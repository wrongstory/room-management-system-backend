create index if not exists room_operation_blocks_page_idx
on public.room_operation_blocks (room_id, starts_at desc, id desc)
where released_at is null;

create index if not exists room_issues_page_idx
on public.room_issues (room_id, reported_at desc, id desc)
where status = 'open';

create function public.list_room_operation_blocks_page(
  p_actor_profile_id uuid,
  p_session_id uuid,
  p_room_id uuid,
  p_status text,
  p_limit integer,
  p_cursor_at timestamptz default null,
  p_cursor_id uuid default null
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
  v_has_more boolean;
  v_next_cursor jsonb;
begin
  perform private.assert_attempt_actor_session(
    p_actor_profile_id,
    p_session_id,
    true
  );

  if p_status is distinct from 'actionable' then
    raise exception using errcode = '22023', message = 'INVALID_ROOM_OPERATION_BLOCK_STATUS';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception using errcode = '22023', message = 'ROOM_OPERATION_PAGE_LIMIT_INVALID';
  end if;
  if (p_cursor_at is null) <> (p_cursor_id is null) then
    raise exception using errcode = '22023', message = 'INVALID_ROOM_OPERATION_CURSOR';
  end if;

  select room.state_version
  into v_room_version
  from public.rooms room
  where room.id = p_room_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'ROOM_NOT_FOUND';
  end if;

  with selected as (
    select
      block.id,
      block.reason_code,
      block.starts_at,
      block.ends_at,
      block.created_at
    from public.room_operation_blocks block
    where block.room_id = p_room_id
      and block.released_at is null
      and (
        p_cursor_at is null
        or (block.starts_at, block.id) < (p_cursor_at, p_cursor_id)
      )
    order by block.starts_at desc, block.id desc
    limit p_limit + 1
  ), numbered as (
    select selected.*, row_number() over (order by starts_at desc, id desc) as row_number
    from selected
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'id', numbered.id,
      'reasonCode', numbered.reason_code,
      'startsAt', numbered.starts_at,
      'endsAt', numbered.ends_at,
      'status', case
        when numbered.starts_at > v_evaluated_at then 'scheduled'
        when numbered.ends_at is not null and numbered.ends_at <= v_evaluated_at then 'expired'
        else 'active'
      end,
      'createdAt', numbered.created_at
    ) order by numbered.starts_at desc, numbered.id desc)
      filter (where numbered.row_number <= p_limit), '[]'::jsonb),
    count(*) > p_limit,
    (jsonb_agg(jsonb_build_object(
      'occurredAt', numbered.starts_at,
      'id', numbered.id
    )) filter (where numbered.row_number = p_limit))->0
  into v_items, v_has_more, v_next_cursor
  from numbered;

  return jsonb_build_object(
    'roomId', p_room_id,
    'roomStateVersion', v_room_version,
    'evaluatedAt', v_evaluated_at,
    'items', v_items,
    'hasMore', v_has_more,
    'nextCursor', case when v_has_more then v_next_cursor else null end
  );
end;
$$;

create function public.list_room_issues_page(
  p_actor_profile_id uuid,
  p_session_id uuid,
  p_room_id uuid,
  p_status text,
  p_limit integer,
  p_cursor_at timestamptz default null,
  p_cursor_id uuid default null
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
  v_has_more boolean;
  v_next_cursor jsonb;
begin
  perform private.assert_attempt_actor_session(
    p_actor_profile_id,
    p_session_id,
    true
  );

  if p_status is distinct from 'open' then
    raise exception using errcode = '22023', message = 'INVALID_ROOM_ISSUE_STATUS';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception using errcode = '22023', message = 'ROOM_OPERATION_PAGE_LIMIT_INVALID';
  end if;
  if (p_cursor_at is null) <> (p_cursor_id is null) then
    raise exception using errcode = '22023', message = 'INVALID_ROOM_OPERATION_CURSOR';
  end if;

  select room.state_version
  into v_room_version
  from public.rooms room
  where room.id = p_room_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'ROOM_NOT_FOUND';
  end if;

  with selected as (
    select
      issue.id,
      issue.category,
      issue.severity,
      issue.blocks_guest_assignment,
      issue.description,
      issue.status,
      issue.reported_at
    from public.room_issues issue
    where issue.room_id = p_room_id
      and issue.status = 'open'
      and (
        p_cursor_at is null
        or (issue.reported_at, issue.id) < (p_cursor_at, p_cursor_id)
      )
    order by issue.reported_at desc, issue.id desc
    limit p_limit + 1
  ), numbered as (
    select selected.*, row_number() over (order by reported_at desc, id desc) as row_number
    from selected
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'id', numbered.id,
      'category', numbered.category,
      'severity', numbered.severity,
      'blocksGuestAssignment', numbered.blocks_guest_assignment,
      'description', numbered.description,
      'status', numbered.status,
      'reportedAt', numbered.reported_at
    ) order by numbered.reported_at desc, numbered.id desc)
      filter (where numbered.row_number <= p_limit), '[]'::jsonb),
    count(*) > p_limit,
    (jsonb_agg(jsonb_build_object(
      'occurredAt', numbered.reported_at,
      'id', numbered.id
    )) filter (where numbered.row_number = p_limit))->0
  into v_items, v_has_more, v_next_cursor
  from numbered;

  return jsonb_build_object(
    'roomId', p_room_id,
    'roomStateVersion', v_room_version,
    'evaluatedAt', v_evaluated_at,
    'items', v_items,
    'hasMore', v_has_more,
    'nextCursor', case when v_has_more then v_next_cursor else null end
  );
end;
$$;

revoke all on function public.list_room_operation_blocks_page(uuid, uuid, uuid, text, integer, timestamptz, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.list_room_issues_page(uuid, uuid, uuid, text, integer, timestamptz, uuid)
  from public, anon, authenticated, service_role;

grant execute on function public.list_room_operation_blocks_page(uuid, uuid, uuid, text, integer, timestamptz, uuid)
  to service_role;
grant execute on function public.list_room_issues_page(uuid, uuid, uuid, text, integer, timestamptz, uuid)
  to service_role;

comment on function public.list_room_operation_blocks_page(uuid, uuid, uuid, text, integer, timestamptz, uuid) is
  'Returns one bounded keyset page of unreleased room operation blocks for an active password-complete business admin live session.';
comment on function public.list_room_issues_page(uuid, uuid, uuid, text, integer, timestamptz, uuid) is
  'Returns one bounded keyset page of open room issues for an active password-complete business admin live session.';
