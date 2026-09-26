-- #306 turns complaint calendar windows into attention thresholds. Existing
-- response_deadline values remain immutable compatibility metadata, but they
-- no longer revoke intake or the maid's single response right.

create or replace function private.guard_complaint_case_projection()
returns trigger language plpgsql set search_path='' as $$
declare v_response public.complaint_maid_responses;
  v_operational public.complaint_compensation_decisions;
  v_source public.complaint_decisions; v_next public.complaint_decisions;
begin
  if tg_op='DELETE' then raise exception using errcode='55000',message='COMPLAINT_CASE_DELETE_FORBIDDEN'; end if;
  if new.id<>old.id or new.room_id<>old.room_id or new.cleaning_target_id<>old.cleaning_target_id
    or new.cleaning_attempt_id<>old.cleaning_attempt_id or new.submission_id<>old.submission_id
    or new.inspection_decision_id<>old.inspection_decision_id or new.original_earning_id<>old.original_earning_id
    or new.maid_profile_id<>old.maid_profile_id or new.category<>old.category
    or new.received_by<>old.received_by or new.received_at<>old.received_at then
    raise exception using errcode='55000',message='COMPLAINT_CASE_SOURCE_IMMUTABLE';
  end if;
  if new.version<>old.version+1 or new.updated_at<old.updated_at then
    raise exception using errcode='40001',message='STALE_VERSION';
  end if;
  if old.current_compensation_decision_id is null and new.current_compensation_decision_id is not null
    and new.status=old.status and new.current_decision_id=old.current_decision_id then return new; end if;
  if new.current_compensation_decision_id is distinct from old.current_compensation_decision_id then
    raise exception using errcode='55000',message='COMPLAINT_REWORK_PROJECTION_IMMUTABLE'; end if;
  if old.status='received' and new.status='under_review' and new.current_decision_id is null then return new; end if;
  if old.status='under_review' and new.status='decided' and new.current_decision_id is not null and old.current_decision_id is null then return new; end if;
  if old.status='decided' and new.status in ('acknowledged','appealed') and new.current_decision_id=old.current_decision_id then return new; end if;
  if old.status='acknowledged' and new.status='closed' and new.current_decision_id=old.current_decision_id then return new; end if;
  if old.status='appealed' and new.status='closed' then
    select * into v_response from public.complaint_maid_responses response where response.complaint_case_id=old.id;
    if v_response.id is not null and exists(select 1 from public.complaint_case_events correction_event
      join public.complaint_case_events response_event on response_event.maid_response_id=v_response.id
      where correction_event.complaint_case_id=old.id and correction_event.event_type='corrected'
        and correction_event.decision_id=old.current_decision_id and correction_event.id>response_event.id)
      and new.current_decision_id=old.current_decision_id then return new; end if;
  end if;
  if new.status=old.status and old.status in ('decided','acknowledged','appealed','closed')
    and new.current_decision_id<>old.current_decision_id and new.first_decided_at=old.first_decided_at
    and new.response_deadline=old.response_deadline then
    if old.current_compensation_decision_id is not null then
      select * into v_operational from public.complaint_compensation_decisions
        where id=old.current_compensation_decision_id;
      select * into v_source from public.complaint_decisions where id=v_operational.complaint_decision_id;
      select * into v_next from public.complaint_decisions where id=new.current_decision_id;
      if not exists(select 1 from public.cleaning_attempts attempt
          where attempt.cleaning_target_id=v_operational.rework_cleaning_target_id
            and attempt.started_at is not null)
        and (v_next.finding is distinct from v_source.finding
          or v_next.rework_required is distinct from v_source.rework_required) then
        raise exception using errcode='40001',message='COMPLAINT_REWORK_PRESTART_FROZEN';
      end if;
    end if;
    return new;
  end if;
  raise exception using errcode='55000',message='COMPLAINT_INVALID_TRANSITION';
end $$;

create or replace function public.create_complaint_case(
  p_actor_profile_id uuid,p_original_earning_id uuid,p_category text,p_expected_version bigint,
  p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor public.profiles; v_earning public.earnings; v_submission public.cleaning_submissions;
  v_attempt public.cleaning_attempts; v_target public.cleaning_targets; v_inspection public.inspection_decisions;
  v_case public.complaint_cases; v_replay jsonb; v_result jsonb; v_at timestamptz:=transaction_timestamp();
begin
  v_actor:=private.assert_complaint_admin(p_actor_profile_id);
  v_replay:=private.replay_command(v_actor.id,'complaint.create',p_idempotency_key,p_request_hash);
  if p_expected_version is distinct from 0 then raise exception using errcode='40001',message='STALE_VERSION'; end if;
  if p_category is null or p_category not in ('cleanliness_general','bathroom_cleanliness','bedding_quality',
    'trash_not_removed','amenity_missing','damage_or_loss','odor_or_smoke','access_or_handover') then
    raise exception using errcode='22023',message='INVALID_COMPLAINT_CATEGORY'; end if;
  if v_replay is not null then return v_replay; end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into v_earning from public.earnings where id=p_original_earning_id;
  select * into v_submission from public.cleaning_submissions where id=v_earning.submission_id;
  select * into v_attempt from public.cleaning_attempts where id=v_submission.cleaning_attempt_id;
  select * into v_target from public.cleaning_targets where id=v_attempt.cleaning_target_id;
  select * into v_inspection from public.inspection_decisions where submission_id=v_submission.id;
  if v_earning.id is null or v_submission.id is null or v_attempt.id is null or v_target.id is null
    or v_inspection.id is null or v_inspection.decision<>'approved' or v_submission.status<>'approved'
    or v_attempt.status<>'approved' or v_target.status<>'approved'
    or v_target.source not in (
      'scheduled_checkout','manual_checkout','stayover_request','manual_room_request',
      'stay_room_move_checkout')
    or (v_target.source='stay_room_move_checkout' and not exists(
      select 1
      from private.stay_segment_checkout_obligations obligation
      join private.reservation_stays stay on stay.id=obligation.stay_id
      where obligation.id=v_target.stay_segment_checkout_obligation_id
        and obligation.cleaning_target_id=v_target.id
        and obligation.room_id=v_target.room_id
        and obligation.status='completed'
        and stay.reservation_id=v_target.reservation_id
    ))
    or v_earning.earning_entitlement_id is null
    or v_earning.earning_entitlement_id is distinct from v_submission.id
    or v_earning.compensation_entitlement_id is not null
    or v_earning.maid_profile_id<>v_attempt.maid_profile_id
    or v_submission.submitted_by<>v_attempt.maid_profile_id
    or v_inspection.decided_at>v_at then
    raise exception using errcode='55000',message='COMPLAINT_SOURCE_NOT_APPROVED';
  end if;
  insert into public.complaint_cases(room_id,cleaning_target_id,cleaning_attempt_id,submission_id,
    inspection_decision_id,original_earning_id,maid_profile_id,category,status,version,received_by,received_at,updated_at)
  values(v_target.room_id,v_target.id,v_attempt.id,v_submission.id,v_inspection.id,v_earning.id,
    v_attempt.maid_profile_id,p_category,'received',1,v_actor.id,v_at,v_at) returning * into v_case;
  insert into public.complaint_case_events(complaint_case_id,event_type,from_status,to_status,case_version,actor_profile_id,occurred_at)
  values(v_case.id,'received',null,'received',1,v_actor.id,v_at);
  perform private.enqueue_complaint_notice(v_case.maid_profile_id,v_case,'received',1,v_at);
  v_result:=private.get_complaint_projection(v_case.id);
  insert into public.audit_events(actor_profile_id,event_type,entity_type,entity_id,effective_at,reason_code,after_state,idempotency_key)
  values(v_actor.id,'complaint.received','complaint_case',v_case.id,v_at,p_category,
    jsonb_build_object('complaintId',v_case.id,'originalEarningId',v_case.original_earning_id,'status','received','version',1),
    private.audit_command_key(v_actor.id,'complaint.create',p_idempotency_key));
  perform private.complete_command(v_actor.id,'complaint.create',p_idempotency_key,p_request_hash,v_case.id,v_result);
  return v_result;
end $$;

create or replace function public.respond_to_complaint(
  p_actor_profile_id uuid,p_complaint_id uuid,p_expected_version bigint,p_response_type text,
  p_appeal_reason_code text,p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor public.profiles; v_case public.complaint_cases;
  v_response public.complaint_maid_responses; v_decision public.complaint_decisions;
  v_replay jsonb; v_result jsonb; v_at timestamptz:=transaction_timestamp();
begin
  v_actor:=private.assert_complaint_reader(p_actor_profile_id);
  if v_actor.role<>'maid' then raise exception using errcode='42501',message='MAID_REQUIRED'; end if;
  v_replay:=private.replay_command(v_actor.id,'complaint.respond',p_idempotency_key,p_request_hash);
  if p_response_type not in ('acknowledged','appealed') then
    raise exception using errcode='22023',message='INVALID_COMPLAINT_RESPONSE'; end if;
  if p_response_type='acknowledged' and p_appeal_reason_code is not null then
    raise exception using errcode='22023',message='COMPLAINT_APPEAL_REASON_FORBIDDEN'; end if;
  if p_response_type='appealed' and (p_appeal_reason_code is null or p_appeal_reason_code not in (
    'work_completed_as_required','evidence_misinterpreted','not_responsible','timeline_mismatch')) then
    raise exception using errcode='22023',message='COMPLAINT_APPEAL_REASON_REQUIRED'; end if;
  if v_replay is not null then return v_replay; end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into v_case from public.complaint_cases where id=p_complaint_id for update;
  if v_case.id is null or v_case.maid_profile_id<>v_actor.id then
    raise exception using errcode='42501',message='COMPLAINT_MAID_MISMATCH'; end if;
  if v_case.version is distinct from p_expected_version then
    raise exception using errcode='40001',message='STALE_VERSION'; end if;
  if v_case.status<>'decided' or v_case.current_decision_id is null then
    raise exception using errcode='55000',message='COMPLAINT_INVALID_TRANSITION'; end if;
  if exists(select 1 from public.complaint_maid_responses r where r.complaint_case_id=v_case.id) then
    raise exception using errcode='23505',message='COMPLAINT_RESPONSE_ALREADY_RECORDED'; end if;
  select * into v_decision from public.complaint_decisions
  where complaint_case_id=v_case.id and decision_version=1;
  insert into public.complaint_maid_responses(complaint_case_id,decision_id,maid_profile_id,
    response_type,appeal_reason_code,responded_at)
  values(v_case.id,v_decision.id,v_actor.id,p_response_type,p_appeal_reason_code,v_at)
  returning * into v_response;
  update public.complaint_cases set status=p_response_type,version=version+1,updated_at=v_at
  where id=v_case.id returning * into v_case;
  insert into public.complaint_case_events(complaint_case_id,event_type,from_status,to_status,
    case_version,actor_profile_id,decision_id,maid_response_id,occurred_at)
  values(v_case.id,p_response_type,'decided',p_response_type,v_case.version,v_actor.id,
    v_decision.id,v_response.id,v_at);
  perform private.enqueue_complaint_notice(v_decision.decided_by,v_case,p_response_type,
    v_case.version,v_at);
  v_result:=private.get_complaint_projection(v_case.id);
  insert into public.audit_events(actor_profile_id,event_type,entity_type,entity_id,effective_at,
    reason_code,after_state,idempotency_key)
  values(v_actor.id,'complaint.'||p_response_type,'complaint_case',v_case.id,v_at,
    p_appeal_reason_code,jsonb_strip_nulls(jsonb_build_object('complaintId',v_case.id,
      'decisionId',v_decision.id,'responseType',p_response_type,
      'appealReasonCode',p_appeal_reason_code,'status',v_case.status,'version',v_case.version)),
    private.audit_command_key(v_actor.id,'complaint.respond',p_idempotency_key));
  perform private.complete_command(v_actor.id,'complaint.respond',p_idempotency_key,p_request_hash,
    v_case.id,v_result);
  return v_result;
end $$;

create or replace function public.close_complaint_case(
  p_actor_profile_id uuid,p_complaint_id uuid,p_expected_version bigint,
  p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor public.profiles; v_case public.complaint_cases;
  v_response public.complaint_maid_responses; v_appeal_resolved boolean;
  v_replay jsonb; v_result jsonb; v_at timestamptz:=transaction_timestamp();
begin
  v_actor:=private.assert_complaint_admin(p_actor_profile_id);
  v_replay:=private.replay_command(v_actor.id,'complaint.close',p_idempotency_key,p_request_hash);
  if v_replay is not null then return v_replay; end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into v_case from public.complaint_cases where id=p_complaint_id for update;
  if v_case.id is null then raise exception using errcode='P0002',message='COMPLAINT_NOT_FOUND'; end if;
  if v_case.version is distinct from p_expected_version then
    raise exception using errcode='40001',message='STALE_VERSION'; end if;
  select * into v_response from public.complaint_maid_responses
  where complaint_case_id=v_case.id;
  select exists(
    select 1 from public.complaint_case_events correction_event
    join public.complaint_case_events response_event
      on response_event.maid_response_id=v_response.id
    where correction_event.complaint_case_id=v_case.id
      and correction_event.event_type='corrected'
      and correction_event.decision_id=v_case.current_decision_id
      and correction_event.id>response_event.id
  ) into v_appeal_resolved;
  if v_case.status='decided' then
    raise exception using errcode='55000',message='COMPLAINT_RESPONSE_REQUIRED';
  elsif v_case.status='appealed' and (v_response.id is null or not v_appeal_resolved) then
    raise exception using errcode='55000',message='COMPLAINT_APPEAL_UNRESOLVED';
  elsif v_case.status not in ('acknowledged','appealed') then
    raise exception using errcode='55000',message='COMPLAINT_INVALID_TRANSITION';
  end if;
  update public.complaint_cases set status='closed',version=version+1,updated_at=v_at
  where id=v_case.id returning * into v_case;
  insert into public.complaint_case_events(complaint_case_id,event_type,from_status,to_status,
    case_version,actor_profile_id,decision_id,occurred_at)
  values(v_case.id,'closed',v_response.response_type,'closed',v_case.version,v_actor.id,
    v_case.current_decision_id,v_at);
  perform private.enqueue_complaint_notice(v_case.maid_profile_id,v_case,'closed',v_case.version,v_at);
  v_result:=private.get_complaint_projection(v_case.id);
  insert into public.audit_events(actor_profile_id,event_type,entity_type,entity_id,effective_at,
    after_state,idempotency_key)
  values(v_actor.id,'complaint.closed','complaint_case',v_case.id,v_at,
    jsonb_build_object('complaintId',v_case.id,'status','closed','version',v_case.version),
    private.audit_command_key(v_actor.id,'complaint.close',p_idempotency_key));
  perform private.complete_command(v_actor.id,'complaint.close',p_idempotency_key,p_request_hash,
    v_case.id,v_result);
  return v_result;
end $$;

comment on column public.complaint_cases.response_deadline is
  'Legacy-compatible attention threshold (first_decided_at + 7 days). It never expires the maid response right or authorizes no-response closure.';
