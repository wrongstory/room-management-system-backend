begin;

select no_plan();

insert into auth.users (id) values
  ('17000000-0000-4000-8000-000000000001'),
  ('17000000-0000-4000-8000-000000000002'),
  ('17000000-0000-4000-8000-000000000003'),
  ('17000000-0000-4000-8000-000000000004');

set local role service_role;
select public.bootstrap_first_developer_profile(
  '27000000-0000-4000-8000-000000000001',
  '17000000-0000-4000-8000-000000000001',
  'PLATFORM DEVELOPER', 'platform developer', '0001',
  'actor-activity-developer-phone-hash', 'actor-activity-bootstrap-0001'
);
reset role;

insert into public.profiles (
  id, auth_user_id, display_name, display_name_normalized,
  login_id, login_id_normalized, login_sequence, role, status
) values
  (
    '27000000-0000-4000-8000-000000000002',
    '17000000-0000-4000-8000-000000000002',
    '활동 관리자', '활동 관리자', '활동 관리자', '활동 관리자', 0,
    'admin', 'active'
  ),
  (
    '27000000-0000-4000-8000-000000000003',
    '17000000-0000-4000-8000-000000000003',
    '활동 메이드', '활동 메이드', '활동 메이드', '활동 메이드', 0,
    'maid', 'active'
  ),
  (
    '27000000-0000-4000-8000-000000000004',
    '17000000-0000-4000-8000-000000000004',
    '비활성 관리자', '비활성 관리자', '비활성 관리자', '비활성 관리자', 0,
    'admin', 'inactive'
  );

update public.rooms
set data_status = 'verified'
where id = (select id from public.rooms order by room_number limit 1);

insert into public.room_pin_sync_events (
  room_id, sync_status, pin_version, reason_code, actor_profile_id, effective_at
)
select id, 'verified', 1, 'TEST_VERIFIED',
  '27000000-0000-4000-8000-000000000002', clock_timestamp()
from public.rooms order by room_number limit 1;

select public.create_reservation(
  '27000000-0000-4000-8000-000000000002',
  '37000000-0000-4000-8000-000000000001',
  (select id from public.rooms order by room_number limit 1),
  date_trunc('minute', clock_timestamp()) + interval '100 days',
  date_trunc('minute', clock_timestamp()) + interval '101 days',
  2, null,
  (select state_version from public.rooms order by room_number limit 1),
  'activity-reservation-create-0001', repeat('a', 64)
);

select ok(
  has_function_privilege(
    'service_role',
    'public.record_actor_activity_event(uuid,text,text,text,text,text,text,uuid,timestamptz)',
    'EXECUTE'
  ),
  'service role can append a validated known-actor activity event'
);
select ok(
  has_function_privilege(
    'service_role', 'public.record_unknown_login_failure(timestamptz)', 'EXECUTE'
  ),
  'service role can append a bounded unknown-login aggregate'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.record_authorization_denial(uuid,text,text,timestamptz)',
    'EXECUTE'
  ),
  'service role can append a bounded authorization-denial aggregate'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.list_developer_activity_events(uuid,uuid,public.app_role,text[],text[],text[],timestamptz,timestamptz,timestamptz,uuid,integer)',
    'EXECUTE'
  ),
  'service role can execute the activity projection'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.record_actor_activity_event(uuid,text,text,text,text,text,text,uuid,timestamptz)',
    'EXECUTE'
  ) and not has_function_privilege(
    'anon', 'public.record_unknown_login_failure(timestamptz)', 'EXECUTE'
  ) and not has_function_privilege(
    'authenticated',
    'public.record_authorization_denial(uuid,text,text,timestamptz)',
    'EXECUTE'
  ) and not has_function_privilege(
    'public',
    'public.list_developer_activity_events(uuid,uuid,public.app_role,text[],text[],text[],timestamptz,timestamptz,timestamptz,uuid,integer)',
    'EXECUTE'
  ),
  'PUBLIC, anon, and authenticated cannot call privileged activity RPCs'
);

select ok(
  not has_table_privilege('anon', 'private.actor_activity_events', 'SELECT')
  and not has_table_privilege('authenticated', 'private.actor_activity_events', 'SELECT')
  and not has_table_privilege('service_role', 'private.actor_activity_events', 'SELECT'),
  'raw known-actor activity rows are not exposed through Data API roles'
);
select ok(
  not has_table_privilege('anon', 'private.actor_activity_aggregates', 'SELECT')
  and not has_table_privilege('authenticated', 'private.actor_activity_aggregates', 'SELECT')
  and not has_table_privilege('service_role', 'private.actor_activity_aggregates', 'SELECT'),
  'raw unknown-login aggregate rows are not exposed through Data API roles'
);
select ok(
  not has_table_privilege(
    'anon', 'private.actor_authorization_denial_aggregates', 'SELECT'
  ) and not has_table_privilege(
    'authenticated', 'private.actor_authorization_denial_aggregates', 'SELECT'
  ) and not has_table_privilege(
    'service_role', 'private.actor_authorization_denial_aggregates', 'SELECT'
  ),
  'raw authorization-denial aggregate rows are not exposed through Data API roles'
);

set local role service_role;
select public.record_actor_activity_event(
  '27000000-0000-4000-8000-000000000002',
  'auth.login_succeeded', 'succeeded', 'edge.auth.login',
  gen_random_uuid()::text, null, null, null, clock_timestamp() - interval '4 minutes'
);
select public.record_actor_activity_event(
  '27000000-0000-4000-8000-000000000002',
  'auth.login_failed', 'failed', 'edge.auth.login',
  gen_random_uuid()::text, 'INVALID_CREDENTIALS', null, null,
  clock_timestamp() - interval '3 minutes'
);
select public.record_authorization_denial(
  '27000000-0000-4000-8000-000000000003',
  'edge.authorization.availability', 'ADMIN_REQUIRED',
  clock_timestamp() - interval '2 minutes'
) from generate_series(1, 1000);
select public.record_authorization_denial(
  '27000000-0000-4000-8000-000000000002',
  'edge.authorization.availability', 'ADMIN_REQUIRED',
  clock_timestamp() - interval '2 minutes'
);
select public.record_authorization_denial(
  '27000000-0000-4000-8000-000000000003',
  'edge.authorization.rooms', 'ADMIN_REQUIRED',
  clock_timestamp() - interval '2 minutes'
);
select public.record_authorization_denial(
  '27000000-0000-4000-8000-000000000003',
  'edge.authorization.availability', 'PASSWORD_CHANGE_REQUIRED',
  clock_timestamp() - interval '2 minutes'
);
select public.record_actor_activity_event(
  '27000000-0000-4000-8000-000000000002',
  'sensitive.read', 'succeeded', 'edge.sensitive.reservation_guest_name',
  gen_random_uuid()::text, null, 'reservation',
  '37000000-0000-4000-8000-000000000001', clock_timestamp() - interval '1 minute'
);
select public.record_unknown_login_failure(clock_timestamp())
from generate_series(1, 1000);
reset role;

select throws_ok(
  $$ select public.record_actor_activity_event(
    '27000000-0000-4000-8000-000000000003',
    'sensitive.read', 'succeeded', 'edge.sensitive.reservation_guest_name',
    gen_random_uuid()::text, null, 'reservation',
    '37000000-0000-4000-8000-000000000001', clock_timestamp()
  ) $$,
  '22023', 'INVALID_ACTIVITY_ACTOR',
  'only an active business admin can record a reservation PII read'
);

select is(
  (select count(*)::integer from private.actor_activity_aggregates),
  1,
  'one minute of unknown-login brute force creates one bounded row'
);
select is(
  (select occurrence_count from private.actor_activity_aggregates),
  600,
  'unknown-login aggregate count saturates at the fixed cap'
);
select is(
  (
    select count(*)::integer
    from private.actor_authorization_denial_aggregates
    where actor_profile_id = '27000000-0000-4000-8000-000000000003'
      and source = 'edge.authorization.availability'
      and reason_code = 'ADMIN_REQUIRED'
  ),
  1,
  'one actor capability denial creates one row per UTC minute'
);
select is(
  (
    select occurrence_count
    from private.actor_authorization_denial_aggregates
    where actor_profile_id = '27000000-0000-4000-8000-000000000003'
      and source = 'edge.authorization.availability'
      and reason_code = 'ADMIN_REQUIRED'
  ),
  600,
  'authorization-denial aggregate saturates at the fixed cap'
);
select is(
  (select count(*)::integer from private.actor_authorization_denial_aggregates),
  4,
  'different actors, sources, and reasons keep isolated denial aggregates'
);
select ok(
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'private'
      and table_name in (
        'actor_activity_events',
        'actor_activity_aggregates',
        'actor_authorization_denial_aggregates'
      )
      and column_name ~ '(password|token|authorization|phone|guest|pin|photo|ip|body|login)'
  ),
  'activity ledgers have no prohibited secret, PII, raw IP, body, or login columns'
);
select ok(
  position('raw-login-sentinel' in (
    coalesce((select string_agg(row_to_json(event)::text, '')
      from private.actor_activity_events event), '') ||
    coalesce((select string_agg(row_to_json(aggregate)::text, '')
      from private.actor_activity_aggregates aggregate), '') ||
    coalesce((select string_agg(row_to_json(denial)::text, '')
      from private.actor_authorization_denial_aggregates denial), '')
  )) = 0,
  'unknown login input is never persisted in raw activity storage'
);
select ok(
  not exists (
    select 1 from private.actor_activity_events
    where request_id !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  'persisted request IDs accept only server UUID v4 format'
);
select ok(
  not exists (
    select 1
    from unnest(array[
      '01012345678',
      '9d0fc2c7-40a7-4bfd-9003-7d52ea7ad3ce',
      'short-token',
      'refresh-token.example.secret',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature'
    ]) caller_value
    where position(caller_value in (
      coalesce((select string_agg(row_to_json(event)::text, '')
        from private.actor_activity_events event), '') ||
      coalesce((select string_agg(row_to_json(aggregate)::text, '')
        from private.actor_activity_aggregates aggregate), '') ||
      coalesce((select string_agg(row_to_json(denial)::text, '')
        from private.actor_authorization_denial_aggregates denial), '')
    )) > 0
  ),
  'caller phone, UUID-like secret, short token, refresh token, and JWT-like IDs are absent'
);
select throws_ok(
  $$ select public.record_actor_activity_event(
    '27000000-0000-4000-8000-000000000002',
    'auth.login_succeeded', 'succeeded', 'edge.auth.login',
    '01012345678', null, null, null, clock_timestamp()
  ) $$,
  '22023', 'INVALID_ACTIVITY_EVENT',
  'caller-shaped request IDs cannot be persisted directly'
);

select ok(
  exists (
    select 1 from public.list_developer_activity_events(
      '27000000-0000-4000-8000-000000000001', null, 'admin',
      array['auth'], array['auth.login_succeeded'], array['succeeded'],
      clock_timestamp() - interval '1 hour', clock_timestamp() + interval '1 hour', null, null, 100
    ) where actor_profile_id = '27000000-0000-4000-8000-000000000002'
  ),
  'developer can filter successful login activity by actor and role'
);
select ok(
  exists (
    select 1 from public.list_developer_activity_events(
      '27000000-0000-4000-8000-000000000001', null, null,
      array['authorization'], array['authorization.denied'], array['denied'],
      clock_timestamp() - interval '1 hour', clock_timestamp() + interval '1 hour', null, null, 100
    ) where actor_profile_id = '27000000-0000-4000-8000-000000000003'
      and source = 'edge.authorization.availability'
      and reason_code = 'ADMIN_REQUIRED'
      and request_id is null
      and summary ->> 'aggregateCount' = '600'
  ),
  'developer sees a bounded authorization denial in the common activity shape'
);
select ok(
  exists (
    select 1 from public.list_developer_activity_events(
      '27000000-0000-4000-8000-000000000001', null, null,
      array['auth'], array['auth.login_failed'], array['failed'],
      clock_timestamp() - interval '1 hour', clock_timestamp() + interval '1 hour', null, null, 100
    ) where actor_profile_id is null and summary ->> 'aggregateCount' = '600'
      and request_id is null
  ),
  'unknown login activity is exposed only as a bounded anonymous summary'
);

select throws_ok(
  $$ select * from public.list_developer_activity_events(
    '27000000-0000-4000-8000-000000000002', null, null, null, null, null,
    clock_timestamp() - interval '1 hour', clock_timestamp() + interval '1 hour', null, null, 10
  ) $$,
  '42501', 'DEVELOPER_REQUIRED',
  'business admin cannot read all activity events'
);
select throws_ok(
  $$ select * from public.list_developer_activity_events(
    '27000000-0000-4000-8000-000000000003', null, null, null, null, null,
    clock_timestamp() - interval '1 hour', clock_timestamp() + interval '1 hour', null, null, 10
  ) $$,
  '42501', 'DEVELOPER_REQUIRED',
  'maid cannot read all activity events'
);
select throws_ok(
  $$ select * from public.list_developer_activity_events(
    '27000000-0000-4000-8000-000000000004', null, null, null, null, null,
    clock_timestamp() - interval '1 hour', clock_timestamp() + interval '1 hour', null, null, 10
  ) $$,
  '42501', 'DEVELOPER_REQUIRED',
  'inactive profile cannot read all activity events'
);
select throws_ok(
  $$ select * from public.list_developer_activity_events(
    '27000000-0000-4000-8000-000000000001', null, null, null, null, null,
    clock_timestamp() - interval '32 days', clock_timestamp(), null, null, 10
  ) $$,
  '22023', 'INVALID_ACTIVITY_QUERY',
  'activity query windows wider than 31 days are rejected'
);
select throws_ok(
  $$ select * from public.list_developer_activity_events(
    '27000000-0000-4000-8000-000000000001', null, null, null, null, null,
    clock_timestamp() - interval '1 hour', clock_timestamp() + interval '1 hour', null, null, 101
  ) $$,
  '22023', 'INVALID_ACTIVITY_QUERY',
  'activity pages larger than 100 are rejected'
);

set local role service_role;
select public.record_actor_activity_event(
  '27000000-0000-4000-8000-000000000002',
  'auth.login_succeeded', 'succeeded', 'edge.auth.login',
  gen_random_uuid()::text,
  null, null, null, clock_timestamp() - interval '4 minutes' + sequence_number * interval '1 second'
)
from generate_series(1, 101) sequence_number;
reset role;

create temporary table activity_first_page as
select * from public.list_developer_activity_events(
  '27000000-0000-4000-8000-000000000001', null, null, null, null, null,
  clock_timestamp() - interval '1 hour', clock_timestamp() + interval '1 hour', null, null, 100
);
select is(
  (select count(*)::integer from activity_first_page), 100,
  'activity projection enforces the 100-row page maximum'
);
select ok(
  exists (
    select 1
    from (select * from activity_first_page order by recorded_at, id limit 1) cursor_row
    cross join lateral public.list_developer_activity_events(
      '27000000-0000-4000-8000-000000000001', null, null, null, null, null,
      clock_timestamp() - interval '1 hour', clock_timestamp() + interval '1 hour',
      cursor_row.recorded_at, cursor_row.id, 100
    ) next_page
    where next_page.id <> cursor_row.id
  ),
  'activity cursor advances without offset pagination'
);

select throws_ok(
  $$ update private.actor_activity_events set outcome = 'failed' where true $$,
  '55000', 'APPEND_ONLY_LEDGER', 'known activity events cannot be updated'
);
select throws_ok(
  $$ delete from private.actor_activity_events where true $$,
  '55000', 'APPEND_ONLY_LEDGER', 'known activity events cannot be deleted'
);
select throws_ok(
  $$ update public.audit_events set event_type = 'tampered' where true $$,
  '55000', 'APPEND_ONLY_LEDGER', 'domain audit events remain immutable on update'
);
select throws_ok(
  $$ delete from public.audit_events where true $$,
  '55000', 'APPEND_ONLY_LEDGER', 'domain audit events remain immutable on delete'
);

select lives_ok(
  $$ select private.submit_weekly_availability_at(
    '27000000-0000-4000-8000-000000000003', '2026-09-07',
    array['2026-09-07'::date, '2026-09-09'::date], 0,
    'activity-availability-submit-0001', '2026-09-06T12:00:00+09'
  ) $$,
  'maid availability submission creates a domain audit event'
);
select lives_ok(
  $$ select private.request_availability_change_at(
    '27000000-0000-4000-8000-000000000003', '2026-09-07',
    array['2026-09-08'::date], 'SCHEDULE_CHANGED', 1,
    'activity-availability-change-0001', '2026-09-07T00:01:00+09'
  ) $$,
  'maid availability change request creates a domain audit event'
);
select lives_ok(
  $$ select private.decide_availability_change_at(
    '27000000-0000-4000-8000-000000000002',
    (select id from public.availability_change_requests
     where maid_profile_id = '27000000-0000-4000-8000-000000000003'),
    'rejected', 'INSUFFICIENT_COVERAGE', 1,
    'activity-availability-decision-0001', '2026-09-07T00:02:00+09'
  ) $$,
  'admin availability decision creates a domain audit event'
);
select is(
  (select count(*)::integer from public.list_developer_audit_events(
    '27000000-0000-4000-8000-000000000001',
    array['availability.submitted', 'availability.change_requested'],
    '27000000-0000-4000-8000-000000000003',
    clock_timestamp() - interval '1 hour', clock_timestamp() + interval '1 hour', null, null, 100
  )),
  2,
  'maid availability audit events are searchable by actor'
);
select is(
  (select count(*)::integer from public.list_developer_audit_events(
    '27000000-0000-4000-8000-000000000001',
    array['availability.change_decided'],
    '27000000-0000-4000-8000-000000000002',
    clock_timestamp() - interval '1 hour', clock_timestamp() + interval '1 hour', null, null, 100
  )),
  1,
  'admin command audit is searchable by actor'
);
select ok(
  not exists (
    select 1 from public.list_developer_audit_events(
      '27000000-0000-4000-8000-000000000001', null, null,
      '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', null, null, 100
    ) where summary::text ~* '(phone|password|token|guestName|pin|requestHash)'
  ),
  'developer audit projection never exposes raw state secret or PII fields'
);

select * from finish();
rollback;
