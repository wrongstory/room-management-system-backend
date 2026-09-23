-- Issue #184: current-time room status must not treat future preparation work as current cleaning.

create or replace function private.room_current_cleaning_required_at(
  p_room_id uuid,
  p_at timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, private
as $$
  select exists (
    select 1
    from public.cleaning_targets target
    where target.room_id = p_room_id
      and (
        (
          target.cleaning_kind = 'checkout'
          and target.status not in ('approved', 'cancelled')
          and exists (
            select 1
            from public.checkout_cleaning_obligations obligation
            join public.reservations reservation
              on reservation.id = obligation.reservation_id
             and reservation.room_id = obligation.room_id
            where obligation.id = target.checkout_obligation_id
              and obligation.current_cleaning_target_id = target.id
              and obligation.status = 'materialized'
              and reservation.actual_checkout_at is not null
              and reservation.actual_checkout_at <= p_at
          )
        )
        or (
          target.cleaning_kind <> 'checkout'
          and target.status in (
            'unassigned',
            'draft_assigned',
            'notified',
            'in_progress',
            'upload_pending',
            'inspection_pending'
          )
          and target.effective_service_date <= (p_at at time zone 'Asia/Seoul')::date
          and (target.available_from is null or target.available_from <= p_at)
        )
      )
  )
$$;

revoke all on function private.room_current_cleaning_required_at(uuid, timestamptz)
from public, anon, authenticated, service_role;

create or replace function private.room_reservation_phase_at(
  p_room_id uuid,
  p_at timestamptz
)
returns text
language sql
stable
security definer
set search_path = pg_catalog, public, private
as $$
  select case
    when exists (
      select 1
      from public.reservations reservation
      where reservation.room_id = p_room_id
        and reservation.status = 'active'
        and reservation.actual_checkout_at is null
        and reservation.check_in_at <= p_at
        and reservation.check_out_at > p_at
    ) then 'current'
    when exists (
      select 1
      from public.reservations reservation
      where reservation.room_id = p_room_id
        and reservation.status = 'active'
        and reservation.actual_check_in_at is null
        and reservation.actual_checkout_at is null
        and reservation.check_in_at > p_at
    ) then 'upcoming'
    else 'none'
  end
$$;

revoke all on function private.room_reservation_phase_at(uuid, timestamptz)
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
set search_path = pg_catalog, public, private
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

  if p_include_occupancy and exists (
    select 1
    from public.reservations reservation
    where reservation.room_id = p_room_id
      and reservation.status = 'active'
      and reservation.actual_check_in_at is not null
      and reservation.actual_check_in_at <= p_at
      and reservation.actual_checkout_at is null
  ) then
    v_reasons := array_append(v_reasons, 'OCCUPIED');
  end if;

  if p_include_occupancy
    and p_preparation_reservation_id is null
    and private.room_reservation_phase_at(p_room_id, p_at) = 'current'
  then
    v_reasons := array_append(v_reasons, 'RESERVATION_CURRENT');
  end if;

  if p_include_cleaning and (
    (
      p_preparation_reservation_id is not null
      and exists (
        select 1
        from public.preparation_obligations obligation
        join public.reservations reservation on reservation.id = obligation.reservation_id
        where obligation.room_id = p_room_id
          and obligation.reservation_id = p_preparation_reservation_id
          and reservation.status = 'active'
          and obligation.status <> 'approved'
      )
    )
    or (
      p_preparation_reservation_id is null
      and private.room_current_cleaning_required_at(p_room_id, p_at)
    )
  ) then
    v_reasons := array_append(v_reasons, 'CLEANING_REQUIRED');
  end if;

  if private.current_candle_count(p_room_id) > 0 then
    v_reasons := array_append(v_reasons, 'CANDLE_PRESENT');
  end if;
  if exists (
    select 1
    from public.room_operation_blocks block
    where block.room_id = p_room_id
      and block.released_at is null
      and block.starts_at <= p_at
      and (block.ends_at is null or block.ends_at > p_at)
  ) then
    v_reasons := array_append(v_reasons, 'OPERATION_BLOCKED');
  end if;
  if exists (
    select 1
    from public.room_issues issue
    where issue.room_id = p_room_id
      and issue.status = 'open'
      and issue.blocks_guest_assignment
  ) then
    v_reasons := array_append(v_reasons, 'ROOM_ISSUE_BLOCKED');
  end if;

  if p_preparation_reservation_id is not null then
    v_pin_status := private.current_pin_sync_status(p_room_id);
    if v_pin_status = 'mismatch' then
      v_reasons := array_append(v_reasons, 'PIN_MISMATCH');
    elsif v_pin_status = 'unconfigured' then
      v_reasons := array_append(v_reasons, 'DATA_UNCONFIRMED');
    end if;
    if exists (
      select 1
      from public.checkout_presence_incidents incident
      where incident.room_id = p_room_id
        and incident.status = 'open'
    ) then
      v_reasons := array_append(v_reasons, 'CHECKOUT_NOT_COMPLETED');
    end if;
  end if;

  if v_room.data_status <> 'verified' and not ('DATA_UNCONFIRMED' = any(v_reasons)) then
    v_reasons := array_append(v_reasons, 'DATA_UNCONFIRMED');
  end if;
  return v_reasons;
end
$$;

revoke all on function private.room_block_reason_codes(uuid, timestamptz, boolean, boolean, uuid)
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
  reason_codes text[]
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
    'OCCUPIED' = any(state.reason_codes),
    'CLEANING_REQUIRED' = any(state.reason_codes),
    private.current_candle_count(room.id),
    private.current_pin_sync_status(room.id),
    array_length(state.reason_codes, 1) is not null,
    array_length(state.reason_codes, 1) is null,
    state.reason_codes
  from public.rooms room
  join public.room_types room_type on room_type.id = room.room_type_id
  cross join lateral (
    select private.room_block_reason_codes(room.id, v_evaluated_at, true, true) as reason_codes
  ) state
  where p_room_id is null or room.id = p_room_id
  order by room.room_number;
end
$$;

revoke all on function public.get_room_operational_projection(uuid, uuid)
from public, anon, authenticated;
grant execute on function public.get_room_operational_projection(uuid, uuid) to service_role;

comment on function public.get_room_operational_projection(uuid, uuid) is
'Current-time room projection. reservation_phase is the scheduled [check-in, check-out) interval evaluated once per response; actual occupancy remains an independent occupied axis and future checkout planning never activates cleaning_required.';
