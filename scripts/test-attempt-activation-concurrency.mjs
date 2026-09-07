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

  // 실제 예약/연박 생성 command로 만든 창을 경쟁시킨다. 원 command의
  // reservation-command lock과 lifecycle lock 순서가 같아야 반쪽 이월이 없다.
  const sourceRooms = ok(await client.from('rooms').select('id,room_type_id,state_version')
    .order('room_number').range(110, 112), 'source window race rooms');
  for (const roomTypeId of new Set(sourceRooms.map((room) => room.room_type_id))) {
    const published = ok(await client.from('cleaning_template_versions').select('id')
      .eq('room_type_id', roomTypeId).eq('cleaning_kind', 'stayover').eq('status', 'published'),
    'source window stayover template');
    if (published.length === 0) {
      ok(await client.from('cleaning_template_versions').insert({
        room_type_id: roomTypeId, cleaning_kind: 'stayover', version: 1,
        status: 'published', duration_minutes: 60, photo_slots: [],
        published_at: now.toISOString(), created_by: actorProfileId
      }), 'source window published local template fixture');
    }
  }
  const stayCheckIn = '2039-10-01T16:00:00+09:00';
  const stayCheckOut = '2039-10-03T11:00:00+09:00';
  const rolloverAt = '2039-10-02T16:00:00+09:00';
  async function reservationFixture(room, checkIn = stayCheckIn, checkOut = stayCheckOut) {
    const reservationId = randomUUID();
    ok(await client.rpc('mutate_room_operation', {
      p_actor_profile_id: actorProfileId, p_room_id: room.id,
      p_action: 'record_pin_sync', p_expected_room_version: room.state_version,
      p_reason_code: 'ACTIVATION_SOURCE_RACE_FIXTURE',
      p_payload: { entityId: randomUUID(), syncStatus: 'verified', pinVersion: 1 },
      p_idempotency_key: `source-pin-${reservationId}`, p_request_hash: '1'.repeat(64)
    }), 'source window room metadata');
    const currentRoom = ok(await client.from('rooms').select('state_version')
      .eq('id', room.id).single(), 'source window room version');
    ok(await client.rpc('create_reservation', {
      p_actor_profile_id: actorProfileId, p_reservation_id: reservationId,
      p_room_id: room.id, p_check_in_at: checkIn, p_check_out_at: checkOut,
      p_guest_count: 2, p_guest_name_encrypted: null,
      p_expected_room_version: currentRoom.state_version,
      p_idempotency_key: `source-reservation-${reservationId}`, p_request_hash: '2'.repeat(64)
    }), 'source window create reservation');
    // 합성 점유 전제만 fixture로 설정; target은 반드시 실제 생성 command를 사용한다.
    ok(await client.from('reservations').update({ actual_check_in_at: checkIn })
      .eq('id', reservationId), 'source window occupied fixture');
    return reservationId;
  }
  async function stayoverFixture(room) {
    const reservationId = await reservationFixture(room);
    const targetId = randomUUID();
    const currentRoom = ok(await client.from('rooms').select('state_version')
      .eq('id', room.id).single(), 'stayover request room version');
    ok(await client.rpc('create_manual_cleaning_request', {
      p_actor_profile_id: actorProfileId, p_target_id: targetId, p_room_id: room.id,
      p_reservation_id: reservationId, p_cleaning_kind: 'stayover',
      p_service_date: '2039-10-02', p_available_from: '2039-10-02T10:00:00+09:00',
      p_due_at: '2039-10-02T15:00:00+09:00',
      p_expected_room_version: currentRoom.state_version,
      p_reason_code: 'ACTIVATION_SOURCE_RACE_FIXTURE',
      p_idempotency_key: `source-stayover-${targetId}`, p_request_hash: '3'.repeat(64)
    }), 'actual create_manual_cleaning_request stayover fixture');
    return { reservationId, targetId, roomId: room.id };
  }
  async function stayoverSnapshot(item) {
    const snapshot = {};
    snapshot.target = ok(await client.from('cleaning_targets').select('*')
      .eq('id', item.targetId).single(), 'source race target snapshot');
    for (const table of ['cleaning_assignments', 'cleaning_target_schedule_revisions', 'notifications']) {
      snapshot[table] = ok(await client.from(table).select('*')
        .eq('cleaning_target_id', item.targetId).order('id'), `source race ${table} snapshot`);
    }
    snapshot.audit = ok(await client.from('audit_events').select('id')
      .eq('entity_id', item.targetId).eq('event_type', 'assignment.rolled_over').order('id'),
    'source race rollover audit snapshot');
    return JSON.stringify(snapshot);
  }
  for (const [index, action] of ['checkout', 'change'].entries()) {
    const item = await stayoverFixture(sourceRooms[index]);
    const before = await stayoverSnapshot(item);
    const reservationCommand = action === 'checkout'
      ? client.rpc('manual_checkout_reservation', {
        p_actor_profile_id: actorProfileId, p_reservation_id: item.reservationId,
        p_expected_version: 1, p_effective_at: rolloverAt,
        p_reason_code: 'SOURCE_WINDOW_RACE',
        p_idempotency_key: `source-checkout-${item.reservationId}`, p_request_hash: '4'.repeat(64)
      })
      : client.rpc('change_reservation', {
        p_actor_profile_id: actorProfileId, p_reservation_id: item.reservationId,
        p_room_id: item.roomId, p_check_in_at: stayCheckIn,
        // 연장 후에도 다음 마감 15:00보다 이르므로 어느 직렬화 순서든 이월은 거부한다.
        p_check_out_at: '2039-10-03T12:00:00+09:00', p_guest_count: 2,
        p_guest_name_mode: 'keep', p_guest_name_encrypted: null, p_expected_version: 1,
        p_reason_code: 'SOURCE_WINDOW_RACE',
        p_idempotency_key: `source-change-${item.reservationId}`, p_request_hash: '5'.repeat(64)
      });
    const race = await Promise.all([
      reservationCommand,
      client.rpc('process_due_assignment_lifecycle', {
        ...lifecycle(`source-${action}`), p_as_of: rolloverAt
      })
    ]);
    for (const result of race) ok(result, `stayover invalid rollover versus ${action}: no deadlock`);
    assert(await stayoverSnapshot(item) === before,
      `stayover invalid rollover versus ${action} keeps schedule/version/assignment/revision/notice/audit unchanged`);
  }

  // 실제 퇴실이 먼저면 같은 batch에서, 나중이면 다음 batch에서 attempt 1건으로 수렴한다.
  const checkoutAt = new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString();
  const checkoutCheckIn = new Date(Date.parse(checkoutAt) - 2 * 86_400_000).toISOString();
  const checkoutReservationId = await reservationFixture(sourceRooms[2], checkoutCheckIn, checkoutAt);
  const obligation = ok(await client.from('checkout_cleaning_obligations')
    .select('planned_cleaning_target_id').eq('reservation_id', checkoutReservationId).single(),
  'checkout activation planned identity');
  const checkoutTargetId = obligation.planned_cleaning_target_id;
  ok(await client.rpc('save_cleaning_assignment_draft', {
    p_actor_profile_id: actorProfileId, p_cleaning_target_id: checkoutTargetId,
    p_maid_profile_id: maids[0], p_sequence_number: sequence++,
    p_expected_assignment_version: 1,
    p_idempotency_key: `source-checkout-draft-${checkoutTargetId}`, p_request_hash: '6'.repeat(64)
  }), 'checkout activation draft command');
  const impact = ok(await client.rpc('get_assignment_commit_impact', {
    p_actor_profile_id: actorProfileId, p_service_date: today
  }), 'checkout activation preflight');
  ok(await client.rpc('commit_and_notify_assignments', {
    p_actor_profile_id: actorProfileId, p_service_date: today,
    p_expected_impact_fingerprint: impact.impactFingerprint,
    p_items: [{ cleaningTargetId: checkoutTargetId, expectedAssignmentVersion: 2, expectedAvailabilityVersion: 1 }],
    p_idempotency_key: `source-checkout-notify-${checkoutTargetId}`, p_request_hash: '7'.repeat(64)
  }), 'checkout activation notify command');
  const checkoutAssignment = ok(await client.from('cleaning_assignments').select('id')
    .eq('cleaning_target_id', checkoutTargetId).eq('is_current', true).single(),
  'checkout activation current assignment');
  const materializationRace = await Promise.all([
    client.rpc('process_due_reservation_transitions', {
      ...lifecycle('checkout-materialize'), p_as_of: checkoutAt
    }),
    client.rpc('process_due_assignment_lifecycle', {
      ...lifecycle('checkout-activate'), p_as_of: checkoutAt
    })
  ]);
  for (const result of materializationRace) ok(result, 'checkout materialization versus activation');
  ok(await client.rpc('process_due_assignment_lifecycle', {
    ...lifecycle('checkout-converge'), p_as_of: checkoutAt
  }), 'checkout activation convergence');
  const checkoutAttempts = ok(await client.from('cleaning_attempts')
    .select('assignment_id,attempt_number').eq('cleaning_target_id', checkoutTargetId),
  'checkout materialization attempts');
  const materialized = ok(await client.from('checkout_cleaning_obligations')
    .select('planned_cleaning_target_id,current_cleaning_target_id,status')
    .eq('reservation_id', checkoutReservationId).single(), 'checkout current identity');
  assert(checkoutAttempts.length === 1 && checkoutAttempts[0].attempt_number === 1 &&
    checkoutAttempts[0].assignment_id === checkoutAssignment.id &&
    materialized.planned_cleaning_target_id === checkoutTargetId &&
    materialized.current_cleaning_target_id === checkoutTargetId && materialized.status === 'materialized',
  'checkout materialization race preserves target/assignment identity and creates exactly attempt one');

  console.log('Attempt activation races PASS: change (3), unassign, cancellation decision, two activation/rollover workers, stayover invalid rollover versus checkout/change, checkout materialization versus activation; exactly-one/fail-closed state preserved.');
}
