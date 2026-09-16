import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function roomMoveSideEffectCounts(cleaningTargetId, reservationId) {
  const output = execFileSync('docker', [
    'exec', '-i', 'supabase_db_room-management-system-backend',
    'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
    '-c', `select (select count(*) from public.notifications where cleaning_target_id='${cleaningTargetId}'::uuid)::text || ',' || (select count(*) from private.notification_delivery_outbox outbox join public.notifications notification on notification.id=outbox.notification_id where notification.cleaning_target_id='${cleaningTargetId}'::uuid)::text || ',' || (select count(*) from public.audit_events where event_type='reservation.room_moved' and entity_type='reservation' and entity_id='${reservationId}'::uuid)::text`
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
  return output.split(',').map(Number);
}

async function room(client, roomNumber) {
  const { data, error } = await client
    .from('rooms')
    .select('id,state_version')
    .eq('room_number', roomNumber)
    .single();
  assert(!error && data, `room ${roomNumber} fixture failed: ${error?.message}`);
  return data;
}

async function createReservation(client, actorProfileId, source, checkInAt, checkOutAt) {
  const reservationId = randomUUID();
  const { data, error } = await client.rpc('create_reservation', {
    p_actor_profile_id: actorProfileId,
    p_reservation_id: reservationId,
    p_room_id: source.id,
    p_check_in_at: checkInAt,
    p_check_out_at: checkOutAt,
    p_guest_count: 2,
    p_guest_name_encrypted: null,
    p_expected_room_version: source.state_version,
    p_idempotency_key: `room-move-create-${randomUUID()}`,
    p_request_hash: randomUUID().replaceAll('-', '').padEnd(64, '0')
  });
  assert(!error && data, `room-move reservation fixture failed: ${error?.message}`);
  return data;
}

async function preview(
  client,
  actorProfileId,
  reservation,
  sourceRoomId,
  targetRoomId,
  effectiveAt = null
) {
  const [sourceResult, targetResult] = await Promise.all([
    client.from('rooms').select('state_version').eq('id', sourceRoomId).single(),
    client.from('rooms').select('state_version').eq('id', targetRoomId).single()
  ]);
  assert(
    !sourceResult.error && sourceResult.data,
    `source room preview fixture failed: ${sourceResult.error?.message}`
  );
  assert(
    !targetResult.error && targetResult.data,
    `target room preview fixture failed: ${targetResult.error?.message}`
  );
  const source = sourceResult.data;
  const target = targetResult.data;
  const { data, error } = await client.rpc('preview_reservation_room_move', {
    p_actor_profile_id: actorProfileId,
    p_reservation_id: reservation.id,
    p_target_room_id: targetRoomId,
    p_expected_reservation_version: reservation.version,
    p_expected_source_room_version: source.state_version,
    p_expected_target_room_version: target.state_version,
    p_effective_at: effectiveAt,
    p_reason_code: 'OPERATIONAL_ADJUSTMENT'
  });
  assert(!error && data?.eligible === true, `room-move preview failed: ${error?.message}`);
  return data;
}

function commitArguments(actorProfileId, previewValue, idempotencyKey, requestHash) {
  return {
    p_actor_profile_id: actorProfileId,
    p_reservation_id: previewValue.reservationId,
    p_target_room_id: previewValue.targetRoomId,
    p_expected_reservation_version: previewValue.reservationVersion,
    p_expected_source_room_version: previewValue.sourceRoomVersion,
    p_expected_target_room_version: previewValue.targetRoomVersion,
    p_preview_evaluated_at: previewValue.evaluatedAt,
    p_preview_expires_at: previewValue.expiresAt,
    p_effective_at: previewValue.effectiveAt,
    p_impact_fingerprint: previewValue.impactFingerprint,
    p_reason_code: 'OPERATIONAL_ADJUSTMENT',
    p_idempotency_key: idempotencyKey,
    p_request_hash: requestHash
  };
}

export async function testReservationRoomMoveConcurrency(
  primaryClient,
  status,
  actorProfileId
) {
  const secondClient = createClient(status.API_URL, status.SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const source = await room(primaryClient, '135');
  const target = await room(primaryClient, '136');
  const reservation = await createReservation(
    primaryClient,
    actorProfileId,
    source,
    '2045-01-01T07:00:00.000Z',
    '2045-01-02T02:00:00.000Z'
  );
  const movePreview = await preview(
    primaryClient,
    actorProfileId,
    reservation,
    source.id,
    target.id
  );
  const sideEffectCountsBefore = roomMoveSideEffectCounts(
    movePreview.plannedCheckoutTargetId,
    reservation.id
  );
  const duplicateArguments = commitArguments(
    actorProfileId,
    movePreview,
    `room-move-duplicate-${randomUUID()}`,
    'a'.repeat(64)
  );
  const duplicateResults = await Promise.all([
    primaryClient.rpc('commit_reservation_room_move', duplicateArguments),
    secondClient.rpc('commit_reservation_room_move', duplicateArguments)
  ]);
  assert(
    duplicateResults.every((result) => !result.error),
    `identical room-move replay failed: ${duplicateResults.map((result) => result.error?.message ?? 'OK').join(',')}`
  );
  assert(
    duplicateResults[0].data.reservation.id === duplicateResults[1].data.reservation.id &&
      duplicateResults[0].data.movedAt === duplicateResults[1].data.movedAt,
    'two sessions must replay one logical room move'
  );
  assert(
    JSON.stringify(roomMoveSideEffectCounts(
      movePreview.plannedCheckoutTargetId,
      reservation.id
    )) === JSON.stringify([
      sideEffectCountsBefore[0],
      sideEffectCountsBefore[1],
      sideEffectCountsBefore[2] + 1
    ]),
    'private room move must append one audit and zero notification or delivery outbox rows'
  );
  const { count: revisionCount, error: revisionError } = await primaryClient
    .from('reservation_schedule_revisions')
    .select('reservation_id', { count: 'exact', head: true })
    .eq('reservation_id', reservation.id);
  assert(!revisionError && revisionCount === 2, 'duplicate commit appends one revision');

  const left = await room(primaryClient, '240');
  const right = await room(primaryClient, '332');
  const leftReservation = await createReservation(
    primaryClient,
    actorProfileId,
    left,
    '2046-01-01T07:00:00.000Z',
    '2046-01-02T02:00:00.000Z'
  );
  const rightReservation = await createReservation(
    primaryClient,
    actorProfileId,
    right,
    '2046-01-03T07:00:00.000Z',
    '2046-01-04T02:00:00.000Z'
  );
  const [leftPreview, rightPreview] = await Promise.all([
    preview(primaryClient, actorProfileId, leftReservation, left.id, right.id),
    preview(secondClient, actorProfileId, rightReservation, right.id, left.id)
  ]);
  const crossingResults = await Promise.all([
    primaryClient.rpc('commit_reservation_room_move', commitArguments(
      actorProfileId,
      leftPreview,
      `room-move-cross-left-${randomUUID()}`,
      'b'.repeat(64)
    )),
    secondClient.rpc('commit_reservation_room_move', commitArguments(
      actorProfileId,
      rightPreview,
      `room-move-cross-right-${randomUUID()}`,
      'c'.repeat(64)
    ))
  ]);
  assert(
    crossingResults.filter((result) => !result.error).length === 1,
    'opposite-direction room locks must serialize to one CAS winner'
  );
  const loser = crossingResults.find((result) => result.error)?.error;
  assert(
    ['SOURCE_ROOM_VERSION_CONFLICT', 'TARGET_ROOM_VERSION_CONFLICT'].includes(loser?.message),
    `opposite-direction loser must be a stable CAS conflict: ${loser?.message}`
  );

  const contenderSourceA = await room(primaryClient, '454');
  const contenderSourceB = await room(primaryClient, '455');
  const sharedTarget = await room(primaryClient, '459');
  const contenderA = await createReservation(
    primaryClient,
    actorProfileId,
    contenderSourceA,
    '2047-01-01T07:00:00.000Z',
    '2047-01-02T02:00:00.000Z'
  );
  const contenderB = await createReservation(
    primaryClient,
    actorProfileId,
    contenderSourceB,
    '2047-01-01T07:00:00.000Z',
    '2047-01-02T02:00:00.000Z'
  );
  const [contenderPreviewA, contenderPreviewB] = await Promise.all([
    preview(
      primaryClient,
      actorProfileId,
      contenderA,
      contenderSourceA.id,
      sharedTarget.id
    ),
    preview(
      secondClient,
      actorProfileId,
      contenderB,
      contenderSourceB.id,
      sharedTarget.id
    )
  ]);
  const sharedTargetResults = await Promise.all([
    primaryClient.rpc('commit_reservation_room_move', commitArguments(
      actorProfileId,
      contenderPreviewA,
      `room-move-shared-target-a-${randomUUID()}`,
      'd'.repeat(64)
    )),
    secondClient.rpc('commit_reservation_room_move', commitArguments(
      actorProfileId,
      contenderPreviewB,
      `room-move-shared-target-b-${randomUUID()}`,
      'e'.repeat(64)
    ))
  ]);
  assert(
    sharedTargetResults.filter((result) => !result.error).length === 1,
    'same-target room moves must serialize to exactly one winner'
  );
  const sharedTargetLoser = sharedTargetResults.find((result) => result.error)?.error;
  assert(
    ['TARGET_ROOM_VERSION_CONFLICT', 'TARGET_ROOM_OVERLAP'].includes(
      sharedTargetLoser?.message
    ),
    `same-target loser must have a stable domain code: ${sharedTargetLoser?.message}`
  );
  const { data: contenderRows, error: contenderRowsError } = await primaryClient
    .from('reservations')
    .select('id,room_id,version,preparation_obligation_id,checkout_obligation_id')
    .in('id', [contenderA.id, contenderB.id]);
  assert(!contenderRowsError && contenderRows?.length === 2, 'contender state lookup failed');
  const targetOccupants = contenderRows.filter((row) => row.room_id === sharedTarget.id);
  const sourceOccupants = contenderRows.filter((row) => row.room_id !== sharedTarget.id);
  assert(
    targetOccupants.length === 1 && sourceOccupants.length === 1,
    'shared target must contain exactly one contender after the race'
  );
  assert(
    targetOccupants[0].version === 2 && sourceOccupants[0].version === 1,
    'losing command must not partially advance its reservation'
  );
  const { data: loserPreparation, error: loserPreparationError } = await primaryClient
    .from('preparation_obligations')
    .select('room_id')
    .eq('id', sourceOccupants[0].preparation_obligation_id)
    .single();
  const { data: loserCheckout, error: loserCheckoutError } = await primaryClient
    .from('checkout_cleaning_obligations')
    .select('room_id')
    .eq('id', sourceOccupants[0].checkout_obligation_id)
    .single();
  assert(
    !loserPreparationError && !loserCheckoutError &&
      loserPreparation.room_id === sourceOccupants[0].room_id &&
      loserCheckout.room_id === sourceOccupants[0].room_id,
    'losing command must not partially move either cleaning obligation'
  );

  const duringSourceA = await room(primaryClient, '531');
  const duringSourceB = await room(primaryClient, '534');
  const duringTarget = await room(primaryClient, '536');
  const duringA = await createReservation(
    primaryClient,
    actorProfileId,
    duringSourceA,
    '2049-01-01T07:00:00.000Z',
    '2049-01-04T02:00:00.000Z'
  );
  const duringB = await createReservation(
    primaryClient,
    actorProfileId,
    duringSourceB,
    '2049-01-01T07:00:00.000Z',
    '2049-01-04T02:00:00.000Z'
  );
  const checkInResults = await Promise.all([
    primaryClient.from('reservations').update({ actual_check_in_at: '2049-01-01T07:00:00.000Z' })
      .eq('id', duringA.id),
    secondClient.from('reservations').update({ actual_check_in_at: '2049-01-01T07:00:00.000Z' })
      .eq('id', duringB.id)
  ]);
  assert(checkInResults.every((result) => !result.error), 'during-stay check-in fixture failed');
  const effectiveAt = '2049-01-02T03:00:00.000Z';
  const [duringPreviewA, duringPreviewB] = await Promise.all([
    preview(primaryClient, actorProfileId, duringA, duringSourceA.id, duringTarget.id, effectiveAt),
    preview(secondClient, actorProfileId, duringB, duringSourceB.id, duringTarget.id, effectiveAt)
  ]);
  assert(
    duringPreviewA.mode === 'DURING_STAY' && duringPreviewB.mode === 'DURING_STAY',
    'checked-in contenders must use DURING_STAY mode'
  );
  const duringResults = await Promise.all([
    primaryClient.rpc('commit_reservation_room_move', commitArguments(
      actorProfileId,duringPreviewA,`during-stay-shared-a-${randomUUID()}`,'f'.repeat(64)
    )),
    secondClient.rpc('commit_reservation_room_move', commitArguments(
      actorProfileId,duringPreviewB,`during-stay-shared-b-${randomUUID()}`,'1'.repeat(64)
    ))
  ]);
  assert(
    duringResults.filter((result) => !result.error).length === 1,
    `same-target DURING_STAY moves must have one winner: ${duringResults.map((result) => result.error?.message ?? 'OK').join(',')}`
  );
  const duringLoser = duringResults.find((result) => result.error)?.error;
  assert(
    ['TARGET_ROOM_VERSION_CONFLICT','TARGET_ROOM_OVERLAP','ROOM_CHANGE_PREVIEW_STALE'].includes(duringLoser?.message),
    `DURING_STAY loser must be a stable CAS/overlap code: ${duringLoser?.message}`
  );
  const targetSegmentCount = Number(execFileSync('docker', [
    'exec','-i','supabase_db_room-management-system-backend','psql','-X','-qAt','-U','postgres','-d','postgres',
    '-v','ON_ERROR_STOP=1','-c',
    `select count(*) from private.stay_room_segments where room_id='${duringTarget.id}'::uuid and starts_at='${effectiveAt}'::timestamptz and retired_at is null`
  ], { encoding: 'utf8', stdio: ['ignore','pipe','inherit'] }).trim());
  assert(targetSegmentCount === 1, 'DURING_STAY target exclusion must leave one segment');

  console.log('reservation room-move replay, UUID-order, shared-target, and DURING_STAY concurrency PASS');
}
