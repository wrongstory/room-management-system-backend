begin;
select no_plan();

create function pg_temp.cid(n integer) returns uuid language sql immutable as $$
  select ('10100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;

insert into auth.users(id) select pg_temp.cid(100+n) from generate_series(1,7)n;
select public.bootstrap_first_developer_profile(pg_temp.cid(6),pg_temp.cid(106),
  'comp developer','comp developer','1010',repeat('a',64),'comp-developer-bootstrap');
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,
  login_id,login_id_normalized,login_sequence,role,status,must_change_password)
select pg_temp.cid(n),pg_temp.cid(100+n),'comp-'||n,'comp-'||n,'comp-'||n,'comp-'||n,0,
  case when n in (1,4,5) then 'admin' else 'maid' end::public.app_role,
  case when n=4 then 'inactive' when n=7 then 'inactive' else 'active' end::public.account_status,
  n=5
from generate_series(1,5)n
union all select pg_temp.cid(7),pg_temp.cid(107),'comp-7','comp-7','comp-7','comp-7',0,
  'maid'::public.app_role,'inactive'::public.account_status,false;
insert into auth.sessions(id,user_id)
select pg_temp.cid(900+n),pg_temp.cid(100+n) from generate_series(1,7)n;

insert into public.availability_versions(id,maid_profile_id,week_start,version,status,is_current,submitted_at)
select pg_temp.cid(700+n),pg_temp.cid(n),
  (clock_timestamp() at time zone 'Asia/Seoul')::date
    -(extract(isodow from (clock_timestamp() at time zone 'Asia/Seoul')::date)::integer-1),
  1,'submitted',true,clock_timestamp()-interval '1 day' from generate_series(2,3)n;
insert into public.availability_days(availability_version_id,work_date,available)
select pg_temp.cid(700+n),(clock_timestamp() at time zone 'Asia/Seoul')::date,true
from generate_series(2,3)n;

create temporary table comp_rooms(n integer primary key,room_id uuid,room_type_id uuid,room_code text);
insert into comp_rooms
select row_number() over(order by room_number),room.id,room.room_type_id,room_type.code
from public.rooms room join public.room_types room_type on room_type.id=room.room_type_id
order by room.room_number limit 5;
insert into public.cleaning_template_versions(id,room_type_id,cleaning_kind,version,status,
  duration_minutes,photo_slots,published_at,created_by)
select pg_temp.cid((800+row_number() over(order by room_type_id))::integer),room_type_id,'reclean',1,
  'published',30,'[]'::jsonb,clock_timestamp(),pg_temp.cid(1)
from (select distinct room_type_id from comp_rooms) types;

create function pg_temp.make_complaint(p_n integer,p_rework boolean default true)
returns jsonb language plpgsql as $$
declare v_room comp_rooms; v_target uuid:=pg_temp.cid(1000+p_n); v_assignment uuid:=pg_temp.cid(2000+p_n);
  v_attempt uuid:=pg_temp.cid(3000+p_n); v_submission uuid:=pg_temp.cid(4000+p_n);
  v_inspection uuid:=pg_temp.cid(4500+p_n); v_earning uuid:=pg_temp.cid(5000+p_n);
  v_case jsonb; v_at timestamptz:=clock_timestamp()-interval '1 day';
begin
  select * into v_room from comp_rooms where comp_rooms.n=p_n;
  insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,
    effective_service_date,available_from,due_at,status,assignment_version,room_type_snapshot,
    fee_snapshot,template_snapshot,created_by)
  values(v_target,v_room.room_id,'additional','manual_room_request','comp-original-'||p_n,
    current_date-1,current_date-1,v_at-interval '2 hours',v_at+interval '2 hours','approved',1,
    jsonb_build_object('id',v_room.room_type_id,'code',v_room.room_code),15000,'{}',pg_temp.cid(1));
  insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,service_date,
    sequence_number,revision,is_current,notified_at,changed_by)
  values(v_assignment,v_target,pg_temp.cid(2),current_date-1,p_n,1,true,v_at-interval '2 hours',pg_temp.cid(1));
  insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,
    status,assignment_revision,started_at,field_completed_at,ended_at,template_snapshot,room_snapshot)
  values(v_attempt,v_target,v_assignment,pg_temp.cid(2),1,'approved',1,v_at-interval '90 minutes',
    v_at-interval '30 minutes',v_at-interval '20 minutes','{}',jsonb_build_object('roomId',v_room.room_id));
  insert into public.cleaning_submissions(id,cleaning_attempt_id,client_submission_id,version,status,
    photo_manifest,submitted_by,submitted_at)
  values(v_submission,v_attempt,pg_temp.cid(6000+p_n),1,'approved','{}',pg_temp.cid(2),v_at-interval '10 minutes');
  insert into public.inspection_decisions(id,submission_id,decision,reason_code,decided_by,decided_at)
  values(v_inspection,v_submission,'approved','QUALITY_OK',pg_temp.cid(1),v_at);
  insert into public.earnings(id,earning_entitlement_id,submission_id,maid_profile_id,earned_on,
    base_amount,bomb_room_bonus)
  values(v_earning,v_submission,v_submission,pg_temp.cid(2),current_date-1,15000,0);
  v_case:=public.create_complaint_case(pg_temp.cid(1),v_earning,'cleanliness_general',0,
    'comp-create-'||p_n,repeat((p_n%9+1)::text,64));
  perform public.start_complaint_review(pg_temp.cid(1),(v_case->>'id')::uuid,1,
    'comp-review-'||p_n,repeat(((p_n+1)%9+1)::text,64));
  return public.decide_complaint_case(pg_temp.cid(1),(v_case->>'id')::uuid,2,'confirmed',0,p_rework,
    'comp-decide-'||p_n,repeat(((p_n+2)%9+1)::text,64));
end $$;

create function pg_temp.stage_submission(p_target uuid,p_maid uuid,p_suffix integer)
returns uuid language plpgsql as $$
declare v_assignment public.cleaning_assignments; v_attempt uuid:=pg_temp.cid(10000+p_suffix);
  v_submission uuid:=pg_temp.cid(11000+p_suffix); v_now timestamptz:=clock_timestamp();
  v_template jsonb; v_room uuid;
begin
  select * into v_assignment from public.cleaning_assignments where cleaning_target_id=p_target and is_current;
  select template_snapshot,room_id into v_template,v_room from public.cleaning_targets where id=p_target;
  insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,
    status,assignment_revision,started_at,field_completed_at,ended_at,template_snapshot,room_snapshot)
  values(v_attempt,p_target,v_assignment.id,p_maid,1,'submitted',v_assignment.revision,
    v_now-interval '40 minutes',v_now-interval '10 minutes',v_now-interval '10 minutes',
    v_template,jsonb_build_object('roomId',v_room));
  insert into public.cleaning_submissions(id,cleaning_attempt_id,client_submission_id,version,status,
    photo_manifest,submitted_by,submitted_at)
  values(v_submission,v_attempt,pg_temp.cid(12000+p_suffix),1,'submitted','{}',p_maid,v_now-interval '5 minutes');
  alter table private.submission_photo_binding_sets disable trigger submission_photo_seal_validate;
  insert into private.submission_photo_binding_sets(submission_id,cleaning_attempt_id,photo_count,sealed_at)
  values(v_submission,v_attempt,1,v_now-interval '5 minutes');
  alter table private.submission_photo_binding_sets enable trigger submission_photo_seal_validate;
  insert into private.submission_current_pointers(cleaning_attempt_id,submission_id,revision)
  values(v_attempt,v_submission,1);
  update public.cleaning_targets set status='inspection_pending' where id=p_target;
  return v_submission;
end $$;

create temporary table comp_results(label text primary key,value jsonb);
insert into comp_results values('same-case',pg_temp.make_complaint(1));
insert into comp_results values('same',public.materialize_complaint_rework(pg_temp.cid(1),
  (select (value->>'id')::uuid from comp_results where label='same-case'),3,
  (select (value->>'currentDecisionId')::uuid from comp_results where label='same-case'),
  pg_temp.cid(2),0,'comp-materialize-same',repeat('4',64)));
select is((select value#>>'{reworkDecision,compensationAmount}' from comp_results where label='same'),'0',
  'same maid stores a zero compensation decision');
select is((select count(*) from public.earnings),1::bigint,'materialization alone creates no earning');
select public.approve_cleaning_submission(pg_temp.cid(1),pg_temp.stage_submission(
  (select (value#>>'{reworkDecision,reworkCleaningTargetId}')::uuid from comp_results where label='same'),
  pg_temp.cid(2),1),'QUALITY_OK','comp-approve-same',repeat('5',64));
select is((select count(*) from public.compensation_entitlements),0::bigint,
  'same-maid approved rework creates no compensation entitlement');
select is((select count(*) from public.earnings),1::bigint,
  'same-maid approved rework creates no additional earning');

insert into comp_results values('other-zero-case',pg_temp.make_complaint(2));
select throws_ok($$select public.materialize_complaint_rework(pg_temp.cid(1),
  (select (value->>'id')::uuid from comp_results where label='other-zero-case'),3,
  (select (value->>'currentDecisionId')::uuid from comp_results where label='other-zero-case'),
  pg_temp.cid(3),-1,'comp-negative',repeat('6',64))$$,'22023','INVALID_COMPLAINT_REWORK',
  'negative compensation is rejected');
select throws_ok($$select public.materialize_complaint_rework(pg_temp.cid(1),
  (select (value->>'id')::uuid from comp_results where label='other-zero-case'),3,
  (select (value->>'currentDecisionId')::uuid from comp_results where label='other-zero-case'),
  pg_temp.cid(3),15001,'comp-over',repeat('7',64))$$,'22023','COMPLAINT_COMPENSATION_AMOUNT_INVALID',
  'compensation above the original base snapshot is rejected');
insert into comp_results values('other-zero',public.materialize_complaint_rework(pg_temp.cid(1),
  (select (value->>'id')::uuid from comp_results where label='other-zero-case'),3,
  (select (value->>'currentDecisionId')::uuid from comp_results where label='other-zero-case'),
  pg_temp.cid(3),0,'comp-materialize-zero',repeat('8',64)));
select is((select count(*) from public.compensation_entitlements),0::bigint,
  'field completion and approval are required before entitlement');
insert into comp_results values('zero-approved',public.approve_cleaning_submission(pg_temp.cid(1),
  pg_temp.stage_submission((select (value#>>'{reworkDecision,reworkCleaningTargetId}')::uuid
    from comp_results where label='other-zero'),pg_temp.cid(3),2),
  'QUALITY_OK','comp-approve-zero',repeat('9',64)));
select ok((select value->>'earningId' is not null from comp_results where label='zero-approved'),
  'other-maid zero compensation approval returns its earning id');
select is((select count(*) from public.compensation_entitlements),1::bigint,
  'other-maid zero compensation creates one typed entitlement');
select is((select count(*) from public.earnings where compensation_entitlement_id is not null
  and total_amount=0),1::bigint,'other-maid zero compensation creates one zero-KRW earning');
select is((select count(*) from public.payroll_items item
  join public.earnings earning on earning.id=item.earning_id
  where earning.compensation_entitlement_id is not null),0::bigint,
  'zero earning is not attached to a positive payroll cycle');
select throws_ok($$select public.create_complaint_case(pg_temp.cid(1),
  (select id from public.earnings where compensation_entitlement_id is not null),
  'cleanliness_general',0,'comp-recursive-complaint',repeat('1',64))$$,
  '55000','COMPLAINT_SOURCE_NOT_APPROVED','compensation earning cannot become complaint intake provenance');

insert into comp_results values('other-base-case',pg_temp.make_complaint(3));
insert into comp_results values('other-base',public.materialize_complaint_rework(pg_temp.cid(1),
  (select (value->>'id')::uuid from comp_results where label='other-base-case'),3,
  (select (value->>'currentDecisionId')::uuid from comp_results where label='other-base-case'),
  pg_temp.cid(3),15000,'comp-materialize-base',repeat('2',64)));
select throws_ok($$select public.correct_complaint_decision(pg_temp.cid(1),
  (select (value->>'id')::uuid from comp_results where label='other-base-case'),4,
  'false',0,false,'comp-prestart-correct',repeat('3',64))$$,
  '40001','COMPLAINT_REWORK_PRESTART_FROZEN','semantic correction cannot strand a pre-start assignment');
select lives_ok($$select public.correct_complaint_decision(pg_temp.cid(1),
  (select (value->>'id')::uuid from comp_results where label='other-base-case'),4,
  'confirmed',5,true,'comp-penalty-only',repeat('4',64))$$,
  'penalty-only correction preserves executable rework semantics');
select is(private.activation_reason_at(
  (select t from public.cleaning_targets t where id=(select
    (value#>>'{reworkDecision,reworkCleaningTargetId}')::uuid from comp_results where label='other-base')),
  (select a from public.cleaning_assignments a where cleaning_target_id=(select
    (value#>>'{reworkDecision,reworkCleaningTargetId}')::uuid from comp_results where label='other-base') and is_current),
  clock_timestamp()),null,'penalty-only correction leaves target executable');
insert into comp_results values('other-base-activated',private.activate_cleaning_attempt_at(
  pg_temp.cid(1),(select (value#>>'{reworkDecision,reworkCleaningTargetId}')::uuid
    from comp_results where label='other-base'),clock_timestamp(),
  (select (value#>>'{assignment,id}')::uuid from comp_results where label='other-base'),1));
select is((select value->>'status' from comp_results where label='other-base-activated'),'activated',
  'penalty-only correction still permits real assignment activation');
select lives_ok(format($sql$select public.start_cleaning_attempt(%L,%L,1,%L,1,
  'comp-start-after-penalty',repeat('5',64))$sql$,pg_temp.cid(3),
  (select (value->>'attemptId')::uuid from comp_results where label='other-base-activated'),
  (select (value#>>'{assignment,id}')::uuid from comp_results where label='other-base')),
  'penalty-only correction still permits the assigned maid to start');
select lives_ok($$select public.correct_complaint_decision(pg_temp.cid(1),
  (select (value->>'id')::uuid from comp_results where label='other-base-case'),5,
  'false',0,false,'comp-poststart-correct',repeat('6',64))$$,
  'post-start correction preserves immutable operational provenance');
select ok((select not (private.get_complaint_projection(
    (value->>'id')::uuid,pg_temp.cid(1))#>>'{reworkDecision,sourceDecisionIsCurrent}')::boolean
  from comp_results where label='other-base-case'),
  'admin projection exposes operational source/current decision divergence');
select ok((select not (private.get_complaint_projection(
    (value->>'id')::uuid,pg_temp.cid(2))->'reworkDecision' ? 'assigneeMaidProfileId')
    and not (private.get_complaint_projection(
      (value->>'id')::uuid,pg_temp.cid(2))->'reworkDecision' ? 'compensationAmount')
  from comp_results where label='other-base-case'),
  'original maid projection hides other-maid identity and compensation');
select ok((select not (private.complaint_compensation_projection_for_actor(
    decision,(select current_decision_id from public.complaint_cases where id=decision.complaint_case_id),
    pg_temp.cid(3)) ? 'originalMaidProfileId')
  from public.complaint_compensation_decisions decision
  where complaint_case_id=(select (value->>'id')::uuid from comp_results where label='other-base-case')),
  'assignee projection hides the original maid identity');

select throws_ok($$update public.cleaning_assignments set maid_profile_id=pg_temp.cid(2)
  where cleaning_target_id=(select (value#>>'{reworkDecision,reworkCleaningTargetId}')::uuid
    from comp_results where label='other-base')$$,'23514','COMPLAINT_REWORK_ASSIGNEE_IMMUTABLE',
  'generic prestart reassignment cannot change the compensation assignee');
select ok(not has_table_privilege('anon','public.complaint_compensation_decisions','SELECT')
  and not has_table_privilege('authenticated','public.complaint_compensation_decisions','INSERT')
  and not has_function_privilege('authenticated',
    'public.materialize_complaint_rework(uuid,uuid,bigint,uuid,uuid,integer,text,text)','EXECUTE')
  and has_function_privilege('service_role',
    'public.materialize_complaint_rework(uuid,uuid,bigint,uuid,uuid,integer,text,text)','EXECUTE'),
  'Data API grants expose read through RLS and service-only mutation RPC');
select throws_ok($$update public.complaint_compensation_decisions set compensation_amount=1$$,
  '55000','COMPLAINT_COMPENSATION_IMMUTABLE','compensation decisions are append-only');
select throws_ok($$update public.compensation_entitlements set amount=1$$,
  '55000','COMPLAINT_COMPENSATION_IMMUTABLE','compensation entitlements are append-only');
select ok(not exists(select 1 from information_schema.columns where table_schema='public'
  and table_name in ('complaint_compensation_decisions','compensation_entitlements')
  and column_name ~ '(note|memo|detail|payload|pin|photo|locator|secret|customer|phone)'),
  'typed compensation tables contain no free text or sensitive locator fields');
select is((select count(*) from public.list_developer_audit_events(pg_temp.cid(6),
  array['complaint.rework_materialized'],null,null,null,null,null,50)),3::bigint,
  'developer audit exposes all materialized rework events through the safe projection');
select is((select count(*) from public.list_developer_audit_events(pg_temp.cid(6),
  array['compensation.earned'],null,null,null,null,null,50)),1::bigint,
  'developer audit exposes the typed compensation earning event');
select ok(not exists(select 1 from public.list_developer_audit_events(pg_temp.cid(6),
    array['complaint.rework_materialized','compensation.earned'],null,null,null,null,null,50) event
  where event.summary ?| array['requestHash','idempotencyKey','before_state','after_state',
    'assigneeMaidProfileId','originalMaidProfileId']
    or case when event.event_type='complaint.rework_materialized'
      then not (event.summary ?& array['complaintId','sourceComplaintDecisionId',
        'reworkCleaningTargetId','sameMaid','compensationAmount','currency','caseVersion'])
      else not (event.summary ?& array['complaintId','compensationDecisionId',
        'reworkCleaningTargetId','attemptId','submissionId','inspectionDecisionId',
        'amount','currency','earningId']) end),
  'developer compensation audit returns only complete allowlisted summaries without cross-maid fields');

set local role authenticated;
set local request.jwt.claim.sub='10100000-0000-4000-8000-000000000101';
set local request.jwt.claims='{"sub":"10100000-0000-4000-8000-000000000101"}';
select is((select count(*) from public.complaint_compensation_decisions),0::bigint,
  'missing session claim hides raw compensation decisions');
select is((select count(*) from public.compensation_entitlements),0::bigint,
  'missing session claim hides compensation entitlements');
set local request.jwt.claims='{"sub":"10100000-0000-4000-8000-000000000101","session_id":"not-a-uuid"}';
select is((select count(*) from public.complaint_compensation_decisions),0::bigint,
  'malformed session claim fails closed without a cast error');
select is((select count(*) from public.compensation_entitlements),0::bigint,
  'malformed session claim hides entitlements');
set local request.jwt.claims='{"sub":"10100000-0000-4000-8000-000000000101","session_id":"10100000-0000-4000-8000-000000000999"}';
select is((select count(*) from public.complaint_compensation_decisions),0::bigint,
  'missing auth.sessions row hides compensation decisions');
select is((select count(*) from public.compensation_entitlements),0::bigint,
  'missing auth.sessions row hides entitlements');
set local request.jwt.claims='{"sub":"10100000-0000-4000-8000-000000000101","session_id":"10100000-0000-4000-8000-000000000902"}';
select is((select count(*) from public.complaint_compensation_decisions),0::bigint,
  'session bound to another auth user hides compensation decisions');
select is((select count(*) from public.compensation_entitlements),0::bigint,
  'session bound to another auth user hides entitlements');
set local request.jwt.claims='{"sub":"10100000-0000-4000-8000-000000000101","session_id":"10100000-0000-4000-8000-000000000901"}';
select is((select count(*) from public.complaint_compensation_decisions),3::bigint,
  'valid admin session sees all raw compensation decisions');
select is((select count(*) from public.compensation_entitlements),1::bigint,
  'valid admin session sees compensation entitlements');
reset role;

set local role authenticated;
set local request.jwt.claim.sub='10100000-0000-4000-8000-000000000102';
set local request.jwt.claims='{"sub":"10100000-0000-4000-8000-000000000102","session_id":"10100000-0000-4000-8000-000000000902"}';
select is((select count(*) from public.complaint_compensation_decisions),0::bigint,
  'original maid has no raw compensation decision Data API access');
select is((select count(*) from public.compensation_entitlements),0::bigint,
  'original maid cannot see another maid entitlement');
reset role;

set local role authenticated;
set local request.jwt.claim.sub='10100000-0000-4000-8000-000000000103';
set local request.jwt.claims='{"sub":"10100000-0000-4000-8000-000000000103","session_id":"10100000-0000-4000-8000-000000000903"}';
select is((select count(*) from public.complaint_compensation_decisions),0::bigint,
  'assignee maid has no raw compensation decision Data API access');
select is((select count(*) from public.compensation_entitlements),1::bigint,
  'assignee maid sees only own typed entitlement');
reset role;

set local role authenticated;
set local request.jwt.claim.sub='10100000-0000-4000-8000-000000000106';
set local request.jwt.claims='{"sub":"10100000-0000-4000-8000-000000000106","session_id":"10100000-0000-4000-8000-000000000906"}';
select is((select count(*) from public.complaint_compensation_decisions),0::bigint,
  'developer sees no compensation decision');
select is((select count(*) from public.compensation_entitlements),0::bigint,
  'developer sees no compensation entitlement');
reset role;

set local role authenticated;
set local request.jwt.claim.sub='10100000-0000-4000-8000-000000000104';
set local request.jwt.claims='{"sub":"10100000-0000-4000-8000-000000000104","session_id":"10100000-0000-4000-8000-000000000904"}';
select is((select count(*) from public.complaint_compensation_decisions),0::bigint,
  'inactive admin sees no compensation decision');
select is((select count(*) from public.compensation_entitlements),0::bigint,
  'inactive admin sees no compensation entitlement');
reset role;

set local role authenticated;
set local request.jwt.claim.sub='10100000-0000-4000-8000-000000000105';
set local request.jwt.claims='{"sub":"10100000-0000-4000-8000-000000000105","session_id":"10100000-0000-4000-8000-000000000905"}';
select is((select count(*) from public.complaint_compensation_decisions),0::bigint,
  'temporary-password admin sees no compensation decision');
select is((select count(*) from public.compensation_entitlements),0::bigint,
  'temporary-password admin sees no compensation entitlement');
reset role;

select * from finish();
rollback;
