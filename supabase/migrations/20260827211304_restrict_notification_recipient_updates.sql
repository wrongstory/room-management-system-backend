-- Recipients may acknowledge their own notification, but resolving a
-- notification is a domain command handled by the backend service role.
revoke update (read_at, resolved_at) on public.notifications from authenticated;
grant update (read_at) on public.notifications to authenticated;
