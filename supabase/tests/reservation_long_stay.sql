begin;

select plan(27);

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
  ('81000000-0000-4000-8000-000000000001'),
  ('81000000-0000-4000-8000-000000000002');
insert into public.profiles(
  id,auth_user_id,display_name,display_name_normalized,login_id,
  login_id_normalized,login_sequence,role,status,must_change_password
) values(
  '82000000-0000-4000-8000-000000000001',
  '81000000-0000-4000-8000-000000000001',
  '장기투숙 관리자','장기투숙 관리자','장기투숙 관리자','장기투숙 관리자',0,
  'admin','active',false
),(
  '82000000-0000-4000-8000-000000000002',
  '81000000-0000-4000-8000-000000000002',
  '장기투숙 메이드','장기투숙 메이드','장기투숙 메이드','장기투숙 메이드',0,
  'maid','active',false
);

select set_config('app.room_catalog_command','v1',true);
insert into public.rooms(id,room_number,room_type_id,elevator_zone)
select fixture.id,fixture.room_number,room_type.id,'A'
from (values
  ('83000000-0000-4000-8000-000000000001'::uuid,'901'),
  ('83000000-0000-4000-8000-000000000002'::uuid,'902'),
  ('83000000-0000-4000-8000-000000000003'::uuid,'903'),
  ('83000000-0000-4000-8000-000000000004'::uuid,'904'),
  ('83000000-0000-4000-8000-000000000005'::uuid,'905')
) fixture(id,room_number)
cross join lateral(select id from public.room_types where code='standard') room_type;
select set_config('app.room_catalog_command','',true);

insert into public.cleaning_template_versions(
  room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,published_at,created_by
)
select room_type.id,'checkout',91,'published',null,pg_temp.checkout_slots(),clock_timestamp(),
  '82000000-0000-4000-8000-000000000001'
from public.room_types room_type where room_type.code='standard'
on conflict do nothing;
insert into public.cleaning_template_versions(
  room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,published_at,created_by
)
select room_type.id,'stayover',6,'published',60,'[]'::jsonb,clock_timestamp(),
  '82000000-0000-4000-8000-000000000001'
from public.room_types room_type where room_type.code='standard'
on conflict do nothing;

select public.create_reservation_v2(
  '82000000-0000-4000-8000-000000000001',
  '84000000-0000-4000-8000-000000000001',
  '83000000-0000-4000-8000-000000000001','long_stay',
  '2027-04-01 15:00:00+09',null,2,null,
  (select state_version from public.rooms where id='83000000-0000-4000-8000-000000000001'),
  'long-stay-open-create',repeat('1',64)
);

select is(
  (select reservation_type::text from public.reservations
    where id='84000000-0000-4000-8000-000000000001'),
  'long_stay','open-ended reservation stores its explicit type'
);
select is(
  (select check_out_at is null from public.reservations
    where id='84000000-0000-4000-8000-000000000001'),
  true,'open-ended reservation keeps a NULL scheduled checkout'
);
select is(
  (select checkout_obligation_id is null from public.reservations
    where id='84000000-0000-4000-8000-000000000001'),
  true,'open-ended reservation has no checkout pointer'
);
select is(
  (select count(*)::integer from public.checkout_cleaning_obligations
    where reservation_id='84000000-0000-4000-8000-000000000001'),
  0,'open-ended create has no checkout obligation'
);
select is(
  (select count(*)::integer from public.cleaning_targets
    where reservation_id='84000000-0000-4000-8000-000000000001'
      and cleaning_kind='checkout'),
  0,'open-ended create has no checkout target'
);
select is(
  (select ends_at is null from private.stay_room_segments
    where source_reservation_id='84000000-0000-4000-8000-000000000001'
      and retired_at is null),
  true,'canonical stay segment has an infinite upper bound'
);
select is(
  (select (candidate->>'interval_bookable')::boolean
    from jsonb_array_elements(public.preview_reservation_bookability(
      '82000000-0000-4000-8000-000000000001',
      '2035-01-01 15:00:00+09','2035-01-02 11:00:00+09',null,null,'standard'
    )->'candidates') candidate where candidate->>'room_id'='83000000-0000-4000-8000-000000000001'),
  false,'open-ended stay blocks arbitrarily distant future intervals'
);
select throws_ok(
  $$select public.create_reservation_v2(
    '82000000-0000-4000-8000-000000000001',gen_random_uuid(),
    '83000000-0000-4000-8000-000000000002','standard',
    '2027-05-01 15:00:00+09',null,1,null,
    (select state_version from public.rooms where id='83000000-0000-4000-8000-000000000002'),
    'standard-without-end',repeat('2',64))$$,
  '22023','STANDARD_RESERVATION_REQUIRES_END','standard reservation requires checkout'
);
select lives_ok(
  $$select public.create_reservation_v2(
    '82000000-0000-4000-8000-000000000001',
    '84000000-0000-4000-8000-000000000004',
    '83000000-0000-4000-8000-000000000004','standard',
    '2027-07-01 15:00:00+09','2027-07-02 11:00:00+09',1,null,
    (select state_version from public.rooms where id='83000000-0000-4000-8000-000000000004'),
    'standard-bounded-create',repeat('b',64))$$,
  'standard reservation with a checkout creates successfully'
);
select lives_ok(
  $$select public.create_reservation_v2(
    '82000000-0000-4000-8000-000000000001',
    '84000000-0000-4000-8000-000000000005',
    '83000000-0000-4000-8000-000000000005','long_stay',
    '2027-08-01 15:00:00+09','2027-09-01 11:00:00+09',1,null,
    (select state_version from public.rooms where id='83000000-0000-4000-8000-000000000005'),
    'long-stay-bounded-create',repeat('c',64))$$,
  'fixed long-stay reservation creates successfully'
);

select ok(
  not (public.preview_reservation_room_move(
    '82000000-0000-4000-8000-000000000001',
    '84000000-0000-4000-8000-000000000001',
    '83000000-0000-4000-8000-000000000002',1,
    (select state_version from public.rooms where id='83000000-0000-4000-8000-000000000001'),
    (select state_version from public.rooms where id='83000000-0000-4000-8000-000000000002'),
    null,'GUEST_REQUEST'
  )->'rejectionReasonCodes' ? 'OPEN_ENDED_STAY_REQUIRES_END'),
  'pre-checkin open-ended move is not rejected merely for lacking an end'
);

select public.change_reservation_v2(
  '82000000-0000-4000-8000-000000000001',
  '84000000-0000-4000-8000-000000000001',
  '83000000-0000-4000-8000-000000000001','long_stay',
  '2027-04-01 15:00:00+09','2027-06-01 11:00:00+09',2,'keep',null,1,
  'LONG_STAY_END_CONFIRMED','long-stay-set-end',repeat('3',64)
);
select is(
  (select count(*)::integer from public.checkout_cleaning_obligations
    where reservation_id='84000000-0000-4000-8000-000000000001'),
  1,'open to fixed creates exactly one checkout obligation'
);
select is(
  (select count(*)::integer from public.cleaning_targets
    where reservation_id='84000000-0000-4000-8000-000000000001'
      and cleaning_kind='checkout'),
  1,'open to fixed creates exactly one planned target'
);
select lives_ok(
  $$select public.change_reservation_v2(
    '82000000-0000-4000-8000-000000000001',
    '84000000-0000-4000-8000-000000000001',
    '83000000-0000-4000-8000-000000000001','long_stay',
    '2027-04-01 15:00:00+09','2027-06-01 11:00:00+09',2,'keep',null,1,
    'LONG_STAY_END_CONFIRMED','long-stay-set-end',repeat('3',64))$$,
  'same-key end confirmation replays'
);
select throws_ok(
  $$select public.change_reservation_v2(
    '82000000-0000-4000-8000-000000000001',
    '84000000-0000-4000-8000-000000000001',
    '83000000-0000-4000-8000-000000000001','long_stay',
    '2027-04-01 15:00:00+09',null,2,'keep',null,2,
    'REMOVE_END','long-stay-remove-end',repeat('4',64))$$,
  '23514','RESERVATION_END_IMMUTABLE','fixed long-stay cannot return to open-ended'
);
select throws_ok(
  $$select public.change_reservation_v2(
    '82000000-0000-4000-8000-000000000001',
    '84000000-0000-4000-8000-000000000001',
    '83000000-0000-4000-8000-000000000001','standard',
    '2027-04-01 15:00:00+09','2027-06-01 11:00:00+09',2,'keep',null,2,
    'TYPE_CHANGE','long-stay-type-change',repeat('5',64))$$,
  '23514','RESERVATION_TYPE_IMMUTABLE','reservation type is immutable'
);

select public.create_reservation_v2(
  '82000000-0000-4000-8000-000000000001',
  '84000000-0000-4000-8000-000000000002',
  '83000000-0000-4000-8000-000000000003','long_stay',
  date_trunc('minute',clock_timestamp())-interval '2 days',null,1,null,
  (select state_version from public.rooms where id='83000000-0000-4000-8000-000000000003'),
  'long-stay-manual-create',repeat('6',64)
);
update public.reservations set actual_check_in_at=date_trunc('minute',clock_timestamp())-interval '1 day',
  version=version+1 where id='84000000-0000-4000-8000-000000000002';
select lives_ok(
  $$select public.create_manual_cleaning_request(
    '82000000-0000-4000-8000-000000000001',
    '85000000-0000-4000-8000-000000000010',
    '83000000-0000-4000-8000-000000000003',
    '84000000-0000-4000-8000-000000000002','stayover',
    (clock_timestamp() at time zone 'Asia/Seoul')::date,
    date_trunc('minute',clock_timestamp())-interval '5 minutes',
    date_trunc('minute',clock_timestamp())+interval '1 hour',
    (select state_version from public.rooms where id='83000000-0000-4000-8000-000000000003'),
    'LONG_STAY_STAYOVER','long-stay-stayover-create',repeat('9',64))$$,
  'open-ended long stay accepts a bounded stayover cleaning request'
);
select is(
  (select private.assignment_preview_source_reason(target,60,clock_timestamp())
    from public.cleaning_targets target
    where id='85000000-0000-4000-8000-000000000010'),
  null::text,'open-ended segment is valid assignment authority for stayover'
);
insert into public.cleaning_assignments(
  id,cleaning_target_id,maid_profile_id,sequence_number,revision,
  service_date,available_from_snapshot,due_at_snapshot,notified_at,changed_by
)
select
  '86000000-0000-4000-8000-000000000010',target.id,
  '82000000-0000-4000-8000-000000000002',10,2,
  target.effective_service_date,target.available_from,target.due_at,
  clock_timestamp(),'82000000-0000-4000-8000-000000000001'
from public.cleaning_targets target
where target.id='85000000-0000-4000-8000-000000000010';
update public.cleaning_targets set status='notified',assignment_version=2
where id='85000000-0000-4000-8000-000000000010';
select is(
  private.activate_cleaning_attempt_at(
    '82000000-0000-4000-8000-000000000001',
    '85000000-0000-4000-8000-000000000010',clock_timestamp(),
    '86000000-0000-4000-8000-000000000010',2
  )->>'status',
  'activated','open-ended stayover assignment activates exactly one attempt'
);
select lives_ok(
  $$select private.execute_cleaning_attempt_at(
    '82000000-0000-4000-8000-000000000002',
    (select id from public.cleaning_attempts
      where cleaning_target_id='85000000-0000-4000-8000-000000000010'),
    1,'86000000-0000-4000-8000-000000000010',2,
    'long-stay-stayover-start',repeat('a',64),'start',clock_timestamp())$$,
  'assigned maid can start open-ended stayover field work'
);
select ok(
  public.preview_reservation_room_move(
    '82000000-0000-4000-8000-000000000001',
    '84000000-0000-4000-8000-000000000002',
    '83000000-0000-4000-8000-000000000002',2,
    (select state_version from public.rooms where id='83000000-0000-4000-8000-000000000003'),
    (select state_version from public.rooms where id='83000000-0000-4000-8000-000000000002'),
    date_trunc('minute',clock_timestamp())+interval '1 hour','GUEST_REQUEST'
  )->'rejectionReasonCodes' ? 'OPEN_ENDED_STAY_REQUIRES_END',
  'during-stay open-ended room move requires an end before commit'
);
select is(
  (public.process_due_reservation_transitions(
    '82000000-0000-4000-8000-000000000001',
    date_trunc('minute',clock_timestamp()),
    'long-stay-scheduler-skip-checkout',repeat('8',64)
  )->>'checked_out_count')::integer,
  0,'scheduler never auto-checks-out an open-ended long stay'
);
select is(
  (select status::text||':'||(actual_checkout_at is null)::text
    from public.reservations where id='84000000-0000-4000-8000-000000000002'),
  'active:true','scheduler leaves the open-ended stay active without an actual checkout'
);
select public.manual_checkout_reservation(
  '82000000-0000-4000-8000-000000000001',
  '84000000-0000-4000-8000-000000000002',2,'GUEST_DEPARTED',
  date_trunc('minute',clock_timestamp()),'long-stay-manual-checkout',repeat('7',64)
);
select is(
  (select check_out_at is null and actual_checkout_at is not null
    from public.reservations where id='84000000-0000-4000-8000-000000000002'),
  true,'manual checkout preserves the unknown scheduled end and records actual checkout'
);
select is(
  (select count(*)::integer from public.checkout_cleaning_obligations
    where reservation_id='84000000-0000-4000-8000-000000000002'),
  1,'manual checkout creates exactly one checkout obligation'
);
select is(
  (select count(*)::integer from public.cleaning_targets
    where reservation_id='84000000-0000-4000-8000-000000000002'
      and cleaning_kind='checkout'),
  1,'manual checkout creates exactly one checkout target'
);
select is(
  (select count(*)::integer from public.reservations
    where id='84000000-0000-4000-8000-000000000002' and status='active'),
  0,'manual checkout ends the active open-ended stay'
);

select * from finish();
rollback;
