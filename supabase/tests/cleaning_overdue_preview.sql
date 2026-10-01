begin;
select no_plan();

create function pg_temp.pvid(n integer) returns uuid language sql immutable as $$
  select ('30840000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
insert into auth.users(id) select pg_temp.pvid(100+n) from generate_series(1,6) n;
select public.bootstrap_first_developer_profile(pg_temp.pvid(6),pg_temp.pvid(106),
  '지연 프리뷰 개발자','지연 프리뷰 개발자','0006','overdue-preview-developer-hash','overdue-preview-bootstrap');
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
  login_sequence,role,status,must_change_password)
select pg_temp.pvid(n),pg_temp.pvid(100+n),'overdue-preview-'||n,'overdue-preview-'||n,
  'overdue-preview-'||n,'overdue-preview-'||n,0,
  case when n<=2 then 'admin' else 'maid' end::public.app_role,
  case when n=5 then 'upload_only' else 'active' end::public.account_status,false
from generate_series(1,5) n;
insert into public.availability_versions(id,maid_profile_id,week_start,version,submitted_at)
values(pg_temp.pvid(203),pg_temp.pvid(3),'2038-06-07',1,'2038-06-06 13:00+09'),
  (pg_temp.pvid(213),pg_temp.pvid(3),'2038-05-31',1,'2038-05-30 13:00+09'),
  (pg_temp.pvid(204),pg_temp.pvid(4),'2038-06-07',1,'2038-06-06 13:00+09');
insert into public.availability_days(availability_version_id,work_date,available)
select pg_temp.pvid(203),'2038-06-07'::date+d,d=0 from generate_series(0,6) d
union all select pg_temp.pvid(213),'2038-05-31'::date+d,false from generate_series(0,6) d
union all select pg_temp.pvid(204),'2038-06-07'::date+d,true from generate_series(0,6) d;

create function pg_temp.preview_fixture(n integer,p_day date,p_status public.cleaning_target_status,
  p_sequence integer default null,p_attempt public.attempt_status default null,
  p_maid uuid default pg_temp.pvid(3)) returns uuid language plpgsql as $$
declare v_room public.rooms; v_type public.room_types; v_id uuid:=pg_temp.pvid(1000+n);
begin
  select * into v_room from public.rooms order by room_number offset(n%100) limit 1;
  select * into v_type from public.room_types where id=v_room.room_type_id;
  insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,
    effective_service_date,available_from,due_at,status,assignment_version,room_type_snapshot,fee_snapshot,
    template_snapshot,created_by)
  values(v_id,v_room.id,'additional','manual_room_request','overdue-preview-target-'||n,p_day,p_day,
    (p_day::timestamp+interval '10 hours') at time zone 'Asia/Seoul',
    (p_day::timestamp+interval '20 hours') at time zone 'Asia/Seoul',p_status,2,
    jsonb_build_object('code',v_type.code,'roomNumber',v_room.room_number,'elevatorZone',v_room.elevator_zone),
    v_type.base_cleaning_fee,'{}',pg_temp.pvid(1));
  if p_sequence is not null then
    insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,
      changed_by,notified_at)
    values(pg_temp.pvid(2000+n),v_id,p_maid,p_sequence,2,pg_temp.pvid(1),
      case when p_status<>'draft_assigned' then '2038-06-06 13:00+09'::timestamptz end);
  end if;
  if p_attempt is not null then
    insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,
      assignment_revision,template_snapshot,room_snapshot,started_at)
    values(pg_temp.pvid(3000+n),v_id,pg_temp.pvid(2000+n),p_maid,1,p_attempt,2,'{}','{}',
      case when p_attempt='in_progress' then '2038-06-07 10:00+09'::timestamptz end);
  end if;
  insert into public.cleaning_target_schedule_revisions(cleaning_target_id,revision,effective_service_date,
    available_from,due_at,reason_code,changed_by)
  select id,1,effective_service_date,available_from,due_at,'TEST',pg_temp.pvid(1)
    from public.cleaning_targets where id=v_id;
  return v_id;
end;
$$;
select pg_temp.preview_fixture(1,'2038-06-06','unassigned');
select pg_temp.preview_fixture(2,'2038-06-06','draft_assigned',2);
select pg_temp.preview_fixture(3,'2038-06-06','notified',3);
select pg_temp.preview_fixture(4,'2038-06-06','notified',4,'scheduled');
select pg_temp.preview_fixture(5,'2038-06-07','unassigned');
select pg_temp.preview_fixture(6,'2038-06-08','unassigned');
select pg_temp.preview_fixture(7,'2038-06-06','approved',50);
select pg_temp.preview_fixture(8,'2038-06-06','cancelled',60);
select pg_temp.preview_fixture(9,'2038-06-05','approved',900);
select pg_temp.preview_fixture(10,'2038-06-06','approved',80);
update public.cleaning_assignments set is_current=false,ended_at='2038-06-06 20:00+09'
  where id=pg_temp.pvid(2010);
select pg_temp.preview_fixture(11,'2038-06-08','notified',11,'scheduled');
select pg_temp.preview_fixture(12,'2038-06-08','notified',12,'in_progress',pg_temp.pvid(4));
select pg_temp.preview_fixture(13,'2038-06-06','draft_assigned',13);
update public.cleaning_targets set due_at=due_at+interval '1 minute' where id=pg_temp.pvid(1013);
select pg_temp.preview_fixture(14,'2038-06-07','unassigned');
update public.cleaning_targets set room_id=(select room_id from public.cleaning_targets where id=pg_temp.pvid(1004))
  where id=pg_temp.pvid(1014);

create function pg_temp.preview_ledgers() returns jsonb language plpgsql stable as $$
declare v_name text; v_rows jsonb; v_result jsonb:='{}';
begin
  foreach v_name in array array['public.cleaning_targets','public.cleaning_assignments','public.cleaning_attempts',
    'public.cleaning_target_schedule_revisions','public.availability_versions','public.availability_days',
    'public.audit_events','public.notifications','private.notification_outbox','private.notification_delivery_outbox',
    'private.notification_groups','private.command_executions','public.reservations','public.checkout_cleaning_obligations'] loop
    execute format('select coalesce(jsonb_agg(to_jsonb(entry) order by to_jsonb(entry)::text),''[]''::jsonb) from %s entry',v_name) into v_rows;
    v_result:=v_result||jsonb_build_object(v_name,v_rows);
  end loop;
  return v_result;
end;
$$;
-- END OVERDUE PREVIEW FIXTURE
create temp table overdue_preview_snapshots(label text primary key,value jsonb);
insert into overdue_preview_snapshots values('before',pg_temp.preview_ledgers());
insert into overdue_preview_snapshots values('today',private.assignment_preview_snapshot_at(pg_temp.pvid(1),'2038-06-07','2038-06-07 08:00+09'));
insert into overdue_preview_snapshots values('tomorrow',private.assignment_preview_snapshot_at(pg_temp.pvid(1),'2038-06-08','2038-06-07 08:00+09'));
select is(pg_temp.preview_ledgers(),(select value from overdue_preview_snapshots where label='before'),
  'today and tomorrow snapshots preserve exact target/assignment/schedule/attempt/audit/inbox/outbox/receipt rows');
create function pg_temp.preview_item(p_label text,n integer) returns jsonb language sql stable as $$
  select item from overdue_preview_snapshots snapshot cross join lateral jsonb_array_elements(snapshot.value->'targets') item
    where snapshot.label=p_label and item->>'cleaningTargetId'=pg_temp.pvid(1000+n)::text
$$;
select is(pg_temp.preview_item('today',1)->>'serviceDate','2038-06-06','past unassigned candidate keeps original service date');
select is(pg_temp.preview_item('today',1)->'blockedReason','null'::jsonb,'past unassigned dueAt alone does not block');
select is(pg_temp.preview_item('today',2)->'blockedReason','null'::jsonb,'past draft remains fixed owner workload');
select is(pg_temp.preview_item('today',3)->'blockedReason','null'::jsonb,'past notified attempt-zero remains fixed');
select is(pg_temp.preview_item('today',4)->'blockedReason','null'::jsonb,'past scheduled current-day fixed has no age-only unresolved block');
select is(pg_temp.preview_item('today',4)->'currentAssignment'->>'maidProfileId',pg_temp.pvid(3)::text,'past scheduled owner retained');
select is((pg_temp.preview_item('today',4)->'currentAssignment'->>'sequenceNumber')::integer,4,'past scheduled sequence retained');
select is(pg_temp.preview_item('today',4)->'currentAssignment'->>'serviceDate','2038-06-06','past assignment date snapshot retained');
select is(pg_temp.preview_item('today',4)->'domainIdentity'->>'originalServiceDate','2038-06-06','original target date retained');
select is(pg_temp.preview_item('today',6),null::jsonb,'tomorrow unassigned excluded from today');
select is(pg_temp.preview_item('today',7),null::jsonb,'approved terminal target not fixed workload');
select is(pg_temp.preview_item('today',8),null::jsonb,'cancelled terminal target not candidate');
select is(pg_temp.preview_item('today',11),null::jsonb,'future scheduled is not today fixed workload');
select is(pg_temp.preview_item('today',12)->>'blockedReason','ASSIGNMENT_PREVIEW_ACTIVE_WORKFLOW_UNRESOLVED','future actual busy workflow remains conservative');
select is(pg_temp.preview_item('today',13)->>'blockedReason','ASSIGNMENT_DRAFT_STALE_SCHEDULE','past draft schedule staleness still blocks');
select is(pg_temp.preview_item('today',14)->>'blockedReason','PREVIOUS_ROOM_WORKFLOW_ACTIVE','actual previous room workflow still blocks');
select is(pg_temp.preview_item('tomorrow',1),null::jsonb,'tomorrow does not duplicate old unassigned candidate');
select is(pg_temp.preview_item('tomorrow',2),null::jsonb,'tomorrow does not silently adopt old draft');
select is(pg_temp.preview_item('tomorrow',3),null::jsonb,'tomorrow does not silently adopt past notified attempt-zero');
select is(pg_temp.preview_item('tomorrow',4)->>'blockedReason','ASSIGNMENT_PREVIEW_ACTIVE_WORKFLOW_UNRESOLVED','past busy stays conservative in tomorrow context');
select is(pg_temp.preview_item('tomorrow',6)->>'serviceDate','2038-06-08','tomorrow exact-date candidate retained');
select is((select (maid->>'available')::boolean from overdue_preview_snapshots s,jsonb_array_elements(s.value->'maids') maid
  where s.label='today' and maid->>'maidProfileId'=pg_temp.pvid(3)::text),true,'today uses current planning-day availability, not unavailable yesterday');
select is((select maid->'availabilityIdentity'->>'weekStart' from overdue_preview_snapshots s,jsonb_array_elements(s.value->'maids') maid
  where s.label='today' and maid->>'maidProfileId'=pg_temp.pvid(3)::text),'2038-06-07','old Sunday work uses today Monday availability version');
select is((select (maid->>'available')::boolean from overdue_preview_snapshots s,jsonb_array_elements(s.value->'maids') maid
  where s.label='tomorrow' and maid->>'maidProfileId'=pg_temp.pvid(3)::text),false,'tomorrow availability evaluated independently');
select is((select maid->>'status' from overdue_preview_snapshots s,jsonb_array_elements(s.value->'maids') maid
  where s.label='today' and maid->>'maidProfileId'=pg_temp.pvid(5)::text),'upload_only','limited profile cannot masquerade as active optimizer maid');
select is((select (slot->>'maxSequenceNumber')::integer from overdue_preview_snapshots s,jsonb_array_elements(s.value->'sequenceReservations') slot
  where s.label='today' and slot->>'maidProfileId'=pg_temp.pvid(3)::text and slot->>'serviceDate'='2038-06-06'),60,
  'actual current approved/cancelled terminal sequence occupancy retained; noncurrent 80 excluded');
select is((select count(*)::integer from overdue_preview_snapshots s,jsonb_array_elements(s.value->'sequenceReservations') slot
  where s.label='today' and slot->>'serviceDate'='2038-06-05'),0,'irrelevant old terminal date not projected');
select ok(not (select value::text from overdue_preview_snapshots where label='today') ~ 'template_snapshot|pin_digits|guest_name|phone|requestHash|photoSlots',
  'new internal projection contains no PIN/PII/template or request hash');
select is(private.assignment_preview_source_reason(jsonb_populate_record(null::public.cleaning_targets,
  to_jsonb(target)||jsonb_build_object('available_from',null)),null,'2038-06-07 08:00+09'),
  'ASSIGNMENT_PREVIEW_INVALID_SCHEDULE','overdue still requires a real valid source schedule')
  from public.cleaning_targets target where id=pg_temp.pvid(1001);
select is(private.assignment_preview_source_reason(jsonb_populate_record(null::public.cleaning_targets,
  to_jsonb(target)||jsonb_build_object('cleaning_kind','stayover')),null,'2038-06-07 08:00+09'),
  'ASSIGNMENT_PREVIEW_SOURCE_INVALID','overdue does not bypass source/kind ownership contract')
  from public.cleaning_targets target where id=pg_temp.pvid(1001);

select throws_ok($$select private.assignment_preview_snapshot_at(pg_temp.pvid(3),'2038-06-07','2038-06-07 08:00+09')$$,
  '42501','ADMIN_REQUIRED','maid cannot read admin snapshot');
select throws_ok($$select private.assignment_preview_snapshot_at(pg_temp.pvid(6),'2038-06-07','2038-06-07 08:00+09')$$,
  '42501','ADMIN_REQUIRED','developer cannot read business snapshot');
update public.profiles set status='inactive' where id=pg_temp.pvid(1);
select throws_ok($$select private.assignment_preview_snapshot_at(pg_temp.pvid(1),'2038-06-07','2038-06-07 08:00+09')$$,
  '42501','ACTIVE_ACCOUNT_REQUIRED','latest inactive actor denied');
update public.profiles set status='active' where id=pg_temp.pvid(1);
select throws_ok($$select private.assignment_preview_snapshot_at(pg_temp.pvid(1),'2038-06-06','2038-06-07 08:00+09')$$,
  '22023','ASSIGNMENT_PREVIEW_DATE_NOT_ALLOWED','historical planning context not newly allowed');
select ok(not has_function_privilege('anon','private.assignment_preview_snapshot_at(uuid,date,timestamptz)','EXECUTE'),'anon private helper execution revoked');
select ok(not has_function_privilege('authenticated','private.assignment_preview_snapshot_at(uuid,date,timestamptz)','EXECUTE'),'authenticated private helper execution revoked');
select ok(not has_function_privilege('service_role','private.assignment_preview_snapshot_at(uuid,date,timestamptz)','EXECUTE'),'service role cannot call clock-injected private helper directly');
select ok(not has_function_privilege('anon','public.get_assignment_preview_snapshot(uuid,date)','EXECUTE'),'anon public RPC execution revoked');
select ok(not has_function_privilege('authenticated','public.get_assignment_preview_snapshot(uuid,date)','EXECUTE'),'authenticated public RPC execution revoked');
select ok(has_function_privilege('service_role','public.get_assignment_preview_snapshot(uuid,date)','EXECUTE'),'server public RPC remains available');
select is((select provolatile::text from pg_proc where oid='private.assignment_preview_snapshot_at(uuid,date,timestamptz)'::regprocedure),
  's','private helper remains STABLE read-only');
select ok((select prosecdef and proconfig @> array['search_path=""'] from pg_proc
  where oid='private.assignment_preview_snapshot_at(uuid,date,timestamptz)'::regprocedure),'privileged helper keeps empty protected search_path');
select ok(not exists(select 1 from pg_proc routine cross join lateral
  aclexplode(coalesce(routine.proacl,acldefault('f',routine.proowner))) acl
  where routine.oid='private.assignment_preview_snapshot_at(uuid,date,timestamptz)'::regprocedure
    and acl.grantee=0 and acl.privilege_type='EXECUTE'),'PUBLIC execute cannot expose clock-injected helper');
set local role anon;
select throws_ok($$select public.get_assignment_preview_snapshot('30840000-0000-4000-8000-000000000001',current_date)$$,
  '42501',null,'actual anon RPC execution denied');
reset role;
set local role authenticated;
select throws_ok($$select public.get_assignment_preview_snapshot('30840000-0000-4000-8000-000000000001',current_date)$$,
  '42501',null,'actual authenticated RPC execution denied');
reset role;
set local role service_role;
select lives_ok($$select public.get_assignment_preview_snapshot('30840000-0000-4000-8000-000000000001',
  (clock_timestamp() at time zone 'Asia/Seoul')::date)$$,'actual service-role wrapper execution allowed');
select throws_ok($$select private.assignment_preview_snapshot_at('30840000-0000-4000-8000-000000000001',
  '2038-06-07','2038-06-07 08:00+09')$$,'42501',null,'actual service-role clock-injected helper execution denied');
reset role;

-- Sentinel probes roll back with the expected exception; limits never truncate.
create function pg_temp.preview_target_limit() returns jsonb language plpgsql as $$
begin
  perform pg_temp.preview_fixture(100+n,'2038-06-07','unassigned') from generate_series(1,243) n;
  return private.assignment_preview_snapshot_at(pg_temp.pvid(1),'2038-06-07','2038-06-07 08:00+09');
end;
$$;
select throws_ok($$select pg_temp.preview_target_limit()$$,'54000','ASSIGNMENT_PREVIEW_LIMIT_EXCEEDED','243-target sentinel rejects whole preview');
create function pg_temp.preview_maid_limit() returns jsonb language plpgsql as $$
begin
  insert into auth.users(id) select pg_temp.pvid(19000+g) from generate_series(1,998) g;
  insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
    login_sequence,role,status,must_change_password)
  select pg_temp.pvid(18000+g),pg_temp.pvid(19000+g),'limit-maid-'||g,'limit-maid-'||g,'limit-maid-'||g,'limit-maid-'||g,
    0,'maid','active',false from generate_series(1,998) g;
  return private.assignment_preview_snapshot_at(pg_temp.pvid(1),'2038-06-07','2038-06-07 08:00+09');
end;
$$;
select throws_ok($$select pg_temp.preview_maid_limit()$$,'54000','ASSIGNMENT_PREVIEW_LIMIT_EXCEEDED','1001-maid sentinel rejects whole preview');
create function pg_temp.preview_sequence_limit(p_extra integer default 998) returns jsonb language plpgsql as $$
declare n integer; v_result jsonb;
begin
 begin
  insert into auth.users(id) select pg_temp.pvid(9000+g) from generate_series(1,167) g;
  insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
    login_sequence,role,status,must_change_password)
  select pg_temp.pvid(8000+g),pg_temp.pvid(9000+g),'slot-maid-'||g,'slot-maid-'||g,'slot-maid-'||g,'slot-maid-'||g,
    0,'maid','active',false from generate_series(1,167) g;
  perform pg_temp.preview_fixture(500+day_offset,'2038-06-05'::date-day_offset,'unassigned')
    from generate_series(1,6) day_offset;
  for n in 1..p_extra loop
    perform pg_temp.preview_fixture(10000+n,'2038-06-05'::date-((n-1)/167+1),'approved',1,null,
      pg_temp.pvid(8001+(n-1)%167));
  end loop;
  v_result:=private.assignment_preview_snapshot_at(pg_temp.pvid(1),'2038-06-07','2038-06-07 08:00+09');
  raise exception using errcode='PZ308',message='rollback successful sequence limit probe';
 exception when sqlstate 'PZ308' then null;
 end;
 return v_result;
end;
$$;
select is(jsonb_array_length(pg_temp.preview_sequence_limit(997)->'sequenceReservations'),1000,
  'exactly 1000 occupied maid/date groups are accepted without truncation');
select throws_ok($$select pg_temp.preview_sequence_limit()$$,'54000','ASSIGNMENT_PREVIEW_LIMIT_EXCEEDED','1001 occupied maid/date groups reject whole preview');
select is(pg_temp.preview_ledgers(),(select value from overdue_preview_snapshots where label='before'),
  'failed sentinel probes preserve original business and delivery ledgers');
set local transaction_read_only=on;
select lives_ok($$select private.assignment_preview_snapshot_at(pg_temp.pvid(1),'2038-06-07','2038-06-07 08:00+09')$$,
  'new snapshot and every nested helper execute in real read-only transaction');
select * from finish();
rollback;
