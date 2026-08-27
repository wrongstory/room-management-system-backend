-- Account creation and lifecycle commands for issue #5.
-- Auth users are created by the server first; profile/alias/audit changes are
-- committed atomically here. Every public command is service-role only.

alter table public.profiles
  add column display_name_normalized text,
  add column login_id_normalized text,
  add column login_sequence integer;

with ranked as (
  select
    id,
    lower(btrim(display_name)) as normalized_name,
    row_number() over (
      partition by lower(btrim(display_name))
      order by created_at, id
    ) as name_sequence,
    count(*) over (partition by lower(btrim(display_name))) as name_count
  from public.profiles
)
update public.profiles p
set
  display_name_normalized = r.normalized_name,
  login_id_normalized = lower(btrim(p.login_id)),
  login_sequence = case when r.name_count = 1 then 0 else r.name_sequence end
from ranked r
where r.id = p.id;

alter table public.profiles
  alter column display_name_normalized set not null,
  alter column login_id_normalized set not null,
  alter column login_sequence set not null,
  add constraint profiles_login_sequence_nonnegative check (login_sequence >= 0),
  add constraint profiles_display_name_sequence_unique
    unique (display_name_normalized, login_sequence),
  add constraint profiles_login_id_normalized_unique unique (login_id_normalized);

create index profiles_active_admin_idx
on public.profiles (id)
where role = 'admin' and status = 'active';

create function private.assert_active_admin(p_actor_profile_id uuid)
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
      and p.role = 'admin'
      and p.status = 'active'
  ) then
    raise exception using errcode = '42501', message = 'ACTIVE_ADMIN_REQUIRED';
  end if;
end;
$$;

create function private.assert_not_last_active_admin(
  p_target_profile_id uuid,
  p_next_role public.app_role,
  p_next_status public.account_status
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_target public.profiles%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('active_admin_guard', 0));

  select * into v_target
  from public.profiles
  where id = p_target_profile_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'ACCOUNT_NOT_FOUND';
  end if;

  if v_target.role = 'admin'
    and v_target.status = 'active'
    and (p_next_role <> 'admin' or p_next_status <> 'active')
    and not exists (
      select 1
      from public.profiles p
      where p.id <> p_target_profile_id
        and p.role = 'admin'
        and p.status = 'active'
    ) then
    raise exception using errcode = '23514', message = 'LAST_ACTIVE_ADMIN_REQUIRED';
  end if;
end;
$$;

revoke all on function private.assert_active_admin(uuid) from public;
revoke all on function private.assert_not_last_active_admin(
  uuid, public.app_role, public.account_status
) from public;

create function public.create_account_profile(
  p_profile_id uuid,
  p_auth_user_id uuid,
  p_actor_profile_id uuid,
  p_display_name text,
  p_display_name_normalized text,
  p_role public.app_role,
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
  v_existing_id uuid;
  v_first_profile public.profiles%rowtype;
  v_next_sequence integer;
  v_login_id text;
  v_login_id_normalized text;
  v_result public.profiles%rowtype;
begin
  perform private.assert_active_admin(p_actor_profile_id);

  select ae.entity_id into v_existing_id
  from public.audit_events ae
  where ae.idempotency_key = p_idempotency_key
    and ae.event_type = 'account.created';

  if v_existing_id is not null then
    select * into v_result from public.profiles where id = v_existing_id;
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
    p_idempotency_key
  from public.profiles actor
  where actor.id = p_actor_profile_id;

  return v_result;
end;
$$;

create function public.change_account_role(
  p_actor_profile_id uuid,
  p_target_profile_id uuid,
  p_role public.app_role,
  p_idempotency_key text
)
returns public.profiles
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_before public.profiles%rowtype;
  v_result public.profiles%rowtype;
begin
  perform private.assert_active_admin(p_actor_profile_id);
  select * into v_before from public.profiles where id = p_target_profile_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'ACCOUNT_NOT_FOUND';
  end if;
  if v_before.status = 'departed' then
    raise exception using errcode = '23514', message = 'DEPARTED_ACCOUNT_IMMUTABLE';
  end if;

  perform private.assert_not_last_active_admin(p_target_profile_id, p_role, v_before.status);

  update public.profiles set role = p_role where id = p_target_profile_id
  returning * into v_result;

  if v_before.role <> v_result.role then
    insert into public.audit_events (
      actor_profile_id, actor_display_name_snapshot, event_type, entity_type,
      entity_id, effective_at, before_state, after_state, idempotency_key
    )
    select
      actor.id, actor.display_name, 'account.role_changed', 'profile', v_result.id,
      now(), jsonb_build_object('role', v_before.role),
      jsonb_build_object('role', v_result.role), p_idempotency_key
    from public.profiles actor where actor.id = p_actor_profile_id
    on conflict (idempotency_key) where idempotency_key is not null do nothing;
  end if;

  return v_result;
end;
$$;

create function public.change_account_status(
  p_actor_profile_id uuid,
  p_target_profile_id uuid,
  p_status public.account_status,
  p_reason_code text,
  p_idempotency_key text
)
returns public.profiles
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_before public.profiles%rowtype;
  v_result public.profiles%rowtype;
begin
  perform private.assert_active_admin(p_actor_profile_id);
  select * into v_before from public.profiles where id = p_target_profile_id for update;
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
  if v_before.status in ('deactivation_pending', 'upload_only') and p_status = 'active' then
    raise exception using errcode = '23514', message = 'DEACTIVATION_MUST_BE_FINISHED';
  end if;

  perform private.assert_not_last_active_admin(p_target_profile_id, v_before.role, p_status);

  update public.profiles
  set
    status = p_status,
    deactivated_at = case when p_status = 'active' then null else coalesce(deactivated_at, now()) end,
    failed_login_count = case when p_status = 'active' then 0 else failed_login_count end,
    locked_until = case when p_status = 'active' then null else locked_until end
  where id = p_target_profile_id
  returning * into v_result;

  if p_status <> 'active' then
    delete from auth.sessions where user_id = v_result.auth_user_id;
  end if;

  if v_before.status <> v_result.status then
    insert into public.audit_events (
      actor_profile_id, actor_display_name_snapshot, event_type, entity_type,
      entity_id, effective_at, reason_code, before_state, after_state, idempotency_key
    )
    select
      actor.id, actor.display_name, 'account.status_changed', 'profile', v_result.id,
      now(), p_reason_code, jsonb_build_object('status', v_before.status),
      jsonb_build_object('status', v_result.status), p_idempotency_key
    from public.profiles actor where actor.id = p_actor_profile_id
    on conflict (idempotency_key) where idempotency_key is not null do nothing;
  end if;

  return v_result;
end;
$$;

create function public.unlock_account(
  p_actor_profile_id uuid,
  p_target_profile_id uuid,
  p_idempotency_key text
)
returns public.profiles
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_before public.profiles%rowtype;
  v_result public.profiles%rowtype;
begin
  perform private.assert_active_admin(p_actor_profile_id);
  select * into v_before from public.profiles where id = p_target_profile_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'ACCOUNT_NOT_FOUND';
  end if;

  update public.profiles
  set failed_login_count = 0, locked_until = null
  where id = p_target_profile_id
  returning * into v_result;

  insert into public.audit_events (
    actor_profile_id, actor_display_name_snapshot, event_type, entity_type,
    entity_id, effective_at, before_state, after_state, idempotency_key
  )
  select
    actor.id, actor.display_name, 'account.unlocked', 'profile', v_result.id,
    now(),
    jsonb_build_object('failedLoginCount', v_before.failed_login_count, 'wasLocked', v_before.locked_until is not null),
    jsonb_build_object('failedLoginCount', 0, 'locked', false), p_idempotency_key
  from public.profiles actor where actor.id = p_actor_profile_id
  on conflict (idempotency_key) where idempotency_key is not null do nothing;

  return v_result;
end;
$$;

create function public.prepare_account_password_reset(
  p_actor_profile_id uuid,
  p_target_profile_id uuid,
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
  perform private.assert_active_admin(p_actor_profile_id);

  update public.profiles
  set must_change_password = true, failed_login_count = 0, locked_until = null
  where id = p_target_profile_id and status <> 'departed'
  returning * into v_result;

  if not found then
    raise exception using errcode = 'P0002', message = 'ACCOUNT_NOT_FOUND_OR_DEPARTED';
  end if;

  delete from auth.sessions where user_id = v_result.auth_user_id;

  insert into public.audit_events (
    actor_profile_id, actor_display_name_snapshot, event_type, entity_type,
    entity_id, effective_at, after_state, idempotency_key
  )
  select
    actor.id, actor.display_name, 'account.password_reset_requested', 'profile', v_result.id,
    now(), jsonb_build_object('mustChangePassword', true, 'lockCleared', true), p_idempotency_key
  from public.profiles actor where actor.id = p_actor_profile_id
  on conflict (idempotency_key) where idempotency_key is not null do nothing;

  return v_result;
end;
$$;

create function public.complete_password_change(
  p_actor_profile_id uuid,
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
  update public.profiles
  set must_change_password = false, failed_login_count = 0, locked_until = null
  where id = p_actor_profile_id and status = 'active'
  returning * into v_result;

  if not found then
    raise exception using errcode = '42501', message = 'ACTIVE_ACCOUNT_REQUIRED';
  end if;

  insert into public.audit_events (
    actor_profile_id, actor_display_name_snapshot, event_type, entity_type,
    entity_id, effective_at, after_state, idempotency_key
  ) values (
    v_result.id, v_result.display_name, 'account.password_changed', 'profile',
    v_result.id, now(), jsonb_build_object('mustChangePassword', false), p_idempotency_key
  )
  on conflict (idempotency_key) where idempotency_key is not null do nothing;

  return v_result;
end;
$$;

create function public.is_active_auth_session(
  p_auth_user_id uuid,
  p_session_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select exists (
    select 1
    from auth.sessions s
    where s.id = p_session_id
      and s.user_id = p_auth_user_id
  )
$$;

drop function public.record_login_success(uuid);

create function public.record_login_success(
  p_profile_id uuid,
  p_login_alias_normalized text
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_retired_alias_count integer := 0;
begin
  update public.profiles
  set failed_login_count = 0, locked_until = null
  where id = p_profile_id;

  if exists (
    select 1
    from public.profiles p
    where p.id = p_profile_id
      and p.login_id_normalized = p_login_alias_normalized
  ) then
    update public.login_aliases
    set active = false, retired_at = now()
    where profile_id = p_profile_id
      and expires_after_new_login = true
      and active = true;
    get diagnostics v_retired_alias_count = row_count;
  end if;

  return v_retired_alias_count;
end;
$$;

revoke all on function public.create_account_profile(
  uuid, uuid, uuid, text, text, public.app_role, text, text, text
) from public, anon, authenticated;
revoke all on function public.change_account_role(
  uuid, uuid, public.app_role, text
) from public, anon, authenticated;
revoke all on function public.change_account_status(
  uuid, uuid, public.account_status, text, text
) from public, anon, authenticated;
revoke all on function public.unlock_account(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.prepare_account_password_reset(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.complete_password_change(uuid, text)
  from public, anon, authenticated;
revoke all on function public.is_active_auth_session(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.record_login_success(uuid, text)
  from public, anon, authenticated;

grant execute on function public.create_account_profile(
  uuid, uuid, uuid, text, text, public.app_role, text, text, text
) to service_role;
grant execute on function public.change_account_role(
  uuid, uuid, public.app_role, text
) to service_role;
grant execute on function public.change_account_status(
  uuid, uuid, public.account_status, text, text
) to service_role;
grant execute on function public.unlock_account(uuid, uuid, text) to service_role;
grant execute on function public.prepare_account_password_reset(uuid, uuid, text)
  to service_role;
grant execute on function public.complete_password_change(uuid, text) to service_role;
grant execute on function public.is_active_auth_session(uuid, uuid) to service_role;
grant execute on function public.record_login_success(uuid, text) to service_role;

revoke select on public.profiles from authenticated;
grant select (
  id,
  display_name,
  login_id,
  role,
  status,
  phone_last_four,
  must_change_password,
  failed_login_count,
  locked_until,
  deactivated_at,
  created_at,
  updated_at
) on public.profiles to authenticated;
