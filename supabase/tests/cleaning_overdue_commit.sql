begin;
select no_plan();

create function pg_temp.ocid(n integer) returns uuid language sql immutable as $$
  select ('30850000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
insert into auth.users(id) select pg_temp.ocid(100+n) from generate_series(1,6) n;
select public.bootstrap_first_developer_profile(pg_temp.ocid(6),pg_temp.ocid(106),
  '지연 확정 개발자','지연 확정 개발자','0006','overdue-commit-developer-hash','overdue-commit-bootstrap');
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
  login_sequence,role,status,must_change_password)
select pg_temp.ocid(n),pg_temp.ocid(100+n),'overdue-commit-'||n,'overdue-commit-'||n,
  'overdue-commit-'||n,'overdue-commit-'||n,0,
  case when n<=2 then 'admin' else 'maid' end::public.app_role,'active',false
from generate_series(1,5) n;
insert into public.availability_versions(id,maid_profile_id,week_start,version,submitted_at)
values(pg_temp.ocid(203),pg_temp.ocid(3),'2038-06-07',1,'2038-06-06 13:00+09'),
  (pg_temp.ocid(213),pg_temp.ocid(3),'2038-05-31',1,'2038-05-30 13:00+09'),
  (pg_temp.ocid(204),pg_temp.ocid(4),'2038-06-07',1,'2038-06-06 13:00+09'),
  (pg_temp.ocid(214),pg_temp.ocid(4),'2038-05-31',1,'2038-05-30 13:00+09');
insert into public.availability_days(availability_version_id,work_date,available)
select pg_temp.ocid(203),'2038-06-07'::date+d,true from generate_series(0,6) d
union all select pg_temp.ocid(213),'2038-05-31'::date+d,false from generate_series(0,6) d
union all select pg_temp.ocid(204),'2038-06-07'::date+d,false from generate_series(0,6) d
union all select pg_temp.ocid(214),'2038-05-31'::date+d,true from generate_series(0,6) d;

create function pg_temp.overdue_commit_fixture(n integer,p_day date,p_status public.cleaning_target_status,
  p_sequence integer default null,p_maid uuid default pg_temp.ocid(3)) returns uuid language plpgsql as $$
declare v_room public.rooms; v_type public.room_types; v_id uuid:=pg_temp.ocid(1000+n);
begin
  select * into v_room from public.rooms order by room_number offset(n%100) limit 1;
  select * into v_type from public.room_types where id=v_room.room_type_id;
  insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,
    effective_service_date,available_from,due_at,status,assignment_version,room_type_snapshot,fee_snapshot,
    template_snapshot,created_by)
  values(v_id,v_room.id,'additional','manual_room_request','overdue-commit-target-'||n,p_day,p_day,
    (p_day::timestamp+interval '10 hours') at time zone 'Asia/Seoul',
    (p_day::timestamp+interval '20 hours') at time zone 'Asia/Seoul',p_status,2,
    jsonb_build_object('code',v_type.code,'roomNumber',v_room.room_number,'elevatorZone',v_room.elevator_zone),
    v_type.base_cleaning_fee,'{}',pg_temp.ocid(1));
  if p_sequence is not null then
    insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,
      changed_by,notified_at)
    values(pg_temp.ocid(2000+n),v_id,p_maid,p_sequence,2,pg_temp.ocid(1),
      case when p_status<>'draft_assigned' then '2038-06-06 13:00+09'::timestamptz end);
  end if;
  insert into public.cleaning_target_schedule_revisions(cleaning_target_id,revision,effective_service_date,
    available_from,due_at,reason_code,changed_by)
  select id,1,effective_service_date,available_from,due_at,'TEST',pg_temp.ocid(1)
    from public.cleaning_targets where id=v_id;
  return v_id;
end
$$;
select pg_temp.overdue_commit_fixture(1,'2038-06-06','unassigned');
select pg_temp.overdue_commit_fixture(2,'2038-06-06','draft_assigned',2);
select pg_temp.overdue_commit_fixture(3,'2038-06-07','draft_assigned',3);
select pg_temp.overdue_commit_fixture(4,'2038-06-08','draft_assigned',4);
select pg_temp.overdue_commit_fixture(5,'2038-06-06','draft_assigned',5);
update public.cleaning_targets set due_at=due_at+interval '1 minute' where id=pg_temp.ocid(1005);
select pg_temp.overdue_commit_fixture(6,'2038-06-06','draft_assigned',1,pg_temp.ocid(4));
select pg_temp.overdue_commit_fixture(7,'2038-06-06','approved',70);
select pg_temp.overdue_commit_fixture(8,'2038-06-06','cancelled',80);
create function pg_temp.overdue_commit_ledgers() returns jsonb language plpgsql stable as $$
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
end
$$;
-- END OVERDUE COMMIT FIXTURE
create temp table overdue_commit_results(label text primary key,value jsonb);
insert into overdue_commit_results values('before',pg_temp.overdue_commit_ledgers());
insert into overdue_commit_results values('today',private.assignment_commit_impact_at('2038-06-07','2038-06-07 08:00+09'));
insert into overdue_commit_results values('tomorrow',private.assignment_commit_impact_at('2038-06-08','2038-06-07 08:00+09'));
select is(pg_temp.overdue_commit_ledgers(),(select value from overdue_commit_results where label='before'),'preflight is read-only');
select is((select jsonb_array_length(value->'committableDrafts') from overdue_commit_results where label='today'),2,'today includes today and old safe drafts');
select is((select jsonb_array_length(value->'blockedDrafts') from overdue_commit_results where label='today'),2,'stale old draft and today unavailable remain blocked');
select is((select value#>>'{remainingUnassignedTargets,0,serviceDate}' from overdue_commit_results where label='today'),'2038-06-06','old unassigned impact retains date');
select is((select value#>>'{committableDrafts,0,serviceDate}' from overdue_commit_results where label='today'),'2038-06-06','committable old draft retains date');
select is((select availability_version from private.assignment_commit_candidates_at('2038-06-07','2038-06-07 08:00+09') where target_id=pg_temp.ocid(1002)),1,'old draft uses current planning week version');
select is((select availability_day_available from private.assignment_commit_candidates_at('2038-06-07','2038-06-07 08:00+09') where target_id=pg_temp.ocid(1002)),true,'old unavailable original date does not override today availability');
select is((select reason_code from private.assignment_commit_candidates_at('2038-06-07','2038-06-07 08:00+09') where target_id=pg_temp.ocid(1006)),'ASSIGNMENT_MAID_UNAVAILABLE','old available date does not authorize unavailable today');
select is((select reason_code from private.assignment_commit_candidates_at('2038-06-07','2038-06-07 08:00+09') where target_id=pg_temp.ocid(1005)),'ASSIGNMENT_DRAFT_STALE_SCHEDULE','stale snapshots remain blocked');
select is((select jsonb_array_length(value->'committableDrafts') from overdue_commit_results where label='tomorrow'),3,'tomorrow includes exact tomorrow and safe unfinished drafts');
select is((select count(*)::integer from private.assignment_commit_candidates_at('2038-06-08','2038-06-07 08:00+09') where assignment_service_date<'2038-06-08'),4,'tomorrow evaluates old drafts including blocked drafts');
select is((select count(*)::integer from private.assignment_commit_candidates_at('2038-06-09','2038-06-07 08:00+09')),0,'outside today/tomorrow has no candidates');
select ok(private.assignment_planning_includes_date('2038-06-06','2038-06-08','2038-06-07 08:00+09'),'planning helper includes old unfinished work for tomorrow');
select ok(not private.assignment_planning_includes_date('infinity','2038-06-07','2038-06-07 08:00+09'),'planning helper rejects nonfinite dates');
select ok(not private.assignment_planning_includes_date(null,'2038-06-07','2038-06-07 08:00+09'),'planning helper rejects null');

create function pg_temp.old_commit(n integer,p_key text,p_version integer default 1,p_hash text default repeat('a',64)) returns jsonb language sql as $$
  select private.commit_and_notify_assignments_at(pg_temp.ocid(1),'2038-06-07',
    private.assignment_commit_impact_at('2038-06-07','2038-06-07 08:00+09')->>'impactFingerprint',
    jsonb_build_array(jsonb_build_object('cleaningTargetId',pg_temp.ocid(1000+n),
      'expectedAssignmentVersion',2,'expectedAvailabilityVersion',p_version)),
    p_key,p_hash,'2038-06-07 08:00+09')
$$;
select throws_ok($$select pg_temp.old_commit(2,'overdue-commit-stale-availability',2)$$,'40001','ASSIGNMENT_AVAILABILITY_STALE','stale planning availability CAS rejects');
select throws_ok($$select pg_temp.old_commit(6,'overdue-commit-unavailable')$$,'23514','ASSIGNMENT_MAID_UNAVAILABLE','old-date availability cannot authorize today');
select throws_ok($$select pg_temp.old_commit(5,'overdue-commit-stale-schedule')$$,'23514','ASSIGNMENT_DRAFT_STALE_SCHEDULE','stale schedule rejects old commit');
select is(pg_temp.overdue_commit_ledgers(),(select value from overdue_commit_results where label='before'),'failed commits preserve every ledger and receipt');
insert into overdue_commit_results values('assignment-snapshot',
  (select to_jsonb(assignment)-'notified_at'-'notified_room_id_snapshot'-'notified_room_number_snapshot'-'notified_reservation_schedule_snapshot'
    from public.cleaning_assignments assignment where id=pg_temp.ocid(2002)));
insert into overdue_commit_results values('target-snapshot',
  (select to_jsonb(target)-'status'-'updated_at' from public.cleaning_targets target where id=pg_temp.ocid(1002)));

insert into overdue_commit_results values('commit',pg_temp.old_commit(2,'overdue-commit-success'));
select is((select value->>'serviceDate' from overdue_commit_results where label='commit'),'2038-06-07','response outer service date is requested planning day');
select is((select value#>>'{notifiedAssignments,0,serviceDate}' from overdue_commit_results where label='commit'),'2038-06-06','notified assignment response retains original date');
select is((select service_date::text from public.cleaning_assignments where id=pg_temp.ocid(2002)),'2038-06-06','stored assignment date remains original');
select is((select sequence_number from public.cleaning_assignments where id=pg_temp.ocid(2002)),2,'stored assignment sequence remains original');
select is((select to_jsonb(assignment)-'notified_at'-'notified_room_id_snapshot'-'notified_room_number_snapshot'-'notified_reservation_schedule_snapshot'
  from public.cleaning_assignments assignment where id=pg_temp.ocid(2002)),
  (select value from overdue_commit_results where label='assignment-snapshot'),'exact assignment owner/date/revision/windows/changer/creation snapshot preserved');
select is((select notified_reservation_schedule_snapshot from public.cleaning_assignments where id=pg_temp.ocid(2002)),
  (select reservation_schedule_snapshot from public.cleaning_target_schedule_revisions where cleaning_target_id=pg_temp.ocid(1002)
    order by revision desc limit 1),'#328 first notice copies exact frozen no-reservation schedule with unknown actuals');
select is((select to_jsonb(target)-'status'-'updated_at' from public.cleaning_targets target where id=pg_temp.ocid(1002)),
  (select value from overdue_commit_results where label='target-snapshot'),'exact target/source/schedule/version snapshot preserved');
select is((select maid_profile_id from public.cleaning_assignments where id=pg_temp.ocid(2002)),pg_temp.ocid(3),'stored owner remains original');
select is((select original_service_date::text||'/'||effective_service_date::text||'/'||carryover_count from public.cleaning_targets where id=pg_temp.ocid(1002)),'2038-06-06/2038-06-06/0','target dates and carryover count remain original');
select is((select after_state->>'serviceDate' from public.audit_events where event_type='assignment.notified' and entity_id=pg_temp.ocid(2002)),'2038-06-07','immutable notified audit records actual planning day');
select is((select count(*)::integer from public.cleaning_attempts where cleaning_target_id=pg_temp.ocid(1002)),0,'commit cannot create an attempt');
select is((select count(*)::integer from public.notifications where cleaning_target_id=pg_temp.ocid(1002)),1,'one typed inbox notice');
select is((select count(*)::integer from private.notification_delivery_outbox outbox join public.notifications notice on notice.id=outbox.notification_id where notice.cleaning_target_id=pg_temp.ocid(1002)),1,'one typed delivery outbox');
insert into overdue_commit_results values('after',pg_temp.overdue_commit_ledgers());
select is(pg_temp.old_commit(2,'overdue-commit-success'),(select value from overdue_commit_results where label='commit'),'same-key retry returns exact receipt');
select is(pg_temp.overdue_commit_ledgers(),(select value from overdue_commit_results where label='after'),'retry creates no ledger or notice');
select throws_ok($$select pg_temp.old_commit(2,'overdue-commit-success',1,repeat('b',64))$$,'IDEMPOTENCY_KEY_REUSED','changed payload cannot reuse receipt');
select throws_ok($$select private.submit_weekly_availability_at(pg_temp.ocid(3),'2038-06-07',array['2038-06-08'::date],1,'overdue-today-unavailable','2038-06-07 08:00+09')$$,'40001','ASSIGNMENT_AVAILABILITY_STALE','actual new version cannot remove today after old task commit');
select is(pg_temp.overdue_commit_ledgers(),(select value from overdue_commit_results where label='after'),'rejected availability replacement rolls back immutable versions and receipts');
select lives_ok($$select private.submit_weekly_availability_at(pg_temp.ocid(3),'2038-06-07',array['2038-06-07'::date,'2038-06-08'::date],1,'overdue-future-unavailable','2038-06-07 08:00+09')$$,'unrelated future day can be unavailable; no blanket future block');
select is((select available from public.availability_days day join public.availability_versions version on version.id=day.availability_version_id where version.maid_profile_id=pg_temp.ocid(3) and version.is_current and day.work_date='2038-06-09'),false,'unrelated future day actually became unavailable');

update public.cleaning_assignments set is_current=false,ended_at='2038-06-07 09:00+09' where id=pg_temp.ocid(2002);
update public.cleaning_targets set status='unassigned' where id=pg_temp.ocid(1002);
select pg_temp.old_commit(3,'overdue-current-success',2);
select throws_ok($$select private.submit_weekly_availability_at(pg_temp.ocid(3),'2038-06-07',array['2038-06-08'::date],2,'overdue-current-unavailable','2038-06-07 08:00+09')$$,'40001','ASSIGNMENT_AVAILABILITY_STALE','original same-day availability guard remains after old assignment ended');
update public.cleaning_assignments set is_current=false,ended_at='2038-06-07 09:00+09' where id=pg_temp.ocid(2003);
update public.cleaning_targets set status='unassigned' where id=pg_temp.ocid(1003);
select lives_ok($$select private.submit_weekly_availability_at(pg_temp.ocid(3),'2038-06-07',array['2038-06-08'::date],2,'overdue-ended-unavailable','2038-06-07 09:00+09')$$,'ended assignments do not leave a ghost today guard');

select ok(not has_function_privilege('anon','private.assignment_planning_includes_date(date,date,timestamptz)','EXECUTE'),'anon cannot execute private planning helper');
select ok(not has_function_privilege('authenticated','private.assignment_planning_includes_date(date,date,timestamptz)','EXECUTE'),'authenticated cannot execute private planning helper');
select ok(not has_function_privilege('service_role','private.assignment_planning_includes_date(date,date,timestamptz)','EXECUTE'),'service role cannot execute private planning helper directly');
select ok(not has_function_privilege('service_role','private.prevent_notified_assignment_unavailability()','EXECUTE'),'service role cannot execute availability trigger directly');
set local role service_role;
select throws_ok($$select public.get_assignment_commit_impact('30850000-0000-4000-8000-000000000003','2038-06-07')$$,'ADMIN_REQUIRED','maid cannot use admin commit-impact RPC');
select throws_ok($$select public.get_assignment_commit_impact('30850000-0000-4000-8000-000000000006','2038-06-07')$$,'ADMIN_REQUIRED','developer cannot use business commit-impact RPC');
reset role;
update public.profiles set status='inactive' where id=pg_temp.ocid(5);
set local role service_role;
select throws_ok($$select public.get_assignment_commit_impact('30850000-0000-4000-8000-000000000005','2038-06-07')$$,'ACTIVE_ACCOUNT_REQUIRED','inactive actor cannot use business commit-impact RPC');
reset role;
update public.profiles set status='upload_only' where id=pg_temp.ocid(5);
set local role service_role;
select throws_ok($$select public.get_assignment_commit_impact('30850000-0000-4000-8000-000000000005','2038-06-07')$$,'ACTIVE_ACCOUNT_REQUIRED','upload-only actor cannot use business commit-impact RPC');
reset role;
-- Technical resource bounds include every visible candidate, not just selected
-- or committable rows. Successful/failed probes roll back all synthetic rows.
create function pg_temp.overdue_commit_limit(p_total integer) returns jsonb language plpgsql as $$
declare v_existing integer; v_result jsonb;
begin
  begin
    select count(*)::integer into v_existing from public.cleaning_targets target
      where private.assignment_planning_includes_date(target.effective_service_date,'2038-06-07','2038-06-07 08:00+09')
        and target.status in ('unassigned','draft_assigned');
    insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,
      effective_service_date,available_from,due_at,status,room_type_snapshot,fee_snapshot,template_snapshot,created_by)
    select pg_temp.ocid(6000+n),target.room_id,target.cleaning_kind,target.source,'overdue-commit-limit-'||n,
      target.original_service_date,target.effective_service_date,target.available_from,target.due_at,
      'unassigned',target.room_type_snapshot,target.fee_snapshot,target.template_snapshot,target.created_by
    from public.cleaning_targets target cross join generate_series(1,p_total-v_existing) n
    where target.id=pg_temp.ocid(1001);
    v_result:=private.assignment_commit_impact_at('2038-06-07','2038-06-07 08:00+09');
    raise exception using errcode='PZ308',message='rollback successful commit limit probe';
  exception when sqlstate 'PZ308' then null;
  end;
  return v_result;
end
$$;
select is((select jsonb_array_length(value->'committableDrafts')+jsonb_array_length(value->'blockedDrafts')+
  jsonb_array_length(value->'remainingUnassignedTargets') from (select pg_temp.overdue_commit_limit(1000) value) probe),
  1000,'exact1000 complete candidate impact accepted without truncation');
select throws_ok($$select pg_temp.overdue_commit_limit(1001)$$,'54000','ASSIGNMENT_COMMIT_LIMIT_EXCEEDED',
  '1001 candidate sentinel rejects whole impact before partial fingerprint');
-- #446: tomorrow notification of an old target keeps the original schedule but
-- cannot be activated by today's scheduler. This is an actual DB test only
-- when the explicitly approved release runner executes it.
select pg_temp.overdue_commit_fixture(9,'2038-06-06','draft_assigned',99);
select private.commit_and_notify_assignments_at(pg_temp.ocid(1),'2038-06-08',
  private.assignment_commit_impact_at('2038-06-08','2038-06-07 08:00+09')->>'impactFingerprint',
  jsonb_build_array(jsonb_build_object('cleaningTargetId',pg_temp.ocid(1009),'expectedAssignmentVersion',2,
    'expectedAvailabilityVersion',(select version from public.availability_versions
      where maid_profile_id=pg_temp.ocid(3) and week_start='2038-06-07' and is_current))),
  'tomorrow-overdue-planning-proof',repeat('b',64),'2038-06-07 08:00+09');
select is((select private.assignment_requested_planning_date(a) from public.cleaning_assignments a
  where id=pg_temp.ocid(2009)),'2038-06-08'::date,'immutable notification binds tomorrow planning day');
select is((select service_date from public.cleaning_assignments where id=pg_temp.ocid(2009)),
  '2038-06-06'::date,'original assignment date is not rewritten');
select is((select private.activation_reason_at(t,a,'2038-06-07 08:00+09')
  from public.cleaning_targets t join public.cleaning_assignments a on a.cleaning_target_id=t.id and a.is_current
  where t.id=pg_temp.ocid(1009)),'CLEANING_SERVICE_DATE_NOT_DUE','tomorrow backlog cannot activate today');
select ok(not has_function_privilege('authenticated',
  'private.assignment_requested_planning_date(public.cleaning_assignments)','execute'),
  'planning evidence helper is not exposed to authenticated callers');
-- Source-only regression fixture for the exact successor evidence reader. This
-- does not claim to exercise the public checkout/replan command. Every probe
-- rolls its synthetic successor back, preserving the original notified row and
-- audit proof for the next case; no migration/DB execution is implied here.
create function pg_temp.planning_successor_probe(p_maid uuid,p_end_reason text,p_schedule_reason text,
  p_sequence integer default 99) returns date language plpgsql as $$
declare old_a public.cleaning_assignments; next_a public.cleaning_assignments;
  target public.cleaning_targets; result date;
begin
  begin
    select * into strict old_a from public.cleaning_assignments where id=pg_temp.ocid(2009);
    update public.cleaning_assignments set is_current=false,ended_at='2038-06-07 09:00+09',
      change_reason_code=p_end_reason where id=old_a.id;
    update public.cleaning_targets set assignment_version=assignment_version+1
      where id=old_a.cleaning_target_id returning * into target;
    insert into public.cleaning_target_schedule_revisions(cleaning_target_id,revision,effective_service_date,
      available_from,due_at,reason_code,changed_by)
    values(target.id,target.assignment_version,target.effective_service_date,target.available_from,target.due_at,
      p_schedule_reason,pg_temp.ocid(1));
    insert into public.cleaning_assignments(cleaning_target_id,maid_profile_id,sequence_number,revision,
      changed_by,notified_at)
    values(target.id,p_maid,p_sequence,target.assignment_version,pg_temp.ocid(1),'2038-06-07 09:00+09')
    returning * into next_a;
    result:=private.assignment_requested_planning_date(next_a);
    raise exception using errcode='PZ446',message='rollback planning successor fixture';
  exception when sqlstate 'PZ446' then null;
  end;
  return result;
end $$;
insert into overdue_commit_results values('before-successor-probes',pg_temp.overdue_commit_ledgers());
select is(pg_temp.planning_successor_probe(pg_temp.ocid(3),'MANUAL_CHECKOUT_RESCHEDULE','MANUAL_CHECKOUT'),
  '2038-06-08'::date,'same-owner immediate checkout successor retains exact tomorrow notification proof');
select is(pg_temp.planning_successor_probe(pg_temp.ocid(3),'RESERVATION_SCHEDULE_CHANGED','RESERVATION_SCHEDULE_CHANGED'),
  '2038-06-08'::date,'same-owner immediate schedule successor retains exact tomorrow notification proof');
select is(pg_temp.planning_successor_probe(pg_temp.ocid(4),'MANUAL_CHECKOUT_RESCHEDULE','MANUAL_CHECKOUT'),
  '2038-06-06'::date,'different owner cannot inherit a previous maid planning-day proof');
select is(pg_temp.planning_successor_probe(pg_temp.ocid(3),'OPERATIONAL_CHANGE','MANUAL_CHECKOUT'),
  '2038-06-06'::date,'ordinary reassignment is not a checkout successor merely because the schedule reason matches');
select is(pg_temp.planning_successor_probe(pg_temp.ocid(3),'MANUAL_CHECKOUT_RESCHEDULE','RESERVATION_SCHEDULE_CHANGED'),
  '2038-06-06'::date,'mismatched end and schedule reasons do not inherit a planning-day proof');
select is(pg_temp.planning_successor_probe(pg_temp.ocid(3),'MANUAL_CHECKOUT_RESCHEDULE','MANUAL_CHECKOUT',100),
  '2038-06-06'::date,'changed sequence is not silently treated as the same planning successor');
select is(pg_temp.overdue_commit_ledgers(),(select value from overdue_commit_results where label='before-successor-probes'),
  'successor proof probes preserve original assignments, snapshots, audit and side-effect ledgers');
select * from finish();
rollback;
