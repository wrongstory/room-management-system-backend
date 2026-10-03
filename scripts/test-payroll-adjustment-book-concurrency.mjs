import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Two actual PostgreSQL transactions overlap on the existing command's lock.
// The new read observes committed CAS state without taking command locks. No
// simulated Promise race, remote project or change to existing writers is used.
const root = fileURLToPath(new URL('..', import.meta.url));
const cli = fileURLToPath(new URL('../node_modules/supabase/dist/supabase.js', import.meta.url));
const psqlArgs = ['exec', '-i', 'supabase_db_room-management-system-backend', 'psql', '-X', '-qAt',
  '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'];
const source = readFileSync(new URL('../supabase/tests/payroll_adjustment_book.sql', import.meta.url), 'utf8');
const beginMarker = '-- PAYROLL_BOOK_FIXTURE_BEGIN';
const endMarker = '-- PAYROLL_BOOK_FIXTURE_END';
assert.equal(source.split(beginMarker).length, 2);
assert.equal(source.split(endMarker).length, 2);
const fixture = source.split(beginMarker)[1].split(endMarker)[0];
assert(!/\\ir|\b(?:no_plan|plan|finish)\s*\(/i.test(fixture), 'Only source-controlled setup is reused');
const id = (n) => `f3250000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const week = `(date_trunc('week',statement_timestamp() at time zone 'Asia/Seoul')::date)`;
const read = (actor = 1) => `select public.get_payroll_adjustment_book('${id(actor)}','${id(400 + actor)}','${id(2)}',${week});`;
const firstSource = `(select id from public.payroll_adjustments where maid_profile_id='${id(2)}' and book_version=1)`;
const correct = (actor, version, amount, key) => `select public.record_payroll_correction('${id(actor)}',null,
  ${firstSource},${amount},${version},'${key}',repeat('b',64));`;
const reverse = (actor, version, key) => `select public.reverse_payroll_source('${id(actor)}',null,
  ${firstSource},${version},'${key}',repeat('c',64));`;
const first = `select public.record_payroll_correction('${id(1)}','${id(5001)}',null,
  -100,0,'book-race-first',repeat('a',64));`;
let phase = 'local-identity';
let resetStarted = false;
const pending = [];
function sql(input) {
  try {
    return execFileSync('docker', psqlArgs, { cwd: root, input: `set statement_timeout='10s';${input}`,
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000, maxBuffer: 16 * 1024 * 1024 }).trim();
  } catch { throw new Error('PAYROLL_ADJUSTMENT_BOOK_RACE_SQL_FAILED'); }
}
function reset() {
  execFileSync(process.execPath, [cli, 'db', 'reset', '--local', '--no-seed'], { cwd: root, stdio: 'inherit' });
}
function wholeState() {
  const tables = JSON.parse(sql(`select jsonb_agg(format('%I.%I',n.nspname,c.relname) order by n.nspname,c.relname)
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private') and c.relkind='r';`));
  const rows = tables.map((table) => {
    assert(/^(public|private)\.[a-z_][a-z_0-9]*$/.test(table));
    return `select '${table}' tag,to_jsonb(t)::text data from ${table} t`;
  });
  return sql(`select md5(coalesce(string_agg(tag||':'||data,'|' order by tag,data),''))
    from (${rows.join(' union all ')}) all_rows;`);
}
function effects() {
  return JSON.parse(sql(`select jsonb_build_object(
    'version',(select version from public.payroll_adjustment_books where maid_profile_id='${id(2)}'),
    'adjustments',(select count(*) from public.payroll_adjustments where maid_profile_id='${id(2)}'),
    'audits',(select count(*) from public.audit_events where event_type in('payroll.adjustment_recorded','payroll.adjustment_reversed')),
    'notices',(select count(*) from public.notifications where recipient_profile_id='${id(2)}'
      and category in('payroll_adjustment_recorded','payroll_adjustment_reversed')),
    'receipts',(select count(*) from private.command_executions where command_type in('payroll.adjustment.correct','payroll.adjustment.reverse')));`));
}
function processResult(child) {
  let safeCode = null;
  let output = '';
  const timer = setTimeout(() => child.kill(), 25000);
  const done = new Promise((resolve) => {
    child.once('error', () => { clearTimeout(timer); resolve({ exitCode: -1, code: 'PROCESS_FAILED' }); });
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    // Never expose raw SQL, RPC payloads, IDs or subprocess errors in failures.
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      if (text.includes('deadlock detected')) safeCode = 'DEADLOCK';
      else if (text.includes('STALE_ADJUSTMENT_VERSION')) safeCode = 'STALE_ADJUSTMENT_VERSION';
      else if (text.includes('PAYROLL_SOURCE_ALREADY_REVERSED')) safeCode = 'PAYROLL_SOURCE_ALREADY_REVERSED';
      else if (text.includes('ERROR:')) safeCode = 'OTHER_DATABASE_ERROR';
    });
    child.once('close', (exitCode) => { clearTimeout(timer); resolve({ exitCode, code: safeCode }); });
  });
  return { child, done, output: () => output };
}
async function holder(command, name) {
  assert(/^[a-z_]+$/.test(name));
  const child = spawn('docker', psqlArgs, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  const item = processResult(child);
  let ready = false;
  const readyPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('PAYROLL_BOOK_HOLDER_TIMEOUT')); }, 10000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('PAYROLL_BOOK_HOLDER_FAILED')); });
    child.once('close', () => { if (!ready) { clearTimeout(timer); reject(new Error('PAYROLL_BOOK_HOLDER_FAILED')); } });
    child.stdout.on('data', (chunk) => {
      if (!ready && (item.output() + chunk.toString()).includes('PAYROLL_BOOK_LOCK_HELD')) {
        ready = true;
        clearTimeout(timer);
        resolve();
      }
    });
  });
  let released = false;
  item.release = async () => {
    if (!released) { released = true; child.stdin.end('commit;\n\\q\n'); }
    return item.done;
  };
  pending.push(item);
  child.stdin.write(`set application_name='${name}';begin;set local statement_timeout='15s';
    set local idle_in_transaction_session_timeout='20s';${command}\n\\echo PAYROLL_BOOK_LOCK_HELD\n`);
  await readyPromise;
  return item;
}
function contender(command, name) {
  assert(/^[a-z_]+$/.test(name));
  const child = spawn('docker', psqlArgs, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  const item = processResult(child);
  pending.push(item);
  child.stdin.end(`set application_name='${name}';begin;set local statement_timeout='15s';${command}commit;\n`);
  return item;
}
async function waitBlocked(name) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (sql(`select exists(select 1 from pg_stat_activity where application_name='${name}'
      and state='active' and wait_event_type='Lock' and xact_start is not null);`) === 't') return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('PAYROLL_BOOK_REAL_OVERLAP_NOT_OBSERVED');
}
async function race(winner, loser, name, versionBefore) {
  const held = await holder(winner, `${name}_holder`);
  const competing = contender(loser, `${name}_contender`);
  try {
    await waitBlocked(`${name}_contender`);
    // A command has changed its uncommitted book, but a second connection's
    // nonlocking STABLE read still sees the last committed CAS V and succeeds.
    const readerBefore = JSON.parse(sql(read(3)));
    assert.equal(readerBefore.currentBookVersion, versionBefore);
    await held.release();
    const results = await Promise.all([held.done, competing.done]);
    assert.equal(results[0].exitCode, 0, 'The held real command commits');
    assert.equal(results[0].code, null, 'Winner has no deadlock or other database error');
    assert.notEqual(results[1].exitCode, 0, 'The truly overlapping loser is rejected');
    assert.equal(results[1].code, 'STALE_ADJUSTMENT_VERSION', 'Only stale CAS is acceptable, not deadlock/timeout/generic errors');
    assert.equal(JSON.parse(sql(read(3))).currentBookVersion, versionBefore + 1);
    assert.deepEqual(effects(), { version: versionBefore + 1, adjustments: versionBefore + 1,
      audits: versionBefore + 1, notices: versionBefore + 1, receipts: versionBefore + 1 },
    'Only one winner appends exactly one complete ledger/audit/notice/receipt effect');
  } finally { await held.release(); await competing.done; }
}
try {
  const status = JSON.parse(execFileSync(process.execPath, [cli, 'status', '--output', 'json'],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert(['localhost', '127.0.0.1'].includes(new URL(status.API_URL).hostname), 'Only local synthetic races are allowed');
  resetStarted = true;
  phase = 'fresh-reset';
  reset();
  phase = 'fixture';
  sql(`begin;${fixture}commit;`);
  const originalEarnings = sql(`select md5(string_agg(to_jsonb(e)::text,'|' order by id)) from public.earnings e;`);
  const originalReceipt = JSON.parse(sql(first));
  phase = 'admin-same-version-reads';
  const a = JSON.parse(sql(read()));
  const b = JSON.parse(sql(read(3)));
  assert.equal(a.currentBookVersion, 1);
  assert.deepEqual(a, b, 'Independent admin connections read the same current CAS V');
  phase = 'correction-wins-reversal-stale';
  await race(correct(1, 1, 5, 'book-race-correct-winner'), reverse(3, 1, 'book-race-reverse-stale'), 'book_correct', 1);
  phase = 'reversal-wins-correction-stale';
  await race(reverse(1, 2, 'book-race-reverse-winner'), correct(3, 2, 5, 'book-race-correct-stale'), 'book_reverse', 2);
  assert.equal(sql(`select amount from public.payroll_adjustments where maid_profile_id='${id(2)}' and book_version=3;`), '100');
  phase = 'reread-recorrect-old-entry';
  const staleRetryVersion = JSON.parse(sql(read(3))).currentBookVersion;
  assert.equal(staleRetryVersion, 3);
  sql(correct(3, staleRetryVersion, 5, 'book-race-refetched-success'));
  assert.deepEqual(effects(), { version: 4, adjustments: 4, audits: 4, notices: 4, receipts: 4 });
  const preserved = wholeState();
  phase = 'exact-old-receipt-and-readonly';
  assert.deepEqual(JSON.parse(sql(first)), originalReceipt, 'An old success receipt is exact, not hydrated to V4');
  sql(`begin read only;${read()}${read(3)}rollback;`);
  assert.equal(wholeState(), preserved, 'Replay/read-only queries preserve every full row');
  assert.equal(sql(`select md5(string_agg(to_jsonb(e)::text,'|' order by id)) from public.earnings e;`), originalEarnings);
  assert.equal(sql(`select count(*) from private.command_executions where idempotency_key
    in('book-race-reverse-stale','book-race-correct-stale');`), '0', 'Both CAS losers leave no receipt');
  console.log('Payroll adjustment book concurrency: PASS; two observed PostgreSQL correction/reversal overlaps, one winner and one stale loser each, no deadlock, nonlocking reads, refetch retry and exact receipts verified.');
} catch (error) {
  const sourceLine = error instanceof Error ? error.stack?.match(/test-payroll-adjustment-book-concurrency\.mjs:(\d+):\d+/)?.[1] : null;
  console.error(`Payroll adjustment book concurrency FAIL: ${JSON.stringify({ phase,
    kind: error instanceof assert.AssertionError ? 'ASSERTION_FAILED' : 'VALIDATION_FAILED',
    sourceLine: sourceLine ? Number(sourceLine) : null })}`);
  process.exitCode = 1;
} finally {
  for (const item of pending) {
    try { if (item.release) await item.release(); else item.child.kill(); } catch { process.exitCode = 1; }
  }
  if (resetStarted) {
    try { reset(); } catch { console.error('Payroll adjustment book concurrency fresh cleanup FAIL'); process.exitCode = 1; }
  }
}
