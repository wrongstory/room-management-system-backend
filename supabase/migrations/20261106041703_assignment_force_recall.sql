do $reasons$ declare item record; expression text; begin
  for item in select * from (values ('attempt_capability_revocations','attempt_capability_revocations_reason_code_check'),
    ('offline_work_lease_revocations','offline_work_lease_revocations_reason_code_check')) x(table_name,constraint_name) loop
    select pg_get_expr(c.conbin,c.conrelid) into expression from pg_constraint c
      where c.conrelid=('private.'||item.table_name)::regclass and c.conname=item.constraint_name;
    if expression is null then raise exception 'FORCE_RECALL_REVOCATION_CONSTRAINT_DRIFT'; end if;
    execute format('alter table private.%I drop constraint %I',item.table_name,item.constraint_name);
    execute format('alter table private.%I add constraint %I check ((%s) or reason_code=''ADMIN_FORCE_RECALL'')',
      item.table_name,item.constraint_name,expression);
  end loop;
end $reasons$;

-- Extend the resolver solely for the receipt of this exact ended assignment.
alter function private.notification_resolution_is_valid(text,text,text,text,text) rename to notification_resolution_before_force_recall;
revoke all on function private.notification_resolution_before_force_recall(text,text,text,text,text) from public,anon,authenticated,service_role;
create function private.notification_resolution_is_valid(p_event_family text,p_source_kind text,p_source_id text,p_terminal_kind text,p_terminal_id text)
returns boolean language plpgsql volatile security definer set search_path='' as $$
begin
  if p_terminal_kind='audit_event' and p_source_kind='cleaning_assignment' and exists (
    select 1 from public.audit_events e
    join public.cleaning_assignments a on a.id=e.entity_id and a.id::text=p_source_id
    join public.cleaning_attempts x on x.assignment_id=a.id and x.id::text=(e.after_state->>'attemptId')
    join private.notification_event_catalog c on c.event_family=p_event_family
      and c.resolver_kind='assignment_terminal' and c.source_entity_kind=p_source_kind
    where e.id::text=p_terminal_id and e.event_type='assignment.force_recalled' and e.entity_type='cleaning_assignment'
      and e.reason_code='ADMIN_FORCE_RECALL' and not a.is_current and a.ended_at=e.effective_at
      and a.change_reason_code='ADMIN_FORCE_RECALL' and x.status='superseded' and x.field_completed_at is not null
  ) then return true; end if;
  return private.notification_resolution_before_force_recall(p_event_family,p_source_kind,p_source_id,p_terminal_kind,p_terminal_id);
end $$;
revoke all on function private.notification_resolution_is_valid(text,text,text,text,text) from public,anon,authenticated,service_role;

create function public.get_assignment_force_recall_candidate(p_actor_profile_id uuid,p_session_id uuid,p_cleaning_target_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare candidate jsonb;
begin
  perform private.assert_attempt_actor_session(p_actor_profile_id,p_session_id,true);
  select jsonb_build_object('expectedCurrentAssignmentId',a.id,'expectedAssignmentVersion',t.assignment_version,
    'expectedAttemptId',x.id,'expectedExecutionVersion',x.execution_version) into candidate
  from public.cleaning_targets t join public.cleaning_assignments a on a.cleaning_target_id=t.id
  join public.cleaning_attempts x on x.assignment_id=a.id and x.cleaning_target_id=t.id and x.maid_profile_id=a.maid_profile_id
  where t.id=p_cleaning_target_id and a.is_current and a.ended_at is null and a.notified_at is not null
    and a.revision=t.assignment_version and x.assignment_revision=a.revision
    and t.status in ('in_progress','upload_pending') and x.status in ('field_completed','upload_pending')
    and x.field_completed_at is not null and x.ended_at is not null
    and not exists(select 1 from public.cleaning_submissions where cleaning_attempt_id=x.id);
  return jsonb_build_object('candidate',candidate);
end $$;
revoke all on function public.get_assignment_force_recall_candidate(uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_assignment_force_recall_candidate(uuid,uuid,uuid) to service_role;

-- #607 Separate administrator command. Completed work times and photo ownership are historical.
create function public.force_recall_cleaning_assignment(
  p_actor_profile_id uuid, p_session_id uuid, p_cleaning_target_id uuid,
  p_expected_assignment_id uuid, p_expected_assignment_version bigint,
  p_expected_attempt_id uuid, p_expected_execution_version bigint,
  p_idempotency_key text, p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor public.profiles;
  target public.cleaning_targets;
  assignee public.cleaning_assignments;
  attempt public.cleaning_attempts;
  original public.cleaning_targets;
  replacement public.cleaning_targets;
  result jsonb;
  recalled_at timestamptz;
  notice record;
  audit_id uuid;
  previous_kind text:=current_setting('app.notification_terminal_kind',true);
  previous_id text:=current_setting('app.notification_terminal_id',true);
begin
  actor:=private.assert_attempt_actor_session_fresh(p_actor_profile_id,p_session_id,true);
  result:=private.replay_command(actor.id,'assignment.force_recall',p_idempotency_key,p_request_hash);
  actor:=private.assert_attempt_actor_session_fresh(p_actor_profile_id,p_session_id,true);
  if result is not null then return result; end if;
  -- Use submission's attempt -> target row order, plus the existing scheduling lock.
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into attempt from public.cleaning_attempts where id=p_expected_attempt_id
    and cleaning_target_id=p_cleaning_target_id for update;
  select * into target from public.cleaning_targets where id=p_cleaning_target_id for update;
  select * into assignee from public.cleaning_assignments where cleaning_target_id=target.id and is_current for update;
  actor:=private.assert_attempt_actor_session_fresh(p_actor_profile_id,p_session_id,true);
  if attempt.id is null or assignee.id is null or target.id is null
    or assignee.id is distinct from p_expected_assignment_id or attempt.assignment_id<>assignee.id
    or attempt.maid_profile_id<>assignee.maid_profile_id or assignee.ended_at is not null
    or assignee.notified_at is null or assignee.revision<>target.assignment_version
    or attempt.assignment_revision<>assignee.revision
    or target.assignment_version is distinct from p_expected_assignment_version
    or attempt.execution_version is distinct from p_expected_execution_version then
    raise exception using errcode='40001',message='ASSIGNMENT_VERSION_CONFLICT';
  end if;
  if target.status not in ('in_progress','upload_pending')
    or attempt.status not in ('field_completed','upload_pending') or attempt.field_completed_at is null
    or attempt.ended_at is null or exists(select 1 from public.cleaning_submissions
      where cleaning_attempt_id=attempt.id) then
    raise exception using errcode='55000',message='ASSIGNMENT_FORCE_RECALL_NOT_ALLOWED';
  end if;
  recalled_at:=clock_timestamp();
  -- Free the active-attempt slot while keeping original actor, timestamps, versions and evidence.
  update public.cleaning_attempts set status='superseded',end_reason='ADMIN_FORCE_RECALL'
    where id=attempt.id;
  insert into private.attempt_capability_revocations(capability_id,revoked_at,reason_code,actor_profile_id)
    select id,recalled_at,'ADMIN_FORCE_RECALL',actor.id from private.attempt_capability_grants
    where attempt_id=attempt.id on conflict(capability_id) do nothing;
  insert into private.offline_work_lease_revocations(lease_id,revoked_at,reason_code,metadata_expires_at)
    select id,recalled_at,'ADMIN_FORCE_RECALL',metadata_expires_at from private.offline_work_leases
    where attempt_id=attempt.id on conflict(lease_id) do nothing;
  update public.cleaning_assignments set is_current=false,ended_at=recalled_at,change_reason_code='ADMIN_FORCE_RECALL'
    where id=assignee.id;

  if target.source='inspection_reclean' then
    -- A zero-fee reclean belongs to its original maid. Use a normal paid target for the successor.
    select t.* into original from public.cleaning_attempts a join public.cleaning_targets t
      on t.id=a.cleaning_target_id where a.id=target.reclean_of_attempt_id;
    if original.id is null then raise exception using errcode='23514',message='RECLEAN_ORIGIN_NOT_FOUND'; end if;
    update public.cleaning_targets set status='cancelled',assignment_version=assignment_version+1,
      cancellation_reason_code='ADMIN_FORCE_RECALL',cancelled_at=recalled_at,cancelled_by=actor.id
      where id=target.id;
    insert into public.cleaning_targets(room_id,reservation_id,cleaning_kind,source,source_key,
      original_service_date,effective_service_date,carryover_count,available_from,due_at,status,
      assignment_version,room_type_snapshot,fee_snapshot,template_snapshot,created_by)
    values(target.room_id,null,'additional','manual_room_request','force-recall:'||assignee.id,
      target.original_service_date,target.effective_service_date,target.carryover_count,target.available_from,
      target.due_at,'unassigned',1,target.room_type_snapshot,original.fee_snapshot,original.template_snapshot,actor.id)
    returning * into replacement;
    insert into public.cleaning_target_schedule_revisions(cleaning_target_id,revision,effective_service_date,
      available_from,due_at,reason_code,changed_by) values(replacement.id,1,replacement.effective_service_date,
      replacement.available_from,replacement.due_at,'ADMIN_FORCE_RECALL',actor.id);
  else
    update public.cleaning_targets set status='unassigned',assignment_version=assignment_version+1
      where id=target.id returning * into replacement;
  end if;
  result:=jsonb_build_object('cleaningTargetId',target.id,'assignmentId',assignee.id,'attemptId',attempt.id,
    'reassignTargetId',replacement.id,'assignmentVersion',replacement.assignment_version,'status','unassigned');
  insert into public.audit_events(actor_profile_id,actor_display_name_snapshot,event_type,entity_type,entity_id,
    effective_at,reason_code,before_state,after_state,request_hash,idempotency_key)
  values(actor.id,actor.display_name,'assignment.force_recalled','cleaning_assignment',assignee.id,recalled_at,
    'ADMIN_FORCE_RECALL',jsonb_build_object('attemptStatus',attempt.status,'maidProfileId',assignee.maid_profile_id,
    'fieldCompletedAt',attempt.field_completed_at,'executionVersion',attempt.execution_version),result,
    p_request_hash,private.audit_command_key(actor.id,'assignment.force_recall',p_idempotency_key)) returning id into audit_id;
  perform set_config('app.notification_terminal_kind','audit_event',true);
  perform set_config('app.notification_terminal_id',audit_id::text,true);
  for notice in select event_family,source_entity_kind,source_entity_id from public.notifications
    where contract_version=1 and source_entity_kind='cleaning_assignment' and source_entity_id=assignee.id::text
    and resolved_at is null loop
    perform private.resolve_notifications_v1(notice.event_family,notice.source_entity_kind,notice.source_entity_id,recalled_at);
  end loop;
  perform set_config('app.notification_terminal_kind',coalesce(previous_kind,''),true);
  perform set_config('app.notification_terminal_id',coalesce(previous_id,''),true);
  perform private.emit_notification_v1('assignment.prestart_unassigned',actor.id,assignee.maid_profile_id,
    'cleaning_assignment',assignee.id::text,'청소 배정이 회수되었습니다','관리자가 제출 전 배정을 회수했습니다.',
    target.room_id,target.id,target.id,recalled_at);
  perform private.complete_command(actor.id,'assignment.force_recall',p_idempotency_key,p_request_hash,assignee.id,result);
  return result;
end $$;
revoke all on function public.force_recall_cleaning_assignment(uuid,uuid,uuid,uuid,bigint,uuid,bigint,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.force_recall_cleaning_assignment(uuid,uuid,uuid,uuid,bigint,uuid,bigint,text,text)
  to service_role;

alter function private.operation_http_route(text) rename to operation_http_route_before_force_recall;
revoke all on function private.operation_http_route_before_force_recall(text) from public,anon,authenticated,service_role;
create function private.operation_http_route(p_route text) returns jsonb language sql immutable set search_path='' as $$
 select case when p_route='forceRecallCleaningAssignment' then jsonb_build_object(
   'routeId',p_route,'kind','BUSINESS_WRITE','authority','ACTIVE_SESSION','hashMode','CALLER',
   'commandName','assignment.force_recall','keyArgument','p_idempotency_key')
 else private.operation_http_route_before_force_recall(p_route) end
$$;
revoke all on function private.operation_http_route(text) from public,anon,authenticated,service_role;
