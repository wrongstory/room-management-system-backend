-- Issue #318: expose a date-aware admin room board and the detailed filter
-- conditions fixed by the frontend wireframe. The existing current projection
-- remains untouched for compatibility; this append-only read contract supplies
-- both today's live board and explicitly selected operational service dates.

create function private.room_board_candle_count_at(
  p_room_id uuid,
  p_at timestamptz
)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select event.count_after
    from public.room_candle_events event
    where event.room_id = p_room_id
      and event.effective_at <= p_at
    order by event.effective_at desc, event.recorded_at desc, event.id desc
    limit 1
  ), 0)
$$;
revoke all on function private.room_board_candle_count_at(uuid, timestamptz)
  from public, anon, authenticated, service_role;

create function private.room_board_pin_sync_status_at(
  p_room_id uuid,
  p_at timestamptz
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select event.sync_status
    from public.room_pin_sync_events event
    where event.room_id = p_room_id
      and event.effective_at <= p_at
    order by event.effective_at desc, event.recorded_at desc, event.id desc
    limit 1
  ), 'unconfigured')
$$;
revoke all on function private.room_board_pin_sync_status_at(uuid, timestamptz)
  from public, anon, authenticated, service_role;

create function private.room_board_operation_blocked_at(
  p_room_id uuid,
  p_at timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.room_operation_blocks block
    where block.room_id = p_room_id
      and block.created_at <= p_at
      and block.starts_at <= p_at
      and (block.ends_at is null or block.ends_at > p_at)
      and (block.released_at is null or block.released_at > p_at)
  )
$$;
revoke all on function private.room_board_operation_blocked_at(uuid, timestamptz)
  from public, anon, authenticated, service_role;

create function private.room_board_issue_count_at(
  p_room_id uuid,
  p_at timestamptz,
  p_blocking_only boolean default false
)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
  from public.room_issues issue
  where issue.room_id = p_room_id
    and issue.reported_at <= p_at
    and (issue.resolved_at is null or issue.resolved_at > p_at)
    and (not p_blocking_only or issue.blocks_guest_assignment)
$$;
revoke all on function private.room_board_issue_count_at(uuid, timestamptz, boolean)
  from public, anon, authenticated, service_role;

create function private.room_board_cleaning_required_at(
  p_room_id uuid,
  p_at timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.cleaning_targets target
    where target.room_id = p_room_id
      and target.created_at <= p_at
      and (target.available_from is null or target.available_from <= p_at)
      and target.effective_service_date <= (p_at at time zone 'Asia/Seoul')::date
      and (target.cancelled_at is null or target.cancelled_at > p_at)
      and not exists (
        select 1
        from public.cleaning_attempts attempt
        join public.cleaning_submissions submission
          on submission.cleaning_attempt_id = attempt.id
        join public.inspection_decisions decision
          on decision.submission_id = submission.id
        where attempt.cleaning_target_id = target.id
          and decision.decided_at <= p_at
      )
  )
$$;
revoke all on function private.room_board_cleaning_required_at(uuid, timestamptz)
  from public, anon, authenticated, service_role;

create function private.room_board_checkout_inspection_required_at(
  p_room_id uuid,
  p_at timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.cleaning_targets target
    where target.room_id = p_room_id
      and target.cleaning_kind = 'checkout'
      and target.created_at <= p_at
      and target.available_from is not null
      and target.available_from <= p_at
      and (target.cancelled_at is null or target.cancelled_at > p_at)
      and not exists (
        select 1
        from public.cleaning_attempts attempt
        where attempt.cleaning_target_id = target.id
          and attempt.field_completed_at is not null
          and attempt.field_completed_at <= p_at
      )
  )
$$;
revoke all on function private.room_board_checkout_inspection_required_at(uuid, timestamptz)
  from public, anon, authenticated, service_role;

create function private.room_board_display_status_override_at(
  p_room_id uuid,
  p_at timestamptz
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select override.target_status
  from private.room_display_status_overrides override
  where override.room_id = p_room_id
    and override.recorded_at <= p_at
  order by override.recorded_at desc, override.id desc
  limit 1
$$;
revoke all on function private.room_board_display_status_override_at(uuid, timestamptz)
  from public, anon, authenticated, service_role;

create function public.get_room_board_projection(
  p_actor_profile_id uuid,
  p_session_id uuid,
  p_service_date date,
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
  canonical_primary_display_status text,
  display_status_override text,
  next_reservation_id uuid,
  next_check_in_at timestamptz,
  next_check_out_at timestamptz,
  blocking_reason_codes text[],
  readiness_reason_codes text[],
  service_date date,
  projection_mode text,
  detail_condition_codes text[],
  display_reservation_id uuid,
  display_check_in_at timestamptz,
  display_check_out_at timestamptz,
  display_guest_count integer,
  display_base_occupancy integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_server_time timestamptz := clock_timestamp();
  v_today date := (v_server_time at time zone 'Asia/Seoul')::date;
  v_service_date date := coalesce(p_service_date, v_today);
  v_evaluated_at timestamptz;
  v_projection_mode text;
begin
  perform private.assert_attempt_actor_session(
    p_actor_profile_id,
    p_session_id,
    true
  );

  if not isfinite(v_service_date) then
    raise exception using errcode = '22023', message = 'SERVICE_DATE_INVALID';
  end if;

  if v_service_date = v_today then
    v_evaluated_at := v_server_time;
    v_projection_mode := 'LIVE';
  elsif v_service_date < v_today then
    v_evaluated_at := (
      ((v_service_date + 1)::timestamp at time zone 'Asia/Seoul')
      - interval '1 microsecond'
    );
    v_projection_mode := 'PAST_END_OF_DAY';
  else
    v_evaluated_at := v_service_date::timestamp at time zone 'Asia/Seoul';
    v_projection_mode := 'FUTURE_START_OF_DAY';
  end if;

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
    case
      when current_reservation.id is not null then 'current'
      when next_reservation.id is not null then 'upcoming'
      else 'none'
    end,
    current_reservation.id is not null,
    state.cleaning_required,
    state.candle_count,
    state.pin_status,
    cardinality(readiness.blocking_reason_codes) > 0,
    current_reservation.id is null
      and cardinality(readiness.readiness_reason_codes) = 0,
    state.reason_codes,
    v_server_time,
    case when current_reservation.id is null then 'VACANT' else 'OCCUPIED' end,
    lifecycle.reservation_lifecycle,
    readiness.readiness_status,
    coalesce(display_override.target_status, canonical_display.value),
    canonical_display.value,
    display_override.target_status,
    next_reservation.id,
    next_reservation.starts_at,
    next_reservation.ends_at,
    readiness.blocking_reason_codes,
    readiness.readiness_reason_codes,
    v_service_date,
    v_projection_mode,
    array_remove(array[
      case when checkout_inspection.value then 'CHECKOUT_INSPECTION_REQUIRED' end,
      case when display_reservation.guest_count > room_type.default_guest_count
        then 'EXTRA_GUESTS' end,
      case when current_reservation.id is null
          and room.data_status = 'verified' then 'VACANT' end,
      case when current_reservation.id is null and state.candle_count > 0
        then 'CANDLE_PRESENT' end,
      case when state.issue_count > 0 then 'ROOM_ISSUE_PRESENT' end,
      case when display_reservation.starts_at is not null
          and (display_reservation.starts_at at time zone 'Asia/Seoul')::time < time '16:00'
        then 'EARLY_CHECK_IN' end,
      case when display_reservation.ends_at is not null
          and (display_reservation.ends_at at time zone 'Asia/Seoul')::time > time '11:00'
        then 'LATE_CHECK_OUT' end,
      case when room.data_status = 'verification_required'
        then 'DATA_VERIFICATION_REQUIRED' end,
      case when state.pin_status <> 'verified' then 'PIN_SYNC_WARNING' end
    ]::text[], null),
    display_reservation.id,
    display_reservation.starts_at,
    display_reservation.ends_at,
    display_reservation.guest_count,
    room_type.default_guest_count
  from public.rooms room
  join public.room_types room_type on room_type.id = room.room_type_id
  left join lateral (
    select reservation.id, reservation.guest_count,
      segment.starts_at, segment.ends_at,
      reservation.actual_check_in_at
    from private.stay_room_segments segment
    join private.reservation_stays stay on stay.id = segment.stay_id
    join public.reservations reservation on reservation.id = stay.reservation_id
    where segment.room_id = room.id
      and segment.retired_at is null
      and segment.starts_at <= v_evaluated_at
      and (segment.ends_at is null or segment.ends_at > v_evaluated_at)
    order by segment.starts_at desc, segment.id desc
    limit 1
  ) current_reservation on true
  left join lateral (
    select reservation.id, reservation.guest_count,
      segment.starts_at, segment.ends_at,
      reservation.actual_check_in_at
    from private.stay_room_segments segment
    join private.reservation_stays stay on stay.id = segment.stay_id
    join public.reservations reservation on reservation.id = stay.reservation_id
    where segment.room_id = room.id
      and segment.retired_at is null
      and segment.starts_at > v_evaluated_at
    order by segment.starts_at, reservation.id
    limit 1
  ) next_reservation on true
  cross join lateral (
    select
      coalesce(current_reservation.id, next_reservation.id) as id,
      coalesce(current_reservation.guest_count, next_reservation.guest_count) as guest_count,
      coalesce(current_reservation.starts_at, next_reservation.starts_at) as starts_at,
      coalesce(current_reservation.ends_at, next_reservation.ends_at) as ends_at
  ) display_reservation
  cross join lateral (
    select
      private.room_board_cleaning_required_at(room.id, v_evaluated_at) as cleaning_required,
      private.room_board_candle_count_at(room.id, v_evaluated_at) as candle_count,
      private.room_board_pin_sync_status_at(room.id, v_evaluated_at) as pin_status,
      private.room_board_issue_count_at(room.id, v_evaluated_at, false) as issue_count,
      private.room_board_issue_count_at(room.id, v_evaluated_at, true) as blocking_issue_count,
      private.room_board_operation_blocked_at(room.id, v_evaluated_at) as operation_blocked
  ) raw_state
  cross join lateral (
    select raw_state.*,
      array_remove(array[
        case when current_reservation.id is not null then 'OCCUPIED' end,
        case when current_reservation.id is not null then 'RESERVATION_CURRENT' end,
        case when raw_state.cleaning_required then 'CLEANING_REQUIRED' end,
        case when raw_state.candle_count > 0 then 'CANDLE_PRESENT' end,
        case when raw_state.operation_blocked then 'OPERATION_BLOCKED' end,
        case when raw_state.blocking_issue_count > 0 then 'ROOM_ISSUE_BLOCKED' end,
        case when room.data_status <> 'verified' then 'DATA_UNCONFIRMED' end
      ]::text[], null) as reason_codes
  ) state
  cross join lateral (
    select case
      when current_reservation.id is not null then 'OCCUPIED'
      when next_reservation.id is null then 'NONE'
      when (next_reservation.starts_at at time zone 'Asia/Seoul')::date = v_service_date
        then 'ARRIVAL_PENDING'
      when (next_reservation.starts_at at time zone 'Asia/Seoul')::date = v_service_date + 1
        then 'RESERVATION_PRESENT'
      else 'FUTURE'
    end as reservation_lifecycle,
    current_reservation.id is not null
      and (current_reservation.actual_check_in_at is null
        or current_reservation.actual_check_in_at > v_evaluated_at)
      as current_checkin_pending
  ) lifecycle
  cross join lateral private.room_readiness_axes_at(
    state.reason_codes,
    state.pin_status,
    lifecycle.current_checkin_pending
  ) readiness
  cross join lateral (
    select case
      when cardinality(readiness.blocking_reason_codes) > 0 then 'BLOCKED'
      when current_reservation.id is not null then 'OCCUPIED'
      when lifecycle.reservation_lifecycle = 'ARRIVAL_PENDING' then 'ARRIVAL_PENDING'
      when lifecycle.reservation_lifecycle = 'RESERVATION_PRESENT' then 'RESERVATION_PRESENT'
      when state.cleaning_required then 'CLEANING_REQUIRED'
      else 'READY'
    end as value
  ) canonical_display
  cross join lateral (
    select private.room_board_display_status_override_at(room.id, v_evaluated_at)
      as target_status
  ) display_override
  cross join lateral (
    select private.room_board_checkout_inspection_required_at(room.id, v_evaluated_at)
      as value
  ) checkout_inspection
  where room.active
    and (p_room_id is null or room.id = p_room_id)
  order by room.room_number;
end
$$;

revoke all on function public.get_room_board_projection(uuid, uuid, date, uuid)
  from public, anon, authenticated;
grant execute on function public.get_room_board_projection(uuid, uuid, date, uuid)
  to service_role;

comment on function public.get_room_board_projection(uuid, uuid, date, uuid) is
  'Admin-only date-aware room board. Historical and future operational axes use immutable event times; room catalog and data-status fields use the latest catalog because they do not yet have effective-dated history.';
