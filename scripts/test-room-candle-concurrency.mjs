import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const run = promisify(execFile);
const container = 'supabase_db_room-management-system-backend';
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
function assert(value, label) { if (!value) throw new Error(label); }
async function sql(query) {
  try {
    const { stdout } = await run('docker', ['exec', container, 'psql', '-XqAt', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', query], { timeout: 15000, maxBuffer: 1024 * 1024 });
    return { value: stdout.trim(), error: null };
  } catch (error) {
    return { value: '', error: /ERROR:\s+([A-Z][A-Z_]+)/.exec(error.stderr ?? '')?.[1] ?? 'DATABASE_TEST_FAILED' };
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
  console.log('Room candle concurrency PASS: CAS add/reduce/reset, receipt replay/hash conflict, suspension and session revocation.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await testRoomCandleConcurrency();
