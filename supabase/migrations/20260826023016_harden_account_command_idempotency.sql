-- Prevent a reused idempotency key from silently authorizing a different
-- account mutation. BEFORE INSERT runs even when the caller uses ON CONFLICT.
create function private.guard_audit_idempotency_key()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_existing public.audit_events%rowtype;
begin
  if new.idempotency_key is null then
    return new;
  end if;

  select * into v_existing
  from public.audit_events
  where idempotency_key = new.idempotency_key;

  if not found then
    return new;
  end if;

  if v_existing.event_type = new.event_type
    and v_existing.entity_type = new.entity_type
    and v_existing.entity_id is not distinct from new.entity_id
    and v_existing.reason_code is not distinct from new.reason_code
    and v_existing.after_state is not distinct from new.after_state then
    return null;
  end if;

  raise exception using errcode = '23505', message = 'IDEMPOTENCY_KEY_REUSED';
end;
$$;

revoke all on function private.guard_audit_idempotency_key() from public;

create trigger audit_events_guard_idempotency
before insert on public.audit_events
for each row execute function private.guard_audit_idempotency_key();

-- The first administrator cannot be created through an administrator-only API.
-- This one-time service command succeeds only while profiles is empty.
create function public.bootstrap_first_admin_profile(
  p_profile_id uuid,
  p_auth_user_id uuid,
  p_display_name text,
  p_display_name_normalized text,
  p_phone_last_four text,
  p_phone_lookup_hash text,
  p_idempotency_key text
)
returns public.profiles
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_result public.profiles%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('first_admin_bootstrap', 0));

  if exists (select 1 from public.profiles) then
    raise exception using errcode = '23514', message = 'FIRST_ADMIN_ALREADY_EXISTS';
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
    p_display_name,
    p_display_name_normalized,
    0,
    'admin',
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
    event_type,
    entity_type,
    entity_id,
    effective_at,
    after_state,
    idempotency_key
  ) values (
    null,
    'account.bootstrap_admin_created',
    'profile',
    v_result.id,
    now(),
    jsonb_build_object(
      'displayName', v_result.display_name,
      'loginId', v_result.login_id,
      'role', v_result.role,
      'status', v_result.status
    ),
    p_idempotency_key
  );

  return v_result;
end;
$$;

revoke all on function public.bootstrap_first_admin_profile(
  uuid, uuid, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.bootstrap_first_admin_profile(
  uuid, uuid, text, text, text, text, text
) to service_role;
