import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export async function testCleaningStartedConcurrency(client, actorProfileId) {
  assert(['localhost', '127.0.0.1'].includes(new URL(client.supabaseUrl).hostname),
    'Started notification race requires disposable local Supabase');
  const sql = (input) => execFileSync('docker', ['exec', '-i', 'supabase_db_room-management-system-backend',
    'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], {
    input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000
  }).trim();
  let sequence = 0;
  function fixture() {
    sequence += 1;
    const item = { maid: randomUUID(), auth: randomUUID(), room: randomUUID(), target: randomUUID(),
      assignment: randomUUID(), attempt: randomUUID() };
    sql(`begin;
      insert into auth.users(id) values('${item.auth}');
      insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,
        login_id,login_id_normalized,login_sequence,role,status,must_change_password)
      values('${item.maid}','${item.auth}','started-${item.maid}','started-${item.maid}',
        'started-${item.maid}','started-${item.maid}',0,'maid','active',false);
      insert into public.rooms(id,room_number,room_type_id,elevator_zone)
      values('${item.room}','${Date.now()}88${sequence}',(select id from public.room_types order by id limit 1),'A');
      insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,
        original_service_date,effective_service_date,available_from,status,assignment_version,
        room_type_snapshot,fee_snapshot,template_snapshot,created_by)
      values('${item.target}','${item.room}','additional','manual_room_request','started-race-${item.target}',
        ((clock_timestamp()-interval '1 minute') at time zone 'Asia/Seoul')::date,
        ((clock_timestamp()-interval '1 minute') at time zone 'Asia/Seoul')::date,
        clock_timestamp()-interval '1 minute','notified',2,'{}',10000,'{}','${actorProfileId}');
      insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,notified_at,changed_by)
      values('${item.assignment}','${item.target}','${item.maid}',1,2,clock_timestamp()-interval '1 minute','${actorProfileId}');
      insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,
        status,assignment_revision,template_snapshot,room_snapshot)
      values('${item.attempt}','${item.target}','${item.assignment}','${item.maid}',1,'scheduled',2,'{}',
        jsonb_build_object('roomId','${item.room}')); commit;`);
    return item;
  }
  const args = (item, key, version = 1) => ({ p_actor_profile_id: item.maid, p_attempt_id: item.attempt,
    p_expected_execution_version: version, p_expected_assignment_id: item.assignment,
    p_expected_assignment_revision: 2, p_idempotency_key: key, p_request_hash: 'a'.repeat(64) });
  const summary = (item) => JSON.parse(sql(`select json_build_object(
    'admins',(select count(*) from public.profiles where role='admin'),
    'pushAdmins',(select count(*) from public.profiles where role='admin' and status='active' and not must_change_password),
    'audit',(select count(*) from public.audit_events where entity_id='${item.attempt}' and event_type='cleaning.attempt_started'),
    'version',(select execution_version from public.cleaning_attempts where id='${item.attempt}'),
    'notices',count(n.id),'deliveries',count(o.id),'recipientCount',count(distinct n.recipient_profile_id),
    'valid',bool_and(not n.requires_action and n.resolved_at is null and n.actor_profile_id='${item.maid}'
      and n.category='cleaning_started' and n.source_entity_kind='cleaning_attempt'
      and n.cleaning_target_id='${item.target}' and n.room_id='${item.room}'
      and n.deep_link_kind='cleaningTarget' and n.deep_link_entity_id='${item.target}'),
    'ids',json_agg(n.id order by n.id))
    from public.notifications n left join private.notification_delivery_outbox o on o.notification_id=n.id
    where n.event_family='cleaning.started_admin' and n.source_entity_id='${item.attempt}'`));
  const verify = (item) => {
    const state = summary(item);
    assert.equal(state.audit, 1, 'Exactly one immutable start audit');
    assert.equal(state.version, 2, 'Exactly one execution CAS transition');
    assert.equal(state.notices, state.admins, 'Exactly one inbox per business admin');
    assert.equal(state.recipientCount, state.admins, 'No duplicate recipient enrollment');
    assert.equal(state.deliveries, state.pushAdmins, 'Exactly one push intent per eligible nonself admin');
    assert.equal(state.valid, true, 'Every new notice has exact safe source and informational semantics');
    return state;
  };
  const same = fixture();
  const key = randomUUID();
  const replays = await Promise.all(Array.from({ length: 8 }, () => client.rpc('start_cleaning_attempt', args(same, key))));
  for (const response of replays) {
    assert.equal(response.error, null, 'Concurrent same-key public start must succeed');
    assert.deepEqual(response.data, replays[0].data, 'Concurrent same-key start replays exact response');
  }
  const beforeReplay = verify(same);
  const replay = await client.rpc('start_cleaning_attempt', args(same, key));
  assert.equal(replay.error, null);
  assert.deepEqual(replay.data, replays[0].data);
  assert.deepEqual(summary(same), beforeReplay, 'Replay preserves every notification identity');
  const different = fixture();
  const winners = await Promise.all(Array.from({ length: 4 }, () =>
    client.rpc('start_cleaning_attempt', args(different, randomUUID()))));
  assert.equal(winners.filter((response) => !response.error).length, 1, 'Different-key same-CAS race has one winner');
  assert(winners.filter((response) => response.error).every((response) => response.error.message === 'ATTEMPT_VERSION_CONFLICT'));
  verify(different);
  for (const item of [same, different]) {
    const result = await client.rpc('complete_cleaning_attempt_field_work', args(item, randomUUID(), 2));
    assert.equal(result.error, null, 'Finish isolated race fixture without changing inspection state');
  }
  console.log('Cleaning started notifications: actual 8-way same-key and 4-way CAS races PASS.');
}
