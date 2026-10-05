import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { validateLocalDockerEndpoint } from './db-lint-baseline.mjs';

export const limitedConcurrencyFreshIdentitySQL = `select jsonb_build_object(
  'authUsers',(select count(*) from auth.users),
  'profiles',(select count(*) from public.profiles),
  'targets',(select count(*) from public.cleaning_targets),
  'operations',(select count(*) from private.photo_upload_operations),
  'historyCount',(select count(*) from supabase_migrations.schema_migrations),
  'head',(select name from supabase_migrations.schema_migrations order by version desc limit 1));`;

export function assertLimitedConcurrencyFreshIdentity(value, manifest) {
  assert(Number.isSafeInteger(manifest.totalCount) && manifest.totalCount > 0);
  assert(typeof manifest.head === 'string' && /^[a-z0-9_]+$/.test(manifest.head));
  assert.deepEqual(value, { authUsers: 0, profiles: 0, targets: 0, operations: 0,
    historyCount: manifest.totalCount, head: manifest.head }, 'Require fresh disposable local DB and exact manifest identity');
}

// Synthetic local rows and real transactions only. Session UUIDs, SQL, digests,
// credentials and provider locators remain in memory; never print raw failures.
export async function testLimitedExistingSessionConcurrency(client) {
  assert(['localhost', '127.0.0.1'].includes(new URL(client.supabaseUrl).hostname));
  const args = ['exec', '-i', 'supabase_db_room-management-system-backend', 'psql', '-X', '-qAt',
    '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'];
  const uuid = value => { assert(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)); return value; };
  const hash = 'a'.repeat(64);
  function sql(statement) {
    try { return execFileSync('docker', args, { input: `set statement_timeout='10s';${statement}`, encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000, maxBuffer: 4 * 1024 * 1024 }).trim(); }
    catch { throw new Error('LIMITED_LOCAL_SQL_FAILED'); }
  }
  function execute(statement) {
    const name = `limited329-${randomUUID()}`, child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '';
    const timer = setTimeout(() => child.kill(), 15000);
    const result = new Promise((resolve, reject) => {
      child.once('error', () => { clearTimeout(timer); reject(new Error('LIMITED_RACE_PROCESS_FAILED')); });
      child.once('close', code => {
        clearTimeout(timer);
        const reason = ['SESSION_REVOKED','CAPABILITY_ACCESS_REQUIRED','SUBMISSION_ACCESS_REQUIRED',
          'PHOTO_EVIDENCE_INCOMPLETE','ATTEMPT_INVALID_TRANSITION','STALE_VERSION','IDEMPOTENCY_KEY_REUSED'].find(x => errors.includes(x)) ?? null;
        resolve({ success: code === 0, output: output.trim(), reason });
      });
    });
    child.stdout.on('data', value => { output += value.toString(); });
    child.stderr.on('data', value => { errors += value.toString(); });
    child.stdin.end(`begin;set local application_name='${name}';set local statement_timeout='10s';${statement};commit;\n`);
    return { name, result };
  }
  async function hold(statement) {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = new Promise(resolve => child.once('close', resolve));
    child.stderr.on('data', () => {});
    await new Promise((resolve, reject) => {
      let output = '', ready = false;
      const timer = setTimeout(() => { child.kill(); reject(new Error('LIMITED_LOCK_SETUP_TIMEOUT')); }, 10000);
      child.once('error', () => { clearTimeout(timer); reject(new Error('LIMITED_LOCK_PROCESS_FAILED')); });
      child.once('close', () => { if (!ready) { clearTimeout(timer); reject(new Error('LIMITED_LOCK_SETUP_FAILED')); } });
      child.stdout.on('data', value => {
        output += value.toString();
        if (!ready && output.includes('LIMITED_LOCK_READY')) { ready = true; output = ''; clearTimeout(timer); resolve(); }
      });
      child.stdin.write(`begin;set local statement_timeout='10s';set local idle_in_transaction_session_timeout='15s';${statement};\n\\echo LIMITED_LOCK_READY\n`);
    });
    let released;
    return (beforeCommit = '') => released ??= (async () => {
      child.stdin.end(`${beforeCommit};commit;\n\\q\n`);
      assert.equal(await closed, 0, 'Lock holder commits without deadlock');
    })();
  }
  async function waitForLock(name) {
    assert(/^limited329-[0-9a-f-]+$/.test(name));
    for (let i = 0; i < 50; i += 1) {
      if (sql(`select exists(select 1 from pg_stat_activity where application_name='${name}'
        and state='active' and wait_event_type='Lock');`) === 't') return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('LIMITED_EXPECTED_REAL_LOCK_NOT_REACHED');
  }
  async function blocked(statement, blocker, beforeCommit = '', waitMs = 0) {
    const release = await hold(blocker), pending = execute(statement);
    try {
      await waitForLock(pending.name);
      if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
      await release(beforeCommit); return await pending.result;
    } finally { await release(); await pending.result; }
  }
  function account(role = 'maid') {
    const id = randomUUID(), auth = randomUUID(), session = randomUUID();
    sql(`insert into auth.users(id) values('${auth}');
      insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
        login_sequence,role,status,must_change_password) values('${id}','${auth}','limited-${id}','limited-${id}',
        'limited-${id}','limited-${id}',0,'${role}','active',false);
      insert into auth.sessions(id,user_id) values('${session}','${auth}');`);
    return { id, auth, session };
  }
  const admin = account('admin'), type = uuid(sql("select id from public.room_types where code='standard';"));
  const template = randomUUID();
  sql(`insert into public.cleaning_template_versions(id,room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,created_by)
    select '${template}','${type}','additional',coalesce(max(version),0)+1,'retired',30,
      '[{"slotKey":"limited-proof","required":true,"displayOrder":0,"label":"synthetic"}]','${admin.id}'
    from public.cleaning_template_versions where room_type_id='${type}' and cleaning_kind='additional';`);
  let sequence = 0;
  function fixture() {
    const owner = account(), room = randomUUID(), target = randomUUID(), assignment = randomUUID(), attempt = randomUUID();
    sql(`insert into public.rooms(id,room_number,room_type_id,elevator_zone) values('${room}','${Date.now()}${++sequence}','${type}','A');
      insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,effective_service_date,
        available_from,due_at,status,assignment_version,room_type_snapshot,fee_snapshot,template_snapshot,created_by)
      select '${target}','${room}','additional','manual_room_request','limited-${target}',
        (clock_timestamp() at time zone 'Asia/Seoul')::date,(clock_timestamp() at time zone 'Asia/Seoul')::date,
        (clock_timestamp() at time zone 'Asia/Seoul')::date::timestamp at time zone 'Asia/Seoul',clock_timestamp()+interval '1 day',
        'notified',2,'{"code":"standard"}',10000,jsonb_build_object('id',id,'version',version,'photoSlots',photo_slots,'durationMinutes',30),'${admin.id}'
      from public.cleaning_template_versions where id='${template}';
      insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,notified_at,changed_by)
        values('${assignment}','${target}','${owner.id}',1,2,clock_timestamp(),'${admin.id}');
      insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,
        assignment_revision,template_snapshot,room_snapshot)
      select '${attempt}','${target}','${assignment}','${owner.id}',1,'scheduled',2,template_snapshot,jsonb_build_object('roomId','${room}')
      from public.cleaning_targets where id='${target}';
      select public.start_cleaning_attempt('${owner.id}','${attempt}',1,'${assignment}',2,'${randomUUID()}','${hash}');`);
    return { owner, target, assignment, attempt, slot: uuid(sql(`select id from private.target_photo_slot_snapshots
      where cleaning_target_id='${target}' and slot_key='limited-proof';`)) };
  }
  const manage = (item, action = 'allow_finish', version = 2, profileVersion = 1, key = randomUUID()) =>
    `select public.manage_cleaning_attempt_lifecycle('${admin.id}','${admin.session}','${item.attempt}',${version},
      '${item.assignment}',2,${profileVersion},'${action}','{}','${action === 'allow_finish' ? 'DEACTIVATION_FINISH_CURRENT' : 'DEACTIVATION_UPLOAD_ONLY'}','${key}','${hash}')`;
  const complete = (item, key = randomUUID(), session = item.owner.session) =>
    `select public.complete_limited_cleaning_attempt_field_work('${item.owner.id}','${session}','${item.attempt}',2,
      '${item.assignment}',2,'${key}','${hash}')`;
  const discover = (item, session = item.owner.session) => `select public.list_limited_cleaning_attempts('${item.owner.id}','${session}')`;
  const globalLock = "select pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0))";
  function state(item) {
    return sql(`select jsonb_build_object('attempt',to_jsonb(a),'profile',to_jsonb(p),
      'grants',(select count(*) from private.attempt_capability_grants where attempt_id=a.id),
      'bindings',(select count(*) from private.attempt_capability_session_roots where actor_profile_id=p.id),
      'roots',(select count(*) from private.limited_session_roots where actor_profile_id=p.id),
      'receipts',(select count(*) from private.command_executions where actor_profile_id=p.id),
      'photos',(select count(*) from private.attempt_photo_versions where cleaning_attempt_id=a.id),
      'submissions',(select count(*) from public.cleaning_submissions where cleaning_attempt_id=a.id),
      'audit',(select count(*) from public.audit_events where entity_id=a.id))
      from public.cleaning_attempts a join public.profiles p on p.id=a.maid_profile_id where a.id='${item.attempt}';`);
  }
  // Old created_at but uncommitted at freeze: real READ COMMITTED visibility,
  // not a creation-time guess or a session query performed after the transition.
  const late = fixture(), lateSession = randomUUID();
  const commitLate = await hold(`insert into auth.sessions(id,user_id,created_at) values('${lateSession}','${late.owner.auth}',clock_timestamp()-interval '30 days')`);
  try { sql(manage(late)); } finally { await commitLate(); }
  assert.equal((await execute(discover(late, lateSession)).result).reason, 'CAPABILITY_ACCESS_REQUIRED');
  const first = JSON.parse(sql(discover(late))); assert.equal(first.items.length, 1);
  const completeKey = randomUUID();
  const duplicateComplete = await Promise.all([execute(complete(late, completeKey)).result, execute(complete(late, completeKey)).result]);
  assert(duplicateComplete.every(x => x.success)); assert.equal(duplicateComplete[0].output, duplicateComplete[1].output);
  assert.equal(sql(`select count(distinct root_id) from private.attempt_capability_session_roots where actor_profile_id='${late.owner.id}';`), '1');
  assert.equal(JSON.parse(sql(discover(late))).items[0].kind, 'upload_submit');
  assert.equal((await execute(discover(late, lateSession)).result).reason, 'CAPABILITY_ACCESS_REQUIRED');
  assert.equal((await execute(complete(late, completeKey, lateSession)).result).reason, 'CAPABILITY_ACCESS_REQUIRED');
  console.log('Limited concurrency PASS: actual delayed-session commit excluded; finish replay and successor inherit one frozen root.');

  const revoked = fixture(); sql(manage(revoked)); const beforeRevoke = state(revoked);
  const revokeResult = await blocked(complete(revoked),`select 1 from auth.sessions where id='${revoked.owner.session}' for update`,
    `delete from auth.sessions where id='${revoked.owner.session}'`);
  assert.equal(revokeResult.reason, 'SESSION_REVOKED'); assert.equal(state(revoked), beforeRevoke);
  const expired = fixture(); sql(manage(expired)); const beforeExpiry = state(expired);
  sql(`update auth.sessions set not_after=clock_timestamp()+interval '2 seconds' where id='${expired.owner.session}';`);
  const expiredComplete = await blocked(complete(expired), globalLock, '', 2200);
  assert.equal(expiredComplete.reason, 'SESSION_REVOKED'); assert.equal(state(expired), beforeExpiry);
  const expiredRead = fixture(); sql(manage(expiredRead));
  sql(`update auth.sessions set not_after=clock_timestamp()+interval '2 seconds' where id='${expiredRead.owner.session}';`);
  assert.equal((await blocked(discover(expiredRead), globalLock, '', 2200)).reason, 'SESSION_REVOKED');
  console.log('Limited concurrency PASS: actual revoke and elapsed not_after after completion/discovery lock waits leave state unchanged.');

  const writerLock = 'lock table private.command_executions in share mode';
  const completionWriter = fixture(); sql(manage(completionWriter)); const beforeCompletionWriter = state(completionWriter);
  sql(`update auth.sessions set not_after=clock_timestamp()+interval '2 seconds' where id='${completionWriter.owner.session}';`);
  const completionWriterResult = await blocked(complete(completionWriter), writerLock, '', 2200);
  assert.equal(completionWriterResult.reason, 'SESSION_REVOKED'); assert.equal(state(completionWriter), beforeCompletionWriter);
  // Owner-only existing test hook issues an already aging immutable grant. No
  // grant UPDATE, renewal, application clock override or credential is added.
  function agingGrant(item, action, version, ttlHours) {
    assert([2, 24].includes(ttlHours));
    sql(`select private.manage_cleaning_attempt_lifecycle_at('${admin.id}','${admin.session}','${item.attempt}',${version},
      '${item.assignment}',2,1,'${action}','{}','${action === 'allow_finish' ? 'DEACTIVATION_FINISH_CURRENT' : 'DEACTIVATION_UPLOAD_ONLY'}',
      '${randomUUID()}','${hash}',clock_timestamp()-interval '${ttlHours} hours'+interval '5 seconds');`);
  }
  const completionTtl = fixture(); agingGrant(completionTtl, 'allow_finish', 2, 2); const beforeCompletionTtl = state(completionTtl);
  const completionTtlResult = await blocked(complete(completionTtl), writerLock, '', 5200);
  assert.equal(completionTtlResult.reason, 'CAPABILITY_ACCESS_REQUIRED'); assert.equal(state(completionTtl), beforeCompletionTtl);
  console.log('Limited concurrency PASS: session deadline and immutable2h TTL elapsed inside completion receipt-writer wait roll back grant/profile/receipt.');

  function uploadFixture() {
    const item = fixture();
    sql(`select public.complete_cleaning_attempt_field_work('${item.owner.id}','${item.attempt}',2,'${item.assignment}',2,'${randomUUID()}','${hash}');`);
    sql(manage(item, 'allow_upload', 3)); return item;
  }
  function pendingPhoto(item) {
    const operation = JSON.parse(sql(`select public.begin_photo_upload('${item.owner.id}','${item.owner.session}','${item.attempt}',
      '${item.assignment}',2,'${item.slot}',0,'${hash}','image/jpeg',100,'${hash}','${hash}');`));
    const op = uuid(operation.operationId);
    sql(`select public.claim_photo_upload('${item.owner.id}','${item.owner.session}','${op}','${hash}');
      select public.record_photo_provider_success('${op}',1,'${hash}','limited_${randomUUID().replaceAll('-', '')}',clock_timestamp());`);
    return op;
  }
  const finalize = (item, operation) => `select public.finalize_photo_upload('${item.owner.id}','${item.owner.session}','${operation}',1,'${hash}')`;
  const submit = (item, key, clientId) => `select public.create_cleaning_submission_with_session('${item.owner.id}','${item.owner.session}',
    '${item.attempt}','${clientId}',0,0,'${key}','${hash}')`;
  const photoExpiry = uploadFixture(), photoOperation = pendingPhoto(photoExpiry), beforePhotoExpiry = state(photoExpiry);
  sql(`update auth.sessions set not_after=clock_timestamp()+interval '2 seconds' where id='${photoExpiry.owner.session}';`);
  const photoResult = await blocked(finalize(photoExpiry, photoOperation),
    `select 1 from private.photo_upload_states where operation_id='${photoOperation}' for update`, '', 2200);
  assert.equal(photoResult.reason, 'SESSION_REVOKED'); assert.equal(state(photoExpiry), beforePhotoExpiry);
  assert.equal(sql(`select count(*) from private.photo_upload_acceptances where operation_id='${photoOperation}';`), '0');
  console.log('Limited concurrency PASS: session expiry during exact photo-state wait creates no acceptance/photo/CAS change.');

  const item = uploadFixture(), operation = pendingPhoto(item);
  const submitKey = randomUUID(), clientId = randomUUID();
  const convergence = await Promise.all([execute(finalize(item, operation)).result, execute(submit(item, submitKey, clientId)).result]);
  assert(convergence[0].success); assert(convergence[1].success || convergence[1].reason === 'PHOTO_EVIDENCE_INCOMPLETE');
  const duplicateSubmit = await Promise.all([execute(submit(item, submitKey, clientId)).result, execute(submit(item, submitKey, clientId)).result]);
  assert(duplicateSubmit.every(x => x.success)); assert.equal(duplicateSubmit[0].output, duplicateSubmit[1].output);
  assert.equal(sql(`select count(*) from public.cleaning_submissions where cleaning_attempt_id='${item.attempt}';`), '1');
  const accepted = `select public.get_photo_upload_receipt_with_session('${item.owner.id}','${item.owner.session}','${operation}')`;
  assert.equal(JSON.parse(sql(accepted)).status, 'accepted');
  const replayBefore = state(item);
  const receiptRevoked = await blocked(accepted,`select 1 from auth.sessions where id='${item.owner.session}' for update`,
    `delete from auth.sessions where id='${item.owner.session}'`);
  assert.equal(receiptRevoked.reason, 'SESSION_REVOKED'); assert.equal(state(item), replayBefore);
  assert.equal((await execute(submit(item, submitKey, clientId)).result).reason, 'SESSION_REVOKED');
  assert.equal(JSON.parse(sql(`select public.reconcile_photo_upload('${operation}','${hash}');`)).status, 'accepted');
  console.log('Limited concurrency PASS: photo/submit race converges; duplicate submission stays one; accepted HTTP receipt/replay reject revoke while worker history survives.');

  const submissionExpiry = uploadFixture(), submittedOperation = pendingPhoto(submissionExpiry);
  sql(finalize(submissionExpiry, submittedOperation));
  const expiryKey = randomUUID(), expiryClientId = randomUUID(), beforeSubmitExpiry = state(submissionExpiry);
  sql(`update auth.sessions set not_after=clock_timestamp()+interval '2 seconds' where id='${submissionExpiry.owner.session}';`);
  const receiptLock = `select pg_advisory_xact_lock(hashtextextended('${submissionExpiry.owner.id}:submission.create:${expiryKey}',0))`;
  const submissionResult = await blocked(submit(submissionExpiry, expiryKey, expiryClientId), receiptLock, '', 2200);
  assert.equal(submissionResult.reason, 'SESSION_REVOKED'); assert.equal(state(submissionExpiry), beforeSubmitExpiry);
  const order = uploadFixture(), orderOperation = pendingPhoto(order); sql(finalize(order, orderOperation));
  const lockOrderRace = await Promise.all([execute(manage(order, 'allow_upload', 3, 2)).result,
    execute(submit(order, randomUUID(), randomUUID())).result]);
  assert(lockOrderRace[1].success); assert(lockOrderRace[0].success || lockOrderRace[0].reason === 'ATTEMPT_INVALID_TRANSITION');
  assert.equal(sql(`select count(*) from private.limited_session_roots where actor_profile_id='${order.owner.id}';`), '1');
  console.log('Limited concurrency PASS: receipt-lock expiry aborts submit; lifecycle versus session-bound submit preserves receipt→global→profile order without deadlock/renewal.');

  const submitWriter = uploadFixture(), submitWriterOperation = pendingPhoto(submitWriter); sql(finalize(submitWriter, submitWriterOperation));
  const beforeSubmitWriter = state(submitWriter);
  sql(`update auth.sessions set not_after=clock_timestamp()+interval '2 seconds' where id='${submitWriter.owner.session}';`);
  const submitWriterResult = await blocked(submit(submitWriter, randomUUID(), randomUUID()), writerLock, '', 2200);
  assert.equal(submitWriterResult.reason, 'SESSION_REVOKED'); assert.equal(state(submitWriter), beforeSubmitWriter);
  const submitTtl = fixture();
  sql(`select public.complete_cleaning_attempt_field_work('${submitTtl.owner.id}','${submitTtl.attempt}',2,'${submitTtl.assignment}',2,'${randomUUID()}','${hash}');`);
  const submitTtlOperation = pendingPhoto(submitTtl); sql(finalize(submitTtl, submitTtlOperation));
  agingGrant(submitTtl, 'allow_upload', 3, 24); const beforeSubmitTtl = state(submitTtl);
  const submitTtlResult = await blocked(submit(submitTtl, randomUUID(), randomUUID()), writerLock, '', 5200);
  assert.equal(submitTtlResult.reason, 'CAPABILITY_ACCESS_REQUIRED'); assert.equal(state(submitTtl), beforeSubmitTtl);
  console.log('Limited concurrency PASS: session deadline and immutable24h TTL elapsed inside submission receipt-writer wait roll back submission/photo binding/receipt.');
}

// Safe import for the aggregate runner; explicit CLI execution remains local-only.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const cli = fileURLToPath(new URL('../node_modules/supabase/dist/supabase.js', import.meta.url));
  const args = ['exec', '-i', 'supabase_db_room-management-system-backend', 'psql', '-X', '-qAt',
    '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'];
  const freshIdentity = () => JSON.parse(execFileSync('docker', args, { cwd: root,
    input: `set statement_timeout='15s';${limitedConcurrencyFreshIdentitySQL}`, encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'], timeout: 20000, maxBuffer: 4 * 1024 * 1024 }));
  let cleanupRequired = false, manifest;
  try {
    assert.equal(process.argv.length, 2, 'No target/URL overrides');
    for (const name of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'SUPABASE_WORKDIR', 'SUPABASE_CLI_BINARY_OVERRIDE']) assert(!process.env[name], 'No external runtime overrides');
    const config = readFileSync(new URL('../supabase/config.toml', import.meta.url), 'utf8');
    assert.equal((config.match(/^[ \t]*project_id[ \t]*=/gm) ?? []).length, 1);
    assert(/^[ \t]*project_id[ \t]*=[ \t]*"room-management-system-backend"\r?$/m.test(config));
    validateLocalDockerEndpoint(execFileSync('docker', ['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 }));
    const status = JSON.parse(execFileSync(process.execPath,[cli,'--workdir',root,'status','--output','json'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore','pipe','pipe'], timeout: 30000 }));
    assert(['localhost','127.0.0.1'].includes(new URL(status.API_URL).hostname));
    manifest = JSON.parse(readFileSync(new URL('../supabase/migration-manifest.dev.json', import.meta.url), 'utf8'));
    assertLimitedConcurrencyFreshIdentity(freshIdentity(), manifest);
    // Only a positively identified, already-fresh local fixture may be reset.
    // Import callers retain ownership of their enclosing aggregate fixture.
    cleanupRequired = true;
    await testLimitedExistingSessionConcurrency(createClient(status.API_URL,status.SECRET_KEY,
      { auth: { autoRefreshToken: false, persistSession: false } }));
  } catch { console.error('Limited existing session concurrency FAIL: redacted local validation failure'); process.exitCode = 1; }
  finally {
    if (cleanupRequired) {
      try {
        execFileSync(process.execPath, [cli, 'db', 'reset', '--local', '--no-seed'], { cwd: root,
          stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
        assertLimitedConcurrencyFreshIdentity(freshIdentity(), manifest);
        console.log('Limited concurrency fresh local cleanup PASS: manifest identity and zero fixture rows verified.');
      } catch { console.error('Limited concurrency fresh local cleanup FAIL: redacted local validation failure'); process.exitCode = 1; }
    }
  }
}
