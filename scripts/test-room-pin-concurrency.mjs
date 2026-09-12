import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function ok(result, message) {
  if (result.error) throw new Error(`${message}: ${result.error.message}`);
  return result.data;
}

export async function configureRoomPinForConcurrency(client, actor, item) {
  const loginClient = createClient(client.supabaseUrl, client.supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const signedIn = ok(
    await loginClient.auth.signInWithPassword({
      email: actor.email,
      password: actor.password,
    }),
    "room PIN readiness sign-in",
  );
  const sessionId = JSON.parse(
    Buffer.from(
      signedIn.session.access_token.split(".")[1],
      "base64url",
    ).toString(),
  ).session_id;
  const prepared = ok(
    await client.rpc("prepare_room_pin_change", {
      p_actor_profile_id: actor.profileId,
      p_session_id: sessionId,
      p_room_id: item.id,
      p_expected_pin_version: 0,
      p_room_number_snapshot: item.roomNumber,
      p_assignment_id: null,
      p_attempt_id: null,
      p_access_lease_id: null,
      p_reason_code: "ADMIN_INITIAL_PIN",
      p_envelope_format: 1,
      p_ciphertext_base64: randomBytes(12).toString("base64"),
      p_nonce_base64: randomBytes(12).toString("base64"),
      p_auth_tag_base64: randomBytes(16).toString("base64"),
      p_key_version: "concurrency-v1",
      p_aad_environment: "test",
      p_aad_project_ref: "local",
      p_idempotency_key: `pin-${randomUUID()}`,
      p_request_hash: randomBytes(32).toString("hex"),
    }),
    "room PIN readiness prepare",
  );
  ok(
    await client.rpc("confirm_room_pin_change", {
      p_actor_profile_id: actor.profileId,
      p_session_id: sessionId,
      p_room_id: item.id,
      p_lease_id: prepared.lease_id,
      p_expected_pin_version: 0,
      p_idempotency_key: `pin-${randomUUID()}`,
      p_request_hash: randomBytes(32).toString("hex"),
    }),
    "room PIN readiness confirm",
  );
}

// Exercises the database lock graph only against the disposable local stack.
// UUIDs and envelope material are never included in output or thrown errors.
export async function testRoomPinConcurrency(client) {
  assert(
    ["localhost", "127.0.0.1"].includes(new URL(client.supabaseUrl).hostname),
    "room PIN concurrency is local only",
  );
  const psqlArgs = [
    "exec",
    "-i",
    "supabase_db_room-management-system-backend",
    "psql",
    "-X",
    "-qAt",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
  ];
  function sql(command) {
    try {
      return execFileSync("docker", psqlArgs, {
        input: command,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 10_000,
      }).trim();
    } catch {
      throw new Error(
        "local room PIN SQL helper failed (raw SQL/output redacted)",
      );
    }
  }
  async function holdReservationCommandLock() {
    const process = spawn("docker", psqlArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let ready = false;
    let output = "";
    let stderr = "";
    const exited = new Promise((resolve) => process.once("close", resolve));
    process.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        process.kill();
        reject(new Error("room PIN lock barrier timed out"));
      }, 10_000);
      process.once("error", () => {
        clearTimeout(timeout);
        reject(new Error("room PIN lock process failed"));
      });
      process.once("close", () => {
        if (!ready) {
          clearTimeout(timeout);
          reject(new Error("room PIN lock setup failed"));
        }
      });
      process.stdout.on("data", (chunk) => {
        output += chunk.toString();
        if (!ready && output.includes("LOCK_READY")) {
          ready = true;
          output = "";
          clearTimeout(timeout);
          resolve();
        }
      });
      process.stdin.write(
        "begin; set local statement_timeout='40s'; " +
          "set local idle_in_transaction_session_timeout='45s'; " +
          "select pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));\n" +
          "\\echo LOCK_READY\n",
      );
    });
    let releasePromise;
    return (beforeCommit = "select 1") => {
      if (!releasePromise) {
        releasePromise = (async () => {
          process.stdin.end(`${beforeCommit}; commit;\n\\q\n`);
          const exitCode = await exited;
          if (exitCode !== 0) {
            const reason =
              stderr.split(/\r?\n/).find((line) => line.trim()) ?? "unknown";
            throw new Error(
              `room PIN lock transaction failed: ${reason.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "[id]")}`,
            );
          }
        })();
      }
      return releasePromise;
    };
  }
  async function waitForAdvisoryLock(rpcName) {
    assert(
      /^[a-z_]+$/.test(rpcName),
      "source-controlled room PIN RPC query filter",
    );
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const waiting = sql(
        "select exists(select 1 from pg_locks waiting " +
          "join pg_locks holder on holder.locktype=waiting.locktype " +
          "and holder.database is not distinct from waiting.database " +
          "and holder.classid=waiting.classid and holder.objid=waiting.objid " +
          "and holder.objsubid=waiting.objsubid and holder.pid<>waiting.pid " +
          "join pg_stat_activity activity on activity.pid=waiting.pid " +
          "where waiting.locktype='advisory' and not waiting.granted and holder.granted " +
          "and activity.state='active' and activity.wait_event_type='Lock' " +
          "and activity.wait_event='advisory' and activity.usename='authenticator')",
      );
      if (waiting === "t") return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      `${rpcName} did not reach the global advisory lock barrier`,
    );
  }
  async function behindGlobalLock(rpcName, invoke, beforeCommit = "select 1") {
    const release = await holdReservationCommandLock();
    const pending = Promise.resolve(invoke());
    try {
      await waitForAdvisoryLock(rpcName);
      await release(beforeCommit);
      return await pending;
    } catch (error) {
      await release();
      const result = await pending.catch(() => null);
      if (result?.error) {
        throw new Error(
          `${rpcName} failed before the lock barrier: ${result.error.message}`,
        );
      }
      throw error;
    }
  }

  async function account(role) {
    const profileId = randomUUID();
    const authUserId = randomUUID();
    const displayName = `room-pin-${role}-${profileId.slice(0, 8)}`;
    const email = `room-pin-${authUserId}@test.invalid`;
    const password = `T:${randomUUID()}`;
    ok(
      await client.auth.admin.createUser({
        id: authUserId,
        email,
        password,
        email_confirm: true,
      }),
      "room PIN Auth fixture",
    );
    ok(
      await client.from("profiles").insert({
        id: profileId,
        auth_user_id: authUserId,
        display_name: displayName,
        display_name_normalized: displayName,
        login_id: `room-pin-${authUserId}`,
        login_id_normalized: `room-pin-${authUserId}`,
        login_sequence: 0,
        role,
        status: "active",
        must_change_password: false,
      }),
      "room PIN profile fixture",
    );
    const loginClient = createClient(client.supabaseUrl, client.supabaseKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const signedIn = ok(
      await loginClient.auth.signInWithPassword({ email, password }),
      "room PIN local sign-in",
    );
    const sessionId = JSON.parse(
      Buffer.from(
        signedIn.session.access_token.split(".")[1],
        "base64url",
      ).toString(),
    ).session_id;
    return { profileId, sessionId };
  }

  const admin = await account("admin");
  const roomType = ok(
    await client.from("room_types").select("id").limit(1).single(),
    "room PIN room type",
  );
  let sequence = 0;
  async function room() {
    sequence += 1;
    const id = randomUUID();
    const roomNumber = `${Date.now()}${sequence}`;
    ok(
      await client.from("rooms").insert({
        id,
        room_number: roomNumber,
        room_type_id: roomType.id,
        elevator_zone: "A",
      }),
      "room PIN room fixture",
    );
    return { id, roomNumber };
  }
  function envelope() {
    return {
      p_envelope_format: 1,
      p_ciphertext_base64: randomBytes(12).toString("base64"),
      p_nonce_base64: randomBytes(12).toString("base64"),
      p_auth_tag_base64: randomBytes(16).toString("base64"),
      p_key_version: "concurrency-v1",
      p_aad_environment: "test",
      p_aad_project_ref: "local",
    };
  }
  function contextArgs(item, actor = admin, work = {}) {
    return {
      p_actor_profile_id: actor.profileId,
      p_session_id: actor.sessionId,
      p_room_id: item.id,
      p_expected_pin_version: work.pinVersion ?? 0,
      p_assignment_id: work.assignmentId ?? null,
      p_attempt_id: work.attemptId ?? null,
      p_access_lease_id: work.accessLeaseId ?? null,
    };
  }
  function prepareArgs(
    item,
    actor = admin,
    work = {},
    expected = 0,
    reason = "ADMIN_INITIAL_PIN",
  ) {
    return {
      ...contextArgs(item, actor, { ...work, pinVersion: expected }),
      p_room_number_snapshot: item.roomNumber,
      p_reason_code: reason,
      ...envelope(),
      p_idempotency_key: `pin-${randomUUID()}`,
      p_request_hash: randomBytes(32).toString("hex"),
    };
  }
  async function installCurrent(item) {
    const prepared = ok(
      await client.rpc("prepare_room_pin_change", prepareArgs(item)),
      "room PIN initial prepare fixture",
    );
    ok(
      await client.rpc("confirm_room_pin_change", {
        p_actor_profile_id: admin.profileId,
        p_session_id: admin.sessionId,
        p_room_id: item.id,
        p_lease_id: prepared.lease_id,
        p_expected_pin_version: 0,
        p_idempotency_key: `pin-${randomUUID()}`,
        p_request_hash: randomBytes(32).toString("hex"),
      }),
      "room PIN initial confirm fixture",
    );
  }

  // Each public PIN RPC must wait at the shared lifecycle lock before touching
  // room/work rows. The fixed barrier makes this an observed lock-order test.
  const ordered = await room();
  ok(
    await behindGlobalLock("get_room_pin_change_context", () =>
      client.rpc("get_room_pin_change_context", contextArgs(ordered)),
    ),
    "context global-first",
  );
  const prepared = ok(
    await behindGlobalLock("prepare_room_pin_change", () =>
      client.rpc("prepare_room_pin_change", prepareArgs(ordered)),
    ),
    "prepare global-first",
  );
  ok(
    await behindGlobalLock("confirm_room_pin_change", () =>
      client.rpc("confirm_room_pin_change", {
        p_actor_profile_id: admin.profileId,
        p_session_id: admin.sessionId,
        p_room_id: ordered.id,
        p_lease_id: prepared.lease_id,
        p_expected_pin_version: 0,
        p_idempotency_key: `pin-${randomUUID()}`,
        p_request_hash: randomBytes(32).toString("hex"),
      }),
    ),
    "confirm global-first",
  );
  const reveal = ok(
    await behindGlobalLock("begin_room_pin_reveal", () =>
      client.rpc("begin_room_pin_reveal", {
        p_actor_profile_id: admin.profileId,
        p_session_id: admin.sessionId,
        p_room_id: ordered.id,
        p_assignment_id: null,
        p_attempt_id: null,
        p_access_lease_id: null,
        p_request_id: randomUUID(),
      }),
    ),
    "begin reveal global-first",
  );
  const revealRequestId = randomUUID();
  const secondReveal = ok(
    await client.rpc("begin_room_pin_reveal", {
      p_actor_profile_id: admin.profileId,
      p_session_id: admin.sessionId,
      p_room_id: ordered.id,
      p_assignment_id: null,
      p_attempt_id: null,
      p_access_lease_id: null,
      p_request_id: revealRequestId,
    }),
    "finalize reveal fixture",
  );
  ok(
    await behindGlobalLock("finalize_room_pin_reveal", () =>
      client.rpc("finalize_room_pin_reveal", {
        p_actor_profile_id: admin.profileId,
        p_session_id: admin.sessionId,
        p_room_id: ordered.id,
        p_reveal_lease_id: secondReveal.lease_id,
        p_request_id: revealRequestId,
      }),
    ),
    "finalize reveal global-first",
  );
  assert(
    reveal.lease_id !== secondReveal.lease_id,
    "reveal leases are separate bounded reads",
  );
  const physical = ok(
    await client.rpc(
      "prepare_room_pin_change",
      prepareArgs(ordered, admin, {}, 1, "ADMIN_PHYSICAL_CHANGE"),
    ),
    "rollback fixture prepare",
  );
  ok(
    await behindGlobalLock("rollback_room_pin_change", () =>
      client.rpc("rollback_room_pin_change", {
        p_actor_profile_id: admin.profileId,
        p_session_id: admin.sessionId,
        p_room_id: ordered.id,
        p_lease_id: physical.lease_id,
        p_expected_pin_version: 1,
        p_idempotency_key: `pin-${randomUUID()}`,
        p_request_hash: randomBytes(32).toString("hex"),
      }),
    ),
    "rollback global-first",
  );

  const concurrent = await room();
  const prepareRace = await Promise.all([
    client.rpc("prepare_room_pin_change", prepareArgs(concurrent)),
    client.rpc("prepare_room_pin_change", prepareArgs(concurrent)),
  ]);
  assert(
    prepareRace.filter((result) => !result.error).length === 1 &&
      prepareRace.some(
        (result) => result.error?.message === "PIN_CHANGE_IN_PROGRESS",
      ),
    "concurrent prepare has one winner and one stable loser",
  );
  const prepareWinner = prepareRace.find((result) => !result.error).data;
  const confirmRace = await Promise.all([
    client.rpc("confirm_room_pin_change", {
      p_actor_profile_id: admin.profileId,
      p_session_id: admin.sessionId,
      p_room_id: concurrent.id,
      p_lease_id: prepareWinner.lease_id,
      p_expected_pin_version: 0,
      p_idempotency_key: `pin-${randomUUID()}`,
      p_request_hash: randomBytes(32).toString("hex"),
    }),
    client.rpc("confirm_room_pin_change", {
      p_actor_profile_id: admin.profileId,
      p_session_id: admin.sessionId,
      p_room_id: concurrent.id,
      p_lease_id: prepareWinner.lease_id,
      p_expected_pin_version: 0,
      p_idempotency_key: `pin-${randomUUID()}`,
      p_request_hash: randomBytes(32).toString("hex"),
    }),
  ]);
  assert(
    confirmRace.filter((result) => !result.error).length === 1 &&
      confirmRace.some(
        (result) => result.error?.message === "PIN_CHANGE_LEASE_NOT_PREPARED",
      ),
    "concurrent confirm has one winner and one stable loser",
  );

  const now = new Date();
  const day = new Date(now.getTime() + 9 * 3_600_000)
    .toISOString()
    .slice(0, 10);
  async function maidFixture() {
    const owner = await account("maid");
    const item = await room();
    await installCurrent(item);
    const targetId = randomUUID();
    const assignmentId = randomUUID();
    const attemptId = randomUUID();
    const accessLeaseId = randomUUID();
    ok(
      await client.from("cleaning_targets").insert({
        id: targetId,
        room_id: item.id,
        cleaning_kind: "additional",
        source: "manual_room_request",
        source_key: `room-pin-${targetId}`,
        original_service_date: day,
        effective_service_date: day,
        available_from: new Date(now.getTime() - 60_000).toISOString(),
        due_at: new Date(now.getTime() + 3_600_000).toISOString(),
        status: "notified",
        assignment_version: 2,
        room_type_snapshot: {},
        template_snapshot: {},
        fee_snapshot: 10000,
        created_by: admin.profileId,
      }),
      "room PIN target fixture",
    );
    ok(
      await client.from("cleaning_assignments").insert({
        id: assignmentId,
        cleaning_target_id: targetId,
        maid_profile_id: owner.profileId,
        sequence_number: ++sequence,
        revision: 2,
        notified_at: now.toISOString(),
        changed_by: admin.profileId,
      }),
      "room PIN assignment fixture",
    );
    ok(
      await client.from("cleaning_attempts").insert({
        id: attemptId,
        cleaning_target_id: targetId,
        assignment_id: assignmentId,
        maid_profile_id: owner.profileId,
        attempt_number: 1,
        status: "scheduled",
        assignment_revision: 2,
        room_snapshot: { roomId: item.id },
        template_snapshot: {},
      }),
      "room PIN attempt fixture",
    );
    ok(
      await client.rpc("start_cleaning_attempt", {
        p_actor_profile_id: owner.profileId,
        p_attempt_id: attemptId,
        p_expected_execution_version: 1,
        p_expected_assignment_id: assignmentId,
        p_expected_assignment_revision: 2,
        p_idempotency_key: randomUUID(),
        p_request_hash: "a".repeat(64),
      }),
      "room PIN started attempt fixture",
    );
    ok(
      await client.from("room_pin_access_leases").insert({
        id: accessLeaseId,
        room_id: item.id,
        cleaning_target_id: targetId,
        assignment_id: assignmentId,
        attempt_id: attemptId,
        pin_version: 1,
        issued_to: owner.profileId,
        issued_at: new Date(now.getTime() - 60_000).toISOString(),
        expires_at: new Date(now.getTime() + 3_600_000).toISOString(),
      }),
      "room PIN authoritative access lease fixture",
    );
    return {
      ...item,
      ...owner,
      targetId,
      assignmentId,
      attemptId,
      accessLeaseId,
      pinVersion: 1,
    };
  }
  function completionSql(item) {
    return (
      `select public.complete_cleaning_attempt_field_work(` +
      `'${item.profileId}'::uuid,'${item.attemptId}'::uuid,2,` +
      `'${item.assignmentId}'::uuid,2,'${randomUUID()}',repeat('c',64))`
    );
  }
  const stableRaceErrors = new Set([
    "PIN_ACCESS_REQUIRED",
    "PIN_ACCESS_LEASE_REQUIRED",
    "PIN_CHANGE_IN_PROGRESS_REQUIRED",
    "PIN_REVEAL_AUTHORIZATION_CHANGED",
  ]);
  async function completeWins(label, rpcName, item, invoke) {
    const result = await behindGlobalLock(rpcName, invoke, completionSql(item));
    assert(
      result.error &&
        stableRaceErrors.has(result.error.message) &&
        !/40P01|deadlock|500|internal/i.test(result.error.message),
      `${label} versus completion fails closed with a stable domain error`,
    );
  }

  const contextRace = await maidFixture();
  await completeWins(
    "context",
    "get_room_pin_change_context",
    contextRace,
    () =>
      client.rpc(
        "get_room_pin_change_context",
        contextArgs(
          contextRace,
          {
            profileId: contextRace.profileId,
            sessionId: contextRace.sessionId,
          },
          contextRace,
        ),
      ),
  );

  const prepareWorkRace = await maidFixture();
  await completeWins(
    "prepare",
    "prepare_room_pin_change",
    prepareWorkRace,
    () =>
      client.rpc(
        "prepare_room_pin_change",
        prepareArgs(
          prepareWorkRace,
          {
            profileId: prepareWorkRace.profileId,
            sessionId: prepareWorkRace.sessionId,
          },
          prepareWorkRace,
          1,
          "MAID_CLEANING_CHANGE",
        ),
      ),
  );

  const confirmWorkRace = await maidFixture();
  const maidPrepared = ok(
    await client.rpc(
      "prepare_room_pin_change",
      prepareArgs(
        confirmWorkRace,
        {
          profileId: confirmWorkRace.profileId,
          sessionId: confirmWorkRace.sessionId,
        },
        confirmWorkRace,
        1,
        "MAID_CLEANING_CHANGE",
      ),
    ),
    "maid confirm race prepare",
  );
  await completeWins(
    "confirm",
    "confirm_room_pin_change",
    confirmWorkRace,
    () =>
      client.rpc("confirm_room_pin_change", {
        p_actor_profile_id: confirmWorkRace.profileId,
        p_session_id: confirmWorkRace.sessionId,
        p_room_id: confirmWorkRace.id,
        p_lease_id: maidPrepared.lease_id,
        p_expected_pin_version: 1,
        p_idempotency_key: `pin-${randomUUID()}`,
        p_request_hash: randomBytes(32).toString("hex"),
      }),
  );

  const beginWorkRace = await maidFixture();
  await completeWins(
    "begin reveal",
    "begin_room_pin_reveal",
    beginWorkRace,
    () =>
      client.rpc("begin_room_pin_reveal", {
        p_actor_profile_id: beginWorkRace.profileId,
        p_session_id: beginWorkRace.sessionId,
        p_room_id: beginWorkRace.id,
        p_assignment_id: beginWorkRace.assignmentId,
        p_attempt_id: beginWorkRace.attemptId,
        p_access_lease_id: beginWorkRace.accessLeaseId,
        p_request_id: randomUUID(),
      }),
  );

  const finalizeWorkRace = await maidFixture();
  const finalizeRequestId = randomUUID();
  const begun = ok(
    await client.rpc("begin_room_pin_reveal", {
      p_actor_profile_id: finalizeWorkRace.profileId,
      p_session_id: finalizeWorkRace.sessionId,
      p_room_id: finalizeWorkRace.id,
      p_assignment_id: finalizeWorkRace.assignmentId,
      p_attempt_id: finalizeWorkRace.attemptId,
      p_access_lease_id: finalizeWorkRace.accessLeaseId,
      p_request_id: finalizeRequestId,
    }),
    "maid finalize race begin",
  );
  await completeWins(
    "finalize reveal",
    "finalize_room_pin_reveal",
    finalizeWorkRace,
    () =>
      client.rpc("finalize_room_pin_reveal", {
        p_actor_profile_id: finalizeWorkRace.profileId,
        p_session_id: finalizeWorkRace.sessionId,
        p_room_id: finalizeWorkRace.id,
        p_reveal_lease_id: begun.lease_id,
        p_request_id: finalizeRequestId,
      }),
  );

  console.log(
    "Room PIN concurrency passed: six global-first RPC barriers, prepare/confirm single winners, and five actual completion conflict paths without deadlock.",
  );
}
