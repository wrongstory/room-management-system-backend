begin;
select no_plan();
create function pg_temp.oid(n integer) returns uuid language sql immutable as $$
 select ('30800000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
insert into auth.users(id) select pg_temp.oid(100+n) from generate_series(1,6) n;
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
 login_sequence,role,status,must_change_password)
select pg_temp.oid(n),pg_temp.oid(100+n),'overdue-'||n,'overdue-'||n,'overdue-'||n,'overdue-'||n,0,
 case when n=3 then 'maid' else 'admin' end::public.app_role,
 case when n in(4,6) then 'inactive' else 'active' end::public.account_status,n=5 from generate_series(1,6) n;
create function pg_temp.overdue_fixture(n integer,p_status public.cleaning_target_status default 'unassigned',
 p_attempt public.attempt_status default null,p_day date default '2042-06-01',p_due timestamptz default '2042-06-01 11:00+09')
returns void language plpgsql as $$
declare room uuid;
begin
 select id into room from public.rooms order by room_number offset (n%100) limit 1;
 insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,effective_service_date,
  available_from,due_at,status,assignment_version,room_type_snapshot,fee_snapshot,template_snapshot,created_by)
 values(pg_temp.oid(1000+n),room,'additional','manual_room_request','overdue-fixture-'||n,p_day,p_day,
  p_day::timestamp at time zone 'Asia/Seoul',p_due,p_status,2,'{}',10000,'{}',pg_temp.oid(1));
 if p_status in('draft_assigned','notified') then
  insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,changed_by,notified_at)
  values(pg_temp.oid(2000+n),pg_temp.oid(1000+n),pg_temp.oid(3),n,2,pg_temp.oid(1),
   case when p_status='notified' then '2042-06-01 00:00+09'::timestamptz end);
 end if;
 if p_attempt is not null then
  insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,
   assignment_revision,template_snapshot,room_snapshot)
  values(pg_temp.oid(3000+n),pg_temp.oid(1000+n),pg_temp.oid(2000+n),pg_temp.oid(3),1,p_attempt,2,'{}',jsonb_build_object('roomId',room));
 end if;
end $$;
select pg_temp.overdue_fixture(1);
select pg_temp.overdue_fixture(2,'draft_assigned');
select pg_temp.overdue_fixture(n,'notified',status::public.attempt_status) from (values
 (3,'scheduled'),(4,'scheduled'),(5,'field_completed'),(6,'upload_pending'),(7,'submitted'),
 (8,'approved'),(9,'rejected'),(10,'superseded'),(11,'interrupted')) fixture(n,status);
select pg_temp.overdue_fixture(12,'cancelled');
select pg_temp.overdue_fixture(13,'unassigned',null,'2042-05-31',null);
select pg_temp.overdue_fixture(14,'unassigned',null,'2042-06-01',null);
select pg_temp.overdue_fixture(15,'unassigned',null,'2042-06-01','2042-06-01 12:00+09');
select pg_temp.overdue_fixture(16,'notified');
select private.execute_cleaning_attempt_at(pg_temp.oid(3),pg_temp.oid(3004),1,pg_temp.oid(2004),2,
 'overdue-real-start',repeat('f',64),'start','2042-06-01 10:00+09');
update public.cleaning_targets set status='in_progress' where id=pg_temp.oid(1005);
create function pg_temp.overdue_business() returns jsonb language sql stable as $$
 select jsonb_build_object('targets',(select jsonb_agg(t order by id) from public.cleaning_targets t),
 'assignments',(select jsonb_agg(a order by id) from public.cleaning_assignments a),
 'attempts',(select jsonb_agg(a order by id) from public.cleaning_attempts a),
 'reservations',(select jsonb_agg(r order by id) from public.reservations r),
 'checkout',(select jsonb_agg(o order by id) from public.checkout_cleaning_obligations o)) $$;
create function pg_temp.overdue_delivery() returns jsonb language sql stable as $$
 select jsonb_build_object('events',(select jsonb_agg(e order by id) from private.cleaning_overdue_events e),
 'recipients',(select jsonb_agg(r order by event_id,recipient_profile_id) from private.cleaning_overdue_recipients r),
 'notices',(select jsonb_agg(n order by id) from public.notifications n),
 'groups',(select jsonb_agg(g order by id) from private.notification_groups g),
 'outbox',(select jsonb_agg(o order by id) from private.notification_delivery_outbox o),
 'cursor',(select to_jsonb(c) from private.cleaning_overdue_scan_cursor c)) $$;
create temp table overdue_results(label text primary key,value jsonb);
insert into overdue_results values('business-before',pg_temp.overdue_business());
select is(private.detect_cleaning_overdue_at(pg_temp.oid(1),'2042-06-01 12:00+09'),6,'first scan records six unfinished overdue targets');
select is(pg_temp.overdue_business(),(select value from overdue_results where label='business-before'),
 'detection never mutates target, assignment, attempt, reservation or checkout obligation');
select is((select count(*)::int from private.cleaning_overdue_events where cleaning_target_id between pg_temp.oid(1005) and pg_temp.oid(1012)),0,
 'physical completion, upload, review, terminal attempts and cancelled targets are not new cleaning overdue work');
select is((select count(*)::int from public.notifications where event_family='cleaning.overdue_admin'),12,'two active password-complete admins each receive six inbox notices');
select is((select count(*)::int from private.notification_delivery_outbox where event_family='cleaning.overdue_admin'),6,'actor-self inbox is retained without self push');
select ok((select bool_and(not requires_action and resolved_at is null and deep_link_kind='cleaningTarget'
 and deep_link_entity_id=cleaning_target_id) from public.notifications where event_family='cleaning.overdue_admin'),
 'overdue notices are informational history with safe cleaning-target links');
select is((select count(*)::int from private.cleaning_overdue_recipients where recipient_profile_id in(pg_temp.oid(3),pg_temp.oid(4),pg_temp.oid(5),pg_temp.oid(6))),0,
 'maid, inactive and temporary-password profiles receive no overdue enrollment');
-- Real reservation creation proves overdue detection never performs checkout.
insert into public.cleaning_template_versions(room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,published_at,created_by)
select id,'checkout',1,'published',null,'[]',now(),pg_temp.oid(1) from public.room_types;
create function pg_temp.unmaterialized_checkout_probe() returns boolean language plpgsql as $$
declare room uuid; target uuid; result boolean;
begin
 begin
  select id into room from public.rooms order by room_number offset 90 limit 1;
  perform public.create_reservation(pg_temp.oid(1),pg_temp.oid(9000),room,'2042-05-29 12:00+09','2042-05-31 12:00+09',1,null,
    (select state_version from public.rooms where id=room),'overdue-checkout-probe',repeat('d',64));
  update public.reservations set actual_check_in_at=check_in_at where id=pg_temp.oid(9000);
  select planned_cleaning_target_id into target from public.checkout_cleaning_obligations where reservation_id=pg_temp.oid(9000);
  perform private.detect_cleaning_overdue_at(pg_temp.oid(1),'2042-06-01 12:00+09');
  select exists(select 1 from private.cleaning_overdue_events where cleaning_target_id=target)
    and exists(select 1 from public.reservations where id=pg_temp.oid(9000) and actual_checkout_at is null and status='active')
    and exists(select 1 from public.checkout_cleaning_obligations where reservation_id=pg_temp.oid(9000)
      and status='private' and current_cleaning_target_id is null)
    and not exists(select 1 from public.cleaning_attempts where cleaning_target_id=target) into result;
  raise exception using errcode='PZ308',message='rollback overdue checkout probe';
 exception when sqlstate 'PZ308' then null;
 end;
 return result;
end $$;
select ok(pg_temp.unmaterialized_checkout_probe(),'overdue checkout notice never invents actual checkout, consumes its obligation or creates an attempt');
select ok(not private.cleaning_target_is_overdue(t,'2042-06-01 12:00+09')
 and private.cleaning_target_is_overdue(t,'2042-06-01 12:00:00.000001+09'),'dueAt is strict greater-than, not inclusive')
 from public.cleaning_targets t where id=pg_temp.oid(1015);
select ok(not private.cleaning_target_is_overdue(t,'2042-06-01 23:59:59.999999+09')
 and private.cleaning_target_is_overdue(t,'2042-06-02 00:00+09'),'NULL dueAt uses exact next KST midnight')
 from public.cleaning_targets t where id=pg_temp.oid(1014);
insert into overdue_results values('first-delivery',pg_temp.overdue_delivery());
select is(private.detect_cleaning_overdue_at(pg_temp.oid(2),'2042-06-01 12:00+09'),0,'different actor replay creates no event');
select is(pg_temp.overdue_delivery(),(select value from overdue_results where label='first-delivery'),
 'different actor replay preserves original evidence, enrollment, notice, group and outbox byte-for-byte');
select is(private.detect_cleaning_overdue_at(pg_temp.oid(2),'2042-06-01 12:30+09'),1,'later grouping window adds only newly elapsed boundary target');
select ok(not exists(select 1 from private.cleaning_overdue_events e where e.cleaning_target_id<>pg_temp.oid(1015)
 and e.occurred_at<>'2042-06-01 12:00+09'),'later scan never moves original event time to the new grouping window');
select is((select count(*)::int from public.notifications where cleaning_target_id=pg_temp.oid(1001)),2,'permanent dedupe is independent of grouping windows');
update public.profiles set status='active' where id=pg_temp.oid(6);
select is(private.detect_cleaning_overdue_at(pg_temp.oid(2),'2042-06-01 12:31+09'),0,'new admin enrollment does not create new target evidence');
select is((select count(*)::int from private.cleaning_overdue_recipients where recipient_profile_id=pg_temp.oid(6)),7,'later eligible administrator enrolls once in each still-incomplete target');
select ok((select bool_and(n.occurred_at=e.occurred_at and n.actor_profile_id=pg_temp.oid(2))
 from public.notifications n join private.cleaning_overdue_events e on e.id::text=n.source_entity_id
 where n.event_family='cleaning.overdue_admin' and n.recipient_profile_id=pg_temp.oid(6)),
 'new enrollment binds its own actor while preserving the original event timestamp');
select throws_ok($$select private.detect_cleaning_overdue_at(pg_temp.oid(3),'2042-06-01 12:31+09')$$,'42501','ADMIN_REQUIRED','maid cannot run privileged detection');
select throws_ok($$select private.detect_cleaning_overdue_at(pg_temp.oid(4),'2042-06-01 12:31+09')$$,'42501','ACTIVE_ACCOUNT_REQUIRED','inactive actor is denied');
select throws_ok($$select private.detect_cleaning_overdue_at(pg_temp.oid(5),'2042-06-01 12:31+09')$$,'42501','PASSWORD_CHANGE_REQUIRED','temporary-password actor is denied');
select throws_ok($$update private.cleaning_overdue_events set occurred_at=occurred_at+interval '1 day'$$,'55000','NOTIFICATION_CATALOG_LEDGER_IMMUTABLE','event timestamp cannot be rewritten');
select throws_ok($$delete from private.cleaning_overdue_recipients$$,'55000','NOTIFICATION_CATALOG_LEDGER_IMMUTABLE','recipient evidence cannot be deleted');

-- Failure of typed notification append rolls back event, cursor, enrollment and all delivery rows.
select pg_temp.overdue_fixture(20);
insert into overdue_results values('atomic-before',pg_temp.overdue_delivery());
create function pg_temp.fail_overdue_notice() returns trigger language plpgsql as $$ begin
 if new.event_family='cleaning.overdue_admin' then raise exception 'TEST_OVERDUE_NOTICE_FAILURE'; end if; return new; end $$;
create trigger fail_overdue_notice before insert on public.notifications for each row execute function pg_temp.fail_overdue_notice();
select throws_ok($$select private.detect_cleaning_overdue_at(pg_temp.oid(1),'2042-06-01 12:32+09')$$,'P0001','TEST_OVERDUE_NOTICE_FAILURE','notice failure aborts the complete scan transaction');
select is(pg_temp.overdue_delivery(),(select value from overdue_results where label='atomic-before'),'failed delivery append leaves no partial evidence or cursor advancement');
drop trigger fail_overdue_notice on public.notifications;
select is(private.detect_cleaning_overdue_at(pg_temp.oid(1),'2042-06-01 12:32+09'),1,'failed scan can be retried once after recovery');
-- Old superseded attempts cannot hide the latest live attempt on the same assignment.
insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,
 assignment_revision,template_snapshot,room_snapshot)
select pg_temp.oid(4010),id,pg_temp.oid(2010),pg_temp.oid(3),2,'scheduled',2,'{}',jsonb_build_object('roomId',room_id)
from public.cleaning_targets where id=pg_temp.oid(1010);
select pg_temp.overdue_fixture(17,'notified');
update public.cleaning_targets set due_at='2042-06-01 10:00+09' where id=pg_temp.oid(1017);
select is(private.detect_cleaning_overdue_at(pg_temp.oid(1),'2042-06-01 12:33+09'),1,'latest scheduled attempt is eligible while stale assignment snapshot is skipped');
select is((select attempt_id from private.cleaning_overdue_events where cleaning_target_id=pg_temp.oid(1010)),pg_temp.oid(4010),
 'evidence points to the latest exact current-assignment attempt');
select is((select count(*)::int from private.cleaning_overdue_events where cleaning_target_id=pg_temp.oid(1017)),0,'notified assignment identity drift is fail-closed');
set constraints all immediate;
set constraints all deferred;

-- New evidence must have recipient enrollment; enrollment and notice must be reciprocal.
create function pg_temp.orphan_overdue_event() returns void language plpgsql as $$ begin
 perform pg_temp.overdue_fixture(21);
 insert into private.cleaning_overdue_events(cleaning_target_id,room_id,actor_profile_id,original_service_date,
 effective_service_date,available_from,due_at,assignment_version,occurred_at)
 select id,room_id,pg_temp.oid(1),original_service_date,effective_service_date,available_from,due_at,assignment_version,'2042-06-01 12:33+09'
 from public.cleaning_targets where id=pg_temp.oid(1021);
 set constraints all immediate;
end $$;
select throws_ok($$select pg_temp.orphan_overdue_event()$$,'23514','CLEANING_OVERDUE_DELIVERY_NOT_ATOMIC','deferred contract rejects orphan event evidence');
select ok(not private.notification_source_is_valid('cleaning.overdue_admin',pg_temp.oid(1),pg_temp.oid(3),e.id::text,
 e.room_id,e.cleaning_target_id,e.cleaning_target_id),'known event UUID never grants another recipient authority')
 from private.cleaning_overdue_events e where cleaning_target_id=pg_temp.oid(1001);

-- Bounded fair pages, including a full page whose business deadline is not open yet.
select pg_temp.overdue_fixture(n,'unassigned',null,'2042-06-01','2042-06-01 23:00+09') from generate_series(100,199) n;
select pg_temp.overdue_fixture(200);
update private.cleaning_overdue_scan_cursor set last_target_id=pg_temp.oid(1099) where singleton;
select is(private.detect_cleaning_overdue_at(pg_temp.oid(1),'2042-06-01 12:34+09'),0,'first bounded page contains only not-yet-overdue targets');
select is((select last_target_id from private.cleaning_overdue_scan_cursor),pg_temp.oid(1199),'one scan advances by exactly one hundred candidates');
select is(private.detect_cleaning_overdue_at(pg_temp.oid(1),'2042-06-01 12:35+09'),1,'next page reaches the overdue backlog after a blocked full page');

-- Scheduler integration keeps its response receipt and includes a bounded new-event count.
select pg_temp.overdue_fixture(201);
update private.cleaning_overdue_scan_cursor set last_target_id=pg_temp.oid(1200) where singleton;
insert into overdue_results values('scheduler',public.process_due_assignment_lifecycle(pg_temp.oid(1),
 '2042-06-01 12:36+09','overdue-notification-scheduler',repeat('a',64)));
select is((select value->>'overdueCount' from overdue_results where label='scheduler'),'1','scheduler response reports newly recorded overdue identities');
insert into overdue_results values('scheduler-delivery',pg_temp.overdue_delivery());
select is(public.process_due_assignment_lifecycle(pg_temp.oid(1),'2042-06-01 12:36+09','overdue-notification-scheduler',repeat('a',64)),
 (select value from overdue_results where label='scheduler'),'scheduler receipt replays exact response including overdue count');
select is(pg_temp.overdue_delivery(),(select value from overdue_results where label='scheduler-delivery'),'same scheduler receipt adds no group, notice, outbox or cursor mutation');
insert into overdue_results select 'completed-event',to_jsonb(e) from private.cleaning_overdue_events e where cleaning_target_id=pg_temp.oid(1001);
update public.cleaning_targets set status='approved' where id=pg_temp.oid(1001);
update public.profiles set status='active' where id=pg_temp.oid(4);
update private.cleaning_overdue_scan_cursor set last_target_id=null where singleton;
select is(private.detect_cleaning_overdue_at(pg_temp.oid(2),'2042-06-01 12:37+09'),0,'late admin enrollment does not create events for completed work');
select is((select to_jsonb(e) from private.cleaning_overdue_events e where cleaning_target_id=pg_temp.oid(1001)),
 (select value from overdue_results where label='completed-event'),'completion preserves immutable overdue history');
select is((select count(*)::int from private.cleaning_overdue_recipients r join private.cleaning_overdue_events e on e.id=r.event_id
 where e.cleaning_target_id=pg_temp.oid(1001) and r.recipient_profile_id=pg_temp.oid(4)),0,'completed historical event does not newly enroll a later administrator');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid=tab::regclass),tab||' has forced RLS')
 from unnest(array['private.cleaning_overdue_events','private.cleaning_overdue_recipients','private.cleaning_overdue_scan_cursor']) tab;
select ok(not has_table_privilege(role,tab,'SELECT,INSERT,UPDATE,DELETE'),role||' has no raw access to '||tab)
 from unnest(array['anon','authenticated','service_role']) role cross join unnest(array[
 'private.cleaning_overdue_events','private.cleaning_overdue_recipients','private.cleaning_overdue_scan_cursor']) tab;
select ok(not has_function_privilege(role,'private.detect_cleaning_overdue_at(uuid,timestamptz)','execute'),role||' cannot directly call detector')
 from unnest(array['anon','authenticated','service_role']) role;
set local role service_role;
select throws_ok($$select * from private.cleaning_overdue_events$$,'42501',null,'actual service role cannot read raw evidence');
reset role;
set local role authenticated;
select throws_ok($$select private.detect_cleaning_overdue_at('30800000-0000-4000-8000-000000000001',now())$$,'42501',null,'actual authenticated role cannot call private detector');
reset role;
-- Informational overdue notices retain immutable push intent, but the worker
-- rechecks current recipient eligibility and never sends without a subscription.
-- Use the actual server clock so this exercises eligibility rather than the TTL.
update public.profiles set status='inactive' where id=pg_temp.oid(4);
select pg_temp.overdue_fixture(300,'unassigned',null,
 ((clock_timestamp()-interval '1 hour') at time zone 'Asia/Seoul')::date,
 clock_timestamp()-interval '1 hour');
update private.cleaning_overdue_scan_cursor set last_target_id=null where singleton;
select is(private.detect_cleaning_overdue_at(pg_temp.oid(1),clock_timestamp()),1,
 'current-clock overdue work records one event for delivery-state regression');
select is((select count(*)::int from private.notification_delivery_outbox o
 join public.notifications n on n.id=o.notification_id
 where n.event_family='cleaning.overdue_admin' and n.cleaning_target_id=pg_temp.oid(1300)),2,
 'two non-self eligible admins have immutable outbox intent before account change');
update public.profiles set status='inactive' where id=pg_temp.oid(2);
select public.claim_notification_deliveries(repeat('3',64),10);
select is((select count(*)::int from private.notification_delivery_jobs j
 join private.notification_delivery_outbox o on o.id=j.outbox_id
 join public.notifications n on n.id=o.notification_id
 where n.cleaning_target_id=pg_temp.oid(1300) and n.recipient_profile_id=pg_temp.oid(2)
 and j.status='suppressed' and j.terminal_reason='RECIPIENT_NOT_ELIGIBLE'),1,
 'worker suppresses overdue push after the recipient becomes inactive');
select is((select count(*)::int from private.notification_delivery_jobs j
 join private.notification_delivery_outbox o on o.id=j.outbox_id
 join public.notifications n on n.id=o.notification_id
 where n.cleaning_target_id=pg_temp.oid(1300) and n.recipient_profile_id=pg_temp.oid(6)
 and j.status='suppressed' and j.terminal_reason='NO_ACTIVE_SUBSCRIPTION'),1,
 'active admin informational overdue push reaches the ordinary subscription check');
select is((select count(*)::int from private.notification_delivery_targets t
 join public.notifications n on n.id=t.notification_id
 where n.cleaning_target_id=pg_temp.oid(1300)),0,
 'suppressed overdue delivery creates no external provider delivery target');
set constraints all immediate;
select * from finish();
rollback;
