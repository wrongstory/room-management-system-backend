begin;
select no_plan();

create function pg_temp.uid(n integer) returns uuid language sql immutable as $$
  select ('a2640000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
create temp table test_clock as
  select '2027-10-05 10:00:00+09'::timestamptz as at_time;
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
    '2027-10-05','2027-10-05','2027-10-05 09:00+09','2027-10-05 16:00+09',
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

select pg_temp.make_target(1,false);
select pg_temp.make_target(2,true,false);
select pg_temp.make_target(3,true,true);
select pg_temp.make_target(4,false);

select private.issue_attempt_capability(
  (select attempt from public.cleaning_attempts attempt where id=pg_temp.uid(503)),
  'finish_current',pg_temp.uid(1),pg_temp.test_time()
);
insert into private.offline_work_leases(
  id,actor_profile_id,attempt_id,assignment_id,assignment_revision,execution_version,
  profile_version,issued_at,expires_at,metadata_expires_at
) values (
  pg_temp.uid(903),pg_temp.uid(2),pg_temp.uid(503),pg_temp.uid(403),2,2,1,
  pg_temp.test_time(),pg_temp.test_time()+interval '2 hours',pg_temp.test_time()+interval '90 days'
);

create function pg_temp.cancel_assignment(
  n integer,p_key text,p_hash text default repeat('a',64),p_expected_version bigint default 2
) returns jsonb language sql as $$
  select private.cancel_unavailable_cleaning_assignment_at(
    pg_temp.uid(1),pg_temp.uid(201),pg_temp.uid(300+n),pg_temp.uid(400+n),p_expected_version,
    case when n in (2,3) then pg_temp.uid(500+n) end,
    case when n=2 then 1::bigint when n=3 then 2::bigint end,
    case n when 1 then 'MAID_DEPARTED' when 2 then 'MAID_INJURED' else 'MAID_UNAVAILABLE' end,
    p_key,p_hash,pg_temp.test_time()+make_interval(mins=>n)
  )
$$;

create temp table results(name text primary key,value jsonb);
insert into results values('not-started',pg_temp.cancel_assignment(1,'unavailable-not-started'));
select is((select status::text from public.cleaning_targets where id=pg_temp.uid(301)),
  'unassigned','not-started unavailable assignment returns to unassigned');
select ok((select not is_current and ended_at=pg_temp.test_time()+interval '1 minute'
  and change_reason_code='MAID_DEPARTED' from public.cleaning_assignments where id=pg_temp.uid(401)),
  'not-started assignment history is ended without deletion');
select is((select count(*)::int from private.assignment_unavailability_cancellations
  where assignment_id=pg_temp.uid(401)),1,'unavailability evidence is append-only exactly once');
select is((select count(*)::int from public.notifications
  where event_family='assignment.prestart_unassigned' and recipient_profile_id=pg_temp.uid(2)
    and source_entity_id=pg_temp.uid(401)::text),1,'old maid receives assignment cancellation inbox notice');
select is((select count(*)::int from public.notifications
  where event_family='assignment.reassignment_required'
    and source_entity_kind='assignment_unavailability_cancellation'),2,
  'each active administrator receives the reassignment-required notice');
select is((select count(*)::int from private.notification_delivery_outbox o
  join public.notifications n on n.id=o.notification_id
  where n.event_family='assignment.reassignment_required'),1,
  'only the non-actor administrator receives a push outbox item');
select is(pg_temp.cancel_assignment(1,'unavailable-not-started'),
  (select value from results where name='not-started'),'lost response replay returns the original result');
select throws_ok($$select pg_temp.cancel_assignment(1,'unavailable-not-started',repeat('b',64))$$,
  '23505','IDEMPOTENCY_KEY_REUSED','same key with another request hash is rejected');
select is((select count(*)::int from private.assignment_unavailability_cancellations
  where assignment_id=pg_temp.uid(401)),1,'replay creates no duplicate cancellation evidence');

insert into results values('scheduled',pg_temp.cancel_assignment(2,'unavailable-scheduled'));
select ok((select status='superseded' and execution_version=2 and ended_at=pg_temp.test_time()+interval '2 minutes'
  and end_reason='MAID_INJURED' from public.cleaning_attempts where id=pg_temp.uid(502)),
  'scheduled attempt is superseded without physical work');
select ok((select not private.attempt_blocks_assignment(a) from public.cleaning_attempts a
  where id=pg_temp.uid(502)),'superseded scheduled attempt no longer blocks reassignment');

insert into results values('in-progress',pg_temp.cancel_assignment(3,'unavailable-in-progress'));
select ok((select status='interrupted' and execution_version=3 and ended_at=pg_temp.test_time()+interval '3 minutes'
  and end_reason='MAID_UNAVAILABLE' from public.cleaning_attempts where id=pg_temp.uid(503)),
  'in-progress attempt is interrupted with immutable reason evidence');
select ok((select not private.attempt_blocks_assignment(a) from public.cleaning_attempts a
  where id=pg_temp.uid(503)),'proven unavailable interruption releases the target for reassignment');
select is((select count(*)::int from private.attempt_capability_revocations revocation
  join private.attempt_capability_grants grant_row on grant_row.id=revocation.capability_id
  where grant_row.attempt_id=pg_temp.uid(503)
    and revocation.reason_code='ASSIGNMENT_UNAVAILABLE'),1,
  'in-progress cancellation revokes any issued limited capability');
select is((select count(*)::int from public.earnings earning
  join public.cleaning_submissions submission on submission.id=earning.submission_id
  join public.cleaning_attempts attempt on attempt.id=submission.cleaning_attempt_id
  where attempt.cleaning_target_id in(pg_temp.uid(301),pg_temp.uid(302),pg_temp.uid(303))),0,
  'cancellation creates no earning for the unavailable maid');
select is((select count(*)::int from private.offline_work_lease_revocations r
  join private.offline_work_leases l on l.id=r.lease_id where l.attempt_id=pg_temp.uid(503)
    and r.reason_code='ATTEMPT_CHANGED'),1,
  'in-progress cancellation revokes the offline work lease');

create temp table before_failure as
select jsonb_build_object(
  'target',(select to_jsonb(t) from public.cleaning_targets t where id=pg_temp.uid(304)),
  'assignment',(select to_jsonb(a) from public.cleaning_assignments a where id=pg_temp.uid(404)),
  'events',(select count(*) from private.assignment_unavailability_cancellations),
  'notifications',(select count(*) from public.notifications),
  'audit',(select count(*) from public.audit_events),
  'receipts',(select count(*) from private.command_executions)
) value;
select throws_ok($$select pg_temp.cancel_assignment(4,'unavailable-stale-version',p_expected_version=>99)$$,
  '40001','ASSIGNMENT_VERSION_CONFLICT','stale target version is rejected');
select is((select jsonb_build_object(
  'target',(select to_jsonb(t) from public.cleaning_targets t where id=pg_temp.uid(304)),
  'assignment',(select to_jsonb(a) from public.cleaning_assignments a where id=pg_temp.uid(404)),
  'events',(select count(*) from private.assignment_unavailability_cancellations),
  'notifications',(select count(*) from public.notifications),
  'audit',(select count(*) from public.audit_events),
  'receipts',(select count(*) from private.command_executions)
)),(select value from before_failure),'failed CAS leaves all business and side-effect ledgers unchanged');

select throws_ok($$select private.cancel_unavailable_cleaning_assignment_at(
  pg_temp.uid(2),pg_temp.uid(202),pg_temp.uid(304),pg_temp.uid(404),2,null,null,
  'MAID_UNAVAILABLE','unavailable-maid-denied',repeat('c',64),pg_temp.test_time())$$,
  '42501','ADMIN_REQUIRED','maid cannot cancel another assignment through the admin command');

-- A rejected zero-fee reclean cannot be transferred in place.  End that
-- immutable responsibility and create one ordinary paid replacement target.
create temp table reclean_room as
select id room_id from public.rooms order by room_number offset 50 limit 1;
insert into public.cleaning_targets(
  id,room_id,cleaning_kind,source,source_key,original_service_date,effective_service_date,
  available_from,due_at,status,assignment_version,room_type_snapshot,fee_snapshot,
  template_snapshot,created_by
)
select pg_temp.uid(305),room_id,'additional','manual_room_request','unavailability-reclean-origin',
  '2027-10-05','2027-10-05','2027-10-05 08:00+09','2027-10-05 14:00+09',
  'notified',2,'{}',15000,jsonb_build_object('contract','origin-paid'),pg_temp.uid(1)
from reclean_room;
insert into public.cleaning_assignments(
  id,cleaning_target_id,maid_profile_id,sequence_number,revision,notified_at,changed_by
) values (
  pg_temp.uid(405),pg_temp.uid(305),pg_temp.uid(2),50,2,pg_temp.test_time()-interval '2 hours',pg_temp.uid(1)
);
insert into public.cleaning_attempts(
  id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,
  assignment_revision,ended_at,end_reason,template_snapshot,room_snapshot
)
select pg_temp.uid(505),pg_temp.uid(305),pg_temp.uid(405),pg_temp.uid(2),1,'rejected',2,
  pg_temp.test_time()-interval '1 hour','INSPECTION_REJECTED','{}',jsonb_build_object('roomId',room_id)
from reclean_room;
update public.cleaning_assignments set is_current=false,
  ended_at=pg_temp.test_time()-interval '1 hour',change_reason_code='INSPECTION_REJECTED'
where id=pg_temp.uid(405);
update public.cleaning_targets set status='approved' where id=pg_temp.uid(305);
insert into public.cleaning_submissions(
  id,cleaning_attempt_id,client_submission_id,version,status,photo_manifest,submitted_by
) values (pg_temp.uid(605),pg_temp.uid(505),pg_temp.uid(705),1,'rejected','{}',pg_temp.uid(2));
insert into public.inspection_decisions(id,submission_id,decision,reason_code,decided_by)
values(pg_temp.uid(805),pg_temp.uid(605),'rejected','QUALITY_REWORK',pg_temp.uid(1));
insert into public.cleaning_targets(
  id,room_id,cleaning_kind,source,source_key,original_service_date,effective_service_date,
  available_from,due_at,status,assignment_version,room_type_snapshot,fee_snapshot,
  template_snapshot,created_by,reclean_of_attempt_id,reclean_maid_profile_id,
  reclean_of_submission_id,reclean_of_inspection_decision_id
)
select pg_temp.uid(306),room_id,'reclean','inspection_reclean','unavailability-reclean-current',
  '2027-10-05','2027-10-05','2027-10-05 14:00+09','2027-10-05 18:00+09',
  'notified',2,'{}',0,jsonb_build_object('contract','zero-fee-reclean'),pg_temp.uid(1),
  pg_temp.uid(505),pg_temp.uid(2),pg_temp.uid(605),pg_temp.uid(805)
from reclean_room;
insert into public.cleaning_assignments(
  id,cleaning_target_id,maid_profile_id,sequence_number,revision,notified_at,changed_by
) values (pg_temp.uid(406),pg_temp.uid(306),pg_temp.uid(2),51,2,pg_temp.test_time(),pg_temp.uid(1));
insert into results values('reclean',private.cancel_unavailable_cleaning_assignment_at(
  pg_temp.uid(1),pg_temp.uid(201),pg_temp.uid(306),pg_temp.uid(406),2,null,null,
  'MAID_INJURED','unavailable-reclean',repeat('e',64),pg_temp.test_time()+interval '5 minutes'
));
select ok((select status='cancelled' and fee_snapshot=0 and assignment_version=3
  from public.cleaning_targets where id=pg_temp.uid(306)),
  'old zero-fee reclean target is preserved and terminally cancelled');
select ok((select replacement.source='manual_room_request' and replacement.cleaning_kind='additional'
    and replacement.status='unassigned' and replacement.assignment_version=1
    and replacement.fee_snapshot=origin.fee_snapshot
    and replacement.template_snapshot=origin.template_snapshot
  from private.assignment_unavailability_cancellations event
  join public.cleaning_targets replacement on replacement.id=event.replacement_target_id
  join public.cleaning_targets origin on origin.id=pg_temp.uid(305)
  where event.assignment_id=pg_temp.uid(406)),
  'reclean replacement is one ordinary paid target with the original frozen contract');
select is((select count(*)::int from private.assignment_unavailability_cancellations event
  join public.cleaning_targets replacement on replacement.id=event.replacement_target_id
  where event.assignment_id=pg_temp.uid(406)),1,
  'reclean cancellation links exactly one replacement target');
select is((select count(*)::int from public.cleaning_assignments assignment
  join private.assignment_unavailability_cancellations event
    on event.replacement_target_id=assignment.cleaning_target_id
  where event.assignment_id=pg_temp.uid(406)),0,
  'replacement remains visibly unassigned for the ordinary manager assignment flow');
select is(private.cancel_unavailable_cleaning_assignment_at(
  pg_temp.uid(1),pg_temp.uid(201),pg_temp.uid(306),pg_temp.uid(406),2,null,null,
  'MAID_INJURED','unavailable-reclean',repeat('e',64),pg_temp.test_time()+interval '5 minutes'
),(select value from results where name='reclean'),
  'reclean cancellation replay creates no duplicate replacement');

delete from auth.sessions where id=pg_temp.uid(201);
select throws_ok($$select private.cancel_unavailable_cleaning_assignment_at(
  pg_temp.uid(1),pg_temp.uid(201),pg_temp.uid(304),pg_temp.uid(404),2,null,null,
  'MAID_UNAVAILABLE','unavailable-session-denied',repeat('d',64),pg_temp.test_time())$$,
  '42501','SESSION_REVOKED','revoked administrator session is rejected');

select is((select count(*)::int from public.audit_events
  where event_type='assignment.unavailability_cancelled'),4,
  'each successful cancellation records one domain audit event');
select ok(not exists(select 1 from public.audit_events
  where event_type='assignment.unavailability_cancelled'
    and (after_state ? 'sessionId' or after_state ? 'pin' or after_state ? 'reasonText')),
  'audit projection contains no session, PIN, or free-text payload');
select is((select count(*)::int from public.list_developer_audit_events(
  pg_temp.uid(6),array['assignment.unavailability_cancelled'],null,
  null,null,null,null,50
)),4,'developer audit projection exposes every successful cancellation');
select ok(not exists(select 1 from public.list_developer_audit_events(
  pg_temp.uid(6),array['assignment.unavailability_cancelled'],null,
  null,null,null,null,50
) event where event.summary ?| array['requestHash','beforeState','afterState','idempotencyKey',
  'sessionId','pin','reasonText']),
  'developer audit projection exposes only the bounded assignment summary');
select ok(not has_table_privilege(role,'private.assignment_unavailability_cancellations',
  'SELECT,INSERT,UPDATE,DELETE'),'private cancellation evidence is hidden from '||role)
from unnest(array['anon','authenticated','service_role']) role;
select ok(not has_function_privilege(role,
  'public.cancel_unavailable_cleaning_assignment(uuid,uuid,uuid,uuid,bigint,uuid,bigint,text,text,text)',
  'EXECUTE'),'public RPC is denied to '||role)
from unnest(array['anon','authenticated']) role;
select ok(has_function_privilege('service_role',
  'public.cancel_unavailable_cleaning_assignment(uuid,uuid,uuid,uuid,bigint,uuid,bigint,text,text,text)',
  'EXECUTE'),'service role can invoke the actor-checked command');

select * from finish();
rollback;
