create or replace function public.preview_reservation_bookability(
  p_actor_profile_id uuid,
  p_check_in_at timestamptz,
  p_check_out_at timestamptz,
  p_guest_count integer default null,
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
  if p_guest_count is not null and p_guest_count < 1 then
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
        || case when p_guest_count is not null
          and p_guest_count > room_type.max_guest_count
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
  'Admin-only reservation preview. guest_count is optional; null omits capacity filtering while a positive value is checked against the latest room-type maximum.';
