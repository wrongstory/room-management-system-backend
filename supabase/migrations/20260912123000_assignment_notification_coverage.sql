-- #128 notification coverage for post-notify assignment changes and field completion.
-- The first 47 migrations are immutable; this migration only appends contract changes.

drop trigger notification_event_catalog_immutable on private.notification_event_catalog;

do $$
declare v_constraint text;
begin
  select c.conname into v_constraint
  from pg_constraint c
  where c.conrelid='private.notification_event_catalog'::regclass
    and c.contype='c'
    and pg_get_constraintdef(c.oid) like '%push_eligible%requires_action%';
  if v_constraint is null then
    raise exception using errcode='P0002',message='NOTIFICATION_PUSH_ACTION_CONSTRAINT_NOT_FOUND';
  end if;
  execute format('alter table private.notification_event_catalog drop constraint %I',v_constraint);
end $$;

update private.notification_event_catalog
set push_eligible=true
where event_family in (
  'reservation.extension_revoked','reservation.cancelled_revoked',
  'cleaning_request.cancelled_revoked','assignment.prestart_old_revoked',
  'assignment.prestart_unassigned','attempt.handover_previous_revoked',
  'assignment.cancellation_approved','assignment.cancellation_rejected',
  'assignment.scheduled_rolled_over'
);

insert into private.notification_event_catalog (
  event_family,category,source_entity_kind,recipient_capability,requires_action,
  push_eligible,resolver_kind,deep_link_kind,group_family,group_scope_kind
) values (
  'cleaning.field_completed_admin','cleaning_field_completed','cleaning_attempt',
  'admin.inspection_queue',false,true,'none','cleaningTarget','cleaning_field_completed','room'
);

insert into private.notification_event_catalog (
  event_family,category,source_entity_kind,recipient_capability,requires_action,
  push_eligible,resolver_kind,deep_link_kind,group_family,group_scope_kind
) values (
  'reservation.notified_schedule_changed','cleaning_schedule_changed','cleaning_assignment',
  'maid.assignment_party',true,true,'assignment_terminal','cleaningTarget','cleaning_schedule_changed','room'
);

insert into private.notification_event_catalog (
  event_family,category,source_entity_kind,recipient_capability,requires_action,
  push_eligible,resolver_kind,deep_link_kind,group_family,group_scope_kind
) values
  ('reservation.notified_guest_count_changed','cleaning_assignment_changed','audit_event_assignment',
    'maid.assignment_party',false,true,'none','cleaningTarget','cleaning_assignment_changed','room'),
  ('room.operation_block_changed','cleaning_room_operation_changed','audit_event_assignment',
    'maid.assignment_party',false,true,'none','cleaningTarget','cleaning_room_operation_changed','room'),
  ('room.issue_status_changed','cleaning_room_issue_changed','audit_event_assignment',
    'maid.assignment_party',false,true,'none','cleaningTarget','cleaning_room_issue_changed','room'),
  ('room.pin_sync_status_changed','cleaning_pin_sync_changed','audit_event_assignment',
    'maid.assignment_party',false,true,'none','cleaningTarget','cleaning_pin_sync_changed','room');

create trigger notification_event_catalog_immutable
before update or delete on private.notification_event_catalog
for each row execute function private.guard_notification_catalog_ledgers();

create function private.pin_sync_event_changes_current_status(p_event_id uuid)
returns boolean language sql volatile security definer set search_path='' as $$
  with current_event as (
    select e.* from public.room_pin_sync_events e where e.id=p_event_id
  ), predecessor as (
    select prior.sync_status from current_event current
    join lateral (
      select e.sync_status from public.room_pin_sync_events e
      where e.room_id=current.room_id
        and (e.recorded_at,e.id)<(current.recorded_at,current.id)
      order by e.recorded_at desc,e.id desc limit 1
    ) prior on true
  )
  select exists(select 1 from current_event current
    where not exists(select 1 from public.room_pin_sync_events later
      where later.room_id=current.room_id
        and (later.recorded_at,later.id)>(current.recorded_at,current.id))
      and current.sync_status is distinct from (select p.sync_status from predecessor p));
$$;
revoke all on function private.pin_sync_event_changes_current_status(uuid)
from public,anon,authenticated,service_role;

create function private.field_completion_notification_source_is_valid(
  p_actor uuid,p_recipient uuid,p_source_id text,p_room uuid,
  p_cleaning_target uuid,p_deep_link_entity uuid
) returns boolean language plpgsql volatile security definer set search_path='' as $$
declare v_attempt public.cleaning_attempts; v_target public.cleaning_targets;
begin
  select * into v_attempt from public.cleaning_attempts where id=p_source_id::uuid;
  select * into v_target from public.cleaning_targets where id=v_attempt.cleaning_target_id;
  return v_attempt.id is not null and v_attempt.status='field_completed'
    and p_room is not distinct from v_target.room_id
    and p_cleaning_target is not distinct from v_target.id
    and p_deep_link_entity is not distinct from v_target.id
    and exists(select 1 from public.profiles p
      where p.id=p_recipient and p.role='admin' and p.status='active')
    and exists(select 1 from public.audit_events ae
      where ae.id::text=current_setting('app.notification_terminal_id',true)
        and ae.event_type='cleaning.field_completed'
        and ae.entity_type='cleaning_attempt' and ae.entity_id=v_attempt.id
        and ae.actor_profile_id=p_actor
        and ae.effective_at=v_attempt.field_completed_at);
exception when invalid_text_representation then return false;
end $$;
revoke all on function private.field_completion_notification_source_is_valid(uuid,uuid,text,uuid,uuid,uuid)
from public,anon,authenticated,service_role;

create function private.assignment_impact_notification_source_is_valid(
  p_event_family text,p_actor uuid,p_recipient uuid,p_source_id text,p_room uuid,
  p_cleaning_target uuid,p_deep_link_entity uuid
) returns boolean language plpgsql volatile security definer set search_path='' as $$
declare
  v_audit_id uuid; v_assignment_id uuid; v_audit public.audit_events;
  v_assignment public.cleaning_assignments; v_target public.cleaning_targets;
  v_issue_id uuid; v_pin_event_id uuid;
begin
  if p_source_id !~ '^[0-9a-f-]{36}:[0-9a-f-]{36}$' then return false; end if;
  v_audit_id:=split_part(p_source_id,':',1)::uuid;
  v_assignment_id:=split_part(p_source_id,':',2)::uuid;
  select * into v_audit from public.audit_events where id=v_audit_id;
  select * into v_assignment from public.cleaning_assignments where id=v_assignment_id;
  select * into v_target from public.cleaning_targets where id=v_assignment.cleaning_target_id;
  if v_audit.id is null or v_audit.id::text<>current_setting('app.notification_terminal_id',true)
    or v_audit.actor_profile_id is distinct from p_actor
    or v_assignment.id is null or not v_assignment.is_current or v_assignment.notified_at is null
    or v_assignment.maid_profile_id is distinct from p_recipient
    or v_assignment.revision is distinct from v_target.assignment_version
    or v_assignment.notified_room_id_snapshot is distinct from v_target.room_id
    or p_room is distinct from v_target.room_id or p_cleaning_target is distinct from v_target.id
    or p_deep_link_entity is distinct from v_target.id then return false; end if;
  if p_event_family='reservation.notified_guest_count_changed' then
    return v_audit.event_type='reservation.changed' and v_audit.entity_type='reservation'
      and v_audit.entity_id=v_target.reservation_id
      and v_audit.before_state->>'guest_count' is distinct from v_audit.after_state->>'guest_count';
  elsif p_event_family='room.operation_block_changed' then
    return v_audit.event_type in ('room.create_block','room.release_block')
      and v_audit.entity_type='room' and v_audit.entity_id=v_target.room_id;
  elsif p_event_family='room.issue_status_changed' then
    if v_audit.event_type not in ('room.report_issue','room.resolve_issue')
      or v_audit.entity_type<>'room' or v_audit.entity_id<>v_target.room_id then return false; end if;
    v_issue_id:=coalesce(nullif(v_audit.after_state->>'issueId',''),
      nullif(v_audit.before_state->>'issueId',''))::uuid;
    return exists(select 1 from public.room_issues i
      where i.id=v_issue_id and i.room_id=v_audit.entity_id and i.blocks_guest_assignment);
  elsif p_event_family='room.pin_sync_status_changed' then
    if v_audit.event_type<>'room.record_pin_sync'
      or v_audit.entity_type<>'room' or v_audit.entity_id<>v_target.room_id then return false; end if;
    v_pin_event_id:=nullif(v_audit.after_state->>'pinSyncEventId','')::uuid;
    return exists(select 1 from public.room_pin_sync_events e
        where e.id=v_pin_event_id and e.room_id=v_audit.entity_id
          and e.actor_profile_id=v_audit.actor_profile_id)
      and private.pin_sync_event_changes_current_status(v_pin_event_id);
  end if;
  return false;
exception when invalid_text_representation or numeric_value_out_of_range then return false;
end $$;
revoke all on function private.assignment_impact_notification_source_is_valid(
  text,uuid,uuid,text,uuid,uuid,uuid)
from public,anon,authenticated,service_role;

create function private.notified_schedule_notification_source_is_valid(
  p_actor uuid,p_recipient uuid,p_source_id text,p_room uuid,
  p_cleaning_target uuid,p_deep_link_entity uuid
) returns boolean language plpgsql volatile security definer set search_path='' as $$
declare v_assignment public.cleaning_assignments; v_target public.cleaning_targets;
begin
  select * into v_assignment from public.cleaning_assignments where id=p_source_id::uuid;
  select * into v_target from public.cleaning_targets where id=v_assignment.cleaning_target_id;
  return v_assignment.id is not null and v_assignment.is_current and v_assignment.notified_at is not null
    and v_assignment.maid_profile_id=p_recipient and v_assignment.revision=v_target.assignment_version
    and p_room is not distinct from v_target.room_id
    and p_cleaning_target is not distinct from v_target.id and p_deep_link_entity is not distinct from v_target.id
    and exists(select 1 from jsonb_array_elements(coalesce(
      nullif(current_setting('app.notification_replan_pairs',true),'')::jsonb,'[]'::jsonb)) pair
      where pair->>'newAssignmentId'=v_assignment.id::text)
    and exists(select 1 from public.audit_events ae
      where ae.id::text=current_setting('app.notification_terminal_id',true)
        and ae.event_type in ('reservation.created','reservation.changed','reservation.cancelled')
        and ae.entity_type='reservation' and ae.entity_id=v_target.reservation_id
        and ae.actor_profile_id=p_actor);
exception when invalid_text_representation then return false;
end $$;
revoke all on function private.notified_schedule_notification_source_is_valid(uuid,uuid,text,uuid,uuid,uuid)
from public,anon,authenticated,service_role;

create or replace function private.emit_notification_v1(
  p_event_family text,p_actor uuid,p_recipient uuid,p_source_kind text,p_source_id text,
  p_title text,p_body text,p_room uuid,p_cleaning_target uuid,p_deep_link_entity uuid,
  p_occurred_at timestamptz
) returns uuid language plpgsql security definer set search_path='' as $$
declare c private.notification_event_catalog; g private.notification_groups; v_scope uuid;
  v_notice uuid; v_dedupe text;
begin
  select * into c from private.notification_event_catalog where event_family=p_event_family;
  if c.event_family is null or c.source_entity_kind<>p_source_kind or p_actor is null or p_recipient is null
    or p_source_id is null or p_source_id!~'^[A-Za-z0-9._:-]{1,160}$'
    or p_deep_link_entity is null or p_occurred_at is null or not isfinite(p_occurred_at)
    or nullif(btrim(p_title),'') is null or char_length(p_title)>120
    or nullif(btrim(p_body),'') is null or char_length(p_body)>500 then
    raise exception using errcode='23514',message='NOTIFICATION_CATALOG_CONTRACT_VIOLATION';
  end if;
  if not (case when p_event_family='cleaning.field_completed_admin' then
      private.field_completion_notification_source_is_valid(p_actor,p_recipient,p_source_id,
        p_room,p_cleaning_target,p_deep_link_entity)
    when p_event_family='reservation.notified_schedule_changed' then
      private.notified_schedule_notification_source_is_valid(p_actor,p_recipient,p_source_id,
        p_room,p_cleaning_target,p_deep_link_entity)
    when p_event_family in ('reservation.notified_guest_count_changed','room.operation_block_changed',
      'room.issue_status_changed','room.pin_sync_status_changed') then
      private.assignment_impact_notification_source_is_valid(p_event_family,p_actor,p_recipient,
        p_source_id,p_room,p_cleaning_target,p_deep_link_entity)
    else private.notification_source_is_valid(p_event_family,p_actor,p_recipient,p_source_id,
      p_room,p_cleaning_target,p_deep_link_entity) end) then
    raise exception using errcode='23514',message='NOTIFICATION_PROVENANCE_INVALID';
  end if;
  v_scope:=case c.group_scope_kind when 'room' then p_room else p_deep_link_entity end;
  if v_scope is null then raise exception using errcode='23514',message='NOTIFICATION_GROUP_SCOPE_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'notification-group:v1:'||p_recipient::text||':'||c.group_family||':'||c.group_scope_kind||':'||v_scope::text,0));
  select * into g from private.notification_groups x
  where x.recipient_profile_id=p_recipient and x.group_family=c.group_family
    and x.scope_kind=c.group_scope_kind and x.scope_id=v_scope
    and p_occurred_at>=x.started_at and p_occurred_at<x.ends_at
  order by x.started_at desc,x.id desc limit 1;
  if g.id is null then
    insert into private.notification_groups(recipient_profile_id,group_family,scope_kind,scope_id,started_at,ends_at)
    values(p_recipient,c.group_family,c.group_scope_kind,v_scope,p_occurred_at,p_occurred_at+interval '10 minutes')
    returning * into g;
  end if;
  v_dedupe:='notification:v1:'||p_event_family||':'||p_source_kind||':'||p_source_id;
  insert into public.notifications(recipient_profile_id,category,title,body,room_id,cleaning_target_id,
    dedupe_key,requires_action,occurred_at,contract_version,actor_profile_id,event_family,
    source_entity_kind,source_entity_id,deep_link_kind,deep_link_entity_id,notification_group_id)
  values(p_recipient,c.category,p_title,p_body,p_room,p_cleaning_target,v_dedupe,c.requires_action,p_occurred_at,
    1,p_actor,p_event_family,p_source_kind,p_source_id,c.deep_link_kind,p_deep_link_entity,g.id)
  on conflict(recipient_profile_id,dedupe_key) where dedupe_key is not null
  do nothing returning id into v_notice;
  if v_notice is null then
    select id into v_notice from public.notifications
    where recipient_profile_id=p_recipient and dedupe_key=v_dedupe and contract_version=1
      and actor_profile_id=p_actor and category=c.category and requires_action=c.requires_action
      and room_id is not distinct from p_room and cleaning_target_id is not distinct from p_cleaning_target
      and event_family=p_event_family and source_entity_kind=p_source_kind and source_entity_id=p_source_id
      and deep_link_kind=c.deep_link_kind and deep_link_entity_id=p_deep_link_entity
      and notification_group_id=g.id;
  end if;
  if v_notice is null then raise exception using errcode='23505',message='NOTIFICATION_DEDUPE_CONFLICT'; end if;
  if c.push_eligible and p_actor<>p_recipient and exists(
    select 1 from public.profiles r where r.id=p_recipient and r.status='active'
      and not r.must_change_password and r.role in ('admin','maid')) then
    insert into private.notification_delivery_outbox(notification_id,event_family,enqueued_at)
    values(v_notice,p_event_family,p_occurred_at) on conflict(notification_id) do nothing;
  end if;
  perform set_config('app.notification_typed_emit_count',
    (coalesce(nullif(current_setting('app.notification_typed_emit_count',true),''),'0')::integer+1)::text,true);
  return v_notice;
end $$;

create or replace function public.claim_notification_deliveries(p_claim_digest text,p_limit integer default 10)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_job record; v_target private.notification_delivery_targets; v_now timestamptz:=clock_timestamp();
  v_items jsonb:='[]'::jsonb; v_suppressed integer:=0; v_blocked integer:=0; v_count integer;
  v_processed integer:=0;
  v_previous text:=current_setting('app.notification_delivery_writer_mode',true);
begin
  if p_claim_digest is null or p_claim_digest !~ '^[0-9a-f]{64}$'
    or p_limit is null or p_limit not between 1 and 10 then
    raise exception using errcode='22023',message='NOTIFICATION_DELIVERY_CLAIM_INVALID';
  end if;
  perform set_config('app.notification_delivery_writer_mode','typed_v1',true);
  begin
    for v_job in
      select j.outbox_id,j.status,o.notification_id,o.event_family,o.enqueued_at,
        n.recipient_profile_id,n.contract_version,n.event_family as notification_event_family,n.resolved_at,
        p.role::text as recipient_role,p.status::text as recipient_status,p.must_change_password,
        c.push_eligible
      from private.notification_delivery_jobs j
      join private.notification_delivery_outbox o on o.id=j.outbox_id
      join public.notifications n on n.id=o.notification_id
      left join public.profiles p on p.id=n.recipient_profile_id
      left join private.notification_event_catalog c on c.event_family=o.event_family
      where j.status='pending'
      order by o.enqueued_at,o.id
      for update of j skip locked limit p_limit
    loop
      v_now:=clock_timestamp();
      if v_job.enqueued_at+interval '24 hours'<=v_now then
        update private.notification_delivery_jobs set status='suppressed',snapshot_at=v_now,terminal_at=v_now,
          terminal_reason='STALE_NOTIFICATION',updated_at=v_now where outbox_id=v_job.outbox_id;
        perform private.append_notification_delivery_event(v_job.outbox_id,null,'suppressed','STALE_NOTIFICATION');
        v_suppressed:=v_suppressed+1; v_processed:=v_processed+1; continue;
      elsif v_job.resolved_at is not null then
        update private.notification_delivery_jobs set status='suppressed',snapshot_at=v_now,terminal_at=v_now,
          terminal_reason='NOTIFICATION_RESOLVED',updated_at=v_now where outbox_id=v_job.outbox_id;
        perform private.append_notification_delivery_event(v_job.outbox_id,null,'suppressed','NOTIFICATION_RESOLVED');
        v_suppressed:=v_suppressed+1; v_processed:=v_processed+1; continue;
      elsif v_job.contract_version<>1 or v_job.notification_event_family is distinct from v_job.event_family
        or not coalesce(v_job.push_eligible,false) then
        update private.notification_delivery_jobs set status='dead_letter',snapshot_at=v_now,terminal_at=v_now,
          terminal_reason='DELIVERY_CONTRACT_INVALID',updated_at=v_now where outbox_id=v_job.outbox_id;
        perform private.append_notification_delivery_event(v_job.outbox_id,null,'dead_letter','DELIVERY_CONTRACT_INVALID');
        v_blocked:=v_blocked+1; v_processed:=v_processed+1; continue;
      elsif v_job.recipient_role not in ('admin','maid') or v_job.recipient_status<>'active'
        or coalesce(v_job.must_change_password,true) then
        update private.notification_delivery_jobs set status='suppressed',snapshot_at=v_now,terminal_at=v_now,
          terminal_reason='RECIPIENT_NOT_ELIGIBLE',updated_at=v_now where outbox_id=v_job.outbox_id;
        perform private.append_notification_delivery_event(v_job.outbox_id,null,'suppressed','RECIPIENT_NOT_ELIGIBLE');
        v_suppressed:=v_suppressed+1; v_processed:=v_processed+1; continue;
      end if;
      insert into private.notification_delivery_targets(
        outbox_id,notification_id,recipient_profile_id,subscription_id,subscription_version,
        subscription_revision_id,next_attempt_at,created_at,updated_at
      )
      select v_job.outbox_id,v_job.notification_id,v_job.recipient_profile_id,s.id,s.version,
        s.current_revision_id,v_now,v_now,v_now
      from private.web_push_subscriptions s
      join private.web_push_subscription_revisions r on r.id=s.current_revision_id
        and r.subscription_id=s.id and r.profile_id=s.profile_id and r.revision_no=s.version
      where s.profile_id=v_job.recipient_profile_id and s.status='active'
      order by s.id on conflict(outbox_id,subscription_id) do nothing;
      get diagnostics v_count=row_count;
      if v_count=0 then
        update private.notification_delivery_jobs set status='suppressed',snapshot_at=v_now,terminal_at=v_now,
          terminal_reason='NO_ACTIVE_SUBSCRIPTION',updated_at=v_now where outbox_id=v_job.outbox_id;
        perform private.append_notification_delivery_event(v_job.outbox_id,null,'suppressed','NO_ACTIVE_SUBSCRIPTION');
        v_suppressed:=v_suppressed+1; v_processed:=v_processed+1;
      else
        update private.notification_delivery_jobs set status='materialized',snapshot_at=v_now,updated_at=v_now
          where outbox_id=v_job.outbox_id;
        perform private.append_notification_delivery_event(v_job.outbox_id,null,'materialized',null);
      end if;
    end loop;

    for v_target in
      select t.* from private.notification_delivery_targets t
      join private.notification_delivery_jobs j on j.outbox_id=t.outbox_id
      where j.status='materialized' and t.status in ('pending','retry','claimed')
        and t.next_attempt_at<=clock_timestamp()
        and (t.status<>'claimed' or t.lease_expires_at<=clock_timestamp() or t.claim_digest=p_claim_digest)
      order by t.next_attempt_at,t.id for update of t skip locked limit greatest(0,p_limit-v_processed)
    loop
      v_now:=clock_timestamp();
      if not exists(select 1 from private.notification_delivery_jobs j
        where j.outbox_id=v_target.outbox_id and j.status='materialized') then
        continue;
      end if;
      if v_target.status='claimed' and v_target.lease_expires_at>v_now
        and v_target.claim_digest=p_claim_digest then
        v_items:=v_items||jsonb_build_array(private.notification_delivery_target_projection(v_target.id));
        continue;
      end if;
      if v_target.lease_version>=8 then
        update private.notification_delivery_targets set status='dead_letter',claim_digest=null,lease_expires_at=null,
          terminal_at=v_now,reason_code='RETRY_EXHAUSTED',updated_at=v_now where id=v_target.id;
        perform private.append_notification_delivery_event(v_target.outbox_id,v_target.id,'dead_letter','RETRY_EXHAUSTED');
        perform private.refresh_notification_delivery_job(v_target.outbox_id); v_blocked:=v_blocked+1; continue;
      end if;
      update private.notification_delivery_targets set status='claimed',lease_version=lease_version+1,
        claim_digest=p_claim_digest,lease_expires_at=v_now+interval '2 minutes',reason_code=null,updated_at=v_now
        where id=v_target.id returning * into v_target;
      insert into private.notification_delivery_attempts(target_id,attempt_no,lease_version,claim_digest,started_at)
      values(v_target.id,v_target.lease_version,v_target.lease_version,p_claim_digest,v_now);
      perform private.append_notification_delivery_event(v_target.outbox_id,v_target.id,'claimed',null);
      v_items:=v_items||jsonb_build_array(private.notification_delivery_target_projection(v_target.id));
    end loop;
    perform set_config('app.notification_delivery_writer_mode',coalesce(v_previous,''),true);
    return jsonb_build_object('items',v_items,'suppressed',v_suppressed,'blocked',v_blocked);
  exception when others then
    perform set_config('app.notification_delivery_writer_mode',coalesce(v_previous,''),true); raise;
  end;
end $$;

comment on function public.claim_notification_deliveries(text,integer) is
'Claims typed push jobs. push_eligible controls delivery independently from inbox requires_action.';

create function private.dispatch_field_completion_admin_notification()
returns trigger language plpgsql security definer set search_path='' as $$
declare
  v_attempt public.cleaning_attempts; v_target public.cleaning_targets; v_admin record;
  previous_terminal_kind text:=current_setting('app.notification_terminal_kind',true);
  previous_terminal_id text:=current_setting('app.notification_terminal_id',true);
  previous_source_event_type text:=current_setting('app.notification_source_event_type',true);
  previous_source_reason_code text:=current_setting('app.notification_source_reason_code',true);
begin
  if new.event_type<>'cleaning.field_completed' then return null; end if;
  select * into v_attempt from public.cleaning_attempts where id=new.entity_id;
  select * into v_target from public.cleaning_targets where id=v_attempt.cleaning_target_id;
  if v_attempt.id is null or v_target.id is null then
    raise exception using errcode='23514',message='NOTIFICATION_PROVENANCE_INVALID';
  end if;
  perform set_config('app.notification_terminal_kind','audit_event',true);
  perform set_config('app.notification_terminal_id',new.id::text,true);
  perform set_config('app.notification_source_event_type',new.event_type,true);
  perform set_config('app.notification_source_reason_code',coalesce(new.reason_code,''),true);
  for v_admin in select p.id from public.profiles p
    where p.role='admin' and p.status='active' order by p.id
  loop
    perform private.emit_notification_v1(
      'cleaning.field_completed_admin',new.actor_profile_id,v_admin.id,
      'cleaning_attempt',v_attempt.id::text,'현장 청소가 완료되었습니다',
      '현장 청소가 완료되어 사진 업로드 또는 검수 대기 상태를 확인해 주세요.',
      v_target.room_id,v_target.id,v_target.id,new.recorded_at);
  end loop;
  perform set_config('app.notification_terminal_kind',coalesce(previous_terminal_kind,''),true);
  perform set_config('app.notification_terminal_id',coalesce(previous_terminal_id,''),true);
  perform set_config('app.notification_source_event_type',coalesce(previous_source_event_type,''),true);
  perform set_config('app.notification_source_reason_code',coalesce(previous_source_reason_code,''),true);
  return null;
exception when others then
  perform set_config('app.notification_terminal_kind',coalesce(previous_terminal_kind,''),true);
  perform set_config('app.notification_terminal_id',coalesce(previous_terminal_id,''),true);
  perform set_config('app.notification_source_event_type',coalesce(previous_source_event_type,''),true);
  perform set_config('app.notification_source_reason_code',coalesce(previous_source_reason_code,''),true);
  raise;
end $$;
revoke all on function private.dispatch_field_completion_admin_notification()
from public,anon,authenticated,service_role;
create trigger audit_field_completion_admin_notification
after insert on public.audit_events
for each row execute function private.dispatch_field_completion_admin_notification();

create function private.replan_notified_checkout_assignment_v1(
  p_cleaning_target_id uuid,p_service_date date,p_available_from timestamptz,p_due_at timestamptz,
  p_reason_code text,p_actor_profile_id uuid,p_changed_at timestamptz
) returns uuid language plpgsql security definer set search_path='' as $$
declare
  v_target public.cleaning_targets; v_assignment public.cleaning_assignments;
  v_next public.cleaning_assignments; v_week date;
begin
  select * into v_target from public.cleaning_targets
    where id=p_cleaning_target_id for update;
  select * into v_assignment from public.cleaning_assignments
    where cleaning_target_id=p_cleaning_target_id and is_current for update;
  if v_target.id is null or v_target.cleaning_kind<>'checkout' or v_target.status<>'notified'
    or v_assignment.id is null or v_assignment.notified_at is null
    or v_assignment.revision<>v_target.assignment_version then
    raise exception using errcode='23514',message='CLEANING_WORKFLOW_REPLAN_REQUIRED';
  end if;
  if p_service_date is null or p_available_from is null
    or p_due_at is not null and p_due_at<p_available_from then
    raise exception using errcode='23514',message='CLEANING_WORKFLOW_REPLAN_REQUIRED';
  end if;
  -- An issued PIN or offline lease is an irreversible exposure boundary, even
  -- when later revoked. A started/non-scheduled attempt is likewise unsafe.
  if exists(select 1 from public.room_pin_access_leases l
      where l.cleaning_target_id=v_target.id)
    or exists(select 1 from private.offline_work_leases l
      join public.cleaning_attempts ca on ca.id=l.attempt_id
      where ca.cleaning_target_id=v_target.id)
    or exists(select 1 from public.cleaning_attempts ca
      where ca.cleaning_target_id=v_target.id and ca.status<>'superseded'
        and (ca.status<>'scheduled' or ca.started_at is not null)) then
    raise exception using errcode='23514',message='CLEANING_WORKFLOW_REPLAN_REQUIRED';
  end if;
  perform 1 from public.profiles p where p.id=v_assignment.maid_profile_id
    and p.role='maid' and p.status='active' for share;
  if not found then
    raise exception using errcode='23514',message='ASSIGNMENT_MAID_UNAVAILABLE';
  end if;
  v_week:=p_service_date-(extract(isodow from p_service_date)::integer-1);
  perform pg_advisory_xact_lock(hashtextextended(
    'availability:'||v_assignment.maid_profile_id::text||':'||v_week::text,0));
  if not exists(select 1 from public.availability_versions v
    join public.availability_days d on d.availability_version_id=v.id
    where v.maid_profile_id=v_assignment.maid_profile_id and v.week_start=v_week
      and v.is_current and d.work_date=p_service_date and d.available) then
    raise exception using errcode='23514',message='ASSIGNMENT_MAID_UNAVAILABLE';
  end if;
  if exists(select 1 from public.cleaning_assignments ca
    where ca.is_current and ca.id<>v_assignment.id
      and ca.maid_profile_id=v_assignment.maid_profile_id
      and ca.service_date=p_service_date
      and ca.sequence_number=v_assignment.sequence_number) then
    raise exception using errcode='23514',message='ASSIGNMENT_SEQUENCE_CONFLICT';
  end if;

  update public.cleaning_attempts
  set status='superseded',ended_at=p_changed_at,end_reason=p_reason_code
  where cleaning_target_id=v_target.id and status='scheduled';
  update public.cleaning_assignments
  set is_current=false,ended_at=p_changed_at,change_reason_code=p_reason_code
  where id=v_assignment.id;
  update public.cleaning_targets
  set effective_service_date=p_service_date,available_from=p_available_from,due_at=p_due_at,
    assignment_version=assignment_version+1
  where id=v_target.id returning * into v_target;
  insert into public.cleaning_target_schedule_revisions(
    cleaning_target_id,revision,effective_service_date,available_from,due_at,
    reason_code,changed_by,recorded_at
  ) values(v_target.id,v_target.assignment_version,v_target.effective_service_date,
    v_target.available_from,v_target.due_at,p_reason_code,p_actor_profile_id,p_changed_at);
  insert into public.cleaning_assignments(
    cleaning_target_id,maid_profile_id,sequence_number,revision,is_current,notified_at,
    changed_by,created_at
  ) values(v_target.id,v_assignment.maid_profile_id,v_assignment.sequence_number,
    v_target.assignment_version,true,p_changed_at,p_actor_profile_id,p_changed_at)
  returning * into v_next;
  perform set_config('app.notification_replan_pairs',(
    coalesce(nullif(current_setting('app.notification_replan_pairs',true),'')::jsonb,'[]'::jsonb)
    ||jsonb_build_array(jsonb_build_object(
      'oldAssignmentId',v_assignment.id,'newAssignmentId',v_next.id,
      'cleaningTargetId',v_target.id,'reasonCode',p_reason_code)))::text,true);
  return v_next.id;
end $$;
revoke all on function private.replan_notified_checkout_assignment_v1(
  uuid,date,timestamptz,timestamptz,text,uuid,timestamptz)
from public,anon,authenticated,service_role;

create or replace function private.sync_planned_checkout_target()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  t public.cleaning_targets%rowtype; a public.cleaning_assignments%rowtype;
  r public.reservations%rowtype; changed boolean; promoted boolean;
  changed_at timestamptz:=clock_timestamp();
begin
  if new.planned_cleaning_target_id is null then return null; end if;
  select * into strict t from public.cleaning_targets
  where id=new.planned_cleaning_target_id for update;
  select * into strict r from public.reservations where id=new.reservation_id;
  select * into a from public.cleaning_assignments
  where cleaning_target_id=t.id and is_current for update;
  changed:=t.room_id is distinct from new.room_id
    or t.effective_service_date is distinct from new.effective_service_date
    or t.available_from is distinct from new.available_from
    or t.due_at is distinct from new.due_at;
  promoted:=old.current_cleaning_target_id is null and new.status='materialized';

  if old.current_cleaning_target_id is not null and new.current_cleaning_target_id is null
    and new.status='private' and a.id is not null and a.notified_at is not null then
    perform set_config('app.notification_extended_assignment_id',a.id::text,true);
  end if;

  if new.status='cancelled' and t.status<>'cancelled' then
    if exists(select 1 from public.cleaning_attempts where cleaning_target_id=t.id and status<>'superseded')
      or exists(select 1 from public.room_pin_access_leases where cleaning_target_id=t.id and revoked_at is null) then
      raise exception using errcode='23514',message='CLEANING_WORKFLOW_CANCEL_CONFLICT';
    end if;
    if a.id is not null and a.notified_at is not null then
      perform set_config('app.notification_cancelled_assignment_id',a.id::text,true);
    end if;
    update public.cleaning_assignments set is_current=false,ended_at=now(),
      change_reason_code='RESERVATION_CANCELLED' where id=a.id;
    update public.cleaning_targets set status='cancelled',cancelled_at=new.cancelled_at,
      cancelled_by=r.updated_by,cancellation_reason_code=new.cancellation_reason_code,
      assignment_version=assignment_version+1 where id=t.id;
  elsif changed and old.current_cleaning_target_id is null then
    if not promoted and a.notified_at is not null then
      if t.room_id is distinct from new.room_id then
        raise exception using errcode='23514',message='CLEANING_WORKFLOW_REPLAN_REQUIRED';
      end if;
      perform private.replan_notified_checkout_assignment_v1(
        t.id,new.effective_service_date,new.available_from,new.due_at,
        'RESERVATION_SCHEDULE_CHANGED',r.updated_by,changed_at);
    else
      if not promoted and t.status not in ('unassigned','draft_assigned') then
        raise exception using errcode='23514',message='CLEANING_WORKFLOW_REPLAN_REQUIRED';
      end if;
      update public.cleaning_targets set room_id=new.room_id,
        effective_service_date=new.effective_service_date,available_from=new.available_from,
        due_at=new.due_at,assignment_version=assignment_version+1
      where id=t.id returning * into t;
      insert into public.cleaning_target_schedule_revisions(
        cleaning_target_id,revision,effective_service_date,available_from,due_at,reason_code,changed_by
      ) values(t.id,t.assignment_version,t.effective_service_date,t.available_from,t.due_at,
        case when promoted then 'MANUAL_CHECKOUT' else 'RESERVATION_SCHEDULE_CHANGED' end,r.updated_by);
      if promoted and a.id is not null then
        update public.cleaning_assignments set is_current=false,ended_at=r.actual_checkout_at,
          change_reason_code='MANUAL_CHECKOUT_RESCHEDULE' where id=a.id;
        insert into public.cleaning_assignments(
          cleaning_target_id,maid_profile_id,sequence_number,revision,is_current,notified_at,changed_by
        ) values(t.id,a.maid_profile_id,a.sequence_number,t.assignment_version,true,
          case when a.notified_at is not null then r.actual_checkout_at end,r.updated_by);
      end if;
    end if;
  end if;
  return null;
end $$;

create function private.dispatch_notified_schedule_replan_notification()
returns trigger language plpgsql security definer set search_path='' as $$
declare
  v_pair jsonb; v_old public.cleaning_assignments;
  v_new public.cleaning_assignments; v_target public.cleaning_targets; v_item record;
  previous_terminal_kind text:=current_setting('app.notification_terminal_kind',true);
  previous_terminal_id text:=current_setting('app.notification_terminal_id',true);
begin
  if new.event_type not in ('reservation.created','reservation.changed','reservation.cancelled') then return null; end if;
  perform set_config('app.notification_terminal_kind','audit_event',true);
  perform set_config('app.notification_terminal_id',new.id::text,true);
  if new.event_type='reservation.changed'
    and coalesce(current_setting('app.notification_extended_assignment_id',true),'')<>'' then
    select * into v_old from public.cleaning_assignments ca
      where ca.id=current_setting('app.notification_extended_assignment_id',true)::uuid;
    select * into v_target from public.cleaning_targets t where t.id=v_old.cleaning_target_id;
    if v_old.id is null or v_old.is_current or v_old.notified_at is null
      or v_old.change_reason_code<>'RESERVATION_EXTENDED'
      or v_target.reservation_id is distinct from new.entity_id then
      raise exception using errcode='23514',message='NOTIFICATION_PROVENANCE_INVALID';
    end if;
    for v_item in select event_family,source_entity_kind,source_entity_id
      from public.notifications where contract_version=1 and requires_action
        and source_entity_kind='cleaning_assignment' and source_entity_id=v_old.id::text
        and resolved_at is null
    loop
      perform private.resolve_notifications_v1(v_item.event_family,v_item.source_entity_kind,
        v_item.source_entity_id,new.recorded_at);
    end loop;
    perform private.emit_notification_v1(
      'reservation.extension_revoked',new.actor_profile_id,v_old.maid_profile_id,
      'cleaning_assignment',v_old.id::text,'청소 배정이 회수되었습니다',
      '예약 퇴실 시간이 연장되어 기존 청소 배정이 회수되었습니다.',
      v_target.room_id,v_target.id,v_target.id,new.recorded_at);
    perform set_config('app.notification_extended_assignment_id','',true);
  end if;
  if new.event_type='reservation.cancelled'
    and coalesce(current_setting('app.notification_cancelled_assignment_id',true),'')<>'' then
    select * into v_old from public.cleaning_assignments ca
      where ca.id=current_setting('app.notification_cancelled_assignment_id',true)::uuid;
    select * into v_target from public.cleaning_targets t where t.id=v_old.cleaning_target_id;
    if v_old.id is null or v_old.is_current or v_old.notified_at is null
      or v_old.change_reason_code<>'RESERVATION_CANCELLED'
      or v_target.reservation_id is distinct from new.entity_id then
      raise exception using errcode='23514',message='NOTIFICATION_PROVENANCE_INVALID';
    end if;
    for v_item in select event_family,source_entity_kind,source_entity_id
      from public.notifications where contract_version=1 and requires_action
        and source_entity_kind='cleaning_assignment' and source_entity_id=v_old.id::text
        and resolved_at is null
    loop
      perform private.resolve_notifications_v1(v_item.event_family,v_item.source_entity_kind,
        v_item.source_entity_id,new.recorded_at);
    end loop;
    perform private.emit_notification_v1(
      'reservation.cancelled_revoked',new.actor_profile_id,v_old.maid_profile_id,
      'cleaning_assignment',v_old.id::text,'청소 배정이 회수되었습니다',
      '예약이 취소되어 기존 청소 배정이 회수되었습니다.',
      v_target.room_id,v_target.id,v_target.id,new.recorded_at);
    perform set_config('app.notification_cancelled_assignment_id','',true);
  end if;
  for v_pair in select value from jsonb_array_elements(coalesce(
    nullif(current_setting('app.notification_replan_pairs',true),'')::jsonb,'[]'::jsonb))
  loop
    select * into v_old from public.cleaning_assignments ca
      where ca.id=(v_pair->>'oldAssignmentId')::uuid;
    select * into v_new from public.cleaning_assignments ca
      where ca.id=(v_pair->>'newAssignmentId')::uuid;
    select * into v_target from public.cleaning_targets t where t.id=v_old.cleaning_target_id;
    if v_old.id is null or v_old.is_current or v_old.notified_at is null
      or v_old.change_reason_code<>v_pair->>'reasonCode'
      or v_new.id is null or not v_new.is_current or v_new.notified_at is null
      or v_new.cleaning_target_id<>v_old.cleaning_target_id
      or v_new.id::text<>v_pair->>'newAssignmentId'
      or v_target.id::text<>v_pair->>'cleaningTargetId' then
      raise exception using errcode='23514',message='NOTIFICATION_PROVENANCE_INVALID';
    end if;
    for v_item in select event_family,source_entity_kind,source_entity_id
      from public.notifications where contract_version=1 and requires_action
        and source_entity_kind='cleaning_assignment' and source_entity_id=v_old.id::text
        and resolved_at is null
    loop
      perform private.resolve_notifications_v1(v_item.event_family,v_item.source_entity_kind,
        v_item.source_entity_id,new.recorded_at);
    end loop;
    perform private.emit_notification_v1(
      'reservation.notified_schedule_changed',new.actor_profile_id,v_new.maid_profile_id,
      'cleaning_assignment',v_new.id::text,'청소 일정이 변경되었습니다',
      '예약 변경으로 청소 가능 시간 또는 마감 시간이 변경되었습니다.',
      v_target.room_id,v_target.id,v_target.id,new.recorded_at);
  end loop;
  perform set_config('app.notification_replan_pairs','',true);
  perform set_config('app.notification_extended_assignment_id','',true);
  perform set_config('app.notification_terminal_kind',coalesce(previous_terminal_kind,''),true);
  perform set_config('app.notification_terminal_id',coalesce(previous_terminal_id,''),true);
  return null;
exception when others then
  perform set_config('app.notification_replan_pairs','',true);
  perform set_config('app.notification_cancelled_assignment_id','',true);
  perform set_config('app.notification_extended_assignment_id','',true);
  perform set_config('app.notification_terminal_kind',coalesce(previous_terminal_kind,''),true);
  perform set_config('app.notification_terminal_id',coalesce(previous_terminal_id,''),true);
  raise;
end $$;
revoke all on function private.dispatch_notified_schedule_replan_notification()
from public,anon,authenticated,service_role;
create trigger audit_notified_schedule_replan_notification
after insert on public.audit_events
for each row execute function private.dispatch_notified_schedule_replan_notification();

create function private.dispatch_notified_assignment_impact_notification()
returns trigger language plpgsql security definer set search_path='' as $$
declare
  v_assignment record; v_room uuid; v_family text; v_title text; v_body text;
  v_issue_id uuid; v_pin_event_id uuid;
  previous_terminal_kind text:=current_setting('app.notification_terminal_kind',true);
  previous_terminal_id text:=current_setting('app.notification_terminal_id',true);
begin
  if new.event_type='reservation.changed' then
    if new.before_state->>'guest_count' is not distinct from new.after_state->>'guest_count' then return null; end if;
    v_family:='reservation.notified_guest_count_changed';
    v_title:='예약 인원 정보가 변경되었습니다';
    v_body:='담당 객실의 예약 인원이 변경되었습니다. 청소 카드를 확인해 주세요.';
  elsif new.event_type in ('room.create_block','room.release_block') then
    v_room:=new.entity_id; v_family:='room.operation_block_changed';
    v_title:='객실 운영 상태가 변경되었습니다';
    v_body:='담당 객실의 운영 차단 상태가 변경되었습니다. 청소 카드를 확인해 주세요.';
  elsif new.event_type in ('room.report_issue','room.resolve_issue') then
    v_issue_id:=coalesce(nullif(new.after_state->>'issueId',''),nullif(new.before_state->>'issueId',''))::uuid;
    if not exists(select 1 from public.room_issues i where i.id=v_issue_id and i.blocks_guest_assignment) then
      return null;
    end if;
    v_room:=new.entity_id; v_family:='room.issue_status_changed';
    v_title:='객실 문제 상태가 변경되었습니다';
    v_body:='담당 객실의 운영 차단 문제가 변경되었습니다. 청소 카드를 확인해 주세요.';
  elsif new.event_type='room.record_pin_sync' then
    v_pin_event_id:=nullif(new.after_state->>'pinSyncEventId','')::uuid;
    if not private.pin_sync_event_changes_current_status(v_pin_event_id) then return null; end if;
    v_room:=new.entity_id; v_family:='room.pin_sync_status_changed';
    v_title:='객실 PIN 동기화 상태가 변경되었습니다';
    v_body:='담당 객실의 출입 준비 상태가 변경되었습니다. 앱에서 상태를 확인해 주세요.';
  else
    return null;
  end if;

  perform set_config('app.notification_terminal_kind','audit_event',true);
  perform set_config('app.notification_terminal_id',new.id::text,true);
  for v_assignment in
    select a.id,a.maid_profile_id,t.id cleaning_target_id,t.room_id
    from public.cleaning_assignments a
    join public.cleaning_targets t on t.id=a.cleaning_target_id
    where a.is_current and a.notified_at is not null
      and a.revision=t.assignment_version
      and a.notified_room_id_snapshot=t.room_id
      and t.status in ('notified','in_progress')
      and not exists(select 1 from public.cleaning_attempts ca
        where ca.cleaning_target_id=t.id and ca.status in ('field_completed','upload_pending','submitted'))
      and ((new.event_type='reservation.changed' and t.reservation_id=new.entity_id)
        or (new.event_type<>'reservation.changed' and t.room_id=v_room))
    order by a.id
  loop
    perform private.emit_notification_v1(
      v_family,new.actor_profile_id,v_assignment.maid_profile_id,'audit_event_assignment',
      new.id::text||':'||v_assignment.id::text,v_title,v_body,v_assignment.room_id,
      v_assignment.cleaning_target_id,v_assignment.cleaning_target_id,new.recorded_at);
  end loop;
  perform set_config('app.notification_terminal_kind',coalesce(previous_terminal_kind,''),true);
  perform set_config('app.notification_terminal_id',coalesce(previous_terminal_id,''),true);
  return null;
exception when others then
  perform set_config('app.notification_terminal_kind',coalesce(previous_terminal_kind,''),true);
  perform set_config('app.notification_terminal_id',coalesce(previous_terminal_id,''),true);
  raise;
end $$;
revoke all on function private.dispatch_notified_assignment_impact_notification()
from public,anon,authenticated,service_role;
create trigger audit_notified_assignment_impact_notification
after insert on public.audit_events
for each row execute function private.dispatch_notified_assignment_impact_notification();
