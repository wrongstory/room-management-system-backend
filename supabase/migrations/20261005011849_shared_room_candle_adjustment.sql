-- #330: a narrow room capability, independent of assignment/submission lifetime.
-- Existing event rows, RLS, generic admin commands and snapshots are unchanged.
create function private.assert_room_candle_actor(p_actor uuid, p_session uuid)
returns public.profiles language plpgsql security definer set search_path = '' as $$
declare actor public.profiles%rowtype;
begin
  select * into actor from public.profiles where id = p_actor for share;
  if not found or actor.status <> 'active' or actor.role not in ('admin', 'maid') then
    raise exception using errcode = '42501', message = 'CANDLE_ACCESS_REQUIRED';
  end if;
  if actor.must_change_password then
    raise exception using errcode = '42501', message = 'PASSWORD_CHANGE_REQUIRED';
  end if;
  perform 1 from auth.sessions where id = p_session and user_id = actor.auth_user_id
    and (not_after is null or not_after > clock_timestamp()) for share;
  if not found then raise exception using errcode = '42501', message = 'SESSION_REVOKED'; end if;
  return actor;
end $$;
revoke all on function private.assert_room_candle_actor(uuid,uuid) from public,anon,authenticated,service_role;

-- All old/new writers already serialize on the room; stamp recording order AFTER
-- that lock, not at transaction start. Never rewrite historical timestamps.
create function private.order_room_candle_event()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.rooms where id = new.room_id for update;
  select greatest(clock_timestamp(), max(recorded_at) + interval '1 microsecond')
    into new.recorded_at from public.room_candle_events where room_id = new.room_id;
  return new;
end $$;
revoke all on function private.order_room_candle_event() from public,anon,authenticated,service_role;
create trigger room_candle_event_recording_order before insert on public.room_candle_events
  for each row execute function private.order_room_candle_event();

create function public.list_room_candles(
  p_actor_profile_id uuid, p_session_id uuid, p_room_id uuid default null,
  p_after_room_id uuid default null, p_limit integer default 50
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare items jsonb; next_cursor uuid;
begin
  perform private.assert_room_candle_actor(p_actor_profile_id,p_session_id);
  if p_limit is null or p_limit < 1 or p_limit > 50 or (p_room_id is not null and p_after_room_id is not null) then
    raise exception using errcode = '22023', message = 'INVALID_CANDLE_REQUEST';
  end if;
  with candidates as materialized (
    select r.id, r.room_number, r.state_version, private.current_candle_count(r.id) as count
    from public.rooms r
    where (p_room_id is null or r.id = p_room_id)
      and (p_after_room_id is null or r.id > p_after_room_id)
    order by r.id limit p_limit + 1
  ), page as (select * from candidates order by id limit p_limit)
  select coalesce(jsonb_agg(jsonb_build_object(
    'roomId',id,'roomNumber',room_number,'count',count,'roomStateVersion',state_version
  ) order by id),'[]'::jsonb),
    case when (select count(*) from candidates) > p_limit then (select id from page order by id desc limit 1) end
  into items, next_cursor from page;
  return jsonb_build_object('items',items,'nextCursor',next_cursor);
end $$;
revoke all on function public.list_room_candles(uuid,uuid,uuid,uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.list_room_candles(uuid,uuid,uuid,uuid,integer) to service_role;

create function public.set_room_candle_count(
  p_actor_profile_id uuid, p_session_id uuid, p_room_id uuid,
  p_expected_room_version bigint, p_reason_code text, p_payload jsonb,
  p_idempotency_key text, p_request_hash text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor public.profiles%rowtype;
  room public.rooms%rowtype;
  event public.room_candle_events%rowtype;
  response jsonb;
  count_after integer;
  verified boolean;
begin
  -- Match the existing admin receipt namespace/hash, including pre-upgrade replay.
  response := private.replay_command(p_actor_profile_id,'room.operation.set_candle_count',p_idempotency_key,p_request_hash);
  actor := private.assert_room_candle_actor(p_actor_profile_id,p_session_id);
  if response is not null then return response; end if;
  if p_expected_room_version is null or p_expected_room_version < 1 or p_expected_room_version > 9007199254740991
    or p_reason_code is null or p_reason_code !~ '^[A-Z0-9_]{2,80}$'
    or p_payload is null or jsonb_typeof(p_payload) <> 'object'
    or p_payload - array['count','physicallyVerified','entityId'] <> '{}'::jsonb
    or jsonb_typeof(p_payload->'count') is distinct from 'number'
    or (p_payload->>'count') !~ '^[0-9]+$'
    or (p_payload->>'count')::numeric > 2147483647
    or (p_payload ? 'physicallyVerified' and jsonb_typeof(p_payload->'physicallyVerified') <> 'boolean') then
    raise exception using errcode = '22023', message = 'INVALID_CANDLE_REQUEST';
  end if;
  count_after := (p_payload->>'count')::integer;
  verified := coalesce((p_payload->>'physicallyVerified')::boolean,false);
  select * into room from public.rooms where id = p_room_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'ROOM_NOT_FOUND'; end if;
  if room.state_version <> p_expected_room_version then
    raise exception using errcode = '40001', message = 'STALE_VERSION';
  end if;
  if count_after < private.current_candle_count(p_room_id) and not verified then
    raise exception using errcode = '22023', message = 'CANDLE_VERIFICATION_REQUIRED';
  end if;
  insert into public.room_candle_events(id,room_id,count_before,count_after,physically_verified,reason_code,actor_profile_id,effective_at)
  values(coalesce((p_payload->>'entityId')::uuid,gen_random_uuid()),p_room_id,private.current_candle_count(p_room_id),
    count_after,verified,p_reason_code,actor.id,clock_timestamp()) returning * into event;
  update public.rooms set state_version = state_version + 1 where id = p_room_id returning * into room;
  response := jsonb_build_object('entity_id',event.id,'room_id',room.id,'room_state_version',room.state_version,
    'recorded_at',event.recorded_at,'candleEventId',event.id,'count',event.count_after);
  insert into public.audit_events(actor_profile_id,actor_display_name_snapshot,event_type,entity_type,entity_id,
    effective_at,reason_code,before_state,after_state,request_hash,idempotency_key)
  values(actor.id,actor.display_name,'room.set_candle_count','room',room.id,event.effective_at,p_reason_code,
    jsonb_build_object('count',event.count_before),jsonb_build_object('candleEventId',event.id,'count',event.count_after),
    p_request_hash,private.audit_command_key(actor.id,'room.operation.set_candle_count',p_idempotency_key));
  perform private.complete_command(actor.id,'room.operation.set_candle_count',p_idempotency_key,p_request_hash,room.id,response);
  return response;
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception using errcode = '22023', message = 'INVALID_CANDLE_REQUEST';
end $$;
revoke all on function public.set_room_candle_count(uuid,uuid,uuid,bigint,text,jsonb,text,text) from public,anon,authenticated,service_role;
grant execute on function public.set_room_candle_count(uuid,uuid,uuid,bigint,text,jsonb,text,text) to service_role;
