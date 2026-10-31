-- #543: settle the exact current Auth effect after the original session disappears.
create or replace function public.complete_password_change(
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
  v_live_session boolean;
  v_effect_version text;
begin
  perform pg_advisory_xact_lock(hashtextextended('password-change:' || p_actor_profile_id::text, 0));
  -- Completion settles an already authorized effect, never authorizes a new password write.
  select * into v_actor from public.profiles
  where id=p_actor_profile_id and auth_user_id=p_auth_user_id and status='active'
  for update;
  if not found then
    raise exception using errcode='42501', message='ACTIVE_ACCOUNT_REQUIRED';
  end if;
  select exists(select 1 from auth.sessions where id=p_session_id and user_id=p_auth_user_id)
    into v_live_session;

  select * into v_command
  from private.password_change_commands c
  where c.actor_profile_id = p_actor_profile_id
    and c.command_type = 'account.password.change'
    and c.idempotency_key = p_idempotency_key
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'PASSWORD_CHANGE_RECEIPT_NOT_FOUND';
  end if;
  if p_session_id is null or v_command.session_digest <> private.password_change_session_digest(p_session_id) then
    raise exception using errcode = '42501', message = 'PASSWORD_CHANGE_SESSION_MISMATCH';
  end if;
  if v_command.request_hash is distinct from p_request_hash or v_command.auth_user_id is distinct from p_auth_user_id then
    raise exception using errcode = '23505', message = 'IDEMPOTENCY_KEY_REUSED';
  end if;
  if v_command.state = 'completed' then
    if not v_live_session then raise exception using errcode='42501', message='SESSION_REVOKED'; end if;
    return jsonb_build_object('completed', true);
  end if;
  if v_command.claim_digest is distinct from p_claim_digest
    or v_command.state not in ('auth_pending', 'inconsistent') then
    raise exception using errcode = '40001', message = 'PASSWORD_CHANGE_CLAIM_STALE';
  end if;

  if not v_live_session and (
    v_command.state <> 'auth_pending' or v_command.lease_expires_at is null
    or v_command.lease_expires_at <= clock_timestamp()
  ) then
    raise exception using errcode='42501', message='SESSION_REVOKED';
  end if;
  -- Serialize the current password effect against concurrent Auth writes/reset.
  perform 1 from auth.users where id=p_auth_user_id for update;
  select password_version into v_effect_version from private.auth_password_versions
  where auth_user_id=p_auth_user_id for update;
  if v_effect_version is distinct from v_command.effect_marker
    or v_command.reset_command_execution_id is not null
    or exists(select 1 from private.password_reset_auth_markers
      where target_profile_id=p_actor_profile_id and state='prepared') then
    raise exception using errcode='40001', message='PASSWORD_STATE_INCONSISTENT';
  end if;

  if not exists(select 1 from auth.sessions where id=p_session_id and user_id=p_auth_user_id)
    and (v_command.state <> 'auth_pending' or v_command.lease_expires_at is null
      or v_command.lease_expires_at <= clock_timestamp()) then
    raise exception using errcode='42501', message='SESSION_REVOKED';
  end if;

  update public.profiles
  set must_change_password = false,
      failed_login_count = 0,
      locked_until = null
  where id = p_actor_profile_id;

  -- Keep the original session only if it survived; never create a replacement.
  -- Revoke every other session in the
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
