create function public.list_room_events(
  p_actor_profile_id uuid,
  p_session_id uuid,
  p_room_id uuid,
  p_limit integer default 30
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_evaluated_at timestamptz := clock_timestamp();
  v_room_version bigint;
  v_items jsonb;
begin
  perform private.assert_attempt_actor_session(
    p_actor_profile_id,
    p_session_id,
    true
  );

  if p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception using errcode = '22023', message = 'INVALID_ROOM_EVENT_LIMIT';
  end if;

  select room.state_version
  into v_room_version
  from public.rooms room
  where room.id = p_room_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'ROOM_NOT_FOUND';
  end if;

  select coalesce(
    jsonb_agg(event.item order by event.effective_at desc, event.recorded_at desc, event.id desc),
    '[]'::jsonb
  )
  into v_items
  from (
    select candidate.id, candidate.effective_at, candidate.recorded_at, candidate.item
    from (
      select
        audit.id,
        audit.effective_at,
        audit.recorded_at,
        jsonb_build_object(
          'id', audit.id,
          'source', 'room_command',
          'eventType', audit.event_type,
          'reasonCode', audit.reason_code,
          'effectiveAt', audit.effective_at,
          'recordedAt', audit.recorded_at,
          'reservationId', null,
          'summary', case audit.event_type
            when 'room.master_data_changed' then jsonb_strip_nulls(jsonb_build_object(
              'roomTypeId', audit.after_state -> 'roomTypeId',
              'elevatorZone', audit.after_state -> 'elevatorZone',
              'dataStatus', audit.after_state -> 'dataStatus',
              'stateVersion', audit.after_state -> 'stateVersion'
            ))
            when 'room.create_block' then jsonb_strip_nulls(jsonb_build_object(
              'blockId', audit.after_state -> 'blockId',
              'startsAt', audit.after_state -> 'startsAt',
              'endsAt', audit.after_state -> 'endsAt',
              'active', audit.after_state -> 'active'
            ))
            when 'room.release_block' then jsonb_strip_nulls(jsonb_build_object(
              'blockId', audit.after_state -> 'blockId',
              'active', audit.after_state -> 'active'
            ))
            when 'room.set_candle_count' then jsonb_strip_nulls(jsonb_build_object(
              'candleEventId', audit.after_state -> 'candleEventId',
              'count', audit.after_state -> 'count'
            ))
            when 'room.report_issue' then jsonb_strip_nulls(jsonb_build_object(
              'issueId', audit.after_state -> 'issueId',
              'category', audit.after_state -> 'category',
              'severity', audit.after_state -> 'severity',
              'blocksGuestAssignment', audit.after_state -> 'blocksGuestAssignment',
              'status', audit.after_state -> 'status'
            ))
            when 'room.resolve_issue' then jsonb_strip_nulls(jsonb_build_object(
              'issueId', audit.after_state -> 'issueId',
              'status', audit.after_state -> 'status'
            ))
            when 'room.record_pin_sync' then jsonb_strip_nulls(jsonb_build_object(
              'pinSyncEventId', audit.after_state -> 'pinSyncEventId',
              'syncStatus', audit.after_state -> 'syncStatus',
              'pinVersion', audit.after_state -> 'pinVersion'
            ))
            when 'room.pin_change_prepared' then jsonb_strip_nulls(jsonb_build_object(
              'status', audit.after_state -> 'status',
              'pinVersion', audit.after_state -> 'pinVersion'
            ))
            when 'room.pin_change_confirmed' then jsonb_strip_nulls(jsonb_build_object(
              'status', audit.after_state -> 'status',
              'pinVersion', audit.after_state -> 'pinVersion'
            ))
            when 'room.pin_mismatch_resolved' then jsonb_strip_nulls(jsonb_build_object(
              'status', audit.after_state -> 'status',
              'pinVersion', audit.after_state -> 'pinVersion'
            ))
            else '{}'::jsonb
          end
        ) as item
      from public.audit_events audit
      where audit.entity_type = 'room'
        and audit.entity_id = p_room_id
        and audit.event_type = any(array[
          'room.master_data_changed',
          'room.create_block',
          'room.release_block',
          'room.set_candle_count',
          'room.report_issue',
          'room.resolve_issue',
          'room.record_pin_sync',
          'room.pin_change_prepared',
          'room.pin_change_confirmed',
          'room.pin_mismatch_resolved'
        ]::text[])

      union all

      select
        occupancy.id,
        occupancy.effective_at,
        occupancy.recorded_at,
        jsonb_build_object(
          'id', occupancy.id,
          'source', 'occupancy',
          'eventType', occupancy.event_type,
          'reasonCode', occupancy.reason_code,
          'effectiveAt', occupancy.effective_at,
          'recordedAt', occupancy.recorded_at,
          'reservationId', occupancy.reservation_id,
          'summary', jsonb_strip_nulls(jsonb_build_object(
            'occupiedBefore', occupancy.before_state -> 'occupied',
            'occupiedAfter', occupancy.after_state -> 'occupied'
          ))
        ) as item
      from public.room_occupancy_events occupancy
      where occupancy.room_id = p_room_id
    ) candidate
    order by candidate.effective_at desc, candidate.recorded_at desc, candidate.id desc
    limit p_limit
  ) event;

  return jsonb_build_object(
    'roomId', p_room_id,
    'roomStateVersion', v_room_version,
    'evaluatedAt', v_evaluated_at,
    'items', v_items
  );
end;
$$;

revoke all on function public.list_room_events(uuid, uuid, uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.list_room_events(uuid, uuid, uuid, integer)
  to service_role;

comment on function public.list_room_events(uuid, uuid, uuid, integer) is
  'Returns up to 50 latest safe room command and actual occupancy events for an active password-complete business admin live session.';
