-- #534 synthetic regression, prepared for the separately approved full DB run.
-- NOT RUN during feature development. Every row is rolled back.
begin;
select no_plan();
create function pg_temp.memo_id(n integer) returns uuid language sql immutable as $$
  select ('53400000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
create function pg_temp.memo_day() returns date language sql stable as $$
  select (statement_timestamp() at time zone 'Asia/Seoul')::date
$$;
insert into auth.users(id) select pg_temp.memo_id(100+n) from generate_series(1,4) n;
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
  login_sequence,role,status,must_change_password)
select pg_temp.memo_id(n),pg_temp.memo_id(100+n),'메모 합성 '||n,'메모 합성 '||n,
  'memo-fixture-'||n,'memo-fixture-'||n,0,case when n<3 then 'admin' else 'maid' end::public.app_role,'active',false
from generate_series(1,4) n;
insert into auth.sessions(id,user_id,created_at,updated_at,not_after)
select pg_temp.memo_id(200+n),pg_temp.memo_id(100+n),now(),now(),now()+interval '1 hour' from generate_series(1,4) n;
insert into public.availability_versions(maid_profile_id,week_start,version,submitted_at)
select pg_temp.memo_id(n),pg_temp.memo_day()-(extract(isodow from pg_temp.memo_day())::integer-1)+w*7,1,now()
from generate_series(3,4) n cross join generate_series(0,1) w;
insert into public.availability_days(availability_version_id,work_date,available)
select v.id,v.week_start+d,true from public.availability_versions v cross join generate_series(0,6) d
where v.maid_profile_id in(pg_temp.memo_id(3),pg_temp.memo_id(4));
insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,
  effective_service_date,available_from,due_at,status,room_type_snapshot,fee_snapshot,template_snapshot,created_by)
select pg_temp.memo_id(300+n),(select id from public.rooms order by room_number offset n limit 1),
  'additional','manual_room_request','memo-target-'||n,pg_temp.memo_day(),pg_temp.memo_day(),
  pg_temp.memo_day()::timestamp at time zone 'Asia/Seoul',
  (pg_temp.memo_day()::timestamp at time zone 'Asia/Seoul')+interval '23 hours',
  'unassigned','{}',10000,'{"durationMinutes":60}',pg_temp.memo_id(1)
from generate_series(1,5) n;

create function pg_temp.memo_save(n integer,key text,memo text,explicit boolean default true,actor integer default 1)
returns jsonb language plpgsql as $$
declare version bigint;
begin
  select assignment_version into strict version from public.cleaning_targets where id=pg_temp.memo_id(300+n);
  if explicit then
    return public.save_cleaning_assignment_draft_with_instruction(pg_temp.memo_id(actor),pg_temp.memo_id(300+n),
      pg_temp.memo_id(3),n,version,key,encode(extensions.digest(key,'sha256'),'hex'),memo);
  end if;
  return public.save_cleaning_assignment_draft(pg_temp.memo_id(actor),pg_temp.memo_id(300+n),
    pg_temp.memo_id(3),n,version,key,encode(extensions.digest(key,'sha256'),'hex'));
end $$;
create temp table memo_results(name text primary key,value jsonb);
insert into memo_results values('first',pg_temp.memo_save(1,'memo-first-0001',E'  쓰레기만 치워주세요\n수건5 물캡슐2  '));
select is((select value->>'instructionMemo' from memo_results where name='first'),E'쓰레기만 치워주세요\n수건5 물캡슐2','Korean numbers and newline stored');
select is((select instruction_memo from public.cleaning_assignments where id=(select (value->>'assignmentId')::uuid from memo_results where name='first')),
  E'쓰레기만 치워주세요\n수건5 물캡슐2','exact revision stores normalized text');
select is(pg_temp.memo_save(1,'memo-inherit-0002',null,false)->>'instructionMemo',E'쓰레기만 치워주세요\n수건5 물캡슐2','omitted legacy draft inherits latest revision');
select is(pg_temp.memo_save(1,'memo-clear-0003',null)->'instructionMemo','null'::jsonb,'explicit null clears');
select is(pg_temp.memo_save(1,'memo-no-resurrect-0004',null,false)->'instructionMemo','null'::jsonb,'inherit latest null never resurrects old text');
select is(pg_temp.memo_save(1,'memo-white-clear-0005',U&'\2000\FEFF\000A')->'instructionMemo','null'::jsonb,'Unicode whitespace clears');
insert into memo_results values('updated',pg_temp.memo_save(1,'memo-only-change-0006','수건5 물캡슐2',true,2));
select is((select (value->>'revision')::bigint from memo_results where name='updated'),7::bigint,'memo-only change creates a new revision');
select is((select changed_by from public.cleaning_assignments where id=(select (value->>'assignmentId')::uuid from memo_results where name='updated')),pg_temp.memo_id(2),'another admin may save and actual writer is immutable');
select is(public.save_cleaning_assignment_draft_with_instruction(pg_temp.memo_id(1),pg_temp.memo_id(301),pg_temp.memo_id(3),1,1,
  'memo-first-0001',encode(extensions.digest('memo-first-0001','sha256'),'hex'),E'  쓰레기만 치워주세요\n수건5 물캡슐2  '),
  (select value from memo_results where name='first'),'old receipt replays original text after later edits');
select throws_ok($$select public.save_cleaning_assignment_draft_with_instruction(pg_temp.memo_id(1),pg_temp.memo_id(301),pg_temp.memo_id(3),1,1,
  'memo-first-0001',repeat('f',64),'수건7')$$,'23505','IDEMPOTENCY_KEY_REUSED','same key different payload conflicts');
select throws_ok($$update public.cleaning_assignments set instruction_memo='수건9' where id=(select (value->>'assignmentId')::uuid from memo_results where name='first')$$,
  '23514','ASSIGNMENT_SNAPSHOT_IMMUTABLE','old instruction immutable');
select throws_ok($$select pg_temp.memo_save(2,'memo-maid-deny-0001','수건5',true,3)$$,'42501','ADMIN_REQUIRED','maid cannot edit an instruction');
select is(pg_temp.memo_save(2,'memo-new-target-0001',null,false)->'instructionMemo','null'::jsonb,'different target does not inherit instructions');

select is(private.normalize_assignment_instruction(repeat('가',500)),repeat('가',500),'500 Korean units accepted');
select is(private.normalize_assignment_instruction(repeat(U&'\+01F642',250)),repeat(U&'\+01F642',250),'250 emoji are 500 UTF16 units');
select throws_ok($$select private.normalize_assignment_instruction(repeat(U&'\+01F642',251))$$,'22023','ASSIGNMENT_INSTRUCTION_INVALID','251 emoji rejected');
select throws_ok($$select private.normalize_assignment_instruction(repeat(' ',501))$$,'22023','ASSIGNMENT_INSTRUCTION_INVALID','raw 501 whitespace rejected before trim');
select throws_ok($$select private.normalize_assignment_instruction('PIN: 1234')$$,'22023','ASSIGNMENT_INSTRUCTION_INVALID','PIN text rejected');
select throws_ok($$select private.normalize_assignment_instruction('010-1234-5678')$$,'22023','ASSIGNMENT_INSTRUCTION_INVALID','phone text rejected');
select throws_ok($$select private.normalize_assignment_instruction('test@example.invalid')$$,'22023','ASSIGNMENT_INSTRUCTION_INVALID','email text rejected');
select throws_ok($$select private.normalize_assignment_instruction('https://example.invalid')$$,'22023','ASSIGNMENT_INSTRUCTION_INVALID','URL text rejected');
select is(private.normalize_assignment_instruction('142호 수건5 2026-10-30'),'142호 수건5 2026-10-30','room numbers quantities and dates remain valid');

-- Before notification the new column is still protected by existing assignment RLS.
select set_config('request.jwt.claim.sub',pg_temp.memo_id(103)::text,true);
set local role authenticated;
select is((select count(instruction_memo) from public.cleaning_assignments),0::bigint,'maid cannot see unnotified draft text');
reset role;
insert into memo_results values('impact',public.get_assignment_commit_impact(pg_temp.memo_id(1),pg_temp.memo_day()));
select is((select item->>'instructionMemo' from memo_results cross join lateral jsonb_array_elements(value->'committableDrafts') item
  where name='impact' and item->>'cleaningTargetId'=pg_temp.memo_id(301)::text),'수건5 물캡슐2','commit preview exposes exact assignment instruction');
insert into memo_results(name,value)
select 'committed',public.commit_and_notify_assignments(pg_temp.memo_id(1),pg_temp.memo_day(),value->>'impactFingerprint',
  (select jsonb_agg(jsonb_build_object('cleaningTargetId',item->>'cleaningTargetId',
    'expectedAssignmentVersion',(item->>'targetAssignmentVersion')::bigint,
    'expectedAvailabilityVersion',(item->>'expectedAvailabilityVersion')::bigint))
    from jsonb_array_elements(value->'committableDrafts') item where item->>'cleaningTargetId'=pg_temp.memo_id(301)::text),
  'memo-commit-0001',repeat('a',64)) from memo_results where name='impact';
select is((select value->'notifiedAssignments'->0->>'instructionMemo' from memo_results where name='committed'),'수건5 물캡슐2','commit result carries immutable note');
set local role authenticated;
select is((select instruction_memo from public.cleaning_assignments where is_current and cleaning_target_id=pg_temp.memo_id(301)),'수건5 물캡슐2','own notified assignment reads its text');
reset role;
select set_config('request.jwt.claim.sub',pg_temp.memo_id(104)::text,true);
set local role authenticated;
select is((select count(instruction_memo) from public.cleaning_assignments),0::bigint,'other maid cannot read instruction');
reset role;
select ok(not exists(select 1 from public.audit_events where after_state::text like '%수건5%' or before_state::text like '%수건5%'), 'instruction text never copied to audit');
select ok(not exists(select 1 from public.notifications where body like '%수건5%' or title like '%수건5%'),'instruction text never copied to notification');

-- Explicit edit uses the latest for-plan core and keeps the prestart guard.
insert into memo_results(name,value)
select 'prestart',public.change_cleaning_assignment_for_plan_with_instruction(pg_temp.memo_id(2),pg_temp.memo_id(301),a.id,a.revision,
  a.maid_profile_id,a.sequence_number,'OPERATIONAL_CHANGE','memo-prestart-0001',repeat('b',64),pg_temp.memo_day(),'물캡슐3',null,null)
from public.cleaning_assignments a where cleaning_target_id=pg_temp.memo_id(301) and is_current;
select is((select value->>'instructionMemo' from memo_results where name='prestart'),'물캡슐3','notified memo-only change appends revision');
select is((select instruction_memo from public.cleaning_assignments where id=(select (value->>'assignmentId')::uuid from memo_results where name='updated')),'수건5 물캡슐2','notified previous revision retains original text');
insert into memo_results(name,value)
select 'reassigned',public.change_cleaning_assignment_prestart(pg_temp.memo_id(1),pg_temp.memo_id(301),a.id,a.revision,
  pg_temp.memo_id(4),a.sequence_number,'OPERATIONAL_CHANGE','memo-reassign-0001',repeat('c',64),null,null)
from public.cleaning_assignments a where cleaning_target_id=pg_temp.memo_id(301) and is_current;
select is((select value->>'instructionMemo' from memo_results where name='reassigned'),'물캡슐3','legacy reassignment inherits latest instruction');
insert into memo_results(name,value)
select 'cleared',public.change_cleaning_assignment_prestart_with_instruction(pg_temp.memo_id(1),pg_temp.memo_id(301),a.id,a.revision,
  a.maid_profile_id,a.sequence_number,'OPERATIONAL_CHANGE','memo-prestart-clear-0001',repeat('d',64),null,null,null)
from public.cleaning_assignments a where cleaning_target_id=pg_temp.memo_id(301) and is_current;
select is((select value->'instructionMemo' from memo_results where name='cleared'),'null'::jsonb,'explicit prestart null clears');
select ok(not exists(select 1 from public.audit_events where after_state::text like '%물캡슐3%'),'prestart audit excludes memo text');
select public.unassign_cleaning_assignment_prestart(pg_temp.memo_id(1),pg_temp.memo_id(301),a.id,a.revision,
  'OPERATIONAL_CHANGE','memo-unassign-0001',repeat('e',64))
from public.cleaning_assignments a where cleaning_target_id=pg_temp.memo_id(301) and is_current;
select is(pg_temp.memo_save(1,'memo-redraft-after-clear-0001',null,false)->'instructionMemo','null'::jsonb,
  'unassign then redraft preserves latest explicit null');

-- Synthetic valid current attempt, followed by the real started-work handover.
update public.cleaning_targets set due_at=(pg_temp.memo_day()+1)::timestamp at time zone 'Asia/Seoul'-interval '1 second'
where id=pg_temp.memo_id(304);
select pg_temp.memo_save(4,'memo-handover-save-0001','수건8 부탁합니다');
update public.cleaning_targets set status='notified' where id=pg_temp.memo_id(304);
update public.cleaning_assignments set notified_at=clock_timestamp() where cleaning_target_id=pg_temp.memo_id(304) and is_current;
insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,
  assignment_revision,template_snapshot,room_snapshot)
select pg_temp.memo_id(504),a.cleaning_target_id,a.id,a.maid_profile_id,1,'scheduled',a.revision,'{}',
  jsonb_build_object('roomId',t.room_id)
from public.cleaning_assignments a join public.cleaning_targets t on t.id=a.cleaning_target_id
where a.cleaning_target_id=pg_temp.memo_id(304) and a.is_current;
select is(public.get_current_cleaning_attempt(pg_temp.memo_id(3),a.id)->>'instructionMemo','수건8 부탁합니다',
  'authorized current attempt read carries exact assignment memo')
from public.cleaning_assignments a where a.cleaning_target_id=pg_temp.memo_id(304) and a.is_current;
select is(public.get_cleaning_attempt_lifecycle_impact(pg_temp.memo_id(1),pg_temp.memo_id(201),a.id)#>>'{attempt,instructionMemo}',
  '수건8 부탁합니다','admin lifecycle read carries exact assignment memo')
from public.cleaning_assignments a where a.cleaning_target_id=pg_temp.memo_id(304) and a.is_current;
select ok(not (private.attempt_execution_projection(a)?'instructionMemo'),'base execution and audit projection stays memo-free')
from public.cleaning_attempts a where a.id=pg_temp.memo_id(504);
select private.execute_cleaning_attempt_at(pg_temp.memo_id(3),a.id,1,a.assignment_id,a.assignment_revision,
  'memo-handover-start-0001',repeat('1',64),'start',clock_timestamp())
from public.cleaning_attempts a where a.id=pg_temp.memo_id(504);
select throws_ok($$select public.change_cleaning_assignment_prestart_with_instruction(pg_temp.memo_id(1),pg_temp.memo_id(304),
  a.id,a.revision,a.maid_profile_id,a.sequence_number,'OPERATIONAL_CHANGE','memo-started-reject-0001',repeat('2',64),'수건9',null,null)
  from public.cleaning_assignments a where a.cleaning_target_id=pg_temp.memo_id(304) and a.is_current$$,
  '23514','ASSIGNMENT_ALREADY_STARTED','memo edit cannot bypass the started-work guard');
insert into memo_results(name,value)
select 'handover',private.manage_cleaning_attempt_lifecycle_at(pg_temp.memo_id(1),pg_temp.memo_id(201),a.id,a.execution_version,
  a.assignment_id,a.assignment_revision,p.account_lifecycle_version,'interrupt_handover',
  jsonb_build_object('maidProfileId',pg_temp.memo_id(4),'sequenceNumber',50,'serviceDate',t.effective_service_date,
    'availableFrom',t.available_from,'dueAt',t.due_at,'deactivateOld',false),
  'ADMIN_HANDOVER','memo-handover-0001',repeat('3',64),clock_timestamp())
from public.cleaning_attempts a join public.cleaning_targets t on t.id=a.cleaning_target_id
join public.profiles p on p.id=a.maid_profile_id where a.id=pg_temp.memo_id(504);
select is((select instruction_memo from public.cleaning_assignments where cleaning_target_id=pg_temp.memo_id(304) and is_current),
  '수건8 부탁합니다','real started-work handover inherits memo for a different maid');
select is(public.get_limited_cleaning_attempt(pg_temp.memo_id(3),pg_temp.memo_id(203),pg_temp.memo_id(504),2)#>>'{attempt,instructionMemo}',
  '수건8 부탁합니다','limited historical attempt reads its original memo');
select ok(not exists(select 1 from public.audit_events where after_state::text like '%수건8%'),'handover and execution audit stay memo-free');
select ok(not exists(select 1 from public.notifications where body like '%수건8%' or title like '%수건8%'),'handover notifications stay memo-free');

-- Actual midnight command ends the old revision; the next ordinary draft inherits.
select pg_temp.memo_save(3,'memo-midnight-save-0001','쓰레기만 치워주세요');
select is(private.rollover_assignment_midnight_at(pg_temp.memo_id(1),pg_temp.memo_id(303),
  (pg_temp.memo_day()+1)::timestamp at time zone 'Asia/Seoul',2)->>'status','rolledOver','midnight releases unstarted assignment');
select is(pg_temp.memo_save(3,'memo-midnight-after-0001',null,false)->>'instructionMemo','쓰레기만 치워주세요','midnight reassignment preserves instruction');
select is(pg_temp.memo_save(5,'memo-new-after-handover-0001',null,false)->'instructionMemo','null'::jsonb,
  'new target after handover starts without inherited instruction');
select is((select count(*) from public.earnings where maid_profile_id in(pg_temp.memo_id(3),pg_temp.memo_id(4))),0::bigint,'memo changes create no earnings');

select ok(has_column_privilege('authenticated','public.cleaning_assignments','instruction_memo','SELECT'),'new column explicitly selectable under unchanged RLS');
select ok(not has_function_privilege(role,'public.save_cleaning_assignment_draft_with_instruction(uuid,uuid,uuid,integer,bigint,text,text,text)','EXECUTE'),'no direct instruction command grant for '||role)
from unnest(array['anon','authenticated']) role;
select ok(not has_function_privilege(role,'private.guard_assignment_instruction()','EXECUTE'),'no trigger helper invocation for '||role)
from unnest(array['anon','authenticated','service_role']) role;
select * from finish();
rollback;
