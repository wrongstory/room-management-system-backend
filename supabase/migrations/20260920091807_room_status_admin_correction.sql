-- Issue #228: keep physical occupancy, room-problem blocking, and overall
-- allocation readiness as independent axes. Administrative occupancy fixes
-- are explicit, append-only commands against the canonical stay segment.

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
  v_successor private.stay_room_segments;
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
    perform 1
    from private.stay_room_segments segment
    where segment.room_id = p_room_id and segment.stay_id <> v_stay.id
      and segment.retired_at is null
      and tstzrange(segment.starts_at, segment.ends_at, '[)') &&
        tstzrange(p_effective_at, v_reservation.check_out_at, '[)')
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
          tstzrange(p_effective_at, v_reservation.check_out_at, '[)')
    ) then
      raise exception using errcode = '23514', message = 'OCCUPANCY_CORRECTION_ROOM_MISMATCH';
    end if;
    select segment.* into v_segment
    from private.stay_room_segments segment
    where segment.stay_id = v_stay.id and segment.room_id = p_room_id
      and segment.retired_at is null and segment.starts_at > p_effective_at
    order by segment.starts_at, segment.id limit 1 for update;
    if v_segment.id is not null then
      update private.stay_room_segments
      set retired_at = v_recorded_at,
          terminal_reason_code = 'ADMIN_OCCUPANCY_CORRECTION',
          version = version + 1,
          updated_at = v_recorded_at
      where id = v_segment.id;
    end if;
    insert into private.stay_room_segments(
      stay_id, room_id, starts_at, ends_at, source_reservation_id,
      terminal_reason_code, created_at, updated_at
    ) values (
      v_stay.id, p_room_id, p_effective_at, v_reservation.check_out_at,
      v_reservation.id, 'ADMIN_OCCUPANCY_CORRECTION', v_recorded_at, v_recorded_at
    ) returning * into v_successor;
  else
    if not v_before_occupied then
      raise exception using errcode = '23514', message = 'OCCUPANCY_CORRECTION_ALREADY_APPLIED';
    end if;
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
    v_segment.id, v_successor.id, p_occupied, p_effective_at, p_actor_profile_id,
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

create or replace function public.get_room_operational_projection(
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
  readiness_status text, primary_display_status text, next_reservation_id uuid,
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
    case when cardinality(readiness.blocking_reason_codes) > 0 then 'BLOCKED'
      when state.occupied then 'OCCUPIED'
      when lifecycle.reservation_lifecycle = 'ARRIVAL_PENDING' then 'ARRIVAL_PENDING'
      when lifecycle.reservation_lifecycle = 'RESERVATION_PRESENT' then 'RESERVATION_PRESENT'
      when state.cleaning_required then 'CLEANING_REQUIRED' else 'READY' end,
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
  where p_room_id is null or room.id = p_room_id order by room.room_number;
end
$$;
revoke all on function public.get_room_operational_projection(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.get_room_operational_projection(uuid, uuid) to service_role;

comment on function public.correct_room_occupancy(
  uuid, uuid, uuid, uuid, boolean, timestamptz, bigint, text, text, text
) is 'Admin-only append-only occupancy correction. Preserves reason, effective time, room CAS, idempotency receipt, safe audit, and canonical stay segment history.';
