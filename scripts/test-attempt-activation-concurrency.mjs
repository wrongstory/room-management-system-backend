import { randomUUID } from 'node:crypto';

function assert(value, message) {
  if (!value) throw new Error(message);
}

function ok(result, label) {
  assert(!result.error, `${label}: ${result.error?.message}`);
  return result.data;
}

function kstDate(date = new Date()) {
  return new Date(date.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}

export async function testAttemptActivationConcurrency(client, actorProfileId) {
  const today = kstDate();
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay() || 7;
  const week = new Date(Date.parse(`${today}T00:00:00Z`) - (weekday - 1) * 86_400_000)
    .toISOString().slice(0, 10);
  const now = new Date();
  const availableFrom = new Date(now.getTime() - 3_600_000).toISOString();
  const dueAt = new Date(now.getTime() + 3_600_000).toISOString();
  const maids = [];

  for (let index = 0; index < 2; index += 1) {
    const authId = randomUUID();
    const profileId = randomUUID();
    ok(await client.auth.admin.createUser({
      id: authId,
      email: `activation-${authId}@test.invalid`,
      password: `T:${randomUUID()}`,
      email_confirm: true
    }), 'activation maid Auth fixture');
    ok(await client.from('profiles').insert({
      id: profileId,
      auth_user_id: authId,
      display_name: `activation-${authId}`,
      display_name_normalized: `activation-${authId}`,
      login_id: `activation-${authId}`,
      login_id_normalized: `activation-${authId}`,
      login_sequence: 0,
      role: 'maid',
      status: 'active'
    }), 'activation maid profile fixture');
    const availabilityId = randomUUID();
    ok(await client.from('availability_versions').insert({
      id: availabilityId,
      maid_profile_id: profileId,
      week_start: week,
      version: 1,
      submitted_at: now.toISOString()
    }), 'activation availability fixture');
    ok(await client.from('availability_days').insert(Array.from({ length: 7 }, (_, offset) => ({
      availability_version_id: availabilityId,
      work_date: new Date(Date.parse(`${week}T00:00:00Z`) + offset * 86_400_000)
        .toISOString().slice(0, 10),
      available: true
    }))), 'activation availability days');
    maids.push(profileId);
  }

  const rooms = ok(await client.from('rooms').select('id').order('room_number').range(60, 89), 'activation rooms');
  let sequence = 300;
  async function fixture({ expired = false } = {}) {
    const targetId = randomUUID();
    const assignmentId = randomUUID();
    const currentSequence = sequence++;
    ok(await client.from('cleaning_targets').insert({
      id: targetId,
      room_id: rooms[currentSequence - 300].id,
      cleaning_kind: 'additional',
      source: 'manual_room_request',
      source_key: `activation-race-${targetId}`,
      original_service_date: expired ? kstDate(new Date(now.getTime() - 86_400_000)) : today,
      effective_service_date: expired ? kstDate(new Date(now.getTime() - 86_400_000)) : today,
      available_from: expired ? new Date(now.getTime() - 30 * 3_600_000).toISOString() : availableFrom,
      due_at: expired ? new Date(now.getTime() - 20 * 3_600_000).toISOString() : dueAt,
      status: 'notified',
      assignment_version: 2,
      room_type_snapshot: {},
      fee_snapshot: 10000,
      template_snapshot: { durationMinutes: 60 },
      created_by: actorProfileId
    }), 'activation target fixture');
    ok(await client.from('cleaning_assignments').insert({
      id: assignmentId,
      cleaning_target_id: targetId,
      maid_profile_id: maids[0],
      sequence_number: currentSequence,
      revision: 2,
      notified_at: now.toISOString(),
      changed_by: actorProfileId
    }), 'activation assignment fixture');
    return { targetId, assignmentId, sequence: currentSequence };
  }

  const lifecycle = (label) => ({
    p_actor_profile_id: actorProfileId,
    p_as_of: now.toISOString(),
    p_idempotency_key: `activation-race-${label}-${randomUUID()}`,
    p_request_hash: 'a'.repeat(64)
  });
  const change = (item) => ({
    p_actor_profile_id: actorProfileId,
    p_cleaning_target_id: item.targetId,
    p_expected_current_assignment_id: item.assignmentId,
    p_expected_assignment_version: 2,
    p_maid_profile_id: maids[1],
    p_sequence_number: item.sequence,
    p_reason_code: 'OPERATIONAL_CHANGE',
    p_idempotency_key: `activation-change-${randomUUID()}`,
    p_request_hash: 'b'.repeat(64)
  });
  const unassign = (item) => ({
    p_actor_profile_id: actorProfileId,
    p_cleaning_target_id: item.targetId,
    p_expected_current_assignment_id: item.assignmentId,
    p_expected_assignment_version: 2,
    p_reason_code: 'OPERATIONAL_CHANGE',
    p_idempotency_key: `activation-unassign-${randomUUID()}`,
    p_request_hash: 'c'.repeat(64)
  });

  for (let repeat = 0; repeat < 3; repeat += 1) {
    const item = await fixture();
    const results = await Promise.all([
      client.rpc('process_due_assignment_lifecycle', lifecycle(`change-${repeat}`)),
      client.rpc('change_cleaning_assignment_prestart', change(item))
    ]);
    assert(results.every((result) => !result.error || /ASSIGNMENT_ALREADY_STARTED|ASSIGNMENT_VERSION_CONFLICT/.test(result.error.message)),
      'activation versus change must fail closed without deadlock');
    const attempts = ok(await client.from('cleaning_attempts').select('assignment_id').eq('cleaning_target_id', item.targetId), 'activation/change attempts');
    const current = ok(await client.from('cleaning_assignments').select('id,maid_profile_id').eq('cleaning_target_id', item.targetId).eq('is_current', true), 'activation/change current');
    assert((attempts.length === 1 && attempts[0].assignment_id === item.assignmentId && current[0]?.id === item.assignmentId) ||
      (attempts.length === 0 && current.length === 1 && current[0].maid_profile_id === maids[1]),
    'activation and pre-start change cannot both mutate the same revision');
  }

  const unassignItem = await fixture();
  const activationVsUnassign = await Promise.all([
    client.rpc('process_due_assignment_lifecycle', lifecycle('unassign')),
    client.rpc('unassign_cleaning_assignment_prestart', unassign(unassignItem))
  ]);
  assert(activationVsUnassign.every((result) => !result.error || /ASSIGNMENT_ALREADY_STARTED|ASSIGNMENT_VERSION_CONFLICT/.test(result.error.message)),
    'activation versus unassign must fail closed');
  const unassignAttempts = ok(await client.from('cleaning_attempts').select('id').eq('cleaning_target_id', unassignItem.targetId), 'activation/unassign attempts');
  const unassignTarget = ok(await client.from('cleaning_targets').select('status').eq('id', unassignItem.targetId).single(), 'activation/unassign target');
  assert((unassignAttempts.length === 1 && unassignTarget.status === 'notified') ||
    (unassignAttempts.length === 0 && unassignTarget.status === 'unassigned'),
  'activation and unassign produce one complete winner state');

  const duplicateItem = await fixture();
  const duplicateWorkers = await Promise.all([
    client.rpc('process_due_assignment_lifecycle', lifecycle('duplicate-a')),
    client.rpc('process_due_assignment_lifecycle', lifecycle('duplicate-b'))
  ]);
  assert(duplicateWorkers.every((result) => !result.error), 'two activation workers must complete');
  const duplicateAttempts = ok(await client.from('cleaning_attempts').select('attempt_number').eq('cleaning_target_id', duplicateItem.targetId), 'duplicate attempts');
  assert(duplicateAttempts.length === 1 && duplicateAttempts[0].attempt_number === 1,
    'two activation workers create exactly attempt one');

  const rolloverItem = await fixture({ expired: true });
  const rolloverWorkers = await Promise.all([
    client.rpc('process_due_assignment_lifecycle', lifecycle('rollover-a')),
    client.rpc('process_due_assignment_lifecycle', lifecycle('rollover-b'))
  ]);
  assert(rolloverWorkers.every((result) => !result.error), 'two rollover workers must complete');
  const rolled = ok(await client.from('cleaning_targets').select('carryover_count,assignment_version,effective_service_date,status').eq('id', rolloverItem.targetId).single(), 'rolled target');
  const revisions = ok(await client.from('cleaning_target_schedule_revisions').select('id').eq('cleaning_target_id', rolloverItem.targetId).eq('reason_code', 'ROLLED_OVER_NOT_STARTED'), 'rollover revisions');
  assert(rolled.carryover_count === 1 && rolled.assignment_version === 3 && rolled.status === 'unassigned' && revisions.length === 1,
    'two rollover workers advance date/version/carryover exactly once');

  const decisionItem = await fixture();
  const request = ok(await client.rpc('request_assignment_cancellation', {
    p_actor_profile_id: maids[0],
    p_cleaning_target_id: decisionItem.targetId,
    p_expected_current_assignment_id: decisionItem.assignmentId,
    p_expected_assignment_version: 2,
    p_reason_code: 'PERSONAL_REASON',
    p_idempotency_key: `activation-request-${randomUUID()}`,
    p_request_hash: 'd'.repeat(64)
  }), 'activation cancellation request');
  const decisionVsActivation = await Promise.all([
    client.rpc('decide_assignment_cancellation_request', {
      p_actor_profile_id: actorProfileId,
      p_request_id: request.requestId,
      p_expected_current_assignment_id: decisionItem.assignmentId,
      p_expected_assignment_version: 2,
      p_decision: 'approved',
      p_reason_code: 'OPERATIONAL_CHANGE',
      p_idempotency_key: `activation-decision-${randomUUID()}`,
      p_request_hash: 'e'.repeat(64)
    }),
    client.rpc('process_due_assignment_lifecycle', lifecycle('decision'))
  ]);
  assert(decisionVsActivation.every((result) => !result.error || /ASSIGNMENT_ALREADY_STARTED|ASSIGNMENT_CHANGE_REQUEST_STALE|ASSIGNMENT_VERSION_CONFLICT/.test(result.error.message)),
    'activation versus cancellation decision must fail closed');
  const decisionAttempts = ok(await client.from('cleaning_attempts').select('id').eq('cleaning_target_id', decisionItem.targetId), 'decision attempts');
  const decisionTarget = ok(await client.from('cleaning_targets').select('status').eq('id', decisionItem.targetId).single(), 'decision target');
  assert((decisionAttempts.length === 1 && decisionTarget.status === 'notified') ||
    (decisionAttempts.length === 0 && decisionTarget.status === 'unassigned'),
  'activation and cancellation approval cannot both mutate the revision');

  console.log('Attempt activation races PASS: change (3), unassign, cancellation decision, two activation workers and two rollover workers; exactly-one/fail-closed state preserved.');
}
