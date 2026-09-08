import { randomUUID } from 'node:crypto';

function assert(value, message) {
  if (!value) throw new Error(message);
}
function ok(result, message) {
  assert(!result.error, `${message}: ${result.error?.message}`);
  return result.data;
}

// Local synthetic rooms isolate this suite from other concurrency suites' open work.
export async function testAttemptExecutionConcurrency(client, actorProfileId) {
  const now = new Date();
  const day = new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
  const availableFrom = new Date(now.getTime() - 60_000).toISOString();
  const dueAt = new Date(now.getTime() + 3_600_000).toISOString();
  const roomType = ok(await client.from('room_types').select('id').limit(1).single(), 'execution room type');
  let sequence = 0;
  async function maid() {
    const id = randomUUID();
    const authId = randomUUID();
    ok(await client.auth.admin.createUser({
      id: authId, email: `execution-${authId}@test.invalid`, password: `T:${randomUUID()}`, email_confirm: true
    }), 'execution auth fixture');
    ok(await client.from('profiles').insert({
      id, auth_user_id: authId, display_name: `execution-${id}`, display_name_normalized: `execution-${id}`,
      login_id: `execution-${id}`, login_id_normalized: `execution-${id}`, login_sequence: 0,
      role: 'maid', status: 'active', must_change_password: false
    }), 'execution maid fixture');
    return id;
  }
  async function fixture(maidId = null) {
    const owner = maidId ?? await maid();
    const targetId = randomUUID();
    const assignmentId = randomUUID();
    const attemptId = randomUUID();
    const roomId = randomUUID();
    sequence += 1;
    ok(await client.from('rooms').insert({
      id: roomId, room_number: `${Date.now()}${sequence}`, room_type_id: roomType.id, elevator_zone: 'A'
    }), 'execution isolated local room');
    ok(await client.from('cleaning_targets').insert({
      id: targetId, room_id: roomId, cleaning_kind: 'additional', source: 'manual_room_request',
      source_key: `execution-${targetId}`, original_service_date: day, effective_service_date: day,
      available_from: availableFrom, due_at: dueAt, status: 'notified', assignment_version: 2,
      room_type_snapshot: {}, template_snapshot: {}, fee_snapshot: 10000, created_by: actorProfileId
    }), 'execution target fixture');
    ok(await client.from('cleaning_assignments').insert({
      id: assignmentId, cleaning_target_id: targetId, maid_profile_id: owner,
      sequence_number: sequence, revision: 2, notified_at: now.toISOString(), changed_by: actorProfileId
    }), 'execution assignment fixture');
    ok(await client.from('cleaning_attempts').insert({
      id: attemptId, cleaning_target_id: targetId, assignment_id: assignmentId, maid_profile_id: owner,
      attempt_number: 1, status: 'scheduled', assignment_revision: 2, template_snapshot: {}, room_snapshot: { roomId }
    }), 'execution attempt fixture');
    return { owner, targetId, assignmentId, attemptId };
  }
  const args = (item, version, key = randomUUID(), hash = 'a'.repeat(64)) => ({
    p_actor_profile_id: item.owner, p_attempt_id: item.attemptId,
    p_expected_execution_version: version, p_expected_assignment_id: item.assignmentId,
    p_expected_assignment_revision: 2, p_idempotency_key: key, p_request_hash: hash
  });
  const start = (item, key) => client.rpc('start_cleaning_attempt', args(item, 1, key));
  const complete = (item, key) => client.rpc('complete_cleaning_attempt_field_work', args(item, 2, key));
  const deactivate = (item) => client.rpc('change_account_status', {
    p_actor_profile_id: actorProfileId, p_target_profile_id: item.owner, p_status: 'inactive',
    p_reason_code: 'EXECUTION_TEST', p_idempotency_key: randomUUID(), p_request_hash: 'b'.repeat(64)
  });
  const state = async (item) => ok(await client.from('cleaning_attempts').select('status,execution_version,started_at,field_completed_at,updated_at')
    .eq('id', item.attemptId).single(), 'execution state');
  const profile = async (item) => ok(await client.from('profiles').select('status').eq('id', item.owner).single(), 'execution profile');

  const replay = await fixture();
  const startKey = randomUUID();
  const starts = await Promise.all([start(replay, startKey), start(replay, startKey)]);
  assert(starts.every((r) => !r.error) && JSON.stringify(starts[0].data) === JSON.stringify(starts[1].data),
    'concurrent same scoped start returns exact logical result');
  assert(Date.parse(starts[0].data.recordedAt) >= Date.parse(starts[0].data.startedAt),
    'recordedAt cannot predate lock-delayed actual start');
  const completeKey = randomUUID();
  const completions = await Promise.all([complete(replay, completeKey), complete(replay, completeKey)]);
  assert(completions.every((r) => !r.error) && JSON.stringify(completions[0].data) === JSON.stringify(completions[1].data),
    'concurrent completion replay converges');
  const audit = ok(await client.from('audit_events').select('event_type').eq('entity_id', replay.attemptId), 'execution audit');
  assert(audit.filter((e) => e.event_type === 'cleaning.attempt_started').length === 1 &&
    audit.filter((e) => e.event_type === 'cleaning.field_completed').length === 1, 'exactly one audit per physical transition');
  assert((await state(replay)).execution_version === 3, 'exactly two CAS increments');

  const stale = await fixture();
  const staleStarts = await Promise.all([start(stale), start(stale)]);
  assert(staleStarts.filter((r) => !r.error).length === 1 &&
    staleStarts.some((r) => r.error?.message === 'ATTEMPT_VERSION_CONFLICT'), 'different keys same CAS have one winner');
  ok(await complete(stale), 'finish stale fixture');

  const first = await fixture();
  const second = await fixture(first.owner);
  const twoRooms = await Promise.all([start(first), start(second)]);
  assert(twoRooms.filter((r) => !r.error).length === 1 && twoRooms.some((r) => r.error?.message === 'MAID_ALREADY_IN_PROGRESS'),
    'one maid cannot acquire two running rooms concurrently');
  ok(await complete(twoRooms[0].error ? second : first), 'finish two-room winner');

  // Exercise both dispatch orders repeatedly; assert whole states, not just errors.
  for (let index = 0; index < 4; index += 1) {
    const item = await fixture();
    const results = index % 2 === 0
      ? await Promise.all([start(item), deactivate(item)])
      : (await Promise.all([deactivate(item), start(item)])).reverse();
    assert(results.every((r) => !r.error || ['MAID_REQUIRED', 'ACCOUNT_EXECUTION_LIFECYCLE_REQUIRED'].includes(r.error.message)),
      'start/deactivate has stable errors and no deadlock');
    const finalAttempt = await state(item);
    const finalProfile = await profile(item);
    assert((finalAttempt.status === 'in_progress' && finalProfile.status === 'active') ||
      (finalAttempt.status === 'scheduled' && finalProfile.status === 'inactive'), 'deactivation and execution cannot strand each other');
    if (finalAttempt.status === 'in_progress') ok(await complete(item), 'finish active race winner');
  }
  for (let index = 0; index < 4; index += 1) {
    const item = await fixture();
    ok(await start(item), 'complete/deactivate setup');
    const results = index % 2 === 0
      ? await Promise.all([complete(item), deactivate(item)])
      : (await Promise.all([deactivate(item), complete(item)])).reverse();
    assert(!results[0].error && (!results[1].error || results[1].error.message === 'ACCOUNT_EXECUTION_LIFECYCLE_REQUIRED'),
      'complete/deactivate never deadlocks and physical completion succeeds');
    assert((await state(item)).status === 'field_completed', 'complete/deactivate preserves physical completion');
  }
  const inactiveFirst = await fixture();
  ok(await deactivate(inactiveFirst), 'deactivate first');
  assert((await start(inactiveFirst)).error?.message === 'MAID_REQUIRED', 'serial deactivate first blocks start');
  const startFirst = await fixture();
  ok(await start(startFirst), 'start first');
  assert((await deactivate(startFirst)).error?.message === 'ACCOUNT_EXECUTION_LIFECYCLE_REQUIRED', 'serial start first blocks generic deactivate');
  ok(await complete(startFirst), 'complete first');
  ok(await deactivate(startFirst), 'serial complete allows later deactivate');
  console.log('Attempt execution concurrency passed: scoped replay, CAS winner, one running job/maid, start/deactivate and complete/deactivate both orders.');
}
