import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { safeRpcResultSummary, waitForLocalPostgrestReady } from './lib/local-postgrest-test-readiness.mjs';

const cli = 'node_modules/supabase/dist/supabase.js';
const psqlArgs = ['exec', '-i', 'supabase_db_room-management-system-backend', 'psql', '-X', '-qAt',
  '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'];
export const manualCancelId = (n) => `34800000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export function manualCancelFixture() {
  const source = readFileSync('supabase/tests/manual_cleaning_cancel_pin_independent.sql', 'utf8');
  const begin = '-- BEGIN MANUAL CANCEL SHARED FIXTURE';
  const end = '-- END MANUAL CANCEL SHARED FIXTURE';
  assert(source.includes(begin) && source.includes(end), 'Manual cancellation fixture markers must exist');
  // A replacement string interprets SQL $$ as a single $; insert verbatim.
  const pinFixture = readFileSync('supabase/tests/room_pin_fixture.psql', 'utf8');
  const fixture = source.split(begin)[1].split(end)[0].replace('\\ir room_pin_fixture.psql',
    () => pinFixture);
  assert(fixture.includes(pinFixture), 'PIN fixture dollar quoting must remain byte-for-byte intact');
  assert(fixture.includes('create function pg_temp.manual_cancel_fixture('), 'Shared fixture must contain actual request creation');
  assert(!/\\ir|\b(?:no_plan|plan|finish)\s*\(/i.test(fixture), 'Shared fixture cannot invoke TAP or unresolved include');
  return fixture;
}

function localSql(input) {
  try {
    return execFileSync('docker', psqlArgs, { input, encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 }).trim();
  } catch {
    throw new Error('MANUAL_CANCEL_LOCAL_SQL_FAILED');
  }
}

const cancelSql = (n, key) => `select public.cancel_manual_cleaning_request_with_session(
  '${manualCancelId(1)}','${manualCancelId(201)}','${manualCancelId(1000 + n)}',2,
  'CUSTOM_CANCEL_REASON','${key}',repeat('3',64));`;
const startSql = (n, key) => `select public.start_cleaning_attempt('${manualCancelId(2)}',
  '${manualCancelId(3000 + n)}',1,'${manualCancelId(2000 + n)}',2,'${key}',repeat('4',64));`;
const finalizeSql = (n, lease, key) => `select public.finalize_room_pin_reveal('${manualCancelId(2)}',
  '${manualCancelId(202)}',(select room_id from public.cleaning_targets where id='${manualCancelId(1000 + n)}'),
  '${lease}','${key}');`;

function contender(input, name) {
  assert(/^[a-z_]+$/.test(name), 'Source-controlled local race application name');
  const child = spawn('docker', psqlArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  let code = null;
  const done = new Promise((resolve) => {
    child.once('error', () => resolve({ exitCode: -1, code: null }));
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => {
      const matched = chunk.toString().match(/(?:STALE_VERSION|CLEANING_REQUEST_CANCEL_CONFLICT|ASSIGNMENT_VERSION_CONFLICT|PASSWORD_CHANGE_REQUIRED|SESSION_REVOKED|PIN_REVEAL_AUTHORIZATION_CHANGED)/);
      if (matched) code = matched[0];
    });
    child.once('close', (exitCode) => resolve({ exitCode, code }));
  });
  child.stdin.end(`set application_name='${name}'; set statement_timeout='30s'; ${input}`);
  return { child, done, output: () => output };
}

async function holder(input, name) {
  assert(/^[a-z_]+$/.test(name), 'Source-controlled local holder application name');
  const child = spawn('docker', psqlArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
  let ready = false;
  let output = '';
  const done = new Promise((resolve) => {
    child.once('error', () => resolve({ exitCode: -1 }));
    child.once('close', (exitCode) => resolve({ exitCode }));
  });
  const readyPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('MANUAL_CANCEL_HOLDER_TIMEOUT')); }, 15000);
    child.once('error', () => { clearTimeout(timeout); reject(new Error('MANUAL_CANCEL_HOLDER_FAILED')); });
    child.once('close', () => { if (!ready) { clearTimeout(timeout); reject(new Error('MANUAL_CANCEL_HOLDER_FAILED')); } });
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (!ready && output.includes('MANUAL_CANCEL_LOCK_HELD')) {
        ready = true;
        clearTimeout(timeout);
        resolve();
      }
    });
    // Drain errors without exposing SQL, identities, envelopes or RPC results.
    child.stderr.on('data', () => {});
  });
  child.stdin.write(`set application_name='${name}'; begin; set local statement_timeout='30s';
    set local idle_in_transaction_session_timeout='40s'; ${input}\n\\echo MANUAL_CANCEL_LOCK_HELD\n`);
  await readyPromise;
  let released = false;
  return { child, done, release: async () => {
    if (!released) { released = true; child.stdin.end('commit;\n\\q\n'); }
    return done;
  } };
}

async function waitBlocked(name) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (localSql(`select exists(select 1 from pg_stat_activity where application_name='${name}'
      and wait_event_type='Lock' and xact_start is not null);`) === 't') return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('MANUAL_CANCEL_CONTENDER_NOT_BLOCKED');
}

async function waitSessionExpiry() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (localSql(`select clock_timestamp()>=not_after from auth.sessions
      where id='${manualCancelId(201)}';`) === 't') return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('MANUAL_CANCEL_SESSION_EXPIRY_NOT_OBSERVED');
}

function successful(result, message) {
  if (result.error) {
    const error = new Error(message);
    error.summary = safeRpcResultSummary(result);
    throw error;
  }
  return result.data;
}

export async function testManualCleaningCancelConcurrency(client) {
  assert(['localhost', '127.0.0.1'].includes(new URL(client.supabaseUrl).hostname), 'Manual cancellation races are local only');
  assert.equal(localSql('select count(*) from public.profiles;'), '0', 'Standalone suite requires a fresh disposable database');
  localSql(`begin; ${manualCancelFixture()}
    select pg_temp.manual_cancel_fixture(n,'additional','notified',true,(clock_timestamp() at time zone 'Asia/Seoul')::date)
      from generate_series(41,50) n;
    commit;`);
  const pending = [];
  const state = (n) => JSON.parse(localSql(`select json_build_object('target',t.status,'version',t.assignment_version,
    'attempt',attempt.status,'started',attempt.started_at is not null,'current',assignment.is_current,
    'notices',(select count(*) from public.notifications where cleaning_target_id=t.id and event_family='cleaning_request.cancelled_revoked'),
    'deliveries',(select count(*) from private.notification_delivery_outbox o join public.notifications notice on notice.id=o.notification_id
      where notice.cleaning_target_id=t.id and notice.event_family='cleaning_request.cancelled_revoked'),
    'audits',(select count(*) from public.audit_events where entity_id=t.id and event_type='cleaning.manual_request.cancelled'),
    'receipts',(select count(*) from private.command_executions where entity_id=t.id and command_type='cleaning.manual_request.cancel'))
    from public.cleaning_targets t join public.cleaning_assignments assignment on assignment.id='${manualCancelId(2000 + n)}'
    join public.cleaning_attempts attempt on attempt.id='${manualCancelId(3000 + n)}' where t.id='${manualCancelId(1000 + n)}';`));
  const args = (n, key = randomUUID(), hash = '3'.repeat(64)) => ({
    p_actor_profile_id: manualCancelId(1), p_session_id: manualCancelId(201),
    p_target_id: manualCancelId(1000 + n), p_expected_version: 2, p_reason_code: 'CUSTOM_CANCEL_REASON',
    p_idempotency_key: key, p_request_hash: hash
  });
  const beginArgs = (n, request) => ({
    p_actor_profile_id: manualCancelId(2), p_session_id: manualCancelId(202),
    p_room_id: localSql(`select room_id from public.cleaning_targets where id='${manualCancelId(1000 + n)}';`),
    p_assignment_id: manualCancelId(2000 + n), p_attempt_id: null, p_access_lease_id: null, p_request_id: request
  });
  const race = async (firstSql, secondSql, suffix) => {
    const first = await holder(firstSql, `manual_cancel_holder_${suffix}`);
    pending.push(first);
    const second = contender(secondSql, `manual_cancel_contender_${suffix}`);
    pending.push(second);
    try { await waitBlocked(`manual_cancel_contender_${suffix}`); }
    finally { await first.release(); }
    return Promise.all([first.done, second.done]);
  };
  try {
    const startFirst = await race(startSql(41, 'manual-race-start-wins'), cancelSql(41, 'manual-race-cancel-loses'), 'start');
    assert.equal(startFirst[0].exitCode, 0);
    assert.equal(startFirst[1].code, 'CLEANING_REQUEST_CANCEL_CONFLICT');
    assert.deepEqual(state(41), { target: 'in_progress', version: 2, attempt: 'in_progress', started: true,
      current: true, notices: 0, deliveries: 0, audits: 0, receipts: 0 }, 'A started winner cannot be cancelled');
    successful(await client.rpc('complete_cleaning_attempt_field_work', {
      p_actor_profile_id: manualCancelId(2), p_attempt_id: manualCancelId(3041), p_expected_execution_version: 2,
      p_expected_assignment_id: manualCancelId(2041), p_expected_assignment_revision: 2,
      p_idempotency_key: 'manual-race-finish-start-winner', p_request_hash: '5'.repeat(64)
    }), 'Manual cancellation start-winner cleanup failed');
    const cancelFirst = await race(cancelSql(42, 'manual-race-cancel-wins'), startSql(42, 'manual-race-start-loses'), 'cancel');
    assert.equal(cancelFirst[0].exitCode, 0);
    assert.equal(cancelFirst[1].code, 'ASSIGNMENT_VERSION_CONFLICT');
    assert.deepEqual(state(42), { target: 'cancelled', version: 3, attempt: 'superseded', started: false,
      current: false, notices: 1, deliveries: 1, audits: 1, receipts: 1 }, 'Cancelled winner prevents later start and emits once');

    const request43 = randomUUID();
    const reveal43 = successful(await client.rpc('begin_room_pin_reveal', beginArgs(43, request43)), 'Finalize-first reveal preparation failed');
    const finalizedFirst = await race(finalizeSql(43, reveal43.lease_id, request43), cancelSql(43, 'manual-race-after-disclosure'), 'finalized');
    assert(finalizedFirst.every((value) => value.exitCode === 0), 'Finalized disclosure and later unstarted cancellation both succeed');
    assert.equal(localSql(`select finalized_at is not null and revoked_at is null from private.room_pin_reveal_leases where id='${reveal43.lease_id}';`), 't');
    assert.equal(state(43).target, 'cancelled');

    const request44 = randomUUID();
    const reveal44 = successful(await client.rpc('begin_room_pin_reveal', beginArgs(44, request44)), 'Cancel-first reveal preparation failed');
    const cancelledFirst = await race(cancelSql(44, 'manual-race-open-reveal'), finalizeSql(44, reveal44.lease_id, request44), 'reveal');
    assert.equal(cancelledFirst[0].exitCode, 0);
    assert.equal(cancelledFirst[1].code, 'PIN_REVEAL_AUTHORIZATION_CHANGED');
    assert.equal(localSql(`select finalized_at is null and revoked_at is not null from private.room_pin_reveal_leases where id='${reveal44.lease_id}';`), 't');
    const newBegin = await client.rpc('begin_room_pin_reveal', beginArgs(44, randomUUID()));
    assert.equal(newBegin.error?.message, 'PIN_ENTITLEMENT_REQUIRED', 'Cancelled assignment cannot begin again');

    // Profile/session mutations use actual row locks held by the wrapper, not
    // guessed delays. Account and session decisions must be rechecked after wait.
    const passwordRace = await race(`select pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
      update public.profiles set must_change_password=true where id='${manualCancelId(1)}';`,
    cancelSql(45, 'manual-race-password-denied'), 'password');
    assert.equal(passwordRace[0].exitCode, 0);
    assert.equal(passwordRace[1].code, 'PASSWORD_CHANGE_REQUIRED');
    assert.equal(state(45).target, 'notified');
    assert.equal(state(45).receipts, 0);
    localSql(`update public.profiles set must_change_password=false where id='${manualCancelId(1)}';`);
    const sessionRace = await race(`select pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
      delete from auth.sessions where id='${manualCancelId(201)}';`, cancelSql(46, 'manual-race-session-denied'), 'session');
    assert.equal(sessionRace[0].exitCode, 0);
    assert.equal(sessionRace[1].code, 'SESSION_REVOKED');
    assert.equal(state(46).target, 'notified');
    assert.equal(state(46).audits, 0);
    localSql(`insert into auth.sessions(id,user_id) values('${manualCancelId(201)}','${manualCancelId(101)}');`);

    const lockOwner = await holder(cancelSql(47, 'manual-race-session-held'), 'manual_cancel_holder_session_row');
    pending.push(lockOwner);
    const sessionDelete = contender(`delete from auth.sessions where id='${manualCancelId(201)}';`, 'manual_cancel_contender_session_row');
    pending.push(sessionDelete);
    try { await waitBlocked('manual_cancel_contender_session_row'); } finally { await lockOwner.release(); }
    const heldResults = await Promise.all([lockOwner.done, sessionDelete.done]);
    assert(heldResults.every((value) => value.exitCode === 0), 'Successful cancellation holds session identity through commit');
    assert.equal(state(47).target, 'cancelled');
    const deniedReplay = await client.rpc('cancel_manual_cleaning_request_with_session', args(47, 'manual-race-session-held'));
    assert.equal(deniedReplay.error?.message, 'SESSION_REVOKED', 'Completed receipt cannot bypass revoked live session');
    localSql(`insert into auth.sessions(id,user_id) values('${manualCancelId(201)}','${manualCancelId(101)}');`);

    const sameKey = randomUUID();
    const same = await Promise.all([client.rpc('cancel_manual_cleaning_request_with_session', args(48, sameKey)),
      client.rpc('cancel_manual_cleaning_request_with_session', args(48, sameKey))]);
    const firstData = successful(same[0], 'Concurrent cancellation replay first request failed');
    assert.deepEqual(successful(same[1], 'Concurrent cancellation replay second request failed'), firstData);
    assert.deepEqual(state(48), { target: 'cancelled', version: 3, attempt: 'superseded', started: false,
      current: false, notices: 1, deliveries: 1, audits: 1, receipts: 1 }, 'Concurrent same-scope replay emits one whole effect');
    const different = await Promise.all([client.rpc('cancel_manual_cleaning_request_with_session', args(49)),
      client.rpc('cancel_manual_cleaning_request_with_session', args(49))]);
    assert.equal(different.filter((value) => !value.error).length, 1, 'Different receipt keys with the same CAS have one winner');
    assert(different.some((value) => value.error?.message === 'STALE_VERSION'));
    assert.equal(state(49).notices, 1);
    assert.equal(state(49).receipts, 1);

    // A valid-at-dispatch session can expire while the command is genuinely
    // blocked. Observe the database clock crossing its immutable cutoff before
    // releasing the global lock; transaction_timestamp() would accept it here.
    const expiryNoticesBefore = localSql(`select md5(string_agg(row_to_json(n)::text,'|' order by id))
      from public.notifications n where cleaning_target_id='${manualCancelId(1050)}';`);
    localSql(`update auth.sessions set not_after=clock_timestamp()+interval '8 seconds' where id='${manualCancelId(201)}';`);
    const expiryHolder = await holder(`select pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));`,
    'manual_cancel_holder_expiry');
    pending.push(expiryHolder);
    const expiryContender = contender(cancelSql(50, 'manual-race-expired-after-wait'), 'manual_cancel_contender_expiry');
    pending.push(expiryContender);
    try {
      await waitBlocked('manual_cancel_contender_expiry');
      assert.equal(localSql(`select clock_timestamp()<not_after from auth.sessions
        where id='${manualCancelId(201)}';`), 't', 'The contender must be observed locked while its exact session is still valid');
      await waitSessionExpiry();
      await expiryHolder.release();
      const expiryResults = await Promise.all([expiryHolder.done, expiryContender.done]);
      assert.equal(expiryResults[0].exitCode, 0);
      assert.equal(expiryResults[1].code, 'SESSION_REVOKED', 'Session expiry during lock wait must fail with live DB clock');
      assert.deepEqual(state(50), { target: 'notified', version: 2, attempt: 'scheduled', started: false,
        current: true, notices: 0, deliveries: 0, audits: 0, receipts: 0 }, 'Expiry denial leaves the target and every cancellation effect unchanged');
      assert.equal(localSql(`select md5(string_agg(row_to_json(n)::text,'|' order by id))
        from public.notifications n where cleaning_target_id='${manualCancelId(1050)}';`), expiryNoticesBefore,
      'Expiry denial neither appends nor resolves the original target notification');
    } finally {
      await expiryHolder.release();
      await expiryContender.done;
      localSql(`update auth.sessions set not_after=null where id='${manualCancelId(201)}';`);
    }
    console.log('Manual cleaning cancellation concurrency: PASS; start/disclosure/session orderings and exact-once effects verified.');
  } finally {
    for (const item of pending) {
      if (item.release) await item.release();
      else item.child.kill();
    }
  }
}

async function runStandalone() {
  let resetStarted = false;
  let phase = 'local-identity';
  const reset = () => execFileSync(process.execPath, [cli, 'db', 'reset', '--local', '--no-seed'], { stdio: 'inherit' });
  try {
    const status = JSON.parse(execFileSync(process.execPath, [cli, 'status', '--output', 'json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    assert(['localhost', '127.0.0.1'].includes(new URL(status.API_URL).hostname), 'Disposable local Supabase required');
    resetStarted = true;
    phase = 'fresh-reset';
    reset();
    phase = 'read-only-api-readiness';
    await waitForLocalPostgrestReady({ apiUrl: status.API_URL, apiKey: status.SECRET_KEY });
    const client = createClient(status.API_URL, status.SECRET_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
    phase = 'fixture-and-races';
    await testManualCleaningCancelConcurrency(client);
  } catch (error) {
    const sourceLine = error instanceof Error ? error.stack?.match(/test-manual-cleaning-cancel-concurrency\.mjs:(\d+):\d+/)?.[1] : null;
    console.error(`Manual cancellation validation FAIL: ${JSON.stringify({ phase,
      kind: error instanceof assert.AssertionError ? 'ASSERTION_FAILED' : 'VALIDATION_FAILED',
      sourceLine: sourceLine ? Number(sourceLine) : null,
      ...(error?.summary ? { rpc: safeRpcResultSummary({ status: error.summary.status, error: { code: error.summary.code } }) } : {}) })}`);
    process.exitCode = 1;
  } finally {
    if (resetStarted) {
      try { reset(); } catch { console.error('Manual cancellation fresh cleanup FAIL'); process.exitCode = 1; }
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runStandalone();
