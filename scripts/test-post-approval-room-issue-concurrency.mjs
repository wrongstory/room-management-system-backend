import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateLocalDockerEndpoint } from './db-lint-baseline.mjs';

// SOURCE CANDIDATE / NOT RUN by author. Fresh disposable local metadata only.
// No Drive calls, real media, credentials, remote target overrides or policy skips.
const root = fileURLToPath(new URL('..', import.meta.url));
const cli = fileURLToPath(new URL('../node_modules/supabase/dist/supabase.js', import.meta.url));
const args = ['exec', '-i', 'supabase_db_room-management-system-backend', 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'];
const source = readFileSync(new URL('../supabase/tests/post_approval_room_issue_ledger.sql', import.meta.url), 'utf8');
const from = '-- BEGIN POST APPROVAL ROOM ISSUE SHARED FIXTURE', to = '-- END POST APPROVAL ROOM ISSUE SHARED FIXTURE';
assert.equal(source.split(from).length, 2); assert.equal(source.split(to).length, 2);
const fixture = source.split(from)[1].split(to)[0];
assert(!/\b(?:no_plan|plan|finish)\s*\(|\\ir/i.test(fixture));
const uploadStart = source.indexOf('create function pg_temp.typed_upload(');
assert(uploadStart >= 0); const uploadHelper = source.slice(uploadStart, source.indexOf('end $$;', uploadStart) + 7);
const singleFrom = '-- BEGIN POST APPROVAL ROOM ISSUE SINGLE FIXTURE', singleTo = '-- END POST APPROVAL ROOM ISSUE SINGLE FIXTURE';
assert.equal(source.split(singleFrom).length, 2); assert.equal(source.split(singleTo).length, 2);
const singleFixture = source.split(singleFrom)[1].split(singleTo)[0];
assert(!/\b(?:no_plan|plan|finish)\s*\(|\\ir/i.test(singleFixture));
const singleFunctions = singleFixture.slice(singleFixture.indexOf('create function pg_temp.single_admission'));
const idFunction = fixture.slice(fixture.indexOf('create function pg_temp.lid('), fixture.indexOf('insert into auth.users'));
const id = n => `b3360000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const key = n => n.toString(16).padStart(64, '0');
const known = ['SESSION_REVOKED', 'CAPABILITY_ACCESS_REQUIRED', 'POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED',
  'PHOTO_UPLOAD_RATE_LIMITED', 'PHOTO_UPLOAD_LIMIT_EXCEEDED', 'PHOTO_STORAGE_QUOTA_EXCEEDED', 'PHOTO_UPLOAD_FENCE_CONFLICT',
  'POST_APPROVAL_ROOM_ISSUE_DELETE_NOT_ALLOWED', 'POST_APPROVAL_ROOM_ISSUE_EVIDENCE_INVALID', 'POST_APPROVAL_ROOM_ISSUE_DRAFT_CONFLICT', 'IDEMPOTENCY_KEY_REUSED'];
let phase = 'preflight', cleanup = false;
const pending = [], uploaded = new Map();
function sql(input) {
  try { return execFileSync('docker', args, { cwd: root, input: `set statement_timeout='20s';${input}`, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 25000, maxBuffer: 8 * 1024 * 1024 }).trim(); }
  catch { throw new Error('POST_APPROVAL_LOCAL_SQL_FAILED'); }
}
function done(child) {
  let output = '', errors = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errors += data; });
  return new Promise(resolve => { child.once('error', () => resolve({ code: null, exitCode: -1, output: '' }));
    child.once('close', exitCode => resolve({ exitCode, code: known.find(code => errors.includes(code)) ?? null, output: output.trim() })); });
}
async function race(firstSql, secondSql, suffix, { rollbackFirst = false, rollbackSecond = false } = {}) {
  assert(/^[a-z_]+$/.test(suffix));
  const first = spawn('docker', args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] }), firstDone = done(first);
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { first.kill(); reject(new Error('POST_APPROVAL_HOLDER_TIMEOUT')); }, 15000);
    first.stdout.on('data', data => { if (data.toString().includes('POST_APPROVAL_LOCK_READY')) { clearTimeout(timer); resolve(); } });
    first.once('close', () => { clearTimeout(timer); reject(new Error('POST_APPROVAL_HOLDER_FAILED')); });
  });
  pending.push(first);
  first.stdin.write(`begin;set local statement_timeout='20s';set local idle_in_transaction_session_timeout='25s';${firstSql}\n\\echo POST_APPROVAL_LOCK_READY\n`);
  await ready;
  const second = spawn('docker', args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] }), secondDone = done(second);
  const name = `post_approval_contender_${suffix}`; pending.push(second);
  second.stdin.end(`begin;set local application_name='${name}';set local statement_timeout='20s';${secondSql}${rollbackSecond ? 'rollback' : 'commit'};`);
  try {
    let blocked = false; const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { if (sql(`select exists(select 1 from pg_stat_activity where application_name='${name}' and wait_event_type='Lock' and xact_start is not null);`) === 't') { blocked = true; break; }
      await new Promise(resolve => setTimeout(resolve, 50)); }
    assert(blocked, 'Actual two-session database lock overlap required');
  } finally { first.stdin.end(`${rollbackFirst ? 'rollback' : 'commit'};\n\\q\n`); assert.equal((await firstDone).exitCode, 0); }
  return secondDone;
}
const oldFixture = `
insert into auth.users(id) values('${id(104)}');
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,login_sequence,role,status,must_change_password)
values('${id(4)}','${id(104)}','late-shared-admin','late-shared-admin','late-shared-admin','late-shared-admin',0,'admin','active',false);
insert into auth.sessions(id,user_id,not_after) values('${id(206)}','${id(104)}',clock_timestamp()+interval '1 day');
insert into public.cleaning_template_versions(id,room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,created_by)
select '${id(7000)}',id,'additional',9,'published',1,private.flat_cleaning_photo_slots(),'${id(1)}' from public.room_types where code='standard';
do $$ declare n integer; r public.rooms; snapshot jsonb; begin
 for n in 1..9 loop
  select * into r from public.rooms where room_type_id=(select id from public.room_types where code='standard') order by room_number offset n+3 limit 1;
  snapshot:=jsonb_build_object('id','${id(7000)}','version',9,'photoSlots',private.flat_cleaning_photo_slots(),'durationMinutes',1);
  insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,effective_service_date,status,assignment_version,room_type_snapshot,fee_snapshot,template_snapshot,created_by)
  values(('b3360000-0000-4000-8000-'||lpad((7100+n)::text,12,'0'))::uuid,r.id,'additional','manual_room_request','late-current-'||n,current_date,current_date,'notified',2,jsonb_build_object('code','standard'),10000,snapshot,'${id(1)}');
  insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,notified_at,changed_by,service_date)
  values(('b3360000-0000-4000-8000-'||lpad((7200+n)::text,12,'0'))::uuid,('b3360000-0000-4000-8000-'||lpad((7100+n)::text,12,'0'))::uuid,'${id(2)}',n+10,2,clock_timestamp()-interval '2 hours','${id(1)}',current_date);
  insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,assignment_revision,template_snapshot,room_snapshot,started_at,field_completed_at,ended_at)
  values(('b3360000-0000-4000-8000-'||lpad((7300+n)::text,12,'0'))::uuid,('b3360000-0000-4000-8000-'||lpad((7100+n)::text,12,'0'))::uuid,('b3360000-0000-4000-8000-'||lpad((7200+n)::text,12,'0'))::uuid,'${id(2)}',1,'field_completed',2,snapshot,jsonb_build_object('roomId',r.id),clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour',clock_timestamp()-interval '1 hour');
 end loop;end $$;`;
function late(n, { actor = 2, session = 202 } = {}) {
  return `select public.admit_post_approval_room_issue_evidence_upload('${id(actor)}','${id(session)}','${id(4002)}','${id(6100 + n)}','${id(6300 + n)}',1,0,0,'${key(9000 + n)}');`;
}
function old(n) { return `select public.admit_photo_collection_upload('${id(2)}','${id(202)}','${id(7300 + n)}','${id(7200 + n)}',2,(select id from private.target_photo_slot_snapshots where cleaning_target_id='${id(7100 + n)}' and slot_key='cleaning-proof'),'${id(7400 + n)}',0,0,'${key(8000 + n)}');`; }
function rate(count) { return `insert into private.photo_upload_admission_limits values('${id(2)}',date_trunc('minute',clock_timestamp()),${count}) on conflict(actor_profile_id) do update set minute_started_at=excluded.minute_started_at,occurrence_count=excluded.occurrence_count;`; }
function finalize(n, actor = 2, session = 202) { return `select public.finalize_post_approval_room_issue_report('${id(actor)}','${id(session)}','${id(4002)}','${id(n)}',1,1,'synthetic memo',jsonb_build_array(jsonb_build_object('evidenceId','${id(n + 100)}','revision',1,'displayOrder',0)),'${key(n + 200)}','${key(n + 300)}');`; }
function sharedDraft(actor, session, revision) { return `select public.save_post_approval_room_issue_draft('${id(actor)}','${id(session)}','${id(4002)}','${id(6190)}',${revision},'synthetic memo','${key(19000 + revision)}','${key(19100 + revision)}');`; }
function prepare(n) { const op = uploaded.get(n); assert(op && /^[0-9a-f-]{36}$/.test(op)); return `select public.prepare_post_approval_room_issue_evidence_delete('${id(2)}','${id(202)}','${op}',1,repeat('f',64));`; }
function rejected(result, codes) { assert.notEqual(result.exitCode, 0); assert((Array.isArray(codes) ? codes : [codes]).includes(result.code)); }
const protectedRelations = ['public.rooms','public.cleaning_targets','public.cleaning_assignments','public.cleaning_attempts',
  'public.cleaning_submissions','public.inspection_decisions','public.earnings','public.payroll_cycles',
  'private.attempt_photo_versions','private.submission_photo_bindings','private.submission_photo_binding_sets',
  'private.photo_provider_objects','private.photo_upload_acceptances','private.photo_retention_records','private.photo_retention_links',
  'private.attempt_room_issue_reports'];
const digestSql = `select md5(jsonb_build_object(${protectedRelations.map(relation => `'${relation}',(select coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text),'[]'::jsonb) from ${relation} r)`).join(',')},
 'oldDTO',private.submission_projection('${id(4002)}'))::text);`;
const emptyRelations = ['auth.users','auth.sessions','public.profiles','public.reservations','public.cleaning_targets','public.cleaning_assignments',
  'public.cleaning_attempts','public.cleaning_submissions','public.inspection_decisions','public.earnings','public.payroll_cycles',
  'private.photo_upload_admissions','private.photo_upload_operations','private.photo_upload_states','private.photo_provider_objects',
  'private.photo_upload_acceptances','private.photo_provider_identity_tombstones','private.photo_storage_names','private.photo_drive_folder_identities',
  'private.photo_quota_pending','private.command_executions','private.notification_delivery_outbox',
  'private.post_approval_room_issue_drafts','private.post_approval_room_issue_draft_revisions','private.post_approval_room_issue_reports'];
export const postApprovalRoomIssueFreshRelations = Object.freeze([...emptyRelations]);
export function assertPostApprovalRoomIssueFresh(value) {
  assert.deepEqual(value, { rooms: 121, roomTypes: 4, publicWithoutRls: 0,
    rows: Object.fromEntries(emptyRelations.map(relation => [relation, 0])) }, 'Require exact fresh disposable local baseline, not merely three empty tables');
}
function fresh() {
  assertPostApprovalRoomIssueFresh(JSON.parse(sql(`select jsonb_build_object('rooms',(select count(*) from public.rooms),
    'roomTypes',(select count(*) from public.room_types),'publicWithoutRls',(select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind='r' and not c.relrowsecurity),
    'rows',jsonb_build_object(${emptyRelations.map(relation => `'${relation}',(select count(*) from ${relation})`).join(',')}));`)));
}
function installedHistory(manifest) {
  const files = readdirSync(new URL('../supabase/migrations', import.meta.url)).filter(name => /^\d{14}_[a-z0-9_]+\.sql$/.test(name)).sort();
  assert.equal(files.length, manifest.totalCount); assert.equal(manifest.migrations.length, files.length);
  const expected = files.map((file, i) => {
    const match = /^(\d{14})_([a-z0-9_]+)\.sql$/.exec(file), entry = manifest.migrations[i];
    assert.equal(entry.order, i + 1); assert.equal(entry.name, match[2]);
    assert.equal(createHash('sha256').update(readFileSync(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')).digest('hex'), entry.sha256);
    return { version: match[1], name: match[2] };
  });
  assertPostApprovalRoomIssueHistory(JSON.parse(sql("select coalesce(jsonb_agg(jsonb_build_object('version',version,'name',name) order by version),'[]'::jsonb) from supabase_migrations.schema_migrations;")), expected);
}
export function assertPostApprovalRoomIssueHistory(value, expected) {
  assert(Array.isArray(expected) && expected.length > 0);
  for (const entry of expected) assert(/^\d{14}$/.test(entry.version) && /^[a-z0-9_]+$/.test(entry.name));
  assert.deepEqual(value, expected, 'Exact local version/name history and source manifest bytes must match before reset authority');
}
export async function runPostApprovalRoomIssueConcurrency() {
let manifest;
try {
  assert.equal(process.argv.length, 2, 'No URL/target/skip overrides');
  for (const name of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'SUPABASE_WORKDIR', 'SUPABASE_CLI_BINARY_OVERRIDE']) assert(!process.env[name]);
  const config = readFileSync(new URL('../supabase/config.toml', import.meta.url), 'utf8');
  assert.equal((config.match(/^[ \t]*project_id[ \t]*=/gm) ?? []).length, 1); assert(/^[ \t]*project_id[ \t]*=[ \t]*"room-management-system-backend"\r?$/m.test(config));
  validateLocalDockerEndpoint(execFileSync('docker', ['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const status = JSON.parse(execFileSync(process.execPath, [cli, 'status', '--output', 'json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert(['localhost', '127.0.0.1'].includes(new URL(status.API_URL).hostname));
  manifest = JSON.parse(readFileSync(new URL('../supabase/migration-manifest.dev.json', import.meta.url), 'utf8'));
  installedHistory(manifest); fresh();
  cleanup = true; phase = 'fixture';
  const out = sql(`begin;${fixture}${oldFixture}${singleFixture}${uploadHelper}
    select pg_temp.save_late(p_client=>6100+n,p_key=>md5('draft'||n::text)||md5('draft-key'||n::text)) from generate_series(1,8)n;
    select pg_temp.save_late(p_client=>6110+n,p_key=>md5('seal'||n::text)||md5('seal-key'||n::text)) from generate_series(0,3)n;
    select public.refresh_photo_storage_quota(clock_timestamp(),1000);
    select jsonb_build_object('client',6110+n,'op',pg_temp.typed_upload(6110+n,6210+n)->>'operationId') from generate_series(0,1)n;
    select jsonb_build_object('client',6113,'op',pg_temp.typed_upload(6113,6213)->>'operationId');
    select jsonb_build_object('client',6112,'op',pg_temp.typed_upload(6112,6212,0,0,false,false,false)->>'operationId');commit;`);
  for (const line of out.split('\n').filter(value => value.startsWith('{"op"') || value.startsWith('{"client"'))) { const value = JSON.parse(line); if (value.op) uploaded.set(value.client, value.op); }
  assert.equal(uploaded.size, 4); const digest = sql(digestSql);
  phase = 'shared_admin_create'; rejected(await race(sharedDraft(1,201,0), sharedDraft(4,206,0), 'shared_create'), 'POST_APPROVAL_ROOM_ISSUE_DRAFT_CONFLICT');
  phase = 'shared_admin_edit'; rejected(await race(sharedDraft(4,206,1), sharedDraft(1,201,1), 'shared_edit'), 'POST_APPROVAL_ROOM_ISSUE_DRAFT_CONFLICT');
  assert.equal(sql(`select count(*) from private.post_approval_room_issue_drafts where client_report_id='${id(6190)}' and reported_by_profile_id='${id(1)}' and draft_revision=2;`), '1');
  assert.equal(sql(`select r.actor_profile_id from private.post_approval_room_issue_draft_revisions r join private.post_approval_room_issue_drafts d on d.id=r.draft_id where d.client_report_id='${id(6190)}' and r.revision=2;`), id(4));
  phase = 'shared_admin_finalize'; rejected(await race(finalize(6113,4,206), finalize(6113,1,201), 'shared_finalize'), 'POST_APPROVAL_ROOM_ISSUE_EVIDENCE_INVALID');
  assert.equal(sql(`select count(*) from private.post_approval_room_issue_reports where client_report_id='${id(6113)}' and reported_by_profile_id='${id(4)}' and draft_created_by_profile_id='${id(2)}';`), '1');
  phase = 'same_key'; assert.equal((await race(late(1), late(1), 'same_key')).exitCode, 0);
  assert.equal(sql(`select count(*) from private.post_approval_issue_upload_admissions where idempotency_key_digest='${key(9001)}';`), '1');
  // samekey admission1 is already live; CPU retry still consumes one request.
  phase = 'mixed_rate'; sql(rate(29)); rejected(await race(old(1), late(2), 'mixed_rate'), 'PHOTO_UPLOAD_RATE_LIMITED');
  phase = 'inverse_mixed_rate'; sql(rate(29)); rejected(await race(late(2), old(9), 'inverse_rate'), 'PHOTO_UPLOAD_RATE_LIMITED');
  phase = 'mixed_quota'; sql(rate(1));
  // First absorb provider-observed fixture uploads into the quota watermark.
  // Calculate the one-upload headroom from the remaining unknown reservations.
  sql('select public.refresh_photo_storage_quota(clock_timestamp(),1000);');
  sql(`select public.refresh_photo_storage_quota(clock_timestamp(),12000000000-(select (private.photo_quota_context(clock_timestamp())->>'pendingBytes')::bigint)-307201);`);
  assert.equal(sql("select private.photo_quota_context(clock_timestamp())->>'effectiveBytes';"), '11999692799');
  rejected(await race(old(2), late(3), 'mixed_quota'), 'PHOTO_STORAGE_QUOTA_EXCEEDED');
  sql('select public.refresh_photo_storage_quota(clock_timestamp(),1000);');
  // samekey1+old1+new2+old2+durable uncertain6112 =5. Two old slots make7.
  phase = 'mixed_inflight'; sql(old(3) + old(4));
  assert.equal(sql(`select private.post_approval_issue_all_inflight('${id(2)}',clock_timestamp());`), '7');
  const transition = `${idFunction}${singleFunctions}do $$ declare ad jsonb; op jsonb; col jsonb; begin
    ad:=pg_temp.single_admission();op:=pg_temp.single_begin((ad->>'admissionId')::uuid);
    if pg_temp.single_begin((ad->>'admissionId')::uuid) is distinct from op then raise exception 'SINGLE_RECEIPT_DRIFT';end if;
    col:=public.begin_admitted_photo_collection_upload('${id(2)}','${id(202)}',(select id from private.photo_upload_admissions where actor_profile_id='${id(2)}' and idempotency_key_digest='${key(8003)}'),repeat('a',64),'image/jpeg',100,'${key(8003)}',repeat('b',64));
    if public.begin_admitted_photo_collection_upload('${id(2)}','${id(202)}',(select id from private.photo_upload_admissions where actor_profile_id='${id(2)}' and idempotency_key_digest='${key(8003)}'),repeat('a',64),'image/jpeg',100,'${key(8003)}',repeat('b',64)) is distinct from col then raise exception 'COLLECTION_RECEIPT_DRIFT';end if;
    if private.post_approval_issue_all_inflight('${id(2)}',clock_timestamp())<>8 then raise exception 'EXACT_EIGHTH_TRANSITION';end if;
    begin ${late(4).replace('select ', 'perform ')} raise exception 'EXPECTED_TYPED_NINTH_DENIAL';
      exception when program_limit_exceeded then if sqlerrm<>'PHOTO_UPLOAD_LIMIT_EXCEEDED' then raise;end if;end;
    begin ${old(8).replace('select ', 'perform ')} raise exception 'EXPECTED_COLLECTION_NINTH_DENIAL';
      exception when program_limit_exceeded then if sqlerrm<>'PHOTO_UPLOAD_LIMIT_EXCEEDED' then raise;end if;end;
    begin perform public.begin_photo_upload('${id(2)}','${id(202)}','${id(7530)}','${id(7520)}',2,
      (select id from private.target_photo_slot_snapshots where cleaning_target_id='${id(7510)}' and slot_key='single-2'),0,repeat('a',64),'image/jpeg',100,repeat('e',64),repeat('b',64));
      raise exception 'EXPECTED_UNBOUND_CORE_NINTH_DENIAL';exception when program_limit_exceeded then if sqlerrm<>'PHOTO_UPLOAD_LIMIT_EXCEEDED' then raise;end if;end;
  end $$;`;
  phase = 'eighth_single_core_transition';
  // Both actual sessions roll back their deliberate old upload fixture writes.
  // Full old-state digest therefore still measures #336 mutations, not old uploads.
  assert.equal((await race(transition, transition, 'single_core', { rollbackFirst: true, rollbackSecond: true })).exitCode, 0);
  assert.equal(sql(`select private.post_approval_issue_all_inflight('${id(2)}',clock_timestamp());`), '7');
  rejected(await race(late(4), old(6), 'mixed_inflight'), 'PHOTO_UPLOAD_LIMIT_EXCEEDED');
  assert.equal(sql(`select private.post_approval_issue_all_inflight('${id(2)}',clock_timestamp());`), '8');
  phase = 'seal_before_purge'; rejected(await race(finalize(6110), prepare(6110), 'seal_purge'), 'POST_APPROVAL_ROOM_ISSUE_DELETE_NOT_ALLOWED');
  phase = 'purge_before_seal';
  // Keep the holder lock outside the caught subtransaction: its rollback would
  // otherwise release the lock before the second session can actually overlap.
  assert.equal((await race(`do $$ begin perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
    begin ${prepare(6111).replace(/^select /, 'perform ')} raise exception 'EXPECTED_DELETE_DENIAL';
    exception when serialization_failure then if sqlerrm<>'POST_APPROVAL_ROOM_ISSUE_DELETE_NOT_ALLOWED' then raise;end if;end;end $$;`, finalize(6111), 'purge_seal')).exitCode, 0);
  phase = 'response_loss'; assert.equal(JSON.parse(sql(finalize(6110))).report.clientReportId, id(6110));
  assert.equal(sql('select count(*) from private.post_approval_room_issue_reports;'), '3');
  const uncertain = uploaded.get(6112);
  phase = 'provider_wait_cas';
  assert.equal((await race(`select public.save_post_approval_room_issue_draft('${id(2)}','${id(202)}','${id(4002)}','${id(6112)}',1,'synthetic memo',md5('provider-cas-race')||md5('provider-cas-race-key'),repeat('b',64));`,
    `select public.record_post_approval_room_issue_evidence_provider_success('${id(2)}','${id(202)}','${uncertain}',1,repeat('f',64),clock_timestamp());`, 'provider_cas')).exitCode, 0);
  sql(`do $$ begin begin perform public.finalize_post_approval_room_issue_evidence_upload('${id(2)}','${id(202)}','${uncertain}',1,repeat('f',64));raise exception 'EXPECTED_CAS_DENIAL';
    exception when serialization_failure then if sqlerrm<>'POST_APPROVAL_ROOM_ISSUE_EVIDENCE_INVALID' then raise;end if;end;end $$;`);
  const firstClock = sql(`select provider_created_at from private.post_approval_issue_provider_objects where operation_id='${uncertain}';`); assert(firstClock);
  phase = 'provider_wait_expiry'; rejected(await race(`select pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));update auth.sessions set not_after=clock_timestamp()-interval '1 second' where id='${id(202)}';`,
    `select public.record_post_approval_room_issue_evidence_provider_success('${id(2)}','${id(202)}','${uncertain}',1,repeat('f',64),clock_timestamp());`, 'provider_expired'), 'SESSION_REVOKED');
  assert.equal(sql(`select provider_created_at from private.post_approval_issue_provider_objects where operation_id='${uncertain}';`), firstClock, 'Provider-wait expiry cannot erase/extend immutable physical first clock');
  sql(`update auth.sessions set not_after=clock_timestamp()+interval '1 day' where id='${id(202)}';`);
  phase = 'expired_after_wait'; rejected(await race(`select pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));update auth.sessions set not_after=clock_timestamp()-interval '1 second' where id='${id(202)}';`, late(5), 'expired'), 'SESSION_REVOKED');
  sql(`update auth.sessions set not_after=clock_timestamp()+interval '1 day' where id='${id(202)}';`);
  phase = 'limited_after_wait'; rejected(await race(`select pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));set local session_replication_role=replica;update public.profiles set status='deactivation_pending' where id='${id(2)}';set local session_replication_role=origin;`, late(5), 'limited'), ['CAPABILITY_ACCESS_REQUIRED', 'POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED']);
  sql(`set session_replication_role=replica;update public.profiles set status='active' where id='${id(2)}';set session_replication_role=origin;`);
  phase = 'foreign_after_wait'; rejected(await race(`select pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));`, late(5, { actor: 3, session: 203 }), 'foreign'), 'POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED');
  const handover = (actor, session, version, marker) => `select public.handover_post_approval_room_issue_evidence_upload('${id(actor)}','${id(session)}','${uncertain}',${version},md5('handover-${marker}')||md5('handover-key-${marker}'),repeat('b',64),repeat('${marker}',64));`;
  phase = 'handover_cas_race';
  rejected(await race(handover(1,201,1,'7'), handover(4,206,1,'6'), 'handover_cas'), 'PHOTO_UPLOAD_FENCE_CONFLICT');
  assert.equal(sql(`select private.post_approval_issue_executor('${uncertain}');`), id(1));
  phase = 'handover_old_executor_race';
  rejected(await race(handover(4,206,2,'6'),
    `select public.renew_post_approval_room_issue_evidence_upload('${id(1)}','${id(201)}','${uncertain}',2,repeat('7',64));`,
    'handover_old_executor'), 'POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED');
  assert.equal(sql(`select count(*) from private.post_approval_issue_upload_handovers where operation_id='${uncertain}';`), '2');
  assert.equal(sql(`select private.post_approval_issue_executor('${uncertain}');`), id(4));
  assert.equal(sql(`select provider_created_at from private.post_approval_issue_provider_objects where operation_id='${uncertain}';`), firstClock);
  assert.equal(sql(digestSql), digest, 'Original approval/photos/seals/earnings/payroll/room rows unchanged');
  console.log('Post-approval issue concurrency PASS:18 actual lock overlaps; handover CAS/old executor, shared admin create/edit/finalize, same-key, mixed30/min, exact eighth single/collection/core replay and ninth denial, globalquota, seal/purge, durable provider CAS/expiry, response loss, limited/foreign and whole old-state digest. Provider metadata synthetic; no Drive calls.');
} catch (error) {
  console.error(`Post-approval issue concurrency FAIL:${JSON.stringify({ phase, kind: error instanceof assert.AssertionError ? 'ASSERTION_FAILED' : 'VALIDATION_FAILED' })}`); process.exitCode = 1;
} finally {
  for (const child of pending) if (child.exitCode === null) child.kill();
  if (cleanup) { try {
      validateLocalDockerEndpoint(execFileSync('docker', ['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
      installedHistory(manifest);
      assert.equal(sql(`select not exists(select 1 from public.profiles where id not in('${id(1)}','${id(2)}','${id(3)}','${id(4)}'))
        and not exists(select 1 from auth.users where id not in('${id(101)}','${id(102)}','${id(103)}','${id(104)}'))
        and not exists(select 1 from public.cleaning_targets where source_key not like 'late-issue-fixture-%' and source_key not like 'late-current-%' and source_key not like 'late-single-%');`), 't', 'Unrelated local data blocks cleanup');
      execFileSync(process.execPath, [cli, 'db', 'reset', '--local', '--no-seed'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
      installedHistory(manifest); fresh(); console.log('Post-approval issue fresh local cleanup PASS');
    } catch { console.error('Post-approval issue fresh local cleanup FAIL'); process.exitCode = 1; } }
}
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await runPostApprovalRoomIssueConcurrency();
