import { execFileSync } from "node:child_process";
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
function kstDate(date = new Date()) {
  return new Date(date.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}
function minute(date = new Date()) {
  return new Date(Math.floor(date.getTime() / 60_000) * 60_000).toISOString();
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

  const roomType = ok(
    await client.from("room_types").select("id").limit(1).single(),
    "checkout incident room type",
  );
  let sequence = 9000;
  async function fixture() {
    sequence += 1;
    const roomId = randomUUID();
    const reservationId = randomUUID();
    const roomNumber = `${Date.now()}${sequence}`;
    ok(await client.from("rooms").insert({
      id: roomId,
      room_number: roomNumber,
      room_type_id: roomType.id,
      elevator_zone: "A",
    }), "checkout incident isolated room");
    const checkoutAt = new Date(Date.now() + 60 * 60_000);
    ok(await client.rpc("create_reservation", {
      p_actor_profile_id: adminProfileId,
      p_reservation_id: reservationId,
      p_room_id: roomId,
      p_check_in_at: minute(new Date(Date.now() - 24 * 60 * 60_000)),
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
    ok(await client.rpc("save_cleaning_assignment_draft", {
      p_actor_profile_id: adminProfileId,
      p_cleaning_target_id: targetId,
      p_maid_profile_id: maidProfileId,
      p_sequence_number: sequence,
      p_expected_assignment_version: 1,
      p_idempotency_key: `checkout-incident-draft-${reservationId}`,
      p_request_hash: "2".repeat(64),
    }), "checkout incident assignment draft");
    const impact = ok(await client.rpc("get_assignment_commit_impact", {
      p_actor_profile_id: adminProfileId,
      p_service_date: today,
    }), "checkout incident assignment preflight");
    ok(await client.rpc("commit_and_notify_assignments", {
      p_actor_profile_id: adminProfileId,
      p_service_date: today,
      p_expected_impact_fingerprint: impact.impactFingerprint,
      p_items: [{
        cleaningTargetId: targetId,
        expectedAssignmentVersion: 2,
        expectedAvailabilityVersion: 1,
      }],
      p_idempotency_key: `checkout-incident-notify-${reservationId}`,
      p_request_hash: "3".repeat(64),
    }), "checkout incident assignment notify");
    ok(await client.from("reservations").update({
      actual_check_in_at: minute(new Date(Date.now() - 23 * 60 * 60_000)),
    }).eq("id", reservationId), "checkout incident checked-in fixture");
    const checkoutTime = minute();
    ok(await client.rpc("manual_checkout_reservation", {
      p_actor_profile_id: adminProfileId,
      p_reservation_id: reservationId,
      p_expected_version: 1,
      p_reason_code: "TEST_GUEST_DEPARTED",
      p_effective_at: checkoutTime,
      p_idempotency_key: `checkout-incident-checkout-${reservationId}`,
      p_request_hash: "4".repeat(64),
    }), "checkout incident manual checkout");
    ok(await client.rpc("process_due_assignment_lifecycle", {
      p_actor_profile_id: adminProfileId,
      p_as_of: new Date(Date.parse(checkoutTime) + 60_000).toISOString(),
      p_idempotency_key: `checkout-incident-lifecycle-${reservationId}`,
      p_request_hash: "5".repeat(64),
    }), "checkout incident attempt activation");
    const assignment = ok(await client.from("cleaning_assignments")
      .select("id,revision").eq("cleaning_target_id", targetId).eq("is_current", true).single(),
    "checkout incident current assignment");
    const attempt = ok(await client.from("cleaning_attempts")
      .select("id,execution_version").eq("cleaning_target_id", targetId).eq("status", "scheduled").single(),
    "checkout incident scheduled attempt");
    return { reservationId, targetId, assignment, attempt };
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
  ) => ({
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
      serviceDate: today,
      availableFrom: minute(new Date(Date.now() - 60_000)),
      dueAt: minute(new Date(Date.now() + 60 * 60_000)),
    },
    p_idempotency_key: key,
    p_request_hash: hash,
  });
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
    client.rpc("process_due_reservation_transitions", {
      p_actor_profile_id: adminProfileId,
      p_as_of: minute(),
      p_idempotency_key: `checkout-incident-scheduler-race-${randomUUID()}`,
      p_request_hash: "2".repeat(64),
    }),
  ]);
  assert(reportVsScheduler.every((result) => !result.error),
    "report and an unrelated scheduler pass serialize without deadlock");
  assert(psql(`select count(*) from public.checkout_presence_incidents
      where attempt_id='${schedulerRaceFixture.attempt.id}'::uuid`) === "1",
    "scheduler race preserves exactly one incident");

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

  const handoverFixture = await fixture();
  ok(await client.rpc("start_cleaning_attempt", attemptArgs(
    handoverFixture,
    1,
    `checkout-incident-handover-setup-${randomUUID()}`,
    "c".repeat(64),
  )), "checkout incident handover-race start");
  handoverFixture.attempt.execution_version = 2;
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
        serviceDate: today,
        availableFrom: minute(new Date(Date.now() - 60_000)),
        dueAt: minute(new Date(Date.now() + 60 * 60_000)),
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
