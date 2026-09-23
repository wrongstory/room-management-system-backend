create function public.list_room_operation_blocks(
  p_actor_profile_id uuid,
  p_session_id uuid,
  p_room_id uuid,
  p_status text default 'actionable'
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

  if p_status is distinct from 'actionable' then
    raise exception using errcode = '22023', message = 'INVALID_ROOM_OPERATION_BLOCK_STATUS';
  end if;

  select room.state_version
  into v_room_version
  from public.rooms room
  where room.id = p_room_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'ROOM_NOT_FOUND';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', block.id,
    'reasonCode', block.reason_code,
    'startsAt', block.starts_at,
    'endsAt', block.ends_at,
    'status', case
      when block.starts_at > v_evaluated_at then 'scheduled'
      when block.ends_at is not null and block.ends_at <= v_evaluated_at then 'expired'
      else 'active'
    end,
    'createdAt', block.created_at
  ) order by block.starts_at desc, block.id desc), '[]'::jsonb)
  into v_items
  from public.room_operation_blocks block
  where block.room_id = p_room_id
    and block.released_at is null;

  return jsonb_build_object(
    'roomId', p_room_id,
    'roomStateVersion', v_room_version,
    'evaluatedAt', v_evaluated_at,
    'items', v_items
  );
end;
$$;

create function public.list_room_issues(
  p_actor_profile_id uuid,
  p_session_id uuid,
  p_room_id uuid,
  p_status text default 'open'
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

  if p_status is distinct from 'open' then
    raise exception using errcode = '22023', message = 'INVALID_ROOM_ISSUE_STATUS';
  end if;

  select room.state_version
  into v_room_version
  from public.rooms room
  where room.id = p_room_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'ROOM_NOT_FOUND';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', issue.id,
    'category', issue.category,
    'severity', issue.severity,
    'blocksGuestAssignment', issue.blocks_guest_assignment,
    'description', issue.description,
    'status', issue.status,
    'reportedAt', issue.reported_at
  ) order by issue.reported_at desc, issue.id desc), '[]'::jsonb)
  into v_items
  from public.room_issues issue
  where issue.room_id = p_room_id
    and issue.status = 'open';

  return jsonb_build_object(
    'roomId', p_room_id,
    'roomStateVersion', v_room_version,
    'evaluatedAt', v_evaluated_at,
    'items', v_items
  );
end;
$$;

revoke all on function public.list_room_operation_blocks(uuid, uuid, uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.list_room_issues(uuid, uuid, uuid, text)
  from public, anon, authenticated, service_role;

grant execute on function public.list_room_operation_blocks(uuid, uuid, uuid, text)
  to service_role;
grant execute on function public.list_room_issues(uuid, uuid, uuid, text)
  to service_role;

comment on function public.list_room_operation_blocks(uuid, uuid, uuid, text) is
  'Returns unreleased room operation blocks with a server-derived scheduled, active, or expired status for an active password-complete business admin live session.';
comment on function public.list_room_issues(uuid, uuid, uuid, text) is
  'Returns open room issues for an active password-complete business admin live session.';
