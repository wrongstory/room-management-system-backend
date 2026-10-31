-- Operator-only PREPARATION. Loading defines a session-local helper; it does not repair data.
-- Separate execution approval, drained password writers, and a fresh secure snapshot are required.
-- Invoke inside an explicit transaction; inspect postconditions before COMMIT.
-- Never log the supplied snapshot (receipt keys and digests are operational credentials).
create or replace function pg_temp.recover_password_effect_543(
  expected_command jsonb, expected_profile jsonb, expected_version jsonb,
  writers_paused_at timestamptz
) returns text
language plpgsql security invoker
set search_path = pg_catalog, public, private, extensions
as $$
declare
  c private.password_change_commands%rowtype;
  p public.profiles%rowtype;
  v private.auth_password_versions%rowtype;
  actor_id uuid := (expected_command->>'actor_profile_id')::uuid;
  audit_key text;
  audit_count integer;
  inserted_audit_count integer;
  applied_at timestamptz;
begin
  if session_user <> 'postgres' then
    raise exception 'OPERATOR_REQUIRED';
  end if;
  if expected_command is null or expected_profile is null or expected_version is null
    or actor_id is null or expected_command->>'state' is distinct from 'auth_pending'
    or expected_command->>'attempt_count' is distinct from '1' then
    raise exception 'EXACT_SNAPSHOT_REQUIRED';
  end if;
  if writers_paused_at is null or writers_paused_at > clock_timestamp()-interval '15 minutes'
    or exists(select 1 from pg_stat_activity where datname=current_database()
      and pid<>pg_backend_pid() and backend_type='client backend'
      and xact_start<=writers_paused_at) then
    raise exception 'PASSWORD_WRITERS_NOT_DRAINED';
  end if;
  -- Actual drain evidence must also be checked by the operator; ACL denial alone is insufficient.
  if has_function_privilege('service_role', 'public.prepare_password_change(uuid,uuid,uuid,text,text,text,text)', 'EXECUTE')
    or has_function_privilege('service_role', 'public.prepare_account_password_reset(uuid,uuid,text,text)', 'EXECUTE')
    or has_function_privilege('service_role', 'public.prepare_password_change_admin_reset(uuid,uuid,text,text,text)', 'EXECUTE') then
    raise exception 'PASSWORD_WRITERS_NOT_PAUSED';
  end if;
  if not pg_try_advisory_xact_lock(hashtextextended('password-change:' || actor_id::text,0)) then
    raise exception 'PASSWORD_WRITER_BUSY';
  end if;
  select * into strict p from public.profiles where id=actor_id for update nowait;
  select * into strict c from private.password_change_commands
    where id=(expected_command->>'id')::uuid and actor_profile_id=actor_id for update nowait;
  perform 1 from auth.users where id=c.auth_user_id for update nowait;
  if not found then raise exception 'AUTH_USER_MISSING'; end if;
  select * into strict v from private.auth_password_versions where auth_user_id=c.auth_user_id for update nowait;
  if p.status <> 'active' or p.auth_user_id is distinct from c.auth_user_id
    or c.command_type <> 'account.password.change'
    or to_jsonb(v) is distinct from expected_version
    or v.password_version is distinct from c.effect_marker
    or v.rotated_at<c.created_at or v.rotated_at>clock_timestamp()
    or c.reset_command_execution_id is not null
    or exists(select 1 from private.password_reset_auth_markers where target_profile_id=actor_id and state='prepared') then
    raise exception 'PASSWORD_EFFECT_CHANGED';
  end if;
  audit_key := private.password_change_audit_key(actor_id,c.idempotency_key);
  select count(*) into audit_count from public.audit_events
    where actor_profile_id=actor_id and event_type='account.password_changed'
      and entity_type='profile' and entity_id=actor_id
      and request_hash=c.request_hash and idempotency_key=audit_key
      and after_state=jsonb_build_object('mustChangePassword',false)
      and effective_at=v.rotated_at;
  if c.state='completed' then
    -- Never revoke newly-created sessions on a repeated operator call.
    if (to_jsonb(c)-array['state','claim_digest','lease_expires_at','failure_code','updated_at','completed_at'])
      is distinct from (expected_command-array['state','claim_digest','lease_expires_at','failure_code','updated_at','completed_at'])
      or audit_count<>1 or c.claim_digest is not null or c.lease_expires_at is not null
      or c.failure_code is not null or c.completed_at is null then
      raise exception 'COMPLETED_RECEIPT_MISMATCH';
    end if;
    return 'already_completed';
  end if;
  if to_jsonb(c) is distinct from expected_command
    or jsonb_build_object('id',p.id,'auth_user_id',p.auth_user_id,'status',p.status,'role',p.role,
      'must_change_password',p.must_change_password,'failed_login_count',p.failed_login_count,'locked_until',p.locked_until)
      is distinct from expected_profile
    or p.must_change_password or p.locked_until is not null
    or c.failure_code is not null or c.completed_at is not null
    or c.claim_digest is null or c.lease_expires_at is null
    or c.lease_expires_at>=writers_paused_at
    or exists(select 1 from public.audit_events where idempotency_key=audit_key)
    or exists(select 1 from auth.sessions s where s.user_id=c.auth_user_id
      and private.password_change_session_digest(s.id)=c.session_digest) then
    raise exception 'RECOVERY_SNAPSHOT_CHANGED';
  end if;
  -- This incident already has a cleared profile gate. Preserve all profile values.
  -- Session deletion only affects the exact target and requires explicit approval.
  delete from auth.sessions where user_id=c.auth_user_id;
  applied_at := clock_timestamp();
  insert into public.audit_events(actor_profile_id,actor_display_name_snapshot,event_type,entity_type,
    entity_id,effective_at,after_state,request_hash,idempotency_key)
  values(p.id,p.display_name,'account.password_changed','profile',p.id,v.rotated_at,
    jsonb_build_object('mustChangePassword',false),c.request_hash,audit_key);
  get diagnostics inserted_audit_count = row_count;
  if inserted_audit_count<>1 then raise exception 'RECOVERY_AUDIT_NOT_INSERTED'; end if;
  update private.password_change_commands set state='completed',claim_digest=null,lease_expires_at=null,
    failure_code=null,updated_at=applied_at,completed_at=applied_at where id=c.id;
  return 'completed';
end;
$$;
revoke all on function pg_temp.recover_password_effect_543(jsonb,jsonb,jsonb,timestamptz)
  from public, anon, authenticated, service_role;
