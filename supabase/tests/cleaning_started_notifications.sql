begin;
select no_plan();
select ok(exists(select 1 from pg_indexes where schemaname='public' and tablename='audit_events'
 and indexname='audit_cleaning_started_entity_idx' and indexdef like '%(entity_id, id)%'
 and indexdef like '%cleaning_attempt%' and indexdef like '%cleaning.attempt_started%'),
 'duplicate start evidence lookup has an attempt-keyed partial index');
select is((select to_jsonb(c) from private.notification_event_catalog c where event_family='cleaning.started_admin'),
 jsonb_build_object('event_family','cleaning.started_admin','category','cleaning_started','source_entity_kind','cleaning_attempt',
 'recipient_capability','admin.assignment_decider','requires_action',false,'push_eligible',true,'resolver_kind','none',
 'deep_link_kind','cleaningTarget','group_family','cleaning_started','group_scope_kind','room','contract_version',1),
 'started catalog preserves the exact approved informational admin contract');
create function pg_temp.sid(n integer) returns uuid language sql immutable as $$
 select ('30830000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
insert into auth.users(id) select pg_temp.sid(100+n) from generate_series(1,7) n;
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
 login_sequence,role,status,must_change_password)
select pg_temp.sid(n),pg_temp.sid(100+n),'started-'||n,'started-'||n,'started-'||n,'started-'||n,0,
 case when n in(3,6,7) then 'maid' else 'admin' end::public.app_role,
 case when n=4 then 'inactive' else 'active' end::public.account_status,n=5 from generate_series(1,7) n;
create function pg_temp.start_fixture(n integer,p_owner integer) returns void language plpgsql as $$
declare room uuid; at_time timestamptz:=clock_timestamp()-interval '1 minute';
 service_day date:=(at_time at time zone 'Asia/Seoul')::date;
begin
 select id into room from public.rooms order by room_number offset n limit 1;
 insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,effective_service_date,
  available_from,due_at,status,assignment_version,room_type_snapshot,fee_snapshot,template_snapshot,created_by)
 values(pg_temp.sid(1000+n),room,'additional','manual_room_request','started-fixture-'||n,service_day,service_day,
  at_time,null,'notified',2,'{}',10000,'{}',pg_temp.sid(1));
 insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,notified_at,changed_by)
 values(pg_temp.sid(2000+n),pg_temp.sid(1000+n),pg_temp.sid(p_owner),n,2,at_time,pg_temp.sid(1));
 insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,
  assignment_revision,template_snapshot,room_snapshot)
 values(pg_temp.sid(3000+n),pg_temp.sid(1000+n),pg_temp.sid(2000+n),pg_temp.sid(p_owner),1,'scheduled',2,'{}',jsonb_build_object('roomId',room));
end $$;
select pg_temp.start_fixture(1,3);
select pg_temp.start_fixture(2,6);
create function pg_temp.start_rpc(n integer,p_actor integer,p_version bigint default 1,p_key text default 'started-test-command',p_hash text default null)
returns jsonb language sql as $$
 select public.start_cleaning_attempt(pg_temp.sid(p_actor),pg_temp.sid(3000+n),p_version,pg_temp.sid(2000+n),2,
  p_key,coalesce(p_hash,repeat('a',64))) $$;
create function pg_temp.start_snapshot() returns jsonb language sql as $$
 select jsonb_build_object('targets',(select jsonb_agg(t order by id) from public.cleaning_targets t),
  'attempts',(select jsonb_agg(a order by id) from public.cleaning_attempts a),
  'assignments',(select jsonb_agg(a order by id) from public.cleaning_assignments a),
  'audit',(select jsonb_agg(e order by id) from public.audit_events e),
  'receipts',(select jsonb_agg(c order by id) from private.command_executions c),
  'notices',(select jsonb_agg(n order by id) from public.notifications n),
  'groups',(select jsonb_agg(g order by id) from private.notification_groups g),
  'outbox',(select jsonb_agg(o order by id) from private.notification_delivery_outbox o)) $$;
create temp table start_results(label text primary key,value jsonb);
select throws_ok($$select pg_temp.start_rpc(1,1)$$,'42501','MAID_REQUIRED','admin cannot act as starting maid');
select throws_ok($$select pg_temp.start_rpc(1,6)$$,'42501','ATTEMPT_ACCESS_REQUIRED','other maid cannot start');
select throws_ok($$select pg_temp.start_rpc(1,3,2)$$,'40001','ATTEMPT_VERSION_CONFLICT','stale start CAS creates no notice');
update public.profiles set must_change_password=true where id=pg_temp.sid(3);
select throws_ok($$select pg_temp.start_rpc(1,3)$$,'42501','PASSWORD_CHANGE_REQUIRED','temporary password cannot start');
update public.profiles set must_change_password=false,status='inactive' where id=pg_temp.sid(3);
select throws_ok($$select pg_temp.start_rpc(1,3)$$,'42501','MAID_REQUIRED','inactive maid cannot start');
update public.profiles set status='active' where id=pg_temp.sid(3);
select is((select count(*)::int from public.notifications where event_family='cleaning.started_admin'),0,'denied starts leave no notification');
insert into start_results values('start',pg_temp.start_rpc(1,3));
select is((select value->>'status' from start_results where label='start'),'in_progress','actual public start transitions once');
select is((select count(*)::int from public.notifications where event_family='cleaning.started_admin'),4,'all business admins receive inbox regardless of account state');
select is((select count(*)::int from private.notification_delivery_outbox where event_family='cleaning.started_admin'),2,'only active password-complete nonself recipients get push');
select ok((select bool_and(n.category='cleaning_started' and not n.requires_action and n.resolved_at is null
 and n.actor_profile_id=pg_temp.sid(3) and n.source_entity_kind='cleaning_attempt' and n.source_entity_id=pg_temp.sid(3001)::text
 and n.deep_link_kind='cleaningTarget' and n.deep_link_entity_id=pg_temp.sid(1001)
 and n.cleaning_target_id=pg_temp.sid(1001) and n.room_id=t.room_id and n.occurred_at=a.recorded_at)
 from public.notifications n join public.cleaning_targets t on t.id=n.cleaning_target_id
 join public.audit_events a on a.entity_id=pg_temp.sid(3001) and a.event_type='cleaning.attempt_started'
 where n.event_family='cleaning.started_admin'),'typed notice binds exact actor, source, room, target and audit time');
insert into start_results values('after-start',pg_temp.start_snapshot());
select is(pg_temp.start_rpc(1,3),(select value from start_results where label='start'),'same key replays exact start response');
select throws_ok($$select pg_temp.start_rpc(1,3,1,'other-key')$$,'40001','ATTEMPT_VERSION_CONFLICT','different key cannot repeat old CAS');
select throws_ok($$select pg_temp.start_rpc(1,3,2,'other-key')$$,'55000','ATTEMPT_INVALID_TRANSITION','current CAS cannot start twice');
select throws_ok($$select pg_temp.start_rpc(1,3,1,'started-test-command',repeat('b',64))$$,'23505','IDEMPOTENCY_KEY_REUSED','changed replay payload rejected');
select is(pg_temp.start_snapshot(),(select value from start_results where label='after-start'),'all replays preserve domain audit receipt group inbox and outbox');
update public.profiles set role='admin' where id=pg_temp.sid(7);
select is(pg_temp.start_rpc(1,3),(select value from start_results where label='start'),'late admin does not prevent original receipt replay');
select is((select count(*)::int from public.notifications where event_family='cleaning.started_admin' and recipient_profile_id=pg_temp.sid(7)),0,
 'late admin receives no retroactive started notice');
insert into start_results values('before-duplicate-audit',pg_temp.start_snapshot());
set local role service_role;
select throws_ok($$insert into public.audit_events(event_type,entity_type,entity_id,actor_profile_id,actor_display_name_snapshot,
 effective_at,recorded_at,after_state,idempotency_key)
 select event_type,entity_type,entity_id,actor_profile_id,actor_display_name_snapshot,
 effective_at,recorded_at,after_state,'started-copied-audit'
 from public.audit_events where entity_id='30830000-0000-4000-8000-000000003001' and event_type='cleaning.attempt_started'$$,
 '23514','NOTIFICATION_PROVENANCE_INVALID','actual service role cannot replay copied start audit to newly added admins');
reset role;
select is(pg_temp.start_snapshot(),(select value from start_results where label='before-duplicate-audit'),
 'copied audit failure preserves every ledger and creates no late-admin notice');
select ok(not private.notification_source_is_valid('cleaning.started_admin',pg_temp.sid(3),pg_temp.sid(1),pg_temp.sid(3001)::text,
 (select room_id from public.cleaning_targets where id=pg_temp.sid(1001)),pg_temp.sid(1001),pg_temp.sid(1001)),
 'known started attempt alone cannot forge source outside its audit dispatch');
select set_config('app.notification_terminal_kind','audit_event',true);
select set_config('app.notification_terminal_id',(select id::text from public.audit_events where entity_id=pg_temp.sid(3001) and event_type='cleaning.attempt_started'),true);
select ok(not private.notification_source_is_valid('cleaning.started_admin',pg_temp.sid(6),pg_temp.sid(1),pg_temp.sid(3001)::text,
 (select room_id from public.cleaning_targets where id=pg_temp.sid(1001)),pg_temp.sid(1001),pg_temp.sid(1001)),'different actor cannot borrow exact audit');
select ok(not private.notification_source_is_valid('cleaning.started_admin',pg_temp.sid(3),pg_temp.sid(6),pg_temp.sid(3001)::text,
 (select room_id from public.cleaning_targets where id=pg_temp.sid(1001)),pg_temp.sid(1001),pg_temp.sid(1001)),'maid cannot borrow admin recipient capability');
select ok(not private.notification_source_is_valid('cleaning.started_admin',pg_temp.sid(3),pg_temp.sid(1),pg_temp.sid(3001)::text,
 (select room_id from public.cleaning_targets where id=pg_temp.sid(1002)),pg_temp.sid(1002),pg_temp.sid(1002)),'cross-room target and deep link rejected');
select set_config('app.notification_terminal_kind','',true);
select set_config('app.notification_terminal_id','',true);
-- Both inbox and outbox failures roll back domain mutation, audit and receipt.
create function pg_temp.fail_started_notice() returns trigger language plpgsql as $$ begin
 if new.event_family='cleaning.started_admin' then raise exception using errcode='P0001',message='START_NOTICE_TEST_FAILURE'; end if;
 return new; end $$;
insert into start_results values('before-failure',pg_temp.start_snapshot());
create trigger fail_started_notice before insert on public.notifications for each row execute function pg_temp.fail_started_notice();
select throws_ok($$select pg_temp.start_rpc(2,6)$$,'P0001','START_NOTICE_TEST_FAILURE','inbox insertion failure aborts public start');
drop trigger fail_started_notice on public.notifications;
select is(pg_temp.start_snapshot(),(select value from start_results where label='before-failure'),'inbox failure rolls back every ledger and receipt');
create trigger fail_started_outbox before insert on private.notification_delivery_outbox for each row execute function pg_temp.fail_started_notice();
select throws_ok($$select pg_temp.start_rpc(2,6)$$,'P0001','START_NOTICE_TEST_FAILURE','outbox insertion failure aborts public start');
drop trigger fail_started_outbox on private.notification_delivery_outbox;
select is(pg_temp.start_snapshot(),(select value from start_results where label='before-failure'),'outbox failure rolls back every ledger and receipt');
select lives_ok($$select pg_temp.start_rpc(2,6)$$,'same key succeeds after complete rollback');
select is((select count(*)::int from public.audit_events where entity_id=pg_temp.sid(3002) and event_type='cleaning.attempt_started'),1,'recovery records only one start audit');
select is((select count(*)::int from public.notifications where event_family='cleaning.started_admin' and source_entity_id=pg_temp.sid(3002)::text),5,'new start includes new admin exactly once');
select is((select count(*)::int from public.notifications where event_family='cleaning.started_admin' and actor_profile_id=recipient_profile_id),0,
 'start actor is a maid and never a recipient of the admin-only family');
select is((select count(*)::int from private.notification_delivery_outbox o join public.notifications n on n.id=o.notification_id
 where n.event_family='cleaning.started_admin' and n.actor_profile_id=n.recipient_profile_id),0,'start never generates actor-self push');
-- The online start-with-lease endpoint uses the same successful start audit.
select public.complete_cleaning_attempt_field_work(pg_temp.sid(6),pg_temp.sid(3002),2,pg_temp.sid(2002),2,'finish-before-lease',repeat('b',64));
select pg_temp.start_fixture(3,6);
insert into auth.sessions(id,user_id) values(pg_temp.sid(206),pg_temp.sid(106));
insert into start_results values('with-lease',public.start_cleaning_attempt_with_lease(pg_temp.sid(6),pg_temp.sid(206),pg_temp.sid(3003),1,
 pg_temp.sid(2003),2,'started-with-lease',repeat('c',64)));
select is((select value->'attempt'->>'status' from start_results where label='with-lease'),'in_progress','actual start-with-lease follows the same online transition');
select is((select count(*)::int from public.notifications where event_family='cleaning.started_admin' and source_entity_id=pg_temp.sid(3003)::text),5,
 'start-with-lease emits one informational inbox per admin');
select is((select count(*)::int from private.notification_delivery_outbox o join public.notifications n on n.id=o.notification_id
 where n.event_family='cleaning.started_admin' and n.source_entity_id=pg_temp.sid(3003)::text),3,'start-with-lease preserves active/password push gating');
select ok((select expires_at=issued_at+interval '2 hours' from private.offline_work_leases where attempt_id=pg_temp.sid(3003)),
 'start notifications do not change the existing two-hour lease TTL');
insert into start_results values('before-lease-replay',pg_temp.start_snapshot());
select is(public.start_cleaning_attempt_with_lease(pg_temp.sid(6),pg_temp.sid(206),pg_temp.sid(3003),1,
 pg_temp.sid(2003),2,'started-with-lease',repeat('c',64))->'lease',(select value->'lease' from start_results where label='with-lease'),
 'start-with-lease replays the immutable lease');
select is(pg_temp.start_snapshot(),(select value from start_results where label='before-lease-replay'),'lease replay adds no audit, notice, group or outbox');
select ok(not has_function_privilege(role,'private.dispatch_cleaning_started_admin_notification()','execute'),role||' cannot invoke dispatcher')
 from unnest(array['anon','authenticated','service_role']) role;
set local role service_role;
select throws_ok($$select * from private.notification_event_catalog$$,'42501',null,'actual service role cannot read raw catalog');
select throws_ok($$select * from private.notification_delivery_outbox$$,'42501',null,'actual service role cannot read raw outbox');
reset role;
set local role authenticated;
select throws_ok($$select public.start_cleaning_attempt('30830000-0000-4000-8000-000000000003','30830000-0000-4000-8000-000000003001',1,
 '30830000-0000-4000-8000-000000002001',2,'raw',repeat('a',64))$$,'42501',null,'authenticated client cannot bypass server start command');
reset role;
set constraints all immediate;
select * from finish();
rollback;
