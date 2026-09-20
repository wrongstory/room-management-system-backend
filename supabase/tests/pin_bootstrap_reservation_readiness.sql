begin;
select no_plan();

create function pg_temp.pid(n integer) returns uuid language sql immutable as $$
  select ('f1400000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
$$;
create function pg_temp.room_id(n integer) returns uuid language sql stable as $$
  select id from public.rooms order by room_number offset n - 1 limit 1
$$;
create function pg_temp.room_number(n integer) returns text language sql stable as $$
  select room_number from public.rooms where id = pg_temp.room_id(n)
$$;
insert into auth.users(id) values
  (pg_temp.pid(101)),
  (pg_temp.pid(102)),
  (pg_temp.pid(103));
set local role service_role;
select public.bootstrap_first_developer_profile(
  pg_temp.pid(3), pg_temp.pid(103), 'PIN 감사 개발자',
  'pin audit developer', '0169', 'pin-audit-developer-phone-hash',
  'pin-audit-developer-bootstrap-0001'
);
reset role;
insert into public.profiles(
  id, auth_user_id, display_name, display_name_normalized,
  login_id, login_id_normalized, login_sequence, role, status,
  must_change_password
) values
  (pg_temp.pid(1), pg_temp.pid(101), 'PIN 초기화 관리자', 'PIN 초기화 관리자',
    'pin-bootstrap-admin', 'pin-bootstrap-admin', 0, 'admin', 'active', false),
  (pg_temp.pid(2), pg_temp.pid(102), 'PIN 초기화 메이드', 'PIN 초기화 메이드',
    'pin-bootstrap-maid', 'pin-bootstrap-maid', 0, 'maid', 'active', false);
insert into auth.sessions(id, user_id) values
  (pg_temp.pid(201), pg_temp.pid(101)),
  (pg_temp.pid(202), pg_temp.pid(102));

select is(
  private.current_pin_sync_status(pg_temp.room_id(1)),
  'unconfigured',
  'fresh room has an explicit unconfigured PIN warning'
);
select is(
  (select allocation_ready
   from public.get_room_operational_projection(pg_temp.pid(1), pg_temp.room_id(1))),
  true,
  'unconfigured PIN does not block reservation allocation readiness'
);
select ok(
  array_position(
    (select reason_codes
     from public.get_room_operational_projection(pg_temp.pid(1), pg_temp.room_id(1))),
    'DATA_UNCONFIRMED'
  ) is null,
  'unconfigured PIN is not conflated with room master data confirmation'
);
select ok(
  'DATA_UNCONFIRMED' = any(private.room_block_reason_codes(
    pg_temp.room_id(1), clock_timestamp(), true, true, pg_temp.pid(900)
  )),
  'actual check-in readiness remains fail-closed until a PIN is verified'
);

-- A prepared physical change is a mismatch warning, but still not a future
-- reservation-allocation blocker.
select public.prepare_room_pin_change(
  pg_temp.pid(1), pg_temp.pid(201), pg_temp.room_id(2), 0,
  pg_temp.room_number(2), null, null, null, 'ADMIN_INITIAL_PIN', 1::smallint,
  encode(digest('candidate', 'sha256'), 'base64'),
  encode(substring(digest('nonce', 'sha256') for 12), 'base64'),
  encode(substring(digest('tag', 'sha256') for 16), 'base64'),
  'test-v1', 'test', 'local', 'pin-bootstrap-mismatch-0001', repeat('a', 64)
);
select is(
  private.current_pin_sync_status(pg_temp.room_id(2)),
  'mismatch',
  'prepared physical change remains an explicit mismatch warning'
);
select is(
  (select allocation_ready
   from public.get_room_operational_projection(pg_temp.pid(1), pg_temp.room_id(2))),
  true,
  'mismatched PIN does not block reservation allocation readiness'
);
select ok(
  'PIN_MISMATCH' = any(private.room_block_reason_codes(
    pg_temp.room_id(2), clock_timestamp(), true, true, pg_temp.pid(901)
  )),
  'mismatched PIN still blocks the actual check-in gate'
);

-- Reservation creation succeeds before any encrypted current PIN exists.
insert into public.cleaning_template_versions(
  room_type_id, cleaning_kind, version, status, duration_minutes,
  photo_slots, published_at, created_by
)
select id, 'checkout', 1, 'published', 60, '[]'::jsonb,
  clock_timestamp(), pg_temp.pid(1)
from public.room_types;

select lives_ok(
  format(
    $sql$select public.create_reservation(
      %L, %L, %L, '2027-10-01 16:00:00+09', '2027-10-02 11:00:00+09',
      2, null, %s, %L, %L
    )$sql$,
    pg_temp.pid(1),
    pg_temp.pid(301),
    pg_temp.room_id(1),
    (select state_version from public.rooms where id = pg_temp.room_id(1)),
    'pinless-reservation-0001',
    repeat('b', 64)
  ),
  'reservation command accepts a room whose PIN is not configured'
);

select throws_ok(
  format(
    'select public.get_room_pin_bootstrap_context(%L,%L,1)',
    pg_temp.pid(2), pg_temp.pid(202)
  ),
  '42501',
  'ADMIN_REQUIRED',
  'maid cannot enumerate bootstrap candidates'
);

create temp table bootstrap_context(value jsonb);
insert into bootstrap_context
select public.get_room_pin_bootstrap_context(pg_temp.pid(1), pg_temp.pid(201), 1);
select is(
  (select jsonb_array_length(value->'candidates') from bootstrap_context),
  1,
  'admin receives a bounded bootstrap candidate list'
);
select is(
  (select value->'candidates'->0->>'room_id' from bootstrap_context),
  pg_temp.room_id(1)::text,
  'unresolved mismatch room is excluded from bootstrap candidates'
);

create temp table bootstrap_input(value jsonb);
insert into bootstrap_input
select jsonb_build_array(jsonb_build_object(
  'roomId', pg_temp.room_id(1),
  'roomNumber', pg_temp.room_number(1),
  'envelopeFormat', 1,
  'ciphertextBase64', encode(digest('bootstrap-ciphertext', 'sha256'), 'base64'),
  'nonceBase64', encode(substring(digest('bootstrap-nonce', 'sha256') for 12), 'base64'),
  'authTagBase64', encode(substring(digest('bootstrap-tag', 'sha256') for 16), 'base64'),
  'keyVersion', 'test-v1',
  'aadEnvironment', 'test',
  'aadProjectRef', 'local'
));

create temp table bootstrap_results(label text primary key, value jsonb);
insert into bootstrap_results values(
  'first',
  public.bootstrap_room_pins(
    pg_temp.pid(1), pg_temp.pid(201),
    (select value from bootstrap_input),
    'pin-bootstrap-batch-0001', repeat('c', 64)
  )
);
insert into bootstrap_results values(
  'replay',
  public.bootstrap_room_pins(
    pg_temp.pid(1), pg_temp.pid(201),
    '[]'::jsonb,
    'pin-bootstrap-batch-0001', repeat('c', 64)
  )
);

select is(
  (select value from bootstrap_results where label = 'replay'),
  (select value from bootstrap_results where label = 'first'),
  'response-loss retry replays the exact safe batch response'
);
select is(
  (select value->>'initialized_count' from bootstrap_results where label = 'first'),
  '1',
  'one eligible room is initialized'
);
select is(
  private.current_pin_sync_status(pg_temp.room_id(1)),
  'mismatch',
  'generated bootstrap remains mismatched before physical confirmation'
);
select is(
  (select count(*)::integer
   from private.room_pin_revisions where room_id = pg_temp.room_id(1)),
  1,
  'bootstrap appends exactly one encrypted revision'
);
select is(
  (select count(*)::integer
   from private.room_pin_sheet_sync_outbox where room_id = pg_temp.room_id(1)),
  0,
  'bootstrap does not publish an unconfirmed PIN to Sheet'
);
select is(
  (select count(*)::integer
   from public.audit_events
   where entity_id = pg_temp.room_id(1)
     and event_type = 'room.pin_change_confirmed'
     and after_state = jsonb_build_object('pinVersion', 1, 'status', 'verified')),
  0,
  'bootstrap does not claim physical confirmation'
);
select is(
  (select count(*)::integer
   from public.audit_events
   where entity_id = pg_temp.room_id(1)
     and event_type = 'room.pin_generated'
     and after_state = jsonb_build_object('pinVersion', 1, 'status', 'mismatch')),
  1,
  'bootstrap audit contains only safe generated-version metadata'
);
select ok(
  not exists(
    select 1
    from public.audit_events
    where entity_id = pg_temp.room_id(1)
      and after_state::text like '%cipher%'
  ) and (select value::text from bootstrap_results where label = 'first') not like '%cipher%',
  'bootstrap response and audit contain no envelope material'
);
select is(
  (select count(*)::integer
   from private.command_executions
   where actor_profile_id = pg_temp.pid(1)
     and command_type = 'room.pin.bootstrap'
     and idempotency_key = 'pin-bootstrap-batch-0001'),
  1,
  'bootstrap retry creates one scoped command receipt'
);

select throws_ok(
  format(
    'select public.begin_room_pin_reveal(%L,%L,%L,null,null,null,%L)',
    pg_temp.pid(1), pg_temp.pid(201), pg_temp.room_id(1), pg_temp.pid(400)
  ),
  '55000',
  'ROOM_PIN_MISMATCH_UNRESOLVED',
  'ordinary reveal remains closed for an unconfirmed generated PIN'
);
select throws_ok(
  format(
    'select public.begin_generated_room_pin_reveal(%L,%L,%L,%L)',
    pg_temp.pid(2), pg_temp.pid(202), pg_temp.room_id(1), pg_temp.pid(401)
  ),
  '42501',
  'ADMIN_REQUIRED',
  'maid cannot reveal an unconfirmed generated PIN'
);

create temp table generated_reveal(value jsonb);
insert into generated_reveal
select public.begin_generated_room_pin_reveal(
  pg_temp.pid(1), pg_temp.pid(201), pg_temp.room_id(1), pg_temp.pid(402)
);
select is(
  (select value->>'pin_version' from generated_reveal),
  '1',
  'admin generated reveal is bound to the current PIN version'
);
select lives_ok(
  format(
    'select public.finalize_generated_room_pin_reveal(%L,%L,%L,%L,%L)',
    pg_temp.pid(1), pg_temp.pid(201), pg_temp.room_id(1),
    (select value->>'lease_id' from generated_reveal), pg_temp.pid(402)
  ),
  'generated reveal rechecks authorization and records sensitive access'
);

create temp table generated_confirmation(value jsonb);
insert into generated_confirmation
select public.confirm_generated_room_pin(
  pg_temp.pid(1), pg_temp.pid(201), pg_temp.room_id(1), 1,
  'generated-pin-confirm-0001', repeat('9', 64)
);
select is(
  private.current_pin_sync_status(pg_temp.room_id(1)),
  'verified',
  'physical confirmation changes the generated PIN to verified'
);
select is(
  (select count(*)::integer
   from private.room_pin_sheet_sync_outbox
   where room_id = pg_temp.room_id(1)
     and reason_code = 'GENERATED_PIN_PHYSICALLY_CONFIRMED'),
  1,
  'physical confirmation enqueues one verified Sheet projection item'
);
select is(
  public.confirm_generated_room_pin(
    pg_temp.pid(1), pg_temp.pid(201), pg_temp.room_id(1), 1,
    'generated-pin-confirm-0001', repeat('9', 64)
  ),
  (select value from generated_confirmation),
  'generated confirmation replay returns the original receipt'
);
select throws_ok(
  format(
    'select public.begin_generated_room_pin_reveal(%L,%L,%L,%L)',
    pg_temp.pid(1), pg_temp.pid(201), pg_temp.room_id(1), pg_temp.pid(403)
  ),
  '42501',
  'GENERATED_PIN_REVEAL_NOT_ALLOWED',
  'generated-only reveal closes after physical confirmation'
);
select is(
  (select count(*)::integer
   from public.list_developer_audit_events(
     pg_temp.pid(3),
     array['room.pin_generated', 'room.generated_pin_confirmed'],
     pg_temp.pid(1), null, null, null, null, 10
   )
   where entity_id = pg_temp.room_id(1)
     and summary ?& array['pinVersion', 'status']
     and summary - array['pinVersion', 'status'] = '{}'::jsonb),
  2,
  'developer audit exposes both generated lifecycle events with safe metadata only'
);

select throws_ok(
  format(
    'select public.bootstrap_room_pins(%L,%L,%L::jsonb,%L,%L)',
    pg_temp.pid(1), pg_temp.pid(201), '[]',
    'pin-bootstrap-batch-0001', repeat('d', 64)
  ),
  '23505',
  'IDEMPOTENCY_KEY_REUSED',
  'same bootstrap key cannot be reused with a different request hash'
);

insert into bootstrap_results values(
  'skip-current',
  public.bootstrap_room_pins(
    pg_temp.pid(1), pg_temp.pid(201),
    (select value from bootstrap_input),
    'pin-bootstrap-batch-0002', repeat('e', 64)
  )
);
select is(
  (select value->>'skipped_count' from bootstrap_results where label = 'skip-current'),
  '1',
  'bootstrap never overwrites an existing current PIN'
);
select is(
  (select count(*)::integer
   from private.room_pin_revisions where room_id = pg_temp.room_id(1)),
  1,
  'skipped current room creates no extra revision'
);

select throws_ok(
  format(
    'select public.bootstrap_room_pins(%L,%L,%L::jsonb,%L,%L)',
    pg_temp.pid(1),
    pg_temp.pid(201),
    jsonb_build_array((select value->0 || jsonb_build_object('pinDigits', 'forbidden') from bootstrap_input))::text,
    'pin-bootstrap-invalid-0001',
    repeat('f', 64)
  ),
  '22023',
  'INVALID_PIN_BOOTSTRAP',
  'bootstrap rejects plaintext or unknown candidate fields'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.get_room_pin_bootstrap_context(uuid,uuid,integer)',
    'execute'
  ) and has_function_privilege(
    'service_role',
    'public.bootstrap_room_pins(uuid,uuid,jsonb,text,text)',
    'execute'
  ) and not has_function_privilege(
    'authenticated',
    'public.get_room_pin_bootstrap_context(uuid,uuid,integer)',
    'execute'
  ) and not has_function_privilege(
    'authenticated',
    'public.bootstrap_room_pins(uuid,uuid,jsonb,text,text)',
    'execute'
  ) and has_function_privilege(
    'service_role',
    'public.begin_generated_room_pin_reveal(uuid,uuid,uuid,uuid)',
    'execute'
  ) and has_function_privilege(
    'service_role',
    'public.finalize_generated_room_pin_reveal(uuid,uuid,uuid,uuid,uuid)',
    'execute'
  ) and has_function_privilege(
    'service_role',
    'public.confirm_generated_room_pin(uuid,uuid,uuid,bigint,text,text)',
    'execute'
  ) and not has_function_privilege(
    'authenticated',
    'public.confirm_generated_room_pin(uuid,uuid,uuid,bigint,text,text)',
    'execute'
  ),
  'bootstrap RPCs are callable only through the service adapter'
);

select * from finish();
rollback;
