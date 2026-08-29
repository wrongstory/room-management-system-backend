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

select public.bootstrap_first_developer_profile(
  '23000000-0000-4000-8000-000000000001',
  '13000000-0000-4000-8000-000000000001',
  'admin',
  'admin',
  '9939',
  'developer-phone-hash',
  'bootstrap-developer-test-0001'
);

insert into developer_test_results values (
  1,
  'developer bootstrap creates the fixed active developer identity',
  exists (
    select 1 from public.profiles
    where id = '23000000-0000-4000-8000-000000000001'
      and login_id = 'admin'
      and role = 'developer'
      and status = 'active'
      and must_change_password = false
  )
);

insert into developer_test_results values (
  2,
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
  'create-business-admin-test-0001'
);

insert into developer_test_results values (
  3,
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
    insert into developer_test_results values (4, 'second developer bootstrap is rejected', false);
  exception when check_violation then
    insert into developer_test_results values (
      4, 'second developer bootstrap is rejected', sqlerrm = 'DEVELOPER_ALREADY_EXISTS'
    );
  end;

  begin
    perform public.change_account_role(
      '23000000-0000-4000-8000-000000000002',
      '23000000-0000-4000-8000-000000000001',
      'admin',
      'change-developer-role-test-0001'
    );
    insert into developer_test_results values (5, 'business admin cannot demote developer', false);
  exception when check_violation then
    insert into developer_test_results values (
      5, 'business admin cannot demote developer', sqlerrm = 'DEVELOPER_ACCOUNT_PROTECTED'
    );
  end;

  begin
    perform public.change_account_status(
      '23000000-0000-4000-8000-000000000002',
      '23000000-0000-4000-8000-000000000001',
      'inactive',
      'SECURITY_TEST',
      'change-developer-status-test-0001'
    );
    insert into developer_test_results values (6, 'business admin cannot deactivate developer', false);
  exception when check_violation then
    insert into developer_test_results values (
      6, 'business admin cannot deactivate developer', sqlerrm = 'DEVELOPER_ACCOUNT_PROTECTED'
    );
  end;

  begin
    perform public.prepare_account_password_reset(
      '23000000-0000-4000-8000-000000000002',
      '23000000-0000-4000-8000-000000000001',
      'reset-developer-password-test-0001'
    );
    insert into developer_test_results values (7, 'business admin cannot reset developer password', false);
  exception when check_violation then
    insert into developer_test_results values (
      7, 'business admin cannot reset developer password', sqlerrm = 'DEVELOPER_ACCOUNT_PROTECTED'
    );
  end;

  begin
    perform public.get_room_operational_projection(
      '23000000-0000-4000-8000-000000000001',
      null
    );
    insert into developer_test_results values (8, 'developer has no business room capability', false);
  exception when insufficient_privilege then
    insert into developer_test_results values (
      8, 'developer has no business room capability', sqlerrm = 'ADMIN_REQUIRED'
    );
  end;
end;
$$;

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '13000000-0000-4000-8000-000000000001', true);

insert into developer_test_results values (
  9,
  'developer JWT resolves only the developer role rather than admin',
  private.current_role() = 'developer'::public.app_role
);

insert into developer_test_results values (
  10,
  'developer cannot read business reservations through admin RLS',
  (select count(*) from public.reservations) = 0
);

reset role;

select '1..10';
select case when passed then 'ok ' else 'not ok ' end
  || test_number || ' - ' || description
from developer_test_results
order by test_number;

rollback;
