-- #343: one informational attention event for an unanswered initial decision.
-- No complaint history, deadline, permission, receipt or economic ledger is rewritten.
create table private.complaint_response_attention_events(
  id uuid primary key default gen_random_uuid(),
  complaint_case_id uuid not null unique references public.complaint_cases(id),
  initial_decision_id uuid not null references public.complaint_decisions(id),
  current_decision_id uuid not null references public.complaint_decisions(id),
  case_version bigint not null check(case_version>0),
  room_id uuid not null references public.rooms(id),
  cleaning_target_id uuid not null references public.cleaning_targets(id),
  first_decided_at timestamptz not null check(isfinite(first_decided_at)),
  response_deadline timestamptz not null check(isfinite(response_deadline)),
  actor_profile_id uuid not null references public.profiles(id),
  occurred_at timestamptz not null check(isfinite(occurred_at)),
  check(response_deadline=first_decided_at+interval '7 days' and occurred_at>response_deadline)
);
create index complaint_attention_initial_idx on private.complaint_response_attention_events(initial_decision_id);
create index complaint_attention_current_idx on private.complaint_response_attention_events(current_decision_id);
create index complaint_attention_room_idx on private.complaint_response_attention_events(room_id);
create index complaint_attention_target_idx on private.complaint_response_attention_events(cleaning_target_id);
create index complaint_attention_actor_idx on private.complaint_response_attention_events(actor_profile_id);
create table private.complaint_response_attention_recipients(
  event_id uuid not null references private.complaint_response_attention_events(id),
  recipient_profile_id uuid not null references public.profiles(id),
  actor_profile_id uuid not null references public.profiles(id),
  push_expected boolean not null,
  enrolled_at timestamptz not null check(isfinite(enrolled_at)),
  primary key(event_id,recipient_profile_id),
  check(not push_expected or actor_profile_id<>recipient_profile_id)
);
create index complaint_attention_recipient_idx on private.complaint_response_attention_recipients(recipient_profile_id);
create index complaint_attention_recipient_actor_idx on private.complaint_response_attention_recipients(actor_profile_id);
create table private.complaint_response_attention_scan_cursor(
  singleton boolean primary key default true check(singleton),last_case_id uuid
);
insert into private.complaint_response_attention_scan_cursor(singleton) values(true);
create index complaint_cases_attention_scan_idx on public.complaint_cases(id)
  include(response_deadline,current_decision_id) where status='decided' and response_deadline is not null;
alter table private.complaint_response_attention_events enable row level security;
alter table private.complaint_response_attention_events force row level security;
alter table private.complaint_response_attention_recipients enable row level security;
alter table private.complaint_response_attention_recipients force row level security;
alter table private.complaint_response_attention_scan_cursor enable row level security;
alter table private.complaint_response_attention_scan_cursor force row level security;
revoke all on private.complaint_response_attention_events,private.complaint_response_attention_recipients,
  private.complaint_response_attention_scan_cursor from public,anon,authenticated,service_role;
create trigger complaint_attention_events_immutable before update or delete on private.complaint_response_attention_events
  for each row execute function private.guard_notification_catalog_ledgers();
create trigger complaint_attention_recipients_immutable before update or delete on private.complaint_response_attention_recipients
  for each row execute function private.guard_notification_catalog_ledgers();

insert into private.notification_event_catalog(event_family,category,source_entity_kind,recipient_capability,
  requires_action,push_eligible,resolver_kind,deep_link_kind,group_family,group_scope_kind)
values('complaint.response_attention_admin','complaint_response_attention','complaint_response_attention_event',
  'admin.complaint_decider',false,true,'none','complaintCase','complaint_response_attention','room');
-- The older typed-source index excludes resolved history. These commit checks
-- must stay bounded for the entire immutable lifetime, not only the inbox queue.
create index notifications_complaint_attention_source_idx
  on public.notifications(source_entity_id,recipient_profile_id)
  where contract_version=1 and event_family='complaint.response_attention_admin';

create function private.complaint_response_attention_is_due(p_case public.complaint_cases,p_as_of timestamptz)
returns boolean language sql volatile security definer set search_path='' as $$
 select coalesce(p_case.status='decided' and p_case.response_deadline is not null
   and isfinite(p_case.response_deadline) and isfinite(p_case.first_decided_at)
   and p_as_of>p_case.response_deadline
   and exists(select 1 from public.complaint_decisions initial
     where initial.complaint_case_id=p_case.id and initial.decision_version=1
       and initial.decision_kind='initial' and initial.prior_decision_id is null
       and initial.decided_at=p_case.first_decided_at)
   and exists(select 1 from public.complaint_decisions current
     where current.id=p_case.current_decision_id and current.complaint_case_id=p_case.id)
   and not exists(select 1 from public.complaint_maid_responses response
     where response.complaint_case_id=p_case.id),false)
$$;

create function private.guard_complaint_response_attention_evidence() returns trigger
language plpgsql security definer set search_path='' as $$
declare c public.complaint_cases; initial public.complaint_decisions;
  event private.complaint_response_attention_events;
begin
 perform private.assert_complaint_admin(new.actor_profile_id);
 if tg_table_name='complaint_response_attention_events' then
  select * into c from public.complaint_cases where id=new.complaint_case_id;
  select * into initial from public.complaint_decisions where id=new.initial_decision_id;
  if not private.complaint_response_attention_is_due(c,new.occurred_at)
    or new.current_decision_id is distinct from c.current_decision_id
    or new.case_version is distinct from c.version or new.room_id is distinct from c.room_id
    or new.cleaning_target_id is distinct from c.cleaning_target_id
    or new.first_decided_at is distinct from c.first_decided_at
    or new.response_deadline is distinct from c.response_deadline
    or initial.id is null or initial.complaint_case_id is distinct from c.id
    or initial.decision_version<>1 or initial.decision_kind<>'initial'
    or initial.decided_at is distinct from c.first_decided_at then
   raise exception using errcode='23514',message='COMPLAINT_ATTENTION_EVIDENCE_INVALID';
  end if;
 else
  select * into event from private.complaint_response_attention_events where id=new.event_id;
  select * into c from public.complaint_cases where id=event.complaint_case_id;
  if event.id is null or not private.complaint_response_attention_is_due(c,new.enrolled_at)
    or new.enrolled_at<event.occurred_at
    or not exists(select 1 from public.profiles where id=new.recipient_profile_id
      and role='admin' and status='active' and not must_change_password)
    or new.push_expected is distinct from (new.actor_profile_id<>new.recipient_profile_id) then
   raise exception using errcode='23514',message='COMPLAINT_ATTENTION_RECIPIENT_INVALID';
  end if;
 end if;
 return new;
end $$;
create trigger complaint_attention_evidence before insert on private.complaint_response_attention_events
  for each row execute function private.guard_complaint_response_attention_evidence();
create trigger complaint_attention_recipient before insert on private.complaint_response_attention_recipients
  for each row execute function private.guard_complaint_response_attention_evidence();

-- A newly eligible recipient gets a fresh delivery opportunity, not the old
-- event's already expired 24-hour TTL. Keep the shared emitter/old families and
-- immutable notice/group occurrence clock unchanged.
create function private.set_complaint_attention_delivery_clock() returns trigger
language plpgsql security definer set search_path='' as $$
declare notice public.notifications; event private.complaint_response_attention_events;
  enrollment private.complaint_response_attention_recipients;
begin
 if new.event_family<>'complaint.response_attention_admin' then return new; end if;
 select * into notice from public.notifications where id=new.notification_id;
 begin
  select * into event from private.complaint_response_attention_events where id=notice.source_entity_id::uuid;
 exception when invalid_text_representation then
  raise exception using errcode='23514',message='COMPLAINT_ATTENTION_DELIVERY_NOT_ATOMIC';
 end;
 select * into enrollment from private.complaint_response_attention_recipients
   where event_id=event.id and recipient_profile_id=notice.recipient_profile_id;
 if notice.contract_version is distinct from 1 or notice.event_family is distinct from new.event_family
   or notice.source_entity_kind is distinct from 'complaint_response_attention_event'
   or event.id is null or enrollment.event_id is null or not enrollment.push_expected
   or notice.actor_profile_id is distinct from enrollment.actor_profile_id
   or new.enqueued_at is distinct from event.occurred_at then
  raise exception using errcode='23514',message='COMPLAINT_ATTENTION_DELIVERY_NOT_ATOMIC';
 end if;
 new.enqueued_at:=enrollment.enrolled_at;
 return new;
end $$;
create trigger complaint_attention_delivery_clock before insert on private.notification_delivery_outbox
  for each row execute function private.set_complaint_attention_delivery_clock();

-- Catch this UUID family before the legacy complaint.* bigint event branch.
alter function private.notification_source_is_valid(text,uuid,uuid,text,uuid,uuid,uuid)
  rename to notification_source_is_valid_before_complaint_attention;
create function private.notification_source_is_valid(p_event_family text,p_actor uuid,p_recipient uuid,p_source_id text,
  p_room uuid,p_cleaning_target uuid,p_deep_link_entity uuid) returns boolean
language plpgsql volatile security definer set search_path='' as $$
begin
 if p_event_family='complaint.response_attention_admin' then
  return exists(select 1 from private.complaint_response_attention_events e
    join private.complaint_response_attention_recipients r on r.event_id=e.id
    where e.id=p_source_id::uuid and r.actor_profile_id=p_actor and r.recipient_profile_id=p_recipient
      and e.room_id=p_room and e.cleaning_target_id=p_cleaning_target
      and e.complaint_case_id=p_deep_link_entity);
 end if;
 return private.notification_source_is_valid_before_complaint_attention(
   p_event_family,p_actor,p_recipient,p_source_id,p_room,p_cleaning_target,p_deep_link_entity);
exception when invalid_text_representation then return false;
end $$;

create function private.check_complaint_response_attention_delivery() returns trigger
language plpgsql security definer set search_path='' as $$
declare v_event_id uuid; recipient uuid; event private.complaint_response_attention_events;
  enrollment private.complaint_response_attention_recipients; notice public.notifications; notice_count integer;
begin
 if tg_table_name='complaint_response_attention_events' then
  if not exists(select 1 from private.complaint_response_attention_recipients r where r.event_id=new.id) then
   raise exception using errcode='23514',message='COMPLAINT_ATTENTION_DELIVERY_NOT_ATOMIC'; end if;
  return null;
 elsif tg_table_name='notification_delivery_outbox' then
  select * into notice from public.notifications where id=new.notification_id;
  if notice.event_family is distinct from 'complaint.response_attention_admin' then return null; end if;
  v_event_id:=notice.source_entity_id::uuid; recipient:=notice.recipient_profile_id;
 elsif tg_table_name='notifications' then
  if new.event_family is distinct from 'complaint.response_attention_admin' then return null; end if;
  begin v_event_id:=new.source_entity_id::uuid;
  exception when invalid_text_representation then
   raise exception using errcode='23514',message='COMPLAINT_ATTENTION_DELIVERY_NOT_ATOMIC'; end;
  recipient:=new.recipient_profile_id;
 else v_event_id:=new.event_id; recipient:=new.recipient_profile_id; end if;
 select * into event from private.complaint_response_attention_events where id=v_event_id;
 select r.* into enrollment from private.complaint_response_attention_recipients r
   where r.event_id=v_event_id and r.recipient_profile_id=recipient;
 select count(*) into notice_count from public.notifications n
   where n.contract_version=1 and n.event_family='complaint.response_attention_admin' and n.source_entity_id=v_event_id::text
     and n.recipient_profile_id=recipient;
 select * into notice from public.notifications n
   where n.contract_version=1 and n.event_family='complaint.response_attention_admin' and n.source_entity_id=v_event_id::text
     and n.recipient_profile_id=recipient;
 if event.id is null or enrollment.event_id is null or notice_count<>1 or notice.contract_version is distinct from 1
   or notice.category is distinct from 'complaint_response_attention'
   or notice.source_entity_kind is distinct from 'complaint_response_attention_event'
   or notice.actor_profile_id is distinct from enrollment.actor_profile_id or notice.requires_action
   or notice.room_id is distinct from event.room_id or notice.cleaning_target_id is distinct from event.cleaning_target_id
   or notice.deep_link_kind is distinct from 'complaintCase' or notice.deep_link_entity_id is distinct from event.complaint_case_id
   or notice.occurred_at is distinct from event.occurred_at
   or (select count(*) from private.notification_delivery_outbox o where o.notification_id=notice.id)
     <>(case when enrollment.push_expected then 1 else 0 end)
   or exists(select 1 from private.notification_delivery_outbox o where o.notification_id=notice.id
     and (o.event_family<>'complaint.response_attention_admin' or o.enqueued_at<>enrollment.enrolled_at)) then
  raise exception using errcode='23514',message='COMPLAINT_ATTENTION_DELIVERY_NOT_ATOMIC';
 end if;
 return null;
end $$;
create constraint trigger complaint_attention_recipient_atomic after insert on private.complaint_response_attention_recipients
  deferrable initially deferred for each row execute function private.check_complaint_response_attention_delivery();
create constraint trigger complaint_attention_notice_atomic after insert on public.notifications
  deferrable initially deferred for each row execute function private.check_complaint_response_attention_delivery();
create constraint trigger complaint_attention_event_atomic after insert on private.complaint_response_attention_events
  deferrable initially deferred for each row execute function private.check_complaint_response_attention_delivery();
create constraint trigger complaint_attention_outbox_atomic after insert on private.notification_delivery_outbox
  deferrable initially deferred for each row execute function private.check_complaint_response_attention_delivery();

create function private.detect_complaint_response_attention_at(p_actor uuid,p_as_of timestamptz) returns integer
language plpgsql security definer set search_path='' as $$
declare item record; c public.complaint_cases; event private.complaint_response_attention_events;
  recipient record; after_id uuid; scanned_id uuid; inserted_id uuid; new_count integer:=0;
begin
 perform private.assert_complaint_admin(p_actor);
 if p_as_of is null or not isfinite(p_as_of) then
  raise exception using errcode='22023',message='ASSIGNMENT_ACTIVATION_TIME_REQUIRED'; end if;
 perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
 perform private.assert_complaint_admin(p_actor);
 select last_case_id into after_id from private.complaint_response_attention_scan_cursor where singleton for update;
 for item in
  with forward as materialized(
   select id from public.complaint_cases where status='decided' and response_deadline is not null
     and response_deadline<p_as_of and (after_id is null or id>after_id) order by id limit 100
  ), wrapped as materialized(
   select id from public.complaint_cases where status='decided' and response_deadline is not null
     and response_deadline<p_as_of and after_id is not null and id<=after_id
     order by id limit (100-(select count(*) from forward))
  ) select id,0 part from forward union all select id,1 part from wrapped order by part,id
 loop
  scanned_id:=item.id;
  select * into c from public.complaint_cases where id=item.id for update;
  if not private.complaint_response_attention_is_due(c,p_as_of) then continue; end if;
  insert into private.complaint_response_attention_events(complaint_case_id,initial_decision_id,current_decision_id,
    case_version,room_id,cleaning_target_id,first_decided_at,response_deadline,actor_profile_id,occurred_at)
  select c.id,d.id,c.current_decision_id,c.version,c.room_id,c.cleaning_target_id,
    c.first_decided_at,c.response_deadline,p_actor,p_as_of
  from public.complaint_decisions d where d.complaint_case_id=c.id and d.decision_version=1
  on conflict(complaint_case_id) do nothing returning id into inserted_id;
  if inserted_id is not null then new_count:=new_count+1; end if;
  select * into event from private.complaint_response_attention_events where complaint_case_id=c.id;
  -- Do not invert account commands' profile/admin guard locking. Eligibility is
  -- checked at enrollment and again by the emitter; racing push drift rolls back.
  for recipient in select id from public.profiles where role='admin' and status='active'
    and not must_change_password order by id
  loop
   if exists(select 1 from private.complaint_response_attention_recipients r
     where r.event_id=event.id and r.recipient_profile_id=recipient.id) then continue; end if;
   insert into private.complaint_response_attention_recipients(event_id,recipient_profile_id,actor_profile_id,push_expected,enrolled_at)
   values(event.id,recipient.id,p_actor,p_actor<>recipient.id,p_as_of);
   perform private.emit_notification_v1('complaint.response_attention_admin',p_actor,recipient.id,
     'complaint_response_attention_event',event.id::text,'컴플레인 응답 지연 확인',
     '최초 판정에 대한 메이드 응답이 아직 없습니다. 사건 현황을 확인해 주세요.',
     event.room_id,event.cleaning_target_id,event.complaint_case_id,event.occurred_at);
  end loop;
 end loop;
 update private.complaint_response_attention_scan_cursor set last_case_id=scanned_id where singleton;
 return new_count;
end $$;

do $upgrade$
declare definition text; needle text:=E'  perform private.complete_command(p_actor_profile_id,''assignment.process_due_lifecycle'',p_idempotency_key,p_request_hash,null,response);';
begin
 definition:=replace(pg_get_functiondef('private.process_due_assignment_lifecycle_at(uuid,timestamptz,text,text)'::regprocedure),E'\r\n',E'\n');
 if strpos(definition,needle)=0 or strpos(substr(definition,strpos(definition,needle)+length(needle)),needle)>0 then
  raise exception 'COMPLAINT_ATTENTION_SOURCE_DRIFT'; end if;
 execute replace(definition,needle,E'  response:=response||jsonb_build_object(''complaintAttentionCount'',private.detect_complaint_response_attention_at(p_actor_profile_id,p_as_of));\n'||needle);
end $upgrade$;
revoke all on function private.complaint_response_attention_is_due(public.complaint_cases,timestamptz),
  private.guard_complaint_response_attention_evidence(),private.check_complaint_response_attention_delivery(),
  private.set_complaint_attention_delivery_clock(),
  private.detect_complaint_response_attention_at(uuid,timestamptz),
  private.notification_source_is_valid(text,uuid,uuid,text,uuid,uuid,uuid),
  private.notification_source_is_valid_before_complaint_attention(text,uuid,uuid,text,uuid,uuid,uuid)
  from public,anon,authenticated,service_role;
