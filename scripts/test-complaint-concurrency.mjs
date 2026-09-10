import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

function assert(value, message) {
  if (!value) throw new Error(message);
}
function ok(result, label) {
  if (result.error)
    throw new Error(
      `${label} failed (${String(result.error.code ?? "DB_ERROR")})`,
    );
  return result.data;
}
const container = "supabase_db_room-management-system-backend";
const psqlArgs = [
  "exec",
  "-i",
  container,
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

export async function testComplaintConcurrency(client, adminProfileId) {
  const url = new URL(client.supabaseUrl);
  assert(
    ["localhost", "127.0.0.1"].includes(url.hostname),
    "complaint races require local Supabase",
  );
  function sql(statement) {
    try {
      return execFileSync("docker", psqlArgs, {
        input: `set statement_timeout='10s';${statement}`,
        encoding: "utf8",
        timeout: 15000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    } catch {
      throw new Error(
        "complaint local fixture/check failed (raw details redacted)",
      );
    }
  }
  const maidId = randomUUID(),
    authId = randomUUID(),
    compensationMaidId = randomUUID(),
    compensationAuthId = randomUUID();
  ok(
    await client.auth.admin.createUser({
      id: authId,
      email: `complaint-${authId}@test.invalid`,
      password: `T:${randomUUID()}`,
      email_confirm: true,
    }),
    "complaint Auth",
  );
  ok(
    await client.auth.admin.createUser({
      id: compensationAuthId,
      email: `complaint-comp-${compensationAuthId}@test.invalid`,
      password: `T:${randomUUID()}`,
      email_confirm: true,
    }),
    "compensation maid Auth",
  );
  ok(
    await client
      .from("profiles")
      .insert({
        id: maidId,
        auth_user_id: authId,
        display_name: `complaint-${maidId}`,
        display_name_normalized: `complaint-${maidId}`,
        login_id: `complaint-${maidId}`,
        login_id_normalized: `complaint-${maidId}`,
        login_sequence: 0,
        role: "maid",
        status: "active",
        must_change_password: false,
      }),
    "complaint maid",
  );
  ok(
    await client.from("profiles").insert({
      id: compensationMaidId,
      auth_user_id: compensationAuthId,
      display_name: `complaint-comp-${compensationMaidId}`,
      display_name_normalized: `complaint-comp-${compensationMaidId}`,
      login_id: `complaint-comp-${compensationMaidId}`,
      login_id_normalized: `complaint-comp-${compensationMaidId}`,
      login_sequence: 0,
      role: "maid",
      status: "active",
      must_change_password: false,
    }),
    "compensation maid",
  );
  sql(`insert into public.availability_versions(id,maid_profile_id,week_start,version,status,is_current,submitted_at)
    values(gen_random_uuid(),'${compensationMaidId}',current_date-(extract(isodow from current_date)::integer-1),1,'submitted',true,clock_timestamp());
    insert into public.availability_days(availability_version_id,work_date,available)
    select version.id,version.week_start+day_offset,true
    from public.availability_versions version cross join generate_series(0,6) day_offset
    where version.maid_profile_id='${compensationMaidId}' and version.is_current;
    insert into public.cleaning_template_versions(id,room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,published_at,created_by)
    select gen_random_uuid(),room_type.id,'reclean',coalesce(max(template.version),0)+1,'published',30,'[]',clock_timestamp(),'${adminProfileId}'
    from public.room_types room_type left join public.cleaning_template_versions template
      on template.room_type_id=room_type.id and template.cleaning_kind='reclean'
    group by room_type.id having count(*) filter(where template.status='published')=0;`);
  let sequence = 0;
  async function complaint() {
    sequence += 1;
    const [roomTypeId, roomTypeCode] = sql(
      "select id||'|'||code from public.room_types order by code limit 1;",
    ).split("|");
    const roomId = randomUUID();
    sql(`insert into public.rooms(id,room_number,room_type_id)
      values('${roomId}','${Date.now()}${sequence}','${roomTypeId}');`);
    const target = randomUUID(),
      assignment = randomUUID(),
      attempt = randomUUID(),
      submission = randomUUID(),
      inspection = randomUUID(),
      earning = randomUUID();
    sql(
      `insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,effective_service_date,available_from,due_at,status,assignment_version,room_type_snapshot,fee_snapshot,template_snapshot,created_by) values('${target}','${roomId}','additional','manual_room_request','complaint-race-${target}',current_date,current_date,clock_timestamp()-interval '2 hours',clock_timestamp()+interval '2 hours','approved',1,jsonb_build_object('id','${roomTypeId}','code','${roomTypeCode}'),15000,'{}','${adminProfileId}');insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,service_date,sequence_number,revision,is_current,notified_at,changed_by) values('${assignment}','${target}','${maidId}',current_date,${900 + sequence},1,true,clock_timestamp()-interval '2 hours','${adminProfileId}');insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,assignment_revision,started_at,field_completed_at,ended_at,template_snapshot,room_snapshot) values('${attempt}','${target}','${assignment}','${maidId}',1,'approved',1,clock_timestamp()-interval '90 minutes',clock_timestamp()-interval '30 minutes',clock_timestamp()-interval '20 minutes','{}','{}');insert into public.cleaning_submissions(id,cleaning_attempt_id,client_submission_id,version,status,photo_manifest,submitted_by,submitted_at) values('${submission}','${attempt}','${randomUUID()}',1,'approved','{}','${maidId}',clock_timestamp()-interval '10 minutes');insert into public.inspection_decisions(id,submission_id,decision,reason_code,decided_by,decided_at) values('${inspection}','${submission}','approved','QUALITY_OK','${adminProfileId}',clock_timestamp()-interval '5 minutes');insert into public.earnings(id,earning_entitlement_id,submission_id,maid_profile_id,earned_on,base_amount,bomb_room_bonus) values('${earning}','${submission}','${submission}','${maidId}',current_date,15000,0);`,
    );
    const created = ok(
      await client.rpc("create_complaint_case", {
        p_actor_profile_id: adminProfileId,
        p_original_earning_id: earning,
        p_category: "cleanliness_general",
        p_expected_version: 0,
        p_idempotency_key: `complaint-race-create-${randomUUID()}`,
        p_request_hash: "1".repeat(64),
      }),
      "complaint create",
    );
    ok(
      await client.rpc("start_complaint_review", {
        p_actor_profile_id: adminProfileId,
        p_complaint_id: created.id,
        p_expected_version: 1,
        p_idempotency_key: `complaint-race-review-${randomUUID()}`,
        p_request_hash: "2".repeat(64),
      }),
      "complaint review",
    );
    return created.id;
  }
  const exact = await complaint();
  const sameKey = `complaint-same-${randomUUID()}`;
  const same = await Promise.all(
    [0, 1].map(() =>
      client.rpc("decide_complaint_case", {
        p_actor_profile_id: adminProfileId,
        p_complaint_id: exact,
        p_expected_version: 2,
        p_finding: "confirmed",
        p_penalty_score: 0,
        p_rework_required: false,
        p_idempotency_key: sameKey,
        p_request_hash: "3".repeat(64),
      }),
    ),
  );
  assert(
    same.every((result) => !result.error) &&
      JSON.stringify(same[0].data) === JSON.stringify(same[1].data),
    "concurrent identical decision returns one logical receipt",
  );
  assert(
    sql(
      `select count(*)=1 from public.complaint_decisions where complaint_case_id='${exact}';`,
    ) === "t",
    "identical decision appends once",
  );
  const raced = await complaint();
  const decisions = await Promise.all(
    [0, 1].map((index) =>
      client.rpc("decide_complaint_case", {
        p_actor_profile_id: adminProfileId,
        p_complaint_id: raced,
        p_expected_version: 2,
        p_finding: index ? "false" : "confirmed",
        p_penalty_score: index ? 10 : 0,
        p_rework_required: Boolean(index),
        p_idempotency_key: `complaint-decision-${index}-${randomUUID()}`,
        p_request_hash: String(index + 4).repeat(64),
      }),
    ),
  );
  assert(
    decisions.filter((result) => !result.error).length === 1 &&
      decisions.filter((result) => result.error).length === 1,
    "different concurrent decisions have one CAS winner",
  );
  assert(
    sql(
      `select count(*)=1 from public.complaint_decisions where complaint_case_id='${raced}';`,
    ) === "t",
    "decision race appends once",
  );
  const current = ok(
    await client.rpc("get_complaint_case", {
      p_actor_profile_id: adminProfileId,
      p_complaint_id: raced,
    }),
    "complaint current",
  );
  const race = await Promise.all([
    client.rpc("respond_to_complaint", {
      p_actor_profile_id: maidId,
      p_complaint_id: raced,
      p_expected_version: current.version,
      p_response_type: "appealed",
      p_appeal_reason_code: "timeline_mismatch",
      p_idempotency_key: `complaint-appeal-${randomUUID()}`,
      p_request_hash: "6".repeat(64),
    }),
    client.rpc("correct_complaint_decision", {
      p_actor_profile_id: adminProfileId,
      p_complaint_id: raced,
      p_expected_version: current.version,
      p_finding: "unverifiable",
      p_penalty_score: 5,
      p_rework_required: false,
      p_idempotency_key: `complaint-correct-${randomUUID()}`,
      p_request_hash: "7".repeat(64),
    }),
  ]);
  assert(
    race.filter((result) => !result.error).length === 1 &&
      race.filter((result) => result.error).length === 1,
    "appeal versus correction has one current-pointer CAS winner",
  );

  const materializeCase = await complaint();
  const materializeDecision = ok(await client.rpc("decide_complaint_case", {
    p_actor_profile_id: adminProfileId,
    p_complaint_id: materializeCase,
    p_expected_version: 2,
    p_finding: "confirmed",
    p_penalty_score: 0,
    p_rework_required: true,
    p_idempotency_key: `complaint-comp-decide-${randomUUID()}`,
    p_request_hash: "8".repeat(64),
  }), "compensation decision");
  const sameMaterializeKey = `complaint-comp-materialize-${randomUUID()}`;
  const materializeArgs = {
    p_actor_profile_id: adminProfileId,
    p_complaint_id: materializeCase,
    p_expected_version: 3,
    p_complaint_decision_id: materializeDecision.currentDecisionId,
    p_assignee_maid_profile_id: compensationMaidId,
    p_compensation_amount: 15000,
    p_idempotency_key: sameMaterializeKey,
    p_request_hash: "9".repeat(64),
  };
  const materialized = await Promise.all([
    client.rpc("materialize_complaint_rework", materializeArgs),
    client.rpc("materialize_complaint_rework", materializeArgs),
  ]);
  assert(materialized.every((result) => !result.error) &&
    JSON.stringify(materialized[0].data) === JSON.stringify(materialized[1].data),
  `concurrent materialize retry returns one logical result (${materialized.map((result) => result.error?.code ?? "OK").join(",")})`);
  const reworkTargetId = materialized[0].data.reworkDecision.reworkCleaningTargetId;
  assert(sql(`select count(*)=1 from public.complaint_compensation_decisions where complaint_case_id='${materializeCase}';`) === "t" &&
    sql(`select count(*)=1 from public.cleaning_targets where id='${reworkTargetId}' and source='post_approval_complaint_reclean';`) === "t",
  "materialize retry creates one decision and target");
  const reworkAttemptId = randomUUID();
  const reworkSubmissionId = randomUUID();
  sql(`insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,
      attempt_number,status,assignment_revision,started_at,field_completed_at,ended_at,
      template_snapshot,room_snapshot)
    select '${reworkAttemptId}',target.id,assignment.id,'${compensationMaidId}',1,'submitted',
      assignment.revision,clock_timestamp()-interval '40 minutes',clock_timestamp()-interval '10 minutes',
      clock_timestamp()-interval '10 minutes',target.template_snapshot,jsonb_build_object('roomId',target.room_id)
    from public.cleaning_targets target join public.cleaning_assignments assignment
      on assignment.cleaning_target_id=target.id and assignment.is_current where target.id='${reworkTargetId}';
    insert into public.cleaning_submissions(id,cleaning_attempt_id,client_submission_id,version,status,
      photo_manifest,submitted_by,submitted_at)
    values('${reworkSubmissionId}','${reworkAttemptId}','${randomUUID()}',1,'submitted','{}',
      '${compensationMaidId}',clock_timestamp()-interval '5 minutes');
    alter table private.submission_photo_binding_sets disable trigger submission_photo_seal_validate;
    insert into private.submission_photo_binding_sets(submission_id,cleaning_attempt_id,photo_count,sealed_at)
    values('${reworkSubmissionId}','${reworkAttemptId}',1,clock_timestamp()-interval '5 minutes');
    alter table private.submission_photo_binding_sets enable trigger submission_photo_seal_validate;
    insert into private.submission_current_pointers(cleaning_attempt_id,submission_id,revision)
    values('${reworkAttemptId}','${reworkSubmissionId}',1);
    update public.cleaning_targets set status='inspection_pending' where id='${reworkTargetId}';`);
  const approvalArgs = {
    p_actor_profile_id: adminProfileId,
    p_submission_id: reworkSubmissionId,
    p_reason_code: "QUALITY_OK",
    p_idempotency_key: `complaint-comp-approve-${randomUUID()}`,
    p_request_hash: "d".repeat(64),
  };
  const approvals = await Promise.all([
    client.rpc("approve_cleaning_submission", approvalArgs),
    client.rpc("approve_cleaning_submission", approvalArgs),
  ]);
  assert(approvals.every((result) => !result.error) &&
    approvals[0].data.earningId === approvals[1].data.earningId &&
    sql(`select count(*)=1 from public.compensation_entitlements where submission_id='${reworkSubmissionId}';`) === "t" &&
    sql(`select count(*)=1 from public.earnings where submission_id='${reworkSubmissionId}' and compensation_entitlement_id is not null;`) === "t",
  `concurrent compensation approval is exactly once (${approvals.map((result) => result.error?.code ?? "OK").join(",")})`);

  const raceErrors = [];
  function assertStableRaceErrors(results, label, allowedMessages) {
    for (const result of results) {
      if (!result.error) continue;
      const observation = {
        code: String(result.error.code ?? ""),
        message: String(result.error.message ?? ""),
      };
      raceErrors.push(observation);
      assert(observation.code !== "40P01", `${label} must never deadlock`);
      assert(
        allowedMessages.some((message) => observation.message.includes(message)),
        `${label} returned a generic or unapproved error (${observation.code})`,
      );
    }
  }
  async function decidedReworkCase(label) {
    const complaintId = await complaint();
    const decision = ok(await client.rpc("decide_complaint_case", {
      p_actor_profile_id: adminProfileId,
      p_complaint_id: complaintId,
      p_expected_version: 2,
      p_finding: "confirmed",
      p_penalty_score: 0,
      p_rework_required: true,
      p_idempotency_key: `${label}-decide-${randomUUID()}`,
      p_request_hash: "a".repeat(64),
    }), `${label} decision`);
    return { complaintId, decision };
  }
  async function materializedRaceFixture(label) {
    const fixture = await decidedReworkCase(label);
    const materializedResult = ok(await client.rpc("materialize_complaint_rework", {
      p_actor_profile_id: adminProfileId,
      p_complaint_id: fixture.complaintId,
      p_expected_version: 3,
      p_complaint_decision_id: fixture.decision.currentDecisionId,
      p_assignee_maid_profile_id: compensationMaidId,
      p_compensation_amount: 15000,
      p_idempotency_key: `${label}-materialize-${randomUUID()}`,
      p_request_hash: "b".repeat(64),
    }), `${label} materialize`);
    return {
      ...fixture,
      materializedResult,
      targetId: materializedResult.reworkDecision.reworkCleaningTargetId,
      assignmentId: materializedResult.assignment.id,
    };
  }

  const correctionRaceCase = await complaint();
  const correctionRaceDecision = ok(await client.rpc("decide_complaint_case", {
    p_actor_profile_id: adminProfileId,
    p_complaint_id: correctionRaceCase,
    p_expected_version: 2,
    p_finding: "confirmed",
    p_penalty_score: 0,
    p_rework_required: true,
    p_idempotency_key: `complaint-comp-race-decide-${randomUUID()}`,
    p_request_hash: "a".repeat(64),
  }), "correction race decision");
  const materializeVsCorrection = await Promise.all([
    client.rpc("materialize_complaint_rework", {
      p_actor_profile_id: adminProfileId,
      p_complaint_id: correctionRaceCase,
      p_expected_version: 3,
      p_complaint_decision_id: correctionRaceDecision.currentDecisionId,
      p_assignee_maid_profile_id: compensationMaidId,
      p_compensation_amount: 0,
      p_idempotency_key: `complaint-comp-race-materialize-${randomUUID()}`,
      p_request_hash: "b".repeat(64),
    }),
    client.rpc("correct_complaint_decision", {
      p_actor_profile_id: adminProfileId,
      p_complaint_id: correctionRaceCase,
      p_expected_version: 3,
      p_finding: "false",
      p_penalty_score: 0,
      p_rework_required: false,
      p_idempotency_key: `complaint-comp-race-correct-${randomUUID()}`,
      p_request_hash: "c".repeat(64),
    }),
  ]);
  assert(materializeVsCorrection.filter((result) => !result.error).length === 1,
    "materialize versus semantic correction has one CAS winner");
  assertStableRaceErrors(materializeVsCorrection, "materialize/correction",
    ["STALE_VERSION", "COMPLAINT_REWORK_DECISION_STALE"]);
  const compCount = Number(sql(`select count(*) from public.complaint_compensation_decisions where complaint_case_id='${correctionRaceCase}';`));
  const targetCount = Number(sql(`select count(*) from public.cleaning_targets where complaint_compensation_decision_id in (select id from public.complaint_compensation_decisions where complaint_case_id='${correctionRaceCase}');`));
  const assignmentCount = Number(sql(`select count(*) from public.cleaning_assignments where cleaning_target_id in (select rework_cleaning_target_id from public.complaint_compensation_decisions where complaint_case_id='${correctionRaceCase}') and is_current;`));
  assert((compCount === 0 && targetCount === 0 && assignmentCount === 0) ||
    (compCount === 1 && targetCount === 1 && assignmentCount === 1),
  "race leaves zero ghost rows or one complete executable assignment");

  for (let iteration = 0; iteration < 4; iteration += 1) {
    const label = `complaint-comp-repeat-materialize-${iteration}`;
    const fixture = await decidedReworkCase(label);
    const results = await Promise.all([
      client.rpc("materialize_complaint_rework", {
        p_actor_profile_id: adminProfileId,
        p_complaint_id: fixture.complaintId,
        p_expected_version: 3,
        p_complaint_decision_id: fixture.decision.currentDecisionId,
        p_assignee_maid_profile_id: compensationMaidId,
        p_compensation_amount: iteration,
        p_idempotency_key: `${label}-materialize-${randomUUID()}`,
        p_request_hash: "c".repeat(64),
      }),
      client.rpc("correct_complaint_decision", {
        p_actor_profile_id: adminProfileId,
        p_complaint_id: fixture.complaintId,
        p_expected_version: 3,
        p_finding: "false",
        p_penalty_score: 0,
        p_rework_required: false,
        p_idempotency_key: `${label}-correct-${randomUUID()}`,
        p_request_hash: "d".repeat(64),
      }),
    ]);
    assert(results.filter((result) => !result.error).length === 1,
      `${label} has one winner`);
    assertStableRaceErrors(results, label,
      ["STALE_VERSION", "COMPLAINT_REWORK_DECISION_STALE"]);
    const counts = sql(`select
      (select count(*) from public.complaint_compensation_decisions where complaint_case_id='${fixture.complaintId}')||'|'||
      (select count(*) from public.cleaning_targets where complaint_compensation_decision_id in
        (select id from public.complaint_compensation_decisions where complaint_case_id='${fixture.complaintId}'))||'|'||
      (select count(*) from public.cleaning_assignments where cleaning_target_id in
        (select rework_cleaning_target_id from public.complaint_compensation_decisions
          where complaint_case_id='${fixture.complaintId}') and is_current);`);
    assert(counts === "0|0|0" || counts === "1|1|1",
      `${label} leaves no partial compensation graph`);
  }

  for (let iteration = 0; iteration < 4; iteration += 1) {
    const label = `complaint-comp-start-correct-${iteration}`;
    const fixture = await materializedRaceFixture(label);
    const activated = JSON.parse(sql(`select private.activate_cleaning_attempt_at(
      '${adminProfileId}','${fixture.targetId}',clock_timestamp(),
      '${fixture.assignmentId}',1)::text;`));
    const results = await Promise.all([
      client.rpc("start_cleaning_attempt", {
        p_actor_profile_id: compensationMaidId,
        p_attempt_id: activated.attemptId,
        p_expected_execution_version: 1,
        p_expected_assignment_id: fixture.assignmentId,
        p_expected_assignment_revision: 1,
        p_idempotency_key: `${label}-start-${randomUUID()}`,
        p_request_hash: "e".repeat(64),
      }),
      client.rpc("correct_complaint_decision", {
        p_actor_profile_id: adminProfileId,
        p_complaint_id: fixture.complaintId,
        p_expected_version: 4,
        p_finding: "false",
        p_penalty_score: 0,
        p_rework_required: false,
        p_idempotency_key: `${label}-correct-${randomUUID()}`,
        p_request_hash: "f".repeat(64),
      }),
    ]);
    assertStableRaceErrors(results, label, ["COMPLAINT_REWORK_PRESTART_FROZEN"]);
    assert(!results[0].error,
      `${label} start remains executable (${results[0].error?.code ?? "OK"}: ${results[0].error?.message ?? ""})`);
    assert(sql(`select status='in_progress' and started_at is not null
      from public.cleaning_attempts where id='${activated.attemptId}';`) === "t",
    `${label} ends with one started operational attempt`);
    assert(sql(`select
      (select count(*) from public.cleaning_targets where id='${fixture.targetId}')||'|'||
      (select count(*) from public.cleaning_assignments where cleaning_target_id='${fixture.targetId}' and is_current)||'|'||
      (select count(*) from public.compensation_entitlements where rework_cleaning_target_id='${fixture.targetId}')||'|'||
      (select count(*) from public.earnings where compensation_entitlement_id in
        (select id from public.compensation_entitlements where rework_cleaning_target_id='${fixture.targetId}'));`) === "1|1|0|0",
    `${label} preserves one target/assignment and no premature ledger rows`);
    ok(await client.rpc("complete_cleaning_attempt_field_work", {
      p_actor_profile_id: compensationMaidId,
      p_attempt_id: activated.attemptId,
      p_expected_execution_version: 2,
      p_expected_assignment_id: fixture.assignmentId,
      p_expected_assignment_revision: 1,
      p_idempotency_key: `${label}-complete-${randomUUID()}`,
      p_request_hash: "0".repeat(64),
    }), `${label} completion cleanup`);
  }

  for (let iteration = 0; iteration < 4; iteration += 1) {
    const label = `complaint-comp-approve-correct-${iteration}`;
    const fixture = await materializedRaceFixture(label);
    const attemptId = randomUUID();
    const submissionId = randomUUID();
    sql(`insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,
        attempt_number,status,assignment_revision,started_at,field_completed_at,ended_at,
        template_snapshot,room_snapshot)
      select '${attemptId}',target.id,assignment.id,'${compensationMaidId}',1,'submitted',
        assignment.revision,clock_timestamp()-interval '40 minutes',clock_timestamp()-interval '10 minutes',
        clock_timestamp()-interval '10 minutes',target.template_snapshot,jsonb_build_object('roomId',target.room_id)
      from public.cleaning_targets target join public.cleaning_assignments assignment
        on assignment.cleaning_target_id=target.id and assignment.is_current where target.id='${fixture.targetId}';
      insert into public.cleaning_submissions(id,cleaning_attempt_id,client_submission_id,version,status,
        photo_manifest,submitted_by,submitted_at)
      values('${submissionId}','${attemptId}','${randomUUID()}',1,'submitted','{}',
        '${compensationMaidId}',clock_timestamp()-interval '5 minutes');
      alter table private.submission_photo_binding_sets disable trigger submission_photo_seal_validate;
      insert into private.submission_photo_binding_sets(submission_id,cleaning_attempt_id,photo_count,sealed_at)
      values('${submissionId}','${attemptId}',1,clock_timestamp()-interval '5 minutes');
      alter table private.submission_photo_binding_sets enable trigger submission_photo_seal_validate;
      insert into private.submission_current_pointers(cleaning_attempt_id,submission_id,revision)
      values('${attemptId}','${submissionId}',1);
      update public.cleaning_targets set status='inspection_pending' where id='${fixture.targetId}';`);
    const results = await Promise.all([
      client.rpc("approve_cleaning_submission", {
        p_actor_profile_id: adminProfileId,
        p_submission_id: submissionId,
        p_reason_code: "QUALITY_OK",
        p_idempotency_key: `${label}-approve-${randomUUID()}`,
        p_request_hash: "1".repeat(64),
      }),
      client.rpc("correct_complaint_decision", {
        p_actor_profile_id: adminProfileId,
        p_complaint_id: fixture.complaintId,
        p_expected_version: 4,
        p_finding: "false",
        p_penalty_score: 0,
        p_rework_required: false,
        p_idempotency_key: `${label}-correct-${randomUUID()}`,
        p_request_hash: "2".repeat(64),
      }),
    ]);
    assert(results.every((result) => !result.error),
      `${label} serializes without invalidating started provenance`);
    assertStableRaceErrors(results, label, []);
    assert(sql(`select
      (select count(*) from public.compensation_entitlements where submission_id='${submissionId}')||'|'||
      (select count(*) from public.earnings where submission_id='${submissionId}'
        and compensation_entitlement_id is not null)||'|'||
      (select count(*) from public.complaint_decisions where complaint_case_id='${fixture.complaintId}');`) === "1|1|2",
    `${label} ends with exactly one entitlement/earning and append-only correction`);
  }

  assert(raceErrors.every((error) => error.code !== "40P01"),
    "repeated complaint races have SQLSTATE 40P01=0 and generic error=0");
  console.log(
    `Complaint concurrency passed: repeated materialize/correction, correction/start, correction/approval; SQLSTATE 40P01=0, generic error=0, stable losers=${raceErrors.length}.`,
  );
}
