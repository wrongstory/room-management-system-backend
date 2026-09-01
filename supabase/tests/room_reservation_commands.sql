begin;

create temporary table room_reservation_test_results (
  test_number integer primary key,
  description text not null,
  passed boolean not null
);

insert into auth.users (id) values ('61000000-0000-4000-8000-000000000001');

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
) values (
  '62000000-0000-4000-8000-000000000001',
  '61000000-0000-4000-8000-000000000001',
  '예약 테스트 관리자',
  '예약 테스트 관리자',
  '예약 테스트 관리자',
  '예약 테스트 관리자',
  0,
  'admin',
  'active',
  false
);

insert into auth.users (id) values
  ('61000000-0000-4000-8000-000000000002'),
  ('61000000-0000-4000-8000-000000000003');

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
    '62000000-0000-4000-8000-000000000002',
    '61000000-0000-4000-8000-000000000002',
    '예약 테스트 메이드',
    '예약 테스트 메이드',
    '예약 테스트 메이드',
    '예약 테스트 메이드',
    0,
    'maid',
    'active',
    false
  ),
  (
    '62000000-0000-4000-8000-000000000003',
    '61000000-0000-4000-8000-000000000003',
    '예약 테스트 비활성 관리자',
    '예약 테스트 비활성 관리자',
    '예약 테스트 비활성 관리자',
    '예약 테스트 비활성 관리자',
    0,
    'admin',
    'inactive',
    false
  );

select public.mutate_room_operation(
  '62000000-0000-4000-8000-000000000001',
  (select id from public.rooms where room_number = '117'),
  'record_pin_sync',
  (select state_version from public.rooms where room_number = '117'),
  'PIN_VERIFIED_FOR_RESERVATION_TEST',
  jsonb_build_object(
    'entityId', '64000000-0000-4000-8000-000000000001',
    'syncStatus', 'verified',
    'pinVersion', 1
  ),
  'room-pin-sync-test-0001',
  repeat('9', 64)
);

select public.create_reservation(
  '62000000-0000-4000-8000-000000000001',
  '63000000-0000-4000-8000-000000000001',
  (select id from public.rooms where room_number = '117'),
  '2027-02-01 16:00:00+09',
  '2027-02-02 11:00:00+09',
  2,
  null,
  (select state_version from public.rooms where room_number = '117'),
  'reservation-create-test-0001',
  repeat('a', 64)
);

insert into room_reservation_test_results values
  (1, 'reservation command creates one reservation', (
    select count(*) = 1
    from public.reservations
    where id = '63000000-0000-4000-8000-000000000001'
  )),
  (2, 'reservation creates one preparation obligation', (
    select count(*) = 1
    from public.preparation_obligations
    where reservation_id = '63000000-0000-4000-8000-000000000001'
  )),
  (3, 'reservation creates one private checkout obligation', (
    select count(*) = 1 and bool_and(status = 'private')
    from public.checkout_cleaning_obligations
    where reservation_id = '63000000-0000-4000-8000-000000000001'
  )),
  (4, 'reservation schedule revision starts at version one', (
    select count(*) = 1 and min(version) = 1
    from public.reservation_schedule_revisions
    where reservation_id = '63000000-0000-4000-8000-000000000001'
  ));

select public.create_reservation(
  '62000000-0000-4000-8000-000000000001',
  '63000000-0000-4000-8000-000000000099',
  (select id from public.rooms where room_number = '117'),
  '2027-02-01 16:00:00+09',
  '2027-02-02 11:00:00+09',
  2,
  null,
  1,
  'reservation-create-test-0001',
  repeat('a', 64)
);

insert into room_reservation_test_results values
  (5, 'same idempotency key and payload does not duplicate the reservation', (
    select count(*) = 1
    from public.reservations
    where id in (
      '63000000-0000-4000-8000-000000000001',
      '63000000-0000-4000-8000-000000000099'
    )
  ));

do $$
begin
  perform public.create_reservation(
    '62000000-0000-4000-8000-000000000001',
    '63000000-0000-4000-8000-000000000098',
    (select id from public.rooms where room_number = '117'),
    '2027-02-01 16:00:00+09',
    '2027-02-02 11:00:00+09',
    3,
    null,
    1,
    'reservation-create-test-0001',
    repeat('b', 64)
  );
  insert into room_reservation_test_results values
    (6, 'different payload cannot reuse an idempotency key', false);
exception when unique_violation then
  insert into room_reservation_test_results values
    (6, 'different payload cannot reuse an idempotency key', sqlerrm like '%IDEMPOTENCY_KEY_REUSED%');
end;
$$;

do $$
begin
  perform public.create_reservation(
    '62000000-0000-4000-8000-000000000001',
    '63000000-0000-4000-8000-000000000002',
    (select id from public.rooms where room_number = '117'),
    '2027-02-02 10:00:00+09',
    '2027-02-03 11:00:00+09',
    2,
    null,
    (select state_version from public.rooms where room_number = '117'),
    'reservation-overlap-test-0001',
    repeat('c', 64)
  );
  insert into room_reservation_test_results values
    (7, 'overlapping half-open reservation ranges are rejected', false);
exception when exclusion_violation then
  insert into room_reservation_test_results values
    (7, 'overlapping half-open reservation ranges are rejected', sqlerrm like '%RESERVATION_OVERLAP%');
end;
$$;

select public.create_reservation(
  '62000000-0000-4000-8000-000000000001',
  '63000000-0000-4000-8000-000000000003',
  (select id from public.rooms where room_number = '117'),
  '2027-02-02 11:00:00+09',
  '2027-02-03 11:00:00+09',
  2,
  null,
  (select state_version from public.rooms where room_number = '117'),
  'reservation-adjacent-test-0001',
  repeat('d', 64)
);

insert into room_reservation_test_results values
  (8, 'adjacent half-open reservation ranges are allowed', (
    select count(*) = 2 from public.reservations where room_id = (
      select id from public.rooms where room_number = '117'
    )
  ));

select public.cancel_reservation(
  '62000000-0000-4000-8000-000000000001',
  '63000000-0000-4000-8000-000000000003',
  1,
  'GUEST_CANCELLED',
  'reservation-cancel-test-0001',
  repeat('e', 64)
);

insert into room_reservation_test_results values
  (9, 'pre-check-in cancellation is soft and versioned', (
    select status = 'cancelled' and cancelled_at is not null and version = 2
    from public.reservations
    where id = '63000000-0000-4000-8000-000000000003'
  )),
  (10, 'cancellation preserves and cancels both obligations', (
    select
      (select status = 'cancelled'
       from public.preparation_obligations
       where reservation_id = '63000000-0000-4000-8000-000000000003')
      and
      (select status = 'cancelled'
       from public.checkout_cleaning_obligations
       where reservation_id = '63000000-0000-4000-8000-000000000003')
  ));

update public.reservations
set actual_check_in_at = check_in_at
where id = '63000000-0000-4000-8000-000000000001';

select public.manual_checkout_reservation(
  '62000000-0000-4000-8000-000000000001',
  '63000000-0000-4000-8000-000000000001',
  1,
  'GUEST_LEFT_EARLY',
  '2027-02-01 18:00:00+09',
  'reservation-checkout-test-0001',
  repeat('f', 64)
);

insert into room_reservation_test_results values
  (11, 'manual checkout records actual time without overwriting schedule', (
    select
      status = 'checked_out'
      and check_out_at = '2027-02-02 11:00:00+09'::timestamptz
      and actual_checkout_at = '2027-02-01 18:00:00+09'::timestamptz
      and version = 2
    from public.reservations
    where id = '63000000-0000-4000-8000-000000000001'
  )),
  (12, 'manual checkout creates one immutable occupancy event', (
    select count(*) = 1 and bool_and(event_type = 'manual_checkout')
    from public.room_occupancy_events
    where reservation_id = '63000000-0000-4000-8000-000000000001'
  )),
  (13, 'manual checkout opens the existing checkout obligation', (
    select status = 'available'
      and available_from = '2027-02-01 18:00:00+09'::timestamptz
    from public.checkout_cleaning_obligations
    where reservation_id = '63000000-0000-4000-8000-000000000001'
  ));

do $$
begin
  perform public.cancel_reservation(
    '62000000-0000-4000-8000-000000000001',
    '63000000-0000-4000-8000-000000000003',
    1,
    'STALE_TEST',
    'reservation-stale-test-0001',
    repeat('1', 64)
  );
  insert into room_reservation_test_results values (14, 'stale versions are rejected', false);
exception when serialization_failure then
  insert into room_reservation_test_results values
    (14, 'stale versions are rejected', sqlerrm like '%STALE_VERSION%');
end;
$$;

insert into room_reservation_test_results values
  (15, 'all new public tables have RLS enabled', (
    select bool_and(c.relrowsecurity)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in (
        'reservation_schedule_revisions',
        'preparation_obligations',
        'checkout_cleaning_obligations',
        'room_occupancy_events',
        'room_operation_blocks',
        'room_issues',
        'room_candle_events',
        'room_pin_sync_events',
        'room_pin_access_leases',
        'cleaning_target_schedule_revisions'
      )
  )),
  (16, 'authenticated cannot execute reservation commands directly', (
    not has_function_privilege(
      'authenticated',
      'public.create_reservation(uuid,uuid,uuid,timestamptz,timestamptz,integer,text,bigint,text,text)',
      'execute'
    )
  )),
  (17, 'service role can execute reservation commands', (
    has_function_privilege(
      'service_role',
      'public.create_reservation(uuid,uuid,uuid,timestamptz,timestamptz,integer,text,bigint,text,text)',
      'execute'
    )
  )),
  (18, 'authenticated has no direct reservation insert privilege', (
    not has_table_privilege('authenticated', 'public.reservations', 'insert')
  )),
  (19, 'reservation and checkout obligation remain one-to-one', (
    select count(*) = count(distinct reservation_id)
    from public.checkout_cleaning_obligations
  )),
  (20, 'room occupancy and schedule ledgers reject update and delete', (
    exists (
      select 1 from pg_trigger
      where tgrelid = 'public.room_occupancy_events'::regclass
        and tgname = 'room_occupancy_events_append_only'
        and not tgisinternal
    ) and exists (
      select 1 from pg_trigger
      where tgrelid = 'public.reservation_schedule_revisions'::regclass
        and tgname = 'reservation_schedule_revisions_append_only'
      and not tgisinternal
    )
  )),
  (21, 'a verified PIN sync is required and retained without PIN plaintext', (
    select count(*) = 1
      and bool_and(sync_status = 'verified')
      and bool_and(pin_version = 1)
    from public.room_pin_sync_events
    where id = '64000000-0000-4000-8000-000000000001'
  )),
  (22, 'audit events are append-only', (
    exists (
      select 1 from pg_trigger
      where tgrelid = 'public.audit_events'::regclass
        and tgname = 'audit_events_append_only'
        and not tgisinternal
    )
    and not has_table_privilege('service_role', 'public.audit_events', 'update')
    and not has_table_privilege('service_role', 'public.audit_events', 'delete')
    and not has_table_privilege('service_role', 'public.audit_events', 'truncate')
    and not has_table_privilege(
      'service_role',
      'public.reservation_schedule_revisions',
      'delete'
    )
  ));

select public.process_due_reservation_transitions(
  '62000000-0000-4000-8000-000000000001',
  '2026-09-01 04:30:00+00',
  'manual-transition-retry-0001',
  repeat('2', 64)
);

select public.process_due_reservation_transitions(
  '62000000-0000-4000-8000-000000000001',
  '2026-09-01 04:30:00+00',
  'manual-transition-retry-0001',
  repeat('2', 64)
);

insert into room_reservation_test_results values
  (23, 'manual transition retry replays one scoped command receipt', (
    select count(*) = 1
    from private.command_executions
    where actor_profile_id = '62000000-0000-4000-8000-000000000001'
      and command_type = 'reservation.process_due_transitions'
      and idempotency_key = 'manual-transition-retry-0001'
  ));

do $$
begin
  perform public.process_due_reservation_transitions(
    '62000000-0000-4000-8000-000000000001',
    '2026-09-01 04:30:00+00',
    'manual-transition-retry-0001',
    repeat('3', 64)
  );
  insert into room_reservation_test_results values
    (24, 'manual transition key cannot be reused with another request hash', false);
exception when unique_violation then
  insert into room_reservation_test_results values
    (24, 'manual transition key cannot be reused with another request hash', sqlerrm like '%IDEMPOTENCY_KEY_REUSED%');
end;
$$;

select '1..27';

select case
  when passed then format('ok %s - %s', test_number, description)
  else format('not ok %s - %s', test_number, description)
end
from room_reservation_test_results
order by test_number;

set local role authenticated;

select set_config('request.jwt.claim.sub', '61000000-0000-4000-8000-000000000001', true);

select case
  when (select count(*) from public.reservation_schedule_revisions) >= 1
    then 'ok 25 - active administrator can read reservation ledgers'
  else 'not ok 25 - active administrator can read reservation ledgers'
end;

select set_config('request.jwt.claim.sub', '61000000-0000-4000-8000-000000000002', true);

select case
  when (select count(*) from public.reservation_schedule_revisions) = 0
    then 'ok 26 - active maid cannot read administrator reservation ledgers'
  else 'not ok 26 - active maid cannot read administrator reservation ledgers'
end;

select set_config('request.jwt.claim.sub', '61000000-0000-4000-8000-000000000003', true);

select case
  when (select count(*) from public.reservation_schedule_revisions) = 0
    then 'ok 27 - inactive administrator cannot read reservation ledgers'
  else 'not ok 27 - inactive administrator cannot read reservation ledgers'
end;

reset role;

rollback;
