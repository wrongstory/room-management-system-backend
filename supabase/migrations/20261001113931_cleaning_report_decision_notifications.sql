-- #308: immediate opposite-role notifications for immutable reports/decisions.
-- No historical delivery/backfill, source mutation, bonus or inspection effect.
create index audit_bomb_report_notification_source_idx on public.audit_events(entity_id,id)
 where event_type='submission.bomb_reported' and entity_type='bomb_room_report';
create index audit_bomb_decision_notification_source_idx on public.audit_events(entity_id,id)
 where event_type='inspection.bomb_decided' and entity_type='bomb_room_decision';
create index audit_attempt_issue_notification_source_idx on public.audit_events((after_state->>'issueId'),id)
 where event_type='room.report_issue' and entity_type='room';

insert into private.notification_event_catalog(event_family,category,source_entity_kind,
 recipient_capability,requires_action,push_eligible,resolver_kind,deep_link_kind,group_family,group_scope_kind)
values
 ('bomb.reported_admin','bomb_room_reported','bomb_room_report','admin.inspection_queue',false,true,'none','cleaningTarget','bomb_room_reported','room'),
 ('room_issue.reported_admin','room_issue_reported','attempt_room_issue_report','admin.inspection_queue',false,true,'none','cleaningTarget','room_issue_reported','room'),
 ('bomb.decided_maid','bomb_room_decided','bomb_room_decision','maid.inspection_subject',false,true,'none','submission','bomb_room_decided','room');

alter function private.notification_source_is_valid(text,uuid,uuid,text,uuid,uuid,uuid)
 rename to notification_source_is_valid_before_cleaning_reports;
create function private.notification_source_is_valid(p_event_family text,p_actor uuid,p_recipient uuid,p_source_id text,
 p_room uuid,p_cleaning_target uuid,p_deep_link_entity uuid) returns boolean
language plpgsql volatile security definer set search_path='' as $$
declare audit public.audit_events; attempt public.cleaning_attempts; target public.cleaning_targets;
 assignment public.cleaning_assignments; report private.bomb_room_reports; issue private.attempt_room_issue_reports;
 room_issue public.room_issues; decision private.bomb_room_decisions; submission public.cleaning_submissions;
begin
 if p_event_family not in ('bomb.reported_admin','room_issue.reported_admin','bomb.decided_maid') then
  return private.notification_source_is_valid_before_cleaning_reports(
   p_event_family,p_actor,p_recipient,p_source_id,p_room,p_cleaning_target,p_deep_link_entity);
 end if;
 if current_setting('app.notification_terminal_kind',true) is distinct from 'audit_event' then return false; end if;
 select * into audit from public.audit_events where id=nullif(current_setting('app.notification_terminal_id',true),'')::uuid;
 if audit.id is null or audit.actor_profile_id is distinct from p_actor then return false; end if;
 if p_event_family='bomb.reported_admin' then
  select * into report from private.bomb_room_reports where id=p_source_id::uuid;
  if report.id is null or report.reported_by is distinct from p_actor
   or audit.event_type<>'submission.bomb_reported' or audit.entity_type<>'bomb_room_report'
   or audit.entity_id<>report.id or audit.effective_at<>report.reported_at
   or audit.after_state<>jsonb_build_object('attemptId',report.cleaning_attempt_id,
    'evidenceCount',(select count(*) from private.bomb_room_report_evidence where report_id=report.id))
   or not exists(select 1 from private.bomb_room_report_evidence where report_id=report.id)
   or exists(select 1 from public.audit_events prior where prior.event_type='submission.bomb_reported'
    and prior.entity_type='bomb_room_report' and prior.entity_id=report.id and prior.id<>audit.id) then return false; end if;
  select * into attempt from public.cleaning_attempts where id=report.cleaning_attempt_id;
 elsif p_event_family='room_issue.reported_admin' then
  select * into issue from private.attempt_room_issue_reports where issue_id=p_source_id::uuid;
  select * into room_issue from public.room_issues where id=issue.issue_id;
  if issue.issue_id is null or room_issue.id is null or room_issue.reported_by is distinct from p_actor
   or room_issue.status<>'open' or room_issue.category<>'cleaning_observation' or room_issue.severity<>'warning'
   or room_issue.blocks_guest_assignment or audit.event_type<>'room.report_issue' or audit.entity_type<>'room'
   or audit.entity_id<>room_issue.room_id or audit.effective_at<issue.reported_at
   or audit.after_state<>jsonb_build_object('issueId',issue.issue_id,'category','cleaning_observation',
    'severity','warning','blocksGuestAssignment',false,'status','open')
   or exists(select 1 from public.audit_events prior where prior.event_type='room.report_issue'
    and prior.entity_type='room' and prior.after_state->>'issueId'=issue.issue_id::text and prior.id<>audit.id) then return false; end if;
  select * into attempt from public.cleaning_attempts where id=issue.cleaning_attempt_id;
 else
  select * into decision from private.bomb_room_decisions where id=p_source_id::uuid;
  select * into report from private.bomb_room_reports where id=decision.report_id;
  select * into submission from public.cleaning_submissions where id=decision.submission_id;
  if decision.id is null or report.id is null or submission.id is null
   or decision.decided_by is distinct from p_actor or audit.event_type<>'inspection.bomb_decided'
   or audit.entity_type<>'bomb_room_decision' or audit.entity_id<>decision.id
   or audit.effective_at<>decision.decided_at or audit.reason_code is distinct from decision.reason_code
   or audit.after_state<>jsonb_build_object('submissionId',submission.id,'decision',decision.decision)
   or report.cleaning_attempt_id<>submission.cleaning_attempt_id or submission.status<>'submitted'
   or not exists(select 1 from private.bomb_room_report_seals seal
    where seal.report_id=report.id and seal.submission_id=submission.id)
   or not exists(select 1 from private.submission_current_pointers pointer
    where pointer.submission_id=submission.id and pointer.cleaning_attempt_id=submission.cleaning_attempt_id)
   or exists(select 1 from public.audit_events prior where prior.event_type='inspection.bomb_decided'
    and prior.entity_type='bomb_room_decision' and prior.entity_id=decision.id and prior.id<>audit.id)
   or not exists(select 1 from public.profiles actor where actor.id=p_actor and actor.role='admin'
    and actor.status='active' and not actor.must_change_password)
   or p_deep_link_entity is distinct from submission.id then return false; end if;
  select * into attempt from public.cleaning_attempts where id=report.cleaning_attempt_id;
  if p_recipient is distinct from attempt.maid_profile_id or report.reported_by<>attempt.maid_profile_id then return false; end if;
 end if;
 select * into target from public.cleaning_targets where id=attempt.cleaning_target_id;
 select * into assignment from public.cleaning_assignments where id=attempt.assignment_id;
 if attempt.id is null or target.id is null or assignment.id is null
  or assignment.cleaning_target_id<>target.id or assignment.maid_profile_id<>attempt.maid_profile_id
  or assignment.revision<>attempt.assignment_revision or assignment.notified_at is null
  or target.room_id is distinct from p_room or target.id is distinct from p_cleaning_target then return false; end if;
 if p_event_family='bomb.decided_maid' then return true; end if;
 return attempt.maid_profile_id=p_actor and assignment.is_current and assignment.ended_at is null
  and target.assignment_version=assignment.revision and target.status<>'cancelled'
  and p_deep_link_entity=target.id and attempt.status in ('scheduled','in_progress','field_completed','upload_pending')
  and (p_event_family<>'room_issue.reported_admin' or (attempt.status<>'scheduled' and room_issue.room_id=target.room_id))
  and not exists(select 1 from private.submission_current_pointers where cleaning_attempt_id=attempt.id)
  and exists(select 1 from public.profiles actor where actor.id=p_actor and actor.role='maid'
   and actor.status='active' and not actor.must_change_password)
  and exists(select 1 from public.profiles recipient where recipient.id=p_recipient and recipient.role='admin');
exception when invalid_text_representation or numeric_value_out_of_range then return false;
end $$;

create function private.dispatch_cleaning_report_decision_notification() returns trigger
language plpgsql security definer set search_path='' as $$
declare attempt public.cleaning_attempts; target public.cleaning_targets; recipient record;
 family text; kind text; source_id uuid; deep_id uuid; title_text text; body_text text;
 previous_kind text:=current_setting('app.notification_terminal_kind',true);
 previous_id text:=current_setting('app.notification_terminal_id',true);
begin
 if new.event_type='submission.bomb_reported' then
  source_id:=new.entity_id; family:='bomb.reported_admin'; kind:='bomb_room_report';
  select a.* into attempt from private.bomb_room_reports r join public.cleaning_attempts a on a.id=r.cleaning_attempt_id where r.id=source_id;
  title_text:='폭탄방 신고가 접수되었습니다'; body_text:='담당 메이드가 폭탄방을 신고했습니다. 업무 상세를 확인해 주세요.';
 elsif new.event_type='room.report_issue' then
  source_id:=(new.after_state->>'issueId')::uuid;
  -- Admin-created/general room issues belong to their existing domain family.
  if not exists(select 1 from private.attempt_room_issue_reports where issue_id=source_id) then return null; end if;
  family:='room_issue.reported_admin'; kind:='attempt_room_issue_report';
  select a.* into attempt from private.attempt_room_issue_reports r join public.cleaning_attempts a on a.id=r.cleaning_attempt_id where r.issue_id=source_id;
  title_text:='객실 특이사항이 접수되었습니다'; body_text:='담당 메이드가 객실 특이사항을 신고했습니다. 업무 상세를 확인해 주세요.';
 elsif new.event_type='inspection.bomb_decided' then
  source_id:=new.entity_id; family:='bomb.decided_maid'; kind:='bomb_room_decision';
  select a.*,d.submission_id into recipient from private.bomb_room_decisions d
   join private.bomb_room_reports r on r.id=d.report_id join public.cleaning_attempts a on a.id=r.cleaning_attempt_id where d.id=source_id;
  select * into attempt from public.cleaning_attempts where id=recipient.id;
  deep_id:=recipient.submission_id;
  title_text:='폭탄방 판정이 등록되었습니다'; body_text:='관리자가 폭탄방 여부를 판정했습니다. 검수 결과와 구분하여 확인해 주세요.';
 else return null; end if;
 select * into target from public.cleaning_targets where id=attempt.cleaning_target_id;
 if attempt.id is null or target.id is null then raise exception using errcode='23514',message='NOTIFICATION_PROVENANCE_INVALID'; end if;
 perform set_config('app.notification_terminal_kind','audit_event',true);
 perform set_config('app.notification_terminal_id',new.id::text,true);
 if family='bomb.decided_maid' then
  perform private.emit_notification_v1(family,new.actor_profile_id,attempt.maid_profile_id,kind,source_id::text,
   title_text,body_text,target.room_id,target.id,deep_id,new.recorded_at);
 else
  -- Read-only recipient scan avoids reverse locks against account lifecycle.
  for recipient in select id from public.profiles where role='admin' order by id loop
   perform private.emit_notification_v1(family,new.actor_profile_id,recipient.id,kind,source_id::text,
    title_text,body_text,target.room_id,target.id,target.id,new.recorded_at);
  end loop;
 end if;
 perform set_config('app.notification_terminal_kind',coalesce(previous_kind,''),true);
 perform set_config('app.notification_terminal_id',coalesce(previous_id,''),true);
 return null;
exception when others then
 perform set_config('app.notification_terminal_kind',coalesce(previous_kind,''),true);
 perform set_config('app.notification_terminal_id',coalesce(previous_id,''),true);
 raise;
end $$;
create trigger audit_cleaning_report_decision_notification after insert on public.audit_events
 for each row execute function private.dispatch_cleaning_report_decision_notification();
revoke all on function private.dispatch_cleaning_report_decision_notification(),
 private.notification_source_is_valid(text,uuid,uuid,text,uuid,uuid,uuid),
 private.notification_source_is_valid_before_cleaning_reports(text,uuid,uuid,text,uuid,uuid,uuid)
 from public,anon,authenticated,service_role;
