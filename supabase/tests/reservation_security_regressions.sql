begin;

create temporary table reservation_security_results (
  test_number integer primary key,
  description text not null,
  passed boolean not null
);

insert into auth.users (id) values
  ('71000000-0000-4000-8000-000000000001'),
  ('71000000-0000-4000-8000-000000000002');

insert into public.profiles (
  id,
  auth_user_id,
  display_name,
  display_name_normalized,
  login_id,
  login_id_normalized,
  login_sequence,
  role,
  status,
  must_change_password
) values
  (
    '72000000-0000-4000-8000-000000000001',
    '71000000-0000-4000-8000-000000000001',
    '예약 보안 관리자',
    '예약 보안 관리자',
    '예약 보안 관리자',
    '예약 보안 관리자',
    0,
    'admin',
    'active',
    false
  ),
  (
    '72000000-0000-4000-8000-000000000002',
    '71000000-0000-4000-8000-000000000002',
    '예약 보안 메이드',
    '예약 보안 메이드',
    '예약 보안 메이드',
    '예약 보안 메이드',
    0,
    'maid',
    'active',
    false
  );

insert into public.cleaning_template_versions (
  room_type_id,
  cleaning_kind,
  version,
  status,
  duration_minutes,
  photo_slots,
  published_at,
  created_by
)
select
  r.room_type_id,
  'additional',
  1,
  'published',
  30,
  '[]'::jsonb,
  now(),
  '72000000-0000-4000-8000-000000000001'
from public.rooms r
where r.room_number = '135';

select public.create_manual_cleaning_request(
  '72000000-0000-4000-8000-000000000001',
  '73000000-0000-4000-8000-000000000001',
  (select id from public.rooms where room_number = '135'),
  null,
  'additional',
  '2030-01-02',
  '2030-01-02 09:00:00+09',
  '2030-01-02 12:00:00+09',
  (select state_version from public.rooms where room_number = '135'),
  'ADMIN_ADDITIONAL_REQUEST',
  'manual-cleaning-create-0001',
  repeat('1', 64)
);

insert into reservation_security_results values
  (1, 'manual cleaning request materializes an unassigned target and schedule revision', (
    select t.status = 'unassigned'
      and t.source = 'manual_room_request'
      and t.cleaning_kind = 'additional'
      and exists (
        select 1 from public.cleaning_target_schedule_revisions sr
        where sr.cleaning_target_id = t.id and sr.revision = 1
      )
    from public.cleaning_targets t
    where t.id = '73000000-0000-4000-8000-000000000001'
  ));

select public.cancel_manual_cleaning_request(
  '72000000-0000-4000-8000-000000000001',
  '73000000-0000-4000-8000-000000000001',
  1,
  'ADMIN_CANCELLED_REQUEST',
  'manual-cleaning-cancel-0001',
  repeat('2', 64)
);

insert into reservation_security_results values
  (2, 'manual cleaning cancellation is soft and CAS-versioned', (
    select status = 'cancelled'
      and assignment_version = 2
      and cancelled_at is not null
    from public.cleaning_targets
    where id = '73000000-0000-4000-8000-000000000001'
  )),
  (3, 'service role cannot delete or truncate protected operational ledgers', (
    not has_table_privilege('service_role', 'public.reservations', 'delete')
    and not has_table_privilege('service_role', 'public.cleaning_targets', 'delete')
    and not has_table_privilege('service_role', 'public.notifications', 'delete')
    and not has_table_privilege('service_role', 'public.room_pin_access_leases', 'truncate')
  )),
  (4, 'authenticated clients cannot execute manual cleaning commands', (
    not has_function_privilege(
      'authenticated',
      'public.cancel_manual_cleaning_request(uuid,uuid,bigint,text,text,text)',
      'execute'
    )
  ));

select public.mutate_room_operation(
  '72000000-0000-4000-8000-000000000001',
  (select id from public.rooms where room_number = '135'),
  'record_pin_sync',
  (select state_version from public.rooms where room_number = '135'),
  'PIN_VERIFIED_FOR_SECURITY_TEST',
  jsonb_build_object(
    'entityId', '75000000-0000-4000-8000-000000000001',
    'syncStatus', 'verified',
    'pinVersion', 1
  ),
  'security-room-pin-sync-0001',
  repeat('5', 64)
);

select public.create_reservation(
  '72000000-0000-4000-8000-000000000001',
  '74000000-0000-4000-8000-000000000001',
  (select id from public.rooms where room_number = '135'),
  '2030-02-01 16:00:00+09',
  '2030-02-02 11:00:00+09',
  2,
  'encrypted-fixture',
  (select state_version from public.rooms where room_number = '135'),
  'reservation-security-create-0001',
  repeat('3', 64)
);

insert into reservation_security_results values
  (5, 'target reservation preparation blocks its own check-in', (
    select 'CLEANING_REQUIRED' = any(private.room_block_reason_codes(
      (select room_id from public.reservations where id = '74000000-0000-4000-8000-000000000001'),
      '2030-02-01 16:00:00+09',
      false,
      true,
      '74000000-0000-4000-8000-000000000001'
    ))
  )),
  (6, 'an unrelated future preparation obligation does not block the target check-in', (
    select not ('CLEANING_REQUIRED' = any(private.room_block_reason_codes(
      (select room_id from public.reservations where id = '74000000-0000-4000-8000-000000000001'),
      '2030-02-01 16:00:00+09',
      false,
      true,
      '74000000-0000-4000-8000-000000000099'
    )))
  ));

insert into public.cleaning_template_versions (
  room_type_id,
  cleaning_kind,
  version,
  status,
  duration_minutes,
  photo_slots,
  published_at,
  created_by
)
select
  r.room_type_id,
  'checkout',
  1,
  'published',
  60,
  '[]'::jsonb,
  now(),
  '72000000-0000-4000-8000-000000000001'
from public.rooms r
where r.room_number = '136';

select public.mutate_room_operation(
  '72000000-0000-4000-8000-000000000001',
  (select id from public.rooms where room_number = '136'),
  'record_pin_sync',
  (select state_version from public.rooms where room_number = '136'),
  'PIN_VERIFIED_FOR_MANUAL_CHECKOUT_TEST',
  jsonb_build_object(
    'entityId', '75000000-0000-4000-8000-000000000002',
    'syncStatus', 'verified',
    'pinVersion', 1
  ),
  'manual-checkout-pin-sync-0001',
  repeat('6', 64)
);

select public.create_reservation(
  '72000000-0000-4000-8000-000000000001',
  '74000000-0000-4000-8000-000000000002',
  (select id from public.rooms where room_number = '136'),
  '2030-03-01 16:00:00+09',
  '2030-03-02 11:00:00+09',
  2,
  null,
  (select state_version from public.rooms where room_number = '136'),
  'manual-checkout-reservation-0001',
  repeat('7', 64)
);

update public.reservations
set actual_check_in_at = '2030-03-01 16:00:00+09'
where id = '74000000-0000-4000-8000-000000000002';

insert into public.cleaning_targets (
  id,
  room_id,
  reservation_id,
  checkout_obligation_id,
  cleaning_kind,
  source,
  source_key,
  original_service_date,
  effective_service_date,
  available_from,
  due_at,
  status,
  room_type_snapshot,
  fee_snapshot,
  template_snapshot,
  created_by
)
select
  '73000000-0000-4000-8000-000000000002',
  r.room_id,
  r.id,
  r.checkout_obligation_id,
  'checkout',
  'scheduled_checkout',
  'scheduled-checkout:74000000-0000-4000-8000-000000000002',
  '2030-03-02',
  '2030-03-02',
  r.check_out_at,
  null,
  'notified',
  jsonb_build_object('roomTypeId', rm.room_type_id),
  rt.base_cleaning_fee,
  jsonb_build_object('templateId', tv.id, 'version', tv.version),
  '72000000-0000-4000-8000-000000000001'
from public.reservations r
join public.rooms rm on rm.id = r.room_id
join public.room_types rt on rt.id = rm.room_type_id
join public.cleaning_template_versions tv
  on tv.room_type_id = rm.room_type_id
  and tv.cleaning_kind = 'checkout'
  and tv.status = 'published'
where r.id = '74000000-0000-4000-8000-000000000002';

update public.checkout_cleaning_obligations
set status = 'materialized',
    current_cleaning_target_id = '73000000-0000-4000-8000-000000000002'
where reservation_id = '74000000-0000-4000-8000-000000000002';

insert into public.cleaning_target_schedule_revisions (
  cleaning_target_id, revision, effective_service_date, available_from, due_at,
  reason_code, changed_by
) values (
  '73000000-0000-4000-8000-000000000002', 1, '2030-03-02',
  '2030-03-02 11:00:00+09', null, 'INITIAL_ASSIGNMENT',
  '72000000-0000-4000-8000-000000000001'
);

insert into public.cleaning_assignments (
  id, cleaning_target_id, maid_profile_id, sequence_number, revision,
  is_current, notified_at, changed_by
) values (
  '76000000-0000-4000-8000-000000000001',
  '73000000-0000-4000-8000-000000000002',
  '72000000-0000-4000-8000-000000000002',
  1, 1, true, '2030-03-01 12:00:00+09',
  '72000000-0000-4000-8000-000000000001'
);

insert into public.cleaning_attempts (
  id, cleaning_target_id, assignment_id, maid_profile_id, attempt_number,
  status, assignment_revision, template_snapshot, room_snapshot
) values (
  '77000000-0000-4000-8000-000000000001',
  '73000000-0000-4000-8000-000000000002',
  '76000000-0000-4000-8000-000000000001',
  '72000000-0000-4000-8000-000000000002',
  1, 'scheduled', 1, '{}'::jsonb, '{}'::jsonb
);

insert into public.room_pin_access_leases (
  id, room_id, reservation_id, cleaning_target_id, assignment_id,
  pin_version, issued_to, issued_at, expires_at
)
select
  '78000000-0000-4000-8000-000000000001',
  r.room_id,
  r.id,
  '73000000-0000-4000-8000-000000000002',
  '76000000-0000-4000-8000-000000000001',
  1,
  '72000000-0000-4000-8000-000000000002',
  '2030-03-01 12:00:00+09',
  '2030-03-02 14:00:00+09'
from public.reservations r
where r.id = '74000000-0000-4000-8000-000000000002';

select public.manual_checkout_reservation(
  '72000000-0000-4000-8000-000000000001',
  '74000000-0000-4000-8000-000000000002',
  1,
  'GUEST_LEFT_EARLY',
  '2030-03-01 18:00:00+09',
  'manual-checkout-revision-0001',
  repeat('8', 64)
);

insert into reservation_security_results values
  (9, 'manual checkout replaces the current assignment and scheduled attempt revisions', (
    select
      (select not is_current and ended_at is not null
       from public.cleaning_assignments where id = '76000000-0000-4000-8000-000000000001')
      and (select count(*) = 1 and bool_and(revision = 2 and is_current)
       from public.cleaning_assignments
       where cleaning_target_id = '73000000-0000-4000-8000-000000000002'
         and id <> '76000000-0000-4000-8000-000000000001')
      and (select status = 'superseded'
       from public.cleaning_attempts where id = '77000000-0000-4000-8000-000000000001')
      and (select count(*) = 1 and bool_and(attempt_number = 2 and status = 'scheduled')
       from public.cleaning_attempts
       where cleaning_target_id = '73000000-0000-4000-8000-000000000002'
         and id <> '77000000-0000-4000-8000-000000000001')
  )),
  (10, 'manual checkout revokes old PIN lease, reissues metadata, and notifies the maid', (
    select
      (select revoked_at is not null
       from public.room_pin_access_leases where id = '78000000-0000-4000-8000-000000000001')
      and (select count(*) = 1
       from public.room_pin_access_leases
       where cleaning_target_id = '73000000-0000-4000-8000-000000000002'
         and id <> '78000000-0000-4000-8000-000000000001'
         and revoked_at is null and revealed_at is null)
      and (select count(*) = 1
       from public.notifications
       where cleaning_target_id = '73000000-0000-4000-8000-000000000002'
         and category = 'cleaning_schedule_changed')
  ));

update public.reservations
set status = 'cancelled',
    cancelled_at = '2029-01-01 00:00:00+09'
where id = '74000000-0000-4000-8000-000000000001';
update public.preparation_obligations
set status = 'cancelled', invalidated_reason_code = 'RETENTION_TEST'
where reservation_id = '74000000-0000-4000-8000-000000000001';
update public.checkout_cleaning_obligations
set status = 'cancelled', cancelled_at = '2029-01-01 00:00:00+09',
    cancellation_reason_code = 'RETENTION_TEST'
where reservation_id = '74000000-0000-4000-8000-000000000001';

select public.process_due_reservation_transitions(
  '72000000-0000-4000-8000-000000000001',
  '2030-01-01 00:00:00+09',
  'retention-worker-20300101',
  repeat('4', 64)
);

insert into reservation_security_results values
  (7, 'guest names are purged 180 days after cancellation', (
    select guest_name_encrypted is null
    from public.reservations
    where id = '74000000-0000-4000-8000-000000000001'
  ));

do $$
begin
  perform public.get_room_operational_projection(
    '72000000-0000-4000-8000-000000000002',
    null
  );
  insert into reservation_security_results values
    (8, 'maid cannot read the global room operational projection', false);
exception when insufficient_privilege then
  insert into reservation_security_results values
    (8, 'maid cannot read the global room operational projection', sqlerrm like '%ADMIN_REQUIRED%');
end;
$$;

insert into reservation_security_results values
  (11, 'all reservation mutation paths use the same transaction lock ordering point', (
    select bool_and(
      pg_get_functiondef(p.oid) like '%room-management:reservation-command%'
    )
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'create_reservation',
        'change_reservation',
        'cancel_reservation',
        'manual_checkout_reservation',
        'process_due_reservation_transitions',
        'create_manual_cleaning_request',
        'cancel_manual_cleaning_request'
      )
  ));

select '1..11';

select case
  when passed then format('ok %s - %s', test_number, description)
  else format('not ok %s - %s', test_number, description)
end
from reservation_security_results
order by test_number;

rollback;
