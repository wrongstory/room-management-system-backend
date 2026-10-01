-- #308: successful online start is informational admin history, not a new task.
-- Preserve all existing catalog policies, source wrappers and command receipts.
-- Bound the duplicate-evidence lookup by attempt, not the lifetime audit ledger.
create index audit_cleaning_started_entity_idx on public.audit_events(entity_id,id)
 where entity_type='cleaning_attempt' and event_type='cleaning.attempt_started';
insert into private.notification_event_catalog (
 event_family,category,source_entity_kind,recipient_capability,requires_action,
 push_eligible,resolver_kind,deep_link_kind,group_family,group_scope_kind
) values ('cleaning.started_admin','cleaning_started','cleaning_attempt',
 'admin.assignment_decider',false,true,'none','cleaningTarget','cleaning_started','room');

alter function private.notification_source_is_valid(text,uuid,uuid,text,uuid,uuid,uuid)
 rename to notification_source_is_valid_before_cleaning_started;
create function private.notification_source_is_valid(p_event_family text,p_actor uuid,p_recipient uuid,p_source_id text,
 p_room uuid,p_cleaning_target uuid,p_deep_link_entity uuid) returns boolean
language plpgsql volatile security definer set search_path='' as $$
begin
 if p_event_family='cleaning.started_admin' then
  return exists(
   select 1 from public.cleaning_attempts attempt
   join public.cleaning_targets target on target.id=attempt.cleaning_target_id
   join public.cleaning_assignments assignment on assignment.id=attempt.assignment_id
   join public.audit_events audit on audit.entity_id=attempt.id
   where attempt.id::text=p_source_id and attempt.status='in_progress' and attempt.started_at is not null
    and attempt.maid_profile_id=p_actor and target.status='in_progress'
    and assignment.cleaning_target_id=target.id and assignment.maid_profile_id=p_actor
    and assignment.is_current and assignment.notified_at is not null
    and assignment.revision=attempt.assignment_revision and target.assignment_version=assignment.revision
    and target.room_id=p_room and target.id=p_cleaning_target and target.id=p_deep_link_entity
    and audit.id::text=current_setting('app.notification_terminal_id',true)
    and current_setting('app.notification_terminal_kind',true)='audit_event'
    and audit.event_type='cleaning.attempt_started' and audit.entity_type='cleaning_attempt'
    and audit.actor_profile_id=p_actor and audit.effective_at=attempt.started_at
    and not exists(select 1 from public.audit_events prior
     where prior.entity_type='cleaning_attempt' and prior.entity_id=attempt.id
      and prior.event_type='cleaning.attempt_started' and prior.id<>audit.id)
    -- Existing start audit has no before_state. The execution UPDATE trigger
    -- enforces scheduled -> in_progress and version +1; corroborate its exact
    -- post-transition projection instead of inventing historical before data.
    and attempt.execution_version>1 and audit.after_state=private.attempt_execution_projection(attempt)
    and exists(select 1 from public.profiles actor where actor.id=p_actor
     and actor.role='maid' and actor.status='active' and not actor.must_change_password)
    and exists(select 1 from public.profiles recipient where recipient.id=p_recipient and recipient.role='admin')
  );
 end if;
 return private.notification_source_is_valid_before_cleaning_started(
  p_event_family,p_actor,p_recipient,p_source_id,p_room,p_cleaning_target,p_deep_link_entity);
end $$;

create function private.dispatch_cleaning_started_admin_notification() returns trigger
language plpgsql security definer set search_path='' as $$
declare attempt public.cleaning_attempts; target public.cleaning_targets; recipient record;
 previous_kind text:=current_setting('app.notification_terminal_kind',true);
 previous_id text:=current_setting('app.notification_terminal_id',true);
begin
 if new.event_type<>'cleaning.attempt_started' then return null; end if;
 select * into attempt from public.cleaning_attempts where id=new.entity_id;
 select * into target from public.cleaning_targets where id=attempt.cleaning_target_id;
 if attempt.id is null or target.id is null then
  raise exception using errcode='23514',message='NOTIFICATION_PROVENANCE_INVALID';
 end if;
 perform set_config('app.notification_terminal_kind','audit_event',true);
 perform set_config('app.notification_terminal_id',new.id::text,true);
 -- Inbox history includes inactive/password-incomplete admins; the shared writer
 -- independently restricts push. Do not introduce reverse account row locks here.
 for recipient in select id from public.profiles where role='admin' order by id loop
  perform private.emit_notification_v1('cleaning.started_admin',new.actor_profile_id,recipient.id,
   'cleaning_attempt',attempt.id::text,'청소가 시작되었습니다','담당 메이드가 객실 청소를 시작했습니다.',
   target.room_id,target.id,target.id,new.recorded_at);
 end loop;
 perform set_config('app.notification_terminal_kind',coalesce(previous_kind,''),true);
 perform set_config('app.notification_terminal_id',coalesce(previous_id,''),true);
 return null;
exception when others then
 perform set_config('app.notification_terminal_kind',coalesce(previous_kind,''),true);
 perform set_config('app.notification_terminal_id',coalesce(previous_id,''),true);
 raise;
end $$;
create trigger audit_cleaning_started_admin_notification after insert on public.audit_events
 for each row execute function private.dispatch_cleaning_started_admin_notification();
revoke all on function private.dispatch_cleaning_started_admin_notification(),
 private.notification_source_is_valid(text,uuid,uuid,text,uuid,uuid,uuid),
 private.notification_source_is_valid_before_cleaning_started(text,uuid,uuid,text,uuid,uuid,uuid)
 from public,anon,authenticated,service_role;
