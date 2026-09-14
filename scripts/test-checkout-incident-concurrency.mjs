import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

function assert(value, message) {
  if (!value) throw new Error(message);
}
function ok(result, message) {
  assert(!result.error, `${message}: ${result.error?.message}`);
  return result.data;
}
function psql(sql) {
  return execFileSync("docker", [
    "exec", "-i", "supabase_db_room-management-system-backend",
    "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres",
    "-d", "postgres", "-c", sql,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 15000 }).trim();
}
function holdReservationCommandLock() {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", [
      "exec", "-i", "supabase_db_room-management-system-backend",
      "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres",
      "-d", "postgres",
    ], { stdio: ["pipe", "pipe", "inherit"] });
    let output = "";
    let settled = false;
    child.on("error", reject);
    child.on("exit", (code) => {
      if (!settled && code !== 0) reject(new Error(`lock holder exited ${code}`));
    });
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (!settled && output.includes("LOCKED")) {
        settled = true;
        resolve({
          release: () => new Promise((releaseResolve, releaseReject) => {
            child.once("exit", (code) => code === 0
              ? releaseResolve()
              : releaseReject(new Error(`lock holder release exited ${code}`)));
            child.stdin.end("commit;\n\\q\n");
          }),
        });
      }
    });
    child.stdin.write("begin;\n");
    child.stdin.write("select pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));\n");
    child.stdin.write("select 'LOCKED';\n");
  });
}
function waitUntil(epochMs) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, epochMs - Date.now())));
}
function kstDate(date = new Date()) {
  return new Date(date.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}
function minute(date = new Date()) {
  return new Date(Math.floor(date.getTime() / 60_000) * 60_000).toISOString();
}
function kstTime(date, time) {
  return new Date(`${date}T${time}:00+09:00`).toISOString();
}
function nextKstMidnight(date) {
  return kstTime(
    kstDate(new Date(date.getTime() + 24 * 60 * 60_000)),
    "00:00",
  );
}
async function waitForCheckoutFixtureWindow() {
  const now = new Date();
  const remainingMs = Date.parse(nextKstMidnight(now)) - now.getTime();

  // Scheduled checkout activation is one minute after checkout. If that
  // positive fixture cannot fit in today's KST window, start it next day.
  if (remainingMs <= 2 * 60_000) {
    await waitUntil(now.getTime() + remainingMs + 1_000);
  }
}

export async function testCheckoutIncidentConcurrency(client, adminProfileId) {
  const admin = ok(
    await client.from("profiles").select("auth_user_id").eq("id", adminProfileId).single(),
    "checkout incident admin fixture",
  );
  const maidAuthId = randomUUID();
  const maidProfileId = randomUUID();
  const nextMaidAuthId = randomUUID();
  const nextMaidProfileId = randomUUID();
  const maidSessionId = randomUUID();
  const adminSessionId = randomUUID();
  ok(await client.auth.admin.createUser({
    id: maidAuthId,
    email: `checkout-incident-${maidAuthId}@test.invalid`,
    password: `T:${randomUUID()}`,
    email_confirm: true,
  }), "checkout incident maid Auth fixture");
  ok(await client.auth.admin.createUser({
    id: nextMaidAuthId,
    email: `checkout-incident-next-${nextMaidAuthId}@test.invalid`,
    password: `T:${randomUUID()}`,
    email_confirm: true,
  }), "checkout incident next-maid Auth fixture");
  ok(await client.from("profiles").insert({
    id: maidProfileId,
    auth_user_id: maidAuthId,
    display_name: `checkout-incident-${maidProfileId}`,
    display_name_normalized: `checkout-incident-${maidProfileId}`,
    login_id: `checkout-incident-${maidProfileId}`,
    login_id_normalized: `checkout-incident-${maidProfileId}`,
    login_sequence: 0,
    role: "maid",
    status: "active",
    must_change_password: false,
  }), "checkout incident maid profile fixture");
  ok(await client.from("profiles").insert({
    id: nextMaidProfileId,
    auth_user_id: nextMaidAuthId,
    display_name: `checkout-incident-next-${nextMaidProfileId}`,
    display_name_normalized: `checkout-incident-next-${nextMaidProfileId}`,
    login_id: `checkout-incident-next-${nextMaidProfileId}`,
    login_id_normalized: `checkout-incident-next-${nextMaidProfileId}`,
    login_sequence: 0,
    role: "maid",
    status: "active",
    must_change_password: false,
  }), "checkout incident next-maid profile fixture");
  psql(`insert into auth.sessions(id,user_id) values
    ('${maidSessionId}'::uuid,'${maidAuthId}'::uuid),
    ('${adminSessionId}'::uuid,'${admin.auth_user_id}'::uuid)`);

  const today = kstDate();
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay() || 7;
  const week = new Date(Date.parse(`${today}T00:00:00Z`) - (weekday - 1) * 86_400_000)
    .toISOString().slice(0, 10);
  const availabilityId = randomUUID();
  const nextAvailabilityId = randomUUID();
  ok(await client.from("availability_versions").insert([{
    id: availabilityId,
    maid_profile_id: maidProfileId,
    week_start: week,
    version: 1,
    submitted_at: new Date().toISOString(),
  }, {
    id: nextAvailabilityId,
    maid_profile_id: nextMaidProfileId,
    week_start: week,
    version: 1,
    submitted_at: new Date().toISOString(),
  }]), "checkout incident availability fixture");
  ok(await client.from("availability_days").insert(
    [availabilityId, nextAvailabilityId].flatMap((versionId) =>
      Array.from({ length: 7 }, (_, offset) => ({
        availability_version_id: versionId,
        work_date: new Date(Date.parse(`${week}T00:00:00Z`) + offset * 86_400_000)
          .toISOString().slice(0, 10),
        available: true,
      }))
    ),
  ), "checkout incident availability days");

  async function ensureAvailability(profileId, serviceDate) {
    const weekday = new Date(`${serviceDate}T00:00:00Z`).getUTCDay() || 7;
    const serviceWeek = new Date(
      Date.parse(`${serviceDate}T00:00:00Z`) - (weekday - 1) * 86_400_000,
    ).toISOString().slice(0, 10);
    const existing = ok(await client.from("availability_versions").select("id")
      .eq("maid_profile_id", profileId).eq("week_start", serviceWeek).eq("is_current", true),
    "checkout incident availability lookup");
    if (existing.length > 0) return;
    const versionId = randomUUID();
    ok(await client.from("availability_versions").insert({
      id: versionId,
      maid_profile_id: profileId,
      week_start: serviceWeek,
      version: 1,
      submitted_at: new Date().toISOString(),
    }), "checkout incident boundary availability fixture");
    ok(await client.from("availability_days").insert(
      Array.from({ length: 7 }, (_, offset) => ({
        availability_version_id: versionId,
        work_date: new Date(Date.parse(`${serviceWeek}T00:00:00Z`) + offset * 86_400_000)
          .toISOString().slice(0, 10),
        available: true,
      })),
    ), "checkout incident boundary availability days");
  }

  const roomType = ok(
    await client.from("room_types").select("id").limit(1).single(),
    "checkout incident room type",
  );
  let sequence = 9000;
  async function fixture({ checkoutMode = "scheduled", nextReservation = null } = {}) {
    await waitForCheckoutFixtureWindow();
    const fixtureAt = new Date();
    sequence += 1;
    const roomId = randomUUID();
    const reservationId = randomUUID();
    const roomNumber = `${fixtureAt.getTime()}${sequence}`;
    ok(await client.from("rooms").insert({
      id: roomId,
      room_number: roomNumber,
      room_type_id: roomType.id,
      elevator_zone: "A",
    }), "checkout incident isolated room");
    const checkoutAt = new Date(
      fixtureAt.getTime() + (checkoutMode === "manual" ? 60 * 60_000 : 0),
    );
    ok(await client.rpc("create_reservation", {
      p_actor_profile_id: adminProfileId,
      p_reservation_id: reservationId,
      p_room_id: roomId,
      p_check_in_at: minute(
        new Date(fixtureAt.getTime() - 24 * 60 * 60_000),
      ),
      p_check_out_at: minute(checkoutAt),
      p_guest_count: 2,
      p_guest_name_encrypted: null,
      p_expected_room_version: 1,
      p_idempotency_key: `checkout-incident-create-${reservationId}`,
      p_request_hash: "1".repeat(64),
    }), "checkout incident reservation");
    const obligation = ok(
      await client.from("checkout_cleaning_obligations")
        .select("planned_cleaning_target_id")
        .eq("reservation_id", reservationId).single(),
      "checkout incident obligation",
    );
    const targetId = obligation.planned_cleaning_target_id;
    const serviceDate = kstDate(checkoutAt);
    await ensureAvailability(maidProfileId, serviceDate);
    await ensureAvailability(nextMaidProfileId, serviceDate);
    let nextReservationId = null;
    if (nextReservation) {
      nextReservationId = randomUUID();
      const currentRoom = ok(await client.from("rooms").select("state_version")
        .eq("id", roomId).single(), "checkout incident next-reservation room version");
      ok(await client.rpc("create_reservation", {
        p_actor_profile_id: adminProfileId,
        p_reservation_id: nextReservationId,
        p_room_id: roomId,
        p_check_in_at: nextReservation.checkInAt,
        p_check_out_at: nextReservation.checkOutAt,
        p_guest_count: 2,
        p_guest_name_encrypted: null,
        p_expected_room_version: currentRoom.state_version,
        p_idempotency_key: `checkout-incident-next-reservation-${nextReservationId}`,
        p_request_hash: "a".repeat(64),
      }), "checkout incident next reservation fixture");
    }
    const targetVersion = ok(await client.from("cleaning_targets")
      .select("assignment_version").eq("id", targetId).single(),
    "checkout incident target version after next-reservation planning");
    ok(await client.rpc("save_cleaning_assignment_draft", {
      p_actor_profile_id: adminProfileId,
      p_cleaning_target_id: targetId,
      p_maid_profile_id: maidProfileId,
      p_sequence_number: sequence,
      p_expected_assignment_version: targetVersion.assignment_version,
      p_idempotency_key: `checkout-incident-draft-${reservationId}`,
      p_request_hash: "2".repeat(64),
    }), "checkout incident assignment draft");
    const impact = ok(await client.rpc("get_assignment_commit_impact", {
      p_actor_profile_id: adminProfileId,
      p_service_date: serviceDate,
    }), "checkout incident assignment preflight");
    ok(await client.rpc("commit_and_notify_assignments", {
      p_actor_profile_id: adminProfileId,
      p_service_date: serviceDate,
      p_expected_impact_fingerprint: impact.impactFingerprint,
      p_items: [{
        cleaningTargetId: targetId,
        expectedAssignmentVersion: targetVersion.assignment_version + 1,
        expectedAvailabilityVersion: 1,
      }],
      p_idempotency_key: `checkout-incident-notify-${reservationId}`,
      p_request_hash: "3".repeat(64),
    }), "checkout incident assignment notify");
    ok(await client.from("reservations").update({
      actual_check_in_at: minute(
        new Date(fixtureAt.getTime() - 23 * 60 * 60_000),
      ),
    }).eq("id", reservationId), "checkout incident checked-in fixture");
    const scheduledCheckoutTime = minute(checkoutAt);
    const checkoutTime = checkoutMode === "manual"
      ? minute(fixtureAt)
      : scheduledCheckoutTime;
    const schedulerArgs = {
      p_actor_profile_id: adminProfileId,
      p_as_of: scheduledCheckoutTime,
      p_idempotency_key: `checkout-incident-scheduled-checkout-${reservationId}`,
      p_request_hash: "4".repeat(64),
    };
    if (checkoutMode === "scheduled") {
      ok(await client.rpc("process_due_reservation_transitions", schedulerArgs),
        "checkout incident scheduled checkout");
    } else {
      ok(await client.rpc("manual_checkout_reservation", {
        p_actor_profile_id: adminProfileId,
        p_reservation_id: reservationId,
        p_expected_version: 1,
        p_reason_code: "TEST_GUEST_DEPARTED",
        p_effective_at: checkoutTime,
        p_idempotency_key: `checkout-incident-manual-checkout-${reservationId}`,
        p_request_hash: "4".repeat(64),
      }), "checkout incident manual checkout");
    }
    const activationAt = new Date(Date.parse(checkoutTime) + 60_000).toISOString();
    ok(await client.rpc("process_due_assignment_lifecycle", {
      p_actor_profile_id: adminProfileId,
      p_as_of: activationAt,
      p_idempotency_key: `checkout-incident-lifecycle-${reservationId}`,
      p_request_hash: "5".repeat(64),
    }), "checkout incident attempt activation");
    const assignment = ok(await client.from("cleaning_assignments")
      .select("id,revision").eq("cleaning_target_id", targetId).eq("is_current", true).single(),
    "checkout incident current assignment");
    const attempt = ok(await client.from("cleaning_attempts")
      .select("id,execution_version").eq("cleaning_target_id", targetId).eq("status", "scheduled").single(),
    "checkout incident scheduled attempt");
    return { roomId, reservationId, targetId, assignment, attempt, schedulerArgs,
      serviceDate, nextReservationId };
  }
  const reportArgs = (item, key, hash = "6".repeat(64)) => ({
    p_actor_profile_id: maidProfileId,
    p_session_id: maidSessionId,
    p_attempt_id: item.attempt.id,
    p_expected_execution_version: item.attempt.execution_version,
    p_expected_assignment_id: item.assignment.id,
    p_expected_assignment_revision: item.assignment.revision,
    p_idempotency_key: key,
    p_request_hash: hash,
  });
  const decisionArgs = (
    incidentId,
    impactFingerprint,
    key,
    nextSequence,
    decision = "CONFIRM_DEPARTED",
    hash = "7".repeat(64),
  ) => {
    const requestedAt = new Date();
    const serviceDate = kstDate(requestedAt);
    return {
      p_actor_profile_id: adminProfileId,
      p_session_id: adminSessionId,
      p_incident_id: incidentId,
      p_expected_version: 1,
      p_expected_impact_fingerprint: impactFingerprint,
      p_decision: decision,
      p_reason_code: decision === "CONFIRM_DEPARTED"
        ? "GUEST_DEPARTURE_CONFIRMED"
        : "REPORT_FALSE_CONFIRMED",
      p_new_checkout_at: null,
      p_reassignment: {
        maidProfileId,
        sequenceNumber: nextSequence,
        serviceDate,
        availableFrom: minute(requestedAt),
        dueAt: nextKstMidnight(requestedAt),
      },
      p_idempotency_key: key,
      p_request_hash: hash,
    };
  };
  const attemptArgs = (item, version, key, hash) => ({
    p_actor_profile_id: maidProfileId,
    p_attempt_id: item.attempt.id,
    p_expected_execution_version: version,
    p_expected_assignment_id: item.assignment.id,
    p_expected_assignment_revision: item.assignment.revision,
    p_idempotency_key: key,
    p_request_hash: hash,
  });

  const startRaceFixture = await fixture();
  const reportVsStart = await Promise.all([
    client.rpc("report_checkout_presence_incident", reportArgs(
      startRaceFixture,
      `checkout-incident-report-start-${randomUUID()}`,
      "c".repeat(64),
    )),
    client.rpc("start_cleaning_attempt", attemptArgs(
      startRaceFixture,
      1,
      `checkout-incident-start-race-${randomUUID()}`,
      "d".repeat(64),
    )),
  ]);
  assert(reportVsStart.filter((result) => !result.error).length === 1,
    "report versus start has one serialized winner");
  assert(reportVsStart.filter((result) => result.error).every((result) =>
    ["CHECKOUT_INCIDENT_OPEN", "CHECKOUT_INCIDENT_REPORT_CONFLICT"].includes(result.error.message)
  ), "report versus start loser is a stable domain conflict");
  if (!reportVsStart[1].error) {
    ok(await client.rpc("complete_cleaning_attempt_field_work", attemptArgs(
      startRaceFixture,
      2,
      `checkout-incident-start-race-cleanup-${randomUUID()}`,
      "7".repeat(64),
    )), "checkout incident start-race cleanup");
  }

  const completeRaceFixture = await fixture();
  ok(await client.rpc("start_cleaning_attempt", attemptArgs(
    completeRaceFixture,
    1,
    `checkout-incident-complete-setup-${randomUUID()}`,
    "e".repeat(64),
  )), "checkout incident complete-race start");
  completeRaceFixture.attempt.execution_version = 2;
  const reportVsComplete = await Promise.all([
    client.rpc("report_checkout_presence_incident", reportArgs(
      completeRaceFixture,
      `checkout-incident-report-complete-${randomUUID()}`,
      "f".repeat(64),
    )),
    client.rpc("complete_cleaning_attempt_field_work", attemptArgs(
      completeRaceFixture,
      2,
      `checkout-incident-complete-race-${randomUUID()}`,
      "0".repeat(64),
    )),
  ]);
  assert(reportVsComplete.filter((result) => !result.error).length === 1,
    "report versus field completion has one serialized winner");
  assert(reportVsComplete.filter((result) => result.error).every((result) =>
    ["CHECKOUT_INCIDENT_OPEN", "CHECKOUT_INCIDENT_REPORT_CONFLICT"].includes(result.error.message)
  ), "report versus field completion loser is a stable domain conflict");
  if (!reportVsComplete[0].error) {
    ok(
      await client.rpc(
        "decide_checkout_presence_incident",
        decisionArgs(
          reportVsComplete[0].data.incidentId,
          reportVsComplete[0].data.impactFingerprint,
          `checkout-incident-complete-race-resolve-${randomUUID()}`,
          20_000,
          "FALSE_REPORT",
          "8".repeat(64),
        ),
      ),
      "checkout incident complete-race resolve",
    );
  }

  const schedulerRaceFixture = await fixture();
  const reportVsScheduler = await Promise.all([
    client.rpc("report_checkout_presence_incident", reportArgs(
      schedulerRaceFixture,
      `checkout-incident-report-scheduler-${randomUUID()}`,
      "1".repeat(64),
    )),
    client.rpc("process_due_reservation_transitions", schedulerRaceFixture.schedulerArgs),
  ]);
  assert(reportVsScheduler.every((result) => !result.error),
    "report and the exact scheduled-checkout replay serialize without deadlock");
  assert(psql(`select count(*) from public.checkout_presence_incidents
      where attempt_id='${schedulerRaceFixture.attempt.id}'::uuid`) === "1",
    "scheduler race preserves exactly one incident");
  assert(psql(`select count(*) from public.room_occupancy_events
      where reservation_id='${schedulerRaceFixture.reservationId}'::uuid
        and event_type='scheduled_checkout'`) === "1",
    "scheduler replay preserves one authoritative scheduled-checkout event");

  const manualFixture = await fixture({ checkoutMode: "manual" });
  psql(`insert into public.room_occupancy_events(
      event_key,room_id,reservation_id,event_type,effective_at,recorded_at,
      actor_profile_id,reason_code,before_state,after_state
    ) select
      'test:scheduled-checkout-decoy:${manualFixture.reservationId}',room_id,id,
      'scheduled_checkout',actual_checkout_at,clock_timestamp()-interval '1 day',
      '${adminProfileId}'::uuid,'TEST_DECOY',
      jsonb_build_object('occupied',true),jsonb_build_object('occupied',false)
    from public.reservations where id='${manualFixture.reservationId}'::uuid`);
  const manualNotificationState = psql(`select coalesce(jsonb_agg(jsonb_build_object(
      'id',id,'resolvedAt',resolved_at,'requiresAction',requires_action,'eventFamily',event_family)
      order by id)::text,'[]') from public.notifications
      where cleaning_target_id='${manualFixture.targetId}'::uuid`);
  const manualReport = await client.rpc("report_checkout_presence_incident", reportArgs(
    manualFixture,
    `checkout-incident-manual-reject-${randomUUID()}`,
    "2".repeat(64),
  ));
  assert(manualReport.error?.message === "CHECKOUT_INCIDENT_REPORT_CONFLICT",
    "manual checkout is rejected by the scheduled-checkout-only report boundary");
  assert(psql(`select count(*) from public.checkout_presence_incidents
      where attempt_id='${manualFixture.attempt.id}'::uuid`) === "0",
    "manual checkout rejection creates no incident");
  assert(psql(`select count(*) from private.offline_work_lease_revocations revocation
      join private.offline_work_leases lease on lease.id=revocation.lease_id
      where lease.attempt_id='${manualFixture.attempt.id}'::uuid`) === "0" &&
    psql(`select count(*) from private.attempt_capability_revocations revocation
      join private.attempt_capability_grants grant_row on grant_row.id=revocation.capability_id
      where grant_row.attempt_id='${manualFixture.attempt.id}'::uuid`) === "0" &&
    psql(`select count(*) from public.room_pin_access_leases
      where attempt_id='${manualFixture.attempt.id}'::uuid and revoked_at is not null`) === "0",
  "manual checkout rejection creates no PIN, offline, or capability revocation");
  assert(psql(`select count(*) from public.audit_events
      where event_type='checkout.presence_reported'
        and after_state->>'attemptId'='${manualFixture.attempt.id}'`) === "0" &&
    psql(`select count(*) from public.notifications
      where cleaning_target_id='${manualFixture.targetId}'::uuid
        and event_family like 'checkout.presence_%'`) === "0" &&
    psql(`select count(*) from private.notification_delivery_outbox outbox
      join public.notifications notice on notice.id=outbox.notification_id
      where notice.cleaning_target_id='${manualFixture.targetId}'::uuid
        and notice.event_family like 'checkout.presence_%'`) === "0",
  "manual checkout rejection creates no checkout audit, notification, or outbox side effect");
  assert(psql(`select coalesce(jsonb_agg(jsonb_build_object(
      'id',id,'resolvedAt',resolved_at,'requiresAction',requires_action,'eventFamily',event_family)
      order by id)::text,'[]') from public.notifications
      where cleaning_target_id='${manualFixture.targetId}'::uuid`) === manualNotificationState,
    "manual checkout rejection leaves the existing notification state untouched");

  const boundaryDate = kstDate(new Date(Date.now() + 24 * 60 * 60_000));
  const boundaryCheckoutAt = kstTime(boundaryDate, "09:00");
  const boundaryCheckInAt = kstTime(boundaryDate, "16:00");
  const boundaryCheckOutAt = kstTime(
    kstDate(new Date(Date.parse(boundaryCheckInAt) + 24 * 60 * 60_000)),
    "11:00",
  );
  const boundaryDue = kstTime(boundaryDate, "15:30");
  const boundaryFixture = await fixture({
    nextReservation: { checkInAt: boundaryCheckInAt, checkOutAt: boundaryCheckOutAt },
  });
  const boundaryReport = ok(await client.rpc(
    "report_checkout_presence_incident",
    reportArgs(boundaryFixture, `checkout-incident-boundary-report-${randomUUID()}`),
  ), "checkout incident exact boundary report");
  const boundaryDecision = {
    p_actor_profile_id: adminProfileId,
    p_session_id: adminSessionId,
    p_incident_id: boundaryReport.incidentId,
    p_expected_version: 1,
    p_expected_impact_fingerprint: boundaryReport.impactFingerprint,
    p_decision: "EXTEND_CHECKOUT",
    p_reason_code: "GUEST_STILL_PRESENT_EXTENDED",
    p_new_checkout_at: boundaryCheckoutAt,
    p_reassignment: {
      maidProfileId,
      sequenceNumber: 20_012,
      serviceDate: boundaryDate,
      availableFrom: boundaryCheckoutAt,
      dueAt: boundaryDue,
    },
    p_idempotency_key: `checkout-incident-boundary-decision-${randomUUID()}`,
    p_request_hash: "7".repeat(64),
  };
  ok(await client.rpc("decide_checkout_presence_incident", boundaryDecision),
    "next check-in minus 30 minutes is an accepted exact boundary");

  const beyondBoundaryFixture = await fixture({
    nextReservation: { checkInAt: boundaryCheckInAt, checkOutAt: boundaryCheckOutAt },
  });
  const beyondBoundaryReport = ok(await client.rpc(
    "report_checkout_presence_incident",
    reportArgs(beyondBoundaryFixture, `checkout-incident-beyond-boundary-report-${randomUUID()}`),
  ), "checkout incident beyond boundary report");
  const beyondBoundaryDecision = {
    ...boundaryDecision,
    p_incident_id: beyondBoundaryReport.incidentId,
    p_expected_impact_fingerprint: beyondBoundaryReport.impactFingerprint,
    p_reassignment: {
      ...boundaryDecision.p_reassignment,
      sequenceNumber: 20_013,
      dueAt: kstTime(boundaryDate, "15:31"),
    },
    p_idempotency_key: `checkout-incident-beyond-boundary-${randomUUID()}`,
    p_request_hash: "8".repeat(64),
  };
  const beyondBoundaryStateSql = `select jsonb_build_object(
      'incident',(select jsonb_build_object('status',status,'version',version,
        'currentDecisionId',current_decision_id,'resolvedAt',resolved_at)
        from public.checkout_presence_incidents
        where id='${beyondBoundaryReport.incidentId}'::uuid),
      'assignments',(select count(*) from public.cleaning_assignments
        where cleaning_target_id='${beyondBoundaryFixture.targetId}'::uuid),
      'attempts',(select count(*) from public.cleaning_attempts
        where cleaning_target_id='${beyondBoundaryFixture.targetId}'::uuid),
      'pinRevoked',(select count(*) from public.room_pin_access_leases
        where attempt_id='${beyondBoundaryFixture.attempt.id}'::uuid and revoked_at is not null),
      'offlineRevoked',(select count(*) from private.offline_work_lease_revocations revocation
        join private.offline_work_leases lease on lease.id=revocation.lease_id
        where lease.attempt_id='${beyondBoundaryFixture.attempt.id}'::uuid),
      'capabilityRevoked',(select count(*) from private.attempt_capability_revocations revocation
        join private.attempt_capability_grants grant_row on grant_row.id=revocation.capability_id
        where grant_row.attempt_id='${beyondBoundaryFixture.attempt.id}'::uuid),
      'notifications',(select jsonb_agg(jsonb_build_object('id',id,'resolvedAt',resolved_at,
        'requiresAction',requires_action,'eventFamily',event_family) order by id)
        from public.notifications where cleaning_target_id='${beyondBoundaryFixture.targetId}'::uuid),
      'receipt',(select count(*) from private.command_executions
        where actor_profile_id='${adminProfileId}'::uuid
          and command_type='checkout.presence.decision'
          and idempotency_key='${beyondBoundaryDecision.p_idempotency_key}')
    )::text`;
  const beyondBoundaryState = psql(beyondBoundaryStateSql);
  const beyondBoundary = await client.rpc(
    "decide_checkout_presence_incident",
    beyondBoundaryDecision,
  );
  assert(beyondBoundary.error?.message === "ASSIGNMENT_SCHEDULE_INVALID",
    "one minute beyond the next check-in buffer is rejected");
  assert(psql(`select count(*) from public.checkout_presence_incident_decisions
      where incident_id='${beyondBoundaryReport.incidentId}'::uuid`) === "0" &&
    psql(`select count(*) from public.checkout_presence_incidents
      where id='${beyondBoundaryReport.incidentId}'::uuid and status='open'`) === "1",
  "invalid next-reservation boundary leaves the incident open without a decision");
  assert(psql(beyondBoundaryStateSql) === beyondBoundaryState,
    "invalid schedule rolls back assignment, attempt, notification, receipt, and prior revocation state");

  const createRaceFixture = await fixture();
  const createRaceReport = ok(await client.rpc(
    "report_checkout_presence_incident",
    reportArgs(createRaceFixture, `checkout-incident-create-race-report-${randomUUID()}`),
  ), "checkout incident next-reservation create race report");
  const createRaceRoom = ok(await client.from("rooms").select("state_version")
    .eq("id", createRaceFixture.roomId).single(),
  "checkout incident create race room version");
  const createRaceReservationId = randomUUID();
  const createRaceDecision = {
    ...boundaryDecision,
    p_incident_id: createRaceReport.incidentId,
    p_expected_impact_fingerprint: createRaceReport.impactFingerprint,
    p_reassignment: {
      ...boundaryDecision.p_reassignment,
      sequenceNumber: 20_014,
      dueAt: kstTime(boundaryDate, "15:31"),
    },
    p_idempotency_key: `checkout-incident-create-race-decision-${randomUUID()}`,
    p_request_hash: "9".repeat(64),
  };
  const createRace = await Promise.all([
    client.rpc("decide_checkout_presence_incident", createRaceDecision),
    client.rpc("create_reservation", {
      p_actor_profile_id: adminProfileId,
      p_reservation_id: createRaceReservationId,
      p_room_id: createRaceFixture.roomId,
      p_check_in_at: boundaryCheckInAt,
      p_check_out_at: boundaryCheckOutAt,
      p_guest_count: 2,
      p_guest_name_encrypted: null,
      p_expected_room_version: createRaceRoom.state_version,
      p_idempotency_key: `checkout-incident-create-race-${randomUUID()}`,
      p_request_hash: "a".repeat(64),
    }),
  ]);
  assert(createRace.filter((result) => !result.error).length === 1,
    "decision versus next-reservation create has one serialized winner");
  assert(createRace.filter((result) => result.error).every((result) =>
    ["ASSIGNMENT_SCHEDULE_INVALID", "CLEANING_DUE_REPLAN_REQUIRED"].includes(result.error.message)
  ), `create-race loser is a stable schedule/domain conflict without deadlock or generic error: ${
    JSON.stringify(createRace.map((result) => result.error?.message ?? "SUCCESS"))
  }`);
  const createDecisionWon = !createRace[0].error;
  assert(psql(`select count(*) from public.checkout_presence_incident_decisions
      where incident_id='${createRaceReport.incidentId}'::uuid`) === (createDecisionWon ? "1" : "0") &&
    psql(`select count(*) from public.checkout_presence_incidents
      where id='${createRaceReport.incidentId}'::uuid
        and status='${createDecisionWon ? "resolved" : "open"}'`) === "1" &&
    psql(`select count(*) from public.reservations
      where id='${createRaceReservationId}'::uuid`) === (createDecisionWon ? "0" : "1"),
  "create race commits exactly the winning serial order and rolls back every loser side effect");

  const changeRaceCheckInAt = kstTime(boundaryDate, "17:00");
  const changeRaceFixture = await fixture({
    nextReservation: { checkInAt: changeRaceCheckInAt, checkOutAt: boundaryCheckOutAt },
  });
  const changeRaceReport = ok(await client.rpc(
    "report_checkout_presence_incident",
    reportArgs(changeRaceFixture, `checkout-incident-change-race-report-${randomUUID()}`),
  ), "checkout incident next-reservation change race report");
  const changeRaceDecision = {
    ...boundaryDecision,
    p_incident_id: changeRaceReport.incidentId,
    p_expected_impact_fingerprint: changeRaceReport.impactFingerprint,
    p_reassignment: {
      ...boundaryDecision.p_reassignment,
      sequenceNumber: 20_015,
      dueAt: kstTime(boundaryDate, "16:00"),
    },
    p_idempotency_key: `checkout-incident-change-race-decision-${randomUUID()}`,
    p_request_hash: "b".repeat(64),
  };
  const changeRace = await Promise.all([
    client.rpc("decide_checkout_presence_incident", changeRaceDecision),
    client.rpc("change_reservation", {
      p_actor_profile_id: adminProfileId,
      p_reservation_id: changeRaceFixture.nextReservationId,
      p_room_id: changeRaceFixture.roomId,
      p_check_in_at: boundaryCheckInAt,
      p_check_out_at: boundaryCheckOutAt,
      p_guest_count: 2,
      p_guest_name_mode: "keep",
      p_guest_name_encrypted: null,
      p_expected_version: 1,
      p_reason_code: "TEST_CHECK_IN_CHANGED",
      p_idempotency_key: `checkout-incident-change-race-${randomUUID()}`,
      p_request_hash: "c".repeat(64),
    }),
  ]);
  assert(changeRace.filter((result) => !result.error).length === 1,
    "decision versus next-reservation schedule change has one serialized winner");
  assert(changeRace.filter((result) => result.error).every((result) =>
    ["ASSIGNMENT_SCHEDULE_INVALID", "CLEANING_DUE_REPLAN_REQUIRED"].includes(result.error.message)
  ), `change-race loser is a stable schedule/domain conflict without deadlock or generic error: ${
    JSON.stringify(changeRace.map((result) => result.error?.message ?? "SUCCESS"))
  }`);
  const changeDecisionWon = !changeRace[0].error;
  const expectedCheckInAt = changeDecisionWon ? changeRaceCheckInAt : boundaryCheckInAt;
  assert(psql(`select count(*) from public.checkout_presence_incident_decisions
      where incident_id='${changeRaceReport.incidentId}'::uuid`) === (changeDecisionWon ? "1" : "0") &&
    psql(`select count(*) from public.checkout_presence_incidents
      where id='${changeRaceReport.incidentId}'::uuid
        and status='${changeDecisionWon ? "resolved" : "open"}'`) === "1" &&
    psql(`select count(*) from public.reservations
      where id='${changeRaceFixture.nextReservationId}'::uuid
        and check_in_at='${expectedCheckInAt}'::timestamptz`) === "1",
  "schedule-change race commits exactly the winning serial order without partial drift");

  const extensionFixture = await fixture();
  const extensionReport = ok(await client.rpc(
    "report_checkout_presence_incident",
    reportArgs(extensionFixture, `checkout-incident-extension-report-${randomUUID()}`, "3".repeat(64)),
  ), "checkout extension report");
  const extendedAt = minute(new Date(Date.now() + 2 * 60 * 60_000));
  ok(await client.rpc("decide_checkout_presence_incident", {
    p_actor_profile_id: adminProfileId,
    p_session_id: adminSessionId,
    p_incident_id: extensionReport.incidentId,
    p_expected_version: 1,
    p_expected_impact_fingerprint: extensionReport.impactFingerprint,
    p_decision: "EXTEND_CHECKOUT",
    p_reason_code: "GUEST_STILL_PRESENT_EXTENDED",
    p_new_checkout_at: extendedAt,
    p_reassignment: {
      maidProfileId,
      sequenceNumber: 20_010,
      serviceDate: kstDate(new Date(extendedAt)),
      availableFrom: extendedAt,
      dueAt: minute(new Date(Date.parse(extendedAt) + 60 * 60_000)),
    },
    p_idempotency_key: `checkout-incident-extension-${randomUUID()}`,
    p_request_hash: "4".repeat(64),
  }), "checkout extension decision");
  assert(psql(`select count(*) from public.cleaning_targets
      where reservation_id='${extensionFixture.reservationId}'::uuid`) === "1" &&
    psql(`select count(*) from public.reservations where id='${extensionFixture.reservationId}'::uuid
      and status='active' and actual_checkout_at is null and check_out_at='${extendedAt}'::timestamptz`) === "1" &&
    psql(`select count(*) from public.cleaning_attempts where cleaning_target_id='${extensionFixture.targetId}'::uuid
      and status in ('scheduled','in_progress')`) === "0",
  "extension preserves one target, resumes occupancy, and creates no premature attempt");

  const falseReportFixture = await fixture();
  const falseReport = ok(await client.rpc(
    "report_checkout_presence_incident",
    reportArgs(falseReportFixture, `checkout-incident-false-report-${randomUUID()}`, "5".repeat(64)),
  ), "false-report incident");
  ok(await client.rpc("decide_checkout_presence_incident", decisionArgs(
    falseReport.incidentId,
    falseReport.impactFingerprint,
    `checkout-incident-false-decision-${randomUUID()}`,
    20_011,
    "FALSE_REPORT",
    "6".repeat(64),
  )), "false-report decision");
  assert(psql(`select count(*) from public.cleaning_targets
      where reservation_id='${falseReportFixture.reservationId}'::uuid`) === "1" &&
    psql(`select count(*) from public.cleaning_attempts where cleaning_target_id='${falseReportFixture.targetId}'::uuid
      and status='scheduled'`) === "1",
  "false-report decision preserves one target and creates one replacement attempt");

  const replayFixture = await fixture();
  const reportKey = `checkout-incident-report-${randomUUID()}`;
  const reports = await Promise.all([
    client.rpc("report_checkout_presence_incident", reportArgs(replayFixture, reportKey)),
    client.rpc("report_checkout_presence_incident", reportArgs(replayFixture, reportKey)),
  ]);
  assert(
    reports.every((result) => !result.error) &&
      JSON.stringify(reports[0].data) === JSON.stringify(reports[1].data),
    "same report command must converge on one logical incident",
  );
  const replayIncidentId = reports[0].data.incidentId;
  assert(
    psql(`select count(*) from public.checkout_presence_incidents
      where attempt_id='${replayFixture.attempt.id}'::uuid`) === "1",
    "report replay creates one incident row",
  );

  const reportRaceFixture = await fixture();
  const reportRace = await Promise.all([
    client.rpc("report_checkout_presence_incident", reportArgs(
      reportRaceFixture,
      `checkout-incident-report-a-${randomUUID()}`,
      "8".repeat(64),
    )),
    client.rpc("report_checkout_presence_incident", reportArgs(
      reportRaceFixture,
      `checkout-incident-report-b-${randomUUID()}`,
      "9".repeat(64),
    )),
  ]);
  assert(reportRace.filter((result) => !result.error).length === 1, "different report commands have one winner");
  assert(
    reportRace.filter((result) => result.error).every((result) =>
      result.error.message === "CHECKOUT_INCIDENT_REPORT_CONFLICT"
    ),
    "report race loser is a stable domain conflict",
  );

  const decisionKey = `checkout-incident-decision-${randomUUID()}`;
  const decisions = await Promise.all([
    client.rpc("decide_checkout_presence_incident", decisionArgs(replayIncidentId, reports[0].data.impactFingerprint, decisionKey, 20_001)),
    client.rpc("decide_checkout_presence_incident", decisionArgs(replayIncidentId, reports[0].data.impactFingerprint, decisionKey, 20_001)),
  ]);
  assert(
    decisions.every((result) => !result.error) &&
      JSON.stringify(decisions[0].data) === JSON.stringify(decisions[1].data),
    "same decision command must converge on one immutable decision",
  );
  const replayAssignmentId = decisions[0].data.decision.nextAssignmentId;
  assert(psql(`select count(*) from public.notifications
      where source_entity_id='${replayAssignmentId}'
        and event_family='assignment.commit_notified' and requires_action`) === "1",
    "decision replay creates one actionable assignment notification");
  assert(psql(`select count(*) from public.notifications
      where source_entity_id='${decisions[0].data.decision.decisionId}'
        and event_family='checkout.presence_resolved_maid' and not requires_action`) === "1",
    "decision replay creates one informational incident-resolution notification");
  assert(psql(`select count(*) from private.notification_delivery_outbox outbox
      join public.notifications notice on notice.id=outbox.notification_id
      where (notice.source_entity_id='${replayAssignmentId}' and notice.event_family='assignment.commit_notified')
         or (notice.source_entity_id='${decisions[0].data.decision.decisionId}'
           and notice.event_family='checkout.presence_resolved_maid')`) === "2",
    "actionable and informational notifications each have one typed outbox row");
  const replacementAssignment = ok(await client.from("cleaning_assignments")
    .select("id,revision").eq("id", replayAssignmentId).single(),
  "replacement assignment notification resolver fixture");
  const replacementAttempt = ok(await client.from("cleaning_attempts")
    .select("id,execution_version").eq("id", decisions[0].data.decision.nextAttemptId).single(),
  "replacement attempt notification resolver fixture");
  const replacementStartArgs = {
    p_actor_profile_id: maidProfileId,
    p_attempt_id: replacementAttempt.id,
    p_expected_execution_version: replacementAttempt.execution_version,
    p_expected_assignment_id: replacementAssignment.id,
    p_expected_assignment_revision: replacementAssignment.revision,
    p_idempotency_key: `checkout-incident-replacement-start-${randomUUID()}`,
    p_request_hash: "5".repeat(64),
  };
  ok(await client.rpc("start_cleaning_attempt", replacementStartArgs),
    "replacement attempt resolves its actionable assignment notice");
  const firstResolvedAt = psql(`select resolved_at::text from public.notifications
    where source_entity_id='${replayAssignmentId}' and event_family='assignment.commit_notified'`);
  assert(firstResolvedAt.length > 0,
    "replacement start resolves the actionable assignment notification");
  ok(await client.rpc("start_cleaning_attempt", replacementStartArgs),
    "replacement start replay");
  assert(psql(`select resolved_at::text from public.notifications
      where source_entity_id='${replayAssignmentId}' and event_family='assignment.commit_notified'`) === firstResolvedAt,
    "replacement start replay preserves the first resolved_at");
  assert(psql(`select count(*) from public.notifications
      where source_entity_id='${decisions[0].data.decision.decisionId}'
        and event_family='checkout.presence_resolved_maid' and resolved_at is null`) === "1",
    "assignment start does not treat the informational incident resolution as actionable");
  assert(psql(`select coalesce(jsonb_agg(jsonb_build_object(
      'id',id,'resolvedAt',resolved_at,'requiresAction',requires_action,'eventFamily',event_family)
      order by id)::text,'[]') from public.notifications
      where cleaning_target_id='${manualFixture.targetId}'::uuid`) === manualNotificationState,
    "assignment start leaves another target and maid notification unchanged");
  ok(await client.rpc("complete_cleaning_attempt_field_work", {
    ...replacementStartArgs,
    p_expected_execution_version: replacementAttempt.execution_version + 1,
    p_idempotency_key: `checkout-incident-replacement-complete-${randomUUID()}`,
    p_request_hash: "6".repeat(64),
  }), "replacement resolver fixture releases the maid in-progress slot");

  const conflictIncident = reportRace.find((result) => !result.error).data.incidentId;
  const decisionRace = await Promise.all([
    client.rpc("decide_checkout_presence_incident", decisionArgs(
      conflictIncident,
      reportRace.find((result) => !result.error).data.impactFingerprint,
      `checkout-incident-confirm-${randomUUID()}`,
      20_002,
      "CONFIRM_DEPARTED",
      "a".repeat(64),
    )),
    client.rpc("decide_checkout_presence_incident", decisionArgs(
      conflictIncident,
      reportRace.find((result) => !result.error).data.impactFingerprint,
      `checkout-incident-false-${randomUUID()}`,
      20_002,
      "FALSE_REPORT",
      "b".repeat(64),
    )),
  ]);
  assert(decisionRace.filter((result) => !result.error).length === 1, "opposing decisions have one winner");
  assert(
    decisionRace.filter((result) => result.error).every((result) =>
      result.error.message === "CHECKOUT_INCIDENT_VERSION_CONFLICT"
    ),
    "decision race loser is a stable CAS conflict without deadlock",
  );
  assert(
    psql(`select count(*) from public.checkout_presence_incidents
      where id in ('${replayIncidentId}'::uuid,'${conflictIncident}'::uuid)
        and status='resolved' and current_decision_id is not null`) === "2" &&
      psql(`select count(*) from public.checkout_presence_incident_decisions
        where incident_id in ('${replayIncidentId}'::uuid,'${conflictIncident}'::uuid)`) === "2",
    "report and decision races leave exactly one immutable decision per incident",
  );

  const replayAfterDueFixture = await fixture();
  const replayAfterDueReport = ok(await client.rpc(
    "report_checkout_presence_incident",
    reportArgs(replayAfterDueFixture, `checkout-incident-due-replay-report-${randomUUID()}`),
  ), "checkout incident due replay report");
  const expiredDueFixture = await fixture();
  const expiredDueReport = ok(await client.rpc(
    "report_checkout_presence_incident",
    reportArgs(expiredDueFixture, `checkout-incident-expired-due-report-${randomUUID()}`),
  ), "checkout incident expired due report");
  const nowMs = Date.now();
  let clockBoundaryDueMs = Date.parse(minute(new Date(nowMs + 60_000)));
  if (clockBoundaryDueMs - nowMs < 10_000) clockBoundaryDueMs += 60_000;
  const clockBoundaryDue = new Date(clockBoundaryDueMs).toISOString();
  const replayAfterDueKey = `checkout-incident-due-replay-${randomUUID()}`;
  const replayAfterDueArgs = decisionArgs(
    replayAfterDueReport.incidentId,
    replayAfterDueReport.impactFingerprint,
    replayAfterDueKey,
    20_030,
    "CONFIRM_DEPARTED",
    "3".repeat(64),
  );
  replayAfterDueArgs.p_reassignment.dueAt = clockBoundaryDue;
  const firstDecision = ok(await client.rpc(
    "decide_checkout_presence_incident",
    replayAfterDueArgs,
  ), "decision before due boundary");

  const expiredDueArgs = decisionArgs(
    expiredDueReport.incidentId,
    expiredDueReport.impactFingerprint,
    `checkout-incident-expired-due-${randomUUID()}`,
    20_031,
    "CONFIRM_DEPARTED",
    "4".repeat(64),
  );
  expiredDueArgs.p_reassignment.dueAt = clockBoundaryDue;
  const expiredDueStateSql = `select jsonb_build_object(
      'incident',(select jsonb_build_object('status',status,'version',version,
        'currentDecisionId',current_decision_id,'resolvedAt',resolved_at)
        from public.checkout_presence_incidents
        where id='${expiredDueReport.incidentId}'::uuid),
      'target',(select jsonb_build_object('status',status,'assignmentVersion',assignment_version,
        'serviceDate',effective_service_date,'availableFrom',available_from,'dueAt',due_at)
        from public.cleaning_targets where id='${expiredDueFixture.targetId}'::uuid),
      'assignments',(select count(*) from public.cleaning_assignments
        where cleaning_target_id='${expiredDueFixture.targetId}'::uuid),
      'attempts',(select count(*) from public.cleaning_attempts
        where cleaning_target_id='${expiredDueFixture.targetId}'::uuid),
      'attemptState',(select jsonb_agg(jsonb_build_object('id',id,'status',status,
        'executionVersion',execution_version,'endedAt',ended_at,'endReason',end_reason) order by id)
        from public.cleaning_attempts where cleaning_target_id='${expiredDueFixture.targetId}'::uuid),
      'pinRevocations',(select jsonb_agg(jsonb_build_object('id',id,'revokedAt',revoked_at,
        'reason',revoke_reason_code) order by id) from public.room_pin_access_leases
        where attempt_id='${expiredDueFixture.attempt.id}'::uuid),
      'offlineRevocations',(select jsonb_agg(jsonb_build_object('leaseId',revocation.lease_id,
        'revokedAt',revocation.revoked_at,'reason',revocation.reason_code) order by revocation.lease_id)
        from private.offline_work_lease_revocations revocation
        join private.offline_work_leases lease on lease.id=revocation.lease_id
        where lease.attempt_id='${expiredDueFixture.attempt.id}'::uuid),
      'capabilityRevocations',(select jsonb_agg(jsonb_build_object('capabilityId',revocation.capability_id,
        'revokedAt',revocation.revoked_at,'reason',revocation.reason_code) order by revocation.capability_id)
        from private.attempt_capability_revocations revocation
        join private.attempt_capability_grants grant_row on grant_row.id=revocation.capability_id
        where grant_row.attempt_id='${expiredDueFixture.attempt.id}'::uuid),
      'audits',(select count(*) from public.audit_events
        where entity_id='${expiredDueReport.incidentId}'::uuid and event_type='checkout.presence_decided'),
      'notifications',(select count(*) from public.notifications
        where cleaning_target_id='${expiredDueFixture.targetId}'::uuid),
      'receipt',(select count(*) from private.command_executions
        where actor_profile_id='${adminProfileId}'::uuid
          and command_type='checkout.presence.decision'
          and idempotency_key='${expiredDueArgs.p_idempotency_key}')
    )::text`;
  const expiredDueState = psql(expiredDueStateSql);
  const lock = await holdReservationCommandLock();
  const delayedDecision = client.rpc("decide_checkout_presence_incident", expiredDueArgs);
  await waitUntil(Date.parse(clockBoundaryDue) + 250);
  await lock.release();
  const expiredDecision = await delayedDecision;
  assert(expiredDecision.error?.message === "INVALID_CHECKOUT_INCIDENT_DECISION",
    "a decision waiting on the global lock rechecks clock_timestamp and rejects an expired dueAt");
  assert(psql(`select count(*) from public.checkout_presence_incident_decisions
      where incident_id='${expiredDueReport.incidentId}'::uuid`) === "0" &&
    psql(`select count(*) from public.checkout_presence_incidents
      where id='${expiredDueReport.incidentId}'::uuid and status='open'`) === "1",
  "expired dueAt rolls back the decision, reassignment, audit, and notification transaction");
  assert(psql(expiredDueStateSql) === expiredDueState,
  "lock-wait expiry preserves incident, target, prior revocations, notifications, and receipt state");
  const replayAfterDue = ok(await client.rpc(
    "decide_checkout_presence_incident",
    replayAfterDueArgs,
  ), "completed decision replay after due elapsed");
  assert(JSON.stringify(replayAfterDue) === JSON.stringify(firstDecision),
    "completed receipt replays exactly after dueAt has elapsed");

  const handoverFixture = await fixture();
  ok(await client.rpc("start_cleaning_attempt", attemptArgs(
    handoverFixture,
    1,
    `checkout-incident-handover-setup-${randomUUID()}`,
    "c".repeat(64),
  )), "checkout incident handover-race start");
  handoverFixture.attempt.execution_version = 2;
  const handoverAt = new Date();
  const handoverServiceDate = kstDate(handoverAt);
  await ensureAvailability(nextMaidProfileId, handoverServiceDate);
  const reportVsHandover = await Promise.all([
    client.rpc("report_checkout_presence_incident", reportArgs(
      handoverFixture,
      `checkout-incident-report-handover-${randomUUID()}`,
      "d".repeat(64),
    )),
    client.rpc("manage_cleaning_attempt_lifecycle", {
      p_actor_profile_id: adminProfileId,
      p_session_id: adminSessionId,
      p_attempt_id: handoverFixture.attempt.id,
      p_expected_execution_version: 2,
      p_expected_assignment_id: handoverFixture.assignment.id,
      p_expected_assignment_revision: handoverFixture.assignment.revision,
      p_expected_profile_version: 1,
      p_action: "interrupt_handover",
      p_payload: {
        maidProfileId: nextMaidProfileId,
        sequenceNumber: 20_020,
        serviceDate: handoverServiceDate,
        availableFrom: minute(handoverAt),
        dueAt: nextKstMidnight(handoverAt),
        deactivateOld: false,
      },
      p_reason_code: "ADMIN_HANDOVER",
      p_idempotency_key: `checkout-incident-handover-race-${randomUUID()}`,
      p_request_hash: "e".repeat(64),
    }),
  ]);
  assert(reportVsHandover.filter((result) => !result.error).length === 1,
    "report versus handover has one serialized winner");
  assert(reportVsHandover.filter((result) => result.error).every((result) =>
    [
      "CHECKOUT_INCIDENT_OPEN",
      "CHECKOUT_INCIDENT_REPORT_CONFLICT",
      "CHECKOUT_NOT_MATERIALIZED",
    ].includes(result.error.message)
  ), `report versus handover loser is a stable domain conflict: ${JSON.stringify(
    reportVsHandover.map((result) => result.error?.message ?? "success"),
  )}`);
  assert(psql(`select count(*) from public.cleaning_targets
      where id='${handoverFixture.targetId}'::uuid`) === "1",
  "report versus handover never duplicates the checkout target");
  console.log("Checkout incident concurrency passed: start/complete/scheduler/handover races, report replay/conflict, and decision replay/opposition converge without deadlock.");
}
