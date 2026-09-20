-- Synthetic, secret-free representation of the production v0.2.0 baseline.
--
-- This fixture is intentionally applied only after resetting to migration 19
-- (actor_activity_audit_contract). It mirrors the production cardinalities
-- that matter to the v0.3.0 upgrade without copying any production identifier,
-- credential, phone number, PIN, guest PII, or free-form request payload.

begin;

set local timezone = 'UTC';

do $$
begin
  if (select count(*) from public.rooms) <> 121 then
    raise exception using
      errcode = '23514',
      message = 'SYNTHETIC_BASELINE_ROOM_COUNT_MISMATCH';
  end if;

  if exists (select 1 from public.reservations) then
    raise exception using
      errcode = '23514',
      message = 'SYNTHETIC_BASELINE_REQUIRES_ZERO_RESERVATIONS';
  end if;
end;
$$;

insert into auth.users (id) values
  ('f0190000-0000-4000-8000-000000000101'),
  ('f0190000-0000-4000-8000-000000000102'),
  ('f0190000-0000-4000-8000-000000000103');

-- The developer must be the first profile because the v19 bootstrap guard
-- intentionally rejects creating a developer after any other profile exists.
insert into public.profiles (
  id,
  auth_user_id,
  display_name,
  display_name_normalized,
  login_id,
  login_id_normalized,
  login_sequence,
  role,
  status,
  must_change_password,
  created_at,
  updated_at
) values (
  'f0190000-0000-4000-8000-000000000001',
  'f0190000-0000-4000-8000-000000000101',
  'Synthetic Developer',
  'synthetic developer',
  'admin',
  'admin',
  0,
  'developer',
  'active',
  false,
  '2026-08-31T00:00:00Z',
  '2026-08-31T00:00:00Z'
);

insert into public.profiles (
  id,
  auth_user_id,
  display_name,
  display_name_normalized,
  login_id,
  login_id_normalized,
  login_sequence,
  role,
  status,
  must_change_password,
  created_at,
  updated_at
) values
  (
    'f0190000-0000-4000-8000-000000000002',
    'f0190000-0000-4000-8000-000000000102',
    'Synthetic Admin',
    'synthetic admin',
    'synthetic-admin',
    'synthetic-admin',
    0,
    'admin',
    'active',
    false,
    '2026-08-31T00:00:00Z',
    '2026-08-31T00:00:00Z'
  ),
  (
    'f0190000-0000-4000-8000-000000000003',
    'f0190000-0000-4000-8000-000000000103',
    'Synthetic Maid',
    'synthetic maid',
    'synthetic-maid',
    'synthetic-maid',
    0,
    'maid',
    'active',
    false,
    '2026-08-31T00:00:00Z',
    '2026-08-31T00:00:00Z'
  );

insert into public.login_aliases (
  id,
  profile_id,
  alias,
  alias_normalized,
  active,
  expires_after_new_login,
  created_at
) values
  (
    'f0190000-0000-4000-8000-000000000011',
    'f0190000-0000-4000-8000-000000000001',
    'admin',
    'admin',
    true,
    false,
    '2026-08-31T00:00:00Z'
  ),
  (
    'f0190000-0000-4000-8000-000000000012',
    'f0190000-0000-4000-8000-000000000002',
    'synthetic-admin',
    'synthetic-admin',
    true,
    false,
    '2026-08-31T00:00:00Z'
  ),
  (
    'f0190000-0000-4000-8000-000000000013',
    'f0190000-0000-4000-8000-000000000003',
    'synthetic-maid',
    'synthetic-maid',
    true,
    false,
    '2026-08-31T00:00:00Z'
  );

insert into auth.sessions (id, user_id, created_at, updated_at) values
  (
    'f0190000-0000-4000-8000-000000000201',
    'f0190000-0000-4000-8000-000000000101',
    '2026-08-31T00:00:00Z',
    '2026-08-31T00:00:00Z'
  ),
  (
    'f0190000-0000-4000-8000-000000000202',
    'f0190000-0000-4000-8000-000000000102',
    '2026-08-31T00:00:00Z',
    '2026-08-31T00:00:00Z'
  ),
  (
    'f0190000-0000-4000-8000-000000000203',
    'f0190000-0000-4000-8000-000000000103',
    '2026-08-31T00:00:00Z',
    '2026-08-31T00:00:00Z'
  );

insert into public.availability_versions (
  id,
  maid_profile_id,
  week_start,
  version,
  status,
  is_current,
  submitted_at,
  created_at
) values (
  'f0190000-0000-4000-8000-000000000301',
  'f0190000-0000-4000-8000-000000000003',
  '2026-09-14',
  1,
  'submitted',
  true,
  '2026-09-13T01:00:00Z',
  '2026-09-13T01:00:00Z'
);

insert into public.availability_days (
  availability_version_id,
  work_date,
  available,
  created_at
)
select
  'f0190000-0000-4000-8000-000000000301',
  day::date,
  extract(isodow from day) between 1 and 5,
  '2026-09-13T01:00:00Z'
from generate_series(
  timestamp '2026-09-14 00:00:00',
  timestamp '2026-09-20 00:00:00',
  interval '1 day'
) as day;

insert into public.audit_events (
  id,
  actor_profile_id,
  actor_display_name_snapshot,
  event_type,
  entity_type,
  entity_id,
  effective_at,
  recorded_at,
  reason_code,
  before_state,
  after_state,
  request_id,
  idempotency_key,
  created_at
) values (
  'f0190000-0000-4000-8000-000000000401',
  'f0190000-0000-4000-8000-000000000003',
  'Synthetic Maid',
  'availability.submitted',
  'availability_version',
  'f0190000-0000-4000-8000-000000000301',
  '2026-09-13T01:00:00Z',
  '2026-09-13T01:00:00Z',
  null,
  null,
  jsonb_build_object(
    'weekStart', '2026-09-14',
    'version', 1
  ),
  'f0190000-0000-4000-8000-000000000501',
  'synthetic-v19-availability-submit',
  '2026-09-13T01:00:00Z'
);

insert into private.command_executions (
  id,
  actor_profile_id,
  command_type,
  idempotency_key,
  request_hash,
  entity_id,
  response_payload,
  completed_at
) values (
  'f0190000-0000-4000-8000-000000000402',
  'f0190000-0000-4000-8000-000000000003',
  'availability.submit',
  'synthetic-v19-availability-submit',
  repeat('a', 64),
  'f0190000-0000-4000-8000-000000000301',
  jsonb_build_object(
    'availabilityVersionId', 'f0190000-0000-4000-8000-000000000301',
    'version', 1
  ),
  '2026-09-13T01:00:00Z'
);

insert into private.scheduler_invocation_heartbeats (
  invocation_key,
  scheduled_at,
  actor_profile_id,
  status,
  transition_count,
  last_error_code,
  attempt_count,
  first_started_at,
  last_completed_at,
  last_request_id,
  created_at,
  updated_at
) values (
  'reservation-scheduler-202609140000',
  '2026-09-14T00:00:00Z',
  'f0190000-0000-4000-8000-000000000002',
  'succeeded',
  0,
  null,
  2,
  '2026-09-14T00:00:01Z',
  '2026-09-14T00:00:02Z',
  'f0190000-0000-4000-8000-000000000502',
  '2026-09-14T00:00:01Z',
  '2026-09-14T00:00:02Z'
);

insert into private.actor_activity_events (
  id,
  actor_profile_id,
  actor_role_snapshot,
  category,
  event_type,
  outcome,
  source,
  resource_type,
  resource_id,
  reason_code,
  request_id,
  occurred_at,
  recorded_at
) values
  (
    'f0190000-0000-4000-8000-000000000601',
    'f0190000-0000-4000-8000-000000000001',
    'developer',
    'auth',
    'auth.login_succeeded',
    'succeeded',
    'edge.auth.login',
    null,
    null,
    null,
    'f0190000-0000-4000-8000-000000000503',
    '2026-09-14T00:01:00Z',
    '2026-09-14T00:01:00Z'
  ),
  (
    'f0190000-0000-4000-8000-000000000602',
    'f0190000-0000-4000-8000-000000000002',
    'admin',
    'auth',
    'auth.login_succeeded',
    'succeeded',
    'edge.auth.login',
    null,
    null,
    null,
    'f0190000-0000-4000-8000-000000000504',
    '2026-09-14T00:02:00Z',
    '2026-09-14T00:02:00Z'
  ),
  (
    'f0190000-0000-4000-8000-000000000603',
    'f0190000-0000-4000-8000-000000000003',
    'maid',
    'auth',
    'auth.login_failed',
    'failed',
    'edge.auth.login',
    null,
    null,
    'INVALID_CREDENTIALS',
    'f0190000-0000-4000-8000-000000000505',
    '2026-09-14T00:03:00Z',
    '2026-09-14T00:03:00Z'
  );

insert into private.actor_activity_aggregates (
  id,
  bucket_started_at,
  category,
  event_type,
  outcome,
  source,
  reason_code,
  occurrence_count,
  first_occurred_at,
  last_occurred_at,
  recorded_at
) values (
  'f0190000-0000-4000-8000-000000000611',
  '2026-09-14T00:04:00Z',
  'auth',
  'auth.login_failed',
  'failed',
  'edge.auth.login',
  'UNKNOWN_ACCOUNT',
  3,
  '2026-09-14T00:04:01Z',
  '2026-09-14T00:04:30Z',
  '2026-09-14T00:04:30Z'
);

insert into private.actor_authorization_denial_aggregates (
  id,
  actor_profile_id,
  actor_role_snapshot,
  category,
  event_type,
  outcome,
  source,
  reason_code,
  bucket_started_at,
  occurrence_count,
  first_occurred_at,
  last_occurred_at,
  recorded_at
) values (
  'f0190000-0000-4000-8000-000000000612',
  'f0190000-0000-4000-8000-000000000001',
  'developer',
  'authorization',
  'authorization.denied',
  'denied',
  'edge.authorization.rooms',
  'ADMIN_REQUIRED',
  '2026-09-14T00:05:00Z',
  2,
  '2026-09-14T00:05:01Z',
  '2026-09-14T00:05:20Z',
  '2026-09-14T00:05:20Z'
);

commit;
