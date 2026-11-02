-- #396: observe only the existing offline resolution terminal. No new business
-- effect, replay, table, column, retention change or global drain claim.
-- The service's canonical request hash binds actor/action/quarantine/resolution/
-- expected execution version/reason. Admission retains only the existing digests.
create index offline_resolutions_operation_receipt_idx on private.offline_event_resolutions
  (actor_profile_id,private.operation_secret_digest(idempotency_key),request_hash,resolution);

create function public.acquire_operation_offline_resolution_admission(
  p_target text,p_version bigint,p_actor uuid,p_auth uuid,p_session text,
  p_nonce text,p_deadline timestamptz,p_resolution text,p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql volatile security definer set search_path = pg_catalog
set lock_timeout = '2s' set statement_timeout = '7s' as $$
declare v_result jsonb; v_route jsonb; v_id uuid; v_profile public.profiles; v_password text;
begin
  if p_resolution is null or p_resolution not in ('record_only','reject_effect','correction_link')
    or p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,128}$'
    or p_request_hash is null or p_request_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode='22023',message='OPERATION_COMMAND_BINDING_REJECTED';
  end if;
  v_route := private.operation_http_route('resolveOfflineQuarantine');
  if v_route is distinct from jsonb_build_object('routeId','resolveOfflineQuarantine',
    'kind','BUSINESS_WRITE','authority','ACTIVE_SESSION','hashMode','NONE',
    'commandName',null,'keyArgument','p_idempotency_key') then
    raise exception using errcode='42501',message='OPERATION_IDENTITY_REJECTED';
  end if;
  perform private.assert_operation_http_identity(v_route,p_actor,p_auth,p_session);
  select * into v_profile from private.assert_attempt_actor_session_fresh(p_actor,p_session::uuid,true);
  if v_profile.auth_user_id is distinct from p_auth then
    raise exception using errcode='42501',message='OPERATION_IDENTITY_REJECTED';
  end if;
  v_result := public.acquire_operation_http_admission(p_target,p_version,'resolveOfflineQuarantine',
    p_actor,p_auth,p_session,p_nonce,p_deadline,null,null,null,null);
  v_id := (v_result->>'admissionId')::uuid;
  -- The opaque admission and its exact binding commit together, under the
  -- existing maintenance/control lock. The original receipt path is unchanged.
  update private.developer_operation_admissions
    set http_command_name='offline.quarantine.'||p_resolution,
      http_key_digest=private.operation_secret_digest(p_idempotency_key),http_request_hash=p_request_hash
    where id=v_id and http_route_id='resolveOfflineQuarantine' and completed_at is null
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
  return jsonb_build_object('admissionId',v_id,'controlVersion',p_version::text,
    'completionMode','OFFLINE_RESOLUTION');
end;
$$;

create function public.complete_operation_offline_resolution_admission(
  p_admission_id uuid,p_nonce text,p_actor uuid,p_auth uuid,p_session text,
  p_quarantine_id uuid,p_resolution text
) returns jsonb language plpgsql volatile security definer set search_path = pg_catalog
set lock_timeout = '2s' set statement_timeout = '7s' as $$
declare v_admission private.developer_operation_admissions; v_route jsonb; v_profile public.profiles;
begin
  select * into v_admission from private.developer_operation_admissions where id=p_admission_id for update;
  if v_admission.id is null or v_admission.completed_at is not null
    or v_admission.http_route_id is distinct from 'resolveOfflineQuarantine'
    or p_quarantine_id is null or p_resolution is null
    or p_resolution not in ('record_only','reject_effect','correction_link')
    or v_admission.http_command_name is distinct from 'offline.quarantine.'||p_resolution
    or p_nonce is null or p_nonce !~ '^[0-9a-f]{64}$'
    or v_admission.nonce_hash is distinct from private.operation_secret_digest(p_nonce)
    or v_admission.http_actor_profile_id is distinct from p_actor
    or v_admission.http_auth_user_id is distinct from p_auth
    or v_admission.http_session_digest is distinct from private.operation_secret_digest(p_session)
    or v_admission.http_password_version is distinct from public.get_auth_password_version(p_auth) then
    raise exception using errcode='42501',message='OPERATION_COMPLETION_UNVERIFIED';
  end if;
  v_route := private.operation_http_route('resolveOfflineQuarantine');
  perform private.assert_operation_http_identity(v_route,p_actor,p_auth,p_session);
  select * into v_profile from private.assert_attempt_actor_session_fresh(p_actor,p_session::uuid,true);
  if v_profile.auth_user_id is distinct from p_auth then
    raise exception using errcode='42501',message='OPERATION_COMPLETION_UNVERIFIED';
  end if;
  -- The immutable, 90-day terminal is committed with the complete resolution
  -- and notification outbox transaction. Hold it through admission completion
  -- against concurrent retention cleanup. Missing/purged rows remain UNKNOWN.
  perform 1 from private.offline_event_resolutions r
    where r.actor_profile_id=p_actor and r.event_record_id=p_quarantine_id
      and r.resolution=p_resolution and r.request_hash=v_admission.http_request_hash
      and private.operation_secret_digest(r.idempotency_key)=v_admission.http_key_digest
    for share;
  if not found then
    raise exception using errcode='42501',message='OPERATION_COMPLETION_UNVERIFIED';
  end if;
  perform private.assert_operation_http_identity(v_route,p_actor,p_auth,p_session);
  select * into v_profile from private.assert_attempt_actor_session_fresh(p_actor,p_session::uuid,true);
  if v_profile.auth_user_id is distinct from p_auth
    or v_admission.http_password_version is distinct from public.get_auth_password_version(p_auth) then
    raise exception using errcode='42501',message='OPERATION_COMPLETION_UNVERIFIED';
  end if;
  perform private.complete_developer_operation_admission(p_admission_id,v_admission.owner_digest,p_nonce);
  return jsonb_build_object('completed',true);
end;
$$;
revoke all on function public.acquire_operation_offline_resolution_admission(
  text,bigint,uuid,uuid,text,text,timestamptz,text,text,text),
  public.complete_operation_offline_resolution_admission(uuid,text,uuid,uuid,text,uuid,text)
  from public,anon,authenticated;
grant execute on function public.acquire_operation_offline_resolution_admission(
  text,bigint,uuid,uuid,text,text,timestamptz,text,text,text),
  public.complete_operation_offline_resolution_admission(uuid,text,uuid,uuid,text,uuid,text)
  to service_role;
