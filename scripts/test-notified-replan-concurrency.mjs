import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { configureRoomPinForConcurrency } from './test-room-pin-concurrency.mjs';

function assert(value, message) {
  if (!value) throw new Error(message);
}

function ok(result, label) {
  assert(!result.error, `${label}: ${result.error?.code ?? ''}:${result.error?.message ?? ''}`);
  return result.data;
}

function sqlScalar(sql) {
  return execFileSync('docker', [
    'exec', '-i', 'supabase_db_room-management-system-backend',
    'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'postgres', '-c', sql
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
}

function kstDate(value) {
  return new Date(value.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}

function previousKstDate(value) {
  const date = new Date(`${kstDate(value)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function weekStart(serviceDate) {
  const date = new Date(`${serviceDate}T00:00:00Z`);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date.toISOString().slice(0, 10);
}

export async function testNotifiedReplanConcurrency(client, actor) {
  const actorProfileId = actor.profileId;
  const rooms = ok(await client.from('rooms').select('id,room_number,state_version')
    .order('room_number').range(100, 106), 'notified replan rooms');
  assert(rooms.length === 7, 'notified replan needs seven isolated rooms');

  const checkoutAt = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 60_000);
  const commandAt = new Date(checkoutAt.getTime() + 60_000);
  const extendedCheckoutAt = new Date(commandAt.getTime() + 86_400_000);
  const plannedCheckoutAt = new Date(commandAt.getTime() + 2 * 86_400_000);
  const plannedChangedCheckoutAt = new Date(commandAt.getTime() + 3 * 86_400_000);
  const checkInAt = `${previousKstDate(checkoutAt)}T16:00:00+09:00`;
  const serviceDates = [...new Set([
    kstDate(checkoutAt), kstDate(extendedCheckoutAt),
    kstDate(plannedCheckoutAt), kstDate(plannedChangedCheckoutAt)
  ])];
  let sequence = 800;

  async function createMaid(label) {
    const authId = randomUUID();
    const maidId = randomUUID();
    ok(await client.auth.admin.createUser({
      id: authId,
      email: `notified-replan-${authId}@test.invalid`,
      password: `T:${randomUUID()}`,
      email_confirm: true
    }), `${label} maid auth`);
    ok(await client.from('profiles').insert({
      id: maidId,
      auth_user_id: authId,
      display_name: `notified-replan-${label}`,
      display_name_normalized: `notified-replan-${label}`,
      login_id: `notified-replan-${authId}`,
      login_id_normalized: `notified-replan-${authId}`,
      login_sequence: 0,
      role: 'maid',
      status: 'active',
      must_change_password: false
    }), `${label} maid profile`);
    for (const week of new Set(serviceDates.map(weekStart))) {
      const availabilityId = randomUUID();
      ok(await client.from('availability_versions').insert({
        id: availabilityId,
        maid_profile_id: maidId,
        week_start: week,
        version: 1,
        status: 'submitted',
        is_current: true,
        submitted_at: commandAt.toISOString()
      }), `${label} availability`);
      ok(await client.from('availability_days').insert(Array.from({ length: 7 }, (_, offset) => {
        const date = new Date(`${week}T00:00:00Z`);
        date.setUTCDate(date.getUTCDate() + offset);
        return {
          availability_version_id: availabilityId,
          work_date: date.toISOString().slice(0, 10),
          available: true
        };
      })), `${label} availability days`);
    }
    return maidId;
  }

  async function fixture(index, label) {
    const room = rooms[index];
    const maidId = await createMaid(label);
    const reservationId = randomUUID();
    await configureRoomPinForConcurrency(client, actor, {
      id: room.id,
      roomNumber: room.room_number
    });
    const currentRoom = ok(await client.from('rooms').select('state_version')
      .eq('id', room.id).single(), `${label} room version`);
    ok(await client.rpc('create_reservation', {
      p_actor_profile_id: actorProfileId,
      p_reservation_id: reservationId,
      p_room_id: room.id,
      p_check_in_at: checkInAt,
      p_check_out_at: checkoutAt.toISOString(),
      p_guest_count: 2,
      p_guest_name_encrypted: null,
      p_expected_room_version: currentRoom.state_version,
      p_idempotency_key: `notified-replan-create-${reservationId}`,
      p_request_hash: '2'.repeat(64)
    }), `${label} reservation`);
    const obligation = ok(await client.from('checkout_cleaning_obligations')
      .select('planned_cleaning_target_id').eq('reservation_id', reservationId).single(),
    `${label} planned target`);
    const targetId = obligation.planned_cleaning_target_id;
    const draft = ok(await client.rpc('save_cleaning_assignment_draft', {
      p_actor_profile_id: actorProfileId,
      p_cleaning_target_id: targetId,
      p_maid_profile_id: maidId,
      p_sequence_number: sequence++,
      p_expected_assignment_version: 1,
      p_idempotency_key: `notified-replan-draft-${reservationId}`,
      p_request_hash: '3'.repeat(64)
    }), `${label} draft`);
    sqlScalar(`update public.cleaning_targets set status='notified' where id='${targetId}'::uuid;
      update public.cleaning_assignments set notified_at='${commandAt.toISOString()}'::timestamptz
      where id='${draft.assignmentId}'::uuid;`);
    ok(await client.rpc('process_due_reservation_transitions', {
      p_actor_profile_id: actorProfileId,
      p_as_of: commandAt.toISOString(),
      p_idempotency_key: `notified-replan-checkout-${reservationId}`,
      p_request_hash: '4'.repeat(64)
    }), `${label} scheduled checkout`);
    const checkedOut = ok(await client.from('reservations').select('version,status')
      .eq('id', reservationId).single(), `${label} checked-out reservation`);
    assert(checkedOut.status === 'checked_out', `${label} reservation is materialized before the race`);
    const target = ok(await client.from('cleaning_targets')
      .select('template_snapshot,room_type_snapshot').eq('id', targetId).single(),
    `${label} target snapshot`);
    const attemptId = randomUUID();
    ok(await client.from('cleaning_attempts').insert({
      id: attemptId,
      cleaning_target_id: targetId,
      assignment_id: draft.assignmentId,
      maid_profile_id: maidId,
      attempt_number: 1,
      status: 'scheduled',
      assignment_revision: 2,
      template_snapshot: target.template_snapshot,
      room_snapshot: { ...target.room_type_snapshot, roomId: room.id },
      created_at: commandAt.toISOString(),
      updated_at: commandAt.toISOString()
    }), `${label} scheduled attempt`);
    return {
      roomId: room.id,
      reservationId,
      reservationVersion: checkedOut.version,
      targetId,
      assignmentId: draft.assignmentId,
      attemptId,
      maidId
    };
  }

  function changeArgs(item, key, hash) {
    return {
      p_actor_profile_id: actorProfileId,
      p_reservation_id: item.reservationId,
      p_room_id: item.roomId,
      p_check_in_at: checkInAt,
      p_check_out_at: extendedCheckoutAt.toISOString(),
      p_guest_count: 2,
      p_guest_name_mode: 'keep',
      p_guest_name_encrypted: null,
      p_expected_version: item.reservationVersion,
      p_reason_code: 'NOTIFIED_LATE_CHECKOUT_REPLAN',
      p_idempotency_key: key,
      p_request_hash: hash
    };
  }

  for (let repeat = 0; repeat < 3; repeat += 1) {
    const item = await fixture(repeat, `start-race-${repeat}`);
    const race = await Promise.all([
      client.rpc('change_reservation', changeArgs(item,
        `notified-replan-change-race-${item.reservationId}`, '5'.repeat(64))),
      client.rpc('start_cleaning_attempt', {
        p_actor_profile_id: item.maidId,
        p_attempt_id: item.attemptId,
        p_expected_execution_version: 1,
        p_expected_assignment_id: item.assignmentId,
        p_expected_assignment_revision: 2,
        p_idempotency_key: `notified-replan-start-race-${item.reservationId}`,
        p_request_hash: '6'.repeat(64)
      })
    ]);
    assert(race.every((result) => result.error?.code !== '40P01'),
      `notified replan/start race ${repeat} has no deadlock`);
    assert(race.filter((result) => !result.error).length === 1,
      `notified replan/start race ${repeat} has one winner`);
    assert(race.filter((result) => result.error).every((result) =>
      /ASSIGNMENT_VERSION_CONFLICT|RESERVATION_EXTENSION_ACCESS_CONFLICT/.test(result.error.message)),
    `notified replan/start race ${repeat} has a stable domain/CAS loser: ${JSON.stringify(race.map((result) => ({ code: result.error?.code, message: result.error?.message })))}`);
    const assignments = ok(await client.from('cleaning_assignments').select('id,is_current')
      .eq('cleaning_target_id', item.targetId), `start race ${repeat} assignments`);
    const noticeCount = Number(sqlScalar(`select count(*) from public.notifications
      where cleaning_target_id='${item.targetId}'::uuid
        and event_family='reservation.extension_revoked'`));
    assert(assignments.length === 1 &&
      assignments.filter((row) => row.is_current).length === (race[0].error ? 1 : 0) &&
      noticeCount === (race[0].error ? 0 : 1),
    `post-checkout extension/start race ${repeat} commits only winner side effects`);
  }

  for (let repeat = 0; repeat < 3; repeat += 1) {
    const item = await fixture(repeat + 3, `retry-race-${repeat}`);
    const key = `notified-replan-retry-${item.reservationId}`;
    const hash = '7'.repeat(64);
    const race = await Promise.all([
      client.rpc('change_reservation', changeArgs(item, key, hash)),
      client.rpc('change_reservation', changeArgs(item, key, hash))
    ]);
    assert(race.every((result) => !result.error),
      `identical notified replan retry ${repeat} succeeds without deadlock`);
    assert(new Set(race.map((result) => JSON.stringify(result.data))).size === 1,
      `identical notified replan retry ${repeat} returns one logical response`);
    ok(await client.rpc('change_reservation', changeArgs(item, key, hash)),
      `identical notified replan post-race replay ${repeat}`);
    const assignments = ok(await client.from('cleaning_assignments').select('id,is_current')
      .eq('cleaning_target_id', item.targetId), `retry race ${repeat} assignments`);
    const revisions = ok(await client.from('cleaning_target_schedule_revisions').select('id')
      .eq('cleaning_target_id', item.targetId)
      .eq('reason_code', 'RESERVATION_EXTENDED'), `retry race ${repeat} revisions`);
    const noticeId = sqlScalar(`select id from public.notifications
      where cleaning_target_id='${item.targetId}'::uuid
        and event_family='reservation.extension_revoked'`);
    assert(assignments.length === 1 && assignments.filter((row) => row.is_current).length === 0 &&
      revisions.length === 1 && noticeId.length === 36,
    `identical post-checkout extension retry ${repeat} creates one revocation revision and notification`);
    const typed = Number(sqlScalar(`select count(*) from private.notification_delivery_outbox
      where notification_id='${noticeId}'::uuid`));
    const legacy = Number(sqlScalar(`select count(*) from private.notification_outbox o
      join public.notifications n on n.id=o.notification_id
      where n.cleaning_target_id='${item.targetId}'::uuid`));
    assert(typed === 1, `identical notified replan retry ${repeat} creates one typed delivery`);
    assert(legacy === 0, `identical notified replan retry ${repeat} creates no legacy outbox row`);
  }

  const plannedRoom = rooms[6];
  const plannedMaidId = await createMaid('planned-retry');
  const plannedReservationId = randomUUID();
  await configureRoomPinForConcurrency(client, actor, {
    id: plannedRoom.id,
    roomNumber: plannedRoom.room_number
  });
  const plannedRoomCurrent = ok(await client.from('rooms').select('state_version')
    .eq('id', plannedRoom.id).single(), 'planned retry room version');
  const plannedCheckInAt = `${previousKstDate(plannedCheckoutAt)}T16:00:00+09:00`;
  ok(await client.rpc('create_reservation', {
    p_actor_profile_id: actorProfileId,
    p_reservation_id: plannedReservationId,
    p_room_id: plannedRoom.id,
    p_check_in_at: plannedCheckInAt,
    p_check_out_at: plannedCheckoutAt.toISOString(),
    p_guest_count: 2,
    p_guest_name_encrypted: null,
    p_expected_room_version: plannedRoomCurrent.state_version,
    p_idempotency_key: `notified-replan-create-${plannedReservationId}`,
    p_request_hash: '9'.repeat(64)
  }), 'planned retry reservation');
  const plannedObligation = ok(await client.from('checkout_cleaning_obligations')
    .select('planned_cleaning_target_id').eq('reservation_id', plannedReservationId).single(),
  'planned retry target');
  const plannedTargetId = plannedObligation.planned_cleaning_target_id;
  const plannedDraft = ok(await client.rpc('save_cleaning_assignment_draft', {
    p_actor_profile_id: actorProfileId,
    p_cleaning_target_id: plannedTargetId,
    p_maid_profile_id: plannedMaidId,
    p_sequence_number: sequence++,
    p_expected_assignment_version: 1,
    p_idempotency_key: `notified-replan-draft-${plannedReservationId}`,
    p_request_hash: 'a'.repeat(64)
  }), 'planned retry draft');
  sqlScalar(`update public.cleaning_targets set status='notified' where id='${plannedTargetId}'::uuid;
    update public.cleaning_assignments set notified_at='${commandAt.toISOString()}'::timestamptz
    where id='${plannedDraft.assignmentId}'::uuid;`);
  const plannedKey = `notified-replan-identical-${plannedReservationId}`;
  const plannedHash = 'b'.repeat(64);
  const plannedArgs = {
    p_actor_profile_id: actorProfileId,
    p_reservation_id: plannedReservationId,
    p_room_id: plannedRoom.id,
    p_check_in_at: plannedCheckInAt,
    p_check_out_at: plannedChangedCheckoutAt.toISOString(),
    p_guest_count: 2,
    p_guest_name_mode: 'keep',
    p_guest_name_encrypted: null,
    p_expected_version: 1,
    p_reason_code: 'NOTIFIED_LATE_CHECKOUT_REPLAN',
    p_idempotency_key: plannedKey,
    p_request_hash: plannedHash
  };
  const plannedRetries = await Promise.all(Array.from({ length: 4 }, () =>
    client.rpc('change_reservation', plannedArgs)));
  assert(plannedRetries.every((result) => !result.error),
    `pre-checkout identical replan retries succeed: ${JSON.stringify(plannedRetries.map((result) => result.error))}`);
  assert(new Set(plannedRetries.map((result) => JSON.stringify(result.data))).size === 1,
    'pre-checkout identical replan retries return one logical response');
  ok(await client.rpc('change_reservation', plannedArgs), 'pre-checkout post-race replay');
  const plannedAssignments = ok(await client.from('cleaning_assignments').select('id,is_current')
    .eq('cleaning_target_id', plannedTargetId), 'pre-checkout retry assignments');
  const plannedRevisions = ok(await client.from('cleaning_target_schedule_revisions').select('id')
    .eq('cleaning_target_id', plannedTargetId)
    .eq('reason_code', 'RESERVATION_SCHEDULE_CHANGED'), 'pre-checkout retry revisions');
  const plannedNoticeId = sqlScalar(`select id from public.notifications
    where cleaning_target_id='${plannedTargetId}'::uuid
      and event_family='reservation.notified_schedule_changed'`);
  assert(plannedAssignments.length === 2 &&
    plannedAssignments.filter((row) => row.is_current).length === 1 &&
    plannedRevisions.length === 1 && plannedNoticeId.length === 36,
  'pre-checkout retries create one immutable revision and one replacement notification');
  assert(Number(sqlScalar(`select count(*) from private.notification_delivery_outbox
    where notification_id='${plannedNoticeId}'::uuid`)) === 1,
  'pre-checkout retries create one typed delivery');
  assert(Number(sqlScalar(`select count(*) from private.notification_outbox o
    join public.notifications n on n.id=o.notification_id
    where n.cleaning_target_id='${plannedTargetId}'::uuid`)) === 0,
  'pre-checkout retries create no legacy outbox row');

  console.log('Notified replan concurrency passed: post-checkout extension/start x3 and retry x3 plus pre-checkout identical retry x4; 40P01=0, stable losers, one immutable replan revision/notification/typed delivery.');
}
