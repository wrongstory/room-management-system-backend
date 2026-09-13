-- Issue #140: an unconfigured or mismatched room PIN is an operational
-- warning, not a reservation-allocation blocker. Actual check-in keeps the
-- stricter verified-PIN gate by passing a preparation reservation identity.

create or replace function private.room_block_reason_codes(
  p_room_id uuid,
  p_at timestamptz,
  p_include_occupancy boolean default true,
  p_include_cleaning boolean default true,
  p_preparation_reservation_id uuid default null
)
returns text[]
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_reasons text[] := array[]::text[];
  v_room public.rooms%rowtype;
  v_pin_status text;
begin
  select * into v_room from public.rooms where id = p_room_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'ROOM_NOT_FOUND';
  end if;

  if p_include_occupancy and exists (
    select 1
    from public.reservations r
    where r.room_id = p_room_id
      and r.status = 'active'
      and r.actual_check_in_at is not null
      and r.actual_check_in_at <= p_at
      and r.actual_checkout_at is null
  ) then
    v_reasons := array_append(v_reasons, 'OCCUPIED');
  end if;

  if p_include_cleaning and exists (
    select 1
    from public.preparation_obligations po
    join public.reservations r on r.id = po.reservation_id
    where po.room_id = p_room_id
      and r.status = 'active'
      and (
        p_preparation_reservation_id is null
        or po.reservation_id = p_preparation_reservation_id
      )
      and po.status <> 'approved'
  ) then
    v_reasons := array_append(v_reasons, 'CLEANING_REQUIRED');
  end if;

  if private.current_candle_count(p_room_id) > 0 then
    v_reasons := array_append(v_reasons, 'CANDLE_PRESENT');
  end if;

  if exists (
    select 1
    from public.room_operation_blocks b
    where b.room_id = p_room_id
      and b.released_at is null
      and b.starts_at <= p_at
      and (b.ends_at is null or b.ends_at > p_at)
  ) then
    v_reasons := array_append(v_reasons, 'OPERATION_BLOCKED');
  end if;

  if exists (
    select 1
    from public.room_issues i
    where i.room_id = p_room_id
      and i.status = 'open'
      and i.blocks_guest_assignment
  ) then
    v_reasons := array_append(v_reasons, 'ROOM_ISSUE_BLOCKED');
  end if;

  -- A non-null preparation reservation identifies the actual check-in gate.
  -- Reservation creation/change and the room allocation projection pass null,
  -- so they expose pin_sync_status separately without turning it into a block.
  if p_preparation_reservation_id is not null then
    v_pin_status := private.current_pin_sync_status(p_room_id);
    if v_pin_status = 'mismatch' then
      v_reasons := array_append(v_reasons, 'PIN_MISMATCH');
    elsif v_pin_status = 'unconfigured' then
      v_reasons := array_append(v_reasons, 'DATA_UNCONFIRMED');
    end if;
  end if;

  if v_room.data_status <> 'verified'
    and not ('DATA_UNCONFIRMED' = any(v_reasons)) then
    v_reasons := array_append(v_reasons, 'DATA_UNCONFIRMED');
  end if;

  return v_reasons;
end;
$$;

revoke all on function private.room_block_reason_codes(
  uuid, timestamptz, boolean, boolean, uuid
) from public, anon, authenticated, service_role;

-- The trusted runtime asks for a bounded set of rooms, constructs each
-- canonical credential with a deployment-only initial PIN, and returns only
-- encrypted envelopes to PostgreSQL.
create function public.get_room_pin_bootstrap_context(
  p_actor_profile_id uuid,
  p_session_id uuid,
  p_limit integer default 20
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.profiles;
  v_candidates jsonb;
  v_remaining_count integer;
begin
  v_actor := private.assert_room_pin_actor_session(
    p_actor_profile_id,
    p_session_id
  );
  if v_actor.role <> 'admin' then
    raise exception using errcode = '42501', message = 'ADMIN_REQUIRED';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 25 then
    raise exception using errcode = '22023', message = 'INVALID_PIN_BOOTSTRAP_LIMIT';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'room_id', candidate.id,
        'room_number', candidate.room_number,
        'proposed_pin_version', 1
      )
      order by candidate.room_number, candidate.id
    ),
    '[]'::jsonb
  )
  into v_candidates
  from (
    select r.id, r.room_number
    from public.rooms r
    where not exists (
      select 1
      from private.room_current_pin current_pin
      where current_pin.room_id = r.id
    )
      and not exists (
        select 1
        from private.room_pin_change_leases change_lease
        where change_lease.room_id = r.id
          and change_lease.status in ('prepared', 'expired')
      )
    order by r.room_number, r.id
    limit p_limit
  ) candidate;

  select count(*)::integer
  into v_remaining_count
  from public.rooms r
  where not exists (
    select 1
    from private.room_current_pin current_pin
    where current_pin.room_id = r.id
  )
    and not exists (
      select 1
      from private.room_pin_change_leases change_lease
      where change_lease.room_id = r.id
        and change_lease.status in ('prepared', 'expired')
    );

  return jsonb_build_object(
    'candidates', v_candidates,
    'remaining_count', v_remaining_count
  );
end;
$$;

create function public.bootstrap_room_pins(
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
      id,
      room_id,
      pin_version,
      envelope_format,
      ciphertext,
      nonce,
      auth_tag,
      key_version,
      aad_environment,
      aad_project_ref,
      recorded_by,
      recorded_by_role,
      source,
      created_at
    ) values (
      v_revision_id,
      v_room.id,
      1,
      v_envelope_format,
      v_ciphertext,
      v_nonce,
      v_auth_tag,
      v_key_version,
      v_aad_environment,
      v_aad_project_ref,
      v_actor.id,
      'admin',
      'admin_initial_entry',
      v_now
    );

    insert into private.room_current_pin (
      room_id,
      pin_revision_id,
      pin_version,
      updated_at
    ) values (
      v_room.id,
      v_revision_id,
      1,
      v_now
    );

    insert into public.room_pin_sync_events (
      room_id,
      sync_status,
      pin_version,
      reason_code,
      actor_profile_id,
      effective_at,
      recorded_at
    ) values (
      v_room.id,
      'verified',
      1,
      'PIN_CHANGE_CONFIRMED',
      v_actor.id,
      v_now,
      v_now
    );

    insert into private.room_pin_sheet_sync_outbox (
      room_id,
      pin_version,
      sync_status,
      reason_code,
      next_attempt_at
    ) values (
      v_room.id,
      1,
      'verified',
      'PIN_CHANGE_CONFIRMED',
      v_now
    );

    update public.rooms
    set state_version = state_version + 1
    where id = v_room.id;

    insert into public.audit_events (
      actor_profile_id,
      actor_display_name_snapshot,
      event_type,
      entity_type,
      entity_id,
      effective_at,
      reason_code,
      after_state,
      request_hash,
      idempotency_key
    ) values (
      v_actor.id,
      v_actor.display_name,
      'room.pin_change_confirmed',
      'room',
      v_room.id,
      v_now,
      'ADMIN_INITIAL_PIN',
      jsonb_build_object('pinVersion', 1, 'status', 'verified'),
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
    select 1
    from private.room_current_pin current_pin
    where current_pin.room_id = r.id
  )
    and not exists (
      select 1
      from private.room_pin_change_leases change_lease
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

revoke all on function public.get_room_pin_bootstrap_context(
  uuid, uuid, integer
) from public, anon, authenticated, service_role;
revoke all on function public.bootstrap_room_pins(
  uuid, uuid, jsonb, text, text
) from public, anon, authenticated, service_role;

grant execute on function public.get_room_pin_bootstrap_context(
  uuid, uuid, integer
) to service_role;
grant execute on function public.bootstrap_room_pins(
  uuid, uuid, jsonb, text, text
) to service_role;

comment on function public.get_room_pin_bootstrap_context(uuid, uuid, integer)
is 'Returns a bounded, secret-free list of rooms eligible for encrypted initial PIN bootstrap.';
comment on function public.bootstrap_room_pins(uuid, uuid, jsonb, text, text)
is 'Atomically installs trusted-runtime encrypted initial PIN revisions without storing plaintext.';
