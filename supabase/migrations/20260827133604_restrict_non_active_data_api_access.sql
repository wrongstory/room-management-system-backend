-- A valid JWT is not sufficient authorization after an account enters a
-- restricted lifecycle state. General Data API policies must resolve no actor
-- for deactivation_pending/upload_only accounts; later upload capabilities use
-- narrow server commands rather than inheriting the full maid/admin role.
create or replace function private.current_profile_id()
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select p.id
  from public.profiles p
  where p.auth_user_id = (select auth.uid())
    and p.status = 'active'
  limit 1
$$;

create or replace function private.current_role()
returns public.app_role
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select p.role
  from public.profiles p
  where p.auth_user_id = (select auth.uid())
    and p.status = 'active'
  limit 1
$$;

-- The opt-in Data API migration revoked routine privileges after the initial
-- helper grants. Policies call these helpers as the authenticated role, so keep
-- only the exact policy helpers executable.
revoke all on function private.current_profile_id() from public, anon, authenticated;
revoke all on function private.current_role() from public, anon, authenticated;
revoke all on function private.current_account_active() from public, anon, authenticated;

grant execute on function private.current_profile_id() to authenticated;
grant execute on function private.current_role() to authenticated;
grant execute on function private.current_account_active() to authenticated;

-- Recipients may acknowledge a notification. Resolution belongs to the domain
-- command that resolves the related incident/workflow.
revoke update (read_at, resolved_at) on public.notifications from authenticated;
grant update (read_at) on public.notifications to authenticated;
