-- Issue #228: keep physical occupancy, room-problem blocking, display
-- classification, and overall allocation readiness as independent axes.
-- Administrative corrections are explicit append-only commands.

create table private.room_occupancy_corrections (
  id uuid primary key default gen_random_uuid(),
  command_key text not null unique,
  room_id uuid not null references public.rooms(id) on delete restrict,
  reservation_id uuid not null references public.reservations(id) on delete restrict,
  stay_id uuid not null references private.reservation_stays(id) on delete restrict,
  replaced_segment_id uuid references private.stay_room_segments(id) on delete restrict,
  successor_segment_id uuid references private.stay_room_segments(id) on delete restrict,
  occupied boolean not null,
  effective_at timestamptz not null,
  actor_profile_id uuid not null references public.profiles(id) on delete restrict,
  reason_code text not null check (reason_code ~ '^[A-Z0-9_]{2,80}$'),
  room_state_version bigint not null check (room_state_version > 0),
  request_hash text not null,
  recorded_at timestamptz not null default clock_timestamp(),
  check (isfinite(effective_at))
);

create index room_occupancy_corrections_room_time_idx
  on private.room_occupancy_corrections(room_id, effective_at desc, id desc);
create index room_occupancy_corrections_reservation_idx
  on private.room_occupancy_corrections(reservation_id, recorded_at desc, id desc);
create index room_occupancy_corrections_stay_idx
  on private.room_occupancy_corrections(stay_id);
create index room_occupancy_corrections_replaced_segment_idx
  on private.room_occupancy_corrections(replaced_segment_id);
create index room_occupancy_corrections_successor_segment_idx
  on private.room_occupancy_corrections(successor_segment_id);
create index room_occupancy_corrections_actor_idx
  on private.room_occupancy_corrections(actor_profile_id);

alter table private.room_occupancy_corrections enable row level security;
alter table private.room_occupancy_corrections force row level security;
revoke all on table private.room_occupancy_corrections
  from public, anon, authenticated, service_role;
grant select, insert on table private.room_occupancy_corrections to service_role;

create function private.guard_room_occupancy_correction_history()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = '55000', message = 'ROOM_OCCUPANCY_CORRECTION_IMMUTABLE';
end
$$;
revoke all on function private.guard_room_occupancy_correction_history()
  from public, anon, authenticated, service_role;
create trigger room_occupancy_corrections_immutable
before update or delete on private.room_occupancy_corrections
for each row execute function private.guard_room_occupancy_correction_history();

create table private.room_display_status_overrides (
  id uuid primary key default gen_random_uuid(),
  command_key text not null unique,
  room_id uuid not null references public.rooms(id) on delete restrict,
  target_status text,
  actor_profile_id uuid not null references public.profiles(id) on delete restrict,
  reason_code text not null check (reason_code ~ '^[A-Z0-9_]{2,80}$'),
  room_state_version bigint not null check (room_state_version > 0),
  request_hash text not null,
  recorded_at timestamptz not null default clock_timestamp(),
  check (target_status is null or target_status in (
    'BLOCKED', 'OCCUPIED', 'ARRIVAL_PENDING', 'RESERVATION_PRESENT',
    'CLEANING_REQUIRED', 'READY'
  ))
);

create unique index room_display_status_overrides_room_version_uidx
  on private.room_display_status_overrides(room_id, room_state_version);
create index room_display_status_overrides_room_current_idx
  on private.room_display_status_overrides(room_id, room_state_version desc, id desc);
create index room_display_status_overrides_actor_idx
  on private.room_display_status_overrides(actor_profile_id);

alter table private.room_display_status_overrides enable row level security;
alter table private.room_display_status_overrides force row level security;
revoke all on table private.room_display_status_overrides
  from public, anon, authenticated, service_role;
grant select, insert on table private.room_display_status_overrides to service_role;

create function private.guard_room_display_status_override_history()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = '55000', message = 'ROOM_DISPLAY_STATUS_OVERRIDE_IMMUTABLE';
end
$$;
revoke all on function private.guard_room_display_status_override_history()
  from public, anon, authenticated, service_role;
create trigger room_display_status_overrides_immutable
before update or delete on private.room_display_status_overrides
for each row execute function private.guard_room_display_status_override_history();

create function private.current_room_display_status_override(p_room_id uuid)
returns text language sql stable security definer set search_path = '' as $$
  select override.target_status
  from private.room_display_status_overrides override
  where override.room_id = p_room_id
  order by override.room_state_version desc, override.id desc
  limit 1
$$;
revoke all on function private.current_room_display_status_override(uuid)
  from public, anon, authenticated, service_role;

create or replace function private.room_occupied_at(p_room_id uuid, p_at timestamptz)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from private.stay_room_segments segment
    join private.reservation_stays stay on stay.id = segment.stay_id
    join public.reservations reservation on reservation.id = stay.reservation_id
    where segment.room_id = p_room_id
      and segment.retired_at is null
      and stay.status in ('scheduled', 'active')
      and reservation.status = 'active'
      and reservation.actual_checkout_at is null
      and segment.starts_at <= p_at
      and (segment.ends_at is null or segment.ends_at > p_at)
  )
$$;
revoke all on function private.room_occupied_at(uuid, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function private.room_reservation_lifecycle_at(
  p_room_id uuid, p_at timestamptz
)
returns table(
  reservation_lifecycle text, next_reservation_id uuid,
  next_check_in_at timestamptz, next_check_out_at timestamptz,
  current_checkin_pending boolean
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_current boolean;
  v_next record;
  v_today date := (p_at at time zone 'Asia/Seoul')::date;
begin
  v_current := private.room_occupied_at(p_room_id, p_at);
  select reservation.id, segment.starts_at as segment_start,
    segment.ends_at as segment_end into v_next
  from private.stay_room_segments segment
  join private.reservation_stays stay on stay.id = segment.stay_id
  join public.reservations reservation on reservation.id = stay.reservation_id
  where segment.room_id = p_room_id and segment.retired_at is null
    and stay.status in ('scheduled', 'active') and reservation.status = 'active'
    and reservation.actual_checkout_at is null and segment.starts_at > p_at
  order by segment.starts_at, reservation.id limit 1;
  reservation_lifecycle := case when v_current then 'OCCUPIED'
    when v_next.id is null then 'NONE'
    when (v_next.segment_start at time zone 'Asia/Seoul')::date = v_today
      then 'ARRIVAL_PENDING'
    when (v_next.segment_start at time zone 'Asia/Seoul')::date = v_today + 1
      then 'RESERVATION_PRESENT'
    else 'FUTURE' end;
  next_reservation_id := v_next.id;
  next_check_in_at := v_next.segment_start;
  next_check_out_at := v_next.segment_end;
  current_checkin_pending := exists (
    select 1 from private.stay_room_segments segment
    join private.reservation_stays stay on stay.id = segment.stay_id
    join public.reservations reservation on reservation.id = stay.reservation_id
    where segment.room_id = p_room_id and segment.retired_at is null
      and stay.status = 'scheduled' and reservation.status = 'active'
      and reservation.actual_check_in_at is null
      and segment.starts_at <= p_at
      and (segment.ends_at is null or segment.ends_at > p_at)
  );
  return next;
end
$$;
revoke all on function private.room_reservation_lifecycle_at(uuid, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.correct_room_occupancy(
  p_actor_profile_id uuid,
  p_session_id uuid,
  p_room_id uuid,
  p_reservation_id uuid,
  p_occupied boolean,
  p_effective_at timestamptz,
  p_expected_room_version bigint,
  p_reason_code text,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_room public.rooms;
  v_reservation public.reservations;
  v_stay private.reservation_stays;
  v_segment private.stay_room_segments;
  v_lineage_segment private.stay_room_segments;
  v_successor private.stay_room_segments;
  v_replaced_segment_id uuid;
  v_correction_id uuid := gen_random_uuid();
  v_recorded_at timestamptz := clock_timestamp();
  v_command_key text;
  v_response jsonb;
  v_before_occupied boolean;
begin
  perform private.assert_attempt_actor_session(p_actor_profile_id, p_session_id, true);
  if p_occupied is null or p_effective_at is null or not isfinite(p_effective_at)
    or p_effective_at > v_recorded_at
    or p_reason_code is null or p_reason_code !~ '^[A-Z0-9_]{2,80}$' then
    raise exception using errcode = '22023', message = 'INVALID_OCCUPANCY_CORRECTION';
  end if;

  v_response := private.replay_command(
    p_actor_profile_id, 'room.occupancy_correction', p_idempotency_key, p_request_hash
  );
  if v_response is not null then return v_response; end if;

  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command', 0));
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'ROOM_NOT_FOUND'; end if;
  if v_room.state_version <> p_expected_room_version then
    raise exception using errcode = '40001', message = 'STALE_VERSION';
  end if;

  select * into v_reservation from public.reservations
  where id = p_reservation_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'RESERVATION_NOT_FOUND'; end if;
  if v_reservation.status <> 'active' or v_reservation.actual_checkout_at is not null then
    raise exception using errcode = '23514', message = 'OCCUPANCY_CORRECTION_NOT_ALLOWED';
  end if;
  select * into v_stay from private.reservation_stays
  where reservation_id = p_reservation_id for update;
  if not found or v_stay.status not in ('scheduled', 'active') then
    raise exception using errcode = '23514', message = 'STAY_SEGMENT_CONTRACT_MISMATCH';
  end if;

  select segment.* into v_segment
  from private.stay_room_segments segment
  where segment.stay_id = v_stay.id and segment.room_id = p_room_id
    and segment.retired_at is null and segment.starts_at <= p_effective_at
    and (segment.ends_at is null or segment.ends_at > p_effective_at)
  order by segment.starts_at desc, segment.id desc limit 1 for update;
  v_before_occupied := v_segment.id is not null;

  if p_occupied then
    if v_before_occupied then
      raise exception using errcode = '23514', message = 'OCCUPANCY_CORRECTION_ALREADY_APPLIED';
    end if;
    if v_reservation.check_out_at is not null and p_effective_at >= v_reservation.check_out_at then
      raise exception using errcode = '23514', message = 'OCCUPANCY_CORRECTION_NOT_ALLOWED';
    end if;
    select segment.* into v_lineage_segment
    from private.stay_room_segments segment
    where segment.stay_id = v_stay.id
      and segment.room_id = p_room_id
      and segment.starts_at <= p_effective_at
      and (segment.ends_at is null or segment.ends_at > p_effective_at)
    order by (segment.retired_at is null) desc, segment.version desc,
      segment.created_at desc, segment.id desc
    limit 1 for update;
    if v_lineage_segment.id is null then
      raise exception using errcode = '23514', message = 'OCCUPANCY_CORRECTION_ROOM_MISMATCH';
    end if;
    v_replaced_segment_id := v_lineage_segment.id;
    perform 1
    from private.stay_room_segments segment
    where segment.room_id = p_room_id and segment.stay_id <> v_stay.id
      and segment.retired_at is null
      and tstzrange(segment.starts_at, segment.ends_at, '[)') &&
        tstzrange(p_effective_at, v_lineage_segment.ends_at, '[)')
    order by segment.starts_at, segment.id
    limit 1 for update;
    if found then
      raise exception using errcode = '23514', message = 'ROOM_OCCUPANCY_CONFLICT';
    end if;
    if exists (
      select 1 from private.stay_room_segments segment
      where segment.stay_id = v_stay.id and segment.retired_at is null
        and segment.room_id <> p_room_id
        and tstzrange(segment.starts_at, segment.ends_at, '[)') &&
          tstzrange(p_effective_at, v_lineage_segment.ends_at, '[)')
    ) then
      raise exception using errcode = '23514', message = 'OCCUPANCY_CORRECTION_ROOM_MISMATCH';
    end if;
    insert into private.stay_room_segments(
      stay_id, room_id, starts_at, ends_at, source_reservation_id,
      move_event_id, terminal_reason_code, created_at, updated_at
    ) values (
      v_lineage_segment.stay_id, v_lineage_segment.room_id, p_effective_at,
      v_lineage_segment.ends_at, v_lineage_segment.source_reservation_id,
      v_lineage_segment.move_event_id, 'ADMIN_OCCUPANCY_CORRECTION',
      v_recorded_at, v_recorded_at
    ) returning * into v_successor;
  else
    if not v_before_occupied then
      raise exception using errcode = '23514', message = 'OCCUPANCY_CORRECTION_ALREADY_APPLIED';
    end if;
    v_replaced_segment_id := v_segment.id;
    update private.stay_room_segments
    set retired_at = v_recorded_at,
        terminal_reason_code = 'ADMIN_OCCUPANCY_CORRECTION',
        version = version + 1,
        updated_at = v_recorded_at
    where id = v_segment.id;
    if p_effective_at > v_segment.starts_at then
      insert into private.stay_room_segments(
        stay_id, room_id, starts_at, ends_at, source_reservation_id,
        move_event_id, terminal_reason_code, created_at, updated_at
      ) values (
        v_segment.stay_id, v_segment.room_id, v_segment.starts_at, p_effective_at,
        v_segment.source_reservation_id, v_segment.move_event_id,
        'ADMIN_OCCUPANCY_CORRECTION', v_recorded_at, v_recorded_at
      ) returning * into v_successor;
    end if;
  end if;

  update public.rooms set state_version = state_version + 1
  where id = p_room_id returning * into v_room;
  v_command_key := private.audit_command_key(
    p_actor_profile_id, 'room.occupancy_correction', p_idempotency_key
  );
  insert into private.room_occupancy_corrections(
    id, command_key, room_id, reservation_id, stay_id, replaced_segment_id,
    successor_segment_id, occupied, effective_at, actor_profile_id, reason_code,
    room_state_version, request_hash, recorded_at
  ) values (
    v_correction_id, v_command_key, p_room_id, p_reservation_id, v_stay.id,
    v_replaced_segment_id, v_successor.id, p_occupied, p_effective_at, p_actor_profile_id,
    p_reason_code, v_room.state_version, p_request_hash, v_recorded_at
  );
  insert into public.room_occupancy_events(
    event_key, room_id, reservation_id, event_type, effective_at, recorded_at,
    actor_profile_id, reason_code, before_state, after_state
  ) values (
    v_command_key, p_room_id, p_reservation_id, 'occupancy_correction',
    p_effective_at, v_recorded_at, p_actor_profile_id, p_reason_code,
    jsonb_build_object('occupied', v_before_occupied),
    jsonb_build_object('occupied', p_occupied)
  );
  insert into public.audit_events(
    actor_profile_id, actor_display_name_snapshot, event_type, entity_type,
    entity_id, effective_at, reason_code, before_state, after_state,
    request_hash, idempotency_key
  ) select profile.id, profile.display_name, 'room.occupancy_corrected', 'room',
      p_room_id, p_effective_at, p_reason_code,
      jsonb_build_object('occupied', v_before_occupied, 'reservationId', p_reservation_id),
      jsonb_build_object('occupied', p_occupied, 'reservationId', p_reservation_id,
        'roomStateVersion', v_room.state_version), p_request_hash, v_command_key
    from public.profiles profile where profile.id = p_actor_profile_id;

  v_response := jsonb_build_object(
    'correction_id', v_correction_id, 'room_id', p_room_id,
    'reservation_id', p_reservation_id, 'occupied', p_occupied,
    'effective_at', p_effective_at, 'room_state_version', v_room.state_version,
    'recorded_at', v_recorded_at
  );
  perform private.complete_command(
    p_actor_profile_id, 'room.occupancy_correction', p_idempotency_key,
    p_request_hash, p_room_id, v_response
  );
  return v_response;
end
$$;
revoke all on function public.correct_room_occupancy(
  uuid, uuid, uuid, uuid, boolean, timestamptz, bigint, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.correct_room_occupancy(
  uuid, uuid, uuid, uuid, boolean, timestamptz, bigint, text, text, text
) to service_role;

create function public.override_room_display_status(
  p_actor_profile_id uuid,
  p_session_id uuid,
  p_room_id uuid,
  p_target_status text,
  p_expected_room_version bigint,
  p_reason_code text,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_room public.rooms;
  v_override_id uuid := gen_random_uuid();
  v_recorded_at timestamptz := clock_timestamp();
  v_command_key text;
  v_before_status text;
  v_response jsonb;
begin
  perform private.assert_attempt_actor_session(p_actor_profile_id, p_session_id, true);
  if (p_target_status is not null and p_target_status not in (
      'BLOCKED', 'OCCUPIED', 'ARRIVAL_PENDING', 'RESERVATION_PRESENT',
      'CLEANING_REQUIRED', 'READY'
    )) or p_reason_code is null or p_reason_code !~ '^[A-Z0-9_]{2,80}$' then
    raise exception using errcode = '22023', message = 'INVALID_DISPLAY_STATUS_OVERRIDE';
  end if;

  v_response := private.replay_command(
    p_actor_profile_id, 'room.display_status_override', p_idempotency_key, p_request_hash
  );
  if v_response is not null then return v_response; end if;

  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'ROOM_NOT_FOUND'; end if;
  if v_room.state_version <> p_expected_room_version then
    raise exception using errcode = '40001', message = 'STALE_VERSION';
  end if;
  v_before_status := private.current_room_display_status_override(p_room_id);
  if v_before_status is not distinct from p_target_status then
    raise exception using errcode = '23514', message = 'DISPLAY_STATUS_OVERRIDE_ALREADY_APPLIED';
  end if;

  update public.rooms set state_version = state_version + 1
  where id = p_room_id returning * into v_room;
  v_command_key := private.audit_command_key(
    p_actor_profile_id, 'room.display_status_override', p_idempotency_key
  );
  insert into private.room_display_status_overrides(
    id, command_key, room_id, target_status, actor_profile_id, reason_code,
    room_state_version, request_hash, recorded_at
  ) values (
    v_override_id, v_command_key, p_room_id, p_target_status, p_actor_profile_id,
    p_reason_code, v_room.state_version, p_request_hash, v_recorded_at
  );
  insert into public.audit_events(
    actor_profile_id, actor_display_name_snapshot, event_type, entity_type,
    entity_id, effective_at, reason_code, before_state, after_state,
    request_hash, idempotency_key
  ) select profile.id, profile.display_name, 'room.display_status_overridden', 'room',
      p_room_id, v_recorded_at, p_reason_code,
      jsonb_build_object('displayStatusOverride', v_before_status),
      jsonb_build_object('displayStatusOverride', p_target_status,
        'roomStateVersion', v_room.state_version), p_request_hash, v_command_key
    from public.profiles profile where profile.id = p_actor_profile_id;

  v_response := jsonb_build_object(
    'override_id', v_override_id, 'room_id', p_room_id,
    'target_status', p_target_status, 'room_state_version', v_room.state_version,
    'recorded_at', v_recorded_at
  );
  perform private.complete_command(
    p_actor_profile_id, 'room.display_status_override', p_idempotency_key,
    p_request_hash, p_room_id, v_response
  );
  return v_response;
end
$$;
revoke all on function public.override_room_display_status(
  uuid, uuid, uuid, text, bigint, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.override_room_display_status(
  uuid, uuid, uuid, text, bigint, text, text, text
) to service_role;

drop function public.get_room_operational_projection(uuid, uuid);

create function public.get_room_operational_projection(
  p_actor_profile_id uuid,
  p_room_id uuid default null
)
returns table (
  id uuid, room_number text, room_type_code text, room_type_name text,
  elevator_zone text, data_status public.data_status, state_version bigint,
  evaluated_at timestamptz, reservation_phase text, occupied boolean,
  cleaning_required boolean, candle_count integer, pin_sync_status text,
  allocation_blocked boolean, allocation_ready boolean, reason_codes text[],
  server_time timestamptz, occupancy_status text, reservation_lifecycle text,
  readiness_status text, primary_display_status text,
  canonical_primary_display_status text, display_status_override text,
  next_reservation_id uuid,
  next_check_in_at timestamptz, next_check_out_at timestamptz,
  blocking_reason_codes text[], readiness_reason_codes text[]
)
language plpgsql security definer set search_path = '' as $$
declare v_evaluated_at timestamptz := clock_timestamp();
begin
  perform private.assert_room_admin(p_actor_profile_id);
  return query
  select room.id, room.room_number, room_type.code, room_type.name,
    room.elevator_zone, room.data_status, room.state_version, v_evaluated_at,
    private.room_reservation_phase_at(room.id, v_evaluated_at), state.occupied,
    state.cleaning_required, private.current_candle_count(room.id), state.pin_status,
    cardinality(readiness.blocking_reason_codes) > 0,
    not state.occupied and cardinality(readiness.readiness_reason_codes) = 0,
    state.reason_codes, v_evaluated_at,
    case when state.occupied then 'OCCUPIED' else 'VACANT' end,
    lifecycle.reservation_lifecycle, readiness.readiness_status,
    coalesce(display_override.target_status, canonical_display.value),
    canonical_display.value, display_override.target_status,
    lifecycle.next_reservation_id, lifecycle.next_check_in_at, lifecycle.next_check_out_at,
    readiness.blocking_reason_codes, readiness.readiness_reason_codes
  from public.rooms room
  join public.room_types room_type on room_type.id = room.room_type_id
  cross join lateral (
    select occupied.value as occupied,
      'CLEANING_REQUIRED' = any(reasons.base_codes) as cleaning_required,
      private.current_pin_sync_status(room.id) as pin_status,
      case when occupied.value then array_append(
        array_remove(reasons.base_codes, 'OCCUPIED'), 'OCCUPIED')
      else array_remove(reasons.base_codes, 'OCCUPIED') end as reason_codes
    from (select private.room_block_reason_codes(
      room.id, v_evaluated_at, true, true) as base_codes) reasons
    cross join lateral (select private.room_occupied_at(
      room.id, v_evaluated_at) as value) occupied
  ) state
  cross join lateral private.room_reservation_lifecycle_at(room.id, v_evaluated_at) lifecycle
  cross join lateral private.room_readiness_axes_at(
    state.reason_codes, state.pin_status, lifecycle.current_checkin_pending) readiness
  cross join lateral (select case
    when cardinality(readiness.blocking_reason_codes) > 0 then 'BLOCKED'
    when state.occupied then 'OCCUPIED'
    when lifecycle.reservation_lifecycle = 'ARRIVAL_PENDING' then 'ARRIVAL_PENDING'
    when lifecycle.reservation_lifecycle = 'RESERVATION_PRESENT' then 'RESERVATION_PRESENT'
    when state.cleaning_required then 'CLEANING_REQUIRED' else 'READY'
  end as value) canonical_display
  cross join lateral (select private.current_room_display_status_override(room.id)
    as target_status) display_override
  where p_room_id is null or room.id = p_room_id order by room.room_number;
end
$$;
revoke all on function public.get_room_operational_projection(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.get_room_operational_projection(uuid, uuid) to service_role;

-- Keep the SQL projection allowlist aligned with the public OpenAPI enum. The
-- public wrapper below remains the only callable surface; this inventory is
-- private and exists so the complete 73-type contract can be regression-tested.
create function private.developer_audit_event_types()
returns text[] language sql immutable set search_path = '' as $$
  select array[
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
    'assignment.draft_saved',
    'assignment.notified',
    'assignment.prestart_changed',
    'assignment.prestart_unassigned',
    'assignment.cancellation_requested',
    'assignment.cancellation_decided',
    'assignment.attempt_activated',
    'assignment.rolled_over',
    'assignment.duration_policy_confirmed',
    'cleaning_template.published',
    'cleaning.attempt_started',
    'cleaning.field_completed',
    'cleaning.finish_current_allowed',
    'cleaning.upload_only_allowed',
    'cleaning.interrupted_handover',
    'cleaning.scheduled_expired',
    'cleaning.offline_event_resolved',
    'photo.upload_accepted',
    'photo.collection_item_deleted',
    'reservation.created',
    'reservation.changed',
    'reservation.room_moved',
    'reservation.cancelled',
    'reservation.manual_checkout',
    'reservation.scheduled_check_in',
    'reservation.scheduled_checkout',
    'reservation.guest_name_retention_purged',
    'checkout.presence_reported',
    'checkout.presence_decided',
    'cleaning.manual_request.created',
    'cleaning.manual_request.cancelled',
    'room.master_data_changed',
    'room.create_block',
    'room.release_block',
    'room.set_candle_count',
    'room.report_issue',
    'room.resolve_issue',
    'room.record_pin_sync',
    'room.occupancy_corrected',
    'room.display_status_overridden',
    'room.pin_change_prepared',
    'room.pin_change_confirmed',
    'room.pin_mismatch_resolved',
    'room.pin_generated',
    'room.generated_pin_confirmed',
    'room_pin_sheet.full_resync_requested',
    'room_pin_sheet.full_resync_succeeded',
    'submission.bomb_reported',
    'submission.created',
    'inspection.bomb_decided',
    'inspection.approved',
    'inspection.rejected',
    'complaint.rework_materialized',
    'compensation.earned',
    'payroll.adjustment_recorded',
    'payroll.adjustment_reversed',
    'payroll.offset_settled',
    'payroll.late_earning_carried',
    'payroll.payment_started',
    'payroll.payment_check_recorded',
    'payroll.payment_paid',
    'payroll.payment_reopened'
  ]::text[]
$$;
revoke all on function private.developer_audit_event_types()
  from public, anon, authenticated, service_role;

-- Extend the bounded developer projection without exposing the raw audit
-- before/after documents or request hash stored in the immutable ledger.
alter function public.list_developer_audit_events(
  uuid, text[], uuid, timestamptz, timestamptz, timestamptz, uuid, integer
) set schema private;
alter function private.list_developer_audit_events(
  uuid, text[], uuid, timestamptz, timestamptz, timestamptz, uuid, integer
) rename to list_developer_audit_events_before_room_status_correction;
revoke all on function private.list_developer_audit_events_before_room_status_correction(
  uuid, text[], uuid, timestamptz, timestamptz, timestamptz, uuid, integer
) from public, anon, authenticated, service_role;

create function public.list_developer_audit_events(
  p_actor_profile_id uuid,
  p_event_types text[] default null,
  p_filter_actor_profile_id uuid default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_before_recorded_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 50
) returns table(
  id uuid, event_type text, entity_type text, entity_id uuid,
  actor_profile_id uuid, actor_display_name text, effective_at timestamptz,
  recorded_at timestamptz, reason_code text, summary jsonb
)
language plpgsql security definer set search_path = '' as $$
declare
  v_new_types constant text[] := array[
    'room.occupancy_corrected', 'room.display_status_overridden'
  ];
  v_allowed_types constant text[] := private.developer_audit_event_types();
  v_previous_types text[];
  v_from timestamptz := coalesce(p_from, clock_timestamp() - interval '7 days');
  v_to timestamptz := coalesce(p_to, clock_timestamp());
begin
  if p_event_types is not null and (
    coalesce(cardinality(p_event_types), 0) = 0
    or exists (
      select 1 from unnest(p_event_types) requested
      where requested <> all(v_allowed_types)
    )
  ) then
    raise exception using errcode = '22023', message = 'INVALID_AUDIT_QUERY';
  end if;
  if p_event_types is null then
    v_previous_types := null;
  else
    select coalesce(array_agg(requested), array[]::text[])
    into v_previous_types
    from unnest(p_event_types) requested
    where requested <> all(v_new_types);
    if cardinality(v_previous_types) = 0 then
      v_previous_types := array['account.created'];
    end if;
  end if;

  return query
  select merged.* from (
    select previous.*
    from private.list_developer_audit_events_before_room_status_correction(
      p_actor_profile_id, v_previous_types, p_filter_actor_profile_id,
      p_from, p_to, p_before_recorded_at, p_before_id, p_limit
    ) previous
    where p_event_types is null or previous.event_type = any(p_event_types)
    union all
    select audit.id, audit.event_type, audit.entity_type, audit.entity_id,
      audit.actor_profile_id, audit.actor_display_name_snapshot,
      audit.effective_at, audit.recorded_at, audit.reason_code,
      case audit.event_type
        when 'room.occupancy_corrected' then jsonb_strip_nulls(jsonb_build_object(
          'occupied', audit.after_state -> 'occupied',
          'roomStateVersion', audit.after_state -> 'roomStateVersion'
        ))
        when 'room.display_status_overridden' then jsonb_strip_nulls(jsonb_build_object(
          'displayStatusOverride', audit.after_state -> 'displayStatusOverride',
          'roomStateVersion', audit.after_state -> 'roomStateVersion'
        ))
      end
    from public.audit_events audit
    where audit.event_type = any(v_new_types)
      and (p_event_types is null or audit.event_type = any(p_event_types))
      and audit.recorded_at >= v_from and audit.recorded_at <= v_to
      and (p_filter_actor_profile_id is null
        or audit.actor_profile_id = p_filter_actor_profile_id)
      and (p_before_recorded_at is null
        or (audit.recorded_at, audit.id) < (p_before_recorded_at, p_before_id))
    order by recorded_at desc, id desc
    limit p_limit
  ) merged
  order by merged.recorded_at desc, merged.id desc
  limit p_limit;
end
$$;
revoke all on function public.list_developer_audit_events(
  uuid, text[], uuid, timestamptz, timestamptz, timestamptz, uuid, integer
) from public, anon, authenticated;
grant execute on function public.list_developer_audit_events(
  uuid, text[], uuid, timestamptz, timestamptz, timestamptz, uuid, integer
) to service_role;

comment on function public.correct_room_occupancy(
  uuid, uuid, uuid, uuid, boolean, timestamptz, bigint, text, text, text
) is 'Admin-only append-only occupancy correction. Preserves reason, effective time, room CAS, idempotency receipt, safe audit, and canonical stay segment history.';

comment on function public.override_room_display_status(
  uuid, uuid, uuid, text, bigint, text, text, text
) is 'Admin-only append-only display classification override. It never changes reservation, occupancy, readiness, bookability, or operation-block authority; null clears the override.';

comment on function public.list_developer_audit_events(
  uuid, text[], uuid, timestamptz, timestamptz, timestamptz, uuid, integer
) is 'Lists bounded safe developer audit projections, including room occupancy corrections and display-status overrides, without raw audit states or request hashes.';
