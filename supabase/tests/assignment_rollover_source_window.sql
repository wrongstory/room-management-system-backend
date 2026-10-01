begin;
\ir room_pin_fixture.psql
select no_plan();

create function pg_temp.pid(n integer) returns uuid language sql immutable as $$
  select ('28100000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid
$$;
insert into auth.users(id) values (pg_temp.pid(101)),(pg_temp.pid(102));
insert into public.profiles(
  id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
  login_sequence,role,status,must_change_password
) values
  (pg_temp.pid(1),pg_temp.pid(101),'이월 관리자','이월 관리자','이월 관리자','이월 관리자',0,'admin','active',false),
  (pg_temp.pid(2),pg_temp.pid(102),'이월 메이드','이월 메이드','이월 메이드','이월 메이드',0,'maid','active',false);

create temp table cases(n int primary key,room_id uuid,reservation_id uuid,target_id uuid);
insert into cases
select n,id,pg_temp.pid(200+n),pg_temp.pid(300+n)
from (select id,row_number() over(order by room_number)::int n from public.rooms) r where n<=9;
insert into public.cleaning_template_versions(
  room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,published_at,created_by
)
select distinct r.room_type_id,k,1,'published',60,'[]'::jsonb,now(),pg_temp.pid(1)
from cases c join public.rooms r on r.id=c.room_id
cross join unnest(array['checkout','stayover','additional']::public.cleaning_kind[]) k;
insert into public.room_pin_sync_events(room_id,sync_status,pin_version,reason_code,actor_profile_id,effective_at)
select room_id,'verified',1,'TEST',pg_temp.pid(1),now() from cases;
select pg_temp.install_room_pin_fixture(room_id,pg_temp.pid(1),1) from cases;

-- Both reservation and stayover targets are created by the real commands; only occupancy is fixture setup.
select public.create_reservation(pg_temp.pid(1),reservation_id,room_id,
  '2037-10-01 10:00+09',case when n in (2,3) then '2037-10-03 11:00+09'::timestamptz
    when n=9 then '2037-10-03 15:00+09'::timestamptz
    else '2037-10-04 11:00+09'::timestamptz end,2,null,
  (select state_version from public.rooms where id=c.room_id),'rollover-reservation-'||n,repeat('1',64))
from cases c where n<=7 or n=9;
update public.reservations set actual_check_in_at=check_in_at
where id in(select reservation_id from cases where n<=7 or n=9);
select public.create_manual_cleaning_request(pg_temp.pid(1),target_id,room_id,reservation_id,'stayover',
  '2037-10-02','2037-10-02 10:00+09','2037-10-02 15:00+09',
  (select state_version from public.rooms where id=c.room_id),'STAYOVER_TEST',
  'rollover-stayover-'||n,repeat('2',64)) from cases c where n<=7 or n=9;
select ok((select bool_and(t.source='stayover_request' and t.cleaning_kind='stayover')
  from cases c join public.cleaning_targets t on t.id=c.target_id where n<=7 or n=9),
  'actual create_manual_cleaning_request produces exact stayover source-kind');

-- Valid and invalid notified fixtures preserve the immutable assignment snapshot.
select public.save_cleaning_assignment_draft(pg_temp.pid(1),target_id,pg_temp.pid(2),n,1,
  'rollover-draft-'||n,repeat('3',64)) from cases where n in(1,3);
update public.cleaning_assignments set notified_at='2037-10-02 09:00+09'
where cleaning_target_id in(select target_id from cases where n in(1,3));
update public.cleaning_targets set status='notified'
where id in(select target_id from cases where n in(1,3));
insert into public.notifications(recipient_profile_id,category,title,body,cleaning_target_id,dedupe_key,requires_action)
select pg_temp.pid(2),'cleaning_assignment_notified','합성','합성',target_id,'rollover-notice-'||n,true
from cases where n in(1,3);

-- Domain-state fixtures after the actual request: checked-out, not occupied, and cancelled.
update public.reservations set status='checked_out',actual_checkout_at='2037-10-02 16:00+09'
where id=(select reservation_id from cases where n=4);
update public.reservations set actual_check_in_at=null where id=(select reservation_id from cases where n=5);
update public.reservations set status='cancelled',cancelled_at='2037-10-02 16:00+09',actual_check_in_at=null
where id=(select reservation_id from cases where n=6);
-- Active + actual checkout is already forbidden by the domain constraint. Keep it intact.
select throws_ok($$update public.reservations set actual_checkout_at='2037-10-02 16:00+09'
  where id=(select reservation_id from cases where n=7)$$,'23514',
  'new row for relation "reservations" violates check constraint "reservations_status_timestamps_check"',
  'active reservation cannot acquire actual checkout without checked_out state');
update public.reservations set status='checked_out',actual_checkout_at='2037-10-02 16:00+09',actual_check_in_at=null
where id=(select reservation_id from cases where n=7);

-- Additional command starts conflict-free, but the next day's window overlaps a later active reservation.
select public.create_manual_cleaning_request(pg_temp.pid(1),target_id,room_id,null,'additional',
  '2037-10-02','2037-10-02 10:00+09','2037-10-02 15:00+09',
  (select state_version from public.rooms where id=c.room_id),'ADDITIONAL_TEST',
  'rollover-additional-create',repeat('4',64)) from cases c where n=8;
select public.create_reservation(pg_temp.pid(1),reservation_id,room_id,
  '2037-10-03 10:00+09','2037-10-05 11:00+09',2,null,
  (select state_version from public.rooms where id=c.room_id),'rollover-additional-reservation',repeat('5',64))
from cases c where n=8;

-- Preserve every original notice, plus every non-overdue notice. New overdue
-- evidence is checked separately below; old notice IDs may never be rewritten.
create temp table original_notice_ids as select id from public.notifications;
create function pg_temp.snapshot(p_target uuid) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'target',(select to_jsonb(t) from public.cleaning_targets t where id=p_target),
    'assignments',(select coalesce(jsonb_agg(to_jsonb(a) order by id),'[]') from public.cleaning_assignments a where cleaning_target_id=p_target),
    'notifications',(select coalesce(jsonb_agg(to_jsonb(n) order by id),'[]') from public.notifications n where cleaning_target_id=p_target
      and (event_family is distinct from 'cleaning.overdue_admin' or id in(select id from original_notice_ids))),
    'outbox',(select coalesce(jsonb_agg(to_jsonb(o) order by o.id),'[]') from private.notification_outbox o
      join public.notifications n on n.id=o.notification_id where n.cleaning_target_id=p_target),
    'revisions',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') from public.cleaning_target_schedule_revisions r where cleaning_target_id=p_target),
    'audit',(select coalesce(jsonb_agg(to_jsonb(a) order by id),'[]') from public.audit_events a where entity_id=p_target),
    'attempts',(select coalesce(jsonb_agg(to_jsonb(a) order by id),'[]') from public.cleaning_attempts a where cleaning_target_id=p_target)
  )
$$;
create temp table before_state as select n,pg_temp.snapshot(target_id) value from cases;
create temp table results as
select c.n,private.rollover_cleaning_target_at(pg_temp.pid(1),c.target_id,'2037-10-02 16:00+09',a.id,t.assignment_version,t.effective_service_date) value
from cases c join public.cleaning_targets t on t.id=c.target_id
left join public.cleaning_assignments a on a.cleaning_target_id=t.id and a.is_current;

select is((select value->>'status' from results where n=1),'rolledOver','valid notified stayover rolls over');
select is((select value->>'status' from results where n=9),'rolledOver',
  'next due exactly equals scheduled checkout boundary and remains valid');
select ok((select t.effective_service_date='2037-10-03' and t.due_at=r.check_out_at
  and t.carryover_count=1 and t.assignment_version=2
  from cases c join public.cleaning_targets t on t.id=c.target_id
  join public.reservations r on r.id=c.reservation_id where c.n=9),
  'inclusive stayover checkout boundary rolls over once without exceeding reservation');
select ok((select t.original_service_date='2037-10-02' and t.effective_service_date='2037-10-03'
  and t.available_from='2037-10-03 10:00+09' and t.due_at='2037-10-03 15:00+09'
  and t.carryover_count=1 and t.assignment_version=3 and t.status='unassigned'
  from public.cleaning_targets t join cases c on c.target_id=t.id where n=1),
  'valid rollover preserves identity/original date and moves schedule/version exactly once');
select is((select count(*)::int from public.cleaning_target_schedule_revisions r join cases c on c.target_id=r.cleaning_target_id
  where n=1 and reason_code='ROLLED_OVER_NOT_STARTED'),1,'valid rollover appends one revision');
select ok((select not a.is_current and a.ended_at is not null from public.cleaning_assignments a join cases c
  on c.target_id=a.cleaning_target_id where n=1),'valid rollover closes previous assignment');
select ok((select resolved_at is not null from public.notifications where dedupe_key='rollover-notice-1'),
  'valid rollover resolves old actionable notification');
select is((select count(*)::int from public.notifications n join cases c on c.target_id=n.cleaning_target_id
  where c.n=1 and n.category='cleaning_assignment_rolled_over'),1,'valid rollover notification exactly once');
select is((select count(*)::int from private.notification_delivery_outbox o join public.notifications n on n.id=o.notification_id
  join cases c on c.target_id=n.cleaning_target_id where c.n=1),0,'informational rollover is inbox-only');
select is(value->>'status','blocked','invalid source window blocked case '||n) from results where n between 2 and 8;
select is(value->>'reasonCode',case when n=8 then 'ADDITIONAL_ROLLOVER_NOT_ALLOWED' else 'STAYOVER_ROLLOVER_NOT_ALLOWED' end,
  'stable source reason case '||n) from results where n between 2 and 8;
select is(pg_temp.snapshot(c.target_id),b.value,'invalid rollover zero mutation case '||c.n)
from cases c join before_state b using(n) where c.n between 2 and 8;
select ok((select t.status='notified' and a.is_current and a.ended_at is null
  from cases c join public.cleaning_targets t on t.id=c.target_id
  join public.cleaning_assignments a on a.cleaning_target_id=t.id where c.n=3),
  'invalid notified stayover keeps current assignment and target status');

-- A failed historical rollover does not invalidate the original still-occupied
-- stayover window. The scheduler preserves schedules and may activate that work.
select public.process_due_assignment_lifecycle(pg_temp.pid(1),'2037-10-02 16:00+09'::timestamptz+make_interval(mins=>n),
  'reservation-scheduler-rollover-regression-'||n,repeat('6',64)) from generate_series(1,3) n;
select is(pg_temp.snapshot(c.target_id),b.value,'three distinct scheduler buckets still zero mutation case '||c.n)
from cases c join before_state b using(n) where c.n between 2 and 8 and c.n<>3;
select is(pg_temp.snapshot(c.target_id)-array['attempts','audit'],b.value-array['attempts','audit'],
  'overdue notified stayover keeps schedule, assignment and notices while activating')
from cases c join before_state b using(n) where c.n=3;
select is((select count(*)::int from public.cleaning_attempts where cleaning_target_id=(select target_id from cases where n=3)),1,
  'three scheduler buckets activate original overdue stayover exactly once');
select is((select carryover_count from public.cleaning_targets where id=(select target_id from cases where n=1)),1,
  'scheduler retry does not duplicate valid next-day rollover');
select is((select count(*)::int from private.cleaning_overdue_events e where e.cleaning_target_id=c.target_id),1,
  'three scheduler buckets record exactly one overdue identity case '||c.n)
from cases c where c.n between 2 and 8;
select is((select count(*)::int from public.notifications n
  join private.cleaning_overdue_events e on e.id::text=n.source_entity_id
  where e.cleaning_target_id=c.target_id and n.event_family='cleaning.overdue_admin'
    and n.category='cleaning_overdue' and n.contract_version=1
    and n.recipient_profile_id=pg_temp.pid(1) and n.actor_profile_id=pg_temp.pid(1)
    and not n.requires_action and n.occurred_at=e.occurred_at
    and n.deep_link_kind='cleaningTarget' and n.deep_link_entity_id=c.target_id),1,
  'original-admin inbox has one exact typed overdue notice case '||c.n)
from cases c where c.n between 2 and 8;
select is((select count(*)::int from private.cleaning_overdue_recipients r
  join private.cleaning_overdue_events e on e.id=r.event_id
  where e.cleaning_target_id=c.target_id and r.recipient_profile_id=pg_temp.pid(1)
    and r.actor_profile_id=pg_temp.pid(1) and not r.push_expected),1,
  'scheduler retains exactly one self enrollment case '||c.n)
from cases c where c.n between 2 and 8;
select is((select count(*)::int from private.cleaning_overdue_events
  where cleaning_target_id in(select target_id from cases)),7,
  'three buckets retain exactly seven target observations without new schedule-day events');
select is((select count(*)::int from public.notifications
  where event_family='cleaning.overdue_admin' and cleaning_target_id in(select target_id from cases)),7,
  'three buckets retain exactly seven overdue notices without extras');
select is((select count(*)::int from private.notification_delivery_outbox o
  join public.notifications n on n.id=o.notification_id
  where n.event_family='cleaning.overdue_admin' and n.cleaning_target_id in(select target_id from cases)),0,
  'scheduler retains actor-self overdue inbox without self push');

select * from finish();
rollback;
