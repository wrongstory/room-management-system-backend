begin;

select plan(14);

insert into auth.users (id) values
  ('14000000-0000-4000-8000-000000000001'),
  ('14000000-0000-4000-8000-000000000002'),
  ('14000000-0000-4000-8000-000000000003'),
  ('14000000-0000-4000-8000-000000000004'),
  ('14000000-0000-4000-8000-000000000005');

insert into public.profiles (
  id, auth_user_id, display_name, display_name_normalized,
  login_id, login_id_normalized, login_sequence, role, status,
  phone_last_four, phone_lookup_hash, must_change_password
) values
  (
    '24000000-0000-4000-8000-000000000001',
    '14000000-0000-4000-8000-000000000001',
    '영수증 관리자 1', '영수증 관리자 1', '영수증 관리자 1', '영수증 관리자 1',
    0, 'admin', 'active', '0001', repeat('1', 64), false
  ),
  (
    '24000000-0000-4000-8000-000000000002',
    '14000000-0000-4000-8000-000000000002',
    '영수증 관리자 2', '영수증 관리자 2', '영수증 관리자 2', '영수증 관리자 2',
    0, 'admin', 'active', '0002', repeat('2', 64), false
  ),
  (
    '24000000-0000-4000-8000-000000000003',
    '14000000-0000-4000-8000-000000000003',
    '영수증 메이드', '영수증 메이드', '영수증 메이드', '영수증 메이드',
    0, 'maid', 'active', '0003', repeat('3', 64), true
  );

select ok(
  has_function_privilege(
    'service_role',
    'public.create_account_profile(uuid,uuid,uuid,text,text,app_role,text,text,text,text)',
    'EXECUTE'
  ),
  'service role can execute the scoped account-create command'
);

select ok(
  not has_function_privilege(
    'service_role',
    'public.create_account_profile(uuid,uuid,uuid,text,text,app_role,text,text,text)',
    'EXECUTE'
  ),
  'the legacy account-create command without a request hash is retired'
);

create temporary table account_create_results (attempt integer, profile_id uuid);
grant select, insert on account_create_results to service_role;

set local role service_role;

insert into account_create_results
select 1, result.id
from public.create_account_profile(
  '24000000-0000-4000-8000-000000000004',
  '14000000-0000-4000-8000-000000000004',
  '24000000-0000-4000-8000-000000000001',
  '동시 생성 대상', '동시 생성 대상', 'maid', '0004', repeat('4', 64),
  'same-create-key-0001', repeat('a', 64)
) result;

insert into account_create_results
select 2, result.id
from public.create_account_profile(
  '24000000-0000-4000-8000-000000000005',
  '14000000-0000-4000-8000-000000000005',
  '24000000-0000-4000-8000-000000000001',
  '동시 생성 대상', '동시 생성 대상', 'maid', '0004', repeat('4', 64),
  'same-create-key-0001', repeat('a', 64)
) result;

reset role;

select is(
  (select count(distinct profile_id)::integer from account_create_results),
  1,
  'same create scope and payload returns one logical profile result'
);

select is(
  (
    select count(*)::integer
    from public.profiles
    where phone_lookup_hash = repeat('4', 64)
  ),
  1,
  'same create scope inserts one logical account'
);

select is(
  (
    select count(*)::integer
    from private.command_executions
    where actor_profile_id = '24000000-0000-4000-8000-000000000001'
      and command_type = 'account.create'
      and idempotency_key = 'same-create-key-0001'
  ),
  1,
  'account create stores one scoped command receipt'
);

select is(
  (
    select count(*)::integer
    from public.audit_events
    where event_type = 'account.created'
      and entity_id = '24000000-0000-4000-8000-000000000004'
  ),
  1,
  'account create replay does not duplicate the audit event'
);

set local role service_role;

select throws_ok(
  $$
    select public.create_account_profile(
      '24000000-0000-4000-8000-000000000005',
      '14000000-0000-4000-8000-000000000005',
      '24000000-0000-4000-8000-000000000001',
      '다른 생성 대상', '다른 생성 대상', 'maid', '0005', repeat('5', 64),
      'same-create-key-0001', repeat('b', 64)
    )
  $$,
  '23505',
  'IDEMPOTENCY_KEY_REUSED',
  'same account-create scope rejects a different request hash'
);

select public.unlock_account(
  '24000000-0000-4000-8000-000000000001',
  '24000000-0000-4000-8000-000000000003',
  'shared-raw-key-0001', repeat('c', 64)
);
select public.unlock_account(
  '24000000-0000-4000-8000-000000000002',
  '24000000-0000-4000-8000-000000000003',
  'shared-raw-key-0001', repeat('d', 64)
);

reset role;

select is(
  (
    select count(*)::integer
    from private.command_executions
    where command_type = 'account.unlock'
      and idempotency_key = 'shared-raw-key-0001'
  ),
  2,
  'different actors can independently use the same raw idempotency key'
);

set local role service_role;
select public.prepare_account_password_reset(
  '24000000-0000-4000-8000-000000000001',
  '24000000-0000-4000-8000-000000000003',
  'shared-raw-key-0001', repeat('e', 64)
);
reset role;

select is(
  (
    select count(*)::integer
    from private.command_executions
    where actor_profile_id = '24000000-0000-4000-8000-000000000001'
      and idempotency_key = 'shared-raw-key-0001'
      and command_type in ('account.unlock', 'account.password.reset')
  ),
  2,
  'different account commands can independently use the same raw key'
);

set local role service_role;
select public.change_account_role(
  '24000000-0000-4000-8000-000000000001',
  '24000000-0000-4000-8000-000000000003',
  'admin', 'role-replay-key-0001', repeat('6', 64)
);
select public.change_account_role(
  '24000000-0000-4000-8000-000000000001',
  '24000000-0000-4000-8000-000000000003',
  'admin', 'role-replay-key-0001', repeat('6', 64)
);
reset role;

select ok(
  (select role = 'admin' from public.profiles where id = '24000000-0000-4000-8000-000000000003')
    and (
      select count(*) = 1
      from private.command_executions
      where command_type = 'account.role.change'
        and idempotency_key = 'role-replay-key-0001'
    )
    and (
      select count(*) = 1
      from public.audit_events
      where event_type = 'account.role_changed'
        and entity_id = '24000000-0000-4000-8000-000000000003'
    ),
  'role replay returns one result, receipt, and audit transition'
);

set local role service_role;
select throws_ok(
  $$
    select public.change_account_role(
      '24000000-0000-4000-8000-000000000001',
      '24000000-0000-4000-8000-000000000003',
      'maid', 'role-replay-key-0001', repeat('7', 64)
    )
  $$,
  '23505',
  'IDEMPOTENCY_KEY_REUSED',
  'role command rejects the same scope with another payload'
);

select public.change_account_status(
  '24000000-0000-4000-8000-000000000001',
  '24000000-0000-4000-8000-000000000003',
  'inactive', 'SECURITY_REVIEW', 'status-replay-key-0001', repeat('8', 64)
);
select public.change_account_status(
  '24000000-0000-4000-8000-000000000001',
  '24000000-0000-4000-8000-000000000003',
  'inactive', 'SECURITY_REVIEW', 'status-replay-key-0001', repeat('8', 64)
);
reset role;

select ok(
  (select status = 'inactive' from public.profiles where id = '24000000-0000-4000-8000-000000000003')
    and (
      select count(*) = 1
      from private.command_executions
      where command_type = 'account.status.change'
        and idempotency_key = 'status-replay-key-0001'
    )
    and (
      select count(*) = 1
      from public.audit_events
      where event_type = 'account.status_changed'
        and entity_id = '24000000-0000-4000-8000-000000000003'
    ),
  'status replay returns one receipt and one audit transition'
);

set local role service_role;
select public.prepare_account_password_reset(
  '24000000-0000-4000-8000-000000000001',
  '24000000-0000-4000-8000-000000000003',
  'reset-replay-key-0001', repeat('9', 64)
);
select public.prepare_account_password_reset(
  '24000000-0000-4000-8000-000000000001',
  '24000000-0000-4000-8000-000000000003',
  'reset-replay-key-0001', repeat('9', 64)
);
reset role;

select ok(
  (
    select count(*) = 1
    from private.command_executions
    where command_type = 'account.password.reset'
      and idempotency_key = 'reset-replay-key-0001'
  )
    and (
      select count(*) = 1
      from public.audit_events
      where event_type = 'account.password_reset_requested'
        and idempotency_key = private.audit_command_key(
          '24000000-0000-4000-8000-000000000001',
          'account.password.reset',
          'reset-replay-key-0001'
        )
    ),
  'password-reset replay stores one receipt and one audit event'
);

select ok(
  not exists (
    select 1
    from public.audit_events
    where idempotency_key in (
      'same-create-key-0001',
      'shared-raw-key-0001',
      'role-replay-key-0001',
      'status-replay-key-0001',
      'reset-replay-key-0001'
    )
  ),
  'raw account idempotency keys are never used as global audit keys'
);

select * from finish();

rollback;
