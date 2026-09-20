begin;
select no_plan();

create function pg_temp.did(n integer) returns uuid language sql immutable as $$
  select ('d2360000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
$$;

insert into auth.users(id) values (pg_temp.did(101)), (pg_temp.did(102));
select public.bootstrap_first_developer_profile(
  pg_temp.did(1), pg_temp.did(101), '객실 기준 개발자', '객실 기준 개발자',
  '0101', repeat('1',64), 'room-catalog-bootstrap-236'
);
insert into public.profiles(
  id, auth_user_id, display_name, display_name_normalized, login_id,
  login_id_normalized, login_sequence, role, status, must_change_password
) values
  (pg_temp.did(2), pg_temp.did(102), '객실 기준 관리자', '객실 기준 관리자',
   'room-catalog-admin', 'room-catalog-admin', 0, 'admin', 'active', false);

select is(
  (public.get_developer_room_catalog(pg_temp.did(1))->'summary'->>'total')::integer,
  121,
  'developer catalog returns the current room total'
);
select ok(
  (public.get_developer_room_catalog(pg_temp.did(1))->'roomTypes'->0)
    ?& array['baseOccupancy','maxOccupancy','version','roomCount']
  and not ((public.get_developer_room_catalog(pg_temp.did(1))->'rooms'->0)
    ?| array['reservationId','guestName','pinSyncStatus','cleaningRequired']),
  'developer catalog returns capacity and omits operational or sensitive fields'
);
select throws_ok(
  format('select public.get_developer_room_catalog(%L)', pg_temp.did(2)),
  '42501', 'DEVELOPER_REQUIRED',
  'business admin cannot use the developer catalog'
);

select throws_ok(
  format(
    'select public.preview_developer_room_type_capacity(%L,(select id from public.room_types where code=''standard''),0,2,1)',
    pg_temp.did(1)
  ),
  '22023', 'ROOM_TYPE_CAPACITY_INVALID',
  'zero base occupancy is rejected'
);
select throws_ok(
  format(
    'select public.preview_developer_room_type_capacity(%L,(select id from public.room_types where code=''standard''),3,2,1)',
    pg_temp.did(1)
  ),
  '22023', 'ROOM_TYPE_CAPACITY_INVALID',
  'base occupancy above maximum is rejected'
);

create temporary table capacity_preview as
select public.preview_developer_room_type_capacity(
  pg_temp.did(1),
  (select id from public.room_types where code='standard'),
  2, 3, 1
) value;

select is(
  (select (value->>'exceedingActiveReservationCount')::integer from capacity_preview),
  0,
  'capacity preview reports no conflicting active reservations'
);

create temporary table capacity_change as
select public.change_developer_room_type_capacity(
  pg_temp.did(1),
  (select id from public.room_types where code='standard'),
  2, 3, 1,
  (select value->>'impactFingerprint' from capacity_preview),
  'CAPACITY_POLICY_CHANGE', 'capacity-change-236', repeat('a',64)
) value;

select is(
  (select (value->'roomType'->>'version')::integer from capacity_change),
  2,
  'capacity commit advances the room type version'
);
select is(
  public.change_developer_room_type_capacity(
    pg_temp.did(1),
    (select id from public.room_types where code='standard'),
    2, 3, 1,
    (select value->>'impactFingerprint' from capacity_preview),
    'CAPACITY_POLICY_CHANGE', 'capacity-change-236', repeat('a',64)
  ),
  (select value from capacity_change),
  'same idempotency key and body replays the original capacity result'
);
select throws_ok(
  format(
    'select public.change_developer_room_type_capacity(%L,(select id from public.room_types where code=''standard''),2,3,1,%L,''CAPACITY_POLICY_CHANGE'',''capacity-change-236'',repeat(''b'',64))',
    pg_temp.did(1), (select value->>'impactFingerprint' from capacity_preview)
  ),
  '23505', 'IDEMPOTENCY_KEY_REUSED',
  'same idempotency key with another request hash is rejected'
);
select throws_ok(
  format(
    'select public.preview_developer_room_type_capacity(%L,(select id from public.room_types where code=''standard''),2,3,1)',
    pg_temp.did(1)
  ),
  '40001', 'ROOM_TYPE_VERSION_CONFLICT',
  'stale room type version is rejected'
);
select throws_ok(
  format(
    'select public.change_developer_room_type_capacity(%L,(select id from public.room_types where code=''standard''),2,3,2,repeat(''0'',64),''CAPACITY_POLICY_CHANGE'',''capacity-stale-preview-236'',repeat(''7'',64))',
    pg_temp.did(1)
  ),
  '40001', 'ROOM_TYPE_CAPACITY_PREVIEW_STALE',
  'unknown capacity impact fingerprint is rejected'
);

select public.create_reservation_v2(
  pg_temp.did(2), pg_temp.did(21),
  (select room.id from public.rooms room join public.room_types room_type
   on room_type.id=room.room_type_id
   where room_type.code='standard' and room.active
   order by room.room_number limit 1),
  'long_stay', '2036-02-01 16:00:00+09', null, 3, null,
  (select room.state_version from public.rooms room join public.room_types room_type
   on room_type.id=room.room_type_id
   where room_type.code='standard' and room.active
   order by room.room_number limit 1),
  'capacity-existing-reservation-236', repeat('9',64)
);
create temporary table conflicting_capacity_preview as
select public.preview_developer_room_type_capacity(
  pg_temp.did(1),
  (select id from public.room_types where code='standard'),
  2, 2, 2
) value;
select is(
  (select (value->>'exceedingActiveReservationCount')::integer
   from conflicting_capacity_preview),
  1,
  'lowering maximum reports the existing oversized active reservation'
);
select throws_ok(
  format(
    'select public.change_developer_room_type_capacity(%L,(select id from public.room_types where code=''standard''),2,2,2,%L,''CAPACITY_POLICY_CHANGE'',''capacity-conflict-236'',repeat(''8'',64))',
    pg_temp.did(1),
    (select value->>'impactFingerprint' from conflicting_capacity_preview)
  ),
  '23514', 'ROOM_TYPE_CAPACITY_ACTIVE_RESERVATION_CONFLICT',
  'capacity commit never mutates an existing oversized reservation'
);

select public.create_developer_room(
  pg_temp.did(1), pg_temp.did(10), '9999',
  (select id from public.room_types where code='standard'), 2,
  'ROOM_CATALOG_ADD', 'room-create-236', repeat('c',64)
);
select is(
  (select data_status::text from public.rooms where id=pg_temp.did(10)),
  'verification_required',
  'new room starts in the safe verification-required state'
);
select throws_ok(
  format(
    'select public.create_developer_room(%L,%L,''9999'',(select id from public.room_types where code=''standard''),2,''ROOM_CATALOG_ADD'',''room-create-duplicate-236'',repeat(''d'',64))',
    pg_temp.did(1), pg_temp.did(11)
  ),
  '23505', 'ROOM_NUMBER_ALREADY_EXISTS',
  'room number uniqueness is enforced in the database'
);

insert into public.rooms(id, room_number, room_type_id, data_status)
select pg_temp.did(12), '9998', id, 'verification_required'
from public.room_types where code='standard';
insert into public.room_issues(
  id, room_id, category, severity, blocks_guest_assignment,
  description, reported_by
) values (
  pg_temp.did(13), pg_temp.did(12), 'catalog_verification', 'warning', true,
  'catalog verification remains unresolved', pg_temp.did(1)
);
create temporary table unresolved_deactivation_preview as
select public.preview_developer_room_deactivation(pg_temp.did(1),pg_temp.did(12),1) value;
select ok(
  not (select (value->>'canDeactivate')::boolean from unresolved_deactivation_preview)
  and (select (value->>'unresolvedOperationCount')::integer from unresolved_deactivation_preview)=1
  and (select value->'reasonCodes' ? 'ROOM_OPERATION_UNRESOLVED'
       from unresolved_deactivation_preview),
  'unresolved room operations block deactivation with a stable reason code'
);

create temporary table deactivation_preview as
select public.preview_developer_room_deactivation(pg_temp.did(1),pg_temp.did(10),1) value;
select is(
  (select (value->>'canDeactivate')::boolean from deactivation_preview),
  true,
  'unused new room can be deactivated'
);
create temporary table deactivation_result as
select public.deactivate_developer_room(
  pg_temp.did(1), pg_temp.did(10), 1,
  (select value->>'impactFingerprint' from deactivation_preview),
  'ROOM_CATALOG_REMOVE', 'room-deactivate-236', repeat('e',64)
) value;
select ok(
  not (select active from public.rooms where id=pg_temp.did(10))
  and (select state_version from public.rooms where id=pg_temp.did(10))=2,
  'deactivation is a versioned inactive transition rather than deletion'
);
select is(
  public.deactivate_developer_room(
    pg_temp.did(1), pg_temp.did(10), 1,
    (select value->>'impactFingerprint' from deactivation_preview),
    'ROOM_CATALOG_REMOVE', 'room-deactivate-236', repeat('e',64)
  ),
  (select value from deactivation_result),
  'deactivation retry replays without a second transition'
);
select throws_ok(
  format('delete from public.rooms where id=%L', pg_temp.did(10)),
  '23514', 'ROOM_HARD_DELETE_FORBIDDEN',
  'room rows cannot be hard deleted'
);

select ok(
  (
    select bool_and(not (candidate->>'interval_bookable')::boolean
      and candidate->'reason_codes' ? 'GUEST_COUNT_EXCEEDS_ROOM_TYPE_CAPACITY')
    from jsonb_array_elements(public.preview_reservation_bookability(
      pg_temp.did(2), '2036-01-01 16:00:00+09', '2036-01-02 11:00:00+09',
      4, null, array[(select id from public.room_types where code='standard')], 'standard'
    )->'candidates') candidate
  ),
  'bookability marks only maximum-capacity overflow as non-bookable'
);

select throws_ok(
  format(
    'select public.create_reservation(%L,%L,(select room.id from public.rooms room join public.room_types room_type on room_type.id=room.room_type_id where room_type.code=''standard'' and room.active order by room.room_number limit 1),''2036-01-01 16:00:00+09'',''2036-01-02 11:00:00+09'',4,null,(select room.state_version from public.rooms room join public.room_types room_type on room_type.id=room.room_type_id where room_type.code=''standard'' and room.active order by room.room_number limit 1),''capacity-reservation-236'',repeat(''f'',64))',
    pg_temp.did(2), pg_temp.did(20)
  ),
  '23514', 'GUEST_COUNT_EXCEEDS_ROOM_TYPE_CAPACITY',
  'reservation commit revalidates the latest maximum capacity'
);

select ok(
  has_function_privilege('service_role','public.get_developer_room_catalog(uuid)','EXECUTE')
  and not has_function_privilege('authenticated','public.get_developer_room_catalog(uuid)','EXECUTE'),
  'developer catalog RPC remains service-role owned and actor checked'
);

select * from finish();
rollback;
