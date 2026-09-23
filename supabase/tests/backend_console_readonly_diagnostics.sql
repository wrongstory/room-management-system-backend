begin;

select plan(33);

select ok(
  exists(select 1 from pg_catalog.pg_roles where rolname = 'rms_diagnostic'),
  'dedicated diagnostic role exists'
);

select ok(
  not rolsuper and not rolcreatedb and not rolcreaterole and not rolinherit
    and not rolreplication and not rolbypassrls and rolcanlogin,
  'diagnostic role has login capability without elevated attributes'
)
from pg_catalog.pg_roles
where rolname = 'rms_diagnostic';

select is(
  (select rolpassword from pg_catalog.pg_authid where rolname = 'rms_diagnostic'),
  null,
  'diagnostic role has no provisioned password'
);

select is(
  (select count(*)::integer
   from pg_catalog.pg_auth_members memberships
   join pg_catalog.pg_roles roles on roles.oid = memberships.member
   where roles.rolname = 'rms_diagnostic'),
  0,
  'diagnostic role is not a member of another database role'
);

select is(
  (select setting from pg_catalog.pg_db_role_setting settings
   join pg_catalog.pg_roles roles on roles.oid = settings.setrole
   cross join lateral unnest(settings.setconfig) setting
   where roles.rolname = 'rms_diagnostic'
     and setting like 'default_transaction_read_only=%'),
  'default_transaction_read_only=on',
  'diagnostic login defaults to read-only transactions'
);
select is(
  (select setting from pg_catalog.pg_db_role_setting settings
   join pg_catalog.pg_roles roles on roles.oid = settings.setrole
   cross join lateral unnest(settings.setconfig) setting
   where roles.rolname = 'rms_diagnostic' and setting like 'statement_timeout=%'),
  'statement_timeout=3s',
  'diagnostic role has a bounded statement timeout'
);
select is(
  (select setting from pg_catalog.pg_db_role_setting settings
   join pg_catalog.pg_roles roles on roles.oid = settings.setrole
   cross join lateral unnest(settings.setconfig) setting
   where roles.rolname = 'rms_diagnostic' and setting like 'lock_timeout=%'),
  'lock_timeout=500ms',
  'diagnostic role has a bounded lock timeout'
);
select is(
  (select setting from pg_catalog.pg_db_role_setting settings
   join pg_catalog.pg_roles roles on roles.oid = settings.setrole
   cross join lateral unnest(settings.setconfig) setting
   where roles.rolname = 'rms_diagnostic'
     and setting like 'idle_in_transaction_session_timeout=%'),
  'idle_in_transaction_session_timeout=5s',
  'diagnostic role has a bounded idle transaction timeout'
);

select ok(
  has_schema_privilege('rms_diagnostic', 'public', 'USAGE'),
  'diagnostic role can resolve approved public views'
);
select ok(
  not has_schema_privilege('rms_diagnostic', 'public', 'CREATE'),
  'diagnostic role cannot create public objects'
);
select ok(
  not has_schema_privilege('rms_diagnostic', 'private', 'USAGE'),
  'diagnostic role cannot resolve private objects'
);

select ok(
  has_table_privilege('rms_diagnostic', 'public.diagnostic_system_summary', 'SELECT'),
  'diagnostic role can read the approved system summary'
);
select ok(
  has_table_privilege('rms_diagnostic', 'public.diagnostic_room_state_summary', 'SELECT'),
  'diagnostic role can read the approved room state summary'
);
select ok(
  has_table_privilege('rms_diagnostic', 'public.diagnostic_workflow_summary', 'SELECT'),
  'diagnostic role can read the approved workflow summary'
);

select ok(
  not has_table_privilege('rms_diagnostic', 'public.rooms', 'SELECT'),
  'diagnostic role cannot read room base rows'
);
select ok(
  not has_table_privilege('rms_diagnostic', 'public.reservations', 'SELECT'),
  'diagnostic role cannot read reservation base rows'
);
select ok(
  not has_table_privilege('rms_diagnostic', 'public.profiles', 'SELECT'),
  'diagnostic role cannot read profile base rows'
);
select ok(
  not has_table_privilege('rms_diagnostic', 'auth.users', 'SELECT'),
  'diagnostic role cannot read auth users'
);
select ok(
  not has_table_privilege('rms_diagnostic', 'public.rooms', 'INSERT,UPDATE,DELETE,TRUNCATE'),
  'diagnostic role cannot mutate room base rows'
);
select ok(
  not has_function_privilege('rms_diagnostic', 'public.get_developer_overview(uuid)', 'EXECUTE'),
  'diagnostic role cannot execute application-owned projections'
);

select is(
  (select count(*)::integer
   from information_schema.columns
   where table_schema = 'public'
     and table_name in (
       'diagnostic_system_summary',
       'diagnostic_room_state_summary',
       'diagnostic_workflow_summary'
     )
     and column_name ~* '(guest|phone|password|token|secret|pin|profile|reservation_id|room_id)'),
  0,
  'approved view column names contain no identifiers or sensitive fields'
);

select is(
  (select count(*)::integer from information_schema.views
   where table_schema = 'public'
     and table_name like 'diagnostic_%_summary'),
  3,
  'exactly three diagnostic summary views are exposed'
);

-- The pgTAP runner connects as postgres, which is intentionally not a permanent
-- member of the diagnostic role. Transactional membership allows SET ROLE only
-- for these assertions and is removed by the final rollback.
grant rms_diagnostic to postgres;
grant usage on schema extensions to rms_diagnostic;
set local role rms_diagnostic;

select extensions.lives_ok(
  'select * from public.diagnostic_system_summary',
  'diagnostic role can execute the approved system query'
);
select extensions.is(
  (select room_count from public.diagnostic_system_summary),
  121::bigint,
  'system summary reports all synthetic rooms without room identifiers'
);
select extensions.is(
  (select sum(room_count) from public.diagnostic_room_state_summary),
  121::numeric,
  'room state summary aggregates every synthetic room'
);
select extensions.lives_ok(
  'select * from public.diagnostic_workflow_summary',
  'diagnostic role can execute the approved workflow query'
);
select extensions.throws_ok(
  'select * from public.rooms',
  '42501', null,
  'diagnostic role cannot bypass approved views to read rooms'
);
select extensions.throws_ok(
  'select * from auth.users',
  '42501', null,
  'diagnostic role cannot read protected auth rows'
);
select extensions.throws_ok(
  $$insert into public.rooms(room_number, room_type_id)
    values ('999', '00000000-0000-0000-0000-000000000000')$$,
  '42501', null,
  'diagnostic role cannot insert business data'
);
select extensions.throws_ok(
  $$update public.rooms set room_number = room_number$$,
  '42501', null,
  'diagnostic role cannot update business data'
);
select extensions.throws_ok(
  'create table public.diagnostic_probe(id integer)',
  '42501', null,
  'diagnostic role cannot create objects'
);

reset role;

select is(
  (select count(*)::integer
   from information_schema.role_table_grants
   where grantee = 'rms_diagnostic'
     and table_schema = 'public'
     and table_name not in (
       'diagnostic_system_summary',
       'diagnostic_room_state_summary',
       'diagnostic_workflow_summary'
     )),
  0,
  'diagnostic role has no explicit public table grants outside the allowlist'
);
select is(
  (select count(*)::integer
   from information_schema.role_routine_grants
   where grantee = 'rms_diagnostic'),
  0,
  'diagnostic role has no explicit routine grants'
);

select * from finish();
rollback;
