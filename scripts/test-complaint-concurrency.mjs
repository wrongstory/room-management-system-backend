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
    authId = randomUUID();
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
  const roomId = sql(
    "select id from public.rooms order by room_number limit 1;",
  );
  let sequence = 0;
  async function complaint() {
    sequence += 1;
    const target = randomUUID(),
      assignment = randomUUID(),
      attempt = randomUUID(),
      submission = randomUUID(),
      inspection = randomUUID(),
      earning = randomUUID();
    sql(
      `insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,effective_service_date,available_from,due_at,status,assignment_version,room_type_snapshot,fee_snapshot,template_snapshot,created_by) values('${target}','${roomId}','additional','manual_room_request','complaint-race-${target}',current_date,current_date,clock_timestamp()-interval '2 hours',clock_timestamp()+interval '2 hours','approved',1,'{}',15000,'{}','${adminProfileId}');insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,service_date,sequence_number,revision,is_current,notified_at,changed_by) values('${assignment}','${target}','${maidId}',current_date,${900 + sequence},1,true,clock_timestamp()-interval '2 hours','${adminProfileId}');insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,assignment_revision,started_at,field_completed_at,ended_at,template_snapshot,room_snapshot) values('${attempt}','${target}','${assignment}','${maidId}',1,'approved',1,clock_timestamp()-interval '90 minutes',clock_timestamp()-interval '30 minutes',clock_timestamp()-interval '20 minutes','{}','{}');insert into public.cleaning_submissions(id,cleaning_attempt_id,client_submission_id,version,status,photo_manifest,submitted_by,submitted_at) values('${submission}','${attempt}','${randomUUID()}',1,'approved','{}','${maidId}',clock_timestamp()-interval '10 minutes');insert into public.inspection_decisions(id,submission_id,decision,reason_code,decided_by,decided_at) values('${inspection}','${submission}','approved','QUALITY_OK','${adminProfileId}',clock_timestamp()-interval '5 minutes');insert into public.earnings(id,earning_entitlement_id,submission_id,maid_profile_id,earned_on,base_amount,bomb_room_bonus) values('${earning}','${submission}','${submission}','${maidId}',current_date,15000,0);`,
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
  console.log(
    "Complaint concurrency passed: identical replay, decision CAS, appeal/correction CAS.",
  );
}
