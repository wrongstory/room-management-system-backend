begin;

select plan(40);

insert into auth.users (id) values
  ('70000000-0000-4000-8000-000000000101'),
  ('70000000-0000-4000-8000-000000000102'),
  ('70000000-0000-4000-8000-000000000104');

insert into public.profiles (
  id, auth_user_id, display_name, display_name_normalized,
  login_id, login_id_normalized, login_sequence, role, status,
  must_change_password
) values
  ('70000000-0000-4000-8000-000000000201', '70000000-0000-4000-8000-000000000101',
   '운영 조회 관리자', '운영 조회 관리자', '운영 조회 관리자', '운영 조회 관리자', 0,
   'admin', 'active', false),
  ('70000000-0000-4000-8000-000000000202', '70000000-0000-4000-8000-000000000102',
   '운영 조회 메이드', '운영 조회 메이드', '운영 조회 메이드', '운영 조회 메이드', 0,
   'maid', 'active', false),
  ('70000000-0000-4000-8000-000000000204', '70000000-0000-4000-8000-000000000104',
   '임시 비밀번호 관리자', '임시 비밀번호 관리자', '임시 비밀번호 관리자', '임시 비밀번호 관리자', 0,
   'admin', 'active', true);

insert into auth.sessions (id, user_id) values
  ('70000000-0000-4000-8000-000000000301', '70000000-0000-4000-8000-000000000101'),
  ('70000000-0000-4000-8000-000000000302', '70000000-0000-4000-8000-000000000102'),
  ('70000000-0000-4000-8000-000000000304', '70000000-0000-4000-8000-000000000104');

insert into auth.sessions (id, user_id)
select '70000000-0000-4000-8000-000000000303', auth_user_id
from public.profiles
where role = 'developer';

create temporary table room_operations_read_results (
  name text primary key,
  value jsonb not null
);

insert into room_operations_read_results values
  ('expired', public.mutate_room_operation(
    '70000000-0000-4000-8000-000000000201',
    (select id from public.rooms where room_number = '117'),
    'create_block', (select state_version from public.rooms where room_number = '117'),
    'EXPIRED_MAINTENANCE', jsonb_build_object(
      'entityId', '70000000-0000-4000-8000-000000000401',
      'startsAt', clock_timestamp() - interval '3 hours',
      'endsAt', clock_timestamp() - interval '2 hours'
    ), 'room-read-expired-0001', repeat('1', 64)
  ));

insert into room_operations_read_results values
  ('active', public.mutate_room_operation(
    '70000000-0000-4000-8000-000000000201',
    (select id from public.rooms where room_number = '117'),
    'create_block', (select state_version from public.rooms where room_number = '117'),
    'ACTIVE_MAINTENANCE', jsonb_build_object(
      'entityId', '70000000-0000-4000-8000-000000000402',
      'startsAt', clock_timestamp() - interval '1 hour',
      'endsAt', clock_timestamp() + interval '1 hour'
    ), 'room-read-active-0001', repeat('2', 64)
  ));

insert into room_operations_read_results values
  ('scheduled', public.mutate_room_operation(
    '70000000-0000-4000-8000-000000000201',
    (select id from public.rooms where room_number = '117'),
    'create_block', (select state_version from public.rooms where room_number = '117'),
    'SCHEDULED_MAINTENANCE', jsonb_build_object(
      'entityId', '70000000-0000-4000-8000-000000000403',
      'startsAt', clock_timestamp() + interval '2 hours',
      'endsAt', clock_timestamp() + interval '3 hours'
    ), 'room-read-scheduled-0001', repeat('3', 64)
  ));

insert into room_operations_read_results values
  ('released-source', public.mutate_room_operation(
    '70000000-0000-4000-8000-000000000201',
    (select id from public.rooms where room_number = '117'),
    'create_block', (select state_version from public.rooms where room_number = '117'),
    'RELEASE_ME', jsonb_build_object(
      'entityId', '70000000-0000-4000-8000-000000000404',
      'startsAt', clock_timestamp() - interval '30 minutes'
    ), 'room-read-release-source-0001', repeat('4', 64)
  ));

insert into room_operations_read_results values (
  'before-release', public.list_room_operation_blocks(
    '70000000-0000-4000-8000-000000000201',
    '70000000-0000-4000-8000-000000000301',
    (select id from public.rooms where room_number = '117'),
    'actionable'
  )
);

select is(
  (select value ->> 'roomId' from room_operations_read_results where name = 'before-release'),
  (select id::text from public.rooms where room_number = '117'),
  'operation blocks identify the room'
);
select is(
  (select (value ->> 'roomStateVersion')::bigint from room_operations_read_results where name = 'before-release'),
  (select state_version from public.rooms where room_number = '117'),
  'operation block envelope exposes current room CAS version'
);
select is(
  (select count(*)::integer from room_operations_read_results r,
    jsonb_array_elements(r.value -> 'items') item
    where r.name = 'before-release' and item ->> 'id' in (
      '70000000-0000-4000-8000-000000000401',
      '70000000-0000-4000-8000-000000000402',
      '70000000-0000-4000-8000-000000000403',
      '70000000-0000-4000-8000-000000000404'
    )), 4, 'all unreleased actionable blocks are returned'
);
select is(
  (select item ->> 'status' from room_operations_read_results r,
    jsonb_array_elements(r.value -> 'items') item
    where r.name = 'before-release' and item ->> 'id' = '70000000-0000-4000-8000-000000000401'),
  'expired', 'past unreleased block is expired'
);
select is(
  (select item ->> 'status' from room_operations_read_results r,
    jsonb_array_elements(r.value -> 'items') item
    where r.name = 'before-release' and item ->> 'id' = '70000000-0000-4000-8000-000000000402'),
  'active', 'current block is active'
);
select is(
  (select item ->> 'status' from room_operations_read_results r,
    jsonb_array_elements(r.value -> 'items') item
    where r.name = 'before-release' and item ->> 'id' = '70000000-0000-4000-8000-000000000403'),
  'scheduled', 'future block is scheduled'
);

insert into room_operations_read_results values (
  'release', public.mutate_room_operation(
    '70000000-0000-4000-8000-000000000201',
    (select id from public.rooms where room_number = '117'),
    'release_block',
    (select (value ->> 'roomStateVersion')::bigint from room_operations_read_results where name = 'before-release'),
    'RELEASED_AFTER_READ',
    jsonb_build_object('entityId', '70000000-0000-4000-8000-000000000404'),
    'room-read-release-0001', repeat('5', 64)
  )
);

select is(
  jsonb_array_length(public.list_room_operation_blocks(
    '70000000-0000-4000-8000-000000000201',
    '70000000-0000-4000-8000-000000000301',
    (select id from public.rooms where room_number = '117'), 'actionable'
  ) -> 'items'), 3, 'released block is excluded from actionable reads'
);
select is(
  (select value ->> 'entity_id' from room_operations_read_results where name = 'release'),
  '70000000-0000-4000-8000-000000000404',
  'read block ID can drive release in a new command'
);

insert into room_operations_read_results values (
  'block-page-1', public.list_room_operation_blocks_page(
    '70000000-0000-4000-8000-000000000201',
    '70000000-0000-4000-8000-000000000301',
    (select id from public.rooms where room_number = '117'),
    'actionable', 2, null, null
  )
);
insert into room_operations_read_results values (
  'block-page-2', public.list_room_operation_blocks_page(
    '70000000-0000-4000-8000-000000000201',
    '70000000-0000-4000-8000-000000000301',
    (select id from public.rooms where room_number = '117'),
    'actionable', 2,
    (select (value #>> '{nextCursor,occurredAt}')::timestamptz from room_operations_read_results where name = 'block-page-1'),
    (select (value #>> '{nextCursor,id}')::uuid from room_operations_read_results where name = 'block-page-1')
  )
);
select is(
  jsonb_array_length((select value -> 'items' from room_operations_read_results where name = 'block-page-1')),
  2, 'operation block page respects the requested limit'
);
select ok(
  (select (value ->> 'hasMore')::boolean and value -> 'nextCursor' is not null
   from room_operations_read_results where name = 'block-page-1'),
  'first operation block page returns a continuation position'
);
select is(
  jsonb_array_length((select value -> 'items' from room_operations_read_results where name = 'block-page-2')),
  1, 'second operation block page returns the remaining row'
);
select is(
  (select count(distinct item ->> 'id')::integer
   from room_operations_read_results results
   cross join lateral jsonb_array_elements(results.value -> 'items') item
   where results.name in ('block-page-1', 'block-page-2')),
  3, 'keyset traversal has no duplicate or missing operation blocks'
);
select throws_ok(
  $$select public.list_room_operation_blocks_page(
    '70000000-0000-4000-8000-000000000201',
    '70000000-0000-4000-8000-000000000301',
    (select id from public.rooms where room_number = '117'), 'actionable', 101, null, null)$$,
  '22023', 'ROOM_OPERATION_PAGE_LIMIT_INVALID', 'operation block page rejects an oversized limit'
);
select throws_ok(
  $$select public.list_room_operation_blocks_page(
    '70000000-0000-4000-8000-000000000201',
    '70000000-0000-4000-8000-000000000301',
    (select id from public.rooms where room_number = '117'), 'actionable', 2, clock_timestamp(), null)$$,
  '22023', 'INVALID_ROOM_OPERATION_CURSOR', 'operation block page rejects a partial cursor'
);
select ok(
  has_function_privilege('service_role', 'public.list_room_operation_blocks_page(uuid,uuid,uuid,text,integer,timestamptz,uuid)', 'EXECUTE'),
  'service role can execute the bounded operation block projection'
);
select ok(
  not has_function_privilege('authenticated', 'public.list_room_operation_blocks_page(uuid,uuid,uuid,text,integer,timestamptz,uuid)', 'EXECUTE'),
  'authenticated cannot execute the bounded operation block projection directly'
);
select ok(
  has_function_privilege('service_role', 'public.list_room_issues_page(uuid,uuid,uuid,text,integer,timestamptz,uuid)', 'EXECUTE'),
  'service role can execute the bounded issue projection'
);
select ok(
  not has_function_privilege('authenticated', 'public.list_room_issues_page(uuid,uuid,uuid,text,integer,timestamptz,uuid)', 'EXECUTE'),
  'authenticated cannot execute the bounded issue projection directly'
);

insert into public.room_operation_blocks (
  room_id, reason_code, starts_at, ends_at, created_by
)
select
  (select id from public.rooms where room_number = '117'),
  'PAGINATION_FIXTURE',
  clock_timestamp() + make_interval(secs => series),
  clock_timestamp() + make_interval(secs => series + 1),
  '70000000-0000-4000-8000-000000000201'
from generate_series(1, 101) series;

insert into room_operations_read_results values (
  'block-max-page', public.list_room_operation_blocks_page(
    '70000000-0000-4000-8000-000000000201',
    '70000000-0000-4000-8000-000000000301',
    (select id from public.rooms where room_number = '117'),
    'actionable', 100, null, null
  )
);
select is(
  jsonb_array_length((select value -> 'items' from room_operations_read_results where name = 'block-max-page')),
  100, 'large fixture response remains capped at one hundred items'
);
select ok(
  (select (value ->> 'hasMore')::boolean and value -> 'nextCursor' is not null
   from room_operations_read_results where name = 'block-max-page'),
  'large fixture exposes a continuation instead of an unbounded response'
);

insert into room_operations_read_results values (
  'issue', public.mutate_room_operation(
    '70000000-0000-4000-8000-000000000201',
    (select id from public.rooms where room_number = '117'),
    'report_issue', (select state_version from public.rooms where room_number = '117'),
    'FACILITY_CHECK', jsonb_build_object(
      'entityId', '70000000-0000-4000-8000-000000000501',
      'category', 'FACILITY', 'severity', 'warning',
      'blocksGuestAssignment', true, 'description', '창문 점검 필요'
    ), 'room-read-issue-0001', repeat('6', 64)
  )
);
insert into room_operations_read_results values (
  'before-resolve', public.list_room_issues(
    '70000000-0000-4000-8000-000000000201',
    '70000000-0000-4000-8000-000000000301',
    (select id from public.rooms where room_number = '117'), 'open'
  )
);

select is(
  (select value #>> '{items,0,id}' from room_operations_read_results where name = 'before-resolve'),
  '70000000-0000-4000-8000-000000000501', 'open issue ID is returned'
);
select is(
  (select value #>> '{items,0,status}' from room_operations_read_results where name = 'before-resolve'),
  'open', 'only open issue status is projected'
);
select is(
  (select count(*)::integer
   from room_operations_read_results r
   cross join lateral jsonb_object_keys(r.value #> '{items,0}') key
   where r.name = 'before-resolve'),
  7, 'issue projection exposes only the seven documented safe summary keys'
);
select is(
  jsonb_array_length((select value -> 'items' from room_operations_read_results where name = 'before-resolve')),
  1, 'one open issue is listed'
);

insert into public.room_issues (
  id, room_id, category, severity, blocks_guest_assignment,
  description, reported_by, reported_at
) values
  ('70000000-0000-4000-8000-000000000502', (select id from public.rooms where room_number = '117'),
   'EQUIPMENT', 'info', false, null, '70000000-0000-4000-8000-000000000201', clock_timestamp() + interval '1 second'),
  ('70000000-0000-4000-8000-000000000503', (select id from public.rooms where room_number = '117'),
   'FACILITY', 'critical', true, 'door inspection', '70000000-0000-4000-8000-000000000201', clock_timestamp() + interval '2 seconds');

insert into room_operations_read_results values (
  'issue-page-1', public.list_room_issues_page(
    '70000000-0000-4000-8000-000000000201',
    '70000000-0000-4000-8000-000000000301',
    (select id from public.rooms where room_number = '117'), 'open', 2, null, null
  )
);
insert into room_operations_read_results values (
  'issue-page-2', public.list_room_issues_page(
    '70000000-0000-4000-8000-000000000201',
    '70000000-0000-4000-8000-000000000301',
    (select id from public.rooms where room_number = '117'), 'open', 2,
    (select (value #>> '{nextCursor,occurredAt}')::timestamptz from room_operations_read_results where name = 'issue-page-1'),
    (select (value #>> '{nextCursor,id}')::uuid from room_operations_read_results where name = 'issue-page-1')
  )
);
select is(
  jsonb_array_length((select value -> 'items' from room_operations_read_results where name = 'issue-page-1')),
  2, 'issue page respects the requested limit'
);
select ok(
  (select (value ->> 'hasMore')::boolean and value -> 'nextCursor' is not null
   from room_operations_read_results where name = 'issue-page-1'),
  'first issue page returns a continuation position'
);
select is(
  jsonb_array_length((select value -> 'items' from room_operations_read_results where name = 'issue-page-2')),
  1, 'second issue page returns the remaining row'
);
select is(
  (select count(distinct item ->> 'id')::integer
   from room_operations_read_results results
   cross join lateral jsonb_array_elements(results.value -> 'items') item
   where results.name in ('issue-page-1', 'issue-page-2')),
  3, 'issue keyset traversal has no duplicate or missing rows'
);

insert into room_operations_read_results values (
  'resolve', public.mutate_room_operation(
    '70000000-0000-4000-8000-000000000201',
    (select id from public.rooms where room_number = '117'),
    'resolve_issue',
    (select (value ->> 'roomStateVersion')::bigint from room_operations_read_results where name = 'before-resolve'),
    'ISSUE_FIXED', jsonb_build_object('entityId', '70000000-0000-4000-8000-000000000501'),
    'room-read-resolve-0001', repeat('7', 64)
  )
);
select is(
  (select count(*)::integer
   from jsonb_array_elements(public.list_room_issues(
     '70000000-0000-4000-8000-000000000201',
     '70000000-0000-4000-8000-000000000301',
     (select id from public.rooms where room_number = '117'), 'open'
   ) -> 'items') item
   where item ->> 'id' = '70000000-0000-4000-8000-000000000501'),
  0, 'resolved issue is excluded from open reads'
);
select is(
  (select value ->> 'entity_id' from room_operations_read_results where name = 'resolve'),
  '70000000-0000-4000-8000-000000000501',
  'read issue ID and room version can drive resolve'
);

select throws_ok(
  $$select public.list_room_operation_blocks(
    '70000000-0000-4000-8000-000000000202',
    '70000000-0000-4000-8000-000000000302',
    (select id from public.rooms where room_number = '117'), 'actionable')$$,
  '42501', 'ADMIN_REQUIRED', 'maid cannot list room operation blocks'
);
select throws_ok(
  $$select public.list_room_issues(
    (select id from public.profiles where role = 'developer'),
    '70000000-0000-4000-8000-000000000303',
    (select id from public.rooms where room_number = '117'), 'open')$$,
  '42501', 'ADMIN_REQUIRED', 'developer cannot list room issues'
);
select throws_ok(
  $$select public.list_room_issues(
    '70000000-0000-4000-8000-000000000204',
    '70000000-0000-4000-8000-000000000304',
    (select id from public.rooms where room_number = '117'), 'open')$$,
  '42501', 'PASSWORD_CHANGE_REQUIRED', 'temporary-password admin cannot list issues'
);
select throws_ok(
  $$select public.list_room_operation_blocks(
    '70000000-0000-4000-8000-000000000201',
    '70000000-0000-4000-8000-000000000399',
    (select id from public.rooms where room_number = '117'), 'actionable')$$,
  '42501', 'SESSION_REVOKED', 'unknown session cannot list room operations'
);
select throws_ok(
  $$select public.list_room_operation_blocks(
    '70000000-0000-4000-8000-000000000201',
    '70000000-0000-4000-8000-000000000301',
    (select id from public.rooms where room_number = '117'), 'active')$$,
  '22023', 'INVALID_ROOM_OPERATION_BLOCK_STATUS', 'unsupported block status is rejected'
);
select throws_ok(
  $$select public.list_room_issues(
    '70000000-0000-4000-8000-000000000201',
    '70000000-0000-4000-8000-000000000301',
    (select id from public.rooms where room_number = '117'), 'resolved')$$,
  '22023', 'INVALID_ROOM_ISSUE_STATUS', 'unsupported issue status is rejected'
);

select ok(
  has_function_privilege('service_role', 'public.list_room_operation_blocks(uuid,uuid,uuid,text)', 'EXECUTE'),
  'service role can execute operation block projection'
);
select ok(
  not has_function_privilege('authenticated', 'public.list_room_operation_blocks(uuid,uuid,uuid,text)', 'EXECUTE'),
  'authenticated cannot execute operation block projection directly'
);
select ok(
  has_function_privilege('service_role', 'public.list_room_issues(uuid,uuid,uuid,text)', 'EXECUTE'),
  'service role can execute issue projection'
);
select ok(
  not has_function_privilege('authenticated', 'public.list_room_issues(uuid,uuid,uuid,text)', 'EXECUTE'),
  'authenticated cannot execute issue projection directly'
);

select * from finish();
rollback;
