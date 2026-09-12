-- Issue #46: make self-service password changes recoverable after an HTTP
-- response loss without persisting password-derived evidence.  The dedicated
-- receipt is private and serializes external Auth mutation per actor.

create table private.password_change_commands (
  id uuid primary key default gen_random_uuid(),
  actor_profile_id uuid not null references public.profiles(id) on delete restrict,
  auth_user_id uuid not null,
  command_type text not null default 'account.password.change'
    check (command_type = 'account.password.change'),
  idempotency_key text not null
    check (idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  effect_marker text not null check (effect_marker ~ '^[0-9a-f]{64}$'),
  session_digest text not null check (session_digest ~ '^[0-9a-f]{64}$'),
  state text not null check (
    state in ('auth_pending', 'completed', 'failed', 'inconsistent', 'reset_pending', 'superseded')
  ),
  claim_digest text check (claim_digest is null or claim_digest ~ '^[0-9a-f]{64}$'),
  lease_expires_at timestamptz,
  attempt_count integer not null default 1 check (attempt_count between 1 and 32),
  failure_code text check (
    failure_code is null or failure_code in ('AUTH_PASSWORD_CHANGE_FAILED', 'PASSWORD_STATE_INCONSISTENT')
  ),
  reset_command_execution_id uuid references private.command_executions(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (actor_profile_id, command_type, idempotency_key),
  unique (id, actor_profile_id),
  check (
    (state in ('auth_pending', 'inconsistent') and claim_digest is not null and lease_expires_at is not null
      and reset_command_execution_id is null)
    or (state in ('completed', 'failed') and claim_digest is null and lease_expires_at is null
      and reset_command_execution_id is null)
    or (state in ('reset_pending', 'superseded') and claim_digest is null and lease_expires_at is null
      and reset_command_execution_id is not null)
  ),
  check ((state in ('completed', 'superseded')) = (completed_at is not null))
);

create unique index password_change_commands_actor_unresolved_uq
on private.password_change_commands (actor_profile_id)
where state in ('auth_pending', 'inconsistent', 'reset_pending');

create index password_change_commands_actor_created_idx
on private.password_change_commands (actor_profile_id, created_at desc, id desc);

alter table private.password_change_commands enable row level security;

-- Password verification uses one authoritative row per actor. Session and
-- client identity are server-side digest evidence only, never row dimensions,
-- so rotating either cannot bypass the limit or create unbounded rows. A
-- saturated window stops writing until its fixed window expires.
create table private.password_verification_rate_limits (
  actor_profile_id uuid primary key references public.profiles(id) on delete restrict,
  session_digest text not null check (session_digest ~ '^[0-9a-f]{64}$'),
  client_digest text not null check (client_digest ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz not null,
  attempt_count integer not null check (attempt_count between 1 and 32767),
  expires_at timestamptz not null
);

alter table private.password_verification_rate_limits enable row level security;

create table private.password_reset_auth_markers (
  command_execution_id uuid primary key references private.command_executions(id) on delete restrict,
  actor_profile_id uuid not null references public.profiles(id) on delete restrict,
  target_profile_id uuid not null references public.profiles(id) on delete restrict,
  effect_marker text not null check (effect_marker ~ '^[0-9a-f]{64}$'),
  state text not null check (state in ('prepared', 'completed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (actor_profile_id, target_profile_id, command_execution_id),
  check ((state = 'completed') = (completed_at is not null))
);

alter table private.password_reset_auth_markers enable row level security;

create unique index password_reset_auth_markers_target_prepared_uq
on private.password_reset_auth_markers (target_profile_id)
where state = 'prepared';

create function private.assert_password_change_actor(
  p_actor_profile_id uuid,
  p_auth_user_id uuid,
  p_session_id uuid
)
returns public.profiles
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.profiles%rowtype;
begin
  select * into v_actor
  from public.profiles p
  where p.id = p_actor_profile_id
    and p.auth_user_id = p_auth_user_id
    and p.status = 'active'
  for update;

  if not found then
    raise exception using errcode = '42501', message = 'ACTIVE_ACCOUNT_REQUIRED';
  end if;

  if not exists (
    select 1 from auth.sessions s
    where s.id = p_session_id and s.user_id = p_auth_user_id
  ) then
    raise exception using errcode = '42501', message = 'SESSION_REVOKED';
  end if;

  return v_actor;
end;
$$;

create function private.password_change_audit_key(
  p_actor_profile_id uuid,
  p_idempotency_key text
)
returns text
language sql
immutable
set search_path = pg_catalog, extensions
as $$
  select 'password-change:' || encode(
    extensions.digest(
      convert_to(
        jsonb_build_array(
          p_actor_profile_id::text,
          'account.password.change',
          p_idempotency_key
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
$$;

create function private.password_change_session_digest(p_session_id uuid)
returns text
language sql
immutable
set search_path = pg_catalog, extensions
as $$
  select encode(
    extensions.digest(
      convert_to(jsonb_build_array('password-change-session:v1', p_session_id::text)::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  )
$$;

create function private.password_change_state(v_command private.password_change_commands)
returns jsonb
language sql
stable
set search_path = pg_catalog
as $$
  select jsonb_build_object(
    'state', case
      when v_command.state = 'auth_pending' and v_command.lease_expires_at > clock_timestamp() then 'busy'
      when v_command.state = 'auth_pending' then 'recover'
      when v_command.state = 'reset_pending' then 'other_in_progress'
      when v_command.state = 'superseded' then 'failed'
      else v_command.state
    end,
    'attemptCount', v_command.attempt_count,
    'effectMarker', v_command.effect_marker
  )
$$;

create function public.consume_password_verification_rate_limit(
  p_actor_profile_id uuid,
  p_auth_user_id uuid,
  p_session_id uuid,
  p_client_digest text,
  p_limit integer default 10,
  p_window_seconds integer default 60
)
returns table (
  allowed boolean,
  retry_after_seconds integer,
  remaining integer
)
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_session_digest text;
  v_row private.password_verification_rate_limits%rowtype;
begin
  if p_client_digest is null or p_client_digest !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'INVALID_PASSWORD_VERIFICATION_CLIENT';
  end if;
  if p_limit < 1 or p_limit > 100 or p_window_seconds < 1 or p_window_seconds > 3600 then
    raise exception using errcode = '22023', message = 'INVALID_RATE_LIMIT_CONFIGURATION';
  end if;

  perform private.assert_password_change_actor(p_actor_profile_id, p_auth_user_id, p_session_id);
  v_session_digest := private.password_change_session_digest(p_session_id);

  delete from private.password_verification_rate_limits limits
  where limits.ctid in (
    select candidates.ctid
    from private.password_verification_rate_limits candidates
    where candidates.expires_at < v_now - interval '10 minutes'
    order by candidates.expires_at
    limit 64
    for update skip locked
  );

  insert into private.password_verification_rate_limits (
    actor_profile_id, session_digest, client_digest,
    window_started_at, attempt_count, expires_at
  ) values (
    p_actor_profile_id, v_session_digest, p_client_digest,
    v_now, 1, v_now + make_interval(secs => p_window_seconds)
  )
  on conflict (actor_profile_id) do update
  set session_digest = excluded.session_digest,
      client_digest = excluded.client_digest,
      window_started_at = case
        when private.password_verification_rate_limits.expires_at <= v_now then v_now
        else private.password_verification_rate_limits.window_started_at
      end,
      attempt_count = case
        when private.password_verification_rate_limits.expires_at <= v_now then 1
        else private.password_verification_rate_limits.attempt_count + 1
      end,
      expires_at = case
        when private.password_verification_rate_limits.expires_at <= v_now
          then v_now + make_interval(secs => p_window_seconds)
        else private.password_verification_rate_limits.expires_at
      end
  where private.password_verification_rate_limits.expires_at <= v_now
    or private.password_verification_rate_limits.attempt_count < p_limit + 1
  returning * into v_row;

  if not found then
    select * into strict v_row
    from private.password_verification_rate_limits limits
    where limits.actor_profile_id = p_actor_profile_id;
  end if;

  return query select
    v_row.attempt_count <= p_limit,
    case when v_row.attempt_count <= p_limit then 0
      else greatest(1, ceil(extract(epoch from (v_row.expires_at - v_now)))::integer)
    end,
    greatest(0, p_limit - v_row.attempt_count);
end;
$$;

-- Reset preparation uses the same target lock order as self-change.  It moves
-- an expired/ambiguous self-change receipt to reset_pending in the same DB
-- transaction, but does not resolve it until the external Auth reset succeeds.
create or replace function public.prepare_account_password_reset(
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
  v_password_command private.password_change_commands%rowtype;
begin
  -- Global reset serialization precedes the target password-change lock, and
  -- that advisory lock always precedes profile row locks.
  perform pg_advisory_xact_lock(hashtextextended('password-reset-recovery:global', 0));
  perform pg_advisory_xact_lock(hashtextextended('password-change:' || p_target_profile_id::text, 0));
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

  select * into v_password_command
  from private.password_change_commands command
  where command.actor_profile_id = p_target_profile_id
    and command.state in ('auth_pending', 'inconsistent', 'reset_pending')
  for update;

  if found then
    if v_password_command.state = 'reset_pending' then
      raise exception using errcode = '40001', message = 'PASSWORD_RESET_IN_PROGRESS';
    end if;
    if v_password_command.state = 'auth_pending'
      and v_password_command.lease_expires_at > clock_timestamp() then
      raise exception using errcode = '40001', message = 'PASSWORD_CHANGE_IN_PROGRESS';
    end if;
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

create function public.inspect_password_change(
  p_actor_profile_id uuid,
  p_auth_user_id uuid,
  p_session_id uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_command private.password_change_commands%rowtype;
begin
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,128}$' then
    raise exception using errcode = '22023', message = 'INVALID_IDEMPOTENCY_KEY';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('password-change:' || p_actor_profile_id::text, 0));
  perform private.assert_password_change_actor(p_actor_profile_id, p_auth_user_id, p_session_id);

  select * into v_command
  from private.password_change_commands c
  where c.actor_profile_id = p_actor_profile_id
    and c.command_type = 'account.password.change'
    and c.idempotency_key = p_idempotency_key
  for update;

  if found then
    if v_command.session_digest <> private.password_change_session_digest(p_session_id) then
      raise exception using errcode = '42501', message = 'PASSWORD_CHANGE_SESSION_MISMATCH';
    end if;
    return private.password_change_state(v_command);
  end if;

  if exists (
    select 1 from private.password_change_commands c
    where c.actor_profile_id = p_actor_profile_id
      and c.state in ('auth_pending', 'inconsistent', 'reset_pending')
  ) then
    return jsonb_build_object('state', 'other_in_progress');
  end if;

  return jsonb_build_object('state', 'absent');
end;
$$;

create function public.prepare_password_change(
  p_actor_profile_id uuid,
  p_auth_user_id uuid,
  p_session_id uuid,
  p_idempotency_key text,
  p_request_hash text,
  p_claim_digest text,
  p_effect_marker text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_command private.password_change_commands%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,128}$' then
    raise exception using errcode = '22023', message = 'INVALID_IDEMPOTENCY_KEY';
  end if;
  if p_request_hash is null or p_request_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'INVALID_REQUEST_HASH';
  end if;
  if p_claim_digest is null or p_claim_digest !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'INVALID_PASSWORD_CHANGE_CLAIM';
  end if;
  if p_effect_marker is null or p_effect_marker !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'INVALID_PASSWORD_CHANGE_EFFECT_MARKER';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('password-change:' || p_actor_profile_id::text, 0));
  perform private.assert_password_change_actor(p_actor_profile_id, p_auth_user_id, p_session_id);

  select * into v_command
  from private.password_change_commands c
  where c.actor_profile_id = p_actor_profile_id
    and c.command_type = 'account.password.change'
    and c.idempotency_key = p_idempotency_key
  for update;

  if found then
    if v_command.session_digest <> private.password_change_session_digest(p_session_id) then
      raise exception using errcode = '42501', message = 'PASSWORD_CHANGE_SESSION_MISMATCH';
    end if;
    if v_command.request_hash <> p_request_hash or v_command.auth_user_id <> p_auth_user_id then
      raise exception using errcode = '23505', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    if v_command.state in ('completed', 'failed', 'superseded') then
      return private.password_change_state(v_command);
    end if;
    if v_command.state = 'reset_pending' then
      return jsonb_build_object('state', 'other_in_progress', 'attemptCount', v_command.attempt_count);
    end if;
    if v_command.state = 'auth_pending' and v_command.lease_expires_at > v_now then
      return jsonb_build_object('state', 'busy', 'attemptCount', v_command.attempt_count);
    end if;

    update private.password_change_commands
    set claim_digest = p_claim_digest,
        lease_expires_at = v_now + interval '60 seconds',
        attempt_count = least(attempt_count + 1, 32),
        updated_at = v_now
    where id = v_command.id
    returning * into v_command;
    return jsonb_build_object('state', 'recover', 'attemptCount', v_command.attempt_count);
  end if;

  if exists (
    select 1 from private.password_change_commands c
    where c.actor_profile_id = p_actor_profile_id
      and c.state in ('auth_pending', 'inconsistent', 'reset_pending')
  ) then
    return jsonb_build_object('state', 'other_in_progress');
  end if;

  insert into private.password_change_commands (
    actor_profile_id, auth_user_id, idempotency_key, request_hash, effect_marker, session_digest, state,
    claim_digest, lease_expires_at, created_at, updated_at
  ) values (
    p_actor_profile_id, p_auth_user_id, p_idempotency_key, p_request_hash,
    p_effect_marker,
    private.password_change_session_digest(p_session_id),
    'auth_pending', p_claim_digest, v_now + interval '60 seconds', v_now, v_now
  ) returning * into v_command;

  return jsonb_build_object('state', 'execute', 'attemptCount', 1);
end;
$$;

create function public.finish_password_change_failure(
  p_actor_profile_id uuid,
  p_auth_user_id uuid,
  p_session_id uuid,
  p_idempotency_key text,
  p_claim_digest text,
  p_failure_code text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_command private.password_change_commands%rowtype;
  v_state text;
begin
  if p_failure_code not in ('AUTH_PASSWORD_CHANGE_FAILED', 'PASSWORD_STATE_INCONSISTENT') then
    raise exception using errcode = '22023', message = 'INVALID_PASSWORD_CHANGE_FAILURE';
  end if;
  v_state := case when p_failure_code = 'AUTH_PASSWORD_CHANGE_FAILED' then 'failed' else 'inconsistent' end;

  perform pg_advisory_xact_lock(hashtextextended('password-change:' || p_actor_profile_id::text, 0));
  perform private.assert_password_change_actor(p_actor_profile_id, p_auth_user_id, p_session_id);
  select * into v_command
  from private.password_change_commands c
  where c.actor_profile_id = p_actor_profile_id
    and c.command_type = 'account.password.change'
    and c.idempotency_key = p_idempotency_key
  for update;

  if not found then
    raise exception using errcode = '40001', message = 'PASSWORD_CHANGE_CLAIM_STALE';
  end if;
  if v_command.session_digest <> private.password_change_session_digest(p_session_id) then
    raise exception using errcode = '42501', message = 'PASSWORD_CHANGE_SESSION_MISMATCH';
  end if;
  if v_command.claim_digest is distinct from p_claim_digest
    or v_command.state not in ('auth_pending', 'inconsistent') then
    raise exception using errcode = '40001', message = 'PASSWORD_CHANGE_CLAIM_STALE';
  end if;

  update private.password_change_commands
  set state = v_state,
      claim_digest = case when v_state = 'failed' then null else claim_digest end,
      lease_expires_at = case when v_state = 'failed' then null else clock_timestamp() end,
      failure_code = p_failure_code,
      updated_at = clock_timestamp()
  where id = v_command.id;
end;
$$;

create function private.password_reset_command_execution(
  p_actor_profile_id uuid,
  p_target_profile_id uuid,
  p_idempotency_key text,
  p_request_hash text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_execution_id uuid;
begin
  perform private.assert_active_admin(p_actor_profile_id);

  select execution.id into v_execution_id
  from private.command_executions execution
  where execution.actor_profile_id = p_actor_profile_id
    and execution.command_type = 'account.password.reset'
    and execution.idempotency_key = p_idempotency_key
    and execution.request_hash = p_request_hash
    and execution.entity_id = p_target_profile_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'PASSWORD_RESET_RECEIPT_NOT_FOUND';
  end if;
  return v_execution_id;
end;
$$;

create function public.prepare_password_change_admin_reset(
  p_actor_profile_id uuid,
  p_target_profile_id uuid,
  p_idempotency_key text,
  p_request_hash text,
  p_effect_marker text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_execution_id uuid;
  v_reset_marker private.password_reset_auth_markers%rowtype;
  v_command private.password_change_commands%rowtype;
begin
  if p_effect_marker is null or p_effect_marker !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'INVALID_PASSWORD_RESET_EFFECT_MARKER';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('password-reset-recovery:global', 0));
  perform pg_advisory_xact_lock(hashtextextended('password-change:' || p_target_profile_id::text, 0));
  v_execution_id := private.password_reset_command_execution(
    p_actor_profile_id, p_target_profile_id, p_idempotency_key, p_request_hash
  );

  select * into v_reset_marker
  from private.password_reset_auth_markers marker
  where marker.command_execution_id = v_execution_id
  for update;

  if not found then
    if exists (
      select 1
      from private.password_reset_auth_markers marker
      where marker.target_profile_id = p_target_profile_id
        and marker.state = 'prepared'
        and marker.command_execution_id <> v_execution_id
    ) then
      raise exception using errcode = '40001', message = 'PASSWORD_RESET_IN_PROGRESS';
    end if;
    insert into private.password_reset_auth_markers (
      command_execution_id, actor_profile_id, target_profile_id, effect_marker, state
    ) values (
      v_execution_id, p_actor_profile_id, p_target_profile_id, p_effect_marker, 'prepared'
    ) returning * into v_reset_marker;
  end if;

  select * into v_command
  from private.password_change_commands command
  where command.actor_profile_id = p_target_profile_id
    and command.state in ('auth_pending', 'inconsistent', 'reset_pending')
  for update;

  if found then
    if v_command.state = 'reset_pending' then
      if v_command.reset_command_execution_id <> v_execution_id then
        raise exception using errcode = '40001', message = 'PASSWORD_RESET_IN_PROGRESS';
      end if;
    elsif v_command.state = 'auth_pending' and v_command.lease_expires_at > clock_timestamp() then
      raise exception using errcode = '40001', message = 'PASSWORD_CHANGE_IN_PROGRESS';
    else
      update private.password_change_commands
      set state = 'reset_pending', claim_digest = null, lease_expires_at = null,
          reset_command_execution_id = v_execution_id, updated_at = clock_timestamp()
      where id = v_command.id;
    end if;
  end if;

  return jsonb_build_object(
    'state', case when v_reset_marker.state = 'completed' then 'completed' else 'prepared' end,
    'effectMarker', v_reset_marker.effect_marker
  );
end;
$$;

-- Called only after updateUserById has returned success.  The command receipt
-- proves which reset is being finalized; no password-derived evidence is
-- persisted.  Replaying the same reset is idempotent.
create function public.finalize_password_change_admin_reset(
  p_actor_profile_id uuid,
  p_target_profile_id uuid,
  p_idempotency_key text,
  p_request_hash text,
  p_effect_marker text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_execution_id uuid;
  v_command private.password_change_commands%rowtype;
  v_reset_marker private.password_reset_auth_markers%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  perform pg_advisory_xact_lock(hashtextextended('password-reset-recovery:global', 0));
  perform pg_advisory_xact_lock(hashtextextended('password-change:' || p_target_profile_id::text, 0));
  v_execution_id := private.password_reset_command_execution(
    p_actor_profile_id, p_target_profile_id, p_idempotency_key, p_request_hash
  );

  select * into strict v_reset_marker
  from private.password_reset_auth_markers marker
  where marker.command_execution_id = v_execution_id
  for update;

  if v_reset_marker.effect_marker <> p_effect_marker then
    raise exception using errcode = '23505', message = 'PASSWORD_RESET_EFFECT_MARKER_MISMATCH';
  end if;

  select * into v_command
  from private.password_change_commands command
  where command.actor_profile_id = p_target_profile_id
    and command.reset_command_execution_id = v_execution_id
  for update;

  if not found then
    update private.password_reset_auth_markers
    set state = 'completed', updated_at = v_now, completed_at = v_now
    where command_execution_id = v_execution_id and state = 'prepared';
    return jsonb_build_object('completed', true, 'receiptSuperseded', false);
  end if;
  if v_command.state = 'superseded' then
    return jsonb_build_object('completed', true, 'receiptSuperseded', true);
  end if;
  if v_command.state <> 'reset_pending' then
    raise exception using errcode = '40001', message = 'PASSWORD_RESET_CLAIM_STALE';
  end if;

  update private.password_change_commands
  set state = 'superseded', updated_at = v_now, completed_at = v_now
  where id = v_command.id;

  update private.password_reset_auth_markers
  set state = 'completed', updated_at = v_now, completed_at = v_now
  where command_execution_id = v_execution_id and state = 'prepared';

  return jsonb_build_object('completed', true, 'receiptSuperseded', true);
end;
$$;

create function private.guard_password_reset_auth_markers()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'PASSWORD_RESET_MARKER_DELETE_FORBIDDEN';
  end if;
  if new.command_execution_id <> old.command_execution_id
    or new.actor_profile_id <> old.actor_profile_id
    or new.target_profile_id <> old.target_profile_id
    or new.effect_marker <> old.effect_marker
    or new.created_at <> old.created_at
    or old.state = 'completed'
    or (old.state = 'prepared' and new.state not in ('prepared', 'completed')) then
    raise exception using errcode = '55000', message = 'PASSWORD_RESET_MARKER_IMMUTABLE';
  end if;
  return new;
end;
$$;

create trigger password_reset_auth_markers_guard
before update or delete on private.password_reset_auth_markers
for each row execute function private.guard_password_reset_auth_markers();

drop function public.complete_password_change(uuid, text);

create function public.complete_password_change(
  p_actor_profile_id uuid,
  p_auth_user_id uuid,
  p_session_id uuid,
  p_idempotency_key text,
  p_request_hash text,
  p_claim_digest text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions
as $$
declare
  v_actor public.profiles%rowtype;
  v_command private.password_change_commands%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  perform pg_advisory_xact_lock(hashtextextended('password-change:' || p_actor_profile_id::text, 0));
  v_actor := private.assert_password_change_actor(p_actor_profile_id, p_auth_user_id, p_session_id);

  select * into v_command
  from private.password_change_commands c
  where c.actor_profile_id = p_actor_profile_id
    and c.command_type = 'account.password.change'
    and c.idempotency_key = p_idempotency_key
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'PASSWORD_CHANGE_RECEIPT_NOT_FOUND';
  end if;
  if v_command.session_digest <> private.password_change_session_digest(p_session_id) then
    raise exception using errcode = '42501', message = 'PASSWORD_CHANGE_SESSION_MISMATCH';
  end if;
  if v_command.request_hash <> p_request_hash or v_command.auth_user_id <> p_auth_user_id then
    raise exception using errcode = '23505', message = 'IDEMPOTENCY_KEY_REUSED';
  end if;
  if v_command.state = 'completed' then
    return jsonb_build_object('completed', true);
  end if;
  if v_command.claim_digest is distinct from p_claim_digest
    or v_command.state not in ('auth_pending', 'inconsistent') then
    raise exception using errcode = '40001', message = 'PASSWORD_CHANGE_CLAIM_STALE';
  end if;

  update public.profiles
  set must_change_password = false,
      failed_login_count = 0,
      locked_until = null
  where id = p_actor_profile_id;

  -- Keep the caller's current session and revoke every other session in the
  -- same transaction as the profile/audit/receipt completion.  The session ID
  -- is an RPC argument only and is never persisted in the receipt or audit.
  delete from auth.sessions
  where user_id = p_auth_user_id and id <> p_session_id;

  insert into public.audit_events (
    actor_profile_id, actor_display_name_snapshot, event_type, entity_type,
    entity_id, effective_at, after_state, request_hash, idempotency_key
  ) values (
    v_actor.id, v_actor.display_name, 'account.password_changed', 'profile',
    v_actor.id, v_now, jsonb_build_object('mustChangePassword', false),
    p_request_hash, private.password_change_audit_key(v_actor.id, p_idempotency_key)
  );

  update private.password_change_commands
  set state = 'completed', claim_digest = null, lease_expires_at = null,
      failure_code = null, updated_at = v_now, completed_at = v_now
  where id = v_command.id;

  return jsonb_build_object('completed', true);
end;
$$;

create function private.guard_password_change_commands()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'PASSWORD_CHANGE_RECEIPT_DELETE_FORBIDDEN';
  end if;
  if new.id <> old.id
    or new.actor_profile_id <> old.actor_profile_id
    or new.auth_user_id <> old.auth_user_id
    or new.command_type <> old.command_type
    or new.idempotency_key <> old.idempotency_key
    or new.request_hash <> old.request_hash
    or new.effect_marker <> old.effect_marker
    or new.session_digest <> old.session_digest
    or new.created_at <> old.created_at
    or (old.state in ('reset_pending', 'superseded')
      and new.reset_command_execution_id is distinct from old.reset_command_execution_id)
    or old.state in ('completed', 'failed', 'superseded')
    or (old.state = 'reset_pending' and new.state not in ('reset_pending', 'superseded'))
    or (old.state = 'inconsistent' and new.state not in ('inconsistent', 'completed', 'reset_pending'))
    or (old.state = 'auth_pending'
      and new.state not in ('auth_pending', 'completed', 'failed', 'inconsistent', 'reset_pending')) then
    raise exception using errcode = '55000', message = 'PASSWORD_CHANGE_RECEIPT_IMMUTABLE';
  end if;
  return new;
end;
$$;

create trigger password_change_commands_guard
before update or delete on private.password_change_commands
for each row execute function private.guard_password_change_commands();

revoke all on table private.password_change_commands from public, anon, authenticated, service_role;
revoke all on table private.password_verification_rate_limits from public, anon, authenticated, service_role;
revoke all on table private.password_reset_auth_markers from public, anon, authenticated, service_role;
revoke all on function private.assert_password_change_actor(uuid, uuid, uuid) from public;
revoke all on function private.password_change_audit_key(uuid, text) from public;
revoke all on function private.password_change_session_digest(uuid) from public;
revoke all on function private.password_change_state(private.password_change_commands) from public;
revoke all on function private.password_reset_command_execution(uuid, uuid, text, text) from public;
revoke all on function private.guard_password_reset_auth_markers() from public;
revoke all on function private.guard_password_change_commands() from public;
revoke all on function public.inspect_password_change(uuid, uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.prepare_password_change(uuid, uuid, uuid, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.finish_password_change_failure(uuid, uuid, uuid, text, text, text)
  from public, anon, authenticated;
revoke all on function public.complete_password_change(uuid, uuid, uuid, text, text, text)
  from public, anon, authenticated;
revoke all on function public.consume_password_verification_rate_limit(
  uuid, uuid, uuid, text, integer, integer
) from public, anon, authenticated;
revoke all on function public.prepare_password_change_admin_reset(uuid, uuid, text, text, text)
  from public, anon, authenticated;
revoke all on function public.finalize_password_change_admin_reset(uuid, uuid, text, text, text)
  from public, anon, authenticated;

grant execute on function public.inspect_password_change(uuid, uuid, uuid, text) to service_role;
grant execute on function public.prepare_password_change(uuid, uuid, uuid, text, text, text, text) to service_role;
grant execute on function public.finish_password_change_failure(uuid, uuid, uuid, text, text, text) to service_role;
grant execute on function public.complete_password_change(uuid, uuid, uuid, text, text, text) to service_role;
grant execute on function public.consume_password_verification_rate_limit(
  uuid, uuid, uuid, text, integer, integer
) to service_role;
grant execute on function public.prepare_password_change_admin_reset(uuid, uuid, text, text, text) to service_role;
grant execute on function public.finalize_password_change_admin_reset(uuid, uuid, text, text, text) to service_role;
