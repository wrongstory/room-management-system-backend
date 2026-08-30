-- Issue #42 security follow-up:
-- 1. bound unauthenticated login bucket cardinality with a global gate;
-- 2. move account command replay from the global audit key to scoped receipts.
-- Existing migrations are already applied remotely, so this remains append-only.

create function private.consume_login_rate_limit_bucket(
  p_key_hash text,
  p_limit integer,
  p_window_seconds integer,
  p_now timestamptz
)
returns table (
  allowed boolean,
  retry_after_seconds integer,
  remaining integer
)
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  v_row private.login_rate_limit_windows%rowtype;
begin
  insert into private.login_rate_limit_windows (
    key_hash,
    window_started_at,
    attempt_count,
    expires_at
  ) values (
    p_key_hash,
    p_now,
    1,
    p_now + make_interval(secs => p_window_seconds)
  )
  on conflict (key_hash) do update
  set
    window_started_at = case
      when private.login_rate_limit_windows.expires_at <= p_now then p_now
      else private.login_rate_limit_windows.window_started_at
    end,
    attempt_count = case
      when private.login_rate_limit_windows.expires_at <= p_now then 1
      else least(private.login_rate_limit_windows.attempt_count + 1, 32767)
    end,
    expires_at = case
      when private.login_rate_limit_windows.expires_at <= p_now
        then p_now + make_interval(secs => p_window_seconds)
      else private.login_rate_limit_windows.expires_at
    end
  returning * into v_row;

  return query select
    v_row.attempt_count <= p_limit,
    case
      when v_row.attempt_count <= p_limit then 0
      else greatest(1, ceil(extract(epoch from (v_row.expires_at - p_now)))::integer)
    end,
    greatest(0, p_limit - v_row.attempt_count);
end;
$$;

create function public.consume_login_rate_limits(
  p_global_key_hash text,
  p_login_key_hash text,
  p_global_limit integer default 60,
  p_login_limit integer default 10,
  p_window_seconds integer default 60
)
returns table (
  allowed boolean,
  retry_after_seconds integer,
  remaining integer,
  blocked_scope text
)
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_result record;
begin
  if p_global_key_hash is null or p_global_key_hash !~ '^[0-9a-f]{64}$'
    or p_login_key_hash is null or p_login_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'INVALID_RATE_LIMIT_KEY';
  end if;
  if p_global_key_hash = p_login_key_hash then
    raise exception using errcode = '22023', message = 'RATE_LIMIT_KEYS_MUST_DIFFER';
  end if;
  if p_global_limit < 1 or p_global_limit > 10000
    or p_login_limit < 1 or p_login_limit > p_global_limit
    or p_window_seconds < 1 or p_window_seconds > 3600 then
    raise exception using errcode = '22023', message = 'INVALID_RATE_LIMIT_CONFIGURATION';
  end if;

  -- Login requests must not perform an unbounded sweep. At most 64 stale rows
  -- are reclaimed per call, independently of the total table cardinality.
  delete from private.login_rate_limit_windows windows
  where windows.ctid in (
    select candidates.ctid
    from private.login_rate_limit_windows candidates
    where candidates.expires_at < v_now - interval '10 minutes'
    order by candidates.expires_at
    limit 64
    for update skip locked
  );

  select * into v_result
  from private.consume_login_rate_limit_bucket(
    p_global_key_hash,
    p_global_limit,
    p_window_seconds,
    v_now
  );
  if not v_result.allowed then
    return query select
      false,
      v_result.retry_after_seconds,
      v_result.remaining,
      'global'::text;
    return;
  end if;

  select * into v_result
  from private.consume_login_rate_limit_bucket(
    p_login_key_hash,
    p_login_limit,
    p_window_seconds,
    v_now
  );
  return query select
    v_result.allowed,
    v_result.retry_after_seconds,
    v_result.remaining,
    case when v_result.allowed then null::text else 'login'::text end;
end;
$$;

revoke all on function private.consume_login_rate_limit_bucket(
  text, integer, integer, timestamptz
) from public;
revoke all on function public.consume_login_rate_limit(
  text, integer, integer
) from service_role;
revoke all on function public.consume_login_rate_limits(
  text, text, integer, integer, integer
) from public, anon, authenticated;
grant execute on function public.consume_login_rate_limits(
  text, text, integer, integer, integer
) to service_role;

create function public.replay_account_command(
  p_actor_profile_id uuid,
  p_command_type text,
  p_idempotency_key text,
  p_request_hash text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_replay jsonb;
begin
  perform private.assert_active_admin(p_actor_profile_id);
  if p_command_type not in (
    'account.create',
    'account.role.change',
    'account.status.change',
    'account.unlock',
    'account.password.reset'
  ) then
    raise exception using errcode = '22023', message = 'UNSUPPORTED_ACCOUNT_COMMAND';
  end if;

  v_replay := private.replay_command(
    p_actor_profile_id,
    p_command_type,
    p_idempotency_key,
    p_request_hash
  );
  if v_replay is null then
    return null;
  end if;
  return (v_replay ->> 'id')::uuid;
end;
$$;

create function public.create_account_profile(
  p_profile_id uuid,
  p_auth_user_id uuid,
  p_actor_profile_id uuid,
  p_display_name text,
  p_display_name_normalized text,
  p_role public.app_role,
  p_phone_last_four text,
  p_phone_lookup_hash text,
  p_idempotency_key text,
  p_request_hash text
)
returns public.profiles
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_replay jsonb;
  v_first_profile public.profiles%rowtype;
  v_next_sequence integer;
  v_login_id text;
  v_login_id_normalized text;
  v_result public.profiles%rowtype;
begin
  perform private.assert_active_admin(p_actor_profile_id);
  v_replay := private.replay_command(
    p_actor_profile_id,
    'account.create',
    p_idempotency_key,
    p_request_hash
  );
  if v_replay is not null then
    select * into strict v_result
    from public.profiles
    where id = (v_replay ->> 'id')::uuid;
    return v_result;
  end if;

  if p_display_name = '' or p_display_name_normalized = '' then
    raise exception using errcode = '22023', message = 'DISPLAY_NAME_REQUIRED';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_display_name_normalized, 0));

  select * into v_first_profile
  from public.profiles p
  where p.display_name_normalized = p_display_name_normalized
    and p.login_sequence = 0
  for update;

  if found then
    update public.profiles
    set
      login_id = p_display_name || '1',
      login_id_normalized = p_display_name_normalized || '1',
      login_sequence = 1
    where id = v_first_profile.id;

    update public.login_aliases
    set expires_after_new_login = true
    where profile_id = v_first_profile.id
      and alias_normalized = p_display_name_normalized
      and active = true;

    insert into public.login_aliases (
      profile_id, alias, alias_normalized, active, expires_after_new_login
    ) values (
      v_first_profile.id,
      p_display_name || '1',
      p_display_name_normalized || '1',
      true,
      false
    );

    v_next_sequence := 2;
  else
    select coalesce(max(p.login_sequence), -1) + 1 into v_next_sequence
    from public.profiles p
    where p.display_name_normalized = p_display_name_normalized;

    if v_next_sequence = 1 then
      v_next_sequence := 2;
    end if;
  end if;

  if v_next_sequence = 0 then
    v_login_id := p_display_name;
    v_login_id_normalized := p_display_name_normalized;
  else
    v_login_id := p_display_name || v_next_sequence::text;
    v_login_id_normalized := p_display_name_normalized || v_next_sequence::text;
  end if;

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
    phone_last_four,
    phone_lookup_hash,
    must_change_password
  ) values (
    p_profile_id,
    p_auth_user_id,
    p_display_name,
    p_display_name_normalized,
    v_login_id,
    v_login_id_normalized,
    v_next_sequence,
    p_role,
    'active',
    p_phone_last_four,
    p_phone_lookup_hash,
    true
  )
  returning * into v_result;

  insert into public.login_aliases (
    profile_id, alias, alias_normalized, active, expires_after_new_login
  ) values (
    v_result.id, v_result.login_id, v_result.login_id_normalized, true, false
  );

  insert into public.audit_events (
    actor_profile_id,
    actor_display_name_snapshot,
    event_type,
    entity_type,
    entity_id,
    effective_at,
    after_state,
    request_hash,
    idempotency_key
  )
  select
    actor.id,
    actor.display_name,
    'account.created',
    'profile',
    v_result.id,
    now(),
    jsonb_build_object(
      'displayName', v_result.display_name,
      'loginId', v_result.login_id,
      'role', v_result.role,
      'status', v_result.status
    ),
    p_request_hash,
    private.audit_command_key(
      p_actor_profile_id,
      'account.create',
      p_idempotency_key
    )
  from public.profiles actor
  where actor.id = p_actor_profile_id;

  perform private.complete_command(
    p_actor_profile_id,
    'account.create',
    p_idempotency_key,
    p_request_hash,
    v_result.id,
    jsonb_build_object('id', v_result.id)
  );

  return v_result;
end;
$$;

create function public.change_account_role(
  p_actor_profile_id uuid,
  p_target_profile_id uuid,
  p_role public.app_role,
  p_idempotency_key text,
  p_request_hash text
)
returns public.profiles
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_replay jsonb;
  v_before public.profiles%rowtype;
  v_result public.profiles%rowtype;
begin
  perform private.assert_active_admin(p_actor_profile_id);
  v_replay := private.replay_command(
    p_actor_profile_id,
    'account.role.change',
    p_idempotency_key,
    p_request_hash
  );
  if v_replay is not null then
    select * into strict v_result
    from public.profiles
    where id = (v_replay ->> 'id')::uuid;
    return v_result;
  end if;

  select * into v_before
  from public.profiles
  where id = p_target_profile_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'ACCOUNT_NOT_FOUND';
  end if;
  if v_before.status = 'departed' then
    raise exception using errcode = '23514', message = 'DEPARTED_ACCOUNT_IMMUTABLE';
  end if;

  perform private.assert_not_last_active_admin(
    p_target_profile_id,
    p_role,
    v_before.status
  );

  update public.profiles
  set role = p_role
  where id = p_target_profile_id
  returning * into v_result;

  if v_before.role <> v_result.role then
    insert into public.audit_events (
      actor_profile_id, actor_display_name_snapshot, event_type, entity_type,
      entity_id, effective_at, before_state, after_state, request_hash,
      idempotency_key
    )
    select
      actor.id, actor.display_name, 'account.role_changed', 'profile', v_result.id,
      now(), jsonb_build_object('role', v_before.role),
      jsonb_build_object('role', v_result.role), p_request_hash,
      private.audit_command_key(
        p_actor_profile_id,
        'account.role.change',
        p_idempotency_key
      )
    from public.profiles actor
    where actor.id = p_actor_profile_id;
  end if;

  perform private.complete_command(
    p_actor_profile_id,
    'account.role.change',
    p_idempotency_key,
    p_request_hash,
    v_result.id,
    jsonb_build_object('id', v_result.id)
  );
  return v_result;
end;
$$;

create function public.change_account_status(
  p_actor_profile_id uuid,
  p_target_profile_id uuid,
  p_status public.account_status,
  p_reason_code text,
  p_idempotency_key text,
  p_request_hash text
)
returns public.profiles
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_replay jsonb;
  v_before public.profiles%rowtype;
  v_result public.profiles%rowtype;
begin
  perform private.assert_active_admin(p_actor_profile_id);
  v_replay := private.replay_command(
    p_actor_profile_id,
    'account.status.change',
    p_idempotency_key,
    p_request_hash
  );
  if v_replay is not null then
    select * into strict v_result
    from public.profiles
    where id = (v_replay ->> 'id')::uuid;
    return v_result;
  end if;

  select * into v_before
  from public.profiles
  where id = p_target_profile_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'ACCOUNT_NOT_FOUND';
  end if;

  if p_status not in ('active', 'inactive', 'departed') then
    raise exception using errcode = '22023', message = 'UNSUPPORTED_ACCOUNT_STATUS';
  end if;
  if v_before.status = 'departed' and p_status <> 'departed' then
    raise exception using errcode = '23514', message = 'DEPARTED_ACCOUNT_IMMUTABLE';
  end if;
  if v_before.status = 'active' and p_status = 'departed' then
    raise exception using errcode = '23514', message = 'ACCOUNT_MUST_BE_INACTIVE_BEFORE_DEPARTURE';
  end if;
  if v_before.status in ('deactivation_pending', 'upload_only')
    and p_status = 'active' then
    raise exception using errcode = '23514', message = 'DEACTIVATION_MUST_BE_FINISHED';
  end if;

  perform private.assert_not_last_active_admin(
    p_target_profile_id,
    v_before.role,
    p_status
  );

  update public.profiles
  set
    status = p_status,
    deactivated_at = case
      when p_status = 'active' then null
      else coalesce(deactivated_at, now())
    end,
    failed_login_count = case
      when p_status = 'active' then 0
      else failed_login_count
    end,
    locked_until = case
      when p_status = 'active' then null
      else locked_until
    end
  where id = p_target_profile_id
  returning * into v_result;

  if p_status <> 'active' then
    delete from auth.sessions where user_id = v_result.auth_user_id;
  end if;

  if v_before.status <> v_result.status then
    insert into public.audit_events (
      actor_profile_id, actor_display_name_snapshot, event_type, entity_type,
      entity_id, effective_at, reason_code, before_state, after_state,
      request_hash, idempotency_key
    )
    select
      actor.id, actor.display_name, 'account.status_changed', 'profile', v_result.id,
      now(), p_reason_code, jsonb_build_object('status', v_before.status),
      jsonb_build_object('status', v_result.status), p_request_hash,
      private.audit_command_key(
        p_actor_profile_id,
        'account.status.change',
        p_idempotency_key
      )
    from public.profiles actor
    where actor.id = p_actor_profile_id;
  end if;

  perform private.complete_command(
    p_actor_profile_id,
    'account.status.change',
    p_idempotency_key,
    p_request_hash,
    v_result.id,
    jsonb_build_object('id', v_result.id)
  );
  return v_result;
end;
$$;

create function public.unlock_account(
  p_actor_profile_id uuid,
  p_target_profile_id uuid,
  p_idempotency_key text,
  p_request_hash text
)
returns public.profiles
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_replay jsonb;
  v_before public.profiles%rowtype;
  v_result public.profiles%rowtype;
begin
  perform private.assert_active_admin(p_actor_profile_id);
  v_replay := private.replay_command(
    p_actor_profile_id,
    'account.unlock',
    p_idempotency_key,
    p_request_hash
  );
  if v_replay is not null then
    select * into strict v_result
    from public.profiles
    where id = (v_replay ->> 'id')::uuid;
    return v_result;
  end if;

  select * into v_before
  from public.profiles
  where id = p_target_profile_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'ACCOUNT_NOT_FOUND';
  end if;

  update public.profiles
  set failed_login_count = 0, locked_until = null
  where id = p_target_profile_id
  returning * into v_result;

  insert into public.audit_events (
    actor_profile_id, actor_display_name_snapshot, event_type, entity_type,
    entity_id, effective_at, before_state, after_state, request_hash,
    idempotency_key
  )
  select
    actor.id, actor.display_name, 'account.unlocked', 'profile', v_result.id,
    now(),
    jsonb_build_object(
      'failedLoginCount', v_before.failed_login_count,
      'wasLocked', v_before.locked_until is not null
    ),
    jsonb_build_object('failedLoginCount', 0, 'locked', false),
    p_request_hash,
    private.audit_command_key(
      p_actor_profile_id,
      'account.unlock',
      p_idempotency_key
    )
  from public.profiles actor
  where actor.id = p_actor_profile_id;

  perform private.complete_command(
    p_actor_profile_id,
    'account.unlock',
    p_idempotency_key,
    p_request_hash,
    v_result.id,
    jsonb_build_object('id', v_result.id)
  );
  return v_result;
end;
$$;

create function public.prepare_account_password_reset(
  p_actor_profile_id uuid,
  p_target_profile_id uuid,
  p_idempotency_key text,
  p_request_hash text
)
returns public.profiles
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_replay jsonb;
  v_result public.profiles%rowtype;
begin
  perform private.assert_active_admin(p_actor_profile_id);
  v_replay := private.replay_command(
    p_actor_profile_id,
    'account.password.reset',
    p_idempotency_key,
    p_request_hash
  );
  if v_replay is not null then
    select * into strict v_result
    from public.profiles
    where id = (v_replay ->> 'id')::uuid;
    return v_result;
  end if;

  update public.profiles
  set must_change_password = true, failed_login_count = 0, locked_until = null
  where id = p_target_profile_id
    and status <> 'departed'
  returning * into v_result;

  if not found then
    raise exception using errcode = 'P0002', message = 'ACCOUNT_NOT_FOUND_OR_DEPARTED';
  end if;

  delete from auth.sessions where user_id = v_result.auth_user_id;

  insert into public.audit_events (
    actor_profile_id, actor_display_name_snapshot, event_type, entity_type,
    entity_id, effective_at, after_state, request_hash, idempotency_key
  )
  select
    actor.id, actor.display_name, 'account.password_reset_requested', 'profile',
    v_result.id, now(),
    jsonb_build_object('mustChangePassword', true, 'lockCleared', true),
    p_request_hash,
    private.audit_command_key(
      p_actor_profile_id,
      'account.password.reset',
      p_idempotency_key
    )
  from public.profiles actor
  where actor.id = p_actor_profile_id;

  perform private.complete_command(
    p_actor_profile_id,
    'account.password.reset',
    p_idempotency_key,
    p_request_hash,
    v_result.id,
    jsonb_build_object('id', v_result.id)
  );
  return v_result;
end;
$$;

revoke all on function public.replay_account_command(
  uuid, text, text, text
) from public, anon, authenticated;
revoke all on function public.create_account_profile(
  uuid, uuid, uuid, text, text, public.app_role, text, text, text
) from service_role;
revoke all on function public.change_account_role(
  uuid, uuid, public.app_role, text
) from service_role;
revoke all on function public.change_account_status(
  uuid, uuid, public.account_status, text, text
) from service_role;
revoke all on function public.unlock_account(uuid, uuid, text) from service_role;
revoke all on function public.prepare_account_password_reset(
  uuid, uuid, text
) from service_role;

revoke all on function public.create_account_profile(
  uuid, uuid, uuid, text, text, public.app_role, text, text, text, text
) from public, anon, authenticated;
revoke all on function public.change_account_role(
  uuid, uuid, public.app_role, text, text
) from public, anon, authenticated;
revoke all on function public.change_account_status(
  uuid, uuid, public.account_status, text, text, text
) from public, anon, authenticated;
revoke all on function public.unlock_account(
  uuid, uuid, text, text
) from public, anon, authenticated;
revoke all on function public.prepare_account_password_reset(
  uuid, uuid, text, text
) from public, anon, authenticated;

grant execute on function public.replay_account_command(
  uuid, text, text, text
) to service_role;
grant execute on function public.create_account_profile(
  uuid, uuid, uuid, text, text, public.app_role, text, text, text, text
) to service_role;
grant execute on function public.change_account_role(
  uuid, uuid, public.app_role, text, text
) to service_role;
grant execute on function public.change_account_status(
  uuid, uuid, public.account_status, text, text, text
) to service_role;
grant execute on function public.unlock_account(
  uuid, uuid, text, text
) to service_role;
grant execute on function public.prepare_account_password_reset(
  uuid, uuid, text, text
) to service_role;
