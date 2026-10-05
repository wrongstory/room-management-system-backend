import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';

function assert(value, message) { if (!value) throw new Error(message); }
function ok(result, label) {
  if (result.error) throw new Error(`${label} failed (${String(result.error.code ?? 'DB_ERROR')})`);
  return result.data;
}

const clockSpans = { execution: '2 hours', metadata: '90 days' };
function clockSpan(horizon) {
  assert(Object.hasOwn(clockSpans, horizon), 'fixed offline clock horizon');
  return clockSpans[horizon];
}
function fixtureUuid(value) {
  assert(typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value), 'fixed offline fixture UUID');
  return value;
}

// Preparation may take longer than the crossing window. It must complete before
// the private start statement selects its DB clock; an issued lease is never moved.
export async function prepareAndStartOfflineFixture(prepare, start) {
  const prepared = await prepare();
  return start(prepared);
}
export function offlineFixtureInputClockSQL(horizon) {
  return `select to_json(clock_timestamp()-interval '${clockSpan(horizon)}');`;
}
export function offlineFixtureStartSQL(input, horizon) {
  const values = ['p_actor_profile_id', 'p_session_id', 'p_attempt_id', 'p_expected_assignment_id', 'p_idempotency_key']
    .map((key) => fixtureUuid(input[key]));
  assert(input.p_expected_execution_version === 1 && input.p_expected_assignment_revision === 2
    && /^[0-9a-f]{64}$/.test(input.p_request_hash), 'fixed offline fixture start');
  return `with fixture_clock as materialized (select clock_timestamp() as at_time)
select private.start_attempt_with_lease_at('${values[0]}','${values[1]}','${values[2]}',1,'${values[3]}',2,
'${values[4]}','${input.p_request_hash}',fixture_clock.at_time-interval '${clockSpan(horizon)}'+interval '5 seconds')
from fixture_clock;`;
}
export function offlineClockProbeSQL(leaseId, horizon) {
  const column = horizon === 'execution' ? 'expires_at' : 'metadata_expires_at';
  clockSpan(horizon);
  return `with fixture_clock as materialized (select clock_timestamp() as at_time)
select jsonb_build_object('live',lease.${column}>fixture_clock.at_time,
'remainingMs',extract(epoch from (lease.${column}-fixture_clock.at_time))*1000)
from private.offline_work_leases lease cross join fixture_clock where lease.id='${fixtureUuid(leaseId)}';`;
}
export function offlineLockProbeSQL(rpcName, holderPid) {
  assert(/^[a-z_]+$/.test(rpcName) && Number.isSafeInteger(holderPid) && holderPid > 0, 'fixed offline lock filter');
  return `select exists(select 1 from pg_stat_activity where pid<>pg_backend_pid() and state='active'
and wait_event_type='Lock' and query like '%${rpcName}%' and ${holderPid}=any(pg_blocking_pids(pid)));`;
}
export function offlineLockReadyPid(output) {
  const marker = output.match(/LOCK_READY:(\d+)\r?\n/);
  const pid = marker ? Number(marker[1]) : null;
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

// Real local Auth/session/RPC races. Every credential, UUID and SQL result remains in memory.
export async function testAttemptOfflineConcurrency(client, { clockFixturePreparationDelayMs = 0 } = {}) {
  assert(['localhost', '127.0.0.1'].includes(new URL(client.supabaseUrl).hostname), 'offline races require local Supabase');
  assert(Number.isSafeInteger(clockFixturePreparationDelayMs) && clockFixturePreparationDelayMs >= 0
    && clockFixturePreparationDelayMs <= 10000, 'bounded offline clock fixture preparation delay');
  function sql(statement) {
    try {
      return execFileSync('docker', ['exec', '-i', 'supabase_db_room-management-system-backend', 'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], { input: statement, encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch { throw new Error('offline local SQL fixture/check failed (raw details redacted)'); }
  }
  async function holdLock(statement) {
    const child = spawn('docker', ['exec', '-i', 'supabase_db_room-management-system-backend', 'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = new Promise((resolve) => child.once('close', resolve));
    child.stderr.on('data', () => {});
    let backendPid;
    await new Promise((resolve, reject) => {
      let ready = false; let output = '';
      const timeout = setTimeout(() => { child.kill(); reject(new Error('offline lock setup timed out')); }, 10000);
      child.once('error', () => { clearTimeout(timeout); reject(new Error('offline lock setup failed')); });
      child.once('close', () => { if (!ready) { clearTimeout(timeout); reject(new Error('offline lock closed prematurely')); } });
      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
        const pid = offlineLockReadyPid(output);
        if (!ready && pid !== null) { backendPid = pid; ready = true; clearTimeout(timeout); output = ''; resolve(); }
      });
      child.stdin.write(`begin;set local statement_timeout='12s';set local idle_in_transaction_session_timeout='15s';${statement};select 'LOCK_READY:'||pg_backend_pid();\n`);
    });
    let promise;
    const release = (beforeCommit = '') => promise ??= (async () => {
      child.stdin.end(`${beforeCommit};commit;\n\\q\n`);
      assert(await closed === 0, 'offline lock released without deadlock');
    })();
    release.backendPid = backendPid;
    return release;
  }
  async function waitForLock(rpcName, holderPid) {
    for (let i = 0; i < 50; i += 1) {
      if (sql(offlineLockProbeSQL(rpcName, holderPid)) === 't') return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('offline RPC did not reach expected lock');
  }
  async function account(role) {
    const id = randomUUID(); const authId = randomUUID();
    const email = `offline-${authId}@test.invalid`; const password = `T:${randomUUID()}`;
    ok(await client.auth.admin.createUser({ id: authId, email, password, email_confirm: true }), 'offline Auth');
    ok(await client.from('profiles').insert({ id, auth_user_id: authId, display_name: `offline-${id}`, display_name_normalized: `offline-${id}`, login_id: `offline-${id}`, login_id_normalized: `offline-${id}`, login_sequence: 0, role, status: 'active', must_change_password: false }), 'offline profile');
    const loginClient = createClient(client.supabaseUrl, client.supabaseKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const signed = ok(await loginClient.auth.signInWithPassword({ email, password }), 'offline sign-in');
    return { id, sessionId: JSON.parse(Buffer.from(signed.session.access_token.split('.')[1], 'base64url').toString()).session_id };
  }
  const admin = await account('admin');
  const roomType = ok(await client.from('room_types').select('id').limit(1).single(), 'offline room type');
  let sequence = 0;
  async function prepareFixture(horizon) {
    const owner = await account('maid');
    const roomId = randomUUID(); const targetId = randomUUID(); const assignmentId = randomUUID(); const attemptId = randomUUID();
    // This historical clock supplies only the original business date/notice.
    // It is not the issued lease anchor. A KST midnight during setup preserves
    // the earlier service date; the current overdue-start contract permits it.
    const now = horizon ? new Date(JSON.parse(sql(offlineFixtureInputClockSQL(horizon)))) : new Date();
    const day = new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10);
    ok(await client.from('rooms').insert({ id: roomId, room_number: `${Date.now()}${++sequence}`, room_type_id: roomType.id, elevator_zone: 'A' }), 'offline room');
    ok(await client.from('cleaning_targets').insert({ id: targetId, room_id: roomId, cleaning_kind: 'additional', source: 'manual_room_request', source_key: `offline-${targetId}`, original_service_date: day, effective_service_date: day, available_from: `${day}T00:00:00+09:00`, due_at: `${day}T23:59:59+09:00`, status: 'notified', assignment_version: 2, room_type_snapshot: {}, template_snapshot: {}, fee_snapshot: 10000, created_by: admin.id }), 'offline target');
    ok(await client.from('cleaning_assignments').insert({ id: assignmentId, cleaning_target_id: targetId, maid_profile_id: owner.id, sequence_number: 1, revision: 2, notified_at: now.toISOString(), changed_by: admin.id }), 'offline assignment');
    ok(await client.from('cleaning_attempts').insert({ id: attemptId, cleaning_target_id: targetId, assignment_id: assignmentId, maid_profile_id: owner.id, attempt_number: 1, status: 'scheduled', assignment_revision: 2, room_snapshot: { roomId }, template_snapshot: {} }), 'offline attempt');
    if (horizon && clockFixturePreparationDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, clockFixturePreparationDelayMs));
    }
    return { owner, attemptId, assignmentId, targetId, day };
  }
  async function fixture(horizon = null) {
    return prepareAndStartOfflineFixture(() => prepareFixture(horizon), async (prepared) => {
      const { owner, attemptId, assignmentId, targetId, day } = prepared;
      const input = { p_actor_profile_id: owner.id, p_session_id: owner.sessionId, p_attempt_id: attemptId, p_expected_execution_version: 1, p_expected_assignment_id: assignmentId, p_expected_assignment_revision: 2, p_idempotency_key: randomUUID(), p_request_hash: 'd'.repeat(64) };
      const starts = horizon
        ? [{ data: JSON.parse(sql(offlineFixtureStartSQL(input, horizon))), error: null }]
        : await Promise.all([client.rpc('start_cleaning_attempt_with_lease', input), client.rpc('start_cleaning_attempt_with_lease', input)]);
      starts.forEach((result) => { ok(result, 'offline concurrent start'); });
      if (!horizon) assert(JSON.stringify(starts[0].data.lease) === JSON.stringify(starts[1].data.lease), 'start race must issue one lease with immutable expiry');
      assert(sql(`select count(*) from private.offline_work_leases where attempt_id='${attemptId}';`) === '1', 'exactly one lease per attempt');
      return { owner, attemptId, assignmentId, targetId, lease: starts[0].data.lease, day, startInput: input };
    });
  }
  function event(item, overrides = {}) {
    return { p_actor_profile_id: item.owner.id, p_session_id: item.owner.sessionId, p_lease_id: item.lease.leaseId, p_event_id: randomUUID(), p_expected_execution_version: 2, p_occurred_at: new Date().toISOString(), p_server_offset_ms: 0, ...overrides };
  }
  function resolve(id, resolution = 'record_only', key = randomUUID()) {
    return client.rpc('resolve_offline_event_quarantine', { p_actor_profile_id: admin.id, p_session_id: admin.sessionId, p_quarantine_id: id, p_resolution: resolution, p_expected_execution_version: resolution === 'correction_link' ? 2 : null, p_reason_code: resolution === 'correction_link' ? 'OFFLINE_CORRECTION_APPROVED' : resolution === 'reject_effect' ? 'OFFLINE_REJECT_EFFECT' : 'OFFLINE_RECORD_ONLY', p_idempotency_key: key, p_request_hash: (resolution === 'correction_link' ? 'f' : 'e').repeat(64) });
  }
  const applied = await fixture(); const sameEvent = event(applied);
  const duplicate = await Promise.all(Array.from({ length: 8 }, () => client.rpc('sync_cleaning_attempt_event', sameEvent)));
  duplicate.forEach((result) => { ok(result, 'same event race'); });
  assert(duplicate.every((result) => JSON.stringify(result.data) === JSON.stringify(duplicate[0].data)), 'same UUID returns original full response including receivedAt');
  assert(duplicate[0].data.outcome === 'applied', 'fresh completion applied');
  assert(sql(`select count(*) from private.offline_completion_events where lease_id='${applied.lease.leaseId}';`) === '1', 'one metadata row');
  const changed = await client.rpc('sync_cleaning_attempt_event', { ...sameEvent, p_server_offset_ms: 1 });
  assert(changed.error?.message === 'OFFLINE_EVENT_CONFLICT', 'same UUID changed payload conflicts');
  assert(sql(`select count(*) from public.audit_events where entity_id='${applied.attemptId}' and event_type='cleaning.field_completed';`) === '1', 'one completion audit');
  assert(sql(`select count(*) from private.command_executions where response_payload::text like '%${sameEvent.p_event_id}%' or idempotency_key='${sameEvent.p_event_id}';`) === '0', 'client event metadata never enters permanent receipt');

  const attacked = await fixture();
  const rotating = await Promise.all(Array.from({ length: 32 }, () => client.rpc('sync_cleaning_attempt_event', event(attacked))));
  assert(rotating.filter((result) => !result.error).length === 1 && rotating.filter((result) => result.error?.message === 'OFFLINE_EVENT_CONFLICT').length === 31, 'one lease rotating UUID race has bounded cardinality');
  assert(sql(`select count(*) from private.offline_completion_events where lease_id='${attacked.lease.leaseId}';`) === '1', 'rotating IDs cannot grow metadata');

  const quarantined = await fixture();
  const badClock = event(quarantined, { p_server_offset_ms: 300001 });
  const quarantineRace = await Promise.all([client.rpc('sync_cleaning_attempt_event', badClock), client.rpc('sync_cleaning_attempt_event', badClock)]);
  quarantineRace.forEach((result) => { ok(result, 'quarantine replay race'); });
  assert(quarantineRace[0].data.outcome === 'quarantined' && JSON.stringify(quarantineRace[0].data) === JSON.stringify(quarantineRace[1].data), 'quarantine has same first result');
  const quarantineId = quarantineRace[0].data.quarantineId;
  const resolutionKey = randomUUID();
  const resolutions = await Promise.all([resolve(quarantineId, 'record_only', resolutionKey), resolve(quarantineId, 'record_only', resolutionKey)]);
  resolutions.forEach((result) => { ok(result, 'resolution duplicate'); });
  assert(JSON.stringify(resolutions[0].data) === JSON.stringify(resolutions[1].data), 'same admin decision replays');
  assert(sql(`select count(*) from private.offline_event_resolutions where event_record_id='${quarantineId}';`) === '1', 'one immutable decision');

  // Valid normalized time but delayed receipt: local private clock helper creates the exact late fixture,
  // then real concurrent public corrections use the current active admin/session and current attempt CAS.
  const correction = await fixture(); const lateEvent = event(correction);
  const late = JSON.parse(sql(`select private.sync_attempt_event_at('${lateEvent.p_actor_profile_id}','${lateEvent.p_session_id}','${lateEvent.p_lease_id}','${lateEvent.p_event_id}',2,'${lateEvent.p_occurred_at}',0,'${correction.lease.expiresAt}'::timestamptz+interval '1 second');`));
  assert(late.outcome === 'quarantined' && late.reasonCode === 'LEASE_EXPIRED', 'known late fixture');
  const correctionKey = randomUUID();
  const corrected = await Promise.all([resolve(late.quarantineId, 'correction_link', correctionKey), resolve(late.quarantineId, 'correction_link', correctionKey)]);
  corrected.forEach((result) => { ok(result, 'correction duplicate'); });
  assert(JSON.stringify(corrected[0].data) === JSON.stringify(corrected[1].data), 'correction exactly-once result');
  assert(sql(`select count(*) from public.audit_events where entity_id='${correction.attemptId}' and event_type='cleaning.field_completed';`) === '1', 'one correction domain effect');

  for (let index = 0; index < 4; index += 1) {
    const raced = await fixture(); const input = event(raced);
    const online = () => client.rpc('complete_cleaning_attempt_field_work', { p_actor_profile_id: raced.owner.id, p_attempt_id: raced.attemptId, p_expected_execution_version: 2, p_expected_assignment_id: raced.assignmentId, p_expected_assignment_revision: 2, p_idempotency_key: randomUUID(), p_request_hash: 'a'.repeat(64) });
    const offline = () => client.rpc('sync_cleaning_attempt_event', input);
    const results = index % 2 === 0 ? await Promise.all([online(), offline()]) : (await Promise.all([offline(), online()])).reverse();
    assert(!results[0].error || ['ATTEMPT_VERSION_CONFLICT', 'ATTEMPT_INVALID_TRANSITION'].includes(results[0].error.message), 'online side has success or expected stale result');
    assert(!results[1].error || ['OFFLINE_EVENT_CONFLICT', 'ATTEMPT_VERSION_CONFLICT'].includes(results[1].error.message), 'sync versus online fails closed or quarantines');
    if (!results[1].error) assert(['applied', 'quarantined'].includes(results[1].data.outcome), 'offline side declares exact effect outcome');
    assert(sql(`select count(*) from public.audit_events where entity_id='${raced.attemptId}' and event_type='cleaning.field_completed';`) === '1', 'online versus offline exactly one logical completion');
  }
  // Cross 2h/90d during an actual target-row lock wait; server clocks must refresh after it.
  for (const horizon of ['execution', 'metadata']) {
    const item = await fixture(horizon);
    const readClock = () => JSON.parse(sql(offlineClockProbeSQL(item.lease.leaseId, horizon)));
    const initialClock = readClock();
    assert(initialClock.live && initialClock.remainingMs > 0 && initialClock.remainingMs <= 5000, 'clock fixture has not expired before request and remains bounded to five seconds');
    const immutableClock = () => sql(`select issued_at='${item.lease.issuedAt}'::timestamptz
and expires_at='${item.lease.expiresAt}'::timestamptz and metadata_expires_at='${item.lease.metadataExpiresAt}'::timestamptz
and expires_at=issued_at+interval '2 hours' and metadata_expires_at=issued_at+interval '90 days'
from private.offline_work_leases where id='${item.lease.leaseId}';`);
    assert(immutableClock() === 't', 'original issued lease clocks and TTL are unchanged');
    const release = await holdLock(`select id from public.cleaning_targets where id='${item.targetId}' for update`);
    const input = event(item, { p_occurred_at: new Date(Date.parse(item.lease.issuedAt) + 1000).toISOString() });
    const rpcName = horizon === 'execution' ? 'sync_cleaning_attempt_event' : 'start_cleaning_attempt_with_lease';
    const pending = Promise.resolve(client.rpc(rpcName, horizon === 'execution' ? input : item.startInput));
    try {
      await waitForLock(rpcName, release.backendPid);
      const blockedClock = readClock();
      assert(blockedClock.live && blockedClock.remainingMs > 0, 'actual public RPC reaches this fixture lock before expiry');
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, blockedClock.remainingMs + 100)));
      assert(sql(offlineLockProbeSQL(rpcName, release.backendPid)) === 't', 'same public RPC remains blocked on this fixture holder during expiry');
      assert(readClock().live === false, 'DB deadline is crossed while the public RPC is still blocked');
      assert(immutableClock() === 't', 'waiting never rewrites the original issued lease clocks');
      await release();
      const result = await pending;
      if (horizon === 'execution') {
        ok(result, 'expired after lock sync');
        assert(result.data.outcome === 'quarantined' && result.data.reasonCode === 'LEASE_EXPIRED', '2h crossing is late metadata, not completion');
      } else {
        assert(result.error?.message === 'OFFLINE_EVENT_EXPIRED', 'start replay cannot return expired metadata after inner lock wait');
        const purgeReplay = await Promise.all([client.rpc('purge_expired_offline_metadata', { p_limit: 100 }), client.rpc('sync_cleaning_attempt_event', input)]);
        ok(purgeReplay[0], 'bounded purge race');
        assert(['OFFLINE_EVENT_EXPIRED', 'OFFLINE_LEASE_UNKNOWN'].includes(purgeReplay[1].error?.message), 'purge versus expired replay cannot reinsert or violate FK');
        assert(sql(`select count(*) from private.offline_work_leases where id='${item.lease.leaseId}';`) === '0', 'expired lease is purged without tombstone');
      }
    } finally { await release(); await pending; }
  }
  const revoked = await fixture();
  const releaseSession = await holdLock(`select id from auth.sessions where id='${revoked.owner.sessionId}' for update`);
  const revokedInput = event(revoked);
  const pendingRevoke = Promise.resolve(client.rpc('sync_cleaning_attempt_event', revokedInput));
  try {
    await waitForLock('sync_cleaning_attempt_event', releaseSession.backendPid);
    await releaseSession(`delete from auth.sessions where id='${revoked.owner.sessionId}'`);
    assert((await pendingRevoke).error?.message === 'SESSION_REVOKED', 'revoked session cannot ingest after lock wait');
    assert(sql(`select count(*) from private.offline_completion_events where lease_id='${revoked.lease.leaseId}';`) === '0', 'revocation creates no quarantine or effect');
  } finally { await releaseSession(); await pendingRevoke; }

  async function availableMaid(day) {
    const person = await account('maid'); const availabilityId = randomUUID();
    const week = new Date(`${day}T00:00:00Z`); week.setUTCDate(week.getUTCDate() - (week.getUTCDay() + 6) % 7);
    ok(await client.from('availability_versions').insert({ id: availabilityId, maid_profile_id: person.id, week_start: week.toISOString().slice(0, 10), version: 1, submitted_at: new Date().toISOString() }), 'offline handover availability');
    ok(await client.from('availability_days').insert(Array.from({ length: 7 }, (_, i) => { const dayDate = new Date(week); dayDate.setUTCDate(dayDate.getUTCDate() + i); return { availability_version_id: availabilityId, work_date: dayDate.toISOString().slice(0, 10), available: true }; })), 'offline handover week');
    return person;
  }
  async function handover(item, nextMaid) {
    return client.rpc('manage_cleaning_attempt_lifecycle', { p_actor_profile_id: admin.id, p_session_id: admin.sessionId, p_attempt_id: item.attemptId, p_expected_execution_version: 2, p_expected_assignment_id: item.assignmentId, p_expected_assignment_revision: 2, p_expected_profile_version: 1, p_action: 'interrupt_handover', p_payload: { maidProfileId: nextMaid.id, sequenceNumber: 1, serviceDate: item.day, availableFrom: `${item.day}T00:00:00+09:00`, dueAt: `${item.day}T23:59:59+09:00`, deactivateOld: false }, p_reason_code: 'ADMIN_HANDOVER', p_idempotency_key: randomUUID(), p_request_hash: 'b'.repeat(64) });
  }
  const old = await fixture(); const newMaid = await availableMaid(old.day); const oldEvent = event(old);
  const moved = ok(await handover(old, newMaid), 'actual handover before offline ingest');
  const oldSync = ok(await client.rpc('sync_cleaning_attempt_event', oldEvent), 'known handed-over lease ingest');
  assert(oldSync.outcome === 'quarantined', 'old actor metadata is quarantined after actual handover');
  const deniedCorrection = await resolve(oldSync.quarantineId, 'correction_link');
  assert(deniedCorrection.error && ['ASSIGNMENT_VERSION_CONFLICT', 'ATTEMPT_INVALID_TRANSITION', 'CAPABILITY_ACCESS_REQUIRED'].includes(deniedCorrection.error.message), 'old handed-over attempt cannot be corrected');
  const current = ok(await client.from('cleaning_attempts').select('status,execution_version').eq('id', moved.nextAttempt.attemptId).single(), 'handover new attempt');
  assert(current.status === 'scheduled' && current.execution_version === 1, 'new scheduled attempt unchanged by old event');
  for (let i = 0; i < 2; i += 1) {
    const item = await fixture(); const next = await availableMaid(item.day); const input = event(item);
    const q = JSON.parse(sql(`select private.sync_attempt_event_at('${input.p_actor_profile_id}','${input.p_session_id}','${input.p_lease_id}','${input.p_event_id}',2,'${input.p_occurred_at}',0,'${item.lease.expiresAt}'::timestamptz+interval '1 second');`));
    const work = () => resolve(q.quarantineId, 'correction_link'); const move = () => handover(item, next);
    const results = i === 0 ? await Promise.all([work(), move()]) : (await Promise.all([move(), work()])).reverse();
    assert(results.filter((result) => !result.error).length === 1, 'correction versus handover has exactly one physical effect');
    assert(results.every((result) => !result.error || ['ATTEMPT_VERSION_CONFLICT', 'ASSIGNMENT_VERSION_CONFLICT', 'ATTEMPT_INVALID_TRANSITION', 'CAPABILITY_ACCESS_REQUIRED'].includes(result.error.message)), 'correction versus handover stable fail-closed without deadlock');
  }
  const decisions = await fixture();
  const decisionEvent = ok(await client.rpc('sync_cleaning_attempt_event', event(decisions, { p_server_offset_ms: 300001 })), 'different decisions fixture');
  const differentDecisions = await Promise.all([resolve(decisionEvent.quarantineId, 'record_only'), resolve(decisionEvent.quarantineId, 'reject_effect')]);
  assert(differentDecisions.filter((result) => !result.error).length === 1 && differentDecisions.filter((result) => result.error?.message === 'OFFLINE_EVENT_ALREADY_RESOLVED').length === 1, 'conflicting admin decisions serialize to one immutable resolution');
  for (let i = 0; i < 2; i += 1) {
    const item = await fixture(); const next = await availableMaid(item.day); const input = event(item);
    const move = () => handover(item, next); const ingest = () => client.rpc('sync_cleaning_attempt_event', input);
    const result = i === 0 ? await Promise.all([move(), ingest()]) : (await Promise.all([ingest(), move()])).reverse();
    const incoming = ok(result[1], 'handover versus ingest metadata');
    assert(!result[0].error ? incoming.outcome === 'quarantined' : result[0].error.message === 'ATTEMPT_VERSION_CONFLICT' && incoming.outcome === 'applied', 'handover versus ingest has one execution winner, late record only');
  }
  for (let i = 0; i < 2; i += 1) {
    const item = await fixture(); const input = event(item);
    const grant = () => client.rpc('manage_cleaning_attempt_lifecycle', { p_actor_profile_id: admin.id, p_session_id: admin.sessionId, p_attempt_id: item.attemptId, p_expected_execution_version: 2, p_expected_assignment_id: item.assignmentId, p_expected_assignment_revision: 2, p_expected_profile_version: 1, p_action: 'allow_finish', p_payload: {}, p_reason_code: 'DEACTIVATION_FINISH_CURRENT', p_idempotency_key: randomUUID(), p_request_hash: 'a'.repeat(64) });
    const ingest = () => client.rpc('sync_cleaning_attempt_event', input);
    const results = i === 0 ? await Promise.all([grant(), ingest()]) : (await Promise.all([ingest(), grant()])).reverse();
    const incoming = ok(results[1], 'account lifecycle versus sync');
    if (!results[0].error) assert(incoming.outcome === 'quarantined' && incoming.reasonCode === 'LEASE_REVOKED', 'status change revokes offline execution but admits bounded metadata');
    else assert(results[0].error.message === 'ATTEMPT_VERSION_CONFLICT' && incoming.outcome === 'applied', 'completion wins before lifecycle CAS');
  }
  console.log('Offline concurrency passed: atomic lease, UUID replay/conflict, rotating UUID bounded slot, resolution replay, online/offline race, 2h/90d lock-wait expiry, purge/replay, session revocation, real handover and correction/handover race.');
}
