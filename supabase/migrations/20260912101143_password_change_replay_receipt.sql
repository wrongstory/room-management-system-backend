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
  session_digest text not null check (session_digest ~ '^[0-9a-f]{64}$'),
  state text not null check (state in ('auth_pending', 'completed', 'failed', 'inconsistent')),
  claim_digest text check (claim_digest is null or claim_digest ~ '^[0-9a-f]{64}$'),
  lease_expires_at timestamptz,
  attempt_count integer not null default 1 check (attempt_count between 1 and 32),
  failure_code text check (
    failure_code is null or failure_code in ('AUTH_PASSWORD_CHANGE_FAILED', 'PASSWORD_STATE_INCONSISTENT')
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (actor_profile_id, command_type, idempotency_key),
  unique (id, actor_profile_id),
  check (
    (state in ('auth_pending', 'inconsistent') and claim_digest is not null and lease_expires_at is not null)
    or (state in ('completed', 'failed') and claim_digest is null and lease_expires_at is null)
  ),
  check ((state = 'completed') = (completed_at is not null))
);

create unique index password_change_commands_actor_unresolved_uq
on private.password_change_commands (actor_profile_id)
where state in ('auth_pending', 'inconsistent');

create index password_change_commands_actor_created_idx
on private.password_change_commands (actor_profile_id, created_at desc, id desc);

alter table private.password_change_commands enable row level security;

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
      else v_command.state
    end,
    'attemptCount', v_command.attempt_count
  )
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
      and c.state in ('auth_pending', 'inconsistent')
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
  p_claim_digest text
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
    if v_command.state in ('completed', 'failed') then
      return private.password_change_state(v_command);
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
      and c.state in ('auth_pending', 'inconsistent')
  ) then
    return jsonb_build_object('state', 'other_in_progress');
  end if;

  insert into private.password_change_commands (
    actor_profile_id, auth_user_id, idempotency_key, request_hash, session_digest, state,
    claim_digest, lease_expires_at, created_at, updated_at
  ) values (
    p_actor_profile_id, p_auth_user_id, p_idempotency_key, p_request_hash,
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
    or new.session_digest <> old.session_digest
    or new.created_at <> old.created_at
    or old.state in ('completed', 'failed')
    or (old.state = 'inconsistent' and new.state not in ('inconsistent', 'completed'))
    or (old.state = 'auth_pending' and new.state not in ('auth_pending', 'completed', 'failed', 'inconsistent')) then
    raise exception using errcode = '55000', message = 'PASSWORD_CHANGE_RECEIPT_IMMUTABLE';
  end if;
  return new;
end;
$$;

create trigger password_change_commands_guard
before update or delete on private.password_change_commands
for each row execute function private.guard_password_change_commands();

revoke all on table private.password_change_commands from public, anon, authenticated, service_role;
revoke all on function private.assert_password_change_actor(uuid, uuid, uuid) from public;
revoke all on function private.password_change_audit_key(uuid, text) from public;
revoke all on function private.password_change_session_digest(uuid) from public;
revoke all on function private.password_change_state(private.password_change_commands) from public;
revoke all on function private.guard_password_change_commands() from public;
revoke all on function public.inspect_password_change(uuid, uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.prepare_password_change(uuid, uuid, uuid, text, text, text)
  from public, anon, authenticated;
revoke all on function public.finish_password_change_failure(uuid, uuid, uuid, text, text, text)
  from public, anon, authenticated;
revoke all on function public.complete_password_change(uuid, uuid, uuid, text, text, text)
  from public, anon, authenticated;

grant execute on function public.inspect_password_change(uuid, uuid, uuid, text) to service_role;
grant execute on function public.prepare_password_change(uuid, uuid, uuid, text, text, text) to service_role;
grant execute on function public.finish_password_change_failure(uuid, uuid, uuid, text, text, text) to service_role;
grant execute on function public.complete_password_change(uuid, uuid, uuid, text, text, text) to service_role;
