-- #396 source132. No worker activation, provider call, reset or policy seed.
alter table private.developer_operation_admissions
  add column worker_kind text,
  add column worker_context jsonb,
  add constraint operation_worker_context_shape check (
    (worker_kind is null and worker_context is null)
    or (worker_kind is not null and worker_kind='NOTIFICATION_DELIVERY' and worker_context is not null
      and jsonb_typeof(worker_context)='object' and http_route_id is null));
-- A second invocation must not reuse the same claim/fence and then rely on the
-- first invocation's provider result while its own duplicate call is in flight.
create unique index operation_notification_claim_once
  on private.developer_operation_admissions((worker_context->>'claimDigest'))
  where worker_kind='NOTIFICATION_DELIVERY';

create function public.claim_operation_notification_deliveries(
  p_target text,p_nonce text,p_deadline timestamptz,p_claim_digest text,p_limit integer default 10
) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog
set lock_timeout='2s' set statement_timeout='7s' as $$
declare v_control private.developer_operation_control; v_id uuid; v_result jsonb;
  v_targets jsonb; v_owner text;
begin
  if current_setting('transaction_isolation')<>'read committed'
    or p_target is null or p_target !~ '^[a-z]{20}$'
    or p_nonce is null or p_nonce !~ '^[0-9a-f]{64}$'
    or p_claim_digest is null or p_claim_digest !~ '^[0-9a-f]{64}$'
    or p_limit is null or p_limit not between 1 and 10
    or p_deadline is null or not isfinite(p_deadline) or p_deadline<=clock_timestamp() then
    raise exception using errcode='22023',message='OPERATION_WORKER_INPUT_INVALID';
  end if;
  select * into v_control from private.developer_operation_control where singleton for update;
  if not found then
    -- Initial activation must separately stop ingress/drain previously untracked
    -- work. Absence preserves old behavior; it is never reset readiness proof.
    return jsonb_build_object('admissionId',null,'claim',public.claim_notification_deliveries(p_claim_digest,p_limit));
  end if;
  v_owner:=private.operation_secret_digest(jsonb_build_array(p_target,'NOTIFICATION_DELIVERY',p_claim_digest)::text);
  v_id:=private.acquire_developer_operation_admission(p_target,v_control.version,'BACKGROUND_WORKER',v_owner,p_nonce,p_deadline);
  v_result:=public.claim_notification_deliveries(p_claim_digest,p_limit);
  if jsonb_typeof(v_result->'items') is distinct from 'array' or jsonb_array_length(v_result->'items')>p_limit then
    raise exception using errcode='55000',message='OPERATION_WORKER_CLAIM_UNVERIFIED';
  end if;
  -- Capture immutable attempt identities in the SAME transaction as the claim.
  -- Later zero rows/current lease expiry/takeover are never completion proof.
  select coalesce(jsonb_agg(jsonb_build_object('attemptId',a.id,'targetId',a.target_id,
    'leaseVersion',a.lease_version) order by a.id),'[]'::jsonb) into v_targets
    from jsonb_array_elements(v_result->'items') item
    join private.notification_delivery_attempts a on a.target_id=(item->>'targetId')::uuid
      and a.lease_version=(item->>'leaseVersion')::integer and a.claim_digest=p_claim_digest;
  if jsonb_array_length(v_targets)<>jsonb_array_length(v_result->'items') then
    raise exception using errcode='55000',message='OPERATION_WORKER_CLAIM_UNVERIFIED';
  end if;
  update private.developer_operation_admissions set worker_kind='NOTIFICATION_DELIVERY',
    worker_context=jsonb_build_object('format','notification-admission-v1','claimDigest',p_claim_digest,'targets',v_targets)
    where id=v_id;
  return jsonb_build_object('admissionId',v_id,'claim',v_result);
end;
$$;

create function public.complete_operation_notification_deliveries(p_target text,p_admission_id uuid,p_nonce text)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog
set lock_timeout='2s' set statement_timeout='7s' as $$
declare v_admission private.developer_operation_admissions; v_context jsonb; v_expected integer; v_terminal integer;
begin
  if current_setting('transaction_isolation')<>'read committed' then
    raise exception using errcode='42501',message='OPERATION_WORKER_COMPLETION_UNVERIFIED';
  end if;
  select * into v_admission from private.developer_operation_admissions where id=p_admission_id for update;
  v_context:=v_admission.worker_context;
  if v_admission.id is null or v_admission.completed_at is not null or v_admission.worker_kind is distinct from 'NOTIFICATION_DELIVERY'
    or p_nonce is null or p_nonce !~ '^[0-9a-f]{64}$'
    or v_admission.nonce_hash is distinct from private.operation_secret_digest(p_nonce)
    or not exists(select 1 from private.developer_operation_control where singleton and target_ref=p_target)
    or v_admission.owner_digest is distinct from private.operation_secret_digest(
      jsonb_build_array(p_target,'NOTIFICATION_DELIVERY',v_context->>'claimDigest')::text)
    or v_context->>'format' is distinct from 'notification-admission-v1'
    or jsonb_typeof(v_context->'targets') is distinct from 'array' then
    raise exception using errcode='42501',message='OPERATION_WORKER_COMPLETION_UNVERIFIED';
  end if;
  v_expected:=jsonb_array_length(v_context->'targets');
  select count(*)::integer into v_terminal from jsonb_array_elements(v_context->'targets') item
    join private.notification_delivery_attempts a on a.id=(item->>'attemptId')::uuid
      and a.target_id=(item->>'targetId')::uuid and a.lease_version=(item->>'leaseVersion')::integer
      and a.claim_digest=v_context->>'claimDigest'
    join private.notification_delivery_attempt_results r on r.attempt_id=a.id
    where r.completed_at is not null
      and r.outcome in ('accepted','suppressed','endpoint_gone','payload_rejected','provider_configuration_error');
  -- In particular retryable/NETWORK_ERROR/TIMEOUT never proves remote quiescence,
  -- even if a later attempt succeeded or the current target became terminal.
  if v_terminal<>v_expected then
    raise exception using errcode='42501',message='OPERATION_WORKER_COMPLETION_UNVERIFIED';
  end if;
  perform private.complete_developer_operation_admission(p_admission_id,v_admission.owner_digest,p_nonce);
  return jsonb_build_object('completed',true);
end;
$$;
revoke all on function public.claim_operation_notification_deliveries(text,text,timestamptz,text,integer),
  public.complete_operation_notification_deliveries(text,uuid,text) from public,anon,authenticated;
grant execute on function public.claim_operation_notification_deliveries(text,text,timestamptz,text,integer),
  public.complete_operation_notification_deliveries(text,uuid,text) to service_role;

-- Configuration failures occur before a claim. Preserve their heartbeat with
-- acquire/write/complete in one transaction; this is not a provider receipt.
create function public.record_operation_notification_configuration_failure(
  p_target text,p_nonce text,p_deadline timestamptz
) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog
set lock_timeout='2s' set statement_timeout='7s' as $$
declare v_control private.developer_operation_control; v_id uuid; v_owner text; v_result jsonb;
begin
  if current_setting('transaction_isolation')<>'read committed'
    or p_target is null or p_target !~ '^[a-z]{20}$'
    or p_nonce is null or p_nonce !~ '^[0-9a-f]{64}$'
    or p_deadline is null or not isfinite(p_deadline) or p_deadline<=clock_timestamp() then
    raise exception using errcode='22023',message='OPERATION_WORKER_INPUT_INVALID';
  end if;
  select * into v_control from private.developer_operation_control where singleton for update;
  if found then
    v_owner:=private.operation_secret_digest(jsonb_build_array(p_target,'NOTIFICATION_CONFIGURATION_FAILURE')::text);
    v_id:=private.acquire_developer_operation_admission(p_target,v_control.version,'BACKGROUND_WORKER',v_owner,p_nonce,p_deadline);
  end if;
  v_result:=public.record_notification_delivery_heartbeat('degraded',0,0,0,0,0,0,0,'PROVIDER_CONFIGURATION_ERROR');
  if v_id is not null then perform private.complete_developer_operation_admission(v_id,v_owner,p_nonce); end if;
  return v_result;
end;
$$;
revoke all on function public.record_operation_notification_configuration_failure(text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.record_operation_notification_configuration_failure(text,text,timestamptz) to service_role;
