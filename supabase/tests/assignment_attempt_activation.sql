begin;
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

-- Today, tomorrow, inactive maid, unassigned rollover and notified rollover fixtures.
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

select ok((select original_service_date='2037-09-30' and effective_service_date='2037-10-01'
  and carryover_count=1 and status='unassigned' from public.cleaning_targets where id=pg_temp.pid(304)),
  'unassigned rollover preserves original date and advances effective date');
select is((select count(*)::int from public.cleaning_target_schedule_revisions
  where cleaning_target_id=pg_temp.pid(304) and reason_code='ROLLED_OVER_UNASSIGNED'),1,
  'unassigned rollover appends one schedule revision');
select ok((select original_service_date='2037-09-30' and effective_service_date='2037-10-01'
  and carryover_count=1 and status='unassigned' from public.cleaning_targets where id=pg_temp.pid(305)),
  'notified attempt-zero rollover returns target to unassigned');
select ok((select not is_current and ended_at is not null and change_reason_code='ROLLED_OVER_NOT_STARTED'
  from public.cleaning_assignments where id=pg_temp.pid(405)),
  'notified rollover preserves and closes assignment history');
select ok((select resolved_at is not null from public.notifications where dedupe_key='activation-old-notice'),
  'notified rollover resolves old actionable notification');
select is((select count(*)::int from public.notifications where cleaning_target_id=pg_temp.pid(305)
  and category='cleaning_assignment_rolled_over'),1,'rollover appends one informational notification');
select is((select count(*)::int from private.notification_outbox outbox join public.notifications notice
  on notice.id=outbox.notification_id where notice.cleaning_target_id=pg_temp.pid(305)
  and notice.category='cleaning_assignment_rolled_over'),1,'rollover notification has one outbox row');
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
  where cleaning_target_id=pg_temp.pid(304) and reason_code='ROLLED_OVER_UNASSIGNED'),1,
  'retry does not append another rollover revision');
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
insert into public.cleaning_targets(
  id,room_id,cleaning_kind,source,source_key,original_service_date,effective_service_date,
  available_from,due_at,status,assignment_version,room_type_snapshot,fee_snapshot,template_snapshot,
  created_by,reclean_of_attempt_id,reclean_maid_profile_id
) select pg_temp.pid(309),room_id,'reclean','inspection_reclean','activation-reclean',
  '2037-10-03','2037-10-03','2037-10-03 11:00+09','2037-10-03 14:00+09','notified',2,
  room_type_snapshot,0,template_snapshot,pg_temp.pid(1),pg_temp.pid(508),pg_temp.pid(2)
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
)),'developer projection includes activation and rollover events');
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

select * from finish();
rollback;
