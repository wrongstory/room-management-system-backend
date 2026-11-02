import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Client } from 'pg';

// Preparation only until the final DB run is separately approved. This module
// reuses the reservation runner's disposable stack and reset window (reset +0).
// Importing it never connects. All text/identities below are synthetic fixtures.
export const assignmentMemoLimits = Object.freeze({ workMs: 75000, cleanupMs: 10000,
  connectMs: 3000, queryMs: 7000, statementMs: 5000, lockMs: 4000, idleMs: 15000, barrierMs: 3000 });
const validUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export function assignmentMemoLocalConnection(value) {
  assert.equal(typeof value, 'string', 'MEMO_LOCAL_URL_REQUIRED');
  let url, username, password;
  try {
    url = new URL(value);
    username = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    // Node URL errors retain the original input, which may contain a credential.
    throw new Error('MEMO_LOCAL_TARGET_REQUIRED');
  }
  assert(['postgres:', 'postgresql:'].includes(url.protocol)
    && ['127.0.0.1', 'localhost'].includes(url.hostname) && url.port === '54322'
    && url.pathname === '/postgres' && username === 'postgres'
    && password.length > 0 && !url.search && !url.hash, 'MEMO_LOCAL_TARGET_REQUIRED');
  // No fallback to PGHOST/PGDATABASE, CLI discovery, or remote URLs.
  return { host: url.hostname, port: 54322, database: 'postgres', user: 'postgres',
    password, ssl: false, connectionTimeoutMillis: assignmentMemoLimits.connectMs,
    query_timeout: assignmentMemoLimits.queryMs, statement_timeout: assignmentMemoLimits.statementMs,
    lock_timeout: assignmentMemoLimits.lockMs, idle_in_transaction_session_timeout: assignmentMemoLimits.idleMs,
    application_name: 'assignment_memo534_fixture' };
}

export function assignmentMemoCommand(input) {
  const { kind, actor, target, maid, assignment, version, sequence, day, key } = input;
  assert(['draft', 'prestart', 'plan'].includes(kind), 'MEMO_COMMAND_KIND');
  assert([actor, target, maid].every(validUuid) && (kind === 'draft' || validUuid(assignment)), 'MEMO_COMMAND_IDENTITY');
  assert(Number.isSafeInteger(version) && version > 0 && Number.isSafeInteger(sequence) && sequence > 0, 'MEMO_COMMAND_VERSION');
  assert(typeof key === 'string' && /^memo534-[a-z0-9-]{1,80}$/.test(key), 'MEMO_COMMAND_KEY');
  assert(typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day), 'MEMO_COMMAND_DAY');
  const explicit = Object.hasOwn(input, 'memo');
  assert(!explicit || input.memo === null || typeof input.memo === 'string', 'MEMO_COMMAND_TEXT');
  const base = { draft: 'save_cleaning_assignment_draft', prestart: 'change_cleaning_assignment_prestart',
    plan: 'change_cleaning_assignment_for_plan' }[kind];
  const rpc = base + (explicit ? '_with_instruction' : '');
  const args = [['p_actor_profile_id', 'uuid', actor], ['p_cleaning_target_id', 'uuid', target]];
  if (kind !== 'draft') args.push(['p_expected_current_assignment_id', 'uuid', assignment]);
  args.push(['p_expected_assignment_version', 'bigint', version], ['p_maid_profile_id', 'uuid', maid],
    ['p_sequence_number', 'integer', sequence]);
  if (kind !== 'draft') args.push(['p_reason_code', 'text', 'OPERATIONAL_CHANGE'],
    ['p_available_from', 'timestamptz', null], ['p_due_at', 'timestamptz', null]);
  if (kind === 'plan') args.push(['p_service_date', 'date', day]);
  if (explicit) args.push(['p_instruction_memo', 'text', input.memo]);
  // A synthetic request hash, not an assertion that this is the HTTP hash codec.
  // Equal payloads share it; changing the memo changes it; keys are excluded.
  const hash = createHash('sha256').update(JSON.stringify([rpc, args])).digest('hex');
  args.push(['p_idempotency_key', 'text', key], ['p_request_hash', 'text', hash]);
  return { text: `select public.${rpc}(${args.map(([name, type], i) => `${name} => $${i + 1}::${type}`).join(',')}) as result`,
    values: args.map(([, , value]) => value), key, hash, target,
    commandName: kind === 'draft' ? 'assignment.save_draft' : 'assignment.prestart_change' };
}

export function assertAssignmentMemoRace(result, expected) {
  assert(result.observedBlocking === true && Number.isSafeInteger(result.firstPid) && result.firstPid > 0
    && Number.isSafeInteger(result.secondPid) && result.secondPid > 0
    && result.firstPid !== result.secondPid, 'MEMO_REAL_TWO_SESSION_BARRIER_REQUIRED');
  assert(result.first?.ok === true && validUuid(result.first.value?.assignmentId)
    && Object.hasOwn(result.first.value, 'instructionMemo'), 'MEMO_FIRST_COMMAND_FAILED');
  if (expected === 'replay') {
    assert(result.second?.ok === true && JSON.stringify(result.first.value) === JSON.stringify(result.second.value), 'MEMO_REPLAY_MISMATCH');
  } else {
    const code = expected === 'cas' ? 'ASSIGNMENT_VERSION_CONFLICT' : expected === 'key' ? 'IDEMPOTENCY_KEY_REUSED' : null;
    assert(code && result.second?.ok === false && result.second.error === code, 'MEMO_LOSER_MUST_BE_EXACT_DOMAIN_CONFLICT');
  }
}

export function assertAssignmentMemoHistory(rows, expectedMemos) {
  assert(Array.isArray(rows) && rows.length === expectedMemos.length && rows.length > 0, 'MEMO_REVISION_COUNT');
  assert(new Set(rows.map(row => row.id)).size === rows.length && rows.every((row, index) => validUuid(row.id)
    && Number(row.revision) === index + 2 && row.instruction_memo === expectedMemos[index]
    && row.is_current === (index === rows.length - 1)), 'MEMO_IMMUTABLE_REVISION_HISTORY');
}

export function assertAssignmentMemoResponse(response, expected) {
  assert(response && validUuid(expected.assignment) && validUuid(expected.target)
    && Number.isSafeInteger(expected.version) && expected.version > 0 && response.assignmentId === expected.assignment
    && response.cleaningTargetId === expected.target && response.revision === expected.version
    && response.targetAssignmentVersion === expected.version && Object.hasOwn(response, 'instructionMemo')
    && response.instructionMemo === expected.memo, 'MEMO_RESPONSE_DOES_NOT_MATCH_COMMITTED_REVISION');
}

// Cleanup rejection remains a failure even when the race itself succeeded.
export async function closeAssignmentMemoConnections(connections) {
  const results = await Promise.allSettled(connections.map(async entry => {
    const errors = [];
    try {
      if (entry.connected && !entry.busy && !entry.failed) await entry.client.query('rollback');
    } catch (error) { errors.push(error); }
    try {
      // pg Client.end destroys its own active non-pipelined connection, so a
      // pending SQL transaction cannot outlive a JS-only timeout indefinitely.
      await entry.client.end();
    } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'MEMO_OWNED_CONNECTION_CLOSE_FAILED');
  }));
  const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
  if (failures.length) throw new AggregateError(failures, 'MEMO_CONNECTION_CLEANUP_FAILED');
}

export async function testAssignmentInstructionConcurrency(connectionString, actor) {
  const config = assignmentMemoLocalConnection(connectionString);
  assert(validUuid(actor), 'MEMO_ACTOR_REQUIRED');
  const entries = Array.from({ length: 3 }, () => ({ client: new Client(config), connected: false, busy: false, failed: false }));
  let stopped = false;
  const query = async (entry, text, values = []) => {
    assert(!stopped && !entry.failed, 'MEMO_WORK_STOPPED');
    entry.busy = true;
    try { return await entry.client.query(text, values); } finally { entry.busy = false; }
  };
  for (const entry of entries) entry.client.on('error', () => { entry.failed = true; });
  const [observer, first, second] = entries;
  const run = async () => {
    await Promise.all(entries.map(async entry => { await entry.client.connect(); entry.connected = true; }));
    const identities = await Promise.all(entries.map(entry => query(entry, 'select pg_backend_pid() as pid, current_database() as database')));
    const pids = identities.map(value => value.rows[0]?.pid);
    assert(new Set(pids).size === 3 && pids.every(pid => Number.isSafeInteger(pid) && pid > 0)
      && identities.every(value => value.rows[0].database === 'postgres'), 'MEMO_DISTINCT_LOCAL_DATABASE_SESSIONS');
    assert((await query(observer, "select count(*)::integer as n from public.profiles where id=$1 and role='admin' and status='active' and not must_change_password", [actor])).rows[0].n === 1, 'MEMO_EXISTING_ADMIN_REQUIRED');
    const day = (await query(observer, "select (clock_timestamp() at time zone 'Asia/Seoul')::date::text as day")).rows[0].day;
    const maid = randomUUID(), user = randomUUID(), availability = randomUUID();
    await query(observer, 'begin');
    await query(observer, 'insert into auth.users(id) values($1)', [user]);
    await query(observer, `insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
      login_sequence,role,status,must_change_password) values($1,$2,$3,$3,$3,$3,0,'maid','active',false)`, [maid, user, `memo534-${maid}`]);
    await query(observer, `insert into public.availability_versions(id,maid_profile_id,week_start,version,submitted_at)
      values($1,$2,$3::date-(extract(isodow from $3::date)::integer-1),1,clock_timestamp())`, [availability, maid, day]);
    await query(observer, `insert into public.availability_days(availability_version_id,work_date,available)
      select id,week_start+n,true from public.availability_versions cross join generate_series(0,6) n where id=$1`, [availability]);
    await query(observer, 'commit');
    let sequence = 0;
    async function fixture(kind) {
      const target = randomUUID(), room = randomUUID(), assignment = randomUUID();
      const n = ++sequence;
      await query(observer, 'begin');
      const inserted = await query(observer, `insert into public.rooms(id,room_number,room_type_id,elevator_zone,data_status)
        select $1,$2,id,'A','verified' from public.room_types where code='standard' and active returning id`, [room, `999534${String(n).padStart(2, '0')}`]);
      assert(inserted.rowCount === 1, 'MEMO_SYNTHETIC_ROOM_REQUIRED');
      await query(observer, `insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,effective_service_date,
        available_from,due_at,status,assignment_version,room_type_snapshot,fee_snapshot,template_snapshot,created_by)
        values($1,$2,'additional','manual_room_request',$3,$4,$4,$4::date::timestamp at time zone 'Asia/Seoul',
        (($4::date+1)::timestamp at time zone 'Asia/Seoul')-interval '1 second',$5,$6,'{}',10000,'{}',$7)`,
      [target, room, `memo534-${target}`, day, kind === 'draft' ? 'unassigned' : 'notified', kind === 'draft' ? 1 : 2, actor]);
      if (kind !== 'draft') await query(observer, `insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,
        sequence_number,revision,notified_at,changed_by,instruction_memo) values($1,$2,$3,$4,2,clock_timestamp(),$5,'수건 1개')`,
      [assignment, target, maid, n, actor]);
      await query(observer, 'commit');
      return { kind, actor, target, maid, assignment, version: kind === 'draft' ? 1 : 2, sequence: n, day };
    }
    const call = async (entry, command) => {
      try { return { ok: true, value: (await query(entry, command.text, command.values)).rows[0].result }; }
      catch (error) {
        const expected = { '40001': 'ASSIGNMENT_VERSION_CONFLICT', '23505': 'IDEMPOTENCY_KEY_REUSED' }[error.code];
        return { ok: false, error: expected && error.message === expected ? expected : 'UNEXPECTED_DATABASE_ERROR' };
      }
    };
    const followup = async command => {
      await query(first, 'begin'); await query(first, 'set local role service_role');
      const result = await call(first, command);
      await query(first, result.ok ? 'commit' : 'rollback');
      return result;
    };
    async function race(left, right, expected) {
      await query(first, 'begin'); await query(first, 'set local role service_role');
      const firstResult = await call(first, left);
      assert(firstResult.ok, 'MEMO_FIRST_COMMAND_FAILED');
      await query(second, 'begin'); await query(second, 'set local role service_role');
      const pending = call(second, right);
      let observedBlocking = false;
      const deadline = Date.now() + assignmentMemoLimits.barrierMs;
      while (!observedBlocking && Date.now() < deadline) {
        observedBlocking = (await query(observer, `select exists(select 1 from pg_stat_activity
          where pid=$1 and state='active' and wait_event_type='Lock' and $2=any(pg_blocking_pids(pid))) as blocked`, [pids[2], pids[1]])).rows[0].blocked;
        if (!observedBlocking) await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert(observedBlocking, 'MEMO_CONTENDER_LOCK_NOT_OBSERVED');
      await query(first, 'commit');
      const secondResult = await pending;
      await query(second, secondResult.ok ? 'commit' : 'rollback');
      const result = { first: firstResult, second: secondResult, observedBlocking, firstPid: pids[1], secondPid: pids[2] };
      assertAssignmentMemoRace(result, expected);
      const receipts = await query(observer, `select count(*)::integer as n from private.command_executions
        where actor_profile_id=$1 and command_type=$2 and idempotency_key=any($3::text[])`, [actor, left.commandName, [...new Set([left.key, right.key])]]);
      assert(receipts.rows[0].n === 1, 'MEMO_EXACTLY_ONE_RECEIPT');
      const audits = await query(observer, `select count(*)::integer as n from public.audit_events
        where event_type=$1 and entity_id in(select id from public.cleaning_assignments where cleaning_target_id=$2)`,
      [left.commandName === 'assignment.save_draft' ? 'assignment.draft_saved' : 'assignment.prestart_changed', left.target]);
      assert(audits.rows[0].n === 1, 'MEMO_EXACTLY_ONE_COMMAND_AUDIT');
      return result;
    }
    async function history(f, memos) {
      const rows = (await query(observer, 'select id,revision,instruction_memo,is_current from public.cleaning_assignments where cleaning_target_id=$1 order by revision', [f.target])).rows;
      assertAssignmentMemoHistory(rows, memos);
      assert((await query(observer, 'select assignment_version from public.cleaning_targets where id=$1', [f.target])).rows[0].assignment_version === String(memos.length + 1), 'MEMO_TARGET_VERSION_MATCH');
      return { ...f, assignment: rows.at(-1).id, version: Number(rows.at(-1).revision) };
    }
    const cases = [
      ['draft', 'cas'], ['draft', 'replay'], ['draft', 'key'],
      ['prestart', 'cas'], ['prestart', 'replay'], ['prestart', 'key'],
      ['plan', 'cas'], ['plan', 'key'],
    ];
    for (const [kind, expected] of cases) {
      const f = await fixture(kind), key = `memo534-${randomUUID()}`;
      const left = assignmentMemoCommand({ ...f, key, memo: '수건 2개' });
      const right = assignmentMemoCommand({ ...f, key: expected === 'cas' ? `memo534-${randomUUID()}` : key,
        memo: expected === 'replay' ? '수건 2개' : '물캡슐 3개' });
      const result = await race(left, right, expected);
      const current = await history(f, kind === 'draft' ? ['수건 2개'] : ['수건 1개', '수건 2개']);
      assertAssignmentMemoResponse(result.first.value, { ...current, memo: '수건 2개' });
      if (expected === 'replay') assertAssignmentMemoResponse(result.second.value, { ...current, memo: '수건 2개' });
    }
    // Observe both orders: explicit clear must not resurrect old text, and an
    // omitted stale write must not silently overwrite the winner's revision.
    for (const clearFirst of [true, false]) {
      const f = await fixture('prestart');
      const clear = assignmentMemoCommand({ ...f, key: `memo534-${randomUUID()}`, memo: null });
      const omitted = assignmentMemoCommand({ ...f, key: `memo534-${randomUUID()}` });
      const result = await race(clearFirst ? clear : omitted, clearFirst ? omitted : clear, 'cas');
      const values = ['수건 1개', clearFirst ? null : '수건 1개'];
      let current = await history(f, values);
      assertAssignmentMemoResponse(result.first.value, { ...current, memo: clearFirst ? null : '수건 1개' });
      if (!clearFirst) {
        const cleared = await followup(assignmentMemoCommand({ ...current, key: `memo534-${randomUUID()}`, memo: null }));
        assert(cleared.ok, 'MEMO_FRESH_CLEAR_FAILED'); values.push(null); current = await history(f, values);
        assertAssignmentMemoResponse(cleared.value, { ...current, memo: null });
      }
      const inherited = await followup(assignmentMemoCommand({ ...current, key: `memo534-${randomUUID()}` }));
      assert(inherited.ok, 'MEMO_LEGACY_INHERIT_FAILED'); values.push(null); current = await history(f, values);
      assertAssignmentMemoResponse(inherited.value, { ...current, memo: null });
    }
    const safety = (await query(observer, `select
      (select count(*) from public.earnings where maid_profile_id=$1)::integer as earnings,
      (select count(*) from public.audit_events where entity_id in(select id from public.cleaning_assignments where maid_profile_id=$1) and
        (coalesce(before_state::text,'')||coalesce(after_state::text,'')) ~ '수건 [12]개|물캡슐 3개')::integer as audits,
      (select count(*) from public.notifications where recipient_profile_id=$1 and (body||title) ~ '수건 [12]개|물캡슐 3개')::integer as notices`, [maid])).rows[0];
    assert(safety.earnings === 0 && safety.audits === 0 && safety.notices === 0, 'MEMO_TEXT_OR_EARNING_SIDE_EFFECT');
  };
  let workTimer, cleanupTimer, failure;
  try {
    await Promise.race([run(), new Promise((_, reject) => {
      workTimer = setTimeout(() => { stopped = true; reject(new Error('MEMO_MODULE_DEADLINE')); }, assignmentMemoLimits.workMs);
    })]);
  } catch (error) { failure = error; } finally {
    stopped = true; clearTimeout(workTimer);
    try {
      await Promise.race([closeAssignmentMemoConnections(entries), new Promise((_, reject) => {
        cleanupTimer = setTimeout(() => reject(new Error('MEMO_CONNECTION_CLEANUP_TIMEOUT')), assignmentMemoLimits.cleanupMs);
      })]);
    } catch (error) {
      failure = failure ? new AggregateError([failure, error], 'MEMO_WORK_AND_CLEANUP_FAILED') : error;
    } finally { clearTimeout(cleanupTimer); }
  }
  if (failure) throw failure;
  console.log('Assignment instruction races PASS: ten observed two-session lock races; immutable memo revisions, exact replay/CAS, clear/inherit; reset +0.');
}
