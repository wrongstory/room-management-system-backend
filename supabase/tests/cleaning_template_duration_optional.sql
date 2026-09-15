begin;
select no_plan();

create function pg_temp.tid(n integer) returns uuid language sql immutable as $$
  select ('e1650000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
$$;
create function pg_temp.checkout_slots(p_count integer) returns jsonb
language sql immutable as $$
  select jsonb_agg(jsonb_build_object(
    'slotKey', case when display_order = 0 then 'tv-on' else 'slot-' || display_order end,
    'displayOrder', display_order,
    'required', display_order < p_count - 1,
    'label', '사진 ' || (display_order + 1)
  ) order by display_order)
  from generate_series(0, p_count - 1) display_order
$$;

insert into auth.users(id) values (pg_temp.tid(101)),(pg_temp.tid(102)),(pg_temp.tid(103));
insert into public.profiles(
  id, auth_user_id, display_name, display_name_normalized, login_id,
  login_id_normalized, login_sequence, role, status, must_change_password
) values (
  pg_temp.tid(1), pg_temp.tid(101), '시간 미설정 관리자', '시간 미설정 관리자',
  'duration-optional-admin', 'duration-optional-admin', 0, 'admin', 'active', false
);
insert into public.profiles(
  id, auth_user_id, display_name, display_name_normalized, login_id,
  login_id_normalized, login_sequence, role, status, must_change_password
) values
  (pg_temp.tid(2), pg_temp.tid(102), '시간 미설정 메이드 1', '시간 미설정 메이드 1',
    'duration-optional-maid-1', 'duration-optional-maid-1', 0, 'maid', 'active', false),
  (pg_temp.tid(3), pg_temp.tid(103), '시간 미설정 메이드 2', '시간 미설정 메이드 2',
    'duration-optional-maid-2', 'duration-optional-maid-2', 0, 'maid', 'active', false);
insert into auth.sessions(id,user_id) values (pg_temp.tid(201),pg_temp.tid(101));

create temp table publication(response jsonb);
insert into publication
select public.publish_checkout_cleaning_template(
  pg_temp.tid(1), pg_temp.tid(201), 'standard', 0, null,
  pg_temp.checkout_slots(10), 'duration-optional-publish', repeat('a',64)
);

select is((select response->'durationMinutes' from publication),'null'::jsonb,
  'checkout photo template publishes with an explicit unconfigured duration');
select is((select duration_minutes from public.cleaning_template_versions
  where room_type_id=(select id from public.room_types where code='standard')
    and cleaning_kind='checkout' and status='published'),null::integer,
  'database never invents a checkout template duration');
select ok(not (select after_state ? 'durationMinutes' from public.audit_events
  where event_type='cleaning_template.published' order by recorded_at desc limit 1),
  'audit omits unconfigured duration instead of recording a fallback');

select lives_ok(
  format(
    $sql$select public.create_reservation(%L,%L,%L,'2044-01-01 16:00+09','2044-01-02 11:00+09',2,null,%s,%L,%L)$sql$,
    pg_temp.tid(1), pg_temp.tid(301),
    (select room.id from public.rooms room join public.room_types room_type
      on room_type.id=room.room_type_id where room_type.code='standard'
      order by room.room_number limit 1),
    (select room.state_version from public.rooms room join public.room_types room_type
      on room_type.id=room.room_type_id where room_type.code='standard'
      order by room.room_number limit 1),
    'duration-optional-reservation', repeat('b',64)
  ),
  'reservation succeeds when the published checkout photo template has no duration'
);
select is((select count(*) from public.cleaning_targets where reservation_id=pg_temp.tid(301)),1::bigint,
  'duration-less template still creates exactly one planned checkout target');
select is((select template_snapshot->>'durationMinutes' from public.cleaning_targets
  where reservation_id=pg_temp.tid(301)),null::text,
  'planned target snapshot contains no invented duration value');
select is((select count(*) from public.assignment_duration_policy_versions
  where status='confirmed'),0::bigint,
  'template publication does not implicitly confirm assignment duration policy');

insert into public.cleaning_template_versions(
  room_type_id, cleaning_kind, version, status, duration_minutes,
  photo_slots, published_at, created_by
)
select room_type.id, 'additional', 1, 'published', 60,
  pg_temp.checkout_slots(2), statement_timestamp(), pg_temp.tid(1)
from public.room_types room_type
where room_type.code = 'standard';

create temp table duration_case as
select
  reservation.room_id,
  room.state_version room_version,
  target.id checkout_target_id,
  pg_temp.tid(302) manual_target_id
from public.reservations reservation
join public.rooms room on room.id = reservation.room_id
join public.cleaning_targets target on target.reservation_id = reservation.id
where reservation.id = pg_temp.tid(301);

create temp table manual_request_result(response jsonb);
insert into manual_request_result
select public.create_manual_cleaning_request(
  pg_temp.tid(1), manual_target_id, room_id, pg_temp.tid(301), 'additional',
  '2044-01-02', '2044-01-02 11:00:30+09', '2044-01-02 12:00+09',
  room_version, 'DURATION_OPTIONAL_TEST', 'duration-open-ended-plan', repeat('d',64)
)
from duration_case;

select is((select response->>'id' from manual_request_result),pg_temp.tid(302)::text,
  'an open-ended duration-less checkout does not become an invented one-minute planning interval');
select is(
  (select public.create_manual_cleaning_request(
    pg_temp.tid(1), manual_target_id, room_id, pg_temp.tid(301), 'additional',
    '2044-01-02', '2044-01-02 11:00:30+09', '2044-01-02 12:00+09',
    room_version, 'DURATION_OPTIONAL_TEST', 'duration-open-ended-plan', repeat('d',64)
  ) from duration_case),
  (select response from manual_request_result),
  'manual planning replays the first completed result without duplicating ledgers'
);

create temp table conflict_before as
select jsonb_build_object(
  'targets',(select count(*) from public.cleaning_targets),
  'schedules',(select count(*) from public.cleaning_target_schedule_revisions),
  'audits',(select count(*) from public.audit_events),
  'receipts',(select count(*) from private.command_executions),
  'roomVersion',(select state_version from public.rooms where id=duration_case.room_id)
) snapshot
from duration_case;

select throws_ok(
  (select format(
    $sql$select public.create_manual_cleaning_request(
      %L,%L,%L,%L,'additional','2044-01-02','2044-01-02 11:30+09','2044-01-02 12:30+09',%s,
      'DURATION_OPTIONAL_TEST','duration-explicit-conflict',%L
    )$sql$,
    pg_temp.tid(1), pg_temp.tid(303), room_id, pg_temp.tid(301),
    (select state_version from public.rooms where id=duration_case.room_id), repeat('e',64)
  ) from duration_case),
  '23P01','CLEANING_REQUEST_TIME_CONFLICT',
  'two explicit planning windows retain the existing conflict boundary'
);
select is(
  (select jsonb_build_object(
    'targets',(select count(*) from public.cleaning_targets),
    'schedules',(select count(*) from public.cleaning_target_schedule_revisions),
    'audits',(select count(*) from public.audit_events),
    'receipts',(select count(*) from private.command_executions),
    'roomVersion',(select state_version from public.rooms where id=duration_case.room_id)
  ) from duration_case),
  (select snapshot from conflict_before),
  'planning conflict rolls back target, schedule, audit, receipt, and room version together'
);

insert into public.cleaning_targets(
  id, room_id, cleaning_kind, source, source_key, original_service_date,
  effective_service_date, available_from, due_at, status, assignment_version,
  room_type_snapshot, fee_snapshot, template_snapshot, created_by
)
select pg_temp.tid(304), room_id, 'additional', 'manual_room_request',
  'duration-running-fixture', '2044-01-02', '2044-01-02',
  '2044-01-02 13:00+09', '2044-01-02 14:00+09', 'in_progress', 2,
  '{}'::jsonb, 10000, '{}'::jsonb, pg_temp.tid(1)
from duration_case;
insert into public.cleaning_assignments(
  id, cleaning_target_id, maid_profile_id, sequence_number, revision, notified_at, changed_by
)
select pg_temp.tid(401), pg_temp.tid(304), pg_temp.tid(2), 1, 2,
  '2044-01-02 11:00+09', pg_temp.tid(1)
from duration_case;
insert into public.cleaning_attempts(
  id, cleaning_target_id, assignment_id, maid_profile_id, attempt_number, status,
  assignment_revision, started_at, template_snapshot, room_snapshot
)
select pg_temp.tid(501), pg_temp.tid(304), pg_temp.tid(401), pg_temp.tid(2), 1,
  'in_progress', 2, '2044-01-02 11:01+09', '{}'::jsonb,
  jsonb_build_object('roomId',room_id)
from duration_case;

update public.cleaning_targets target
set status='notified', assignment_version=2
from duration_case fixture
where target.id=fixture.manual_target_id;
insert into public.cleaning_assignments(
  id, cleaning_target_id, maid_profile_id, sequence_number, revision, notified_at, changed_by
)
select pg_temp.tid(402), manual_target_id, pg_temp.tid(3), 2, 2,
  '2044-01-02 11:00+09', pg_temp.tid(1)
from duration_case;
insert into public.cleaning_attempts(
  id, cleaning_target_id, assignment_id, maid_profile_id, attempt_number, status,
  assignment_revision, template_snapshot, room_snapshot
)
select pg_temp.tid(502), manual_target_id, pg_temp.tid(402), pg_temp.tid(3), 1,
  'scheduled', 2, '{}'::jsonb, jsonb_build_object('roomId',room_id)
from duration_case;

select throws_ok(
  $$select private.execute_cleaning_attempt_at(
    pg_temp.tid(3),pg_temp.tid(502),1,pg_temp.tid(402),2,
    'duration-room-work-block',repeat('f',64),'start','2044-01-02 11:30+09'
  )$$,
  '55000','PREVIOUS_ROOM_WORKFLOW_ACTIVE',
  'actual start is blocked by current same-room work instead of an estimated end time'
);
select ok((select status='scheduled' and started_at is null from public.cleaning_attempts where id=pg_temp.tid(502))
  and not exists(select 1 from public.audit_events where entity_id=pg_temp.tid(502)
    and event_type='cleaning.attempt_started')
  and not exists(select 1 from private.command_executions where idempotency_key='duration-room-work-block'),
  'same-room execution rejection leaves attempt, audit, and receipt unchanged');

update public.cleaning_attempts
set status='field_completed', field_completed_at='2044-01-02 11:31+09',
  ended_at='2044-01-02 11:31+09', execution_version=execution_version+1
where id=pg_temp.tid(501);
insert into public.checkout_presence_incidents(
  id, reservation_id, room_id, checkout_obligation_id, cleaning_target_id,
  assignment_id, attempt_id, reported_by, reason_code, reservation_version,
  target_assignment_version, assignment_revision, attempt_execution_version, reported_at
)
select pg_temp.tid(601), pg_temp.tid(301), fixture.room_id, obligation.id, pg_temp.tid(304),
  pg_temp.tid(401), pg_temp.tid(501), pg_temp.tid(2), 'GUEST_STILL_PRESENT',
  reservation.version, 2, 2, 2, '2044-01-02 11:32+09'
from duration_case fixture
join public.checkout_cleaning_obligations obligation on obligation.reservation_id=pg_temp.tid(301)
join public.reservations reservation on reservation.id=pg_temp.tid(301);

select throws_ok(
  $$select private.execute_cleaning_attempt_at(
    pg_temp.tid(3),pg_temp.tid(502),1,pg_temp.tid(402),2,
    'duration-room-incident-block',repeat('1',64),'start','2044-01-02 11:33+09'
  )$$,
  '55000','CHECKOUT_INCIDENT_OPEN',
  'an unresolved checkout-presence incident blocks every same-room execution path'
);
select ok((select status='scheduled' and started_at is null from public.cleaning_attempts where id=pg_temp.tid(502))
  and not exists(select 1 from public.audit_events where entity_id=pg_temp.tid(502)
    and event_type='cleaning.attempt_started')
  and not exists(select 1 from private.command_executions where idempotency_key='duration-room-incident-block'),
  'incident rejection leaves execution state and immutable ledgers unchanged');

select throws_ok(
  $$insert into public.cleaning_template_versions(
      room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,created_by
    ) values(
      (select id from public.room_types where code='premium'),'stayover',999,'draft',null,'[]',
      pg_temp.tid(1)
    )$$,
  '23514',null,
  'non-checkout template kinds retain the positive duration requirement'
);

select * from finish();
rollback;
