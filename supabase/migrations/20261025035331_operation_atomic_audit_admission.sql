-- #396: finite same-transaction audit/read-state effects. No caller SQL or generic dispatch.
-- This is not a lifecycle initializer, reset endpoint or proof of all-path coverage.
create function public.execute_operation_atomic_rpc(
  p_target text, p_version bigint, p_nonce text, p_deadline timestamptz,
  p_rpc_name text, p_args jsonb
) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog
set lock_timeout='2s' set statement_timeout='7s' as $$
declare
  v_control private.developer_operation_control;
  v_id uuid; v_owner text; v_result jsonb; v_required text[]; v_optional text[];
  v_occurred_at timestamptz;
begin
  if p_target is null or p_target !~ '^[a-z0-9][a-z0-9-]{2,63}$'
    or p_nonce is null or p_nonce !~ '^[a-f0-9]{64}$'
    or p_deadline is null or not isfinite(p_deadline) or p_deadline<=clock_timestamp()
    or p_args is null or jsonb_typeof(p_args)<>'object' or pg_column_size(p_args)>8192 then
    raise exception using errcode='22023',message='OPERATION_ATOMIC_RPC_REJECTED';
  end if;
  case p_rpc_name
    when 'record_actor_activity_event' then
      v_required:=array['p_actor_profile_id','p_event_type','p_outcome','p_source','p_request_id'];
      v_optional:=array['p_reason_code','p_resource_type','p_resource_id','p_occurred_at'];
    when 'record_unknown_login_failure' then
      v_required:='{}'; v_optional:=array['p_occurred_at'];
    when 'record_authorization_denial' then
      v_required:=array['p_actor_profile_id','p_source','p_reason_code']; v_optional:=array['p_occurred_at'];
    when 'mark_notification_read' then
      v_required:=array['p_actor_profile_id','p_session_id','p_notification_id']; v_optional:='{}';
    else raise exception using errcode='22023',message='OPERATION_ATOMIC_RPC_REJECTED';
  end case;
  if not(p_args ?& v_required) or exists(select 1 from jsonb_object_keys(p_args) as keys(key) where not(key=any(v_required||v_optional)))
    or exists(select 1 from jsonb_each(p_args) e where jsonb_typeof(e.value) not in ('string','null')) then
    raise exception using errcode='22023',message='OPERATION_ATOMIC_RPC_REJECTED';
  end if;
  -- This row lock is held through the original effect and completed receipt.
  -- Failure rolls back both; a lost HTTP response never requires a separate finish.
  select * into v_control from private.developer_operation_control where singleton for update;
  if not found then
    if p_version is not null then raise exception using errcode='42501',message='OPERATION_CONTROL_UNAVAILABLE'; end if;
  else
    if v_control.target_ref is distinct from p_target or v_control.version is distinct from p_version
      or v_control.lifecycle='UNKNOWN' or v_control.maintenance<>'OPEN' then
      raise exception using errcode='42501',message='OPERATION_CONTROL_UNAVAILABLE';
    end if;
    v_owner:=private.operation_secret_digest('atomic-rpc:'||p_rpc_name||':'||coalesce(p_args->>'p_actor_profile_id','unknown'));
    v_id:=private.acquire_developer_operation_admission(p_target,p_version,'BUSINESS_WRITE',v_owner,p_nonce,p_deadline);
  end if;
  -- Missing optional occurredAt keeps the existing DB clock default. Explicit
  -- null stays null so the original audit validation still rejects it.
  if p_rpc_name<>'mark_notification_read' then
    v_occurred_at:=case when p_args ? 'p_occurred_at' then (p_args->>'p_occurred_at')::timestamptz else clock_timestamp() end;
  end if;
  case p_rpc_name
    when 'record_actor_activity_event' then
      v_result:=to_jsonb(public.record_actor_activity_event((p_args->>'p_actor_profile_id')::uuid,
        p_args->>'p_event_type',p_args->>'p_outcome',p_args->>'p_source',p_args->>'p_request_id',
        p_args->>'p_reason_code',p_args->>'p_resource_type',(p_args->>'p_resource_id')::uuid,v_occurred_at));
    when 'record_unknown_login_failure' then
      perform public.record_unknown_login_failure(v_occurred_at); v_result:='null'::jsonb;
    when 'record_authorization_denial' then
      perform public.record_authorization_denial((p_args->>'p_actor_profile_id')::uuid,p_args->>'p_source',p_args->>'p_reason_code',v_occurred_at);
      v_result:='null'::jsonb;
    when 'mark_notification_read' then
      v_result:=public.mark_notification_read((p_args->>'p_actor_profile_id')::uuid,
        (p_args->>'p_session_id')::uuid,(p_args->>'p_notification_id')::uuid);
  end case;
  if v_id is not null then perform private.complete_developer_operation_admission(v_id,v_owner,p_nonce); end if;
  return jsonb_build_object('result',v_result);
end
$$;
alter function public.execute_operation_atomic_rpc(text,bigint,text,timestamptz,text,jsonb) owner to postgres;
revoke all on function public.execute_operation_atomic_rpc(text,bigint,text,timestamptz,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.execute_operation_atomic_rpc(text,bigint,text,timestamptz,text,jsonb) to service_role;
