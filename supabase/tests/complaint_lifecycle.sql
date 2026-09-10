begin;
select no_plan();

create function pg_temp.pid(n integer) returns uuid language sql immutable as $$
  select ('10000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;

insert into auth.users(id) select pg_temp.pid(100+n) from generate_series(1,9)n;
select public.bootstrap_first_developer_profile(
  pg_temp.pid(6),pg_temp.pid(106),'complaint developer','complaint developer','0100',
  repeat('d',64),'complaint-developer-bootstrap'
);
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,
  login_id,login_id_normalized,login_sequence,role,status,must_change_password)
select pg_temp.pid(n),pg_temp.pid(100+n),'complaint-'||n,'complaint-'||n,
  'complaint-'||n,'complaint-'||n,0,
  case when n in (1,4,8,9) then 'admin' else 'maid' end::public.app_role,
  case when n=4 then 'inactive' when n=5 then 'upload_only' when n=7 then 'departed' else 'active' end::public.account_status,
  n=8
from generate_series(1,5)n
union all select pg_temp.pid(7),pg_temp.pid(107),'complaint-7','complaint-7','complaint-7','complaint-7',0,
  'maid'::public.app_role,'departed'::public.account_status,false
union all select pg_temp.pid(8),pg_temp.pid(108),'complaint-8','complaint-8','complaint-8','complaint-8',0,
  'admin'::public.app_role,'active'::public.account_status,true
union all select pg_temp.pid(9),pg_temp.pid(109),'complaint-9','complaint-9','complaint-9','complaint-9',0,
  'admin'::public.app_role,'active'::public.account_status,false;

insert into auth.sessions(id,user_id)
select pg_temp.pid(900+n),pg_temp.pid(100+n) from generate_series(1,9)n;

create function pg_temp.approved_source(
  n integer,p_maid integer default 2,p_age interval default interval '1 day',
  p_submission_status public.submission_status default 'approved',p_inspection text default 'approved',
  p_target_source text default 'manual_room_request'
) returns uuid language plpgsql as $$
declare v_room public.rooms; v_target uuid:=pg_temp.pid(1000+n); v_assignment uuid:=pg_temp.pid(2000+n);
  v_attempt uuid:=pg_temp.pid(3000+n); v_submission uuid:=pg_temp.pid(4000+n);
  v_inspection uuid:=pg_temp.pid(4500+n); v_earning uuid:=pg_temp.pid(5000+n);
  v_at timestamptz:=transaction_timestamp()-p_age;
begin
  select * into v_room from public.rooms order by room_number offset n limit 1;
  insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,
    effective_service_date,available_from,due_at,status,assignment_version,room_type_snapshot,
    fee_snapshot,template_snapshot,created_by)
  values(v_target,v_room.id,
    (case when p_target_source in ('inspection_reclean','post_approval_complaint_reclean')
      then 'reclean' else 'additional' end)::public.cleaning_kind,
    p_target_source,'complaint-source-'||n,
    (v_at at time zone 'Asia/Seoul')::date,(v_at at time zone 'Asia/Seoul')::date,
    v_at-interval '2 hours',v_at+interval '2 hours',
    (case when p_submission_status='approved' and p_inspection='approved' then 'approved' else 'rejected' end)::public.cleaning_target_status,
    1,jsonb_build_object('id',v_room.room_type_id),15000,'{}'::jsonb,pg_temp.pid(1));
  insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,service_date,
    sequence_number,revision,is_current,notified_at,changed_by)
  values(v_assignment,v_target,pg_temp.pid(p_maid),(v_at at time zone 'Asia/Seoul')::date,n+1,1,true,v_at-interval '2 hours',pg_temp.pid(1));
  insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,
    status,assignment_revision,started_at,field_completed_at,ended_at,template_snapshot,room_snapshot)
  values(v_attempt,v_target,v_assignment,pg_temp.pid(p_maid),1,
    (case when p_submission_status='approved' and p_inspection='approved' then 'approved' else 'rejected' end)::public.attempt_status,
    1,v_at-interval '90 minutes',v_at-interval '30 minutes',v_at-interval '20 minutes',
    '{}'::jsonb,jsonb_build_object('roomId',v_room.id));
  insert into public.cleaning_submissions(id,cleaning_attempt_id,client_submission_id,version,status,
    photo_manifest,submitted_by,submitted_at)
  values(v_submission,v_attempt,pg_temp.pid(6000+n),1,p_submission_status,'{}',pg_temp.pid(p_maid),v_at-interval '10 minutes');
  insert into public.inspection_decisions(id,submission_id,decision,reason_code,decided_by,decided_at)
  values(v_inspection,v_submission,p_inspection,'QUALITY_OK',pg_temp.pid(1),v_at);
  insert into public.earnings(id,earning_entitlement_id,submission_id,maid_profile_id,earned_on,base_amount,bomb_room_bonus)
  values(v_earning,v_submission,v_submission,pg_temp.pid(p_maid),(v_at at time zone 'Asia/Seoul')::date,15000,0);
  return v_earning;
end $$;

select pg_temp.approved_source(1,2,interval '30 days');
select pg_temp.approved_source(2,2,interval '30 days 1 second');
select pg_temp.approved_source(3,2,interval '1 day','rejected','rejected');
select pg_temp.approved_source(5,2,interval '1 day');
select pg_temp.approved_source(6,2,interval '1 day');
select pg_temp.approved_source(7,2,interval '1 day');
select pg_temp.approved_source(8,2,interval '1 day');

create temporary table complaint_results(label text primary key,value jsonb);
insert into complaint_results values('boundary',public.create_complaint_case(
  pg_temp.pid(1),pg_temp.pid(5001),'cleanliness_general',0,'complaint-create-boundary',repeat('a',64)));
select is((select value->>'status' from complaint_results where label='boundary'),'received',
  'approval plus exactly 30 days remains inside the inclusive intake window');
select throws_ok($$select public.create_complaint_case(pg_temp.pid(1),pg_temp.pid(5002),
  'cleanliness_general',0,'complaint-create-over',repeat('b',64))$$,
  '22023','COMPLAINT_INTAKE_WINDOW_CLOSED','approval plus more than 30 days is rejected');
select throws_ok($$select public.create_complaint_case(pg_temp.pid(1),pg_temp.pid(5003),
  'cleanliness_general',0,'complaint-create-rejected',repeat('c',64))$$,
  '55000','COMPLAINT_SOURCE_NOT_APPROVED','rejected provenance is not complaint intake provenance');
select throws_ok($$select public.create_complaint_case(pg_temp.pid(1),pg_temp.pid(5005),
  'free-form customer text',0,'complaint-create-free-text',repeat('d',64))$$,
  '22023','INVALID_COMPLAINT_CATEGORY','category is source controlled');
select throws_ok($$select public.create_complaint_case(pg_temp.pid(1),pg_temp.pid(5005),
  'cleanliness_general',null,'complaint-create-null-cas',repeat('d',64))$$,
  '40001','STALE_VERSION','null create CAS fails closed');

insert into complaint_results values('main',public.create_complaint_case(
  pg_temp.pid(1),pg_temp.pid(5005),'bathroom_cleanliness',0,'complaint-create-main',repeat('e',64)));
select is(public.create_complaint_case(pg_temp.pid(1),pg_temp.pid(5005),'bathroom_cleanliness',0,
  'complaint-create-main',repeat('e',64)),(select value from complaint_results where label='main'),
  'same idempotency key and canonical hash replay the exact receipt');
select throws_ok($$select public.create_complaint_case(pg_temp.pid(1),pg_temp.pid(5005),
  'bathroom_cleanliness',0,'complaint-create-main',repeat('f',64))$$,
  '23505','IDEMPOTENCY_KEY_REUSED','same idempotency key with a different payload hash fails');

select throws_ok($$select public.create_complaint_case(pg_temp.pid(6),pg_temp.pid(5006),
  'cleanliness_general',0,'complaint-developer',repeat('1',64))$$,'42501','ADMIN_REQUIRED','developer cannot create complaints');
select throws_ok($$select public.create_complaint_case(pg_temp.pid(4),pg_temp.pid(5006),
  'cleanliness_general',0,'complaint-inactive',repeat('2',64))$$,'42501','ADMIN_REQUIRED','inactive admin is denied');
select throws_ok($$select public.create_complaint_case(pg_temp.pid(8),pg_temp.pid(5006),
  'cleanliness_general',0,'complaint-temporary',repeat('3',64))$$,'42501','ADMIN_REQUIRED','temporary-password admin is denied');
select throws_ok($$select public.create_complaint_case(pg_temp.pid(5),pg_temp.pid(5006),
  'cleanliness_general',0,'complaint-upload-only',repeat('4',64))$$,'42501','ADMIN_REQUIRED','upload-only maid is denied');

select public.start_complaint_review(pg_temp.pid(1),
  (select (value->>'id')::uuid from complaint_results where label='main'),1,
  'complaint-review-main',repeat('5',64));
select throws_ok($$select public.decide_complaint_case(pg_temp.pid(1),
  (select (value->>'id')::uuid from complaint_results where label='main'),2,
  'confirmed',-1,false,'complaint-penalty-low',repeat('6',64))$$,
  '22023','INVALID_COMPLAINT_PENALTY','negative penalty is rejected');
select throws_ok($$select public.decide_complaint_case(pg_temp.pid(1),
  (select (value->>'id')::uuid from complaint_results where label='main'),2,
  'confirmed',11,false,'complaint-penalty-high',repeat('7',64))$$,
  '22023','INVALID_COMPLAINT_PENALTY','penalty above ten is rejected');

create temporary table payroll_before as select
  (select count(*) from public.earnings) earnings_count,
  (select count(*) from public.payroll_cycles) cycles_count,
  (select count(*) from public.payroll_items) items_count;
insert into complaint_results values('decision',public.decide_complaint_case(pg_temp.pid(1),
  (select (value->>'id')::uuid from complaint_results where label='main'),2,
  'confirmed',0,true,'complaint-decision-main',repeat('8',64)));
select is((select value->'currentDecision'->>'penaltyScore' from complaint_results where label='decision'),'0',
  'zero penalty is accepted as evaluation data');
select ok((select (select count(*) from public.earnings)=earnings_count
  and (select count(*) from public.payroll_cycles)=cycles_count
  and (select count(*) from public.payroll_items)=items_count from payroll_before),
  'complaint decision creates no earning, adjustment, or payroll side effect');

select throws_ok($$select public.respond_to_complaint(pg_temp.pid(3),
  (select (value->>'id')::uuid from complaint_results where label='main'),3,
  'acknowledged',null,'complaint-cross-maid',repeat('9',64))$$,
  '42501','COMPLAINT_MAID_MISMATCH','another maid cannot respond');
insert into complaint_results values('appeal',public.respond_to_complaint(pg_temp.pid(2),
  (select (value->>'id')::uuid from complaint_results where label='main'),3,
  'appealed','evidence_misinterpreted','complaint-appeal-main',repeat('a',64)));
select is((select value->>'status' from complaint_results where label='appeal'),'appealed',
  'owner maid may submit one source-controlled appeal');
select throws_ok($$select public.respond_to_complaint(pg_temp.pid(2),
  (select (value->>'id')::uuid from complaint_results where label='main'),4,
  'appealed','timeline_mismatch','complaint-appeal-twice',repeat('b',64))$$,
  '55000','COMPLAINT_INVALID_TRANSITION','a second response is rejected');
select throws_ok($$select public.close_complaint_case(pg_temp.pid(1),
  (select (value->>'id')::uuid from complaint_results where label='main'),4,
  'complaint-close-unresolved',repeat('c',64))$$,
  '55000','COMPLAINT_APPEAL_UNRESOLVED','unresolved appeal cannot close');

insert into complaint_results values('correction',public.correct_complaint_decision(pg_temp.pid(1),
  (select (value->>'id')::uuid from complaint_results where label='main'),4,
  'unverifiable',10,false,'complaint-correct-main',repeat('d',64)));
select is((select value->'currentDecision'->>'penaltyScore' from complaint_results where label='correction'),'10',
  'ten is an accepted evaluation-only correction penalty');
select is((select count(*) from public.complaint_decisions where complaint_case_id=
  (select (value->>'id')::uuid from complaint_results where label='main')),2::bigint,
  'correction preserves the initial decision and appends a linked version');
select is((select decision_version from public.complaint_decisions where complaint_case_id=
  (select (value->>'id')::uuid from complaint_results where label='main') order by decision_version desc limit 1),2,
  'correction advances immutable decision version');

insert into complaint_results values('closed',public.close_complaint_case(pg_temp.pid(1),
  (select (value->>'id')::uuid from complaint_results where label='main'),5,
  'complaint-close-main',repeat('e',64)));
select is((select value->>'status' from complaint_results where label='closed'),'closed','resolved appeal closes');
select throws_ok($$select public.start_complaint_review(pg_temp.pid(1),
  (select (value->>'id')::uuid from complaint_results where label='main'),6,
  'complaint-reopen-main',repeat('f',64))$$,'55000','COMPLAINT_INVALID_TRANSITION','closed case never reopens');
insert into complaint_results values('closed-correction',public.correct_complaint_decision(pg_temp.pid(1),
  (select (value->>'id')::uuid from complaint_results where label='main'),6,
  'false',0,false,'complaint-correct-closed',repeat('1',64)));
select is((select value->>'status' from complaint_results where label='closed-correction'),'closed',
  'post-close correction appends history without reopening');
select is((select value->>'responseDeadline' from complaint_results where label='closed-correction'),
  (select value->>'responseDeadline' from complaint_results where label='decision'),
  'correction never resets the first-decision response window');

select is((select count(*) from public.audit_events where event_type like 'complaint.%'),8::bigint,
  'each successful lifecycle mutation appends one bounded audit event');
select is((select count(*) from private.notification_outbox o join public.notifications n on n.id=o.notification_id
  where n.category like 'complaint_%'),7::bigint,'required notifications and outbox rows commit atomically');

insert into complaint_results values('pre-corrected',public.create_complaint_case(
  pg_temp.pid(1),pg_temp.pid(5001),'damage_or_loss',0,'complaint-create-pre-corrected',repeat('2',64)));
select public.start_complaint_review(pg_temp.pid(1),
  (select (value->>'id')::uuid from complaint_results where label='pre-corrected'),1,
  'complaint-review-pre-corrected',repeat('3',64));
select public.decide_complaint_case(pg_temp.pid(1),
  (select (value->>'id')::uuid from complaint_results where label='pre-corrected'),2,
  'confirmed',1,true,'complaint-decide-pre-corrected',repeat('4',64));
select public.correct_complaint_decision(pg_temp.pid(1),
  (select (value->>'id')::uuid from complaint_results where label='pre-corrected'),3,
  'unverifiable',2,false,'complaint-correct-before-response',repeat('5',64));
insert into complaint_results values('appeal-after-correction',public.respond_to_complaint(pg_temp.pid(2),
  (select (value->>'id')::uuid from complaint_results where label='pre-corrected'),4,
  'appealed','timeline_mismatch','complaint-appeal-after-correction',repeat('6',64)));
select is((select value->'maidResponse'->>'decisionId' from complaint_results where label='appeal-after-correction'),
  (select id::text from public.complaint_decisions where complaint_case_id=
    (select (value->>'id')::uuid from complaint_results where label='pre-corrected') and decision_version=1),
  'pre-response correction preserves the one response right against the initial decision');
select throws_ok($$select public.close_complaint_case(pg_temp.pid(1),
  (select (value->>'id')::uuid from complaint_results where label='pre-corrected'),5,
  'complaint-close-pre-corrected-appeal',repeat('7',64))$$,
  '55000','COMPLAINT_APPEAL_UNRESOLVED','a correction before the appeal does not resolve that appeal');
select public.correct_complaint_decision(pg_temp.pid(1),
  (select (value->>'id')::uuid from complaint_results where label='pre-corrected'),5,
  'false',0,false,'complaint-correct-after-response',repeat('8',64));
select lives_ok($$select public.close_complaint_case(pg_temp.pid(1),
  (select (value->>'id')::uuid from complaint_results where label='pre-corrected'),6,
  'complaint-close-post-appeal-correction',repeat('9',64))$$,
  'only a correction appended after the appeal permits close');

insert into complaint_results values('deadline-equal',public.create_complaint_case(
  pg_temp.pid(1),pg_temp.pid(5006),'amenity_missing',0,'complaint-create-deadline-equal',repeat('2',64)));
select public.start_complaint_review(pg_temp.pid(1),
  (select (value->>'id')::uuid from complaint_results where label='deadline-equal'),1,
  'complaint-review-deadline-equal',repeat('3',64));
select public.decide_complaint_case(pg_temp.pid(1),
  (select (value->>'id')::uuid from complaint_results where label='deadline-equal'),2,
  'confirmed',0,false,'complaint-decide-deadline-equal',repeat('4',64));
alter table public.complaint_cases disable trigger complaint_case_projection_guard;
update public.complaint_cases set
  first_decided_at=transaction_timestamp()-interval '7 days',
  response_deadline=transaction_timestamp()
where id=(select (value->>'id')::uuid from complaint_results where label='deadline-equal');
alter table public.complaint_cases enable trigger complaint_case_projection_guard;
select lives_ok($$select public.respond_to_complaint(pg_temp.pid(2),
  (select (value->>'id')::uuid from complaint_results where label='deadline-equal'),3,
  'acknowledged',null,'complaint-response-deadline-equal',repeat('5',64))$$,
  'maid response is accepted at the inclusive seven-day deadline');

insert into complaint_results values('deadline-past',public.create_complaint_case(
  pg_temp.pid(1),pg_temp.pid(5007),'odor_or_smoke',0,'complaint-create-deadline-past',repeat('6',64)));
select public.start_complaint_review(pg_temp.pid(1),
  (select (value->>'id')::uuid from complaint_results where label='deadline-past'),1,
  'complaint-review-deadline-past',repeat('7',64));
select public.decide_complaint_case(pg_temp.pid(1),
  (select (value->>'id')::uuid from complaint_results where label='deadline-past'),2,
  'unverifiable',0,false,'complaint-decide-deadline-past',repeat('8',64));
alter table public.complaint_cases disable trigger complaint_case_projection_guard;
update public.complaint_cases set
  first_decided_at=transaction_timestamp()-interval '7 days'-interval '1 microsecond',
  response_deadline=transaction_timestamp()-interval '1 microsecond'
where id=(select (value->>'id')::uuid from complaint_results where label='deadline-past');
alter table public.complaint_cases enable trigger complaint_case_projection_guard;
select throws_ok($$select public.respond_to_complaint(pg_temp.pid(2),
  (select (value->>'id')::uuid from complaint_results where label='deadline-past'),3,
  'appealed','timeline_mismatch','complaint-response-deadline-past',repeat('9',64))$$,
  '22023','COMPLAINT_RESPONSE_WINDOW_CLOSED','maid response is rejected after the seven-day deadline');

insert into complaint_results values('close-boundary',public.create_complaint_case(
  pg_temp.pid(1),pg_temp.pid(5008),'access_or_handover',0,'complaint-create-close-boundary',repeat('a',64)));
select public.start_complaint_review(pg_temp.pid(1),
  (select (value->>'id')::uuid from complaint_results where label='close-boundary'),1,
  'complaint-review-close-boundary',repeat('b',64));
select public.decide_complaint_case(pg_temp.pid(1),
  (select (value->>'id')::uuid from complaint_results where label='close-boundary'),2,
  'false',0,false,'complaint-decide-close-boundary',repeat('c',64));
alter table public.complaint_cases disable trigger complaint_case_projection_guard;
update public.complaint_cases set
  first_decided_at=transaction_timestamp()-interval '7 days',
  response_deadline=transaction_timestamp()
where id=(select (value->>'id')::uuid from complaint_results where label='close-boundary');
alter table public.complaint_cases enable trigger complaint_case_projection_guard;
select throws_ok($$select public.close_complaint_case(pg_temp.pid(1),
  (select (value->>'id')::uuid from complaint_results where label='close-boundary'),3,
  'complaint-close-deadline-equal',repeat('d',64))$$,
  '55000','COMPLAINT_RESPONSE_WINDOW_OPEN','no-response case cannot close at the inclusive response deadline');
alter table public.complaint_cases disable trigger complaint_case_projection_guard;
update public.complaint_cases set
  first_decided_at=transaction_timestamp()-interval '7 days'-interval '1 microsecond',
  response_deadline=transaction_timestamp()-interval '1 microsecond'
where id=(select (value->>'id')::uuid from complaint_results where label='close-boundary');
alter table public.complaint_cases enable trigger complaint_case_projection_guard;
select lives_ok($$select public.close_complaint_case(pg_temp.pid(1),
  (select (value->>'id')::uuid from complaint_results where label='close-boundary'),3,
  'complaint-close-deadline-past',repeat('e',64))$$,
  'no-response case may close only after the inclusive seven-day window expires');

select is((select bool_and(not requires_action) from public.notifications
  where category in ('complaint_received','complaint_corrected','complaint_acknowledged','complaint_closed')),true,
  'received, correction, acknowledgement, and close notices are informational');
select is((select bool_and(requires_action) from public.notifications
  where category in ('complaint_decided','complaint_appealed')),true,
  'initial decision and unresolved appeal notices retain their intended action flag');

select ok(not exists(select 1 from information_schema.columns where table_schema='public'
  and table_name in ('complaint_cases','complaint_decisions','complaint_maid_responses','complaint_case_events')
  and column_name ~ '(note|detail|body|customer|phone|pin|photo|locator|payload|error)'),
  'complaint tables expose no free-text, PII, PIN, locator, payload, or raw-error columns');

select throws_ok($$update public.complaint_decisions set penalty_score=1$$,
  '55000','COMPLAINT_HISTORY_IMMUTABLE','decision history rejects update');
select throws_ok($$delete from public.complaint_maid_responses$$,
  '55000','COMPLAINT_HISTORY_IMMUTABLE','maid response history rejects delete');
select throws_ok($$delete from public.complaint_cases$$,
  '55000','COMPLAINT_CASE_DELETE_FORBIDDEN','complaint cases cannot be deleted');

select ok(has_function_privilege('service_role','public.create_complaint_case(uuid,uuid,text,bigint,text,text)','EXECUTE')
  and has_function_privilege('service_role','public.list_complaint_cases_page(uuid,timestamptz,timestamptz,timestamptz,uuid,integer)','EXECUTE')
  and not has_function_privilege('authenticated','public.create_complaint_case(uuid,uuid,text,bigint,text,text)','EXECUTE'),
  'Data API grants expose reviewed complaint RPCs only to service_role');
select ok(has_function_privilege('authenticated','private.complaint_rls_session_is_active()','EXECUTE')
  and not has_function_privilege('anon','private.complaint_rls_session_is_active()','EXECUTE')
  and not has_function_privilege('service_role','private.complaint_rls_session_is_active()','EXECUTE'),
  'session predicate grants only the authenticated policy execution role');
select lives_ok($$select public.record_authorization_denial(pg_temp.pid(6),
  'edge.authorization.complaints','COMPLAINT_ACCESS_REQUIRED',clock_timestamp())$$,
  'complaint authorization denial uses a source-controlled aggregate');
select is((select count(*) from private.actor_authorization_denial_aggregates
  where source='edge.authorization.complaints' and reason_code='COMPLAINT_ACCESS_REQUIRED'),1::bigint,
  'complaint authorization denial records no raw route or payload');
select ok(not exists(select 1 from (values('anon'),('authenticated')) r(role_name)
  cross join (values('complaint_cases'),('complaint_decisions'),('complaint_maid_responses'),('complaint_case_events')) t(table_name)
  cross join unnest(array['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p(privilege)
  where has_table_privilege(r.role_name,'public.'||t.table_name,p.privilege)),
  'anon and authenticated have no raw complaint write privilege');
select throws_ok($$select public.list_complaint_cases_page(pg_temp.pid(1),transaction_timestamp()-interval '32 days',
  transaction_timestamp(),null,null,50)$$,'22023','COMPLAINT_PERIOD_INVALID','list period is bounded to 31 days');
select throws_ok($$select public.list_complaint_cases_page(pg_temp.pid(1),transaction_timestamp()-interval '1 day',
  transaction_timestamp()+interval '1 day',null,null,101)$$,'22023','COMPLAINT_PAGE_LIMIT_INVALID','list page is bounded to 100');
select throws_ok($$select public.list_complaint_cases_page(pg_temp.pid(1),transaction_timestamp()-interval '1 day',
  transaction_timestamp()+interval '1 day',transaction_timestamp(),null,50)$$,'22023','INVALID_COMPLAINT_CURSOR','partial cursor is rejected');

create temporary table complaint_rls_counts as select
  (select count(*) from public.complaint_cases) all_cases,
  (select count(*) from public.complaint_decisions) all_decisions,
  (select count(*) from public.complaint_maid_responses) all_responses,
  (select count(*) from public.complaint_case_events) all_events,
  (select count(*) from public.complaint_cases where maid_profile_id=pg_temp.pid(2)) maid_cases,
  (select count(*) from public.complaint_decisions d join public.complaint_cases c
    on c.id=d.complaint_case_id where c.maid_profile_id=pg_temp.pid(2)) maid_decisions,
  (select count(*) from public.complaint_maid_responses r join public.complaint_cases c
    on c.id=r.complaint_case_id where c.maid_profile_id=pg_temp.pid(2)) maid_responses,
  (select count(*) from public.complaint_case_events e join public.complaint_cases c
    on c.id=e.complaint_case_id where c.maid_profile_id=pg_temp.pid(2)) maid_events;
grant select on complaint_rls_counts to authenticated;

set local role authenticated;
set local request.jwt.claim.sub='10000000-0000-4000-8000-000000000101';
set local request.jwt.claims='{"sub":"10000000-0000-4000-8000-000000000101"}';
select is((select count(*) from public.complaint_cases),0::bigint,
  'missing session claim hides complaint_cases');
select is((select count(*) from public.complaint_decisions),0::bigint,
  'missing session claim hides complaint_decisions');
select is((select count(*) from public.complaint_maid_responses),0::bigint,
  'missing session claim hides complaint_maid_responses');
select is((select count(*) from public.complaint_case_events),0::bigint,
  'missing session claim hides complaint_case_events');

set local request.jwt.claims='{"sub":"10000000-0000-4000-8000-000000000101","session_id":"not-a-uuid"}';
select is((select count(*) from public.complaint_cases),0::bigint,
  'malformed session claim hides complaint_cases without a cast error');
select is((select count(*) from public.complaint_decisions),0::bigint,
  'malformed session claim hides complaint_decisions without a cast error');
select is((select count(*) from public.complaint_maid_responses),0::bigint,
  'malformed session claim hides complaint_maid_responses without a cast error');
select is((select count(*) from public.complaint_case_events),0::bigint,
  'malformed session claim hides complaint_case_events without a cast error');

set local request.jwt.claims='{"sub":"10000000-0000-4000-8000-000000000101","session_id":"10000000-0000-4000-8000-000000000999"}';
select is((select count(*) from public.complaint_cases),0::bigint,
  'missing auth.sessions row hides complaint_cases');
select is((select count(*) from public.complaint_decisions),0::bigint,
  'missing auth.sessions row hides complaint_decisions');
select is((select count(*) from public.complaint_maid_responses),0::bigint,
  'missing auth.sessions row hides complaint_maid_responses');
select is((select count(*) from public.complaint_case_events),0::bigint,
  'missing auth.sessions row hides complaint_case_events');

set local request.jwt.claims='{"sub":"10000000-0000-4000-8000-000000000101","session_id":"10000000-0000-4000-8000-000000000902"}';
select is((select count(*) from public.complaint_cases),0::bigint,
  'session bound to another auth user hides complaint_cases');
select is((select count(*) from public.complaint_decisions),0::bigint,
  'session bound to another auth user hides complaint_decisions');
select is((select count(*) from public.complaint_maid_responses),0::bigint,
  'session bound to another auth user hides complaint_maid_responses');
select is((select count(*) from public.complaint_case_events),0::bigint,
  'session bound to another auth user hides complaint_case_events');

reset role;
update auth.sessions set not_after=clock_timestamp()-interval '1 second' where id=pg_temp.pid(901);
set local role authenticated;
set local request.jwt.claim.sub='10000000-0000-4000-8000-000000000101';
set local request.jwt.claims='{"sub":"10000000-0000-4000-8000-000000000101","session_id":"10000000-0000-4000-8000-000000000901"}';
select is((select count(*) from public.complaint_cases),0::bigint,
  'expired auth session hides complaint_cases');
select is((select count(*) from public.complaint_decisions),0::bigint,
  'expired auth session hides complaint_decisions');
select is((select count(*) from public.complaint_maid_responses),0::bigint,
  'expired auth session hides complaint_maid_responses');
select is((select count(*) from public.complaint_case_events),0::bigint,
  'expired auth session hides complaint_case_events');
reset role;
update auth.sessions set not_after=null where id=pg_temp.pid(901);

set local role authenticated;
set local request.jwt.claim.sub='10000000-0000-4000-8000-000000000101';
set local request.jwt.claims='{"sub":"10000000-0000-4000-8000-000000000101","session_id":"10000000-0000-4000-8000-000000000901"}';
select is((select count(*) from public.complaint_cases),(select all_cases from pg_temp.complaint_rls_counts),
  'valid exact admin session authorizes complaint_cases');
select is((select count(*) from public.complaint_decisions),(select all_decisions from pg_temp.complaint_rls_counts),
  'valid exact admin session authorizes complaint_decisions');
select is((select count(*) from public.complaint_maid_responses),(select all_responses from pg_temp.complaint_rls_counts),
  'valid exact admin session authorizes complaint_maid_responses');
select is((select count(*) from public.complaint_case_events),(select all_events from pg_temp.complaint_rls_counts),
  'valid exact admin session authorizes complaint_case_events');
reset role;

set local role authenticated;
set local request.jwt.claim.sub='10000000-0000-4000-8000-000000000102';
set local request.jwt.claims='{"sub":"10000000-0000-4000-8000-000000000102","session_id":"10000000-0000-4000-8000-000000000902"}';
select is((select count(*) from public.complaint_cases),(select maid_cases from pg_temp.complaint_rls_counts),
  'active password-complete maid sees only self complaints');
select is((select count(*) from public.complaint_decisions),(select maid_decisions from pg_temp.complaint_rls_counts),
  'active password-complete maid sees only self complaint decisions');
select is((select count(*) from public.complaint_maid_responses),(select maid_responses from pg_temp.complaint_rls_counts),
  'active password-complete maid sees only self complaint responses');
select is((select count(*) from public.complaint_case_events),(select maid_events from pg_temp.complaint_rls_counts),
  'active password-complete maid sees only self complaint events');
select is((select count(*) from public.complaint_cases where maid_profile_id=pg_temp.pid(3)),0::bigint,
  'maid RLS denies cross-maid rows');
reset role;

set local role authenticated;
set local request.jwt.claim.sub='10000000-0000-4000-8000-000000000106';
set local request.jwt.claims='{"sub":"10000000-0000-4000-8000-000000000106","session_id":"10000000-0000-4000-8000-000000000906"}';
select is((select count(*) from public.complaint_cases),0::bigint,'developer RLS sees no complaint cases');
reset role;

set local role authenticated;
set local request.jwt.claim.sub='10000000-0000-4000-8000-000000000104';
set local request.jwt.claims='{"sub":"10000000-0000-4000-8000-000000000104","session_id":"10000000-0000-4000-8000-000000000904"}';
select is((select count(*) from public.complaint_cases),0::bigint,'inactive admin RLS sees no complaint cases');
reset role;

set local role authenticated;
set local request.jwt.claim.sub='10000000-0000-4000-8000-000000000108';
set local request.jwt.claims='{"sub":"10000000-0000-4000-8000-000000000108","session_id":"10000000-0000-4000-8000-000000000908"}';
select is((select count(*) from public.complaint_cases),0::bigint,
  'temporary-password admin RLS sees no complaint cases');
reset role;

select * from finish();
rollback;
