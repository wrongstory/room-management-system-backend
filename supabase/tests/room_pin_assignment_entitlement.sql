begin;
select no_plan();

create function pg_temp.id(n integer) returns uuid language sql immutable as $$
  select ('f1940000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
create function pg_temp.room_id() returns uuid language sql stable as $$
  select id from public.rooms order by room_number limit 1
$$;
create function pg_temp.room_number() returns text language sql stable as $$
  select room_number from public.rooms where id=pg_temp.room_id()
$$;

insert into auth.users(id) values(pg_temp.id(101)),(pg_temp.id(102)),(pg_temp.id(103));
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
  login_sequence,role,status,must_change_password)
values
  (pg_temp.id(1),pg_temp.id(101),'PIN Entitlement 관리자','PIN Entitlement 관리자','pin-ent-admin','pin-ent-admin',0,'admin','active',false),
  (pg_temp.id(2),pg_temp.id(102),'PIN Entitlement 메이드','PIN Entitlement 메이드','pin-ent-maid','pin-ent-maid',0,'maid','active',false),
  (pg_temp.id(3),pg_temp.id(103),'PIN Entitlement 종료 메이드','PIN Entitlement 종료 메이드','pin-ent-final','pin-ent-final',0,'maid','active',false);
insert into auth.sessions(id,user_id) values
  (pg_temp.id(201),pg_temp.id(101)),(pg_temp.id(202),pg_temp.id(102)),(pg_temp.id(203),pg_temp.id(103));

create temp table result(label text primary key,value jsonb);
insert into result values('pin-v1-prepare',public.prepare_room_pin_change(
  pg_temp.id(1),pg_temp.id(201),pg_temp.room_id(),0,pg_temp.room_number(),null,null,null,
  'ADMIN_INITIAL_PIN',1::smallint,'djE=','AQEBAQEBAQEBAQEB','AAAAAAAAAAAAAAAAAAAAAA==',
  'v1','test','local','entitlement-pin-v1-prepare',repeat('1',64)));
insert into result values('pin-v1-confirm',public.confirm_room_pin_change(
  pg_temp.id(1),pg_temp.id(201),pg_temp.room_id(),
  ((select value->>'lease_id' from result where label='pin-v1-prepare'))::uuid,0,
  'entitlement-pin-v1-confirm',repeat('2',64)));

create function pg_temp.notify_assignment(
  n integer,p_maid uuid,p_date date,p_status public.cleaning_target_status default 'notified'
) returns uuid language plpgsql as $$
declare target_id uuid:=pg_temp.id(300+n); assignment_id uuid:=pg_temp.id(400+n);
  group_id uuid:=pg_temp.id(500+n); notification_id uuid:=pg_temp.id(600+n); outbox_id uuid:=pg_temp.id(700+n);
begin
  insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,
    effective_service_date,available_from,due_at,status,assignment_version,room_type_snapshot,
    fee_snapshot,template_snapshot,created_by)
  values(target_id,pg_temp.room_id(),'additional','manual_room_request','pin-entitlement-'||n,p_date,p_date,
    (p_date::timestamp at time zone 'Asia/Seoul')+interval '11 hours',
    (p_date::timestamp at time zone 'Asia/Seoul')+interval '20 hours',p_status,2,'{}',10000,'{}',pg_temp.id(1));
  insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,notified_at,changed_by)
  values(assignment_id,target_id,p_maid,n,2,clock_timestamp(),pg_temp.id(1));
  insert into private.notification_groups(id,recipient_profile_id,group_family,scope_kind,scope_id,started_at,ends_at)
  values(group_id,p_maid,'cleaning_assignment_notified','room',pg_temp.room_id(),transaction_timestamp(),transaction_timestamp()+interval '10 minutes');
  insert into public.notifications(id,recipient_profile_id,category,title,body,room_id,cleaning_target_id,
    dedupe_key,requires_action,occurred_at,contract_version,actor_profile_id,event_family,
    source_entity_kind,source_entity_id,deep_link_kind,deep_link_entity_id,notification_group_id)
  values(notification_id,p_maid,'cleaning_assignment_notified','assignment','assignment',pg_temp.room_id(),target_id,
    'pin-entitlement-'||n,true,clock_timestamp(),1,pg_temp.id(1),'assignment.commit_notified',
    'cleaning_assignment',assignment_id::text,'cleaningTarget',target_id,group_id);
  insert into private.notification_delivery_outbox(id,notification_id,event_family)
  values(outbox_id,notification_id,'assignment.commit_notified');
  return assignment_id;
end $$;

create temp table assignments(label text primary key,id uuid);
insert into assignments values
  ('today',pg_temp.notify_assignment(1,pg_temp.id(2),(clock_timestamp() at time zone 'Asia/Seoul')::date)),
  ('next',pg_temp.notify_assignment(2,pg_temp.id(2),(clock_timestamp() at time zone 'Asia/Seoul')::date+1)),
  ('far',pg_temp.notify_assignment(3,pg_temp.id(2),(clock_timestamp() at time zone 'Asia/Seoul')::date+2)),
  ('deactivation',pg_temp.notify_assignment(4,pg_temp.id(3),(clock_timestamp() at time zone 'Asia/Seoul')::date)),
  ('inspection',pg_temp.notify_assignment(5,pg_temp.id(2),(clock_timestamp() at time zone 'Asia/Seoul')::date,'inspection_pending')),
  ('reject',pg_temp.notify_assignment(6,pg_temp.id(2),(clock_timestamp() at time zone 'Asia/Seoul')::date)),
  ('cancel',pg_temp.notify_assignment(7,pg_temp.id(2),(clock_timestamp() at time zone 'Asia/Seoul')::date));

select is((select count(*)::int from private.room_pin_assignment_entitlements where ended_at is null),7,
  'each exact typed delivery outbox grants its current notified assignment immediately, including farther future work');
select is((select source_outbox_id from private.room_pin_assignment_entitlements
  where assignment_id=(select id from assignments where label='today') and ended_at is null),pg_temp.id(701),
  'entitlement binds the exact outbox row that fired the grant trigger');

-- A second logical notification cannot rewrite the immutable source evidence or duplicate authority.
insert into private.notification_groups(id,recipient_profile_id,group_family,scope_kind,scope_id,started_at,ends_at)
values(pg_temp.id(551),pg_temp.id(2),'cleaning_assignment_notified','room',pg_temp.room_id(),transaction_timestamp(),transaction_timestamp()+interval '10 minutes');
insert into public.notifications(id,recipient_profile_id,category,title,body,room_id,cleaning_target_id,
  dedupe_key,requires_action,occurred_at,contract_version,actor_profile_id,event_family,
  source_entity_kind,source_entity_id,deep_link_kind,deep_link_entity_id,notification_group_id)
select pg_temp.id(651),pg_temp.id(2),'cleaning_assignment_notified','assignment','assignment',pg_temp.room_id(),
  a.cleaning_target_id,'pin-entitlement-duplicate',true,clock_timestamp(),1,pg_temp.id(1),
  'assignment.commit_notified','cleaning_assignment',a.id::text,'cleaningTarget',a.cleaning_target_id,pg_temp.id(551)
from public.cleaning_assignments a where a.id=(select id from assignments where label='today');
insert into private.notification_delivery_outbox(id,notification_id,event_family)
values(pg_temp.id(751),pg_temp.id(651),'assignment.commit_notified');
select is((select count(*)::int from private.room_pin_assignment_entitlements
  where assignment_id=(select id from assignments where label='today') and ended_at is null),1,
  'notification retry or duplicate evidence converges to one active entitlement');
select is((select source_outbox_id from private.room_pin_assignment_entitlements
  where assignment_id=(select id from assignments where label='today') and ended_at is null),pg_temp.id(701),
  'later outbox evidence cannot replace the original immutable source binding');

-- Assignment snapshots are immutable, so a same-maid schedule/prestart change
-- ends the prior assignment row and creates a successor row at the new target
-- assignment revision without rotating the room PIN.
update public.cleaning_targets set assignment_version=3
where id=(select cleaning_target_id from public.cleaning_assignments
  where id=(select id from assignments where label='today'));
update public.cleaning_assignments
set is_current=false,ended_at=clock_timestamp(),change_reason_code='TEST_SAME_MAID_CHANGED'
where id=(select id from assignments where label='today');
insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,notified_at,changed_by)
select pg_temp.id(499),cleaning_target_id,maid_profile_id,sequence_number,3,clock_timestamp(),pg_temp.id(1)
from public.cleaning_assignments where id=pg_temp.id(401);
update assignments set id=pg_temp.id(499) where label='today';
insert into private.notification_groups(id,recipient_profile_id,group_family,scope_kind,scope_id,started_at,ends_at)
values(pg_temp.id(553),pg_temp.id(2),'cleaning_assignment_changed','room',pg_temp.room_id(),transaction_timestamp(),transaction_timestamp()+interval '10 minutes');
insert into public.notifications(id,recipient_profile_id,category,title,body,room_id,cleaning_target_id,
  dedupe_key,requires_action,occurred_at,contract_version,actor_profile_id,event_family,
  source_entity_kind,source_entity_id,deep_link_kind,deep_link_entity_id,notification_group_id)
select pg_temp.id(653),pg_temp.id(2),'cleaning_assignment_changed','changed','changed',pg_temp.room_id(),
  a.cleaning_target_id,'pin-entitlement-revision-bump',true,clock_timestamp(),1,pg_temp.id(1),
  'assignment.prestart_same_maid_changed','cleaning_assignment',a.id::text,'cleaningTarget',a.cleaning_target_id,pg_temp.id(553)
from public.cleaning_assignments a where a.id=(select id from assignments where label='today');
insert into private.notification_delivery_outbox(id,notification_id,event_family)
values(pg_temp.id(753),pg_temp.id(653),'assignment.prestart_same_maid_changed');
select is((select count(*)::int from private.room_pin_assignment_entitlements
  where assignment_id=pg_temp.id(401) and assignment_revision=2
    and ended_at is not null),1,
  'same-maid revision change ends the exact previous immutable assignment authority');
select is((select count(*)::int from private.room_pin_assignment_entitlements
  where assignment_id=(select id from assignments where label='today') and assignment_revision=3
    and pin_version=1 and ended_at is null),1,
  'same PIN revision grants one active successor for the new assignment revision');
insert into result values('revision-bump-reveal',public.begin_room_pin_reveal(
  pg_temp.id(2),pg_temp.id(202),pg_temp.room_id(),
  (select id from assignments where label='today'),null,null,pg_temp.id(802)));
select is((select value->>'pin_version' from result where label='revision-bump-reveal'),'1',
  'the exact successor assignment revision can begin a reveal immediately');

insert into result values('admin-reveal',public.begin_room_pin_reveal(
  pg_temp.id(1),pg_temp.id(201),pg_temp.room_id(),null,null,null,pg_temp.id(810)));
select is((select value->>'pin_version' from result where label='admin-reveal'),'1',
  'an active administrator retains the independent positive reveal path');
select throws_ok(format($sql$select public.begin_room_pin_reveal(%L,%L,%L,%L,null,null,%L)$sql$,
  pg_temp.id(3),pg_temp.id(203),pg_temp.room_id(),(select id from assignments where label='today'),pg_temp.id(811)),
  '42501','PIN_ENTITLEMENT_REQUIRED','another maid cannot reveal through the assignee entitlement');
insert into result values('inspection-reveal',public.begin_room_pin_reveal(
  pg_temp.id(2),pg_temp.id(202),pg_temp.room_id(),
  (select id from assignments where label='inspection'),null,null,pg_temp.id(812)));
select ok((select ended_at is null from private.room_pin_assignment_entitlements
  where assignment_id=(select id from assignments where label='inspection')),
  'inspection_pending retains the durable entitlement');
select is((select value->>'pin_version' from result where label='inspection-reveal'),'1',
  'inspection_pending remains revealable by the exact notified maid');

update public.cleaning_targets set status='rejected'
where id=(select cleaning_target_id from public.cleaning_assignments
  where id=(select id from assignments where label='reject'));
select ok(not exists(select 1 from private.room_pin_assignment_entitlements
  where assignment_id=(select id from assignments where label='reject') and ended_at is null),
  'final rejection atomically ends assignment PIN authority');
update public.cleaning_targets set status='cancelled'
where id=(select cleaning_target_id from public.cleaning_assignments
  where id=(select id from assignments where label='cancel'));
select ok(not exists(select 1 from private.room_pin_assignment_entitlements
  where assignment_id=(select id from assignments where label='cancel') and ended_at is null),
  'approved cancellation atomically ends assignment PIN authority');

-- Entering the limited deactivation lifecycle keeps durable history open but reveal remains active-only.
update public.profiles set status='deactivation_pending' where id=pg_temp.id(3);
select ok((select ended_at is null from private.room_pin_assignment_entitlements
  where assignment_id=(select id from assignments where label='deactivation')),
  'deactivation_pending does not prematurely end the durable assignment entitlement');
select throws_ok(format($sql$select public.begin_room_pin_reveal(%L,%L,%L,%L,null,null,%L)$sql$,
  pg_temp.id(3),pg_temp.id(203),pg_temp.room_id(),(select id from assignments where label='deactivation'),pg_temp.id(801)),
  '42501','PIN_ACCESS_REQUIRED','deactivation_pending cannot execute a new PIN reveal');
update public.profiles set status='upload_only' where id=pg_temp.id(3);
select ok((select ended_at is null from private.room_pin_assignment_entitlements
  where assignment_id=(select id from assignments where label='deactivation')),
  'upload_only preserves durable history until final account cleanup');
select throws_ok(format($sql$select public.begin_room_pin_reveal(%L,%L,%L,%L,null,null,%L)$sql$,
  pg_temp.id(3),pg_temp.id(203),pg_temp.room_id(),(select id from assignments where label='deactivation'),pg_temp.id(813)),
  '42501','PIN_ACCESS_REQUIRED','upload_only cannot execute a PIN reveal');

-- Rotation ends every old revision but issues successors only to active current workflow and the nearest future service date.
insert into result values('pin-v2-prepare',public.prepare_room_pin_change(
  pg_temp.id(1),pg_temp.id(201),pg_temp.room_id(),1,pg_temp.room_number(),null,null,null,
  'ADMIN_PHYSICAL_CHANGE',1::smallint,'djI=','AgICAgICAgICAgIC','AAAAAAAAAAAAAAAAAAAAAA==',
  'v1','test','local','entitlement-pin-v2-prepare',repeat('3',64)));
insert into result values('pin-v2-confirm',public.confirm_room_pin_change(
  pg_temp.id(1),pg_temp.id(201),pg_temp.room_id(),
  ((select value->>'lease_id' from result where label='pin-v2-prepare'))::uuid,1,
  'entitlement-pin-v2-confirm',repeat('4',64)));
select ok(exists(select 1 from private.room_pin_assignment_entitlements e join assignments a on a.id=e.assignment_id
  where a.label='today' and e.pin_version=2 and e.ended_at is null),
  'rotation grants the active current-workflow assignee the exact new PIN revision');
select ok(exists(select 1 from private.room_pin_assignment_entitlements e join assignments a on a.id=e.assignment_id
  where a.label='next' and e.pin_version=2 and e.ended_at is null),
  'rotation grants the already-notified nearest future workday assignee');
select ok(not exists(select 1 from private.room_pin_assignment_entitlements e join assignments a on a.id=e.assignment_id
  where a.label='far' and e.pin_version=2 and e.ended_at is null),
  'rotation does not grant a farther future notified assignment');
select ok(not exists(select 1 from private.room_pin_assignment_entitlements e join assignments a on a.id=e.assignment_id
  where a.label='deactivation' and e.pin_version=2 and e.ended_at is null),
  'rotation never grants a successor to deactivation_pending or upload_only actors');
select is((select count(*)::int from private.room_pin_assignment_entitlements where pin_version=1 and ended_at is null),0,
  'rotation atomically closes every authority bound to the old PIN revision');

select ok(not exists(select 1 from private.room_pin_assignment_entitlements e join assignments a on a.id=e.assignment_id
  where a.label='deactivation' and e.ended_at is null),
  'upload_only transition does not resurrect PIN authority after rotation');
update public.profiles set status='departed' where id=pg_temp.id(3);
select ok(not exists(select 1 from private.room_pin_assignment_entitlements
  where maid_profile_id=pg_temp.id(3) and ended_at is null),
  'final departed cleanup leaves no durable or reveal authority open');

update public.cleaning_assignments
set is_current=false,ended_at=clock_timestamp(),change_reason_code='TEST_REASSIGNED'
where id=(select id from assignments where label='next');
select ok(not exists(select 1 from private.room_pin_assignment_entitlements
  where assignment_id=(select id from assignments where label='next') and ended_at is null),
  'assignment revision change ends the previous exact revision entitlement');
update public.cleaning_targets set status='approved'
where id=(select cleaning_target_id from public.cleaning_assignments
  where id=(select id from assignments where label='today'));
select ok(not exists(select 1 from private.room_pin_assignment_entitlements
  where assignment_id=(select id from assignments where label='today') and ended_at is null),
  'final approval atomically ends current assignment PIN authority');

-- The rollover family can create a typed delivery outbox, but it describes an
-- ended predecessor rather than authority-starting notification evidence. It
-- must stay outside both the positive evidence allowlist and the grant path.
update public.cleaning_assignments
set is_current=false,ended_at=clock_timestamp(),change_reason_code='TEST_ROLLED_OVER'
where id=(select id from assignments where label='far');
insert into private.notification_groups(id,recipient_profile_id,group_family,scope_kind,scope_id,started_at,ends_at)
values(pg_temp.id(552),pg_temp.id(2),'cleaning_assignment_rolled_over','room',pg_temp.room_id(),transaction_timestamp(),transaction_timestamp()+interval '10 minutes');
insert into public.notifications(id,recipient_profile_id,category,title,body,room_id,cleaning_target_id,
  dedupe_key,requires_action,occurred_at,contract_version,actor_profile_id,event_family,
  source_entity_kind,source_entity_id,deep_link_kind,deep_link_entity_id,notification_group_id)
select pg_temp.id(652),pg_temp.id(2),'cleaning_assignment_rolled_over','rollover','rollover',pg_temp.room_id(),
  a.cleaning_target_id,'pin-entitlement-rollover',false,clock_timestamp(),1,pg_temp.id(1),
  'assignment.scheduled_rolled_over','cleaning_assignment',a.id::text,'cleaningTarget',a.cleaning_target_id,pg_temp.id(552)
from public.cleaning_assignments a where a.id=(select id from assignments where label='far');
insert into private.notification_delivery_outbox(id,notification_id,event_family)
values(pg_temp.id(752),pg_temp.id(652),'assignment.scheduled_rolled_over');
select ok(not exists(select 1 from private.pin_assignment_outbox_evidence(
  (select id from assignments where label='far')) where outbox_id=pg_temp.id(752)),
  'scheduled rollover outbox is explicitly non-authoritative PIN evidence');
select ok(not exists(select 1 from private.room_pin_assignment_entitlements
  where assignment_id=(select id from assignments where label='far') and ended_at is null),
  'scheduled rollover outbox never re-grants its ended predecessor');

select throws_ok(format('delete from private.room_pin_assignment_entitlements where assignment_id=%L',
  (select id from assignments where label='far')),'55000','PIN_ENTITLEMENT_IMMUTABLE',
  'entitlement ledger rows cannot be deleted');
select throws_ok(format('update private.room_pin_assignment_entitlements set maid_profile_id=%L where assignment_id=%L',
  pg_temp.id(3),(select id from assignments where label='far')),'55000','PIN_ENTITLEMENT_IMMUTABLE',
  'entitlement identity cannot be rewritten');

select * from finish();
rollback;
