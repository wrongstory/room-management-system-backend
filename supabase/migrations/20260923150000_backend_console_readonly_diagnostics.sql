-- Local proof-of-concept boundary for backend-console read-only diagnostics.
-- The role is intentionally provisioned without a password. Hosted credentials and
-- pooler endpoints remain an operational decision outside this migration.

do $$
declare
  existing_role pg_catalog.pg_roles%rowtype;
begin
  select * into existing_role
  from pg_catalog.pg_roles
  where rolname = 'rms_diagnostic';

  if not found then
    create role rms_diagnostic
      login
      nosuperuser
      nocreatedb
      nocreaterole
      noinherit
      noreplication
      nobypassrls
      password null;
  elsif existing_role.rolsuper
    or existing_role.rolcreatedb
    or existing_role.rolcreaterole
    or existing_role.rolinherit
    or existing_role.rolreplication
    or existing_role.rolbypassrls
    or not existing_role.rolcanlogin
    or exists (
      select 1
      from pg_catalog.pg_authid
      where rolname = 'rms_diagnostic'
        and rolpassword is not null
    )
    or exists (
      select 1
      from pg_catalog.pg_auth_members
      where member = existing_role.oid
    ) then
    raise exception using errcode = '42501', message = 'DIAGNOSTIC_ROLE_ATTRIBUTES_INVALID';
  end if;
end
$$;

alter role rms_diagnostic set default_transaction_read_only = 'on';
alter role rms_diagnostic set statement_timeout = '3s';
alter role rms_diagnostic set lock_timeout = '500ms';
alter role rms_diagnostic set idle_in_transaction_session_timeout = '5s';
alter role rms_diagnostic set search_path = 'pg_catalog, public';

create or replace view public.diagnostic_system_summary
with (security_barrier = true, security_invoker = false)
as
select
  (select count(*)::bigint from public.rooms) as room_count,
  (select count(*)::bigint from public.room_types where active) as active_room_type_count,
  (select count(*)::bigint from public.reservations where status = 'active')
    as active_reservation_count,
  (select count(*)::bigint from public.cleaning_targets
    where status not in ('approved', 'cancelled')) as open_cleaning_target_count,
  (select count(*)::bigint from public.cleaning_attempts
    where status in ('scheduled', 'in_progress', 'field_completed', 'upload_pending', 'submitted'))
    as active_cleaning_attempt_count;

create or replace view public.diagnostic_room_state_summary
with (security_barrier = true, security_invoker = false)
as
select
  rooms.data_status::text as data_status,
  (rooms.operation_suspended_at is not null) as operation_suspended,
  count(*)::bigint as room_count
from public.rooms
group by rooms.data_status, (rooms.operation_suspended_at is not null);

create or replace view public.diagnostic_workflow_summary
with (security_barrier = true, security_invoker = false)
as
select 'reservation'::text as workflow, reservations.status::text as state,
       count(*)::bigint as item_count
from public.reservations
group by reservations.status
union all
select 'cleaning_target'::text, cleaning_targets.status::text, count(*)::bigint
from public.cleaning_targets
group by cleaning_targets.status
union all
select 'cleaning_attempt'::text, cleaning_attempts.status::text, count(*)::bigint
from public.cleaning_attempts
group by cleaning_attempts.status
union all
select 'cleaning_submission'::text, cleaning_submissions.status::text, count(*)::bigint
from public.cleaning_submissions
group by cleaning_submissions.status;

alter view public.diagnostic_system_summary owner to postgres;
alter view public.diagnostic_room_state_summary owner to postgres;
alter view public.diagnostic_workflow_summary owner to postgres;

revoke all on public.diagnostic_system_summary from public, anon, authenticated, service_role;
revoke all on public.diagnostic_room_state_summary from public, anon, authenticated, service_role;
revoke all on public.diagnostic_workflow_summary from public, anon, authenticated, service_role;
revoke all on all tables in schema public from rms_diagnostic;
revoke all on all sequences in schema public from rms_diagnostic;
revoke all on all functions in schema public from rms_diagnostic;
revoke all on schema private from rms_diagnostic;
revoke all on schema public from rms_diagnostic;

grant usage on schema public to rms_diagnostic;
grant select on public.diagnostic_system_summary to rms_diagnostic;
grant select on public.diagnostic_room_state_summary to rms_diagnostic;
grant select on public.diagnostic_workflow_summary to rms_diagnostic;

comment on role rms_diagnostic is
  'Passwordless-by-default role for bounded backend-console read-only diagnostics.';
comment on view public.diagnostic_system_summary is
  'PII-free aggregate system counters approved for backend-console diagnostics.';
comment on view public.diagnostic_room_state_summary is
  'PII-free aggregate room state counters approved for backend-console diagnostics.';
comment on view public.diagnostic_workflow_summary is
  'PII-free aggregate workflow counters approved for backend-console diagnostics.';
