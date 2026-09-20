-- Issue #236: developer-safe room catalog and room-type capacity management.
-- Existing guest-count values are preserved. This migration does not backfill or
-- otherwise promote a new set of production occupancy numbers.

alter table public.rooms
  add column active boolean not null default true,
  add column deactivated_at timestamptz,
  add column deactivated_by uuid references public.profiles(id) on delete restrict,
  add column deactivation_reason_code text,
  add constraint rooms_deactivation_shape_check check (
    (active and deactivated_at is null and deactivated_by is null and deactivation_reason_code is null)
    or
    (not active and deactivated_at is not null and deactivated_by is not null
      and deactivation_reason_code is not null
      and deactivation_reason_code ~ '^[A-Z0-9_]{2,80}$')
  );

create index rooms_active_type_number_idx
  on public.rooms(active, room_type_id, room_number, id);
create index rooms_deactivated_by_idx
  on public.rooms(deactivated_by) where deactivated_by is not null;

create function private.prevent_room_hard_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception using errcode = '23514', message = 'ROOM_HARD_DELETE_FORBIDDEN';
end;
$$;

revoke all on function private.prevent_room_hard_delete()
from public, anon, authenticated, service_role;

create trigger rooms_prevent_hard_delete
before delete on public.rooms
for each row execute function private.prevent_room_hard_delete();

create table private.developer_catalog_previews (
  id uuid primary key default gen_random_uuid(),
  actor_profile_id uuid not null references public.profiles(id) on delete restrict,
  preview_kind text not null check (preview_kind in ('room_type_capacity', 'room_deactivation')),
  entity_id uuid not null,
  expected_version bigint not null check (expected_version > 0),
  request_payload jsonb not null,
  impact_payload jsonb not null,
  impact_fingerprint text not null unique check (impact_fingerprint ~ '^[0-9a-f]{64}$'),
  evaluated_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  check (expires_at = evaluated_at + interval '5 minutes'),
  check (consumed_at is null or consumed_at >= evaluated_at)
);

create index developer_catalog_previews_actor_expiry_idx
  on private.developer_catalog_previews(actor_profile_id, expires_at, id);

alter table private.developer_catalog_previews enable row level security;
alter table private.developer_catalog_previews force row level security;
revoke all on private.developer_catalog_previews from public, anon, authenticated, service_role;

create or replace function private.assert_active_developer(p_actor_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.profiles profile
    where profile.id = p_actor_profile_id
      and profile.role = 'developer'
      and profile.status = 'active'
      and not profile.must_change_password
  ) then
    raise exception using errcode = '42501', message = 'DEVELOPER_REQUIRED';
  end if;
end;
$$;

revoke all on function private.assert_active_developer(uuid)
from public, anon, authenticated, service_role;

create function private.developer_room_summary()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'total', count(*)::integer,
    'active', count(*) filter (where room.active)::integer,
    'inactive', count(*) filter (where not room.active)::integer
  )
  from public.rooms room
$$;

create function private.developer_room_type_item(p_room_type_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', room_type.id,
    'code', room_type.code,
    'displayName', room_type.name,
    'baseOccupancy', room_type.default_guest_count,
    'maxOccupancy', room_type.max_guest_count,
    'active', room_type.active,
    'version', room_type.version,
    'roomCount', count(room.id)::integer
  )
  from public.room_types room_type
  left join public.rooms room on room.room_type_id = room_type.id
  where room_type.id = p_room_type_id
  group by room_type.id
$$;

create function private.developer_room_item(p_room_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', room.id,
    'roomNumber', room.room_number,
    'roomTypeId', room.room_type_id,
    'roomTypeCode', room_type.code,
    'active', room.active,
    'version', room.state_version
  )
  from public.rooms room
  join public.room_types room_type on room_type.id = room.room_type_id
  where room.id = p_room_id
$$;

revoke all on function private.developer_room_summary() from public, anon, authenticated, service_role;
revoke all on function private.developer_room_type_item(uuid) from public, anon, authenticated, service_role;
revoke all on function private.developer_room_item(uuid) from public, anon, authenticated, service_role;

drop function public.list_room_type_catalog(uuid, uuid);

create function public.list_room_type_catalog(
  p_actor_profile_id uuid,
  p_session_id uuid
)
returns table (
  id uuid,
  code text,
  display_name text,
  base_cleaning_fee integer,
  base_occupancy integer,
  max_occupancy integer,
  active boolean,
  version bigint,
  room_count integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_attempt_actor_session(
    p_actor_profile_id,
    p_session_id,
    true
  );

  return query
  select
    room_type.id,
    room_type.code,
    room_type.name,
    room_type.base_cleaning_fee,
    room_type.default_guest_count,
    room_type.max_guest_count,
    room_type.active,
    room_type.version,
    count(room.id)::integer
  from public.room_types room_type
  left join public.rooms room on room.room_type_id = room_type.id
  group by room_type.id
  order by room_type.code;
end;
$$;

revoke all on function public.list_room_type_catalog(uuid, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.list_room_type_catalog(uuid, uuid) to service_role;

create function public.get_developer_room_catalog(p_actor_profile_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_generated_at timestamptz := clock_timestamp();
  v_room_types jsonb;
  v_rooms jsonb;
begin
  perform private.assert_active_developer(p_actor_profile_id);

  select coalesce(jsonb_agg(private.developer_room_type_item(room_type.id)
    order by room_type.code), '[]'::jsonb)
  into v_room_types
  from public.room_types room_type;

  select coalesce(jsonb_agg(private.developer_room_item(room.id)
    order by room.room_number, room.id), '[]'::jsonb)
  into v_rooms
  from public.rooms room;

  return jsonb_build_object(
    'generatedAt', v_generated_at,
    'summary', private.developer_room_summary(),
    'roomTypes', v_room_types,
    'rooms', v_rooms
  );
end;
$$;

revoke all on function public.get_developer_room_catalog(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.get_developer_room_catalog(uuid) to service_role;

create function private.developer_capacity_impact(
  p_room_type_id uuid,
  p_max_occupancy integer,
  p_at timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_room_count integer;
  v_active_reservation_count integer;
  v_exceeding_reservation_count integer;
begin
  select count(*)::integer into v_room_count
  from public.rooms room
  where room.room_type_id = p_room_type_id;

  select
    count(distinct reservation.id)::integer,
    count(distinct reservation.id) filter (
      where reservation.guest_count > p_max_occupancy
    )::integer
  into v_active_reservation_count, v_exceeding_reservation_count
  from private.stay_room_segments segment
  join private.reservation_stays stay on stay.id = segment.stay_id
  join public.reservations reservation on reservation.id = stay.reservation_id
  join public.rooms room on room.id = segment.room_id
  where segment.retired_at is null
    and stay.status in ('scheduled', 'active')
    and reservation.status = 'active'
    and (segment.ends_at is null or segment.ends_at > p_at)
    and room.room_type_id = p_room_type_id;

  return jsonb_build_object(
    'roomCount', coalesce(v_room_count, 0),
    'activeReservationCount', coalesce(v_active_reservation_count, 0),
    'exceedingActiveReservationCount', coalesce(v_exceeding_reservation_count, 0),
    'reasonCodes', case
      when coalesce(v_exceeding_reservation_count, 0) > 0
        then jsonb_build_array('ROOM_TYPE_CAPACITY_ACTIVE_RESERVATION_CONFLICT')
      else '[]'::jsonb
    end
  );
end;
$$;

revoke all on function private.developer_capacity_impact(uuid, integer, timestamptz)
from public, anon, authenticated, service_role;

create function public.preview_developer_room_type_capacity(
  p_actor_profile_id uuid,
  p_room_type_id uuid,
  p_base_occupancy integer,
  p_max_occupancy integer,
  p_expected_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room_type public.room_types;
  v_evaluated_at timestamptz := clock_timestamp();
  v_expires_at timestamptz := v_evaluated_at + interval '5 minutes';
  v_impact jsonb;
  v_fingerprint text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  perform private.assert_active_developer(p_actor_profile_id);
  if p_base_occupancy is null or p_max_occupancy is null
    or p_base_occupancy < 1 or p_max_occupancy < 1
    or p_base_occupancy > p_max_occupancy then
    raise exception using errcode = '22023', message = 'ROOM_TYPE_CAPACITY_INVALID';
  end if;

  select * into v_room_type from public.room_types
  where id = p_room_type_id;
  if v_room_type.id is null then
    raise exception using errcode = 'P0002', message = 'ROOM_TYPE_NOT_FOUND';
  end if;
  if v_room_type.version <> p_expected_version then
    raise exception using errcode = '40001', message = 'ROOM_TYPE_VERSION_CONFLICT';
  end if;

  v_impact := private.developer_capacity_impact(
    p_room_type_id,
    p_max_occupancy,
    v_evaluated_at
  );

  insert into private.developer_catalog_previews(
    actor_profile_id, preview_kind, entity_id, expected_version,
    request_payload, impact_payload, impact_fingerprint, evaluated_at, expires_at
  ) values (
    p_actor_profile_id, 'room_type_capacity', p_room_type_id, p_expected_version,
    jsonb_build_object(
      'baseOccupancy', p_base_occupancy,
      'maxOccupancy', p_max_occupancy
    ),
    v_impact, v_fingerprint, v_evaluated_at, v_expires_at
  );

  return jsonb_build_object(
    'roomTypeId', v_room_type.id,
    'current', jsonb_build_object(
      'baseOccupancy', v_room_type.default_guest_count,
      'maxOccupancy', v_room_type.max_guest_count,
      'version', v_room_type.version
    ),
    'proposed', jsonb_build_object(
      'baseOccupancy', p_base_occupancy,
      'maxOccupancy', p_max_occupancy
    )
  ) || v_impact || jsonb_build_object(
    'impactFingerprint', v_fingerprint,
    'evaluatedAt', v_evaluated_at,
    'expiresAt', v_expires_at
  );
end;
$$;

revoke all on function public.preview_developer_room_type_capacity(
  uuid, uuid, integer, integer, bigint
) from public, anon, authenticated, service_role;
grant execute on function public.preview_developer_room_type_capacity(
  uuid, uuid, integer, integer, bigint
) to service_role;

create function public.change_developer_room_type_capacity(
  p_actor_profile_id uuid,
  p_room_type_id uuid,
  p_base_occupancy integer,
  p_max_occupancy integer,
  p_expected_version bigint,
  p_impact_fingerprint text,
  p_reason_code text,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_preview private.developer_catalog_previews;
  v_room_type public.room_types;
  v_before jsonb;
  v_fresh_impact jsonb;
  v_response jsonb;
  v_now timestamptz := clock_timestamp();
begin
  perform private.assert_active_developer(p_actor_profile_id);
  v_response := private.replay_command(
    p_actor_profile_id,
    'developer.room_type.capacity.change',
    p_idempotency_key,
    p_request_hash
  );
  if v_response is not null then return v_response; end if;

  if p_base_occupancy is null or p_max_occupancy is null
    or p_base_occupancy < 1 or p_max_occupancy < 1
    or p_base_occupancy > p_max_occupancy then
    raise exception using errcode = '22023', message = 'ROOM_TYPE_CAPACITY_INVALID';
  end if;
  if p_impact_fingerprint is null or p_impact_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'ROOM_TYPE_CAPACITY_PREVIEW_STALE';
  end if;
  if p_reason_code <> 'CAPACITY_POLICY_CHANGE' then
    raise exception using errcode = '22023', message = 'INVALID_REASON_CODE';
  end if;

  select * into v_preview
  from private.developer_catalog_previews preview
  where preview.impact_fingerprint = p_impact_fingerprint
  for update;
  if v_preview.id is null
    or v_preview.actor_profile_id <> p_actor_profile_id
    or v_preview.preview_kind <> 'room_type_capacity'
    or v_preview.entity_id <> p_room_type_id
    or v_preview.expected_version <> p_expected_version
    or v_preview.request_payload <> jsonb_build_object(
      'baseOccupancy', p_base_occupancy,
      'maxOccupancy', p_max_occupancy
    )
    or v_preview.expires_at <= v_now
    or v_preview.consumed_at is not null then
    raise exception using errcode = '40001', message = 'ROOM_TYPE_CAPACITY_PREVIEW_STALE';
  end if;

  select * into v_room_type
  from public.room_types room_type
  where room_type.id = p_room_type_id
  for update;
  if v_room_type.id is null then
    raise exception using errcode = 'P0002', message = 'ROOM_TYPE_NOT_FOUND';
  end if;
  if v_room_type.version <> p_expected_version then
    raise exception using errcode = '40001', message = 'ROOM_TYPE_VERSION_CONFLICT';
  end if;

  v_fresh_impact := private.developer_capacity_impact(
    p_room_type_id,
    p_max_occupancy,
    v_now
  );
  if v_fresh_impact <> v_preview.impact_payload then
    raise exception using errcode = '40001', message = 'ROOM_TYPE_CAPACITY_PREVIEW_STALE';
  end if;
  if (v_fresh_impact ->> 'exceedingActiveReservationCount')::integer > 0 then
    raise exception using errcode = '23514',
      message = 'ROOM_TYPE_CAPACITY_ACTIVE_RESERVATION_CONFLICT';
  end if;

  v_before := private.developer_room_type_item(v_room_type.id);
  update public.room_types
  set default_guest_count = p_base_occupancy,
      max_guest_count = p_max_occupancy
  where id = v_room_type.id
  returning * into v_room_type;

  update private.developer_catalog_previews
  set consumed_at = v_now
  where id = v_preview.id;

  v_response := jsonb_build_object(
    'roomType', private.developer_room_type_item(v_room_type.id),
    'effectiveAt', v_now
  );

  insert into public.audit_events(
    actor_profile_id, actor_display_name_snapshot, event_type, entity_type,
    entity_id, effective_at, reason_code, before_state, after_state,
    request_hash, idempotency_key
  )
  select profile.id, profile.display_name, 'room_type.capacity_changed', 'room_type',
    v_room_type.id, v_now, p_reason_code, v_before,
    private.developer_room_type_item(v_room_type.id), p_request_hash,
    private.audit_command_key(
      p_actor_profile_id,
      'developer.room_type.capacity.change',
      p_idempotency_key
    )
  from public.profiles profile
  where profile.id = p_actor_profile_id;

  perform private.complete_command(
    p_actor_profile_id,
    'developer.room_type.capacity.change',
    p_idempotency_key,
    p_request_hash,
    v_room_type.id,
    v_response
  );
  return v_response;
end;
$$;

revoke all on function public.change_developer_room_type_capacity(
  uuid, uuid, integer, integer, bigint, text, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.change_developer_room_type_capacity(
  uuid, uuid, integer, integer, bigint, text, text, text, text
) to service_role;

create function public.create_developer_room(
  p_actor_profile_id uuid,
  p_room_id uuid,
  p_room_number text,
  p_room_type_id uuid,
  p_expected_room_type_version bigint,
  p_reason_code text,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room_type public.room_types;
  v_room public.rooms;
  v_response jsonb;
  v_room_number text := btrim(p_room_number);
  v_now timestamptz := clock_timestamp();
begin
  perform private.assert_active_developer(p_actor_profile_id);
  v_response := private.replay_command(
    p_actor_profile_id,
    'developer.room.create',
    p_idempotency_key,
    p_request_hash
  );
  if v_response is not null then return v_response; end if;

  if v_room_number is null or v_room_number !~ '^[0-9]{1,20}$' then
    raise exception using errcode = '22023', message = 'INVALID_ROOM_NUMBER';
  end if;
  if p_reason_code <> 'ROOM_CATALOG_ADD' then
    raise exception using errcode = '22023', message = 'INVALID_REASON_CODE';
  end if;

  select * into v_room_type
  from public.room_types room_type
  where room_type.id = p_room_type_id
  for key share;
  if v_room_type.id is null then
    raise exception using errcode = 'P0002', message = 'ROOM_TYPE_NOT_FOUND';
  end if;
  if v_room_type.version <> p_expected_room_type_version then
    raise exception using errcode = '40001', message = 'ROOM_TYPE_VERSION_CONFLICT';
  end if;
  if not v_room_type.active then
    raise exception using errcode = '23514', message = 'ROOM_TYPE_INACTIVE';
  end if;
  if exists(select 1 from public.rooms room where room.room_number = v_room_number) then
    raise exception using errcode = '23505', message = 'ROOM_NUMBER_ALREADY_EXISTS';
  end if;

  begin
    insert into public.rooms(
      id, room_number, room_type_id, elevator_zone, data_status, active
    ) values (
      p_room_id, v_room_number, v_room_type.id, null, 'verification_required', true
    ) returning * into v_room;
  exception when unique_violation then
    raise exception using errcode = '23505', message = 'ROOM_NUMBER_ALREADY_EXISTS';
  end;

  v_response := jsonb_build_object(
    'room', private.developer_room_item(v_room.id),
    'summary', private.developer_room_summary(),
    'roomType', private.developer_room_type_item(v_room_type.id),
    'effectiveAt', v_now
  );

  insert into public.audit_events(
    actor_profile_id, actor_display_name_snapshot, event_type, entity_type,
    entity_id, effective_at, reason_code, after_state, request_hash, idempotency_key
  )
  select profile.id, profile.display_name, 'room.catalog_added', 'room',
    v_room.id, v_now, p_reason_code, private.developer_room_item(v_room.id),
    p_request_hash, private.audit_command_key(
      p_actor_profile_id,
      'developer.room.create',
      p_idempotency_key
    )
  from public.profiles profile where profile.id = p_actor_profile_id;

  perform private.complete_command(
    p_actor_profile_id,
    'developer.room.create',
    p_idempotency_key,
    p_request_hash,
    v_room.id,
    v_response
  );
  return v_response;
end;
$$;

revoke all on function public.create_developer_room(
  uuid, uuid, text, uuid, bigint, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.create_developer_room(
  uuid, uuid, text, uuid, bigint, text, text, text
) to service_role;

create function private.developer_room_deactivation_impact(
  p_room_id uuid,
  p_at timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_current_occupancy boolean;
  v_reservation_count integer;
  v_target_count integer;
  v_assignment_count integer;
  v_attempt_count integer;
  v_pin_lease boolean;
  v_issue_count integer;
  v_reason_codes jsonb := '[]'::jsonb;
begin
  select exists(
    select 1
    from private.stay_room_segments segment
    join private.reservation_stays stay on stay.id = segment.stay_id
    join public.reservations reservation on reservation.id = stay.reservation_id
    where segment.room_id = p_room_id
      and segment.retired_at is null
      and stay.status = 'active'
      and reservation.actual_check_in_at is not null
      and reservation.actual_checkout_at is null
      and segment.starts_at <= p_at
      and (segment.ends_at is null or segment.ends_at > p_at)
  ) into v_current_occupancy;

  select count(distinct reservation.id)::integer
  into v_reservation_count
  from private.stay_room_segments segment
  join private.reservation_stays stay on stay.id = segment.stay_id
  join public.reservations reservation on reservation.id = stay.reservation_id
  where segment.room_id = p_room_id
    and segment.retired_at is null
    and stay.status in ('scheduled', 'active')
    and reservation.status = 'active'
    and (segment.ends_at is null or segment.ends_at > p_at);

  select count(*)::integer into v_target_count
  from public.cleaning_targets target
  where target.room_id = p_room_id
    and target.status not in ('approved', 'rejected', 'cancelled');

  select count(*)::integer into v_assignment_count
  from public.cleaning_assignments assignment
  join public.cleaning_targets target on target.id = assignment.cleaning_target_id
  where target.room_id = p_room_id
    and assignment.is_current
    and assignment.ended_at is null
    and target.status not in ('approved', 'rejected', 'cancelled');

  select count(*)::integer into v_attempt_count
  from public.cleaning_attempts attempt
  join public.cleaning_targets target on target.id = attempt.cleaning_target_id
  where target.room_id = p_room_id
    and attempt.status in ('scheduled', 'in_progress', 'field_completed', 'upload_pending', 'submitted');

  select exists(
    select 1 from private.room_pin_change_leases lease
    where lease.room_id = p_room_id
      and lease.status in ('prepared', 'expired')
  ) into v_pin_lease;

  select (
    (select count(*) from public.room_operation_blocks block
      where block.room_id = p_room_id and block.released_at is null)
    +
    (select count(*) from public.room_issues issue
      where issue.room_id = p_room_id and issue.status = 'open')
  )::integer into v_issue_count;

  if v_current_occupancy then
    v_reason_codes := v_reason_codes || jsonb_build_array('ROOM_CURRENTLY_OCCUPIED');
  end if;
  if coalesce(v_reservation_count, 0) > 0 then
    v_reason_codes := v_reason_codes || jsonb_build_array('ROOM_ACTIVE_OR_FUTURE_RESERVATION_EXISTS');
  end if;
  if coalesce(v_target_count, 0) > 0
    or coalesce(v_assignment_count, 0) > 0
    or coalesce(v_attempt_count, 0) > 0 then
    v_reason_codes := v_reason_codes || jsonb_build_array('ROOM_CLEANING_WORKFLOW_ACTIVE');
  end if;
  if v_pin_lease then
    v_reason_codes := v_reason_codes || jsonb_build_array('ROOM_PIN_CHANGE_ACTIVE');
  end if;
  if coalesce(v_issue_count, 0) > 0 then
    v_reason_codes := v_reason_codes || jsonb_build_array('ROOM_OPERATION_UNRESOLVED');
  end if;

  return jsonb_build_object(
    'currentlyOccupied', v_current_occupancy,
    'activeFutureReservationCount', coalesce(v_reservation_count, 0),
    'activeCleaningTargetCount', coalesce(v_target_count, 0),
    'activeAssignmentCount', coalesce(v_assignment_count, 0),
    'activeAttemptCount', coalesce(v_attempt_count, 0),
    'activePinChangeLease', v_pin_lease,
    'unresolvedOperationCount', coalesce(v_issue_count, 0),
    'canDeactivate', jsonb_array_length(v_reason_codes) = 0,
    'reasonCodes', v_reason_codes
  );
end;
$$;

revoke all on function private.developer_room_deactivation_impact(uuid, timestamptz)
from public, anon, authenticated, service_role;

create function public.preview_developer_room_deactivation(
  p_actor_profile_id uuid,
  p_room_id uuid,
  p_expected_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room public.rooms;
  v_evaluated_at timestamptz := clock_timestamp();
  v_expires_at timestamptz := v_evaluated_at + interval '5 minutes';
  v_impact jsonb;
  v_fingerprint text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  perform private.assert_active_developer(p_actor_profile_id);
  select * into v_room from public.rooms where id = p_room_id;
  if v_room.id is null then
    raise exception using errcode = 'P0002', message = 'ROOM_NOT_FOUND';
  end if;
  if v_room.state_version <> p_expected_version then
    raise exception using errcode = '40001', message = 'ROOM_VERSION_CONFLICT';
  end if;
  if not v_room.active then
    raise exception using errcode = '23514', message = 'ROOM_ALREADY_INACTIVE';
  end if;

  v_impact := private.developer_room_deactivation_impact(p_room_id, v_evaluated_at);
  insert into private.developer_catalog_previews(
    actor_profile_id, preview_kind, entity_id, expected_version,
    request_payload, impact_payload, impact_fingerprint, evaluated_at, expires_at
  ) values (
    p_actor_profile_id, 'room_deactivation', p_room_id, p_expected_version,
    '{}'::jsonb, v_impact, v_fingerprint, v_evaluated_at, v_expires_at
  );

  return jsonb_build_object('roomId', p_room_id)
    || v_impact
    || jsonb_build_object(
      'impactFingerprint', v_fingerprint,
      'evaluatedAt', v_evaluated_at,
      'expiresAt', v_expires_at
    );
end;
$$;

revoke all on function public.preview_developer_room_deactivation(uuid, uuid, bigint)
from public, anon, authenticated, service_role;
grant execute on function public.preview_developer_room_deactivation(uuid, uuid, bigint)
to service_role;

create function public.deactivate_developer_room(
  p_actor_profile_id uuid,
  p_room_id uuid,
  p_expected_version bigint,
  p_impact_fingerprint text,
  p_reason_code text,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_preview private.developer_catalog_previews;
  v_room public.rooms;
  v_before jsonb;
  v_fresh_impact jsonb;
  v_response jsonb;
  v_now timestamptz := clock_timestamp();
begin
  perform private.assert_active_developer(p_actor_profile_id);
  v_response := private.replay_command(
    p_actor_profile_id,
    'developer.room.deactivate',
    p_idempotency_key,
    p_request_hash
  );
  if v_response is not null then return v_response; end if;

  if p_impact_fingerprint is null or p_impact_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'ROOM_DEACTIVATION_PREVIEW_STALE';
  end if;
  if p_reason_code <> 'ROOM_CATALOG_REMOVE' then
    raise exception using errcode = '22023', message = 'INVALID_REASON_CODE';
  end if;

  select * into v_preview
  from private.developer_catalog_previews preview
  where preview.impact_fingerprint = p_impact_fingerprint
  for update;
  if v_preview.id is null
    or v_preview.actor_profile_id <> p_actor_profile_id
    or v_preview.preview_kind <> 'room_deactivation'
    or v_preview.entity_id <> p_room_id
    or v_preview.expected_version <> p_expected_version
    or v_preview.expires_at <= v_now
    or v_preview.consumed_at is not null then
    raise exception using errcode = '40001', message = 'ROOM_DEACTIVATION_PREVIEW_STALE';
  end if;

  select * into v_room
  from public.rooms room
  where room.id = p_room_id
  for update;
  if v_room.id is null then
    raise exception using errcode = 'P0002', message = 'ROOM_NOT_FOUND';
  end if;
  if v_room.state_version <> p_expected_version then
    raise exception using errcode = '40001', message = 'ROOM_VERSION_CONFLICT';
  end if;
  if not v_room.active then
    raise exception using errcode = '23514', message = 'ROOM_ALREADY_INACTIVE';
  end if;

  v_fresh_impact := private.developer_room_deactivation_impact(p_room_id, v_now);
  if v_fresh_impact <> v_preview.impact_payload then
    raise exception using errcode = '40001', message = 'ROOM_DEACTIVATION_PREVIEW_STALE';
  end if;
  if not (v_fresh_impact ->> 'canDeactivate')::boolean then
    raise exception using errcode = '23514', message = 'ROOM_DEACTIVATION_BLOCKED',
      detail = (v_fresh_impact -> 'reasonCodes')::text;
  end if;

  v_before := private.developer_room_item(v_room.id);
  update public.rooms
  set active = false,
      deactivated_at = v_now,
      deactivated_by = p_actor_profile_id,
      deactivation_reason_code = p_reason_code,
      state_version = state_version + 1
  where id = v_room.id
  returning * into v_room;

  update private.developer_catalog_previews
  set consumed_at = v_now
  where id = v_preview.id;

  v_response := jsonb_build_object(
    'room', private.developer_room_item(v_room.id),
    'summary', private.developer_room_summary(),
    'effectiveAt', v_now
  );

  insert into public.audit_events(
    actor_profile_id, actor_display_name_snapshot, event_type, entity_type,
    entity_id, effective_at, reason_code, before_state, after_state,
    request_hash, idempotency_key
  )
  select profile.id, profile.display_name, 'room.catalog_deactivated', 'room',
    v_room.id, v_now, p_reason_code, v_before,
    private.developer_room_item(v_room.id), p_request_hash,
    private.audit_command_key(
      p_actor_profile_id,
      'developer.room.deactivate',
      p_idempotency_key
    )
  from public.profiles profile where profile.id = p_actor_profile_id;

  perform private.complete_command(
    p_actor_profile_id,
    'developer.room.deactivate',
    p_idempotency_key,
    p_request_hash,
    v_room.id,
    v_response
  );
  return v_response;
end;
$$;

revoke all on function public.deactivate_developer_room(
  uuid, uuid, bigint, text, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.deactivate_developer_room(
  uuid, uuid, bigint, text, text, text, text
) to service_role;

create function private.enforce_reservation_room_catalog()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room_active boolean;
  v_room_type_active boolean;
  v_max_occupancy integer;
begin
  select room.active, room_type.active, room_type.max_guest_count
  into v_room_active, v_room_type_active, v_max_occupancy
  from public.rooms room
  join public.room_types room_type on room_type.id = room.room_type_id
  where room.id = new.room_id
  for key share of room, room_type;

  if not found then
    raise exception using errcode = 'P0002', message = 'ROOM_NOT_FOUND';
  end if;
  if not v_room_active or not v_room_type_active then
    raise exception using errcode = '23514', message = 'ROOM_INACTIVE';
  end if;
  if new.guest_count > v_max_occupancy then
    raise exception using errcode = '23514',
      message = 'GUEST_COUNT_EXCEEDS_ROOM_TYPE_CAPACITY';
  end if;
  return new;
end;
$$;

create trigger reservations_enforce_room_catalog
before insert or update of room_id, guest_count on public.reservations
for each row execute function private.enforce_reservation_room_catalog();

create function private.enforce_stay_segment_room_capacity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_guest_count integer;
  v_room_active boolean;
  v_room_type_active boolean;
  v_max_occupancy integer;
begin
  select reservation.guest_count
  into v_guest_count
  from public.reservations reservation
  where reservation.id = new.source_reservation_id;

  select room.active, room_type.active, room_type.max_guest_count
  into v_room_active, v_room_type_active, v_max_occupancy
  from public.rooms room
  join public.room_types room_type on room_type.id = room.room_type_id
  where room.id = new.room_id
  for key share of room, room_type;

  if not found or not v_room_active or not v_room_type_active then
    raise exception using errcode = '23514', message = 'ROOM_INACTIVE';
  end if;
  if v_guest_count > v_max_occupancy then
    raise exception using errcode = '23514',
      message = 'GUEST_COUNT_EXCEEDS_ROOM_TYPE_CAPACITY';
  end if;
  return new;
end;
$$;

create trigger stay_room_segments_enforce_capacity
before insert on private.stay_room_segments
for each row execute function private.enforce_stay_segment_room_capacity();

create function private.enforce_cleaning_target_active_room()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_active boolean;
begin
  select room.active into v_active
  from public.rooms room
  where room.id = new.room_id
  for key share;
  if not found or not v_active then
    raise exception using errcode = '23514', message = 'ROOM_INACTIVE';
  end if;
  return new;
end;
$$;

create trigger cleaning_targets_require_active_room
before insert on public.cleaning_targets
for each row execute function private.enforce_cleaning_target_active_room();

revoke all on function private.enforce_reservation_room_catalog()
from public, anon, authenticated, service_role;
revoke all on function private.enforce_stay_segment_room_capacity()
from public, anon, authenticated, service_role;
revoke all on function private.enforce_cleaning_target_active_room()
from public, anon, authenticated, service_role;

create or replace function private.room_block_reason_codes(
  p_room_id uuid,
  p_at timestamptz,
  p_include_occupancy boolean default true,
  p_include_cleaning boolean default true,
  p_preparation_reservation_id uuid default null
)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_reasons text[] := array[]::text[];
  v_room public.rooms;
  v_pin_status text;
begin
  select * into v_room from public.rooms where id = p_room_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'ROOM_NOT_FOUND';
  end if;
  if not v_room.active then
    v_reasons := array_append(v_reasons, 'ROOM_INACTIVE');
  end if;
  if p_include_occupancy and exists(
    select 1 from private.stay_room_segments segment
    join private.reservation_stays stay on stay.id = segment.stay_id
    join public.reservations reservation on reservation.id = stay.reservation_id
    where segment.room_id = p_room_id and segment.retired_at is null and stay.status = 'active'
      and segment.starts_at <= p_at and (segment.ends_at > p_at or (
        reservation.actual_check_in_at is not null and reservation.actual_checkout_at is null
        and segment.room_id = private.reservation_final_room_id(reservation.id)))
  ) then v_reasons := array_append(v_reasons, 'OCCUPIED'); end if;
  if p_include_occupancy and p_preparation_reservation_id is null
    and private.room_reservation_phase_at(p_room_id, p_at) = 'current'
    then v_reasons := array_append(v_reasons, 'RESERVATION_CURRENT'); end if;
  if p_include_cleaning and ((p_preparation_reservation_id is not null and exists(
      select 1 from public.preparation_obligations obligation
      join public.reservations reservation on reservation.id = obligation.reservation_id
      where obligation.room_id = p_room_id and obligation.reservation_id = p_preparation_reservation_id
        and reservation.status = 'active' and obligation.status <> 'approved'
    )) or (p_preparation_reservation_id is null
      and private.room_current_cleaning_required_at(p_room_id, p_at)))
    then v_reasons := array_append(v_reasons, 'CLEANING_REQUIRED'); end if;
  if private.current_candle_count(p_room_id) > 0 then
    v_reasons := array_append(v_reasons, 'CANDLE_PRESENT');
  end if;
  if exists(select 1 from public.room_operation_blocks block where block.room_id = p_room_id
    and block.released_at is null and block.starts_at <= p_at
    and (block.ends_at is null or block.ends_at > p_at)) then
    v_reasons := array_append(v_reasons, 'OPERATION_BLOCKED');
  end if;
  if exists(select 1 from public.room_issues issue where issue.room_id = p_room_id
    and issue.status = 'open' and issue.blocks_guest_assignment) then
    v_reasons := array_append(v_reasons, 'ROOM_ISSUE_BLOCKED');
  end if;
  if p_preparation_reservation_id is not null then
    v_pin_status := private.current_pin_sync_status(p_room_id);
    if v_pin_status = 'mismatch' then
      v_reasons := array_append(v_reasons, 'PIN_MISMATCH');
    elsif v_pin_status = 'unconfigured' then
      v_reasons := array_append(v_reasons, 'DATA_UNCONFIRMED');
    end if;
    if exists(select 1 from public.checkout_presence_incidents incident
      where incident.room_id = p_room_id and incident.status = 'open') then
      v_reasons := array_append(v_reasons, 'CHECKOUT_NOT_COMPLETED');
    end if;
  end if;
  if v_room.data_status <> 'verified' and not ('DATA_UNCONFIRMED' = any(v_reasons)) then
    v_reasons := array_append(v_reasons, 'DATA_UNCONFIRMED');
  end if;
  return v_reasons;
end;
$$;

revoke all on function private.room_block_reason_codes(
  uuid, timestamptz, boolean, boolean, uuid
) from public, anon, authenticated, service_role;

drop function public.preview_reservation_bookability(
  uuid, timestamptz, timestamptz, uuid, uuid[], text
);

create function public.preview_reservation_bookability(
  p_actor_profile_id uuid,
  p_check_in_at timestamptz,
  p_check_out_at timestamptz,
  p_guest_count integer,
  p_exclude_reservation_id uuid default null,
  p_room_type_ids uuid[] default null,
  p_reservation_type text default 'standard'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_evaluated_at timestamptz := clock_timestamp();
  v_excluded public.reservations;
  v_candidates jsonb;
  v_room_type_ids uuid[] := nullif(p_room_type_ids, array[]::uuid[]);
begin
  perform private.assert_room_admin(p_actor_profile_id);
  if p_reservation_type not in ('standard', 'long_stay') then
    raise exception using errcode = '22023', message = 'UNSUPPORTED_RESERVATION_TYPE';
  end if;
  if p_guest_count is null or p_guest_count < 1 then
    raise exception using errcode = '22023', message = 'INVALID_GUEST_COUNT';
  end if;
  if p_check_in_at is null or not isfinite(p_check_in_at)
    or p_check_in_at <> date_trunc('minute', p_check_in_at)
    or (p_reservation_type = 'standard' and p_check_out_at is null)
    or (p_check_out_at is not null and (
      not isfinite(p_check_out_at) or p_check_out_at <= p_check_in_at
      or (p_check_out_at at time zone 'Asia/Seoul')::date
        <= (p_check_in_at at time zone 'Asia/Seoul')::date
      or p_check_out_at <> date_trunc('minute', p_check_out_at))) then
    raise exception using errcode = '22023', message = 'INVALID_RESERVATION_SCHEDULE';
  end if;
  if p_check_out_at is not null and p_check_out_at - p_check_in_at > interval '366 days' then
    raise exception using errcode = '22023', message = 'BOOKABILITY_RANGE_TOO_LARGE';
  end if;
  if v_room_type_ids is not null and cardinality(v_room_type_ids) > 20 then
    raise exception using errcode = '22023', message = 'INVALID_ROOM_TYPE_FILTER';
  end if;
  if v_room_type_ids is not null and (
    (select count(distinct value) from unnest(v_room_type_ids) value) <> cardinality(v_room_type_ids)
    or exists(select 1 from unnest(v_room_type_ids) value where not exists(
      select 1 from public.room_types room_type where room_type.id = value
    ))
  ) then
    raise exception using errcode = '22023', message = 'INVALID_ROOM_TYPE_FILTER';
  end if;
  if p_exclude_reservation_id is not null then
    select * into v_excluded from public.reservations where id = p_exclude_reservation_id;
    if v_excluded.id is null then
      raise exception using errcode = 'P0002', message = 'EXCLUDE_RESERVATION_NOT_FOUND';
    end if;
    if v_excluded.status <> 'active' or v_excluded.actual_check_in_at is not null
      or v_excluded.actual_checkout_at is not null or v_excluded.cancelled_at is not null then
      raise exception using errcode = '23514', message = 'EXCLUDE_RESERVATION_NOT_ELIGIBLE';
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'room_id', candidate.room_id,
    'room_number', candidate.room_number,
    'room_type_id', candidate.room_type_id,
    'room_state_version', candidate.room_state_version,
    'interval_bookable', candidate.interval_bookable,
    'check_in_ready', candidate.check_in_ready,
    'reason_codes', candidate.reason_codes,
    'evaluated_at', v_evaluated_at
  ) order by candidate.room_number, candidate.room_id), '[]'::jsonb)
  into v_candidates
  from (
    select room.id room_id, room.room_number, room.room_type_id,
      room.state_version room_state_version,
      not state.overlap_found and cardinality(state.interval_reasons) = 0 interval_bookable,
      readiness.readiness_status = 'READY' check_in_ready,
      combined.reason_codes
    from public.rooms room
    join public.room_types room_type on room_type.id = room.room_type_id
    cross join lateral (
      select exists(
        select 1 from private.stay_room_segments segment
        join private.reservation_stays stay on stay.id = segment.stay_id
        where segment.room_id = room.id and segment.retired_at is null
          and stay.status in ('scheduled', 'active')
          and segment.source_reservation_id is distinct from p_exclude_reservation_id
          and tstzrange(segment.starts_at, segment.ends_at, '[)')
            && tstzrange(p_check_in_at, p_check_out_at, '[)')
      ) overlap_found,
      private.room_block_reason_codes(room.id, v_evaluated_at, false, false)
        || case when exists(
          select 1 from public.room_operation_blocks block
          where block.room_id = room.id and block.released_at is null
            and (p_check_out_at is null or block.starts_at < p_check_out_at)
            and (block.ends_at is null or block.ends_at > p_check_in_at)
        ) and not ('OPERATION_BLOCKED' = any(private.room_block_reason_codes(
          room.id, v_evaluated_at, false, false
        ))) then array['OPERATION_BLOCKED']::text[] else array[]::text[] end
        || case when p_guest_count > room_type.max_guest_count
          then array['GUEST_COUNT_EXCEEDS_ROOM_TYPE_CAPACITY']::text[]
          else array[]::text[] end interval_reasons,
      private.room_block_reason_codes(room.id, v_evaluated_at, true, true)
        readiness_base_reasons,
      private.current_pin_sync_status(room.id) pin_status
    ) state
    cross join lateral private.room_reservation_lifecycle_at(room.id, v_evaluated_at) lifecycle
    cross join lateral private.room_readiness_axes_at(
      state.readiness_base_reasons,
      state.pin_status,
      lifecycle.current_checkin_pending
    ) readiness
    cross join lateral (
      select coalesce(array_agg(item.reason order by item.first_ordinal), array[]::text[]) reason_codes
      from (
        select reason, min(ordinal) first_ordinal
        from unnest(
          case when state.overlap_found then array['RESERVATION_OVERLAP']::text[]
            else array[]::text[] end
          || state.interval_reasons
          || readiness.readiness_reason_codes
        ) with ordinality reasons(reason, ordinal)
        group by reason
      ) item
    ) combined
    where room.active and room_type.active
      and (v_room_type_ids is null or room.room_type_id = any(v_room_type_ids))
  ) candidate;

  return jsonb_build_object(
    'evaluated_at', v_evaluated_at,
    'guest_count', p_guest_count,
    'candidates', v_candidates
  );
end;
$$;

revoke all on function public.preview_reservation_bookability(
  uuid, timestamptz, timestamptz, integer, uuid, uuid[], text
) from public, anon, authenticated, service_role;
grant execute on function public.preview_reservation_bookability(
  uuid, timestamptz, timestamptz, integer, uuid, uuid[], text
) to service_role;

comment on function public.preview_reservation_bookability(
  uuid, timestamptz, timestamptz, integer, uuid, uuid[], text
) is
  'Admin-only reservation preview. guest_count is checked against the latest room-type maximum without changing current readiness semantics.';
