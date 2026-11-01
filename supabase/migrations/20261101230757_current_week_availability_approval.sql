-- 2026-11-02 user decision: maid current-week changes require administrator approval.
-- Existing RPC signatures, admission hashes, immutable versions and assignment guards stay in force.
-- DB execution requires separate approval; this migration is prepared on dev only.

-- A first current-week request has no approved source yet. Existing references remain enforced.
alter table public.availability_change_requests
  alter column availability_version_id drop not null,
  drop constraint availability_change_requests_source_version_check,
  add constraint availability_change_requests_source_version_check check (
    (source_version = 0 and availability_version_id is null)
    or (source_version > 0 and availability_version_id is not null)
  );

create function private.assert_availability_past_unchanged(
  p_version_id uuid, p_week_start date, p_dates date[], p_command_at timestamptz
) returns void language plpgsql set search_path = pg_catalog as $$
begin
  if p_version_id is null and exists (select 1 from unnest(p_dates) d where d < (p_command_at at time zone 'Asia/Seoul')::date) then
    raise exception using errcode = '22023', message = 'PAST_AVAILABILITY_DATE_NOT_ALLOWED';
  end if;
  if exists (
    select 1 from public.availability_days d
    where d.availability_version_id = p_version_id
      and d.work_date < (p_command_at at time zone 'Asia/Seoul')::date
      and d.available is distinct from (d.work_date = any(p_dates))
  ) then
    raise exception using errcode = '22023', message = 'PAST_AVAILABILITY_DATE_NOT_ALLOWED';
  end if;
end;
$$;
revoke all on function private.assert_availability_past_unchanged(uuid,date,date[],timestamptz) from public, anon, authenticated;

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

  if p_week_start = v_current_week_start then
    raise exception using errcode = '42501', message = 'AVAILABILITY_APPROVAL_REQUIRED';
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


create or replace function private.request_availability_change_at(
  p_actor_profile_id uuid,
  p_week_start date,
  p_requested_available_dates date[],
  p_reason_code text,
  p_expected_version integer,
  p_idempotency_key text,
  p_command_at timestamptz
)
returns public.availability_change_requests
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_dates date[];
  v_local_at timestamp without time zone := p_command_at at time zone 'Asia/Seoul';
  v_hash text;
  v_replay jsonb;
  v_current public.availability_versions%rowtype;
  v_result public.availability_change_requests%rowtype;
begin
  perform private.assert_active_maid(p_actor_profile_id);
  v_dates := private.assert_availability_dates(p_week_start, p_requested_available_dates);
  if p_expected_version is null or p_expected_version < 0 then
    raise exception using errcode = '22023', message = 'EXPECTED_VERSION_INVALID';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,128}$' then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_INVALID';
  end if;
  if p_reason_code is null or p_reason_code !~ '^[A-Z0-9_]{2,80}$' then
    raise exception using errcode = '22023', message = 'REASON_CODE_INVALID';
  end if;

  v_hash := private.availability_request_hash(jsonb_build_object(
    'command', 'availability.change_requested',
    'actorProfileId', p_actor_profile_id,
    'weekStart', p_week_start,
    'requestedAvailableDates', to_jsonb(v_dates),
    'reasonCode', p_reason_code,
    'expectedVersion', p_expected_version
  ));

  v_replay := private.replay_command(
    p_actor_profile_id,
    'availability.change_requested',
    p_idempotency_key,
    v_hash
  );
  if v_replay is not null then
    select * into v_result
    from public.availability_change_requests
    where id = (v_replay ->> 'id')::uuid;
    return v_result;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'availability:' || p_actor_profile_id::text || ':' || p_week_start::text, 0
  ));

  if v_local_at < p_week_start::timestamp then
    raise exception using errcode = '22023', message = 'CHANGE_REQUEST_BEFORE_DEADLINE';
  end if;

  if p_week_start <> date_trunc('week', v_local_at)::date then
    raise exception using errcode = '22023', message = 'AVAILABILITY_WEEK_OUT_OF_RANGE';
  end if;

  select * into v_current
  from public.availability_versions av
  where av.maid_profile_id = p_actor_profile_id
    and av.week_start = p_week_start
    and av.is_current
  for update;
  if coalesce(v_current.version, 0) <> p_expected_version then
    raise exception using errcode = '40001', message = 'STALE_VERSION';
  end if;

  perform private.assert_availability_past_unchanged(v_current.id, p_week_start, v_dates, p_command_at);

  insert into public.availability_change_requests (
    availability_version_id, maid_profile_id, week_start, source_version,
    requested_available_dates, reason_code, status, requested_at
  ) values (
    v_current.id, p_actor_profile_id, p_week_start, coalesce(v_current.version, 0),
    v_dates, p_reason_code, 'pending', p_command_at
  ) returning * into v_result;

  insert into public.audit_events (
    actor_profile_id, actor_display_name_snapshot, event_type, entity_type,
    entity_id, effective_at, reason_code, after_state, idempotency_key
  )
  select
    p.id, p.display_name, 'availability.change_requested', 'availability_change_request',
    v_result.id, p_command_at, p_reason_code,
    jsonb_build_object(
      'maidProfileId', p_actor_profile_id,
      'weekStart', p_week_start,
      'sourceVersion', coalesce(v_current.version, 0),
      'requestedAvailableDates', to_jsonb(v_dates),
      'requestHash', v_hash
    ),
    private.audit_command_key(
      p_actor_profile_id,
      'availability.change_requested',
      p_idempotency_key
    )
  from public.profiles p where p.id = p_actor_profile_id;

  perform private.complete_command(
    p_actor_profile_id,
    'availability.change_requested',
    p_idempotency_key,
    v_hash,
    v_result.id,
    jsonb_build_object('id', v_result.id)
  );

  return v_result;
exception
  when unique_violation then
    if sqlerrm like '%availability_change_requests_one_pending_per_week%' then
      raise exception using errcode = '23505', message = 'PENDING_CHANGE_REQUEST_EXISTS';
    end if;
    raise;
end;
$$;

create or replace function private.decide_availability_change_at(
  p_actor_profile_id uuid,
  p_change_request_id uuid,
  p_decision public.availability_request_status,
  p_reason_code text,
  p_expected_version integer,
  p_idempotency_key text,
  p_command_at timestamptz
)
returns public.availability_change_requests
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_hash text;
  v_replay jsonb;
  v_request public.availability_change_requests%rowtype;
  v_current public.availability_versions%rowtype;
  v_approved public.availability_versions%rowtype;
begin
  perform private.assert_active_availability_admin(p_actor_profile_id);
  if p_expected_version is null or p_expected_version < 0 then
    raise exception using errcode = '22023', message = 'EXPECTED_VERSION_INVALID';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,128}$' then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_INVALID';
  end if;
  if p_decision not in ('approved', 'rejected') then
    raise exception using errcode = '22023', message = 'DECISION_INVALID';
  end if;
  if p_reason_code is null or p_reason_code !~ '^[A-Z0-9_]{2,80}$' then
    raise exception using errcode = '22023', message = 'REASON_CODE_INVALID';
  end if;

  v_hash := private.availability_request_hash(jsonb_build_object(
    'command', 'availability.change_decided',
    'actorProfileId', p_actor_profile_id,
    'changeRequestId', p_change_request_id,
    'decision', p_decision,
    'reasonCode', p_reason_code,
    'expectedVersion', p_expected_version
  ));

  v_replay := private.replay_command(
    p_actor_profile_id,
    'availability.change_decided',
    p_idempotency_key,
    v_hash
  );
  if v_replay is not null then
    select * into v_request
    from public.availability_change_requests
    where id = (v_replay ->> 'id')::uuid;
    return v_request;
  end if;

  select * into v_request
  from public.availability_change_requests
  where id = p_change_request_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'CHANGE_REQUEST_NOT_FOUND';
  end if;
  if v_request.status <> 'pending' then
    raise exception using errcode = '22023', message = 'INVALID_TRANSITION';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'availability:' || v_request.maid_profile_id::text || ':' || v_request.week_start::text, 0
  ));
  select * into v_current
  from public.availability_versions av
  where av.maid_profile_id = v_request.maid_profile_id
    and av.week_start = v_request.week_start
    and av.is_current
  for update;
  if v_request.source_version <> p_expected_version or (p_decision = 'approved' and (
    v_current.id is distinct from v_request.availability_version_id
    or coalesce(v_current.version, 0) <> p_expected_version)) then
    raise exception using errcode = '40001', message = 'STALE_VERSION';
  end if;

  if p_decision = 'approved' then
    perform private.assert_active_maid(v_request.maid_profile_id);
    if v_request.week_start <> date_trunc('week', p_command_at at time zone 'Asia/Seoul')::date then
      raise exception using errcode = '22023', message = 'AVAILABILITY_WEEK_OUT_OF_RANGE';
    end if;
    perform private.assert_availability_past_unchanged(v_current.id, v_request.week_start, v_request.requested_available_dates, p_command_at);
    update public.availability_versions
    set status = 'superseded', is_current = false
    where id = v_current.id;

    insert into public.availability_versions (
      maid_profile_id, week_start, version, status, is_current, submitted_at
    ) values (
      v_request.maid_profile_id, v_request.week_start, coalesce(v_current.version, 0) + 1,
      'submitted', true, p_command_at
    ) returning * into v_approved;

    perform private.insert_availability_days(
      v_approved.id, v_request.week_start, v_request.requested_available_dates
    );
  end if;

  update public.availability_change_requests
  set
    status = p_decision,
    decided_by = p_actor_profile_id,
    decided_at = p_command_at,
    decision_reason_code = p_reason_code,
    approved_version_id = v_approved.id
  where id = v_request.id
  returning * into v_request;

  insert into public.audit_events (
    actor_profile_id, actor_display_name_snapshot, event_type, entity_type,
    entity_id, effective_at, reason_code, before_state, after_state, idempotency_key
  )
  select
    p.id, p.display_name, 'availability.change_decided', 'availability_change_request',
    v_request.id, p_command_at, p_reason_code,
    jsonb_build_object('status', 'pending', 'sourceVersion', coalesce(v_current.version, 0)),
    jsonb_build_object(
      'status', p_decision,
      'approvedVersionId', v_approved.id,
      'requestHash', v_hash
    ),
    private.audit_command_key(
      p_actor_profile_id,
      'availability.change_decided',
      p_idempotency_key
    )
  from public.profiles p where p.id = p_actor_profile_id;

  perform private.complete_command(
    p_actor_profile_id,
    'availability.change_decided',
    p_idempotency_key,
    v_hash,
    v_request.id,
    jsonb_build_object('id', v_request.id)
  );

  return v_request;
end;
$$;

create or replace function private.operation_availability_hash(p_route text,p_actor uuid,p_args jsonb)
returns text language plpgsql volatile set search_path = pg_catalog as $$
declare v_keys text[]; v_expected text[]; v_dates date[]; v_week date; v_version integer; v_payload jsonb;
begin
  if jsonb_typeof(p_args) is distinct from 'object' then
    raise exception using errcode='22023',message='OPERATION_COMMAND_BINDING_REJECTED';
  end if;
  v_expected := case p_route
    when 'submitAvailability' then array['p_actor_profile_id','p_available_dates','p_expected_version','p_week_start']
    when 'requestAvailabilityChange' then array['p_actor_profile_id','p_expected_version','p_reason_code','p_requested_available_dates','p_week_start']
    when 'decideAvailabilityChange' then array['p_actor_profile_id','p_change_request_id','p_decision','p_expected_version','p_reason_code']
    else null end;
  select array_agg(k order by k) into v_keys from jsonb_object_keys(p_args) k;
  if v_expected is null or v_keys is distinct from v_expected
    or jsonb_typeof(p_args->'p_actor_profile_id') is distinct from 'string'
    or (p_args->>'p_actor_profile_id')::uuid is distinct from p_actor
    or jsonb_typeof(p_args->'p_expected_version') is distinct from 'number'
    or p_args->>'p_expected_version' !~ '^[0-9]+$' then
    raise exception using errcode='22023',message='OPERATION_COMMAND_BINDING_REJECTED';
  end if;
  v_version := (p_args->>'p_expected_version')::integer;
  if p_route in ('submitAvailability','requestAvailabilityChange') then
    if jsonb_typeof(p_args->'p_week_start') is distinct from 'string'
      or p_args->>'p_week_start' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception using errcode='22023',message='OPERATION_COMMAND_BINDING_REJECTED';
    end if;
    v_week := (p_args->>'p_week_start')::date;
    v_payload := p_args->(case when p_route='submitAvailability' then 'p_available_dates' else 'p_requested_available_dates' end);
    if jsonb_typeof(v_payload) is distinct from 'array' then
      raise exception using errcode='22023',message='OPERATION_COMMAND_BINDING_REJECTED';
    end if;
    if exists(select 1 from jsonb_array_elements(v_payload) e
      where jsonb_typeof(e) is distinct from 'string' or e#>>'{}' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') then
      raise exception using errcode='22023',message='OPERATION_COMMAND_BINDING_REJECTED';
    end if;
    select coalesce(array_agg(d::date),'{}'::date[]) into v_dates from jsonb_array_elements_text(v_payload) d;
    v_dates := private.assert_availability_dates(v_week,v_dates);
    if p_route='submitAvailability' then
      return private.availability_request_hash(jsonb_build_object('command','availability.submit',
        'actorProfileId',p_actor,'weekStart',v_week,'availableDates',to_jsonb(v_dates),'expectedVersion',v_version));
    end if;
  end if;
  if jsonb_typeof(p_args->'p_reason_code') is distinct from 'string'
    or p_args->>'p_reason_code' !~ '^[A-Z0-9_]{2,80}$' then
    raise exception using errcode='22023',message='OPERATION_COMMAND_BINDING_REJECTED';
  end if;
  if p_route='requestAvailabilityChange' then
    return private.availability_request_hash(jsonb_build_object('command','availability.change_requested',
      'actorProfileId',p_actor,'weekStart',v_week,'requestedAvailableDates',to_jsonb(v_dates),
      'reasonCode',p_args->>'p_reason_code','expectedVersion',v_version));
  end if;
  if jsonb_typeof(p_args->'p_change_request_id') is distinct from 'string'
    or jsonb_typeof(p_args->'p_decision') is distinct from 'string'
    or p_args->>'p_decision' not in ('approved','rejected') then
    raise exception using errcode='22023',message='OPERATION_COMMAND_BINDING_REJECTED';
  end if;
  return private.availability_request_hash(jsonb_build_object('command','availability.change_decided',
    'actorProfileId',p_actor,'changeRequestId',(p_args->>'p_change_request_id')::uuid,
    'decision',(p_args->>'p_decision')::public.availability_request_status,
    'reasonCode',p_args->>'p_reason_code','expectedVersion',v_version));
end;
$$;

-- Keep the internal hash helper private even when installed on the production-only branch.
revoke all on function private.operation_availability_hash(text,uuid,jsonb) from public, anon, authenticated;
