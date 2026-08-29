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

insert into public.cleaning_assignments (
  id, cleaning_target_id, maid_profile_id, sequence_number, revision,
  is_current, ended_at, change_reason_code, changed_by
) values (
  '76000000-0000-4000-8000-000000000010',
  '73000000-0000-4000-8000-000000000001',
  '72000000-0000-4000-8000-000000000002',
  1, 1, false, '2030-01-01 09:00:00+09', 'PAST_UNSTARTED_REASSIGNMENT',
  '72000000-0000-4000-8000-000000000001'
);

insert into public.cleaning_attempts (
  id, cleaning_target_id, assignment_id, maid_profile_id, attempt_number,
  status, assignment_revision, ended_at, end_reason, template_snapshot, room_snapshot
) values (
  '77000000-0000-4000-8000-000000000010',
  '73000000-0000-4000-8000-000000000001',
  '76000000-0000-4000-8000-000000000010',
  '72000000-0000-4000-8000-000000000002',
  1, 'superseded', 1, '2030-01-01 09:00:00+09', 'PAST_UNSTARTED_REASSIGNMENT',
  '{}'::jsonb, '{}'::jsonb
);

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
  'stayover',
  1,
  'published',
  45,
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

do $$
begin
  perform public.create_manual_cleaning_request(
    '72000000-0000-4000-8000-000000000001',
    '73000000-0000-4000-8000-000000000003',
    (select id from public.rooms where room_number = '136'),
    '74000000-0000-4000-8000-000000000002',
    'stayover',
    '2030-03-02',
    '2030-03-02 10:00:00+09',
    '2030-03-02 12:00:00+09',
    (select state_version from public.rooms where room_number = '136'),
    'OUTSIDE_STAY_WINDOW',
    'stayover-window-invalid-0001',
    repeat('9', 64)
  );
  insert into reservation_security_results values
    (13, 'stayover requests must remain inside the occupied access window', false);
exception when check_violation then
  insert into reservation_security_results values
    (13, 'stayover requests must remain inside the occupied access window', sqlerrm like '%STAYOVER_ACCESS_WINDOW_INVALID%');
end;
$$;

select public.mutate_room_operation(
  '72000000-0000-4000-8000-000000000001',
  (select id from public.rooms where room_number = '240'),
  'record_pin_sync',
  (select state_version from public.rooms where room_number = '240'),
  'PIN_VERIFIED_FOR_EXTENSION_TEST',
  jsonb_build_object(
    'entityId', '75000000-0000-4000-8000-000000000020',
    'syncStatus', 'verified',
    'pinVersion', 1
  ),
  'extension-pin-sync-0001',
  repeat('1', 64)
);

select public.create_reservation(
  '72000000-0000-4000-8000-000000000001',
  '74000000-0000-4000-8000-000000000020',
  (select id from public.rooms where room_number = '240'),
  '2028-01-01 16:00:00+09',
  '2028-01-02 11:00:00+09',
  2,
  null,
  (select state_version from public.rooms where room_number = '240'),
  'extension-create-0001',
  repeat('2', 64)
);

update public.reservations
set actual_check_in_at = check_in_at
where id = '74000000-0000-4000-8000-000000000020';

select public.process_due_reservation_transitions(
  '72000000-0000-4000-8000-000000000001',
  '2028-01-02 11:00:00+09',
  'extension-checkout-worker-0001',
  repeat('3', 64)
);

select public.change_reservation(
  '72000000-0000-4000-8000-000000000001',
  '74000000-0000-4000-8000-000000000020',
  (select id from public.rooms where room_number = '240'),
  '2028-01-01 16:00:00+09',
  '2028-01-02 12:00:00+09',
  2,
  'keep',
  null,
  2,
  'GUEST_EXTENDED_AFTER_AUTOMATIC_CHECKOUT',
  'extension-change-0001',
  repeat('4', 64)
);

insert into reservation_security_results values
  (20, 'automatic checkout extension resumes a genuinely occupied reservation', (
    select r.status = 'active'
      and r.actual_check_in_at is not null
      and r.actual_checkout_at is null
      and exists (
        select 1 from public.room_occupancy_events e
        where e.reservation_id = r.id
          and e.event_type = 'occupancy_resumed'
      )
    from public.reservations r
    where r.id = '74000000-0000-4000-8000-000000000020'
  ));

select public.mutate_room_operation(
  '72000000-0000-4000-8000-000000000001',
  (select id from public.rooms where room_number = '332'),
  'record_pin_sync',
  (select state_version from public.rooms where room_number = '332'),
  'PIN_VERIFIED_FOR_ADJACENT_TEST',
  jsonb_build_object(
    'entityId', '75000000-0000-4000-8000-000000000021',
    'syncStatus', 'verified',
    'pinVersion', 1
  ),
  'adjacent-pin-sync-0001',
  repeat('5', 64)
);

select public.create_reservation(
  '72000000-0000-4000-8000-000000000001',
  '74000000-0000-4000-8000-000000000021',
  (select id from public.rooms where room_number = '332'),
  '2029-01-01 16:00:00+09',
  '2029-01-02 11:00:00+09',
  2,
  null,
  (select state_version from public.rooms where room_number = '332'),
  'adjacent-first-create-0001',
  repeat('6', 64)
);

select public.create_reservation(
  '72000000-0000-4000-8000-000000000001',
  '74000000-0000-4000-8000-000000000022',
  (select id from public.rooms where room_number = '332'),
  '2029-01-02 11:00:00+09',
  '2029-01-03 11:00:00+09',
  2,
  null,
  (select state_version from public.rooms where room_number = '332'),
  'adjacent-second-create-0001',
  repeat('7', 64)
);

insert into public.cleaning_targets (
  id, room_id, reservation_id, cleaning_kind, source, source_key,
  original_service_date, effective_service_date, status,
  room_type_snapshot, fee_snapshot, template_snapshot, created_by
) values (
  '73000000-0000-4000-8000-000000000021',
  (select id from public.rooms where room_number = '332'),
  null,
  'additional',
  'manual_room_request',
  'adjacent-preparation-proof',
  '2029-01-02',
  '2029-01-02',
  'approved',
  '{}'::jsonb,
  16000,
  '{}'::jsonb,
  '72000000-0000-4000-8000-000000000001'
);

insert into public.cleaning_assignments (
  id, cleaning_target_id, maid_profile_id, sequence_number, revision, changed_by
) values (
  '76000000-0000-4000-8000-000000000021',
  '73000000-0000-4000-8000-000000000021',
  '72000000-0000-4000-8000-000000000002',
  1,
  1,
  '72000000-0000-4000-8000-000000000001'
);

insert into public.cleaning_attempts (
  id, cleaning_target_id, assignment_id, maid_profile_id, attempt_number,
  status, assignment_revision, started_at, field_completed_at, ended_at,
  template_snapshot, room_snapshot
) values (
  '77000000-0000-4000-8000-000000000021',
  '73000000-0000-4000-8000-000000000021',
  '76000000-0000-4000-8000-000000000021',
  '72000000-0000-4000-8000-000000000002',
  1,
  'approved',
  1,
  '2029-01-02 09:00:00+09',
  '2029-01-02 10:00:00+09',
  '2029-01-02 10:05:00+09',
  '{}'::jsonb,
  '{}'::jsonb
);

insert into public.cleaning_submissions (
  id, cleaning_attempt_id, client_submission_id, version, status,
  photo_manifest, submitted_by, submitted_at
) values (
  '79000000-0000-4000-8000-000000000021',
  '77000000-0000-4000-8000-000000000021',
  '79000000-0000-4000-8000-000000000022',
  1,
  'approved',
  '{}'::jsonb,
  '72000000-0000-4000-8000-000000000002',
  '2029-01-02 10:05:00+09'
);

insert into public.inspection_decisions (
  id, submission_id, decision, reason_code, decided_by, decided_at
) values (
  '79000000-0000-4000-8000-000000000023',
  '79000000-0000-4000-8000-000000000021',
  'approved',
  'ADJACENT_CHECKIN_PROOF',
  '72000000-0000-4000-8000-000000000001',
  '2029-01-02 10:10:00+09'
);

update public.preparation_obligations
set status = 'approved',
    current_attempt_id = '77000000-0000-4000-8000-000000000021',
    approved_submission_id = '79000000-0000-4000-8000-000000000021'
where reservation_id = '74000000-0000-4000-8000-000000000022';

update public.reservations
set actual_check_in_at = check_in_at
where id = '74000000-0000-4000-8000-000000000021';

select public.process_due_reservation_transitions(
  '72000000-0000-4000-8000-000000000001',
  '2029-01-02 11:00:00+09',
  'adjacent-transition-worker-0001',
  repeat('8', 64)
);

insert into reservation_security_results values
  (21, 'same-instant adjacent stays checkout before the next check-in', (
    select
      (select status = 'checked_out'
       from public.reservations where id = '74000000-0000-4000-8000-000000000021')
      and (select actual_check_in_at = '2029-01-02 11:00:00+09'::timestamptz
       from public.reservations where id = '74000000-0000-4000-8000-000000000022')
  ));

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
  is_current, notified_at, ended_at, change_reason_code, changed_by
) values
(
  '76000000-0000-4000-8000-000000000000',
  '73000000-0000-4000-8000-000000000002',
  '72000000-0000-4000-8000-000000000002',
  1, 1, false, null, '2030-03-01 11:00:00+09', 'PAST_UNSTARTED_REASSIGNMENT',
  '72000000-0000-4000-8000-000000000001'
),
(
  '76000000-0000-4000-8000-000000000001',
  '73000000-0000-4000-8000-000000000002',
  '72000000-0000-4000-8000-000000000002',
  1, 2, true, '2030-03-01 12:00:00+09', null, null,
  '72000000-0000-4000-8000-000000000001'
);

insert into public.cleaning_attempts (
  id, cleaning_target_id, assignment_id, maid_profile_id, attempt_number,
  status, assignment_revision, template_snapshot, room_snapshot
) values
(
  '77000000-0000-4000-8000-000000000000',
  '73000000-0000-4000-8000-000000000002',
  '76000000-0000-4000-8000-000000000000',
  '72000000-0000-4000-8000-000000000002',
  1, 'superseded', 1, '{}'::jsonb, '{}'::jsonb
),
(
  '77000000-0000-4000-8000-000000000001',
  '73000000-0000-4000-8000-000000000002',
  '76000000-0000-4000-8000-000000000001',
  '72000000-0000-4000-8000-000000000002',
  2, 'scheduled', 2, '{}'::jsonb, '{}'::jsonb
);

insert into public.room_pin_access_leases (
  id, room_id, reservation_id, cleaning_target_id, assignment_id, attempt_id,
  pin_version, issued_to, issued_at, expires_at
)
select
  '78000000-0000-4000-8000-000000000001',
  r.room_id,
  r.id,
  '73000000-0000-4000-8000-000000000002',
  '76000000-0000-4000-8000-000000000001',
  '77000000-0000-4000-8000-000000000001',
  1,
  '72000000-0000-4000-8000-000000000002',
  '2030-03-01 12:00:00+09',
  '2030-03-02 14:00:00+09'
from public.reservations r
where r.id = '74000000-0000-4000-8000-000000000002';

do $$
begin
  begin
    insert into public.room_pin_access_leases (
      id, room_id, reservation_id, cleaning_target_id, assignment_id, attempt_id,
      pin_version, issued_to, issued_at, expires_at
    ) values (
      '78000000-0000-4000-8000-000000000002',
      (select id from public.rooms where room_number = '135'),
      '74000000-0000-4000-8000-000000000002',
      '73000000-0000-4000-8000-000000000002',
      '76000000-0000-4000-8000-000000000001',
      '77000000-0000-4000-8000-000000000001',
      1,
      '72000000-0000-4000-8000-000000000002',
      '2030-03-01 12:00:00+09',
      '2030-03-02 14:00:00+09'
    );
    insert into reservation_security_results values
      (18, 'PIN leases reject cross-room work identities', false);
  exception when foreign_key_violation or check_violation then
    insert into reservation_security_results values
      (18, 'PIN leases reject cross-room work identities', true);
  end;
end;
$$;

insert into public.cleaning_submissions (
  id, cleaning_attempt_id, client_submission_id, version, status,
  photo_manifest, submitted_by, submitted_at
) values (
  '79000000-0000-4000-8000-000000000001',
  '77000000-0000-4000-8000-000000000001',
  '79000000-0000-4000-8000-000000000002',
  1,
  'approved',
  '{}'::jsonb,
  '72000000-0000-4000-8000-000000000002',
  '2030-03-01 13:00:00+09'
);

insert into public.inspection_decisions (
  id, submission_id, decision, reason_code, decided_by, decided_at
) values (
  '79000000-0000-4000-8000-000000000003',
  '79000000-0000-4000-8000-000000000001',
  'approved',
  'SECURITY_PROOF_FIXTURE',
  '72000000-0000-4000-8000-000000000001',
  '2030-03-01 13:05:00+09'
);

do $$
begin
  begin
    update public.preparation_obligations
    set status = 'approved',
        current_attempt_id = '77000000-0000-4000-8000-000000000001',
        approved_submission_id = '79000000-0000-4000-8000-000000000001'
    where reservation_id = '74000000-0000-4000-8000-000000000001';
    insert into reservation_security_results values
      (19, 'preparation approval rejects proof from another room', false);
  exception when check_violation then
    insert into reservation_security_results values
      (19, 'preparation approval rejects proof from another room', sqlerrm like '%PREPARATION_ATTEMPT_ROOM_MISMATCH%');
  end;
end;
$$;

do $$
begin
  perform public.create_manual_cleaning_request(
    '72000000-0000-4000-8000-000000000001',
    '73000000-0000-4000-8000-000000000004',
    (select id from public.rooms where room_number = '136'),
    null,
    'additional',
    '2030-03-01',
    '2030-03-01 17:00:00+09',
    '2030-03-01 18:00:00+09',
    (select state_version from public.rooms where room_number = '136'),
    'OCCUPIED_ADDITIONAL_REQUEST',
    'additional-occupied-invalid-0001',
    repeat('a', 64)
  );
  insert into reservation_security_results values
    (12, 'additional cleaning requests require a vacant room window', false);
exception when check_violation then
  insert into reservation_security_results values
    (12, 'additional cleaning requests require a vacant room window', sqlerrm like '%VACANT_ROOM_REQUIRED%');
end;
$$;

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
      and (select count(*) = 1 and bool_and(revision = 3 and is_current)
       from public.cleaning_assignments
       where cleaning_target_id = '73000000-0000-4000-8000-000000000002'
         and id not in (
           '76000000-0000-4000-8000-000000000000',
           '76000000-0000-4000-8000-000000000001'
         ))
      and (select status = 'superseded'
       from public.cleaning_attempts where id = '77000000-0000-4000-8000-000000000001')
      and (select count(*) = 1 and bool_and(attempt_number = 3 and status = 'scheduled')
       from public.cleaning_attempts
       where cleaning_target_id = '73000000-0000-4000-8000-000000000002'
         and id not in (
           '77000000-0000-4000-8000-000000000000',
           '77000000-0000-4000-8000-000000000001'
         ))
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

select public.create_reservation(
  '72000000-0000-4000-8000-000000000001',
  '74000000-0000-4000-8000-000000000003',
  (select id from public.rooms where room_number = '135'),
  '2031-01-01 16:00:00+09',
  '2031-01-02 11:00:00+09',
  2,
  null,
  (select state_version from public.rooms where room_number = '135'),
  'missed-stay-create-0001',
  repeat('b', 64)
);

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
  status,
  room_type_snapshot,
  fee_snapshot,
  template_snapshot,
  created_by
)
select
  '73000000-0000-4000-8000-000000000005',
  r.room_id,
  r.id,
  r.checkout_obligation_id,
  'checkout',
  'scheduled_checkout',
  'scheduled-checkout:74000000-0000-4000-8000-000000000003',
  '2031-01-02',
  '2031-01-02',
  r.check_out_at,
  'unassigned',
  jsonb_build_object('roomTypeId', rm.room_type_id),
  rt.base_cleaning_fee,
  jsonb_build_object(
    'templateId', tv.id,
    'version', tv.version,
    'durationMinutes', tv.duration_minutes
  ),
  '72000000-0000-4000-8000-000000000001'
from public.reservations r
join public.rooms rm on rm.id = r.room_id
join public.room_types rt on rt.id = rm.room_type_id
join public.cleaning_template_versions tv
  on tv.room_type_id = rm.room_type_id
  and tv.cleaning_kind = 'checkout'
  and tv.status = 'published'
where r.id = '74000000-0000-4000-8000-000000000003';

update public.checkout_cleaning_obligations
set status = 'materialized',
    current_cleaning_target_id = '73000000-0000-4000-8000-000000000005'
where reservation_id = '74000000-0000-4000-8000-000000000003';

insert into public.cleaning_target_schedule_revisions (
  cleaning_target_id, revision, effective_service_date, available_from, due_at,
  reason_code, changed_by
) values (
  '73000000-0000-4000-8000-000000000005', 1, '2031-01-02',
  '2031-01-02 11:00:00+09', null, 'INITIAL_TARGET',
  '72000000-0000-4000-8000-000000000001'
);

select public.create_reservation(
  '72000000-0000-4000-8000-000000000001',
  '74000000-0000-4000-8000-000000000004',
  (select id from public.rooms where room_number = '135'),
  '2031-01-02 16:00:00+09',
  '2031-01-03 11:00:00+09',
  2,
  null,
  (select state_version from public.rooms where room_number = '135'),
  'next-stay-create-0001',
  repeat('d', 64)
);

insert into reservation_security_results values
  (15, 'next reservation changes update an unassigned target and obligation due revision', (
    select
      (select due_at = '2031-01-02 15:30:00+09'::timestamptz
         and assignment_version = 2
       from public.cleaning_targets
       where id = '73000000-0000-4000-8000-000000000005')
      and (select due_at = '2031-01-02 15:30:00+09'::timestamptz
       from public.checkout_cleaning_obligations
       where reservation_id = '74000000-0000-4000-8000-000000000003')
      and (select count(*) = 1
       from public.cleaning_target_schedule_revisions
       where cleaning_target_id = '73000000-0000-4000-8000-000000000005'
         and revision = 2
         and reason_code = 'NEXT_RESERVATION_CHANGED')
  ));

select public.process_due_reservation_transitions(
  '72000000-0000-4000-8000-000000000001',
  '2031-01-03 12:00:00+09',
  'missed-stay-catchup-0001',
  repeat('c', 64)
);

insert into reservation_security_results values
  (14, 'scheduler catch-up closes a fully missed stay without fabricating check-in', (
    select r.status = 'checked_out'
      and r.actual_check_in_at is null
      and r.actual_checkout_at = r.check_out_at
      and exists (
        select 1 from public.room_occupancy_events e
        where e.reservation_id = r.id
          and e.event_type = 'scheduled_checkout'
          and (e.before_state ->> 'occupied')::boolean = false
      )
    from public.reservations r
    where r.id = '74000000-0000-4000-8000-000000000003'
  ));

select public.create_reservation(
  '72000000-0000-4000-8000-000000000001',
  '74000000-0000-4000-8000-000000000010',
  (select id from public.rooms where room_number = '135'),
  date_trunc('minute', now()) - interval '2 days',
  date_trunc('minute', now()) + interval '2 days',
  2,
  null,
  (select state_version from public.rooms where room_number = '135'),
  'past-checkout-create-0001',
  repeat('f', 64)
);

update public.reservations
set actual_check_in_at = check_in_at
where id = '74000000-0000-4000-8000-000000000010';

do $$
declare
  v_reservation public.reservations%rowtype;
begin
  select * into v_reservation
  from public.reservations
  where id = '74000000-0000-4000-8000-000000000010';

  perform public.change_reservation(
    '72000000-0000-4000-8000-000000000001',
    v_reservation.id,
    v_reservation.room_id,
    v_reservation.check_in_at,
    date_trunc('minute', now()) - interval '1 minute',
    v_reservation.guest_count,
    'keep',
    null,
    v_reservation.version,
    'SHORTEN_TO_PAST',
    'past-checkout-change-0001',
    repeat('0', 64)
  );
  insert into reservation_security_results values
    (16, 'occupied reservations require manual checkout for a current or past end time', false);
exception when check_violation then
  insert into reservation_security_results values
    (16, 'occupied reservations require manual checkout for a current or past end time', sqlerrm like '%MANUAL_CHECKOUT_REQUIRED%');
end;
$$;

do $$
begin
  begin
    insert into public.cleaning_targets (
      id, room_id, reservation_id, checkout_obligation_id, cleaning_kind,
      source, source_key, original_service_date, effective_service_date,
      room_type_snapshot, fee_snapshot, template_snapshot, created_by
    ) values (
      '73000000-0000-4000-8000-000000000011',
      (select id from public.rooms where room_number = '135'),
      '74000000-0000-4000-8000-000000000010',
      (select checkout_obligation_id from public.reservations where id = '74000000-0000-4000-8000-000000000001'),
      'checkout',
      'scheduled_checkout',
      'cross-obligation-contract-test',
      (now() at time zone 'Asia/Seoul')::date,
      (now() at time zone 'Asia/Seoul')::date,
      '{}'::jsonb,
      16000,
      '{}'::jsonb,
      '72000000-0000-4000-8000-000000000001'
    );
    set constraints cleaning_targets_checkout_obligation_contract_fk immediate;
    insert into reservation_security_results values
      (17, 'checkout targets reject another reservation obligation', false);
  exception when foreign_key_violation then
    insert into reservation_security_results values
      (17, 'checkout targets reject another reservation obligation', true);
  end;
end;
$$;

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

update public.cleaning_targets
set status = 'approved'
where id = '73000000-0000-4000-8000-000000000005';

update public.checkout_cleaning_obligations
set status = 'completed'
where reservation_id = '74000000-0000-4000-8000-000000000003';

do $$
begin
  begin
    update public.cleaning_targets
    set status = 'cancelled'
    where id = '73000000-0000-4000-8000-000000000005';
    insert into reservation_security_results values
      (22, 'completed checkout targets cannot regress through direct service-role DML', false);
  exception when check_violation then
    insert into reservation_security_results values
      (22, 'completed checkout targets cannot regress through direct service-role DML', sqlerrm like '%TERMINAL_CHECKOUT_TARGET_IMMUTABLE%');
  end;
end;
$$;

select '1..22';

select case
  when passed then format('ok %s - %s', test_number, description)
  else format('not ok %s - %s', test_number, description)
end
from reservation_security_results
order by test_number;

rollback;
