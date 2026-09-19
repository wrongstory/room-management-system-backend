begin;
select no_plan();

create function pg_temp.wid(n integer) returns uuid language sql immutable as $$
  select ('e2060000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
$$;

insert into auth.users(id) select pg_temp.wid(n) from generate_series(101,105) n;
insert into public.profiles(
  id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
  login_sequence,role,status,must_change_password
) values
  (pg_temp.wid(5),pg_temp.wid(105),'기록 개발자','기록 개발자','admin','admin',0,'developer','active',false),
  (pg_temp.wid(1),pg_temp.wid(101),'기록 관리자','기록 관리자','work-admin','work-admin',0,'admin','active',false),
  (pg_temp.wid(2),pg_temp.wid(102),'기록 메이드 A','기록 메이드 a','work-maid-a','work-maid-a',0,'maid','active',false),
  (pg_temp.wid(3),pg_temp.wid(103),'기록 메이드 B','기록 메이드 b','work-maid-b','work-maid-b',0,'maid','active',false),
  (pg_temp.wid(4),pg_temp.wid(104),'기록 메이드 C','기록 메이드 c','work-maid-c','work-maid-c',0,'maid','active',false);
insert into auth.sessions(id,user_id) values
  (pg_temp.wid(201),pg_temp.wid(101)),(pg_temp.wid(202),pg_temp.wid(102)),
  (pg_temp.wid(203),pg_temp.wid(103)),(pg_temp.wid(204),pg_temp.wid(104)),
  (pg_temp.wid(205),pg_temp.wid(105));

set local session_replication_role = replica;

insert into public.availability_versions(
  id,maid_profile_id,week_start,version,status,is_current,submitted_at
) values
  (pg_temp.wid(301),pg_temp.wid(2),'2026-09-14',1,'superseded',false,'2026-09-06 13:00+09'),
  (pg_temp.wid(302),pg_temp.wid(2),'2026-09-14',2,'submitted',true,'2026-09-13 13:00+09'),
  (pg_temp.wid(303),pg_temp.wid(3),'2026-09-14',1,'submitted',true,'2026-09-13 14:00+09');
insert into public.availability_days(availability_version_id,work_date,available)
select pg_temp.wid(302), day::date, day::date in ('2026-09-14','2026-09-16')
from generate_series('2026-09-14'::date,'2026-09-20'::date,'1 day') day;
insert into public.availability_days(availability_version_id,work_date,available)
select pg_temp.wid(303), day::date, day::date = '2026-09-18'
from generate_series('2026-09-14'::date,'2026-09-20'::date,'1 day') day;

insert into public.cleaning_assignments(
  id,cleaning_target_id,maid_profile_id,service_date,sequence_number,revision,is_current,notified_at,ended_at,changed_by
) values
  (pg_temp.wid(401),pg_temp.wid(501),pg_temp.wid(2),'2026-09-14',1,1,true,'2026-09-13 18:00+09',null,pg_temp.wid(1)),
  (pg_temp.wid(402),pg_temp.wid(502),pg_temp.wid(2),'2026-09-16',1,1,false,'2026-09-13 18:01+09','2026-09-13 18:02+09',pg_temp.wid(1)),
  (pg_temp.wid(403),pg_temp.wid(502),pg_temp.wid(3),'2026-09-16',1,2,true,'2026-09-13 18:03+09',null,pg_temp.wid(1)),
  (pg_temp.wid(404),pg_temp.wid(504),pg_temp.wid(2),'2026-09-17',2,1,true,null,null,pg_temp.wid(1));

insert into public.cleaning_attempts(
  id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,assignment_revision,
  started_at,field_completed_at,ended_at,template_snapshot,room_snapshot
) values
  (pg_temp.wid(601),pg_temp.wid(501),pg_temp.wid(401),pg_temp.wid(2),1,'field_completed',1,
    '2026-09-14 00:00+09','2026-09-14 00:20+09','2026-09-14 00:20+09','{}','{}'),
  (pg_temp.wid(602),pg_temp.wid(503),pg_temp.wid(401),pg_temp.wid(2),2,'field_completed',1,
    '2026-09-14 12:00+09','2026-09-14 12:30+09','2026-09-14 12:30+09','{}','{}'),
  (pg_temp.wid(603),pg_temp.wid(504),pg_temp.wid(404),pg_temp.wid(2),1,'scheduled',1,
    null,null,null,'{}','{}'),
  (pg_temp.wid(604),pg_temp.wid(505),pg_temp.wid(403),pg_temp.wid(3),1,'field_completed',2,
    '2026-09-13 23:30+09','2026-09-13 23:59:59+09','2026-09-13 23:59:59+09','{}','{}'),
  (pg_temp.wid(605),pg_temp.wid(506),pg_temp.wid(403),pg_temp.wid(3),2,'field_completed',2,
    '2026-09-20 23:30+09','2026-09-21 00:00:00+09','2026-09-21 00:00:00+09','{}','{}');

set local session_replication_role = origin;

select is(
  public.list_work_history(pg_temp.wid(1),pg_temp.wid(201),'2026-09-14',pg_temp.wid(2),100,null)
    #>>'{items,0,availabilityVersionCount}',
  '2','current availability includes immutable weekly version metadata'
);
select ok(
  (public.list_work_history(pg_temp.wid(1),pg_temp.wid(201),'2026-09-14',pg_temp.wid(2),100,null)
    #>>'{items,0,days,0,availableSubmitted}')::boolean
  and (public.list_work_history(pg_temp.wid(1),pg_temp.wid(201),'2026-09-14',pg_temp.wid(2),100,null)
    #>>'{items,0,days,0,assignmentNotified}')::boolean
  and (public.list_work_history(pg_temp.wid(1),pg_temp.wid(201),'2026-09-14',pg_temp.wid(2),100,null)
    #>>'{items,0,days,0,fieldCompleted}')::boolean,
  'three weekly axes can all be true on the same KST day'
);
select is(
  public.list_work_history(pg_temp.wid(1),pg_temp.wid(201),'2026-09-14',null,100,null)
    #>>'{summary,fieldCompletedDayCount}',
  '1','same-maid same-day completions dedupe and KST week boundaries exclude adjacent weeks'
);
select is(
  public.list_work_history(pg_temp.wid(1),pg_temp.wid(201),'2026-09-14',null,100,null)
    #>>'{summary,notifiedDayCount}',
  '3','notified history preserves both sides of a reassignment'
);
select is(
  public.list_work_history(pg_temp.wid(1),pg_temp.wid(201),'2026-09-14',null,100,null)
    #>>'{summary,fieldCompletedMaidCount}',
  '1','scheduled attempts without field_completed_at never count as actual work'
);
select is(
  jsonb_array_length(public.list_work_history(pg_temp.wid(2),pg_temp.wid(202),'2026-09-14',null,100,null)->'items'),
  1,'maid sees only the self weekly row'
);
select throws_ok(
  $$select public.list_work_history(pg_temp.wid(2),pg_temp.wid(202),'2026-09-14',pg_temp.wid(3),100,null)$$,
  '42501','WORK_HISTORY_MAID_SCOPE_REQUIRED','maid cannot filter another maid'
);
select throws_ok(
  $$select public.list_work_history(pg_temp.wid(5),pg_temp.wid(205),'2026-09-14',null,100,null)$$,
  '42501','WORK_HISTORY_ACCESS_REQUIRED','developer cannot read work history'
);
select throws_ok(
  $$select public.list_work_history(pg_temp.wid(1),pg_temp.wid(201),'2026-09-15',null,100,null)$$,
  '22023','INVALID_WORK_HISTORY_QUERY','weekStart must be a KST business Monday'
);
select ok(
  public.list_work_history(pg_temp.wid(1),pg_temp.wid(201),'2026-09-14',null,1,null)->'nextCursor' is not null,
  'bounded admin page returns a continuation cursor'
);
select is(
  public.list_work_history(pg_temp.wid(1),pg_temp.wid(201),'2026-09-14',null,1,pg_temp.wid(2))
    #>>'{items,0,maidProfileId}',
  pg_temp.wid(3)::text,'cursor traversal continues without duplicating the prior maid'
);
select is(
  public.list_work_history(pg_temp.wid(1),pg_temp.wid(201),'2026-09-14',null,1,null)->'summary',
  public.list_work_history(pg_temp.wid(1),pg_temp.wid(201),'2026-09-14',null,1,pg_temp.wid(2))->'summary',
  'summary remains scoped to the full filter instead of the current page'
);
select ok(
  has_function_privilege('service_role','public.list_work_history(uuid,uuid,date,uuid,integer,uuid)','EXECUTE')
  and not has_function_privilege('authenticated','public.list_work_history(uuid,uuid,date,uuid,integer,uuid)','EXECUTE'),
  'only service role executes the app-owned projection'
);

select * from finish();
rollback;
