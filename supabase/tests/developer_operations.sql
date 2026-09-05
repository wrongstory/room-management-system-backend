begin;

select plan(30);

insert into auth.users (id) values
  ('16000000-0000-4000-8000-000000000001'),
  ('16000000-0000-4000-8000-000000000002');

set local role service_role;

select public.bootstrap_first_developer_profile(
  '26000000-0000-4000-8000-000000000001',
  '16000000-0000-4000-8000-000000000001',
  'PLATFORM DEVELOPER',
  'platform developer',
  '0001',
  'developer-operations-phone-hash',
  'developer-operations-bootstrap-0001'
);

select public.create_account_profile(
  '26000000-0000-4000-8000-000000000002',
  '16000000-0000-4000-8000-000000000002',
  '26000000-0000-4000-8000-000000000001',
  '운영 관리자',
  '운영 관리자',
  'admin',
  '0002',
  'developer-operations-admin-phone-hash',
  'developer-operations-create-admin-0001',
  repeat('1', 64)
);

reset role;

select ok(
  has_function_privilege(
    'service_role',
    'public.get_developer_overview(uuid)',
    'EXECUTE'
  ),
  'service role can execute the developer overview projection'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.get_developer_overview(uuid)',
    'EXECUTE'
  ),
  'authenticated callers cannot execute developer projections directly'
);

select ok(
  not has_table_privilege(
    'service_role',
    'private.scheduler_invocation_heartbeats',
    'SELECT'
  ),
  'service role cannot read raw scheduler heartbeat rows'
);

select is(
  (public.get_developer_overview(
    '26000000-0000-4000-8000-000000000001'
  ) #>> '{accounts,byRole,developer}')::integer,
  1,
  'overview reports one singleton developer'
);

select is(
  (public.get_developer_overview(
    '26000000-0000-4000-8000-000000000001'
  ) #>> '{accounts,byRole,admin}')::integer,
  1,
  'overview reports the business administrator separately'
);

select is(
  public.get_developer_database_status(
    '26000000-0000-4000-8000-000000000001',
    'assignment_attempt_activation'
  ) ->> 'currentMigration',
  'assignment_attempt_activation',
  'database status exposes the stable current migration name'
);

select is(
  public.get_developer_database_status(
    '26000000-0000-4000-8000-000000000001',
    'assignment_attempt_activation'
  ) ->> 'migrationDrift',
  'equal',
  'database status matches the source migration name'
);

update supabase_migrations.schema_migrations
set version = '20991231235958'
where name = 'assignment_attempt_activation';

select is(
  public.get_developer_database_status(
    '26000000-0000-4000-8000-000000000001',
    'assignment_attempt_activation'
  ) ->> 'migrationDrift',
  'equal',
  'remote execution version remapping does not create false drift'
);

insert into supabase_migrations.schema_migrations (version, statements, name)
values ('20991231235959', array[]::text[], 'developer_operations_future');

select is(
  public.get_developer_database_status(
    '26000000-0000-4000-8000-000000000001',
    'assignment_attempt_activation'
  ) ->> 'migrationDrift',
  'ahead',
  'a migration after the expected named migration reports ahead'
);

delete from supabase_migrations.schema_migrations
where name = 'developer_operations_future';

select is(
  public.get_developer_database_status(
    '26000000-0000-4000-8000-000000000001',
    'developer_operations_future'
  ) ->> 'migrationDrift',
  'behind',
  'a missing expected migration name reports behind'
);

select is(
  (public.get_developer_database_status(
    '26000000-0000-4000-8000-000000000001',
    'assignment_attempt_activation'
  ) ->> 'rlsMissingCount')::integer,
  0,
  'database status reports no public base table without RLS'
);

select is(
  public.get_developer_database_status(
    '26000000-0000-4000-8000-000000000001',
    'assignment_attempt_activation'
  ) #>> '{criticalRpcs,create_account_profile}',
  'true',
  'critical RPC requires the current account-create signature and safe grants'
);

select ok(
  to_regprocedure(
    'public.create_account_profile(uuid,uuid,uuid,text,text,public.app_role,text,text,text)'
  ) is not null,
  'legacy account-create overload remains available for the false-green regression'
);

revoke execute on function public.create_account_profile(
  uuid, uuid, uuid, text, text, public.app_role, text, text, text, text
) from service_role;

select is(
  public.get_developer_database_status(
    '26000000-0000-4000-8000-000000000001',
    'assignment_attempt_activation'
  ) #>> '{criticalRpcs,create_account_profile}',
  'false',
  'legacy overload cannot mask missing service-role EXECUTE on the secure signature'
);

grant execute on function public.create_account_profile(
  uuid, uuid, uuid, text, text, public.app_role, text, text, text, text
) to service_role;

grant execute on function public.create_account_profile(
  uuid, uuid, uuid, text, text, public.app_role, text, text, text, text
) to authenticated;

select is(
  public.get_developer_database_status(
    '26000000-0000-4000-8000-000000000001',
    'assignment_attempt_activation'
  ) #>> '{criticalRpcs,create_account_profile}',
  'false',
  'critical RPC becomes unhealthy when authenticated can execute it'
);

revoke execute on function public.create_account_profile(
  uuid, uuid, uuid, text, text, public.app_role, text, text, text, text
) from authenticated;

alter table public.notifications disable row level security;
select is(
  (public.get_developer_database_status(
    '26000000-0000-4000-8000-000000000001',
    'assignment_attempt_activation'
  ) ->> 'rlsMissingCount')::integer,
  1,
  'database status detects a public base table without RLS'
);
alter table public.notifications enable row level security;

select is(
  public.get_developer_scheduler_status(
    '26000000-0000-4000-8000-000000000001',
    '26000000-0000-4000-8000-000000000002'
  ) ->> 'status',
  'not_configured',
  'missing Cron is a normal not-configured scheduler state'
);

select is(
  public.get_developer_scheduler_status(
    '26000000-0000-4000-8000-000000000001',
    '26000000-0000-4000-8000-000000000001'
  ) ->> 'schedulerActorValid',
  'false',
  'developer is never accepted as the scheduler business actor'
);

select lives_ok(
  $$ select public.record_scheduler_heartbeat(
    '26000000-0000-4000-8000-000000000002',
    'reservation-scheduler-202608301200',
    '2026-08-30T12:00:00Z',
    'succeeded',
    0,
    null,
    '2026-08-30T12:00:01Z',
    '2026-08-30T12:00:02Z',
    'developer-operations-heartbeat-request'
  ) $$,
  'active business admin can record an app-owned scheduler heartbeat'
);

select is(
  public.get_developer_scheduler_status(
    '26000000-0000-4000-8000-000000000001',
    '26000000-0000-4000-8000-000000000002'
  ) #>> '{lastHeartbeat,status}',
  'succeeded',
  'scheduler projection returns the safe heartbeat status'
);

select throws_ok(
  $$ select public.get_developer_overview(
    '26000000-0000-4000-8000-000000000002'
  ) $$,
  '42501',
  'DEVELOPER_REQUIRED',
  'business admin cannot read developer operations projections'
);

insert into public.audit_events (
  actor_profile_id,
  actor_display_name_snapshot,
  event_type,
  entity_type,
  entity_id,
  effective_at,
  after_state,
  idempotency_key
) values (
  '26000000-0000-4000-8000-000000000001',
  'PLATFORM DEVELOPER',
  'account.created',
  'profile',
  '26000000-0000-4000-8000-000000000002',
  clock_timestamp(),
  jsonb_build_object(
    'displayName', '운영 관리자',
    'loginId', '운영 관리자',
    'role', 'admin',
    'status', 'active',
    'phone', 'must-not-leak',
    'secret', 'must-not-leak'
  ),
  'developer-operations-audit-projection-0001'
);

select ok(
  not exists (
    select 1
    from public.list_developer_audit_events(
      '26000000-0000-4000-8000-000000000001',
      array['account.created'],
      null,
      clock_timestamp() - interval '1 hour',
      clock_timestamp() + interval '1 hour',
      null,
      null,
      10
    ) e
    where e.summary ? 'phone' or e.summary ? 'secret'
  ),
  'audit projection removes non-allowlisted raw state fields'
);

select ok(
  exists (
    select 1
    from public.list_developer_audit_events(
      '26000000-0000-4000-8000-000000000001',
      array['account.created'],
      null,
      clock_timestamp() - interval '1 hour',
      clock_timestamp() + interval '1 hour',
      null,
      null,
      10
    ) e
    where e.summary ->> 'role' = 'admin'
  ),
  'audit projection keeps the event-specific safe role field'
);

create temporary table developer_audit_cursor_anchor as
select id, recorded_at
from public.list_developer_audit_events(
  '26000000-0000-4000-8000-000000000001',
  null, null,
  clock_timestamp() - interval '1 hour',
  clock_timestamp() + interval '1 hour',
  null, null, 1
);

select ok(
  exists (
    select 1
    from developer_audit_cursor_anchor anchor
    cross join lateral public.list_developer_audit_events(
      '26000000-0000-4000-8000-000000000001',
      null, null,
      clock_timestamp() - interval '1 hour',
      clock_timestamp() + interval '1 hour',
      anchor.recorded_at, anchor.id, 1
    ) next_page
    where next_page.id <> anchor.id
  ),
  'audit cursor advances to a different event without offset pagination'
);

select throws_ok(
  $$ select * from public.list_developer_audit_events(
    '26000000-0000-4000-8000-000000000001',
    array['unapproved.event'], null, null, null, null, null, 10
  ) $$,
  '22023',
  'INVALID_AUDIT_QUERY',
  'audit event types outside the domain allowlist are rejected'
);

select throws_ok(
  $$ select * from public.list_developer_audit_events(
    '26000000-0000-4000-8000-000000000001',
    null, null, clock_timestamp() - interval '32 days', clock_timestamp(),
    null, null, 10
  ) $$,
  '22023',
  'INVALID_AUDIT_QUERY',
  'audit queries wider than 31 days are rejected'
);

create temporary table developer_diagnostic_results as
select sequence_number, result.*
from generate_series(1, 11) sequence_number
cross join lateral public.consume_developer_diagnostic_limit(
  '26000000-0000-4000-8000-000000000001',
  10 + (sequence_number * 0),
  60
) result;

select is(
  (select count(*)::integer from developer_diagnostic_results where allowed),
  10,
  'diagnostics allow ten calls per minute'
);

select ok(
  (
    select not allowed and retry_after_seconds between 1 and 60
    from developer_diagnostic_results
    where sequence_number = 11
  ),
  'the eleventh diagnostic call is rate limited'
);

select is(
  (
    select attempt_count
    from private.developer_diagnostic_rate_limits
    where actor_profile_id = '26000000-0000-4000-8000-000000000001'
  ),
  11,
  'the diagnostic limiter stops incrementing at limit plus one'
);

select throws_ok(
  $$ select public.record_scheduler_heartbeat(
    '26000000-0000-4000-8000-000000000001',
    'reservation-scheduler-202608301201',
    '2026-08-30T12:01:00Z',
    'succeeded', 0, null,
    '2026-08-30T12:01:01Z',
    '2026-08-30T12:01:02Z',
    'developer-cannot-be-scheduler'
  ) $$,
  '42501',
  'ADMIN_REQUIRED',
  'developer cannot record a scheduler heartbeat as the business actor'
);

reset role;

rollback;
