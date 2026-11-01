import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { assignmentMemoLocalConnection, closeAssignmentMemoConnections } from './test-assignment-instruction-concurrency.mjs';

// Prepared for the separately approved final DB run only. Import is inert.
// Reuse the reservation fixture stack and its reset window; no extra reset.
export const roomFixedMemoLimits = Object.freeze({ workMs: 60000, cleanupMs: 10000, barrierMs: 3000 });
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export function roomFixedMemoCommand({ actor, session, room, version, memo, key }) {
  assert([actor, session, room].every(uuid), 'FIXED_MEMO_IDENTITY_REQUIRED');
  assert(Number.isSafeInteger(version) && version >= 0 && version < Number.MAX_SAFE_INTEGER, 'FIXED_MEMO_VERSION_REQUIRED');
  assert(memo === null || typeof memo === 'string', 'FIXED_MEMO_TEXT_REQUIRED');
  assert(typeof key === 'string' && /^memo551-[a-z0-9-]{1,80}$/.test(key), 'FIXED_MEMO_KEY_REQUIRED');
  // Synthetic request identity, not the HTTP hash codec. Session/key excluded;
  // a different memo/version/room changes the logical request identity.
  const hash = createHash('sha256').update(JSON.stringify([actor, room, version, memo])).digest('hex');
  return { text: `select public.set_room_fixed_memo($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::text,$6::text,$7::text) as result`,
    values: [actor, session, room, version, memo, key, hash], actor, key, hash, room };
}

export async function observeRoomFixedMemoLock(probe, firstPid, secondPid, {
  now = Date.now, pause = ms => new Promise(resolve => setTimeout(resolve, ms)),
  barrierMs = roomFixedMemoLimits.barrierMs,
} = {}) {
  assert(Number.isSafeInteger(firstPid) && firstPid > 0 && Number.isSafeInteger(secondPid)
    && secondPid > 0 && firstPid !== secondPid, 'FIXED_MEMO_DISTINCT_SESSIONS_REQUIRED');
  const deadline = now() + barrierMs;
  while (now() < deadline) {
    if (await probe(firstPid, secondPid) === true) return;
    await pause(20);
  }
  throw new Error('FIXED_MEMO_CONTENDER_LOCK_NOT_OBSERVED');
}

export function assertRoomFixedMemoRace(first, second, expected, committed) {
  assert(first?.ok === true && first.value?.roomId === committed.room && first.value.version === committed.version
    && Object.hasOwn(first.value, 'memo') && first.value.memo === committed.memo
    && typeof first.value.updatedAt === 'string', 'FIXED_MEMO_FIRST_RESULT_INVALID');
  if (expected === 'replay') {
    assert(second?.ok === true, 'FIXED_MEMO_REPLAY_FAILED');
    assert.deepEqual(second.value, first.value, 'FIXED_MEMO_REPLAY_CHANGED_RESULT');
  } else {
    const required = { cas: ['40001', 'STALE_VERSION'], key: ['23505', 'IDEMPOTENCY_KEY_REUSED'],
      revoked: ['42501', 'SESSION_REVOKED'] }[expected];
    assert(required && second?.ok === false && second.code === required[0] && second.error === required[1],
      'FIXED_MEMO_LOSER_MUST_BE_EXACT_DOMAIN_CONFLICT');
  }
}

// A timeout blocks all subsequent queries and closes owned sockets. Cleanup
// failure is never hidden by either successful work or an earlier work failure.
export async function withRoomFixedMemoCleanup(work, cleanup, limits = roomFixedMemoLimits) {
  const signal = { stopped: false };
  let workTimer, cleanupTimer, failure;
  try {
    await Promise.race([work(signal), new Promise((_, reject) => {
      workTimer = setTimeout(() => { signal.stopped = true; reject(new Error('FIXED_MEMO_WORK_TIMEOUT')); }, limits.workMs);
    })]);
  } catch (error) { failure = error; } finally {
    signal.stopped = true; clearTimeout(workTimer);
    try {
      await Promise.race([cleanup(), new Promise((_, reject) => {
        cleanupTimer = setTimeout(() => reject(new Error('FIXED_MEMO_CLEANUP_TIMEOUT')), limits.cleanupMs);
      })]);
    } catch (error) {
      failure = failure ? new AggregateError([failure, error], 'FIXED_MEMO_WORK_AND_CLEANUP_FAILED') : error;
    } finally { clearTimeout(cleanupTimer); }
  }
  if (failure) throw failure;
}

export async function testRoomFixedMemoConcurrency(connectionString, actor) {
  const config = { ...assignmentMemoLocalConnection(connectionString), application_name: 'room_fixed_memo551_fixture' };
  assert(uuid(actor), 'FIXED_MEMO_ADMIN_REQUIRED');
  const entries = Array.from({ length: 3 }, () => ({ client: new Client(config), connected: false, busy: false, failed: false }));
  for (const entry of entries) entry.client.on('error', () => { entry.failed = true; });
  const [observer, first, second] = entries;
  await withRoomFixedMemoCleanup(async signal => {
    const query = async (entry, text, values = []) => {
      assert(!signal.stopped && !entry.failed && !entry.busy, 'FIXED_MEMO_WORK_STOPPED');
      entry.busy = true;
      try { return await entry.client.query(text, values); } finally { entry.busy = false; }
    };
    await Promise.all(entries.map(async entry => { await entry.client.connect(); entry.connected = true; }));
    const identities = await Promise.all(entries.map(entry => query(entry, 'select pg_backend_pid() as pid,current_database() as database')));
    const pids = identities.map(result => result.rows[0]?.pid);
    assert(new Set(pids).size === 3 && pids.every(pid => Number.isSafeInteger(pid) && pid > 0)
      && identities.every(result => result.rows[0].database === 'postgres'), 'FIXED_MEMO_DISTINCT_LOCAL_DATABASE_SESSIONS');
    const admin = (await query(observer, "select auth_user_id from public.profiles where id=$1 and role='admin' and status='active' and not must_change_password", [actor])).rows;
    assert(admin.length === 1 && uuid(admin[0].auth_user_id), 'FIXED_MEMO_EXISTING_ADMIN_REQUIRED');
    const otherActor = randomUUID(), otherUser = randomUUID(), otherSession = randomUUID();
    await query(observer, 'begin');
    await query(observer, 'insert into auth.users(id) values($1)', [otherUser]);
    await query(observer, `insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,
      login_id,login_id_normalized,login_sequence,role,status,must_change_password)
      values($1,$2,$3,$3,$3,$3,0,'admin','active',false)`, [otherActor, otherUser, `memo551-${otherActor}`]);
    await query(observer, `insert into auth.sessions(id,user_id,created_at,updated_at,not_after)
      values($1,$2,clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 hour')`, [otherSession, otherUser]);
    await query(observer, 'commit');
    let serial = 0;
    async function fixture() {
      const room = randomUUID(), session = randomUUID();
      await query(observer, 'begin');
      const rooms = await query(observer, `insert into public.rooms(id,room_number,room_type_id,elevator_zone,data_status)
        select $1,$2,id,'A','verified' from public.room_types where code='standard' and active returning id`,
      [room, `999551${String(++serial).padStart(2, '0')}`]);
      assert(rooms.rowCount === 1, 'FIXED_MEMO_SYNTHETIC_ROOM_REQUIRED');
      await query(observer, `insert into auth.sessions(id,user_id,created_at,updated_at,not_after)
        values($1,$2,clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 hour')`, [session, admin[0].auth_user_id]);
      await query(observer, 'commit');
      return { actor, session, room, version: 0, memo: '매주 화요일 청소', key: `memo551-${randomUUID()}` };
    }
    const call = async (entry, command) => {
      try { return { ok: true, value: (await query(entry, command.text, command.values)).rows[0].result }; }
      catch (error) {
        const known = { '40001': 'STALE_VERSION', '23505': 'IDEMPOTENCY_KEY_REUSED', '42501': 'SESSION_REVOKED' }[error.code];
        // Never include raw PostgreSQL details, connection strings, or values.
        return { ok: false, code: known && known === error.message ? error.code : 'UNEXPECTED',
          error: known && known === error.message ? known : 'UNEXPECTED_DATABASE_ERROR' };
      }
    };
    const beginService = async entry => { await query(entry, 'begin'); await query(entry, 'set local role service_role'); };
    const observe = () => observeRoomFixedMemoLock(async (blocker, waiter) => (
      await query(observer, `select exists(select 1 from pg_stat_activity where pid=$1 and state='active'
        and wait_event_type='Lock' and $2=any(pg_blocking_pids(pid))) as blocked`, [waiter, blocker])
    ).rows[0].blocked, pids[1], pids[2]);
    async function effects(f, commands, memos) {
      const rows = (await query(observer, `select revision,memo from private.room_fixed_memo_revisions where room_id=$1 order by revision`, [f.room])).rows;
      const count = memos.length;
      assert.deepEqual(rows, memos.map((memo, index) => ({ revision: String(index + 1), memo })), 'FIXED_MEMO_COMMITTED_HISTORY');
      const result = (await query(observer, `select
        (select count(*) from private.command_executions where actor_profile_id=any($1::uuid[]) and command_type='room.fixed_memo.set'
          and idempotency_key=any($3::text[]))::integer as receipts,
        (select count(*) from public.audit_events where entity_id=$2 and event_type='room.fixed_memo_changed')::integer as audits,
        (select count(*) from public.audit_events where entity_id=$2
          and (coalesce(before_state::text,'')||coalesce(after_state::text,'')) ~ '화요일|수건')::integer as leaked,
        (select count(*) from public.cleaning_targets where room_id=$2)::integer as targets`,
      [[...new Set(commands.map(command => command.actor))], f.room, [...new Set(commands.map(command => command.key))]])).rows[0];
      assert.deepEqual(result, { receipts: count, audits: count, leaked: 0, targets: 0 }, 'FIXED_MEMO_EXACT_ATOMIC_EFFECTS');
    }
    for (const expected of ['cas', 'replay', 'key', 'revoked']) {
      const f = await fixture();
      const left = roomFixedMemoCommand(f);
      const right = roomFixedMemoCommand({ ...f, key: expected === 'cas' ? `memo551-${randomUUID()}` : f.key,
        ...(expected === 'cas' ? { actor: otherActor, session: otherSession } : {}),
        memo: ['cas', 'key'].includes(expected) ? '수건 2개' : f.memo });
      await beginService(first);
      const firstResult = await call(first, left);
      assert(firstResult.ok, 'FIXED_MEMO_FIRST_COMMAND_FAILED');
      await beginService(second);
      const pending = call(second, right);
      await observe();
      if (expected === 'revoked') {
        const removed = await query(observer, 'delete from auth.sessions where id=$1 and user_id=$2', [f.session, admin[0].auth_user_id]);
        assert.equal(removed.rowCount, 1, 'FIXED_MEMO_OWN_SESSION_REVOKED');
      }
      await query(first, 'commit');
      const secondResult = await pending;
      await query(second, secondResult.ok ? 'commit' : 'rollback');
      assertRoomFixedMemoRace(firstResult, secondResult, expected, { room: f.room, version: 1, memo: f.memo });
      await effects(f, [left, right], [f.memo]);
    }
    // Both winning orders preserve the immutable prior text and prevent stale
    // clearing/editing from overriding the new committed revision.
    for (const clearFirst of [true, false]) {
      const f = await fixture(), seed = roomFixedMemoCommand(f);
      await beginService(first);
      assert((await call(first, seed)).ok, 'FIXED_MEMO_HISTORY_SEED_FAILED');
      await query(first, 'commit');
      const memo = clearFirst ? null : '수건 2개';
      const left = roomFixedMemoCommand({ ...f, version: 1, memo, key: `memo551-${randomUUID()}` });
      const right = roomFixedMemoCommand({ ...f, actor: otherActor, session: otherSession,
        version: 1, memo: clearFirst ? '수건 2개' : null, key: `memo551-${randomUUID()}` });
      await beginService(first);
      const firstResult = await call(first, left);
      assert(firstResult.ok, 'FIXED_MEMO_FIRST_COMMAND_FAILED');
      await beginService(second);
      const pending = call(second, right);
      await observe();
      await query(first, 'commit');
      const secondResult = await pending;
      await query(second, secondResult.ok ? 'commit' : 'rollback');
      assertRoomFixedMemoRace(firstResult, secondResult, 'cas', { room: f.room, version: 2, memo });
      await effects(f, [seed, left, right], [f.memo, memo]);
    }
    // The contender has passed its initial authority checks before it waits on
    // our room lock. Changing only its owned fixture session must prevent all
    // memo/audit/receipt effects after the lock is released.
    for (const change of ['expired', 'revoked']) {
      const f = await fixture(), command = roomFixedMemoCommand(f);
      await query(first, 'begin');
      await query(first, 'select id from public.rooms where id=$1 for update', [f.room]);
      await beginService(second);
      const pending = call(second, command);
      await observe();
      const altered = change === 'expired'
        ? await query(observer, "update auth.sessions set not_after=clock_timestamp()-interval '1 second' where id=$1 and user_id=$2", [f.session, admin[0].auth_user_id])
        : await query(observer, 'delete from auth.sessions where id=$1 and user_id=$2', [f.session, admin[0].auth_user_id]);
      assert.equal(altered.rowCount, 1, 'FIXED_MEMO_OWN_SESSION_CHANGED');
      await query(first, 'commit');
      const result = await pending;
      await query(second, 'rollback');
      assert.deepEqual(result, { ok: false, code: '42501', error: 'SESSION_REVOKED' }, 'FIXED_MEMO_POST_WAIT_AUTHORITY_REQUIRED');
      await effects(f, [command], []);
    }
  }, () => closeAssignmentMemoConnections(entries));
  console.log('Room fixed memo races PASS: eight observed two-session lock races; two-admin CAS, replay/key conflict, clear/edit history and post-wait session expiry/revocation; reset +0.');
}
