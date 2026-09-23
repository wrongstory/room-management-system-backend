begin;

-- Generated initial credentials stay mismatch until an administrator confirms
-- that each physical door lock was updated. Only that confirmation enters the
-- Sheet synchronization outbox.
alter table private.room_pin_sheet_sync_outbox
  drop constraint room_pin_sheet_sync_outbox_reason_code_check,
  add constraint room_pin_sheet_sync_outbox_reason_code_check check (
    reason_code in (
      'PIN_CHANGE_CONFIRMED',
      'PHYSICAL_ROLLBACK_CONFIRMED',
      'GENERATED_PIN_PHYSICALLY_CONFIRMED'
    )
  );

create or replace function public.bootstrap_room_pins(
  p_actor_profile_id uuid,
  p_session_id uuid,
  p_candidates jsonb,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.profiles;
  v_replay jsonb;
  v_item jsonb;
  v_room public.rooms;
  v_room_id uuid;
  v_room_number text;
  v_revision_id uuid;
  v_envelope_format smallint;
  v_ciphertext bytea;
  v_nonce bytea;
  v_auth_tag bytea;
  v_key_version text;
  v_aad_environment text;
  v_aad_project_ref text;
  v_initialized_ids uuid[] := array[]::uuid[];
  v_skipped_ids uuid[] := array[]::uuid[];
  v_remaining_count integer;
  v_now timestamptz := clock_timestamp();
  v_response jsonb;
begin
  perform pg_advisory_xact_lock(
    hashtextextended('room-management:reservation-command', 0)
  );

  v_actor := private.assert_room_pin_actor_session(
    p_actor_profile_id,
    p_session_id
  );
  if v_actor.role <> 'admin' then
    raise exception using errcode = '42501', message = 'ADMIN_REQUIRED';
  end if;

  v_replay := private.replay_command(
    v_actor.id,
    'room.pin.bootstrap',
    p_idempotency_key,
    p_request_hash
  );
  if v_replay is not null then
    return v_replay;
  end if;

  if p_candidates is null
    or jsonb_typeof(p_candidates) <> 'array'
    or jsonb_array_length(p_candidates) > 25 then
    raise exception using errcode = '22023', message = 'INVALID_PIN_BOOTSTRAP';
  end if;

  if (
    select count(*) <> count(distinct candidate.value->>'roomId')
    from jsonb_array_elements(p_candidates) candidate(value)
  ) then
    raise exception using errcode = '22023', message = 'INVALID_PIN_BOOTSTRAP';
  end if;

  for v_item in
    select candidate.value
    from jsonb_array_elements(p_candidates) candidate(value)
    order by candidate.value->>'roomId'
  loop
    if jsonb_typeof(v_item) <> 'object'
      or not v_item ?& array[
        'roomId', 'roomNumber', 'envelopeFormat', 'ciphertextBase64',
        'nonceBase64', 'authTagBase64', 'keyVersion',
        'aadEnvironment', 'aadProjectRef'
      ]
      or exists (
        select 1
        from jsonb_object_keys(v_item) supplied(supplied_key)
        where supplied_key <> all(array[
          'roomId', 'roomNumber', 'envelopeFormat', 'ciphertextBase64',
          'nonceBase64', 'authTagBase64', 'keyVersion',
          'aadEnvironment', 'aadProjectRef'
        ])
      ) then
      raise exception using errcode = '22023', message = 'INVALID_PIN_BOOTSTRAP';
    end if;

    begin
      v_room_id := (v_item->>'roomId')::uuid;
      v_room_number := v_item->>'roomNumber';
      v_envelope_format := (v_item->>'envelopeFormat')::smallint;
      v_ciphertext := decode(v_item->>'ciphertextBase64', 'base64');
      v_nonce := decode(v_item->>'nonceBase64', 'base64');
      v_auth_tag := decode(v_item->>'authTagBase64', 'base64');
      v_key_version := v_item->>'keyVersion';
      v_aad_environment := v_item->>'aadEnvironment';
      v_aad_project_ref := v_item->>'aadProjectRef';
    exception when others then
      raise exception using errcode = '22023', message = 'INVALID_PIN_BOOTSTRAP';
    end;

    if v_room_number is null
      or v_envelope_format <> 1
      or octet_length(v_ciphertext) not between 1 and 256
      or octet_length(v_nonce) <> 12
      or octet_length(v_auth_tag) <> 16
      or v_key_version !~ '^[A-Za-z0-9._-]{1,32}$'
      or v_aad_environment !~ '^[A-Za-z0-9._:-]{1,80}$'
      or v_aad_project_ref !~ '^[A-Za-z0-9._:-]{1,80}$' then
      raise exception using errcode = '22023', message = 'INVALID_PIN_BOOTSTRAP';
    end if;

    perform pg_advisory_xact_lock(hashtextextended('room-pin:' || v_room_id::text, 0));
    select * into v_room
    from public.rooms
    where id = v_room_id
    for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'ROOM_NOT_FOUND';
    end if;
    if v_room.room_number <> v_room_number then
      raise exception using errcode = '40001', message = 'ROOM_NUMBER_CHANGED';
    end if;

    if exists (
      select 1 from private.room_current_pin where room_id = v_room.id
    ) or exists (
      select 1
      from private.room_pin_change_leases
      where room_id = v_room.id
        and status in ('prepared', 'expired')
    ) then
      v_skipped_ids := array_append(v_skipped_ids, v_room.id);
      continue;
    end if;

    v_revision_id := gen_random_uuid();
    insert into private.room_pin_revisions (
      id, room_id, pin_version, envelope_format, ciphertext, nonce, auth_tag,
      key_version, aad_environment, aad_project_ref, recorded_by,
      recorded_by_role, source, created_at
    ) values (
      v_revision_id, v_room.id, 1, v_envelope_format, v_ciphertext, v_nonce,
      v_auth_tag, v_key_version, v_aad_environment, v_aad_project_ref,
      v_actor.id, 'admin', 'admin_initial_entry', v_now
    );

    insert into private.room_current_pin (
      room_id, pin_revision_id, pin_version, updated_at
    ) values (v_room.id, v_revision_id, 1, v_now);

    insert into public.room_pin_sync_events (
      room_id, sync_status, pin_version, reason_code, actor_profile_id,
      effective_at, recorded_at
    ) values (
      v_room.id, 'mismatch', 1, 'GENERATED_PIN_AWAITING_PHYSICAL_CONFIRMATION',
      v_actor.id, v_now, v_now
    );

    update public.rooms
    set state_version = state_version + 1
    where id = v_room.id;

    insert into public.audit_events (
      actor_profile_id, actor_display_name_snapshot, event_type, entity_type,
      entity_id, effective_at, reason_code, after_state, request_hash,
      idempotency_key
    ) values (
      v_actor.id, v_actor.display_name, 'room.pin_generated', 'room',
      v_room.id, v_now, 'GENERATED_INITIAL_PIN',
      jsonb_build_object('pinVersion', 1, 'status', 'mismatch'),
      p_request_hash,
      private.audit_command_key(
        v_actor.id,
        'room.pin.bootstrap.' || v_room.id::text,
        p_idempotency_key
      )
    );

    v_initialized_ids := array_append(v_initialized_ids, v_room.id);
  end loop;

  select count(*)::integer
  into v_remaining_count
  from public.rooms r
  where not exists (
    select 1 from private.room_current_pin current_pin
    where current_pin.room_id = r.id
  )
    and not exists (
      select 1 from private.room_pin_change_leases change_lease
      where change_lease.room_id = r.id
        and change_lease.status in ('prepared', 'expired')
    );

  v_response := jsonb_build_object(
    'initialized_room_ids', to_jsonb(v_initialized_ids),
    'skipped_room_ids', to_jsonb(v_skipped_ids),
    'initialized_count', cardinality(v_initialized_ids),
    'skipped_count', cardinality(v_skipped_ids),
    'remaining_count', v_remaining_count,
    'completed_at', v_now
  );

  perform private.complete_command(
    v_actor.id,
    'room.pin.bootstrap',
    p_idempotency_key,
    p_request_hash,
    null,
    v_response
  );
  return v_response;
end;
$$;

create function public.begin_generated_room_pin_reveal(
  p_actor_profile_id uuid,
  p_session_id uuid,
  p_room_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.profiles;
  v_room public.rooms;
  v_current private.room_current_pin;
  v_revision private.room_pin_revisions;
  v_lease private.room_pin_reveal_leases;
  v_sync public.room_pin_sync_events;
  v_now timestamptz := clock_timestamp();
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command', 0));
  perform pg_advisory_xact_lock(hashtextextended('room-pin:' || p_room_id::text, 0));
  v_actor := private.assert_room_pin_actor_session(p_actor_profile_id, p_session_id);
  if v_actor.role <> 'admin' then
    raise exception using errcode = '42501', message = 'ADMIN_REQUIRED';
  end if;

  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'ROOM_NOT_FOUND';
  end if;
  select * into v_current
  from private.room_current_pin where room_id = p_room_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'ROOM_PIN_UNCONFIGURED';
  end if;
  select * into v_sync
  from public.room_pin_sync_events
  where room_id = p_room_id
  order by recorded_at desc, id desc
  limit 1;
  select * into v_revision
  from private.room_pin_revisions where id = v_current.pin_revision_id;

  if v_sync.sync_status is distinct from 'mismatch'
    or v_sync.pin_version is distinct from v_current.pin_version
    or v_sync.reason_code is distinct from 'GENERATED_PIN_AWAITING_PHYSICAL_CONFIRMATION'
    or v_revision.source is distinct from 'admin_initial_entry'
    or exists (
      select 1 from private.room_pin_change_leases
      where room_id = p_room_id and status in ('prepared', 'expired')
    ) then
    raise exception using errcode = '42501', message = 'GENERATED_PIN_REVEAL_NOT_ALLOWED';
  end if;

  insert into private.room_pin_reveal_leases (
    room_id, pin_revision_id, pin_version, actor_profile_id,
    actor_role_snapshot, assignment_id, attempt_id,
    authoritative_access_lease_id, issued_at, expires_at, request_id
  ) values (
    p_room_id, v_revision.id, v_revision.pin_version, v_actor.id, 'admin',
    null, null, null, v_now, v_now + interval '30 seconds', p_request_id
  ) returning * into v_lease;

  return jsonb_build_object(
    'lease_id', v_lease.id,
    'room_id', p_room_id,
    'room_number', v_room.room_number,
    'pin_version', v_revision.pin_version,
    'expires_at', v_lease.expires_at,
    'envelope_format', v_revision.envelope_format,
    'ciphertext_base64', encode(v_revision.ciphertext, 'base64'),
    'nonce_base64', encode(v_revision.nonce, 'base64'),
    'auth_tag_base64', encode(v_revision.auth_tag, 'base64'),
    'key_version', v_revision.key_version,
    'aad_environment', v_revision.aad_environment,
    'aad_project_ref', v_revision.aad_project_ref
  );
end;
$$;

create function public.finalize_generated_room_pin_reveal(
  p_actor_profile_id uuid,
  p_session_id uuid,
  p_room_id uuid,
  p_reveal_lease_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.profiles;
  v_room public.rooms;
  v_current private.room_current_pin;
  v_lease private.room_pin_reveal_leases;
  v_sync public.room_pin_sync_events;
  v_activity_id uuid;
  v_now timestamptz := clock_timestamp();
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command', 0));
  perform pg_advisory_xact_lock(hashtextextended('room-pin:' || p_room_id::text, 0));
  v_actor := private.assert_room_pin_actor_session(p_actor_profile_id, p_session_id);
  if v_actor.role <> 'admin' then
    raise exception using errcode = '42501', message = 'ADMIN_REQUIRED';
  end if;

  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'ROOM_NOT_FOUND';
  end if;
  select * into v_current
  from private.room_current_pin where room_id = p_room_id for update;
  select * into v_lease
  from private.room_pin_reveal_leases
  where id = p_reveal_lease_id and room_id = p_room_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'PIN_REVEAL_LEASE_NOT_FOUND';
  end if;
  select * into v_sync
  from public.room_pin_sync_events
  where room_id = p_room_id
  order by recorded_at desc, id desc
  limit 1;

  if v_lease.actor_profile_id <> v_actor.id
    or v_lease.actor_role_snapshot <> 'admin'
    or v_lease.request_id <> p_request_id
    or v_lease.finalized_at is not null
    or v_lease.expires_at <= v_now
    or v_current.pin_revision_id is distinct from v_lease.pin_revision_id
    or v_current.pin_version is distinct from v_lease.pin_version
    or v_sync.sync_status is distinct from 'mismatch'
    or v_sync.pin_version is distinct from v_current.pin_version
    or v_sync.reason_code is distinct from 'GENERATED_PIN_AWAITING_PHYSICAL_CONFIRMATION'
    or exists (
      select 1 from private.room_pin_change_leases
      where room_id = p_room_id and status in ('prepared', 'expired')
    ) then
    raise exception using errcode = '42501', message = 'PIN_REVEAL_AUTHORIZATION_CHANGED';
  end if;

  update private.room_pin_reveal_leases
  set finalized_at = v_now
  where id = v_lease.id;

  insert into private.actor_activity_events (
    actor_profile_id, actor_role_snapshot, category, event_type, outcome,
    source, resource_type, resource_id, reason_code, request_id, occurred_at
  ) values (
    v_actor.id, 'admin', 'sensitive_access', 'sensitive.read', 'succeeded',
    'edge.sensitive.room_pin', 'room', p_room_id,
    'GENERATED_PIN_BOOTSTRAP', p_request_id::text, v_now
  ) returning id into v_activity_id;

  return jsonb_build_object(
    'room_id', p_room_id,
    'pin_version', v_lease.pin_version,
    'reveal_lease_id', v_lease.id,
    'activity_id', v_activity_id,
    'finalized_at', v_now
  );
end;
$$;

create function public.confirm_generated_room_pin(
  p_actor_profile_id uuid,
  p_session_id uuid,
  p_room_id uuid,
  p_expected_pin_version bigint,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.profiles;
  v_room public.rooms;
  v_current private.room_current_pin;
  v_revision private.room_pin_revisions;
  v_sync public.room_pin_sync_events;
  v_replay jsonb;
  v_response jsonb;
  v_now timestamptz := clock_timestamp();
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command', 0));
  perform pg_advisory_xact_lock(hashtextextended('room-pin:' || p_room_id::text, 0));
  v_actor := private.assert_room_pin_actor_session(p_actor_profile_id, p_session_id);
  if v_actor.role <> 'admin' then
    raise exception using errcode = '42501', message = 'ADMIN_REQUIRED';
  end if;

  v_replay := private.replay_command(
    v_actor.id,
    'room.pin.generated.confirm',
    p_idempotency_key,
    p_request_hash
  );
  if v_replay is not null then
    return v_replay;
  end if;
  if p_expected_pin_version is null or p_expected_pin_version < 1 then
    raise exception using errcode = '22023', message = 'INVALID_PIN_VERSION';
  end if;

  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'ROOM_NOT_FOUND';
  end if;
  select * into v_current
  from private.room_current_pin where room_id = p_room_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'ROOM_PIN_UNCONFIGURED';
  end if;
  if v_current.pin_version <> p_expected_pin_version then
    raise exception using errcode = '40001', message = 'STALE_PIN_VERSION';
  end if;
  select * into v_revision
  from private.room_pin_revisions where id = v_current.pin_revision_id;
  select * into v_sync
  from public.room_pin_sync_events
  where room_id = p_room_id
  order by recorded_at desc, id desc
  limit 1;

  if v_sync.sync_status is distinct from 'mismatch'
    or v_sync.pin_version is distinct from v_current.pin_version
    or v_sync.reason_code is distinct from 'GENERATED_PIN_AWAITING_PHYSICAL_CONFIRMATION'
    or v_revision.source is distinct from 'admin_initial_entry'
    or exists (
      select 1 from private.room_pin_change_leases
      where room_id = p_room_id and status in ('prepared', 'expired')
    ) then
    raise exception using errcode = '55000', message = 'GENERATED_PIN_CONFIRMATION_NOT_ALLOWED';
  end if;

  insert into public.room_pin_sync_events (
    room_id, sync_status, pin_version, reason_code, actor_profile_id,
    effective_at, recorded_at
  ) values (
    p_room_id, 'verified', v_current.pin_version,
    'GENERATED_PIN_PHYSICALLY_CONFIRMED', v_actor.id, v_now, v_now
  );

  insert into private.room_pin_sheet_sync_outbox (
    room_id, pin_version, sync_status, reason_code, next_attempt_at
  ) values (
    p_room_id, v_current.pin_version, 'verified',
    'GENERATED_PIN_PHYSICALLY_CONFIRMED', v_now
  );

  update public.rooms
  set state_version = state_version + 1
  where id = p_room_id;

  v_response := jsonb_build_object(
    'room_id', p_room_id,
    'pin_version', v_current.pin_version,
    'status', 'verified',
    'confirmed_at', v_now
  );

  insert into public.audit_events (
    actor_profile_id, actor_display_name_snapshot, event_type, entity_type,
    entity_id, effective_at, reason_code, after_state, request_hash,
    idempotency_key
  ) values (
    v_actor.id, v_actor.display_name, 'room.generated_pin_confirmed', 'room',
    p_room_id, v_now, 'GENERATED_PIN_PHYSICALLY_CONFIRMED',
    jsonb_build_object('pinVersion', v_current.pin_version, 'status', 'verified'),
    p_request_hash,
    private.audit_command_key(
      v_actor.id,
      'room.pin.generated.confirm',
      p_idempotency_key
    )
  );

  perform private.complete_command(
    v_actor.id,
    'room.pin.generated.confirm',
    p_idempotency_key,
    p_request_hash,
    p_room_id,
    v_response
  );
  return v_response;
end;
$$;

-- Extend the bounded developer audit projection with generated-PIN lifecycle
-- events. Only version and synchronization status are exposed.
alter function public.list_developer_audit_events(
  uuid, text[], uuid, timestamptz, timestamptz, timestamptz, uuid, integer
) set schema private;
alter function private.list_developer_audit_events(
  uuid, text[], uuid, timestamptz, timestamptz, timestamptz, uuid, integer
) rename to list_developer_audit_events_before_generated_pin;
revoke all on function private.list_developer_audit_events_before_generated_pin(
  uuid, text[], uuid, timestamptz, timestamptz, timestamptz, uuid, integer
) from public, anon, authenticated, service_role;

create function public.list_developer_audit_events(
  p_actor_profile_id uuid,
  p_event_types text[] default null,
  p_filter_actor_profile_id uuid default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_before_recorded_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 50
) returns table(
  id uuid, event_type text, entity_type text, entity_id uuid,
  actor_profile_id uuid, actor_display_name text, effective_at timestamptz,
  recorded_at timestamptz, reason_code text, summary jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new_types constant text[] := array[
    'room.pin_generated', 'room.generated_pin_confirmed'
  ];
  v_previous_types text[];
  v_from timestamptz := coalesce(p_from, clock_timestamp() - interval '7 days');
  v_to timestamptz := coalesce(p_to, clock_timestamp());
begin
  if p_event_types is not null and coalesce(cardinality(p_event_types), 0) = 0 then
    raise exception using errcode = '22023', message = 'INVALID_AUDIT_QUERY';
  end if;
  if p_event_types is null then
    v_previous_types := null;
  else
    select coalesce(array_agg(requested), array[]::text[])
    into v_previous_types
    from unnest(p_event_types) requested
    where requested <> all(v_new_types);
    if cardinality(v_previous_types) = 0 then
      v_previous_types := array['account.created'];
    end if;
  end if;

  return query
  select merged.* from (
    select previous.*
    from private.list_developer_audit_events_before_generated_pin(
      p_actor_profile_id, v_previous_types, p_filter_actor_profile_id,
      p_from, p_to, p_before_recorded_at, p_before_id, p_limit
    ) previous
    where p_event_types is null or previous.event_type = any(p_event_types)
    union all
    select audit.id, audit.event_type, audit.entity_type, audit.entity_id,
      audit.actor_profile_id, audit.actor_display_name_snapshot,
      audit.effective_at, audit.recorded_at, audit.reason_code,
      jsonb_strip_nulls(jsonb_build_object(
        'pinVersion', audit.after_state -> 'pinVersion',
        'status', audit.after_state ->> 'status'
      ))
    from public.audit_events audit
    where audit.event_type = any(v_new_types)
      and (p_event_types is null or audit.event_type = any(p_event_types))
      and audit.recorded_at >= v_from and audit.recorded_at <= v_to
      and (p_filter_actor_profile_id is null or audit.actor_profile_id = p_filter_actor_profile_id)
      and (p_before_recorded_at is null
        or (audit.recorded_at, audit.id) < (p_before_recorded_at, p_before_id))
    order by recorded_at desc, id desc
    limit p_limit
  ) merged
  order by merged.recorded_at desc, merged.id desc
  limit p_limit;
end;
$$;

revoke all on function public.list_developer_audit_events(
  uuid, text[], uuid, timestamptz, timestamptz, timestamptz, uuid, integer
) from public, anon, authenticated;
grant execute on function public.list_developer_audit_events(
  uuid, text[], uuid, timestamptz, timestamptz, timestamptz, uuid, integer
) to service_role;

revoke all on function public.begin_generated_room_pin_reveal(
  uuid, uuid, uuid, uuid
) from public, anon, authenticated, service_role;
revoke all on function public.finalize_generated_room_pin_reveal(
  uuid, uuid, uuid, uuid, uuid
) from public, anon, authenticated, service_role;
revoke all on function public.confirm_generated_room_pin(
  uuid, uuid, uuid, bigint, text, text
) from public, anon, authenticated, service_role;

grant execute on function public.begin_generated_room_pin_reveal(
  uuid, uuid, uuid, uuid
) to service_role;
grant execute on function public.finalize_generated_room_pin_reveal(
  uuid, uuid, uuid, uuid, uuid
) to service_role;
grant execute on function public.confirm_generated_room_pin(
  uuid, uuid, uuid, bigint, text, text
) to service_role;

comment on function public.bootstrap_room_pins(uuid, uuid, jsonb, text, text)
is 'Atomically installs generated encrypted initial PIN revisions in mismatch state without storing plaintext.';
comment on function public.begin_generated_room_pin_reveal(uuid, uuid, uuid, uuid)
is 'Begins a 30-second admin-only reveal for a generated PIN awaiting physical confirmation.';
comment on function public.finalize_generated_room_pin_reveal(uuid, uuid, uuid, uuid, uuid)
is 'Rechecks and records admin access to a generated PIN without persisting plaintext.';
comment on function public.confirm_generated_room_pin(uuid, uuid, uuid, bigint, text, text)
is 'Confirms physical installation of a generated PIN and queues verified Sheet synchronization.';
comment on function public.list_developer_audit_events(
  uuid, text[], uuid, timestamptz, timestamptz, timestamptz, uuid, integer
) is 'Lists bounded safe developer audit projections including generated PIN lifecycle metadata.';

commit;
