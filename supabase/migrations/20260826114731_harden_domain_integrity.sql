-- Correct domain constraints that were too weak or contradicted the canonical
-- frontend policies. Business writes remain service-role commands only.

alter table public.reservations
  add constraint reservations_id_room_unique unique (id, room_id),
  add constraint reservations_status_timestamps_check check (
    (
      status = 'active'
      and cancelled_at is null
      and actual_checkout_at is null
    )
    or (
      status = 'cancelled'
      and cancelled_at is not null
      and actual_checkout_at is null
    )
    or (
      status = 'checked_out'
      and cancelled_at is null
      and actual_checkout_at is not null
      and actual_checkout_at >= check_in_at
    )
  );

drop index public.cleaning_targets_one_active_per_room;

alter table public.cleaning_targets
  drop constraint cleaning_targets_source_check,
  add column reclean_of_attempt_id uuid,
  add column reclean_maid_profile_id uuid,
  add constraint cleaning_targets_source_check check (source in (
    'scheduled_checkout',
    'manual_checkout',
    'stayover_request',
    'manual_room_request',
    'inspection_reclean',
    'post_approval_complaint_reclean'
  )),
  add constraint cleaning_targets_source_kind_check check (
    (
      source in ('scheduled_checkout', 'manual_checkout')
      and cleaning_kind = 'checkout'
      and reservation_id is not null
    )
    or (
      source = 'stayover_request'
      and cleaning_kind = 'stayover'
      and reservation_id is not null
    )
    or (source = 'manual_room_request' and cleaning_kind = 'additional')
    or (source in ('inspection_reclean', 'post_approval_complaint_reclean') and cleaning_kind = 'reclean')
  ),
  add constraint cleaning_targets_reclean_origin_check check (
    (
      source = 'inspection_reclean'
      and reclean_of_attempt_id is not null
      and reclean_maid_profile_id is not null
    )
    or (
      source <> 'inspection_reclean'
      and reclean_of_attempt_id is null
      and reclean_maid_profile_id is null
    )
  ),
  add constraint cleaning_targets_reservation_room_fk
    foreign key (reservation_id, room_id)
    references public.reservations (id, room_id)
    on delete restrict;

create unique index cleaning_targets_one_checkout_per_reservation
on public.cleaning_targets (reservation_id)
where reservation_id is not null and cleaning_kind = 'checkout';

create function private.enforce_reclean_origin_room()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_origin_room_id uuid;
begin
  if new.source <> 'inspection_reclean' then
    return new;
  end if;

  select t.room_id into v_origin_room_id
  from public.cleaning_attempts a
  join public.cleaning_targets t on t.id = a.cleaning_target_id
  where a.id = new.reclean_of_attempt_id
    and a.maid_profile_id = new.reclean_maid_profile_id;

  if not found then
    raise exception using errcode = '23503', message = 'RECLEAN_ORIGIN_NOT_FOUND';
  end if;
  if new.room_id <> v_origin_room_id then
    raise exception using errcode = '23514', message = 'RECLEAN_ROOM_MISMATCH';
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_reclean_origin_room() from public;

create trigger cleaning_targets_enforce_reclean_origin
before insert or update of room_id, source, reclean_of_attempt_id, reclean_maid_profile_id
on public.cleaning_targets
for each row execute function private.enforce_reclean_origin_room();

alter table public.cleaning_assignments
  add constraint cleaning_assignments_attempt_reference_unique
    unique (id, cleaning_target_id, maid_profile_id, revision),
  add constraint cleaning_assignments_current_end_check check (
    (is_current and ended_at is null)
    or (not is_current and ended_at is not null)
  );

alter table public.cleaning_attempts
  add constraint cleaning_attempts_id_maid_unique unique (id, maid_profile_id),
  add constraint cleaning_attempts_assignment_contract_fk
    foreign key (
      assignment_id,
      cleaning_target_id,
      maid_profile_id,
      assignment_revision
    )
    references public.cleaning_assignments (
      id,
      cleaning_target_id,
      maid_profile_id,
      revision
    )
    on delete restrict;

alter table public.cleaning_targets
  add constraint cleaning_targets_reclean_attempt_unique unique (reclean_of_attempt_id),
  add constraint cleaning_targets_reclean_attempt_maid_fk
    foreign key (reclean_of_attempt_id, reclean_maid_profile_id)
    references public.cleaning_attempts (id, maid_profile_id)
    on delete restrict;

create function private.enforce_cleaning_assignment_contract()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_reclean_maid_profile_id uuid;
begin
  if not exists (
    select 1
    from public.profiles p
    where p.id = new.maid_profile_id
      and p.role = 'maid'
      and p.status = 'active'
  ) then
    raise exception using errcode = '23514', message = 'ACTIVE_MAID_REQUIRED';
  end if;

  select t.reclean_maid_profile_id into v_reclean_maid_profile_id
  from public.cleaning_targets t
  where t.id = new.cleaning_target_id
    and t.source = 'inspection_reclean';

  if found and new.maid_profile_id <> v_reclean_maid_profile_id then
    raise exception using errcode = '23514', message = 'RECLEAN_MAID_IMMUTABLE';
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_cleaning_assignment_contract() from public;

create trigger cleaning_assignments_enforce_contract
before insert or update of cleaning_target_id, maid_profile_id
on public.cleaning_assignments
for each row execute function private.enforce_cleaning_assignment_contract();

alter table public.cleaning_submissions
  add constraint cleaning_submissions_id_submitter_unique unique (id, submitted_by),
  add constraint cleaning_submissions_attempt_maid_fk
    foreign key (cleaning_attempt_id, submitted_by)
    references public.cleaning_attempts (id, maid_profile_id)
    on delete restrict;

alter table public.earnings
  drop column reclean_compensation_decision_id,
  alter column earning_entitlement_id set not null,
  add constraint earnings_submission_maid_fk
    foreign key (submission_id, maid_profile_id)
    references public.cleaning_submissions (id, submitted_by)
    on delete restrict,
  add constraint earnings_bomb_bonus_exact_check check (
    bomb_room_bonus = 0 or bomb_room_bonus = base_amount
  ),
  add constraint earnings_id_maid_unique unique (id, maid_profile_id);

alter table public.payroll_cycles
  drop column locked_earning_ids,
  add constraint payroll_cycles_id_maid_unique unique (id, maid_profile_id),
  add constraint payroll_cycles_state_check check (
    (
      status = 'open'
      and locked_amount is null
      and payment_started_by is null
      and payment_started_at is null
      and paid_at is null
      and check_reason is null
    )
    or (
      status = 'paying'
      and locked_amount is not null
      and payment_started_by is not null
      and payment_started_at is not null
      and paid_at is null
      and check_reason is null
    )
    or (
      status = 'check'
      and locked_amount is not null
      and payment_started_by is not null
      and payment_started_at is not null
      and paid_at is null
      and nullif(btrim(check_reason), '') is not null
    )
    or (
      status = 'paid'
      and locked_amount is not null
      and payment_started_by is not null
      and payment_started_at is not null
      and paid_at is not null
    )
  );

create table public.payroll_items (
  id uuid primary key default gen_random_uuid(),
  payroll_cycle_id uuid not null,
  earning_id uuid not null unique,
  maid_profile_id uuid not null,
  locked_amount integer not null check (locked_amount >= 0),
  created_at timestamptz not null default now(),
  constraint payroll_items_cycle_maid_fk
    foreign key (payroll_cycle_id, maid_profile_id)
    references public.payroll_cycles (id, maid_profile_id)
    on delete restrict,
  constraint payroll_items_earning_maid_fk
    foreign key (earning_id, maid_profile_id)
    references public.earnings (id, maid_profile_id)
    on delete restrict,
  unique (payroll_cycle_id, earning_id)
);

create function private.set_payroll_item_amount()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  select e.total_amount into new.locked_amount
  from public.earnings e
  where e.id = new.earning_id
    and e.maid_profile_id = new.maid_profile_id;

  if not found then
    raise exception using errcode = '23503', message = 'EARNING_MAID_MISMATCH';
  end if;

  return new;
end;
$$;

revoke all on function private.set_payroll_item_amount() from public;

create trigger payroll_items_set_amount
before insert on public.payroll_items
for each row execute function private.set_payroll_item_amount();

create function private.prevent_payroll_item_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception using errcode = '55000', message = 'PAYROLL_ITEM_IMMUTABLE';
end;
$$;

revoke all on function private.prevent_payroll_item_mutation() from public;

create trigger payroll_items_prevent_mutation
before update or delete on public.payroll_items
for each row execute function private.prevent_payroll_item_mutation();

create function private.assert_payroll_cycle_total(p_payroll_cycle_id uuid)
returns void
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_cycle public.payroll_cycles%rowtype;
  v_item_count bigint;
  v_item_total bigint;
begin
  select * into v_cycle
  from public.payroll_cycles pc
  where pc.id = p_payroll_cycle_id;

  if not found then
    return;
  end if;

  select count(*), coalesce(sum(pi.locked_amount), 0)
  into v_item_count, v_item_total
  from public.payroll_items pi
  where pi.payroll_cycle_id = p_payroll_cycle_id;

  if v_cycle.status = 'open' then
    if v_item_count <> 0 then
      raise exception using errcode = '23514', message = 'OPEN_PAYROLL_CANNOT_HAVE_ITEMS';
    end if;
  elsif v_item_count = 0 or v_cycle.locked_amount <> v_item_total then
    raise exception using errcode = '23514', message = 'PAYROLL_LOCKED_AMOUNT_MISMATCH';
  end if;
end;
$$;

revoke all on function private.assert_payroll_cycle_total(uuid) from public;

create function private.check_payroll_item_cycle_total()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'DELETE' then
    perform private.assert_payroll_cycle_total(old.payroll_cycle_id);
  else
    perform private.assert_payroll_cycle_total(new.payroll_cycle_id);
  end if;
  return null;
end;
$$;

revoke all on function private.check_payroll_item_cycle_total() from public;

create constraint trigger payroll_items_check_cycle_total
after insert or update or delete on public.payroll_items
deferrable initially deferred
for each row execute function private.check_payroll_item_cycle_total();

create function private.check_payroll_cycle_total()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  perform private.assert_payroll_cycle_total(new.id);
  return new;
end;
$$;

revoke all on function private.check_payroll_cycle_total() from public;

create constraint trigger payroll_cycles_check_total
after insert or update of status, locked_amount on public.payroll_cycles
deferrable initially deferred
for each row execute function private.check_payroll_cycle_total();

create index payroll_items_payroll_cycle_id_idx
on public.payroll_items (payroll_cycle_id);

create index payroll_items_maid_profile_id_idx
on public.payroll_items (maid_profile_id);

alter table public.payroll_items enable row level security;

create policy payroll_items_read_scoped on public.payroll_items
for select to authenticated
using (
  (select private.current_role()) = 'admin'
  or maid_profile_id = (select private.current_profile_id())
);

revoke all privileges on public.payroll_items from anon, authenticated;
grant select on public.payroll_items to authenticated;
grant all privileges on public.payroll_items to service_role;
