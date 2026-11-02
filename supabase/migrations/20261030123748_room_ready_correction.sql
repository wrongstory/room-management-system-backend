-- #532: explicit administrator correction, never a fabricated inspection approval.
-- No operational rows are changed by installing this migration.
create function private.room_ready_targets(p_room uuid,p_at timestamptz)
returns setof public.cleaning_targets language sql stable security definer set search_path='' as $$
  select t.* from public.cleaning_targets t where t.room_id=p_room
    and t.status not in ('approved','cancelled') and (
      (t.cleaning_kind='checkout' and (
        exists(select 1 from public.checkout_cleaning_obligations o join public.reservations r on r.id=o.reservation_id
          where o.id=t.checkout_obligation_id and o.current_cleaning_target_id=t.id and o.status='materialized'
            and r.actual_checkout_at is not null and r.actual_checkout_at<=p_at)
        or exists(select 1 from private.stay_segment_checkout_obligations o
          where o.id=t.stay_segment_checkout_obligation_id and o.cleaning_target_id=t.id
            and o.status='materialized' and o.available_from<=p_at)))
      or (t.cleaning_kind<>'checkout' and t.status in
        ('unassigned','draft_assigned','notified','in_progress','upload_pending','inspection_pending')
        and t.effective_service_date<=(p_at at time zone 'Asia/Seoul')::date
        and (t.available_from is null or t.available_from<=p_at)))
  order by t.id
$$;
revoke all on function private.room_ready_targets(uuid,timestamptz) from public,anon,authenticated,service_role;

-- The snapshot is internal; public responses contain only the allowlisted effects below.
create function private.room_ready_snapshot(p_room uuid,p_at timestamptz)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare room public.rooms; targets uuid[]; result jsonb; blockers text[]:=array[]::text[]; count_value bigint;
begin
  select * into room from public.rooms where id=p_room;
  if room.id is null then raise exception using errcode='P0002',message='ROOM_NOT_FOUND'; end if;
  select array_agg(id order by id) into targets from (select id from private.room_ready_targets(p_room,p_at) limit 101) bounded;
  if coalesce(cardinality(targets),0)>100 then
    raise exception using errcode='54000',message='ROOM_READY_CORRECTION_LIMIT_EXCEEDED'; end if;
  -- Bound historical children as well as currently visible rows. Never truncate a confirmation.
  select count(*) into count_value from (select id from public.cleaning_attempts where cleaning_target_id=any(targets) limit 1001) bounded;
  if count_value>1000 then raise exception using errcode='54000',message='ROOM_READY_CORRECTION_LIMIT_EXCEEDED'; end if;
  select count(*) into count_value from (select s.id from public.cleaning_submissions s join public.cleaning_attempts a
    on a.id=s.cleaning_attempt_id where a.cleaning_target_id=any(targets) limit 1001) bounded;
  if count_value>1000 then raise exception using errcode='54000',message='ROOM_READY_CORRECTION_LIMIT_EXCEEDED'; end if;
  select count(*) into count_value from (select id from public.cleaning_assignments where cleaning_target_id=any(targets) limit 1001) bounded;
  if count_value>1000 then raise exception using errcode='54000',message='ROOM_READY_CORRECTION_LIMIT_EXCEEDED'; end if;
  select count(*) into count_value from (select o.id from public.preparation_obligations o join public.cleaning_attempts a
    on a.id=o.current_attempt_id where a.cleaning_target_id=any(targets) limit 1001) bounded;
  if count_value>1000 then raise exception using errcode='54000',message='ROOM_READY_CORRECTION_LIMIT_EXCEEDED'; end if;
  select count(*) into count_value from (select id from public.room_operation_blocks where room_id=p_room
    and released_at is null and starts_at<=p_at and (ends_at is null or ends_at>p_at) limit 101) bounded;
  if count_value>100 then raise exception using errcode='54000',message='ROOM_READY_CORRECTION_LIMIT_EXCEEDED'; end if;
  select count(*) into count_value from (select id from public.room_issues where room_id=p_room
    and status='open' and blocks_guest_assignment limit 101) bounded;
  if count_value>100 then raise exception using errcode='54000',message='ROOM_READY_CORRECTION_LIMIT_EXCEEDED'; end if;
  if not room.active then blockers:=array_append(blockers,'ROOM_INACTIVE'); end if;
  if not exists(select 1 from public.room_types where id=room.room_type_id and active) then blockers:=array_append(blockers,'ROOM_TYPE_INACTIVE'); end if;
  if room.data_status<>'verified' then blockers:=array_append(blockers,'DATA_UNCONFIRMED'); end if;
  if 'OCCUPIED'=any(private.room_block_reason_codes(p_room,p_at,true,false)) then blockers:=array_append(blockers,'OCCUPIED'); end if;
  if private.room_reservation_phase_at(p_room,p_at)='current' then blockers:=array_append(blockers,'RESERVATION_CURRENT'); end if;
  if exists(select 1 from public.checkout_presence_incidents where room_id=p_room and status='open') then
    blockers:=array_append(blockers,'CHECKOUT_NOT_COMPLETED'); end if;
  if exists(select 1 from public.assignment_change_requests where cleaning_target_id=any(targets) and status='pending') then
    blockers:=array_append(blockers,'ASSIGNMENT_CHANGE_PENDING'); end if;
  -- Reclean/compensation chains need their own approval-preserving correction command.
  if exists(select 1 from public.cleaning_targets where id=any(targets) and (
    source not in ('scheduled_checkout','manual_checkout','stay_room_move_checkout','manual_room_request','stayover_request')
    or status='rejected' or reclean_of_attempt_id is not null or complaint_compensation_decision_id is not null))
    or exists(select 1 from public.cleaning_attempts a join public.cleaning_submissions s on s.cleaning_attempt_id=a.id
      join public.inspection_decisions d on d.submission_id=s.id where a.cleaning_target_id=any(targets))
    or exists(select 1 from public.preparation_obligations o join public.cleaning_attempts a on a.id=o.current_attempt_id
      where a.cleaning_target_id=any(targets) and o.status='approved') then
    blockers:=array_append(blockers,'UNSUPPORTED_CLEANING_CHAIN'); end if;
  -- A timeout is not a provider ACK. Wait for actual terminal evidence, never discard in-flight bytes.
  if exists(select 1 from private.photo_upload_operations op join private.photo_upload_states st on st.operation_id=op.id
      where op.cleaning_target_id=any(targets) and st.status not in ('accepted','compensated'))
    or exists(select 1 from private.photo_upload_admissions ad where ad.cleaning_target_id=any(targets)
      and ad.expires_at>p_at and not exists(select 1 from private.photo_upload_admission_bindings b where b.admission_id=ad.id)) then
    blockers:=array_append(blockers,'PHOTO_UPLOAD_IN_PROGRESS'); end if;
  result:=jsonb_build_object('roomId',room.id,'roomStateVersion',room.state_version,'blockers',to_jsonb(blockers),
    'roomTypeId',room.room_type_id,'active',room.active,'dataStatus',room.data_status,
    'candleCount',private.current_candle_count(p_room),'displayStatusOverride',private.current_room_display_status_override(p_room),
    'targets',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'status',t.status,'version',t.assignment_version,
      'source',t.source,'kind',t.cleaning_kind,'reservationId',t.reservation_id,'availableFrom',t.available_from,'dueAt',t.due_at,
      'checkoutObligationId',t.checkout_obligation_id,'segmentObligationId',t.stay_segment_checkout_obligation_id,
      'serviceDate',t.effective_service_date,'template',t.template_snapshot,'fee',t.fee_snapshot) order by t.id)
      from public.cleaning_targets t where t.id=any(targets)),'[]'::jsonb),
    'assignments',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'targetId',a.cleaning_target_id,'version',a.revision,
      'current',a.is_current,'notifiedAt',a.notified_at,'endedAt',a.ended_at,'maidId',a.maid_profile_id) order by a.id)
      from public.cleaning_assignments a where a.cleaning_target_id=any(targets)),'[]'::jsonb),
    'attempts',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'targetId',a.cleaning_target_id,'assignmentId',a.assignment_id,
      'assignmentRevision',a.assignment_revision,'version',a.execution_version,'status',a.status,
      'startedAt',a.started_at,'fieldCompletedAt',a.field_completed_at,'endedAt',a.ended_at) order by a.id)
      from public.cleaning_attempts a where a.cleaning_target_id=any(targets)),'[]'::jsonb),
    'submissions',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'attemptId',s.cleaning_attempt_id,'status',s.status,
      'submittedAt',s.submitted_at,'current',exists(select 1 from private.submission_current_pointers c where c.submission_id=s.id)) order by s.id)
      from public.cleaning_submissions s join public.cleaning_attempts a on a.id=s.cleaning_attempt_id
      where a.cleaning_target_id=any(targets)),'[]'::jsonb),
    'checkoutObligations',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'version',o.version,'status',o.status,
      'plannedId',o.planned_cleaning_target_id,'currentId',o.current_cleaning_target_id) order by o.id)
      from public.checkout_cleaning_obligations o where o.current_cleaning_target_id=any(targets)),'[]'::jsonb),
    'segmentObligations',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'version',o.version,'status',o.status,
      'targetId',o.cleaning_target_id) order by o.id) from private.stay_segment_checkout_obligations o where o.cleaning_target_id=any(targets)),'[]'::jsonb),
    'preparations',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'version',o.version,'status',o.status,
      'currentAttemptId',o.current_attempt_id,'approvedSubmissionId',o.approved_submission_id) order by o.id)
      from public.preparation_obligations o join public.cleaning_attempts a on a.id=o.current_attempt_id
      where a.cleaning_target_id=any(targets)),'[]'::jsonb),
    'blocks',coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'version',b.version,'startsAt',b.starts_at,'endsAt',b.ends_at) order by b.id)
      from public.room_operation_blocks b where b.room_id=p_room and b.released_at is null and b.starts_at<=p_at
        and (b.ends_at is null or b.ends_at>p_at)),'[]'::jsonb),
    'issues',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'version',i.version) order by i.id)
      from public.room_issues i where i.room_id=p_room and i.status='open' and i.blocks_guest_assignment),'[]'::jsonb));
  return result;
end $$;
revoke all on function private.room_ready_snapshot(uuid,timestamptz) from public,anon,authenticated,service_role;

create function private.room_ready_fingerprint(p_state jsonb,p_actor uuid,p_session uuid,p_reason text,p_evaluated timestamptz,p_expires timestamptz)
returns text language sql immutable set search_path='' as $$
  select encode(extensions.digest(convert_to(jsonb_build_object('state',p_state,'actor',p_actor,'session',p_session,
    'reason',p_reason,'evaluatedEpoch',extract(epoch from p_evaluated),'expiresEpoch',extract(epoch from p_expires))::text,'UTF8'),'sha256'),'hex')
$$;
revoke all on function private.room_ready_fingerprint(jsonb,uuid,uuid,text,timestamptz,timestamptz) from public,anon,authenticated,service_role;

create function public.preview_room_ready_correction(p_actor_profile_id uuid,p_session_id uuid,p_room_id uuid,
  p_reason_code text default 'ADMIN_ROOM_READY_CORRECTION')
returns jsonb language plpgsql security definer set search_path='' as $$
declare state jsonb; at_time timestamptz; expires timestamptz; earning_ack boolean; effects jsonb; warnings text[]:=array[]::text[];
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  perform 1 from public.profiles where id=p_actor_profile_id for share;
  perform 1 from auth.sessions where id=p_session_id and user_id=(select auth_user_id from public.profiles where id=p_actor_profile_id) for share;
  if not found then raise exception using errcode='42501',message='SESSION_REVOKED'; end if;
  perform private.assert_attempt_actor_session_fresh(p_actor_profile_id,p_session_id,true);
  if p_room_id is null or p_reason_code is distinct from 'ADMIN_ROOM_READY_CORRECTION' then
    raise exception using errcode='22023',message='ROOM_READY_CORRECTION_INVALID_INPUT'; end if;
  -- Use one physical instant and serialize with room operations as well as workflow commands.
  perform 1 from public.rooms where id=p_room_id for share;
  at_time:=clock_timestamp(); expires:=at_time+interval '5 minutes';
  state:=private.room_ready_snapshot(p_room_id,at_time);
  earning_ack:=exists(select 1 from jsonb_array_elements(state->'attempts') a
    where a->>'startedAt' is not null or a->>'fieldCompletedAt' is not null)
    or jsonb_array_length(state->'submissions')>0;
  if jsonb_array_length(state->'targets')>0 then warnings:=array_append(warnings,'CANCEL_WITHOUT_NEW_EARNINGS'); end if;
  if earning_ack then warnings:=array_append(warnings,'APPROVE_BEFORE_CANCEL_TO_PRESERVE_EARNINGS'); end if;
  if (state->>'candleCount')::integer>0 then warnings:=array_append(warnings,'PHYSICAL_CANDLE_REMOVAL_REQUIRED'); end if;
  select coalesce(jsonb_agg(jsonb_build_object('cleaningTargetId',t.id,'assignmentId',a.id,'attemptId',x.id,
    'attemptStatus',x.status,'hasSubmission',exists(select 1 from public.cleaning_submissions s
      join public.cleaning_attempts a2 on a2.id=s.cleaning_attempt_id where a2.cleaning_target_id=t.id),
    'fieldCompleted',x.field_completed_at is not null) order by t.id),'[]'::jsonb) into effects
  from private.room_ready_targets(p_room_id,at_time) t
  left join public.cleaning_assignments a on a.cleaning_target_id=t.id and a.is_current
  left join lateral(select a2.* from public.cleaning_attempts a2 where a2.cleaning_target_id=t.id
    order by a2.attempt_number desc,a2.id desc limit 1) x on true;
  perform private.assert_attempt_actor_session_fresh(p_actor_profile_id,p_session_id,true);
  return jsonb_build_object('roomId',p_room_id,'targetStatus','READY','roomStateVersion',state->'roomStateVersion',
    'canApply',jsonb_array_length(state->'blockers')=0,'blockingReasons',state->'blockers','requiresConfirmation',true,
    'requiresEarningAcknowledgement',earning_ack,'effects',jsonb_build_object('cleaningTargets',effects,
      'operationBlockIds',coalesce((select jsonb_agg(b->'id' order by b->>'id') from jsonb_array_elements(state->'blocks') b),'[]'::jsonb),
      'roomIssueIds',coalesce((select jsonb_agg(i->'id' order by i->>'id') from jsonb_array_elements(state->'issues') i),'[]'::jsonb),
      'candleCount',state->'candleCount','displayStatusOverride',state->'displayStatusOverride'),
    'warnings',to_jsonb(warnings),'impactFingerprint',private.room_ready_fingerprint(state,p_actor_profile_id,p_session_id,p_reason_code,at_time,expires),
    'evaluatedAt',at_time,'expiresAt',expires);
end $$;
revoke all on function public.preview_room_ready_correction(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.preview_room_ready_correction(uuid,uuid,uuid,text) to service_role;

-- Extend only the reason-code vocabulary. Existing revocation invariants remain intact.
do $reasons$ declare item record; expression text; begin
  for item in select * from (values ('attempt_capability_revocations','attempt_capability_revocations_reason_code_check'),
    ('offline_work_lease_revocations','offline_work_lease_revocations_reason_code_check')) x(table_name,constraint_name) loop
    select pg_get_expr(c.conbin,c.conrelid) into expression from pg_constraint c
      where c.conrelid=('private.'||item.table_name)::regclass and c.conname=item.constraint_name;
    if expression is null then raise exception 'ROOM_READY_REVOCATION_CONSTRAINT_DRIFT'; end if;
    execute format('alter table private.%I drop constraint %I',item.table_name,item.constraint_name);
    execute format('alter table private.%I add constraint %I check ((%s) or reason_code=''ROOM_READY_CORRECTION'')',
      item.table_name,item.constraint_name,expression);
  end loop;
end $reasons$;

create index audit_events_room_ready_correction_idx on public.audit_events(entity_id,effective_at)
  where event_type='room.ready_corrected';

-- A terminal target alone is insufficient evidence to ignore preserved physical history.
create function private.room_ready_cancelled_attempt(p_attempt public.cleaning_attempts)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.cleaning_targets t
    join public.cleaning_assignments a on a.id=p_attempt.assignment_id and a.cleaning_target_id=t.id
    join public.audit_events e on e.entity_id=t.room_id and e.event_type='room.ready_corrected'
    cross join lateral jsonb_array_elements(e.before_state->'attempts') original
    cross join lateral jsonb_array_elements(e.before_state->'targets') target_proof
    where t.id=p_attempt.cleaning_target_id and t.status='cancelled'
      and t.cancellation_reason_code='ADMIN_ROOM_READY_CORRECTION' and t.cancelled_at=e.effective_at
      and t.cancelled_by=e.actor_profile_id and e.reason_code=t.cancellation_reason_code
      and not a.is_current and a.ended_at is not null and a.ended_at<=e.effective_at
      and original->>'id'=p_attempt.id::text and original->>'assignmentId'=a.id::text
      and original->>'targetId'=t.id::text and target_proof->>'id'=t.id::text
      and (target_proof->>'version')::bigint+1=t.assignment_version
      and (original->>'assignmentRevision')::bigint=p_attempt.assignment_revision
      and ((original->>'version')::bigint=p_attempt.execution_version
        or ((original->>'version')::bigint+1=p_attempt.execution_version
          and original->>'status' in ('scheduled','in_progress') and p_attempt.status in ('superseded','interrupted')))
      and (e.after_state->'cancelledCleaningTargetIds') @> jsonb_build_array(t.id))
$$;
revoke all on function private.room_ready_cancelled_attempt(public.cleaning_attempts) from public,anon,authenticated,service_role;

alter function private.notification_resolution_is_valid(text,text,text,text,text)
  rename to notification_resolution_before_room_ready;
revoke all on function private.notification_resolution_before_room_ready(text,text,text,text,text) from public,anon,authenticated,service_role;
create function private.notification_resolution_is_valid(p_event_family text,p_source_kind text,p_source_id text,p_terminal_kind text,p_terminal_id text)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare evidence public.audit_events; catalog private.notification_event_catalog;
begin
  if p_terminal_kind='audit_event' then
    select * into evidence from public.audit_events where id=p_terminal_id::uuid;
    select * into catalog from private.notification_event_catalog where event_family=p_event_family and source_entity_kind=p_source_kind;
    if evidence.event_type='room.ready_corrected' and evidence.reason_code='ADMIN_ROOM_READY_CORRECTION' then
      if catalog.resolver_kind='assignment_terminal' and p_source_kind='cleaning_assignment' then
        return exists(select 1 from public.cleaning_assignments a join public.cleaning_targets t on t.id=a.cleaning_target_id
          where a.id=p_source_id::uuid and t.room_id=evidence.entity_id and t.status='cancelled'
            and t.cancelled_at=evidence.effective_at and t.cancelled_by=evidence.actor_profile_id
            and t.cancellation_reason_code=evidence.reason_code and not a.is_current and a.ended_at=evidence.effective_at
            and (evidence.after_state->'cancelledCleaningTargetIds') @> jsonb_build_array(t.id)
            and (evidence.before_state->'assignments') @> jsonb_build_array(jsonb_build_object('id',a.id,'current',true)));
      elsif catalog.resolver_kind='submission_terminal' and p_source_kind='cleaning_submission' then
        return exists(select 1 from public.cleaning_submissions s join public.cleaning_attempts a on a.id=s.cleaning_attempt_id
          join public.cleaning_targets t on t.id=a.cleaning_target_id where s.id=p_source_id::uuid
            and t.room_id=evidence.entity_id and t.cancelled_at=evidence.effective_at and private.room_ready_cancelled_attempt(a));
      end if;
    end if;
  end if;
  return private.notification_resolution_before_room_ready(p_event_family,p_source_kind,p_source_id,p_terminal_kind,p_terminal_id);
exception when invalid_text_representation or numeric_value_out_of_range then return false;
end $$;
revoke all on function private.notification_resolution_is_valid(text,text,text,text,text) from public,anon,authenticated,service_role;

create function public.apply_room_ready_correction(p_actor_profile_id uuid,p_session_id uuid,p_room_id uuid,
  p_expected_room_version bigint,p_impact_fingerprint text,p_evaluated_at timestamptz,p_expires_at timestamptz,
  p_confirmed boolean,p_acknowledge_no_new_earnings boolean,p_confirm_physical_candle_removal boolean,
  p_reason_code text,p_idempotency_key text,p_request_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare state jsonb; at_time timestamptz; result jsonb; actor public.profiles; room public.rooms;
  target public.cleaning_targets; assignment public.cleaning_assignments; attempt public.cleaning_attempts;
  target_ids uuid[]; block_ids uuid[]; issue_ids uuid[]; canonical_hash text; item record; audit_key text; audit_id uuid;
  previous_kind text:=current_setting('app.notification_terminal_kind',true);
  previous_id text:=current_setting('app.notification_terminal_id',true);
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  perform 1 from public.profiles where id=p_actor_profile_id for share;
  perform 1 from auth.sessions where id=p_session_id and user_id=(select auth_user_id from public.profiles where id=p_actor_profile_id) for share;
  if not found then raise exception using errcode='42501',message='SESSION_REVOKED'; end if;
  actor:=private.assert_attempt_actor_session_fresh(p_actor_profile_id,p_session_id,true);
  if p_room_id is null or p_expected_room_version is null or p_expected_room_version<1
    or p_reason_code is distinct from 'ADMIN_ROOM_READY_CORRECTION'
    or p_impact_fingerprint is null or p_impact_fingerprint !~ '^[0-9a-f]{64}$'
    or p_evaluated_at is null or p_expires_at is null or not isfinite(p_evaluated_at) or not isfinite(p_expires_at)
    or p_confirmed is null or p_acknowledge_no_new_earnings is null or p_confirm_physical_candle_removal is null then
    raise exception using errcode='22023',message='ROOM_READY_CORRECTION_INVALID_INPUT'; end if;
  -- Only the trusted HTTP adapter supplies this canonical hash; clients cannot select it.
  -- Keep CALLER receipt identity identical to the maintenance admission contract.
  if p_request_hash is null or p_request_hash !~ '^[0-9a-f]{64}$' then raise exception using errcode='22023',message='ROOM_READY_CORRECTION_INVALID_INPUT'; end if;
  canonical_hash:=p_request_hash;
  result:=private.replay_command(p_actor_profile_id,'room.ready_correction',p_idempotency_key,canonical_hash);
  if result is not null then return result; end if;
  select * into room from public.rooms where id=p_room_id for update;
  if room.id is null then raise exception using errcode='P0002',message='ROOM_NOT_FOUND'; end if;
  at_time:=clock_timestamp();
  if p_evaluated_at>at_time or p_expires_at<>p_evaluated_at+interval '5 minutes' or p_expires_at<=at_time
    or room.state_version<>p_expected_room_version then raise exception using errcode='40001',message='ROOM_READY_PREVIEW_STALE'; end if;
  state:=private.room_ready_snapshot(p_room_id,at_time);
  if private.room_ready_fingerprint(state,p_actor_profile_id,p_session_id,p_reason_code,p_evaluated_at,p_expires_at)<>p_impact_fingerprint then
    raise exception using errcode='40001',message='ROOM_READY_PREVIEW_STALE'; end if;
  if jsonb_array_length(state->'blockers')>0 then raise exception using errcode='55000',message='ROOM_READY_CORRECTION_BLOCKED'; end if;
  if not p_confirmed then raise exception using errcode='55000',message='ROOM_READY_CONFIRMATION_REQUIRED'; end if;
  if not p_acknowledge_no_new_earnings and (exists(select 1 from jsonb_array_elements(state->'attempts') a
    where a->>'startedAt' is not null or a->>'fieldCompletedAt' is not null) or jsonb_array_length(state->'submissions')>0) then
    raise exception using errcode='55000',message='ROOM_READY_EARNING_ACKNOWLEDGEMENT_REQUIRED'; end if;
  if (state->>'candleCount')::integer>0 and not p_confirm_physical_candle_removal then
    raise exception using errcode='55000',message='ROOM_READY_CANDLE_CONFIRMATION_REQUIRED'; end if;
  select coalesce(array_agg((t->>'id')::uuid order by t->>'id'),array[]::uuid[]) into target_ids from jsonb_array_elements(state->'targets') t;
  select coalesce(array_agg((t->>'id')::uuid order by t->>'id'),array[]::uuid[]) into block_ids from jsonb_array_elements(state->'blocks') t;
  select coalesce(array_agg((t->>'id')::uuid order by t->>'id'),array[]::uuid[]) into issue_ids from jsonb_array_elements(state->'issues') t;
  for target in select * from public.cleaning_targets where id=any(target_ids) order by id for update loop
    for assignment in select * from public.cleaning_assignments where cleaning_target_id=target.id and is_current order by id for update loop
      update public.cleaning_assignments set is_current=false,ended_at=at_time,change_reason_code=p_reason_code where id=assignment.id;
      if assignment.notified_at is not null then
        perform private.emit_notification_v1('assignment.prestart_unassigned',p_actor_profile_id,assignment.maid_profile_id,
          'cleaning_assignment',assignment.id::text,'객실 상태 정정으로 청소가 취소되었습니다',
          '관리자가 확인 후 청소 요청을 취소했습니다. 이 취소로 새 수당은 발생하지 않습니다.',p_room_id,target.id,target.id,at_time);
      end if;
    end loop;
    for attempt in select * from public.cleaning_attempts where cleaning_target_id=target.id order by id for update loop
      if attempt.status in ('scheduled','in_progress') then
        update public.cleaning_attempts set status=case when attempt.status='scheduled' then 'superseded'::public.attempt_status
          else 'interrupted'::public.attempt_status end,ended_at=at_time,end_reason=p_reason_code,execution_version=execution_version+1
          where id=attempt.id;
      end if;
      -- Completed/submitted physical history is preserved, and its remaining authority is revoked.
      insert into private.attempt_capability_revocations(capability_id,revoked_at,reason_code,actor_profile_id)
        select id,at_time,'ROOM_READY_CORRECTION',p_actor_profile_id from private.attempt_capability_grants where attempt_id=attempt.id
        on conflict(capability_id) do nothing;
      insert into private.offline_work_lease_revocations(lease_id,revoked_at,reason_code,metadata_expires_at)
        select id,at_time,'ROOM_READY_CORRECTION',metadata_expires_at from private.offline_work_leases
        where attempt_id=attempt.id and metadata_expires_at>at_time on conflict(lease_id) do nothing;
    end loop;
    update public.room_pin_access_leases set revoked_at=at_time,revoke_reason_code=p_reason_code
      where cleaning_target_id=target.id and revoked_at is null;
    update public.cleaning_targets set status='cancelled',assignment_version=assignment_version+1,
      cancelled_at=at_time,cancelled_by=p_actor_profile_id,cancellation_reason_code=p_reason_code where id=target.id;
    update public.checkout_cleaning_obligations set status='cancelled',version=version+1,
      cancelled_at=at_time,cancellation_reason_code=p_reason_code where current_cleaning_target_id=target.id and status='materialized';
    update private.stay_segment_checkout_obligations set status='cancelled',version=version+1
      where cleaning_target_id=target.id and status='materialized';
  end loop;
  update public.room_operation_blocks set released_at=at_time,released_by=p_actor_profile_id,release_reason_code=p_reason_code,version=version+1 where id=any(block_ids);
  update public.room_issues set status='resolved',resolved_at=at_time,resolved_by=p_actor_profile_id,resolution_reason_code=p_reason_code,version=version+1 where id=any(issue_ids);
  if (state->>'candleCount')::integer>0 then
    insert into public.room_candle_events(room_id,count_before,count_after,physically_verified,reason_code,actor_profile_id,effective_at)
      values(p_room_id,(state->>'candleCount')::integer,0,true,p_reason_code,p_actor_profile_id,at_time);
  end if;
  if cardinality(private.room_block_reason_codes(p_room_id,clock_timestamp(),true,true))>0 then
    raise exception using errcode='40001',message='ROOM_READY_PREVIEW_STALE'; end if;
  update public.rooms set state_version=state_version+1 where id=p_room_id returning * into room;
  audit_key:=private.audit_command_key(p_actor_profile_id,'room.ready_correction',p_idempotency_key);
  insert into private.room_display_status_overrides(command_key,room_id,target_status,actor_profile_id,reason_code,room_state_version,request_hash,recorded_at)
    values(audit_key,p_room_id,null,p_actor_profile_id,p_reason_code,room.state_version,canonical_hash,at_time);
  result:=jsonb_build_object('roomId',p_room_id,'targetStatus','READY','roomStateVersion',room.state_version,'recordedAt',at_time,
    'cancelledCleaningTargetIds',to_jsonb(target_ids),'releasedOperationBlockIds',to_jsonb(block_ids),'resolvedRoomIssueIds',to_jsonb(issue_ids),
    'candlesCleared',(state->>'candleCount')::integer>0);
  -- Only IDs, states and versions: no guest data, PIN, photo bytes, session or preview token.
  insert into public.audit_events(actor_profile_id,actor_display_name_snapshot,event_type,entity_type,entity_id,effective_at,reason_code,
    before_state,after_state,request_hash,idempotency_key)
    values(p_actor_profile_id,actor.display_name,'room.ready_corrected','room',p_room_id,at_time,p_reason_code,
      jsonb_build_object('attempts',state->'attempts','assignments',state->'assignments','targets',
        (select coalesce(jsonb_agg(jsonb_build_object('id',t->'id','version',t->'version')),'[]'::jsonb) from jsonb_array_elements(state->'targets') t)),
      result,canonical_hash,audit_key) returning id into audit_id;
  -- Resolve action cards only after durable terminal evidence exists, including pending inspections.
  perform set_config('app.notification_terminal_kind','audit_event',true);
  perform set_config('app.notification_terminal_id',audit_id::text,true);
  for item in select distinct n.event_family,n.source_entity_kind,n.source_entity_id from public.notifications n
    join private.notification_event_catalog c on c.event_family=n.event_family
    where n.contract_version=1 and n.resolved_at is null and (
      (c.resolver_kind='assignment_terminal' and n.source_entity_kind='cleaning_assignment' and exists(
        select 1 from public.cleaning_assignments a where a.id::text=n.source_entity_id and a.cleaning_target_id=any(target_ids)
          and a.ended_at=at_time and not a.is_current))
      or (c.resolver_kind='submission_terminal' and n.source_entity_kind='cleaning_submission' and exists(
        select 1 from public.cleaning_submissions s join public.cleaning_attempts a on a.id=s.cleaning_attempt_id
        where s.id::text=n.source_entity_id and a.cleaning_target_id=any(target_ids)))) loop
    perform private.resolve_notifications_v1(item.event_family,item.source_entity_kind,item.source_entity_id,at_time);
  end loop;
  perform set_config('app.notification_terminal_kind',coalesce(previous_kind,''),true);
  perform set_config('app.notification_terminal_id',coalesce(previous_id,''),true);
  perform private.assert_attempt_actor_session_fresh(p_actor_profile_id,p_session_id,true);
  perform private.complete_command(p_actor_profile_id,'room.ready_correction',p_idempotency_key,canonical_hash,p_room_id,result);
  return result;
end $$;
revoke all on function public.apply_room_ready_correction(uuid,uuid,uuid,bigint,text,timestamptz,timestamptz,boolean,boolean,boolean,text,text,text)
  from public,anon,authenticated;
grant execute on function public.apply_room_ready_correction(uuid,uuid,uuid,bigint,text,timestamptz,timestamptz,boolean,boolean,boolean,text,text,text) to service_role;

-- Keep completed physical history visible in history, but remove exactly corrected work from live queues.
-- Source drift fails installation rather than silently leaving a lifecycle permanently blocked.
do $patch$ declare item record; definition text; begin
  for item in select * from (values
    ('private.activation_reason_at_before_stay_segments(public.cleaning_targets,public.cleaning_assignments,timestamptz)',
      'and previous_attempt.status in (''scheduled'', ''in_progress'', ''field_completed'', ''upload_pending'', ''submitted'')',
      'and not private.room_ready_cancelled_attempt(previous_attempt) and previous_attempt.status in (''scheduled'', ''in_progress'', ''field_completed'', ''upload_pending'', ''submitted'')'),
    ('private.activation_reason_at(public.cleaning_targets,public.cleaning_assignments,timestamptz)',
      'and (previous_attempt.status=''in_progress'' or (',
      'and not private.room_ready_cancelled_attempt(previous_attempt) and (previous_attempt.status=''in_progress'' or ('),
    ('private.assignment_preview_snapshot_at(uuid,date,timestamptz)',
      'and previous_attempt.status in (''scheduled'',''in_progress'',''field_completed'',''upload_pending'',''submitted'')',
      'and not private.room_ready_cancelled_attempt(previous_attempt) and previous_attempt.status in (''scheduled'',''in_progress'',''field_completed'',''upload_pending'',''submitted'')'),
    ('private.assignment_preview_snapshot_at(uuid,date,timestamptz)',
      'and busy.status in (''scheduled'',''in_progress'',''field_completed'',''upload_pending'',''submitted'')',
      'and not private.room_ready_cancelled_attempt(busy) and busy.status in (''scheduled'',''in_progress'',''field_completed'',''upload_pending'',''submitted'')'),
    ('private.attempt_blocks_assignment(public.cleaning_attempts)',
      'select p_attempt.status<>''superseded''',
      'select not private.room_ready_cancelled_attempt(p_attempt) and p_attempt.status<>''superseded'''),
    ('private.developer_room_deactivation_impact(uuid,timestamptz)',
      'and attempt.status in (''scheduled'', ''in_progress'', ''field_completed'', ''upload_pending'', ''submitted'')',
      'and not private.room_ready_cancelled_attempt(attempt) and attempt.status in (''scheduled'', ''in_progress'', ''field_completed'', ''upload_pending'', ''submitted'')'),
    ('public.list_cleaning_inspections_page(uuid,uuid,timestamptz,uuid,integer)',
      'where submission.status = ''submitted''',
      'where submission.status = ''submitted'' and not exists(select 1 from public.cleaning_attempts cancelled_attempt where cancelled_attempt.id=submission.cleaning_attempt_id and private.room_ready_cancelled_attempt(cancelled_attempt))'),
    ('public.list_cleaning_submissions(uuid,uuid,boolean)',
      '(not p_pending_only or s.status=''submitted'')',
      '(not p_pending_only or (s.status=''submitted'' and not private.room_ready_cancelled_attempt(a)))'),
    ('public.override_room_display_status(uuid,uuid,uuid,text,bigint,text,text,text)',
      'v_before_status := private.current_room_display_status_override(p_room_id);',
      'if p_target_status=''READY'' and (cardinality(private.room_block_reason_codes(p_room_id,clock_timestamp(),true,true))>0 or exists(select 1 from public.checkout_presence_incidents where room_id=p_room_id and status=''open'')) then raise exception using errcode=''55000'',message=''ROOM_READY_CORRECTION_REQUIRED''; end if; v_before_status := private.current_room_display_status_override(p_room_id);')
  ) edits(signature,needle,replacement) loop
    definition:=replace(pg_get_functiondef(item.signature::regprocedure),E'\r\n',E'\n');
    if (length(definition)-length(replace(definition,item.needle,'')))/length(item.needle)<>1 then
      raise exception 'ROOM_READY_CALLER_SOURCE_DRIFT: %',item.signature; end if;
    execute replace(definition,item.needle,item.replacement);
  end loop;
end $patch$;


-- Append-only admission registration. Source130 and all its route bindings stay immutable.
alter function private.operation_http_route(text) rename to operation_http_route_before_room_ready_correction;
revoke all on function private.operation_http_route_before_room_ready_correction(text) from public,anon,authenticated,service_role;
create function private.operation_http_route(p_route text)
returns jsonb language sql immutable set search_path='' as $$
  select case when p_route='applyRoomReadyCorrection' then jsonb_build_object(
    'routeId','applyRoomReadyCorrection','kind','BUSINESS_WRITE','authority','ACTIVE_SESSION',
    'hashMode','CALLER','commandName','room.ready_correction','keyArgument','p_idempotency_key')
  else private.operation_http_route_before_room_ready_correction(p_route) end
$$;
revoke all on function private.operation_http_route(text) from public,anon,authenticated,service_role;

-- Explicit public projection: no raw proof snapshot, fingerprint, request hash or arbitrary JSON.
create function private.room_ready_audit_summary(p_after jsonb)
returns jsonb language sql immutable set search_path='' as $$
  select jsonb_build_object('roomStateVersion',p_after->'roomStateVersion',
    'cancelledCleaningCount',jsonb_array_length(coalesce(p_after->'cancelledCleaningTargetIds','[]'::jsonb)),
    'releasedOperationBlockCount',jsonb_array_length(coalesce(p_after->'releasedOperationBlockIds','[]'::jsonb)),
    'resolvedRoomIssueCount',jsonb_array_length(coalesce(p_after->'resolvedRoomIssueIds','[]'::jsonb)),
    'candlesCleared',p_after->'candlesCleared')
$$;
revoke all on function private.room_ready_audit_summary(jsonb) from public,anon,authenticated,service_role;

-- Keep the public function identity and its reviewed fresh-session caller classification.
-- Refuse unexpected source changes instead of replacing an unknown history implementation.
do $room_history$
declare definition text; needle text; replacement text;
begin
  definition:=pg_get_functiondef('public.list_room_events(uuid,uuid,uuid,integer)'::regprocedure);
  needle:='when ''room.master_data_changed'' then ''room_configuration''';
  replacement:=needle||E'\n            when ''room.ready_corrected'' then ''room_configuration''';
  if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then
    raise exception 'ROOM_READY_HISTORY_SOURCE_DRIFT'; end if;
  definition:=replace(definition,needle,replacement);
  needle:='''summary'', case audit.event_type';
  replacement:=needle||E'\n            when ''room.ready_corrected'' then private.room_ready_audit_summary(audit.after_state)';
  if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then
    raise exception 'ROOM_READY_HISTORY_SOURCE_DRIFT'; end if;
  definition:=replace(definition,needle,replacement);
  needle:='''room.master_data_changed'',';
  replacement:=needle||E'\n          ''room.ready_corrected'',';
  if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then
    raise exception 'ROOM_READY_HISTORY_SOURCE_DRIFT'; end if;
  execute replace(definition,needle,replacement);
end
$room_history$;

alter function private.developer_audit_event_types() rename to developer_audit_event_types_before_ready_correction;
revoke all on function private.developer_audit_event_types_before_ready_correction() from public,anon,authenticated,service_role;
create function private.developer_audit_event_types()
returns text[] language sql immutable set search_path='' as $$
  select array_append(private.developer_audit_event_types_before_ready_correction(),'room.ready_corrected')
$$;
revoke all on function private.developer_audit_event_types() from public,anon,authenticated,service_role;
alter function public.list_developer_audit_events(uuid,text[],uuid,timestamptz,timestamptz,timestamptz,uuid,integer) set schema private;
alter function private.list_developer_audit_events(uuid,text[],uuid,timestamptz,timestamptz,timestamptz,uuid,integer)
  rename to list_developer_audit_events_before_ready_correction;
revoke all on function private.list_developer_audit_events_before_ready_correction(uuid,text[],uuid,timestamptz,timestamptz,timestamptz,uuid,integer)
  from public,anon,authenticated,service_role;
create function public.list_developer_audit_events(
  p_actor_profile_id uuid,p_event_types text[] default null,p_filter_actor_profile_id uuid default null,
  p_from timestamptz default null,p_to timestamptz default null,p_before_recorded_at timestamptz default null,
  p_before_id uuid default null,p_limit integer default 50
) returns table(id uuid,event_type text,entity_type text,entity_id uuid,actor_profile_id uuid,
  actor_display_name text,effective_at timestamptz,recorded_at timestamptz,reason_code text,summary jsonb)
language plpgsql security definer set search_path='' as $$
declare previous_types text[]; allowed_types text[]:=private.developer_audit_event_types();
  from_at timestamptz:=coalesce(p_from,clock_timestamp()-interval '7 days');
  to_at timestamptz:=coalesce(p_to,clock_timestamp());
begin
  perform private.assert_active_developer(p_actor_profile_id);
  if p_limit is null or p_limit not between 1 and 100 or from_at>to_at or to_at-from_at>interval '31 days'
    or (p_before_recorded_at is null)<>(p_before_id is null)
    or (p_event_types is not null and (coalesce(cardinality(p_event_types),0)=0
      or exists(select 1 from unnest(p_event_types) requested where requested is null or requested<>all(allowed_types)))) then
    raise exception using errcode='22023',message='INVALID_AUDIT_QUERY'; end if;
  if p_event_types is not null then
    select coalesce(array_agg(requested),array[]::text[]) into previous_types
      from unnest(p_event_types) requested where requested<>'room.ready_corrected';
    if cardinality(previous_types)=0 then previous_types:=array['account.created']; end if;
  end if;
  return query select merged.* from (
    select previous.* from private.list_developer_audit_events_before_ready_correction(
      p_actor_profile_id,previous_types,p_filter_actor_profile_id,from_at,to_at,p_before_recorded_at,p_before_id,p_limit) previous
      where p_event_types is null or previous.event_type=any(p_event_types)
    union all
    select audit.id,audit.event_type,audit.entity_type,audit.entity_id,audit.actor_profile_id,
      audit.actor_display_name_snapshot,audit.effective_at,audit.recorded_at,audit.reason_code,
      private.room_ready_audit_summary(audit.after_state)
    from public.audit_events audit where audit.event_type='room.ready_corrected'
      and (p_event_types is null or audit.event_type=any(p_event_types))
      and audit.recorded_at>=from_at and audit.recorded_at<=to_at
      and (p_filter_actor_profile_id is null or audit.actor_profile_id=p_filter_actor_profile_id)
      and (p_before_recorded_at is null or (audit.recorded_at,audit.id)<(p_before_recorded_at,p_before_id))
    order by recorded_at desc,id desc limit p_limit
  ) merged order by merged.recorded_at desc,merged.id desc limit p_limit;
end
$$;
revoke all on function public.list_developer_audit_events(uuid,text[],uuid,timestamptz,timestamptz,timestamptz,uuid,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.list_developer_audit_events(uuid,text[],uuid,timestamptz,timestamptz,timestamptz,uuid,integer) to service_role;
