-- #559: remove one unused private argument; no policy or warning allowance changes.
-- Existing migration history is immutable. Database execution needs separate approval.
-- Only the private helper receives a new identity; both callers retain their OIDs/ACLs.
do $availability_guard_559$
declare expected jsonb; actual record; actual_acl text[];
begin
  if to_regprocedure('private.assert_availability_past_unchanged(uuid,date[],timestamptz)') is not null then
    raise exception using errcode='55000',message='AVAILABILITY_GUARD_SOURCE_DRIFT';
  end if;
  for expected in select value from jsonb_array_elements($origins$[{"identity":"private.assert_availability_past_unchanged(uuid,date,date[],timestamptz)","beforeSha256":"e24f147079881aa327529ad2df2283aa502e9c96229ee0f6d358886ed8d1c390","afterSha256":"e24f147079881aa327529ad2df2283aa502e9c96229ee0f6d358886ed8d1c390","returnType":"void","securityDefiner":false,"argumentNames":["p_version_id","p_week_start","p_dates","p_command_at"],"settings":["search_path=pg_catalog"]},{"identity":"private.request_availability_change_at(uuid,date,date[],text,integer,text,timestamptz)","beforeSha256":"219b6a499f4e19b10743c06a047a8255ff32b81ce184fa7f1d931c9845547354","afterSha256":"24d5287e5137557a16143c3122010abee62721bb3e46c8211bc79a5531d11327","returnType":"public.availability_change_requests","securityDefiner":true,"argumentNames":["p_actor_profile_id","p_week_start","p_requested_available_dates","p_reason_code","p_expected_version","p_idempotency_key","p_command_at"],"settings":["search_path=pg_catalog, public, extensions"]},{"identity":"private.decide_availability_change_at(uuid,uuid,public.availability_request_status,text,integer,text,timestamptz)","beforeSha256":"906b3b5602a45e83450a2d7d76cdca178b76f6c3f68dc69085989436c6dd0c20","afterSha256":"bd1cb599f4d4764ad7d47877d29c5da7c83d09550882eb1e104c04afda06c3f5","returnType":"public.availability_change_requests","securityDefiner":true,"argumentNames":["p_actor_profile_id","p_change_request_id","p_decision","p_reason_code","p_expected_version","p_idempotency_key","p_command_at"],"settings":["search_path=pg_catalog, public, extensions"]}]$origins$::jsonb) loop
    select p.*,r.rolname as owner_name,l.lanname as language_name into actual
      from pg_proc p join pg_roles r on r.oid=p.proowner join pg_language l on l.oid=p.prolang
      where p.oid=to_regprocedure(expected->>'identity');
    if not found then
      raise exception using errcode='55000',message='AVAILABILITY_GUARD_SOURCE_DRIFT';
    end if;
    select array_agg(a::text order by a::text) into actual_acl
      from unnest(coalesce(actual.proacl,acldefault('f',actual.proowner))) a;
    if encode(extensions.digest(replace(actual.prosrc,E'\r\n',E'\n'),'sha256'),'hex')<>expected->>'beforeSha256'
      or position(E'\r' in replace(actual.prosrc,E'\r\n',E'\n'))<>0
      or actual.prokind<>'f' or actual.language_name<>'plpgsql' or actual.owner_name<>'postgres'
      or actual.provolatile<>'v' or actual.proisstrict or actual.proretset
      or actual.prosecdef is distinct from (expected->>'securityDefiner')::boolean
      or actual.prorettype<>to_regtype(expected->>'returnType')
      or to_jsonb(actual.proargnames) is distinct from expected->'argumentNames'
      or to_jsonb(actual.proconfig) is distinct from expected->'settings'
      or actual_acl is distinct from array['postgres=X/postgres']::text[]
      or actual.proleakproof or actual.proparallel<>'u'
      or actual.pronargdefaults<>0 or actual.proargdefaults is not null
      or actual.proargmodes is not null or actual.proallargtypes is not null
      or actual.provariadic<>0 or actual.prosupport<>0 or actual.probin is not null
      or actual.procost<>100 or actual.prorows<>0
      or (select count(*) from pg_proc p where p.pronamespace=actual.pronamespace and p.proname=actual.proname)<>1 then
      raise exception using errcode='55000',message='AVAILABILITY_GUARD_SOURCE_DRIFT';
    end if;
  end loop;
end
$availability_guard_559$;

create function private.assert_availability_past_unchanged(
  p_version_id uuid, p_dates date[], p_command_at timestamptz
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
alter function private.assert_availability_past_unchanged(uuid,date[],timestamptz) owner to postgres;
revoke all on function private.assert_availability_past_unchanged(uuid,date[],timestamptz)
from public, anon, authenticated, service_role;

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

  perform private.assert_availability_past_unchanged(v_current.id, v_dates, p_command_at);

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
    perform private.assert_availability_past_unchanged(v_current.id, v_request.requested_available_dates, p_command_at);
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

do $availability_guard_acl_559$
begin
  if (select array_agg(a::text order by a::text) from pg_proc p,
    lateral unnest(coalesce(p.proacl,acldefault('f',p.proowner))) a
    where p.oid='private.assert_availability_past_unchanged(uuid,date[],timestamptz)'::regprocedure)
    is distinct from array['postgres=X/postgres']::text[] then
    raise exception using errcode='55000',message='AVAILABILITY_GUARD_ACL_DRIFT';
  end if;
end
$availability_guard_acl_559$;

-- RESTRICT rejects catalog-tracked dependencies; never CASCADE.
-- The two known repository callers are replaced above. Text/dynamic PLpgSQL
-- references are not proven absent by pg_depend and are not claimed here.
drop function private.assert_availability_past_unchanged(uuid,date,date[],timestamptz) restrict;
