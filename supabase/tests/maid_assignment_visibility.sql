begin;
select no_plan();

create function pg_temp.vid(n integer) returns uuid language sql immutable
as $$ select ('44000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid $$;

insert into auth.users(id) select pg_temp.vid(n+100) from generate_series(1,4) n;
select public.bootstrap_first_developer_profile(pg_temp.vid(4),pg_temp.vid(104),
  'visibility developer','visibility developer','0004','visibility-developer-phone-hash','visibility-bootstrap-0001');
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,
  login_id,login_id_normalized,login_sequence,role,status)
select pg_temp.vid(n),pg_temp.vid(n+100),'visibility-'||n,'visibility-'||n,
  'visibility-'||n,'visibility-'||n,0,
  case when n=1 then 'admin' else 'maid' end::public.app_role,'active'
from generate_series(1,3) n;

insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,
  original_service_date,effective_service_date,available_from,due_at,status,
  assignment_version,room_type_snapshot,fee_snapshot,template_snapshot,created_by)
select pg_temp.vid(n+300),(select id from public.rooms order by room_number offset n limit 1),
  'additional','manual_room_request','visibility-target-'||n,
  '2039-10-01','2039-10-01','2039-10-01 09:00+09','2039-10-01 15:00+09',
  'draft_assigned',1,'{}',10000,'{}',pg_temp.vid(1)
from generate_series(1,3) n;

-- Same target: never-notified draft -> notified own -> never-notified own -> other maid.
-- Each prior revision really ends; no timestamp is erased to synthesize history.
do $$
declare n integer;
begin
  for n in 1..4 loop
    update public.cleaning_targets set assignment_version=n where id=pg_temp.vid(301);
    insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,
      sequence_number,revision,changed_by,notified_at)
    values(pg_temp.vid(n+400),pg_temp.vid(301),pg_temp.vid(case when n=4 then 3 else 2 end),
      1,n,pg_temp.vid(1),case when n in (2,4) then '2039-09-30 18:00+09'::timestamptz end);
    if n in (2,3) then
      insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,
        attempt_number,status,assignment_revision,template_snapshot,room_snapshot)
      values(pg_temp.vid(n+500),pg_temp.vid(301),pg_temp.vid(n+400),pg_temp.vid(2),
        n,'superseded',n,'{}','{}');
    end if;
    if n<4 then
      update public.cleaning_assignments set is_current=false,ended_at='2039-09-30 19:00+09',
        change_reason_code='VISIBILITY_TEST_REVISED' where id=pg_temp.vid(n+400);
    end if;
  end loop;
end;
$$;

insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,
  sequence_number,revision,changed_by,notified_at)
values
  (pg_temp.vid(405),pg_temp.vid(302),pg_temp.vid(2),2,1,pg_temp.vid(1),'2039-09-30 18:00+09'),
  (pg_temp.vid(406),pg_temp.vid(303),pg_temp.vid(2),3,1,pg_temp.vid(1),null);
insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,
  attempt_number,status,assignment_revision,template_snapshot,room_snapshot)
select pg_temp.vid(n+500),pg_temp.vid(n+297),pg_temp.vid(n+400),pg_temp.vid(2),
  1,'scheduled',1,'{}','{}' from generate_series(5,6) n;

insert into public.assignment_change_requests(id,cleaning_target_id,assignment_id,maid_profile_id,
  reason_code,status,source_assignment_revision,source_target_assignment_version)
select pg_temp.vid(n+600),pg_temp.vid(301),pg_temp.vid(n+400),pg_temp.vid(2),
  'PERSONAL_REASON','superseded',n,n from generate_series(2,3) n;
insert into public.cleaning_submissions(id,cleaning_attempt_id,client_submission_id,version,
  status,photo_manifest,submitted_by,superseded_at)
select pg_temp.vid(n+700),pg_temp.vid(n+500),pg_temp.vid(n+800),1,
  'superseded','[]',pg_temp.vid(2),clock_timestamp() from generate_series(2,3) n;
-- Historical revoked lease metadata follows the existing terminal-lease contract;
-- it never grants current PIN access for a superseded attempt.
insert into public.room_pin_access_leases(id,room_id,cleaning_target_id,assignment_id,
  attempt_id,pin_version,issued_to,issued_at,expires_at,revoked_at,revoke_reason_code)
select pg_temp.vid(n+900),t.room_id,t.id,pg_temp.vid(n+400),pg_temp.vid(n+500),
  1,pg_temp.vid(2),'2039-10-01 09:00+09','2039-10-01 10:00+09',
  '2039-10-01 09:30+09','VISIBILITY_HISTORY_REVOKED'
from generate_series(2,3) n cross join public.cleaning_targets t where t.id=pg_temp.vid(301);
insert into public.cleaning_target_schedule_revisions(cleaning_target_id,revision,
  effective_service_date,available_from,due_at,reason_code,changed_by)
select pg_temp.vid(301),n,'2039-10-01','2039-10-01 09:00+09','2039-10-01 15:00+09',
  'VISIBILITY_TEST',pg_temp.vid(1) from generate_series(1,4) n;

create function pg_temp.visibility_ledger() returns jsonb language sql stable as $$
  select jsonb_build_object('assignments',(select jsonb_agg(to_jsonb(a) order by id) from public.cleaning_assignments a),
    'targets',(select jsonb_agg(to_jsonb(t) order by id) from public.cleaning_targets t),
    'attempts',(select jsonb_agg(to_jsonb(a) order by id) from public.cleaning_attempts a),
    'audit',(select count(*) from public.audit_events),
    'notifications',(select count(*) from public.notifications),
    'outbox',(select count(*) from private.notification_outbox),
    'receipts',(select count(*) from private.command_executions))
$$;
create temporary table visibility_before as select pg_temp.visibility_ledger() as snapshot;

set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.vid(102)::text,true);
select is((select array_agg(id order by id) from public.cleaning_assignments),
  array[pg_temp.vid(402),pg_temp.vid(405)],'maid sees only own notified current and historical revisions');
select is((select count(*)::integer from public.cleaning_assignments where is_current),1,
  'current list excludes current own draft and current other maid');
select is((select array_agg(id order by id) from public.cleaning_assignments where cleaning_target_id=pg_temp.vid(301)),
  array[pg_temp.vid(402)],'history includes superseded notified self but no same-target drafts or other maid');
select is((select count(*)::integer from public.cleaning_assignments where id=pg_temp.vid(401)),0,'IDOR cannot read never-notified past draft');
select is((select count(*)::integer from public.cleaning_assignments where id=pg_temp.vid(403)),0,'later own never-notified draft remains hidden');
select is((select count(*)::integer from public.cleaning_assignments where id=pg_temp.vid(404)),0,'other maid notified revision remains hidden');
select is((select array_agg(id order by id) from public.cleaning_targets),array[pg_temp.vid(302)],
  'raw target is visible only through exact current own notified snapshot');
select is((select count(*)::integer from public.cleaning_targets where id=pg_temp.vid(301)),0,
  'past notified history does not expose current target version or new plan');
select is((select array_agg(revision order by revision) from public.cleaning_target_schedule_revisions),array[2::bigint],
  'schedule history exposes only exact notified revision even when every draft has identical schedule');
select is((select array_agg(id order by id) from public.cleaning_attempts),array[pg_temp.vid(502),pg_temp.vid(505)],
  'attempt relation cannot bypass the notified revision boundary');
select is((select array_agg(id order by id) from public.assignment_change_requests),array[pg_temp.vid(602)],
  'request history preserves notified source only');
select is((select array_agg(id order by id) from public.cleaning_submissions),array[pg_temp.vid(702)],
  'submission relation inherits notified attempt ownership');
select is((select array_agg(id order by id) from public.room_pin_access_leases),array[pg_temp.vid(902)],
  'PIN lease metadata cannot expose never-notified assignment');
select throws_ok($$update public.cleaning_assignments set notified_at=clock_timestamp() where id=pg_temp.vid(406)$$,
  '42501',null,'maid cannot self-notify hidden draft by DML');
select throws_ok($$delete from public.cleaning_assignments where id=pg_temp.vid(402)$$,
  '42501',null,'maid cannot delete notified history');

select set_config('request.jwt.claim.sub',pg_temp.vid(103)::text,true);
select is((select array_agg(id order by id) from public.cleaning_assignments),array[pg_temp.vid(404)],
  'new maid sees own notified revision but not previous maid history');
select is((select array_agg(id order by id) from public.cleaning_targets),array[pg_temp.vid(301)],
  'new current notified maid has current target access');

select set_config('request.jwt.claim.sub',pg_temp.vid(101)::text,true);
select is((select count(*)::integer from public.cleaning_assignments),6,'admin retains all draft/current/history');
select is((select count(*)::integer from public.cleaning_targets),3,'admin retains all targets');
select is((select count(*)::integer from public.cleaning_target_schedule_revisions),4,'admin retains every schedule revision');
select is((select count(*)::integer from public.cleaning_attempts),4,'admin retains every attempt');

select set_config('request.jwt.claim.sub',pg_temp.vid(104)::text,true);
select is((select count(*)::integer from public.cleaning_assignments),0,'developer does not inherit admin assignment RLS');
select is((select count(*)::integer from public.cleaning_targets),0,'developer cannot read targets');
reset role;
select is(pg_temp.visibility_ledger(),(select snapshot from visibility_before),
  'all persona reads and denied DML preserve assignments/targets/attempts/audit/notification/outbox/receipts');

set local role service_role;
select is(jsonb_array_length(public.list_assignment_change_requests(pg_temp.vid(2))),1,
  'service-role request projection cannot bypass notified source RLS');
select is(jsonb_array_length(public.list_assignment_change_requests(pg_temp.vid(1))),2,
  'admin request projection still includes all source revisions');
reset role;

select ok((select notified_room_id_snapshot=room_id and notified_room_number_snapshot=room_number
  from public.cleaning_assignments a join public.cleaning_targets t on t.id=a.cleaning_target_id
  join public.rooms r on r.id=t.room_id where a.id=pg_temp.vid(402)),
  'notified INSERT captures the actual room before later reassignment');
select ok((select notified_room_id_snapshot is null and notified_room_number_snapshot is null
  from public.cleaning_assignments where id=pg_temp.vid(406)),
  'never-notified draft has no notified room metadata');
select throws_ok($$update public.cleaning_assignments set notified_room_id_snapshot=
  (select id from public.rooms order by room_number desc limit 1) where id=pg_temp.vid(402)$$,
  '23514','ASSIGNMENT_NOTIFICATION_ROOM_IMMUTABLE','notified history room cannot be rewritten directly');
select throws_ok($$update public.cleaning_assignments set notified_room_number_snapshot='spoof'
  where id=pg_temp.vid(405)$$,'23514','ASSIGNMENT_NOTIFICATION_ROOM_IMMUTABLE',
  'notified room number snapshot cannot be overwritten');

-- No new-room fallback for a target whose old notified assignment has ended.
-- A target without dependent attempt/PIN FKs models reservation unassign + room replan.
insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,
  original_service_date,effective_service_date,status,assignment_version,
  room_type_snapshot,fee_snapshot,template_snapshot,created_by)
select pg_temp.vid(304),id,'additional','manual_room_request','visibility-moved-room',
  '2039-10-02','2039-10-02','notified',1,'{}',10000,'{}',pg_temp.vid(1)
from public.rooms order by room_number offset 20 limit 1;
insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,
  revision,changed_by,notified_at,notified_room_id_snapshot,notified_room_number_snapshot)
select pg_temp.vid(407),pg_temp.vid(304),pg_temp.vid(2),1,1,pg_temp.vid(1),clock_timestamp(),
  id,'caller-spoof' from public.rooms order by room_number desc limit 1;
select ok((select a.notified_room_id_snapshot=t.room_id and a.notified_room_number_snapshot<>'caller-spoof'
  from public.cleaning_assignments a join public.cleaning_targets t on t.id=a.cleaning_target_id
  where a.id=pg_temp.vid(407)),'caller-supplied room snapshot is replaced on notified INSERT');
update public.cleaning_assignments set is_current=false,ended_at=clock_timestamp() where id=pg_temp.vid(407);
update public.cleaning_targets set room_id=(select id from public.rooms order by room_number offset 21 limit 1),
  assignment_version=2,status='unassigned' where id=pg_temp.vid(304);
select ok((select a.notified_room_id_snapshot<>t.room_id
  from public.cleaning_assignments a join public.cleaning_targets t on t.id=a.cleaning_target_id
  where a.id=pg_temp.vid(407)),'past notified room survives target relocation without new-room leakage');
update public.cleaning_assignments set notified_at=clock_timestamp(),
  notified_room_id_snapshot=(select id from public.rooms order by room_number desc limit 1),
  notified_room_number_snapshot='caller-spoof' where id=pg_temp.vid(406);
select ok((select a.notified_room_id_snapshot=t.room_id and a.notified_room_number_snapshot<>'caller-spoof'
  from public.cleaning_assignments a join public.cleaning_targets t on t.id=a.cleaning_target_id
  where a.id=pg_temp.vid(406)),'first notification UPDATE captures room and ignores caller snapshot');

-- Current profile is re-evaluated even with the same previously issued JWT subject.
do $$
declare state public.account_status;
begin
  foreach state in array array['inactive','deactivation_pending','upload_only','departed']::public.account_status[] loop
    update public.profiles set status=state where id=pg_temp.vid(2);
    set local role authenticated;
    perform set_config('request.jwt.claim.sub',pg_temp.vid(102)::text,true);
    if exists(select 1 from public.cleaning_assignments)
      or exists(select 1 from public.cleaning_targets)
      or exists(select 1 from public.cleaning_attempts)
      or exists(select 1 from public.assignment_change_requests)
      or exists(select 1 from public.cleaning_target_schedule_revisions)
      or exists(select 1 from public.room_pin_access_leases)
      or exists(select 1 from public.cleaning_submissions) then
      raise exception 'restricted profile leaked assignment relations: %',state;
    end if;
    reset role;
  end loop;
end;
$$;
select pass('inactive/deactivation_pending/upload_only/departed JWT personas expose no assignment relations');

select throws_ok($$update public.cleaning_assignments set notified_at=null where id=pg_temp.vid(402)$$,
  '23514','ASSIGNMENT_NOTIFICATION_IMMUTABLE','past notification cannot be erased');
select throws_ok($$update public.cleaning_assignments set notified_at='2040-01-01' where id=pg_temp.vid(405)$$,
  '23514','ASSIGNMENT_NOTIFICATION_IMMUTABLE','notification timestamp cannot be rewritten');
select throws_ok($$update public.cleaning_assignments set notified_at=clock_timestamp() where id=pg_temp.vid(403)$$,
  '23514','ASSIGNMENT_NOTIFICATION_REQUIRES_CURRENT','ended never-notified draft cannot be retroactively disclosed');
select ok(not has_function_privilege('authenticated','private.preserve_assignment_notification_history()','EXECUTE')
  and not has_function_privilege('anon','private.preserve_assignment_notification_history()','EXECUTE'),
  'notification guard has no public client EXECUTE grant');
set local role anon;
select throws_ok($$select * from public.cleaning_assignments$$,'42501',null,'anon cannot read raw assignments');
reset role;

select * from finish();
rollback;
