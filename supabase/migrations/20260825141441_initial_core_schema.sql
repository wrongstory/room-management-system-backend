+-- CASTLE THE ART room-management core schema
-- Policy sources: frontend DOCS/16-20 and FINAL_UX_AUDIT.md.
-- Every public table is protected by RLS. The service secret remains server-only.

create extension if not exists btree_gist with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

create type public.app_role as enum ('admin', 'maid');
create type public.account_status as enum (
  'active',
  'deactivation_pending',
  'upload_only',
  'inactive',
  'departed'
);
create type public.data_status as enum ('verified', 'verification_required');
create type public.cleaning_kind as enum ('checkout', 'stayover', 'additional', 'reclean');
create type public.cleaning_target_status as enum (
  'unassigned',
  'draft_assigned',
  'notified',
  'in_progress',
  'upload_pending',
  'inspection_pending',
  'approved',
  'rejected',
  'cancelled'
);
create type public.attempt_status as enum (
  'scheduled',
  'in_progress',
  'field_completed',
  'upload_pending',
  'submitted',
  'approved',
  'rejected',
  'interrupted',
  'superseded'
);
create type public.submission_status as enum ('submitted', 'superseded', 'approved', 'rejected');
create type public.payment_status as enum ('open', 'paying', 'check', 'paid');

create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.profiles (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique references auth.users(id) on delete restrict,
  display_name text not null,
  login_id text not null unique,
  role public.app_role not null,
  status public.account_status not null default 'active',
  phone_last_four text check (phone_last_four is null or phone_last_four ~ '^[0-9]{4}$'),
  phone_lookup_hash text unique,
  must_change_password boolean not null default true,
  failed_login_count integer not null default 0 check (failed_login_count >= 0),
  locked_until timestamptz,
  deactivated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.login_aliases (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  alias text not null,
  alias_normalized text not null unique,
  active boolean not null default true,
  expires_after_new_login boolean not null default false,
  created_at timestamptz not null default now(),
  retired_at timestamptz
);

create function private.current_profile_id()
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select p.id
  from public.profiles p
  where p.auth_user_id = (select auth.uid())
    and p.status in ('active', 'deactivation_pending', 'upload_only')
  limit 1
$$;

create function private.current_role()
returns public.app_role
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select p.role
  from public.profiles p
  where p.auth_user_id = (select auth.uid())
    and p.status in ('active', 'deactivation_pending', 'upload_only')
  limit 1
$$;

create function private.current_account_active()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.auth_user_id = (select auth.uid())
      and p.status = 'active'
  )
$$;

revoke all on function private.current_profile_id() from public;
revoke all on function private.current_role() from public;
revoke all on function private.current_account_active() from public;
grant execute on function private.current_profile_id() to authenticated;
grant execute on function private.current_role() to authenticated;
grant execute on function private.current_account_active() to authenticated;

create function public.record_login_failure(p_profile_id uuid)
returns table (failed_login_count integer, locked_until timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  return query
  update public.profiles p
  set
    failed_login_count = case
      when p.locked_until is not null and p.locked_until <= now() then 1
      else p.failed_login_count + 1
    end,
    locked_until = case
      when (
        case
          when p.locked_until is not null and p.locked_until <= now() then 1
          else p.failed_login_count + 1
        end
      ) >= 5 then now() + interval '15 minutes'
      else null
    end
  where p.id = p_profile_id
  returning p.failed_login_count, p.locked_until;
end;
$$;

create function public.record_login_success(p_profile_id uuid)
returns void
language sql
security definer
set search_path = pg_catalog, public
as $$
  update public.profiles
  set failed_login_count = 0, locked_until = null
  where id = p_profile_id
$$;

revoke all on function public.record_login_failure(uuid) from public, anon, authenticated;
revoke all on function public.record_login_success(uuid) from public, anon, authenticated;
grant execute on function public.record_login_failure(uuid) to service_role;
grant execute on function public.record_login_success(uuid) to service_role;

create table public.room_types (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  base_cleaning_fee integer not null check (base_cleaning_fee >= 0),
  default_duration_minutes integer not null check (default_duration_minutes > 0),
  default_guest_count integer not null check (default_guest_count > 0),
  max_guest_count integer not null check (max_guest_count >= default_guest_count),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  room_number text not null unique check (room_number ~ '^[0-9]+$'),
  room_type_id uuid not null references public.room_types(id),
  elevator_zone text check (elevator_zone in ('A', 'B', 'C')),
  data_status public.data_status not null default 'verified',
  data_status_reason text,
  occupancy_override text check (occupancy_override in ('occupied', 'vacant')),
  occupancy_override_reason text,
  state_version bigint not null default 1 check (state_version > 0),
  operation_suspended_at timestamptz,
  operation_suspended_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create view public.room_catalog
with (security_invoker = true)
as
select
  r.id,
  r.room_number,
  rt.code as room_type_code,
  rt.name as room_type_name,
  r.elevator_zone,
  r.data_status
from public.rooms r
join public.room_types rt on rt.id = r.room_type_id;

create table public.reservations (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id),
  check_in_at timestamptz not null,
  check_out_at timestamptz not null,
  guest_count integer not null check (guest_count > 0),
  status text not null default 'active' check (status in ('active', 'cancelled', 'checked_out')),
  guest_name_encrypted text,
  preparation_obligation_id uuid not null default gen_random_uuid(),
  stay_range tstzrange generated always as (tstzrange(check_in_at, check_out_at, '[)')) stored,
  version bigint not null default 1 check (version > 0),
  created_by uuid not null references public.profiles(id),
  updated_by uuid not null references public.profiles(id),
  cancelled_at timestamptz,
  actual_checkout_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (check_out_at > check_in_at),
  constraint reservations_no_overlap exclude using gist (
    room_id with =,
    stay_range with &&
  ) where (status = 'active')
);

create table public.cleaning_template_versions (
  id uuid primary key default gen_random_uuid(),
  room_type_id uuid not null references public.room_types(id),
  cleaning_kind public.cleaning_kind not null,
  version integer not null check (version > 0),
  status text not null check (status in ('draft', 'published', 'retired')),
  duration_minutes integer not null check (duration_minutes > 0),
  photo_slots jsonb not null default '[]'::jsonb,
  published_at timestamptz,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (room_type_id, cleaning_kind, version)
);

create unique index cleaning_template_one_published
on public.cleaning_template_versions (room_type_id, cleaning_kind)
where status = 'published';

create table public.cleaning_targets (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id),
  reservation_id uuid references public.reservations(id),
  cleaning_kind public.cleaning_kind not null,
  source text not null check (source in (
    'scheduled_checkout',
    'manual_checkout',
    'stayover_request',
    'manual_room_request',
    'inspection_reclean'
  )),
  source_key text not null unique,
  original_service_date date not null,
  effective_service_date date not null,
  carryover_count integer not null default 0 check (carryover_count >= 0),
  available_from timestamptz,
  due_at timestamptz,
  status public.cleaning_target_status not null default 'unassigned',
  assignment_version bigint not null default 1 check (assignment_version > 0),
  room_type_snapshot jsonb not null,
  fee_snapshot integer not null check (fee_snapshot >= 0),
  template_snapshot jsonb not null,
  cancellation_reason_code text,
  cancelled_at timestamptz,
  cancelled_by uuid references public.profiles(id),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index cleaning_targets_one_active_per_room
on public.cleaning_targets (room_id)
where status not in ('approved', 'cancelled');

create table public.cleaning_assignments (
  id uuid primary key default gen_random_uuid(),
  cleaning_target_id uuid not null references public.cleaning_targets(id),
  maid_profile_id uuid not null references public.profiles(id),
  sequence_number integer not null check (sequence_number > 0),
  revision bigint not null check (revision > 0),
  is_current boolean not null default true,
  notified_at timestamptz,
  ended_at timestamptz,
  change_reason_code text,
  changed_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (cleaning_target_id, revision)
);

create unique index cleaning_assignments_one_current
on public.cleaning_assignments (cleaning_target_id)
where is_current;

create table public.cleaning_attempts (
  id uuid primary key default gen_random_uuid(),
  cleaning_target_id uuid not null references public.cleaning_targets(id),
  assignment_id uuid not null references public.cleaning_assignments(id),
  maid_profile_id uuid not null references public.profiles(id),
  attempt_number integer not null check (attempt_number > 0),
  status public.attempt_status not null default 'scheduled',
  assignment_revision bigint not null,
  started_at timestamptz,
  field_completed_at timestamptz,
  ended_at timestamptz,
  end_reason text,
  template_snapshot jsonb not null,
  room_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (cleaning_target_id, attempt_number)
);

create unique index cleaning_attempts_one_active_per_target
on public.cleaning_attempts (cleaning_target_id)
where status in ('scheduled', 'in_progress', 'field_completed', 'upload_pending', 'submitted');

create unique index cleaning_attempts_one_in_progress_per_maid
on public.cleaning_attempts (maid_profile_id)
where status = 'in_progress';

create table public.cleaning_submissions (
  id uuid primary key default gen_random_uuid(),
  cleaning_attempt_id uuid not null references public.cleaning_attempts(id),
  client_submission_id uuid not null unique,
  version integer not null check (version > 0),
  status public.submission_status not null default 'submitted',
  photo_manifest jsonb not null,
  issue_snapshot jsonb not null default '[]'::jsonb,
  candle_count integer not null default 0 check (candle_count >= 0),
  bomb_room_snapshot jsonb,
  submitted_by uuid not null references public.profiles(id),
  submitted_at timestamptz not null default now(),
  superseded_at timestamptz,
  unique (cleaning_attempt_id, version)
);

create unique index cleaning_submissions_one_current
on public.cleaning_submissions (cleaning_attempt_id)
where status = 'submitted';

create table public.inspection_decisions (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null unique references public.cleaning_submissions(id),
  decision text not null check (decision in ('approved', 'rejected')),
  reason_code text,
  reason_detail text,
  bomb_room_decision text check (bomb_room_decision in ('approved', 'rejected')),
  decided_by uuid not null references public.profiles(id),
  decided_at timestamptz not null default now()
);

create table public.earnings (
  id uuid primary key default gen_random_uuid(),
  earning_entitlement_id uuid unique,
  reclean_compensation_decision_id uuid unique,
  submission_id uuid not null unique references public.cleaning_submissions(id),
  maid_profile_id uuid not null references public.profiles(id),
  earned_on date not null,
  base_amount integer not null check (base_amount >= 0),
  bomb_room_bonus integer not null default 0 check (bomb_room_bonus >= 0),
  total_amount integer generated always as (base_amount + bomb_room_bonus) stored,
  created_at timestamptz not null default now(),
  check (
    (earning_entitlement_id is not null and reclean_compensation_decision_id is null)
    or (earning_entitlement_id is null and reclean_compensation_decision_id is not null)
  )
);

create table public.payroll_cycles (
  id uuid primary key default gen_random_uuid(),
  maid_profile_id uuid not null references public.profiles(id),
  week_start date not null check (extract(isodow from week_start) = 1),
  status public.payment_status not null default 'open',
  locked_amount integer check (locked_amount is null or locked_amount >= 0),
  locked_earning_ids uuid[],
  payment_started_by uuid references public.profiles(id),
  payment_started_at timestamptz,
  paid_at timestamptz,
  check_reason text,
  version bigint not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (maid_profile_id, week_start)
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_profile_id uuid not null references public.profiles(id),
  category text not null,
  title text not null,
  body text not null,
  room_id uuid references public.rooms(id),
  cleaning_target_id uuid references public.cleaning_targets(id),
  dedupe_key text,
  group_key text,
  requires_action boolean not null default false,
  read_at timestamptz,
  resolved_at timestamptz,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create unique index notifications_dedupe
on public.notifications (recipient_profile_id, dedupe_key)
where dedupe_key is not null;

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_profile_id uuid references public.profiles(id),
  actor_display_name_snapshot text,
  event_type text not null,
  entity_type text not null,
  entity_id uuid,
  effective_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  reason_code text,
  before_state jsonb,
  after_state jsonb,
  request_id text,
  idempotency_key text,
  created_at timestamptz not null default now()
);

create unique index audit_events_idempotency
on public.audit_events (idempotency_key)
where idempotency_key is not null;

create trigger profiles_set_updated_at before update on public.profiles
for each row execute function private.set_updated_at();
create trigger room_types_set_updated_at before update on public.room_types
for each row execute function private.set_updated_at();
create trigger rooms_set_updated_at before update on public.rooms
for each row execute function private.set_updated_at();
create trigger reservations_set_updated_at before update on public.reservations
for each row execute function private.set_updated_at();
create trigger cleaning_targets_set_updated_at before update on public.cleaning_targets
for each row execute function private.set_updated_at();
create trigger cleaning_attempts_set_updated_at before update on public.cleaning_attempts
for each row execute function private.set_updated_at();
create trigger payroll_cycles_set_updated_at before update on public.payroll_cycles
for each row execute function private.set_updated_at();

insert into public.room_types (
  code, name, base_cleaning_fee, default_duration_minutes, default_guest_count, max_guest_count
) values
  ('standard', '스탠다드 더블 로프트', 16000, 55, 2, 2),
  ('premium', '프리미어 더블 로프트', 20000, 65, 2, 3),
  ('oceanPremium', '파셜 오션뷰 프리미어 더블 로프트', 20000, 70, 2, 4),
  ('oceanFamily', '파셜 오션뷰 패밀리 투룸 로프트', 30000, 80, 4, 6);

with catalog(room_number, type_code, elevator_zone) as (
  values
    ('350','standard','C'),('352','standard','C'),('516','standard','A'),('552','standard','C'),('556','standard','C'),('623','standard','A'),('652','standard','C'),('657','standard','B'),('660','standard','B'),('662','standard','B'),('720','standard','A'),('723','standard','A'),('726','standard','A'),('729','standard','B'),('750','standard','C'),('752','standard','C'),('753','standard','C'),('756','standard','C'),('760','standard','B'),('762','standard','B'),('553','standard','C'),('629','standard','B'),
    ('117','premium','A'),('135','premium','C'),('136','premium','C'),('240','premium','C'),('332','premium','B'),('454','premium','C'),('455','premium','C'),('459','premium','B'),('527','premium','A'),('528','premium','B'),('531','premium','B'),('534','premium','C'),('540','premium','C'),('541','premium','C'),('549','premium','C'),('554','premium','C'),('555','premium','C'),('561','premium','B'),('603','premium','B'),('621','premium','A'),('624','premium','A'),('634','premium','C'),('635','premium','C'),('649','premium','C'),('651','premium','C'),('654','premium','C'),('655','premium','C'),('658','premium','B'),('661','premium','B'),('721','premium','A'),('722','premium','A'),('724','premium','A'),('727','premium','A'),('730','premium','B'),('731','premium','B'),('732','premium','B'),('749','premium','C'),('751','premium','C'),('754','premium','C'),('755','premium','C'),('759','premium','B'),('761','premium','B'),('139','premium','C'),('358','premium','B'),('359','premium','B'),('449','premium','C'),('458','premium','B'),('461','premium','B'),('558','premium','B'),('559','premium','B'),('628','premium','B'),
    ('536','oceanPremium','C'),('639','oceanPremium','C'),('640','oceanPremium','C'),('641','oceanPremium','C'),('701','oceanPremium','B'),('704','oceanPremium','B'),('706','oceanPremium','A'),('707','oceanPremium','A'),('735','oceanPremium','C'),('738','oceanPremium','C'),('739','oceanPremium','C'),('740','oceanPremium','C'),('741','oceanPremium','C'),
    ('142','oceanFamily','C'),('211','oceanFamily','A'),('314','oceanFamily','A'),('410','oceanFamily','A'),('413','oceanFamily','A'),('415','oceanFamily','A'),('444','oceanFamily','C'),('509','oceanFamily','A'),('510','oceanFamily','A'),('511','oceanFamily','A'),('512','oceanFamily','A'),('514','oceanFamily','A'),('542','oceanFamily','C'),('544','oceanFamily','C'),('546','oceanFamily','C'),('608','oceanFamily','A'),('609','oceanFamily','A'),('610','oceanFamily','A'),('611','oceanFamily','A'),('612','oceanFamily','A'),('637','oceanFamily','C'),('645','oceanFamily','C'),('646','oceanFamily','C'),('647','oceanFamily','C'),('648','oceanFamily','C'),('708','oceanFamily','A'),('709','oceanFamily','A'),('712','oceanFamily','A'),('737','oceanFamily','C'),('743','oceanFamily','C'),('744','oceanFamily','C'),('745','oceanFamily','C'),('746','oceanFamily','C'),('747','oceanFamily','C'),('748','oceanFamily','C')
)
insert into public.rooms (room_number, room_type_id, elevator_zone)
select c.room_number, rt.id, c.elevator_zone
from catalog c
join public.room_types rt on rt.code = c.type_code;

update public.rooms
set
  occupancy_override = 'occupied',
  occupancy_override_reason = '2026-08 initial occupied seed'
where room_number in ('139','358','359','449','458','461','553','558','559','628','629');

update public.rooms
set
  data_status = 'verification_required',
  data_status_reason = '현재 투숙 상태 확인 필요'
where room_number = '762';

alter table public.profiles enable row level security;
alter table public.login_aliases enable row level security;
alter table public.room_types enable row level security;
alter table public.rooms enable row level security;
alter table public.reservations enable row level security;
alter table public.cleaning_template_versions enable row level security;
alter table public.cleaning_targets enable row level security;
alter table public.cleaning_assignments enable row level security;
alter table public.cleaning_attempts enable row level security;
alter table public.cleaning_submissions enable row level security;
alter table public.inspection_decisions enable row level security;
alter table public.earnings enable row level security;
alter table public.payroll_cycles enable row level security;
alter table public.notifications enable row level security;
alter table public.audit_events enable row level security;

create policy profiles_select_self_or_admin on public.profiles
for select to authenticated
using (id = (select private.current_profile_id()) or (select private.current_role()) = 'admin');

create policy profiles_admin_all on public.profiles
for all to authenticated
using ((select private.current_role()) = 'admin')
with check ((select private.current_role()) = 'admin');

create policy room_types_read_active on public.room_types
for select to authenticated
using ((select private.current_account_active()));

create policy room_types_admin_write on public.room_types
for all to authenticated
using ((select private.current_role()) = 'admin')
with check ((select private.current_role()) = 'admin');

create policy rooms_read_active on public.rooms
for select to authenticated
using ((select private.current_account_active()));

create policy rooms_admin_write on public.rooms
for all to authenticated
using ((select private.current_role()) = 'admin')
with check ((select private.current_role()) = 'admin');

create policy reservations_admin_all on public.reservations
for all to authenticated
using ((select private.current_role()) = 'admin')
with check ((select private.current_role()) = 'admin');

create policy templates_read_active on public.cleaning_template_versions
for select to authenticated
using ((select private.current_account_active()));

create policy templates_admin_write on public.cleaning_template_versions
for all to authenticated
using ((select private.current_role()) = 'admin')
with check ((select private.current_role()) = 'admin');

create policy targets_read_scoped on public.cleaning_targets
for select to authenticated
using (
  (select private.current_role()) = 'admin'
  or exists (
    select 1
    from public.cleaning_assignments a
    where a.cleaning_target_id = cleaning_targets.id
      and a.maid_profile_id = (select private.current_profile_id())
      and a.is_current
  )
);

create policy targets_admin_write on public.cleaning_targets
for all to authenticated
using ((select private.current_role()) = 'admin')
with check ((select private.current_role()) = 'admin');

create policy assignments_read_scoped on public.cleaning_assignments
for select to authenticated
using (
  (select private.current_role()) = 'admin'
  or maid_profile_id = (select private.current_profile_id())
);

create policy assignments_admin_write on public.cleaning_assignments
for all to authenticated
using ((select private.current_role()) = 'admin')
with check ((select private.current_role()) = 'admin');

create policy attempts_read_scoped on public.cleaning_attempts
for select to authenticated
using (
  (select private.current_role()) = 'admin'
  or maid_profile_id = (select private.current_profile_id())
);

create policy attempts_maid_update_own on public.cleaning_attempts
for update to authenticated
using (maid_profile_id = (select private.current_profile_id()))
with check (maid_profile_id = (select private.current_profile_id()));

create policy attempts_admin_all on public.cleaning_attempts
for all to authenticated
using ((select private.current_role()) = 'admin')
with check ((select private.current_role()) = 'admin');

create policy submissions_read_scoped on public.cleaning_submissions
for select to authenticated
using (
  (select private.current_role()) = 'admin'
  or submitted_by = (select private.current_profile_id())
);

create policy submissions_insert_own on public.cleaning_submissions
for insert to authenticated
with check (submitted_by = (select private.current_profile_id()));

create policy decisions_read_scoped on public.inspection_decisions
for select to authenticated
using (
  (select private.current_role()) = 'admin'
  or exists (
    select 1
    from public.cleaning_submissions s
    where s.id = inspection_decisions.submission_id
      and s.submitted_by = (select private.current_profile_id())
  )
);

create policy decisions_admin_write on public.inspection_decisions
for all to authenticated
using ((select private.current_role()) = 'admin')
with check ((select private.current_role()) = 'admin');

create policy earnings_read_scoped on public.earnings
for select to authenticated
using (
  (select private.current_role()) = 'admin'
  or maid_profile_id = (select private.current_profile_id())
);

create policy earnings_admin_write on public.earnings
for all to authenticated
using ((select private.current_role()) = 'admin')
with check ((select private.current_role()) = 'admin');

create policy payroll_read_scoped on public.payroll_cycles
for select to authenticated
using (
  (select private.current_role()) = 'admin'
  or maid_profile_id = (select private.current_profile_id())
);

create policy payroll_admin_write on public.payroll_cycles
for all to authenticated
using ((select private.current_role()) = 'admin')
with check ((select private.current_role()) = 'admin');

create policy notifications_read_own on public.notifications
for select to authenticated
using (recipient_profile_id = (select private.current_profile_id()));

create policy notifications_update_own on public.notifications
for update to authenticated
using (recipient_profile_id = (select private.current_profile_id()))
with check (recipient_profile_id = (select private.current_profile_id()));

create policy notifications_admin_all on public.notifications
for all to authenticated
using ((select private.current_role()) = 'admin')
with check ((select private.current_role()) = 'admin');

create policy audit_admin_read on public.audit_events
for select to authenticated
using ((select private.current_role()) = 'admin');

grant usage on schema public to authenticated;
grant select on public.profiles, public.room_types, public.rooms, public.room_catalog,
  public.cleaning_template_versions, public.cleaning_targets, public.cleaning_assignments,
  public.cleaning_attempts, public.cleaning_submissions, public.inspection_decisions,
  public.earnings, public.payroll_cycles, public.notifications to authenticated;
grant insert on public.cleaning_submissions to authenticated;
grant update on public.cleaning_attempts, public.notifications to authenticated;
grant insert, update, delete on public.profiles, public.room_types, public.rooms,
  public.reservations, public.cleaning_template_versions, public.cleaning_targets,
  public.cleaning_assignments, public.cleaning_attempts, public.inspection_decisions,
  public.earnings, public.payroll_cycles, public.notifications to authenticated;
grant select on public.reservations, public.audit_events to authenticated;

-- The backend secret maps to service_role. Explicit grants are required because
-- new Supabase projects no longer auto-expose newly created public tables.
grant all privileges on all tables in schema public to service_role;
grant all privileges on all routines in schema public to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'cleaning-evidence',
  'cleaning-evidence',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/heic', 'image/heif']
)
on conflict (id) do nothing;

create policy cleaning_evidence_insert_own
on storage.objects
for insert to authenticated
with check (
  bucket_id = 'cleaning-evidence'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and (select private.current_account_active())
);

create policy cleaning_evidence_read_scoped
on storage.objects
for select to authenticated
using (
  bucket_id = 'cleaning-evidence'
  and (
    owner_id = (select auth.uid())::text
    or (select private.current_role()) = 'admin'
  )
);
