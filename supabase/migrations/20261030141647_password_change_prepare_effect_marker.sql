-- #535: Preserve the existing receipt/claim/permission contract; return its persisted effect identity.
-- No data repair, password mutation, or account gate changes are performed by this migration.
create or replace function public.prepare_password_change(
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
    return jsonb_build_object('state', 'recover', 'attemptCount', v_command.attempt_count, 'effectMarker', v_command.effect_marker);
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

  return jsonb_build_object('state', 'execute', 'attemptCount', 1, 'effectMarker', v_command.effect_marker);
end;
$$;
