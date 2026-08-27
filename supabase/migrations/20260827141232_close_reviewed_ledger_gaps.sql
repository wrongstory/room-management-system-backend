-- Review hardening: provenance and payment snapshots must not be rewritable
-- after downstream assignments or payment execution exist.

create or replace function private.enforce_reclean_origin_room()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_origin_room_id uuid;
begin
  if tg_op = 'UPDATE' and (
    new.source is distinct from old.source
    or new.reclean_of_attempt_id is distinct from old.reclean_of_attempt_id
    or new.reclean_maid_profile_id is distinct from old.reclean_maid_profile_id
  ) then
    raise exception using errcode = '55000', message = 'CLEANING_TARGET_ORIGIN_IMMUTABLE';
  end if;

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

revoke all on function private.enforce_reclean_origin_room() from public, anon, authenticated;

create or replace function private.set_payroll_item_amount()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_earned_on date;
  v_week_start date;
  v_cycle_status public.payment_status;
begin
  select e.total_amount, e.earned_on, pc.week_start, pc.status
  into new.locked_amount, v_earned_on, v_week_start, v_cycle_status
  from public.earnings e
  join public.payroll_cycles pc
    on pc.id = new.payroll_cycle_id
   and pc.maid_profile_id = new.maid_profile_id
  where e.id = new.earning_id
    and e.maid_profile_id = new.maid_profile_id;

  if not found then
    raise exception using errcode = '23503', message = 'PAYROLL_ITEM_SOURCE_MISMATCH';
  end if;
  if v_cycle_status <> 'open' then
    raise exception using errcode = '55000', message = 'PAYROLL_CYCLE_NOT_OPEN';
  end if;
  if v_earned_on < v_week_start or v_earned_on >= v_week_start + 7 then
    raise exception using errcode = '23514', message = 'EARNING_OUTSIDE_PAYROLL_WEEK';
  end if;

  return new;
end;
$$;

revoke all on function private.set_payroll_item_amount() from public, anon, authenticated;

create function private.prevent_payroll_cycle_snapshot_rewrite()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if new.maid_profile_id is distinct from old.maid_profile_id
    or new.week_start is distinct from old.week_start then
    raise exception using errcode = '55000', message = 'PAYROLL_CYCLE_IDENTITY_IMMUTABLE';
  end if;

  if old.status <> 'open' and (
    new.locked_amount is distinct from old.locked_amount
    or new.payment_started_by is distinct from old.payment_started_by
    or new.payment_started_at is distinct from old.payment_started_at
  ) then
    raise exception using errcode = '55000', message = 'PAYROLL_LOCK_SNAPSHOT_IMMUTABLE';
  end if;

  if old.status = 'paid' and (
    new.status is distinct from old.status
    or new.paid_at is distinct from old.paid_at
    or new.check_reason is distinct from old.check_reason
  ) then
    raise exception using errcode = '55000', message = 'PAID_PAYROLL_IMMUTABLE';
  end if;

  return new;
end;
$$;

revoke all on function private.prevent_payroll_cycle_snapshot_rewrite() from public, anon, authenticated;

create trigger payroll_cycles_prevent_snapshot_rewrite
before update of maid_profile_id, week_start, status, locked_amount,
  payment_started_by, payment_started_at, paid_at, check_reason
on public.payroll_cycles
for each row execute function private.prevent_payroll_cycle_snapshot_rewrite();
