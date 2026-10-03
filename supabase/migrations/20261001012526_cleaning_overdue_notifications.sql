-- #308 phase 2: durable informational overdue history, never a permission expiry.
-- No historical domain row, schedule, assignment, attempt or receipt is rewritten.
create table private.cleaning_overdue_events(
  id uuid primary key default gen_random_uuid(),
  cleaning_target_id uuid not null unique references public.cleaning_targets(id),
  room_id uuid not null references public.rooms(id),
  actor_profile_id uuid not null references public.profiles(id),
  original_service_date date not null, effective_service_date date not null,
  available_from timestamptz, due_at timestamptz,
  assignment_id uuid references public.cleaning_assignments(id),
  assignment_version bigint not null, attempt_id uuid references public.cleaning_attempts(id),
  occurred_at timestamptz not null check(isfinite(occurred_at)),
  check((due_at is not null and occurred_at>due_at) or
    (due_at is null and occurred_at>=(effective_service_date+1)::timestamp at time zone 'Asia/Seoul'))
);
create index cleaning_overdue_events_room_idx on private.cleaning_overdue_events(room_id);
create index cleaning_overdue_events_actor_idx on private.cleaning_overdue_events(actor_profile_id);
create index cleaning_overdue_events_assignment_idx on private.cleaning_overdue_events(assignment_id);
create index cleaning_overdue_events_attempt_idx on private.cleaning_overdue_events(attempt_id);
create table private.cleaning_overdue_recipients(
  event_id uuid not null references private.cleaning_overdue_events(id),
  recipient_profile_id uuid not null references public.profiles(id),
  actor_profile_id uuid not null references public.profiles(id),
  push_expected boolean not null,
  enrolled_at timestamptz not null check(isfinite(enrolled_at)),
  primary key(event_id,recipient_profile_id),
  check(not push_expected or actor_profile_id<>recipient_profile_id)
);
create index cleaning_overdue_recipients_recipient_idx on private.cleaning_overdue_recipients(recipient_profile_id);
create index cleaning_overdue_recipients_actor_idx on private.cleaning_overdue_recipients(actor_profile_id);
create table private.cleaning_overdue_scan_cursor(
  singleton boolean primary key default true check(singleton),last_target_id uuid
);
insert into private.cleaning_overdue_scan_cursor(singleton) values(true);
create index cleaning_targets_overdue_scan_idx on public.cleaning_targets(id)
  include(effective_service_date,due_at) where status in('unassigned','draft_assigned','notified','in_progress');
alter table private.cleaning_overdue_events enable row level security;
alter table private.cleaning_overdue_events force row level security;
alter table private.cleaning_overdue_recipients enable row level security;
alter table private.cleaning_overdue_recipients force row level security;
alter table private.cleaning_overdue_scan_cursor enable row level security;
alter table private.cleaning_overdue_scan_cursor force row level security;
revoke all on private.cleaning_overdue_events,private.cleaning_overdue_recipients,
  private.cleaning_overdue_scan_cursor from public,anon,authenticated,service_role;
create trigger cleaning_overdue_events_immutable before update or delete on private.cleaning_overdue_events
  for each row execute function private.guard_notification_catalog_ledgers();
create trigger cleaning_overdue_recipients_immutable before update or delete on private.cleaning_overdue_recipients
  for each row execute function private.guard_notification_catalog_ledgers();

insert into private.notification_event_catalog(event_family,category,source_entity_kind,recipient_capability,
  requires_action,push_eligible,resolver_kind,deep_link_kind,group_family,group_scope_kind)
values('cleaning.overdue_admin','cleaning_overdue','cleaning_overdue_event','admin.assignment_decider',
  false,true,'none','cleaningTarget','cleaning_overdue','room');

-- dueAt is physical cleaning completion, not an invented upload/review deadline.
create function private.cleaning_target_is_overdue(p_target public.cleaning_targets,p_as_of timestamptz)
returns boolean language sql volatile security definer set search_path='' as $$
 select p_target.status in('unassigned','draft_assigned','notified','in_progress')
   and case when p_target.due_at is not null then p_as_of>p_target.due_at
     else p_as_of>=(p_target.effective_service_date+1)::timestamp at time zone 'Asia/Seoul' end
   and (p_target.status not in('notified','in_progress') or exists(select 1 from public.cleaning_assignments a
     where a.cleaning_target_id=p_target.id and a.is_current and a.notified_at is not null
       and a.revision=p_target.assignment_version and a.service_date=p_target.effective_service_date
       and a.available_from_snapshot is not distinct from p_target.available_from
       and a.due_at_snapshot is not distinct from p_target.due_at))
   and not exists(select 1 from public.cleaning_assignments assignment
     cross join lateral(select status from public.cleaning_attempts attempt
       where attempt.assignment_id=assignment.id and attempt.assignment_revision=assignment.revision
       order by attempt.attempt_number desc limit 1) latest_attempt
     where assignment.cleaning_target_id=p_target.id and assignment.is_current
       and latest_attempt.status not in('scheduled','in_progress'))
$$;

-- Record only facts read under the same global and domain row locks as execution.
create function private.guard_cleaning_overdue_evidence() returns trigger
language plpgsql security definer set search_path='' as $$
declare target public.cleaning_targets; assignment public.cleaning_assignments; attempt public.cleaning_attempts;
begin
 if tg_table_name='cleaning_overdue_events' then
  select * into target from public.cleaning_targets where id=new.cleaning_target_id;
  select * into assignment from public.cleaning_assignments where cleaning_target_id=target.id and is_current;
  select * into attempt from public.cleaning_attempts where assignment_id=assignment.id
    and assignment_revision=assignment.revision order by attempt_number desc limit 1;
  if target.id is null or not private.cleaning_target_is_overdue(target,new.occurred_at)
    or new.room_id is distinct from target.room_id
    or new.original_service_date is distinct from target.original_service_date
    or new.effective_service_date is distinct from target.effective_service_date
    or new.available_from is distinct from target.available_from or new.due_at is distinct from target.due_at
    or new.assignment_version is distinct from target.assignment_version
    or new.assignment_id is distinct from assignment.id or new.attempt_id is distinct from attempt.id then
   raise exception using errcode='23514',message='CLEANING_OVERDUE_EVIDENCE_INVALID';
  end if;
 else
  if not exists(select 1 from public.profiles where id=new.recipient_profile_id
      and role='admin' and status='active' and not must_change_password)
    or new.push_expected is distinct from (new.actor_profile_id<>new.recipient_profile_id) then
   raise exception using errcode='23514',message='CLEANING_OVERDUE_RECIPIENT_INVALID';
  end if;
 end if;
 perform private.assert_room_admin(new.actor_profile_id);
 if exists(select 1 from public.profiles where id=new.actor_profile_id and must_change_password) then
  raise exception using errcode='42501',message='PASSWORD_CHANGE_REQUIRED';
 end if;
 return new;
end $$;
create trigger cleaning_overdue_evidence before insert on private.cleaning_overdue_events
 for each row execute function private.guard_cleaning_overdue_evidence();
create trigger cleaning_overdue_recipient before insert on private.cleaning_overdue_recipients
 for each row execute function private.guard_cleaning_overdue_evidence();

alter function private.notification_source_is_valid(text,uuid,uuid,text,uuid,uuid,uuid)
 rename to notification_source_is_valid_before_cleaning_overdue;
create function private.notification_source_is_valid(p_event_family text,p_actor uuid,p_recipient uuid,p_source_id text,
 p_room uuid,p_cleaning_target uuid,p_deep_link_entity uuid) returns boolean
language plpgsql volatile security definer set search_path='' as $$
begin
 if p_event_family='cleaning.overdue_admin' then
  return exists(select 1 from private.cleaning_overdue_events e
    join private.cleaning_overdue_recipients r on r.event_id=e.id
    where e.id::text=p_source_id and r.actor_profile_id=p_actor and r.recipient_profile_id=p_recipient
      and e.room_id=p_room and e.cleaning_target_id=p_cleaning_target and e.cleaning_target_id=p_deep_link_entity);
 end if;
 return private.notification_source_is_valid_before_cleaning_overdue(
   p_event_family,p_actor,p_recipient,p_source_id,p_room,p_cleaning_target,p_deep_link_entity);
end $$;

-- Both directions are deferred: enrollment and exact typed notice/outbox must
-- commit together, while immutable history never depends on later account state.
create function private.check_cleaning_overdue_delivery() returns trigger
language plpgsql security definer set search_path='' as $$
declare v_event_id uuid; recipient uuid; event private.cleaning_overdue_events;
 enrollment private.cleaning_overdue_recipients; notice public.notifications; notice_count integer;
begin
 if tg_table_name='cleaning_overdue_events' then
  if not exists(select 1 from private.cleaning_overdue_recipients where event_id=new.id) then
   raise exception using errcode='23514',message='CLEANING_OVERDUE_DELIVERY_NOT_ATOMIC'; end if;
  return null;
 elsif tg_table_name='notification_delivery_outbox' then
  select * into notice from public.notifications where id=new.notification_id;
  if notice.event_family is distinct from 'cleaning.overdue_admin' then return null; end if;
  v_event_id:=notice.source_entity_id::uuid; recipient:=notice.recipient_profile_id;
 elsif tg_table_name='notifications' then
  if new.event_family is distinct from 'cleaning.overdue_admin' then return null; end if;
  begin v_event_id:=new.source_entity_id::uuid;
  exception when invalid_text_representation then
   raise exception using errcode='23514',message='CLEANING_OVERDUE_DELIVERY_NOT_ATOMIC'; end;
  recipient:=new.recipient_profile_id;
 else v_event_id:=new.event_id; recipient:=new.recipient_profile_id; end if;
 select * into event from private.cleaning_overdue_events where id=v_event_id;
 select r.* into enrollment from private.cleaning_overdue_recipients r
   where r.event_id=v_event_id and r.recipient_profile_id=recipient;
 select count(*) into notice_count from public.notifications n where n.event_family='cleaning.overdue_admin'
   and n.source_entity_id=v_event_id::text and n.recipient_profile_id=recipient;
 select * into notice from public.notifications n where n.event_family='cleaning.overdue_admin'
   and n.source_entity_id=v_event_id::text and n.recipient_profile_id=recipient;
 if event.id is null or enrollment.event_id is null or notice_count<>1 or notice.contract_version is distinct from 1
   or notice.category is distinct from 'cleaning_overdue' or notice.source_entity_kind is distinct from 'cleaning_overdue_event'
   or notice.actor_profile_id is distinct from enrollment.actor_profile_id or notice.requires_action
   or notice.room_id is distinct from event.room_id or notice.cleaning_target_id is distinct from event.cleaning_target_id
   or notice.deep_link_kind is distinct from 'cleaningTarget' or notice.deep_link_entity_id is distinct from event.cleaning_target_id
   or notice.occurred_at is distinct from event.occurred_at
   or (select count(*) from private.notification_delivery_outbox o where o.notification_id=notice.id)
       <>(case when enrollment.push_expected then 1 else 0 end)
   or exists(select 1 from private.notification_delivery_outbox o where o.notification_id=notice.id
     and (o.event_family<>'cleaning.overdue_admin' or o.enqueued_at<>event.occurred_at)) then
  raise exception using errcode='23514',message='CLEANING_OVERDUE_DELIVERY_NOT_ATOMIC';
 end if;
 return null;
end $$;
create constraint trigger cleaning_overdue_recipient_atomic after insert on private.cleaning_overdue_recipients
 deferrable initially deferred for each row execute function private.check_cleaning_overdue_delivery();
create constraint trigger cleaning_overdue_notice_atomic after insert on public.notifications
 deferrable initially deferred for each row execute function private.check_cleaning_overdue_delivery();
create constraint trigger cleaning_overdue_event_atomic after insert on private.cleaning_overdue_events
 deferrable initially deferred for each row execute function private.check_cleaning_overdue_delivery();
create constraint trigger cleaning_overdue_outbox_atomic after insert on private.notification_delivery_outbox
 deferrable initially deferred for each row execute function private.check_cleaning_overdue_delivery();

create function private.detect_cleaning_overdue_at(p_actor uuid,p_as_of timestamptz) returns integer
language plpgsql security definer set search_path='' as $$
declare item record; target public.cleaning_targets; assignment public.cleaning_assignments; attempt public.cleaning_attempts;
 event private.cleaning_overdue_events; recipient record; after_id uuid; scanned_id uuid;
 new_count integer:=0; inserted_id uuid; notice_id uuid;
begin
 perform private.assert_room_admin(p_actor);
 if p_as_of is null or not isfinite(p_as_of) then
  raise exception using errcode='22023',message='ASSIGNMENT_ACTIVATION_TIME_REQUIRED'; end if;
 if exists(select 1 from public.profiles where id=p_actor and must_change_password) then
  raise exception using errcode='42501',message='PASSWORD_CHANGE_REQUIRED'; end if;
 perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
 select last_target_id into after_id from private.cleaning_overdue_scan_cursor where singleton for update;
 for item in
  with forward as materialized(
   select id from public.cleaning_targets where status in('unassigned','draft_assigned','notified','in_progress')
    and effective_service_date<=(p_as_of at time zone 'Asia/Seoul')::date
    and (after_id is null or id>after_id) order by id limit 100
  ), wrapped as materialized(
   select id from public.cleaning_targets where status in('unassigned','draft_assigned','notified','in_progress')
    and effective_service_date<=(p_as_of at time zone 'Asia/Seoul')::date and after_id is not null and id<=after_id
    order by id limit (100-(select count(*) from forward))
  ) select id,0 part from forward union all select id,1 part from wrapped order by part,id
 loop
  scanned_id:=item.id;
  select * into target from public.cleaning_targets where id=item.id for update;
  select * into assignment from public.cleaning_assignments where cleaning_target_id=target.id and is_current for update;
  select * into attempt from public.cleaning_attempts where assignment_id=assignment.id
    and assignment_revision=assignment.revision order by attempt_number desc limit 1 for update;
  if not private.cleaning_target_is_overdue(target,p_as_of) then continue; end if;
  insert into private.cleaning_overdue_events(cleaning_target_id,room_id,actor_profile_id,original_service_date,
    effective_service_date,available_from,due_at,assignment_id,assignment_version,attempt_id,occurred_at)
  values(target.id,target.room_id,p_actor,target.original_service_date,target.effective_service_date,
    target.available_from,target.due_at,assignment.id,target.assignment_version,attempt.id,p_as_of)
  on conflict(cleaning_target_id) do nothing returning id into inserted_id;
  if inserted_id is not null then new_count:=new_count+1; end if;
  select * into event from private.cleaning_overdue_events where cleaning_target_id=target.id;
  -- Do not invert account commands' target-profile/admin-guard lock ordering.
  -- Enrollment/emitter recheck eligibility; a racing change in push eligibility
  -- fails the deferred atomic check, rolling the entire scan back for retry.
  for recipient in select id from public.profiles where role='admin' and status='active'
    and not must_change_password order by id
  loop
   -- Never re-enter the grouping/emitter with a different actor or detection time.
   if exists(select 1 from private.cleaning_overdue_recipients r
     where r.event_id=event.id and r.recipient_profile_id=recipient.id) then continue; end if;
   insert into private.cleaning_overdue_recipients(event_id,recipient_profile_id,actor_profile_id,push_expected,enrolled_at)
   values(event.id,recipient.id,p_actor,p_actor<>recipient.id,p_as_of);
   notice_id:=private.emit_notification_v1('cleaning.overdue_admin',p_actor,recipient.id,'cleaning_overdue_event',event.id::text,
     '청소 지연 확인','예정된 청소가 아직 완료되지 않았습니다. 업무 현황을 확인해 주세요.',
     event.room_id,event.cleaning_target_id,event.cleaning_target_id,event.occurred_at);
  end loop;
 end loop;
 update private.cleaning_overdue_scan_cursor set last_target_id=scanned_id where singleton;
 return new_count;
end $$;

-- Append the count before receipt completion; exact existing receipts replay as
-- recorded (they are not retroactively enriched or made to emit new notices).
do $upgrade$
declare definition text; needle text:=E'  perform private.complete_command(p_actor_profile_id,''assignment.process_due_lifecycle'',p_idempotency_key,p_request_hash,null,response);';
begin
 definition:=replace(pg_get_functiondef('private.process_due_assignment_lifecycle_at(uuid,timestamptz,text,text)'::regprocedure),E'\r\n',E'\n');
 if strpos(definition,needle)=0 or strpos(substr(definition,strpos(definition,needle)+length(needle)),needle)>0 then
  raise exception 'CLEANING_OVERDUE_SOURCE_DRIFT'; end if;
 execute replace(definition,needle,E'  response:=response||jsonb_build_object(''overdueCount'',private.detect_cleaning_overdue_at(p_actor_profile_id,p_as_of));\n'||needle);
end $upgrade$;
revoke all on function private.cleaning_target_is_overdue(public.cleaning_targets,timestamptz),
 private.guard_cleaning_overdue_evidence(),private.check_cleaning_overdue_delivery(),
 private.detect_cleaning_overdue_at(uuid,timestamptz),
 private.notification_source_is_valid(text,uuid,uuid,text,uuid,uuid,uuid),
 private.notification_source_is_valid_before_cleaning_overdue(text,uuid,uuid,text,uuid,uuid,uuid)
 from public,anon,authenticated,service_role;
