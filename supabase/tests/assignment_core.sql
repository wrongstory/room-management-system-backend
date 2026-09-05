begin;

select plan(28);

insert into auth.users (id) values
  ('18000000-0000-4000-8000-000000000001'),
  ('18000000-0000-4000-8000-000000000002'),
  ('18000000-0000-4000-8000-000000000003'),
  ('18000000-0000-4000-8000-000000000004'),
  ('18000000-0000-4000-8000-000000000005');

set local role service_role;

select public.bootstrap_first_developer_profile(
  '28000000-0000-4000-8000-000000000005',
  '18000000-0000-4000-8000-000000000005',
  '배정 감사 개발자',
  '배정 감사 개발자',
  '0005',
  'assignment-audit-developer-phone-hash',
  'assignment-audit-bootstrap-0001'
);

reset role;

insert into public.profiles (
  id, auth_user_id, display_name, display_name_normalized,
  login_id, login_id_normalized, login_sequence, role, status
) values
  (
    '28000000-0000-4000-8000-000000000001',
    '18000000-0000-4000-8000-000000000001',
    '배정 관리자', '배정 관리자', '배정 관리자', '배정 관리자', 0, 'admin', 'active'
  ),
  (
    '28000000-0000-4000-8000-000000000002',
    '18000000-0000-4000-8000-000000000002',
    '배정 메이드1', '배정 메이드1', '배정 메이드1', '배정 메이드1', 0, 'maid', 'active'
  ),
  (
    '28000000-0000-4000-8000-000000000003',
    '18000000-0000-4000-8000-000000000003',
    '배정 메이드2', '배정 메이드2', '배정 메이드2', '배정 메이드2', 0, 'maid', 'active'
  ),
  (
    '28000000-0000-4000-8000-000000000004',
    '18000000-0000-4000-8000-000000000004',
    '비활성 메이드', '비활성 메이드', '비활성 메이드', '비활성 메이드', 0, 'maid', 'inactive'
  );

insert into public.cleaning_targets (
  id, room_id, cleaning_kind, source, source_key,
  original_service_date, effective_service_date, available_from, due_at,
  status, room_type_snapshot, fee_snapshot, template_snapshot, created_by
) values
  (
    '48000000-0000-4000-8000-000000000001',
    (select id from public.rooms order by room_number offset 0 limit 1),
    'additional', 'manual_room_request', 'assignment-target-1',
    '2027-10-01', '2027-10-01', '2027-10-01 09:00:00+09', '2027-10-01 15:00:00+09',
    'unassigned', '{}'::jsonb, 10000, '{}'::jsonb,
    '28000000-0000-4000-8000-000000000001'
  ),
  (
    '48000000-0000-4000-8000-000000000002',
    (select id from public.rooms order by room_number offset 1 limit 1),
    'additional', 'manual_room_request', 'assignment-target-2',
    '2027-10-01', '2027-10-01', '2027-10-01 09:30:00+09', '2027-10-01 15:30:00+09',
    'unassigned', '{}'::jsonb, 10000, '{}'::jsonb,
    '28000000-0000-4000-8000-000000000001'
  ),
  (
    '48000000-0000-4000-8000-000000000003',
    (select id from public.rooms order by room_number offset 2 limit 1),
    'additional', 'manual_room_request', 'assignment-target-3',
    '2027-10-01', '2027-10-01', null, null,
    'unassigned', '{}'::jsonb, 10000, '{}'::jsonb,
    '28000000-0000-4000-8000-000000000001'
  ),
  (
    '48000000-0000-4000-8000-000000000004',
    (select id from public.rooms order by room_number offset 3 limit 1),
    'additional', 'manual_room_request', 'assignment-target-4',
    '2027-10-02', '2027-10-02', null, null,
    'unassigned', '{}'::jsonb, 10000, '{}'::jsonb,
    '28000000-0000-4000-8000-000000000001'
  ),
  (
    '48000000-0000-4000-8000-000000000005',
    (select id from public.rooms order by room_number offset 4 limit 1),
    'additional', 'manual_room_request', 'assignment-target-5',
    '2027-10-03', '2027-10-03', null, null,
    'notified', '{}'::jsonb, 10000, '{}'::jsonb,
    '28000000-0000-4000-8000-000000000001'
  ),
  (
    '48000000-0000-4000-8000-000000000006',
    (select id from public.rooms order by room_number offset 5 limit 1),
    'additional', 'manual_room_request', 'assignment-target-6',
    '2027-10-04', '2027-10-04', null, null,
    'cancelled', '{}'::jsonb, 10000, '{}'::jsonb,
    '28000000-0000-4000-8000-000000000001'
  ),
  (
    '48000000-0000-4000-8000-000000000007',
    (select id from public.rooms order by room_number offset 6 limit 1),
    'additional', 'manual_room_request', 'assignment-origin',
    '2027-10-05', '2027-10-05', null, null,
    'approved', '{}'::jsonb, 10000, '{}'::jsonb,
    '28000000-0000-4000-8000-000000000001'
  );

insert into public.cleaning_assignments (
  id, cleaning_target_id, maid_profile_id, sequence_number, revision,
  is_current, ended_at, change_reason_code, changed_by
) values (
  '58000000-0000-4000-8000-000000000007',
  '48000000-0000-4000-8000-000000000007',
  '28000000-0000-4000-8000-000000000002',
  7, 1, true, null, null,
  '28000000-0000-4000-8000-000000000001'
);

insert into public.cleaning_attempts (
  id, cleaning_target_id, assignment_id, maid_profile_id, attempt_number,
  status, assignment_revision, ended_at, end_reason, template_snapshot, room_snapshot
) values (
  '68000000-0000-4000-8000-000000000007',
  '48000000-0000-4000-8000-000000000007',
  '58000000-0000-4000-8000-000000000007',
  '28000000-0000-4000-8000-000000000002',
  1, 'approved', 1, clock_timestamp(), 'TEST_APPROVED', '{}'::jsonb, '{}'::jsonb
);

-- 실제 lifecycle 순서: current assignment에 attempt를 연결한 뒤 과거 담당을 종료한다.
update public.cleaning_assignments set is_current=false,ended_at=clock_timestamp(),change_reason_code='TEST_COMPLETED'
where id='58000000-0000-4000-8000-000000000007';

insert into public.cleaning_targets (
  id, room_id, cleaning_kind, source, source_key,
  original_service_date, effective_service_date, status,
  room_type_snapshot, fee_snapshot, template_snapshot, created_by,
  reclean_of_attempt_id, reclean_maid_profile_id
) values (
  '48000000-0000-4000-8000-000000000008',
  (select room_id from public.cleaning_targets where id = '48000000-0000-4000-8000-000000000007'),
  'reclean', 'inspection_reclean', 'assignment-reclean',
  '2027-10-05', '2027-10-05', 'unassigned',
  '{}'::jsonb, 0, '{}'::jsonb,
  '28000000-0000-4000-8000-000000000001',
  '68000000-0000-4000-8000-000000000007',
  '28000000-0000-4000-8000-000000000002'
);

create temporary table assignment_results (
  first_response jsonb,
  replay_response jsonb,
  revised_response jsonb
);

insert into assignment_results (first_response)
select public.save_cleaning_assignment_draft(
  '28000000-0000-4000-8000-000000000001',
  '48000000-0000-4000-8000-000000000001',
  '28000000-0000-4000-8000-000000000002',
  1, 1, 'assignment-first-0001', repeat('a', 64)
);

select ok(
  (select first_response ->> 'assignmentId' is not null from assignment_results),
  'first draft assignment returns an assignment projection'
);
select ok(
  exists (
    select 1 from public.cleaning_assignments a
    where a.cleaning_target_id = '48000000-0000-4000-8000-000000000001'
      and a.revision = 2 and a.service_date = '2027-10-01'
      and a.available_from_snapshot = '2027-10-01 09:00:00+09'
      and a.due_at_snapshot = '2027-10-01 15:00:00+09'
  ),
  'first draft stores the exact target schedule snapshot'
);
select is(
  (select count(*)::integer
   from public.list_developer_audit_events(
     '28000000-0000-4000-8000-000000000005',
     array['assignment.draft_saved'],
     '28000000-0000-4000-8000-000000000001',
     clock_timestamp() - interval '1 hour',
     clock_timestamp() + interval '1 hour',
     null, null, 100
   )),
  1,
  'developer audit projection exposes the assignment draft event'
);
select is(
  (select summary
   from public.list_developer_audit_events(
     '28000000-0000-4000-8000-000000000005',
     array['assignment.draft_saved'],
     '28000000-0000-4000-8000-000000000001',
     clock_timestamp() - interval '1 hour',
     clock_timestamp() + interval '1 hour',
     null, null, 100
   )),
  jsonb_build_object(
    'cleaningTargetId', '48000000-0000-4000-8000-000000000001',
    'maidProfileId', '28000000-0000-4000-8000-000000000002',
    'serviceDate', '2027-10-01',
    'sequenceNumber', 1,
    'revision', 2,
    'targetAssignmentVersion', 2
  ),
  'assignment developer audit summary contains only approved fields'
);
select ok(
  not exists (
    select 1
    from public.list_developer_audit_events(
      '28000000-0000-4000-8000-000000000005',
      array['assignment.draft_saved'],
      '28000000-0000-4000-8000-000000000001',
      clock_timestamp() - interval '1 hour',
      clock_timestamp() + interval '1 hour',
      null, null, 100
    ) projected
    where to_jsonb(projected) ?| array['before_state', 'after_state']
      or projected.summary ? 'requestHash'
      or projected.summary::text ~* '(phone|password|token|guestName|pin)'
  ),
  'assignment audit projection hides raw state, request hash, and sensitive fields'
);

update assignment_results
set replay_response = public.save_cleaning_assignment_draft(
  '28000000-0000-4000-8000-000000000001',
  '48000000-0000-4000-8000-000000000001',
  '28000000-0000-4000-8000-000000000002',
  1, 1, 'assignment-first-0001', repeat('a', 64)
);

select is(
  (select replay_response ->> 'assignmentId' from assignment_results),
  (select first_response ->> 'assignmentId' from assignment_results),
  'exact idempotent replay returns the same assignment'
);
select is(
  (select count(*)::integer from public.cleaning_assignments
    where cleaning_target_id = '48000000-0000-4000-8000-000000000001'),
  1,
  'exact replay creates no additional assignment revision'
);
select is(
  (select count(*)::integer from public.audit_events
    where event_type = 'assignment.draft_saved'
      and after_state ->> 'cleaningTargetId' = '48000000-0000-4000-8000-000000000001'),
  1,
  'exact replay creates no additional audit event'
);

select throws_ok(
  $$ select public.save_cleaning_assignment_draft(
    '28000000-0000-4000-8000-000000000001',
    '48000000-0000-4000-8000-000000000001',
    '28000000-0000-4000-8000-000000000002',
    2, 1, 'assignment-first-0001', repeat('b', 64)
  ) $$,
  '23505', 'IDEMPOTENCY_KEY_REUSED',
  'same idempotency key with another payload is rejected'
);

update assignment_results
set revised_response = public.save_cleaning_assignment_draft(
  '28000000-0000-4000-8000-000000000001',
  '48000000-0000-4000-8000-000000000001',
  '28000000-0000-4000-8000-000000000003',
  1, 2, 'assignment-revise-0001', repeat('c', 64)
);

select ok(
  (select revised_response ->> 'assignmentId' <> first_response ->> 'assignmentId'
    from assignment_results),
  'draft revision replacement creates a new immutable assignment row'
);
select ok(
  (select count(*) = 2 and count(*) filter (where is_current) = 1
    and max(revision) = 3
    from public.cleaning_assignments
    where cleaning_target_id = '48000000-0000-4000-8000-000000000001'),
  'target keeps exactly one current assignment and preserves old revision'
);
select ok(
  exists (
    select 1 from public.cleaning_assignments
    where cleaning_target_id = '48000000-0000-4000-8000-000000000001'
      and revision = 2 and not is_current and ended_at is not null
      and change_reason_code = 'DRAFT_REVISED'
  ),
  'replaced draft closes with DRAFT_REVISED'
);
select is(
  (select assignment_version from public.cleaning_targets
    where id = '48000000-0000-4000-8000-000000000001'),
  3::bigint,
  'target assignmentVersion is the authoritative revision CAS'
);

select throws_ok(
  $$ update public.cleaning_assignments
    set sequence_number = 99
    where cleaning_target_id = '48000000-0000-4000-8000-000000000001'
      and revision = 2 $$,
  '23514', 'ASSIGNMENT_SNAPSHOT_IMMUTABLE',
  'historical assignment core snapshot is immutable'
);

select throws_ok(
  $$ select public.save_cleaning_assignment_draft(
    '28000000-0000-4000-8000-000000000001',
    '48000000-0000-4000-8000-000000000003',
    '28000000-0000-4000-8000-000000000003',
    1, 1, 'assignment-sequence-conflict', repeat('d', 64)
  ) $$,
  '23505',
  'duplicate key value violates unique constraint "cleaning_assignments_current_maid_date_sequence"',
  'same maid date and current sequence is rejected'
);

select lives_ok(
  $$ select public.save_cleaning_assignment_draft(
    '28000000-0000-4000-8000-000000000001',
    '48000000-0000-4000-8000-000000000002',
    '28000000-0000-4000-8000-000000000002',
    1, 1, 'assignment-other-maid-0001', repeat('e', 64)
  ) $$,
  'different maids may use the same sequence on the same date'
);
select lives_ok(
  $$ select public.save_cleaning_assignment_draft(
    '28000000-0000-4000-8000-000000000001',
    '48000000-0000-4000-8000-000000000004',
    '28000000-0000-4000-8000-000000000003',
    1, 1, 'assignment-other-date-0001', repeat('f', 64)
  ) $$,
  'the same maid sequence may be reused on a different date'
);

select throws_ok(
  $$ select public.save_cleaning_assignment_draft(
    '28000000-0000-4000-8000-000000000001',
    '48000000-0000-4000-8000-000000000003',
    '28000000-0000-4000-8000-000000000004',
    2, 1, 'assignment-inactive-maid', repeat('1', 64)
  ) $$,
  '23514', 'ACTIVE_MAID_REQUIRED',
  'inactive maid cannot be assigned'
);
select throws_ok(
  $$ select public.save_cleaning_assignment_draft(
    '28000000-0000-4000-8000-000000000002',
    '48000000-0000-4000-8000-000000000003',
    '28000000-0000-4000-8000-000000000002',
    2, 1, 'assignment-non-admin', repeat('2', 64)
  ) $$,
  '42501', 'ADMIN_REQUIRED',
  'non-admin actor cannot save a draft'
);
select throws_ok(
  $$ select public.save_cleaning_assignment_draft(
    '28000000-0000-4000-8000-000000000001',
    '48000000-0000-4000-8000-000000000003',
    '28000000-0000-4000-8000-000000000002',
    2, 2, 'assignment-stale-version', repeat('4', 64)
  ) $$,
  '40001', 'ASSIGNMENT_VERSION_CONFLICT',
  'stale assignmentVersion is rejected'
);
select throws_ok(
  $$ select public.save_cleaning_assignment_draft(
    '28000000-0000-4000-8000-000000000001',
    '48000000-0000-4000-8000-000000000005',
    '28000000-0000-4000-8000-000000000002',
    2, 1, 'assignment-notified', repeat('6', 64)
  ) $$,
  '23514', 'ASSIGNMENT_TARGET_STATE_INVALID',
  'notified target cannot be changed by the draft command'
);
select throws_ok(
  $$ select public.save_cleaning_assignment_draft(
    '28000000-0000-4000-8000-000000000001',
    '48000000-0000-4000-8000-000000000006',
    '28000000-0000-4000-8000-000000000002',
    2, 1, 'assignment-cancelled', repeat('7', 64)
  ) $$,
  '23514', 'ASSIGNMENT_TARGET_STATE_INVALID',
  'cancelled target cannot be changed by the draft command'
);
select throws_ok(
  $$ select public.save_cleaning_assignment_draft(
    '28000000-0000-4000-8000-000000000001',
    '48000000-0000-4000-8000-000000000008',
    '28000000-0000-4000-8000-000000000003',
    8, 1, 'assignment-reclean-wrong-maid', repeat('8', 64)
  ) $$,
  '23514', 'RECLEAN_MAID_IMMUTABLE',
  'inspection reclean cannot be assigned to another maid'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.save_cleaning_assignment_draft(uuid,uuid,uuid,integer,bigint,text,text)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'authenticated',
      'public.save_cleaning_assignment_draft(uuid,uuid,uuid,integer,bigint,text,text)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.save_cleaning_assignment_draft(uuid,uuid,uuid,integer,bigint,text,text)',
      'EXECUTE'
    ),
  'assignment command execute grant is service-role only'
);
select ok(
  not has_table_privilege('authenticated', 'public.cleaning_assignments', 'INSERT')
    and not has_table_privilege('authenticated', 'public.cleaning_assignments', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.cleaning_assignments', 'DELETE'),
  'authenticated direct assignment DML remains blocked'
);
select is(
  (select count(*)::integer from public.notifications
    where cleaning_target_id in (
      '48000000-0000-4000-8000-000000000001',
      '48000000-0000-4000-8000-000000000002',
      '48000000-0000-4000-8000-000000000004'
    )),
  0,
  'draft saves create no notifications'
);
select is(
  (select count(*)::integer from public.cleaning_attempts
    where cleaning_target_id in (
      '48000000-0000-4000-8000-000000000001',
      '48000000-0000-4000-8000-000000000002',
      '48000000-0000-4000-8000-000000000004'
    )),
  0,
  'draft saves create no cleaning attempts'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '18000000-0000-4000-8000-000000000002', true);
select ok(
  (select count(*) > 0 from public.cleaning_assignments)
    and not exists (
      select 1 from public.cleaning_assignments
      where maid_profile_id <> '28000000-0000-4000-8000-000000000002'
    ),
  'maid RLS exposes only own current and historical revisions'
);

reset role;

select * from finish();
rollback;
