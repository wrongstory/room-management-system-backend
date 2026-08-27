-- Allow an explicitly recorded recovery from an unconfirmed payment attempt
-- without weakening paid-ledger immutability.

alter table public.payroll_cycles
  add column last_reopen_reason text,
  add column last_reopened_by uuid references public.profiles(id),
  add column last_reopened_at timestamptz,
  add constraint payroll_cycles_reopen_record_check check (
    (
      last_reopen_reason is null
      and last_reopened_by is null
      and last_reopened_at is null
    )
    or (
      nullif(btrim(last_reopen_reason), '') is not null
      and last_reopened_by is not null
      and last_reopened_at is not null
    )
  );

create index payroll_cycles_last_reopened_by_idx
on public.payroll_cycles (last_reopened_by)
where last_reopened_by is not null;

create or replace function private.prevent_payroll_cycle_snapshot_rewrite()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_is_reopen boolean := old.status in ('paying', 'check') and new.status = 'open';
begin
  if new.maid_profile_id is distinct from old.maid_profile_id
    or new.week_start is distinct from old.week_start then
    raise exception using errcode = '55000', message = 'PAYROLL_CYCLE_IDENTITY_IMMUTABLE';
  end if;

  if old.status = 'paid' and (
    new.status is distinct from old.status
    or new.locked_amount is distinct from old.locked_amount
    or new.payment_started_by is distinct from old.payment_started_by
    or new.payment_started_at is distinct from old.payment_started_at
    or new.paid_at is distinct from old.paid_at
    or new.check_reason is distinct from old.check_reason
    or new.last_reopen_reason is distinct from old.last_reopen_reason
    or new.last_reopened_by is distinct from old.last_reopened_by
    or new.last_reopened_at is distinct from old.last_reopened_at
  ) then
    raise exception using errcode = '55000', message = 'PAID_PAYROLL_IMMUTABLE';
  end if;

  if v_is_reopen then
    if new.locked_amount is not null
      or new.payment_started_by is not null
      or new.payment_started_at is not null
      or new.paid_at is not null
      or new.check_reason is not null then
      raise exception using errcode = '23514', message = 'PAYROLL_REOPEN_SNAPSHOT_NOT_CLEARED';
    end if;

    if nullif(btrim(new.last_reopen_reason), '') is null
      or new.last_reopened_by is null
      or new.last_reopened_at is null then
      raise exception using errcode = '23514', message = 'PAYROLL_REOPEN_REASON_REQUIRED';
    end if;

    if new.last_reopened_at < old.payment_started_at then
      raise exception using errcode = '23514', message = 'PAYROLL_REOPEN_TIME_INVALID';
    end if;

    if new.version <> old.version + 1 then
      raise exception using errcode = '40001', message = 'PAYROLL_REOPEN_VERSION_MISMATCH';
    end if;
  elsif old.status <> 'open' and (
    new.locked_amount is distinct from old.locked_amount
    or new.payment_started_by is distinct from old.payment_started_by
    or new.payment_started_at is distinct from old.payment_started_at
  ) then
    raise exception using errcode = '55000', message = 'PAYROLL_LOCK_SNAPSHOT_IMMUTABLE';
  end if;

  if not v_is_reopen and (
    new.last_reopen_reason is distinct from old.last_reopen_reason
    or new.last_reopened_by is distinct from old.last_reopened_by
    or new.last_reopened_at is distinct from old.last_reopened_at
  ) then
    raise exception using errcode = '55000', message = 'PAYROLL_REOPEN_RECORD_IMMUTABLE';
  end if;

  return new;
end;
$$;

revoke all on function private.prevent_payroll_cycle_snapshot_rewrite()
from public, anon, authenticated;

create or replace function private.assert_payroll_cycle_total(p_payroll_cycle_id uuid)
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

  -- OPEN cycles may retain and append candidate items. The amount snapshot is
  -- locked only when the cycle enters PAYING again.
  if v_cycle.status <> 'open'
    and (v_item_count = 0 or v_cycle.locked_amount <> v_item_total) then
    raise exception using errcode = '23514', message = 'PAYROLL_LOCKED_AMOUNT_MISMATCH';
  end if;
end;
$$;

revoke all on function private.assert_payroll_cycle_total(uuid)
from public, anon, authenticated;
