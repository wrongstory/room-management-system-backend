-- #548: additive, read-only arrival facts. No reservation/occupancy backfill.
create function public.get_room_board_arrival_projection(
  p_actor_profile_id uuid,
  p_session_id uuid,
  p_service_date date,
  p_room_id uuid default null
) returns setof jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  board record;
  reservation public.reservations;
  result jsonb;
  arrival_status text;
  checkin_reasons text[];
  checkin_ready boolean;
begin
  -- Explicit check also covers an empty catalog. The underlying projection
  -- repeats its existing live-session/role checks without broadening access.
  perform private.assert_attempt_actor_session(p_actor_profile_id, p_session_id, true);
  for board in select * from public.get_room_board_projection(
    p_actor_profile_id, p_session_id, p_service_date, p_room_id
  ) loop
    result := to_jsonb(board);
    if board.projection_mode <> 'LIVE' then
      -- Current preparation rows cannot prove historical readiness.
      return next result || jsonb_build_object('arrival', null);
      continue;
    end if;
    select * into reservation from public.reservations r
    where r.id = board.display_reservation_id
      and r.status = 'active' and r.actual_checkout_at is null;
    arrival_status := 'NONE';
    checkin_reasons := null;
    checkin_ready := null;
    if reservation.id is not null then
      if reservation.actual_check_in_at is not null
        and board.display_check_in_at > board.evaluated_at then
        arrival_status := 'ROOM_MOVE_PENDING';
      elsif reservation.actual_check_in_at is not null then
        arrival_status := 'CHECKED_IN';
      elsif board.display_check_in_at > board.evaluated_at then
        arrival_status := 'SCHEDULED';
      else
        arrival_status := 'CHECKIN_PENDING';
      end if;
      if arrival_status in ('SCHEDULED', 'CHECKIN_PENDING')
        and (board.display_check_in_at at time zone 'Asia/Seoul')::date <= board.service_date then
        -- Exactly the scheduler's current readiness predicate, including the
        -- reservation-specific preparation proof, PIN and checkout incidents.
        checkin_reasons := private.room_block_reason_codes(
          board.id, board.evaluated_at, true, true, reservation.id
        );
        checkin_ready := cardinality(checkin_reasons) = 0;
        if not checkin_ready then
          -- Keep planned occupancy/cleaning axes intact, but do not advertise
          -- READY when this reservation cannot actually check in.
          result := result || jsonb_build_object(
            'allocation_ready', false,
            'readiness_status', case
              when checkin_reasons <@ array['CLEANING_REQUIRED']::text[]
                then 'CLEANING_REQUIRED' else 'CHECKIN_BLOCKED' end
          );
        end if;
      end if;
    end if;
    return next result || jsonb_build_object('arrival', jsonb_build_object(
      'status', arrival_status,
      'checkInReady', checkin_ready,
      'reasonCodes', checkin_reasons,
      'actualCheckInAt', reservation.actual_check_in_at,
      'recordedAt', reservation.created_at
    ));
  end loop;
end
$$;
revoke all on function public.get_room_board_arrival_projection(uuid,uuid,date,uuid)
  from public, anon, authenticated;
grant execute on function public.get_room_board_arrival_projection(uuid,uuid,date,uuid)
  to service_role;
comment on function public.get_room_board_arrival_projection(uuid,uuid,date,uuid) is
  'Admin live-session room board with separate actual arrival and registration facts. Historical arrival facts are unknown. Read only; no implicit check-in, approval or retroactive event writes.';
