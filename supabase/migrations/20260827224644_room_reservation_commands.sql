-- Issue #1: room master data, reservation schedule history, occupancy events,
-- preparation/checkout obligations, and atomic room operations.
-- Existing migrations are already applied remotely, so this is append-only.

alter table public.audit_events
  add column request_hash text
  check (request_hash is null or request_hash ~ '^[0-9a-f]{64}$');

create or replace function private.guard_audit_idempotency_key()
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
    and v_existing.request_hash is not distinct from new.request_hash
    and v_existing.after_state is not distinct from new.after_state then
    return null;
  end if;

  raise exception using errcode = '23505', message = 'IDEMPOTENCY_KEY_REUSED';
end;
$$;

create table private.command_executions (
  id uuid primary key default gen_random_uuid(),
  actor_profile_id uuid not null references public.profiles(id) on delete restrict,
  command_type text not null,
  idempotency_key text not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  entity_id uuid,
  response_payload jsonb not null,
  completed_at timestamptz not null default now(),
  unique (actor_profile_id, command_type, idempotency_key)
);

revoke all on table private.command_executions from public, anon, authenticated;
grant select, insert on table private.command_executions to service_role;

create type public.preparation_obligation_status as enum (
  'pending',
  'approved',
  'invalidated',
  'cancelled'
);

create type public.checkout_obligation_status as enum (
  'private',
  'available',
  'materialized',
  'completed',
  'cancelled'
);

alter table public.reservations
  add column actual_check_in_at timestamptz;

update public.reservations
set actual_check_in_at = check_in_at
where status = 'checked_out'
  and actual_checkout_at is not null
  and actual_check_in_at is null;

alter table public.reservations
  drop constraint reservations_status_timestamps_check,
  drop constraint reservations_check,
  add constraint reservations_minimum_stay_check check (
    (check_out_at at time zone 'Asia/Seoul')::date
      > (check_in_at at time zone 'Asia/Seoul')::date
  ),
  add constraint reservations_minute_precision_check check (
    check_in_at = date_trunc('minute', check_in_at)
    and check_out_at = date_trunc('minute', check_out_at)
  ),
  add constraint reservations_status_timestamps_check check (
    (
      status = 'active'
      and cancelled_at is null
      and actual_checkout_at is null
      and (actual_check_in_at is null or actual_check_in_at >= check_in_at)
    )
    or (
      status = 'cancelled'
      and cancelled_at is not null
      and actual_check_in_at is null
      and actual_checkout_at is null
    )
    or (
      status = 'checked_out'
      and cancelled_at is null
      and actual_checkout_at is not null
      and (
        actual_check_in_at is null
        or actual_checkout_at >= actual_check_in_at
      )
    )
  );

create table public.reservation_schedule_revisions (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations(id) on delete restrict,
  version bigint not null check (version > 0),
  room_id uuid not null references public.rooms(id) on delete restrict,
  check_in_at timestamptz not null,
  check_out_at timestamptz not null,
  guest_count integer not null check (guest_count > 0),
  reason_code text not null,
  actor_profile_id uuid not null references public.profiles(id) on delete restrict,
  effective_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  unique (reservation_id, version),
  check (
    (check_out_at at time zone 'Asia/Seoul')::date
      > (check_in_at at time zone 'Asia/Seoul')::date
  )
);

insert into public.reservation_schedule_revisions (
  reservation_id,
  version,
  room_id,
  check_in_at,
  check_out_at,
  guest_count,
  reason_code,
  actor_profile_id,
  effective_at,
  recorded_at
)
select
  r.id,
  r.version,
  r.room_id,
  r.check_in_at,
  r.check_out_at,
  r.guest_count,
  'MIGRATION_BASELINE',
  r.updated_by,
  r.updated_at,
  r.updated_at
from public.reservations r;

create table public.preparation_obligations (
  id uuid primary key,
  reservation_id uuid not null unique references public.reservations(id) on delete restrict,
  room_id uuid not null references public.rooms(id) on delete restrict,
  status public.preparation_obligation_status not null default 'pending',
  current_attempt_id uuid references public.cleaning_attempts(id) on delete restrict,
  approved_submission_id uuid unique references public.cleaning_submissions(id) on delete restrict,
  version bigint not null default 1 check (version > 0),
  invalidated_reason_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, reservation_id, room_id),
  check (
    (
      status = 'approved'
      and current_attempt_id is not null
      and approved_submission_id is not null
    )
    or (status <> 'approved' and approved_submission_id is null)
  )
);

insert into public.preparation_obligations (
  id,
  reservation_id,
  room_id,
  status,
  created_at,
  updated_at
)
select
  r.preparation_obligation_id,
  r.id,
  r.room_id,
  case
    when r.status = 'cancelled' then 'cancelled'::public.preparation_obligation_status
    else 'pending'::public.preparation_obligation_status
  end,
  r.created_at,
  r.updated_at
from public.reservations r;

alter table public.reservations
  add constraint reservations_preparation_obligation_contract_fk
  foreign key (preparation_obligation_id, id, room_id)
  references public.preparation_obligations (id, reservation_id, room_id)
  deferrable initially deferred;

create table public.checkout_cleaning_obligations (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null unique references public.reservations(id) on delete restrict,
  room_id uuid not null references public.rooms(id) on delete restrict,
  status public.checkout_obligation_status not null default 'private',
  original_service_date date not null,
  effective_service_date date not null,
  available_from timestamptz not null,
  due_at timestamptz,
  current_cleaning_target_id uuid unique references public.cleaning_targets(id) on delete restrict,
  version bigint not null default 1 check (version > 0),
  cancelled_at timestamptz,
  cancellation_reason_code text,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, reservation_id, room_id),
  check (
    (status = 'cancelled' and cancelled_at is not null and cancellation_reason_code is not null)
    or (status <> 'cancelled' and cancelled_at is null and cancellation_reason_code is null)
  )
);

insert into public.checkout_cleaning_obligations (
  reservation_id,
  room_id,
  status,
  original_service_date,
  effective_service_date,
  available_from,
  current_cleaning_target_id,
  cancelled_at,
  cancellation_reason_code,
  created_by,
  created_at,
  updated_at
)
select
  r.id,
  r.room_id,
  case
    when r.status = 'cancelled' then 'cancelled'::public.checkout_obligation_status
    when t.status = 'approved' then 'completed'::public.checkout_obligation_status
    when t.id is not null then 'materialized'::public.checkout_obligation_status
    when r.status = 'checked_out' then 'available'::public.checkout_obligation_status
    else 'private'::public.checkout_obligation_status
  end,
  (r.check_out_at at time zone 'Asia/Seoul')::date,
  (r.check_out_at at time zone 'Asia/Seoul')::date,
  coalesce(r.actual_checkout_at, r.check_out_at),
  t.id,
  r.cancelled_at,
  case when r.status = 'cancelled' then 'MIGRATION_CANCELLED_RESERVATION' end,
  r.created_by,
  r.created_at,
  r.updated_at
from public.reservations r
left join lateral (
  select ct.id, ct.status
  from public.cleaning_targets ct
  where r.status <> 'cancelled'
    and ct.reservation_id = r.id
    and ct.cleaning_kind = 'checkout'
    and ct.status <> 'cancelled'
  order by ct.created_at desc, ct.id desc
  limit 1
) t on true;

alter table public.checkout_cleaning_obligations
  add constraint checkout_obligation_status_target_check check (
    (status in ('materialized', 'completed') and current_cleaning_target_id is not null)
    or (status in ('private', 'available') and current_cleaning_target_id is null)
    or status = 'cancelled'
  );

alter table public.reservations
  add column checkout_obligation_id uuid not null default gen_random_uuid();

update public.reservations r
set checkout_obligation_id = o.id
from public.checkout_cleaning_obligations o
where o.reservation_id = r.id;

alter table public.reservations
  add constraint reservations_checkout_obligation_contract_fk
  foreign key (checkout_obligation_id, id, room_id)
  references public.checkout_cleaning_obligations (id, reservation_id, room_id)
  deferrable initially deferred;

alter table public.cleaning_targets
  add column checkout_obligation_id uuid unique
  references public.checkout_cleaning_obligations(id) on delete restrict;

update public.cleaning_targets ct
set checkout_obligation_id = o.id
from public.checkout_cleaning_obligations o
where ct.reservation_id = o.reservation_id
  and ct.cleaning_kind = 'checkout';

alter table public.cleaning_targets
  add constraint cleaning_targets_id_checkout_contract_unique
    unique (id, checkout_obligation_id, reservation_id, room_id),
  add constraint cleaning_targets_checkout_obligation_shape_check check (
    (
      cleaning_kind = 'checkout'
      and reservation_id is not null
      and checkout_obligation_id is not null
    )
    or (
      cleaning_kind <> 'checkout'
      and checkout_obligation_id is null
    )
  ),
  add constraint cleaning_targets_checkout_obligation_contract_fk
    foreign key (checkout_obligation_id, reservation_id, room_id)
    references public.checkout_cleaning_obligations (id, reservation_id, room_id)
    on delete restrict
    deferrable initially deferred;

alter table public.checkout_cleaning_obligations
  add constraint checkout_obligations_current_target_contract_fk
    foreign key (current_cleaning_target_id, id, reservation_id, room_id)
    references public.cleaning_targets (
      id,
      checkout_obligation_id,
      reservation_id,
      room_id
    )
    on delete restrict
    deferrable initially deferred;

alter table public.cleaning_submissions
  add constraint cleaning_submissions_id_attempt_unique
    unique (id, cleaning_attempt_id);

alter table public.preparation_obligations
  add constraint preparation_obligations_submission_attempt_fk
    foreign key (approved_submission_id, current_attempt_id)
    references public.cleaning_submissions (id, cleaning_attempt_id)
    on delete restrict
    deferrable initially deferred;

create table private.preparation_proof_usages (
  id uuid primary key default gen_random_uuid(),
  preparation_obligation_id uuid not null
    references public.preparation_obligations(id) on delete restrict,
  reservation_id uuid not null references public.reservations(id) on delete restrict,
  room_id uuid not null references public.rooms(id) on delete restrict,
  approved_submission_id uuid not null unique,
  cleaning_attempt_id uuid not null,
  recorded_at timestamptz not null default now(),
  foreign key (preparation_obligation_id, reservation_id, room_id)
    references public.preparation_obligations (id, reservation_id, room_id)
    on delete restrict,
  foreign key (approved_submission_id, cleaning_attempt_id)
    references public.cleaning_submissions (id, cleaning_attempt_id)
    on delete restrict
);

create index preparation_proof_usages_obligation_idx
on private.preparation_proof_usages (
  preparation_obligation_id,
  reservation_id,
  room_id,
  recorded_at desc
);
create index preparation_proof_usages_reservation_idx
on private.preparation_proof_usages (reservation_id);
create index preparation_proof_usages_room_idx
on private.preparation_proof_usages (room_id);
create index preparation_proof_usages_submission_attempt_idx
on private.preparation_proof_usages (approved_submission_id, cleaning_attempt_id);
create index preparation_proof_usages_attempt_idx
on private.preparation_proof_usages (cleaning_attempt_id);

revoke all on table private.preparation_proof_usages from public, anon, authenticated;
grant select, insert on table private.preparation_proof_usages to service_role;

create table public.room_occupancy_events (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique,
  room_id uuid not null references public.rooms(id) on delete restrict,
  reservation_id uuid not null references public.reservations(id) on delete restrict,
  event_type text not null check (event_type in (
    'scheduled_check_in',
    'manual_checkout',
    'scheduled_checkout',
    'occupancy_resumed',
    'occupancy_correction'
  )),
  effective_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  actor_profile_id uuid not null references public.profiles(id) on delete restrict,
  reason_code text not null,
  before_state jsonb,
  after_state jsonb not null
);

insert into public.room_occupancy_events (
  event_key,
  room_id,
  reservation_id,
  event_type,
  effective_at,
  recorded_at,
  actor_profile_id,
  reason_code,
  after_state
)
select
  'migration:checked_out:' || r.id::text,
  r.room_id,
  r.id,
  'occupancy_correction',
  r.actual_checkout_at,
  r.updated_at,
  r.updated_by,
  'MIGRATION_BASELINE',
  jsonb_build_object('occupied', false)
from public.reservations r
where r.status = 'checked_out'
  and r.actual_checkout_at is not null;

create table public.room_operation_blocks (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete restrict,
  reason_code text not null,
  starts_at timestamptz not null,
  ends_at timestamptz,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  released_by uuid references public.profiles(id) on delete restrict,
  released_at timestamptz,
  release_reason_code text,
  version bigint not null default 1 check (version > 0),
  check (ends_at is null or ends_at > starts_at),
  check (
    (released_at is null and released_by is null and release_reason_code is null)
    or (released_at is not null and released_by is not null and release_reason_code is not null)
  )
);

create table public.room_issues (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete restrict,
  category text not null,
  severity text not null check (severity in ('info', 'warning', 'critical')),
  blocks_guest_assignment boolean not null default false,
  description text,
  status text not null default 'open' check (status in ('open', 'resolved')),
  reported_by uuid not null references public.profiles(id) on delete restrict,
  reported_at timestamptz not null default now(),
  resolved_by uuid references public.profiles(id) on delete restrict,
  resolved_at timestamptz,
  resolution_reason_code text,
  version bigint not null default 1 check (version > 0),
  check (
    (status = 'open' and resolved_by is null and resolved_at is null and resolution_reason_code is null)
    or (
      status = 'resolved'
      and resolved_by is not null
      and resolved_at is not null
      and resolution_reason_code is not null
    )
  )
);

create table public.room_candle_events (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete restrict,
  count_before integer not null check (count_before >= 0),
  count_after integer not null check (count_after >= 0),
  physically_verified boolean not null default false,
  reason_code text not null,
  actor_profile_id uuid not null references public.profiles(id) on delete restrict,
  effective_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  check (count_after >= count_before or physically_verified)
);

create table public.room_pin_sync_events (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete restrict,
  sync_status text not null check (sync_status in ('verified', 'mismatch', 'unconfigured')),
  pin_version bigint check (pin_version is null or pin_version > 0),
  reason_code text not null,
  actor_profile_id uuid not null references public.profiles(id) on delete restrict,
  effective_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  check ((sync_status = 'verified' and pin_version is not null) or sync_status <> 'verified')
);

alter table public.cleaning_targets
  add constraint cleaning_targets_id_room_unique unique (id, room_id),
  add constraint cleaning_targets_id_reservation_unique unique (id, reservation_id);

alter table public.cleaning_assignments
  add constraint cleaning_assignments_id_target_maid_unique
    unique (id, cleaning_target_id, maid_profile_id);

alter table public.cleaning_attempts
  add constraint cleaning_attempts_pin_lease_contract_unique
    unique (id, assignment_id, cleaning_target_id, maid_profile_id);

create table public.room_pin_access_leases (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete restrict,
  reservation_id uuid references public.reservations(id) on delete restrict,
  cleaning_target_id uuid not null references public.cleaning_targets(id) on delete restrict,
  assignment_id uuid not null references public.cleaning_assignments(id) on delete restrict,
  attempt_id uuid not null references public.cleaning_attempts(id) on delete restrict,
  pin_version bigint not null check (pin_version > 0),
  issued_to uuid not null references public.profiles(id) on delete restrict,
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  revealed_at timestamptz,
  revoked_at timestamptz,
  revoke_reason_code text,
  check (expires_at > issued_at),
  check (revealed_at is null or (revealed_at >= issued_at and revealed_at < expires_at)),
  check (revoked_at is null or revoked_at >= issued_at),
  check ((revoked_at is null and revoke_reason_code is null) or (revoked_at is not null and revoke_reason_code is not null))
);

alter table public.room_pin_access_leases
  add constraint room_pin_leases_target_room_fk
    foreign key (cleaning_target_id, room_id)
    references public.cleaning_targets (id, room_id)
    on delete restrict,
  add constraint room_pin_leases_target_reservation_fk
    foreign key (cleaning_target_id, reservation_id)
    references public.cleaning_targets (id, reservation_id)
    on delete restrict,
  add constraint room_pin_leases_assignment_contract_fk
    foreign key (assignment_id, cleaning_target_id, issued_to)
    references public.cleaning_assignments (id, cleaning_target_id, maid_profile_id)
    on delete restrict,
  add constraint room_pin_leases_attempt_contract_fk
    foreign key (attempt_id, assignment_id, cleaning_target_id, issued_to)
    references public.cleaning_attempts (
      id,
      assignment_id,
      cleaning_target_id,
      maid_profile_id
    )
    on delete restrict;

create function private.enforce_preparation_proof_contract()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_attempt_room_id uuid;
  v_check_in_at timestamptz;
  v_required_clean_after_at timestamptz;
begin
  select r.check_in_at into v_check_in_at
  from public.reservations r
  where r.id = new.reservation_id
    and r.room_id = new.room_id;

  if not found then
    raise exception using errcode = '23514', message = 'PREPARATION_RESERVATION_ROOM_MISMATCH';
  end if;

  select coalesce(
    max(coalesce(r.actual_checkout_at, r.check_out_at)),
    new.created_at
  ) into v_required_clean_after_at
  from public.reservations r
  where r.room_id = new.room_id
    and r.id <> new.reservation_id
    and r.status <> 'cancelled'
    and r.check_in_at < v_check_in_at;

  if new.current_attempt_id is not null then
    select t.room_id into v_attempt_room_id
    from public.cleaning_attempts a
    join public.cleaning_targets t on t.id = a.cleaning_target_id
    where a.id = new.current_attempt_id;

    if not found or v_attempt_room_id <> new.room_id then
      raise exception using errcode = '23514', message = 'PREPARATION_ATTEMPT_ROOM_MISMATCH';
    end if;
  end if;

  if new.status = 'approved' and not exists (
    select 1
    from public.cleaning_submissions s
    join public.inspection_decisions d on d.submission_id = s.id
    join public.cleaning_attempts a on a.id = s.cleaning_attempt_id
    join public.cleaning_targets t on t.id = a.cleaning_target_id
    where s.id = new.approved_submission_id
      and s.cleaning_attempt_id = new.current_attempt_id
      and s.status = 'approved'
      and d.decision = 'approved'
      and t.room_id = new.room_id
      and t.status = 'approved'
      and t.available_from is not null
      and t.available_from >= v_required_clean_after_at
      and d.decided_at >= t.available_from
      and d.decided_at >= v_required_clean_after_at
      and d.decided_at <= v_check_in_at
  ) then
    raise exception using errcode = '23514', message = 'PREPARATION_APPROVAL_PROOF_REQUIRED';
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_preparation_proof_contract() from public;

create trigger preparation_obligations_enforce_proof
before insert or update of room_id, status, current_attempt_id, approved_submission_id
on public.preparation_obligations
for each row execute function private.enforce_preparation_proof_contract();

create function private.record_preparation_proof_usage()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_existing_obligation_id uuid;
begin
  if new.status <> 'approved' then
    return new;
  end if;

  select u.preparation_obligation_id into v_existing_obligation_id
  from private.preparation_proof_usages u
  where u.approved_submission_id = new.approved_submission_id;

  if found then
    if v_existing_obligation_id <> new.id then
      raise exception using errcode = '23514', message = 'PREPARATION_PROOF_ALREADY_USED';
    end if;
    return new;
  end if;

  insert into private.preparation_proof_usages (
    preparation_obligation_id,
    reservation_id,
    room_id,
    approved_submission_id,
    cleaning_attempt_id
  ) values (
    new.id,
    new.reservation_id,
    new.room_id,
    new.approved_submission_id,
    new.current_attempt_id
  );

  return new;
end;
$$;

revoke all on function private.record_preparation_proof_usage() from public;

create trigger preparation_obligations_record_proof_usage
after insert or update of status, current_attempt_id, approved_submission_id
on public.preparation_obligations
for each row execute function private.record_preparation_proof_usage();

create function private.invalidate_stale_preparation_proofs(
  p_room_id uuid,
  p_reason_code text
)
returns void
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  update public.preparation_obligations o
  set status = 'invalidated',
      approved_submission_id = null,
      invalidated_reason_code = p_reason_code,
      version = o.version + 1
  from public.reservations current_reservation
  where current_reservation.id = o.reservation_id
    and current_reservation.room_id = p_room_id
    and current_reservation.status = 'active'
    and o.status = 'approved'
    and not exists (
      select 1
      from public.cleaning_submissions s
      join public.inspection_decisions d on d.submission_id = s.id
      join public.cleaning_attempts a on a.id = s.cleaning_attempt_id
      join public.cleaning_targets t on t.id = a.cleaning_target_id
      where s.id = o.approved_submission_id
        and s.cleaning_attempt_id = o.current_attempt_id
        and s.status = 'approved'
        and d.decision = 'approved'
        and t.room_id = o.room_id
        and t.status = 'approved'
        and t.available_from is not null
        and t.available_from >= coalesce((
          select max(coalesce(previous_reservation.actual_checkout_at, previous_reservation.check_out_at))
          from public.reservations previous_reservation
          where previous_reservation.room_id = current_reservation.room_id
            and previous_reservation.id <> current_reservation.id
            and previous_reservation.status <> 'cancelled'
            and previous_reservation.check_in_at < current_reservation.check_in_at
        ), o.created_at)
        and d.decided_at >= t.available_from
        and d.decided_at >= coalesce((
          select max(coalesce(previous_reservation.actual_checkout_at, previous_reservation.check_out_at))
          from public.reservations previous_reservation
          where previous_reservation.room_id = current_reservation.room_id
            and previous_reservation.id <> current_reservation.id
            and previous_reservation.status <> 'cancelled'
            and previous_reservation.check_in_at < current_reservation.check_in_at
        ), o.created_at)
        and d.decided_at <= current_reservation.check_in_at
    );
end;
$$;

revoke all on function private.invalidate_stale_preparation_proofs(uuid, text) from public;

create function private.enforce_checkout_obligation_target_state()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_target public.cleaning_targets%rowtype;
begin
  if new.current_cleaning_target_id is null then
    return new;
  end if;

  select * into v_target
  from public.cleaning_targets t
  where t.id = new.current_cleaning_target_id;

  if not found
    or v_target.checkout_obligation_id <> new.id
    or v_target.reservation_id <> new.reservation_id
    or v_target.room_id <> new.room_id
    or v_target.cleaning_kind <> 'checkout' then
    raise exception using errcode = '23514', message = 'CHECKOUT_TARGET_CONTRACT_MISMATCH';
  end if;

  if new.status = 'completed' and v_target.status <> 'approved' then
    raise exception using errcode = '23514', message = 'CHECKOUT_COMPLETION_PROOF_REQUIRED';
  elsif new.status = 'cancelled' and v_target.status <> 'cancelled' then
    raise exception using errcode = '23514', message = 'CHECKOUT_CANCELLATION_TARGET_MISMATCH';
  elsif new.status = 'materialized' and v_target.status in ('approved', 'cancelled') then
    raise exception using errcode = '23514', message = 'CHECKOUT_TERMINAL_TARGET_STATUS_MISMATCH';
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_checkout_obligation_target_state() from public;

create trigger checkout_obligations_enforce_target_state
before insert or update of status, current_cleaning_target_id, reservation_id, room_id
on public.checkout_cleaning_obligations
for each row execute function private.enforce_checkout_obligation_target_state();

create function private.prevent_terminal_checkout_target_regression()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if exists (
    select 1
    from public.checkout_cleaning_obligations o
    where o.current_cleaning_target_id = old.id
      and (
        (o.status = 'completed' and new.status <> 'approved')
        or (o.status = 'cancelled' and new.status <> 'cancelled')
        or new.checkout_obligation_id is distinct from o.id
        or new.reservation_id is distinct from o.reservation_id
        or new.room_id is distinct from o.room_id
        or new.cleaning_kind <> 'checkout'
      )
  ) then
    raise exception using errcode = '23514', message = 'TERMINAL_CHECKOUT_TARGET_IMMUTABLE';
  end if;

  return new;
end;
$$;

revoke all on function private.prevent_terminal_checkout_target_regression() from public;

create trigger cleaning_targets_preserve_terminal_checkout_contract
before update of status, checkout_obligation_id, reservation_id, room_id, cleaning_kind
on public.cleaning_targets
for each row execute function private.prevent_terminal_checkout_target_regression();

create function private.validate_checkout_obligation_target_at_commit()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_obligation_id uuid;
begin
  if tg_table_name = 'checkout_cleaning_obligations' then
    v_obligation_id := new.id;
  else
    select o.id into v_obligation_id
    from public.checkout_cleaning_obligations o
    where o.current_cleaning_target_id = new.id;

    if not found then
      return null;
    end if;
  end if;

  if exists (
    select 1
    from public.checkout_cleaning_obligations o
    left join public.cleaning_targets t on t.id = o.current_cleaning_target_id
    where o.id = v_obligation_id
      and (
        (o.status = 'materialized' and t.status in ('approved', 'cancelled'))
        or (o.status = 'completed' and t.status is distinct from 'approved')
        or (
          o.status = 'cancelled'
          and o.current_cleaning_target_id is not null
          and t.status is distinct from 'cancelled'
        )
      )
  ) then
    raise exception using errcode = '23514', message = 'CHECKOUT_TERMINAL_CONTRACT_NOT_ATOMIC';
  end if;

  return null;
end;
$$;

revoke all on function private.validate_checkout_obligation_target_at_commit() from public;

create constraint trigger checkout_obligations_validate_terminal_contract
after insert or update on public.checkout_cleaning_obligations
deferrable initially deferred
for each row execute function private.validate_checkout_obligation_target_at_commit();

create constraint trigger cleaning_targets_validate_checkout_terminal_contract
after insert or update on public.cleaning_targets
deferrable initially deferred
for each row execute function private.validate_checkout_obligation_target_at_commit();

create function private.enforce_pin_lease_contract()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_target_reservation_id uuid;
  v_assignment_is_current boolean;
  v_attempt_status public.attempt_status;
  v_current_pin_version bigint;
  v_current_pin_status text;
begin
  select
    t.reservation_id,
    a.is_current,
    ca.status
  into
    v_target_reservation_id,
    v_assignment_is_current,
    v_attempt_status
  from public.cleaning_targets t
  join public.cleaning_assignments a
    on a.id = new.assignment_id
    and a.cleaning_target_id = t.id
    and a.maid_profile_id = new.issued_to
  join public.cleaning_attempts ca
    on ca.id = new.attempt_id
    and ca.assignment_id = a.id
    and ca.cleaning_target_id = t.id
    and ca.maid_profile_id = new.issued_to
  where t.id = new.cleaning_target_id
    and t.room_id = new.room_id;

  if not found or v_target_reservation_id is distinct from new.reservation_id then
    raise exception using errcode = '23514', message = 'PIN_LEASE_WORK_CONTRACT_MISMATCH';
  end if;

  if new.revoked_at is null then
    if not v_assignment_is_current
      or v_attempt_status not in (
        'scheduled',
        'in_progress',
        'field_completed',
        'upload_pending',
        'submitted'
      ) then
      raise exception using errcode = '23514', message = 'PIN_LEASE_CURRENT_WORK_REQUIRED';
    end if;

    select e.sync_status, e.pin_version
    into v_current_pin_status, v_current_pin_version
    from public.room_pin_sync_events e
    where e.room_id = new.room_id
    order by e.effective_at desc, e.recorded_at desc, e.id desc
    limit 1;

    if v_current_pin_status is distinct from 'verified'
      or v_current_pin_version is distinct from new.pin_version then
      raise exception using errcode = '23514', message = 'PIN_LEASE_VERSION_MISMATCH';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_pin_lease_contract() from public;

create trigger room_pin_access_leases_enforce_contract
before insert or update of
  room_id,
  reservation_id,
  cleaning_target_id,
  assignment_id,
  attempt_id,
  pin_version,
  issued_to,
  revoked_at
on public.room_pin_access_leases
for each row execute function private.enforce_pin_lease_contract();

create table public.cleaning_target_schedule_revisions (
  id uuid primary key default gen_random_uuid(),
  cleaning_target_id uuid not null references public.cleaning_targets(id) on delete restrict,
  revision bigint not null check (revision > 0),
  effective_service_date date not null,
  available_from timestamptz,
  due_at timestamptz,
  reason_code text not null,
  changed_by uuid not null references public.profiles(id) on delete restrict,
  recorded_at timestamptz not null default now(),
  unique (cleaning_target_id, revision)
);

insert into public.cleaning_target_schedule_revisions (
  cleaning_target_id,
  revision,
  effective_service_date,
  available_from,
  due_at,
  reason_code,
  changed_by,
  recorded_at
)
select
  t.id,
  t.assignment_version,
  t.effective_service_date,
  t.available_from,
  t.due_at,
  'MIGRATION_BASELINE',
  t.created_by,
  t.updated_at
from public.cleaning_targets t;

-- Remove only known demo snapshot values. Operator-authored records are not touched.
update public.rooms
set occupancy_override = null,
    occupancy_override_reason = null,
    state_version = state_version + 1
where occupancy_override_reason = '2026-08 initial occupied seed';

update public.rooms
set data_status = 'verified',
    data_status_reason = null,
    state_version = state_version + 1
where room_number = '762'
  and data_status = 'verification_required'
  and data_status_reason = '현재 투숙 상태 확인 필요';

create index reservation_schedule_revisions_reservation_idx
on public.reservation_schedule_revisions (reservation_id, version desc);

create index reservation_schedule_revisions_room_idx
on public.reservation_schedule_revisions (room_id, check_in_at, check_out_at);

create index reservation_schedule_revisions_actor_idx
on public.reservation_schedule_revisions (actor_profile_id);

create index reservations_preparation_obligation_contract_idx
on public.reservations (preparation_obligation_id, id, room_id);

create index reservations_checkout_obligation_contract_idx
on public.reservations (checkout_obligation_id, id, room_id);

create index preparation_obligations_room_idx
on public.preparation_obligations (room_id, status);

create index preparation_obligations_current_attempt_idx
on public.preparation_obligations (current_attempt_id)
where current_attempt_id is not null;

create index preparation_obligations_submission_attempt_contract_idx
on public.preparation_obligations (approved_submission_id, current_attempt_id);

create index checkout_cleaning_obligations_room_idx
on public.checkout_cleaning_obligations (room_id, status, effective_service_date);

create index checkout_obligations_current_target_contract_idx
on public.checkout_cleaning_obligations (
  current_cleaning_target_id,
  id,
  reservation_id,
  room_id
);

create index checkout_cleaning_obligations_created_by_idx
on public.checkout_cleaning_obligations (created_by);

create index cleaning_targets_checkout_obligation_contract_idx
on public.cleaning_targets (checkout_obligation_id, reservation_id, room_id);

create index room_occupancy_events_room_idx
on public.room_occupancy_events (room_id, effective_at desc, recorded_at desc);

create index room_occupancy_events_reservation_idx
on public.room_occupancy_events (reservation_id, recorded_at desc);

create index room_occupancy_events_actor_idx
on public.room_occupancy_events (actor_profile_id);

create index room_operation_blocks_active_idx
on public.room_operation_blocks (room_id, starts_at, ends_at)
where released_at is null;

create index room_operation_blocks_created_by_idx
on public.room_operation_blocks (created_by);

create index room_operation_blocks_released_by_idx
on public.room_operation_blocks (released_by)
where released_by is not null;

create index room_issues_open_idx
on public.room_issues (room_id, blocks_guest_assignment)
where status = 'open';

create index room_issues_reported_by_idx on public.room_issues (reported_by);
create index room_issues_resolved_by_idx on public.room_issues (resolved_by) where resolved_by is not null;
create index room_candle_events_room_idx on public.room_candle_events (room_id, recorded_at desc);
create index room_candle_events_actor_idx on public.room_candle_events (actor_profile_id);
create index room_pin_sync_events_room_idx on public.room_pin_sync_events (room_id, recorded_at desc);
create index room_pin_sync_events_actor_idx on public.room_pin_sync_events (actor_profile_id);
create index room_pin_access_leases_room_idx on public.room_pin_access_leases (room_id, expires_at);
create index room_pin_access_leases_reservation_idx on public.room_pin_access_leases (reservation_id) where reservation_id is not null;
create index room_pin_access_leases_target_idx on public.room_pin_access_leases (cleaning_target_id) where cleaning_target_id is not null;
create index room_pin_access_leases_assignment_idx on public.room_pin_access_leases (assignment_id) where assignment_id is not null;
create index room_pin_access_leases_issued_to_idx on public.room_pin_access_leases (issued_to);
create index room_pin_leases_target_room_contract_idx
on public.room_pin_access_leases (cleaning_target_id, room_id);
create index room_pin_leases_target_reservation_contract_idx
on public.room_pin_access_leases (cleaning_target_id, reservation_id);
create index room_pin_leases_assignment_contract_idx
on public.room_pin_access_leases (assignment_id, cleaning_target_id, issued_to);
create index room_pin_leases_attempt_contract_idx
on public.room_pin_access_leases (attempt_id, assignment_id, cleaning_target_id, issued_to);
create index cleaning_target_schedule_revisions_target_idx
on public.cleaning_target_schedule_revisions (cleaning_target_id, revision desc);
create index cleaning_target_schedule_revisions_changed_by_idx
on public.cleaning_target_schedule_revisions (changed_by);

create function private.prevent_append_only_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception using errcode = '55000', message = 'APPEND_ONLY_LEDGER';
end;
$$;

revoke all on function private.prevent_append_only_mutation() from public;

create function private.prevent_consumed_preparation_proof_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, public, private
as $$
begin
  if (
    tg_table_name = 'cleaning_targets'
    and exists (
      select 1
      from private.preparation_proof_usages u
      join public.cleaning_attempts a on a.id = u.cleaning_attempt_id
      where a.cleaning_target_id = old.id
    )
  ) or (
    tg_table_name = 'cleaning_attempts'
    and exists (
      select 1
      from private.preparation_proof_usages u
      where u.cleaning_attempt_id = old.id
    )
  ) or (
    tg_table_name = 'cleaning_submissions'
    and exists (
      select 1
      from private.preparation_proof_usages u
      where u.approved_submission_id = old.id
    )
  ) then
    raise exception using errcode = '55000', message = 'CONSUMED_PREPARATION_PROOF_IMMUTABLE';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;

revoke all on function private.prevent_consumed_preparation_proof_mutation() from public;

create trigger audit_events_append_only
before update or delete on public.audit_events
for each row execute function private.prevent_append_only_mutation();

create trigger reservation_schedule_revisions_append_only
before update or delete on public.reservation_schedule_revisions
for each row execute function private.prevent_append_only_mutation();

create trigger room_occupancy_events_append_only
before update or delete on public.room_occupancy_events
for each row execute function private.prevent_append_only_mutation();

create trigger room_candle_events_append_only
before update or delete on public.room_candle_events
for each row execute function private.prevent_append_only_mutation();

create trigger room_pin_sync_events_append_only
before update or delete on public.room_pin_sync_events
for each row execute function private.prevent_append_only_mutation();

create trigger cleaning_target_schedule_revisions_append_only
before update or delete on public.cleaning_target_schedule_revisions
for each row execute function private.prevent_append_only_mutation();

create trigger inspection_decisions_append_only
before update or delete on public.inspection_decisions
for each row execute function private.prevent_append_only_mutation();

create trigger preparation_proof_usages_append_only
before update or delete on private.preparation_proof_usages
for each row execute function private.prevent_append_only_mutation();

create trigger consumed_preparation_target_immutable
before update or delete on public.cleaning_targets
for each row execute function private.prevent_consumed_preparation_proof_mutation();

create trigger consumed_preparation_attempt_immutable
before update or delete on public.cleaning_attempts
for each row execute function private.prevent_consumed_preparation_proof_mutation();

create trigger consumed_preparation_submission_immutable
before update or delete on public.cleaning_submissions
for each row execute function private.prevent_consumed_preparation_proof_mutation();

create trigger preparation_obligations_set_updated_at
before update on public.preparation_obligations
for each row execute function private.set_updated_at();

create trigger checkout_cleaning_obligations_set_updated_at
before update on public.checkout_cleaning_obligations
for each row execute function private.set_updated_at();

create function private.assert_active_actor(p_actor_profile_id uuid)
returns public.app_role
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role public.app_role;
begin
  select p.role into v_role
  from public.profiles p
  where p.id = p_actor_profile_id
    and p.status = 'active'
  for share;

  if not found then
    raise exception using errcode = '42501', message = 'ACTIVE_ACCOUNT_REQUIRED';
  end if;

  return v_role;
end;
$$;

create function private.assert_room_admin(p_actor_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
begin
  if private.assert_active_actor(p_actor_profile_id) <> 'admin' then
    raise exception using errcode = '42501', message = 'ADMIN_REQUIRED';
  end if;
end;
$$;

create function private.replay_command(
  p_actor_profile_id uuid,
  p_command_type text,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_existing private.command_executions%rowtype;
begin
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,128}$' then
    raise exception using errcode = '22023', message = 'INVALID_IDEMPOTENCY_KEY';
  end if;
  if p_request_hash is null or p_request_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'INVALID_REQUEST_HASH';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      p_actor_profile_id::text || ':' || p_command_type || ':' || p_idempotency_key,
      0
    )
  );

  select * into v_existing
  from private.command_executions ce
  where ce.actor_profile_id = p_actor_profile_id
    and ce.command_type = p_command_type
    and ce.idempotency_key = p_idempotency_key;

  if not found then
    return null;
  end if;
  if v_existing.request_hash <> p_request_hash then
    raise exception using errcode = '23505', message = 'IDEMPOTENCY_KEY_REUSED';
  end if;
  return v_existing.response_payload;
end;
$$;

create function private.complete_command(
  p_actor_profile_id uuid,
  p_command_type text,
  p_idempotency_key text,
  p_request_hash text,
  p_entity_id uuid,
  p_response_payload jsonb
)
returns void
language sql
security definer
set search_path = pg_catalog, public, private
as $$
  insert into private.command_executions (
    actor_profile_id,
    command_type,
    idempotency_key,
    request_hash,
    entity_id,
    response_payload
  ) values (
    p_actor_profile_id,
    p_command_type,
    p_idempotency_key,
    p_request_hash,
    p_entity_id,
    p_response_payload
  )
$$;

create function private.audit_command_key(
  p_actor_profile_id uuid,
  p_command_type text,
  p_idempotency_key text
)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select p_actor_profile_id::text || ':' || p_command_type || ':' || p_idempotency_key
$$;

create function private.current_candle_count(p_room_id uuid)
returns integer
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce((
    select e.count_after
    from public.room_candle_events e
    where e.room_id = p_room_id
    order by e.recorded_at desc, e.id desc
    limit 1
  ), 0)
$$;

create function private.current_pin_sync_status(p_room_id uuid)
returns text
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce((
    select e.sync_status
    from public.room_pin_sync_events e
    where e.room_id = p_room_id
    order by e.recorded_at desc, e.id desc
    limit 1
  ), 'unconfigured')
$$;

create function private.room_block_reason_codes(
  p_room_id uuid,
  p_at timestamptz,
  p_include_occupancy boolean default true,
  p_include_cleaning boolean default true,
  p_preparation_reservation_id uuid default null
)
returns text[]
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_reasons text[] := array[]::text[];
  v_room public.rooms%rowtype;
  v_pin_status text;
begin
  select * into v_room from public.rooms where id = p_room_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'ROOM_NOT_FOUND';
  end if;

  if p_include_occupancy and exists (
    select 1
    from public.reservations r
    where r.room_id = p_room_id
      and r.status = 'active'
      and r.actual_check_in_at is not null
      and r.actual_check_in_at <= p_at
      and r.actual_checkout_at is null
  ) then
    v_reasons := array_append(v_reasons, 'OCCUPIED');
  end if;

  if p_include_cleaning and exists (
    select 1
    from public.preparation_obligations po
    join public.reservations r on r.id = po.reservation_id
    where po.room_id = p_room_id
      and r.status = 'active'
      and (
        p_preparation_reservation_id is null
        or po.reservation_id = p_preparation_reservation_id
      )
      and po.status <> 'approved'
  ) then
    v_reasons := array_append(v_reasons, 'CLEANING_REQUIRED');
  end if;

  if private.current_candle_count(p_room_id) > 0 then
    v_reasons := array_append(v_reasons, 'CANDLE_PRESENT');
  end if;

  if exists (
    select 1
    from public.room_operation_blocks b
    where b.room_id = p_room_id
      and b.released_at is null
      and b.starts_at <= p_at
      and (b.ends_at is null or b.ends_at > p_at)
  ) then
    v_reasons := array_append(v_reasons, 'OPERATION_BLOCKED');
  end if;

  if exists (
    select 1
    from public.room_issues i
    where i.room_id = p_room_id
      and i.status = 'open'
      and i.blocks_guest_assignment
  ) then
    v_reasons := array_append(v_reasons, 'ROOM_ISSUE_BLOCKED');
  end if;

  v_pin_status := private.current_pin_sync_status(p_room_id);
  if v_pin_status = 'mismatch' then
    v_reasons := array_append(v_reasons, 'PIN_MISMATCH');
  elsif v_pin_status = 'unconfigured' then
    v_reasons := array_append(v_reasons, 'DATA_UNCONFIRMED');
  end if;

  if v_room.data_status <> 'verified' and not ('DATA_UNCONFIRMED' = any(v_reasons)) then
    v_reasons := array_append(v_reasons, 'DATA_UNCONFIRMED');
  end if;

  return v_reasons;
end;
$$;

create function private.reservation_response(p_reservation public.reservations)
returns jsonb
language sql
stable
set search_path = pg_catalog
as $$
  select jsonb_build_object(
    'id', p_reservation.id,
    'room_id', p_reservation.room_id,
    'check_in_at', p_reservation.check_in_at,
    'check_out_at', p_reservation.check_out_at,
    'guest_count', p_reservation.guest_count,
    'status', p_reservation.status,
    'preparation_obligation_id', p_reservation.preparation_obligation_id,
    'checkout_obligation_id', p_reservation.checkout_obligation_id,
    'version', p_reservation.version,
    'actual_check_in_at', p_reservation.actual_check_in_at,
    'actual_checkout_at', p_reservation.actual_checkout_at,
    'cancelled_at', p_reservation.cancelled_at,
    'created_at', p_reservation.created_at,
    'updated_at', p_reservation.updated_at
  )
$$;

create function public.get_room_operational_projection(
  p_actor_profile_id uuid,
  p_room_id uuid default null
)
returns table (
  id uuid,
  room_number text,
  room_type_code text,
  room_type_name text,
  elevator_zone text,
  data_status public.data_status,
  state_version bigint,
  occupied boolean,
  cleaning_required boolean,
  candle_count integer,
  pin_sync_status text,
  allocation_blocked boolean,
  allocation_ready boolean,
  reason_codes text[]
)
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
begin
  perform private.assert_room_admin(p_actor_profile_id);

  return query
  select
    r.id,
    r.room_number,
    rt.code,
    rt.name,
    r.elevator_zone,
    r.data_status,
    r.state_version,
    'OCCUPIED' = any(state.reason_codes),
    'CLEANING_REQUIRED' = any(state.reason_codes),
    private.current_candle_count(r.id),
    private.current_pin_sync_status(r.id),
    array_length(state.reason_codes, 1) is not null,
    array_length(state.reason_codes, 1) is null,
    state.reason_codes
  from public.rooms r
  join public.room_types rt on rt.id = r.room_type_id
  cross join lateral (
    select private.room_block_reason_codes(r.id, now(), true, true) as reason_codes
  ) state
  where p_room_id is null or r.id = p_room_id
  order by r.room_number;
end;
$$;

create function public.change_room_master_data(
  p_actor_profile_id uuid,
  p_room_id uuid,
  p_room_type_id uuid,
  p_elevator_zone text,
  p_data_status public.data_status,
  p_data_status_reason text,
  p_expected_version bigint,
  p_reason_code text,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_room public.rooms%rowtype;
  v_before jsonb;
  v_response jsonb;
begin
  perform private.assert_room_admin(p_actor_profile_id);
  v_response := private.replay_command(
    p_actor_profile_id,
    'room.change_master_data',
    p_idempotency_key,
    p_request_hash
  );
  if v_response is not null then
    return v_response;
  end if;

  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'ROOM_NOT_FOUND';
  end if;
  if v_room.state_version <> p_expected_version then
    raise exception using errcode = '40001', message = 'STALE_VERSION';
  end if;
  if not exists (
    select 1 from public.room_types rt where rt.id = p_room_type_id and rt.active
  ) then
    raise exception using errcode = '23514', message = 'ACTIVE_ROOM_TYPE_REQUIRED';
  end if;
  if p_data_status = 'verification_required'
    and nullif(btrim(p_data_status_reason), '') is null then
    raise exception using errcode = '22023', message = 'DATA_STATUS_REASON_REQUIRED';
  end if;

  v_before := jsonb_build_object(
    'roomTypeId', v_room.room_type_id,
    'elevatorZone', v_room.elevator_zone,
    'dataStatus', v_room.data_status,
    'stateVersion', v_room.state_version
  );

  update public.rooms
  set room_type_id = p_room_type_id,
      elevator_zone = p_elevator_zone,
      data_status = p_data_status,
      data_status_reason = case
        when p_data_status = 'verified' then null
        else p_data_status_reason
      end,
      state_version = state_version + 1
  where rooms.id = p_room_id
  returning * into v_room;

  v_response := jsonb_build_object(
    'id', v_room.id,
    'state_version', v_room.state_version,
    'updated_at', v_room.updated_at
  );

  insert into public.audit_events (
    actor_profile_id,
    actor_display_name_snapshot,
    event_type,
    entity_type,
    entity_id,
    effective_at,
    reason_code,
    before_state,
    after_state,
    request_hash,
    idempotency_key
  )
  select
    p.id,
    p.display_name,
    'room.master_data_changed',
    'room',
    v_room.id,
    now(),
    p_reason_code,
    v_before,
    jsonb_build_object(
      'roomTypeId', v_room.room_type_id,
      'elevatorZone', v_room.elevator_zone,
      'dataStatus', v_room.data_status,
      'stateVersion', v_room.state_version
    ),
    p_request_hash,
    private.audit_command_key(p_actor_profile_id, 'room.change_master_data', p_idempotency_key)
  from public.profiles p where p.id = p_actor_profile_id;

  perform private.complete_command(
    p_actor_profile_id,
    'room.change_master_data',
    p_idempotency_key,
    p_request_hash,
    v_room.id,
    v_response
  );
  return v_response;
end;
$$;

create function private.refresh_checkout_due_at(
  p_room_id uuid,
  p_actor_profile_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_item record;
  v_target public.cleaning_targets%rowtype;
begin
  for v_item in
    select
      o.id as obligation_id,
      o.current_cleaning_target_id,
      case
        when next_stay.next_check_in_at is null then null
        else next_stay.next_check_in_at - interval '30 minutes'
      end as desired_due_at
    from public.checkout_cleaning_obligations o
    join public.reservations r on r.id = o.reservation_id
    cross join lateral (
      select (
        select min(next_r.check_in_at)
        from public.reservations next_r
        where next_r.room_id = r.room_id
          and next_r.status = 'active'
          and next_r.check_in_at >= r.check_out_at
          and next_r.id <> r.id
      ) as next_check_in_at
    ) next_stay
    where r.room_id = p_room_id
      and r.status <> 'cancelled'
      and o.status in ('private', 'available', 'materialized')
      and o.due_at is distinct from case
        when next_stay.next_check_in_at is null then null
        else next_stay.next_check_in_at - interval '30 minutes'
      end
    order by r.check_out_at, r.id
  loop
    if v_item.current_cleaning_target_id is not null then
      select * into v_target
      from public.cleaning_targets t
      where t.id = v_item.current_cleaning_target_id
      for update;

      if v_target.status in ('approved', 'cancelled') then
        continue;
      end if;
      if v_target.status <> 'unassigned' then
        raise exception using
          errcode = '23514',
          message = 'CLEANING_DUE_REPLAN_REQUIRED';
      end if;

      update public.cleaning_targets
      set due_at = v_item.desired_due_at,
          assignment_version = assignment_version + 1
      where id = v_target.id
      returning * into v_target;

      insert into public.cleaning_target_schedule_revisions (
        cleaning_target_id,
        revision,
        effective_service_date,
        available_from,
        due_at,
        reason_code,
        changed_by
      ) values (
        v_target.id,
        v_target.assignment_version,
        v_target.effective_service_date,
        v_target.available_from,
        v_target.due_at,
        'NEXT_RESERVATION_CHANGED',
        p_actor_profile_id
      );
    end if;

    update public.checkout_cleaning_obligations
    set due_at = v_item.desired_due_at,
        version = version + 1
    where id = v_item.obligation_id;
  end loop;
end;
$$;

create function public.create_reservation(
  p_actor_profile_id uuid,
  p_reservation_id uuid,
  p_room_id uuid,
  p_check_in_at timestamptz,
  p_check_out_at timestamptz,
  p_guest_count integer,
  p_guest_name_encrypted text,
  p_expected_room_version bigint,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_room public.rooms%rowtype;
  v_reservation public.reservations%rowtype;
  v_preparation_id uuid := gen_random_uuid();
  v_checkout_obligation_id uuid := gen_random_uuid();
  v_assignment_reasons text[];
  v_response jsonb;
begin
  perform private.assert_room_admin(p_actor_profile_id);
  v_response := private.replay_command(
    p_actor_profile_id,
    'reservation.create',
    p_idempotency_key,
    p_request_hash
  );
  if v_response is not null then
    return v_response;
  end if;

  -- Reservation commands share one short transaction lock. The free-plan workload is
  -- small, and a single ordering point prevents room/reservation/obligation deadlocks.
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command', 0));

  if (p_check_out_at at time zone 'Asia/Seoul')::date
      <= (p_check_in_at at time zone 'Asia/Seoul')::date
    or p_check_in_at <> date_trunc('minute', p_check_in_at)
    or p_check_out_at <> date_trunc('minute', p_check_out_at) then
    raise exception using errcode = '22023', message = 'INVALID_RESERVATION_SCHEDULE';
  end if;
  if p_guest_count <= 0 then
    raise exception using errcode = '22023', message = 'INVALID_GUEST_COUNT';
  end if;

  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'ROOM_NOT_FOUND';
  end if;
  if v_room.state_version <> p_expected_room_version then
    raise exception using errcode = '40001', message = 'STALE_VERSION';
  end if;

  v_assignment_reasons := private.room_block_reason_codes(p_room_id, now(), false, false);
  if exists (
    select 1
    from public.room_operation_blocks b
    where b.room_id = p_room_id
      and b.released_at is null
      and b.starts_at < p_check_out_at
      and (b.ends_at is null or b.ends_at > p_check_in_at)
  ) and not ('OPERATION_BLOCKED' = any(v_assignment_reasons)) then
    v_assignment_reasons := array_append(v_assignment_reasons, 'OPERATION_BLOCKED');
  end if;
  if cardinality(v_assignment_reasons) > 0 then
    raise exception using
      errcode = '23514',
      message = 'ROOM_ALLOCATION_BLOCKED',
      detail = array_to_string(v_assignment_reasons, ',');
  end if;

  insert into public.reservations (
    id,
    room_id,
    check_in_at,
    check_out_at,
    guest_count,
    guest_name_encrypted,
    preparation_obligation_id,
    checkout_obligation_id,
    created_by,
    updated_by
  ) values (
    p_reservation_id,
    p_room_id,
    p_check_in_at,
    p_check_out_at,
    p_guest_count,
    p_guest_name_encrypted,
    v_preparation_id,
    v_checkout_obligation_id,
    p_actor_profile_id,
    p_actor_profile_id
  )
  returning * into v_reservation;

  insert into public.preparation_obligations (
    id,
    reservation_id,
    room_id
  ) values (
    v_preparation_id,
    v_reservation.id,
    v_reservation.room_id
  );

  insert into public.checkout_cleaning_obligations (
    id,
    reservation_id,
    room_id,
    original_service_date,
    effective_service_date,
    available_from,
    created_by
  ) values (
    v_checkout_obligation_id,
    v_reservation.id,
    v_reservation.room_id,
    (v_reservation.check_out_at at time zone 'Asia/Seoul')::date,
    (v_reservation.check_out_at at time zone 'Asia/Seoul')::date,
    v_reservation.check_out_at,
    p_actor_profile_id
  );

  insert into public.reservation_schedule_revisions (
    reservation_id,
    version,
    room_id,
    check_in_at,
    check_out_at,
    guest_count,
    reason_code,
    actor_profile_id,
    effective_at
  ) values (
    v_reservation.id,
    v_reservation.version,
    v_reservation.room_id,
    v_reservation.check_in_at,
    v_reservation.check_out_at,
    v_reservation.guest_count,
    'RESERVATION_CREATED',
    p_actor_profile_id,
    now()
  );

  update public.rooms
  set state_version = state_version + 1
  where id = v_reservation.room_id
  returning * into v_room;

  perform private.refresh_checkout_due_at(v_reservation.room_id, p_actor_profile_id);
  perform private.invalidate_stale_preparation_proofs(
    v_reservation.room_id,
    'PREVIOUS_OCCUPANCY_CHANGED'
  );

  v_response := private.reservation_response(v_reservation)
    || jsonb_build_object(
      'room_state_version', v_room.state_version
    );

  insert into public.audit_events (
    actor_profile_id,
    actor_display_name_snapshot,
    event_type,
    entity_type,
    entity_id,
    effective_at,
    reason_code,
    after_state,
    request_hash,
    idempotency_key
  )
  select
    p.id,
    p.display_name,
    'reservation.created',
    'reservation',
    v_reservation.id,
    now(),
    'RESERVATION_CREATED',
    v_response,
    p_request_hash,
    private.audit_command_key(p_actor_profile_id, 'reservation.create', p_idempotency_key)
  from public.profiles p where p.id = p_actor_profile_id;

  perform private.complete_command(
    p_actor_profile_id,
    'reservation.create',
    p_idempotency_key,
    p_request_hash,
    v_reservation.id,
    v_response
  );
  return v_response;
exception
  when exclusion_violation then
    raise exception using errcode = '23P01', message = 'RESERVATION_OVERLAP';
end;
$$;

create function public.change_reservation(
  p_actor_profile_id uuid,
  p_reservation_id uuid,
  p_room_id uuid,
  p_check_in_at timestamptz,
  p_check_out_at timestamptz,
  p_guest_count integer,
  p_guest_name_mode text,
  p_guest_name_encrypted text,
  p_expected_version bigint,
  p_reason_code text,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_reservation public.reservations%rowtype;
  v_updated public.reservations%rowtype;
  v_old_room_id uuid;
  v_checkout_obligation public.checkout_cleaning_obligations%rowtype;
  v_checkout_event_type text;
  v_reopen_occupancy boolean := false;
  v_assignment_reasons text[];
  v_before jsonb;
  v_response jsonb;
begin
  perform private.assert_room_admin(p_actor_profile_id);
  v_response := private.replay_command(
    p_actor_profile_id,
    'reservation.change',
    p_idempotency_key,
    p_request_hash
  );
  if v_response is not null then
    return v_response;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command', 0));

  if (p_check_out_at at time zone 'Asia/Seoul')::date
      <= (p_check_in_at at time zone 'Asia/Seoul')::date
    or p_check_in_at <> date_trunc('minute', p_check_in_at)
    or p_check_out_at <> date_trunc('minute', p_check_out_at) then
    raise exception using errcode = '22023', message = 'INVALID_RESERVATION_SCHEDULE';
  end if;
  if p_guest_count <= 0 then
    raise exception using errcode = '22023', message = 'INVALID_GUEST_COUNT';
  end if;
  if p_guest_name_mode not in ('keep', 'set', 'clear')
    or (p_guest_name_mode = 'set' and p_guest_name_encrypted is null) then
    raise exception using errcode = '22023', message = 'INVALID_GUEST_NAME_MODE';
  end if;

  select * into v_reservation
  from public.reservations
  where id = p_reservation_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'RESERVATION_NOT_FOUND';
  end if;
  if v_reservation.version <> p_expected_version then
    raise exception using errcode = '40001', message = 'STALE_VERSION';
  end if;

  v_old_room_id := v_reservation.room_id;
  perform 1
  from public.rooms r
  where r.id in (v_old_room_id, p_room_id)
  order by r.id
  for update;
  if not exists (select 1 from public.rooms where id = p_room_id) then
    raise exception using errcode = 'P0002', message = 'ROOM_NOT_FOUND';
  end if;

  select * into v_checkout_obligation
  from public.checkout_cleaning_obligations o
  where o.reservation_id = v_reservation.id
  for update;

  if v_reservation.status = 'cancelled' then
    raise exception using errcode = '23514', message = 'INVALID_TRANSITION';
  elsif v_reservation.status = 'checked_out' then
    select e.event_type into v_checkout_event_type
    from public.room_occupancy_events e
    where e.reservation_id = v_reservation.id
      and e.event_type in ('manual_checkout', 'scheduled_checkout')
    order by e.recorded_at desc, e.id desc
    limit 1;

    if v_checkout_event_type <> 'scheduled_checkout'
      or p_check_out_at <= now()
      or p_room_id <> v_reservation.room_id
      or p_check_in_at <> v_reservation.check_in_at then
      raise exception using errcode = '23514', message = 'CHECKED_OUT_RESERVATION_IMMUTABLE';
    end if;

    if exists (
      select 1
      from public.cleaning_targets t
      join public.cleaning_assignments ca
        on ca.cleaning_target_id = t.id
        and ca.is_current
      join public.cleaning_attempts a
        on a.cleaning_target_id = t.id
        and a.assignment_id = ca.id
      where t.reservation_id = v_reservation.id
        and a.status <> 'superseded'
        and (a.started_at is not null or a.status <> 'scheduled')
    ) or exists (
      select 1
      from public.room_pin_access_leases l
      where l.reservation_id = v_reservation.id
        and l.revealed_at is not null
        and l.revoked_at is null
    ) then
      raise exception using errcode = '23514', message = 'RESERVATION_EXTENSION_ACCESS_CONFLICT';
    end if;
    v_reopen_occupancy := true;
  end if;

  if v_reservation.actual_check_in_at is not null and not v_reopen_occupancy then
    if p_room_id <> v_reservation.room_id or p_check_in_at <> v_reservation.check_in_at then
      raise exception using errcode = '23514', message = 'OCCUPIED_RESERVATION_SCHEDULE_LOCKED';
    end if;
    if p_check_out_at <= now() then
      raise exception using errcode = '23514', message = 'MANUAL_CHECKOUT_REQUIRED';
    end if;
  end if;

  if v_checkout_obligation.current_cleaning_target_id is not null
    and (
      p_room_id <> v_reservation.room_id
      or p_check_out_at <> v_reservation.check_out_at
    ) then
    if not v_reopen_occupancy then
      raise exception using errcode = '23514', message = 'CLEANING_WORKFLOW_REPLAN_REQUIRED';
    end if;
  end if;

  if p_room_id <> v_reservation.room_id then
    v_assignment_reasons := private.room_block_reason_codes(p_room_id, now(), false, false);
  else
    v_assignment_reasons := array[]::text[];
  end if;
  if exists (
    select 1
    from public.room_operation_blocks b
    where b.room_id = p_room_id
      and b.released_at is null
      and b.starts_at < p_check_out_at
      and (b.ends_at is null or b.ends_at > p_check_in_at)
  ) and not ('OPERATION_BLOCKED' = any(v_assignment_reasons)) then
    v_assignment_reasons := array_append(v_assignment_reasons, 'OPERATION_BLOCKED');
  end if;
  if cardinality(v_assignment_reasons) > 0 then
    raise exception using
      errcode = '23514',
      message = 'ROOM_ALLOCATION_BLOCKED',
      detail = array_to_string(v_assignment_reasons, ',');
  end if;

  v_before := private.reservation_response(v_reservation);

  update public.reservations
  set room_id = p_room_id,
      check_in_at = p_check_in_at,
      check_out_at = p_check_out_at,
      guest_count = p_guest_count,
      guest_name_encrypted = case p_guest_name_mode
        when 'keep' then guest_name_encrypted
        when 'clear' then null
        else p_guest_name_encrypted
      end,
      status = case when v_reopen_occupancy then 'active' else status end,
      actual_checkout_at = case when v_reopen_occupancy then null else actual_checkout_at end,
      version = version + 1,
      updated_by = p_actor_profile_id
  where id = v_reservation.id
  returning * into v_updated;

  update public.preparation_obligations
  set room_id = p_room_id,
      status = case
        when p_room_id <> v_reservation.room_id
          or p_check_in_at <> v_reservation.check_in_at then 'invalidated'
        else status
      end,
      approved_submission_id = case
        when p_room_id <> v_reservation.room_id
          or p_check_in_at <> v_reservation.check_in_at then null
        else approved_submission_id
      end,
      invalidated_reason_code = case
        when p_room_id <> v_reservation.room_id then 'RESERVATION_ROOM_CHANGED'
        when p_check_in_at <> v_reservation.check_in_at then 'RESERVATION_CHECK_IN_CHANGED'
        else invalidated_reason_code
      end,
      version = version + 1
  where reservation_id = v_reservation.id;

  update public.checkout_cleaning_obligations
  set room_id = p_room_id,
      status = case
        when v_reopen_occupancy and current_cleaning_target_id is null then 'private'
        when v_reopen_occupancy then 'materialized'
        else status
      end,
      effective_service_date = (p_check_out_at at time zone 'Asia/Seoul')::date,
      available_from = p_check_out_at,
      version = version + 1
  where reservation_id = v_reservation.id;

  insert into public.reservation_schedule_revisions (
    reservation_id,
    version,
    room_id,
    check_in_at,
    check_out_at,
    guest_count,
    reason_code,
    actor_profile_id,
    effective_at
  ) values (
    v_updated.id,
    v_updated.version,
    v_updated.room_id,
    v_updated.check_in_at,
    v_updated.check_out_at,
    v_updated.guest_count,
    p_reason_code,
    p_actor_profile_id,
    now()
  );

  update public.rooms
  set state_version = state_version + 1
  where id in (v_old_room_id, p_room_id);

  if v_reopen_occupancy then
    update public.cleaning_attempts a
    set status = 'superseded',
        ended_at = now(),
        end_reason = 'RESERVATION_EXTENDED'
    from public.cleaning_targets t
    where t.id = v_checkout_obligation.current_cleaning_target_id
      and a.cleaning_target_id = t.id
      and a.status = 'scheduled';

    update public.cleaning_assignments a
    set is_current = false,
        ended_at = now(),
        change_reason_code = 'RESERVATION_EXTENDED'
    where a.cleaning_target_id = v_checkout_obligation.current_cleaning_target_id
      and a.is_current;

    insert into public.notifications (
      recipient_profile_id,
      category,
      title,
      body,
      room_id,
      cleaning_target_id,
      dedupe_key,
      requires_action
    )
    select
      a.maid_profile_id,
      'cleaning_assignment_revoked',
      '청소 배정이 회수되었습니다',
      '예약 퇴실 시간이 연장되어 기존 청소 배정이 회수되었습니다.',
      v_updated.room_id,
      a.cleaning_target_id,
      private.audit_command_key(
        p_actor_profile_id,
        'reservation.change.assignment_revoked.' || a.id::text,
        p_idempotency_key
      ),
      false
    from public.cleaning_assignments a
    where a.cleaning_target_id = v_checkout_obligation.current_cleaning_target_id
      and a.change_reason_code = 'RESERVATION_EXTENDED'
      and a.ended_at is not null
      and a.notified_at is not null;

    update public.cleaning_targets
    set status = 'unassigned',
        available_from = p_check_out_at,
        effective_service_date = (p_check_out_at at time zone 'Asia/Seoul')::date,
        assignment_version = assignment_version + 1
    where id = v_checkout_obligation.current_cleaning_target_id;

    insert into public.cleaning_target_schedule_revisions (
      cleaning_target_id,
      revision,
      effective_service_date,
      available_from,
      due_at,
      reason_code,
      changed_by
    )
    select
      t.id,
      t.assignment_version,
      t.effective_service_date,
      t.available_from,
      t.due_at,
      'RESERVATION_EXTENDED',
      p_actor_profile_id
    from public.cleaning_targets t
    where t.id = v_checkout_obligation.current_cleaning_target_id;

    update public.room_pin_access_leases
    set revoked_at = now(), revoke_reason_code = 'RESERVATION_EXTENDED'
    where reservation_id = v_reservation.id
      and revoked_at is null;

    if v_reservation.actual_check_in_at is not null then
      insert into public.room_occupancy_events (
      event_key,
      room_id,
      reservation_id,
      event_type,
      effective_at,
      actor_profile_id,
      reason_code,
      before_state,
      after_state
    ) values (
      private.audit_command_key(
        p_actor_profile_id,
        'reservation.change.occupancy_resumed',
        p_idempotency_key
      ),
      v_updated.room_id,
      v_updated.id,
      'occupancy_resumed',
      now(),
      p_actor_profile_id,
      p_reason_code,
      jsonb_build_object('occupied', false),
      jsonb_build_object('occupied', true)
      );
    end if;
  end if;

  perform private.refresh_checkout_due_at(v_old_room_id, p_actor_profile_id);
  perform private.invalidate_stale_preparation_proofs(
    v_old_room_id,
    'RESERVATION_SCHEDULE_CHANGED'
  );
  if p_room_id <> v_old_room_id then
    perform private.refresh_checkout_due_at(p_room_id, p_actor_profile_id);
    perform private.invalidate_stale_preparation_proofs(
      p_room_id,
      'RESERVATION_SCHEDULE_CHANGED'
    );
  end if;

  v_response := private.reservation_response(v_updated);

  insert into public.audit_events (
    actor_profile_id,
    actor_display_name_snapshot,
    event_type,
    entity_type,
    entity_id,
    effective_at,
    reason_code,
    before_state,
    after_state,
    request_hash,
    idempotency_key
  )
  select
    p.id,
    p.display_name,
    'reservation.changed',
    'reservation',
    v_updated.id,
    now(),
    p_reason_code,
    v_before,
    v_response,
    p_request_hash,
    private.audit_command_key(p_actor_profile_id, 'reservation.change', p_idempotency_key)
  from public.profiles p where p.id = p_actor_profile_id;

  perform private.complete_command(
    p_actor_profile_id,
    'reservation.change',
    p_idempotency_key,
    p_request_hash,
    v_updated.id,
    v_response
  );
  return v_response;
exception
  when exclusion_violation then
    raise exception using errcode = '23P01', message = 'RESERVATION_OVERLAP';
end;
$$;

create function public.cancel_reservation(
  p_actor_profile_id uuid,
  p_reservation_id uuid,
  p_expected_version bigint,
  p_reason_code text,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_reservation public.reservations%rowtype;
  v_updated public.reservations%rowtype;
  v_obligation public.checkout_cleaning_obligations%rowtype;
  v_target_status public.cleaning_target_status;
  v_before jsonb;
  v_response jsonb;
begin
  perform private.assert_room_admin(p_actor_profile_id);
  v_response := private.replay_command(
    p_actor_profile_id,
    'reservation.cancel',
    p_idempotency_key,
    p_request_hash
  );
  if v_response is not null then
    return v_response;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command', 0));

  select * into v_reservation
  from public.reservations
  where id = p_reservation_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'RESERVATION_NOT_FOUND';
  end if;
  if v_reservation.version <> p_expected_version then
    raise exception using errcode = '40001', message = 'STALE_VERSION';
  end if;
  if v_reservation.status <> 'active'
    or v_reservation.actual_check_in_at is not null
    or now() >= v_reservation.check_in_at then
    raise exception using errcode = '23514', message = 'RESERVATION_CANCELLATION_NOT_ALLOWED';
  end if;

  select * into v_obligation
  from public.checkout_cleaning_obligations
  where reservation_id = v_reservation.id
  for update;

  if v_obligation.current_cleaning_target_id is not null then
    select status into v_target_status
    from public.cleaning_targets
    where id = v_obligation.current_cleaning_target_id
    for update;
    if v_target_status not in ('unassigned', 'draft_assigned', 'cancelled') then
      raise exception using errcode = '23514', message = 'CLEANING_WORKFLOW_CANCEL_CONFLICT';
    end if;

    update public.cleaning_targets
    set status = 'cancelled',
        cancelled_at = now(),
        cancelled_by = p_actor_profile_id,
        cancellation_reason_code = p_reason_code
    where id = v_obligation.current_cleaning_target_id
      and status <> 'cancelled';
  end if;

  v_before := private.reservation_response(v_reservation);

  update public.reservations
  set status = 'cancelled',
      cancelled_at = now(),
      version = version + 1,
      updated_by = p_actor_profile_id
  where id = v_reservation.id
  returning * into v_updated;

  update public.preparation_obligations
  set status = 'cancelled',
      approved_submission_id = null,
      invalidated_reason_code = p_reason_code,
      version = version + 1
  where reservation_id = v_reservation.id;

  update public.checkout_cleaning_obligations
  set status = 'cancelled',
      cancelled_at = now(),
      cancellation_reason_code = p_reason_code,
      version = version + 1
  where reservation_id = v_reservation.id;

  update public.rooms
  set state_version = state_version + 1
  where id = v_reservation.room_id;

  perform private.refresh_checkout_due_at(v_reservation.room_id, p_actor_profile_id);
  perform private.invalidate_stale_preparation_proofs(
    v_reservation.room_id,
    'PREVIOUS_OCCUPANCY_CHANGED'
  );
  v_response := private.reservation_response(v_updated);

  insert into public.audit_events (
    actor_profile_id,
    actor_display_name_snapshot,
    event_type,
    entity_type,
    entity_id,
    effective_at,
    reason_code,
    before_state,
    after_state,
    request_hash,
    idempotency_key
  )
  select
    p.id,
    p.display_name,
    'reservation.cancelled',
    'reservation',
    v_updated.id,
    now(),
    p_reason_code,
    v_before,
    v_response,
    p_request_hash,
    private.audit_command_key(p_actor_profile_id, 'reservation.cancel', p_idempotency_key)
  from public.profiles p where p.id = p_actor_profile_id;

  perform private.complete_command(
    p_actor_profile_id,
    'reservation.cancel',
    p_idempotency_key,
    p_request_hash,
    v_updated.id,
    v_response
  );
  return v_response;
end;
$$;

create function public.manual_checkout_reservation(
  p_actor_profile_id uuid,
  p_reservation_id uuid,
  p_expected_version bigint,
  p_reason_code text,
  p_effective_at timestamptz,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_reservation public.reservations%rowtype;
  v_updated public.reservations%rowtype;
  v_obligation public.checkout_cleaning_obligations%rowtype;
  v_assignment public.cleaning_assignments%rowtype;
  v_attempt public.cleaning_attempts%rowtype;
  v_new_assignment_id uuid;
  v_new_attempt_id uuid;
  v_current_pin_version bigint;
  v_current_pin_status text;
  v_before jsonb;
  v_response jsonb;
begin
  perform private.assert_room_admin(p_actor_profile_id);
  v_response := private.replay_command(
    p_actor_profile_id,
    'reservation.manual_checkout',
    p_idempotency_key,
    p_request_hash
  );
  if v_response is not null then
    return v_response;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command', 0));

  select * into v_reservation
  from public.reservations
  where id = p_reservation_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'RESERVATION_NOT_FOUND';
  end if;
  if v_reservation.version <> p_expected_version then
    raise exception using errcode = '40001', message = 'STALE_VERSION';
  end if;
  if v_reservation.status <> 'active'
    or v_reservation.actual_check_in_at is null
    or v_reservation.actual_checkout_at is not null
    or p_effective_at >= v_reservation.check_out_at
    or p_effective_at < v_reservation.actual_check_in_at then
    raise exception using errcode = '23514', message = 'MANUAL_CHECKOUT_NOT_ALLOWED';
  end if;

  perform 1 from public.rooms where id = v_reservation.room_id for update;
  select * into v_obligation
  from public.checkout_cleaning_obligations
  where reservation_id = v_reservation.id
  for update;

  if exists (
    select 1
    from public.cleaning_targets t
    join public.cleaning_assignments ca
      on ca.cleaning_target_id = t.id
      and ca.is_current
    join public.cleaning_attempts a
      on a.cleaning_target_id = t.id
      and a.assignment_id = ca.id
    where t.reservation_id = v_reservation.id
      and a.status <> 'superseded'
      and (a.started_at is not null or a.status <> 'scheduled')
  ) or exists (
    select 1
    from public.room_pin_access_leases l
    where l.reservation_id = v_reservation.id
      and l.revealed_at is not null
      and l.revoked_at is null
  ) then
    raise exception using errcode = '23514', message = 'MANUAL_CHECKOUT_ACCESS_CONFLICT';
  end if;

  if v_obligation.current_cleaning_target_id is not null then
    select * into v_assignment
    from public.cleaning_assignments a
    where a.cleaning_target_id = v_obligation.current_cleaning_target_id
      and a.is_current
    for update;

    select * into v_attempt
    from public.cleaning_attempts a
    where a.cleaning_target_id = v_obligation.current_cleaning_target_id
      and a.status = 'scheduled'
    order by a.attempt_number desc
    limit 1
    for update;
  end if;

  v_before := private.reservation_response(v_reservation);

  update public.reservations
  set status = 'checked_out',
      actual_checkout_at = p_effective_at,
      version = version + 1,
      updated_by = p_actor_profile_id
  where id = v_reservation.id
  returning * into v_updated;

  update public.checkout_cleaning_obligations
  set status = case
        when current_cleaning_target_id is null then 'available'::public.checkout_obligation_status
        else 'materialized'::public.checkout_obligation_status
      end,
      available_from = p_effective_at,
      effective_service_date = (p_effective_at at time zone 'Asia/Seoul')::date,
      version = version + 1
  where reservation_id = v_reservation.id;

  update public.cleaning_targets
  set available_from = p_effective_at,
      effective_service_date = (p_effective_at at time zone 'Asia/Seoul')::date,
      assignment_version = assignment_version + 1
  where id = v_obligation.current_cleaning_target_id
    and status in ('unassigned', 'draft_assigned', 'notified');

  insert into public.cleaning_target_schedule_revisions (
    cleaning_target_id,
    revision,
    effective_service_date,
    available_from,
    due_at,
    reason_code,
    changed_by
  )
  select
    t.id,
    t.assignment_version,
    t.effective_service_date,
    t.available_from,
    t.due_at,
    'MANUAL_CHECKOUT',
    p_actor_profile_id
  from public.cleaning_targets t
  where t.id = v_obligation.current_cleaning_target_id
    and t.status in ('unassigned', 'draft_assigned', 'notified');

  if v_assignment.id is not null then
    update public.cleaning_assignments
    set is_current = false,
        ended_at = p_effective_at,
        change_reason_code = 'MANUAL_CHECKOUT_RESCHEDULE'
    where id = v_assignment.id;

    v_new_assignment_id := gen_random_uuid();
    insert into public.cleaning_assignments (
      id,
      cleaning_target_id,
      maid_profile_id,
      sequence_number,
      revision,
      is_current,
      notified_at,
      changed_by
    ) values (
      v_new_assignment_id,
      v_assignment.cleaning_target_id,
      v_assignment.maid_profile_id,
      v_assignment.sequence_number,
      v_assignment.revision + 1,
      true,
      case when v_assignment.notified_at is null then null else p_effective_at end,
      p_actor_profile_id
    );

    if v_attempt.id is not null then
      update public.cleaning_attempts
      set status = 'superseded',
          ended_at = p_effective_at,
          end_reason = 'MANUAL_CHECKOUT_RESCHEDULE'
      where id = v_attempt.id;

      v_new_attempt_id := gen_random_uuid();
      insert into public.cleaning_attempts (
        id,
        cleaning_target_id,
        assignment_id,
        maid_profile_id,
        attempt_number,
        status,
        assignment_revision,
        template_snapshot,
        room_snapshot
      ) values (
        v_new_attempt_id,
        v_attempt.cleaning_target_id,
        v_new_assignment_id,
        v_assignment.maid_profile_id,
        v_attempt.attempt_number + 1,
        'scheduled',
        v_assignment.revision + 1,
        v_attempt.template_snapshot,
        v_attempt.room_snapshot
      );
    end if;

    if v_assignment.notified_at is not null then
      insert into public.notifications (
        recipient_profile_id,
        category,
        title,
        body,
        room_id,
        cleaning_target_id,
        dedupe_key,
        requires_action,
        occurred_at
      ) values (
        v_assignment.maid_profile_id,
        'cleaning_schedule_changed',
        '청소 시작 시간이 변경되었습니다',
        '수동 체크아웃 처리로 청소 가능 시간이 변경되었습니다.',
        v_updated.room_id,
        v_assignment.cleaning_target_id,
        private.audit_command_key(
          p_actor_profile_id,
          'reservation.manual_checkout.assignment_notice',
          p_idempotency_key
        ),
        true,
        p_effective_at
      );
    end if;
  end if;

  select e.sync_status, e.pin_version
  into v_current_pin_status, v_current_pin_version
  from public.room_pin_sync_events e
  where e.room_id = v_updated.room_id
  order by e.recorded_at desc, e.id desc
  limit 1;

  with revoked as (
    update public.room_pin_access_leases
    set revoked_at = p_effective_at,
        revoke_reason_code = 'MANUAL_CHECKOUT_RESCHEDULE'
    where reservation_id = v_reservation.id
      and revoked_at is null
    returning *
  )
  insert into public.room_pin_access_leases (
    room_id,
    reservation_id,
    cleaning_target_id,
    assignment_id,
    attempt_id,
    pin_version,
    issued_to,
    issued_at,
    expires_at
  )
  select
    l.room_id,
    l.reservation_id,
    l.cleaning_target_id,
    v_new_assignment_id,
    v_new_attempt_id,
    v_current_pin_version,
    l.issued_to,
    p_effective_at,
    l.expires_at
  from revoked l
  where v_new_assignment_id is not null
    and v_new_attempt_id is not null
    and l.room_id = v_updated.room_id
    and l.cleaning_target_id = v_obligation.current_cleaning_target_id
    and l.assignment_id = v_assignment.id
    and l.attempt_id = v_attempt.id
    and l.issued_to = v_assignment.maid_profile_id
    and l.revealed_at is null
    and l.expires_at > p_effective_at
    and v_current_pin_status = 'verified'
    and v_current_pin_version is not null;

  insert into public.room_occupancy_events (
    event_key,
    room_id,
    reservation_id,
    event_type,
    effective_at,
    actor_profile_id,
    reason_code,
    before_state,
    after_state
  ) values (
    private.audit_command_key(
      p_actor_profile_id,
      'reservation.manual_checkout.event',
      p_idempotency_key
    ),
    v_updated.room_id,
    v_updated.id,
    'manual_checkout',
    p_effective_at,
    p_actor_profile_id,
    p_reason_code,
    jsonb_build_object('occupied', true),
    jsonb_build_object('occupied', false)
  );

  update public.rooms
  set state_version = state_version + 1
  where id = v_updated.room_id;

  v_response := private.reservation_response(v_updated);

  insert into public.audit_events (
    actor_profile_id,
    actor_display_name_snapshot,
    event_type,
    entity_type,
    entity_id,
    effective_at,
    reason_code,
    before_state,
    after_state,
    request_hash,
    idempotency_key
  )
  select
    p.id,
    p.display_name,
    'reservation.manual_checkout',
    'reservation',
    v_updated.id,
    p_effective_at,
    p_reason_code,
    v_before,
    v_response,
    p_request_hash,
    private.audit_command_key(
      p_actor_profile_id,
      'reservation.manual_checkout',
      p_idempotency_key
    )
  from public.profiles p where p.id = p_actor_profile_id;

  perform private.complete_command(
    p_actor_profile_id,
    'reservation.manual_checkout',
    p_idempotency_key,
    p_request_hash,
    v_updated.id,
    v_response
  );
  return v_response;
end;
$$;

create function public.process_due_reservation_transitions(
  p_actor_profile_id uuid,
  p_as_of timestamptz,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_reservation public.reservations%rowtype;
  v_updated public.reservations%rowtype;
  v_reason_codes text[];
  v_checked_in integer := 0;
  v_checked_out integer := 0;
  v_blocked integer := 0;
  v_purged_guest_names integer := 0;
  v_response jsonb;
begin
  perform private.assert_room_admin(p_actor_profile_id);
  v_response := private.replay_command(
    p_actor_profile_id,
    'reservation.process_due_transitions',
    p_idempotency_key,
    p_request_hash
  );
  if v_response is not null then
    return v_response;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command', 0));

  -- Close due stays first so a legal [checkout, next check-in) boundary does not
  -- leave the next reservation blocked until the following scheduler tick.
  for v_reservation in
    select r.*
    from public.reservations r
    where r.status = 'active'
      and r.actual_checkout_at is null
      and r.check_out_at <= p_as_of
    order by r.room_id, r.check_out_at, r.id
    for update skip locked
  loop
    perform 1 from public.rooms where id = v_reservation.room_id for update;

    update public.reservations
    set status = 'checked_out',
        actual_checkout_at = v_reservation.check_out_at,
        version = version + 1,
        updated_by = p_actor_profile_id
    where id = v_reservation.id
      and status = 'active'
      and actual_checkout_at is null
    returning * into v_updated;

    if not found then
      continue;
    end if;

    update public.checkout_cleaning_obligations
    set status = case
          when current_cleaning_target_id is null then 'available'::public.checkout_obligation_status
          else 'materialized'::public.checkout_obligation_status
        end,
        available_from = v_updated.check_out_at,
        effective_service_date = (v_updated.check_out_at at time zone 'Asia/Seoul')::date,
        version = version + 1
    where reservation_id = v_updated.id;

    insert into public.room_occupancy_events (
      event_key,
      room_id,
      reservation_id,
      event_type,
      effective_at,
      actor_profile_id,
      reason_code,
      before_state,
      after_state
    ) values (
      private.audit_command_key(
        p_actor_profile_id,
        'reservation.scheduled_checkout.' || v_updated.id::text,
        p_idempotency_key
      ),
      v_updated.room_id,
      v_updated.id,
      'scheduled_checkout',
      v_updated.check_out_at,
      p_actor_profile_id,
      'SCHEDULED_CHECKOUT_REACHED',
      jsonb_build_object('occupied', v_reservation.actual_check_in_at is not null),
      jsonb_build_object('occupied', false)
    );

    update public.rooms set state_version = state_version + 1 where id = v_updated.room_id;

    insert into public.audit_events (
      actor_profile_id,
      actor_display_name_snapshot,
      event_type,
      entity_type,
      entity_id,
      effective_at,
      reason_code,
      before_state,
      after_state,
      request_hash,
      idempotency_key
    )
    select
      p.id,
      p.display_name,
      'reservation.scheduled_checkout',
      'reservation',
      v_updated.id,
      v_updated.check_out_at,
      'SCHEDULED_CHECKOUT_REACHED',
      private.reservation_response(v_reservation),
      private.reservation_response(v_updated),
      p_request_hash,
      private.audit_command_key(
        p_actor_profile_id,
        'reservation.scheduled_checkout.' || v_updated.id::text,
        p_idempotency_key
      )
    from public.profiles p where p.id = p_actor_profile_id;

    v_checked_out := v_checked_out + 1;
  end loop;

  for v_reservation in
    select r.*
    from public.reservations r
    where r.status = 'active'
      and r.actual_check_in_at is null
      and r.check_in_at <= p_as_of
      and r.check_out_at > p_as_of
    order by r.room_id, r.check_in_at, r.id
    for update skip locked
  loop
    perform 1 from public.rooms where id = v_reservation.room_id for update;
    v_reason_codes := private.room_block_reason_codes(
      v_reservation.room_id,
      p_as_of,
      true,
      true,
      v_reservation.id
    );

    if cardinality(v_reason_codes) > 0 then
      v_blocked := v_blocked + 1;
      continue;
    end if;

    update public.reservations
    set actual_check_in_at = p_as_of,
        version = version + 1,
        updated_by = p_actor_profile_id
    where id = v_reservation.id
      and status = 'active'
      and actual_check_in_at is null
    returning * into v_updated;

    if not found then
      continue;
    end if;

    insert into public.room_occupancy_events (
      event_key,
      room_id,
      reservation_id,
      event_type,
      effective_at,
      actor_profile_id,
      reason_code,
      before_state,
      after_state
    ) values (
      private.audit_command_key(
        p_actor_profile_id,
        'reservation.scheduled_check_in.' || v_updated.id::text,
        p_idempotency_key
      ),
      v_updated.room_id,
      v_updated.id,
      'scheduled_check_in',
      p_as_of,
      p_actor_profile_id,
      'SCHEDULED_CHECK_IN_READY',
      jsonb_build_object('occupied', false),
      jsonb_build_object('occupied', true)
    );

    update public.rooms set state_version = state_version + 1 where id = v_updated.room_id;

    insert into public.audit_events (
      actor_profile_id,
      actor_display_name_snapshot,
      event_type,
      entity_type,
      entity_id,
      effective_at,
      reason_code,
      before_state,
      after_state,
      request_hash,
      idempotency_key
    )
    select
      p.id,
      p.display_name,
      'reservation.scheduled_check_in',
      'reservation',
      v_updated.id,
      p_as_of,
      'SCHEDULED_CHECK_IN_READY',
      private.reservation_response(v_reservation),
      private.reservation_response(v_updated),
      p_request_hash,
      private.audit_command_key(
        p_actor_profile_id,
        'reservation.scheduled_check_in.' || v_updated.id::text,
        p_idempotency_key
      )
    from public.profiles p where p.id = p_actor_profile_id;

    v_checked_in := v_checked_in + 1;
  end loop;

  update public.reservations r
  set guest_name_encrypted = null,
      version = version + 1,
      updated_by = p_actor_profile_id
  where r.guest_name_encrypted is not null
    and (
      (r.status = 'checked_out' and r.actual_checkout_at <= p_as_of - interval '180 days')
      or (r.status = 'cancelled' and r.cancelled_at <= p_as_of - interval '180 days')
    );
  get diagnostics v_purged_guest_names = row_count;

  if v_purged_guest_names > 0 then
    insert into public.audit_events (
      actor_profile_id,
      actor_display_name_snapshot,
      event_type,
      entity_type,
      effective_at,
      reason_code,
      after_state,
      request_hash,
      idempotency_key
    )
    select
      p.id,
      p.display_name,
      'reservation.guest_name_retention_purged',
      'reservation_retention_batch',
      p_as_of,
      'RETENTION_180_DAYS_EXPIRED',
      jsonb_build_object('purged_count', v_purged_guest_names),
      p_request_hash,
      private.audit_command_key(
        p_actor_profile_id,
        'reservation.guest_name_retention_purged',
        p_idempotency_key
      )
    from public.profiles p where p.id = p_actor_profile_id;
  end if;

  v_response := jsonb_build_object(
    'as_of', p_as_of,
    'checked_in_count', v_checked_in,
    'checked_out_count', v_checked_out,
    'blocked_check_in_count', v_blocked,
    'purged_guest_name_count', v_purged_guest_names
  );

  perform private.complete_command(
    p_actor_profile_id,
    'reservation.process_due_transitions',
    p_idempotency_key,
    p_request_hash,
    null,
    v_response
  );
  return v_response;
end;
$$;

create function public.create_manual_cleaning_request(
  p_actor_profile_id uuid,
  p_target_id uuid,
  p_room_id uuid,
  p_reservation_id uuid,
  p_cleaning_kind public.cleaning_kind,
  p_service_date date,
  p_available_from timestamptz,
  p_due_at timestamptz,
  p_expected_room_version bigint,
  p_reason_code text,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_room public.rooms%rowtype;
  v_room_type public.room_types%rowtype;
  v_template public.cleaning_template_versions%rowtype;
  v_stay public.reservations%rowtype;
  v_target public.cleaning_targets%rowtype;
  v_response jsonb;
begin
  perform private.assert_room_admin(p_actor_profile_id);
  v_response := private.replay_command(
    p_actor_profile_id,
    'cleaning.manual_request.create',
    p_idempotency_key,
    p_request_hash
  );
  if v_response is not null then
    return v_response;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command', 0));

  if p_cleaning_kind not in ('stayover', 'additional')
    or (p_available_from at time zone 'Asia/Seoul')::date <> p_service_date
    or (p_due_at is not null and p_due_at <= p_available_from) then
    raise exception using errcode = '22023', message = 'INVALID_MANUAL_CLEANING_REQUEST';
  end if;

  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'ROOM_NOT_FOUND';
  end if;
  if v_room.state_version <> p_expected_room_version then
    raise exception using errcode = '40001', message = 'STALE_VERSION';
  end if;

  select * into v_room_type from public.room_types where id = v_room.room_type_id;
  select * into v_template
  from public.cleaning_template_versions t
  where t.room_type_id = v_room.room_type_id
    and t.cleaning_kind = p_cleaning_kind
    and t.status = 'published';
  if not found then
    raise exception using errcode = '23514', message = 'CLEANING_TEMPLATE_NOT_CONFIGURED';
  end if;

  if p_cleaning_kind = 'stayover' then
    select * into v_stay
    from public.reservations r
    where r.id = p_reservation_id
      and r.room_id = p_room_id
      and r.status = 'active'
      and r.actual_check_in_at is not null
      and r.actual_checkout_at is null
    for update;
    if not found then
      raise exception using errcode = '23514', message = 'ACTIVE_STAY_RESERVATION_REQUIRED';
    end if;
    if p_due_at is null
      or p_available_from < v_stay.actual_check_in_at
      or p_available_from >= p_due_at
      or p_due_at > v_stay.check_out_at then
      raise exception using errcode = '23514', message = 'STAYOVER_ACCESS_WINDOW_INVALID';
    end if;
  elsif p_reservation_id is not null and not exists (
    select 1 from public.reservations r
    where r.id = p_reservation_id and r.room_id = p_room_id
  ) then
    raise exception using errcode = '23514', message = 'RESERVATION_ROOM_MISMATCH';
  elsif exists (
    select 1
    from public.reservations r
    where r.room_id = p_room_id
      and r.status = 'active'
      and tstzrange(
        coalesce(r.actual_check_in_at, r.check_in_at),
        case
          when r.actual_check_in_at is not null and r.actual_checkout_at is null
            then 'infinity'::timestamptz
          else coalesce(r.actual_checkout_at, r.check_out_at)
        end,
        '[)'
      ) && tstzrange(
        p_available_from,
        coalesce(
          p_due_at,
          p_available_from + make_interval(mins => v_template.duration_minutes)
        ),
        '[)'
      )
  ) then
    raise exception using errcode = '23514', message = 'VACANT_ROOM_REQUIRED';
  end if;

  if exists (
    select 1
    from public.cleaning_targets t
    where t.room_id = p_room_id
      and t.status not in ('approved', 'cancelled')
      and tstzrange(
        coalesce(t.available_from, p_available_from),
        coalesce(
          t.due_at,
          coalesce(t.available_from, p_available_from) + make_interval(
            mins => coalesce((t.template_snapshot ->> 'durationMinutes')::integer, 1)
          )
        ),
        '[)'
      ) && tstzrange(
        p_available_from,
        coalesce(
          p_due_at,
          p_available_from + make_interval(mins => v_template.duration_minutes)
        ),
        '[)'
      )
  ) then
    raise exception using errcode = '23P01', message = 'CLEANING_REQUEST_TIME_CONFLICT';
  end if;

  insert into public.cleaning_targets (
    id,
    room_id,
    reservation_id,
    cleaning_kind,
    source,
    source_key,
    original_service_date,
    effective_service_date,
    available_from,
    due_at,
    room_type_snapshot,
    fee_snapshot,
    template_snapshot,
    created_by
  ) values (
    p_target_id,
    p_room_id,
    p_reservation_id,
    p_cleaning_kind,
    case when p_cleaning_kind = 'stayover' then 'stayover_request' else 'manual_room_request' end,
    'manual-cleaning-request:' || p_target_id::text,
    p_service_date,
    p_service_date,
    p_available_from,
    p_due_at,
    jsonb_build_object(
      'id', v_room_type.id,
      'code', v_room_type.code,
      'name', v_room_type.name,
      'defaultDurationMinutes', v_room_type.default_duration_minutes
    ),
    v_room_type.base_cleaning_fee,
    jsonb_build_object(
      'id', v_template.id,
      'version', v_template.version,
      'durationMinutes', v_template.duration_minutes,
      'photoSlots', v_template.photo_slots
    ),
    p_actor_profile_id
  ) returning * into v_target;

  insert into public.cleaning_target_schedule_revisions (
    cleaning_target_id,
    revision,
    effective_service_date,
    available_from,
    due_at,
    reason_code,
    changed_by
  ) values (
    v_target.id,
    v_target.assignment_version,
    v_target.effective_service_date,
    v_target.available_from,
    v_target.due_at,
    p_reason_code,
    p_actor_profile_id
  );

  update public.rooms set state_version = state_version + 1 where id = p_room_id;

  v_response := jsonb_build_object(
    'id', v_target.id,
    'room_id', v_target.room_id,
    'reservation_id', v_target.reservation_id,
    'cleaning_kind', v_target.cleaning_kind,
    'status', v_target.status,
    'service_date', v_target.effective_service_date,
    'available_from', v_target.available_from,
    'due_at', v_target.due_at,
    'version', v_target.assignment_version
  );

  insert into public.audit_events (
    actor_profile_id,
    actor_display_name_snapshot,
    event_type,
    entity_type,
    entity_id,
    effective_at,
    reason_code,
    after_state,
    request_hash,
    idempotency_key
  )
  select
    p.id,
    p.display_name,
    'cleaning.manual_request.created',
    'cleaning_target',
    v_target.id,
    now(),
    p_reason_code,
    v_response,
    p_request_hash,
    private.audit_command_key(
      p_actor_profile_id,
      'cleaning.manual_request.create',
      p_idempotency_key
    )
  from public.profiles p where p.id = p_actor_profile_id;

  perform private.complete_command(
    p_actor_profile_id,
    'cleaning.manual_request.create',
    p_idempotency_key,
    p_request_hash,
    v_target.id,
    v_response
  );
  return v_response;
end;
$$;

create function public.cancel_manual_cleaning_request(
  p_actor_profile_id uuid,
  p_target_id uuid,
  p_expected_version bigint,
  p_reason_code text,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_target public.cleaning_targets%rowtype;
  v_response jsonb;
begin
  perform private.assert_room_admin(p_actor_profile_id);
  v_response := private.replay_command(
    p_actor_profile_id,
    'cleaning.manual_request.cancel',
    p_idempotency_key,
    p_request_hash
  );
  if v_response is not null then
    return v_response;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command', 0));

  select * into v_target
  from public.cleaning_targets t
  where t.id = p_target_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'CLEANING_REQUEST_NOT_FOUND';
  end if;
  if v_target.source not in ('stayover_request', 'manual_room_request') then
    raise exception using errcode = '23514', message = 'NOT_MANUAL_CLEANING_REQUEST';
  end if;
  if v_target.assignment_version <> p_expected_version then
    raise exception using errcode = '40001', message = 'STALE_VERSION';
  end if;
  if v_target.status not in ('unassigned', 'draft_assigned', 'notified')
    or exists (
      select 1 from public.cleaning_attempts a
      join public.cleaning_assignments ca
        on ca.id = a.assignment_id
        and ca.cleaning_target_id = v_target.id
        and ca.is_current
      where a.cleaning_target_id = v_target.id
        and a.status <> 'superseded'
        and (a.started_at is not null or a.status <> 'scheduled')
    )
    or exists (
      select 1 from public.room_pin_access_leases l
      where l.cleaning_target_id = v_target.id
        and l.revealed_at is not null
        and l.revoked_at is null
    ) then
    raise exception using errcode = '23514', message = 'CLEANING_REQUEST_CANCEL_CONFLICT';
  end if;

  insert into public.notifications (
    recipient_profile_id,
    category,
    title,
    body,
    room_id,
    cleaning_target_id,
    dedupe_key,
    requires_action
  )
  select
    a.maid_profile_id,
    'cleaning_assignment_revoked',
    '청소 요청이 취소되었습니다',
    '관리자가 추가 청소 요청을 취소했습니다.',
    v_target.room_id,
    v_target.id,
    private.audit_command_key(
      p_actor_profile_id,
      'cleaning.manual_request.cancel.notice.' || a.id::text,
      p_idempotency_key
    ),
    false
  from public.cleaning_assignments a
  where a.cleaning_target_id = v_target.id
    and a.is_current
    and a.notified_at is not null;

  update public.cleaning_attempts
  set status = 'superseded',
      ended_at = now(),
      end_reason = 'MANUAL_REQUEST_CANCELLED'
  where cleaning_target_id = v_target.id
    and status = 'scheduled';

  update public.cleaning_assignments
  set is_current = false,
      ended_at = now(),
      change_reason_code = p_reason_code
  where cleaning_target_id = v_target.id
    and is_current;

  update public.room_pin_access_leases
  set revoked_at = now(),
      revoke_reason_code = 'MANUAL_REQUEST_CANCELLED'
  where cleaning_target_id = v_target.id
    and revoked_at is null;

  update public.cleaning_targets
  set status = 'cancelled',
      assignment_version = assignment_version + 1,
      cancellation_reason_code = p_reason_code,
      cancelled_at = now(),
      cancelled_by = p_actor_profile_id
  where id = v_target.id
  returning * into v_target;

  update public.rooms set state_version = state_version + 1 where id = v_target.room_id;

  v_response := jsonb_build_object(
    'id', v_target.id,
    'room_id', v_target.room_id,
    'reservation_id', v_target.reservation_id,
    'cleaning_kind', v_target.cleaning_kind,
    'status', v_target.status,
    'service_date', v_target.effective_service_date,
    'available_from', v_target.available_from,
    'due_at', v_target.due_at,
    'version', v_target.assignment_version
  );

  insert into public.audit_events (
    actor_profile_id,
    actor_display_name_snapshot,
    event_type,
    entity_type,
    entity_id,
    effective_at,
    reason_code,
    before_state,
    after_state,
    request_hash,
    idempotency_key
  )
  select
    p.id,
    p.display_name,
    'cleaning.manual_request.cancelled',
    'cleaning_target',
    v_target.id,
    now(),
    p_reason_code,
    jsonb_build_object('status', 'active', 'version', p_expected_version),
    v_response,
    p_request_hash,
    private.audit_command_key(
      p_actor_profile_id,
      'cleaning.manual_request.cancel',
      p_idempotency_key
    )
  from public.profiles p where p.id = p_actor_profile_id;

  perform private.complete_command(
    p_actor_profile_id,
    'cleaning.manual_request.cancel',
    p_idempotency_key,
    p_request_hash,
    v_target.id,
    v_response
  );
  return v_response;
end;
$$;

create function public.list_reservations(
  p_actor_profile_id uuid,
  p_room_id uuid default null
)
returns setof public.reservations
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
begin
  perform private.assert_room_admin(p_actor_profile_id);
  return query
  select r.*
  from public.reservations r
  where p_room_id is null or r.room_id = p_room_id
  order by r.check_in_at, r.id;
end;
$$;

create function public.get_reservation_detail(
  p_actor_profile_id uuid,
  p_reservation_id uuid
)
returns setof public.reservations
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
begin
  perform private.assert_room_admin(p_actor_profile_id);
  return query
  select r.*
  from public.reservations r
  where r.id = p_reservation_id;
end;
$$;

create function public.mutate_room_operation(
  p_actor_profile_id uuid,
  p_room_id uuid,
  p_action text,
  p_expected_room_version bigint,
  p_reason_code text,
  p_payload jsonb,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_room public.rooms%rowtype;
  v_entity_id uuid;
  v_block public.room_operation_blocks%rowtype;
  v_issue public.room_issues%rowtype;
  v_count_before integer;
  v_count_after integer;
  v_response jsonb;
  v_before jsonb;
  v_after jsonb;
begin
  perform private.assert_room_admin(p_actor_profile_id);
  v_response := private.replay_command(
    p_actor_profile_id,
    'room.operation.' || p_action,
    p_idempotency_key,
    p_request_hash
  );
  if v_response is not null then
    return v_response;
  end if;

  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'ROOM_NOT_FOUND';
  end if;
  if v_room.state_version <> p_expected_room_version then
    raise exception using errcode = '40001', message = 'STALE_VERSION';
  end if;

  v_entity_id := coalesce(nullif(p_payload ->> 'entityId', '')::uuid, gen_random_uuid());

  case p_action
    when 'create_block' then
      insert into public.room_operation_blocks (
        id,
        room_id,
        reason_code,
        starts_at,
        ends_at,
        created_by
      ) values (
        v_entity_id,
        p_room_id,
        p_reason_code,
        coalesce(nullif(p_payload ->> 'startsAt', '')::timestamptz, now()),
        nullif(p_payload ->> 'endsAt', '')::timestamptz,
        p_actor_profile_id
      )
      returning * into v_block;
      v_after := jsonb_build_object(
        'blockId', v_block.id,
        'startsAt', v_block.starts_at,
        'endsAt', v_block.ends_at,
        'active', true
      );

    when 'release_block' then
      select * into v_block
      from public.room_operation_blocks
      where id = v_entity_id and room_id = p_room_id
      for update;
      if not found then
        raise exception using errcode = 'P0002', message = 'ROOM_BLOCK_NOT_FOUND';
      end if;
      if v_block.released_at is not null then
        raise exception using errcode = '23514', message = 'ROOM_BLOCK_ALREADY_RELEASED';
      end if;
      v_before := jsonb_build_object('blockId', v_block.id, 'active', true);
      update public.room_operation_blocks
      set released_by = p_actor_profile_id,
          released_at = now(),
          release_reason_code = p_reason_code,
          version = version + 1
      where id = v_block.id
      returning * into v_block;
      v_after := jsonb_build_object('blockId', v_block.id, 'active', false);

    when 'set_candle_count' then
      v_count_before := private.current_candle_count(p_room_id);
      v_count_after := (p_payload ->> 'count')::integer;
      insert into public.room_candle_events (
        id,
        room_id,
        count_before,
        count_after,
        physically_verified,
        reason_code,
        actor_profile_id,
        effective_at
      ) values (
        v_entity_id,
        p_room_id,
        v_count_before,
        v_count_after,
        coalesce((p_payload ->> 'physicallyVerified')::boolean, false),
        p_reason_code,
        p_actor_profile_id,
        now()
      );
      v_before := jsonb_build_object('count', v_count_before);
      v_after := jsonb_build_object('candleEventId', v_entity_id, 'count', v_count_after);

    when 'report_issue' then
      insert into public.room_issues (
        id,
        room_id,
        category,
        severity,
        blocks_guest_assignment,
        description,
        reported_by
      ) values (
        v_entity_id,
        p_room_id,
        p_payload ->> 'category',
        p_payload ->> 'severity',
        coalesce((p_payload ->> 'blocksGuestAssignment')::boolean, false),
        nullif(p_payload ->> 'description', ''),
        p_actor_profile_id
      )
      returning * into v_issue;
      v_after := jsonb_build_object(
        'issueId', v_issue.id,
        'category', v_issue.category,
        'severity', v_issue.severity,
        'blocksGuestAssignment', v_issue.blocks_guest_assignment,
        'status', v_issue.status
      );

    when 'resolve_issue' then
      select * into v_issue
      from public.room_issues
      where id = v_entity_id and room_id = p_room_id
      for update;
      if not found then
        raise exception using errcode = 'P0002', message = 'ROOM_ISSUE_NOT_FOUND';
      end if;
      if v_issue.status <> 'open' then
        raise exception using errcode = '23514', message = 'ROOM_ISSUE_ALREADY_RESOLVED';
      end if;
      v_before := jsonb_build_object('issueId', v_issue.id, 'status', v_issue.status);
      update public.room_issues
      set status = 'resolved',
          resolved_by = p_actor_profile_id,
          resolved_at = now(),
          resolution_reason_code = p_reason_code,
          version = version + 1
      where id = v_issue.id
      returning * into v_issue;
      v_after := jsonb_build_object('issueId', v_issue.id, 'status', v_issue.status);

    when 'record_pin_sync' then
      insert into public.room_pin_sync_events (
        id,
        room_id,
        sync_status,
        pin_version,
        reason_code,
        actor_profile_id,
        effective_at
      ) values (
        v_entity_id,
        p_room_id,
        p_payload ->> 'syncStatus',
        nullif(p_payload ->> 'pinVersion', '')::bigint,
        p_reason_code,
        p_actor_profile_id,
        now()
      );
      v_after := jsonb_build_object(
        'pinSyncEventId', v_entity_id,
        'syncStatus', p_payload ->> 'syncStatus',
        'pinVersion', nullif(p_payload ->> 'pinVersion', '')::bigint
      );

    else
      raise exception using errcode = '22023', message = 'UNKNOWN_ROOM_OPERATION';
  end case;

  update public.rooms
  set state_version = state_version + 1
  where id = p_room_id
  returning * into v_room;

  v_response := jsonb_build_object(
    'entity_id', v_entity_id,
    'room_id', p_room_id,
    'room_state_version', v_room.state_version,
    'recorded_at', now()
  ) || coalesce(v_after, '{}'::jsonb);

  insert into public.audit_events (
    actor_profile_id,
    actor_display_name_snapshot,
    event_type,
    entity_type,
    entity_id,
    effective_at,
    reason_code,
    before_state,
    after_state,
    request_hash,
    idempotency_key
  )
  select
    p.id,
    p.display_name,
    'room.' || p_action,
    'room',
    p_room_id,
    now(),
    p_reason_code,
    v_before,
    v_after,
    p_request_hash,
    private.audit_command_key(
      p_actor_profile_id,
      'room.operation.' || p_action,
      p_idempotency_key
    )
  from public.profiles p where p.id = p_actor_profile_id;

  perform private.complete_command(
    p_actor_profile_id,
    'room.operation.' || p_action,
    p_idempotency_key,
    p_request_hash,
    p_room_id,
    v_response
  );
  return v_response;
exception
  when invalid_text_representation then
    raise exception using errcode = '22023', message = 'INVALID_ROOM_OPERATION_PAYLOAD';
end;
$$;

alter table public.reservation_schedule_revisions enable row level security;
alter table public.preparation_obligations enable row level security;
alter table public.checkout_cleaning_obligations enable row level security;
alter table public.room_occupancy_events enable row level security;
alter table public.room_operation_blocks enable row level security;
alter table public.room_issues enable row level security;
alter table public.room_candle_events enable row level security;
alter table public.room_pin_sync_events enable row level security;
alter table public.room_pin_access_leases enable row level security;
alter table public.cleaning_target_schedule_revisions enable row level security;

create policy reservation_schedule_revisions_admin_read
on public.reservation_schedule_revisions
for select to authenticated
using ((select private.current_role()) = 'admin');

create policy preparation_obligations_admin_read
on public.preparation_obligations
for select to authenticated
using ((select private.current_role()) = 'admin');

create policy checkout_cleaning_obligations_admin_read
on public.checkout_cleaning_obligations
for select to authenticated
using ((select private.current_role()) = 'admin');

create policy room_occupancy_events_admin_read
on public.room_occupancy_events
for select to authenticated
using ((select private.current_role()) = 'admin');

create policy room_operation_blocks_admin_read
on public.room_operation_blocks
for select to authenticated
using ((select private.current_role()) = 'admin');

create policy room_issues_admin_read
on public.room_issues
for select to authenticated
using ((select private.current_role()) = 'admin');

create policy room_candle_events_admin_read
on public.room_candle_events
for select to authenticated
using ((select private.current_role()) = 'admin');

create policy room_pin_sync_events_admin_read
on public.room_pin_sync_events
for select to authenticated
using ((select private.current_role()) = 'admin');

create policy room_pin_access_leases_scoped_read
on public.room_pin_access_leases
for select to authenticated
using (
  (select private.current_role()) = 'admin'
  or issued_to = (select private.current_profile_id())
);

create policy cleaning_target_schedule_revisions_scoped_read
on public.cleaning_target_schedule_revisions
for select to authenticated
using (
  (select private.current_role()) = 'admin'
  or exists (
    select 1
    from public.cleaning_assignments a
    where a.cleaning_target_id = cleaning_target_schedule_revisions.cleaning_target_id
      and a.maid_profile_id = (select private.current_profile_id())
      and a.is_current
  )
);

revoke all privileges on public.reservation_schedule_revisions from anon, authenticated;
revoke all privileges on public.preparation_obligations from anon, authenticated;
revoke all privileges on public.checkout_cleaning_obligations from anon, authenticated;
revoke all privileges on public.room_occupancy_events from anon, authenticated;
revoke all privileges on public.room_operation_blocks from anon, authenticated;
revoke all privileges on public.room_issues from anon, authenticated;
revoke all privileges on public.room_candle_events from anon, authenticated;
revoke all privileges on public.room_pin_sync_events from anon, authenticated;
revoke all privileges on public.room_pin_access_leases from anon, authenticated;
revoke all privileges on public.cleaning_target_schedule_revisions from anon, authenticated;

grant select on public.reservation_schedule_revisions to authenticated;
grant select on public.preparation_obligations to authenticated;
grant select on public.checkout_cleaning_obligations to authenticated;
grant select on public.room_occupancy_events to authenticated;
grant select on public.room_operation_blocks to authenticated;
grant select on public.room_issues to authenticated;
grant select on public.room_candle_events to authenticated;
grant select on public.room_pin_sync_events to authenticated;
grant select on public.room_pin_access_leases to authenticated;
grant select on public.cleaning_target_schedule_revisions to authenticated;

revoke update, delete, truncate on public.audit_events from service_role;
revoke delete, truncate on public.reservations,
  public.reservation_schedule_revisions,
  public.preparation_obligations,
  public.checkout_cleaning_obligations,
  public.room_occupancy_events,
  public.room_operation_blocks,
  public.room_issues,
  public.room_candle_events,
  public.room_pin_sync_events,
  public.room_pin_access_leases,
  public.cleaning_targets,
  public.cleaning_assignments,
  public.cleaning_attempts,
  public.cleaning_submissions,
  public.submission_photos,
  public.inspection_decisions,
  public.earnings,
  public.payroll_cycles,
  public.notifications,
  public.cleaning_target_schedule_revisions
from service_role;
grant select, insert on public.audit_events to service_role;

grant select, insert on public.reservation_schedule_revisions to service_role;
grant select, insert, update on public.preparation_obligations to service_role;
grant select, insert, update on public.checkout_cleaning_obligations to service_role;
grant select, insert on public.room_occupancy_events to service_role;
grant select, insert, update on public.room_operation_blocks to service_role;
grant select, insert, update on public.room_issues to service_role;
grant select, insert on public.room_candle_events to service_role;
grant select, insert on public.room_pin_sync_events to service_role;
grant select, insert, update on public.room_pin_access_leases to service_role;
grant select, insert on public.cleaning_target_schedule_revisions to service_role;

revoke all on function private.assert_active_actor(uuid) from public, anon, authenticated;
revoke all on function private.assert_room_admin(uuid) from public, anon, authenticated;
revoke all on function private.replay_command(uuid, text, text, text) from public, anon, authenticated;
revoke all on function private.complete_command(uuid, text, text, text, uuid, jsonb) from public, anon, authenticated;
revoke all on function private.audit_command_key(uuid, text, text) from public, anon, authenticated;
revoke all on function private.current_candle_count(uuid) from public, anon, authenticated;
revoke all on function private.current_pin_sync_status(uuid) from public, anon, authenticated;
revoke all on function private.room_block_reason_codes(uuid, timestamptz, boolean, boolean, uuid) from public, anon, authenticated;
revoke all on function private.reservation_response(public.reservations) from public, anon, authenticated;
revoke all on function private.refresh_checkout_due_at(uuid, uuid) from public, anon, authenticated;

revoke all on function public.get_room_operational_projection(uuid, uuid) from public, anon, authenticated;
revoke all on function public.change_room_master_data(
  uuid, uuid, uuid, text, public.data_status, text, bigint, text, text, text
) from public, anon, authenticated;
revoke all on function public.create_reservation(
  uuid, uuid, uuid, timestamptz, timestamptz, integer, text, bigint, text, text
) from public, anon, authenticated;
revoke all on function public.change_reservation(
  uuid, uuid, uuid, timestamptz, timestamptz, integer, text, text, bigint, text, text, text
) from public, anon, authenticated;
revoke all on function public.cancel_reservation(
  uuid, uuid, bigint, text, text, text
) from public, anon, authenticated;
revoke all on function public.manual_checkout_reservation(
  uuid, uuid, bigint, text, timestamptz, text, text
) from public, anon, authenticated;
revoke all on function public.process_due_reservation_transitions(
  uuid, timestamptz, text, text
) from public, anon, authenticated;
revoke all on function public.create_manual_cleaning_request(
  uuid, uuid, uuid, uuid, public.cleaning_kind, date, timestamptz, timestamptz,
  bigint, text, text, text
) from public, anon, authenticated;
revoke all on function public.cancel_manual_cleaning_request(
  uuid, uuid, bigint, text, text, text
) from public, anon, authenticated;
revoke all on function public.list_reservations(uuid, uuid) from public, anon, authenticated;
revoke all on function public.get_reservation_detail(uuid, uuid) from public, anon, authenticated;
revoke all on function public.mutate_room_operation(
  uuid, uuid, text, bigint, text, jsonb, text, text
) from public, anon, authenticated;

grant execute on function public.get_room_operational_projection(uuid, uuid) to service_role;
grant execute on function public.change_room_master_data(
  uuid, uuid, uuid, text, public.data_status, text, bigint, text, text, text
) to service_role;
grant execute on function public.create_reservation(
  uuid, uuid, uuid, timestamptz, timestamptz, integer, text, bigint, text, text
) to service_role;
grant execute on function public.change_reservation(
  uuid, uuid, uuid, timestamptz, timestamptz, integer, text, text, bigint, text, text, text
) to service_role;
grant execute on function public.cancel_reservation(
  uuid, uuid, bigint, text, text, text
) to service_role;
grant execute on function public.manual_checkout_reservation(
  uuid, uuid, bigint, text, timestamptz, text, text
) to service_role;
grant execute on function public.process_due_reservation_transitions(
  uuid, timestamptz, text, text
) to service_role;
grant execute on function public.create_manual_cleaning_request(
  uuid, uuid, uuid, uuid, public.cleaning_kind, date, timestamptz, timestamptz,
  bigint, text, text, text
) to service_role;
grant execute on function public.cancel_manual_cleaning_request(
  uuid, uuid, bigint, text, text, text
) to service_role;
grant execute on function public.list_reservations(uuid, uuid) to service_role;
grant execute on function public.get_reservation_detail(uuid, uuid) to service_role;
grant execute on function public.mutate_room_operation(
  uuid, uuid, text, bigint, text, jsonb, text, text
) to service_role;
