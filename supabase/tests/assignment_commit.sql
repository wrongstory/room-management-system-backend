begin;

select plan(33);

insert into auth.users (id) values
  ('19000000-0000-4000-8000-000000000001'),
  ('19000000-0000-4000-8000-000000000002'),
  ('19000000-0000-4000-8000-000000000003'),
  ('19000000-0000-4000-8000-000000000004');

set local role service_role;
select public.bootstrap_first_developer_profile(
  '29000000-0000-4000-8000-000000000004',
  '19000000-0000-4000-8000-000000000004',
  '배정 확정 감사 개발자', '배정 확정 감사 개발자', '0004',
  'assignment-commit-developer-phone-hash',
  'assignment-commit-bootstrap-0001'
);
reset role;

insert into public.profiles (
  id, auth_user_id, display_name, display_name_normalized,
  login_id, login_id_normalized, login_sequence, role, status
) values
  (
    '29000000-0000-4000-8000-000000000001',
    '19000000-0000-4000-8000-000000000001',
    '확정 관리자', '확정 관리자', '확정 관리자', '확정 관리자', 0, 'admin', 'active'
  ),
  (
    '29000000-0000-4000-8000-000000000002',
    '19000000-0000-4000-8000-000000000002',
    '가능 메이드', '가능 메이드', '가능 메이드', '가능 메이드', 0, 'maid', 'active'
  ),
  (
    '29000000-0000-4000-8000-000000000003',
    '19000000-0000-4000-8000-000000000003',
    '불가 메이드', '불가 메이드', '불가 메이드', '불가 메이드', 0, 'maid', 'active'
  );

insert into public.availability_versions (
  id, maid_profile_id, week_start, version, submitted_at
) values
  ('39000000-0000-4000-8000-000000000001', '29000000-0000-4000-8000-000000000002', '2027-09-27', 1, '2027-09-25 20:00:00+09'),
  ('39000000-0000-4000-8000-000000000002', '29000000-0000-4000-8000-000000000003', '2027-09-27', 1, '2027-09-25 20:00:00+09');

insert into public.availability_days (availability_version_id, work_date, available)
values
  ('39000000-0000-4000-8000-000000000001', '2027-10-01', true),
  ('39000000-0000-4000-8000-000000000002', '2027-10-01', false);

insert into public.cleaning_targets (
  id, room_id, cleaning_kind, source, source_key,
  original_service_date, effective_service_date, available_from, due_at,
  status, room_type_snapshot, fee_snapshot, template_snapshot, created_by
) values
  (
    '49000000-0000-4000-8000-000000000001',
    (select id from public.rooms order by room_number offset 0 limit 1),
    'additional', 'manual_room_request', 'assignment-commit-target-1',
    '2027-10-01', '2027-10-01', '2027-10-01 09:00:00+09', '2027-10-01 15:00:00+09',
    'unassigned', '{}'::jsonb, 10000, '{"durationMinutes":60}'::jsonb,
    '29000000-0000-4000-8000-000000000001'
  ),
  (
    '49000000-0000-4000-8000-000000000002',
    (select id from public.rooms order by room_number offset 1 limit 1),
    'additional', 'manual_room_request', 'assignment-commit-target-2',
    '2027-10-01', '2027-10-01', '2027-10-01 09:00:00+09', '2027-10-01 16:00:00+09',
    'unassigned', '{}'::jsonb, 10000, '{"durationMinutes":60}'::jsonb,
    '29000000-0000-4000-8000-000000000001'
  ),
  (
    '49000000-0000-4000-8000-000000000003',
    (select id from public.rooms order by room_number offset 2 limit 1),
    'additional', 'manual_room_request', 'assignment-commit-target-3',
    '2027-10-01', '2027-10-01', '2027-10-01 09:00:00+09', '2027-10-01 17:00:00+09',
    'unassigned', '{}'::jsonb, 10000, '{"durationMinutes":60}'::jsonb,
    '29000000-0000-4000-8000-000000000001'
  ),
  (
    '49000000-0000-4000-8000-000000000004',
    (select id from public.rooms order by room_number offset 3 limit 1),
    'additional', 'manual_room_request', 'assignment-commit-target-4',
    '2027-10-01', '2027-10-01', '2027-10-01 09:00:00+09', '2027-10-01 18:00:00+09',
    'unassigned', '{}'::jsonb, 10000, '{"durationMinutes":60}'::jsonb,
    '29000000-0000-4000-8000-000000000001'
  ),
  (
    '49000000-0000-4000-8000-000000000005',
    (select id from public.rooms order by room_number offset 4 limit 1),
    'additional', 'manual_room_request', 'assignment-commit-target-5',
    '2027-10-01', '2027-10-01', '2027-10-01 09:00:00+09', '2027-10-01 18:00:00+09',
    'unassigned', '{}'::jsonb, 10000, '{"durationMinutes":60}'::jsonb,
    '29000000-0000-4000-8000-000000000001'
  ),
  (
    '49000000-0000-4000-8000-000000000006',
    (select id from public.rooms order by room_number offset 5 limit 1),
    'additional', 'manual_room_request', 'assignment-commit-target-6',
    '2027-10-01', '2027-10-01', '2027-10-01 09:00:00+09', '2027-10-01 18:00:00+09',
    'unassigned', '{}'::jsonb, 10000, '{"durationMinutes":60}'::jsonb,
    '29000000-0000-4000-8000-000000000001'
  );

select public.save_cleaning_assignment_draft(
  '29000000-0000-4000-8000-000000000001',
  '49000000-0000-4000-8000-000000000001',
  '29000000-0000-4000-8000-000000000002',
  1, 1, 'assignment-commit-draft-0001', repeat('1', 64)
);
select public.save_cleaning_assignment_draft(
  '29000000-0000-4000-8000-000000000001',
  '49000000-0000-4000-8000-000000000002',
  '29000000-0000-4000-8000-000000000002',
  2, 1, 'assignment-commit-draft-0002', repeat('2', 64)
);
select public.save_cleaning_assignment_draft(
  '29000000-0000-4000-8000-000000000001',
  '49000000-0000-4000-8000-000000000004',
  '29000000-0000-4000-8000-000000000003',
  1, 1, 'assignment-commit-draft-0004', repeat('4', 64)
);
select public.save_cleaning_assignment_draft(
  '29000000-0000-4000-8000-000000000001',
  '49000000-0000-4000-8000-000000000005',
  '29000000-0000-4000-8000-000000000002',
  3, 1, 'assignment-commit-draft-0005', repeat('5', 64)
);
select public.save_cleaning_assignment_draft(
  '29000000-0000-4000-8000-000000000001',
  '49000000-0000-4000-8000-000000000006',
  '29000000-0000-4000-8000-000000000002',
  4, 1, 'assignment-commit-draft-0006', repeat('6', 64)
);

create temporary table assignment_commit_results (
  before_impact jsonb,
  first_response jsonb,
  replay_response jsonb
);

insert into assignment_commit_results (before_impact)
values (private.assignment_commit_impact_at(
  '2027-10-01', '2027-10-01 09:00:00+09'
));

select is(
  (select jsonb_array_length(before_impact -> 'committableDrafts') from assignment_commit_results),
  4,
  'preflight identifies four committable drafts'
);
select is(
  (select jsonb_array_length(before_impact -> 'blockedDrafts') from assignment_commit_results),
  1,
  'preflight identifies one unavailable draft'
);
select is(
  (select before_impact #>> '{blockedDrafts,0,reasonCodes,0}' from assignment_commit_results),
  'ASSIGNMENT_MAID_UNAVAILABLE',
  'preflight exposes a stable blocked reason code'
);
select is(
  (select jsonb_array_length(before_impact -> 'remainingUnassignedTargets') from assignment_commit_results),
  1,
  'preflight keeps the unassigned target visible'
);

update assignment_commit_results
set first_response = private.commit_and_notify_assignments_at(
  '29000000-0000-4000-8000-000000000001',
  '2027-10-01',
  before_impact ->> 'impactFingerprint',
  jsonb_build_array(jsonb_build_object(
    'cleaningTargetId', '49000000-0000-4000-8000-000000000001',
    'expectedAssignmentVersion', 2,
    'expectedAvailabilityVersion', 1
  )),
  'assignment-commit-notify-0001', repeat('a', 64),
  '2027-10-01 09:00:00+09'
);

select is(
  (select jsonb_array_length(first_response -> 'notifiedAssignments') from assignment_commit_results),
  1,
  'partial commit notifies exactly the selected assignment'
);
select is(
  (select jsonb_array_length(first_response -> 'remainingDrafts') from assignment_commit_results),
  3,
  'partial commit reports the remaining committable draft'
);
select is(
  (select jsonb_array_length(first_response -> 'blockedDrafts') from assignment_commit_results),
  1,
  'partial commit preserves blocked draft visibility'
);
select is(
  (select jsonb_array_length(first_response -> 'unassignedTargets') from assignment_commit_results),
  1,
  'partial commit preserves unassigned target visibility'
);
select is(
  (select status::text from public.cleaning_targets where id = '49000000-0000-4000-8000-000000000001'),
  'notified',
  'selected target transitions to notified'
);
select is(
  (select status::text from public.cleaning_targets where id = '49000000-0000-4000-8000-000000000002'),
  'draft_assigned',
  'unselected draft remains draft_assigned'
);
select is(
  (select count(*)::integer from public.notifications where cleaning_target_id = '49000000-0000-4000-8000-000000000001'),
  1,
  'commit creates exactly one persisted notification'
);
select is(
  (select count(*)::integer from private.notification_outbox),
  1,
  'commit creates exactly one pending outbox item'
);
select is(
  (select count(*)::integer from public.cleaning_attempts where cleaning_target_id = '49000000-0000-4000-8000-000000000001'),
  0,
  'commit does not create a cleaning attempt'
);

update assignment_commit_results
set replay_response = private.commit_and_notify_assignments_at(
  '29000000-0000-4000-8000-000000000001',
  '2027-10-01',
  before_impact ->> 'impactFingerprint',
  jsonb_build_array(jsonb_build_object(
    'cleaningTargetId', '49000000-0000-4000-8000-000000000001',
    'expectedAssignmentVersion', 2,
    'expectedAvailabilityVersion', 1
  )),
  'assignment-commit-notify-0001', repeat('a', 64),
  '2027-10-01 09:00:00+09'
);

select is(
  (select replay_response from assignment_commit_results),
  (select first_response from assignment_commit_results),
  'exact retry replays the same logical response'
);
select is(
  (select count(*)::integer from public.notifications where cleaning_target_id = '49000000-0000-4000-8000-000000000001'),
  1,
  'exact retry creates no duplicate notification'
);
select is(
  (select count(*)::integer from public.audit_events where event_type = 'assignment.notified'),
  1,
  'exact retry creates no duplicate audit event'
);

select throws_ok(
  $$ select private.commit_and_notify_assignments_at(
    '29000000-0000-4000-8000-000000000001', '2027-10-01',
    (select before_impact ->> 'impactFingerprint' from assignment_commit_results),
    jsonb_build_array(jsonb_build_object(
      'cleaningTargetId', '49000000-0000-4000-8000-000000000001',
      'expectedAssignmentVersion', 2, 'expectedAvailabilityVersion', 1
    )), 'assignment-commit-notify-0001', repeat('b', 64),
    '2027-10-01 09:00:00+09') $$,
  'IDEMPOTENCY_KEY_REUSED',
  'same scoped key with a different request hash is rejected'
);

select throws_ok(
  $$ select private.commit_and_notify_assignments_at(
    '29000000-0000-4000-8000-000000000001', '2027-10-01',
    (private.assignment_commit_impact_at('2027-10-01', '2027-10-01 09:00:00+09')->>'impactFingerprint'),
    jsonb_build_array(
      jsonb_build_object('cleaningTargetId', '49000000-0000-4000-8000-000000000002', 'expectedAssignmentVersion', 2, 'expectedAvailabilityVersion', 1),
      jsonb_build_object('cleaningTargetId', '49000000-0000-4000-8000-000000000004', 'expectedAssignmentVersion', 2, 'expectedAvailabilityVersion', 1)
    ), 'assignment-commit-atomic-0001', repeat('c', 64),
    '2027-10-01 09:00:00+09') $$,
  'ASSIGNMENT_MAID_UNAVAILABLE',
  'a blocked selected draft rolls back the complete subset'
);
select is(
  (select status::text from public.cleaning_targets where id = '49000000-0000-4000-8000-000000000002'),
  'draft_assigned',
  'failed subset commit leaves the otherwise valid target unchanged'
);

select throws_ok(
  $$ select private.commit_and_notify_assignments_at(
    '29000000-0000-4000-8000-000000000001', '2027-10-01',
    (private.assignment_commit_impact_at('2027-10-01', '2027-10-01 09:00:00+09')->>'impactFingerprint'),
    jsonb_build_array(jsonb_build_object(
      'cleaningTargetId', '49000000-0000-4000-8000-000000000002',
      'expectedAssignmentVersion', 1, 'expectedAvailabilityVersion', 1
    )), 'assignment-commit-stale-target-0001', repeat('7', 64),
    '2027-10-01 09:00:00+09') $$,
  'ASSIGNMENT_VERSION_CONFLICT',
  'stale target assignment version rejects the complete selected subset'
);
select is(
  (select count(*)::integer from public.notifications where cleaning_target_id = '49000000-0000-4000-8000-000000000002'),
  0,
  'stale target version creates no notification side effect'
);
select ok(
  exists (
    select 1
    from jsonb_array_elements(
      private.assignment_commit_impact_at(
        '2027-10-01', '2027-10-01 17:00:00+09'
      ) -> 'blockedDrafts'
    ) blocked
    where blocked ->> 'cleaningTargetId' = '49000000-0000-4000-8000-000000000002'
      and blocked #>> '{reasonCodes,0}' = 'ASSIGNMENT_WINDOW_EXPIRED'
  ),
  'an expired due window is reported with a stable reason code'
);

update public.cleaning_targets
set due_at = '2027-10-01 16:30:00+09'
where id = '49000000-0000-4000-8000-000000000002';
select ok(
  exists (
    select 1
    from jsonb_array_elements(
      private.assignment_commit_impact_at(
        '2027-10-01', '2027-10-01 09:00:00+09'
      ) -> 'blockedDrafts'
    ) blocked
    where blocked ->> 'cleaningTargetId' = '49000000-0000-4000-8000-000000000002'
      and blocked #>> '{reasonCodes,0}' = 'ASSIGNMENT_DRAFT_STALE_SCHEDULE'
  ),
  'schedule changes after draft are reported as stale'
);

update public.profiles
set status = 'inactive'
where id = '29000000-0000-4000-8000-000000000003';
select ok(
  exists (
    select 1
    from jsonb_array_elements(
      private.assignment_commit_impact_at(
        '2027-10-01', '2027-10-01 09:00:00+09'
      ) -> 'blockedDrafts'
    ) blocked
    where blocked ->> 'cleaningTargetId' = '49000000-0000-4000-8000-000000000004'
      and blocked #>> '{reasonCodes,0}' = 'ASSIGNMENT_MAID_UNAVAILABLE'
  ),
  'inactive maid is reported as unavailable'
);

create temporary table assignment_multi_commit_result as
select private.commit_and_notify_assignments_at(
  '29000000-0000-4000-8000-000000000001',
  '2027-10-01',
  private.assignment_commit_impact_at(
    '2027-10-01', '2027-10-01 09:00:00+09'
  ) ->> 'impactFingerprint',
  jsonb_build_array(
    jsonb_build_object(
      'cleaningTargetId', '49000000-0000-4000-8000-000000000005',
      'expectedAssignmentVersion', 2, 'expectedAvailabilityVersion', 1
    ),
    jsonb_build_object(
      'cleaningTargetId', '49000000-0000-4000-8000-000000000006',
      'expectedAssignmentVersion', 2, 'expectedAvailabilityVersion', 1
    )
  ),
  'assignment-commit-multi-0001', repeat('e', 64),
  '2027-10-01 09:00:00+09'
) as response;

select is(
  (select jsonb_array_length(response -> 'notifiedAssignments') from assignment_multi_commit_result),
  2,
  'multi-target commit atomically notifies every selected draft'
);
select is(
  (select count(*)::integer from private.notification_outbox),
  3,
  'multi-target commit creates exactly one outbox row per notification'
);

select throws_ok(
  $$ do $change$
     begin
       update public.availability_versions
       set is_current = false, status = 'superseded'
       where id = '39000000-0000-4000-8000-000000000001';
       insert into public.availability_versions (
         id, maid_profile_id, week_start, version, submitted_at
       ) values (
         '39000000-0000-4000-8000-000000000003',
         '29000000-0000-4000-8000-000000000002',
         '2027-09-27', 2, '2027-09-30 20:00:00+09'
       );
       insert into public.availability_days (
         availability_version_id, work_date, available
       ) values (
         '39000000-0000-4000-8000-000000000003', '2027-10-01', false
       );
     end
     $change$ $$,
  'ASSIGNMENT_AVAILABILITY_STALE',
  'notified assignment prevents a racing availability decision from winning'
);

select ok(
  exists (
    select 1
    from public.list_developer_audit_events(
      '29000000-0000-4000-8000-000000000004',
      array['assignment.notified'],
      '29000000-0000-4000-8000-000000000001',
      clock_timestamp() - interval '1 day',
      clock_timestamp() + interval '1 minute',
      null, null, 100
    ) event
    where event.event_type = 'assignment.notified'
      and array(select jsonb_object_keys(event.summary) order by 1) = array[
        'assignmentId', 'cleaningTargetId', 'maidProfileId',
        'revision', 'sequenceNumber', 'serviceDate'
      ]::text[]
  ),
  'developer audit projection exposes only the approved notification summary'
);

select ok(
  not has_table_privilege('anon', 'private.notification_outbox', 'SELECT')
    and not has_table_privilege('authenticated', 'private.notification_outbox', 'SELECT')
    and not has_table_privilege('authenticated', 'private.notification_outbox', 'UPDATE')
    and has_table_privilege('service_role', 'private.notification_outbox', 'SELECT')
    and has_table_privilege('service_role', 'private.notification_outbox', 'UPDATE'),
  'notification outbox is server-owned and hidden from Data API roles'
);
select ok(
  not has_function_privilege('anon', 'public.commit_and_notify_assignments(uuid,date,text,jsonb,text,text)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.commit_and_notify_assignments(uuid,date,text,jsonb,text,text)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.commit_and_notify_assignments(uuid,date,text,jsonb,text,text)', 'EXECUTE'),
  'assignment commit command execute grant is service-role only'
);
select ok(
  not has_function_privilege('anon', 'public.get_assignment_commit_impact(uuid,date)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.get_assignment_commit_impact(uuid,date)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.get_assignment_commit_impact(uuid,date)', 'EXECUTE'),
  'assignment impact projection execute grant is service-role only'
);
select throws_ok(
  $$ select private.commit_and_notify_assignments_at(
    '29000000-0000-4000-8000-000000000001', '2027-10-03', repeat('a', 64),
    jsonb_build_array(jsonb_build_object('cleaningTargetId', '49000000-0000-4000-8000-000000000002', 'expectedAssignmentVersion', 2, 'expectedAvailabilityVersion', 1)),
    'assignment-commit-date-0001', repeat('d', 64), '2027-10-01 09:00:00+09') $$,
  'ASSIGNMENT_COMMIT_NOT_ALLOWED',
  'commit is limited to KST today and tomorrow'
);
select throws_ok(
  $$ update public.audit_events set after_state = '{}' where event_type = 'assignment.notified' $$,
  'APPEND_ONLY_LEDGER',
  'assignment notification audit remains immutable'
);

select * from finish();
rollback;
