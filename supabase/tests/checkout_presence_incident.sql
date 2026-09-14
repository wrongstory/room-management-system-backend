begin;
\ir room_pin_fixture.psql
select no_plan();

create function pg_temp.iid(n integer) returns uuid language sql immutable as $$
  select ('f3300000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;

insert into auth.users(id) select pg_temp.iid(100+n) from generate_series(1,9) n;
insert into auth.sessions(id,user_id) select pg_temp.iid(200+n),pg_temp.iid(100+n) from generate_series(1,9) n;
select public.bootstrap_first_developer_profile(
  pg_temp.iid(6),pg_temp.iid(106),'사건 개발자','사건 개발자','0006',
  'checkout-incident-developer-phone','checkout-incident-developer-bootstrap'
);
insert into public.profiles(
  id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
  login_sequence,role,status,must_change_password
) values
  (pg_temp.iid(1),pg_temp.iid(101),'사건 관리자','사건 관리자','사건 관리자','사건 관리자',0,'admin','active',false),
  (pg_temp.iid(2),pg_temp.iid(102),'신고 메이드','신고 메이드','신고 메이드','신고 메이드',0,'maid','active',false),
  (pg_temp.iid(3),pg_temp.iid(103),'후속 메이드','후속 메이드','후속 메이드','후속 메이드',0,'maid','active',false),
  (pg_temp.iid(4),pg_temp.iid(104),'임시 관리자','임시 관리자','임시 관리자','임시 관리자',0,'admin','active',true),
  (pg_temp.iid(5),pg_temp.iid(105),'비활성 메이드','비활성 메이드','비활성 메이드','비활성 메이드',0,'maid','inactive',false),
  (pg_temp.iid(7),pg_temp.iid(107),'임시 메이드','임시 메이드','임시 메이드','임시 메이드',0,'maid','active',true),
  (pg_temp.iid(8),pg_temp.iid(108),'업로드 메이드','업로드 메이드','업로드 메이드','업로드 메이드',0,'maid','upload_only',false),
  (pg_temp.iid(9),pg_temp.iid(109),'다른 메이드','다른 메이드','다른 메이드','다른 메이드',0,'maid','active',false);

create temp table incident_fixture(
  room_id uuid,reservation_id uuid,target_id uuid,assignment_id uuid,attempt_id uuid,
  incident_id uuid,report_result jsonb,decision_result jsonb,at_time timestamptz
);

create function pg_temp.incident_slots() returns jsonb language sql immutable as $$
  select jsonb_build_array(jsonb_build_object(
    'slotKey','room-proof','required',true,'displayOrder',0,
    'sectionKey','checkout','label','객실 증빙','description','합성 테스트 증빙',
    'instanceNumber',1,'instanceCount',1
  ))
$$;

do $$
declare
  v_room public.rooms;
  v_reservation_id uuid:=pg_temp.iid(300);
  v_target_id uuid;
  v_assignment_id uuid;
  v_attempt_id uuid;
  -- Keep the authoritative scheduled checkout far enough in the past that an
  -- otherwise-valid reassignment interval can exercise the post-lock hard
  -- deadline check without violating the checkout target's available-from
  -- invariant first.
  v_at timestamptz:=date_trunc('minute',clock_timestamp())-interval '5 minutes';
  v_service_date date:=(clock_timestamp() at time zone 'Asia/Seoul')::date;
  v_planned_date date:=((clock_timestamp() at time zone 'Asia/Seoul')::date);
  v_week date;
  v_availability uuid;
  v_result jsonb;
  v_commit_at timestamptz:=((v_planned_date-1)+time '09:00') at time zone 'Asia/Seoul';
begin
  select * into v_room from public.rooms order by room_number limit 1;
  insert into public.room_pin_sync_events(
    room_id,sync_status,pin_version,reason_code,actor_profile_id,effective_at
  ) values(v_room.id,'verified',1,'TEST',pg_temp.iid(1),v_at);
  perform pg_temp.install_room_pin_fixture(v_room.id,pg_temp.iid(1),1);
  insert into public.cleaning_template_versions(
    room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,published_at,created_by
  ) values(v_room.room_type_id,'checkout',6,'published',60,pg_temp.incident_slots(),v_at,pg_temp.iid(1));

  v_result:=public.create_reservation(
    pg_temp.iid(1),v_reservation_id,v_room.id,
    ((v_service_date-1)+time '16:00') at time zone 'Asia/Seoul',
    v_at,2,null,v_room.state_version,
    'checkout-incident-create',repeat('1',64)
  );
  select planned_cleaning_target_id into v_target_id
  from public.checkout_cleaning_obligations where reservation_id=v_reservation_id;

  v_week:=v_planned_date-(extract(isodow from v_planned_date)::integer-1);
  foreach v_availability in array array[pg_temp.iid(702),pg_temp.iid(703)] loop
    insert into public.availability_versions(
      id,maid_profile_id,week_start,version,submitted_at
    ) values(
      v_availability,
      case when v_availability=pg_temp.iid(702) then pg_temp.iid(2) else pg_temp.iid(3) end,
      v_week,1,v_at
    );
    insert into public.availability_days(availability_version_id,work_date,available)
    select v_availability,v_week+i,true from generate_series(0,6) i;
  end loop;
  if v_week<>v_service_date-(extract(isodow from v_service_date)::integer-1) then
    v_week:=v_service_date-(extract(isodow from v_service_date)::integer-1);
    foreach v_availability in array array[pg_temp.iid(712),pg_temp.iid(713)] loop
      insert into public.availability_versions(
        id,maid_profile_id,week_start,version,submitted_at
      ) values(
        v_availability,
        case when v_availability=pg_temp.iid(712) then pg_temp.iid(2) else pg_temp.iid(3) end,
        v_week,1,v_at
      );
      insert into public.availability_days(availability_version_id,work_date,available)
      select v_availability,v_week+i,true from generate_series(0,6) i;
    end loop;
  end if;

  v_result:=public.save_cleaning_assignment_draft(
    pg_temp.iid(1),v_target_id,pg_temp.iid(2),1,1,
    'checkout-incident-draft',repeat('2',64)
  );
  v_assignment_id:=(v_result->>'assignmentId')::uuid;
  perform private.commit_and_notify_assignments_at(
    pg_temp.iid(1),v_planned_date,
    private.assignment_commit_impact_at(v_planned_date,v_commit_at)->>'impactFingerprint',
    jsonb_build_array(jsonb_build_object(
      'cleaningTargetId',v_target_id,
      'expectedAssignmentVersion',(select assignment_version from public.cleaning_targets where id=v_target_id),
      'expectedAvailabilityVersion',1
    )),
    'checkout-incident-notify',repeat('3',64),v_commit_at
  );
  update public.reservations set actual_check_in_at=check_in_at where id=v_reservation_id;
  perform public.process_due_reservation_transitions(
    pg_temp.iid(1),v_at,
    'checkout-incident-scheduled-checkout',repeat('4',64)
  );
  perform public.process_due_assignment_lifecycle(
    pg_temp.iid(1),v_at+interval '1 minute','checkout-incident-activate',repeat('5',64)
  );
  select id into v_assignment_id from public.cleaning_assignments
  where cleaning_target_id=v_target_id and is_current;
  select id into v_attempt_id from public.cleaning_attempts
  where cleaning_target_id=v_target_id and status='scheduled';
  insert into incident_fixture(room_id,reservation_id,target_id,assignment_id,attempt_id,at_time)
  values(v_room.id,v_reservation_id,v_target_id,v_assignment_id,v_attempt_id,v_at);
end $$;

select ok((select attempt_id is not null from incident_fixture),
  'actual scheduler checkout produces a scheduled attempt fixture');
select ok(exists(
  select 1 from public.room_occupancy_events occupancy
  join incident_fixture fixture on fixture.reservation_id=occupancy.reservation_id
  where occupancy.room_id=fixture.room_id
    and occupancy.event_type='scheduled_checkout'
    and occupancy.effective_at=fixture.at_time
), 'fixture is backed by authoritative scheduled-checkout occupancy evidence');
select ok(exists(select 1 from public.notifications
  where recipient_profile_id=pg_temp.iid(2)
    and cleaning_target_id=(select target_id from incident_fixture)
    and requires_action and resolved_at is null),
  'fixture starts with an actionable current assignment notification');

select throws_ok(
  $$select public.report_checkout_presence_incident(
    pg_temp.iid(9),pg_temp.iid(209),(select attempt_id from incident_fixture),1,
    (select assignment_id from incident_fixture),
    (select revision from public.cleaning_assignments where id=(select assignment_id from incident_fixture)),
    'checkout-incident-other-maid',repeat('0',64)
  )$$,'42501','CHECKOUT_INCIDENT_REPORT_REQUIRED','another active maid cannot report the assigned attempt');
select throws_ok(
  $$select public.report_checkout_presence_incident(
    pg_temp.iid(7),pg_temp.iid(207),(select attempt_id from incident_fixture),1,
    (select assignment_id from incident_fixture),1,'checkout-incident-temp-maid',repeat('0',64)
  )$$,'42501','PASSWORD_CHANGE_REQUIRED','temporary-password maid cannot report');
select throws_ok(
  $$select public.report_checkout_presence_incident(
    pg_temp.iid(8),pg_temp.iid(208),(select attempt_id from incident_fixture),1,
    (select assignment_id from incident_fixture),1,'checkout-incident-upload-maid',repeat('0',64)
  )$$,'42501','PIN_ACCESS_REQUIRED','upload-only maid cannot report');
select throws_ok(
  $$select public.report_checkout_presence_incident(
    pg_temp.iid(6),pg_temp.iid(206),(select attempt_id from incident_fixture),1,
    (select assignment_id from incident_fixture),1,'checkout-incident-developer',repeat('0',64)
  )$$,'42501','MAID_REQUIRED','developer cannot report a checkout incident');

grant select on incident_fixture to service_role;
set local role service_role;
select lives_ok(
  $$update public.reservations set actual_check_in_at=actual_check_in_at
    where id=(select reservation_id from incident_fixture)$$,
  'existing service-owned reservation writes do not need raw incident table grants'
);
reset role;
select ok((select bool_and(p.prosecdef)
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='private' and p.proname in (
    'guard_checkout_incident_workflow','guard_checkout_incident_reservation',
    'guard_checkout_incident_reveal_lease','guard_checkout_incident_submission',
    'guard_checkout_incident_inspection'
  )), 'incident lookup triggers run as fixed-search-path security definers');

update incident_fixture f set report_result=public.report_checkout_presence_incident(
  pg_temp.iid(2),pg_temp.iid(202),f.attempt_id,1,f.assignment_id,
  (select revision from public.cleaning_assignments where id=f.assignment_id),
  'checkout-incident-report',repeat('6',64)
);

update incident_fixture set incident_id=(select id from public.checkout_presence_incidents);

select is((select report_result->>'status' from incident_fixture),'open',
  'maid report creates one open typed incident');
select is(current_setting('app.checkout_incident_writer_mode',true),'',
  'report restores the incident writer capability after success');
select is((select count(*)::integer from public.checkout_presence_incidents),1,
  'report creates exactly one incident');
select is(
  (select public.report_checkout_presence_incident(
    pg_temp.iid(2),pg_temp.iid(202),attempt_id,1,assignment_id,
    (select revision from public.cleaning_assignments where id=assignment_id),
    'checkout-incident-report',repeat('6',64)
  ) from incident_fixture),
  (select report_result from incident_fixture),
  'lost response retry replays the exact logical report'
);
select throws_ok(
  format(
    'select public.report_checkout_presence_incident(%L,%L,%L,1,%L,%s,%L,%L)',
    pg_temp.iid(2),pg_temp.iid(202),(select attempt_id from incident_fixture),
    (select assignment_id from incident_fixture),
    (select revision from public.cleaning_assignments where id=(select assignment_id from incident_fixture)),
    'checkout-incident-report-other',repeat('7',64)
  ),'40001','CHECKOUT_INCIDENT_REPORT_CONFLICT',
  'same attempt with another command key fails with a stable conflict'
);

select throws_ok(
  format(
    'select private.execute_cleaning_attempt_at(%L,%L,1,%L,%s,%L,%L,%L,%L)',
    pg_temp.iid(2),(select attempt_id from incident_fixture),(select assignment_id from incident_fixture),
    (select revision from public.cleaning_assignments where id=(select assignment_id from incident_fixture)),
    'checkout-incident-start',repeat('8',64),'start',(select at_time+interval '2 minute' from incident_fixture)
  ),'55000','CHECKOUT_INCIDENT_OPEN','future cleaning start is frozen while the incident is open'
);
select throws_ok(
  format(
    'insert into public.cleaning_assignments(cleaning_target_id,maid_profile_id,sequence_number,revision,changed_by,notified_at) values(%L,%L,99,999,%L,clock_timestamp())',
    (select target_id from incident_fixture),pg_temp.iid(3),pg_temp.iid(1)
  ),'55000','CHECKOUT_INCIDENT_OPEN','reassignment is frozen outside the admin decision command'
);
select ok((select bool_and(revoked_at is not null) from private.offline_work_lease_revocations
  where lease_id in (select id from private.offline_work_leases where attempt_id=(select attempt_id from incident_fixture)))
  or not exists(select 1 from private.offline_work_leases where attempt_id=(select attempt_id from incident_fixture)),
  'existing offline authority is revoked or absent');
select ok(not exists(select 1 from public.notifications
  where recipient_profile_id=pg_temp.iid(2)
    and cleaning_target_id=(select target_id from incident_fixture)
    and requires_action and resolved_at is null),
  'report resolves the previous actionable assignment notification');
select is((select count(*)::integer from public.notifications
  where event_family='checkout.presence_reported_admin'),1,
  'all and only active password-complete business admins receive the report');
select is((select count(*)::integer from private.notification_delivery_outbox o
  join public.notifications n on n.id=o.notification_id
  where n.event_family='checkout.presence_reported_admin'),1,
  'admin report notification and typed delivery intent are atomic');

select throws_ok(
  (select format(
    'select public.decide_checkout_presence_incident(%L,%L,%L,1,%L,%L,%L,null,%L::jsonb,%L,%L)',
    pg_temp.iid(4),pg_temp.iid(204),incident_id,report_result->>'impactFingerprint','CONFIRM_DEPARTED','GUEST_DEPARTURE_CONFIRMED',
    jsonb_build_object(
      'maidProfileId',pg_temp.iid(3),'sequenceNumber',1,
      'serviceDate',(at_time at time zone 'Asia/Seoul')::date,
      'availableFrom',at_time,'dueAt',at_time+interval '4 hours'
    )::text,'checkout-incident-temp-admin',repeat('0',64)
  ) from incident_fixture),
  '42501','PASSWORD_CHANGE_REQUIRED','temporary-password admin cannot decide an incident'
);
select throws_ok(
  (select format(
    'select public.decide_checkout_presence_incident(%L,%L,%L,1,%L,%L,%L,null,%L::jsonb,%L,%L)',
    pg_temp.iid(3),pg_temp.iid(203),incident_id,report_result->>'impactFingerprint','CONFIRM_DEPARTED','GUEST_DEPARTURE_CONFIRMED',
    jsonb_build_object(
      'maidProfileId',pg_temp.iid(3),'sequenceNumber',1,
      'serviceDate',(at_time at time zone 'Asia/Seoul')::date,
      'availableFrom',at_time,'dueAt',at_time+interval '4 hours'
    )::text,'checkout-incident-maid-decision',repeat('0',64)
  ) from incident_fixture),
  '42501','ADMIN_REQUIRED','maid cannot decide an incident'
);
select throws_ok(
  (select format(
    'select public.decide_checkout_presence_incident(%L,%L,%L,1,%L,%L,%L,null,%L::jsonb,%L,%L)',
    pg_temp.iid(6),pg_temp.iid(206),incident_id,report_result->>'impactFingerprint','CONFIRM_DEPARTED','GUEST_DEPARTURE_CONFIRMED',
    jsonb_build_object(
      'maidProfileId',pg_temp.iid(3),'sequenceNumber',1,
      'serviceDate',(at_time at time zone 'Asia/Seoul')::date,
      'availableFrom',at_time,'dueAt',at_time+interval '4 hours'
    )::text,'checkout-incident-developer-decision',repeat('0',64)
  ) from incident_fixture),
  '42501','ADMIN_REQUIRED','developer cannot decide an incident'
);

select throws_ok(
  (select format(
    'select public.decide_checkout_presence_incident(%L,%L,%L,1,%L,%L,%L,null,%L::jsonb,%L,%L)',
    pg_temp.iid(1),pg_temp.iid(201),incident_id,repeat('0',64),
    'CONFIRM_DEPARTED','GUEST_DEPARTURE_CONFIRMED',
    jsonb_build_object(
      'maidProfileId',pg_temp.iid(3),'sequenceNumber',1,
      'serviceDate',(at_time at time zone 'Asia/Seoul')::date,
      'availableFrom',at_time,'dueAt',at_time+interval '4 hours'
    )::text,'checkout-incident-stale-impact',repeat('d',64)
  ) from incident_fixture),
  '40001','CHECKOUT_INCIDENT_IMPACT_CHANGED',
  'admin decision rejects a stale or substituted impact fingerprint'
);

select throws_ok(
  (select format(
    'select public.decide_checkout_presence_incident(%L,%L,%L,1,%L,%L,%L,null,%L::jsonb,%L,%L)',
    pg_temp.iid(1),pg_temp.iid(201),incident_id,report_result->>'impactFingerprint','CONFIRM_DEPARTED','GUEST_DEPARTURE_CONFIRMED',
    jsonb_build_object(
      'maidProfileId',pg_temp.iid(3),'sequenceNumber',1,
      'serviceDate',(at_time at time zone 'Asia/Seoul')::date,
      'availableFrom',at_time+interval '1 hour','dueAt',at_time+interval '5 hours'
    )::text,'checkout-incident-future-departed',repeat('f',64)
  ) from incident_fixture),
  '22023','INVALID_CHECKOUT_INCIDENT_DECISION',
  'confirmed departure cannot schedule work in the future'
);
select throws_ok(
  (select format(
    'select public.decide_checkout_presence_incident(%L,%L,%L,1,%L,%L,%L,%L,%L::jsonb,%L,%L)',
    pg_temp.iid(1),pg_temp.iid(201),incident_id,report_result->>'impactFingerprint','EXTEND_CHECKOUT','GUEST_STILL_PRESENT_EXTENDED',at_time,
    jsonb_build_object(
      'maidProfileId',pg_temp.iid(3),'sequenceNumber',1,
      'serviceDate',(at_time at time zone 'Asia/Seoul')::date,
      'availableFrom',at_time,'dueAt',at_time+interval '4 hours'
    )::text,'checkout-incident-past-extension',repeat('e',64)
  ) from incident_fixture),
  '22023','INVALID_CHECKOUT_INCIDENT_DECISION',
  'checkout extension must move checkout into the future'
);

select throws_ok(
  (select format(
    'select public.decide_checkout_presence_incident(%L,%L,%L,1,%L,%L,%L,null,%L::jsonb,%L,%L)',
    pg_temp.iid(1),pg_temp.iid(201),incident_id,report_result->>'impactFingerprint',
    'CONFIRM_DEPARTED','GUEST_DEPARTURE_CONFIRMED',
    jsonb_build_object(
      'maidProfileId',pg_temp.iid(3),'sequenceNumber',1,
      'serviceDate',(clock_timestamp() at time zone 'Asia/Seoul')::date,
      'availableFrom',date_trunc('minute',clock_timestamp())-interval '2 minutes',
      'dueAt',date_trunc('minute',clock_timestamp())-interval '1 minute'
    )::text,'checkout-incident-expired-due',repeat('1',64)
  ) from incident_fixture),
  '22023','INVALID_CHECKOUT_INCIDENT_DECISION',
  'a new decision cannot create an already expired reassignment window'
);
select is((select status from public.checkout_presence_incidents
  where id=(select incident_id from incident_fixture)),'open',
  'expired-due rejection rolls back without resolving the incident');
select is((select count(*)::integer from public.checkout_presence_incident_decisions),0,
  'expired-due rejection creates no immutable decision');

select throws_ok(
  (select format(
    'select public.decide_checkout_presence_incident(%L,%L,%L,1,%L,%L,%L,null,%L::jsonb,%L,%L)',
    pg_temp.iid(1),pg_temp.iid(201),incident_id,report_result->>'impactFingerprint',
    'CONFIRM_DEPARTED','GUEST_DEPARTURE_CONFIRMED',
    jsonb_build_object(
      'maidProfileId',pg_temp.iid(3),'sequenceNumber',1,
      'serviceDate',(at_time at time zone 'Asia/Seoul')::date,
      'availableFrom',at_time+interval '1 day',
      'dueAt',at_time+interval '1 day 1 hour'
    )::text,'checkout-incident-service-date-mismatch',repeat('2',64)
  ) from incident_fixture),
  '23514','ASSIGNMENT_SCHEDULE_INVALID',
  'reassignment serviceDate must match availableFrom in KST'
);
select throws_ok(
  (select format(
    'select public.decide_checkout_presence_incident(%L,%L,%L,1,%L,%L,%L,null,%L::jsonb,%L,%L)',
    pg_temp.iid(1),pg_temp.iid(201),incident_id,report_result->>'impactFingerprint',
    'CONFIRM_DEPARTED','GUEST_DEPARTURE_CONFIRMED',
    jsonb_build_object(
      'maidProfileId',pg_temp.iid(3),'sequenceNumber',1,
      'serviceDate',(at_time at time zone 'Asia/Seoul')::date,
      'availableFrom',at_time,
      'dueAt',(((at_time at time zone 'Asia/Seoul')::date+1)::timestamp
        at time zone 'Asia/Seoul')+interval '1 minute'
    )::text,'checkout-incident-after-service-day',repeat('3',64)
  ) from incident_fixture),
  '23514','ASSIGNMENT_SCHEDULE_INVALID',
  'reassignment dueAt cannot exceed the next KST midnight boundary'
);
select is((select status from public.checkout_presence_incidents
  where id=(select incident_id from incident_fixture)),'open',
  'invalid schedule attempts preserve the open frozen incident');
select is((select count(*)::integer from public.checkout_presence_incident_decisions),0,
  'invalid schedule attempts append no decision history');

update incident_fixture f set decision_result=public.decide_checkout_presence_incident(
  pg_temp.iid(1),pg_temp.iid(201),f.incident_id,1,
  f.report_result->>'impactFingerprint','CONFIRM_DEPARTED',
  'GUEST_DEPARTURE_CONFIRMED',null,
  jsonb_build_object(
    'maidProfileId',pg_temp.iid(3),
    'sequenceNumber',1,
    'serviceDate',(f.at_time at time zone 'Asia/Seoul')::date,
    'availableFrom',f.at_time,
    'dueAt',f.at_time+interval '4 hours'
  ),
  'checkout-incident-decision',repeat('9',64)
);

select is((select decision_result#>>'{decision,decision}' from incident_fixture),'CONFIRM_DEPARTED',
  'admin records one immutable typed decision');
select is(current_setting('app.checkout_incident_writer_mode',true),'',
  'decision restores the incident writer capability after success');
select is((select count(*)::integer from public.cleaning_targets
  where id=(select target_id from incident_fixture)),1,
  'decision reuses the existing checkout cleaning target');
select ok((select not is_current and change_reason_code='CHECKOUT_NOT_COMPLETED'
  from public.cleaning_assignments where id=(select assignment_id from incident_fixture)),
  'old notified responsibility remains immutable history');
select ok((select status='superseded' and ended_at is not null and end_reason='CHECKOUT_NOT_COMPLETED'
  from public.cleaning_attempts where id=(select attempt_id from incident_fixture)),
  'interrupted scheduled work is closed without deleting history');
select ok((select count(*)=1 and bool_and(is_current and maid_profile_id=pg_temp.iid(3))
  from public.cleaning_assignments where cleaning_target_id=(select target_id from incident_fixture) and is_current),
  'decision creates one new responsibility revision');
select ok((select count(*)=1 and bool_and(status='scheduled' and maid_profile_id=pg_temp.iid(3))
  from public.cleaning_attempts where cleaning_target_id=(select target_id from incident_fixture)
    and id<>(select attempt_id from incident_fixture)),
  'confirmed departure creates one new scheduled attempt for the selected maid');
select ok(exists(select 1 from public.notifications
  where recipient_profile_id=pg_temp.iid(3) and event_family='checkout.presence_resolved_maid'
    and not requires_action and resolved_at is null),
  'newly responsible maid receives one informational incident-resolution notification');
select is((select count(*)::integer from public.notifications
  where recipient_profile_id=pg_temp.iid(3) and event_family='assignment.commit_notified'
    and requires_action and resolved_at is null),1,
  'newly responsible maid receives one actionable assignment notification');
select is((select count(*)::integer from private.notification_delivery_outbox outbox
  join public.notifications notice on notice.id=outbox.notification_id
  where notice.recipient_profile_id=pg_temp.iid(3)
    and notice.event_family in ('checkout.presence_resolved_maid','assignment.commit_notified')),2,
  'informational resolution and actionable assignment each enqueue exactly one typed delivery');
select ok(exists(select 1 from public.notifications
  where recipient_profile_id=pg_temp.iid(2) and event_family='checkout.presence_previous_maid_resolved'
    and not requires_action),
  'previous maid receives an informational responsibility-release notification');
select ok(not exists(select 1 from public.notifications
  where event_family='checkout.presence_reported_admin' and resolved_at is null),
  'admin incident action notification is resolved by the immutable decision');
select is((select count(*)::integer from public.earnings),0,
  'interrupted work creates no earning');
select is(
  (select public.decide_checkout_presence_incident(
    pg_temp.iid(1),pg_temp.iid(201),incident_id,1,
    report_result->>'impactFingerprint','CONFIRM_DEPARTED',
    'GUEST_DEPARTURE_CONFIRMED',null,
    jsonb_build_object(
      'maidProfileId',pg_temp.iid(3),'sequenceNumber',1,
      'serviceDate',(at_time at time zone 'Asia/Seoul')::date,
      'availableFrom',at_time,'dueAt',at_time+interval '4 hours'
    ),'checkout-incident-decision',repeat('9',64)
  ) from incident_fixture),
  (select decision_result from incident_fixture),
  'decision retry replays without duplicate responsibility or attempt'
);
select is((select count(*)::integer from public.notifications
  where recipient_profile_id=pg_temp.iid(3)
    and event_family in ('checkout.presence_resolved_maid','assignment.commit_notified')),2,
  'decision replay duplicates neither the informational nor actionable notification');

create temp table started_incident_fixture as
select a.id attempt_id,a.assignment_id,s.revision assignment_revision,
  a.execution_version,t.id target_id,t.room_id,t.reservation_id,f.at_time
from incident_fixture f
join public.cleaning_targets t on t.id=f.target_id
join public.cleaning_assignments s on s.cleaning_target_id=t.id and s.is_current
join public.cleaning_attempts a on a.assignment_id=s.id and a.status='scheduled';
select lives_ok(
  (select format(
    'select private.start_attempt_with_lease_at(%L,%L,%L,1,%L,%s,%L,%L,%L)',
    pg_temp.iid(3),pg_temp.iid(203),attempt_id,assignment_id,assignment_revision,
    'checkout-incident-second-start',repeat('b',64),at_time+interval '1 minute'
  ) from started_incident_fixture),
  'the replacement responsibility can start before a second report'
);
create temp table replacement_notice_resolution as
select resolved_at
from public.notifications
where event_family='assignment.commit_notified'
  and source_entity_id=(select assignment_id::text from started_incident_fixture);
select ok((select resolved_at is not null from replacement_notice_resolution),
  'replacement start resolves its actionable assignment notification');
select ok(exists(select 1 from public.notifications
  where event_family='checkout.presence_resolved_maid'
    and source_entity_id=(select current_decision_id::text
      from public.checkout_presence_incidents where id=(select incident_id from incident_fixture))
    and not requires_action and resolved_at is null),
  'replacement start leaves the informational incident-resolution notice open as read-state only');
select lives_ok(
  (select format(
    'select private.start_attempt_with_lease_at(%L,%L,%L,1,%L,%s,%L,%L,%L)',
    pg_temp.iid(3),pg_temp.iid(203),attempt_id,assignment_id,assignment_revision,
    'checkout-incident-second-start',repeat('b',64),at_time+interval '1 minute'
  ) from started_incident_fixture),
  'replacement start replay succeeds'
);
select is((select resolved_at from public.notifications
    where event_family='assignment.commit_notified'
      and source_entity_id=(select assignment_id::text from started_incident_fixture)),
  (select resolved_at from replacement_notice_resolution),
  'replacement start replay preserves the first notification resolved_at');
insert into public.room_pin_access_leases(
  id,room_id,cleaning_target_id,assignment_id,attempt_id,pin_version,
  reservation_id,issued_to,issued_at,expires_at
)
select pg_temp.iid(800),room_id,target_id,assignment_id,attempt_id,1,
  reservation_id,pg_temp.iid(3),at_time,at_time+interval '1 hour'
from started_incident_fixture;
create temp table started_reveal as
select public.begin_room_pin_reveal(
  pg_temp.iid(3),pg_temp.iid(203),room_id,assignment_id,attempt_id,
  pg_temp.iid(800),pg_temp.iid(801)
) result from started_incident_fixture;
select lives_ok(
  $$select public.finalize_room_pin_reveal(
    pg_temp.iid(3),pg_temp.iid(203),(select room_id from incident_fixture),
    ((select result->>'lease_id' from started_reveal))::uuid,pg_temp.iid(801)
  )$$,
  'PIN reveal can complete before the physical-presence report'
);
create temp table second_report as
select public.report_checkout_presence_incident(
  pg_temp.iid(3),pg_temp.iid(203),attempt_id,2,assignment_id,assignment_revision,
  'checkout-incident-second-report',repeat('c',64)
) result from started_incident_fixture;
select is((select result->>'status' from second_report),'open',
  'an in-progress attempt remains reportable after PIN reveal');
select ok((select revoked_at is not null and revoke_reason_code='CHECKOUT_NOT_COMPLETED'
  from public.room_pin_access_leases where id=pg_temp.iid(800)),
  'report revokes future access through the already revealed PIN lease');
select ok(exists(select 1 from private.offline_work_lease_revocations revocation
  join private.offline_work_leases lease on lease.id=revocation.lease_id
  where lease.attempt_id=(select attempt_id from started_incident_fixture)
    and revocation.reason_code='CHECKOUT_NOT_COMPLETED'),
  'report revokes the online-start issued offline execution lease');
select throws_ok(
  (select format(
    'select private.execute_cleaning_attempt_at(%L,%L,2,%L,%s,%L,%L,%L,%L)',
    pg_temp.iid(3),attempt_id,assignment_id,assignment_revision,
    'checkout-incident-second-complete',repeat('d',64),'complete_field_work',at_time+interval '2 minute'
  ) from started_incident_fixture),
  '55000','CHECKOUT_INCIDENT_OPEN',
  'reported in-progress work cannot be completed from online or replay paths'
);

select is((select count(*)::integer from public.audit_events
  where event_type in ('checkout.presence_reported','checkout.presence_decided')),3,
  'two reports and one decision each append one domain audit event');
select is((select count(*)::integer from public.list_developer_audit_events(
  pg_temp.iid(6),array['checkout.presence_reported','checkout.presence_decided'],null,
  clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day',null,null,50
)),3,'developer projection includes every typed checkout audit event');
select ok((select bool_and(
  not summary ?& array['requestHash','idempotencyKey','before_state','after_state','pinDigits',
    'guestName','phone','sessionId','token']
) from public.list_developer_audit_events(
  pg_temp.iid(6),array['checkout.presence_reported','checkout.presence_decided'],null,
  clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day',null,null,50
)),'developer audit projection excludes raw state and sensitive material');
select ok(not has_table_privilege('service_role','public.checkout_presence_incidents','SELECT')
  and not has_table_privilege('service_role','public.checkout_presence_incident_decisions','SELECT'),
  'service-role cannot bypass the app-owned checkout incident projections with raw table reads');
select throws_ok(
  $$update public.checkout_presence_incidents set reason_code='REPORT_FALSE_CONFIRMED'
    where id=(select incident_id from incident_fixture)$$,
  '55000','CHECKOUT_INCIDENT_IMMUTABLE','incident provenance is immutable');
select throws_ok(
  $$delete from public.checkout_presence_incident_decisions$$,
  '55000','CHECKOUT_INCIDENT_DECISION_IMMUTABLE','decision history cannot be deleted');

set local role authenticated;
select set_config('request.jwt.claims',json_build_object(
  'sub',pg_temp.iid(101),'session_id',pg_temp.iid(201),'role','authenticated'
)::text,true);
select is((select count(*)::integer from public.checkout_presence_incidents),2,
  'active password-complete admin sees the bounded incident ledger');
select set_config('request.jwt.claims',json_build_object(
  'sub',pg_temp.iid(104),'session_id',pg_temp.iid(204),'role','authenticated'
)::text,true);
select is((select count(*)::integer from public.checkout_presence_incidents),0,
  'temporary-password admin receives zero incident rows');
select set_config('request.jwt.claims',json_build_object(
  'sub',pg_temp.iid(105),'session_id',pg_temp.iid(205),'role','authenticated'
)::text,true);
select is((select count(*)::integer from public.checkout_presence_incidents),0,
  'inactive maid receives zero incident rows');
select set_config('request.jwt.claims',json_build_object(
  'sub',pg_temp.iid(106),'session_id',pg_temp.iid(206),'role','authenticated'
)::text,true);
select is((select count(*)::integer from public.checkout_presence_incidents),0,
  'developer does not inherit business incident visibility');
select set_config('request.jwt.claims',json_build_object(
  'sub',pg_temp.iid(109),'session_id',pg_temp.iid(209),'role','authenticated'
)::text,true);
select is((select count(*)::integer from public.checkout_presence_incidents),0,
  'unrelated active maid cannot enumerate incident rows');
reset role;

select throws_ok(
  $$select public.report_checkout_presence_incident(
    pg_temp.iid(5),pg_temp.iid(205),(select attempt_id from incident_fixture),1,
    (select assignment_id from incident_fixture),1,'inactive-report',repeat('a',64)
  )$$,'42501','PIN_ACCESS_REQUIRED','inactive maid is rejected before incident access');
delete from auth.sessions where id=pg_temp.iid(203);
set local role authenticated;
select set_config('request.jwt.claims',json_build_object(
  'sub',pg_temp.iid(103),'session_id',pg_temp.iid(203),'role','authenticated'
)::text,true);
select is((select count(*)::integer from public.checkout_presence_incidents),0,
  'revoked maid session sees zero incident rows through Data API RLS');
select is((select count(*)::integer from public.checkout_presence_incident_decisions),0,
  'revoked maid session sees zero decision rows through Data API RLS');
reset role;
select throws_ok(
  $$select public.get_checkout_presence_incident(
    pg_temp.iid(3),pg_temp.iid(203),(select incident_id from incident_fixture)
  )$$,'42501','SESSION_REVOKED','revoked maid session cannot read an incident');

select * from finish();
rollback;
