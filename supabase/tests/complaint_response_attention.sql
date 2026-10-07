begin;
select no_plan();

-- BEGIN COMPLAINT RESPONSE ATTENTION UPGRADE FIXTURE
-- Shared with upgrade/concurrency harnesses. Only synthetic source graph setup;
-- all complaint decisions/responses/corrections use actual command RPCs.
create function pg_temp.attention_pid(n integer) returns uuid language sql stable as $$
 select coalesce(case when n=6 then (select id from public.profiles where role='developer' limit 1) end,
  ('34300000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid)
$$;
insert into auth.users(id) select pg_temp.attention_pid(100+n) from generate_series(1,9)n;
do $$begin
 if not exists(select 1 from public.profiles where role='developer') then
  perform public.bootstrap_first_developer_profile(pg_temp.attention_pid(6),pg_temp.attention_pid(106),
   'attention developer','attention developer','0100',repeat('d',64),'attention-bootstrap');
 end if;
end $$;
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,
 login_id,login_id_normalized,login_sequence,role,status,must_change_password)
select pg_temp.attention_pid(n),pg_temp.attention_pid(100+n),'attention-'||n,'attention-'||n,
 'attention-'||n,'attention-'||n,0,
 case when n in(1,3,4,5) then 'admin' else 'maid' end::public.app_role,
 case when n=4 then 'inactive' when n=7 then 'upload_only' when n=8 then 'departed'
   else 'active' end::public.account_status,n=5
from generate_series(1,9)n where n<>6;
insert into auth.sessions(id,user_id)
select pg_temp.attention_pid(900+n),pg_temp.attention_pid(100+n) from generate_series(1,9)n;
create temporary table attention_cases(n integer primary key,id uuid not null unique);
create function pg_temp.attention_get_case(n integer) returns uuid language sql as $$
 select id from pg_temp.attention_cases where attention_cases.n=$1
$$;
create function pg_temp.attention_case(n integer,corrected boolean default false,p_decide boolean default true,
 p_source_age interval default interval '2 days') returns uuid language plpgsql as $$
declare r public.rooms; at_time timestamptz:=transaction_timestamp()-p_source_age;
 target uuid:=pg_temp.attention_pid(10000+n); assignment uuid:=pg_temp.attention_pid(20000+n);
 attempt uuid:=pg_temp.attention_pid(30000+n); submission uuid:=pg_temp.attention_pid(40000+n);
 inspection uuid:=pg_temp.attention_pid(45000+n); earning uuid:=pg_temp.attention_pid(50000+n);
 result jsonb; case_id uuid;
begin
 select * into r from public.rooms order by room_number offset (n%121) limit 1;
 insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,
  effective_service_date,available_from,due_at,status,assignment_version,room_type_snapshot,
  fee_snapshot,template_snapshot,created_by)
 values(target,r.id,'additional','manual_room_request','attention-source-'||n,
  (at_time at time zone 'Asia/Seoul')::date,(at_time at time zone 'Asia/Seoul')::date,
  at_time-interval '2 hours',at_time+interval '2 hours','approved',1,
  jsonb_build_object('id',r.room_type_id),15000,'{}',pg_temp.attention_pid(1));
 insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,service_date,
  sequence_number,revision,is_current,notified_at,changed_by)
 values(assignment,target,pg_temp.attention_pid(2),(at_time at time zone 'Asia/Seoul')::date,
  n+1,1,true,at_time-interval '2 hours',pg_temp.attention_pid(1));
 insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,
  status,assignment_revision,started_at,field_completed_at,ended_at,template_snapshot,room_snapshot)
 values(attempt,target,assignment,pg_temp.attention_pid(2),1,'approved',1,
  at_time-interval '90 minutes',at_time-interval '30 minutes',at_time-interval '20 minutes',
  '{}',jsonb_build_object('roomId',r.id));
 insert into public.cleaning_submissions(id,cleaning_attempt_id,client_submission_id,version,status,
  photo_manifest,submitted_by,submitted_at)
 values(submission,attempt,pg_temp.attention_pid(60000+n),1,'approved','{}',pg_temp.attention_pid(2),at_time-interval '10 minutes');
 insert into public.inspection_decisions(id,submission_id,decision,reason_code,decided_by,decided_at)
 values(inspection,submission,'approved','QUALITY_OK',pg_temp.attention_pid(1),at_time);
 insert into public.earnings(id,earning_entitlement_id,submission_id,maid_profile_id,earned_on,base_amount,bomb_room_bonus)
 values(earning,submission,submission,pg_temp.attention_pid(2),(at_time at time zone 'Asia/Seoul')::date,15000,0);
 result:=public.create_complaint_case(pg_temp.attention_pid(1),earning,'cleanliness_general',0,
  'attention-create-'||n,repeat('a',64));
 case_id:=(result->>'id')::uuid;
 insert into pg_temp.attention_cases values(n,case_id);
 if not p_decide then return case_id; end if;
 perform public.start_complaint_review(pg_temp.attention_pid(1),case_id,1,'attention-review-'||n,repeat('b',64));
 perform public.decide_complaint_case(pg_temp.attention_pid(1),case_id,2,'confirmed',0,false,
  'attention-decide-'||n,repeat('c',64));
 if corrected then
  perform public.correct_complaint_decision(pg_temp.attention_pid(1),case_id,3,'false',0,false,
   'attention-correct-'||n,repeat('d',64));
 end if;
 return case_id;
end $$;
select pg_temp.attention_case(1);
select pg_temp.attention_case(2,true);
select pg_temp.attention_case(3);
select pg_temp.attention_case(4);
select pg_temp.attention_case(5);
select pg_temp.attention_case(6,false,false);
-- A pre-existing decided projection with a missing deadline is representable
-- under the old nullable CHECK. Preserve it; never infer a replacement deadline.
-- Construct its immutable decision/event by INSERT only, without disabling or
-- rewriting any guard. Normal fixtures above exercise the actual decide RPC.
select pg_temp.attention_case(11,false,false);
select public.start_complaint_review(pg_temp.attention_pid(1),pg_temp.attention_get_case(11),1,
 'attention-null-legacy-review',repeat('b',64));
insert into public.complaint_decisions(id,complaint_case_id,decision_version,decision_kind,
 finding,penalty_score,rework_required,decided_by,decided_at)
values(pg_temp.attention_pid(71011),pg_temp.attention_get_case(11),1,'initial','confirmed',0,false,
 pg_temp.attention_pid(1),transaction_timestamp());
update public.complaint_cases set status='decided',version=3,current_decision_id=pg_temp.attention_pid(71011),
 first_decided_at=transaction_timestamp(),response_deadline=null,updated_at=transaction_timestamp()
where id=pg_temp.attention_get_case(11);
insert into public.complaint_case_events(complaint_case_id,event_type,from_status,to_status,case_version,
 actor_profile_id,decision_id,occurred_at)
values(pg_temp.attention_get_case(11),'decided','under_review','decided',3,
 pg_temp.attention_pid(1),pg_temp.attention_pid(71011),transaction_timestamp());
select public.respond_to_complaint(pg_temp.attention_pid(2),pg_temp.attention_get_case(3),3,
 'acknowledged',null,'attention-response-3',repeat('e',64));
select public.respond_to_complaint(pg_temp.attention_pid(2),pg_temp.attention_get_case(4),3,
 'acknowledged',null,'attention-response-4',repeat('e',64));
select public.close_complaint_case(pg_temp.attention_pid(1),pg_temp.attention_get_case(4),4,
 'attention-close-4',repeat('f',64));
select public.respond_to_complaint(pg_temp.attention_pid(2),pg_temp.attention_get_case(5),3,
 'appealed','evidence_misinterpreted','attention-response-5',repeat('e',64));
select public.correct_complaint_decision(pg_temp.attention_pid(1),pg_temp.attention_get_case(5),4,
 'unverifiable',0,false,'attention-correct-5',repeat('d',64));
-- END COMPLAINT RESPONSE ATTENTION UPGRADE FIXTURE

select is((select count(*) from private.complaint_response_attention_events),0::bigint,'no eager historical backfill');
select is((select count(*) from private.notification_event_catalog),60::bigint,'attention and subsequent post-approval typed families are additive');
select is((select count(distinct category) from private.notification_event_catalog),42::bigint,'one additive public category');
select is(private.detect_complaint_response_attention_at(pg_temp.attention_pid(1),transaction_timestamp()+interval '7 days'),0,
 'strict deadline equality is not overdue');
create temporary table attention_receipts(label text primary key,value jsonb);
insert into attention_receipts values('first',public.process_due_assignment_lifecycle(pg_temp.attention_pid(1),
 transaction_timestamp()+interval '7 days 1 second','attention-scheduler-first',repeat('a',64)));
select is((select (value->>'complaintAttentionCount')::integer from attention_receipts where label='first'),2,
 'actual scheduler command detects initial and corrected unanswered cases only');
set constraints all immediate;
set constraints all deferred;
select is((select count(*) from private.complaint_response_attention_events),2::bigint,'one immutable event per case');
select is((select response_deadline from public.complaint_cases where id=pg_temp.attention_get_case(6)),null::timestamptz,
 'undecided history keeps null deadline; no guessed deadline backfill');
select is((select response_deadline from public.complaint_cases where id=pg_temp.attention_get_case(11)),null::timestamptz,
 'decided legacy history keeps missing deadline without guessed backfill');
select ok(not private.complaint_response_attention_is_due(
 (select jsonb_populate_record(null::public.complaint_cases,to_jsonb(c)||jsonb_build_object('current_decision_id',
  (select current_decision_id from public.complaint_cases where id=pg_temp.attention_get_case(2))))
  from public.complaint_cases c where c.id=pg_temp.attention_get_case(1)),transaction_timestamp()+interval '8 days'),
 'foreign current decision fails typed case ownership without rewriting source');
select is((select count(*) from private.complaint_response_attention_recipients),4::bigint,'only two active password-complete admins');
select is((select count(*) from public.notifications where event_family='complaint.response_attention_admin'),4::bigint,'each enrollment has one inbox row');
select is((select count(*) from private.notification_delivery_outbox where event_family='complaint.response_attention_admin'),2::bigint,
 'other admin push only; scheduler actor self push excluded');
select ok(not exists(select 1 from public.notifications where event_family='complaint.response_attention_admin'
 and (requires_action or deep_link_kind<>'complaintCase' or category<>'complaint_response_attention'
 or title<>'컴플레인 응답 지연 확인' or body<>'최초 판정에 대한 메이드 응답이 아직 없습니다. 사건 현황을 확인해 주세요.')),
 'bounded safe informational content and case deep link');
select ok(exists(select 1 from private.complaint_response_attention_events e
 join public.complaint_decisions i on i.id=e.initial_decision_id
 join public.complaint_decisions c on c.id=e.current_decision_id
 where e.complaint_case_id=pg_temp.attention_get_case(2) and i.decision_version=1 and c.decision_version=2
 and e.case_version=4 and e.response_deadline=e.first_decided_at+interval '7 days'),
 'pre-response correction preserves original threshold and both typed decisions');
select is(public.process_due_assignment_lifecycle(pg_temp.attention_pid(1),transaction_timestamp()+interval '9 days',
 'attention-scheduler-first',repeat('a',64)),(select value from attention_receipts where label='first'),
 'same key replays exact count and response despite later observation time');
select throws_ok($$select public.process_due_assignment_lifecycle(pg_temp.attention_pid(1),transaction_timestamp(),
 'attention-scheduler-first',repeat('b',64))$$,'23505','IDEMPOTENCY_KEY_REUSED','different hash rejected');
select is(private.detect_complaint_response_attention_at(pg_temp.attention_pid(3),transaction_timestamp()+interval '9 days'),0,
 'new actor and grouping window do not create another event');
select is((select count(*) from public.notifications where event_family='complaint.response_attention_admin'),4::bigint,
 'already enrolled recipients never re-enter emitter');

-- Snapshot provenance remains valid after current decision/response/terminal drift.
create temporary table attention_frozen as select to_jsonb(e) snapshot from private.complaint_response_attention_events e;
select public.correct_complaint_decision(pg_temp.attention_pid(1),pg_temp.attention_get_case(1),3,
 'false',0,false,'attention-after-detection-correction',repeat('d',64));
select throws_ok($$select public.close_complaint_case(pg_temp.attention_pid(1),pg_temp.attention_get_case(1),4,
 'attention-close-unanswered',repeat('c',64))$$,'55000','COMPLAINT_RESPONSE_REQUIRED','attention never permits no-response closure');
select public.respond_to_complaint(pg_temp.attention_pid(2),pg_temp.attention_get_case(1),4,
 'acknowledged',null,'attention-after-detection-response',repeat('e',64));
select public.close_complaint_case(pg_temp.attention_pid(1),pg_temp.attention_get_case(1),5,
 'attention-after-detection-close',repeat('f',64));
select public.correct_complaint_decision(pg_temp.attention_pid(1),pg_temp.attention_get_case(1),6,
 'confirmed',0,false,'attention-after-close-correction',repeat('d',64));
select is((select d.decision_version from public.complaint_maid_responses r
 join public.complaint_decisions d on d.id=r.decision_id where r.complaint_case_id=pg_temp.attention_get_case(1)),1,
 'response still belongs to initial decision after correction');
select throws_ok($$select public.respond_to_complaint(pg_temp.attention_pid(2),pg_temp.attention_get_case(1),7,
 'acknowledged',null,'attention-response-again',repeat('e',64))$$,'55000','COMPLAINT_INVALID_TRANSITION','closed cannot respond or reopen');
select ok(not exists(select 1 from private.complaint_response_attention_events e
 where not exists(select 1 from attention_frozen f where f.snapshot=to_jsonb(e))), 'all detection snapshots unchanged');
select ok(not exists(select 1 from public.notifications n where n.event_family='complaint.response_attention_admin'
 and not private.notification_source_is_valid(n.event_family,n.actor_profile_id,n.recipient_profile_id,n.source_entity_id,
 n.room_id,n.cleaning_target_id,n.deep_link_entity_id)), 'history provenance remains valid after close and correction');

insert into auth.users(id) values(pg_temp.attention_pid(110));
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
 login_sequence,role,status,must_change_password)
values(pg_temp.attention_pid(10),pg_temp.attention_pid(110),'attention-10','attention-10','attention-10','attention-10',0,'admin','active',false);
select is(private.detect_complaint_response_attention_at(pg_temp.attention_pid(1),transaction_timestamp()+interval '10 days'),0,
 'late admin enrollment does not create another logical event');
set constraints all immediate;
set constraints all deferred;
select is((select count(*) from private.complaint_response_attention_recipients
 where recipient_profile_id=pg_temp.attention_pid(10)),1::bigint,'new admin enrolls only still-unanswered case, never closed history');
select is((select count(*) from private.complaint_response_attention_events),2::bigint,'late enrollment preserves event count');
select ok(exists(select 1 from private.complaint_response_attention_recipients r
 join private.complaint_response_attention_events e on e.id=r.event_id
 join public.notifications n on n.source_entity_id=e.id::text and n.recipient_profile_id=r.recipient_profile_id
   and n.event_family='complaint.response_attention_admin'
 join private.notification_delivery_outbox o on o.notification_id=n.id
 where r.recipient_profile_id=pg_temp.attention_pid(10) and r.enrolled_at-e.occurred_at>interval '24 hours'
 and o.enqueued_at=r.enrolled_at and n.occurred_at=e.occurred_at),
 'late recipient clock is fresh while original notice occurrence remains frozen');

select ok(not private.notification_source_is_valid('complaint.response_attention_admin',pg_temp.attention_pid(1),
 pg_temp.attention_pid(3),'not-a-uuid',null,null,null),'malformed UUID source returns false');
select ok(not private.notification_source_is_valid('complaint.response_attention_admin',pg_temp.attention_pid(1),
 pg_temp.attention_pid(3),'123',null,null,null),'old bigint-looking source cannot forge UUID attention');
select ok(not private.notification_source_is_valid('complaint.response_attention_admin',pg_temp.attention_pid(9),
 pg_temp.attention_pid(3),(select id::text from private.complaint_response_attention_events limit 1),
 (select room_id from private.complaint_response_attention_events limit 1),
 (select cleaning_target_id from private.complaint_response_attention_events limit 1),
 (select complaint_case_id from private.complaint_response_attention_events limit 1)), 'actor binding cannot be forged');
select throws_ok($$update private.complaint_response_attention_events set case_version=case_version+1$$,
 '55000','NOTIFICATION_CATALOG_LEDGER_IMMUTABLE','immutable attention event cannot be changed');
select throws_ok($$delete from private.complaint_response_attention_recipients$$,
 '55000','NOTIFICATION_CATALOG_LEDGER_IMMUTABLE','immutable enrollment cannot be removed');

-- Real public scheduler authorization and direct private ACL boundaries.
select throws_ok($$select public.process_due_assignment_lifecycle(pg_temp.attention_pid(4),transaction_timestamp(),
 'attention-inactive-admin',repeat('a',64))$$,'42501','ACTIVE_ACCOUNT_REQUIRED','inactive scheduler actor denied');
select throws_ok($$select private.detect_complaint_response_attention_at(pg_temp.attention_pid(5),transaction_timestamp())$$,
 '42501','ADMIN_REQUIRED','temporary password actor denied');
select throws_ok($$select private.detect_complaint_response_attention_at(pg_temp.attention_pid(6),transaction_timestamp())$$,
 '42501','ADMIN_REQUIRED','developer is not business admin');
select throws_ok($$select private.detect_complaint_response_attention_at(pg_temp.attention_pid(7),transaction_timestamp())$$,
 '42501','ADMIN_REQUIRED','upload-only cannot detect');
select throws_ok($$select private.detect_complaint_response_attention_at(pg_temp.attention_pid(1),'infinity')$$,
 '22023','ASSIGNMENT_ACTIVATION_TIME_REQUIRED','infinite scan time denied');
select ok(not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='private' and c.relname in('complaint_response_attention_events','complaint_response_attention_recipients',
 'complaint_response_attention_scan_cursor') and (not c.relrowsecurity or not c.relforcerowsecurity)), 'all new private tables FORCE RLS');
select ok(not has_table_privilege('service_role','private.complaint_response_attention_events','SELECT')
 and not has_table_privilege('authenticated','private.complaint_response_attention_events','INSERT')
 and not has_function_privilege('service_role','private.detect_complaint_response_attention_at(uuid,timestamptz)','EXECUTE')
 and not has_function_privilege('anon','private.notification_source_is_valid(text,uuid,uuid,text,uuid,uuid,uuid)','EXECUTE'),
 'direct runtime table and helper ACL denied');
set local role anon;
select throws_ok($$select * from private.complaint_response_attention_events$$,'42501',null,'anon raw private evidence denied');
select throws_ok($$select public.process_due_assignment_lifecycle('34300000-0000-4000-8000-000000000001',now(),
 'attention-anon-rpc',repeat('a',64))$$,'42501',null,'anon public scheduler RPC denied');
reset role;
set local role authenticated;
select throws_ok($$select * from private.complaint_response_attention_recipients$$,'42501',null,'authenticated raw recipient evidence denied');
select throws_ok($$select * from public.notifications$$,'42501',null,'authenticated raw inbox internals denied');
reset role;
set local role service_role;
select throws_ok($$select * from private.complaint_response_attention_scan_cursor$$,'42501',null,'service role raw cursor denied');
select throws_ok($$select private.detect_complaint_response_attention_at('34300000-0000-4000-8000-000000000001',now())$$,
 '42501',null,'service role cannot call private detector');
select lives_ok($$select public.process_due_assignment_lifecycle('34300000-0000-4000-8000-000000000001',
 now()+interval '10 days','attention-service-role-rpc',repeat('a',64))$$,'service role can call actor-validated public lifecycle');
select ok(not ((public.list_notifications_page('34300000-0000-4000-8000-000000000001',
 '34300000-0000-4000-8000-000000000901',null,null,100)->'notifications')::text
 ~ 'sourceEntity|eventFamily|dedupeKey|actorProfileId|34300000-0000-4000-8000-000000071011'),
 'actual public projection hides source evidence and internal routing');
select throws_ok($$select public.list_notifications_page('34300000-0000-4000-8000-000000000001',
 '34300000-0000-4000-8000-000000000902',null,null,100)$$,'42501','NOTIFICATION_ACCESS_REQUIRED','cross-user session denied');
reset role;
-- Temporary grant in this rolled-back transaction exercises defense-in-depth RLS.
grant select on public.notifications to authenticated;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"34300000-0000-4000-8000-000000000101","role":"authenticated","session_id":"34300000-0000-4000-8000-000000000901"}',true);
select is((select count(*) from public.notifications where event_family='complaint.response_attention_admin'),2::bigint,
 'live authenticated admin RLS sees only own attention inbox');
select set_config('request.jwt.claims','{"sub":"34300000-0000-4000-8000-000000000102","role":"authenticated","session_id":"34300000-0000-4000-8000-000000000902"}',true);
select is((select count(*) from public.notifications where event_family='complaint.response_attention_admin'),0::bigint,
 'maid cannot see admin attention inbox under actual RLS');
reset role;
delete from auth.sessions where id=pg_temp.attention_pid(901);
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"34300000-0000-4000-8000-000000000101","role":"authenticated","session_id":"34300000-0000-4000-8000-000000000901"}',true);
select is((select count(*) from public.notifications),0::bigint,'deleted live session makes authenticated inbox empty');
reset role;
revoke select on public.notifications from authenticated;

-- Failed external-side-effect preparation must roll back source, cursor, notice,
-- outbox and receipt together. Failure injection is synthetic and test-local.
select pg_temp.attention_case(7);
create function pg_temp.attention_fail_outbox() returns trigger language plpgsql as $$
begin
 if new.event_family='complaint.response_attention_admin' then
  raise exception using errcode='23514',message='ATTENTION_TEST_OUTBOX_FAILURE'; end if;
 return new;
end $$;
create trigger attention_test_outbox_failure before insert on private.notification_delivery_outbox
 for each row execute function pg_temp.attention_fail_outbox();
create temporary table attention_before_failure as select
 (select count(*) from private.complaint_response_attention_events) events,
 (select count(*) from private.complaint_response_attention_recipients) recipients,
 (select count(*) from public.notifications) notices,
 (select count(*) from private.notification_delivery_outbox) outboxes,
 (select last_case_id from private.complaint_response_attention_scan_cursor) cursor_id;
select throws_ok($$select public.process_due_assignment_lifecycle(pg_temp.attention_pid(1),
 transaction_timestamp()+interval '11 days','attention-atomic-failure',repeat('f',64))$$,
 '23514','ATTENTION_TEST_OUTBOX_FAILURE','outbox failure aborts scheduler transaction');
select ok((select events=(select count(*) from private.complaint_response_attention_events)
 and recipients=(select count(*) from private.complaint_response_attention_recipients)
 and notices=(select count(*) from public.notifications) and outboxes=(select count(*) from private.notification_delivery_outbox)
 and cursor_id is not distinct from (select last_case_id from private.complaint_response_attention_scan_cursor)
 from attention_before_failure), 'all attention and cursor writes rolled back');
select is((select count(*) from private.command_executions where idempotency_key='attention-atomic-failure'),0::bigint,'failed receipt not committed');
drop trigger attention_test_outbox_failure on private.notification_delivery_outbox;
select lives_ok($$select public.process_due_assignment_lifecycle(pg_temp.attention_pid(1),
 transaction_timestamp()+interval '11 days','attention-atomic-failure',repeat('f',64))$$,'same command succeeds after failure removed');
set constraints all immediate;
set constraints all deferred;

-- Actual delivery worker regression, using valid older synthetic approval and
-- INSERT-only historical decisions rather than rewriting immutable time fields.
select pg_temp.attention_case(12,false,false,interval '20 days');
insert into public.complaint_cases(id,room_id,cleaning_target_id,cleaning_attempt_id,submission_id,
 inspection_decision_id,original_earning_id,maid_profile_id,category,status,version,received_by,received_at,updated_at)
select pg_temp.attention_pid(70013),room_id,cleaning_target_id,cleaning_attempt_id,submission_id,
 inspection_decision_id,original_earning_id,maid_profile_id,category,'under_review',2,received_by,
 transaction_timestamp()-interval '11 days',transaction_timestamp()-interval '10 days 1 hour'
from public.complaint_cases where id=pg_temp.attention_get_case(12);
insert into public.complaint_decisions(id,complaint_case_id,decision_version,decision_kind,finding,
 penalty_score,rework_required,decided_by,decided_at)
values(pg_temp.attention_pid(71013),pg_temp.attention_pid(70013),1,'initial','confirmed',0,false,
 pg_temp.attention_pid(1),transaction_timestamp()-interval '10 days');
update public.complaint_cases set status='decided',version=3,current_decision_id=pg_temp.attention_pid(71013),
 first_decided_at=transaction_timestamp()-interval '10 days',response_deadline=transaction_timestamp()-interval '3 days',
 updated_at=transaction_timestamp()-interval '10 days' where id=pg_temp.attention_pid(70013);
insert into public.complaint_case_events(complaint_case_id,event_type,from_status,to_status,case_version,
 actor_profile_id,decision_id,occurred_at)
values(pg_temp.attention_pid(70013),'received',null,'received',1,pg_temp.attention_pid(1),null,transaction_timestamp()-interval '11 days'),
 (pg_temp.attention_pid(70013),'review_started','received','under_review',2,pg_temp.attention_pid(1),null,transaction_timestamp()-interval '10 days 1 hour'),
 (pg_temp.attention_pid(70013),'decided','under_review','decided',3,pg_temp.attention_pid(1),pg_temp.attention_pid(71013),transaction_timestamp()-interval '10 days');
select is(private.detect_complaint_response_attention_at(pg_temp.attention_pid(1),transaction_timestamp()-interval '2 days'),1,
 'stored historical deadline produces one real older attention event');
set constraints all immediate;
set constraints all deferred;
insert into auth.users(id) values(pg_temp.attention_pid(114));
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
 login_sequence,role,status,must_change_password)
values(pg_temp.attention_pid(14),pg_temp.attention_pid(114),'attention-14','attention-14','attention-14','attention-14',0,'admin','active',false);
select is((public.process_due_assignment_lifecycle(pg_temp.attention_pid(1),transaction_timestamp(),
 'attention-late-delivery-worker',repeat('d',64))->>'complaintAttentionCount')::integer,0,
 'late admin registration adds delivery without new logical event');
set constraints all immediate;
set constraints all deferred;
create temporary table attention_late_delivery as select o.id
from private.notification_delivery_outbox o join public.notifications n on n.id=o.notification_id
where n.event_family='complaint.response_attention_admin' and n.recipient_profile_id=pg_temp.attention_pid(14)
 and n.deep_link_entity_id=pg_temp.attention_pid(70013);
select is((select count(*) from attention_late_delivery),1::bigint,'late admin has one exact push outbox');
select ok(exists(select 1 from attention_late_delivery late join private.notification_delivery_outbox o on o.id=late.id
 join public.notifications n on n.id=o.notification_id
 where n.occurred_at<clock_timestamp()-interval '24 hours' and o.enqueued_at+interval '24 hours'>clock_timestamp()),
 'late-admin notice is older than TTL but its own delivery clock is fresh');
create function pg_temp.attention_process_late_delivery() returns void language plpgsql as $$
begin
 for i in 1..20 loop
  perform public.claim_notification_deliveries(repeat('9',64),10);
  exit when exists(select 1 from private.notification_delivery_jobs j join pg_temp.attention_late_delivery late
    on late.id=j.outbox_id where j.status<>'pending');
 end loop;
end $$;
select lives_ok($$select pg_temp.attention_process_late_delivery()$$,'actual bounded delivery worker processes late admin');
select is((select j.terminal_reason from private.notification_delivery_jobs j
 join attention_late_delivery late on late.id=j.outbox_id),'NO_ACTIVE_SUBSCRIPTION',
 'late recipient is not stale: worker reaches current subscription eligibility');
select lives_ok($$select public.respond_to_complaint(pg_temp.attention_pid(2),pg_temp.attention_pid(70013),3,
 'acknowledged',null,'attention-real-past-deadline-response',repeat('e',64))$$,
 'actual maid response remains authorized after the real stored deadline');
select lives_ok($$select public.close_complaint_case(pg_temp.attention_pid(1),pg_temp.attention_pid(70013),4,
 'attention-real-past-deadline-close',repeat('f',64))$$,'responded old case closes only by explicit admin command');
select ok(not exists(select 1 from public.notifications n where n.event_family='complaint.response_attention_admin'
 and n.deep_link_entity_id=pg_temp.attention_pid(70013)
 and not private.notification_source_is_valid(n.event_family,n.actor_profile_id,n.recipient_profile_id,
 n.source_entity_id,n.room_id,n.cleaning_target_id,n.deep_link_entity_id)),
 'actual overdue response and closure preserve historical attention provenance');

-- Typed insertion guards reject mismatched source relationships, not just UUIDs.
select pg_temp.attention_case(8);
create function pg_temp.attention_try_event(p_case uuid,p_version_delta integer,p_initial uuid default null,
 p_atomic boolean default false) returns void language plpgsql as $$
begin
 insert into private.complaint_response_attention_events(complaint_case_id,initial_decision_id,current_decision_id,
 case_version,room_id,cleaning_target_id,first_decided_at,response_deadline,actor_profile_id,occurred_at)
 select c.id,coalesce(p_initial,d.id),c.current_decision_id,c.version+p_version_delta,c.room_id,c.cleaning_target_id,
 c.first_decided_at,c.response_deadline,pg_temp.attention_pid(1),transaction_timestamp()+interval '11 days'
 from public.complaint_cases c join public.complaint_decisions d on d.complaint_case_id=c.id and d.decision_version=1
 where c.id=p_case;
 if p_atomic then set constraints all immediate; end if;
end $$;
select throws_ok($$select pg_temp.attention_try_event(pg_temp.attention_get_case(8),1)$$,
 '23514','COMPLAINT_ATTENTION_EVIDENCE_INVALID','forged case version rejected');
select throws_ok($$select pg_temp.attention_try_event(pg_temp.attention_get_case(8),0,
 (select initial_decision_id from private.complaint_response_attention_events limit 1))$$,
 '23514','COMPLAINT_ATTENTION_EVIDENCE_INVALID','other case initial decision rejected');
select throws_ok($$select pg_temp.attention_try_event(pg_temp.attention_get_case(8),0,null,true)$$,
 '23514','COMPLAINT_ATTENTION_DELIVERY_NOT_ATOMIC','orphan event cannot commit without exact enrollment and notice');
select is((select count(*) from private.complaint_response_attention_events where complaint_case_id=pg_temp.attention_get_case(8)),
 0::bigint,'invalid and orphan attempts leave no source evidence');
select lives_ok($$select private.detect_complaint_response_attention_at(pg_temp.attention_pid(1),
 transaction_timestamp()+interval '11 days')$$,'normal detector creates complete typed evidence after failures');
set constraints all immediate;
set constraints all deferred;

-- Fair bounded scan: an already notified oldest case cannot starve others.
select pg_temp.attention_case(n) from generate_series(20,124)n;
create temporary table attention_fair_before as select count(*) events from private.complaint_response_attention_events;
select ok(private.detect_complaint_response_attention_at(pg_temp.attention_pid(1),transaction_timestamp()+interval '12 days')<=100,
 'first scan is bounded to 100 candidates');
select ok(private.detect_complaint_response_attention_at(pg_temp.attention_pid(1),transaction_timestamp()+interval '12 days')<=100,
 'second scan is bounded to 100 candidates');
set constraints all immediate;
select is((select count(*) from private.complaint_response_attention_events)-(select events from attention_fair_before),105::bigint,
 'two rotating scans reach all 105 new cases despite existing unresolved history');
select ok(not exists(select 1 from private.complaint_response_attention_events e join public.complaint_cases c
 on c.id=e.complaint_case_id where e.complaint_case_id in(pg_temp.attention_get_case(3),pg_temp.attention_get_case(4),pg_temp.attention_get_case(5))),
 'responded, appealed, corrected-after-response and terminal cases never receive new warnings');
select * from finish();
rollback;
