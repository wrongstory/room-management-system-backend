-- #352: keep the existing server-only helper contract and reject hard-expired
-- Auth sessions even while the Auth cleanup or access JWT remains lazy.
-- No Auth settings, business deadlines, PIN/capability TTL or RLS changes.
create or replace function public.is_active_auth_session(
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
      and (s.not_after is null or s.not_after > statement_timestamp())
  )
$$;

-- CREATE OR REPLACE deliberately preserves the existing owner and EXECUTE ACL.
-- Direct-session callers, post-lock clocks and session-free legacy RLS remain
-- separate audit scopes; this helper change does not claim to repair them.
