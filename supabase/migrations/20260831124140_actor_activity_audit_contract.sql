-- Issue #58: keep successful domain audit separate from authentication,
-- authorization, and sensitive-access activity. Raw activity tables stay in
-- the non-exposed private schema and every callable projection is service-owned.

create table private.actor_activity_events (
  id uuid primary key default gen_random_uuid(),
  actor_profile_id uuid not null references public.profiles(id),
  actor_role_snapshot public.app_role not null,
  category text not null check (category in ('auth', 'sensitive_access')),
  event_type text not null check (event_type in (
    'auth.login_succeeded',
    'auth.login_failed',
    'sensitive.read'
  )),
  outcome text not null check (outcome in ('succeeded', 'failed')),
  source text not null check (source in (
    'edge.auth.login',
    'edge.sensitive.reservation_guest_name'
  )),
  resource_type text,
  resource_id uuid,
  reason_code text,
  request_id text not null,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp(),
  constraint actor_activity_reason_code_safe check (
    reason_code is null or reason_code ~ '^[A-Z0-9_]{2,80}$'
  ),
  constraint actor_activity_request_id_safe check (
    request_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  constraint actor_activity_resource_pair check (
    (resource_type is null) = (resource_id is null)
  )
);

comment on table private.actor_activity_events is
  'Immutable known-actor login and sensitive-access activity. Request IDs are server-generated UUID v4 only; no caller request metadata, credentials, raw addresses, or free-form fields.';

create index actor_activity_recorded_cursor_idx
on private.actor_activity_events (recorded_at desc, id desc);

create index actor_activity_actor_cursor_idx
on private.actor_activity_events (actor_profile_id, recorded_at desc, id desc);

create index actor_activity_type_outcome_cursor_idx
on private.actor_activity_events (event_type, outcome, recorded_at desc, id desc);

create trigger actor_activity_events_append_only
before update or delete on private.actor_activity_events
for each row execute function private.prevent_append_only_mutation();

-- Unknown aliases never become actor events. They are represented by one
-- saturated aggregate per UTC minute, so rotating IDs cannot grow row
-- cardinality. No login ID, HMAC, request ID, or client address is stored.
create table private.actor_activity_aggregates (
  id uuid primary key default gen_random_uuid(),
  bucket_started_at timestamptz not null,
  category text not null check (category = 'auth'),
  event_type text not null check (event_type = 'auth.login_failed'),
  outcome text not null check (outcome = 'failed'),
  source text not null check (source = 'edge.auth.login'),
  reason_code text not null check (reason_code = 'UNKNOWN_ACCOUNT'),
  occurrence_count integer not null check (occurrence_count between 1 and 600),
  first_occurred_at timestamptz not null,
  last_occurred_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp(),
  unique (bucket_started_at, event_type, source),
  check (first_occurred_at <= last_occurred_at)
);

comment on table private.actor_activity_aggregates is
  '31-day bounded unknown-login aggregate. It intentionally contains no actor or raw identifier.';

create index actor_activity_aggregates_recorded_cursor_idx
on private.actor_activity_aggregates (recorded_at desc, id desc);

-- Authorization denials are accountability signals, but a caller must not be
-- able to grow the ledger by repeatedly hitting the same forbidden capability.
-- Keep one saturated row per actor/source/reason/UTC minute.
create table private.actor_authorization_denial_aggregates (
  id uuid primary key default gen_random_uuid(),
  actor_profile_id uuid not null references public.profiles(id),
  actor_role_snapshot public.app_role not null,
  category text not null check (category = 'authorization'),
  event_type text not null check (event_type = 'authorization.denied'),
  outcome text not null check (outcome = 'denied'),
  source text not null check (source in (
    'edge.authorization.accounts',
    'edge.authorization.developer',
    'edge.authorization.availability',
    'edge.authorization.reservations',
    'edge.authorization.rooms'
  )),
  reason_code text not null check (reason_code in (
    'ACCOUNT_MANAGER_REQUIRED',
    'ADMIN_REQUIRED',
    'AVAILABILITY_ACCESS_REQUIRED',
    'DEVELOPER_REQUIRED',
    'MAID_REQUIRED',
    'PASSWORD_CHANGE_REQUIRED'
  )),
  bucket_started_at timestamptz not null,
  occurrence_count integer not null check (occurrence_count between 1 and 600),
  first_occurred_at timestamptz not null,
  last_occurred_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp(),
  unique (actor_profile_id, source, reason_code, bucket_started_at),
  check (first_occurred_at <= last_occurred_at)
);

comment on table private.actor_authorization_denial_aggregates is
  'One bounded authorization-denial row per actor, capability, reason, and UTC minute. No request metadata or free-form input is stored.';

create index actor_authorization_denial_actor_cursor_idx
on private.actor_authorization_denial_aggregates (
  actor_profile_id, recorded_at desc, id desc
);

create index actor_authorization_denial_cursor_idx
on private.actor_authorization_denial_aggregates (recorded_at desc, id desc);

revoke all on table private.actor_activity_events from public, anon, authenticated, service_role;
revoke all on table private.actor_activity_aggregates from public, anon, authenticated, service_role;
revoke all on table private.actor_authorization_denial_aggregates
from public, anon, authenticated, service_role;

create function public.record_actor_activity_event(
  p_actor_profile_id uuid,
  p_event_type text,
  p_outcome text,
  p_source text,
  p_request_id text,
  p_reason_code text default null,
  p_resource_type text default null,
  p_resource_id uuid default null,
  p_occurred_at timestamptz default clock_timestamp()
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles%rowtype;
  v_category text;
  v_id uuid;
begin
  if p_request_id is null
    or p_request_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_occurred_at is null
    or abs(extract(epoch from (clock_timestamp() - p_occurred_at))) > 300
    or (p_reason_code is not null and p_reason_code !~ '^[A-Z0-9_]{2,80}$')
    or (p_resource_type is null) <> (p_resource_id is null) then
    raise exception using errcode = '22023', message = 'INVALID_ACTIVITY_EVENT';
  end if;

  select * into v_profile
  from public.profiles p
  where p.id = p_actor_profile_id;
  if not found then
    raise exception using errcode = '22023', message = 'INVALID_ACTIVITY_ACTOR';
  end if;

  case
    when p_event_type = 'auth.login_succeeded'
      and p_outcome = 'succeeded'
      and p_source = 'edge.auth.login'
      and p_reason_code is null
      and p_resource_type is null then
      v_category := 'auth';
    when p_event_type = 'auth.login_failed'
      and p_outcome = 'failed'
      and p_source = 'edge.auth.login'
      and p_reason_code in (
        'INVALID_CREDENTIALS',
        'ACCOUNT_INACTIVE',
        'ACCOUNT_LOCKED'
      )
      and p_resource_type is null then
      v_category := 'auth';
    when p_event_type = 'sensitive.read'
      and p_outcome = 'succeeded'
      and p_source = 'edge.sensitive.reservation_guest_name'
      and p_reason_code is null
      and p_resource_type = 'reservation'
      and p_resource_id is not null then
      v_category := 'sensitive_access';
    else
      raise exception using errcode = '22023', message = 'INVALID_ACTIVITY_EVENT';
  end case;

  if p_event_type in (
    'auth.login_succeeded',
    'sensitive.read'
  ) and v_profile.status <> 'active' then
    raise exception using errcode = '22023', message = 'INVALID_ACTIVITY_ACTOR';
  end if;
  if p_event_type = 'sensitive.read' and (
    v_profile.role <> 'admin'
    or not exists (
      select 1 from public.reservations reservation
      where reservation.id = p_resource_id
    )
  ) then
    raise exception using errcode = '22023', message = 'INVALID_ACTIVITY_ACTOR';
  end if;

  insert into private.actor_activity_events (
    actor_profile_id,
    actor_role_snapshot,
    category,
    event_type,
    outcome,
    source,
    resource_type,
    resource_id,
    reason_code,
    request_id,
    occurred_at
  ) values (
    v_profile.id,
    v_profile.role,
    v_category,
    p_event_type,
    p_outcome,
    p_source,
    p_resource_type,
    p_resource_id,
    p_reason_code,
    p_request_id,
    p_occurred_at
  ) returning id into v_id;

  return v_id;
end;
$$;

create function public.record_unknown_login_failure(
  p_occurred_at timestamptz default clock_timestamp()
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bucket timestamptz;
begin
  if p_occurred_at is null
    or abs(extract(epoch from (clock_timestamp() - p_occurred_at))) > 300 then
    raise exception using errcode = '22023', message = 'INVALID_ACTIVITY_EVENT';
  end if;

  v_bucket := date_trunc('minute', p_occurred_at);

  insert into private.actor_activity_aggregates (
    bucket_started_at,
    category,
    event_type,
    outcome,
    source,
    reason_code,
    occurrence_count,
    first_occurred_at,
    last_occurred_at
  ) values (
    v_bucket,
    'auth',
    'auth.login_failed',
    'failed',
    'edge.auth.login',
    'UNKNOWN_ACCOUNT',
    1,
    p_occurred_at,
    p_occurred_at
  )
  on conflict (bucket_started_at, event_type, source) do update
  set occurrence_count = least(
        private.actor_activity_aggregates.occurrence_count + 1,
        600
      ),
      last_occurred_at = greatest(
        private.actor_activity_aggregates.last_occurred_at,
        excluded.last_occurred_at
      );

  delete from private.actor_activity_aggregates aggregate
  where aggregate.id in (
    select expired.id
    from private.actor_activity_aggregates expired
    where expired.bucket_started_at < v_bucket - interval '31 days'
    order by expired.bucket_started_at
    limit 64
  );
end;
$$;

create function public.record_authorization_denial(
  p_actor_profile_id uuid,
  p_source text,
  p_reason_code text,
  p_occurred_at timestamptz default clock_timestamp()
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles%rowtype;
  v_bucket timestamptz;
begin
  if p_occurred_at is null
    or abs(extract(epoch from (clock_timestamp() - p_occurred_at))) > 300
    or p_source not in (
      'edge.authorization.accounts',
      'edge.authorization.developer',
      'edge.authorization.availability',
      'edge.authorization.reservations',
      'edge.authorization.rooms'
    )
    or p_reason_code not in (
      'ACCOUNT_MANAGER_REQUIRED',
      'ADMIN_REQUIRED',
      'AVAILABILITY_ACCESS_REQUIRED',
      'DEVELOPER_REQUIRED',
      'MAID_REQUIRED',
      'PASSWORD_CHANGE_REQUIRED'
    ) then
    raise exception using errcode = '22023', message = 'INVALID_ACTIVITY_EVENT';
  end if;

  select * into v_profile
  from public.profiles profile
  where profile.id = p_actor_profile_id
    and profile.status = 'active';
  if not found then
    raise exception using errcode = '22023', message = 'INVALID_ACTIVITY_ACTOR';
  end if;

  v_bucket := date_trunc('minute', p_occurred_at);

  insert into private.actor_authorization_denial_aggregates (
    actor_profile_id,
    actor_role_snapshot,
    category,
    event_type,
    outcome,
    source,
    reason_code,
    bucket_started_at,
    occurrence_count,
    first_occurred_at,
    last_occurred_at
  ) values (
    v_profile.id,
    v_profile.role,
    'authorization',
    'authorization.denied',
    'denied',
    p_source,
    p_reason_code,
    v_bucket,
    1,
    p_occurred_at,
    p_occurred_at
  )
  on conflict (actor_profile_id, source, reason_code, bucket_started_at)
  do update set
    occurrence_count = least(
      private.actor_authorization_denial_aggregates.occurrence_count + 1,
      600
    ),
    last_occurred_at = greatest(
      private.actor_authorization_denial_aggregates.last_occurred_at,
      excluded.last_occurred_at
    );

  delete from private.actor_authorization_denial_aggregates aggregate
  where aggregate.id in (
    select expired.id
    from private.actor_authorization_denial_aggregates expired
    where expired.bucket_started_at < v_bucket - interval '31 days'
    order by expired.bucket_started_at
    limit 64
  );
end;
$$;

create function public.list_developer_activity_events(
  p_actor_profile_id uuid,
  p_filter_actor_profile_id uuid default null,
  p_role public.app_role default null,
  p_categories text[] default null,
  p_event_types text[] default null,
  p_outcomes text[] default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_before_recorded_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 50
)
returns table (
  id uuid,
  category text,
  event_type text,
  outcome text,
  actor_profile_id uuid,
  actor_role text,
  source text,
  resource_type text,
  resource_id uuid,
  reason_code text,
  request_id text,
  occurred_at timestamptz,
  recorded_at timestamptz,
  summary jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_allowed_categories constant text[] := array['auth', 'authorization', 'sensitive_access'];
  v_allowed_event_types constant text[] := array[
    'auth.login_succeeded',
    'auth.login_failed',
    'authorization.denied',
    'sensitive.read'
  ];
  v_allowed_outcomes constant text[] := array['succeeded', 'failed', 'denied'];
  v_categories text[] := coalesce(p_categories, v_allowed_categories);
  v_event_types text[] := coalesce(p_event_types, v_allowed_event_types);
  v_outcomes text[] := coalesce(p_outcomes, v_allowed_outcomes);
  v_from timestamptz := coalesce(p_from, clock_timestamp() - interval '7 days');
  v_to timestamptz := coalesce(p_to, clock_timestamp());
begin
  perform private.assert_active_developer(p_actor_profile_id);

  if p_limit not between 1 and 100
    or v_from > v_to
    or v_to - v_from > interval '31 days'
    or (p_before_recorded_at is null) <> (p_before_id is null)
    or coalesce(cardinality(v_categories), 0) not between 1 and 3
    or coalesce(cardinality(v_event_types), 0) not between 1 and 4
    or coalesce(cardinality(v_outcomes), 0) not between 1 and 3
    or exists (
      select 1 from unnest(v_categories) requested
      where not requested = any (v_allowed_categories)
    )
    or exists (
      select 1 from unnest(v_event_types) requested
      where not requested = any (v_allowed_event_types)
    )
    or exists (
      select 1 from unnest(v_outcomes) requested
      where not requested = any (v_allowed_outcomes)
    ) then
    raise exception using errcode = '22023', message = 'INVALID_ACTIVITY_QUERY';
  end if;

  return query
  with combined as (
    select
      event.id,
      event.category,
      event.event_type,
      event.outcome,
      event.actor_profile_id,
      event.actor_role_snapshot::text as actor_role,
      event.source,
      event.resource_type,
      event.resource_id,
      event.reason_code,
      event.request_id,
      event.occurred_at,
      event.recorded_at,
      '{}'::jsonb as summary
    from private.actor_activity_events event
    union all
    select
      denial.id,
      denial.category,
      denial.event_type,
      denial.outcome,
      denial.actor_profile_id,
      denial.actor_role_snapshot::text,
      denial.source,
      null::text,
      null::uuid,
      denial.reason_code,
      null::text,
      denial.first_occurred_at,
      denial.recorded_at,
      jsonb_build_object(
        'aggregateCount', denial.occurrence_count,
        'lastOccurredAt', denial.last_occurred_at,
        'bucketMinutes', 1
      )
    from private.actor_authorization_denial_aggregates denial
    union all
    select
      aggregate.id,
      aggregate.category,
      aggregate.event_type,
      aggregate.outcome,
      null::uuid,
      null::text,
      aggregate.source,
      null::text,
      null::uuid,
      aggregate.reason_code,
      null::text,
      aggregate.first_occurred_at,
      aggregate.recorded_at,
      jsonb_build_object(
        'aggregateCount', aggregate.occurrence_count,
        'lastOccurredAt', aggregate.last_occurred_at,
        'bucketMinutes', 1
      )
    from private.actor_activity_aggregates aggregate
  )
  select
    combined.id,
    combined.category,
    combined.event_type,
    combined.outcome,
    combined.actor_profile_id,
    combined.actor_role,
    combined.source,
    combined.resource_type,
    combined.resource_id,
    combined.reason_code,
    combined.request_id,
    combined.occurred_at,
    combined.recorded_at,
    combined.summary
  from combined
  where combined.category = any (v_categories)
    and combined.event_type = any (v_event_types)
    and combined.outcome = any (v_outcomes)
    and combined.recorded_at >= v_from
    and combined.recorded_at <= v_to
    and (p_filter_actor_profile_id is null
      or combined.actor_profile_id = p_filter_actor_profile_id)
    and (p_role is null or combined.actor_role = p_role::text)
    and (
      p_before_recorded_at is null
      or (combined.recorded_at, combined.id) < (p_before_recorded_at, p_before_id)
    )
  order by combined.recorded_at desc, combined.id desc
  limit p_limit;
end;
$$;

-- Expand the existing immutable domain audit projection to every event type
-- currently emitted by account, availability, reservation, room, cleaning,
-- and scheduler-driven reservation commands. Raw state JSON never leaves DB.
create or replace function public.list_developer_audit_events(
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
set search_path = ''
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
    'account.password_changed',
    'availability.submitted',
    'availability.change_requested',
    'availability.change_decided',
    'reservation.created',
    'reservation.changed',
    'reservation.cancelled',
    'reservation.manual_checkout',
    'reservation.scheduled_check_in',
    'reservation.scheduled_checkout',
    'reservation.guest_name_retention_purged',
    'cleaning.manual_request.created',
    'cleaning.manual_request.cancelled',
    'room.master_data_changed',
    'room.create_block',
    'room.release_block',
    'room.set_candle_count',
    'room.report_issue',
    'room.resolve_issue',
    'room.record_pin_sync'
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
    or coalesce(cardinality(v_selected), 0) not between 1 and 27
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
    case
      when ae.event_type like 'account.%' then
        jsonb_strip_nulls(jsonb_build_object(
          'displayName', ae.after_state ->> 'displayName',
          'loginId', ae.after_state ->> 'loginId',
          'role', ae.after_state ->> 'role',
          'status', ae.after_state ->> 'status',
          'mustChangePassword', ae.after_state -> 'mustChangePassword'
        ))
      when ae.event_type like 'availability.%' then
        jsonb_strip_nulls(jsonb_build_object(
          'maidProfileId', ae.after_state ->> 'maidProfileId',
          'weekStart', ae.after_state ->> 'weekStart',
          'version', ae.after_state -> 'version',
          'sourceVersion', ae.after_state -> 'sourceVersion',
          'status', ae.after_state ->> 'status',
          'approvedVersionId', ae.after_state ->> 'approvedVersionId'
        ))
      when ae.event_type like 'reservation.%' then
        jsonb_strip_nulls(jsonb_build_object(
          'roomId', ae.after_state ->> 'room_id',
          'status', ae.after_state ->> 'status',
          'version', ae.after_state -> 'version',
          'checkInAt', ae.after_state ->> 'check_in_at',
          'checkOutAt', ae.after_state ->> 'check_out_at',
          'purgedCount', ae.after_state -> 'purged_count'
        ))
      when ae.event_type like 'cleaning.%' then
        jsonb_strip_nulls(jsonb_build_object(
          'roomId', ae.after_state ->> 'room_id',
          'reservationId', ae.after_state ->> 'reservation_id',
          'cleaningKind', ae.after_state ->> 'cleaning_kind',
          'status', ae.after_state ->> 'status',
          'serviceDate', ae.after_state ->> 'service_date',
          'availableFrom', ae.after_state ->> 'available_from',
          'dueAt', ae.after_state ->> 'due_at',
          'version', ae.after_state -> 'version'
        ))
      when ae.event_type like 'room.%' then
        jsonb_strip_nulls(jsonb_build_object(
          'roomTypeId', ae.after_state ->> 'roomTypeId',
          'elevatorZone', ae.after_state ->> 'elevatorZone',
          'dataStatus', ae.after_state ->> 'dataStatus',
          'stateVersion', ae.after_state -> 'stateVersion',
          'blockId', ae.after_state ->> 'blockId',
          'active', ae.after_state -> 'active',
          'count', ae.after_state -> 'count',
          'issueId', ae.after_state ->> 'issueId',
          'category', ae.after_state ->> 'category',
          'severity', ae.after_state ->> 'severity',
          'blocksGuestAssignment', ae.after_state -> 'blocksGuestAssignment',
          'status', ae.after_state ->> 'status',
          'pinSyncEventId', ae.after_state ->> 'pinSyncEventId',
          'syncStatus', ae.after_state ->> 'syncStatus',
          'pinVersion', ae.after_state -> 'pinVersion'
        ))
      else '{}'::jsonb
    end
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

revoke all on function public.record_actor_activity_event(
  uuid, text, text, text, text, text, text, uuid, timestamptz
) from public, anon, authenticated;
revoke all on function public.record_unknown_login_failure(timestamptz)
from public, anon, authenticated;
revoke all on function public.record_authorization_denial(
  uuid, text, text, timestamptz
) from public, anon, authenticated;
revoke all on function public.list_developer_activity_events(
  uuid, uuid, public.app_role, text[], text[], text[], timestamptz, timestamptz,
  timestamptz, uuid, integer
) from public, anon, authenticated;

grant execute on function public.record_actor_activity_event(
  uuid, text, text, text, text, text, text, uuid, timestamptz
) to service_role;
grant execute on function public.record_unknown_login_failure(timestamptz)
to service_role;
grant execute on function public.record_authorization_denial(
  uuid, text, text, timestamptz
) to service_role;
grant execute on function public.list_developer_activity_events(
  uuid, uuid, public.app_role, text[], text[], text[], timestamptz, timestamptz,
  timestamptz, uuid, integer
) to service_role;

-- Re-assert the pre-existing domain audit projection grant after CREATE OR REPLACE.
revoke all on function public.list_developer_audit_events(
  uuid, text[], uuid, timestamptz, timestamptz, timestamptz, uuid, integer
) from public, anon, authenticated;
grant execute on function public.list_developer_audit_events(
  uuid, text[], uuid, timestamptz, timestamptz, timestamptz, uuid, integer
) to service_role;
