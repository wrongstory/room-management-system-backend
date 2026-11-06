begin;
select no_plan();

create function pg_temp.uid(n integer) returns uuid language sql immutable as $$
  select ('a2640000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
create temp table test_clock as
  select date_trunc('day',transaction_timestamp() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul' as at_time;
create function pg_temp.test_time() returns timestamptz language sql stable as $$
  select at_time from test_clock
$$;

insert into auth.users(id)
select pg_temp.uid(100+n) from generate_series(1,5) n;
insert into auth.users(id) values(pg_temp.uid(106));
select public.bootstrap_first_developer_profile(
  pg_temp.uid(6),pg_temp.uid(106),'수행불가 개발자','수행불가 개발자','0264',
  'assignment-unavailability-developer-hash','assignment-unavailability-bootstrap'
);
insert into public.profiles(
  id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
  login_sequence,role,status,must_change_password
)
select pg_temp.uid(n),pg_temp.uid(100+n),'unavailable-'||n,'unavailable-'||n,
  'unavailable-'||n,'unavailable-'||n,0,
  case when n in (1,3) then 'admin' else 'maid' end::public.app_role,
  'active',false
from generate_series(1,5) n;
insert into auth.sessions(id,user_id)
select pg_temp.uid(200+n),pg_temp.uid(100+n) from generate_series(1,5) n;

create function pg_temp.make_target(n integer,p_with_attempt boolean,p_started boolean default false)
returns void language plpgsql as $$
declare room_id uuid;
begin
  select id into room_id from public.rooms order by room_number offset (30+n) limit 1;
  insert into public.cleaning_targets(
    id,room_id,cleaning_kind,source,source_key,original_service_date,effective_service_date,
    available_from,due_at,status,assignment_version,room_type_snapshot,fee_snapshot,
    template_snapshot,created_by
  ) values (
    pg_temp.uid(300+n),room_id,'additional','manual_room_request','unavailability-target-'||n,
    (pg_temp.test_time() at time zone 'Asia/Seoul')::date,(pg_temp.test_time() at time zone 'Asia/Seoul')::date,pg_temp.test_time(),pg_temp.test_time()+interval '1 day',
    'notified',2,'{}',12000,'{}',pg_temp.uid(1)
  );
  insert into public.cleaning_assignments(
    id,cleaning_target_id,maid_profile_id,sequence_number,revision,notified_at,changed_by
  ) values (
    pg_temp.uid(400+n),pg_temp.uid(300+n),pg_temp.uid(2),n,2,pg_temp.test_time(),pg_temp.uid(1)
  );
  if p_with_attempt then
    insert into public.cleaning_attempts(
      id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,
      assignment_revision,template_snapshot,room_snapshot
    ) values (
      pg_temp.uid(500+n),pg_temp.uid(300+n),pg_temp.uid(400+n),pg_temp.uid(2),1,
      'scheduled',2,'{}',jsonb_build_object('roomId',room_id)
    );
    if p_started then
      perform private.execute_cleaning_attempt_at(
        pg_temp.uid(2),pg_temp.uid(500+n),1,pg_temp.uid(400+n),2,
        'unavailability-start-'||n,repeat('1',64),'start',pg_temp.test_time()
      );
    end if;
  end if;
end $$;

select pg_temp.make_target(1,true,true);
create function pg_temp.recall(v bigint,k text default 'admin-recall-fixture') returns jsonb language sql as $$
 select public.force_recall_cleaning_assignment(pg_temp.uid(1),pg_temp.uid(201),pg_temp.uid(301),
   pg_temp.uid(401),2,pg_temp.uid(501),v,k,repeat('a',64))
$$;
select throws_ok($$select pg_temp.recall(2)$$,'55000','ASSIGNMENT_FORCE_RECALL_NOT_ALLOWED','running work uses the existing workflow');
select private.execute_cleaning_attempt_at(pg_temp.uid(2),pg_temp.uid(501),2,pg_temp.uid(401),2,
  'force-recall-complete',repeat('b',64),'complete_field_work',transaction_timestamp());
create temp table work_before as select started_at,field_completed_at,ended_at,maid_profile_id,execution_version
  from public.cleaning_attempts where id=pg_temp.uid(501);
select private.issue_attempt_capability((select a from public.cleaning_attempts a where a.id=pg_temp.uid(501)),
  'upload_submit',pg_temp.uid(1),transaction_timestamp());
select private.emit_notification_v1('assignment.prestart_new_notified',pg_temp.uid(1),pg_temp.uid(2),
  'cleaning_assignment',pg_temp.uid(401)::text,'합성 배정','합성 통보',
  (select room_id from public.cleaning_targets where id=pg_temp.uid(301)),pg_temp.uid(301),pg_temp.uid(301),clock_timestamp());
select is(public.get_assignment_force_recall_candidate(pg_temp.uid(1),pg_temp.uid(201),pg_temp.uid(301))
  ->'candidate'->>'expectedExecutionVersion','3','administrator sees the actual version');
select throws_ok($$select pg_temp.recall(2)$$,'40001','ASSIGNMENT_VERSION_CONFLICT','stale version leaves completed work intact');
select throws_ok($$select public.force_recall_cleaning_assignment(pg_temp.uid(2),pg_temp.uid(202),pg_temp.uid(301),
  pg_temp.uid(401),2,pg_temp.uid(501),3,'force-recall-maid',repeat('a',64))$$,'42501','ADMIN_REQUIRED','maid cannot force recall');
create temp table recalled as select pg_temp.recall(3) as result;
select is((select result->>'status' from recalled),'unassigned','target can now be reassigned');
select is(pg_temp.recall(3),(select result from recalled),'lost response replays the original receipt');
select ok((select a.status='superseded' and not private.attempt_blocks_assignment(a)
  and (a.started_at,a.field_completed_at,a.ended_at,a.maid_profile_id,a.execution_version)
  is not distinct from (b.started_at,b.field_completed_at,b.ended_at,b.maid_profile_id,b.execution_version)
  from public.cleaning_attempts a cross join work_before b where a.id=pg_temp.uid(501)),
  'original work timestamps and actor survive and do not block a successor');
select ok(not exists(select 1 from private.attempt_capability_grants g where g.attempt_id=pg_temp.uid(501)
  and not exists(select 1 from private.attempt_capability_revocations r where r.capability_id=g.id)),
  'no live capability remains');
select ok(not exists(select 1 from public.notifications where source_entity_id=pg_temp.uid(401)::text
  and event_family='assignment.prestart_new_notified' and resolved_at is null),'old actionable notice resolved');
select is((select count(*) from public.audit_events where entity_id=pg_temp.uid(401) and event_type='assignment.force_recalled'),1::bigint,'one admin audit on retry');
select is(public.get_assignment_force_recall_candidate(pg_temp.uid(1),pg_temp.uid(201),pg_temp.uid(301))->'candidate','null'::jsonb,'ended work cannot be recalled again');

-- Verify actual scheduling rather than only checking an unassigned status.
insert into public.availability_versions(maid_profile_id,week_start,version,submitted_at)
select pg_temp.uid(4),d-(extract(isodow from d)::int-1),1,now()
from (select effective_service_date as d from public.cleaning_targets where id=pg_temp.uid(301)) day;
insert into public.availability_days(availability_version_id,work_date,available)
select v.id,v.week_start+n,true from public.availability_versions v cross join generate_series(0,6)n
where v.maid_profile_id=pg_temp.uid(4);
select public.save_cleaning_assignment_draft(pg_temp.uid(1),pg_temp.uid(301),pg_temp.uid(4),1,3,'successor-draft',repeat('d',64));
create temp table impact as select public.get_assignment_commit_impact(pg_temp.uid(1),
  (select effective_service_date from public.cleaning_targets where id=pg_temp.uid(301))) as value;
select public.commit_and_notify_assignments(pg_temp.uid(1),(select effective_service_date from public.cleaning_targets where id=pg_temp.uid(301)),
  value->>'impactFingerprint',(select jsonb_agg(jsonb_build_object('cleaningTargetId',item->>'cleaningTargetId',
    'expectedAssignmentVersion',(item->>'targetAssignmentVersion')::bigint,'expectedAvailabilityVersion',(item->>'expectedAvailabilityVersion')::bigint))
    from jsonb_array_elements(value->'committableDrafts') item where item->>'cleaningTargetId'=pg_temp.uid(301)::text),
  'successor-notified',repeat('e',64)) from impact;
select ok(exists(select 1 from public.cleaning_assignments where cleaning_target_id=pg_temp.uid(301) and maid_profile_id=pg_temp.uid(4)
  and is_current and notified_at is not null),'new maid owns a separate notified revision');
select * from finish();
rollback;
