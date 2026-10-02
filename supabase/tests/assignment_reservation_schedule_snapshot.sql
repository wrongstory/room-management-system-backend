begin;
select no_plan();

create function pg_temp.schedule_id(n integer) returns uuid language sql immutable as $$
  select ('32800000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
insert into auth.users(id) select pg_temp.schedule_id(100+n) from generate_series(1,6) n;
select public.bootstrap_first_developer_profile(pg_temp.schedule_id(6),pg_temp.schedule_id(106),
  '일정 개발자','일정 개발자','0328','schedule-fixture-phone-hash','schedule-fixture-bootstrap');
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
  login_sequence,role,status,must_change_password)
select pg_temp.schedule_id(n),pg_temp.schedule_id(100+n),'schedule-fixture-'||n,'schedule-fixture-'||n,
  'schedule-fixture-'||n,'schedule-fixture-'||n,0,
  case when n=1 then 'admin' else 'maid' end::public.app_role,
  case when n=4 then 'inactive' when n=5 then 'upload_only' else 'active' end::public.account_status,false
from generate_series(1,5) n;
insert into auth.sessions(id,user_id)
select pg_temp.schedule_id(200+n),pg_temp.schedule_id(100+n) from generate_series(1,6) n;
insert into public.cleaning_template_versions(room_type_id,cleaning_kind,version,status,duration_minutes,
  photo_slots,published_at,created_by)
select rt.id,k,1,'published',case when k='checkout' then null else 30 end,
  '[]'::jsonb,clock_timestamp(),pg_temp.schedule_id(1)
from public.room_types rt cross join unnest(array['checkout','stayover','additional']::public.cleaning_kind[]) k;

create function pg_temp.schedule_room(n integer) returns uuid language sql stable as $$
  select id from public.rooms order by room_number offset n limit 1
$$;
create function pg_temp.schedule_reservation(n integer,p_in timestamptz,p_out timestamptz,
  p_type text default 'standard',p_room integer default null)
returns uuid language plpgsql as $$
declare room_id uuid:=pg_temp.schedule_room(coalesce(p_room,n)); target_id uuid;
begin
  perform public.create_reservation_v2(pg_temp.schedule_id(1),pg_temp.schedule_id(1000+n),room_id,
    p_type,p_in,p_out,2,null,(select state_version from public.rooms where id=room_id),
    'schedule-reservation-'||n,repeat('a',64));
  select planned_cleaning_target_id into target_id from public.checkout_cleaning_obligations
    where reservation_id=pg_temp.schedule_id(1000+n);
  return target_id;
end $$;
create function pg_temp.schedule_notice(p_target uuid,n integer,p_notified boolean default true)
returns uuid language plpgsql as $$
declare target public.cleaning_targets; assignment_id uuid:=pg_temp.schedule_id(2000+n);
begin
  update public.cleaning_targets set assignment_version=assignment_version+1,
    status=case when p_notified then 'notified' else 'draft_assigned' end::public.cleaning_target_status
    where id=p_target returning * into target;
  insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,
    notified_at,changed_by)
  values(assignment_id,p_target,pg_temp.schedule_id(2),n,target.assignment_version,
    case when p_notified then clock_timestamp() end,pg_temp.schedule_id(1));
  return assignment_id;
end $$;
create function pg_temp.schedule_read(p_actor uuid,p_session uuid,p_ids uuid[],p_current boolean)
returns jsonb language sql stable as $read$
  select public.get_assignment_schedule_read(p_actor,p_session,p_ids,p_current,
    case when p_actor=pg_temp.schedule_id(1) then 'admin' else 'maid' end)
$read$;
create temp table schedule_cases(label text primary key,target_id uuid,assignment_id uuid,value jsonb);
insert into schedule_cases(label,target_id) values('checkout',pg_temp.schedule_reservation(1,
  '2020-01-01 16:00+09','2020-01-02 12:30+09'));
insert into schedule_cases(label,value)
select 'original-plan',reservation_schedule_snapshot from public.cleaning_target_schedule_revisions
where cleaning_target_id=(select target_id from schedule_cases where label='checkout') order by revision limit 1;
select is((select value->'nextCheckInAt' from schedule_cases where label='original-plan'),'null'::jsonb,
  'creation plan has no invented next check-in');
select pg_temp.schedule_reservation(101,'2020-01-02 15:00+09','2020-01-03 11:00+09','standard',1);
select is((select reservation_schedule_snapshot from public.cleaning_target_schedule_revisions
  where cleaning_target_id=(select target_id from schedule_cases where label='checkout') order by revision limit 1),
  (select value from schedule_cases where label='original-plan'),'later reservation preserves exact creation snapshot');
update schedule_cases set assignment_id=pg_temp.schedule_notice(target_id,1) where label='checkout';
insert into schedule_cases(label,value) values('notified-plan',pg_temp.schedule_read(
  pg_temp.schedule_id(2),pg_temp.schedule_id(202),
  array[(select assignment_id from schedule_cases where label='checkout')],false)->0->'scheduleSnapshot');
select is((select (value->>'plannedCheckoutAt')::timestamptz from schedule_cases where label='notified-plan'),
  '2020-01-02 12:30+09'::timestamptz,'planned checkout uses exact reservation row, not access inversion');
select is((select (value->>'nextCheckInAt')::timestamptz from schedule_cases where label='notified-plan'),
  '2020-01-02 15:00+09'::timestamptz,'next planned guest check-in is captured');
select is((select value->>'nextArrivalKind' from schedule_cases where label='notified-plan'),'check_in',
  'initial guest arrival differs from room move');
select is((select value->>'isEarlyCheckIn' from schedule_cases where label='notified-plan'),'true',
  'planned 15:00 KST is early check-in');
select is((select value->>'isLateCheckout' from schedule_cases where label='notified-plan'),'true',
  'planned 12:30 KST is late checkout');
select is((select value->>'isScheduleUpdated' from schedule_cases where label='notified-plan'),'true',
  'NEXT_RESERVATION_CHANGED plus real deadline change proves schedule update');
select is((select value->>'sourceReservationVersion' from schedule_cases where label='notified-plan'),'1',
  'source reservation version is frozen even before reservation revision insertion');
select ok(not (select value ?| array['sourceReservationId','sourceRoomId','nextReservationId','guestName',
  'guestCount','phone','pin','ciphertext'] from schedule_cases where label='notified-plan'),
  'public projection strips internal IDs and never copies PII or PIN');
select is((select count(*)::int from jsonb_object_keys((select value from schedule_cases where label='notified-plan'))),
  14,'snapshot exposes exactly fourteen contract keys');
select is(pg_temp.schedule_read(pg_temp.schedule_id(1),pg_temp.schedule_id(201),
  array[(select assignment_id from schedule_cases where label='checkout')],false)->0->'scheduleSnapshot',
  (select value from schedule_cases where label='notified-plan'),'admin and own notified maid share frozen projection');
select is(pg_temp.schedule_read(pg_temp.schedule_id(2),pg_temp.schedule_id(202),
  array[(select assignment_id from schedule_cases where label='checkout')],false)->0->'currentDeparture',
  'null'::jsonb,'history suppresses live departure even for a current row');
select throws_ok(format('update public.cleaning_assignments set notified_reservation_schedule_snapshot=''{}''
  where id=%L',(select assignment_id from schedule_cases where label='checkout')),
  '23514','ASSIGNMENT_NOTIFICATION_SCHEDULE_IMMUTABLE','notified plan cannot be overwritten');
select throws_ok(format('update public.cleaning_target_schedule_revisions set reservation_schedule_snapshot=''{}''
  where cleaning_target_id=%L',(select target_id from schedule_cases where label='checkout')),
  '55000','APPEND_ONLY_LEDGER','cleaning schedule remains append-only');

-- No source reservation and an open-ended stay retain explicit unknowns.
select pg_temp.schedule_reservation(2,'2020-01-01 16:00+09',null,'long_stay');
update public.reservations set actual_check_in_at=check_in_at where id=pg_temp.schedule_id(1002);
select public.create_manual_cleaning_request(pg_temp.schedule_id(1),pg_temp.schedule_id(3002),
  pg_temp.schedule_room(2),pg_temp.schedule_id(1002),'stayover','2020-01-02',
  '2020-01-02 09:00+09','2020-01-02 15:00+09',
  (select state_version from public.rooms where id=pg_temp.schedule_room(2)),
  'SCHEDULE_FIXTURE','schedule-stayover',repeat('b',64));
insert into schedule_cases(label,target_id,assignment_id)
values('stayover',pg_temp.schedule_id(3002),pg_temp.schedule_notice(pg_temp.schedule_id(3002),2,false));
select is(pg_temp.schedule_read(pg_temp.schedule_id(1),pg_temp.schedule_id(201),
  array[(select assignment_id from schedule_cases where label='stayover')],true)->0->'scheduleSnapshot'->'plannedCheckoutAt',
  'null'::jsonb,'open-ended source checkout is null, never dueAt or artificial end');
select throws_ok(format('select pg_temp.schedule_read(%L,%L,array[%L::uuid],false)',
  pg_temp.schedule_id(2),pg_temp.schedule_id(202),(select assignment_id from schedule_cases where label='stayover')),
  '42501','ASSIGNMENT_ACCESS_REQUIRED','maid cannot read unnotified draft schedule');
update public.cleaning_assignments set notified_at=clock_timestamp()
  where id=(select assignment_id from schedule_cases where label='stayover');
select ok((select notified_reservation_schedule_snapshot is not null from public.cleaning_assignments
  where id=(select assignment_id from schedule_cases where label='stayover')),'first-notice UPDATE captures frozen plan');
select public.create_manual_cleaning_request(pg_temp.schedule_id(1),pg_temp.schedule_id(3003),
  pg_temp.schedule_room(3),null,'additional','2020-01-02','2020-01-02 09:00+09','2020-01-02 15:00+09',
  (select state_version from public.rooms where id=pg_temp.schedule_room(3)),
  'SCHEDULE_FIXTURE','schedule-additional',repeat('c',64));
insert into schedule_cases(label,target_id,assignment_id)
values('additional',pg_temp.schedule_id(3003),pg_temp.schedule_notice(pg_temp.schedule_id(3003),3));
select is(pg_temp.schedule_read(pg_temp.schedule_id(2),pg_temp.schedule_id(202),
  array[(select assignment_id from schedule_cases where label='additional')],true)->0->'scheduleSnapshot'->'sourceReservationVersion',
  'null'::jsonb,'additional source does not adopt an arbitrary room reservation');
select is(pg_temp.schedule_read(pg_temp.schedule_id(2),pg_temp.schedule_id(202),
  array[(select assignment_id from schedule_cases where label='additional')],false)->0->'scheduleSnapshot'->'nextCheckInAt',
  'null'::jsonb,'15:00 dueAt does not fabricate next check-in 15:30');
select is(pg_temp.schedule_read(pg_temp.schedule_id(2),pg_temp.schedule_id(202),
  array[(select assignment_id from schedule_cases where label='additional')],false)->0->'scheduleSnapshot'->>'isScheduleUpdated',
  'false','assignment version increment alone is not schedule update');
select is(private.assignment_schedule_reason('customer name raw text'),'UNKNOWN','raw reason text is not copied');

-- Exact KST thresholds use stored guest plans, not browser timezone or kind.
insert into schedule_cases(label,target_id) values('kst-boundary',pg_temp.schedule_reservation(6,
  '2020-01-01 16:00+09','2020-01-02 11:00+09'));
select pg_temp.schedule_reservation(106,'2020-01-02 16:00+09','2020-01-03 11:00+09','standard',6);
update schedule_cases set assignment_id=pg_temp.schedule_notice(target_id,6) where label='kst-boundary';
select is(pg_temp.schedule_read(pg_temp.schedule_id(2),pg_temp.schedule_id(202),
  array[(select assignment_id from schedule_cases where label='kst-boundary')],false)->0->'scheduleSnapshot'->>'isEarlyCheckIn',
  'false','exactly 16:00 KST is not early');
select is(pg_temp.schedule_read(pg_temp.schedule_id(2),pg_temp.schedule_id(202),
  array[(select assignment_id from schedule_cases where label='kst-boundary')],false)->0->'scheduleSnapshot'->>'isLateCheckout',
  'false','exactly 11:00 KST is not late');
insert into schedule_cases(label,target_id) values('kst-adjacent',pg_temp.schedule_reservation(7,
  '2020-01-01 16:00+09','2020-01-02 11:01+09'));
select pg_temp.schedule_reservation(107,'2020-01-02 15:59+09','2020-01-03 11:00+09','standard',7);
update schedule_cases set assignment_id=pg_temp.schedule_notice(target_id,7) where label='kst-adjacent';
select is(pg_temp.schedule_read(pg_temp.schedule_id(2),pg_temp.schedule_id(202),
  array[(select assignment_id from schedule_cases where label='kst-adjacent')],false)->0->'scheduleSnapshot'->>'isEarlyCheckIn',
  'true','15:59 KST remains early');
select is(pg_temp.schedule_read(pg_temp.schedule_id(2),pg_temp.schedule_id(202),
  array[(select assignment_id from schedule_cases where label='kst-adjacent')],false)->0->'scheduleSnapshot'->>'isLateCheckout',
  'true','11:01 KST remains late');
select pg_temp.schedule_reservation(8,'2020-01-01 16:00+09','2020-01-03 12:30+09');
update public.reservations set actual_check_in_at=check_in_at where id=pg_temp.schedule_id(1008);
select public.create_manual_cleaning_request(pg_temp.schedule_id(1),pg_temp.schedule_id(3008),
  pg_temp.schedule_room(8),pg_temp.schedule_id(1008),'stayover','2020-01-02',
  '2020-01-02 09:00+09','2020-01-02 15:00+09',
  (select state_version from public.rooms where id=pg_temp.schedule_room(8)),
  'SCHEDULE_FIXTURE','schedule-known-stayover',repeat('8',64));
insert into schedule_cases(label,target_id,assignment_id)
values('known-stayover',pg_temp.schedule_id(3008),pg_temp.schedule_notice(pg_temp.schedule_id(3008),8));
select is(pg_temp.schedule_read(pg_temp.schedule_id(2),pg_temp.schedule_id(202),
  array[(select assignment_id from schedule_cases where label='known-stayover')],false)->0->'scheduleSnapshot'->>'isLateCheckout',
  'true','known source planned late checkout badge is not restricted to checkout cleaning kind');

-- Manual departure capture is valid before checkout event insertion, but only
-- its newly notified successor gets that capture; earlier history stays null.
insert into schedule_cases(label,target_id) values('manual',pg_temp.schedule_reservation(4,
  '2020-01-01 16:00+09','2020-01-03 11:00+09'));
update public.reservations set actual_check_in_at=check_in_at where id=pg_temp.schedule_id(1004);
update schedule_cases set assignment_id=pg_temp.schedule_notice(target_id,4) where label='manual';
select public.manual_checkout_reservation(pg_temp.schedule_id(1),pg_temp.schedule_id(1004),
  (select version from public.reservations where id=pg_temp.schedule_id(1004)),
  'SCHEDULE_FIXTURE','2020-01-02 10:00+09','schedule-manual-checkout',repeat('d',64));
select is(pg_temp.schedule_read(pg_temp.schedule_id(2),pg_temp.schedule_id(202),
  array[(select assignment_id from schedule_cases where label='manual')],false)->0->'scheduleSnapshot'->'actualCheckoutAt',
  'null'::jsonb,'earlier notified history is not hydrated from later actual checkout');
select is((pg_temp.schedule_read(pg_temp.schedule_id(2),pg_temp.schedule_id(202),
  array[(select id from public.cleaning_assignments where cleaning_target_id=(select target_id from schedule_cases
    where label='manual') and is_current)],false)->0->'scheduleSnapshot'->>'actualCheckoutAt')::timestamptz,
  '2020-01-02 10:00+09'::timestamptz,'manual successor captures actual checkout before event insertion');
select is((pg_temp.schedule_read(pg_temp.schedule_id(2),pg_temp.schedule_id(202),
  array[(select id from public.cleaning_assignments where cleaning_target_id=(select target_id from schedule_cases
    where label='manual') and is_current)],true)->0->'currentDeparture'->>'actualCheckoutAt')::timestamptz,
  '2020-01-02 10:00+09'::timestamptz,'current exact source includes committed checkout fact');
select is(pg_temp.schedule_read(pg_temp.schedule_id(2),pg_temp.schedule_id(202),
  array[(select id from public.cleaning_assignments where cleaning_target_id=(select target_id from schedule_cases
    where label='manual') and is_current)],false)->0->'scheduleSnapshot'->>'isLateCheckout',
  'false','early actual departure is not a planned late checkout badge');

-- Complete authorization/bounds matrix, all-or-nothing and no side effects.
select throws_ok(format('select public.get_assignment_schedule_read(%L,%L,array[%L::uuid],true,''maid'')',
  pg_temp.schedule_id(1),pg_temp.schedule_id(201),(select assignment_id from schedule_cases where label='checkout')),
  '42501','ASSIGNMENT_ACCESS_REQUIRED','maid adapter shape is rejected after latest actor becomes admin');
select throws_ok(format('select public.get_assignment_schedule_read(%L,%L,array[%L::uuid],true,''admin'')',
  pg_temp.schedule_id(2),pg_temp.schedule_id(202),(select assignment_id from schedule_cases where label='checkout')),
  '42501','ASSIGNMENT_ACCESS_REQUIRED','admin adapter shape is rejected after latest actor becomes maid');
select throws_ok(format('select pg_temp.schedule_read(%L,%L,array[%L::uuid],true)',
  pg_temp.schedule_id(3),pg_temp.schedule_id(203),(select assignment_id from schedule_cases where label='checkout')),
  '42501','ASSIGNMENT_ACCESS_REQUIRED','other maid cannot query notified schedule');
select throws_ok(format('select pg_temp.schedule_read(%L,%L,array[%L::uuid],true)',
  pg_temp.schedule_id(4),pg_temp.schedule_id(204),(select assignment_id from schedule_cases where label='checkout')),
  '42501','ASSIGNMENT_ACCESS_REQUIRED','inactive account denied');
select throws_ok(format('select pg_temp.schedule_read(%L,%L,array[%L::uuid],true)',
  pg_temp.schedule_id(5),pg_temp.schedule_id(205),(select assignment_id from schedule_cases where label='checkout')),
  '42501','ASSIGNMENT_ACCESS_REQUIRED','limited upload capability does not grant schedule read');
select throws_ok(format('select pg_temp.schedule_read(%L,%L,array[%L::uuid],true)',
  pg_temp.schedule_id(6),pg_temp.schedule_id(206),(select assignment_id from schedule_cases where label='checkout')),
  '42501','ASSIGNMENT_ACCESS_REQUIRED','developer has no business schedule read');
select throws_ok(format('select pg_temp.schedule_read(%L,%L,array[%L::uuid],false)',
  pg_temp.schedule_id(2),pg_temp.schedule_id(999),(select assignment_id from schedule_cases where label='checkout')),
  '42501','SESSION_REVOKED','invalid Auth session denied');
select throws_ok(format('select pg_temp.schedule_read(%L,%L,array[%L::uuid,%L::uuid],false)',
  pg_temp.schedule_id(2),pg_temp.schedule_id(202),(select assignment_id from schedule_cases where label='checkout'),
  (select assignment_id from schedule_cases where label='checkout')),
  '22023','ASSIGNMENT_SCHEDULE_QUERY_INVALID','duplicate identities rejected');
select throws_ok(format('select pg_temp.schedule_read(%L,%L,array[]::uuid[],false)',
  pg_temp.schedule_id(1),pg_temp.schedule_id(201)),'22023','ASSIGNMENT_SCHEDULE_QUERY_INVALID','empty batch rejected');
select throws_ok(format('select pg_temp.schedule_read(%L,%L,array[%L::uuid,%L::uuid],false)',
  pg_temp.schedule_id(2),pg_temp.schedule_id(202),(select assignment_id from schedule_cases where label='checkout'),
  pg_temp.schedule_id(9999)),'42501','ASSIGNMENT_ACCESS_REQUIRED','one unauthorized identity rejects entire batch');
select ok((select bool_and(not has_function_privilege(role_name,
  'public.get_assignment_schedule_read(uuid,uuid,uuid[],boolean,text)','EXECUTE'))
  from unnest(array['anon','authenticated']) role_name),'RPC is not a browser callable privilege bypass');
select ok(has_function_privilege('service_role','public.get_assignment_schedule_read(uuid,uuid,uuid[],boolean,text)',
  'EXECUTE'),'app-owned service role has narrow RPC EXECUTE');
select ok((select bool_and(not has_function_privilege(role_name,signature,'EXECUTE'))
  from unnest(array['anon','authenticated','service_role']) role_name cross join unnest(array[
  'private.assignment_schedule_reason(text)',
  'private.assignment_departure_fact_at(public.cleaning_targets,timestamptz,boolean)',
  'private.capture_cleaning_reservation_schedule()','private.capture_assignment_reservation_schedule()',
  'private.assignment_schedule_public_snapshot(jsonb)']) signature),'raw helper EXECUTE is revoked');
select ok((select provolatile='s' and prosecdef and proconfig=array['search_path=""']
  from pg_proc where oid='public.get_assignment_schedule_read(uuid,uuid,uuid[],boolean,text)'::regprocedure),
  'read RPC is stable definer with empty search_path');
select ok(not has_column_privilege('authenticated','public.cleaning_assignments',
  'notified_reservation_schedule_snapshot','SELECT') and
  not has_column_privilege('authenticated','public.cleaning_target_schedule_revisions',
    'reservation_schedule_snapshot','SELECT'),'browser cannot read either raw internal-lineage pack');
select ok(has_column_privilege('authenticated','public.cleaning_assignments','notified_room_id_snapshot','SELECT')
  and has_column_privilege('authenticated','public.cleaning_target_schedule_revisions','reason_code','SELECT'),
  'pre95 explicit snapshot/reason columns retain browser SELECT under original RLS');
set local role authenticated;
select set_config('request.jwt.claims',json_build_object('sub',pg_temp.schedule_id(102),
  'session_id',pg_temp.schedule_id(202),'role','authenticated')::text,true);
select lives_ok($$select id,cleaning_target_id,maid_profile_id,notified_room_id_snapshot
  from public.cleaning_assignments$$,'actual authenticated query preserves old explicit assignment columns');
select lives_ok($$select id,cleaning_target_id,revision,reason_code from public.cleaning_target_schedule_revisions$$,
  'actual authenticated query preserves old schedule columns under unchanged RLS');
select throws_ok($$select notified_reservation_schedule_snapshot from public.cleaning_assignments$$,
  '42501',null,'actual authenticated SELECT cannot expose notified raw JSON');
select throws_ok($$select reservation_schedule_snapshot from public.cleaning_target_schedule_revisions$$,
  '42501',null,'actual authenticated SELECT cannot expose creation raw JSON');
select throws_ok($$select public.get_assignment_schedule_read(pg_temp.schedule_id(2),pg_temp.schedule_id(202),
  array[pg_temp.schedule_id(2001)],true,'maid')$$,'42501',null,'browser cannot bypass application read adapter through RPC');
reset role;
set local role anon;
select throws_ok($$select notified_reservation_schedule_snapshot from public.cleaning_assignments$$,
  '42501',null,'anon cannot expose raw notified JSON');
select throws_ok($$select reservation_schedule_snapshot from public.cleaning_target_schedule_revisions$$,
  '42501',null,'anon cannot expose raw creation JSON');
reset role;
create temp table schedule_read_digest(value text);
insert into schedule_read_digest select md5(string_agg(data,'|' order by data)) from (
  select to_jsonb(t)::text data from public.cleaning_targets t union all
  select to_jsonb(t)::text from public.cleaning_assignments t union all
  select to_jsonb(t)::text from public.cleaning_target_schedule_revisions t union all
  select to_jsonb(t)::text from public.audit_events t union all
  select to_jsonb(t)::text from private.command_executions t union all
  select to_jsonb(t)::text from public.notifications t
) evidence;
select pg_temp.schedule_read(pg_temp.schedule_id(2),pg_temp.schedule_id(202),
  array[(select assignment_id from schedule_cases where label='checkout')],true);
select is((select md5(string_agg(data,'|' order by data)) from (
  select to_jsonb(t)::text data from public.cleaning_targets t union all
  select to_jsonb(t)::text from public.cleaning_assignments t union all
  select to_jsonb(t)::text from public.cleaning_target_schedule_revisions t union all
  select to_jsonb(t)::text from public.audit_events t union all
  select to_jsonb(t)::text from private.command_executions t union all
  select to_jsonb(t)::text from public.notifications t
) evidence),(select value from schedule_read_digest),'schedule read changes zero business or side-effect rows');
select * from finish();
rollback;
