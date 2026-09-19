begin;

select plan(20);

insert into auth.users (id) values
  ('71000000-0000-4000-8000-000000000101'),
  ('71000000-0000-4000-8000-000000000102'),
  ('71000000-0000-4000-8000-000000000103');

insert into public.profiles (
  id, auth_user_id, display_name, display_name_normalized,
  login_id, login_id_normalized, login_sequence, role, status,
  must_change_password
) values
  ('71000000-0000-4000-8000-000000000201', '71000000-0000-4000-8000-000000000101',
   '이벤트 관리자', '이벤트 관리자', '이벤트 관리자', '이벤트 관리자', 0,
   'admin', 'active', false),
  ('71000000-0000-4000-8000-000000000202', '71000000-0000-4000-8000-000000000102',
   '이벤트 메이드', '이벤트 메이드', '이벤트 메이드', '이벤트 메이드', 0,
   'maid', 'active', false),
  ('71000000-0000-4000-8000-000000000203', '71000000-0000-4000-8000-000000000103',
   '임시 비밀번호 관리자', '임시 비밀번호 관리자', '임시 비밀번호 관리자', '임시 비밀번호 관리자', 0,
   'admin', 'active', true);

insert into auth.sessions (id, user_id) values
  ('71000000-0000-4000-8000-000000000301', '71000000-0000-4000-8000-000000000101'),
  ('71000000-0000-4000-8000-000000000302', '71000000-0000-4000-8000-000000000102'),
  ('71000000-0000-4000-8000-000000000303', '71000000-0000-4000-8000-000000000103');

create temporary table room_event_fixture as
select
  (select id from public.rooms where room_number = '117') as room_id,
  (select id from public.rooms where room_number = '118') as other_room_id;

create temporary table room_event_results (name text primary key, value jsonb not null);

insert into room_event_results values (
  'first-command',
  public.mutate_room_operation(
    '71000000-0000-4000-8000-000000000201',
    (select room_id from room_event_fixture),
    'set_candle_count',
    (select state_version from public.rooms where id = (select room_id from room_event_fixture)),
    'TIMELINE_REPLAY',
    jsonb_build_object('count', 0, 'physicallyVerified', true),
    'room-event-replay-0001', repeat('1', 64)
  )
);

insert into room_event_results values (
  'replayed-command',
  public.mutate_room_operation(
    '71000000-0000-4000-8000-000000000201',
    (select room_id from room_event_fixture),
    'set_candle_count',
    ((select value ->> 'room_state_version' from room_event_results where name = 'first-command')::bigint - 1),
    'TIMELINE_REPLAY',
    jsonb_build_object('count', 0, 'physicallyVerified', true),
    'room-event-replay-0001', repeat('1', 64)
  )
);

insert into public.audit_events (
  actor_profile_id, actor_display_name_snapshot, event_type, entity_type,
  entity_id, effective_at, recorded_at, reason_code, before_state, after_state
)
select
  '71000000-0000-4000-8000-000000000201', '이벤트 관리자',
  'room.set_candle_count', 'room', (select room_id from room_event_fixture),
  clock_timestamp() - make_interval(secs => series),
  clock_timestamp() - make_interval(secs => series),
  'BULK_' || lpad(series::text, 2, '0'),
  jsonb_build_object('rawPin', 'must-not-leak'),
  jsonb_build_object('count', series, 'guestName', 'must-not-leak', 'requestBody', 'must-not-leak')
from generate_series(1, 51) series;

insert into public.audit_events (
  actor_profile_id, event_type, entity_type, entity_id, effective_at,
  recorded_at, reason_code, after_state
) values (
  '71000000-0000-4000-8000-000000000201', 'room.set_candle_count', 'room',
  (select other_room_id from room_event_fixture), clock_timestamp() + interval '2 minutes',
  clock_timestamp(), 'OTHER_ROOM_ONLY', jsonb_build_object('count', 7)
);

insert into public.reservations (
  id, room_id, reservation_type, check_in_at, check_out_at, guest_count,
  created_by, updated_by
) values (
  '71000000-0000-4000-8000-000000000401',
  (select room_id from room_event_fixture), 'standard',
  '2030-01-01T06:00:00Z', '2030-01-02T02:00:00Z', 2,
  '71000000-0000-4000-8000-000000000201',
  '71000000-0000-4000-8000-000000000201'
);

insert into public.room_occupancy_events (
  id, event_key, room_id, reservation_id, event_type, effective_at,
  recorded_at, actor_profile_id, reason_code, before_state, after_state
) values (
  '71000000-0000-4000-8000-000000000501', 'room-event-timeline:occupancy',
  (select room_id from room_event_fixture),
  '71000000-0000-4000-8000-000000000401', 'scheduled_check_in',
  clock_timestamp() + interval '1 minute', clock_timestamp(),
  '71000000-0000-4000-8000-000000000201', 'SCHEDULED_TRANSITION',
  jsonb_build_object('occupied', false, 'guestName', 'must-not-leak'),
  jsonb_build_object('occupied', true, 'guestName', 'must-not-leak')
);

insert into room_event_results values (
  'timeline',
  public.list_room_events(
    '71000000-0000-4000-8000-000000000201',
    '71000000-0000-4000-8000-000000000301',
    (select room_id from room_event_fixture), 50
  )
);

insert into room_event_results values (
  'timeline-replay',
  public.list_room_events(
    '71000000-0000-4000-8000-000000000201',
    '71000000-0000-4000-8000-000000000301',
    (select room_id from room_event_fixture), 50
  )
);

select is(
  (select value ->> 'roomId' from room_event_results where name = 'timeline'),
  (select room_id::text from room_event_fixture),
  'timeline identifies the requested room'
);
select is(
  (select (value ->> 'roomStateVersion')::bigint from room_event_results where name = 'timeline'),
  (select state_version from public.rooms where id = (select room_id from room_event_fixture)),
  'timeline returns the current room state version'
);
select is(
  jsonb_array_length((select value -> 'items' from room_event_results where name = 'timeline')),
  50,
  'timeline is capped at fifty items'
);
select is(
  (select value #>> '{items,0,source}' from room_event_results where name = 'timeline'),
  'occupancy',
  'events are ordered newest first across both ledgers'
);
select is(
  (select count(*)::integer from room_event_results result,
    jsonb_array_elements(result.value -> 'items') item
    where result.name = 'timeline' and item ->> 'reasonCode' = 'OTHER_ROOM_ONLY'),
  0,
  'events from another room are excluded'
);
select is(
  (select count(*)::integer from public.audit_events
   where entity_type = 'room'
     and entity_id = (select room_id from room_event_fixture)
     and reason_code = 'TIMELINE_REPLAY'),
  1,
  'command replay does not duplicate the audit event'
);
select is(
  (select item ->> 'eventKey'
   from room_event_results result,
     lateral jsonb_array_elements(result.value -> 'items') item
   where result.name = 'timeline' and item ->> 'reasonCode' = 'TIMELINE_REPLAY'),
  (select item ->> 'eventKey'
   from room_event_results result,
     lateral jsonb_array_elements(result.value -> 'items') item
   where result.name = 'timeline-replay' and item ->> 'reasonCode' = 'TIMELINE_REPLAY'),
  'command replay keeps the stable source-qualified event key'
);
select ok(
  (select
     item ->> 'eventKey' = 'room_command:' || audit.id::text
     and item ->> 'category' = 'room_candle'
     and item ->> 'actorProfileId' = audit.actor_profile_id::text
     and item ->> 'actorDisplayName' = audit.actor_display_name_snapshot
     and item ->> 'entityId' = audit.entity_id::text
     and (item ->> 'effectiveAt')::timestamptz = audit.effective_at
     and (item ->> 'recordedAt')::timestamptz = audit.recorded_at
   from room_event_results result,
     lateral jsonb_array_elements(result.value -> 'items') item
     join public.audit_events audit
       on item ->> 'eventKey' = 'room_command:' || audit.id::text
   where result.name = 'timeline' and item ->> 'reasonCode' = 'TIMELINE_REPLAY'),
  'command projection identity, category, actor, entity, and timestamps match the audit ledger'
);
select is(
  (select item ->> 'eventKey'
   from room_event_results result,
     lateral jsonb_array_elements(result.value -> 'items') item
   where result.name = 'timeline' and item ->> 'source' = 'occupancy'),
  'occupancy:71000000-0000-4000-8000-000000000501',
  'occupancy event key is stable and source-qualified'
);
select ok(
  (select
     item ->> 'category' = 'occupancy'
     and item ->> 'actorProfileId' = occupancy.actor_profile_id::text
     and (item -> 'actorDisplayName') = 'null'::jsonb
     and item ->> 'entityId' = occupancy.reservation_id::text
     and item ->> 'reservationId' = occupancy.reservation_id::text
     and (item ->> 'effectiveAt')::timestamptz = occupancy.effective_at
     and (item ->> 'recordedAt')::timestamptz = occupancy.recorded_at
   from room_event_results result,
     lateral jsonb_array_elements(result.value -> 'items') item
     join public.room_occupancy_events occupancy
       on item ->> 'eventKey' = 'occupancy:' || occupancy.id::text
   where result.name = 'timeline' and item ->> 'source' = 'occupancy'),
  'occupancy projection actor, entity, reservation, and timestamps match the occupancy ledger'
);
select ok(
  (select value::text not like '%must-not-leak%' from room_event_results where name = 'timeline'),
  'raw before/after state fields are not exposed'
);
select is(
  jsonb_array_length(public.list_room_events(
    '71000000-0000-4000-8000-000000000201',
    '71000000-0000-4000-8000-000000000301',
    (select room_id from room_event_fixture), 1
  ) -> 'items'),
  1,
  'caller can request a one-item bounded page'
);
select throws_ok(
  $$select public.list_room_events(
    '71000000-0000-4000-8000-000000000201',
    '71000000-0000-4000-8000-000000000301',
    (select room_id from room_event_fixture), 0)$$,
  '22023', 'INVALID_ROOM_EVENT_LIMIT', 'zero limit is rejected'
);
select throws_ok(
  $$select public.list_room_events(
    '71000000-0000-4000-8000-000000000201',
    '71000000-0000-4000-8000-000000000301',
    (select room_id from room_event_fixture), 51)$$,
  '22023', 'INVALID_ROOM_EVENT_LIMIT', 'limit above fifty is rejected'
);
select throws_ok(
  $$select public.list_room_events(
    '71000000-0000-4000-8000-000000000201',
    '71000000-0000-4000-8000-000000000301',
    '71000000-0000-4000-8000-000000000999', 30)$$,
  'P0002', 'ROOM_NOT_FOUND', 'unknown room is rejected'
);
select throws_ok(
  $$select public.list_room_events(
    '71000000-0000-4000-8000-000000000202',
    '71000000-0000-4000-8000-000000000302',
    (select room_id from room_event_fixture), 30)$$,
  '42501', 'ADMIN_REQUIRED', 'maid cannot read room events'
);
select throws_ok(
  $$select public.list_room_events(
    '71000000-0000-4000-8000-000000000203',
    '71000000-0000-4000-8000-000000000303',
    (select room_id from room_event_fixture), 30)$$,
  '42501', 'PASSWORD_CHANGE_REQUIRED', 'temporary-password admin cannot read room events'
);
select throws_ok(
  $$select public.list_room_events(
    '71000000-0000-4000-8000-000000000201',
    '71000000-0000-4000-8000-000000000399',
    (select room_id from room_event_fixture), 30)$$,
  '42501', 'SESSION_REVOKED', 'unknown session cannot read room events'
);
select ok(
  has_function_privilege('service_role', 'public.list_room_events(uuid,uuid,uuid,integer)', 'EXECUTE'),
  'service role can execute the projection'
);
select ok(
  not has_function_privilege('authenticated', 'public.list_room_events(uuid,uuid,uuid,integer)', 'EXECUTE'),
  'authenticated cannot execute the privileged projection directly'
);

select * from finish();
rollback;
