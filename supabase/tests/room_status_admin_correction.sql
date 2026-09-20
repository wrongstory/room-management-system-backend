begin;

select plan(17);

create function pg_temp.checkout_slots() returns jsonb
language sql immutable as $$
  select jsonb_agg(jsonb_build_object(
    'slotKey', case when display_order = 0 then 'tv-on'
      when display_order = 1 then 'entry-storage'
      when display_order = 8 then 'extra-proof'
      else 'slot-' || display_order end,
    'displayOrder', display_order,
    'required', display_order < 8,
    'label', '사진 ' || (display_order + 1),
    'maxPhotos', case when display_order = 8 then 10 else 1 end
  ) order by display_order)
  from generate_series(0, 8) display_order
$$;

insert into auth.users(id) values
  ('91000000-0000-4000-8000-000000000001'),
  ('91000000-0000-4000-8000-000000000002');
insert into public.profiles(
  id,auth_user_id,display_name,display_name_normalized,login_id,
  login_id_normalized,login_sequence,role,status,must_change_password
) values
  ('92000000-0000-4000-8000-000000000001','91000000-0000-4000-8000-000000000001',
   '점유 보정 관리자','점유 보정 관리자','점유 보정 관리자','점유 보정 관리자',0,'admin','active',false),
  ('92000000-0000-4000-8000-000000000002','91000000-0000-4000-8000-000000000002',
   '점유 보정 메이드','점유 보정 메이드','점유 보정 메이드','점유 보정 메이드',0,'maid','active',false);
insert into auth.sessions(id,user_id) values
  ('93000000-0000-4000-8000-000000000001','91000000-0000-4000-8000-000000000001'),
  ('93000000-0000-4000-8000-000000000002','91000000-0000-4000-8000-000000000002');
insert into auth.sessions(id,user_id)
select '93000000-0000-4000-8000-000000000003',auth_user_id
from public.profiles where role='developer';

insert into public.rooms(id,room_number,room_type_id,elevator_zone)
select fixture.id,fixture.number,room_type.id,'A'
from (values
  ('94000000-0000-4000-8000-000000000001'::uuid,'971'),
  ('94000000-0000-4000-8000-000000000002'::uuid,'972')
) fixture(id,number)
cross join lateral(select id from public.room_types where code='standard') room_type;

insert into public.cleaning_template_versions(
  room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,published_at,created_by
)
select id,'checkout',228,'published',null,pg_temp.checkout_slots(),clock_timestamp(),
  '92000000-0000-4000-8000-000000000001'
from public.room_types where code='standard' on conflict do nothing;

select public.create_reservation_v2(
  '92000000-0000-4000-8000-000000000001',
  '95000000-0000-4000-8000-000000000001',
  '94000000-0000-4000-8000-000000000001','standard',
  (current_date+1+time '16:00') at time zone 'Asia/Seoul',
  (current_date+2+time '11:00') at time zone 'Asia/Seoul',1,null,
  (select state_version from public.rooms where id='94000000-0000-4000-8000-000000000001'),
  'room-state-create-bounded',repeat('1',64)
);

select is(private.room_occupied_at(
  '94000000-0000-4000-8000-000000000001',
  (select starts_at-interval '1 microsecond' from private.stay_room_segments
   where source_reservation_id='95000000-0000-4000-8000-000000000001' and retired_at is null)
),false,'occupied is false immediately before segment start');
select is(private.room_occupied_at(
  '94000000-0000-4000-8000-000000000001',
  (select starts_at from private.stay_room_segments
   where source_reservation_id='95000000-0000-4000-8000-000000000001' and retired_at is null)
),true,'occupied is true exactly at segment start');
select is(private.room_occupied_at(
  '94000000-0000-4000-8000-000000000001',
  (select ends_at from private.stay_room_segments
   where source_reservation_id='95000000-0000-4000-8000-000000000001' and retired_at is null)
),false,'occupied is false exactly at bounded segment end');

select public.create_reservation_v2(
  '92000000-0000-4000-8000-000000000001',
  '95000000-0000-4000-8000-000000000002',
  '94000000-0000-4000-8000-000000000002','long_stay',
  (current_date+1+time '16:00') at time zone 'Asia/Seoul',null,1,null,
  (select state_version from public.rooms where id='94000000-0000-4000-8000-000000000002'),
  'room-state-create-open',repeat('2',64)
);
select is(private.room_occupied_at(
  '94000000-0000-4000-8000-000000000002',clock_timestamp()+interval '10 years'
),true,'open-ended canonical segment remains occupied without an end');

select is((select blocking_reason_codes from private.room_readiness_axes_at(
  array['OCCUPIED'], 'verified', false)),array[]::text[],
  'occupancy alone is not allocationBlocked');
select is((select blocking_reason_codes from private.room_readiness_axes_at(
  array['CLEANING_REQUIRED'], 'verified', false)),array[]::text[],
  'cleaning alone is not allocationBlocked');
select is((select blocking_reason_codes from private.room_readiness_axes_at(
  array['OPERATION_BLOCKED'], 'verified', false)),array['OPERATION_BLOCKED']::text[],
  'a room operation problem is allocationBlocked');
select is((select readiness_reason_codes from private.room_readiness_axes_at(
  array['CLEANING_REQUIRED'], 'verified', false)),array['CLEANING_REQUIRED']::text[],
  'cleaning remains part of overall allocation readiness');

update public.reservations
set actual_check_in_at=clock_timestamp()-interval '1 hour'
where id='95000000-0000-4000-8000-000000000001';

create temporary table correction_result as
select public.correct_room_occupancy(
  '92000000-0000-4000-8000-000000000001',
  '93000000-0000-4000-8000-000000000001',
  '94000000-0000-4000-8000-000000000001',
  '95000000-0000-4000-8000-000000000001',false,
  (select starts_at from private.stay_room_segments
   where source_reservation_id='95000000-0000-4000-8000-000000000001' and retired_at is null),
  (select state_version from public.rooms where id='94000000-0000-4000-8000-000000000001'),
  'FRONT_DESK_VERIFIED','room-state-zero-length',repeat('3',64)
) value;

select is((select count(*)::integer from private.room_occupancy_corrections),1,
  'admin correction appends exactly one immutable correction');
select is((select successor_segment_id is null from private.room_occupancy_corrections),true,
  'correction at segment start retires the whole segment without a zero-length successor');
select is((select count(*)::integer from public.room_occupancy_events
  where event_key like '%room-state-zero-length%'),1,
  'correction appends one public safe occupancy event');
select is((select count(*)::integer from public.audit_events
  where event_type='room.occupancy_corrected'),1,'correction appends one safe audit event');

select throws_ok($$select public.correct_room_occupancy(
  '92000000-0000-4000-8000-000000000001','93000000-0000-4000-8000-000000000001',
  '94000000-0000-4000-8000-000000000002','95000000-0000-4000-8000-000000000001',
  true,clock_timestamp(),(select state_version from public.rooms where id='94000000-0000-4000-8000-000000000002'),
  'FRONT_DESK_VERIFIED','room-state-target-room-conflict',repeat('7',64))$$,
  '23514','ROOM_OCCUPANCY_CONFLICT',
  'a different stay overlapping the target room returns a stable occupancy conflict');

select throws_ok($$select public.correct_room_occupancy(
  '92000000-0000-4000-8000-000000000001','93000000-0000-4000-8000-000000000001',
  '94000000-0000-4000-8000-000000000001','95000000-0000-4000-8000-000000000002',
  true,clock_timestamp(),(select state_version from public.rooms where id='94000000-0000-4000-8000-000000000001'),
  'FRONT_DESK_VERIFIED','room-state-other-room-overlap',repeat('6',64))$$,
  '23514','OCCUPANCY_CORRECTION_ROOM_MISMATCH',
  'a future segment in another room rejects an occupied correction with a stable domain error');

select throws_ok($$select public.correct_room_occupancy(
  '92000000-0000-4000-8000-000000000002','93000000-0000-4000-8000-000000000002',
  '94000000-0000-4000-8000-000000000002','95000000-0000-4000-8000-000000000002',
  false,clock_timestamp(),(select state_version from public.rooms where id='94000000-0000-4000-8000-000000000002'),
  'MAID_ATTEMPT','room-state-maid-denied',repeat('4',64))$$,
  '42501','ADMIN_REQUIRED','maid cannot correct occupancy');
select throws_ok($$select public.correct_room_occupancy(
  (select id from public.profiles where role='developer'),'93000000-0000-4000-8000-000000000003',
  '94000000-0000-4000-8000-000000000002','95000000-0000-4000-8000-000000000002',
  false,clock_timestamp(),(select state_version from public.rooms where id='94000000-0000-4000-8000-000000000002'),
  'DEVELOPER_ATTEMPT','room-state-developer-denied',repeat('5',64))$$,
  '42501','ADMIN_REQUIRED','developer cannot correct occupancy');

select is((select count(*)::integer from private.room_occupancy_corrections),1,
  'denied roles append no correction rows');

select * from finish();
rollback;
