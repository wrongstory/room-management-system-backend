-- #206: one weekly read model that keeps availability, notification, and
-- physical completion as independent facts. No business rows are rewritten.

create index cleaning_assignments_work_history_maid_date_idx
  on public.cleaning_assignments(maid_profile_id, service_date, id)
  where notified_at is not null;

create function public.list_work_history(
  p_actor_profile_id uuid,
  p_session_id uuid,
  p_week_start date,
  p_maid_profile_id uuid default null,
  p_limit integer default 50,
  p_cursor_maid_profile_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor public.profiles%rowtype;
  result jsonb;
begin
  select * into actor
  from public.profiles
  where id = p_actor_profile_id;

  if not found
    or actor.role not in ('admin', 'maid')
    or actor.status <> 'active'
    or actor.must_change_password
  then
    raise exception using errcode = '42501', message = 'WORK_HISTORY_ACCESS_REQUIRED';
  end if;

  if p_session_id is null
    or not public.is_active_auth_session(actor.auth_user_id, p_session_id)
  then
    raise exception using errcode = '42501', message = 'ACTIVE_SESSION_REQUIRED';
  end if;

  if actor.role = 'maid'
    and p_maid_profile_id is not null
    and p_maid_profile_id <> actor.id
  then
    raise exception using errcode = '42501', message = 'WORK_HISTORY_MAID_SCOPE_REQUIRED';
  end if;

  if p_week_start is null
    or extract(isodow from p_week_start) <> 1
    or p_limit is null or p_limit < 1 or p_limit > 100
  then
    raise exception using errcode = '22023', message = 'INVALID_WORK_HISTORY_QUERY';
  end if;

  if p_maid_profile_id is not null
    and not exists (
      select 1 from public.profiles maid
      where maid.id = p_maid_profile_id and maid.role = 'maid'
    )
  then
    raise exception using errcode = '22023', message = 'WORK_HISTORY_MAID_NOT_FOUND';
  end if;

  with scoped_maids as materialized (
    select maid.id, maid.display_name
    from public.profiles maid
    where maid.role = 'maid'
      and (actor.role = 'admin' or maid.id = actor.id)
      and (p_maid_profile_id is null or maid.id = p_maid_profile_id)
  ), availability as materialized (
    select
      maid.id as maid_profile_id,
      current_version.id as current_version_id,
      current_version.version as current_version,
      current_version.submitted_at,
      coalesce(version_count.count, 0)::integer as version_count
    from scoped_maids maid
    left join public.availability_versions current_version
      on current_version.maid_profile_id = maid.id
      and current_version.week_start = p_week_start
      and current_version.is_current
      and current_version.status = 'submitted'
    left join lateral (
      select count(*)::integer as count
      from public.availability_versions version_row
      where version_row.maid_profile_id = maid.id
        and version_row.week_start = p_week_start
    ) version_count on true
  ), available_days as materialized (
    select distinct version_row.maid_profile_id, day.work_date
    from public.availability_versions version_row
    join public.availability_days day
      on day.availability_version_id = version_row.id
    join scoped_maids maid on maid.id = version_row.maid_profile_id
    where version_row.week_start = p_week_start
      and version_row.is_current
      and version_row.status = 'submitted'
      and day.available
  ), notified_days as materialized (
    select distinct assignment.maid_profile_id, assignment.service_date as work_date
    from public.cleaning_assignments assignment
    join scoped_maids maid on maid.id = assignment.maid_profile_id
    where assignment.notified_at is not null
      and assignment.service_date between p_week_start and p_week_start + 6
  ), completed_days as materialized (
    select distinct
      attempt.maid_profile_id,
      (attempt.field_completed_at at time zone 'Asia/Seoul')::date as work_date
    from public.cleaning_attempts attempt
    join scoped_maids maid on maid.id = attempt.maid_profile_id
    where attempt.field_completed_at >= p_week_start::timestamp at time zone 'Asia/Seoul'
      and attempt.field_completed_at < (p_week_start + 7)::timestamp at time zone 'Asia/Seoul'
  ), summary as materialized (
    select jsonb_build_object(
      'maidCount', (select count(*) from scoped_maids),
      'availabilityMaidCount', (select count(distinct maid_profile_id) from available_days),
      'availabilityDayCount', (select count(*) from available_days),
      'notifiedMaidCount', (select count(distinct maid_profile_id) from notified_days),
      'notifiedDayCount', (select count(*) from notified_days),
      'fieldCompletedMaidCount', (select count(distinct maid_profile_id) from completed_days),
      'fieldCompletedDayCount', (select count(*) from completed_days)
    ) as value
  ), candidates as materialized (
    select maid.*
    from scoped_maids maid
    where p_cursor_maid_profile_id is null or maid.id > p_cursor_maid_profile_id
    order by maid.id
    limit p_limit + 1
  ), page as materialized (
    select * from candidates order by id limit p_limit
  ), projected as (
    select
      maid.id,
      jsonb_build_object(
        'maidProfileId', maid.id,
        'maidDisplayName', maid.display_name,
        'maidDisplayNameSource', 'current_profile',
        'availabilitySubmittedAt', availability.submitted_at,
        'availabilityCurrentVersion', availability.current_version,
        'availabilityVersionCount', availability.version_count,
        'days', (
          select jsonb_agg(jsonb_build_object(
            'date', work_day,
            'availableSubmitted', exists (
              select 1 from available_days evidence
              where evidence.maid_profile_id = maid.id and evidence.work_date = work_day
            ),
            'assignmentNotified', exists (
              select 1 from notified_days evidence
              where evidence.maid_profile_id = maid.id and evidence.work_date = work_day
            ),
            'fieldCompleted', exists (
              select 1 from completed_days evidence
              where evidence.maid_profile_id = maid.id and evidence.work_date = work_day
            )
          ) order by work_day)
          from (
            select generated_at::date as work_day
            from generate_series(p_week_start, p_week_start + 6, interval '1 day') series(generated_at)
          ) week_days
        )
      ) as item
    from page maid
    join availability on availability.maid_profile_id = maid.id
  )
  select jsonb_build_object(
    'weekStart', p_week_start,
    'weekEnd', p_week_start + 6,
    'timezone', 'Asia/Seoul',
    'summary', (select value from summary),
    'items', coalesce(
      (select jsonb_agg(projected.item order by projected.id) from projected),
      '[]'::jsonb
    ),
    'nextCursor', case when (select count(*) from candidates) > p_limit then
      jsonb_build_object('maidProfileId', (select id from page order by id desc limit 1))
      else null end
  ) into result;

  return result;
end;
$$;

revoke all on function public.list_work_history(
  uuid, uuid, date, uuid, integer, uuid
) from public, anon, authenticated;
grant execute on function public.list_work_history(
  uuid, uuid, date, uuid, integer, uuid
) to service_role;
