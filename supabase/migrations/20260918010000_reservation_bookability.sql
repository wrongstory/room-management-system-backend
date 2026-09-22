-- Issue #196: bounded reservation calendar reads and future interval preview.
-- Existing reservation/stay constraints remain the final commit authority.

create index reservations_calendar_range_idx
  on public.reservations(check_in_at, id);

create function public.preview_reservation_bookability(
  p_actor_profile_id uuid,
  p_check_in_at timestamptz,
  p_check_out_at timestamptz,
  p_exclude_reservation_id uuid default null,
  p_room_type_ids uuid[] default null,
  p_reservation_type text default 'standard'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_evaluated_at timestamptz := clock_timestamp();
  v_excluded public.reservations%rowtype;
  v_candidates jsonb;
  v_room_type_ids uuid[] := nullif(p_room_type_ids, array[]::uuid[]);
begin
  perform private.assert_room_admin(p_actor_profile_id);

  if p_reservation_type is distinct from 'standard' then
    raise exception using errcode = '22023', message = 'UNSUPPORTED_RESERVATION_TYPE';
  end if;

  if p_check_in_at is null or p_check_out_at is null
    or not isfinite(p_check_in_at) or not isfinite(p_check_out_at)
    or p_check_out_at <= p_check_in_at
    or (p_check_out_at at time zone 'Asia/Seoul')::date
      <= (p_check_in_at at time zone 'Asia/Seoul')::date
    or p_check_in_at <> date_trunc('minute', p_check_in_at)
    or p_check_out_at <> date_trunc('minute', p_check_out_at) then
    raise exception using errcode = '22023', message = 'INVALID_RESERVATION_SCHEDULE';
  end if;
  if p_check_out_at - p_check_in_at > interval '366 days' then
    raise exception using errcode = '22023', message = 'BOOKABILITY_RANGE_TOO_LARGE';
  end if;
  if v_room_type_ids is not null
    and cardinality(v_room_type_ids) > 20 then
    raise exception using errcode = '22023', message = 'INVALID_ROOM_TYPE_FILTER';
  end if;
  if v_room_type_ids is not null and (
    (select count(distinct value) from unnest(v_room_type_ids) value)
      <> cardinality(v_room_type_ids)
    or exists (
      select 1 from unnest(v_room_type_ids) value
      where not exists(select 1 from public.room_types room_type where room_type.id = value)
    )
  ) then
    raise exception using errcode = '22023', message = 'INVALID_ROOM_TYPE_FILTER';
  end if;

  if p_exclude_reservation_id is not null then
    select * into v_excluded
    from public.reservations reservation
    where reservation.id = p_exclude_reservation_id;
    if not found then
      raise exception using errcode = 'P0002', message = 'EXCLUDE_RESERVATION_NOT_FOUND';
    end if;
    if v_excluded.status <> 'active'
      or v_excluded.actual_check_in_at is not null
      or v_excluded.actual_checkout_at is not null
      or v_excluded.cancelled_at is not null then
      raise exception using errcode = '23514', message = 'EXCLUDE_RESERVATION_NOT_ELIGIBLE';
    end if;
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'room_id', candidate.room_id,
      'room_number', candidate.room_number,
      'room_type_id', candidate.room_type_id,
      'room_state_version', candidate.room_state_version,
      'interval_bookable', candidate.interval_bookable,
      'check_in_ready', candidate.check_in_ready,
      'reason_codes', candidate.reason_codes,
      'evaluated_at', v_evaluated_at
    ) order by candidate.room_number, candidate.room_id
  ), '[]'::jsonb)
  into v_candidates
  from (
  select
    room.id as room_id,
    room.room_number,
    room.room_type_id,
    room.state_version as room_state_version,
    not state.overlap_found and cardinality(state.interval_reasons) = 0 as interval_bookable,
    readiness.readiness_status = 'READY' as check_in_ready,
    combined.reason_codes
  from public.rooms room
  cross join lateral (
    select
      exists(
        select 1
        from private.stay_room_segments segment
        join private.reservation_stays stay on stay.id = segment.stay_id
        where segment.room_id = room.id
          and segment.retired_at is null
          and stay.status in ('scheduled', 'active')
          and segment.source_reservation_id is distinct from p_exclude_reservation_id
          and tstzrange(segment.starts_at, segment.ends_at, '[)')
            && tstzrange(p_check_in_at, p_check_out_at, '[)')
      ) as overlap_found,
      private.room_block_reason_codes(room.id, v_evaluated_at, false, false)
        || case when exists(
          select 1
          from public.room_operation_blocks block
          where block.room_id = room.id
            and block.released_at is null
            and block.starts_at < p_check_out_at
            and (block.ends_at is null or block.ends_at > p_check_in_at)
        ) and not ('OPERATION_BLOCKED' = any(
          private.room_block_reason_codes(room.id, v_evaluated_at, false, false)
        )) then array['OPERATION_BLOCKED']::text[] else array[]::text[] end
        as interval_reasons,
      private.room_block_reason_codes(room.id, v_evaluated_at, true, true)
        as readiness_base_reasons,
      private.current_pin_sync_status(room.id) as pin_status
  ) state
  cross join lateral private.room_reservation_lifecycle_at(
    room.id,
    v_evaluated_at
  ) lifecycle
  cross join lateral private.room_readiness_axes_at(
    state.readiness_base_reasons,
    state.pin_status,
    lifecycle.current_checkin_pending
  ) readiness
  cross join lateral (
    select coalesce(array_agg(item.reason order by item.first_ordinal), array[]::text[])
      as reason_codes
    from (
      select reason, min(ordinal) as first_ordinal
      from unnest(
        case when state.overlap_found
          then array['RESERVATION_OVERLAP']::text[]
          else array[]::text[] end
        || state.interval_reasons
        || readiness.readiness_reason_codes
      ) with ordinality as reasons(reason, ordinal)
      group by reason
    ) item
  ) combined
  where v_room_type_ids is null or room.room_type_id = any(v_room_type_ids)
  ) candidate;

  return jsonb_build_object(
    'evaluated_at', v_evaluated_at,
    'candidates', v_candidates
  );
end
$$;

revoke all on function public.preview_reservation_bookability(
  uuid, timestamptz, timestamptz, uuid, uuid[], text
) from public, anon, authenticated;
grant execute on function public.preview_reservation_bookability(
  uuid, timestamptz, timestamptz, uuid, uuid[], text
) to service_role;

comment on function public.preview_reservation_bookability(
  uuid, timestamptz, timestamptz, uuid, uuid[], text
) is
'Admin-only standard-reservation read preview. An omitted or empty room-type array means all room types. interval_bookable mirrors current create/change allocation blockers and canonical stay-segment overlap while check_in_ready remains a separate current readiness/PIN axis. Preview never guarantees a later commit.';

create function public.list_reservations_page(
  p_actor_profile_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_room_id uuid default null,
  p_after_check_in_at timestamptz default null,
  p_after_id uuid default null,
  p_limit integer default 50
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_server_time timestamptz := clock_timestamp();
  v_rows jsonb;
  v_has_more boolean;
begin
  perform private.assert_room_admin(p_actor_profile_id);
  if p_from is null or p_to is null
    or not isfinite(p_from) or not isfinite(p_to)
    or p_to <= p_from then
    raise exception using errcode = '22023', message = 'INVALID_RESERVATION_RANGE';
  end if;
  if p_to - p_from > interval '31 days' then
    raise exception using errcode = '22023', message = 'RESERVATION_RANGE_TOO_LARGE';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception using errcode = '22023', message = 'INVALID_RESERVATION_PAGE_SIZE';
  end if;
  if (p_after_check_in_at is null) <> (p_after_id is null) then
    raise exception using errcode = '22023', message = 'INVALID_RESERVATION_CURSOR';
  end if;

  with candidates as (
    select reservation as reservation_row,
      reservation.check_in_at as sort_check_in_at,
      reservation.id as sort_id
    from public.reservations reservation
    where reservation.check_in_at < p_to
      and reservation.check_out_at > p_from
      and (
        p_room_id is null
        or exists (
          select 1
          from private.stay_room_segments segment
          where segment.source_reservation_id = reservation.id
            and segment.room_id = p_room_id
            and tstzrange(segment.starts_at, segment.ends_at, '[)')
              && tstzrange(p_from, p_to, '[)')
        )
      )
      and (
        p_after_check_in_at is null
        or (reservation.check_in_at, reservation.id) > (p_after_check_in_at, p_after_id)
      )
    order by reservation.check_in_at, reservation.id
    limit p_limit + 1
  ), numbered as (
    select candidates.*,
      row_number() over(order by sort_check_in_at, sort_id) as row_number
    from candidates
  )
  select
    coalesce(jsonb_agg(
      jsonb_build_object(
        'id', (numbered.reservation_row).id,
        'room_id', private.reservation_projected_room_id(
          numbered.reservation_row,
          v_server_time
        ),
        'check_in_at', (numbered.reservation_row).check_in_at,
        'check_out_at', (numbered.reservation_row).check_out_at,
        'guest_count', (numbered.reservation_row).guest_count,
        'status', (numbered.reservation_row).status,
        'preparation_obligation_id', (numbered.reservation_row).preparation_obligation_id,
        'checkout_obligation_id', (numbered.reservation_row).checkout_obligation_id,
        'version', (numbered.reservation_row).version,
        'actual_check_in_at', (numbered.reservation_row).actual_check_in_at,
        'actual_checkout_at', (numbered.reservation_row).actual_checkout_at,
        'cancelled_at', (numbered.reservation_row).cancelled_at,
        'created_at', (numbered.reservation_row).created_at,
        'updated_at', (numbered.reservation_row).updated_at
      )
      order by numbered.sort_check_in_at, numbered.sort_id
    ) filter (where numbered.row_number <= p_limit), '[]'::jsonb),
    coalesce(bool_or(numbered.row_number > p_limit), false)
  into v_rows, v_has_more
  from numbered;

  return jsonb_build_object(
    'server_time', v_server_time,
    'reservations', v_rows,
    'has_more', v_has_more
  );
end
$$;

revoke all on function public.list_reservations_page(
  uuid, timestamptz, timestamptz, uuid, timestamptz, uuid, integer
) from public, anon, authenticated;
grant execute on function public.list_reservations_page(
  uuid, timestamptz, timestamptz, uuid, timestamptz, uuid, integer
) to service_role;

comment on function public.list_reservations_page(
  uuid, timestamptz, timestamptz, uuid, timestamptz, uuid, integer
) is
'Admin-only bounded [from,to) reservation calendar projection. Stable keyset order is check_in_at ASC,id ASC; guest PII is excluded. The HTTP adapter owns the actor/filter/sort scoped opaque cursor.';
