-- #396 source133. Opt-in scheduler admission; no activation or policy seed.
alter table private.developer_operation_admissions drop constraint operation_worker_context_shape;
alter table private.developer_operation_admissions add constraint operation_worker_context_shape check (
  (worker_kind is null and worker_context is null) or
  (worker_kind is not null and worker_kind in ('NOTIFICATION_DELIVERY','RESERVATION_SCHEDULER') and worker_context is not null
    and jsonb_typeof(worker_context)='object' and http_route_id is null));
create unique index operation_scheduler_request_once
  on private.developer_operation_admissions((worker_context->>'requestId'))
  where worker_kind='RESERVATION_SCHEDULER';

create function public.acquire_operation_reservation_scheduler(
  p_target text,p_nonce text,p_deadline timestamptz,p_actor_profile_id uuid,
  p_invocation_key text,p_scheduled_at timestamptz,p_request_id text,
  p_reservation_hash text,p_assignment_hash text
) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog
set lock_timeout='2s' set statement_timeout='7s' as $$
declare v_control private.developer_operation_control; v_id uuid; v_owner text; v_heartbeat_attempt integer;
begin
  if current_setting('transaction_isolation')<>'read committed'
    or p_target is null or p_target !~ '^[a-z]{20}$'
    or p_nonce is null or p_nonce !~ '^[0-9a-f]{64}$'
    or p_deadline is null or not isfinite(p_deadline) or p_deadline<=clock_timestamp()
    or p_actor_profile_id is null or p_invocation_key is null or p_invocation_key !~ '^reservation-scheduler-[0-9]{12}$'
    or p_scheduled_at is null or not isfinite(p_scheduled_at)
    or p_scheduled_at<>date_trunc('minute',p_scheduled_at)
    or p_invocation_key<>'reservation-scheduler-'||to_char(p_scheduled_at at time zone 'UTC','YYYYMMDDHH24MI')
    or p_request_id is null or char_length(p_request_id) not between 1 and 128
    or p_reservation_hash is distinct from encode(extensions.digest('{"command":"reservation.process_due_transitions"}','sha256'),'hex')
    or p_assignment_hash is distinct from encode(extensions.digest('{"command":"assignment.process_due_lifecycle"}','sha256'),'hex') then
    raise exception using errcode='22023',message='OPERATION_SCHEDULER_INPUT_INVALID';
  end if;
  perform private.assert_room_admin(p_actor_profile_id);
  select * into v_control from private.developer_operation_control where singleton for update;
  -- Initial installation must independently stop ingress and drain old work.
  if not found then return jsonb_build_object('admissionId',null); end if;
  v_owner:=private.operation_secret_digest(jsonb_build_array(p_target,'RESERVATION_SCHEDULER',p_actor_profile_id,p_invocation_key,p_request_id)::text);
  v_id:=private.acquire_developer_operation_admission(p_target,v_control.version,'BACKGROUND_WORKER',v_owner,p_nonce,p_deadline);
  select coalesce((select h.attempt_count from private.scheduler_invocation_heartbeats h
    where h.invocation_key=p_invocation_key),0) into v_heartbeat_attempt;
  update private.developer_operation_admissions set worker_kind='RESERVATION_SCHEDULER',
    worker_context=jsonb_build_object('format','scheduler-admission-v1','actorId',p_actor_profile_id,
      'invocationKey',p_invocation_key,'scheduledAt',p_scheduled_at,'requestId',p_request_id,
      'reservationHash',p_reservation_hash,'assignmentHash',p_assignment_hash,
      'heartbeatAttemptAtAcquire',v_heartbeat_attempt) where id=v_id;
  return jsonb_build_object('admissionId',v_id);
end;
$$;

create function public.complete_operation_reservation_scheduler(p_target text,p_admission_id uuid,p_nonce text)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog
set lock_timeout='2s' set statement_timeout='7s' as $$
declare v_admission private.developer_operation_admissions; v_context jsonb;
begin
  if current_setting('transaction_isolation')<>'read committed' then
    raise exception using errcode='42501',message='OPERATION_SCHEDULER_COMPLETION_UNVERIFIED';
  end if;
  select * into v_admission from private.developer_operation_admissions where id=p_admission_id for update;
  v_context:=v_admission.worker_context;
  if v_admission.id is null or v_admission.completed_at is not null or v_admission.worker_kind is distinct from 'RESERVATION_SCHEDULER'
    or p_nonce is null or p_nonce !~ '^[0-9a-f]{64}$'
    or v_admission.nonce_hash is distinct from private.operation_secret_digest(p_nonce)
    or not exists(select 1 from private.developer_operation_control where singleton and target_ref=p_target)
    or v_context->>'format' is distinct from 'scheduler-admission-v1'
    or v_admission.owner_digest is distinct from private.operation_secret_digest(jsonb_build_array(
      p_target,'RESERVATION_SCHEDULER',(v_context->>'actorId')::uuid,v_context->>'invocationKey',v_context->>'requestId')::text) then
    raise exception using errcode='42501',message='OPERATION_SCHEDULER_COMPLETION_UNVERIFIED';
  end if;
  -- Older idempotent command receipts are valid, but BOTH exact commands and
  -- this request's newly written successful heartbeat must exist. Client time
  -- is not DB write proof; capture and compare the server-maintained counter.
  -- A later run's heartbeat,
  -- one committed phase, deadline expiry or current business state is not proof.
  if not exists(select 1 from private.command_executions c
      where c.actor_profile_id=(v_context->>'actorId')::uuid and c.command_type='reservation.process_due_transitions.v66'
        and c.idempotency_key=v_context->>'invocationKey' and c.request_hash=v_context->>'reservationHash')
    or not exists(select 1 from private.command_executions c
      where c.actor_profile_id=(v_context->>'actorId')::uuid and c.command_type='assignment.process_due_lifecycle'
        and c.idempotency_key=v_context->>'invocationKey' and c.request_hash=v_context->>'assignmentHash')
    or not exists(select 1 from private.scheduler_invocation_heartbeats h
      where h.invocation_key=v_context->>'invocationKey' and h.actor_profile_id=(v_context->>'actorId')::uuid
        and h.scheduled_at=(v_context->>'scheduledAt')::timestamptz and h.status='succeeded'
        and h.last_error_code is null and h.last_request_id=v_context->>'requestId'
        and h.attempt_count>(v_context->>'heartbeatAttemptAtAcquire')::integer) then
    raise exception using errcode='42501',message='OPERATION_SCHEDULER_COMPLETION_UNVERIFIED';
  end if;
  perform private.complete_developer_operation_admission(p_admission_id,v_admission.owner_digest,p_nonce);
  return jsonb_build_object('completed',true);
end;
$$;
revoke all on function public.acquire_operation_reservation_scheduler(text,text,timestamptz,uuid,text,timestamptz,text,text,text),
  public.complete_operation_reservation_scheduler(text,uuid,text) from public,anon,authenticated;
grant execute on function public.acquire_operation_reservation_scheduler(text,text,timestamptz,uuid,text,timestamptz,text,text,text),
  public.complete_operation_reservation_scheduler(text,uuid,text) to service_role;
