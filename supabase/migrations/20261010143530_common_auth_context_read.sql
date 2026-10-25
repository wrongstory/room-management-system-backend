-- #442: one network round trip, not concurrent authorization reads.
-- Apply only after the separately approved final database validation.
create function public.get_active_auth_context(p_auth_user_id uuid, p_session_id text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  v_profile record;
  v_session_id uuid;
  v_active boolean;
begin
  -- VOLATILE obtains a fresh snapshot for each SQL command only at this
  -- isolation level. Never silently authorize from a transaction-old snapshot.
  if current_setting('transaction_isolation') <> 'read committed' then
    return jsonb_build_object('code', 'AUTH_CONTEXT_UNAVAILABLE');
  end if;

  select p.id, p.auth_user_id, p.display_name, p.role, p.status, p.must_change_password
    into v_profile from public.profiles p where p.auth_user_id = p_auth_user_id;
  if not found then
    return jsonb_build_object('code', 'PROFILE_NOT_FOUND');
  end if;
  if v_profile.status <> 'active' then
    return jsonb_build_object('code', 'ACCOUNT_INACTIVE');
  end if;
  if p_session_id is null or p_session_id = '' then
    return jsonb_build_object('code', 'INVALID_ACCESS_TOKEN');
  end if;
  begin
    v_session_id := p_session_id::uuid;
  exception when invalid_text_representation then
    return jsonb_build_object('code', 'SESSION_REVOKED');
  end;

  -- Separate command, after profile completion. Do not combine into a JOIN,
  -- CTE, STABLE helper or parallel request. Use the actual session-check clock,
  -- not the outer RPC's statement_timestamp() captured before profile waiting.
  select exists (select 1 from auth.sessions s
    where s.id = v_session_id and s.user_id = p_auth_user_id
      and (s.not_after is null or s.not_after > clock_timestamp())) into v_active;
  if not v_active then
    return jsonb_build_object('code', 'SESSION_REVOKED');
  end if;
  return jsonb_build_object('code', 'OK', 'profile', jsonb_build_object(
    'id', v_profile.id, 'auth_user_id', v_profile.auth_user_id,
    'display_name', v_profile.display_name, 'role', v_profile.role,
    'must_change_password', v_profile.must_change_password));
end
$$;

revoke all on function public.get_active_auth_context(uuid, text) from public, anon, authenticated;
grant execute on function public.get_active_auth_context(uuid, text) to service_role;
comment on function public.get_active_auth_context(uuid, text) is
  'Server-only verified Auth user context: sequential fresh profile then live session; no writes or cache.';
