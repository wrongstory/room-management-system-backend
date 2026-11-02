-- #551: persistent room guidance, never a scheduling rule or assignment snapshot.
create table private.room_fixed_memo_revisions (
  room_id uuid not null references public.rooms(id) on delete restrict,
  revision bigint not null check (revision between 1 and 9007199254740991),
  memo text check (memo is null or char_length(memo) between 1 and 500),
  actor_profile_id uuid not null references public.profiles(id) on delete restrict,
  recorded_at timestamptz not null default clock_timestamp(),
  primary key(room_id,revision)
);
create index room_fixed_memo_actor_idx on private.room_fixed_memo_revisions(actor_profile_id);
alter table private.room_fixed_memo_revisions enable row level security;
revoke all on private.room_fixed_memo_revisions from public,anon,authenticated,service_role;

create function private.guard_room_fixed_memo_revision()
returns trigger language plpgsql set search_path='' as $$
begin
  raise exception using errcode='23514',message='ROOM_FIXED_MEMO_IMMUTABLE';
end $$;
revoke all on function private.guard_room_fixed_memo_revision() from public,anon,authenticated,service_role;
create trigger room_fixed_memo_immutable before update or delete on private.room_fixed_memo_revisions
for each row execute function private.guard_room_fixed_memo_revision();

create function private.room_fixed_memo_projection(p_room_id uuid)
returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('roomId',p_room_id,'memo',m.memo,
    'version',coalesce(m.revision,0),'updatedAt',m.recorded_at)
  from (select 1) base left join lateral (
    select memo,revision,recorded_at from private.room_fixed_memo_revisions
    where room_id=p_room_id order by revision desc limit 1
  ) m on true
$$;
revoke all on function private.room_fixed_memo_projection(uuid) from public,anon,authenticated,service_role;

create function public.get_room_fixed_memo(p_actor_profile_id uuid,p_session_id uuid,p_room_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare actor public.profiles;
begin
  select * into actor from public.profiles where id=p_actor_profile_id;
  if actor.id is null or actor.status<>'active' or actor.role not in ('admin','maid') then
    raise exception using errcode='42501',message='ROOM_FIXED_MEMO_FORBIDDEN'; end if;
  perform private.assert_attempt_actor_session(p_actor_profile_id,p_session_id,actor.role='admin');
  if actor.role='maid' and not exists (
    select 1 from public.cleaning_assignments a
    join public.cleaning_targets t on t.id=a.cleaning_target_id
    where a.maid_profile_id=actor.id and a.is_current and a.ended_at is null
      and a.notified_at is not null and a.revision=t.assignment_version
      and a.notified_room_id_snapshot=t.room_id and t.room_id=p_room_id
      and t.status in ('notified','in_progress','upload_pending','inspection_pending','approved','rejected')
      -- This helper checks exact typed notification/outbox provenance only, not PIN state.
      and exists(select 1 from private.pin_assignment_outbox_evidence(a.id))
  ) then raise exception using errcode='42501',message='ROOM_FIXED_MEMO_FORBIDDEN'; end if;
  if not exists(select 1 from public.rooms where id=p_room_id) then
    raise exception using errcode='P0002',message='ROOM_NOT_FOUND'; end if;
  return private.room_fixed_memo_projection(p_room_id);
end $$;
revoke all on function public.get_room_fixed_memo(uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_room_fixed_memo(uuid,uuid,uuid) to service_role;

create function public.set_room_fixed_memo(p_actor_profile_id uuid,p_session_id uuid,p_room_id uuid,
  p_expected_version bigint,p_memo text,p_idempotency_key text,p_request_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; response jsonb; current_version bigint; normalized text;
begin
  -- Validate authority even for a replay; repeat after receipt/room waits.
  actor:=private.assert_attempt_actor_session_fresh(p_actor_profile_id,p_session_id,true);
  response:=private.replay_command(p_actor_profile_id,'room.fixed_memo.set',p_idempotency_key,p_request_hash);
  actor:=private.assert_attempt_actor_session_fresh(p_actor_profile_id,p_session_id,true);
  if response is not null then return response; end if;
  if p_expected_version is null or p_expected_version not between 0 and 9007199254740990 then
    raise exception using errcode='22023',message='ROOM_FIXED_MEMO_INVALID'; end if;
  begin normalized:=private.normalize_assignment_instruction(p_memo);
  exception when invalid_parameter_value then
    raise exception using errcode='22023',message='ROOM_FIXED_MEMO_INVALID'; end;
  perform 1 from public.rooms where id=p_room_id for update;
  if not found then raise exception using errcode='P0002',message='ROOM_NOT_FOUND'; end if;
  actor:=private.assert_attempt_actor_session_fresh(p_actor_profile_id,p_session_id,true);
  select coalesce(max(revision),0) into current_version from private.room_fixed_memo_revisions where room_id=p_room_id;
  if current_version<>p_expected_version then raise exception using errcode='40001',message='STALE_VERSION'; end if;
  insert into private.room_fixed_memo_revisions(room_id,revision,memo,actor_profile_id)
  values(p_room_id,current_version+1,normalized,actor.id);
  response:=private.room_fixed_memo_projection(p_room_id);
  insert into public.audit_events(actor_profile_id,actor_display_name_snapshot,event_type,entity_type,entity_id,
    effective_at,reason_code,before_state,after_state,request_hash,idempotency_key)
  values(actor.id,actor.display_name,'room.fixed_memo_changed','room',p_room_id,
    clock_timestamp(),'ADMIN_ROOM_FIXED_MEMO',jsonb_build_object('version',current_version),
    jsonb_build_object('version',current_version+1,'cleared',normalized is null),
    p_request_hash,private.audit_command_key(actor.id,'room.fixed_memo.set',p_idempotency_key));
  perform private.complete_command(actor.id,'room.fixed_memo.set',p_idempotency_key,p_request_hash,p_room_id,response);
  return response;
end $$;
revoke all on function public.set_room_fixed_memo(uuid,uuid,uuid,bigint,text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.set_room_fixed_memo(uuid,uuid,uuid,bigint,text,text,text) to service_role;

alter function private.operation_http_route(text) rename to operation_http_route_before_room_fixed_memo;
revoke all on function private.operation_http_route_before_room_fixed_memo(text) from public,anon,authenticated,service_role;
create function private.operation_http_route(p_route text)
returns jsonb language sql immutable set search_path='' as $$
  select case when p_route='setRoomFixedMemo' then jsonb_build_object(
    'routeId','setRoomFixedMemo','kind','BUSINESS_WRITE','authority','ACTIVE_SESSION',
    'hashMode','CALLER','commandName','room.fixed_memo.set','keyArgument','p_idempotency_key')
  else private.operation_http_route_before_room_fixed_memo(p_route) end
$$;
revoke all on function private.operation_http_route(text) from public,anon,authenticated,service_role;
