import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function ok(result, message) {
  if (result.error) throw new Error(`${message}: ${result.error.message}`);
  return result.data;
}

// Synthetic local Auth sessions stay in memory; no token/session/credential is logged.
export async function testAttemptLifecycleConcurrency(client) {
  assert(['localhost', '127.0.0.1'].includes(new URL(client.supabaseUrl).hostname), 'lifecycle concurrency is local only');
  const psqlArgs = ['exec', '-i', 'supabase_db_room-management-system-backend', 'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'];
  function sql(command) {
    try {
      return execFileSync('docker', psqlArgs, { input: command, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10_000 }).trim();
    } catch {
      throw new Error('local lifecycle SQL helper failed (raw SQL/output redacted)');
    }
  }
  async function holdLock(command) {
    const process = spawn('docker', psqlArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    let ready = false;
    let output = '';
    const exited = new Promise((resolve) => process.once('close', resolve));
    process.stderr.on('data', () => {}); // Never print SQL/session identifiers from errors.
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { process.kill(); reject(new Error('local lifecycle lock setup timed out')); }, 10_000);
      process.once('error', () => { clearTimeout(timeout); reject(new Error('local lifecycle lock process failed')); });
      process.once('close', () => { if (!ready) { clearTimeout(timeout); reject(new Error('local lifecycle lock setup failed')); } });
      process.stdout.on('data', (chunk) => {
        output += chunk.toString();
        if (!ready && output.includes('LOCK_READY')) { ready = true; output = ''; clearTimeout(timeout); resolve(); }
      });
      process.stdin.write(`begin; set local statement_timeout='12s'; set local idle_in_transaction_session_timeout='15s'; ${command};\n\\echo LOCK_READY\n`);
    });
    let releasePromise;
    return (beforeCommit = '') => {
      if (!releasePromise) releasePromise = (async () => {
        process.stdin.end(`${beforeCommit}; commit;\n\\q\n`);
        assert(await exited === 0, 'local lifecycle lock transaction completed without deadlock');
      })();
      return releasePromise;
    };
  }
  async function waitForLock(rpcName) {
    assert(/^[a-z_]+$/.test(rpcName), 'source-controlled RPC query filter');
    for (let retry = 0; retry < 50; retry += 1) {
      if (sql(`select exists(select 1 from pg_stat_activity where pid<>pg_backend_pid() and state='active' and wait_event_type='Lock' and query like '%${rpcName}%');`) === 't') return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('lifecycle RPC did not reach the expected transaction lock');
  }
  const now = new Date();
  const day = new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10);
  const from = `${day}T00:00:00+09:00`;
  const due = `${day}T23:59:59+09:00`;
  const type = ok(await client.from('room_types').select('id').limit(1).single(), 'lifecycle room type');
  let seq = 0;
  async function account(role = 'maid') {
    const id = randomUUID();
    const userId = randomUUID();
    const email = `lifecycle-${userId}@test.invalid`;
    const password = `T:${randomUUID()}`;
    ok(await client.auth.admin.createUser({ id: userId, email, password, email_confirm: true }), 'lifecycle auth fixture');
    ok(await client.from('profiles').insert({ id, auth_user_id: userId, display_name: `lifecycle-${id}`,
      display_name_normalized: `lifecycle-${id}`, login_id: `lifecycle-${id}`, login_id_normalized: `lifecycle-${id}`,
      login_sequence: 0, role, status: 'active', must_change_password: false }), 'lifecycle profile fixture');
    const loginClient = createClient(client.supabaseUrl, client.supabaseKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
    const signedIn = ok(await loginClient.auth.signInWithPassword({ email, password }), 'lifecycle local sign-in');
    const sessionId = JSON.parse(Buffer.from(signedIn.session.access_token.split('.')[1], 'base64url').toString()).session_id;
    return { id, sessionId };
  }
  const admin = await account('admin');
  async function fixture(options = {}) {
    const owner = await account();
    const roomId = randomUUID();
    const targetId = randomUUID();
    const assignmentId = randomUUID();
    const attemptId = randomUUID();
    seq += 1;
    ok(await client.from('rooms').insert({ id: roomId, room_number: `${Date.now()}${seq}`,
      room_type_id: type.id, elevator_zone: 'A' }), 'lifecycle room fixture');
    ok(await client.from('cleaning_targets').insert({ id: targetId, room_id: roomId, cleaning_kind: 'additional',
      source: 'manual_room_request', source_key: `lifecycle-${targetId}`, original_service_date: day, effective_service_date: day,
      available_from: from, due_at: options.dueAt ?? due, status: 'notified', assignment_version: 2,
      room_type_snapshot: {}, template_snapshot: {}, fee_snapshot: 10000, created_by: admin.id }), 'lifecycle target fixture');
    ok(await client.from('cleaning_assignments').insert({ id: assignmentId, cleaning_target_id: targetId,
      maid_profile_id: owner.id, sequence_number: 1, revision: 2, notified_at: now.toISOString(), changed_by: admin.id }), 'lifecycle assignment fixture');
    ok(await client.from('cleaning_attempts').insert({ id: attemptId, cleaning_target_id: targetId, assignment_id: assignmentId,
      maid_profile_id: owner.id, attempt_number: 1, status: 'scheduled', assignment_revision: 2,
      room_snapshot: { roomId }, template_snapshot: {} }), 'lifecycle attempt fixture');
    if (options.start !== false) ok(await client.rpc('start_cleaning_attempt', { p_actor_profile_id: owner.id, p_attempt_id: attemptId,
      p_expected_execution_version: 1, p_expected_assignment_id: assignmentId, p_expected_assignment_revision: 2,
      p_idempotency_key: randomUUID(), p_request_hash: 'a'.repeat(64) }), 'lifecycle start fixture');
    return { owner, targetId, assignmentId, attemptId };
  }
  function manage(item, action = 'allow_finish', key = randomUUID(), payload = {}, profileVersion = 1, executionVersion = 2) {
    return client.rpc('manage_cleaning_attempt_lifecycle', { p_actor_profile_id: admin.id, p_session_id: admin.sessionId,
      p_attempt_id: item.attemptId, p_expected_execution_version: executionVersion, p_expected_assignment_id: item.assignmentId,
      p_expected_assignment_revision: 2, p_expected_profile_version: profileVersion, p_action: action, p_payload: payload,
      p_reason_code: action === 'allow_finish' ? 'DEACTIVATION_FINISH_CURRENT' : action === 'expire_scheduled' ? 'SCHEDULE_EXPIRED' : 'DEACTIVATION_HANDOVER',
      p_idempotency_key: key, p_request_hash: 'b'.repeat(64) });
  }
  function complete(item, key = randomUUID()) {
    return client.rpc('complete_limited_cleaning_attempt_field_work', { p_actor_profile_id: item.owner.id,
      p_session_id: item.owner.sessionId, p_attempt_id: item.attemptId, p_expected_execution_version: 2,
      p_expected_assignment_id: item.assignmentId, p_expected_assignment_revision: 2,
      p_idempotency_key: key, p_request_hash: 'c'.repeat(64) });
  }
  const item = await fixture();
  const grantKey = randomUUID();
  const grants = await Promise.all([manage(item, 'allow_finish', grantKey), manage(item, 'allow_finish', grantKey)]);
  assert(grants.every((r) => !r.error) && JSON.stringify(grants[0].data) === JSON.stringify(grants[1].data),
    'same scoped grant race returns one logical result and fixed expiration');
  const differentKey = ok(await manage(item, 'allow_finish', randomUUID(), {}, 2), 'different grant key');
  assert(differentKey.capability.expiresAt === grants[0].data.capability.expiresAt, 'new key cannot extend grant expiration');
  const completeKey = randomUUID();
  const completions = await Promise.all([complete(item, completeKey), complete(item, completeKey)]);
  assert(completions.every((r) => !r.error) && JSON.stringify(completions[0].data) === JSON.stringify(completions[1].data),
    'same scoped limited completion race replays in upload_only');
  const events = ok(await client.from('audit_events').select('event_type').eq('entity_id', item.attemptId), 'limited audit count');
  assert(events.filter((e) => e.event_type === 'cleaning.field_completed').length === 1, 'limited completion writes exactly one audit');

  const newMaid = await account();
  const week = new Date(`${day}T00:00:00Z`);
  week.setUTCDate(week.getUTCDate() - (week.getUTCDay() + 6) % 7);
  const availabilityId = randomUUID();
  ok(await client.from('availability_versions').insert({ id: availabilityId, maid_profile_id: newMaid.id,
    week_start: week.toISOString().slice(0, 10), version: 1, submitted_at: now.toISOString() }), 'handover availability');
  ok(await client.from('availability_days').insert(Array.from({ length: 7 }, (_, offset) => {
    const date = new Date(week);
    date.setUTCDate(date.getUTCDate() + offset);
    return { availability_version_id: availabilityId, work_date: date.toISOString().slice(0, 10), available: true };
  })), 'handover available week');
  for (let index = 0; index < 4; index += 1) {
    const race = await fixture();
    ok(await manage(race), 'finish grant for handover race');
    const payload = { maidProfileId: newMaid.id, sequenceNumber: index + 1, serviceDate: day,
      availableFrom: from, dueAt: due, deactivateOld: true };
    const work = () => complete(race);
    const handover = () => manage(race, 'interrupt_handover', randomUUID(), payload, 2);
    const results = index % 2 === 0 ? await Promise.all([work(), handover()])
      : (await Promise.all([handover(), work()])).reverse();
    assert(results.filter((r) => !r.error).length === 1, 'complete versus handover has one winner');
    assert(results.every((r) => !r.error || ['CAPABILITY_ACCESS_REQUIRED', 'ACCOUNT_VERSION_CONFLICT', 'ATTEMPT_VERSION_CONFLICT'].includes(r.error.message)),
      'complete/handover race has stable fail-closed errors without deadlock');
    const attempts = ok(await client.from('cleaning_attempts').select('id,status,execution_version').eq('cleaning_target_id', race.targetId), 'race attempts');
    const old = attempts.find((a) => a.id === race.attemptId);
    assert((old.status === 'field_completed' && attempts.length === 1) ||
      (old.status === 'interrupted' && attempts.length === 2 && attempts.some((a) => a.status === 'scheduled')),
    'race preserves one current workflow and immutable old history');
  }
  const duplicateHandover = await fixture();
  const payload = { maidProfileId: newMaid.id, sequenceNumber: 99, serviceDate: day,
    availableFrom: from, dueAt: due, deactivateOld: true };
  const handoverKey = randomUUID();
  const handovers = await Promise.all([manage(duplicateHandover, 'interrupt_handover', handoverKey, payload),
    manage(duplicateHandover, 'interrupt_handover', handoverKey, payload)]);
  assert(handovers.every((r) => !r.error) && JSON.stringify(handovers[0].data) === JSON.stringify(handovers[1].data),
    'duplicate handover creates one new logical attempt');
  const next = ok(await client.from('cleaning_attempts').select('id').eq('cleaning_target_id', duplicateHandover.targetId), 'handover count');
  assert(next.length === 2, 'concurrent handover has no orphan or duplicate attempt');
  const availabilityWeek = week.toISOString().slice(0, 10);
  async function availableMaid() {
    const person = await account();
    const versionId = randomUUID();
    ok(await client.from('availability_versions').insert({ id: versionId, maid_profile_id: person.id,
      week_start: availabilityWeek, version: 1, submitted_at: now.toISOString() }), 'isolated race availability');
    ok(await client.from('availability_days').insert(Array.from({ length: 7 }, (_, offset) => {
      const date = new Date(`${availabilityWeek}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() + offset);
      return { availability_version_id: versionId, work_date: date.toISOString().slice(0, 10), available: true };
    })), 'isolated race week days');
    return { ...person, versionId };
  }
  const handoverPayload = (person, deadline = due) => ({ maidProfileId: person.id, sequenceNumber: 1,
    serviceDate: day, availableFrom: from, dueAt: deadline, deactivateOld: true });

  // Hold the exact availability lock before a real approval command. Handover
  // waits while holding profile locks: FK KEY SHARE must not form a deadlock.
  const approvalTarget = await availableMaid();
  const approvalItem = await fixture();
  const requestId = randomUUID();
  ok(await client.from('availability_change_requests').insert({ id: requestId,
    availability_version_id: approvalTarget.versionId, maid_profile_id: approvalTarget.id,
    week_start: availabilityWeek, source_version: 1, requested_available_dates: [],
    reason_code: 'CONCURRENCY_UNAVAILABLE', status: 'pending', requested_at: now.toISOString() }), 'availability approval race request');
  const releaseApproval = await holdLock(`select pg_advisory_xact_lock(hashtextextended('availability:${approvalTarget.id}:${availabilityWeek}',0))`);
  let approvalReleased = false;
  const approvalHandover = Promise.resolve(manage(approvalItem, 'interrupt_handover', randomUUID(), handoverPayload(approvalTarget)));
  try {
    await waitForLock('manage_cleaning_attempt_lifecycle');
    await releaseApproval(`select public.decide_availability_change('${admin.id}','${requestId}','approved','CONCURRENCY_APPROVED',1,'${randomUUID()}')`);
    approvalReleased = true;
    const result = await approvalHandover;
    assert(result.error?.message === 'ASSIGNMENT_MAID_UNAVAILABLE', 'handover rechecks committed unavailable decision after lock wait');
  } finally {
    if (!approvalReleased) await releaseApproval();
    await approvalHandover;
  }

  // Real wall-clock expiry while waiting, not an injected command timestamp.
  const clockMaid = await availableMaid();
  const clockItem = await fixture();
  const releaseClock = await holdLock(`select pg_advisory_xact_lock(hashtextextended('availability:${clockMaid.id}:${availabilityWeek}',0))`);
  const deadline = new Date(Date.now() + 2500).toISOString();
  let clockReleased = false;
  const clockHandover = Promise.resolve(manage(clockItem, 'interrupt_handover', randomUUID(), handoverPayload(clockMaid, deadline)));
  try {
    await waitForLock('manage_cleaning_attempt_lifecycle');
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Date.parse(deadline) - Date.now() + 100)));
    await releaseClock();
    clockReleased = true;
    assert((await clockHandover).error?.message === 'ASSIGNMENT_SCHEDULE_INVALID', 'post-lock clock rejects an expired handover window');
    const state = ok(await client.from('cleaning_attempts').select('status').eq('id', clockItem.attemptId).single(), 'expired wait attempt');
    assert(state.status === 'in_progress', 'expired handover creates no transition');
  } finally {
    if (!clockReleased) await releaseClock();
    await clockHandover;
  }

  // Revocation wins the locked session row after middleware-style validation.
  const revoked = await fixture();
  ok(await manage(revoked), 'session race finish grant');
  const releaseSession = await holdLock(`select 1 from auth.sessions where id='${revoked.owner.sessionId}' for update`);
  let sessionReleased = false;
  const pendingComplete = Promise.resolve(complete(revoked));
  try {
    await waitForLock('complete_limited_cleaning_attempt_field_work');
    await releaseSession(`delete from auth.sessions where id='${revoked.owner.sessionId}'`);
    sessionReleased = true;
    assert((await pendingComplete).error?.message === 'SESSION_REVOKED', 'revocation during lock wait blocks limited completion');
    const state = ok(await client.from('cleaning_attempts').select('status,execution_version').eq('id', revoked.attemptId).single(), 'revoked attempt state');
    assert(state.status === 'in_progress' && state.execution_version === 2, 'revoked session has no physical completion side effect');
  } finally {
    if (!sessionReleased) await releaseSession();
    await pendingComplete;
  }

  const expired = await fixture({ start: false, dueAt: new Date(Date.now() - 1000).toISOString() });
  const expiryRace = await Promise.all([
    manage(expired, 'expire_scheduled', randomUUID(), {}, 1, 1),
    client.rpc('start_cleaning_attempt', { p_actor_profile_id: expired.owner.id, p_attempt_id: expired.attemptId,
      p_expected_execution_version: 1, p_expected_assignment_id: expired.assignmentId, p_expected_assignment_revision: 2,
      p_idempotency_key: randomUUID(), p_request_hash: 'd'.repeat(64) })
  ]);
  assert(!expiryRace[0].error && expiryRace[1].error &&
    ['CLEANING_WINDOW_EXPIRED', 'ATTEMPT_VERSION_CONFLICT', 'ASSIGNMENT_VERSION_CONFLICT'].includes(expiryRace[1].error.message),
  'expired scheduled cleanup wins while start fails closed');
  const expiredState = ok(await client.from('cleaning_attempts').select('status,started_at,execution_version').eq('id', expired.attemptId).single(), 'expiry race state');
  assert(expiredState.status === 'superseded' && expiredState.started_at === null && expiredState.execution_version === 2,
    'expiration preserves unstarted immutable history');

  for (let index = 0; index < 4; index += 1) {
    const accountRace = await fixture();
    ok(await manage(accountRace), 'account race finish grant');
    const deactivate = () => client.rpc('change_account_status', { p_actor_profile_id: admin.id,
      p_target_profile_id: accountRace.owner.id, p_status: 'inactive', p_reason_code: 'LIFECYCLE_TEST',
      p_idempotency_key: randomUUID(), p_request_hash: 'e'.repeat(64) });
    const results = index % 2 === 0 ? await Promise.all([complete(accountRace), deactivate()])
      : (await Promise.all([deactivate(), complete(accountRace)])).reverse();
    assert(!results[0].error && (!results[1].error || results[1].error.message === 'ACCOUNT_EXECUTION_LIFECYCLE_REQUIRED'),
      'limited completion and generic deactivation serialize without deadlock');
    const state = ok(await client.from('cleaning_attempts').select('status').eq('id', accountRace.attemptId).single(), 'account race attempt');
    const profile = ok(await client.from('profiles').select('status').eq('id', accountRace.owner.id).single(), 'account race profile');
    assert(state.status === 'field_completed' && ['upload_only', 'inactive'].includes(profile.status), 'account race preserves completed work and no active reactivation');
    if (profile.status === 'inactive') assert((await complete(accountRace)).error?.message === 'CAPABILITY_ACCESS_REQUIRED', 'inactive account has no replay/execute permission');
  }
  console.log('Attempt lifecycle concurrency passed: fixed TTL/replay, handover/complete, availability approval/clock waits, session revocation, scheduled expiry/start, account change/completion.');
}
