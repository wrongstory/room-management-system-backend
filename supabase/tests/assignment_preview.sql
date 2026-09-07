begin;
select no_plan();

create function pg_temp.pid(n integer) returns uuid language sql immutable as $$
  select ('29000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid
$$;
insert into auth.users(id) select pg_temp.pid(100+n) from generate_series(1,8) n;
select public.bootstrap_first_developer_profile(pg_temp.pid(8),pg_temp.pid(108),'프리뷰 개발자','프리뷰 개발자',
  '0008','preview-developer-test-hash','preview-developer-bootstrap');
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
  login_sequence,role,status,must_change_password)
select pg_temp.pid(n),pg_temp.pid(100+n),'프리뷰'||n,'프리뷰'||n,'프리뷰'||n,'프리뷰'||n,0,
  case when n=1 then 'admin'::public.app_role else 'maid'::public.app_role end,'active',false
from generate_series(1,7) n;
update public.profiles set status='inactive' where id=pg_temp.pid(4);
update public.profiles set status='upload_only' where id=pg_temp.pid(5);
update public.profiles set status='departed' where id=pg_temp.pid(6);

insert into public.availability_versions(id,maid_profile_id,week_start,version,submitted_at)
select pg_temp.pid(200+n),pg_temp.pid(n),'2038-06-07',1,'2038-06-06 13:00+09'
from generate_series(2,6) n;
insert into public.availability_days(availability_version_id,work_date,available)
select pg_temp.pid(200+n),'2038-06-07'::date+d,n<>3
from generate_series(2,6) n cross join generate_series(0,6) d;

create function pg_temp.add_target(n integer,p_status public.cleaning_target_status,p_date date default '2038-06-07')
returns uuid language plpgsql as $$
declare v_room public.rooms; v_type public.room_types; v_id uuid:=pg_temp.pid(300+n);
begin
  select * into v_room from public.rooms order by room_number offset n limit 1;
  select * into v_type from public.room_types where id=v_room.room_type_id;
  insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,
    effective_service_date,available_from,due_at,status,assignment_version,room_type_snapshot,fee_snapshot,
    template_snapshot,created_by)
  values(v_id,v_room.id,'additional','manual_room_request','preview-target-'||n,p_date,p_date,
    (p_date::timestamp+interval '10 hours') at time zone 'Asia/Seoul',
    (p_date::timestamp+interval '20 hours') at time zone 'Asia/Seoul',p_status,2,
    jsonb_build_object('code',v_type.code,'roomNumber',v_room.room_number,'elevatorZone',v_room.elevator_zone),
    v_type.base_cleaning_fee,jsonb_build_object('durationMinutes',999),pg_temp.pid(1));
  if p_status in ('draft_assigned','notified') then
    insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,changed_by,notified_at)
    values(pg_temp.pid(400+n),v_id,pg_temp.pid(2),n,2,pg_temp.pid(1),
      case when p_status='notified' then '2038-06-06 13:00+09'::timestamptz end);
  end if;
  return v_id;
end;
$$;
select pg_temp.add_target(1,'draft_assigned');
select pg_temp.add_target(2,'notified');
select pg_temp.add_target(3,'unassigned');
select pg_temp.add_target(4,'unassigned','2038-06-08');
select pg_temp.add_target(5,'notified','2038-06-06');
insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,
  assignment_revision,template_snapshot,room_snapshot)
values(pg_temp.pid(505),pg_temp.pid(305),pg_temp.pid(405),pg_temp.pid(2),1,'scheduled',2,'{}','{}');

create function pg_temp.ledger_snapshot() returns jsonb language plpgsql as $$
declare name text; value jsonb; result jsonb:='{}';
begin
  foreach name in array array['public.cleaning_targets','public.cleaning_assignments','public.cleaning_attempts',
    'public.assignment_change_requests','public.availability_versions','public.availability_days','public.notifications',
    'private.notification_outbox','public.audit_events','private.command_executions','public.reservations',
    'public.checkout_cleaning_obligations','public.cleaning_target_schedule_revisions'] loop
    execute format('select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),''[]''::jsonb) from %s t',name) into value;
    result:=result||jsonb_build_object(name,value);
  end loop;
  return result;
end;
$$;
create temp table snapshots(label text primary key,value jsonb);
insert into snapshots values('before-unconfirmed',pg_temp.ledger_snapshot());
select is(public.get_assignment_duration_policy(pg_temp.pid(1)),null::jsonb,'fresh config has no confirmed policy');
insert into snapshots values('unconfirmed',private.assignment_preview_snapshot_at(pg_temp.pid(1),'2038-06-07','2038-06-07 08:00+09'));
select is((select value->'durationPolicy' from snapshots where label='unconfirmed'),'null'::jsonb,'preview never copies demo durations');
select is(pg_temp.ledger_snapshot(),(select value from snapshots where label='before-unconfirmed'),'unconfirmed snapshot changes no ledger');
select is((select count(*)::integer from public.assignment_duration_policy_versions),0,'preview does not seed config');

select throws_ok($$select public.confirm_assignment_duration_policy(pg_temp.pid(1),0,0,40,50,60,'preview-invalid-policy',repeat('a',64))$$,
  '22023','INVALID_ASSIGNMENT_DURATION_POLICY','zero duration denied');
select throws_ok($$select public.confirm_assignment_duration_policy(pg_temp.pid(1),0,30,null,50,60,'preview-null-policy',repeat('a',64))$$,
  '22023','INVALID_ASSIGNMENT_DURATION_POLICY','partial config denied');
insert into snapshots values('policy1',public.confirm_assignment_duration_policy(pg_temp.pid(1),0,30,40,50,60,'preview-policy-one',repeat('1',64)));
select is(public.confirm_assignment_duration_policy(pg_temp.pid(1),0,30,40,50,60,'preview-policy-one',repeat('1',64)),
  (select value from snapshots where label='policy1'),'policy exact retry replays');
select throws_ok($$select public.confirm_assignment_duration_policy(pg_temp.pid(1),0,31,40,50,60,'preview-policy-one',repeat('2',64))$$,
  '23505','IDEMPOTENCY_KEY_REUSED','policy changed payload conflict');
select throws_ok($$select public.confirm_assignment_duration_policy(pg_temp.pid(1),0,31,40,50,60,'preview-policy-stale',repeat('2',64))$$,
  '40001','ASSIGNMENT_DURATION_POLICY_VERSION_CONFLICT','policy stale version fails');
select is((public.get_assignment_duration_policy(pg_temp.pid(1))->>'standardMinutes')::integer,30,'confirmed test duration used');

insert into snapshots values('before-confirmed',pg_temp.ledger_snapshot());
insert into snapshots values('confirmed',private.assignment_preview_snapshot_at(pg_temp.pid(1),'2038-06-07','2038-06-07 08:00+09'));
select is(pg_temp.ledger_snapshot(),(select value from snapshots where label='before-confirmed'),'confirmed snapshot changes all ledgers zero');
select is((select count(*)::integer from jsonb_array_elements((select value->'targets' from snapshots where label='confirmed'))),4,
  'today target board includes cross-day active workflow');
select is((select item->>'blockedReason' from jsonb_array_elements((select value->'targets' from snapshots where label='confirmed')) item
  where item->>'cleaningTargetId'=pg_temp.pid(305)::text),'ASSIGNMENT_PREVIEW_ACTIVE_WORKFLOW_UNRESOLVED','cross-day attempt remaining duration is not invented');
select is((select count(*)::integer from jsonb_array_elements((select value->'maids' from snapshots where label='confirmed')) m
  where m->>'role'='maid' and m->>'status'='active' and (m->>'available')::boolean and m->>'availabilityVersion' is not null),1,
  'only active submitted available maid is eligible');
select ok(not (select value::text from snapshots where label='confirmed') ~ 'durationMinutes|defaultDurationMinutes|guest_name|phone|requestHash|photoSlots',
  'snapshot safe projection excludes demo/template/PII/hash');
select is((select count(*)::integer from jsonb_array_elements((select value->'targets' from snapshots where label='confirmed')) t
  where t->'currentAssignment'<>'null'::jsonb),3,'draft notified and active fixed assignments retained');
select is((private.assignment_preview_snapshot_at(pg_temp.pid(1),'2038-06-08','2038-06-07 08:00+09')->>'serviceDate'),'2038-06-08','tomorrow accepted');
select throws_ok($$select private.assignment_preview_snapshot_at(pg_temp.pid(1),'2038-06-09','2038-06-07 08:00+09')$$,
  '22023','ASSIGNMENT_PREVIEW_DATE_NOT_ALLOWED','out of today tomorrow denied');
select throws_ok($$select private.assignment_preview_snapshot_at(pg_temp.pid(2),'2038-06-07','2038-06-07 08:00+09')$$,
  '42501','ADMIN_REQUIRED','maid snapshot forbidden');
select throws_ok($$select private.assignment_preview_snapshot_at(pg_temp.pid(8),'2038-06-07','2038-06-07 08:00+09')$$,
  '42501','ADMIN_REQUIRED','developer snapshot forbidden');
select throws_ok($$select public.confirm_assignment_duration_policy(pg_temp.pid(8),1,31,40,50,60,'preview-developer-write',repeat('2',64))$$,
  '42501','ADMIN_REQUIRED','developer config forbidden');
select throws_ok($$select public.confirm_assignment_duration_policy(pg_temp.pid(2),1,31,40,50,60,'preview-maid-write',repeat('2',64))$$,
  '42501','ADMIN_REQUIRED','maid config forbidden');
select ok((select relrowsecurity from pg_class where oid='public.assignment_duration_policy_versions'::regclass),'policy RLS enabled');
select ok(not has_table_privilege('authenticated','public.assignment_duration_policy_versions','INSERT,UPDATE,DELETE'), 'authenticated direct config write revoked');
select ok(not has_table_privilege('service_role','public.assignment_duration_policy_versions','INSERT,UPDATE,DELETE'), 'service direct config write revoked');
select ok(not has_function_privilege('anon','public.get_assignment_preview_snapshot(uuid,date)','EXECUTE'), 'anon snapshot RPC denied');
select ok(not has_function_privilege('authenticated','public.get_assignment_preview_snapshot(uuid,date)','EXECUTE'), 'authenticated snapshot RPC denied');
select ok(has_function_privilege('service_role','public.get_assignment_preview_snapshot(uuid,date)','EXECUTE'), 'server snapshot RPC allowed');
select is((select provolatile::text from pg_proc where oid='public.get_assignment_preview_snapshot(uuid,date)'::regprocedure),'s','public snapshot is STABLE');
select is((select provolatile::text from pg_proc where oid='private.assignment_preview_snapshot_at(uuid,date,timestamptz)'::regprocedure),'s','private snapshot is STABLE');

select throws_ok($$update public.assignment_duration_policy_versions set standard_minutes=99 where version=1$$,
  '23514','ASSIGNMENT_DURATION_POLICY_IMMUTABLE','confirmed snapshot immutable');
select throws_ok($$delete from public.assignment_duration_policy_versions where version=1$$,
  '23514','ASSIGNMENT_DURATION_POLICY_IMMUTABLE','policy delete forbidden');
select public.confirm_assignment_duration_policy(pg_temp.pid(1),1,35,45,55,65,'preview-policy-two',repeat('2',64));
select is((select status from public.assignment_duration_policy_versions where version=1),'retired','old confirmed retired');
select is((select standard_minutes from public.assignment_duration_policy_versions where version=1),30,'retirement preserves exact values');
select is((select count(*)::integer from public.assignment_duration_policy_versions where status='confirmed'),1,'exactly one current confirmed policy');
select throws_ok($$update public.assignment_duration_policy_versions set status='confirmed' where version=1$$,
  '23514','ASSIGNMENT_DURATION_POLICY_IMMUTABLE','retired cannot resurrect');
select is((select count(*)::integer from public.list_developer_audit_events(pg_temp.pid(8),array['assignment.duration_policy_confirmed'])),2,
  'developer can read config audit events');
select ok((select bool_and(summary ?& array['policyVersion','status','standardMinutes','premiumMinutes','oceanPremiumMinutes','oceanFamilyMinutes']
  and (select count(*) from jsonb_object_keys(summary))=6)
  from public.list_developer_audit_events(pg_temp.pid(8),array['assignment.duration_policy_confirmed'])), 'config audit safe six-field allowlist');

-- Production reservation command creates tomorrow's private planned checkout;
-- preview may inspect it but cannot materialize it or create an attempt.
insert into public.cleaning_template_versions(room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,published_at,created_by)
select id,'checkout',1,'published',999,'[]',now(),pg_temp.pid(1) from public.room_types;
create temp table plan_room as select * from public.rooms order by room_number offset 60 limit 1;
insert into public.room_pin_sync_events(room_id,sync_status,pin_version,reason_code,actor_profile_id,effective_at)
select id,'verified',1,'TEST',pg_temp.pid(1),now() from plan_room;
select public.create_reservation(pg_temp.pid(1),pg_temp.pid(900),id,'2038-06-07 16:00+09','2038-06-08 11:00+09',
  2,null,state_version,'preview-create-plan',repeat('8',64)) from plan_room;
insert into snapshots values('before-plan',pg_temp.ledger_snapshot());
insert into snapshots values('plan',private.assignment_preview_snapshot_at(pg_temp.pid(1),'2038-06-08','2038-06-07 08:00+09'));
select is((select item->'blockedReason' from jsonb_array_elements((select value->'targets' from snapshots where label='plan')) item
  where item->'domainIdentity'->>'reservationId'=pg_temp.pid(900)::text),'null'::jsonb,'future private checkout plan is preview eligible');
select is(pg_temp.ledger_snapshot(),(select value from snapshots where label='before-plan'),'checkout preview leaves obligations and attempts unchanged');
select ok((select status='private' and current_cleaning_target_id is null from public.checkout_cleaning_obligations
  where reservation_id=pg_temp.pid(900)),'preview does not materialize planned target');
select is((select count(*)::integer from public.cleaning_attempts a join public.cleaning_targets t on t.id=a.cleaning_target_id
  where t.reservation_id=pg_temp.pid(900)),0,'private planned checkout remains attempt zero');

-- A safe source-reason helper does not permit invalid kind/source or null schedule.
select is(private.assignment_preview_source_reason(
  jsonb_populate_record(null::public.cleaning_targets,to_jsonb(t)||jsonb_build_object('cleaning_kind','stayover')),30,'2038-06-07 08:00+09'),
  'ASSIGNMENT_PREVIEW_SOURCE_INVALID','source kind mismatch fails closed') from public.cleaning_targets t where id=pg_temp.pid(303);
select is(private.assignment_preview_source_reason(
  jsonb_populate_record(null::public.cleaning_targets,to_jsonb(t)||jsonb_build_object('available_from',null)),30,'2038-06-07 08:00+09'),
  'ASSIGNMENT_PREVIEW_INVALID_SCHEDULE','missing available time fails closed') from public.cleaning_targets t where id=pg_temp.pid(303);
select is(private.assignment_preview_source_reason(
  jsonb_populate_record(null::public.cleaning_targets,to_jsonb(t)||jsonb_build_object('due_at',null)),null,'2038-06-07 08:00+09'),
  'ASSIGNMENT_PREVIEW_DURATION_POLICY_UNCONFIRMED','null deadline never falls back to template duration') from public.cleaning_targets t where id=pg_temp.pid(303);

-- Real stayover creation shares reservation/room/window invariants with #1.
insert into public.cleaning_template_versions(room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,published_at,created_by)
select id,'stayover',1,'published',999,'[]',now(),pg_temp.pid(1) from public.room_types;
update public.reservations set actual_check_in_at=check_in_at where id=pg_temp.pid(900);
select public.create_manual_cleaning_request(pg_temp.pid(1),pg_temp.pid(901),r.id,pg_temp.pid(900),'stayover',
  '2038-06-07','2038-06-07 17:00+09','2038-06-07 18:00+09',r.state_version,'TEST','preview-stayover-create',repeat('9',64))
from public.rooms r join plan_room p on p.id=r.id;
select is(private.assignment_preview_source_reason(t,30,'2038-06-07 16:00+09'),null::text,'actual stayover command target passes source validator')
from public.cleaning_targets t where id=pg_temp.pid(901);
select is(private.assignment_preview_source_reason(jsonb_populate_record(null::public.cleaning_targets,
  to_jsonb(t)||jsonb_build_object('due_at','2038-06-08 12:00+09')),30,'2038-06-07 16:00+09'),
  'ASSIGNMENT_PREVIEW_SOURCE_INVALID','stayover beyond checkout rejected') from public.cleaning_targets t where id=pg_temp.pid(901);
select is(private.assignment_preview_source_reason(jsonb_populate_record(null::public.cleaning_targets,
  to_jsonb(t)||jsonb_build_object('available_from','2038-06-07 15:00+09')),30,'2038-06-07 14:00+09'),
  'ASSIGNMENT_PREVIEW_SOURCE_INVALID','stayover before actual checkin rejected') from public.cleaning_targets t where id=pg_temp.pid(901);
select is(private.assignment_preview_source_reason(jsonb_populate_record(null::public.cleaning_targets,
  to_jsonb(t)||jsonb_build_object('source','manual_room_request','cleaning_kind','additional')),30,'2038-06-07 16:00+09'),
  'ASSIGNMENT_PREVIEW_SOURCE_INVALID','additional request overlapping actual occupancy rejected') from public.cleaning_targets t where id=pg_temp.pid(901);
update public.reservations set actual_check_in_at=null where id=pg_temp.pid(900);
select is(private.assignment_preview_source_reason(t,30,'2038-06-07 16:00+09'),'ASSIGNMENT_PREVIEW_SOURCE_INVALID',
  'stayover without actual occupancy rejected') from public.cleaning_targets t where id=pg_temp.pid(901);
update public.reservations set status='cancelled',cancelled_at='2038-06-07 15:00+09' where id=pg_temp.pid(900);
select is(private.assignment_preview_source_reason(t,30,'2038-06-07 16:00+09'),'ASSIGNMENT_PREVIEW_SOURCE_INVALID',
  'stayover cancelled reservation rejected') from public.cleaning_targets t where id=pg_temp.pid(901);
update public.reservations set status='active',cancelled_at=null,actual_check_in_at=check_in_at where id=pg_temp.pid(900);

-- Reclean retains the original maid identity even when they become unavailable.
select pg_temp.add_target(10,'notified');
insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,
  assignment_revision,ended_at,end_reason,template_snapshot,room_snapshot)
values(pg_temp.pid(510),pg_temp.pid(310),pg_temp.pid(410),pg_temp.pid(2),1,'rejected',2,
  '2038-06-07 13:00+09','INSPECTION_REJECTED','{}','{}');
update public.cleaning_assignments set is_current=false,ended_at='2038-06-07 13:00+09',change_reason_code='INSPECTION_REJECTED'
where id=pg_temp.pid(410);
insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,effective_service_date,
  available_from,due_at,status,assignment_version,room_type_snapshot,fee_snapshot,template_snapshot,
  created_by,reclean_of_attempt_id,reclean_maid_profile_id)
select pg_temp.pid(311),room_id,'reclean','inspection_reclean','preview-reclean','2038-06-07','2038-06-07',
  '2038-06-07 14:00+09','2038-06-07 20:00+09','unassigned',1,room_type_snapshot,0,template_snapshot,
  pg_temp.pid(1),pg_temp.pid(510),pg_temp.pid(2) from public.cleaning_targets where id=pg_temp.pid(310);
select is(private.assignment_preview_source_reason(t,30,'2038-06-07 13:00+09'),null::text,'reclean valid original rejected maid source')
from public.cleaning_targets t where id=pg_temp.pid(311);
select is(private.assignment_preview_source_reason(jsonb_populate_record(null::public.cleaning_targets,
  to_jsonb(t)||jsonb_build_object('reclean_maid_profile_id',pg_temp.pid(3))),30,'2038-06-07 13:00+09'),
  'RECLEAN_MAID_IMMUTABLE','reclean different maid fails source validation') from public.cleaning_targets t where id=pg_temp.pid(311);
update public.profiles set status='inactive' where id=pg_temp.pid(2);
insert into snapshots values('reclean-unavailable',private.assignment_preview_snapshot_at(pg_temp.pid(1),'2038-06-07','2038-06-07 13:00+09'));
select is((select item->>'recleanMaidProfileId' from jsonb_array_elements((select value->'targets' from snapshots where label='reclean-unavailable')) item
  where item->>'cleaningTargetId'=pg_temp.pid(311)::text),pg_temp.pid(2)::text,'unavailable reclean keeps immutable original maid identity');
select is((select item->>'status' from jsonb_array_elements((select value->'maids' from snapshots where label='reclean-unavailable')) item
  where item->>'maidProfileId'=pg_temp.pid(2)::text),'inactive','unavailable reclean maid cannot become optimizer candidate');

-- RPC execution ACL is checked through real database roles, not only catalogs.
set local role anon;
select throws_ok($$select public.get_assignment_preview_snapshot('29000000-0000-4000-8000-000000000001',current_date)$$,
  '42501',null,'anon actual snapshot execution denied');
select throws_ok($$select public.get_assignment_duration_policy('29000000-0000-4000-8000-000000000001')$$,
  '42501',null,'anon actual policy read execution denied');
reset role;
set local role authenticated;
select throws_ok($$select public.confirm_assignment_duration_policy('29000000-0000-4000-8000-000000000001',2,30,40,50,60,'preview-forbidden-write',repeat('a',64))$$,
  '42501',null,'authenticated actual config execution denied');
select throws_ok($$select * from public.assignment_duration_policy_versions$$,'42501',null,'Data API role raw policy table access denied');
reset role;
select ok(not exists(select 1 from pg_proc f cross join lateral aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) acl
  where f.oid in ('public.get_assignment_preview_snapshot(uuid,date)'::regprocedure,
    'public.get_assignment_duration_policy(uuid)'::regprocedure,
    'public.confirm_assignment_duration_policy(uuid,bigint,integer,integer,integer,integer,text,text)'::regprocedure)
  and acl.grantee=0 and acl.privilege_type='EXECUTE'),'PUBLIC execute is revoked for every new RPC');
-- A second admin allows the fixture to deactivate the first without violating last-admin protection.
update public.profiles set role='admin' where id=pg_temp.pid(7);
update public.profiles set status='inactive' where id=pg_temp.pid(1);
select throws_ok($$select private.assignment_preview_snapshot_at(pg_temp.pid(1),'2038-06-07','2038-06-07 08:00+09')$$,
  '42501','ACTIVE_ACCOUNT_REQUIRED','latest inactive admin snapshot access denied');
select throws_ok($$select public.get_assignment_duration_policy(pg_temp.pid(1))$$,
  '42501','ACTIVE_ACCOUNT_REQUIRED','latest inactive admin config read denied');
update public.profiles set status='active' where id=pg_temp.pid(1);

select pg_temp.add_target(12,'unassigned');
update public.cleaning_targets set room_id=(select room_id from public.cleaning_targets where id=pg_temp.pid(305))
  where id=pg_temp.pid(312);
insert into snapshots values('previous-room',private.assignment_preview_snapshot_at(pg_temp.pid(1),'2038-06-07','2038-06-07 08:00+09'));
select is((select item->>'blockedReason' from jsonb_array_elements((select value->'targets' from snapshots where label='previous-room')) item
  where item->>'cleaningTargetId'=pg_temp.pid(312)::text),'PREVIOUS_ROOM_WORKFLOW_ACTIVE',
  'other target prior room workflow blocks reassignment even with another available maid');
update public.profiles set status='active' where id=pg_temp.pid(2);
select pg_temp.add_target(15,'notified','2038-06-08');
insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,
  assignment_revision,template_snapshot,room_snapshot)
values(pg_temp.pid(515),pg_temp.pid(315),pg_temp.pid(415),pg_temp.pid(2),1,'scheduled',2,'{}','{}');
insert into snapshots values('future-fixed',private.assignment_preview_snapshot_at(pg_temp.pid(1),'2038-06-07','2038-06-07 08:00+09'));
select is((select count(*)::integer from jsonb_array_elements((select value->'targets' from snapshots where label='future-fixed')) item
  where item->>'cleaningTargetId'=pg_temp.pid(315)::text),0,'future scheduled attempt is not today fixed workload');

-- PostgreSQL READ ONLY rejects hidden mutations, including writes through helpers.
set local transaction_read_only = on;
select lives_ok($$select private.assignment_preview_snapshot_at(pg_temp.pid(1),'2038-06-07','2038-06-07 08:00+09')$$,
  'snapshot and nested validators execute in read-only transaction');
select * from finish();
rollback;
