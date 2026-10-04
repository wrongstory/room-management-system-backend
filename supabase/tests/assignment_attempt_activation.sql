begin;
\ir room_pin_fixture.psql
select no_plan();

create function pg_temp.pid(n integer) returns uuid language sql immutable as $$
  select ('28000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
$$;

insert into auth.users(id) select pg_temp.pid(n + 100) from generate_series(1, 5) n;
select public.bootstrap_first_developer_profile(
  pg_temp.pid(5), pg_temp.pid(105), '활성화 개발자', '활성화 개발자', '0005',
  'activation-developer-phone-hash', 'activation-developer-bootstrap'
);
insert into public.profiles(
  id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
  login_sequence,role,status,must_change_password
) values
  (pg_temp.pid(1),pg_temp.pid(101),'활성화 관리자','활성화 관리자','활성화 관리자','활성화 관리자',0,'admin','active',false),
  (pg_temp.pid(2),pg_temp.pid(102),'활성화 메이드1','활성화 메이드1','활성화 메이드1','활성화 메이드1',0,'maid','active',false),
  (pg_temp.pid(3),pg_temp.pid(103),'활성화 메이드2','활성화 메이드2','활성화 메이드2','활성화 메이드2',0,'maid','active',false),
  (pg_temp.pid(4),pg_temp.pid(104),'비활성 메이드','비활성 메이드','비활성 메이드','비활성 메이드',0,'maid','active',false);

create function pg_temp.add_target(
  n integer,
  p_status public.cleaning_target_status,
  p_date date,
  p_available timestamptz,
  p_due timestamptz,
  p_room_offset integer default null,
  p_maid integer default 2
) returns uuid language plpgsql as $$
declare
  target_id uuid := pg_temp.pid(300 + n);
  room_id uuid;
begin
  select id into room_id from public.rooms order by room_number
  offset coalesce(p_room_offset, n) limit 1;
  insert into public.cleaning_targets(
    id,room_id,cleaning_kind,source,source_key,original_service_date,
    effective_service_date,available_from,due_at,status,assignment_version,
    room_type_snapshot,fee_snapshot,template_snapshot,created_by
  ) values (
    target_id,room_id,'additional','manual_room_request','activation-target-'||n,
    p_date,p_date,p_available,p_due,p_status,2,
    jsonb_build_object('fixture',n),10000,jsonb_build_object('durationMinutes',60),pg_temp.pid(1)
  );
  if p_status in ('draft_assigned','notified') then
    insert into public.cleaning_assignments(
      id,cleaning_target_id,maid_profile_id,sequence_number,revision,changed_by,notified_at
    ) values (
      pg_temp.pid(400+n),target_id,pg_temp.pid(p_maid),n,2,pg_temp.pid(1),
      case when p_status='notified' then p_available-interval '1 hour' end
    );
  end if;
  return target_id;
end;
$$;

-- Today, tomorrow, inactive maid, past unassigned and past notified fixtures.
select pg_temp.add_target(1,'notified','2037-10-01','2037-10-01 09:00+09','2037-10-01 15:00+09');
select pg_temp.add_target(2,'notified','2037-10-02','2037-10-02 09:00+09','2037-10-02 15:00+09');
select pg_temp.add_target(3,'notified','2037-10-01','2037-10-01 09:00+09','2037-10-01 15:00+09',null,4);
update public.profiles set status='inactive' where id=pg_temp.pid(4);
select pg_temp.add_target(4,'unassigned','2037-09-30','2037-09-30 09:00+09','2037-09-30 15:00+09');
select pg_temp.add_target(5,'notified','2037-09-30','2037-09-30 09:00+09','2037-09-30 15:00+09');
insert into public.notifications(
  recipient_profile_id,category,title,body,cleaning_target_id,dedupe_key,requires_action
) values (
  pg_temp.pid(2),'cleaning_assignment_notified','테스트','합성 배정',pg_temp.pid(305),
  'activation-old-notice',true
);

-- Active old room workflow blocks the next target in that room.
select pg_temp.add_target(6,'notified','2037-09-30','2037-09-30 08:00+09','2037-09-30 14:00+09',20);
insert into public.cleaning_attempts(
  id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,
  assignment_revision,template_snapshot,room_snapshot
) values (
  pg_temp.pid(506),pg_temp.pid(306),pg_temp.pid(406),pg_temp.pid(2),1,'scheduled',2,
  jsonb_build_object('durationMinutes',60),jsonb_build_object('fixture',6)
);
select pg_temp.add_target(7,'notified','2037-10-01','2037-10-01 10:00+09','2037-10-01 16:00+09',20);

-- Every active workflow status is excluded from rollover.
select pg_temp.add_target(n,'notified','2037-09-30','2037-09-30 08:00+09','2037-09-30 14:00+09',60+n)
from generate_series(20,24) n;
insert into public.cleaning_attempts(
  id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,
  assignment_revision,template_snapshot,room_snapshot
)
select pg_temp.pid(500+n),pg_temp.pid(300+n),pg_temp.pid(400+n),pg_temp.pid(2),1,
  status::public.attempt_status,2,jsonb_build_object('durationMinutes',60),jsonb_build_object('fixture',n)
from (values
  (20,'scheduled'),(21,'in_progress'),(22,'field_completed'),(23,'upload_pending'),(24,'submitted')
) active(n,status);

create temp table run_results(label text primary key,value jsonb);
insert into run_results values (
  'today',
  public.process_due_assignment_lifecycle(
    pg_temp.pid(1),'2037-10-01 11:00+09','activation-run-today',repeat('a',64)
  )
);

select is((select count(*)::int from public.cleaning_attempts where cleaning_target_id=pg_temp.pid(301)),1,
  'today notified target creates one scheduled attempt');
select is((select status::text from public.cleaning_attempts where cleaning_target_id=pg_temp.pid(301)),'scheduled',
  'activation owns scheduled status only');
select ok((select assignment_id=pg_temp.pid(401) and maid_profile_id=pg_temp.pid(2)
  and assignment_revision=2 and attempt_number=1 from public.cleaning_attempts
  where cleaning_target_id=pg_temp.pid(301)),'attempt freezes current assignment identity');
select ok((select template_snapshot=jsonb_build_object('durationMinutes',60)
  and room_snapshot ?& array['fixture','roomId','roomNumber','elevatorZone']
  from public.cleaning_attempts where cleaning_target_id=pg_temp.pid(301)),
  'attempt freezes target snapshots with minimal room identity');
select is((select count(*)::int from public.cleaning_attempts where cleaning_target_id=pg_temp.pid(302)),0,
  'tomorrow notified target does not activate today');
select is((select count(*)::int from public.cleaning_attempts where cleaning_target_id=pg_temp.pid(303)),0,
  'inactive maid target is fail-closed');
select is((select count(*)::int from public.cleaning_attempts where cleaning_target_id=pg_temp.pid(307)),0,
  'previous room workflow blocks next target');
select ok((select value->'activationResults' @> jsonb_build_array(jsonb_build_object(
  'cleaningTargetId',pg_temp.pid(307),'status','blocked','reasonCode','PREVIOUS_ROOM_WORKFLOW_ACTIVE'
  )) from run_results where label='today'),'blocked result uses stable previous-workflow reason');

select ok((select original_service_date='2037-09-30' and effective_service_date='2037-09-30'
  and carryover_count=0 and status='unassigned' from public.cleaning_targets where id=pg_temp.pid(304)),
  'past unassigned target retains its original schedule without automatic rollover');
select is((select count(*)::int from public.cleaning_target_schedule_revisions
  where cleaning_target_id=pg_temp.pid(304) and reason_code='ROLLED_OVER_UNASSIGNED'),0,
  'elapsed time appends no schedule revision');
select ok((select original_service_date='2037-09-30' and effective_service_date='2037-09-30'
  and carryover_count=0 and status='notified' from public.cleaning_targets where id=pg_temp.pid(305)),
  'past notified target retains its schedule and notification state');
select ok((select is_current and ended_at is null
  from public.cleaning_assignments where id=pg_temp.pid(405)),
  'past notified assignment remains current');
select is((select count(*)::int from public.cleaning_attempts where cleaning_target_id=pg_temp.pid(305) and status='scheduled'),1,
  'scheduler activates past notified work without replacing its identity');
select ok((select value->>'rolledOverCount'='0' and value->'rolloverResults'='[]'::jsonb from run_results where label='today'),
  'legacy response fields report zero automatic rollovers');
select ok((select resolved_at is null from public.notifications where dedupe_key='activation-old-notice'),
  'elapsed time does not resolve the current assignment notice');
select is((select count(*)::int from public.notifications where cleaning_target_id=pg_temp.pid(305)
  and category='cleaning_assignment_rolled_over'),0,'elapsed time emits no rollover notification');
select is((select count(*)::int from private.notification_delivery_outbox outbox join public.notifications notice
  on notice.id=outbox.notification_id where notice.cleaning_target_id=pg_temp.pid(305)
  and notice.category='cleaning_assignment_rolled_over'),0,'elapsed time emits no rollover push');
select ok((select effective_service_date='2037-09-30' and carryover_count=0 from public.cleaning_targets
  where id=pg_temp.pid(306)),'active scheduled attempt is excluded from rollover');
select is((select count(*)::int from public.cleaning_targets
  where id=any(array[pg_temp.pid(320),pg_temp.pid(321),pg_temp.pid(322),pg_temp.pid(323),pg_temp.pid(324)])
    and effective_service_date='2037-09-30' and carryover_count=0 and status='notified'),5,
  'all five active workflow statuses are excluded from rollover');

-- Once the earlier room workflow is terminal, the unchanged notified revision can activate.
update public.cleaning_attempts set status='approved' where id=pg_temp.pid(506);
select is((select private.activate_cleaning_attempt_at(
  pg_temp.pid(1),pg_temp.pid(307),'2037-10-01 11:30+09',pg_temp.pid(407),2
)->>'status'),'activated','blocked target activates after the previous room workflow terminates');
select is((select count(*)::int from public.cleaning_attempts where cleaning_target_id=pg_temp.pid(307)),1,
  'previous-workflow retry still creates exactly one attempt');

-- Same command replay is a byte-for-byte logical result and adds no side effects.
select is(public.process_due_assignment_lifecycle(
  pg_temp.pid(1),'2037-10-01 11:00+09','activation-run-today',repeat('a',64)
),(select value from run_results where label='today'),'exact scheduler retry replays the same result');
select is((select count(*)::int from public.cleaning_attempts where cleaning_target_id=pg_temp.pid(301)),1,
  'retry does not create another attempt');
select is((select count(*)::int from public.cleaning_target_schedule_revisions
  where cleaning_target_id=pg_temp.pid(304) and reason_code='ROLLED_OVER_UNASSIGNED'),0,
  'retry still creates no rollover revision');
select throws_ok($$select public.process_due_assignment_lifecycle(
  pg_temp.pid(1),'2037-10-01 11:00+09','activation-run-today',repeat('b',64)
)$$,'23505','IDEMPOTENCY_KEY_REUSED','same key with a different hash is rejected');

insert into run_results values (
  'tomorrow',public.process_due_assignment_lifecycle(
    pg_temp.pid(1),'2037-10-02 11:00+09','activation-run-tomorrow',repeat('c',64)
  )
);
select is((select count(*)::int from public.cleaning_attempts where cleaning_target_id=pg_temp.pid(302)),1,
  'tomorrow target activates when its KST service date arrives');

-- Reclean only activates for the immutable original rejected maid and zero fee.
select pg_temp.add_target(8,'notified','2037-10-03','2037-10-03 08:00+09','2037-10-03 10:00+09',30);
insert into public.cleaning_attempts(
  id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,assignment_revision,
  ended_at,end_reason,template_snapshot,room_snapshot
) values (
  pg_temp.pid(508),pg_temp.pid(308),pg_temp.pid(408),pg_temp.pid(2),1,'rejected',2,
  '2037-10-03 10:00+09','INSPECTION_REJECTED',jsonb_build_object('durationMinutes',60),jsonb_build_object('fixture',8)
);
update public.cleaning_assignments set is_current=false,ended_at='2037-10-03 10:00+09',change_reason_code='INSPECTION_REJECTED'
where id=pg_temp.pid(408);
insert into public.cleaning_submissions(
  id,cleaning_attempt_id,client_submission_id,version,status,photo_manifest,submitted_by
) values (
  pg_temp.pid(608),pg_temp.pid(508),pg_temp.pid(708),1,'rejected','{}',pg_temp.pid(2)
);
insert into public.inspection_decisions(id,submission_id,decision,reason_code,decided_by)
values(pg_temp.pid(808),pg_temp.pid(608),'rejected','QUALITY_REWORK',pg_temp.pid(1));
insert into public.cleaning_targets(
  id,room_id,cleaning_kind,source,source_key,original_service_date,effective_service_date,
  available_from,due_at,status,assignment_version,room_type_snapshot,fee_snapshot,template_snapshot,
  created_by,reclean_of_attempt_id,reclean_maid_profile_id,
  reclean_of_submission_id,reclean_of_inspection_decision_id
) select pg_temp.pid(309),room_id,'reclean','inspection_reclean','activation-reclean',
  '2037-10-03','2037-10-03','2037-10-03 11:00+09','2037-10-03 14:00+09','notified',2,
  room_type_snapshot,0,template_snapshot,pg_temp.pid(1),pg_temp.pid(508),pg_temp.pid(2),
  pg_temp.pid(608),pg_temp.pid(808)
  from public.cleaning_targets where id=pg_temp.pid(308);
insert into public.cleaning_assignments(
  id,cleaning_target_id,maid_profile_id,sequence_number,revision,changed_by,notified_at
) values (pg_temp.pid(409),pg_temp.pid(309),pg_temp.pid(2),99,2,pg_temp.pid(1),'2037-10-03 09:00+09');
select lives_ok($$select public.process_due_assignment_lifecycle(
  pg_temp.pid(1),'2037-10-03 12:00+09','activation-run-reclean',repeat('d',64)
)$$,'reclean with original maid activates');
select is((select count(*)::int from public.cleaning_attempts where cleaning_target_id=pg_temp.pid(309)),1,
  'reclean creates exactly one scheduled attempt');
select throws_ok($$update public.cleaning_assignments set maid_profile_id=pg_temp.pid(3)
  where id=pg_temp.pid(409)$$,'23514','RECLEAN_MAID_IMMUTABLE',
  'reclean assignment cannot be changed to another maid before activation');

-- Planned checkout remains attempt-zero until the same planned target is materialized.
insert into public.cleaning_template_versions(
  room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,published_at,created_by
) select room_type.id,'checkout',1,'published',60,'[]',now(),pg_temp.pid(1)
  from public.room_types room_type;
create temp table checkout_case(reservation_id uuid,target_id uuid,room_id uuid,old_assignment_id uuid);
insert into checkout_case(reservation_id,room_id)
select pg_temp.pid(701),id from public.rooms order by room_number offset 40 limit 1;
insert into public.room_pin_sync_events(room_id,sync_status,pin_version,reason_code,actor_profile_id,effective_at)
select room_id,'verified',1,'TEST',pg_temp.pid(1),now() from checkout_case;
select pg_temp.install_room_pin_fixture(room_id,pg_temp.pid(1),1) from checkout_case;
select public.create_reservation(
  pg_temp.pid(1),reservation_id,room_id,date_trunc('minute',now())-interval '1 day',
  ((now() at time zone 'Asia/Seoul')::date+1+time '11:00') at time zone 'Asia/Seoul',
  2,null,(select state_version from public.rooms where id=room_id),
  'activation-checkout-create',repeat('e',64)
) from checkout_case;
update checkout_case c set target_id=o.planned_cleaning_target_id
from public.checkout_cleaning_obligations o where o.reservation_id=c.reservation_id;
update public.reservations set actual_check_in_at=check_in_at where id=(select reservation_id from checkout_case);
insert into public.cleaning_assignments(
  cleaning_target_id,maid_profile_id,sequence_number,revision,changed_by,notified_at
) select target_id,pg_temp.pid(2),111,2,pg_temp.pid(1),now() from checkout_case returning id;
update public.cleaning_targets set status='notified',assignment_version=2 where id=(select target_id from checkout_case);
update checkout_case c set old_assignment_id=a.id from public.cleaning_assignments a
where a.cleaning_target_id=c.target_id and a.is_current;
select lives_ok($$select private.activate_cleaning_attempt_at(
  pg_temp.pid(1),(select target_id from checkout_case),now()
)$$,'private checkout plan returns a bounded not-ready result');
select is((select count(*)::int from public.cleaning_attempts where cleaning_target_id=(select target_id from checkout_case)),0,
  'private planned checkout remains attempt zero');
select is((select private.activate_cleaning_attempt_at(
  pg_temp.pid(1),(select target_id from checkout_case),
  ((now() at time zone 'Asia/Seoul')::date+1+time '12:00') at time zone 'Asia/Seoul'
)->>'reasonCode'),'CHECKOUT_NOT_MATERIALIZED','planned checkout uses stable materialization reason');
select public.manual_checkout_reservation(
  pg_temp.pid(1),reservation_id,1,'TEST',date_trunc('minute',now()),
  'activation-manual-checkout',repeat('f',64)
) from checkout_case;
select lives_ok($$select private.activate_cleaning_attempt_at(
  pg_temp.pid(1),(select target_id from checkout_case),clock_timestamp()+interval '1 second'
)$$,'manual checkout activates the current promoted revision');
select is((select count(*)::int from public.cleaning_attempts where cleaning_target_id=(select target_id from checkout_case)),1,
  'manual checkout reuses the planned target and creates one attempt');
select ok((select a.assignment_id=current_assignment.id and a.assignment_revision=current_assignment.revision
  from public.cleaning_attempts a join public.cleaning_assignments current_assignment
    on current_assignment.cleaning_target_id=a.cleaning_target_id and current_assignment.is_current
  where a.cleaning_target_id=(select target_id from checkout_case)),
  'manual checkout activates only the new current assignment revision');
select is((select private.activate_cleaning_attempt_at(
  pg_temp.pid(1),(select target_id from checkout_case),clock_timestamp()+interval '2 seconds',
  (select old_assignment_id from checkout_case),2
)->>'reasonCode'),'ASSIGNMENT_VERSION_CONFLICT',
  'manual checkout never activates the stale pre-checkout assignment identity');

-- Ledger, privilege and immutability boundaries.
select ok((select count(*)>=2 from public.list_developer_audit_events(
  pg_temp.pid(5),array['assignment.attempt_activated','assignment.rolled_over']
)),'developer projection includes successful activation events');
select ok(not exists(select 1 from public.list_developer_audit_events(
  pg_temp.pid(5),array['assignment.attempt_activated','assignment.rolled_over']
) event where event.summary ?| array['requestHash','before_state','after_state','notificationBody','pin','guestName','phone']),
  'developer audit projection exposes only approved safe summary fields');
select throws_ok($$update public.cleaning_attempts set template_snapshot='{}' where cleaning_target_id=pg_temp.pid(301)$$,
  '23514','ATTEMPT_SNAPSHOT_IMMUTABLE','attempt execution snapshot cannot be rewritten');
select throws_ok($$select public.process_due_assignment_lifecycle(
  pg_temp.pid(5),now(),'activation-developer-denied',repeat('1',64)
)$$,'42501','ADMIN_REQUIRED','developer cannot activate business work');
select throws_ok($$select public.process_due_assignment_lifecycle(
  pg_temp.pid(2),now(),'activation-maid-denied',repeat('2',64)
)$$,'42501','ADMIN_REQUIRED','maid cannot activate business work');
select throws_ok($$select public.process_due_assignment_lifecycle(
  pg_temp.pid(4),now(),'activation-inactive-denied',repeat('3',64)
)$$,'42501','ACTIVE_ACCOUNT_REQUIRED','inactive account cannot activate business work');
select ok(not has_function_privilege('anon','public.process_due_assignment_lifecycle(uuid,timestamptz,text,text)','execute')
  and not has_function_privilege('authenticated','public.process_due_assignment_lifecycle(uuid,timestamptz,text,text)','execute')
  and has_function_privilege('service_role','public.process_due_assignment_lifecycle(uuid,timestamptz,text,text)','execute'),
  'activation RPC is service-role only');
select ok(not has_function_privilege('anon','private.activate_cleaning_attempt_at(uuid,uuid,timestamptz,uuid,bigint)','execute')
  and not has_function_privilege('authenticated','private.rollover_cleaning_target_at(uuid,uuid,timestamptz,uuid,bigint,date)','execute'),
  'private lifecycle helpers are not client executable');
select is((select count(*)::int from public.cleaning_targets where id=(select target_id from checkout_case)),1,
  'checkout materialization and activation never duplicate target identity');

-- A historical clear window must not hide actual occupancy at execution time.
-- Each reservation probe is rolled back, including its canonical stay segments.
create function pg_temp.occupied_activation_reason(p_target uuid,p_actual boolean,p_overstay boolean)
returns text language plpgsql as $$
declare reason text; target public.cleaning_targets; assignment public.cleaning_assignments;
begin
 select * into target from public.cleaning_targets where id=p_target;
 select * into assignment from public.cleaning_assignments where cleaning_target_id=p_target and is_current;
 begin
  insert into public.reservations(id,room_id,check_in_at,check_out_at,actual_check_in_at,guest_count,status,created_by,updated_by)
  values(pg_temp.pid(9999),target.room_id,'2040-01-01 12:00+09',
    case when p_overstay then '2040-01-02 12:00+09'::timestamptz else '2040-01-04 12:00+09'::timestamptz end,
    case when p_actual then '2040-01-01 12:00+09'::timestamptz end,1,'active',pg_temp.pid(1),pg_temp.pid(1));
  reason:=private.activation_reason_at(target,assignment,'2040-01-03 12:00+09');
  raise exception using errcode='PZ308',message='rollback occupancy probe';
 exception when sqlstate 'PZ308' then null;
 end;
 return reason;
end $$;
select is(pg_temp.occupied_activation_reason(pg_temp.pid(301),true,false),'ATTEMPT_ACTIVATION_NOT_ALLOWED',
  'historical additional window cannot bypass a current actual occupant');
select is(pg_temp.occupied_activation_reason(pg_temp.pid(301),true,true),'ATTEMPT_ACTIVATION_NOT_ALLOWED',
  'actual occupant blocks additional work even after planned checkout');
select is(pg_temp.occupied_activation_reason(pg_temp.pid(309),true,true),'ATTEMPT_ACTIVATION_NOT_ALLOWED',
  'actual occupant after planned checkout blocks reclean too');
select is(pg_temp.occupied_activation_reason((select target_id from checkout_case),true,true),'ATTEMPT_ACTIVATION_NOT_ALLOWED',
  'materialized checkout of an earlier stay cannot bypass a later physical occupant');
select is(pg_temp.occupied_activation_reason(pg_temp.pid(301),false,false),'ATTEMPT_ACTIVATION_NOT_ALLOWED',
  'current scheduled reservation interval remains protected');
select is(pg_temp.occupied_activation_reason(pg_temp.pid(301),false,true),null::text,
  'elapsed scheduled reservation with no physical check-in does not invent occupancy');

-- Exercise the actual room-move API, then activate historical additional work
-- after the planned checkout while the guest is still physically checked in.
create function pg_temp.moved_room_activation_probe() returns jsonb language plpgsql as $$
declare
 source_room uuid; next_room uuid; preview jsonb; result jsonb; before_state jsonb;
 old_result jsonb; current_result jsonb; after_state jsonb;
begin
 begin
  select id into source_room from public.rooms order by room_number offset 50 limit 1;
  select id into next_room from public.rooms order by room_number offset 51 limit 1;
  perform public.create_reservation(pg_temp.pid(1),pg_temp.pid(9901),source_room,
    '2041-01-01 12:00+09','2041-01-03 12:00+09',1,null,
    (select state_version from public.rooms where id=source_room),'overdue-move-create',repeat('9',64));
  update public.reservations set actual_check_in_at=check_in_at where id=pg_temp.pid(9901);
  select public.preview_reservation_room_move(pg_temp.pid(1),reservation.id,next_room,
    reservation.version,source.state_version,destination.state_version,'2041-01-02 12:00+09','ROOM_UNAVAILABLE')
  into preview from public.reservations reservation
  join public.rooms source on source.id=source_room join public.rooms destination on destination.id=next_room
  where reservation.id=pg_temp.pid(9901);
  perform public.commit_reservation_room_move(pg_temp.pid(1),pg_temp.pid(9901),next_room,
    (preview->>'reservationVersion')::bigint,(preview->>'sourceRoomVersion')::bigint,
    (preview->>'targetRoomVersion')::bigint,(preview->>'evaluatedAt')::timestamptz,
    (preview->>'expiresAt')::timestamptz,(preview->>'effectiveAt')::timestamptz,
    preview->>'impactFingerprint','ROOM_UNAVAILABLE','overdue-move-commit',repeat('9',64));
  -- Both additional windows predate the stay, so only current actual occupancy
  -- (not a historical overlap or future reservation interval) distinguishes them.
  perform pg_temp.add_target(2001,'notified','2037-10-01','2037-10-01 09:00+09','2037-10-01 10:00+09',50);
  perform pg_temp.add_target(2002,'notified','2037-10-01','2037-10-01 09:00+09','2037-10-01 10:00+09',51);
  select jsonb_build_object('targets',(select jsonb_agg(t order by id) from public.cleaning_targets t
      where id in(pg_temp.pid(2301),pg_temp.pid(2302))),
    'assignments',(select jsonb_agg(a order by id) from public.cleaning_assignments a
      where cleaning_target_id in(pg_temp.pid(2301),pg_temp.pid(2302)))) into before_state;
  old_result:=private.activate_cleaning_attempt_at(pg_temp.pid(1),pg_temp.pid(2301),'2041-01-04 12:00+09',pg_temp.pid(2401),2);
  current_result:=private.activate_cleaning_attempt_at(pg_temp.pid(1),pg_temp.pid(2302),'2041-01-04 12:00+09',pg_temp.pid(2402),2);
  select jsonb_build_object('targets',(select jsonb_agg(t order by id) from public.cleaning_targets t
      where id in(pg_temp.pid(2301),pg_temp.pid(2302))),
    'assignments',(select jsonb_agg(a order by id) from public.cleaning_assignments a
      where cleaning_target_id in(pg_temp.pid(2301),pg_temp.pid(2302)))) into after_state;
  result:=jsonb_build_object('old',old_result,'current',current_result,'unchanged',before_state=after_state,
    'moveEvents',(select count(*) from private.reservation_room_move_events where reservation_id=pg_temp.pid(9901)),
    'currentAttempts',(select count(*) from public.cleaning_attempts where cleaning_target_id=pg_temp.pid(2302)));
  raise exception using errcode='PZ308',message='rollback moved room probe';
 exception when sqlstate 'PZ308' then null;
 end;
 return result;
end $$;
insert into run_results values('moved-room-probe',pg_temp.moved_room_activation_probe());
select is((select value->>'moveEvents' from run_results where label='moved-room-probe'),'1',
  'occupancy regression passes through one real room-move command');
select is((select value#>>'{old,status}' from run_results where label='moved-room-probe'),'activated',
  'historical additional work activates in vacated old room after a canonical move');
select is((select value#>>'{current,reasonCode}' from run_results where label='moved-room-probe'),'ATTEMPT_ACTIVATION_NOT_ALLOWED',
  'new current room additional activation is blocked by physical overstay after planned checkout');
select ok((select (value->>'unchanged')::boolean and value->>'currentAttempts'='0' from run_results where label='moved-room-probe'),
  'moved-room activation preserves both target and assignment schedules and creates no occupied-room attempt');

-- Bounded keyset rotation makes progress past a full page of not-yet-open work.
select pg_temp.add_target(n,'notified','2037-10-04','2037-10-04 23:00+09','2037-10-04 23:59+09',0)
from generate_series(1001,1101) n;
select pg_temp.add_target(1102,'notified','2037-10-04','2037-10-04 09:00+09','2037-10-04 10:00+09',45);
update private.assignment_activation_scan_cursor set last_target_id=pg_temp.pid(1300) where singleton;
insert into run_results values('bounded-first',public.process_due_assignment_lifecycle(
  pg_temp.pid(1),'2037-10-04 11:00+09','activation-bounded-first',repeat('7',64)));
select is((select jsonb_array_length(value->'activationResults') from run_results where label='bounded-first'),100,
  'one scheduler invocation scans at most one hundred candidates');
select is((select count(*)::int from public.cleaning_attempts where cleaning_target_id=pg_temp.pid(1402)),0,
  'eligible candidate after a full page awaits the next bounded invocation');
insert into run_results values('cursor-before-replay',
  (select to_jsonb(cursor) from private.assignment_activation_scan_cursor cursor));
select is(public.process_due_assignment_lifecycle(pg_temp.pid(1),'2037-10-04 11:00+09','activation-bounded-first',repeat('7',64)),
  (select value from run_results where label='bounded-first'),'bounded scheduler response-loss retry is exact');
select is((select to_jsonb(cursor) from private.assignment_activation_scan_cursor cursor),
  (select value from run_results where label='cursor-before-replay'),'receipt replay never advances the shared cursor');
insert into run_results values('bounded-next',public.process_due_assignment_lifecycle(
  pg_temp.pid(1),'2037-10-04 11:01+09','activation-bounded-next',repeat('8',64)));
select is((select count(*)::int from public.cleaning_attempts where cleaning_target_id=pg_temp.pid(1402)),1,
  'next invocation reaches overdue eligible work despite the blocked older page');
select ok((select jsonb_array_length(value->'activationResults')<=100 and value->'rolloverResults'='[]'::jsonb
  from run_results where label='bounded-next'),'wraparound stays bounded and never rolls work over');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid='private.assignment_activation_scan_cursor'::regclass),
  'operational cursor has forced RLS');
select ok(not has_table_privilege(role,'private.assignment_activation_scan_cursor','SELECT,INSERT,UPDATE,DELETE'),
  'scheduler cursor is inaccessible to '||role) from unnest(array['anon','authenticated','service_role']) role;

-- The later workflow intentionally sorts first by UUID. Both begin attempt-zero.
select pg_temp.add_target(3001,'notified','2037-10-05','2037-10-05 10:00+09','2037-10-05 11:00+09',55);
select pg_temp.add_target(3002,'notified','2037-10-05','2037-10-05 09:00+09','2037-10-05 10:00+09',55);
select is(private.activate_cleaning_attempt_at(pg_temp.pid(1),pg_temp.pid(3301),'2037-10-05 12:00+09',pg_temp.pid(3401),2)->>'reasonCode',
  'PREVIOUS_ROOM_WORKFLOW_ACTIVE','direct activation sees an earlier notified predecessor with no attempt');
update private.assignment_activation_scan_cursor set last_target_id=pg_temp.pid(3300) where singleton;
insert into run_results values('reverse-workflow-order',public.process_due_assignment_lifecycle(
  pg_temp.pid(1),'2037-10-05 12:00+09','activation-reverse-workflow',repeat('a',64)));
select is((select count(*)::int from public.cleaning_attempts where cleaning_target_id=pg_temp.pid(3301)),0,
  'UUID-first later workflow does not activate ahead of its predecessor');
select is((select count(*)::int from public.cleaning_attempts where cleaning_target_id=pg_temp.pid(3302)),1,
  'chronologically first workflow activates despite its later UUID');
select ok((select value->'activationResults' @> jsonb_build_array(jsonb_build_object(
  'cleaningTargetId',pg_temp.pid(3301),'reasonCode','PREVIOUS_ROOM_WORKFLOW_ACTIVE'))
  from run_results where label='reverse-workflow-order'),'scheduler reports stable room predecessor reason');
-- Legacy notified targets can retain terminal attempt history; do not deadlock
-- their successors merely because target status still says notified.
update public.cleaning_attempts set status='approved' where cleaning_target_id=pg_temp.pid(3302);
select is(private.activate_cleaning_attempt_at(pg_temp.pid(1),pg_temp.pid(3301),'2037-10-05 12:01+09',pg_temp.pid(3401),2)->>'status',
  'activated','terminal current-assignment history releases the next room workflow');

-- Put the chronologically first work just beyond a 100-row page. The predecessor
-- is inserted after the cursor, but the activation guard must see across pages.
select pg_temp.add_target(4001,'notified','2037-10-05','2037-10-05 10:00+09','2037-10-05 11:00+09',56);
select pg_temp.add_target(n,'notified','2037-10-05','2037-10-05 23:00+09','2037-10-05 23:59+09',57)
from generate_series(4002,4100) n;
update private.assignment_activation_scan_cursor set last_target_id=pg_temp.pid(4300) where singleton;
select pg_temp.add_target(4101,'notified','2037-10-05','2037-10-05 09:00+09','2037-10-05 10:00+09',56);
insert into run_results values('workflow-page-one',public.process_due_assignment_lifecycle(
  pg_temp.pid(1),'2037-10-05 12:02+09','activation-workflow-page-one',repeat('b',64)));
select is((select jsonb_array_length(value->'activationResults') from run_results where label='workflow-page-one'),100,
  'workflow-order fixture fills the whole first scheduler page');
select is((select count(*)::int from public.cleaning_attempts where cleaning_target_id in(pg_temp.pid(4301),pg_temp.pid(4401))),0,
  'first page neither activates its later work nor reaches the earlier work on the next page');
select ok((select value->'activationResults' @> jsonb_build_array(jsonb_build_object(
  'cleaningTargetId',pg_temp.pid(4301),'reasonCode','PREVIOUS_ROOM_WORKFLOW_ACTIVE'))
  from run_results where label='workflow-page-one'),'predecessor outside the selected page still blocks later work');
insert into run_results values('workflow-page-two',public.process_due_assignment_lifecycle(
  pg_temp.pid(1),'2037-10-05 12:03+09','activation-workflow-page-two',repeat('c',64)));
select is((select count(*)::int from public.cleaning_attempts where cleaning_target_id=pg_temp.pid(4401)),1,
  'second page activates exactly the earlier notified room workflow');
select is((select count(*)::int from public.cleaning_attempts where cleaning_target_id=pg_temp.pid(4301)),0,
  'later room workflow remains blocked after the predecessor becomes scheduled');
select ok((select bool_and(status='notified' and assignment_version=2 and carryover_count=0)
  from public.cleaning_targets where id in(pg_temp.pid(4301),pg_temp.pid(4401)))
  and (select bool_and(is_current and ended_at is null and revision=2) from public.cleaning_assignments
    where cleaning_target_id in(pg_temp.pid(4301),pg_temp.pid(4401))),
  'page-boundary room ordering preserves both schedules and current assignment identities');

select * from finish();
rollback;
