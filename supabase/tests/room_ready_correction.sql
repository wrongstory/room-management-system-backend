-- #532 isolated synthetic regression. Execution requires separate explicit DB approval.
begin;
select no_plan();
create function pg_temp.ready_id(n integer) returns uuid language sql immutable as $$
  select ('53200000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
insert into auth.users(id) values(pg_temp.ready_id(101)),(pg_temp.ready_id(102)),(pg_temp.ready_id(103));
select public.bootstrap_first_developer_profile(pg_temp.ready_id(3),pg_temp.ready_id(103),
  'ready-developer','ready-developer','0532','ready-fixture-phone-hash','ready-bootstrap');
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
  login_sequence,role,status,must_change_password)
values(pg_temp.ready_id(1),pg_temp.ready_id(101),'ready-admin','ready-admin','ready-admin','ready-admin',0,'admin','active',false),
  (pg_temp.ready_id(2),pg_temp.ready_id(102),'ready-maid','ready-maid','ready-maid','ready-maid',0,'maid','active',false);
insert into auth.sessions(id,user_id) values(pg_temp.ready_id(201),pg_temp.ready_id(101)),(pg_temp.ready_id(202),pg_temp.ready_id(102));
insert into public.rooms(id,room_number,room_type_id,elevator_zone,data_status)
select pg_temp.ready_id(10),'9532',id,'A','verified' from public.room_types where active order by code limit 1;
insert into public.cleaning_template_versions(room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,published_at,created_by)
select room_type_id,k,532,'published',case when k='checkout' then null else 30 end,'[]'::jsonb,clock_timestamp(),pg_temp.ready_id(1)
from public.rooms cross join unnest(array['additional','checkout']::public.cleaning_kind[]) k where id=pg_temp.ready_id(10);
select public.create_manual_cleaning_request(pg_temp.ready_id(1),pg_temp.ready_id(20),pg_temp.ready_id(10),null,'additional',
  (clock_timestamp() at time zone 'Asia/Seoul')::date,
  date_trunc('day',clock_timestamp() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul',
  (date_trunc('day',clock_timestamp() at time zone 'Asia/Seoul')+interval '23 hours 59 minutes') at time zone 'Asia/Seoul',
  (select state_version from public.rooms where id=pg_temp.ready_id(10)),'SYNTHETIC_READY_TEST','ready-create',repeat('1',64));
update public.cleaning_targets set assignment_version=2,status='notified' where id=pg_temp.ready_id(20);
insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,notified_at,changed_by)
values(pg_temp.ready_id(30),pg_temp.ready_id(20),pg_temp.ready_id(2),1,2,clock_timestamp(),pg_temp.ready_id(1));
select private.emit_notification_v1('assignment.commit_notified',pg_temp.ready_id(1),pg_temp.ready_id(2),
  'cleaning_assignment',pg_temp.ready_id(30)::text,'합성 배정','합성 배정 확인',pg_temp.ready_id(10),pg_temp.ready_id(20),pg_temp.ready_id(20),clock_timestamp());
insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,assignment_revision,template_snapshot,room_snapshot)
select pg_temp.ready_id(40),id,pg_temp.ready_id(30),pg_temp.ready_id(2),1,'scheduled',2,template_snapshot,
  room_type_snapshot||jsonb_build_object('roomId',room_id) from public.cleaning_targets where id=pg_temp.ready_id(20);
-- Synthetic physical history: real production fixtures are never used.
update public.cleaning_attempts set status='in_progress',execution_version=execution_version+1,started_at=clock_timestamp()
where id=pg_temp.ready_id(40);
update public.cleaning_targets set status='in_progress' where id=pg_temp.ready_id(20);
update public.cleaning_attempts set status='field_completed',execution_version=execution_version+1,
  field_completed_at=statement_timestamp(),ended_at=statement_timestamp() where id=pg_temp.ready_id(40);
create temp table ready_saved(key text primary key,value jsonb);
insert into ready_saved values('physical',(select to_jsonb(a) from public.cleaning_attempts a where id=pg_temp.ready_id(40))),
  ('earnings',jsonb_build_object('count',(select count(*) from public.earnings))),
  ('preview',public.preview_room_ready_correction(pg_temp.ready_id(1),pg_temp.ready_id(201),pg_temp.ready_id(10)));
create function pg_temp.ready_apply(p_confirm boolean default true,p_ack boolean default true,p_key text default 'ready-apply',
  p_value jsonb default null,p_hash text default repeat('a',64)) returns jsonb language plpgsql as $$
declare p jsonb:=coalesce(p_value,(select value from ready_saved where key='preview'));
begin return public.apply_room_ready_correction(pg_temp.ready_id(1),pg_temp.ready_id(201),pg_temp.ready_id(10),
  (p->>'roomStateVersion')::bigint,p->>'impactFingerprint',(p->>'evaluatedAt')::timestamptz,(p->>'expiresAt')::timestamptz,
  p_confirm,p_ack,false,'ADMIN_ROOM_READY_CORRECTION',p_key,p_hash); end $$;
select is((select value->>'canApply' from ready_saved where key='preview'),'true','unapproved field completion can be corrected');
select is((select value->>'requiresEarningAcknowledgement' from ready_saved where key='preview'),'true','physical work needs earning acknowledgement');
select throws_ok($$select pg_temp.ready_apply(false,true,'no-confirm')$$,'55000','ROOM_READY_CONFIRMATION_REQUIRED','confirmation required');
select throws_ok($$select pg_temp.ready_apply(true,false,'no-earnings')$$,'55000','ROOM_READY_EARNING_ACKNOWLEDGEMENT_REQUIRED','earning acknowledgement required');
select throws_ok($$select pg_temp.ready_apply(true,true,'forged-time',
  (select value||jsonb_build_object('evaluatedAt',clock_timestamp()-interval '1 minute','expiresAt',clock_timestamp()+interval '4 minutes')
   from ready_saved where key='preview'))$$,'40001','ROOM_READY_PREVIEW_STALE','stale preview cannot refresh its own clock');
select throws_ok($$select public.override_room_display_status(pg_temp.ready_id(1),pg_temp.ready_id(201),pg_temp.ready_id(10),'READY',
  (select state_version from public.rooms where id=pg_temp.ready_id(10)),'SYNTHETIC_READY_TEST','label-only',repeat('b',64))$$,
  '55000','ROOM_READY_CORRECTION_REQUIRED','legacy READY cannot hide live cleaning');
select lives_ok($$insert into ready_saved values('result',pg_temp.ready_apply())$$,'confirmed correction applies');
select is((select status::text from public.cleaning_targets where id=pg_temp.ready_id(20)),'cancelled','target soft cancellation');
select is((select to_jsonb(a) from public.cleaning_attempts a where id=pg_temp.ready_id(40)),
  (select value from ready_saved where key='physical'),'finished physical history preserved');
select is((select is_current from public.cleaning_assignments where id=pg_temp.ready_id(30)),false,'assignment authority ended');
select is(private.room_current_cleaning_required_at(pg_temp.ready_id(10),clock_timestamp()),false,'cleaning readiness is actually cleared');
select ok((select private.room_ready_cancelled_attempt(a) from public.cleaning_attempts a where id=pg_temp.ready_id(40)),
  'cancelled attempt no longer blocks subsequent work through exact correction evidence');
select is((select count(*)::text from public.earnings),(select value->>'count' from ready_saved where key='earnings'),'no new earning');
select is((select count(*) from public.notifications where source_entity_kind='cleaning_assignment' and source_entity_id=pg_temp.ready_id(30)::text
  and requires_action and resolved_at is null),0::bigint,'previous assignment action notice resolved');
select is(pg_temp.ready_apply(),(select value from ready_saved where key='result'),'same receipt replay');
select throws_ok($$select pg_temp.ready_apply(true,true,'ready-apply',null,repeat('c',64))$$,
  '23505','IDEMPOTENCY_KEY_REUSED','different request hash cannot replay');
select is((select count(*) from public.audit_events where event_type='room.ready_corrected' and entity_id=pg_temp.ready_id(10)),1::bigint,
  'single immutable correction evidence');
select ok(not has_function_privilege('authenticated','public.apply_room_ready_correction(uuid,uuid,uuid,bigint,text,timestamptz,timestamptz,boolean,boolean,boolean,text,text,text)','EXECUTE'),
  'authenticated cannot call privileged mutation directly');
select is(public.list_room_events(pg_temp.ready_id(1),pg_temp.ready_id(201),pg_temp.ready_id(10),30)->'items'->0->>'eventType',
  'room.ready_corrected','correction appears in room history');
select is((select array_agg(k order by k) from jsonb_object_keys(public.list_room_events(pg_temp.ready_id(1),pg_temp.ready_id(201),pg_temp.ready_id(10),30)->'items'->0->'summary') k),
  array['cancelledCleaningCount','candlesCleared','releasedOperationBlockCount','resolvedRoomIssueCount','roomStateVersion'],
  'history summary exposes only five safe keys');
select is((select count(*) from public.list_developer_audit_events(pg_temp.ready_id(3),array['room.ready_corrected'])),1::bigint,
  'developer correction event filter works');
select throws_ok($$select * from public.list_developer_audit_events(pg_temp.ready_id(1),array['room.ready_corrected'])$$,
  '42501','DEVELOPER_REQUIRED','administrator cannot use developer audit endpoint');

-- Reproduce the reported checkout obligation with no next stay, then try a new booking.
select public.create_reservation(pg_temp.ready_id(1),pg_temp.ready_id(50),pg_temp.ready_id(10),
  clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day',1,null,
  (select state_version from public.rooms where id=pg_temp.ready_id(10)),'old-stay',repeat('d',64));
update public.reservations set actual_check_in_at=check_in_at where id=pg_temp.ready_id(50);
select public.manual_checkout_reservation(pg_temp.ready_id(1),pg_temp.ready_id(50),
  (select version from public.reservations where id=pg_temp.ready_id(50)),
  'SYNTHETIC_READY_TEST',clock_timestamp(),'old-stay-checkout',repeat('d',64));
insert into ready_saved values('checkout-target',
  (select to_jsonb(current_cleaning_target_id) from public.checkout_cleaning_obligations where reservation_id=pg_temp.ready_id(50)));
update public.cleaning_targets set status='notified',assignment_version=assignment_version+1
where id=(select (value#>>'{}')::uuid from ready_saved where key='checkout-target');
insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,notified_at,changed_by)
select pg_temp.ready_id(60),id,pg_temp.ready_id(2),2,assignment_version,clock_timestamp(),pg_temp.ready_id(1)
from public.cleaning_targets where id=(select (value#>>'{}')::uuid from ready_saved where key='checkout-target');
insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,assignment_revision,template_snapshot,room_snapshot)
select pg_temp.ready_id(70),id,pg_temp.ready_id(60),pg_temp.ready_id(2),1,'scheduled',assignment_version,
  template_snapshot,room_type_snapshot||jsonb_build_object('roomId',room_id)
from public.cleaning_targets where id=(select (value#>>'{}')::uuid from ready_saved where key='checkout-target');
update public.cleaning_attempts set status='in_progress',execution_version=execution_version+1,started_at=clock_timestamp()
where id=pg_temp.ready_id(70);
update public.cleaning_targets set status='in_progress' where id=(select (value#>>'{}')::uuid from ready_saved where key='checkout-target');
update public.cleaning_attempts set status='field_completed',execution_version=execution_version+1,
  field_completed_at=statement_timestamp(),ended_at=statement_timestamp() where id=pg_temp.ready_id(70);
select is((select due_at from public.cleaning_targets where id=(select (value#>>'{}')::uuid from ready_saved where key='checkout-target')),
  null::timestamptz,'checkout has no next-reservation due time');
create function pg_temp.ready_next_booking() returns jsonb language sql as $$
  select public.create_reservation(pg_temp.ready_id(1),pg_temp.ready_id(51),pg_temp.ready_id(10),
    clock_timestamp()+interval '1 hour',clock_timestamp()+interval '2 days',1,null,
    (select state_version from public.rooms where id=pg_temp.ready_id(10)),'next-stay',repeat('e',64))
$$;
select throws_ok($$select pg_temp.ready_next_booking()$$,'23514','CLEANING_DUE_REPLAN_REQUIRED','original next-booking conflict reproduced');
update ready_saved set value=public.preview_room_ready_correction(pg_temp.ready_id(1),pg_temp.ready_id(201),pg_temp.ready_id(10)) where key='preview';
select lives_ok($$select pg_temp.ready_apply(true,true,'checkout-ready',null,repeat('f',64))$$,'automatic checkout correction applies atomically');
set constraints all immediate;
select is((select status::text from public.checkout_cleaning_obligations where reservation_id=pg_temp.ready_id(50)),
  'cancelled','automatic obligation and target cancelled together');
set constraints all deferred;
select public.create_manual_cleaning_request(pg_temp.ready_id(1),pg_temp.ready_id(80),pg_temp.ready_id(10),null,'additional',
  (clock_timestamp() at time zone 'Asia/Seoul')::date,clock_timestamp(),clock_timestamp()+interval '30 minutes',
  (select state_version from public.rooms where id=pg_temp.ready_id(10)),'SYNTHETIC_READY_TEST','next-cleaning',repeat('8',64));
update public.cleaning_targets set status='notified',assignment_version=assignment_version+1 where id=pg_temp.ready_id(80);
insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,notified_at,changed_by)
select pg_temp.ready_id(90),id,pg_temp.ready_id(2),3,assignment_version,clock_timestamp(),pg_temp.ready_id(1)
from public.cleaning_targets where id=pg_temp.ready_id(80);
select lives_ok($$select public.process_due_assignment_lifecycle(pg_temp.ready_id(1),clock_timestamp(),'after-correction-activate',repeat('9',64))$$,
  'public lifecycle scheduler runs after correction');
select ok(exists(select 1 from public.cleaning_attempts where cleaning_target_id=pg_temp.ready_id(80) and status='scheduled'),
  'next cleaning activates through the complete preserved-helper chain');
select lives_ok($$select pg_temp.ready_next_booking()$$,'new reservation succeeds after confirmed correction');
insert into public.assignment_change_requests(id,cleaning_target_id,assignment_id,maid_profile_id,reason_code,
  source_assignment_revision,source_target_assignment_version)
select pg_temp.ready_id(91),t.id,a.id,a.maid_profile_id,'PERSONAL_REASON',a.revision,t.assignment_version
from public.cleaning_targets t join public.cleaning_assignments a on a.cleaning_target_id=t.id and a.is_current
where t.id=pg_temp.ready_id(80);
update ready_saved set value=public.preview_room_ready_correction(pg_temp.ready_id(1),pg_temp.ready_id(201),pg_temp.ready_id(10)) where key='preview';
select ok((select value->'blockingReasons'?'ASSIGNMENT_CHANGE_PENDING' and not (value->>'canApply')::boolean
  from ready_saved where key='preview'),'pending assignment change requires its own existing decision procedure');
select throws_ok($$select pg_temp.ready_apply(true,true,'pending-change-blocked')$$,'55000','ROOM_READY_CORRECTION_BLOCKED',
  'correction does not silently decide a pending assignment request');
select * from finish();
rollback;
