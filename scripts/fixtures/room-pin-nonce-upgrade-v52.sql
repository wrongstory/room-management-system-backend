-- Synthetic v52 history for the 52 -> 53 room-PIN nonce upgrade test.
-- The caller may set `inject_conflict` to 1 to add a cross-table historical
-- collision. No production credential, key, PIN, or envelope is used here.
\if :{?inject_conflict}
\else
\set inject_conflict 0
\endif

insert into auth.users(id) values ('f1531000-0000-4000-8000-000000000101');
insert into public.profiles(
  id, auth_user_id, display_name, display_name_normalized,
  login_id, login_id_normalized, login_sequence, role, status,
  must_change_password
) values (
  'f1531000-0000-4000-8000-000000000001',
  'f1531000-0000-4000-8000-000000000101',
  'PIN nonce upgrade actor', 'PIN nonce upgrade actor',
  'pin-nonce-upgrade', 'pin-nonce-upgrade', 0, 'admin', 'active', false
);
insert into auth.sessions(id, user_id) values (
  'f1531000-0000-4000-8000-000000000201',
  'f1531000-0000-4000-8000-000000000101'
);

create temp table upgrade_rooms as
select row_number() over (order by room_number, id) as n, id
from public.rooms
order by room_number, id
limit 8;

-- Prepared, expired and rolled-back leases must remain byte-for-byte history.
insert into private.room_pin_change_leases(
  id, room_id, expected_pin_version, proposed_pin_version,
  actor_profile_id, actor_role_snapshot, reason_code,
  envelope_format, ciphertext, nonce, auth_tag, key_version,
  aad_environment, aad_project_ref, request_hash, idempotency_key,
  status, prepared_at, expires_at, resolved_at
)
select
  ('f1531000-0000-4000-8000-' || lpad((200 + n)::text, 12, '0'))::uuid,
  id, 0, 1,
  'f1531000-0000-4000-8000-000000000001'::uuid, 'admin', 'ADMIN_INITIAL_PIN',
  1,
  digest('upgrade-lease-cipher-' || n, 'sha256'),
  substring(digest('upgrade-lease-nonce-' || n, 'sha256') for 12),
  substring(digest('upgrade-lease-tag-' || n, 'sha256') for 16),
  'upgrade-v1', 'test', 'local', repeat(n::text, 64),
  'upgrade-lease-key-' || lpad(n::text, 4, '0'),
  case n when 1 then 'prepared' when 2 then 'expired' else 'rolled_back' end,
  case when n = 1 then clock_timestamp() else clock_timestamp() - interval '10 minutes' end,
  case when n = 1 then clock_timestamp() + interval '4 minutes' else clock_timestamp() - interval '6 minutes' end,
  case when n = 1 then null else clock_timestamp() - interval '5 minutes' end
from upgrade_rooms
where n between 1 and 3;

-- Confirmed lease plus its exact revision is one logical encryption.
insert into private.room_pin_change_leases(
  id, room_id, expected_pin_version, proposed_pin_version,
  actor_profile_id, actor_role_snapshot, reason_code,
  envelope_format, ciphertext, nonce, auth_tag, key_version,
  aad_environment, aad_project_ref, request_hash, idempotency_key,
  status, prepared_at, expires_at, confirmed_at, resolved_at
)
select
  'f1531000-0000-4000-8000-000000000204', id, 0, 1,
  'f1531000-0000-4000-8000-000000000001', 'admin', 'ADMIN_INITIAL_PIN',
  1, digest('upgrade-confirmed-cipher', 'sha256'),
  substring(digest('upgrade-confirmed-nonce', 'sha256') for 12),
  substring(digest('upgrade-confirmed-tag', 'sha256') for 16),
  'upgrade-v1', 'test', 'local', repeat('4', 64),
  'upgrade-lease-key-0004', 'confirmed',
  clock_timestamp() - interval '10 minutes',
  clock_timestamp() - interval '6 minutes',
  clock_timestamp() - interval '7 minutes',
  clock_timestamp() - interval '7 minutes'
from upgrade_rooms where n = 4;

insert into private.room_pin_revisions(
  id, room_id, pin_version, envelope_format, ciphertext, nonce, auth_tag,
  key_version, aad_environment, aad_project_ref,
  recorded_by, recorded_by_role, source, created_at
)
select
  'f1531000-0000-4000-8000-000000000304', id, 1, 1,
  digest('upgrade-confirmed-cipher', 'sha256'),
  substring(digest('upgrade-confirmed-nonce', 'sha256') for 12),
  substring(digest('upgrade-confirmed-tag', 'sha256') for 16),
  'upgrade-v1', 'test', 'local',
  'f1531000-0000-4000-8000-000000000001', 'admin', 'admin_initial_entry',
  clock_timestamp() - interval '6 minutes'
from upgrade_rooms where n = 4;

-- Exercise the actual v52 bootstrap RPC so its immutable revision, current
-- pointer, verified sync event, Sheet outbox, audit and completed receipt all
-- exist before migration 53. The harness hashes every column before/after.
select public.bootstrap_room_pins(
  'f1531000-0000-4000-8000-000000000001',
  'f1531000-0000-4000-8000-000000000201',
  jsonb_build_array(jsonb_build_object(
    'roomId', id,
    'roomNumber', room_number,
    'envelopeFormat', 1,
    'ciphertextBase64', encode(digest('upgrade-bootstrap-cipher', 'sha256'), 'base64'),
    'nonceBase64', encode(substring(digest('upgrade-bootstrap-nonce', 'sha256') for 12), 'base64'),
    'authTagBase64', encode(substring(digest('upgrade-bootstrap-tag', 'sha256') for 16), 'base64'),
    'keyVersion', 'upgrade-v1',
    'aadEnvironment', 'test',
    'aadProjectRef', 'local'
  )),
  'upgrade-bootstrap-key-0005',
  repeat('5', 64)
)
from public.rooms
where id = (select id from upgrade_rooms where n = 5);

-- Optional corrupt v52 evidence: same key-version/nonce as the prepared lease
-- for room 1, but a different room/AAD-bound encryption. Migration 53 must
-- abort and preserve both rows rather than deleting or guessing a winner.
\if :inject_conflict
insert into private.room_pin_revisions(
  id, room_id, pin_version, envelope_format, ciphertext, nonce, auth_tag,
  key_version, aad_environment, aad_project_ref,
  recorded_by, recorded_by_role, source
)
select
  'f1531000-0000-4000-8000-000000000306', id, 1, 1,
  digest('upgrade-conflicting-cipher', 'sha256'),
  substring(digest('upgrade-lease-nonce-1', 'sha256') for 12),
  substring(digest('upgrade-conflicting-tag', 'sha256') for 16),
  'upgrade-v1', 'test', 'local',
  'f1531000-0000-4000-8000-000000000001', 'admin', 'admin_initial_entry'
from upgrade_rooms where n = 6;
\endif
