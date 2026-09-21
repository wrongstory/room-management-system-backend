begin;

select plan(35);

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
  ('94000000-0000-4000-8000-000000000002'::uuid,'972'),
  ('94000000-0000-4000-8000-000000000003'::uuid,'973')
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

select is(
  (select public.correct_room_occupancy(
    '92000000-0000-4000-8000-000000000001','93000000-0000-4000-8000-000000000001',
    '94000000-0000-4000-8000-000000000001','95000000-0000-4000-8000-000000000001',
    false,(select effective_at from private.room_occupancy_corrections limit 1),
    (select room_state_version-1 from private.room_occupancy_corrections limit 1),
    'FRONT_DESK_VERIFIED','room-state-zero-length',repeat('3',64))->>'correction_id'),
  (select value->>'correction_id' from correction_result),
  'same occupancy correction request replays the original response');
select is((select count(*)::integer from private.room_occupancy_corrections),1,
  'occupancy correction replay duplicates no ledger, event, audit, or segment');

create temporary table restore_result as
select public.correct_room_occupancy(
  '92000000-0000-4000-8000-000000000001','93000000-0000-4000-8000-000000000001',
  '94000000-0000-4000-8000-000000000001','95000000-0000-4000-8000-000000000001',
  true,(select effective_at from private.room_occupancy_corrections limit 1),
  (select state_version from public.rooms where id='94000000-0000-4000-8000-000000000001'),
  'FRONT_DESK_VERIFIED','room-state-same-room-restore',repeat('8',64)
) value;
select is((select value->>'occupied' from restore_result),'true',
  'occupied restoration succeeds inside the same room lineage');
select is(private.room_occupied_at(
  '94000000-0000-4000-8000-000000000001',
  (select effective_at from private.room_occupancy_corrections where occupied limit 1)
),true,'same-room restoration makes the canonical segment occupied again');
select is(
  (select public.correct_room_occupancy(
    '92000000-0000-4000-8000-000000000001','93000000-0000-4000-8000-000000000001',
    '94000000-0000-4000-8000-000000000001','95000000-0000-4000-8000-000000000001',
    true,(select effective_at from private.room_occupancy_corrections where occupied limit 1),
    (select room_state_version-1 from private.room_occupancy_corrections where occupied limit 1),
    'FRONT_DESK_VERIFIED','room-state-same-room-restore',repeat('8',64))->>'correction_id'),
  (select value->>'correction_id' from restore_result),
  'same-room occupied restoration replays the original response');
select is((select count(*)::integer from private.room_occupancy_corrections),2,
  'same-room restore replay leaves exactly two occupancy corrections');

select public.correct_room_occupancy(
  '92000000-0000-4000-8000-000000000001','93000000-0000-4000-8000-000000000001',
  '94000000-0000-4000-8000-000000000001','95000000-0000-4000-8000-000000000001',
  false,(select effective_at from private.room_occupancy_corrections where occupied limit 1),
  (select state_version from public.rooms where id='94000000-0000-4000-8000-000000000001'),
  'FRONT_DESK_VERIFIED','room-state-vacant-again',repeat('9',64));

select throws_ok($$select public.correct_room_occupancy(
  '92000000-0000-4000-8000-000000000001','93000000-0000-4000-8000-000000000001',
  '94000000-0000-4000-8000-000000000003','95000000-0000-4000-8000-000000000001',
  true,(select effective_at from private.room_occupancy_corrections where occupied limit 1),
  (select state_version from public.rooms where id='94000000-0000-4000-8000-000000000003'),
  'FRONT_DESK_VERIFIED','room-state-cross-room-restore',repeat('6',64))$$,
  '23514','OCCUPANCY_CORRECTION_ROOM_MISMATCH',
  'A vacant correction followed by B occupied restoration is rejected by room lineage');

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

select is((select count(*)::integer from private.room_occupancy_corrections),3,
  'denied roles append no correction rows');

create temporary table display_override_results(
  target_status text primary key,
  primary_display_status text not null,
  canonical_primary_display_status text not null,
  display_status_override text not null,
  occupied boolean not null,
  allocation_blocked boolean not null,
  allocation_ready boolean not null
);
do $$
declare v_target text; v_index integer := 0;
begin
  foreach v_target in array array[
    'BLOCKED','OCCUPIED','ARRIVAL_PENDING','RESERVATION_PRESENT',
    'CLEANING_REQUIRED','READY'
  ] loop
    v_index := v_index + 1;
    perform public.override_room_display_status(
      '92000000-0000-4000-8000-000000000001',
      '93000000-0000-4000-8000-000000000001',
      '94000000-0000-4000-8000-000000000003',v_target,
      (select state_version from public.rooms
       where id='94000000-0000-4000-8000-000000000003'),
      'FRONT_DESK_VERIFIED','room-display-'||lower(v_target),repeat(v_index::text,64)
    );
    insert into display_override_results
    select v_target,primary_display_status,canonical_primary_display_status,
      display_status_override,occupied,allocation_blocked,allocation_ready
    from public.get_room_operational_projection(
      '92000000-0000-4000-8000-000000000001',
      '94000000-0000-4000-8000-000000000003'
    );
  end loop;
end
$$;
select set_eq(
  'select primary_display_status from display_override_results',
  $$values ('BLOCKED'),('OCCUPIED'),('ARRIVAL_PENDING'),
    ('RESERVATION_PRESENT'),('CLEANING_REQUIRED'),('READY')$$,
  'every source-controlled display classification can be forced per room');
select ok(not exists(select 1 from display_override_results
  where target_status <> display_status_override),
  'effective display classification exposes the current override explicitly');
select ok(not exists(select 1 from display_override_results
  where canonical_primary_display_status <> 'READY' or occupied
    or allocation_blocked or not allocation_ready),
  'display overrides never change canonical occupancy, blocking, or readiness axes');

create temporary table clear_override_result as
select public.override_room_display_status(
  '92000000-0000-4000-8000-000000000001',
  '93000000-0000-4000-8000-000000000001',
  '94000000-0000-4000-8000-000000000003',null,
  (select state_version from public.rooms where id='94000000-0000-4000-8000-000000000003'),
  'FRONT_DESK_VERIFIED','room-display-clear',repeat('a',64)
) value;
select ok((select primary_display_status=canonical_primary_display_status
  and display_status_override is null
  from public.get_room_operational_projection(
    '92000000-0000-4000-8000-000000000001',
    '94000000-0000-4000-8000-000000000003')),
  'null clears the override and restores the canonical display classification');
select is(
  (select public.override_room_display_status(
    '92000000-0000-4000-8000-000000000001',
    '93000000-0000-4000-8000-000000000001',
    '94000000-0000-4000-8000-000000000003',null,
    (select room_state_version-1 from private.room_display_status_overrides
     where target_status is null order by room_state_version desc limit 1),
    'FRONT_DESK_VERIFIED','room-display-clear',repeat('a',64))->>'override_id'),
  (select value->>'override_id' from clear_override_result),
  'display override retry replays the original response');
select is((select count(*)::integer from private.room_display_status_overrides),7,
  'six display statuses and one clear append exactly seven immutable rows');
select is((select count(*)::integer from public.audit_events
  where event_type='room.display_status_overridden'),7,
  'each display override appends one safe audit event');

select throws_ok($$select public.override_room_display_status(
  '92000000-0000-4000-8000-000000000002','93000000-0000-4000-8000-000000000002',
  '94000000-0000-4000-8000-000000000003','BLOCKED',
  (select state_version from public.rooms where id='94000000-0000-4000-8000-000000000003'),
  'MAID_ATTEMPT','room-display-maid-denied',repeat('b',64))$$,
  '42501','ADMIN_REQUIRED','maid cannot override a display classification');
select throws_ok($$select public.override_room_display_status(
  (select id from public.profiles where role='developer'),'93000000-0000-4000-8000-000000000003',
  '94000000-0000-4000-8000-000000000003','BLOCKED',
  (select state_version from public.rooms where id='94000000-0000-4000-8000-000000000003'),
  'DEVELOPER_ATTEMPT','room-display-developer-denied',repeat('c',64))$$,
  '42501','ADMIN_REQUIRED','developer cannot override a display classification');
select is((select count(*)::integer from private.room_display_status_overrides),7,
  'denied roles append no display override rows');

select ok(has_function_privilege(
  'service_role', 'public.get_room_operational_projection(uuid,uuid)', 'EXECUTE'),
  'projection drop/recreate restores service-role execute authority');
select ok(not has_function_privilege(
  'authenticated', 'public.get_room_operational_projection(uuid,uuid)', 'EXECUTE'),
  'projection drop/recreate does not leak execute to authenticated');
select ok(to_regprocedure('public.get_room_operational_projection(uuid,uuid)') is not null,
  'projection drop/recreate leaves the canonical callable signature installed');

select * from finish();
rollback;
