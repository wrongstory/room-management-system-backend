import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const container = 'supabase_db_room-management-system-backend';
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
const safeCodes = ['SESSION_REVOKED', 'CANDLE_ACCESS_REQUIRED', 'PASSWORD_CHANGE_REQUIRED',
  'STALE_VERSION', 'IDEMPOTENCY_KEY_REUSED', 'CANDLE_VERIFICATION_REQUIRED', 'INVALID_CANDLE_REQUEST'];
const safeError = (stderr) => safeCodes.find((code) => new RegExp(`ERROR:\\s+${code}(?:\\s|$)`).test(stderr)) ?? 'DATABASE_TEST_FAILED';
function assert(value, label) { if (!value) throw new Error(label); }
async function sql(query) {
  try {
    const { stdout } = await run('docker', ['exec', container, 'psql', '-XqAt', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', `set statement_timeout='10s';${query}`], { timeout: 15000, maxBuffer: 1024 * 1024 });
    return { value: stdout.trim(), error: null };
  } catch (error) {
    return { value: '', error: safeError(String(error.stderr ?? '')) };
  }
}
async function must(query) { const result = await sql(query); assert(!result.error, result.error); return result.value; }
async function barrier(key) {
  for (let n = 0; n < 100; n++) {
    if (await must(`select exists(select 1 from pg_locks where locktype='advisory' and classid=330 and objid=${key} and granted)`) === 't') return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('candle concurrency barrier timeout');
}

// These timers bound failures only. Actual PostgreSQL PID edges and DB time prove
// both overlaps; no deadline is extended once a contender has been launched.
function transaction(query, name, hold = false) {
  assert(/^[a-z][a-z0-9_]{1,60}$/.test(name), 'CANDLE_PROCESS_NAME_INVALID');
  const child = spawn('docker', ['exec', '-i', container, 'psql', '-XqAt', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', stderr = '', timedOut = false, closed = false, released = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 45000);
  const done = new Promise((resolve) => {
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.stdin.on('error', () => {}); // Broken pipe is represented by the sanitized close result.
    child.once('error', () => { closed = true; clearTimeout(timer); resolve({ exitCode: -1, error: 'CANDLE_PROCESS_FAILED' }); });
    child.once('close', (exitCode) => {
      closed = true; clearTimeout(timer);
      resolve({ exitCode, error: timedOut ? 'CANDLE_PROCESS_TIMEOUT' : exitCode === 0 ? null : safeError(stderr) });
    });
  });
  const input = `set application_name=${literal(name)};begin;set local statement_timeout='35s';
    set local idle_in_transaction_session_timeout='40s';select 'CANDLE_PID:'||pg_backend_pid();${query}\n`;
  if (hold) child.stdin.write(`${input}\\echo CANDLE_LOCK_HELD\n`);
  else child.stdin.end(`${input}commit;\n`);
  return { done, output: () => output, closed: () => closed, release: async () => {
    if (!released) { released = true; if (!closed) child.stdin.end('commit;\n\\q\n'); }
    return done;
  } };
}
async function readyPid(item, held = false) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline && !item.closed()) {
    const match = /(?:^|\n)CANDLE_PID:([1-9][0-9]*)\r?(?:\n|$)/.exec(item.output());
    if (match && (!held || item.output().includes('CANDLE_LOCK_HELD'))) return Number(match[1]);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('CANDLE_LOCK_PROCESS_NOT_READY');
}
async function effects(room, actors) {
  return must(`select jsonb_build_object(
    'version',(select state_version from public.rooms where id=${literal(room)}),
    'count',private.current_candle_count(${literal(room)}),
    'room',(select md5(to_jsonb(r)::text) from public.rooms r where id=${literal(room)}),
    'eventCount',(select count(*) from public.room_candle_events where room_id=${literal(room)}),
    'events',(select md5(coalesce(string_agg(to_jsonb(e)::text,'|' order by e.id),'')) from public.room_candle_events e where room_id=${literal(room)}),
    'auditCount',(select count(*) from public.audit_events where entity_id=${literal(room)} and event_type='room.set_candle_count'),
    'audits',(select md5(coalesce(string_agg(to_jsonb(a)::text,'|' order by a.id),'')) from public.audit_events a where entity_id=${literal(room)} and event_type='room.set_candle_count'),
    'receiptCount',(select count(*) from private.command_executions where actor_profile_id in (${actors.map(literal).join(',')}) and command_type='room.operation.set_candle_count'),
    'receipts',(select md5(coalesce(string_agg(to_jsonb(c)::text,'|' order by c.id),'')) from private.command_executions c
      where actor_profile_id in (${actors.map(literal).join(',')}) and command_type='room.operation.set_candle_count'))`);
}
async function hardExpiryRace(kind, session, room, actors, command) {
  const before = await effects(room, actors);
  // New synthetic Auth deadline, not a product TTL or an Auth configuration change.
  // All actor/business fixture work has finished before this DB clock is issued.
  await must(`update auth.sessions set not_after=clock_timestamp()+interval '12 seconds' where id=${literal(session)};`);
  const lock = kind === 'room'
    ? `select id from public.rooms where id=${literal(room)} for update;`
    : `select id from auth.sessions where id=${literal(session)} for update;`;
  const tag = `candle_${kind}_expiry_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
  const held = transaction(lock, `${tag}_holder`, true);
  let competing;
  try {
    const holderPid = await readyPid(held, true);
    competing = transaction(command, `${tag}_contender`);
    const contenderPid = await readyPid(competing);
    const observation = (expired) => `select exists(select 1 from pg_stat_activity h,pg_stat_activity c,auth.sessions s
      where h.pid=${holderPid} and c.pid=${contenderPid} and h.application_name=${literal(`${tag}_holder`)}
        and c.application_name=${literal(`${tag}_contender`)} and h.state='idle in transaction' and h.xact_start is not null
        and c.state='active' and c.wait_event_type='Lock' and c.xact_start is not null
        and h.pid=any(pg_blocking_pids(c.pid)) and s.id=${literal(session)}
        and s.not_after is not null and clock_timestamp()${expired ? '>=' : '<'}s.not_after)`;
    const observe = async (expired) => {
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline && !competing.closed() && !held.closed()) {
        if (await must(observation(expired)) === 't') return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(expired ? 'CANDLE_EXPIRED_BLOCK_NOT_OBSERVED' : 'CANDLE_LIVE_BLOCK_NOT_OBSERVED');
    };
    await observe(false);
    await observe(true); // Same captured holder/contender stay locked across the actual DB deadline.
    const holderResult = await held.release();
    const denied = await competing.done;
    assert(holderResult.exitCode === 0 && holderResult.error === null, 'CANDLE_HOLDER_FAILED');
    assert(denied.exitCode !== 0 && denied.error === 'SESSION_REVOKED', 'CANDLE_HARD_EXPIRY_NOT_DENIED');
    assert(await effects(room, actors) === before, 'CANDLE_HARD_EXPIRY_CHANGED_LEDGER');
  } finally {
    await held.release();
    if (competing) await competing.done;
    await must(`update auth.sessions set not_after=null where id=${literal(session)};`);
  }
}

export async function testRoomCandleConcurrency() {
  // Fixed LOCAL Docker target only; synthetic ledger rows survive until the next local reset.
  const users = [randomUUID(), randomUUID()];
  const actors = [randomUUID(), randomUUID()];
  const sessions = [randomUUID(), randomUUID()];
  const suffix = randomUUID();
  for (let i = 0; i < 2; i++) {
    await must(`insert into auth.users(id) values(${literal(users[i])});
      insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,login_sequence,role,status,must_change_password)
      values(${literal(actors[i])},${literal(users[i])},'candle-${i}-${suffix}','candle-${i}-${suffix}','candle-${i}-${suffix}','candle-${i}-${suffix}',0,'maid','active',false);
      insert into auth.sessions(id,user_id) values(${literal(sessions[i])},${literal(users[i])});`);
  }
  const room = await must('select id from public.rooms order by id desc limit 1');
  const version = () => must(`select state_version from public.rooms where id=${literal(room)}`);
  const count = () => must(`select private.current_candle_count(${literal(room)})`);
  const command = (i, qty, v, key) => `select public.set_room_candle_count(${literal(actors[i])},${literal(sessions[i])},${literal(room)},${v},'CANDLE_ADJUSTED',
    jsonb_build_object('count',${qty},'physicallyVerified',true),${literal(key)},encode(extensions.digest(${literal(key)}||${literal(String(qty))},'sha256'),'hex'))`;
  let v = await version();
  const race = await Promise.all([0, 1, 2].map((qty) => sql(command(qty % 2, qty, v, randomUUID()))));
  assert(race.filter((r) => !r.error).length === 1 && race.filter((r) => r.error === 'STALE_VERSION').length === 2, 'one simultaneous add/reduce/reset wins CAS');
  assert(Number(await version()) === Number(v) + 1, 'CAS race changes version exactly once');
  v = await version();
  const key = randomUUID();
  const retries = await Promise.all(Array.from({ length: 5 }, () => sql(command(0, 7, v, key))));
  assert(retries.every((r) => !r.error && r.value === retries[0].value), 'concurrent same-key requests replay one receipt');
  assert(await count() === '7' && Number(await version()) === Number(v) + 1, 'retries apply once');
  const changedHash = await sql(command(0, 8, v, key));
  assert(changedHash.error === 'IDEMPOTENCY_KEY_REUSED', 'same-key different count conflicts');

  await hardExpiryRace('room', sessions[0], room, actors, command(0, 0, await version(), randomUUID()));
  await hardExpiryRace('session', sessions[0], room, actors, command(0, 0, await version(), randomUUID()));

  // Account suspension commits while the command is waiting on the actor lock.
  const suspension = sql(`begin; update public.profiles set status='inactive' where id=${literal(actors[1])};
    select pg_advisory_xact_lock(330,1); select pg_sleep(1); commit;`);
  await barrier(1);
  const denied = await sql(command(1, 0, await version(), randomUUID()));
  assert(!(await suspension).error && denied.error === 'CANDLE_ACCESS_REQUIRED', 'concurrent suspension cannot be bypassed');
  assert(await count() === '7', 'suspension denial leaves count unchanged');

  // A deleted session must also prevent replay of an already successful command.
  const revoke = sql(`begin; delete from auth.sessions where id=${literal(sessions[0])};
    select pg_advisory_xact_lock(330,2); select pg_sleep(1); commit;`);
  await barrier(2);
  const revokedReplay = await sql(command(0, 7, v, key));
  assert(!(await revoke).error && revokedReplay.error === 'SESSION_REVOKED', 'concurrent revocation prevents receipt replay');
  console.log('Room candle concurrency PASS: CAS add/reduce/reset, receipt replay/hash conflict, suspension, session revocation and actual room/session lock hard-expiry denials with unchanged ledgers.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await testRoomCandleConcurrency();
