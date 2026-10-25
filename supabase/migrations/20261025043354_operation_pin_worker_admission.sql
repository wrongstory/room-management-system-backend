-- #396 source134: incremental PIN Sheet admission only. No hosted mapping,
-- credentials, full-resync activation, photo deletion or reset is introduced.
alter table private.developer_operation_admissions drop constraint operation_worker_context_shape,
  add constraint operation_worker_context_shape check (
    (worker_kind is null and worker_context is null)
    or (worker_kind is not null and worker_kind in ('NOTIFICATION_DELIVERY','RESERVATION_SCHEDULER','ROOM_PIN_SHEET_INCREMENTAL')
      and worker_context is not null and jsonb_typeof(worker_context)='object' and http_route_id is null));
create unique index operation_pin_claim_once on private.developer_operation_admissions((worker_context->>'claimId'))
  where worker_kind='ROOM_PIN_SHEET_INCREMENTAL';

create function private.assert_operation_pin_admission(p_target text,p_admission_id uuid,p_nonce text)
returns private.developer_operation_admissions language plpgsql volatile security definer set search_path=pg_catalog as $$
declare a private.developer_operation_admissions;
begin
  select * into a from private.developer_operation_admissions where id=p_admission_id for update;
  if current_setting('transaction_isolation')<>'read committed' or a.id is null or a.completed_at is not null
    or a.worker_kind is distinct from 'ROOM_PIN_SHEET_INCREMENTAL' or p_nonce is null or p_nonce !~ '^[0-9a-f]{64}$'
    or a.nonce_hash is distinct from private.operation_secret_digest(p_nonce)
    or not exists(select 1 from private.developer_operation_control where singleton and target_ref=p_target)
    or a.worker_context->>'format' is distinct from 'pin-incremental-admission-v1'
    or a.owner_digest is distinct from private.operation_secret_digest(jsonb_build_array(p_target,'ROOM_PIN_SHEET_INCREMENTAL',
      a.worker_context->>'claimId',a.worker_context->>'environment',a.worker_context->>'targetDigest')::text) then
    raise exception using errcode='42501',message='OPERATION_PIN_ADMISSION_REJECTED';
  end if;
  return a;
end;
$$;
revoke all on function private.assert_operation_pin_admission(text,uuid,text) from public,anon,authenticated,service_role;

create function public.claim_operation_pin_incremental(p_target text,p_nonce text,p_deadline timestamptz,
  p_claim_id uuid,p_expected_environment text,p_expected_project_ref text,p_expected_target_identity_digest text)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog
set lock_timeout='2s' set statement_timeout='7s' as $$
declare c private.developer_operation_control; a uuid; owner_digest text; result jsonb; items jsonb;
begin
  if current_setting('transaction_isolation')<>'read committed' or p_target is null or p_target !~ '^[a-z]{20}$'
    or p_nonce is null or p_nonce !~ '^[0-9a-f]{64}$' or p_claim_id is null
    or p_deadline is null or not isfinite(p_deadline) or p_deadline<=clock_timestamp()
    or p_expected_environment is null or p_expected_environment !~ '^[A-Za-z0-9._:-]{1,80}$'
    or p_expected_project_ref is distinct from p_target
    or p_expected_target_identity_digest is null or p_expected_target_identity_digest !~ '^[0-9a-f]{64}$' then
    raise exception using errcode='22023',message='OPERATION_PIN_INPUT_INVALID';
  end if;
  select * into c from private.developer_operation_control where singleton for update;
  if found then
    owner_digest:=private.operation_secret_digest(jsonb_build_array(p_target,'ROOM_PIN_SHEET_INCREMENTAL',
      p_claim_id,p_expected_environment,p_expected_target_identity_digest)::text);
    a:=private.acquire_developer_operation_admission(p_target,c.version,'BACKGROUND_WORKER',owner_digest,p_nonce,p_deadline);
  end if;
  -- Serialize with the old worker/full-resync request path, but never call the
  -- full-resync claim function or release a full-board uncertain write.
  perform 1 from private.room_pin_sheet_sync_worker_state where singleton for update;
  if not found or exists(select 1 from private.room_pin_sheet_full_resync_runs
    where status in ('pending','processing','failed','operator_blocked')) then
    raise exception using errcode='42501',message='OPERATION_PIN_FULL_RESYNC_HOLD';
  end if;
  result:=public.claim_room_pin_sheet_sync(p_claim_id,10,p_expected_environment,p_expected_project_ref);
  if jsonb_typeof(result->'items') is distinct from 'array' or jsonb_array_length(result->'items')>10
    or result->>'status' is null or result->>'status' not in ('claimed','busy','operator_blocked') then
    raise exception using errcode='55000',message='OPERATION_PIN_CLAIM_UNVERIFIED';
  end if;
  if a is null then return jsonb_build_object('admissionId',null,'claim',result); end if;
  select coalesce(jsonb_agg(jsonb_build_object('outboxId',o.id,'pinVersion',o.pin_version,
    'authorized',false,'terminal',null) order by o.id),'[]'::jsonb) into items
    from jsonb_array_elements(result->'items') i join private.room_pin_sheet_sync_outbox o on o.id=(i->>'outboxId')::uuid
      and o.claim_id=p_claim_id and o.lease_fence=(result->>'leaseFence')::bigint
      and o.pin_version=(i->>'pinVersion')::bigint and o.status='processing';
  if jsonb_array_length(items)<>jsonb_array_length(result->'items') then
    raise exception using errcode='55000',message='OPERATION_PIN_CLAIM_UNVERIFIED';
  end if;
  update private.developer_operation_admissions set worker_kind='ROOM_PIN_SHEET_INCREMENTAL',worker_context=jsonb_build_object(
    'format','pin-incremental-admission-v1','claimId',p_claim_id,'environment',p_expected_environment,
    'targetDigest',p_expected_target_identity_digest,'leaseFence',result->'leaseFence','items',items,'heartbeat',null) where id=a;
  if result->>'status' in ('busy','operator_blocked') then
    if jsonb_array_length(items)<>0 then raise exception using errcode='55000',message='OPERATION_PIN_CLAIM_UNVERIFIED'; end if;
    -- This invocation performed only the completed claim transaction. Previous
    -- worker/provider uncertainty is not released by this DB-only admission.
    perform private.complete_developer_operation_admission(a,owner_digest,p_nonce);
    return jsonb_build_object('admissionId',null,'claim',result);
  end if;
  return jsonb_build_object('admissionId',a,'claim',result);
end;
$$;

-- Closed fixed dispatch: no caller SQL/function name and no PIN/credential data.
create function public.dispatch_operation_pin_incremental(p_target text,p_admission_id uuid,p_nonce text,p_action text,p_args jsonb)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog
set lock_timeout='2s' set statement_timeout='7s' as $$
declare a private.developer_operation_admissions; expected text[]; keys text[]; result jsonb;
  claim uuid; fence bigint; outbox uuid; pin_version bigint; i integer; item jsonb; context jsonb;
  job private.room_pin_sheet_sync_outbox; outcome text;
begin
  a:=private.assert_operation_pin_admission(p_target,p_admission_id,p_nonce); context:=a.worker_context;
  if context->'heartbeat' is distinct from 'null'::jsonb then
    raise exception using errcode='42501',message='OPERATION_PIN_RUN_FINISHED';
  end if;
  expected:=case p_action
    when 'RENEW' then array['p_claim_id','p_lease_fence']
    when 'AUTHORIZE' then array['p_claim_id','p_expected_pin_version','p_lease_fence','p_outbox_id']
    when 'SETTLE' then array['p_claim_id','p_expected_pin_version','p_lease_fence','p_outbox_id','p_outcome','p_reason_code']
    when 'HEARTBEAT' then array['p_already_current','p_blocked','p_claim_id','p_claimed','p_error_code','p_lease_fence','p_projected','p_retrying','p_status','p_superseded']
    else null end;
  if expected is null or jsonb_typeof(p_args) is distinct from 'object' then
    raise exception using errcode='22023',message='OPERATION_PIN_DISPATCH_INVALID';
  end if;
  select array_agg(key order by key) into keys from jsonb_object_keys(p_args) key;
  if keys is distinct from expected or jsonb_typeof(p_args->'p_claim_id') is distinct from 'string'
    or jsonb_typeof(p_args->'p_lease_fence') is distinct from 'number' then
    raise exception using errcode='22023',message='OPERATION_PIN_DISPATCH_INVALID';
  end if;
  claim:=(p_args->>'p_claim_id')::uuid; fence:=(p_args->>'p_lease_fence')::bigint;
  if claim is distinct from (context->>'claimId')::uuid or fence is distinct from (context->>'leaseFence')::bigint then
    raise exception using errcode='42501',message='OPERATION_PIN_FENCE_REJECTED';
  end if;
  if p_action='RENEW' then return public.renew_room_pin_sheet_sync_run(claim,fence); end if;
  if p_action in ('AUTHORIZE','SETTLE') then
    if jsonb_typeof(p_args->'p_outbox_id') is distinct from 'string' or jsonb_typeof(p_args->'p_expected_pin_version') is distinct from 'number' then
      raise exception using errcode='22023',message='OPERATION_PIN_DISPATCH_INVALID';
    end if;
    outbox:=(p_args->>'p_outbox_id')::uuid; pin_version:=(p_args->>'p_expected_pin_version')::bigint;
    select (n-1)::integer,value into i,item from jsonb_array_elements(context->'items') with ordinality x(value,n)
      where (value->>'outboxId')::uuid=outbox and (value->>'pinVersion')::bigint=pin_version;
    if i is null or item->'terminal' is distinct from 'null'::jsonb then
      raise exception using errcode='42501',message='OPERATION_PIN_ITEM_REJECTED';
    end if;
    -- The old settle has an idempotent terminal shortcut. Require our exact
    -- current processing fence BEFORE calling it so old state cannot be borrowed.
    perform 1 from private.room_pin_sheet_sync_worker_state where singleton for update;
    select * into job from private.room_pin_sheet_sync_outbox where id=outbox for update;
    if job.status is distinct from 'processing' or job.claim_id is distinct from claim
      or job.lease_fence is distinct from fence or job.pin_version is distinct from pin_version then
      raise exception using errcode='42501',message='OPERATION_PIN_FENCE_REJECTED';
    end if;
    if p_action='AUTHORIZE' then
      if item->'authorized' is distinct from 'false'::jsonb then raise exception using errcode='42501',message='OPERATION_PIN_WRITE_ALREADY_STARTED'; end if;
      result:=public.authorize_room_pin_sheet_write(outbox,claim,fence,pin_version);
      if result->>'status'='authorized' then item:=jsonb_set(item,'{authorized}','true');
      elsif result->>'status'='superseded' then item:=jsonb_set(item,'{terminal}',to_jsonb('SUPERSEDED_BEFORE_WRITE'::text));
      else raise exception using errcode='55000',message='OPERATION_PIN_TERMINAL_UNVERIFIED'; end if;
    else
      outcome:=p_args->>'p_outcome';
      if outcome is null or outcome not in ('succeeded','already_current','retryable','operator_blocked')
        or (outcome='succeeded' and item->'authorized' is distinct from 'true'::jsonb)
        or (outcome='already_current' and item->'authorized' is distinct from 'false'::jsonb)
        or jsonb_typeof(p_args->'p_reason_code') not in ('null','string') then
        raise exception using errcode='22023',message='OPERATION_PIN_DISPATCH_INVALID';
      end if;
      result:=public.settle_room_pin_sheet_sync(outbox,claim,fence,pin_version,outcome,p_args->>'p_reason_code');
      if outcome in ('succeeded','already_current') and result->>'status' in ('succeeded','superseded') then
        item:=jsonb_set(item,'{terminal}',to_jsonb(outcome));
      else
        -- Original settle can return superseded for an UNKNOWN provider result
        -- after a newer PIN exists. Preserve the original unknown observation.
        item:=jsonb_set(item,'{terminal}',to_jsonb('UNKNOWN'::text));
      end if;
    end if;
    context:=jsonb_set(context,array['items',i::text],item);
  else
    if jsonb_typeof(p_args->'p_status') is distinct from 'string'
      or jsonb_typeof(p_args->'p_error_code') not in ('null','string')
      or exists(select 1 from unnest(array['p_claimed','p_projected','p_already_current','p_superseded','p_retrying','p_blocked']) k
        where jsonb_typeof(p_args->k) is distinct from 'number' or (p_args->>k) !~ '^[0-9]+$') then
      raise exception using errcode='22023',message='OPERATION_PIN_DISPATCH_INVALID';
    end if;
    result:=public.record_room_pin_sheet_sync_heartbeat(claim,fence,p_args->>'p_status',
      (p_args->>'p_claimed')::integer,(p_args->>'p_projected')::integer,(p_args->>'p_already_current')::integer,
      (p_args->>'p_superseded')::integer,(p_args->>'p_retrying')::integer,(p_args->>'p_blocked')::integer,p_args->>'p_error_code');
    -- A durable per-admission observation, not a later mutable singleton heartbeat.
    context:=jsonb_set(context,'{heartbeat}',jsonb_build_object('status',result->>'status','recordedAt',result->'recordedAt'));
  end if;
  update private.developer_operation_admissions set worker_context=context where id=a.id;
  return result;
end;
$$;

create function public.complete_operation_pin_incremental(p_target text,p_admission_id uuid,p_nonce text)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog
set lock_timeout='2s' set statement_timeout='7s' as $$
declare a private.developer_operation_admissions;
begin
  a:=private.assert_operation_pin_admission(p_target,p_admission_id,p_nonce);
  if a.worker_context->'heartbeat'->>'status' is distinct from 'succeeded'
    or a.worker_context->'heartbeat'->>'recordedAt' is null
    or jsonb_typeof(a.worker_context->'items') is distinct from 'array'
    or exists(select 1 from jsonb_array_elements(a.worker_context->'items') i
      where coalesce(i->>'terminal','') not in ('succeeded','already_current','SUPERSEDED_BEFORE_WRITE')) then
    raise exception using errcode='42501',message='OPERATION_PIN_TERMINAL_UNVERIFIED';
  end if;
  perform private.complete_developer_operation_admission(a.id,a.owner_digest,p_nonce);
  return jsonb_build_object('completed',true);
end;
$$;
revoke all on function public.claim_operation_pin_incremental(text,text,timestamptz,uuid,text,text,text),
  public.dispatch_operation_pin_incremental(text,uuid,text,text,jsonb),public.complete_operation_pin_incremental(text,uuid,text)
  from public,anon,authenticated;
grant execute on function public.claim_operation_pin_incremental(text,text,timestamptz,uuid,text,text,text),
  public.dispatch_operation_pin_incremental(text,uuid,text,text,jsonb),public.complete_operation_pin_incremental(text,uuid,text)
  to service_role;
