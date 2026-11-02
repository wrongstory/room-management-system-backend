-- #577: admin catalog fee only; existing targets and earnings stay immutable.
create function public.set_room_type_cleaning_fee(
  p_actor_profile_id uuid,p_session_id uuid,p_room_type_id uuid,
  p_expected_version bigint,p_base_cleaning_fee integer,p_confirm_future_targets_only boolean,
  p_idempotency_key text,p_request_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; item public.room_types; response jsonb; old_fee integer; old_version bigint;
begin
  actor:=private.assert_attempt_actor_session_fresh(p_actor_profile_id,p_session_id,true);
  response:=private.replay_command(actor.id,'room_type.cleaning_fee.set',p_idempotency_key,p_request_hash);
  actor:=private.assert_attempt_actor_session_fresh(p_actor_profile_id,p_session_id,true);
  if response is not null then return response; end if;
  -- earnings.total_amount is integer and an approved bomb bonus equals base fee.
  if p_base_cleaning_fee is null or p_base_cleaning_fee not between 0 and 1073741823
    or p_expected_version is null or p_expected_version not between 1 and 9007199254740990
    or p_confirm_future_targets_only is distinct from true then
    raise exception using errcode='22023',message='ROOM_TYPE_CLEANING_FEE_INVALID'; end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into item from public.room_types where id=p_room_type_id for update;
  if not found then raise exception using errcode='P0002',message='ROOM_TYPE_NOT_FOUND'; end if;
  actor:=private.assert_attempt_actor_session_fresh(p_actor_profile_id,p_session_id,true);
  if item.version<>p_expected_version then raise exception using errcode='40001',message='STALE_VERSION'; end if;
  old_fee:=item.base_cleaning_fee; old_version:=item.version;
  if old_fee<>p_base_cleaning_fee then
    update public.room_types set base_cleaning_fee=p_base_cleaning_fee where id=item.id returning * into item;
    insert into public.audit_events(actor_profile_id,actor_display_name_snapshot,event_type,entity_type,entity_id,
      effective_at,reason_code,before_state,after_state,request_hash,idempotency_key)
    values(actor.id,actor.display_name,'room_type.cleaning_fee_changed','room_type',item.id,
      clock_timestamp(),'ADMIN_ROOM_TYPE_CLEANING_FEE',
      jsonb_build_object('baseCleaningFee',old_fee,'version',old_version),
      jsonb_build_object('baseCleaningFee',item.base_cleaning_fee,'version',item.version,'effectiveFor','NEW_TARGETS_ONLY'),
      p_request_hash,private.audit_command_key(actor.id,'room_type.cleaning_fee.set',p_idempotency_key));
  end if;
  response:=jsonb_build_object('roomTypeId',item.id,'baseCleaningFee',item.base_cleaning_fee,
    'version',item.version,'effectiveFor','NEW_TARGETS_ONLY');
  perform private.complete_command(actor.id,'room_type.cleaning_fee.set',p_idempotency_key,p_request_hash,item.id,response);
  return response;
end $$;
revoke all on function public.set_room_type_cleaning_fee(uuid,uuid,uuid,bigint,integer,boolean,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.set_room_type_cleaning_fee(uuid,uuid,uuid,bigint,integer,boolean,text,text) to service_role;

alter function private.operation_http_route(text) rename to operation_http_route_before_room_type_fee;
revoke all on function private.operation_http_route_before_room_type_fee(text) from public,anon,authenticated,service_role;
create function private.operation_http_route(p_route text)
returns jsonb language sql immutable set search_path='' as $$
  select case when p_route='setRoomTypeCleaningFee' then jsonb_build_object(
    'routeId','setRoomTypeCleaningFee','kind','BUSINESS_WRITE','authority','ACTIVE_SESSION',
    'hashMode','CALLER','commandName','room_type.cleaning_fee.set','keyArgument','p_idempotency_key')
  else private.operation_http_route_before_room_type_fee(p_route) end
$$;
revoke all on function private.operation_http_route(text) from public,anon,authenticated,service_role;
