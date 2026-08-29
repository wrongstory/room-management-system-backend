-- Singleton platform developer account and one-time bootstrap contract.
create unique index profiles_singleton_developer_idx
on public.profiles (role)
where role = 'developer';

create function private.protect_developer_profile()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'INSERT' then
    if new.role = 'developer' then
      perform pg_advisory_xact_lock(hashtextextended('developer_bootstrap_guard', 0));
      if exists (select 1 from public.profiles) then
        raise exception using errcode = '23514', message = 'DEVELOPER_ALREADY_EXISTS';
      end if;
      if new.status <> 'active'
        or new.login_id_normalized <> 'admin'
        or new.must_change_password then
        raise exception using errcode = '23514', message = 'INVALID_DEVELOPER_BOOTSTRAP';
      end if;
    end if;
    return new;
  end if;

  if old.role = 'developer' then
    if new.role <> 'developer'
      or new.status <> 'active'
      or new.login_id_normalized <> old.login_id_normalized
      or new.must_change_password <> old.must_change_password then
      raise exception using errcode = '23514', message = 'DEVELOPER_ACCOUNT_PROTECTED';
    end if;
  elsif new.role = 'developer' then
    raise exception using errcode = '23514', message = 'DEVELOPER_ROLE_BOOTSTRAP_ONLY';
  end if;

  return new;
end;
$$;

revoke all on function private.protect_developer_profile() from public;

create trigger profiles_protect_developer
before insert or update on public.profiles
for each row execute function private.protect_developer_profile();

-- Account commands accept the platform developer as an account manager. Room,
-- reservation, availability and scheduler commands continue to require a
-- business administrator and are intentionally unchanged.
create or replace function private.assert_active_admin(p_actor_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if not exists (
    select 1
    from public.profiles p
    where p.id = p_actor_profile_id
      and p.role in ('developer', 'admin')
      and p.status = 'active'
  ) then
    raise exception using errcode = '42501', message = 'ACTIVE_ACCOUNT_MANAGER_REQUIRED';
  end if;
end;
$$;

revoke all on function private.assert_active_admin(uuid) from public;

-- Disable the legacy first-admin command. A business administrator must now be
-- created by the bootstrapped developer through the normal account command.
revoke all on function public.bootstrap_first_admin_profile(
  uuid, uuid, text, text, text, text, text
) from service_role;

create function public.bootstrap_first_developer_profile(
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
  perform pg_advisory_xact_lock(hashtextextended('developer_bootstrap_guard', 0));

  if exists (select 1 from public.profiles) then
    raise exception using errcode = '23514', message = 'DEVELOPER_ALREADY_EXISTS';
  end if;
  if p_display_name_normalized <> 'admin' then
    raise exception using errcode = '22023', message = 'DEVELOPER_LOGIN_ID_MUST_BE_ADMIN';
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
    'developer',
    'active',
    p_phone_last_four,
    p_phone_lookup_hash,
    false
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
    'account.bootstrap_developer_created',
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

revoke all on function public.bootstrap_first_developer_profile(
  uuid, uuid, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.bootstrap_first_developer_profile(
  uuid, uuid, text, text, text, text, text
) to service_role;
