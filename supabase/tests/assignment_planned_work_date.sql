begin;
\ir room_pin_fixture.psql
select no_plan();
insert into auth.users(id) values ('a1000000-0000-4000-8000-000000000001'),('a1000000-0000-4000-8000-000000000002');
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,login_sequence,role,status,must_change_password) values
('a2000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','계획 관리자','계획 관리자','계획 관리자','계획 관리자',0,'admin','active',false),
('a2000000-0000-4000-8000-000000000002','a1000000-0000-4000-8000-000000000002','계획 메이드','계획 메이드','계획 메이드','계획 메이드',0,'maid','active',false);
insert into public.cleaning_template_versions(room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,published_at,created_by)
select id,'checkout',1,'published',60,'[]',now(),'a2000000-0000-4000-8000-000000000001' from public.room_types;
create temp table plans(label text primary key,reservation_id uuid,target_id uuid,room_id uuid,assignment_id uuid,result jsonb);
create function pg_temp.make_plan(p_label text,p_out timestamptz,p_in timestamptz default null) returns uuid language plpgsql as $$
declare room public.rooms%rowtype; rid uuid:=gen_random_uuid(); tid uuid; response jsonb;
begin
 select * into room from public.rooms r where not exists(select 1 from plans p where p.room_id=r.id) order by room_number limit 1;
 insert into public.room_pin_sync_events(room_id,sync_status,pin_version,reason_code,actor_profile_id,effective_at)
 values(room.id,'verified',1,'TEST','a2000000-0000-4000-8000-000000000001',now());
 perform pg_temp.install_room_pin_fixture(room.id,'a2000000-0000-4000-8000-000000000001',1);
 response:=public.create_reservation('a2000000-0000-4000-8000-000000000001',rid,room.id,
   coalesce(p_in,((p_out at time zone 'Asia/Seoul')::date-1 + time '16:00') at time zone 'Asia/Seoul'),
   p_out,2,null,room.state_version,'planning-create-'||p_label,repeat('a',64));
 select planned_cleaning_target_id into tid from public.checkout_cleaning_obligations where reservation_id=rid;
 insert into plans values(p_label,rid,tid,room.id,null,response);
 return tid;
end; $$;
-- A previous Sunday -> Monday boundary is readable regardless of the test runner date.
create function pg_temp.plan_day() returns date language sql stable as $$
 select date_trunc('week',transaction_timestamp() at time zone 'Asia/Seoul')::date-8
$$;
create function pg_temp.local_at(d date,tm time) returns timestamptz language sql immutable as $$
 select (d+tm) at time zone 'Asia/Seoul'
$$;
create function pg_temp.staff(n integer) returns uuid language sql immutable as $$
 select ('a2000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
create function pg_temp.sess(n integer) returns uuid language sql immutable as $$
 select ('a3000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
insert into auth.users(id) values('a1000000-0000-4000-8000-000000000003');
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,login_sequence,role,status,must_change_password)
values(pg_temp.staff(3),'a1000000-0000-4000-8000-000000000003','다른 메이드','다른 메이드','plan-other','plan-other',0,'maid','active',false);
insert into auth.sessions(id,user_id)
select pg_temp.sess(n),('a1000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,3)n;
select pg_temp.make_plan('delayed',pg_temp.local_at(pg_temp.plan_day()-30,'11:00'));
select public.process_due_reservation_transitions(pg_temp.staff(1),pg_temp.local_at(pg_temp.plan_day()-30,'13:00'),'delayed-checkout-process',repeat('a',64));
select is((select t.effective_service_date from public.cleaning_targets t join plans p on p.target_id=t.id),pg_temp.plan_day()-30,'checkout work day recorded');
insert into public.availability_versions(maid_profile_id,week_start,version,submitted_at)
values(pg_temp.staff(2),pg_temp.plan_day()-6,1,pg_temp.local_at(pg_temp.plan_day()-7,'12:00'));
insert into public.availability_days(availability_version_id,work_date,available)
select v.id,v.week_start+n,n=6 from public.availability_versions v cross join generate_series(0,6)n
where v.maid_profile_id=pg_temp.staff(2);
select public.save_cleaning_assignment_draft_with_instruction(pg_temp.staff(1),t.id,pg_temp.staff(2),1,t.assignment_version,
  'delayed-memo-draft',repeat('b',64),'퇴실 이후 청소')
from public.cleaning_targets t join plans p on p.target_id=t.id;
select private.commit_and_notify_assignments_at(pg_temp.staff(1),pg_temp.plan_day(),
  private.assignment_commit_impact_at(pg_temp.plan_day(),pg_temp.local_at(pg_temp.plan_day()-1,'12:00'))->>'impactFingerprint',
  jsonb_build_array(jsonb_build_object('cleaningTargetId',t.id,'expectedAssignmentVersion',t.assignment_version,'expectedAvailabilityVersion',1)),
  'delayed-notify',repeat('c',64),pg_temp.local_at(pg_temp.plan_day()-1,'12:00'))
from public.cleaning_targets t join plans p on p.target_id=t.id;
update plans p set assignment_id=a.id from public.cleaning_assignments a where a.cleaning_target_id=p.target_id and a.is_current;
create function pg_temp.rows(actor integer,d date,hist boolean default true) returns jsonb language sql stable as $$
 select public.list_assignment_rows_for_planning_date(pg_temp.staff(actor),pg_temp.sess(actor),
   case when actor=1 then 'admin' else 'maid' end,d,null,hist)
$$;
select is(pg_temp.rows(2,pg_temp.plan_day())->0->>'instruction_memo','퇴실 이후 청소','own notified memo found on planned day');
select is(pg_temp.rows(1,pg_temp.plan_day(),false)->0->>'service_date',(pg_temp.plan_day()-30)::text,'original assignment date retained');
select is(pg_temp.rows(1,pg_temp.plan_day()-30),'[]'::jsonb,'original day no longer shows the delayed task');
select is(pg_temp.rows(3,pg_temp.plan_day()),'[]'::jsonb,'another maid cannot discover it');
select throws_ok($$select public.list_assignment_rows_for_planning_date(pg_temp.staff(3),pg_temp.sess(3),'maid',
 pg_temp.plan_day(),pg_temp.staff(2),true)$$,'42501','ASSIGNMENT_ACCESS_REQUIRED','cross-maid filter rejected');
create function pg_temp.week_read(d date) returns jsonb language sql stable as $$
 select public.list_work_history(pg_temp.staff(1),pg_temp.sess(1),d,pg_temp.staff(2),100,null)
$$;
select is(pg_temp.week_read(pg_temp.plan_day()-6)#>>'{summary,notifiedDayCount}','1','notified week tracks planned Sunday');
select is(private.activation_reason_at(t,a,pg_temp.local_at(pg_temp.plan_day()-1,'15:00')),'CLEANING_SERVICE_DATE_NOT_DUE',
  'tomorrow plan cannot start early') from public.cleaning_targets t join plans p on p.target_id=t.id join public.cleaning_assignments a on a.id=p.assignment_id;
select private.activate_cleaning_attempt_at(pg_temp.staff(1),p.target_id,pg_temp.local_at(pg_temp.plan_day(),'23:00'),a.id,a.revision)
from plans p join public.cleaning_assignments a on a.id=p.assignment_id;
create function pg_temp.detail(d date) returns jsonb language sql stable as $$
 select public.list_payroll_work_details_page(pg_temp.staff(1),pg_temp.sess(1),'admin',d,pg_temp.staff(2),'workflow',null,null,25)
$$;
select is(pg_temp.detail(pg_temp.plan_day()-6)#>>'{entries,0,entryDate}',pg_temp.plan_day()::text,'expected detail on planned Sunday');
select is((pg_temp.detail(pg_temp.plan_day()-6)#>>'{summary,expectedAmount}')::bigint,(select fee_snapshot::bigint from public.cleaning_targets t join plans p on p.target_id=t.id),'aggregate and scheduled detail agree');
select private.execute_cleaning_attempt_at(pg_temp.staff(2),x.id,x.execution_version,x.assignment_id,x.assignment_revision,
  'delayed-start',repeat('d',64),'start',pg_temp.local_at(pg_temp.plan_day(),'23:30'))
from public.cleaning_attempts x join plans p on x.assignment_id=p.assignment_id;
select private.execute_cleaning_attempt_at(pg_temp.staff(2),x.id,x.execution_version,x.assignment_id,x.assignment_revision,
  'delayed-complete',repeat('e',64),'complete_field_work',pg_temp.local_at(pg_temp.plan_day()+1,'00:10'))
from public.cleaning_attempts x join plans p on x.assignment_id=p.assignment_id;
select is(pg_temp.detail(pg_temp.plan_day()-6)->'entries','[]'::jsonb,'completed work leaves previous expected week');
select is(pg_temp.detail(pg_temp.plan_day()+1)#>>'{entries,0,entryDate}',(pg_temp.plan_day()+1)::text,'actual KST Monday completion wins');
select is(pg_temp.week_read(pg_temp.plan_day()+1)#>>'{summary,fieldCompletedDayCount}','1','actual Monday counts in new work week');
select is(pg_temp.week_read(pg_temp.plan_day()+1)#>>'{summary,notifiedDayCount}','0','completion does not move notification history');
select is((select t.original_service_date from public.cleaning_targets t join plans p on p.target_id=t.id),pg_temp.plan_day()-30,'source checkout day survives completion');

-- A notified tomorrow task moves to today. The former revision still belongs to tomorrow.
create function pg_temp.today() returns date language sql stable as $$select (transaction_timestamp() at time zone 'Asia/Seoul')::date$$;
select pg_temp.make_plan('reschedule',pg_temp.local_at(pg_temp.today()-25,'11:00'));
select public.process_due_reservation_transitions(pg_temp.staff(1),pg_temp.local_at(pg_temp.today()-25,'13:00'),
 'reschedule-checkout-process',repeat('1',64));
insert into public.availability_versions(maid_profile_id,week_start,version,submitted_at)
select pg_temp.staff(n),w,1,transaction_timestamp() from generate_series(2,3)n cross join
  (select distinct day-(extract(isodow from day)::int-1) as w from (values(pg_temp.today()),(pg_temp.today()+1)) dates(day)) weeks;
insert into public.availability_days(availability_version_id,work_date,available)
select v.id,v.week_start+d,(v.week_start+d=pg_temp.today()+1 or (v.week_start+d=pg_temp.today() and v.maid_profile_id=pg_temp.staff(2)))
from public.availability_versions v cross join generate_series(0,6)d
where v.maid_profile_id in(pg_temp.staff(2),pg_temp.staff(3)) and v.week_start+6>=pg_temp.today() and v.week_start<=pg_temp.today()+1;
select public.save_cleaning_assignment_draft_with_instruction(pg_temp.staff(1),t.id,pg_temp.staff(2),2,t.assignment_version,
  'reschedule-draft-memo',repeat('2',64),'내일 예정')
from public.cleaning_targets t join plans p on p.target_id=t.id where p.label='reschedule';
select private.commit_and_notify_assignments_at(pg_temp.staff(1),pg_temp.today()+1,
 private.assignment_commit_impact_at(pg_temp.today()+1,transaction_timestamp())->>'impactFingerprint',
 jsonb_build_array(jsonb_build_object('cleaningTargetId',t.id,'expectedAssignmentVersion',t.assignment_version,'expectedAvailabilityVersion',1)),
 'reschedule-tomorrow',repeat('3',64),transaction_timestamp())
from public.cleaning_targets t join plans p on p.target_id=t.id where p.label='reschedule';
create function pg_temp.reschedule(n integer,k text) returns jsonb language sql as $$
 select public.change_cleaning_assignment_for_plan_with_instruction(pg_temp.staff(1),t.id,a.id,t.assignment_version,
 pg_temp.staff(n),a.sequence_number,'OPERATIONAL_CHANGE',k,repeat('4',64),pg_temp.today(),'오늘로 변경',null,null)
 from public.cleaning_targets t join plans p on p.target_id=t.id join public.cleaning_assignments a on a.cleaning_target_id=t.id and a.is_current
 where p.label='reschedule'
$$;
select throws_ok($$select pg_temp.reschedule(3,'reschedule-unavailable')$$,'23514','ASSIGNMENT_MAID_UNAVAILABLE','tomorrow availability cannot authorize today');
select pg_temp.reschedule(2,'reschedule-available');
select is(pg_temp.rows(2,pg_temp.today(),false)->0->>'instruction_memo','오늘로 변경','current list uses changed day and note');
select is(pg_temp.rows(2,pg_temp.today()+1,true)->0->>'instruction_memo','내일 예정','superseded notice retains former day');
select is(pg_temp.rows(2,pg_temp.today()+1,false),'[]'::jsonb,'former day has no current revision');
select ok(not has_function_privilege('authenticated','public.list_assignment_rows_for_planning_date(uuid,uuid,text,date,uuid,boolean)','EXECUTE'),
 'no direct authenticated RPC');
-- Both legacy change commands omit the date. Yesterday is unavailable, but
-- the current draft has rolled to today and the maid has submitted availability.
select pg_temp.make_plan('rolled-draft',pg_temp.local_at(pg_temp.today()-1,'11:00'));
select public.process_due_reservation_transitions(pg_temp.staff(1),pg_temp.local_at(pg_temp.today()-1,'13:00'),'rolled-checkout-process',repeat('5',64));
select private.rollover_assignment_midnight_at(pg_temp.staff(1),t.id,pg_temp.local_at(pg_temp.today(),'00:01'),t.assignment_version)
from public.cleaning_targets t join plans p on p.target_id=t.id where p.label='rolled-draft';
select public.save_cleaning_assignment_draft_with_instruction(pg_temp.staff(1),t.id,pg_temp.staff(2),3,t.assignment_version,
 'rolled-initial-draft',repeat('5',64),'이월 메모')
from public.cleaning_targets t join plans p on p.target_id=t.id where p.label='rolled-draft';
savepoint rolled_draft;
select public.change_cleaning_assignment_prestart(pg_temp.staff(1),t.id,a.id,t.assignment_version,
 pg_temp.staff(2),4,'SEQUENCE_CHANGED','rolled-omit-day',repeat('6',64))
from plans p join public.cleaning_targets t on t.id=p.target_id
join public.cleaning_assignments a on a.cleaning_target_id=t.id and a.is_current where p.label='rolled-draft';
select is((select private.assignment_report_day(t,a) from plans p join public.cleaning_targets t on t.id=p.target_id
 join public.cleaning_assignments a on a.cleaning_target_id=t.id and a.is_current
 where p.label='rolled-draft' and a.sequence_number=4),pg_temp.today(),'date omitted: ordinary change uses available rollover day');
rollback to rolled_draft;
select public.change_cleaning_assignment_prestart_with_instruction(pg_temp.staff(1),t.id,a.id,t.assignment_version,
 pg_temp.staff(2),4,'SEQUENCE_CHANGED','rolled-memo-omit-day',repeat('7',64),'변경 메모',null,null)
from plans p join public.cleaning_targets t on t.id=p.target_id
join public.cleaning_assignments a on a.cleaning_target_id=t.id and a.is_current where p.label='rolled-draft';
select is((select private.assignment_report_day(t,a) from plans p join public.cleaning_targets t on t.id=p.target_id
 join public.cleaning_assignments a on a.cleaning_target_id=t.id and a.is_current
 where p.label='rolled-draft' and a.instruction_memo='변경 메모'),pg_temp.today(),'date omitted: memo change uses available rollover day');

select * from finish();
rollback;
