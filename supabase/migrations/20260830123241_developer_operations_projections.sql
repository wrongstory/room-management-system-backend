-- Issue #43: bounded developer-only operational projections.
-- Supabase internal schemas remain behind app-owned SECURITY DEFINER RPCs.

create function private.assert_active_developer(p_actor_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if not exists (
    select 1
    from public.profiles p
    where p.id = p_actor_profile_id
      and p.role = 'developer'
      and p.status = 'active'
  ) then
    raise exception using errcode = '42501', message = 'DEVELOPER_REQUIRED';
  end if;
end;
$$;

revoke all on function private.assert_active_developer(uuid) from public;

create index audit_events_developer_projection_idx
on public.audit_events (event_type, recorded_at desc, id desc);

create table private.scheduler_invocation_heartbeats (
  invocation_key text primary key
    check (invocation_key ~ '^reservation-scheduler-[0-9]{12}$'),
  scheduled_at timestamptz not null,
  actor_profile_id uuid not null references public.profiles(id) on delete restrict,
  status text not null check (status in ('succeeded', 'failed')),
  transition_count integer check (transition_count is null or transition_count >= 0),
  last_error_code text check (
    last_error_code is null or last_error_code ~ '^[A-Z0-9_]{2,80}$'
  ),
  attempt_count integer not null default 1 check (attempt_count > 0),
  first_started_at timestamptz not null,
  last_completed_at timestamptz not null,
  last_request_id text check (
    last_request_id is null or char_length(last_request_id) between 1 and 128
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index scheduler_invocation_heartbeats_latest_idx
on private.scheduler_invocation_heartbeats (last_completed_at desc, invocation_key desc);

revoke all on table private.scheduler_invocation_heartbeats
from public, anon, authenticated, service_role;

create table private.developer_diagnostic_rate_limits (
  actor_profile_id uuid primary key references public.profiles(id) on delete restrict,
  window_started_at timestamptz not null,
  attempt_count integer not null check (attempt_count > 0),
  updated_at timestamptz not null default now()
);

revoke all on table private.developer_diagnostic_rate_limits
from public, anon, authenticated, service_role;

create function public.record_scheduler_heartbeat(
  p_actor_profile_id uuid,
  p_invocation_key text,
  p_scheduled_at timestamptz,
  p_status text,
  p_transition_count integer,
  p_error_code text,
  p_started_at timestamptz,
  p_completed_at timestamptz,
  p_request_id text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
begin
  perform private.assert_room_admin(p_actor_profile_id);

  if p_invocation_key is null
    or p_invocation_key !~ '^reservation-scheduler-[0-9]{12}$'
    or p_scheduled_at is null
    or p_scheduled_at <> date_trunc('minute', p_scheduled_at)
    or p_status not in ('succeeded', 'failed')
    or (p_status = 'succeeded' and p_error_code is not null)
    or (p_status = 'failed' and (
      p_error_code is null or p_error_code !~ '^[A-Z0-9_]{2,80}$'
    ))
    or p_transition_count is not null and p_transition_count < 0
    or p_started_at is null
    or p_completed_at is null
    or p_completed_at < p_started_at
    or p_request_id is null
    or char_length(p_request_id) not between 1 and 128 then
    raise exception using errcode = '22023', message = 'INVALID_SCHEDULER_HEARTBEAT';
  end if;

  insert into private.scheduler_invocation_heartbeats (
    invocation_key,
    scheduled_at,
    actor_profile_id,
    status,
    transition_count,
    last_error_code,
    first_started_at,
    last_completed_at,
    last_request_id
  ) values (
    p_invocation_key,
    p_scheduled_at,
    p_actor_profile_id,
    p_status,
    p_transition_count,
    p_error_code,
    p_started_at,
    p_completed_at,
    p_request_id
  )
  on conflict (invocation_key) do update
  set
    actor_profile_id = excluded.actor_profile_id,
    status = excluded.status,
    transition_count = excluded.transition_count,
    last_error_code = excluded.last_error_code,
    attempt_count = private.scheduler_invocation_heartbeats.attempt_count + 1,
    last_completed_at = excluded.last_completed_at,
    last_request_id = excluded.last_request_id,
    updated_at = now();

  delete from private.scheduler_invocation_heartbeats h
  where h.invocation_key in (
    select expired.invocation_key
    from private.scheduler_invocation_heartbeats expired
    where expired.last_completed_at < now() - interval '7 days'
    order by expired.last_completed_at
    limit 64
  );
end;
$$;

create function public.consume_developer_diagnostic_limit(
  p_actor_profile_id uuid,
  p_limit integer default 10,
  p_window_seconds integer default 60
)
returns table (
  allowed boolean,
  retry_after_seconds integer,
  remaining integer
)
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_window_start timestamptz;
  v_attempt_count integer;
begin
  perform private.assert_active_developer(p_actor_profile_id);

  if p_limit not between 1 and 60 or p_window_seconds not between 10 and 3600 then
    raise exception using errcode = '22023', message = 'INVALID_DIAGNOSTIC_LIMIT';
  end if;

  insert into private.developer_diagnostic_rate_limits (
    actor_profile_id, window_started_at, attempt_count, updated_at
  ) values (
    p_actor_profile_id, v_now, 1, v_now
  )
  on conflict (actor_profile_id) do update
  set
    window_started_at = case
      when private.developer_diagnostic_rate_limits.window_started_at
        <= v_now - make_interval(secs => p_window_seconds)
        then v_now
      else private.developer_diagnostic_rate_limits.window_started_at
    end,
    attempt_count = case
      when private.developer_diagnostic_rate_limits.window_started_at
        <= v_now - make_interval(secs => p_window_seconds)
        then 1
      when private.developer_diagnostic_rate_limits.attempt_count < p_limit + 1
        then private.developer_diagnostic_rate_limits.attempt_count + 1
      else private.developer_diagnostic_rate_limits.attempt_count
    end,
    updated_at = case
      when private.developer_diagnostic_rate_limits.window_started_at
        <= v_now - make_interval(secs => p_window_seconds)
        or private.developer_diagnostic_rate_limits.attempt_count < p_limit + 1
        then v_now
      else private.developer_diagnostic_rate_limits.updated_at
    end
  returning window_started_at, attempt_count
  into v_window_start, v_attempt_count;

  return query select
    v_attempt_count <= p_limit,
    case
      when v_attempt_count <= p_limit then 0
      else greatest(
        1,
        ceil(extract(epoch from (
          v_window_start + make_interval(secs => p_window_seconds) - v_now
        )))::integer
      )
    end,
    greatest(0, p_limit - v_attempt_count);
end;
$$;

create function public.get_developer_overview(p_actor_profile_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_result jsonb;
begin
  perform private.assert_active_developer(p_actor_profile_id);

  select jsonb_build_object(
    'generatedAt', clock_timestamp(),
    'accounts', jsonb_build_object(
      'total', count(*),
      'active', count(*) filter (where status = 'active'),
      'byRole', jsonb_build_object(
        'developer', count(*) filter (where role = 'developer'),
        'admin', count(*) filter (where role = 'admin'),
        'maid', count(*) filter (where role = 'maid')
      )
    ),
    'rooms', jsonb_build_object(
      'total', (select count(*) from public.rooms)
    ),
    'auditEventsLast24Hours', (
      select count(*)
      from public.audit_events ae
      where ae.recorded_at >= clock_timestamp() - interval '24 hours'
        and ae.event_type = any (array[
          'account.bootstrap_developer_created',
          'account.bootstrap_admin_created',
          'account.created',
          'account.role_changed',
          'account.status_changed',
          'account.unlocked',
          'account.password_reset_requested',
          'account.password_changed'
        ])
    )
  ) into v_result
  from public.profiles;

  return v_result;
end;
$$;

create function public.get_developer_database_status(
  p_actor_profile_id uuid,
  p_expected_migration_name text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_current_migration text;
  v_current_migration_version text;
  v_expected_remote_version text;
  v_expected_match_count integer := 0;
  v_drift text := 'unknown';
  v_rls_missing integer;
  v_critical_rpcs jsonb;
begin
  perform private.assert_active_developer(p_actor_profile_id);

  if p_expected_migration_name is null
    or p_expected_migration_name !~ '^[a-z][a-z0-9_]{2,100}$' then
    raise exception using errcode = '22023', message = 'INVALID_EXPECTED_MIGRATION';
  end if;

  if to_regclass('supabase_migrations.schema_migrations') is not null then
    begin
      execute $history$
        select version::text, name::text
        from supabase_migrations.schema_migrations
        order by version desc
        limit 1
      $history$
      into v_current_migration_version, v_current_migration;

      execute $expected$
        select count(*)::integer, max(version)::text
        from supabase_migrations.schema_migrations
        where name = $1
      $expected$
      into v_expected_match_count, v_expected_remote_version
      using p_expected_migration_name;
    exception
      when undefined_column or undefined_table then
        v_current_migration := null;
        v_current_migration_version := null;
        v_expected_remote_version := null;
        v_expected_match_count := 0;
    end;
  end if;

  if v_current_migration_version ~ '^[0-9]{14}$'
    and v_expected_remote_version ~ '^[0-9]{14}$'
    and v_expected_match_count = 1
    and v_current_migration_version = v_expected_remote_version then
    v_drift := 'equal';
  elsif v_current_migration_version ~ '^[0-9]{14}$'
    and v_expected_remote_version ~ '^[0-9]{14}$'
    and v_expected_match_count = 1
    and v_current_migration_version > v_expected_remote_version then
    v_drift := 'ahead';
  elsif v_current_migration_version ~ '^[0-9]{14}$'
    and v_expected_match_count = 0 then
    v_drift := 'behind';
  end if;

  select count(*)::integer into v_rls_missing
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('r', 'p')
    and not c.relrowsecurity;

  select jsonb_object_agg(required.name, required.valid order by required.name)
  into v_critical_rpcs
  from (
    select
      expected.name,
      resolved.function_oid is not null
        and coalesce(pg_catalog.has_function_privilege(
          'service_role', resolved.function_oid, 'EXECUTE'
        ), false)
        and not coalesce(pg_catalog.has_function_privilege(
          'anon', resolved.function_oid, 'EXECUTE'
        ), false)
        and not coalesce(pg_catalog.has_function_privilege(
          'authenticated', resolved.function_oid, 'EXECUTE'
        ), false) as valid
    from (values
      (
        'create_account_profile',
        'public.create_account_profile(uuid,uuid,uuid,text,text,public.app_role,text,text,text,text)'
      ),
      (
        'get_developer_database_status',
        'public.get_developer_database_status(uuid,text)'
      ),
      (
        'get_room_operational_projection',
        'public.get_room_operational_projection(uuid,uuid)'
      ),
      (
        'is_active_auth_session',
        'public.is_active_auth_session(uuid,uuid)'
      ),
      (
        'process_due_reservation_transitions',
        'public.process_due_reservation_transitions(uuid,timestamp with time zone,text,text)'
      )
    ) as expected(name, signature)
    cross join lateral (
      select pg_catalog.to_regprocedure(expected.signature) as function_oid
    ) resolved
  ) required;

  return jsonb_build_object(
    'databaseReachable', true,
    'currentMigration', v_current_migration,
    'currentMigrationVersion', v_current_migration_version,
    'expectedMigration', p_expected_migration_name,
    'migrationDrift', v_drift,
    'rlsMissingCount', v_rls_missing,
    'rlsValid', v_rls_missing = 0,
    'criticalRpcs', coalesce(v_critical_rpcs, '{}'::jsonb),
    'rowCounts', jsonb_build_object(
      'profiles', (select count(*) from public.profiles),
      'rooms', (select count(*) from public.rooms),
      'auditEventsEstimate', coalesce((
        select greatest(0, c.reltuples::bigint)
        from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'audit_events'
      ), 0)
    ),
    'checkedAt', clock_timestamp()
  );
end;
$$;

create function public.get_developer_scheduler_status(
  p_actor_profile_id uuid,
  p_scheduler_actor_profile_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_actor_valid boolean := false;
  v_cron_available boolean := false;
  v_job_count integer := 0;
  v_job_active boolean := false;
  v_cadence text;
  v_last_cron_status text;
  v_last_cron_started_at timestamptz;
  v_last_cron_ended_at timestamptz;
  v_job_relation regclass;
  v_run_relation regclass;
  v_heartbeat private.scheduler_invocation_heartbeats%rowtype;
  v_status text;
begin
  perform private.assert_active_developer(p_actor_profile_id);

  if p_scheduler_actor_profile_id is not null then
    select exists (
      select 1
      from public.profiles p
      where p.id = p_scheduler_actor_profile_id
        and p.role = 'admin'
        and p.status = 'active'
    ) into v_actor_valid;
  end if;

  v_job_relation := to_regclass('cron.job');
  v_run_relation := to_regclass('cron.job_run_details');
  v_cron_available := v_job_relation is not null;
  if v_cron_available then
    begin
      execute format($cron$
        select
          count(*)::integer,
          coalesce(bool_or(active), false),
          min(schedule)
        from %s
        where jobname = 'reservation-transition-every-minute'
      $cron$, v_job_relation) into v_job_count, v_job_active, v_cadence;

      if v_job_count > 0 and v_run_relation is not null then
        execute format($cron_run$
          select d.status, d.start_time, d.end_time
          from %s d
          join %s j on j.jobid = d.jobid
          where j.jobname = 'reservation-transition-every-minute'
          order by d.runid desc
          limit 1
        $cron_run$, v_run_relation, v_job_relation)
        into v_last_cron_status, v_last_cron_started_at, v_last_cron_ended_at;
      end if;
    exception when others then
      v_cron_available := false;
      v_job_count := 0;
      v_job_active := false;
      v_cadence := null;
      v_last_cron_status := null;
      v_last_cron_started_at := null;
      v_last_cron_ended_at := null;
    end;
  end if;

  select * into v_heartbeat
  from private.scheduler_invocation_heartbeats h
  order by h.last_completed_at desc, h.invocation_key desc
  limit 1;

  v_status := case
    when v_job_count = 0 or not v_job_active then 'not_configured'
    when not v_actor_valid then 'actor_invalid'
    when v_heartbeat.invocation_key is null then 'awaiting_first_run'
    when v_heartbeat.status <> 'succeeded' then 'degraded'
    when v_heartbeat.last_completed_at < clock_timestamp() - interval '5 minutes'
      then 'degraded'
    else 'healthy'
  end;

  return jsonb_build_object(
    'status', v_status,
    'cronCatalogAvailable', v_cron_available,
    'cronConfigured', v_job_count > 0,
    'cronActive', v_job_active,
    'cadence', v_cadence,
    'schedulerActorConfigured', p_scheduler_actor_profile_id is not null,
    'schedulerActorValid', v_actor_valid,
    'lastCronRun', case when v_last_cron_status is null then null else
      jsonb_build_object(
        'status', v_last_cron_status,
        'startedAt', v_last_cron_started_at,
        'endedAt', v_last_cron_ended_at
      )
    end,
    'lastHeartbeat', case when v_heartbeat.invocation_key is null then null else
      jsonb_build_object(
        'invocationKey', v_heartbeat.invocation_key,
        'scheduledAt', v_heartbeat.scheduled_at,
        'status', v_heartbeat.status,
        'transitionCount', v_heartbeat.transition_count,
        'errorCode', v_heartbeat.last_error_code,
        'attemptCount', v_heartbeat.attempt_count,
        'completedAt', v_heartbeat.last_completed_at
      )
    end,
    'checkedAt', clock_timestamp()
  );
end;
$$;

create function public.list_developer_audit_events(
  p_actor_profile_id uuid,
  p_event_types text[] default null,
  p_filter_actor_profile_id uuid default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_before_recorded_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 50
)
returns table (
  id uuid,
  event_type text,
  entity_type text,
  entity_id uuid,
  actor_profile_id uuid,
  actor_display_name text,
  effective_at timestamptz,
  recorded_at timestamptz,
  reason_code text,
  summary jsonb
)
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_allowed constant text[] := array[
    'account.bootstrap_developer_created',
    'account.bootstrap_admin_created',
    'account.created',
    'account.role_changed',
    'account.status_changed',
    'account.unlocked',
    'account.password_reset_requested',
    'account.password_changed'
  ];
  v_selected text[] := coalesce(p_event_types, v_allowed);
  v_from timestamptz := coalesce(p_from, clock_timestamp() - interval '7 days');
  v_to timestamptz := coalesce(p_to, clock_timestamp());
begin
  perform private.assert_active_developer(p_actor_profile_id);

  if p_limit not between 1 and 100
    or v_from > v_to
    or v_to - v_from > interval '31 days'
    or (p_before_recorded_at is null) <> (p_before_id is null)
    or exists (
      select 1 from unnest(v_selected) requested
      where not requested = any (v_allowed)
    ) then
    raise exception using errcode = '22023', message = 'INVALID_AUDIT_QUERY';
  end if;

  return query
  select
    ae.id,
    ae.event_type,
    ae.entity_type,
    ae.entity_id,
    ae.actor_profile_id,
    ae.actor_display_name_snapshot,
    ae.effective_at,
    ae.recorded_at,
    ae.reason_code,
    jsonb_strip_nulls(jsonb_build_object(
      'displayName', ae.after_state ->> 'displayName',
      'loginId', ae.after_state ->> 'loginId',
      'role', ae.after_state ->> 'role',
      'status', ae.after_state ->> 'status',
      'mustChangePassword', ae.after_state -> 'mustChangePassword'
    ))
  from public.audit_events ae
  where ae.event_type = any (v_selected)
    and ae.recorded_at >= v_from
    and ae.recorded_at <= v_to
    and (p_filter_actor_profile_id is null
      or ae.actor_profile_id = p_filter_actor_profile_id)
    and (
      p_before_recorded_at is null
      or (ae.recorded_at, ae.id) < (p_before_recorded_at, p_before_id)
    )
  order by ae.recorded_at desc, ae.id desc
  limit p_limit;
end;
$$;

revoke all on function public.record_scheduler_heartbeat(
  uuid, text, timestamptz, text, integer, text, timestamptz, timestamptz, text
) from public, anon, authenticated;
revoke all on function public.consume_developer_diagnostic_limit(uuid, integer, integer)
from public, anon, authenticated;
revoke all on function public.get_developer_overview(uuid)
from public, anon, authenticated;
revoke all on function public.get_developer_database_status(uuid, text)
from public, anon, authenticated;
revoke all on function public.get_developer_scheduler_status(uuid, uuid)
from public, anon, authenticated;
revoke all on function public.list_developer_audit_events(
  uuid, text[], uuid, timestamptz, timestamptz, timestamptz, uuid, integer
) from public, anon, authenticated;

grant execute on function public.record_scheduler_heartbeat(
  uuid, text, timestamptz, text, integer, text, timestamptz, timestamptz, text
) to service_role;
grant execute on function public.consume_developer_diagnostic_limit(uuid, integer, integer)
to service_role;
grant execute on function public.get_developer_overview(uuid) to service_role;
grant execute on function public.get_developer_database_status(uuid, text)
to service_role;
grant execute on function public.get_developer_scheduler_status(uuid, uuid)
to service_role;
grant execute on function public.list_developer_audit_events(
  uuid, text[], uuid, timestamptz, timestamptz, timestamptz, uuid, integer
) to service_role;
