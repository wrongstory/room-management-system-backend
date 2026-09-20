begin;
select no_plan();

create function pg_temp.pid(n integer) returns uuid language sql immutable as $$
  select ('21700000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
$$;
create function pg_temp.closed_week(n integer) returns date language sql stable as $$
  select date_trunc('week', clock_timestamp() at time zone 'Asia/Seoul')::date - (n * 7)
$$;

insert into auth.users(id)
select pg_temp.pid(100 + n) from generate_series(1, 5) n;
insert into auth.sessions(id, user_id)
select pg_temp.pid(900 + n), pg_temp.pid(100 + n) from generate_series(1, 5) n;

select public.bootstrap_first_developer_profile(
  pg_temp.pid(4), pg_temp.pid(104), 'payroll resolver developer',
  'payroll resolver developer', '0217', repeat('d', 64),
  'payroll-cycle-resolver-bootstrap'
);

insert into public.profiles(
  id, auth_user_id, display_name, display_name_normalized,
  login_id, login_id_normalized, login_sequence, role, status,
  must_change_password
) values
  (pg_temp.pid(1), pg_temp.pid(101), 'resolver-admin', 'resolver-admin',
    'resolver-admin', 'resolver-admin', 0, 'admin', 'active', false),
  (pg_temp.pid(2), pg_temp.pid(102), 'resolver-maid', 'resolver-maid',
    'resolver-maid', 'resolver-maid', 0, 'maid', 'active', false),
  (pg_temp.pid(3), pg_temp.pid(103), 'resolver-other', 'resolver-other',
    'resolver-other', 'resolver-other', 0, 'maid', 'active', false),
  (pg_temp.pid(5), pg_temp.pid(105), 'resolver-temp', 'resolver-temp',
    'resolver-temp', 'resolver-temp', 0, 'admin', 'active', true);

insert into public.payroll_cycles(id, maid_profile_id, week_start)
values
  (pg_temp.pid(1001), pg_temp.pid(2), pg_temp.closed_week(2)),
  (pg_temp.pid(1002), pg_temp.pid(3), pg_temp.closed_week(2)),
  (pg_temp.pid(1003), pg_temp.pid(2),
    date_trunc('week', clock_timestamp() at time zone 'Asia/Seoul')::date);

select ok(
  (public.get_payroll_cycle(pg_temp.pid(1), pg_temp.pid(1001))->>'cycleId')::uuid
    = pg_temp.pid(1001),
  'admin resolves any materialized closed payroll cycle'
);
select ok(
  (public.get_payroll_cycle(pg_temp.pid(2), pg_temp.pid(1001))->>'maidProfileId')::uuid
    = pg_temp.pid(2),
  'maid resolves the maid self cycle'
);
select throws_ok(
  $$select public.get_payroll_cycle(pg_temp.pid(2), pg_temp.pid(1002))$$,
  '42501', 'PAYROLL_ACCESS_REQUIRED', 'cross-maid cycle is denied'
);
select throws_ok(
  $$select public.get_payroll_cycle(pg_temp.pid(4), pg_temp.pid(1001))$$,
  '42501', 'PAYROLL_ACCESS_REQUIRED', 'developer is denied'
);
select throws_ok(
  $$select public.get_payroll_cycle(pg_temp.pid(5), pg_temp.pid(1001))$$,
  '42501', 'PAYROLL_ACCESS_REQUIRED', 'temporary-password admin is denied'
);
select throws_ok(
  $$select public.get_payroll_cycle(pg_temp.pid(1), pg_temp.pid(1999))$$,
  'P0002', 'PAYROLL_CYCLE_NOT_FOUND', 'unknown cycle returns the stable not-found error'
);
select throws_ok(
  $$select public.get_payroll_cycle(pg_temp.pid(1), pg_temp.pid(1003))$$,
  '22023', 'PAYROLL_WEEK_NOT_CLOSED', 'current week cycle is outside the closed-week contract'
);

create temporary table resolver_counts_before as
select
  (select count(*) from public.payroll_cycles) cycles,
  (select count(*) from public.payroll_events) events,
  (select count(*) from public.audit_events) audits,
  (select count(*) from public.notifications) notifications;
select public.get_payroll_cycle(pg_temp.pid(1), pg_temp.pid(1001));
select is(
  (select row(cycles, events, audits, notifications)::text from resolver_counts_before),
  (select row(
    (select count(*) from public.payroll_cycles),
    (select count(*) from public.payroll_events),
    (select count(*) from public.audit_events),
    (select count(*) from public.notifications)
  )::text),
  'resolver has no ledger, audit, or notification side effects'
);

select ok(
  not has_function_privilege('authenticated', 'public.get_payroll_cycle(uuid,uuid)', 'EXECUTE'),
  'authenticated cannot call the server-owned resolver directly'
);
select ok(
  has_function_privilege('service_role', 'public.get_payroll_cycle(uuid,uuid)', 'EXECUTE'),
  'service role can call the resolver after the HTTP actor gate'
);

select * from finish();
rollback;
