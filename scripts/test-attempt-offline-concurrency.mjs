import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';

function assert(value, message) { if (!value) throw new Error(message); }
function ok(result, label) {
  if (result.error) throw new Error(`${label} failed (${String(result.error.code ?? 'DB_ERROR')})`);
  return result.data;
}

// Real local Auth/session/RPC races. Every credential, UUID and SQL result remains in memory.
export async function testAttemptOfflineConcurrency(client) {
  assert(['localhost', '127.0.0.1'].includes(new URL(client.supabaseUrl).hostname), 'offline races require local Supabase');
  function sql(statement) {
    try {
      return execFileSync('docker', ['exec', '-i', 'supabase_db_room-management-system-backend', 'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], { input: statement, encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch { throw new Error('offline local SQL fixture/check failed (raw details redacted)'); }
  }
  async function holdLock(statement) {
    const child = spawn('docker', ['exec', '-i', 'supabase_db_room-management-system-backend', 'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = new Promise((resolve) => child.once('close', resolve));
    child.stderr.on('data', () => {});
    await new Promise((resolve, reject) => {
      let ready = false; let output = '';
      const timeout = setTimeout(() => { child.kill(); reject(new Error('offline lock setup timed out')); }, 10000);
      child.once('error', () => { clearTimeout(timeout); reject(new Error('offline lock setup failed')); });
      child.once('close', () => { if (!ready) { clearTimeout(timeout); reject(new Error('offline lock closed prematurely')); } });
      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
        if (!ready && output.includes('LOCK_READY')) { ready = true; clearTimeout(timeout); output = ''; resolve(); }
      });
      child.stdin.write(`begin;set local statement_timeout='12s';set local idle_in_transaction_session_timeout='15s';${statement};\n\\echo LOCK_READY\n`);
    });
    let promise;
    return (beforeCommit = '') => promise ??= (async () => {
      child.stdin.end(`${beforeCommit};commit;\n\\q\n`);
      assert(await closed === 0, 'offline lock released without deadlock');
    })();
  }
  async function waitForLock(rpcName) {
    assert(/^[a-z_]+$/.test(rpcName), 'fixed RPC filter');
    for (let i = 0; i < 50; i += 1) {
      if (sql(`select exists(select 1 from pg_stat_activity where pid<>pg_backend_pid() and state='active' and wait_event_type='Lock' and query like '%${rpcName}%');`) === 't') return;
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
  async function fixture(startAt = null) {
    const owner = await account('maid');
    const roomId = randomUUID(); const targetId = randomUUID(); const assignmentId = randomUUID(); const attemptId = randomUUID();
    const now = startAt ? new Date(startAt) : new Date(); const day = new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10);
    ok(await client.from('rooms').insert({ id: roomId, room_number: `${Date.now()}${++sequence}`, room_type_id: roomType.id, elevator_zone: 'A' }), 'offline room');
    ok(await client.from('cleaning_targets').insert({ id: targetId, room_id: roomId, cleaning_kind: 'additional', source: 'manual_room_request', source_key: `offline-${targetId}`, original_service_date: day, effective_service_date: day, available_from: `${day}T00:00:00+09:00`, due_at: `${day}T23:59:59+09:00`, status: 'notified', assignment_version: 2, room_type_snapshot: {}, template_snapshot: {}, fee_snapshot: 10000, created_by: admin.id }), 'offline target');
    ok(await client.from('cleaning_assignments').insert({ id: assignmentId, cleaning_target_id: targetId, maid_profile_id: owner.id, sequence_number: 1, revision: 2, notified_at: now.toISOString(), changed_by: admin.id }), 'offline assignment');
    ok(await client.from('cleaning_attempts').insert({ id: attemptId, cleaning_target_id: targetId, assignment_id: assignmentId, maid_profile_id: owner.id, attempt_number: 1, status: 'scheduled', assignment_revision: 2, room_snapshot: { roomId }, template_snapshot: {} }), 'offline attempt');
    const input = { p_actor_profile_id: owner.id, p_session_id: owner.sessionId, p_attempt_id: attemptId, p_expected_execution_version: 1, p_expected_assignment_id: assignmentId, p_expected_assignment_revision: 2, p_idempotency_key: randomUUID(), p_request_hash: 'd'.repeat(64) };
    const starts = startAt
      ? [{ data: JSON.parse(sql(`select private.start_attempt_with_lease_at('${owner.id}','${owner.sessionId}','${attemptId}',1,'${assignmentId}',2,'${input.p_idempotency_key}','${input.p_request_hash}','${now.toISOString()}');`)), error: null }]
      : await Promise.all([client.rpc('start_cleaning_attempt_with_lease', input), client.rpc('start_cleaning_attempt_with_lease', input)]);
    starts.forEach((result) => { ok(result, 'offline concurrent start'); });
    if (!startAt) assert(JSON.stringify(starts[0].data.lease) === JSON.stringify(starts[1].data.lease), 'start race must issue one lease with immutable expiry');
    assert(sql(`select count(*) from private.offline_work_leases where attempt_id='${attemptId}';`) === '1', 'exactly one lease per attempt');
    return { owner, attemptId, assignmentId, targetId, lease: starts[0].data.lease, day, startInput: input };
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
    const span = horizon === 'execution' ? 2 * 3600000 : 90 * 86400000;
    const item = await fixture(new Date(Date.now() - span + 5000).toISOString());
    const deadline = Date.parse(horizon === 'execution' ? item.lease.expiresAt : item.lease.metadataExpiresAt);
    assert(deadline > Date.now(), 'clock fixture has not expired before request');
    const release = await holdLock(`select id from public.cleaning_targets where id='${item.targetId}' for update`);
    const input = event(item, { p_occurred_at: new Date(Date.parse(item.lease.issuedAt) + 1000).toISOString() });
    const rpcName = horizon === 'execution' ? 'sync_cleaning_attempt_event' : 'start_cleaning_attempt_with_lease';
    const pending = Promise.resolve(client.rpc(rpcName, horizon === 'execution' ? input : item.startInput));
    try {
      await waitForLock(rpcName);
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now() + 100)));
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
    await waitForLock('sync_cleaning_attempt_event');
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
