import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Each race has a live PostgreSQL holder and an observed blocking PID edge.
// Timers bound failures, never serve as evidence that a race really overlapped.
const root = fileURLToPath(new URL('..', import.meta.url));
const cli = fileURLToPath(new URL('../node_modules/supabase/dist/supabase.js', import.meta.url));
const psqlArgs = ['exec', '-i', 'supabase_db_room-management-system-backend', 'psql', '-X', '-qAt',
  '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'];
const source = readFileSync(new URL('../supabase/tests/payroll_adjustment_book.sql', import.meta.url), 'utf8');
const begin = '-- PAYROLL_BOOK_FIXTURE_BEGIN', end = '-- PAYROLL_BOOK_FIXTURE_END';
assert.equal(source.split(begin).length, 2); assert.equal(source.split(end).length, 2);
const fixture = source.split(begin)[1].split(end)[0];
assert(!/\\ir|\b(?:no_plan|plan|finish)\s*\(/i.test(fixture));
const id = n => `f3250000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const literal = value => `'${value.replaceAll("'", "''")}'`;
const fence = "select pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));";
const safeCodes = ['PAYROLL_REMITTANCE_MARKER_STALE_VERSION', 'PAYROLL_REMITTANCE_BASIS_CHANGED', 'SESSION_REVOKED',
  'ADMIN_REQUIRED', 'PASSWORD_CHANGE_REQUIRED', 'IDEMPOTENCY_KEY_REUSED'];
let week, phase = 'local-identity', resetStarted = false, overlaps = 0;
const pending = [];
const read = (actor = 1, session = 400 + actor, role = 'admin') => `select public.get_payroll_remittance_marker(
  '${id(actor)}','${id(session)}','${role}','${id(2)}',${week});`;
const set = (projection, marked, key, actor = 1, session = 400 + actor) => `select public.set_payroll_remittance_marker(
  '${id(actor)}','${id(session)}','admin','${id(2)}',${week},${marked},${projection.version},
  ${literal(projection.basisFingerprint)},${literal(key)},repeat('a',64));`;
const reconfirm = (projection, key, actor = 1) => `select public.reconfirm_payroll_remittance_marker(
  '${id(actor)}','${id(400 + actor)}','admin','${id(2)}',${week},${projection.version},
  ${literal(projection.basisFingerprint)},${literal(key)},repeat('b',64));`;
const correction = (amount, version, key) => `select public.record_payroll_correction('${id(1)}',
  '${id(5001)}',null,${amount},${version},${literal(key)},repeat('c',64));`;
function sql(input) {
  try { return execFileSync('docker', psqlArgs, { cwd: root, input: `set statement_timeout='8s';${input}`,
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 13000, maxBuffer: 16 * 1024 * 1024 }).trim(); }
  catch { throw new Error('PAYROLL_REMITTANCE_RACE_SQL_FAILED'); }
}
function reset() { execFileSync(process.execPath, [cli, 'db', 'reset', '--local', '--no-seed'], { cwd: root, stdio: 'inherit' }); }
function state(financial = false, extraExcluded = []) {
  const excluded = financial ? ['private.payroll_remittance_markers', 'private.payroll_remittance_marker_revisions',
    'public.audit_events', 'private.command_executions'] : [];
  const tables = JSON.parse(sql(`select jsonb_agg(format('%I.%I',n.nspname,c.relname) order by n.nspname,c.relname)
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private') and c.relkind='r';`));
  const rows = tables.filter(x => !excluded.includes(x) && !extraExcluded.includes(x)).map(table => {
    assert(/^(public|private)\.[a-z_][a-z_0-9]*$/.test(table));
    return `select ${literal(table)} tag,to_jsonb(t)::text data from ${table} t`;
  });
  return sql(`select md5(coalesce(string_agg(tag||':'||data,'|' order by tag,data),''))
    from (${rows.join(' union all ')}) all_rows;`);
}
function effects() {
  return JSON.parse(sql(`select jsonb_build_object(
    'version',(select coalesce(max(version),0) from private.payroll_remittance_markers),
    'revisions',(select count(*) from private.payroll_remittance_marker_revisions),
    'audits',(select count(*) from public.audit_events where event_type in
      ('payroll.remittance_marked','payroll.remittance_cleared','payroll.remittance_reconfirmed')),
    'receipts',(select count(*) from private.command_executions where command_type in
      ('payroll.remittance.set','payroll.remittance.reconfirm')));`));
}
function oneEffect(before, after) {
  assert.deepEqual(after, Object.fromEntries(Object.entries(before).map(([key, value]) => [key, value + 1])),
    'Only the winner appends one revision, audit, receipt and CAS version');
}
function processResult(child) {
  let safeCode = null, output = '', stderr = '';
  const timer = setTimeout(() => child.kill(), 30000);
  const done = new Promise(resolve => {
    child.once('error', () => { clearTimeout(timer); resolve({ exitCode: -1, code: 'PROCESS_FAILED' }); });
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
      if (stderr.includes('deadlock detected')) safeCode = 'DEADLOCK';
      else { const code = safeCodes.find(value => stderr.includes(value));
        if (code) safeCode = code; else if (stderr.includes('ERROR:')) safeCode = 'OTHER_DATABASE_ERROR'; }
    });
    child.once('close', exitCode => { clearTimeout(timer); resolve({ exitCode, code: safeCode }); });
  });
  return { child, done, output: () => output.trim() };
}
async function holder(command, name) {
  assert(/^[a-z_]+$/.test(name));
  const child = spawn('docker', psqlArgs, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  const item = processResult(child); let ready = false, released = false;
  const readyPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('REMITTANCE_HOLDER_TIMEOUT')); }, 12000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('REMITTANCE_HOLDER_FAILED')); });
    child.once('close', () => { if (!ready) { clearTimeout(timer); reject(new Error('REMITTANCE_HOLDER_FAILED')); } });
    child.stdout.on('data', () => {
      if (!ready && item.output().includes('REMITTANCE_LOCK_HELD')) {
        ready = true; clearTimeout(timer); resolve();
      }
    });
  });
  item.release = async () => {
    if (!released) { released = true; child.stdin.end('commit;\n\\q\n'); }
    return item.done;
  };
  pending.push(item);
  child.stdin.write(`set application_name='${name}';begin;set local statement_timeout='20s';
    set local idle_in_transaction_session_timeout='25s';${command}\n\\echo REMITTANCE_LOCK_HELD\n`);
  await readyPromise;
  assert.equal(sql(`select exists(select 1 from pg_stat_activity where application_name='${name}'
    and state='idle in transaction' and xact_start is not null);`), 't');
  return item;
}
function contender(command, name) {
  assert(/^[a-z_]+$/.test(name));
  const child = spawn('docker', psqlArgs, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  const item = processResult(child); pending.push(item);
  child.stdin.end(`set application_name='${name}';begin;set local statement_timeout='20s';${command}commit;\n`);
  return item;
}
async function observedBlock(name, blockingName) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (sql(`select exists(select 1 from pg_stat_activity contender join pg_stat_activity holder
      on holder.pid=any(pg_blocking_pids(contender.pid)) where contender.application_name='${name}'
      and holder.application_name='${blockingName}' and contender.state='active'
      and contender.wait_event_type='Lock' and contender.xact_start is not null
      and holder.state='idle in transaction' and holder.xact_start is not null);`) === 't') {
      overlaps += 1; return;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('REMITTANCE_REAL_BLOCKING_EDGE_NOT_OBSERVED');
}
async function race(winner, loser, name, expectedCode, during) {
  const held = await holder(winner, `${name}_holder`), competing = contender(loser, `${name}_contender`);
  try {
    await observedBlock(`${name}_contender`, `${name}_holder`);
    if (during) await during();
    const won = await held.release(), lost = await competing.done;
    assert.equal(won.exitCode, 0); assert.equal(won.code, null);
    if (expectedCode === null) { assert.equal(lost.exitCode, 0); assert.equal(lost.code, null); }
    else { assert.notEqual(lost.exitCode, 0); assert.equal(lost.code, expectedCode, 'Only the expected domain denial is acceptable'); }
    return competing;
  } finally { await held.release(); await competing.done; }
}
async function denied(command, code, name) {
  const result = contender(command, name), verdict = await result.done;
  assert.notEqual(verdict.exitCode, 0); assert.equal(verdict.code, code);
}
function addLateEarningSql() {
  // Reuse exactly the checked-in provenance constructor, not an invented fake
  // earning row. Capture the same week even if this script crosses KST Monday.
  const prefix = fixture.split('insert into auth.users')[0];
  const parts = fixture.split('create function pg_temp.book_add_earning');
  assert.equal(parts.length, 2);
  const functionBody = parts[1].split('select pg_temp.book_add_earning(1,2,-4,10000);');
  assert.equal(functionBody.length, 2);
  const weekExpression = "date_trunc('week',statement_timestamp() at time zone 'Asia/Seoul')::date";
  assert.equal(prefix.split(weekExpression).length, 2);
  const captured = prefix.replace(weekExpression, `(${week}+28)`);
  return `${captured}create function pg_temp.book_add_earning${functionBody[0]}
    select pg_temp.book_add_earning(30,2,-4,2000);`;
}
try {
  const config = readFileSync(new URL('../supabase/config.toml', import.meta.url), 'utf8');
  assert.equal((config.match(/^[ \t]*project_id[ \t]*=/gm) ?? []).length, 1);
  assert.equal(/^[ \t]*project_id[ \t]*=[ \t]*"([^"\r\n]+)"[ \t]*(?:#[^\r\n]*)?\r?$/m.exec(config)?.[1],
    'room-management-system-backend');
  const status = JSON.parse(execFileSync(process.execPath, [cli, 'status', '--output', 'json'],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert(['localhost', '127.0.0.1'].includes(new URL(status.API_URL).hostname));
  resetStarted = true; phase = 'fresh-fixture'; reset(); sql(`begin;${fixture}commit;`);
  const capturedWeek = sql(`select to_char(date_trunc('week',earned_on::timestamp)::date,'YYYY-MM-DD')
    from public.earnings where id='${id(5001)}';`);
  assert(/^\d{4}-\d{2}-\d{2}$/.test(capturedWeek)); week = `${literal(capturedWeek)}::date`;
  phase = 'same-version-two-admins';
  const initial = JSON.parse(sql(read())), initialB = JSON.parse(sql(read(3)));
  assert.deepEqual(initialB, initial); assert.equal(initial.version, 0);
  let before = effects(), financial = state(true);
  const oldOn = set(initial, true, 'remittance-race-on');
  await race(oldOn, set(initialB, false, 'remittance-race-stale-off', 3), 'remittance_cas', 'PAYROLL_REMITTANCE_MARKER_STALE_VERSION', () => {
    assert.deepEqual(JSON.parse(sql(read(3))), initial, 'Nonlocking read sees committed pre-command state');
  });
  oneEffect(before, effects()); assert.equal(state(true), financial);
  const on = JSON.parse(sql(read())); assert.equal(on.marked, true); assert.equal(on.version, 1);
  phase = 'same-key-real-replay';
  before = effects(); const sameKey = set(on, false, 'remittance-race-same-key');
  const replayed = await race(sameKey, sameKey, 'remittance_replay', null);
  oneEffect(before, effects()); assert.equal(JSON.parse(replayed.output()).version, 2);
  assert.equal(state(true), financial);
  const oldOnResult = JSON.parse(sql(oldOn)); assert.equal(oldOnResult.version, 1); assert.equal(oldOnResult.marked, true);
  assert.equal(JSON.parse(sql(read())).version, 2, 'Replay never restores superseded display');
  phase = 'financial-adjustment-beats-stale-basis';
  let current = JSON.parse(sql(read())); before = effects();
  await race(correction(-100, 0, 'remittance-race-actual-adjustment'),
    set(current, true, 'remittance-race-adjustment-stale'), 'remittance_adjustment', 'PAYROLL_REMITTANCE_BASIS_CHANGED');
  assert.deepEqual(effects(), before); assert.equal(JSON.parse(sql(read())).marked, false);
  assert.equal(sql(`select count(*) from public.payroll_adjustments where maid_profile_id='${id(2)}';`), '1');
  current = JSON.parse(sql(read())); const confirmedOn = JSON.parse(sql(set(current, true, 'remittance-race-refetched-on', 3)));
  phase = 'amount-change-retains-on-and-separate-ack';
  sql(correction(25, 1, 'remittance-race-second-adjustment'));
  current = JSON.parse(sql(read())); assert.equal(current.marked, true); assert.equal(current.needsReconfirmation, true);
  assert.equal(current.version, confirmedOn.version); assert.deepEqual(current.confirmedBasis, confirmedOn.basis);
  financial = state(true); before = effects();
  const ack = JSON.parse(sql(reconfirm(current, 'remittance-race-ack', 1)));
  oneEffect(before, effects()); assert.equal(ack.marked, true); assert.equal(ack.needsReconfirmation, false);
  assert.equal(ack.lastChangedBy, confirmedOn.lastChangedBy); assert.equal(ack.lastChangedAt, confirmedOn.lastChangedAt);
  assert.equal(ack.confirmedBy, id(1)); assert.equal(state(true), financial);
  phase = 'actual-start-alone-is-not-a-money-change';
  before = effects(); current = JSON.parse(sql(read()));
  const startCommand = `select public.start_payroll_cycle('${id(1)}','${id(2)}',${week},0,
    'remittance-race-actual-start',repeat('d',64));`;
  await race(startCommand, set(current, true, 'remittance-race-start-noop', 3), 'remittance_start', null);
  assert.deepEqual(effects(), { ...before, receipts: before.receipts + 1 },
    'Same-money actual start and same-value on write a receipt, never a fake display revision');
  const started = JSON.parse(sql(startCommand)); assert.equal(started.status, 'paying'); assert.equal(started.lockedAmount, 9925);
  const paidCommand = `select public.record_payroll_payment_paid('${id(1)}',${literal(started.paymentAttemptId)},
    ${started.version},'bank_transfer','RACE-REM-A1','remittance-race-actual-paid',repeat('e',64));`;
  const paid = JSON.parse(sql(paidCommand));
  current = JSON.parse(sql(read())); assert.equal(current.marked, true); assert.equal(current.needsReconfirmation, false);
  assert.equal(current.version, ack.version, 'Actual PAYING/PAID and lockedAmount alone do not change display CAS');
  assert.equal(current.confirmedBasis.lockedAmount, null, 'Original display snapshot remains immutable');
  assert.equal(current.basis.lockedAmount, 9925, 'Current financial lock is still observable separately');
  phase = 'paid-fixed-lock-late-earning-warning-and-ack-race';
  sql(`begin;${addLateEarningSql()}commit;`);
  current = JSON.parse(sql(read())); assert.equal(current.marked, true); assert.equal(current.needsReconfirmation, true);
  assert.equal(current.basis.lockedAmount, 9925); assert.equal(current.basis.payableAmount, 9925);
  assert.equal(current.basis.accrualAmount, 12000); assert.equal(current.basis.lateEarningAmount, 2000);
  financial = state(true); before = effects();
  await race(reconfirm(current, 'remittance-race-paid-ack', 1), reconfirm(current, 'remittance-race-paid-ack-stale', 3),
    'remittance_ack', 'PAYROLL_REMITTANCE_MARKER_STALE_VERSION');
  oneEffect(before, effects()); assert.equal(state(true), financial);
  assert.deepEqual(JSON.parse(sql(paidCommand)), paid); assert.equal(sql(`select status from public.payroll_cycles
    where id=${literal(started.cycleId)};`), 'paid');
  phase = 'session-expiry-after-observed-global-wait';
  current = JSON.parse(sql(read())); before = effects(); financial = state(true);
  sql(`update auth.sessions set not_after=clock_timestamp()+interval '4 seconds' where id='${id(403)}';`);
  await race(fence, set(current, false, 'remittance-race-expired', 3), 'remittance_expiry', 'SESSION_REVOKED', async () => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && sql(`select clock_timestamp()>=not_after from auth.sessions where id='${id(403)}';`) !== 't') {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(sql(`select clock_timestamp()>=not_after from auth.sessions where id='${id(403)}';`), 't',
      'The actual DB clock passed the exact session deadline while the global blocker was still held');
  });
  assert.deepEqual(effects(), before); assert.equal(state(true), financial);
  sql(`update auth.sessions set not_after=null where id='${id(403)}';`);
  phase = 'session-delete-first-observed-global-wait';
  await race(`${fence}delete from auth.sessions where id='${id(403)}';`,
    set(current, false, 'remittance-race-revoked', 3), 'remittance_revoke', 'SESSION_REVOKED');
  assert.deepEqual(effects(), before); assert.equal(state(true), financial);
  sql(`insert into auth.sessions(id,user_id) values('${id(403)}','${id(103)}');`);
  phase = 'latest-role-change-after-observed-global-wait';
  await race(`${fence}update public.profiles set role='maid' where id='${id(3)}';`,
    set(current, false, 'remittance-race-role-changed', 3), 'remittance_role', 'ADMIN_REQUIRED');
  assert.deepEqual(effects(), before);
  sql(`update public.profiles set role='admin' where id='${id(3)}';`);
  // The legitimate account command advances profile updated_at. Capture the
  // complete business state after restoring it, not an impossible old timestamp.
  financial = state(true);
  phase = 'latest-password-gate-after-observed-global-wait';
  await race(`${fence}update public.profiles set must_change_password=true where id='${id(3)}';`,
    set(current, false, 'remittance-race-password-changed', 3), 'remittance_password', 'PASSWORD_CHANGE_REQUIRED');
  assert.deepEqual(effects(), before);
  sql(`update public.profiles set must_change_password=false where id='${id(3)}';`);
  financial = state(true);
  phase = 'marker-first-session-delete-must-wait';
  const heldCommand = set(current, false, 'remittance-race-session-share', 3);
  const deleted = await race(heldCommand, `delete from auth.sessions where id='${id(403)}';`, 'remittance_share', null);
  assert.equal(deleted.output(), ''); oneEffect(before, effects()); assert.equal(state(true), financial);
  phase = 'receipt-wait-revocation-before-hash-conflict';
  sql(`insert into auth.sessions(id,user_id) values('${id(403)}','${id(103)}');`);
  const receiptKey = 'remittance-race-session-share';
  const receiptLock = `select pg_advisory_xact_lock(hashtextextended(
    '${id(3)}:payroll.remittance.set:${receiptKey}',0));`;
  assert.equal(heldCommand.split("repeat('a',64)").length, 2);
  const mismatchedReplay = heldCommand.replace("repeat('a',64)", "repeat('f',64)");
  before = effects(); financial = state(true);
  await race(`${receiptLock}delete from auth.sessions where id='${id(403)}';`, mismatchedReplay,
    'remittance_receipt_revoke', 'SESSION_REVOKED');
  assert.deepEqual(effects(), before); assert.equal(state(true), financial,
    'Receipt-wait revoked hash mismatch leaves every business row unchanged');
  phase = 'receipt-wait-role-change-before-hash-conflict';
  sql(`insert into auth.sessions(id,user_id) values('${id(403)}','${id(103)}');`);
  const nonAccountRows = state(true, ['public.profiles']);
  await race(`${receiptLock}update public.profiles set role='maid' where id='${id(3)}';`, mismatchedReplay,
    'remittance_receipt_role', 'ADMIN_REQUIRED');
  assert.deepEqual(effects(), before); assert.equal(state(true, ['public.profiles']), nonAccountRows,
    'Only the explicit profile change takes effect; denied mismatched replay has no business effects');
  sql(`update public.profiles set role='admin' where id='${id(3)}';
    delete from auth.sessions where id='${id(403)}';`);
  const nowState = state();
  await denied(heldCommand, 'SESSION_REVOKED', 'remittance_revoked_replay');
  assert.equal(state(), nowState, 'Revoked-session successful receipt replay is still denied without any row effects');
  const history = JSON.parse(sql(`select public.list_payroll_remittance_marker_history('${id(1)}','${id(401)}',
    'admin','${id(2)}',${week},null,100);`));
  assert.equal(history.hasMore, false); assert.equal(history.entries.length, effects().revisions);
  assert.deepEqual(history.entries.map(x => x.version), Array.from({ length: history.entries.length }, (_, i) => i + 1));
  sql(`begin read only;${read()}${read(2, 402, 'maid')}rollback;`);
  assert.equal(state(), nowState); assert.equal(overlaps, 12, 'All twelve races have observed real PostgreSQL blocking PID edges');
  console.log('Payroll remittance marker concurrency PASS: 12 observed PostgreSQL blocking edges; CAS winner, exact same-key replay, financial basis races, separate ACK, PAID late-earning warning, post-wait expiry/revocation/role checks, session-share ordering and receipt-wait auth denial before hash conflict; no deadlock or display-induced financial changes.');
} catch (error) {
  const line = error instanceof Error ? error.stack?.match(/test-payroll-remittance-marker-concurrency\.mjs:(\d+):\d+/)?.[1] : null;
  console.error(`Payroll remittance marker concurrency FAIL: ${JSON.stringify({ phase,
    kind: error instanceof assert.AssertionError ? 'ASSERTION_FAILED' : 'VALIDATION_FAILED', sourceLine: line ? Number(line) : null })}`);
  process.exitCode = 1;
} finally {
  for (const item of pending) {
    try { if (item.release) await item.release(); else if (item.child.exitCode === null) { item.child.kill(); await item.done; } }
    catch { process.exitCode = 1; }
  }
  if (resetStarted) {
    try {
      reset(); const manifest = JSON.parse(readFileSync(new URL('../supabase/migration-manifest.dev.json', import.meta.url), 'utf8'));
      assert.equal(sql('select count(*) from supabase_migrations.schema_migrations;'), String(manifest.totalCount));
      assert.equal(sql('select count(*) from public.profiles;'), '0'); assert.equal(sql('select count(*) from auth.users;'), '0');
    } catch { console.error('Payroll remittance marker concurrency fresh cleanup FAIL'); process.exitCode = 1; }
  }
}
