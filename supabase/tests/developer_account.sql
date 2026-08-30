begin;

create temporary table developer_test_results (
  test_number integer primary key,
  description text not null,
  passed boolean not null
);
grant select, insert on developer_test_results to service_role, authenticated;

insert into auth.users (id) values
  ('13000000-0000-4000-8000-000000000001'),
  ('13000000-0000-4000-8000-000000000002'),
  ('13000000-0000-4000-8000-000000000003');

set local role service_role;

do $$
begin
  begin
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
      phone_last_four,
      phone_lookup_hash,
      must_change_password
    ) values (
      '23000000-0000-4000-8000-000000000001',
      '13000000-0000-4000-8000-000000000001',
      'ADMIN',
      'admin',
      'ADMIN',
      'admin',
      0,
      'developer',
      'active',
      '0001',
      'invalid-uppercase-login-hash',
      false
    );
    insert into developer_test_results values (1, 'uppercase developer login id is rejected', false);
  exception when check_violation then
    insert into developer_test_results values (
      1, 'uppercase developer login id is rejected', sqlerrm = 'INVALID_DEVELOPER_BOOTSTRAP'
    );
  end;
end;
$$;

select public.bootstrap_first_developer_profile(
  '23000000-0000-4000-8000-000000000001',
  '13000000-0000-4000-8000-000000000001',
  'ADMIN',
  'admin',
  '9939',
  'developer-phone-hash',
  'bootstrap-developer-test-0001'
);

insert into developer_test_results values (
  2,
  'developer display name is separate from the fixed lowercase login id',
  exists (
    select 1 from public.profiles
    where id = '23000000-0000-4000-8000-000000000001'
      and display_name = 'ADMIN'
      and login_id = 'admin'
      and login_id_normalized = 'admin'
      and role = 'developer'
      and status = 'active'
      and must_change_password = false
  )
);

insert into developer_test_results values (
  3,
  'legacy first-admin bootstrap is no longer executable by service role',
  not has_function_privilege(
    'service_role',
    'public.bootstrap_first_admin_profile(uuid,uuid,text,text,text,text,text)',
    'EXECUTE'
  )
);

select public.create_account_profile(
  '23000000-0000-4000-8000-000000000002',
  '13000000-0000-4000-8000-000000000002',
  '23000000-0000-4000-8000-000000000001',
  '운영 관리자',
  '운영 관리자',
  'admin',
  '0002',
  'business-admin-phone-hash',
  'create-business-admin-test-0001',
  repeat('1', 64)
);

insert into developer_test_results values (
  4,
  'developer can create a separate business administrator',
  exists (
    select 1 from public.profiles
    where id = '23000000-0000-4000-8000-000000000002'
      and role = 'admin'
      and must_change_password = true
  )
);

do $$
begin
  begin
    perform public.bootstrap_first_developer_profile(
      '23000000-0000-4000-8000-000000000003',
      '13000000-0000-4000-8000-000000000003',
      'admin', 'admin', '0003', 'second-developer-phone-hash',
      'bootstrap-developer-test-0002'
    );
    insert into developer_test_results values (5, 'second developer bootstrap is rejected', false);
  exception when check_violation then
    insert into developer_test_results values (
      5, 'second developer bootstrap is rejected', sqlerrm = 'DEVELOPER_ALREADY_EXISTS'
    );
  end;

  begin
    perform public.change_account_role(
      '23000000-0000-4000-8000-000000000002',
      '23000000-0000-4000-8000-000000000001',
      'admin',
      'change-developer-role-test-0001',
      repeat('2', 64)
    );
    insert into developer_test_results values (6, 'business admin cannot demote developer', false);
  exception when check_violation then
    insert into developer_test_results values (
      6, 'business admin cannot demote developer', sqlerrm = 'DEVELOPER_ACCOUNT_PROTECTED'
    );
  end;

  begin
    perform public.change_account_status(
      '23000000-0000-4000-8000-000000000002',
      '23000000-0000-4000-8000-000000000001',
      'inactive',
      'SECURITY_TEST',
      'change-developer-status-test-0001',
      repeat('3', 64)
    );
    insert into developer_test_results values (7, 'business admin cannot deactivate developer', false);
  exception when check_violation then
    insert into developer_test_results values (
      7, 'business admin cannot deactivate developer', sqlerrm = 'DEVELOPER_ACCOUNT_PROTECTED'
    );
  end;

  begin
    perform public.prepare_account_password_reset(
      '23000000-0000-4000-8000-000000000002',
      '23000000-0000-4000-8000-000000000001',
      'reset-developer-password-test-0001',
      repeat('4', 64)
    );
    insert into developer_test_results values (8, 'business admin cannot reset developer password', false);
  exception when check_violation then
    insert into developer_test_results values (
      8, 'business admin cannot reset developer password', sqlerrm = 'DEVELOPER_ACCOUNT_PROTECTED'
    );
  end;

  begin
    update public.profiles
    set login_id = 'ADMIN'
    where id = '23000000-0000-4000-8000-000000000001';
    insert into developer_test_results values (9, 'developer login display value cannot change', false);
  exception when check_violation then
    insert into developer_test_results values (
      9, 'developer login display value cannot change', sqlerrm = 'DEVELOPER_ACCOUNT_PROTECTED'
    );
  end;

  begin
    perform public.get_room_operational_projection(
      '23000000-0000-4000-8000-000000000001',
      null
    );
    insert into developer_test_results values (10, 'developer has no business room capability', false);
  exception when insufficient_privilege then
    insert into developer_test_results values (
      10, 'developer has no business room capability', sqlerrm = 'ADMIN_REQUIRED'
    );
  end;

  begin
    perform public.process_due_reservation_transitions(
      '23000000-0000-4000-8000-000000000001',
      clock_timestamp(),
      'developer-scheduler-test-0001',
      repeat('a', 64)
    );
    insert into developer_test_results values (13, 'developer cannot act as the reservation scheduler admin', false);
  exception when insufficient_privilege then
    insert into developer_test_results values (
      13,
      'developer cannot act as the reservation scheduler admin',
      sqlerrm = 'ADMIN_REQUIRED'
    );
  end;
end;
$$;

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '13000000-0000-4000-8000-000000000001', true);

insert into developer_test_results values (
  11,
  'developer JWT resolves only the developer role rather than admin',
  private.current_role() = 'developer'::public.app_role
);

insert into developer_test_results values (
  12,
  'developer cannot read business reservations through admin RLS',
  (select count(*) from public.reservations) = 0
);

reset role;

select '1..13';
select case when passed then 'ok ' else 'not ok ' end
  || test_number || ' - ' || description
from developer_test_results
order by test_number;

rollback;
