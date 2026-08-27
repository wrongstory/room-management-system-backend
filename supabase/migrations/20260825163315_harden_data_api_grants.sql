-- Projects created before the Data API auto-exposure rollout may still grant
-- broad privileges automatically. Revoke them and opt in only to the contract
-- required by the backend.
revoke all on schema public from public, anon, authenticated;
grant usage on schema public to authenticated, service_role;

revoke all privileges on all tables in schema public from anon, authenticated;
revoke all privileges on all sequences in schema public from anon, authenticated;
revoke all privileges on all routines in schema public from anon, authenticated;

alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated;

drop policy if exists notifications_read_own on public.notifications;
drop policy if exists notifications_admin_read on public.notifications;
drop policy if exists notifications_read_scoped on public.notifications;

create policy notifications_read_scoped on public.notifications
for select to authenticated
using (
  recipient_profile_id = (select private.current_profile_id())
  or (select private.current_role()) = 'admin'
);

grant select on public.profiles, public.room_types, public.rooms, public.room_catalog,
  public.cleaning_template_versions, public.cleaning_targets, public.cleaning_assignments,
  public.cleaning_attempts, public.cleaning_submissions, public.inspection_decisions,
  public.earnings, public.payroll_cycles, public.notifications to authenticated;
grant update (read_at, resolved_at) on public.notifications to authenticated;
grant select on public.reservations, public.audit_events to authenticated;
