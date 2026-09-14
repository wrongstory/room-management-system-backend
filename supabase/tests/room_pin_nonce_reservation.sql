begin;
select no_plan();

create function pg_temp.nid(n integer) returns uuid language sql immutable as $$
  select ('f1530000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
$$;
create function pg_temp.room_id(n integer) returns uuid language sql stable as $$
  select id from public.rooms order by room_number offset n - 1 limit 1
$$;
create function pg_temp.room_number(n integer) returns text language sql stable as $$
  select room_number from public.rooms where id = pg_temp.room_id(n)
$$;

insert into auth.users(id) values (pg_temp.nid(101));
insert into public.profiles(
  id, auth_user_id, display_name, display_name_normalized,
  login_id, login_id_normalized, login_sequence, role, status,
  must_change_password
) values (
  pg_temp.nid(1), pg_temp.nid(101), 'PIN nonce 관리자', 'PIN nonce 관리자',
  'pin-nonce-admin', 'pin-nonce-admin', 0, 'admin', 'active', false
);
insert into auth.sessions(id, user_id) values (pg_temp.nid(201), pg_temp.nid(101));

select ok(
  (select relrowsecurity and relforcerowsecurity
   from pg_class where oid = 'private.room_pin_nonce_reservations'::regclass),
  'nonce registry has enabled and forced RLS'
);
select ok(
  not has_table_privilege('service_role', 'private.room_pin_nonce_reservations', 'SELECT')
  and not has_table_privilege('authenticated', 'private.room_pin_nonce_reservations', 'SELECT')
  and not has_table_privilege('anon', 'private.room_pin_nonce_reservations', 'SELECT'),
  'nonce registry has no Data API read grant'
);
select ok(
  not has_function_privilege(
    'service_role',
    'private.room_pin_envelope_fingerprint(uuid,bigint,smallint,bytea,bytea,text,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'private.reserve_room_pin_nonce_from_envelope()',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'private.guard_room_pin_change_lease_encryption_identity()',
    'EXECUTE'
  ),
  'private nonce helpers are not directly executable by service role'
);

create temp table prepared(value jsonb);
insert into prepared
select public.prepare_room_pin_change(
  pg_temp.nid(1), pg_temp.nid(201), pg_temp.room_id(1), 0,
  pg_temp.room_number(1), null, null, null, 'ADMIN_INITIAL_PIN', 1::smallint,
  encode(digest('nonce-normal-cipher', 'sha256'), 'base64'),
  encode(substring(digest('nonce-normal-value', 'sha256') for 12), 'base64'),
  encode(substring(digest('nonce-normal-tag', 'sha256') for 16), 'base64'),
  'nonce-test-v1', 'test', 'local', 'nonce-normal-prepare-0001', repeat('a', 64)
);
select is(
  (select count(*)::integer from private.room_pin_nonce_reservations),
  1,
  'prepare reserves one global key-version and nonce identity'
);

select lives_ok(
  format(
    'select public.confirm_room_pin_change(%L,%L,%L,%L,0,%L,%L)',
    pg_temp.nid(1), pg_temp.nid(201), pg_temp.room_id(1),
    (select value->>'lease_id' from prepared),
    'nonce-normal-confirm-0001', repeat('b', 64)
  ),
  'confirm reuses the prepared logical encryption reservation'
);
select is(
  (select count(*)::integer from private.room_pin_nonce_reservations),
  1,
  'prepare and matching confirmed revision share one reservation'
);
select is(
  (select count(*)::integer from private.room_pin_revisions where room_id = pg_temp.room_id(1)),
  1,
  'normal confirm still appends one immutable revision'
);
select is(
  public.confirm_room_pin_change(
    pg_temp.nid(1), pg_temp.nid(201), pg_temp.room_id(1),
    (select (value->>'lease_id')::uuid from prepared), 0,
    'nonce-normal-confirm-0001', repeat('b', 64)
  ),
  (select response_payload from private.command_executions
   where actor_profile_id = pg_temp.nid(1)
     and command_type = 'room.pin_change.confirm'
     and idempotency_key = 'nonce-normal-confirm-0001'),
  'same confirm command replays without reserving a second nonce'
);

select throws_ok(
  $$update private.room_pin_change_leases
    set nonce = digest('mutated-lease-nonce', 'sha256')::bytea
    where idempotency_key = 'nonce-normal-prepare-0001'$$,
  '55000',
  'ROOM_PIN_CHANGE_ENCRYPTION_IDENTITY_IMMUTABLE',
  'lease lifecycle updates cannot mutate its reserved encryption identity'
);

-- Reserve a second nonce through the regular prepare path, then prove that a
-- different encryption cannot reuse it in bootstrap. One earlier bootstrap
-- item is deliberately valid: the collision must roll the whole batch back.
select public.prepare_room_pin_change(
  pg_temp.nid(1), pg_temp.nid(201), pg_temp.room_id(2), 0,
  pg_temp.room_number(2), null, null, null, 'ADMIN_INITIAL_PIN', 1::smallint,
  encode(digest('nonce-cross-flow-prepare-cipher', 'sha256'), 'base64'),
  encode(substring(digest('nonce-cross-flow-value', 'sha256') for 12), 'base64'),
  encode(substring(digest('nonce-cross-flow-prepare-tag', 'sha256') for 16), 'base64'),
  'nonce-test-v1', 'test', 'local', 'nonce-cross-flow-prepare-0001', repeat('c', 64)
);

create temp table atomic_before as
select
  (select count(*) from private.room_pin_revisions) as revisions,
  (select count(*) from private.room_current_pin) as current_pins,
  (select count(*) from public.room_pin_sync_events) as sync_events,
  (select count(*) from private.room_pin_sheet_sync_outbox) as outbox,
  (select count(*) from public.audit_events) as audits,
  (select count(*) from private.command_executions) as receipts;

select throws_ok(
  format(
    'select public.bootstrap_room_pins(%L,%L,%L::jsonb,%L,%L)',
    pg_temp.nid(1),
    pg_temp.nid(201),
    jsonb_build_array(
      jsonb_build_object(
        'roomId', pg_temp.room_id(3),
        'roomNumber', pg_temp.room_number(3),
        'envelopeFormat', 1,
        'ciphertextBase64', encode(digest('nonce-atomic-valid-cipher', 'sha256'), 'base64'),
        'nonceBase64', encode(substring(digest('nonce-atomic-valid-value', 'sha256') for 12), 'base64'),
        'authTagBase64', encode(substring(digest('nonce-atomic-valid-tag', 'sha256') for 16), 'base64'),
        'keyVersion', 'nonce-test-v1',
        'aadEnvironment', 'test',
        'aadProjectRef', 'local'
      ),
      jsonb_build_object(
        'roomId', pg_temp.room_id(4),
        'roomNumber', pg_temp.room_number(4),
        'envelopeFormat', 1,
        'ciphertextBase64', encode(digest('nonce-cross-flow-bootstrap-cipher', 'sha256'), 'base64'),
        'nonceBase64', encode(substring(digest('nonce-cross-flow-value', 'sha256') for 12), 'base64'),
        'authTagBase64', encode(substring(digest('nonce-cross-flow-bootstrap-tag', 'sha256') for 16), 'base64'),
        'keyVersion', 'nonce-test-v1',
        'aadEnvironment', 'test',
        'aadProjectRef', 'local'
      )
    )::text,
    'nonce-cross-flow-bootstrap-0001',
    repeat('d', 64)
  ),
  '23505',
  'ROOM_PIN_NONCE_REUSE',
  'bootstrap cannot reuse a regular prepare nonce for another encryption'
);

select is(
  (select jsonb_build_array(revisions, current_pins, sync_events, outbox, audits, receipts)
   from atomic_before),
  (select jsonb_build_array(
    (select count(*) from private.room_pin_revisions),
    (select count(*) from private.room_current_pin),
    (select count(*) from public.room_pin_sync_events),
    (select count(*) from private.room_pin_sheet_sync_outbox),
    (select count(*) from public.audit_events),
    (select count(*) from private.command_executions)
  )),
  'nonce validation failure rolls back the whole bootstrap business batch'
);
select is(
  (select status from private.room_pin_change_leases
   where idempotency_key = 'nonce-cross-flow-prepare-0001'),
  'prepared',
  'cross-flow rejection preserves the unresolved physical-change lease'
);
select ok(
  not exists(select 1 from private.room_current_pin where room_id in (pg_temp.room_id(3), pg_temp.room_id(4))),
  'failed bootstrap creates no partial current pointer'
);

select throws_ok(
  $$update private.room_pin_nonce_reservations set reserved_at = clock_timestamp()$$,
  '55000',
  'APPEND_ONLY_LEDGER',
  'nonce reservations cannot be rewritten'
);
select throws_ok(
  $$delete from private.room_pin_nonce_reservations$$,
  '55000',
  'APPEND_ONLY_LEDGER',
  'nonce reservations cannot be deleted'
);

select * from finish();
rollback;
