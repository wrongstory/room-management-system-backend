-- #396: one existing HTTP route, exactly its three public lifecycle actions.
-- Source130 remains byte-identical. No lifecycle business function, activation,
-- seed, reset, deletion or expiry-as-completion behavior changes here.
create function public.acquire_operation_lifecycle_admission(
  p_target text,p_version bigint,p_actor uuid,p_auth uuid,p_session text,
  p_nonce text,p_deadline timestamptz,p_action text,p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql volatile security definer set search_path = pg_catalog
set lock_timeout = '2s' set statement_timeout = '7s' as $$
declare v_result jsonb; v_route jsonb; v_command text; v_id uuid;
  v_profile public.profiles; v_password text;
begin
  v_command := case p_action
    when 'allow_finish' then 'cleaning.lifecycle.allow_finish'
    when 'allow_upload' then 'cleaning.lifecycle.allow_upload'
    when 'interrupt_handover' then 'cleaning.lifecycle.interrupt_handover'
    else null end;
  if v_command is null or p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,128}$'
    or p_request_hash is null or p_request_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode='22023',message='OPERATION_COMMAND_BINDING_REJECTED';
  end if;
  v_route := private.operation_http_route('manageAttemptLifecycle');
  if v_route is distinct from jsonb_build_object('routeId','manageAttemptLifecycle',
      'kind','BUSINESS_WRITE','authority','ACTIVE_SESSION','hashMode','NONE',
      'commandName',null,'keyArgument','p_idempotency_key') then
    raise exception using errcode='42501',message='OPERATION_IDENTITY_REJECTED';
  end if;
  perform private.assert_operation_http_identity(v_route,p_actor,p_auth,p_session);
  select * into v_profile from private.assert_attempt_actor_session_fresh(p_actor,p_session::uuid,true);
  if v_profile.auth_user_id is distinct from p_auth then
    raise exception using errcode='42501',message='OPERATION_IDENTITY_REJECTED';
  end if;
  -- The source130 acquire serializes against REQUESTED under the control lock
  -- and binds owner/nonce/actor/session/password before any business effect.
  v_result := public.acquire_operation_http_admission(p_target,p_version,'manageAttemptLifecycle',
    p_actor,p_auth,p_session,p_nonce,p_deadline,null,null,null,null);
  v_id := (v_result->>'admissionId')::uuid;
  -- Opaque creation and exact receipt binding are one transaction: no committed
  -- intermediate row can be observed or completed. No raw key or action payload.
  update private.developer_operation_admissions
    set http_command_name=v_command,http_key_digest=private.operation_secret_digest(p_idempotency_key),
      http_request_hash=p_request_hash
    where id=v_id and http_route_id='manageAttemptLifecycle' and completed_at is null
      and http_actor_profile_id=p_actor and http_auth_user_id=p_auth
      and http_session_digest=private.operation_secret_digest(p_session)
      and nonce_hash=private.operation_secret_digest(p_nonce)
      and http_command_name is null and http_key_digest is null and http_request_hash is null
    returning http_password_version into v_password;
  if not found or v_password is null then
    raise exception using errcode='42501',message='OPERATION_IDENTITY_REJECTED';
  end if;
  perform private.assert_operation_http_identity(v_route,p_actor,p_auth,p_session);
  select * into v_profile from private.assert_attempt_actor_session_fresh(p_actor,p_session::uuid,true);
  if v_profile.auth_user_id is distinct from p_auth
    or v_password is distinct from public.get_auth_password_version(p_auth) then
    raise exception using errcode='42501',message='OPERATION_IDENTITY_REJECTED';
  end if;
  -- Completion stays in source130: exact immutable actor/command/key/hash and
  -- current session/password, never a successful HTTP response or lease expiry.
  return jsonb_build_object('admissionId',v_id,'controlVersion',p_version::text,
    'completionMode','COMMAND_RECEIPT');
end;
$$;
revoke all on function public.acquire_operation_lifecycle_admission(
  text,bigint,uuid,uuid,text,text,timestamptz,text,text,text) from public,anon,authenticated;
grant execute on function public.acquire_operation_lifecycle_admission(
  text,bigint,uuid,uuid,text,text,timestamptz,text,text,text) to service_role;
