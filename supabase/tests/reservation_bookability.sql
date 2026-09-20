begin;

select plan(23);

insert into auth.users(id) values
  ('71000000-0000-4000-8000-000000000001'),
  ('71000000-0000-4000-8000-000000000002');

insert into public.profiles(
  id,auth_user_id,display_name,display_name_normalized,login_id,
  login_id_normalized,login_sequence,role,status,must_change_password
) values
  (
    '72000000-0000-4000-8000-000000000001',
    '71000000-0000-4000-8000-000000000001',
    '가용성 관리자','가용성 관리자','가용성 관리자','가용성 관리자',0,
    'admin','active',false
  ),
  (
    '72000000-0000-4000-8000-000000000002',
    '71000000-0000-4000-8000-000000000002',
    '가용성 메이드','가용성 메이드','가용성 메이드','가용성 메이드',0,
    'maid','active',false
  );

select set_config('app.room_catalog_command','v1',true);
insert into public.rooms(id,room_number,room_type_id,elevator_zone)
select fixture.id,fixture.room_number,room_type.id,'A'
from (values
  ('75000000-0000-4000-8000-000000000002'::uuid,'118'),
  ('75000000-0000-4000-8000-000000000003'::uuid,'119'),
  ('75000000-0000-4000-8000-000000000004'::uuid,'120')
) fixture(id,room_number)
cross join lateral (
  select id from public.room_types where code='standard'
) room_type;
select set_config('app.room_catalog_command','',true);

insert into public.cleaning_template_versions(
  room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,
  published_at,created_by
)
select id,'checkout',1,'published',60,'[]'::jsonb,clock_timestamp(),
  '72000000-0000-4000-8000-000000000001'
from public.room_types;

select public.create_reservation(
  '72000000-0000-4000-8000-000000000001',
  '73000000-0000-4000-8000-000000000001',
  (select id from public.rooms where room_number='117'),
  '2027-02-01 16:00:00+09','2027-02-02 11:00:00+09',2,
  'encrypted-guest-must-not-leak',
  (select state_version from public.rooms where room_number='117'),
  'bookability-create-117',repeat('1',64)
);

select public.create_reservation(
  '72000000-0000-4000-8000-000000000001',
  '73000000-0000-4000-8000-000000000002',
  (select id from public.rooms where room_number='118'),
  '2027-02-01 16:00:00+09','2027-02-02 11:00:00+09',2,null,
  (select state_version from public.rooms where room_number='118'),
  'bookability-create-118',repeat('2',64)
);

select public.create_reservation(
  '72000000-0000-4000-8000-000000000001',
  '73000000-0000-4000-8000-000000000003',
  (select id from public.rooms where room_number='119'),
  '2027-02-05 16:00:00+09','2027-02-06 11:00:00+09',2,null,
  (select state_version from public.rooms where room_number='119'),
  'bookability-create-119',repeat('3',64)
);

select public.cancel_reservation(
  '72000000-0000-4000-8000-000000000001',
  '73000000-0000-4000-8000-000000000003',1,'GUEST_CANCELLED',
  'bookability-cancel-119',repeat('4',64)
);

select public.create_reservation(
  '72000000-0000-4000-8000-000000000001',
  '73000000-0000-4000-8000-000000000004',
  (select id from public.rooms where room_number='120'),
  date_trunc('minute',clock_timestamp())-interval '1 minute',
  date_trunc('minute',clock_timestamp())+interval '1 day',2,null,
  (select state_version from public.rooms where room_number='120'),
  'bookability-create-current-120',repeat('5',64)
);

select is(
  (
    select (candidate->>'interval_bookable')::boolean
    from jsonb_array_elements(public.preview_reservation_bookability(
      '72000000-0000-4000-8000-000000000001',
      '2027-02-02 11:00:00+09','2027-02-03 11:00:00+09',null,null
    )->'candidates') candidate
    where candidate->>'room_number'='117'
  ),
  true,
  '[in,out) permits an interval adjacent to checkout'
);

select is(
  (
    select (candidate->>'interval_bookable')::boolean
    from jsonb_array_elements(public.preview_reservation_bookability(
      '72000000-0000-4000-8000-000000000001',
      '2027-02-02 10:59:00+09','2027-02-03 11:00:00+09',null,null
    )->'candidates') candidate
    where candidate->>'room_number'='117'
  ),
  false,
  'actual overlap is not bookable'
);

select ok(
  (
    select candidate->'reason_codes' ? 'RESERVATION_OVERLAP'
    from jsonb_array_elements(public.preview_reservation_bookability(
      '72000000-0000-4000-8000-000000000001',
      '2027-02-02 10:59:00+09','2027-02-03 11:00:00+09',null,null
    )->'candidates') candidate
    where candidate->>'room_number'='117'
  ),
  'overlap reason is stable and safe'
);

select is(
  (
    select (candidate->>'interval_bookable')::boolean
    from jsonb_array_elements(public.preview_reservation_bookability(
      '72000000-0000-4000-8000-000000000001',
      '2027-02-01 16:00:00+09','2027-02-02 11:00:00+09',
      '73000000-0000-4000-8000-000000000001',null
    )->'candidates') candidate
    where candidate->>'room_number'='117'
  ),
  true,
  'exact active pre-checkin reservation can be excluded'
);

select is(
  (
    select (candidate->>'interval_bookable')::boolean
    from jsonb_array_elements(public.preview_reservation_bookability(
      '72000000-0000-4000-8000-000000000001',
      '2027-02-01 16:00:00+09','2027-02-02 11:00:00+09',
      '73000000-0000-4000-8000-000000000001',null
    )->'candidates') candidate
    where candidate->>'room_number'='118'
  ),
  false,
  'excluding one reservation never excludes another room reservation'
);

select throws_ok(
  $$select public.preview_reservation_bookability(
    '72000000-0000-4000-8000-000000000001',
    '2027-02-01 16:00:00+09','2027-02-02 11:00:00+09',
    '73000000-0000-4000-8000-000000000099',null
  )$$,
  'P0002','EXCLUDE_RESERVATION_NOT_FOUND',
  'unknown exclusion is rejected'
);

select throws_ok(
  $$select public.preview_reservation_bookability(
    '72000000-0000-4000-8000-000000000001',
    '2027-02-05 16:00:00+09','2027-02-06 11:00:00+09',
    '73000000-0000-4000-8000-000000000003',null
  )$$,
  '23514','EXCLUDE_RESERVATION_NOT_ELIGIBLE',
  'cancelled reservation cannot be an exclusion authority'
);

select ok(
  (
    select (candidate->>'interval_bookable')::boolean
      and not (candidate->>'check_in_ready')::boolean
      and candidate->'reason_codes' ? 'PIN_UNCONFIGURED'
    from jsonb_array_elements(public.preview_reservation_bookability(
      '72000000-0000-4000-8000-000000000001',
      '2027-03-01 16:00:00+09','2027-03-02 11:00:00+09',null,null
    )->'candidates') candidate
    where candidate->>'room_number'='120'
  ),
  'current check-in pending exposes PIN readiness without changing interval bookability'
);

select ok(
  (
    select (candidate->>'interval_bookable')::boolean
      and (candidate->>'check_in_ready')::boolean
      and not (candidate->'reason_codes' ? 'PIN_UNCONFIGURED')
    from jsonb_array_elements(public.preview_reservation_bookability(
      '72000000-0000-4000-8000-000000000001',
      '2027-03-01 16:00:00+09','2027-03-02 11:00:00+09',null,null
    )->'candidates') candidate
    where candidate->>'room_number'='118'
  ),
  'future interval without current arrival does not turn unconfigured PIN into a readiness failure'
);

select ok(
  jsonb_typeof(public.preview_reservation_bookability(
    '72000000-0000-4000-8000-000000000001',
    '2027-03-01 16:00:00+09','2027-03-02 11:00:00+09',null,null
  )->'evaluated_at')='string',
  'preview envelope always carries evaluatedAt authority'
);

select is(
  (select jsonb_agg(candidate - 'evaluated_at' order by candidate->>'room_number')
   from jsonb_array_elements(public.preview_reservation_bookability(
     '72000000-0000-4000-8000-000000000001',
     '2027-03-01 16:00:00+09','2027-03-02 11:00:00+09',null,array[]::uuid[],'standard'
   )->'candidates') candidate),
  (select jsonb_agg(candidate - 'evaluated_at' order by candidate->>'room_number')
   from jsonb_array_elements(public.preview_reservation_bookability(
     '72000000-0000-4000-8000-000000000001',
     '2027-03-01 16:00:00+09','2027-03-02 11:00:00+09',null,null,'standard'
   )->'candidates') candidate),
  'empty and omitted room type filters both mean all room types'
);

select lives_ok(
  $$select public.preview_reservation_bookability(
    '72000000-0000-4000-8000-000000000001',
    '2027-03-01 16:00:00+09','2027-03-02 11:00:00+09',null,null,'long_stay'
  )$$,
  'long-stay preview is part of the nullable checkout contract'
);

select is(
  jsonb_array_length(public.list_reservations_page(
    '72000000-0000-4000-8000-000000000001',
    '2027-02-01 00:00:00+09','2027-03-02 00:00:00+09',null,null,null,50
  )->'reservations'),
  3,
  '29-day page returns every overlapping active and cancelled reservation'
);

select ok(
  not (public.list_reservations_page(
    '72000000-0000-4000-8000-000000000001',
    '2027-02-01 00:00:00+09','2027-03-02 00:00:00+09',null,null,null,50
  )::text like '%encrypted-guest-must-not-leak%'),
  'range page never exposes guest PII'
);

select is(
  jsonb_array_length(public.list_reservations_page(
    '72000000-0000-4000-8000-000000000001',
    '2027-02-02 11:00:00+09','2027-02-03 11:00:00+09',
    (select id from public.rooms where room_number='117'),null,null,50
  )->'reservations'),
  0,
  'range read uses the same half-open overlap boundary'
);

select is(
  jsonb_array_length(public.list_reservations_page(
    '72000000-0000-4000-8000-000000000001',
    '2027-02-05 00:00:00+09','2027-02-07 00:00:00+09',
    (select id from public.rooms where room_number='119'),null,null,50
  )->'reservations'),
  1,
  'room filter preserves cancelled retired segment history'
);

create temporary table first_page as
select public.list_reservations_page(
  '72000000-0000-4000-8000-000000000001',
  '2027-02-01 00:00:00+09','2027-03-02 00:00:00+09',null,null,null,1
) value;

select is((select (value->>'has_more')::boolean from first_page),true,
  'bounded page reports more rows');

select is(
  jsonb_array_length(public.list_reservations_page(
    '72000000-0000-4000-8000-000000000001',
    '2027-02-01 00:00:00+09','2027-03-02 00:00:00+09',null,
    (select (value->'reservations'->0->>'check_in_at')::timestamptz from first_page),
    (select (value->'reservations'->0->>'id')::uuid from first_page),50
  )->'reservations'),
  2,
  'keyset continuation has no duplicate or omission'
);

select ok(
  (select value ? 'server_time' from first_page),
  'range page publishes serverTime snapshot'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.preview_reservation_bookability(uuid,timestamptz,timestamptz,uuid,uuid[],text)',
    'execute'
  ) and not has_function_privilege(
    'authenticated',
    'public.list_reservations_page(uuid,timestamptz,timestamptz,uuid,timestamptz,uuid,integer)',
    'execute'
  ),
  'authenticated and maid clients cannot call service-role projections directly'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.preview_reservation_bookability(uuid,timestamptz,timestamptz,uuid,uuid[],text)',
    'execute'
  ) and has_function_privilege(
    'service_role',
    'public.list_reservations_page(uuid,timestamptz,timestamptz,uuid,timestamptz,uuid,integer)',
    'execute'
  ),
  'service role can call actor-bound projections'
);

select throws_ok(
  $$select public.preview_reservation_bookability(
    '72000000-0000-4000-8000-000000000002',
    '2027-03-01 16:00:00+09','2027-03-02 11:00:00+09',null,null
  )$$,
  '42501','ADMIN_REQUIRED',
  'maid actor cannot preview the room inventory'
);

select throws_ok(
  $$select public.list_reservations_page(
    '72000000-0000-4000-8000-000000000002',
    '2027-02-01 00:00:00+09','2027-03-02 00:00:00+09',null,null,null,50
  )$$,
  '42501','ADMIN_REQUIRED',
  'maid actor cannot list the reservation calendar'
);

select * from finish();
rollback;
