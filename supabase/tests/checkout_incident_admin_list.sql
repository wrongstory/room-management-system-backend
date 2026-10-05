begin;
\ir room_pin_fixture.psql
select no_plan();

-- CHECKOUT_LIST_FIXTURE_BEGIN
-- This exact setup is also reused on baseline95 by the upgrade runner. Only
-- test fixtures use controlled synthetic report times; immutable rows are never
-- rewritten and no production trigger/constraint is disabled.
create function pg_temp.checkout_list_id(n integer) returns uuid language sql immutable as $$
  select ('f3270000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
insert into auth.users(id) select pg_temp.checkout_list_id(100+n) from generate_series(1,9) n;
insert into auth.sessions(id,user_id)
  select pg_temp.checkout_list_id(200+n),pg_temp.checkout_list_id(100+n) from generate_series(1,9) n;
select public.bootstrap_first_developer_profile(
  pg_temp.checkout_list_id(6),pg_temp.checkout_list_id(106),'목록 개발자','목록 개발자','0006',
  'checkout-list-developer-phone','checkout-list-developer-bootstrap'
);
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,
  login_id,login_id_normalized,login_sequence,role,status,must_change_password)
values
  (pg_temp.checkout_list_id(1),pg_temp.checkout_list_id(101),'목록 관리자','목록 관리자','목록 관리자','목록 관리자',0,'admin','active',false),
  (pg_temp.checkout_list_id(2),pg_temp.checkout_list_id(102),'목록 메이드','목록 메이드','목록 메이드','목록 메이드',0,'maid','active',false),
  (pg_temp.checkout_list_id(3),pg_temp.checkout_list_id(103),'다른 관리자','다른 관리자','다른 관리자','다른 관리자',0,'admin','active',false),
  (pg_temp.checkout_list_id(4),pg_temp.checkout_list_id(104),'임시 관리자','임시 관리자','임시 관리자','임시 관리자',0,'admin','active',true),
  (pg_temp.checkout_list_id(5),pg_temp.checkout_list_id(105),'비활성 관리자','비활성 관리자','비활성 관리자','비활성 관리자',0,'admin','inactive',false),
  (pg_temp.checkout_list_id(7),pg_temp.checkout_list_id(107),'다른 메이드','다른 메이드','다른 메이드','다른 메이드',0,'maid','active',false),
  (pg_temp.checkout_list_id(8),pg_temp.checkout_list_id(108),'제한 메이드','제한 메이드','제한 메이드','제한 메이드',0,'maid','upload_only',false),
  (pg_temp.checkout_list_id(9),pg_temp.checkout_list_id(109),'퇴사 관리자','퇴사 관리자','퇴사 관리자','퇴사 관리자',0,'admin','departed',false);
create temp table checkout_list_fixture(n integer primary key,room_id uuid,reservation_id uuid,
  target_id uuid,assignment_id uuid,attempt_id uuid,incident_id uuid,at_time timestamptz,
  report_result jsonb,detail_result jsonb,decision_result jsonb);
create function pg_temp.checkout_list_slots() returns jsonb language sql immutable as $$
  select jsonb_build_array(jsonb_build_object('slotKey','room-proof','required',true,
    'displayOrder',0,'sectionKey','checkout','label','객실 증빙','description','합성 목록 증빙',
    'instanceNumber',1,'instanceCount',1))
$$;
do $$
declare
  fixture_count integer:=coalesce(nullif(current_setting('app.checkout_list_fixture_count',true),''),'102')::integer;
  work_date date:=(clock_timestamp() at time zone 'Asia/Seoul')::date;
  at_time timestamptz:=case when (clock_timestamp() at time zone 'Asia/Seoul')::time<time '00:01'
    then ((work_date-1)+time '23:58') at time zone 'Asia/Seoul'
    else greatest(date_trunc('minute',clock_timestamp())-interval '5 minutes',
      work_date::timestamp at time zone 'Asia/Seoul') end;
  planned_date date:=(at_time at time zone 'Asia/Seoul')::date;
  commit_at timestamptz:=((planned_date-1)+time '09:00') at time zone 'Asia/Seoul';
  week_date date; version_id uuid; room public.rooms; target_id uuid; assignment_id uuid;
  attempt_id uuid; v_reservation_id uuid; result jsonb; n integer;
begin
  insert into public.cleaning_template_versions(room_type_id,cleaning_kind,version,status,
    duration_minutes,photo_slots,published_at,created_by)
  select id,'checkout',6,'published',60,pg_temp.checkout_list_slots(),at_time,pg_temp.checkout_list_id(1)
  from public.room_types;
  for week_date in select distinct d-(extract(isodow from d)::integer-1)
    from unnest(array[planned_date,work_date]) d loop
    version_id:=gen_random_uuid();
    insert into public.availability_versions(id,maid_profile_id,week_start,version,submitted_at)
    values(version_id,pg_temp.checkout_list_id(2),week_date,1,at_time);
    insert into public.availability_days(availability_version_id,work_date,available)
      select version_id,week_date+d,true from generate_series(0,6) d;
  end loop;
  for n in 1..fixture_count loop
    select * into room from public.rooms order by room_number offset n-1 limit 1;
    perform pg_temp.install_room_pin_fixture(room.id,pg_temp.checkout_list_id(1),1);
    insert into public.room_pin_sync_events(room_id,sync_status,pin_version,reason_code,actor_profile_id,effective_at)
      values(room.id,'verified',1,'LIST_TEST',pg_temp.checkout_list_id(1),at_time);
    v_reservation_id:=pg_temp.checkout_list_id(1000+n);
    perform public.create_reservation(pg_temp.checkout_list_id(1),v_reservation_id,room.id,
      ((planned_date-1)+time '16:00') at time zone 'Asia/Seoul',at_time,2,null,room.state_version,
      'checkout-list-create-'||n,repeat('1',64));
    select planned_cleaning_target_id into target_id from public.checkout_cleaning_obligations
      where checkout_cleaning_obligations.reservation_id=v_reservation_id;
    result:=public.save_cleaning_assignment_draft(pg_temp.checkout_list_id(1),target_id,
      pg_temp.checkout_list_id(2),n,1,'checkout-list-draft-'||n,repeat('2',64));
    assignment_id:=(result->>'assignmentId')::uuid;
    perform private.commit_and_notify_assignments_at(pg_temp.checkout_list_id(1),planned_date,
      private.assignment_commit_impact_at(planned_date,commit_at)->>'impactFingerprint',
      jsonb_build_array(jsonb_build_object('cleaningTargetId',target_id,
        'expectedAssignmentVersion',(select assignment_version from public.cleaning_targets where id=target_id),
        'expectedAvailabilityVersion',1)),
      'checkout-list-notify-'||n,repeat('3',64),commit_at);
    update public.reservations set actual_check_in_at=check_in_at where id=v_reservation_id;
    perform public.process_due_reservation_transitions(pg_temp.checkout_list_id(1),at_time,
      'checkout-list-checkout-'||n,repeat('4',64));
    select id into assignment_id from public.cleaning_assignments where cleaning_target_id=target_id and is_current;
    perform private.activate_cleaning_attempt_at(pg_temp.checkout_list_id(1),target_id,
      at_time+interval '30 seconds',assignment_id,
      (select assignment_version from public.cleaning_targets where id=target_id));
    select id into attempt_id from public.cleaning_attempts
      where cleaning_target_id=target_id and status='scheduled';
    insert into checkout_list_fixture(n,room_id,reservation_id,target_id,assignment_id,attempt_id,at_time)
      values(n,room.id,v_reservation_id,target_id,assignment_id,attempt_id,at_time);
  end loop;
end $$;
-- One genuine public report, with typed notification, immutable audit and exact
-- receipt, proves that an unrelated active administrator can discover it.
update checkout_list_fixture f set report_result=public.report_checkout_presence_incident(
  pg_temp.checkout_list_id(2),pg_temp.checkout_list_id(202),f.attempt_id,1,f.assignment_id,
  (select revision from public.cleaning_assignments where id=f.assignment_id),
  'checkout-list-real-report',repeat('5',64)) where n=1;
update checkout_list_fixture set incident_id=(report_result->>'incidentId')::uuid where n=1;
-- Remaining rows have independent, actual FK graphs. Controlled INSERT times
-- exercise timestamp ties/microseconds without mutating immutable report rows.
insert into public.checkout_presence_incidents(id,reservation_id,room_id,checkout_obligation_id,
  cleaning_target_id,assignment_id,attempt_id,reported_by,reason_code,reservation_version,
  target_assignment_version,assignment_revision,attempt_execution_version,pin_version_snapshot,reported_at)
select pg_temp.checkout_list_id(3000+f.n),f.reservation_id,f.room_id,o.id,f.target_id,f.assignment_id,
  f.attempt_id,pg_temp.checkout_list_id(2),'GUEST_STILL_PRESENT',r.version,t.assignment_version,
  a.revision,attempt.execution_version,1,
  case when f.n=3 then timestamptz '2001-01-01 00:00:00.123457Z'
    else timestamptz '2001-01-01 00:00:00.123456Z' end
from checkout_list_fixture f join public.reservations r on r.id=f.reservation_id
join public.checkout_cleaning_obligations o on o.reservation_id=f.reservation_id
join public.cleaning_targets t on t.id=f.target_id
join public.cleaning_assignments a on a.id=f.assignment_id
join public.cleaning_attempts attempt on attempt.id=f.attempt_id where f.n>1;
update checkout_list_fixture set incident_id=pg_temp.checkout_list_id(3000+n) where n>1;
-- CHECKOUT_LIST_FIXTURE_END

create function pg_temp.checkout_list(p_actor integer default 3,p_session integer default 203,
  p_room uuid default null,p_target uuid default null,p_date date default null,
  p_after timestamptz default null,p_after_id uuid default null,p_limit integer default 50)
returns jsonb language sql stable as $$
  select public.list_checkout_presence_incidents_page(pg_temp.checkout_list_id(p_actor),
    case when p_session is null then null else pg_temp.checkout_list_id(p_session) end,
    p_room,p_target,p_date,p_after,p_after_id,p_limit)
$$;
create function pg_temp.checkout_list_digest() returns text language plpgsql as $$
declare relation record; rows_digest text; output text:='';
begin
  for relation in select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in('public','private') and c.relkind='r' order by n.nspname,c.relname loop
    execute format('select md5(coalesce(string_agg(to_jsonb(t)::text,%L order by to_jsonb(t)::text),%L)) from %I.%I t',
      '|','',relation.nspname,relation.relname) into rows_digest;
    output:=output||relation.nspname||'.'||relation.relname||':'||rows_digest||'|';
  end loop;
  return md5(output);
end $$;

select is((select count(*)::integer from checkout_list_fixture),102,'102 independent work graphs provide a real sentinel bound');
select ok((select bool_and(attempt_id is not null) from checkout_list_fixture),'actual checkout and activation produce every attempt');
select is(jsonb_array_length(pg_temp.checkout_list()->'items'),51,'default50 returns only one lookahead');
select is(jsonb_array_length(pg_temp.checkout_list(p_limit=>100)->'items'),101,'max100 returns exactly101 raw items, not102');
select is(jsonb_array_length(pg_temp.checkout_list(p_limit=>1)->'items'),2,'limit1 returns one sentinel');
select is(pg_temp.checkout_list()->'items'->0->>'incidentId',(select incident_id::text from checkout_list_fixture where n=1),
  'different active admin discovers the genuine public report first');
select is(pg_temp.checkout_list()->'items'->1->>'reportedAt','2001-01-01T00:00:00.123457Z','one microsecond is not rounded away');
select is(pg_temp.checkout_list()->'items'->2->>'incidentId',pg_temp.checkout_list_id(3102)::text,'same instant sorts UUID descending');
select is(pg_temp.checkout_list(p_after=>'2001-01-01T00:00:00.123457Z',p_after_id=>pg_temp.checkout_list_id(3003),p_limit=>1)
  ->'items'->0->>'incidentId',pg_temp.checkout_list_id(3102)::text,'microsecond continuation retains the next timestamp');
select is(pg_temp.checkout_list(p_after=>'2001-01-01T00:00:00.123456Z',p_after_id=>pg_temp.checkout_list_id(3102),p_limit=>1)
  ->'items'->0->>'incidentId',pg_temp.checkout_list_id(3101)::text,'equal timestamp continues strictly below UUID');
select is(pg_temp.checkout_list(p_after=>'2000-01-01Z',p_after_id=>pg_temp.checkout_list_id(9999))->'items','[]'::jsonb,'exhausted page is empty');
select is(pg_temp.checkout_list(p_room=>pg_temp.checkout_list_id(9999))->'items','[]'::jsonb,'unknown room filter is empty, not404');
select is(pg_temp.checkout_list(p_target=>pg_temp.checkout_list_id(9999))->'items','[]'::jsonb,'unknown target filter is empty, not404');
select is((select array_agg(key order by key) from jsonb_object_keys(pg_temp.checkout_list()->'items'->0) key),
  array['allowedDecisions','assignmentId','attemptId','cleaningTargetId','incidentId','reportedAt','roomId','roomNumber','serviceDate','status'],
  'exact ten public fields, without reporter/PII/PIN/reservation/version/fingerprint');
select is(pg_temp.checkout_list()->'items'->0->'allowedDecisions',
  '["EXTEND_CHECKOUT","CONFIRM_DEPARTED","FALSE_REPORT"]'::jsonb,'fixed advisory menu is not decision proof');
select ok((select bool_and(value->>'status'='open' and value->>'reportedAt'~
  '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$')
  from jsonb_array_elements(pg_temp.checkout_list(p_limit=>100)->'items')),'all raw items are open and exact UTC microsecond strings');
set local timezone='Pacific/Honolulu';
set local datestyle='SQL, DMY';
select is(pg_temp.checkout_list()->'items'->1->>'reportedAt','2001-01-01T00:00:00.123457Z','session timezone and DateStyle cannot alter cursor instant');
select is(pg_temp.checkout_list(p_target=>(select target_id from checkout_list_fixture where n=2))->'items'->0->>'serviceDate',
  (select to_char(a.service_date,'YYYY-MM-DD') from public.cleaning_assignments a
    join checkout_list_fixture f on f.assignment_id=a.id where f.n=2),'fixed assignment date is not report KST calendar date');
set local timezone='UTC';
set local datestyle='ISO, MDY';

select throws_ok('select pg_temp.checkout_list(2,202)','42501','ADMIN_REQUIRED','reporter maid cannot enumerate incidents');
select throws_ok('select pg_temp.checkout_list(6,206)','42501','ADMIN_REQUIRED','developer cannot enumerate incidents');
select throws_ok('select pg_temp.checkout_list(5,205)','42501','ADMIN_REQUIRED','inactive admin denied');
select throws_ok('select pg_temp.checkout_list(9,209)','42501','ADMIN_REQUIRED','departed admin denied');
select throws_ok('select pg_temp.checkout_list(8,208)','42501','ADMIN_REQUIRED','limited account denied');
select throws_ok('select pg_temp.checkout_list(4,204)','42501','PASSWORD_CHANGE_REQUIRED','temporary password admin denied');
select throws_ok('select pg_temp.checkout_list(3,null)','42501','SESSION_REVOKED','null session denied');
select throws_ok('select pg_temp.checkout_list(3,999)','42501','SESSION_REVOKED','missing session denied');
select throws_ok('select pg_temp.checkout_list(3,201)','42501','SESSION_REVOKED','foreign user session denied');
update auth.sessions set not_after=statement_timestamp()-interval '1 microsecond' where id=pg_temp.checkout_list_id(203);
select throws_ok('select pg_temp.checkout_list()','42501','SESSION_REVOKED','past not_after denied');
select throws_ok('select pg_temp.checkout_list(p_room=>pg_temp.checkout_list_id(9999))','42501','SESSION_REVOKED','empty filter never bypasses session guard');
-- A VOLATILE test wrapper writes before its next SPI statement. The STABLE read
-- therefore sees that committed-to-the-calling-transaction row with exactly the
-- same statement_timestamp(), rather than a data-modifying CTE's old snapshot.
create function pg_temp.checkout_list_equal_session() returns jsonb language plpgsql as $$
begin
  update auth.sessions set not_after=statement_timestamp() where id=pg_temp.checkout_list_id(203);
  return pg_temp.checkout_list();
end $$;
select throws_ok('select pg_temp.checkout_list_equal_session()','42501','SESSION_REVOKED','exact equal statement boundary denied');
update auth.sessions set not_after=clock_timestamp()+interval '1 hour' where id=pg_temp.checkout_list_id(203);
select lives_ok('select pg_temp.checkout_list()','future session remains valid');
update auth.sessions set not_after=null where id=pg_temp.checkout_list_id(203);
select lives_ok('select pg_temp.checkout_list()','null not_after remains compatible');
update public.profiles set must_change_password=true where id=pg_temp.checkout_list_id(3);
select throws_ok('select pg_temp.checkout_list()','42501','PASSWORD_CHANGE_REQUIRED','latest password gate is rechecked');
update public.profiles set must_change_password=false where id=pg_temp.checkout_list_id(3);
update public.profiles set role='maid' where id=pg_temp.checkout_list_id(3);
select throws_ok('select pg_temp.checkout_list()','42501','ADMIN_REQUIRED','latest role change denies stale admin');
update public.profiles set role='admin' where id=pg_temp.checkout_list_id(3);
select throws_ok('select pg_temp.checkout_list(p_limit=>0)','22023','INVALID_CHECKOUT_INCIDENT_LIST','zero limit denied');
select throws_ok('select pg_temp.checkout_list(p_limit=>101)','22023','INVALID_CHECKOUT_INCIDENT_LIST','101 requested limit denied');
select throws_ok('select pg_temp.checkout_list(p_limit=>null)','22023','INVALID_CHECKOUT_INCIDENT_LIST','null limit denied');
select throws_ok($q$select pg_temp.checkout_list(p_after=>'2001-01-01Z')$q$,'22023','INVALID_CHECKOUT_INCIDENT_LIST','half anchor denied');
select throws_ok('select pg_temp.checkout_list(p_after_id=>pg_temp.checkout_list_id(3102))','22023','INVALID_CHECKOUT_INCIDENT_LIST','other half anchor denied');
select throws_ok($q$select pg_temp.checkout_list(p_after=>'infinity',p_after_id=>pg_temp.checkout_list_id(3102))$q$,
  '22023','INVALID_CHECKOUT_INCIDENT_LIST','infinite cursor denied');
select throws_ok($q$select pg_temp.checkout_list(p_date=>'infinity')$q$,'22023','INVALID_CHECKOUT_INCIDENT_LIST','infinite business date denied');

-- Mutate only a test current target under the existing typed writer seam, then
-- restore it. The read must use the report's original assignment date regardless
-- of target-date drift; no trigger/constraint or snapshot is disabled/rewritten.
create temp table checkout_list_original_target as select t.id,t.effective_service_date,t.available_from,t.due_at
from public.cleaning_targets t join checkout_list_fixture f on f.target_id=t.id where f.n=2;
select set_config('app.checkout_incident_writer_mode','typed_v1',true);
update public.cleaning_targets set effective_service_date=effective_service_date+1,available_from=available_from+interval '1 day'
  where id=(select id from checkout_list_original_target);
select set_config('app.checkout_incident_writer_mode','',true);
select is(jsonb_array_length(pg_temp.checkout_list(p_room=>(select room_id from checkout_list_fixture where n=2),
  p_target=>(select target_id from checkout_list_fixture where n=2),
  p_date=>(select effective_service_date from checkout_list_original_target))->'items'),1,'all three filters intersect against frozen assignment date');
select is(pg_temp.checkout_list(p_target=>(select target_id from checkout_list_fixture where n=2),
  p_date=>(select effective_service_date+1 from checkout_list_original_target))->'items','[]'::jsonb,'mutable target date cannot retag the report');
select is(pg_temp.checkout_list(p_room=>(select room_id from checkout_list_fixture where n=3),
  p_target=>(select target_id from checkout_list_fixture where n=2))->'items','[]'::jsonb,'foreign room/target intersection is empty');
select set_config('app.checkout_incident_writer_mode','typed_v1',true);
update public.cleaning_targets t set effective_service_date=o.effective_service_date,
  available_from=o.available_from,due_at=o.due_at from checkout_list_original_target o where t.id=o.id;
select set_config('app.checkout_incident_writer_mode','',true);

create temp table checkout_list_before_read as select pg_temp.checkout_list_digest() digest;
select lives_ok('select pg_temp.checkout_list(p_limit=>100)','full list is a bounded read');
select lives_ok('select pg_temp.checkout_list(p_room=>pg_temp.checkout_list_id(9999))','empty list is a bounded read');
select is(pg_temp.checkout_list_digest(),(select digest from checkout_list_before_read),
  'all public/private domain rows, versions, snapshots, receipts, audits, notifications and outboxes are byte-identical after GET');
select is(current_setting('app.checkout_incident_writer_mode',true),'','GET creates no writer authority');

update checkout_list_fixture f set detail_result=public.get_checkout_presence_incident(
  pg_temp.checkout_list_id(3),pg_temp.checkout_list_id(203),f.incident_id) where n=1;
select ok((select detail_result->>'impactFingerprint'~'^[0-9a-f]{64}$' from checkout_list_fixture where n=1),
  'list discovery feeds existing latest detail proof for another admin');
select lives_ok($q$select public.get_checkout_presence_incident(pg_temp.checkout_list_id(2),pg_temp.checkout_list_id(202),
  (select incident_id from checkout_list_fixture where n=1))$q$,'reporter maid retains existing single-incident access');
select throws_ok($q$select public.get_checkout_presence_incident(pg_temp.checkout_list_id(7),pg_temp.checkout_list_id(207),
  (select incident_id from checkout_list_fixture where n=1))$q$,'42501','CHECKOUT_INCIDENT_ACCESS_REQUIRED','unrelated maid remains denied single detail');
select throws_ok(format('select public.decide_checkout_presence_incident(%L,%L,%L,1,%L,%L,%L,%L::timestamptz,%L::jsonb,%L,%L)',
  pg_temp.checkout_list_id(3),pg_temp.checkout_list_id(203),(select incident_id from checkout_list_fixture where n=1),repeat('0',64),
  decision,reason,case when decision='EXTEND_CHECKOUT' then next_window.available_from else null end,
  jsonb_build_object('maidProfileId',pg_temp.checkout_list_id(2),'sequenceNumber',200,
    'serviceDate',(next_window.available_from at time zone 'Asia/Seoul')::date,
    'availableFrom',next_window.available_from,
    'dueAt',((next_window.available_from at time zone 'Asia/Seoul')::date+1)::timestamp at time zone 'Asia/Seoul'),
  'checkout-list-stale-'||decision,repeat('6',64)),
  '40001','CHECKOUT_INCIDENT_IMPACT_CHANGED','advisory list cannot bypass stale proof for '||decision)
from (values('EXTEND_CHECKOUT','GUEST_STILL_PRESENT_EXTENDED'),
  ('CONFIRM_DEPARTED','GUEST_DEPARTURE_CONFIRMED'),('FALSE_REPORT','REPORT_FALSE_CONFIRMED')) decisions(decision,reason)
cross join lateral (select case when decisions.decision='EXTEND_CHECKOUT'
  then date_trunc('minute',clock_timestamp())+interval '10 minutes'
  else greatest((select at_time from checkout_list_fixture where n=1),
    (clock_timestamp() at time zone 'Asia/Seoul')::date::timestamp at time zone 'Asia/Seoul') end available_from) next_window;
update checkout_list_fixture f set decision_result=public.decide_checkout_presence_incident(
  pg_temp.checkout_list_id(3),pg_temp.checkout_list_id(203),f.incident_id,1,f.detail_result->>'impactFingerprint',
  'CONFIRM_DEPARTED','GUEST_DEPARTURE_CONFIRMED',null,
  jsonb_build_object('maidProfileId',pg_temp.checkout_list_id(2),'sequenceNumber',200,
    'serviceDate',(clock_timestamp() at time zone 'Asia/Seoul')::date,
    'availableFrom',greatest(f.at_time,(clock_timestamp() at time zone 'Asia/Seoul')::date::timestamp at time zone 'Asia/Seoul'),
    'dueAt',((clock_timestamp() at time zone 'Asia/Seoul')::date+1)::timestamp at time zone 'Asia/Seoul'),
  'checkout-list-real-decision',repeat('7',64)) where n=1;
select is((select decision_result->>'status' from checkout_list_fixture where n=1),'resolved','discovery→detail→existing decision completes');
select is(pg_temp.checkout_list(p_target=>(select target_id from checkout_list_fixture where n=1))->'items','[]'::jsonb,'resolved incident leaves open list');
select is(jsonb_array_length(pg_temp.checkout_list(p_after=>(select (report_result->>'reportedAt')::timestamptz from checkout_list_fixture where n=1),
  p_after_id=>(select incident_id from checkout_list_fixture where n=1),p_limit=>100)->'items'),101,
  'resolving the previous anchor does not invalidate or restart continuation');
select lives_ok($q$select public.get_checkout_presence_incident(pg_temp.checkout_list_id(2),pg_temp.checkout_list_id(202),
  (select incident_id from checkout_list_fixture where n=1))$q$,'maid retains notified historical incident detail after successor');
select ok((select a.notified_reservation_schedule_snapshot is not null from public.cleaning_assignments a
  join checkout_list_fixture f on f.assignment_id=a.id where f.n=1),'original #328 notification snapshot is retained after decision');

select ok(has_function_privilege('service_role',
  'public.list_checkout_presence_incidents_page(uuid,uuid,uuid,uuid,date,timestamptz,uuid,integer)','EXECUTE'),'service-only RPC grant exists');
select ok(not has_function_privilege('authenticated',
  'public.list_checkout_presence_incidents_page(uuid,uuid,uuid,uuid,date,timestamptz,uuid,integer)','EXECUTE'),'authenticated has no direct RPC execute');
select ok(not has_function_privilege('anon',
  'public.list_checkout_presence_incidents_page(uuid,uuid,uuid,uuid,date,timestamptz,uuid,integer)','EXECUTE'),'anon has no direct RPC execute');
select ok(not has_table_privilege('service_role','public.checkout_presence_incidents','SELECT'),'no raw incident service table grant is added');
select ok((select provolatile='s' and prosecdef and proconfig=array['search_path=""']
  from pg_proc where oid='public.list_checkout_presence_incidents_page(uuid,uuid,uuid,uuid,date,timestamptz,uuid,integer)'::regprocedure),
  'RPC is STABLE security definer with empty search_path');
select ok(exists(select 1 from pg_indexes where schemaname='public'
  and indexname='checkout_presence_incidents_open_queue_idx' and indexdef like '%reported_at DESC, id DESC%'
  and indexdef like '%status = ''open''%'),'global queue partial index matches exact ordering and predicate');
set local role authenticated;
select throws_ok($q$select public.list_checkout_presence_incidents_page(null,null,null,null,null,null,null,50)$q$,
  '42501','permission denied for function list_checkout_presence_incidents_page','actual browser role cannot execute raw RPC');
reset role;
set local role anon;
select throws_ok($q$select public.list_checkout_presence_incidents_page(null,null,null,null,null,null,null,50)$q$,
  '42501',null::text,'actual anon role is denied without widening its existing schema or function ACL');
reset role;
set local role service_role;
select lives_ok($q$select public.list_checkout_presence_incidents_page(
  'f3270000-0000-4000-8000-000000000003','f3270000-0000-4000-8000-000000000203',null,null,null,null,null,50)$q$,
  'actual service role can execute only authorized bounded projection');
reset role;
select * from finish();
rollback;
