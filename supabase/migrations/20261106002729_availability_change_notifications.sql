-- Current-week change requests notify administrators; decisions notify only the requesting maid.
-- Forward-only: no historical backfill or replay. Domain command, inbox and delivery outbox commit atomically.
alter table private.notification_event_catalog
  drop constraint notification_event_catalog_recipient_capability_check,
  add constraint notification_event_catalog_recipient_capability_check check (recipient_capability in (
    'maid.assignment_party','maid.limited_grantee','admin.assignment_decider','admin.inspection_queue',
    'maid.inspection_subject','maid.complaint_party','admin.complaint_decider','maid.rework_assignee',
    'maid.payroll_owner','admin.availability_decider','maid.availability_owner'
  )),
  drop constraint notification_event_catalog_deep_link_kind_check,
  add constraint notification_event_catalog_deep_link_kind_check check (deep_link_kind in (
    'cleaningTarget','assignmentRequest','submission','complaintCase','payrollCycle','payrollProfile','availabilityRequest'
  )),
  drop constraint notification_event_catalog_group_scope_kind_check,
  add constraint notification_event_catalog_group_scope_kind_check check (group_scope_kind in (
    'room','payrollCycle','payrollProfile','availabilityRequest'
  ));
alter table private.notification_groups
  drop constraint notification_groups_scope_kind_check,
  add constraint notification_groups_scope_kind_check check (scope_kind in ('room','payrollCycle','payrollProfile','availabilityRequest'));
alter table public.notifications
  drop constraint notifications_typed_provenance_check,
  add constraint notifications_typed_provenance_check check (
    (contract_version is null and actor_profile_id is null and event_family is null
      and source_entity_kind is null and source_entity_id is null and deep_link_kind is null
      and deep_link_entity_id is null and notification_group_id is null)
    or
    (contract_version = 1 and actor_profile_id is not null and event_family is not null
      and source_entity_kind is not null and source_entity_id ~ '^[A-Za-z0-9._:-]{1,160}$'
      and deep_link_kind in ('cleaningTarget','assignmentRequest','submission','complaintCase','payrollCycle','payrollProfile','availabilityRequest')
      and deep_link_entity_id is not null and notification_group_id is not null)
  );

insert into private.notification_event_catalog(event_family,category,source_entity_kind,
  recipient_capability,requires_action,push_eligible,resolver_kind,deep_link_kind,group_family,group_scope_kind)
values
 ('availability.change_requested','availability_change_requested','availability_change_request','admin.availability_decider',true,true,'availability_decision','availabilityRequest','availability_change_requested','availabilityRequest'),
 ('availability.change_approved','availability_change_approved','availability_change_request','maid.availability_owner',false,true,'none','availabilityRequest','availability_change_approved','availabilityRequest'),
 ('availability.change_rejected','availability_change_rejected','availability_change_request','maid.availability_owner',false,true,'none','availabilityRequest','availability_change_rejected','availabilityRequest');

create index audit_availability_notification_source_idx on public.audit_events(entity_id,event_type,id)
 where entity_type='availability_change_request' and event_type in ('availability.change_requested','availability.change_decided');

create function private.availability_notification_evidence(p_request_id uuid,p_audit_id uuid,p_phase text)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare request public.availability_change_requests; evidence public.audit_events;
begin
 select * into request from public.availability_change_requests where id=p_request_id;
 select * into evidence from public.audit_events where id=p_audit_id;
 if request.id is null or evidence.id is null or evidence.entity_type is distinct from 'availability_change_request'
  or evidence.entity_id is distinct from request.id
  or not coalesce(evidence.after_state->>'requestHash' ~ '^[0-9a-f]{64}$',false)
  or exists(select 1 from public.audit_events prior where prior.entity_type='availability_change_request'
    and prior.entity_id=request.id and prior.event_type=evidence.event_type and prior.id<>evidence.id) then return false; end if;
 if p_phase='requested' then
  return request.status='pending' and evidence.event_type='availability.change_requested'
   and evidence.actor_profile_id=request.maid_profile_id and evidence.effective_at=request.requested_at
   and evidence.reason_code=request.reason_code
   and evidence.after_state=jsonb_build_object('maidProfileId',request.maid_profile_id,'weekStart',request.week_start,
     'sourceVersion',request.source_version,'requestedAvailableDates',to_jsonb(request.requested_available_dates),
     'requestHash',evidence.after_state->>'requestHash')
   and exists(select 1 from public.profiles where id=evidence.actor_profile_id and role='maid' and status='active');
 elsif p_phase in ('approved','rejected') then
  return request.status=p_phase and evidence.event_type='availability.change_decided'
   and evidence.actor_profile_id=request.decided_by and evidence.effective_at=request.decided_at
   and evidence.reason_code=request.decision_reason_code and evidence.before_state->>'status'='pending'
   and evidence.after_state=jsonb_build_object('status',request.status,'approvedVersionId',request.approved_version_id,
     'requestHash',evidence.after_state->>'requestHash')
   and exists(select 1 from public.profiles where id=evidence.actor_profile_id and role='admin' and status='active');
 end if;
 return false;
end $$;

alter function private.notification_source_is_valid(text,uuid,uuid,text,uuid,uuid,uuid)
 rename to notification_source_before_availability;
create function private.notification_source_is_valid(p_event_family text,p_actor uuid,p_recipient uuid,p_source_id text,
 p_room uuid,p_cleaning_target uuid,p_deep_link_entity uuid) returns boolean
language plpgsql volatile security definer set search_path='' as $$
declare evidence public.audit_events; request public.availability_change_requests; phase text;
begin
 if p_event_family not in ('availability.change_requested','availability.change_approved','availability.change_rejected') then
  return private.notification_source_before_availability(p_event_family,p_actor,p_recipient,p_source_id,p_room,p_cleaning_target,p_deep_link_entity);
 end if;
 if current_setting('app.notification_terminal_kind',true) is distinct from 'audit_event'
  or p_room is not null or p_cleaning_target is not null then return false; end if;
 select * into evidence from public.audit_events where id=nullif(current_setting('app.notification_terminal_id',true),'')::uuid;
 select * into request from public.availability_change_requests where id=p_source_id::uuid;
 phase:=substring(p_event_family from length('availability.change_')+1);
 if evidence.actor_profile_id is distinct from p_actor or p_deep_link_entity is distinct from request.id
  or not coalesce(private.availability_notification_evidence(request.id,evidence.id,phase),false) then return false; end if;
 if phase='requested' then
  return exists(select 1 from public.profiles where id=p_recipient and role='admin');
 end if;
 return p_recipient=request.maid_profile_id and exists(select 1 from public.profiles where id=p_recipient and role='maid');
exception when invalid_text_representation or numeric_value_out_of_range then return false;
end $$;

alter function private.notification_resolution_is_valid(text,text,text,text,text)
 rename to notification_resolution_before_availability;
create function private.notification_resolution_is_valid(p_event_family text,p_source_kind text,p_source_id text,p_terminal_kind text,p_terminal_id text)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare decision_status text;
begin
 if p_event_family<>'availability.change_requested' then
  return private.notification_resolution_before_availability(p_event_family,p_source_kind,p_source_id,p_terminal_kind,p_terminal_id);
 end if;
 if p_source_kind is distinct from 'availability_change_request' or p_terminal_kind is distinct from 'audit_event' then return false; end if;
 select status into decision_status from public.availability_change_requests where id=p_source_id::uuid;
 return coalesce(decision_status in ('approved','rejected')
  and private.availability_notification_evidence(p_source_id::uuid,p_terminal_id::uuid,decision_status),false);
exception when invalid_text_representation or numeric_value_out_of_range then return false;
end $$;

create function private.dispatch_availability_change_notification() returns trigger
language plpgsql security definer set search_path='' as $$
declare request public.availability_change_requests; recipient record; family text; title_text text; body_text text;
 previous_kind text:=current_setting('app.notification_terminal_kind',true);
 previous_id text:=current_setting('app.notification_terminal_id',true);
begin
 select * into request from public.availability_change_requests where id=new.entity_id;
 if request.id is null then raise exception using errcode='23514',message='NOTIFICATION_PROVENANCE_INVALID'; end if;
 perform set_config('app.notification_terminal_kind','audit_event',true);
 perform set_config('app.notification_terminal_id',new.id::text,true);
 if new.event_type='availability.change_requested' then
  -- No recipient row locks: account lifecycle may hold profile locks before domain locks.
  for recipient in select id from public.profiles where role='admin' order by id loop
   perform private.emit_notification_v1('availability.change_requested',new.actor_profile_id,recipient.id,
    'availability_change_request',request.id::text,'근무 가능일 변경 요청이 도착했습니다',
    '메이드가 이번 주 근무 가능일 변경을 요청했습니다. 승인 또는 반려해 주세요.',null,null,request.id,new.recorded_at);
  end loop;
 else
  perform private.resolve_notifications_v1('availability.change_requested','availability_change_request',request.id::text,new.recorded_at);
  if request.status='approved' then
   family:='availability.change_approved'; title_text:='근무 가능일 변경이 승인되었습니다';
   body_text:='관리자가 변경 요청을 승인했습니다. 반영된 근무 가능일을 확인해 주세요.';
  elsif request.status='rejected' then
   family:='availability.change_rejected'; title_text:='근무 가능일 변경이 반려되었습니다';
   body_text:='관리자가 변경 요청을 반려했습니다. 기존 근무 가능일은 유지됩니다.';
  else raise exception using errcode='23514',message='NOTIFICATION_PROVENANCE_INVALID'; end if;
  perform private.emit_notification_v1(family,new.actor_profile_id,request.maid_profile_id,
   'availability_change_request',request.id::text,title_text,body_text,null,null,request.id,new.recorded_at);
 end if;
 perform set_config('app.notification_terminal_kind',coalesce(previous_kind,''),true);
 perform set_config('app.notification_terminal_id',coalesce(previous_id,''),true);
 return null;
exception when others then
 perform set_config('app.notification_terminal_kind',coalesce(previous_kind,''),true);
 perform set_config('app.notification_terminal_id',coalesce(previous_id,''),true);
 raise;
end $$;
create trigger audit_availability_change_notification after insert on public.audit_events
 for each row when (new.entity_type='availability_change_request' and new.event_type in ('availability.change_requested','availability.change_decided'))
 execute function private.dispatch_availability_change_notification();

revoke all on function private.availability_notification_evidence(uuid,uuid,text),
 private.notification_source_is_valid(text,uuid,uuid,text,uuid,uuid,uuid),
 private.notification_source_before_availability(text,uuid,uuid,text,uuid,uuid,uuid),
 private.notification_resolution_is_valid(text,text,text,text,text),
 private.notification_resolution_before_availability(text,text,text,text,text),
 private.dispatch_availability_change_notification() from public,anon,authenticated,service_role;
