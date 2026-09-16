-- Issue #187 Phase A: expose arrival lifecycle and current readiness as
-- independent, current-time room projection axes.  This migration does not
-- add room-move commands or change reservation allocation authority.

create function private.room_reservation_lifecycle_at(
  p_room_id uuid,
  p_at timestamptz
)
returns table (
  reservation_lifecycle text,
  next_reservation_id uuid,
  next_check_in_at timestamptz,
  next_check_out_at timestamptz,
  current_checkin_pending boolean
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_current boolean;
  v_next public.reservations%rowtype;
  v_today date := (p_at at time zone 'Asia/Seoul')::date;
begin
  select exists (
    select 1
    from public.reservations reservation
    where reservation.room_id = p_room_id
      and reservation.status = 'active'
      and reservation.actual_checkout_at is null
      and (
        (
          reservation.check_in_at <= p_at
          and reservation.check_out_at > p_at
        )
        or (
          reservation.actual_check_in_at is not null
          and reservation.actual_check_in_at <= p_at
        )
      )
  ) into v_current;

  select reservation.* into v_next
  from public.reservations reservation
  where reservation.room_id = p_room_id
    and reservation.status = 'active'
    and reservation.actual_check_in_at is null
    and reservation.actual_checkout_at is null
    and reservation.check_in_at > p_at
  order by reservation.check_in_at, reservation.id
  limit 1;

  reservation_lifecycle := case
    when v_current then 'OCCUPIED'
    when v_next.id is null then 'NONE'
    when (v_next.check_in_at at time zone 'Asia/Seoul')::date = v_today
      then 'ARRIVAL_PENDING'
    when (v_next.check_in_at at time zone 'Asia/Seoul')::date = v_today + 1
      then 'RESERVATION_PRESENT'
    else 'FUTURE'
  end;
  next_reservation_id := v_next.id;
  next_check_in_at := v_next.check_in_at;
  next_check_out_at := v_next.check_out_at;
  current_checkin_pending := exists (
    select 1
    from public.reservations reservation
    where reservation.room_id = p_room_id
      and reservation.status = 'active'
      and reservation.actual_check_in_at is null
      and reservation.actual_checkout_at is null
      and reservation.check_in_at <= p_at
      and reservation.check_out_at > p_at
  );
  return next;
end
$$;

revoke all on function private.room_reservation_lifecycle_at(uuid, timestamptz)
from public, anon, authenticated, service_role;

create function private.room_readiness_axes_at(
  p_base_reason_codes text[],
  p_pin_sync_status text,
  p_current_checkin_pending boolean
)
returns table (
  blocking_reason_codes text[],
  readiness_reason_codes text[],
  readiness_status text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_pin_reason text;
begin
  select coalesce(array_agg(reason order by ordinal), array[]::text[])
  into blocking_reason_codes
  from unnest(coalesce(p_base_reason_codes, array[]::text[]))
    with ordinality as reasons(reason, ordinal)
  where reason not in ('OCCUPIED', 'RESERVATION_CURRENT', 'CLEANING_REQUIRED');

  v_pin_reason := case
    when not p_current_checkin_pending then null
    when p_pin_sync_status = 'mismatch' then 'PIN_MISMATCH'
    when p_pin_sync_status = 'unconfigured' then 'PIN_UNCONFIGURED'
    else null
  end;

  readiness_reason_codes := blocking_reason_codes;
  if 'CLEANING_REQUIRED' = any(coalesce(p_base_reason_codes, array[]::text[])) then
    readiness_reason_codes := array_append(readiness_reason_codes, 'CLEANING_REQUIRED');
  end if;
  if v_pin_reason is not null then
    readiness_reason_codes := array_append(readiness_reason_codes, v_pin_reason);
  end if;

  readiness_status := case
    when cardinality(blocking_reason_codes) > 0 or v_pin_reason is not null
      then 'CHECKIN_BLOCKED'
    when 'CLEANING_REQUIRED' = any(coalesce(p_base_reason_codes, array[]::text[]))
      then 'CLEANING_REQUIRED'
    else 'READY'
  end;
  return next;
end
$$;

revoke all on function private.room_readiness_axes_at(text[], text, boolean)
from public, anon, authenticated, service_role;

drop function public.get_room_operational_projection(uuid, uuid);

create function public.get_room_operational_projection(
  p_actor_profile_id uuid,
  p_room_id uuid default null
)
returns table (
  id uuid,
  room_number text,
  room_type_code text,
  room_type_name text,
  elevator_zone text,
  data_status public.data_status,
  state_version bigint,
  evaluated_at timestamptz,
  reservation_phase text,
  occupied boolean,
  cleaning_required boolean,
  candle_count integer,
  pin_sync_status text,
  allocation_blocked boolean,
  allocation_ready boolean,
  reason_codes text[],
  server_time timestamptz,
  occupancy_status text,
  reservation_lifecycle text,
  readiness_status text,
  primary_display_status text,
  next_reservation_id uuid,
  next_check_in_at timestamptz,
  next_check_out_at timestamptz,
  blocking_reason_codes text[],
  readiness_reason_codes text[]
)
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_evaluated_at timestamptz := clock_timestamp();
begin
  perform private.assert_room_admin(p_actor_profile_id);

  return query
  select
    room.id,
    room.room_number,
    room_type.code,
    room_type.name,
    room.elevator_zone,
    room.data_status,
    room.state_version,
    v_evaluated_at,
    private.room_reservation_phase_at(room.id, v_evaluated_at),
    state.occupied,
    state.cleaning_required,
    private.current_candle_count(room.id),
    state.pin_status,
    cardinality(state.reason_codes) > 0,
    cardinality(state.reason_codes) = 0,
    state.reason_codes,
    v_evaluated_at,
    case when state.occupied then 'OCCUPIED' else 'VACANT' end,
    lifecycle.reservation_lifecycle,
    readiness.readiness_status,
    case
      when readiness.readiness_status = 'CHECKIN_BLOCKED' then 'BLOCKED'
      when lifecycle.reservation_lifecycle = 'OCCUPIED' then 'OCCUPIED'
      when lifecycle.reservation_lifecycle = 'ARRIVAL_PENDING' then 'ARRIVAL_PENDING'
      when lifecycle.reservation_lifecycle = 'RESERVATION_PRESENT' then 'RESERVATION_PRESENT'
      when state.cleaning_required then 'CLEANING_REQUIRED'
      else 'READY'
    end,
    lifecycle.next_reservation_id,
    lifecycle.next_check_in_at,
    lifecycle.next_check_out_at,
    readiness.blocking_reason_codes,
    readiness.readiness_reason_codes
  from public.rooms room
  join public.room_types room_type on room_type.id = room.room_type_id
  cross join lateral (
    select
      reasons.reason_codes,
      'OCCUPIED' = any(reasons.reason_codes) as occupied,
      'CLEANING_REQUIRED' = any(reasons.reason_codes) as cleaning_required,
      private.current_pin_sync_status(room.id) as pin_status
    from (
      select private.room_block_reason_codes(
        room.id,
        v_evaluated_at,
        true,
        true
      ) as reason_codes
    ) reasons
  ) state
  cross join lateral private.room_reservation_lifecycle_at(
    room.id,
    v_evaluated_at
  ) lifecycle
  cross join lateral private.room_readiness_axes_at(
    state.reason_codes,
    state.pin_status,
    lifecycle.current_checkin_pending
  ) readiness
  where p_room_id is null or room.id = p_room_id
  order by room.room_number;
end
$$;

revoke all on function public.get_room_operational_projection(uuid, uuid)
from public, anon, authenticated;
grant execute on function public.get_room_operational_projection(uuid, uuid)
to service_role;

comment on function public.get_room_operational_projection(uuid, uuid) is
'Current-time room projection evaluated once per response. Existing phase/allocation fields remain compatible; arrival lifecycle, actual occupancy, readiness, display priority, and next future reservation are independent axes. No guest PII or PIN material is returned.';
