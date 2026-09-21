-- Issue #229: Sunday remains the primary planning day, but active maids may
-- submit or revise availability for the current or next KST week on any day.
-- Past dates in the current week may retain an already-recorded true value,
-- but they cannot be changed from unavailable/missing to available.
create or replace function private.submit_weekly_availability_at(
  p_actor_profile_id uuid,
  p_week_start date,
  p_available_dates date[],
  p_expected_version integer,
  p_idempotency_key text,
  p_command_at timestamptz
)
returns public.availability_versions
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_dates date[];
  v_local_at timestamp without time zone := p_command_at at time zone 'Asia/Seoul';
  v_local_date date;
  v_current_week_start date;
  v_hash text;
  v_replay jsonb;
  v_current public.availability_versions%rowtype;
  v_result public.availability_versions%rowtype;
  v_current_version integer;
begin
  perform private.assert_active_maid(p_actor_profile_id);
  v_dates := private.assert_availability_dates(p_week_start, p_available_dates);
  if p_expected_version < 0 then
    raise exception using errcode = '22023', message = 'EXPECTED_VERSION_INVALID';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,128}$' then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_INVALID';
  end if;

  v_hash := private.availability_request_hash(jsonb_build_object(
    'command', 'availability.submit',
    'actorProfileId', p_actor_profile_id,
    'weekStart', p_week_start,
    'availableDates', to_jsonb(v_dates),
    'expectedVersion', p_expected_version
  ));

  v_replay := private.replay_command(
    p_actor_profile_id,
    'availability.submit',
    p_idempotency_key,
    v_hash
  );
  if v_replay is not null then
    select * into v_result
    from public.availability_versions
    where id = (v_replay ->> 'id')::uuid;
    return v_result;
  end if;

  v_local_date := v_local_at::date;
  v_current_week_start := v_local_date
    - (extract(isodow from v_local_date)::integer - 1);
  if p_week_start <> v_current_week_start
    and p_week_start <> v_current_week_start + 7 then
    raise exception using
      errcode = '22023',
      message = 'AVAILABILITY_WEEK_OUT_OF_RANGE';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'availability:' || p_actor_profile_id::text || ':' || p_week_start::text, 0
  ));

  select * into v_current
  from public.availability_versions av
  where av.maid_profile_id = p_actor_profile_id
    and av.week_start = p_week_start
    and av.is_current
  for update;
  v_current_version := case when found then v_current.version else 0 end;
  if v_current_version <> p_expected_version then
    raise exception using errcode = '40001', message = 'STALE_VERSION';
  end if;

  if p_week_start = v_current_week_start
    and exists (
      select 1
      from unnest(v_dates) requested_date
      where requested_date < v_local_date
        and not exists (
          select 1
          from public.availability_days existing_day
          where existing_day.availability_version_id = v_current.id
            and existing_day.work_date = requested_date
            and existing_day.available
        )
    ) then
    raise exception using
      errcode = '22023',
      message = 'PAST_AVAILABILITY_DATE_NOT_ALLOWED';
  end if;

  if v_current.id is not null then
    update public.availability_versions
    set status = 'superseded', is_current = false
    where id = v_current.id;
  end if;

  insert into public.availability_versions (
    maid_profile_id, week_start, version, status, is_current, submitted_at
  ) values (
    p_actor_profile_id, p_week_start, v_current_version + 1,
    'submitted', true, p_command_at
  ) returning * into v_result;

  perform private.insert_availability_days(v_result.id, p_week_start, v_dates);

  insert into public.audit_events (
    actor_profile_id, actor_display_name_snapshot, event_type, entity_type,
    entity_id, effective_at, after_state, idempotency_key
  )
  select
    p.id, p.display_name, 'availability.submitted', 'availability_version',
    v_result.id, p_command_at,
    jsonb_build_object(
      'maidProfileId', p_actor_profile_id,
      'weekStart', p_week_start,
      'version', v_result.version,
      'availableDates', to_jsonb(v_dates),
      'requestHash', v_hash
    ),
    private.audit_command_key(
      p_actor_profile_id,
      'availability.submit',
      p_idempotency_key
    )
  from public.profiles p
  where p.id = p_actor_profile_id;

  perform private.complete_command(
    p_actor_profile_id,
    'availability.submit',
    p_idempotency_key,
    v_hash,
    v_result.id,
    jsonb_build_object('id', v_result.id)
  );

  return v_result;
end;
$$;

revoke all on function private.submit_weekly_availability_at(
  uuid, date, date[], integer, text, timestamptz
) from public, anon, authenticated;
