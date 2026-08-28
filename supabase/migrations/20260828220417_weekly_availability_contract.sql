-- Issue #6: immutable weekly availability versions, post-deadline change
-- decisions, and an RLS-scoped administrator candidate projection.
create extension if not exists pgcrypto with schema extensions;

create type public.availability_status as enum ('submitted', 'superseded');
create type public.availability_request_status as enum ('pending', 'approved', 'rejected');

create table public.availability_versions (
  id uuid primary key default gen_random_uuid(),
  maid_profile_id uuid not null references public.profiles(id) on delete restrict,
  week_start date not null check (extract(isodow from week_start) = 1),
  version integer not null check (version > 0),
  status public.availability_status not null default 'submitted',
  is_current boolean not null default true,
  submitted_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (maid_profile_id, week_start, version),
  unique (id, maid_profile_id, week_start, version)
);

create unique index availability_versions_one_current_per_week
on public.availability_versions (maid_profile_id, week_start)
where is_current;

create index availability_versions_maid_week_idx
on public.availability_versions (maid_profile_id, week_start, version desc);

create table public.availability_days (
  id bigint generated always as identity primary key,
  availability_version_id uuid not null
    references public.availability_versions(id) on delete restrict,
  work_date date not null,
  available boolean not null,
  created_at timestamptz not null default now(),
  unique (availability_version_id, work_date)
);

create index availability_days_available_date_idx
on public.availability_days (work_date, availability_version_id)
where available;

create table public.availability_change_requests (
  id uuid primary key default gen_random_uuid(),
  availability_version_id uuid not null
    references public.availability_versions(id) on delete restrict,
  maid_profile_id uuid not null references public.profiles(id) on delete restrict,
  week_start date not null check (extract(isodow from week_start) = 1),
  source_version integer not null check (source_version > 0),
  requested_available_dates date[] not null,
  reason_code text not null check (reason_code ~ '^[A-Z0-9_]{2,80}$'),
  status public.availability_request_status not null default 'pending',
  requested_at timestamptz not null,
  decided_by uuid references public.profiles(id) on delete restrict,
  decided_at timestamptz,
  decision_reason_code text check (
    decision_reason_code is null or decision_reason_code ~ '^[A-Z0-9_]{2,80}$'
  ),
  approved_version_id uuid references public.availability_versions(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (id, maid_profile_id, week_start),
  check (
    (status = 'pending' and decided_by is null and decided_at is null
      and decision_reason_code is null and approved_version_id is null)
    or (status = 'rejected' and decided_by is not null and decided_at is not null
      and decision_reason_code is not null and approved_version_id is null)
    or (status = 'approved' and decided_by is not null and decided_at is not null
      and decision_reason_code is not null and approved_version_id is not null)
  )
);

alter table public.availability_change_requests
add constraint availability_change_requests_source_fk
foreign key (availability_version_id, maid_profile_id, week_start, source_version)
references public.availability_versions (id, maid_profile_id, week_start, version)
on delete restrict;

create unique index availability_change_requests_one_pending_per_week
on public.availability_change_requests (maid_profile_id, week_start)
where status = 'pending';

create index availability_change_requests_source_idx
on public.availability_change_requests (availability_version_id);

create index availability_change_requests_decided_by_idx
on public.availability_change_requests (decided_by)
where decided_by is not null;

create function private.canonical_availability_dates(p_dates date[])
returns date[]
language sql
immutable
set search_path = pg_catalog
as $$
  select coalesce(array_agg(d order by d), '{}'::date[])
  from (
    select distinct value as d
    from unnest(coalesce(p_dates, '{}'::date[])) as valueset(value)
    where value is not null
  ) canonical
$$;

create function private.availability_request_hash(p_payload jsonb)
returns text
language sql
immutable
set search_path = pg_catalog, extensions
as $$
  select encode(extensions.digest(p_payload::text, 'sha256'), 'hex')
$$;

create function private.assert_active_maid(p_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if not exists (
    select 1
    from public.profiles p
    where p.id = p_profile_id
      and p.role = 'maid'
      and p.status = 'active'
  ) then
    raise exception using errcode = '42501', message = 'ACTIVE_MAID_REQUIRED';
  end if;
end;
$$;

create function private.assert_active_availability_admin(p_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if not exists (
    select 1
    from public.profiles p
    where p.id = p_profile_id
      and p.role = 'admin'
      and p.status = 'active'
  ) then
    raise exception using errcode = '42501', message = 'ACTIVE_ADMIN_REQUIRED';
  end if;
end;
$$;

create function private.assert_availability_dates(
  p_week_start date,
  p_dates date[]
)
returns date[]
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_dates date[] := private.canonical_availability_dates(p_dates);
begin
  if p_dates is null then
    raise exception using errcode = '22023', message = 'AVAILABILITY_DATES_REQUIRED';
  end if;
  if extract(isodow from p_week_start) <> 1 then
    raise exception using errcode = '22023', message = 'WEEK_START_MUST_BE_MONDAY';
  end if;
  if array_position(p_dates, null) is not null
    or cardinality(v_dates) <> cardinality(coalesce(p_dates, '{}'::date[])) then
    raise exception using errcode = '22023', message = 'AVAILABILITY_DATES_MUST_BE_UNIQUE';
  end if;
  if exists (
    select 1
    from unnest(v_dates) d
    where d < p_week_start or d > p_week_start + 6
  ) then
    raise exception using errcode = '22023', message = 'AVAILABILITY_DATE_OUTSIDE_WEEK';
  end if;
  return v_dates;
end;
$$;

create function private.assert_availability_day_contract()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_week_start date;
begin
  select av.week_start into v_week_start
  from public.availability_versions av
  where av.id = new.availability_version_id;

  if not found or new.work_date < v_week_start or new.work_date > v_week_start + 6 then
    raise exception using errcode = '23514', message = 'AVAILABILITY_DATE_OUTSIDE_WEEK';
  end if;
  return new;
end;
$$;

create trigger availability_days_validate_range
before insert or update on public.availability_days
for each row execute function private.assert_availability_day_contract();

create function private.assert_complete_availability_week()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_version_id uuid := case when tg_op = 'DELETE'
    then old.availability_version_id else new.availability_version_id end;
begin
  if exists (select 1 from public.availability_versions where id = v_version_id)
    and (select count(*) from public.availability_days where availability_version_id = v_version_id) <> 7 then
    raise exception using errcode = '23514', message = 'AVAILABILITY_WEEK_REQUIRES_SEVEN_DAYS';
  end if;
  return coalesce(new, old);
end;
$$;

create constraint trigger availability_days_require_complete_week
after insert or update or delete on public.availability_days
deferrable initially deferred
for each row execute function private.assert_complete_availability_week();

create function private.prevent_availability_history_rewrite()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'AVAILABILITY_HISTORY_DELETE_FORBIDDEN';
  end if;
  if new.id is distinct from old.id
    or new.maid_profile_id is distinct from old.maid_profile_id
    or new.week_start is distinct from old.week_start
    or new.version is distinct from old.version
    or new.submitted_at is distinct from old.submitted_at
    or new.created_at is distinct from old.created_at then
    raise exception using errcode = '55000', message = 'AVAILABILITY_HISTORY_IMMUTABLE';
  end if;
  if not (
    old.status = 'submitted' and old.is_current
    and new.status = 'superseded' and not new.is_current
  ) then
    raise exception using errcode = '55000', message = 'AVAILABILITY_CURRENT_TRANSITION_INVALID';
  end if;
  return new;
end;
$$;

create trigger availability_versions_preserve_history
before update or delete on public.availability_versions
for each row execute function private.prevent_availability_history_rewrite();

create function private.prevent_availability_day_rewrite()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception using errcode = '55000', message = 'AVAILABILITY_DAY_IMMUTABLE';
end;
$$;

create trigger availability_days_preserve_history
before update or delete on public.availability_days
for each row execute function private.prevent_availability_day_rewrite();

create function private.prevent_availability_request_rewrite()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'AVAILABILITY_REQUEST_DELETE_FORBIDDEN';
  end if;
  if new.id is distinct from old.id
    or new.availability_version_id is distinct from old.availability_version_id
    or new.maid_profile_id is distinct from old.maid_profile_id
    or new.week_start is distinct from old.week_start
    or new.source_version is distinct from old.source_version
    or new.requested_available_dates is distinct from old.requested_available_dates
    or new.reason_code is distinct from old.reason_code
    or new.requested_at is distinct from old.requested_at
    or new.created_at is distinct from old.created_at then
    raise exception using errcode = '55000', message = 'AVAILABILITY_REQUEST_IMMUTABLE';
  end if;
  if old.status <> 'pending' or new.status not in ('approved', 'rejected') then
    raise exception using errcode = '55000', message = 'AVAILABILITY_REQUEST_TRANSITION_INVALID';
  end if;
  return new;
end;
$$;

create trigger availability_change_requests_preserve_history
before update or delete on public.availability_change_requests
for each row execute function private.prevent_availability_request_rewrite();

create function private.insert_availability_days(
  p_version_id uuid,
  p_week_start date,
  p_available_dates date[]
)
returns void
language sql
set search_path = pg_catalog, public
as $$
  insert into public.availability_days (
    availability_version_id, work_date, available
  )
  select
    p_version_id,
    p_week_start + day_offset,
    (p_week_start + day_offset) = any(p_available_dates)
  from generate_series(0, 6) day_offset
$$;

create function private.submit_weekly_availability_at(
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
  v_hash text;
  v_receipt public.audit_events%rowtype;
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

  perform pg_advisory_xact_lock(hashtextextended('idempotency:' || p_idempotency_key, 0));
  perform pg_advisory_xact_lock(hashtextextended(
    'availability:' || p_actor_profile_id::text || ':' || p_week_start::text, 0
  ));

  select * into v_receipt
  from public.audit_events ae
  where ae.idempotency_key = p_idempotency_key;
  if found then
    if v_receipt.event_type <> 'availability.submitted'
      or v_receipt.after_state ->> 'requestHash' <> v_hash then
      raise exception using errcode = '23505', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    select * into v_result from public.availability_versions where id = v_receipt.entity_id;
    return v_result;
  end if;

  if extract(isodow from v_local_at) <> 7
    or v_local_at::time < time '12:00'
    or v_local_at::time >= time '24:00'
    or p_week_start <> v_local_at::date + 1 then
    raise exception using errcode = '22023', message = 'OUTSIDE_AVAILABILITY_WINDOW';
  end if;

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
    p_idempotency_key
  from public.profiles p
  where p.id = p_actor_profile_id;

  return v_result;
end;
$$;

create function public.submit_weekly_availability(
  p_actor_profile_id uuid,
  p_week_start date,
  p_available_dates date[],
  p_expected_version integer,
  p_idempotency_key text
)
returns public.availability_versions
language sql
security definer
set search_path = pg_catalog, public
as $$
  select private.submit_weekly_availability_at(
    p_actor_profile_id, p_week_start, p_available_dates,
    p_expected_version, p_idempotency_key, clock_timestamp()
  )
$$;

create function private.request_availability_change_at(
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
  v_receipt public.audit_events%rowtype;
  v_current public.availability_versions%rowtype;
  v_result public.availability_change_requests%rowtype;
begin
  perform private.assert_active_maid(p_actor_profile_id);
  v_dates := private.assert_availability_dates(p_week_start, p_requested_available_dates);
  if p_expected_version < 1 then
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

  perform pg_advisory_xact_lock(hashtextextended('idempotency:' || p_idempotency_key, 0));
  perform pg_advisory_xact_lock(hashtextextended(
    'availability:' || p_actor_profile_id::text || ':' || p_week_start::text, 0
  ));

  select * into v_receipt from public.audit_events where idempotency_key = p_idempotency_key;
  if found then
    if v_receipt.event_type <> 'availability.change_requested'
      or v_receipt.after_state ->> 'requestHash' <> v_hash then
      raise exception using errcode = '23505', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    select * into v_result
    from public.availability_change_requests where id = v_receipt.entity_id;
    return v_result;
  end if;

  if v_local_at < p_week_start::timestamp then
    raise exception using errcode = '22023', message = 'CHANGE_REQUEST_BEFORE_DEADLINE';
  end if;

  select * into v_current
  from public.availability_versions av
  where av.maid_profile_id = p_actor_profile_id
    and av.week_start = p_week_start
    and av.is_current
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'AVAILABILITY_NOT_FOUND';
  end if;
  if v_current.version <> p_expected_version then
    raise exception using errcode = '40001', message = 'STALE_VERSION';
  end if;

  insert into public.availability_change_requests (
    availability_version_id, maid_profile_id, week_start, source_version,
    requested_available_dates, reason_code, status, requested_at
  ) values (
    v_current.id, p_actor_profile_id, p_week_start, v_current.version,
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
      'sourceVersion', v_current.version,
      'requestedAvailableDates', to_jsonb(v_dates),
      'requestHash', v_hash
    ),
    p_idempotency_key
  from public.profiles p where p.id = p_actor_profile_id;

  return v_result;
exception
  when unique_violation then
    if sqlerrm like '%availability_change_requests_one_pending_per_week%' then
      raise exception using errcode = '23505', message = 'PENDING_CHANGE_REQUEST_EXISTS';
    end if;
    raise;
end;
$$;

create function public.request_availability_change(
  p_actor_profile_id uuid,
  p_week_start date,
  p_requested_available_dates date[],
  p_reason_code text,
  p_expected_version integer,
  p_idempotency_key text
)
returns public.availability_change_requests
language sql
security definer
set search_path = pg_catalog, public
as $$
  select private.request_availability_change_at(
    p_actor_profile_id, p_week_start, p_requested_available_dates,
    p_reason_code, p_expected_version, p_idempotency_key, clock_timestamp()
  )
$$;

create function private.decide_availability_change_at(
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
  v_receipt public.audit_events%rowtype;
  v_request public.availability_change_requests%rowtype;
  v_current public.availability_versions%rowtype;
  v_approved public.availability_versions%rowtype;
begin
  perform private.assert_active_availability_admin(p_actor_profile_id);
  if p_expected_version < 1 then
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

  perform pg_advisory_xact_lock(hashtextextended('idempotency:' || p_idempotency_key, 0));
  select * into v_receipt from public.audit_events where idempotency_key = p_idempotency_key;
  if found then
    if v_receipt.event_type <> 'availability.change_decided'
      or v_receipt.after_state ->> 'requestHash' <> v_hash then
      raise exception using errcode = '23505', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    select * into v_request
    from public.availability_change_requests where id = v_receipt.entity_id;
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
  if not found or v_current.id <> v_request.availability_version_id
    or v_current.version <> p_expected_version then
    raise exception using errcode = '40001', message = 'STALE_VERSION';
  end if;

  if p_decision = 'approved' then
    update public.availability_versions
    set status = 'superseded', is_current = false
    where id = v_current.id;

    insert into public.availability_versions (
      maid_profile_id, week_start, version, status, is_current, submitted_at
    ) values (
      v_request.maid_profile_id, v_request.week_start, v_current.version + 1,
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
    jsonb_build_object('status', 'pending', 'sourceVersion', v_current.version),
    jsonb_build_object(
      'status', p_decision,
      'approvedVersionId', v_approved.id,
      'requestHash', v_hash
    ),
    p_idempotency_key
  from public.profiles p where p.id = p_actor_profile_id;

  return v_request;
end;
$$;

create function public.decide_availability_change(
  p_actor_profile_id uuid,
  p_change_request_id uuid,
  p_decision public.availability_request_status,
  p_reason_code text,
  p_expected_version integer,
  p_idempotency_key text
)
returns public.availability_change_requests
language sql
security definer
set search_path = pg_catalog, public
as $$
  select private.decide_availability_change_at(
    p_actor_profile_id, p_change_request_id, p_decision,
    p_reason_code, p_expected_version, p_idempotency_key, clock_timestamp()
  )
$$;

alter table public.availability_versions enable row level security;
alter table public.availability_days enable row level security;
alter table public.availability_change_requests enable row level security;

create policy availability_versions_read_scoped on public.availability_versions
for select to authenticated
using (
  (select private.current_role()) = 'admin'
  or maid_profile_id = (select private.current_profile_id())
);

create policy availability_days_read_scoped on public.availability_days
for select to authenticated
using (
  exists (
    select 1
    from public.availability_versions av
    where av.id = availability_days.availability_version_id
      and (
        (select private.current_role()) = 'admin'
        or av.maid_profile_id = (select private.current_profile_id())
      )
  )
);

create policy availability_change_requests_read_scoped
on public.availability_change_requests
for select to authenticated
using (
  (select private.current_role()) = 'admin'
  or maid_profile_id = (select private.current_profile_id())
);

create view public.availability_candidates
with (security_invoker = true, security_barrier = true)
as
select
  ad.work_date,
  av.week_start,
  av.version as availability_version,
  p.id as maid_profile_id,
  p.display_name
from public.availability_versions av
join public.availability_days ad on ad.availability_version_id = av.id
join public.profiles p on p.id = av.maid_profile_id
where av.is_current
  and av.status = 'submitted'
  and ad.available
  and p.role = 'maid'
  and p.status = 'active';

revoke all on function private.canonical_availability_dates(date[]) from public;
revoke all on function private.availability_request_hash(jsonb) from public;
revoke all on function private.assert_active_maid(uuid) from public;
revoke all on function private.assert_active_availability_admin(uuid) from public;
revoke all on function private.assert_availability_dates(date, date[]) from public;
revoke all on function private.assert_availability_day_contract() from public;
revoke all on function private.assert_complete_availability_week() from public;
revoke all on function private.prevent_availability_history_rewrite() from public;
revoke all on function private.prevent_availability_day_rewrite() from public;
revoke all on function private.prevent_availability_request_rewrite() from public;
revoke all on function private.insert_availability_days(uuid, date, date[]) from public;
revoke all on function private.submit_weekly_availability_at(
  uuid, date, date[], integer, text, timestamptz
) from public;
revoke all on function private.request_availability_change_at(
  uuid, date, date[], text, integer, text, timestamptz
) from public;
revoke all on function private.decide_availability_change_at(
  uuid, uuid, public.availability_request_status, text, integer, text, timestamptz
) from public;

revoke all on function public.submit_weekly_availability(
  uuid, date, date[], integer, text
) from public, anon, authenticated;
revoke all on function public.request_availability_change(
  uuid, date, date[], text, integer, text
) from public, anon, authenticated;
revoke all on function public.decide_availability_change(
  uuid, uuid, public.availability_request_status, text, integer, text
) from public, anon, authenticated;

grant execute on function public.submit_weekly_availability(
  uuid, date, date[], integer, text
) to service_role;
grant execute on function public.request_availability_change(
  uuid, date, date[], text, integer, text
) to service_role;
grant execute on function public.decide_availability_change(
  uuid, uuid, public.availability_request_status, text, integer, text
) to service_role;

revoke all privileges on public.availability_versions,
  public.availability_days, public.availability_change_requests
from anon, authenticated;
grant select on public.availability_versions,
  public.availability_days, public.availability_change_requests,
  public.availability_candidates
to authenticated;

grant all privileges on public.availability_versions,
  public.availability_days, public.availability_change_requests
to service_role;
grant usage, select on sequence public.availability_days_id_seq to service_role;
grant select on public.availability_candidates to service_role;
