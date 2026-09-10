-- Issue #102: immutable signed payroll adjustments, full reversals and
-- non-positive carry-forward. This is the 39th append-only migration.

alter table public.payroll_cycles
  add column offset_settled_at timestamptz,
  add column offset_settled_by uuid references public.profiles(id) on delete restrict,
  add constraint payroll_cycles_offset_settlement_projection_check check (
    (offset_settled_at is null and offset_settled_by is null)
    or (offset_settled_at is not null and offset_settled_by is not null and status = 'open')
  );

create table public.payroll_adjustment_books (
  maid_profile_id uuid primary key references public.profiles(id) on delete restrict,
  version bigint not null default 0 check (version >= 0),
  updated_at timestamptz not null default now()
);

create table public.payroll_adjustments (
  id uuid primary key default gen_random_uuid(),
  maid_profile_id uuid not null references public.profiles(id) on delete restrict,
  book_version bigint not null check (book_version > 0),
  amount integer not null check (amount <> 0),
  currency text not null default 'KRW' check (currency = 'KRW'),
  reason_code text not null check (reason_code in (
    'earning_correction','adjustment_correction','earning_reversal',
    'adjustment_reversal','late_earning_carry'
  )),
  root_earning_id uuid not null references public.earnings(id) on delete restrict,
  correction_of_earning_id uuid references public.earnings(id) on delete restrict,
  correction_of_adjustment_id uuid references public.payroll_adjustments(id) on delete restrict,
  reversal_of_earning_id uuid references public.earnings(id) on delete restrict,
  reversal_of_adjustment_id uuid references public.payroll_adjustments(id) on delete restrict,
  late_carried_earning_id uuid references public.earnings(id) on delete restrict,
  available_week_start date not null check (extract(isodow from available_week_start) = 1),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (maid_profile_id, book_version),
  unique (reversal_of_earning_id),
  unique (reversal_of_adjustment_id),
  unique (late_carried_earning_id),
  check (num_nonnulls(
    correction_of_earning_id, correction_of_adjustment_id,
    reversal_of_earning_id, reversal_of_adjustment_id, late_carried_earning_id
  ) = 1),
  check (
    (reason_code='earning_correction' and correction_of_earning_id is not null)
    or (reason_code='adjustment_correction' and correction_of_adjustment_id is not null)
    or (reason_code='earning_reversal' and reversal_of_earning_id is not null)
    or (reason_code='adjustment_reversal' and reversal_of_adjustment_id is not null)
    or (reason_code='late_earning_carry' and late_carried_earning_id is not null and amount > 0)
  ),
  check (correction_of_adjustment_id is null or correction_of_adjustment_id <> id),
  check (reversal_of_adjustment_id is null or reversal_of_adjustment_id <> id)
);

create table public.payroll_adjustment_items (
  id uuid primary key default gen_random_uuid(),
  payroll_cycle_id uuid not null,
  adjustment_id uuid not null unique references public.payroll_adjustments(id) on delete restrict,
  maid_profile_id uuid not null,
  locked_amount integer not null check (locked_amount <> 0),
  created_at timestamptz not null default now(),
  constraint payroll_adjustment_items_cycle_maid_fk foreign key (payroll_cycle_id,maid_profile_id)
    references public.payroll_cycles(id,maid_profile_id) on delete restrict,
  unique (payroll_cycle_id,adjustment_id)
);

create table public.payroll_residual_carries (
  id uuid primary key default gen_random_uuid(),
  maid_profile_id uuid not null references public.profiles(id) on delete restrict,
  source_settlement_id uuid not null unique,
  available_week_start date not null check (extract(isodow from available_week_start)=1),
  amount integer not null check (amount > 0),
  currency text not null default 'KRW' check (currency='KRW'),
  created_at timestamptz not null default now(),
  unique (id,maid_profile_id)
);

create table public.payroll_carry_items (
  id uuid primary key default gen_random_uuid(),
  payroll_cycle_id uuid not null,
  carry_id uuid not null unique,
  maid_profile_id uuid not null,
  locked_amount integer not null check (locked_amount > 0),
  created_at timestamptz not null default now(),
  constraint payroll_carry_items_cycle_maid_fk foreign key (payroll_cycle_id,maid_profile_id)
    references public.payroll_cycles(id,maid_profile_id) on delete restrict,
  constraint payroll_carry_items_carry_maid_fk foreign key (carry_id,maid_profile_id)
    references public.payroll_residual_carries(id,maid_profile_id) on delete restrict,
  unique (payroll_cycle_id,carry_id)
);

create table public.payroll_offset_settlements (
  id uuid primary key default gen_random_uuid(),
  payroll_cycle_id uuid not null unique references public.payroll_cycles(id) on delete restrict,
  maid_profile_id uuid not null references public.profiles(id) on delete restrict,
  week_start date not null,
  cycle_version bigint not null check (cycle_version > 0),
  earning_amount integer not null check (earning_amount >= 0),
  adjustment_amount integer not null,
  carry_in_amount integer not null check (carry_in_amount <= 0),
  net_amount integer not null check (net_amount <= 0),
  carry_out_id uuid unique,
  settled_by uuid not null references public.profiles(id) on delete restrict,
  settled_at timestamptz not null,
  currency text not null default 'KRW' check (currency='KRW'),
  constraint payroll_offset_settlements_cycle_maid_fk foreign key (payroll_cycle_id,maid_profile_id)
    references public.payroll_cycles(id,maid_profile_id) on delete restrict,
  check (net_amount = earning_amount + adjustment_amount + carry_in_amount),
  check ((net_amount=0 and carry_out_id is null) or (net_amount<0 and carry_out_id is not null))
);

alter table public.payroll_residual_carries
  add constraint payroll_residual_carries_source_fk foreign key (source_settlement_id)
    references public.payroll_offset_settlements(id) on delete restrict deferrable initially deferred;
alter table public.payroll_offset_settlements
  add constraint payroll_offset_settlements_carry_out_fk foreign key (carry_out_id)
    references public.payroll_residual_carries(id) on delete restrict deferrable initially deferred;

create index payroll_adjustments_maid_available_idx
on public.payroll_adjustments(maid_profile_id,available_week_start,created_at,id);
create index payroll_adjustments_root_idx on public.payroll_adjustments(root_earning_id,created_at,id);
create index payroll_adjustments_correction_earning_idx on public.payroll_adjustments(correction_of_earning_id)
where correction_of_earning_id is not null;
create index payroll_adjustments_correction_adjustment_idx on public.payroll_adjustments(correction_of_adjustment_id)
where correction_of_adjustment_id is not null;
create index payroll_adjustment_items_cycle_idx on public.payroll_adjustment_items(payroll_cycle_id);
create index payroll_adjustment_items_maid_idx on public.payroll_adjustment_items(maid_profile_id);
create index payroll_residual_carries_available_idx
on public.payroll_residual_carries(maid_profile_id,available_week_start,created_at,id);
create index payroll_carry_items_cycle_idx on public.payroll_carry_items(payroll_cycle_id);
create index payroll_offset_settlements_maid_week_idx
on public.payroll_offset_settlements(maid_profile_id,week_start);

create function private.prevent_payroll_ledger_mutation()
returns trigger language plpgsql set search_path='' as $$
begin
  raise exception using errcode='55000',message='PAYROLL_LEDGER_IMMUTABLE';
end $$;
revoke all on function private.prevent_payroll_ledger_mutation()
from public,anon,authenticated,service_role;

create trigger payroll_adjustments_append_only before update or delete on public.payroll_adjustments
for each row execute function private.prevent_payroll_ledger_mutation();
create trigger payroll_adjustment_items_append_only before update or delete on public.payroll_adjustment_items
for each row execute function private.prevent_payroll_ledger_mutation();
create trigger payroll_residual_carries_append_only before update or delete on public.payroll_residual_carries
for each row execute function private.prevent_payroll_ledger_mutation();
create trigger payroll_carry_items_append_only before update or delete on public.payroll_carry_items
for each row execute function private.prevent_payroll_ledger_mutation();
create trigger payroll_offset_settlements_append_only before update or delete on public.payroll_offset_settlements
for each row execute function private.prevent_payroll_ledger_mutation();

create function private.set_payroll_adjustment_item_amount()
returns trigger language plpgsql set search_path='' as $$
begin
  select adjustment.amount into new.locked_amount
  from public.payroll_adjustments adjustment
  where adjustment.id=new.adjustment_id and adjustment.maid_profile_id=new.maid_profile_id;
  if not found then raise exception using errcode='23503',message='ADJUSTMENT_MAID_MISMATCH'; end if;
  return new;
end $$;
revoke all on function private.set_payroll_adjustment_item_amount()
from public,anon,authenticated,service_role;
create trigger payroll_adjustment_items_set_amount before insert on public.payroll_adjustment_items
for each row execute function private.set_payroll_adjustment_item_amount();

create function private.set_payroll_carry_item_amount()
returns trigger language plpgsql set search_path='' as $$
begin
  select carry.amount into new.locked_amount from public.payroll_residual_carries carry
  where carry.id=new.carry_id and carry.maid_profile_id=new.maid_profile_id;
  if not found then raise exception using errcode='23503',message='CARRY_MAID_MISMATCH'; end if;
  return new;
end $$;
revoke all on function private.set_payroll_carry_item_amount()
from public,anon,authenticated,service_role;
create trigger payroll_carry_items_set_amount before insert on public.payroll_carry_items
for each row execute function private.set_payroll_carry_item_amount();

create function private.payroll_rls_session_is_active()
returns boolean language plpgsql stable security definer set search_path='' as $$
declare v_user uuid; v_text text; v_session uuid;
begin
  v_user:=auth.uid(); v_text:=auth.jwt()->>'session_id';
  if v_user is null or v_text is null or v_text='' then return false; end if;
  begin v_session:=v_text::uuid; exception when invalid_text_representation then return false; end;
  return exists(select 1 from auth.sessions session where session.id=v_session
    and session.user_id=v_user and (session.not_after is null or session.not_after>current_timestamp));
end $$;
revoke all on function private.payroll_rls_session_is_active()
from public,anon,authenticated,service_role;
grant execute on function private.payroll_rls_session_is_active() to authenticated;

create or replace function private.can_read_payroll_row(p_maid_profile_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select private.payroll_rls_session_is_active() and exists(
    select 1 from public.profiles actor where actor.auth_user_id=auth.uid()
      and actor.status='active' and not actor.must_change_password
      and (actor.role='admin' or (actor.role='maid' and actor.id=p_maid_profile_id)))
$$;

alter table public.payroll_adjustment_books enable row level security;
alter table public.payroll_adjustments enable row level security;
alter table public.payroll_adjustment_items enable row level security;
alter table public.payroll_residual_carries enable row level security;
alter table public.payroll_carry_items enable row level security;
alter table public.payroll_offset_settlements enable row level security;

create policy payroll_adjustment_books_read on public.payroll_adjustment_books for select to authenticated
using ((select private.can_read_payroll_row(maid_profile_id)));
create policy payroll_adjustments_read on public.payroll_adjustments for select to authenticated
using ((select private.can_read_payroll_row(maid_profile_id)));
create policy payroll_adjustment_items_read on public.payroll_adjustment_items for select to authenticated
using ((select private.can_read_payroll_row(maid_profile_id)));
create policy payroll_residual_carries_read on public.payroll_residual_carries for select to authenticated
using ((select private.can_read_payroll_row(maid_profile_id)));
create policy payroll_carry_items_read on public.payroll_carry_items for select to authenticated
using ((select private.can_read_payroll_row(maid_profile_id)));
create policy payroll_offset_settlements_read on public.payroll_offset_settlements for select to authenticated
using ((select private.can_read_payroll_row(maid_profile_id)));

-- Apply the live-session fence to all pre-existing payroll Data API reads too.
drop policy if exists earnings_read_scoped on public.earnings;
create policy earnings_read_scoped on public.earnings for select to authenticated
using ((select private.can_read_payroll_row(earnings.maid_profile_id)));
drop policy if exists payroll_read_scoped on public.payroll_cycles;
create policy payroll_read_scoped on public.payroll_cycles for select to authenticated
using ((select private.can_read_payroll_row(payroll_cycles.maid_profile_id)));
drop policy if exists payroll_items_read_scoped on public.payroll_items;
create policy payroll_items_read_scoped on public.payroll_items for select to authenticated
using ((select private.can_read_payroll_row(payroll_items.maid_profile_id)));
drop policy if exists payroll_events_read_scoped on public.payroll_events;
create policy payroll_events_read_scoped on public.payroll_events for select to authenticated
using ((select private.can_read_payroll_row(payroll_events.maid_profile_id)));

create function private.validate_payroll_adjustment()
returns trigger language plpgsql set search_path='' as $$
declare
  v_earning public.earnings;
  v_source public.payroll_adjustments;
  v_root_total bigint;
begin
  if new.correction_of_earning_id is not null
    or new.reversal_of_earning_id is not null
    or new.late_carried_earning_id is not null then
    select * into v_earning from public.earnings
    where id=coalesce(new.correction_of_earning_id,new.reversal_of_earning_id,new.late_carried_earning_id);
    if v_earning.id is null then raise exception using errcode='23503',message='PAYROLL_SOURCE_NOT_FOUND'; end if;
    if v_earning.maid_profile_id<>new.maid_profile_id or new.root_earning_id<>v_earning.id then
      raise exception using errcode='23514',message='PAYROLL_SOURCE_MISMATCH'; end if;
    if new.reason_code='earning_reversal' and new.amount<>-v_earning.total_amount then
      raise exception using errcode='23514',message='PAYROLL_REVERSAL_AMOUNT_INVALID'; end if;
    if new.reason_code='late_earning_carry' and new.amount<>v_earning.total_amount then
      raise exception using errcode='23514',message='PAYROLL_LATE_CARRY_AMOUNT_INVALID'; end if;
  else
    select * into v_source from public.payroll_adjustments
    where id=coalesce(new.correction_of_adjustment_id,new.reversal_of_adjustment_id);
    if v_source.id is null then raise exception using errcode='23503',message='PAYROLL_SOURCE_NOT_FOUND'; end if;
    if v_source.maid_profile_id<>new.maid_profile_id
      or v_source.currency<>new.currency or v_source.root_earning_id<>new.root_earning_id
      or v_source.created_at>new.created_at
      or v_source.reason_code='late_earning_carry' then
      raise exception using errcode='23514',message='PAYROLL_SOURCE_MISMATCH'; end if;
    if new.reason_code='adjustment_reversal' and new.amount<>-v_source.amount then
      raise exception using errcode='23514',message='PAYROLL_REVERSAL_AMOUNT_INVALID'; end if;
  end if;

  if new.reason_code<>'late_earning_carry' then
    select earning.total_amount + coalesce(sum(adjustment.amount),0)
    into v_root_total
    from public.earnings earning
    left join public.payroll_adjustments adjustment
      on adjustment.root_earning_id=earning.id and adjustment.reason_code<>'late_earning_carry'
    where earning.id=new.root_earning_id
    group by earning.total_amount;
    if coalesce(v_root_total,0)+new.amount<0 then
      raise exception using errcode='23514',message='PAYROLL_ROOT_ENTITLEMENT_NEGATIVE'; end if;
  end if;
  return new;
end $$;
revoke all on function private.validate_payroll_adjustment()
from public,anon,authenticated,service_role;
create trigger payroll_adjustments_validate before insert on public.payroll_adjustments
for each row execute function private.validate_payroll_adjustment();

create function private.guard_payroll_adjustment_item()
returns trigger language plpgsql set search_path='' as $$
declare v_adjustment public.payroll_adjustments; v_cycle public.payroll_cycles;
begin
  select * into v_adjustment from public.payroll_adjustments where id=new.adjustment_id;
  select * into v_cycle from public.payroll_cycles where id=new.payroll_cycle_id;
  if v_adjustment.id is null or v_cycle.id is null
    or v_adjustment.maid_profile_id<>v_cycle.maid_profile_id
    or v_adjustment.available_week_start<>v_cycle.week_start then
    raise exception using errcode='23514',message='PAYROLL_ADJUSTMENT_CYCLE_MISMATCH'; end if;
  if v_cycle.status<>'open' or v_cycle.offset_settled_at is not null then
    raise exception using errcode='55000',message='PAYROLL_CYCLE_ECONOMICALLY_FROZEN'; end if;
  return new;
end $$;
revoke all on function private.guard_payroll_adjustment_item()
from public,anon,authenticated,service_role;
create trigger payroll_adjustment_items_guard before insert on public.payroll_adjustment_items
for each row execute function private.guard_payroll_adjustment_item();

create function private.guard_payroll_carry_item()
returns trigger language plpgsql set search_path='' as $$
declare v_carry public.payroll_residual_carries; v_cycle public.payroll_cycles;
begin
  select * into v_carry from public.payroll_residual_carries where id=new.carry_id;
  select * into v_cycle from public.payroll_cycles where id=new.payroll_cycle_id;
  if v_carry.id is null or v_cycle.id is null or v_carry.maid_profile_id<>v_cycle.maid_profile_id
    or v_carry.available_week_start<>v_cycle.week_start then
    raise exception using errcode='23514',message='PAYROLL_CARRY_CYCLE_MISMATCH'; end if;
  if v_cycle.status<>'open' or v_cycle.offset_settled_at is not null then
    raise exception using errcode='55000',message='PAYROLL_CYCLE_ECONOMICALLY_FROZEN'; end if;
  return new;
end $$;
revoke all on function private.guard_payroll_carry_item()
from public,anon,authenticated,service_role;
create trigger payroll_carry_items_guard before insert on public.payroll_carry_items
for each row execute function private.guard_payroll_carry_item();

create or replace function private.prevent_payroll_cycle_snapshot_rewrite()
returns trigger language plpgsql set search_path='' as $$
declare v_is_reopen boolean:=old.status in ('paying','check') and new.status='open';
  v_is_offset boolean:=old.status='open' and old.offset_settled_at is null
    and new.status='open' and new.offset_settled_at is not null;
begin
  if new.maid_profile_id is distinct from old.maid_profile_id or new.week_start is distinct from old.week_start then
    raise exception using errcode='55000',message='PAYROLL_CYCLE_IDENTITY_IMMUTABLE'; end if;
  if old.status='paid' and new is distinct from old then
    raise exception using errcode='55000',message='PAID_PAYROLL_IMMUTABLE'; end if;
  if old.offset_settled_at is not null and new is distinct from old then
    raise exception using errcode='55000',message='PAYROLL_CYCLE_ECONOMICALLY_FROZEN'; end if;
  if v_is_offset then
    if new.offset_settled_by is null or new.version<>old.version+1
      or new.locked_amount is not null or new.payment_started_at is not null then
      raise exception using errcode='23514',message='PAYROLL_OFFSET_PROJECTION_INVALID'; end if;
  elsif new.offset_settled_at is distinct from old.offset_settled_at
    or new.offset_settled_by is distinct from old.offset_settled_by then
    raise exception using errcode='55000',message='PAYROLL_OFFSET_PROJECTION_IMMUTABLE';
  end if;
  if v_is_reopen then
    if new.locked_amount is not null or new.payment_started_by is not null or new.payment_started_at is not null
      or new.paid_at is not null or new.check_reason is not null then
      raise exception using errcode='23514',message='PAYROLL_REOPEN_SNAPSHOT_NOT_CLEARED'; end if;
    if nullif(btrim(new.last_reopen_reason),'') is null or new.last_reopened_by is null
      or new.last_reopened_at is null or new.last_reopened_at<old.payment_started_at then
      raise exception using errcode='23514',message='PAYROLL_REOPEN_REASON_REQUIRED'; end if;
    if new.version<>old.version+1 then raise exception using errcode='40001',message='PAYROLL_REOPEN_VERSION_MISMATCH'; end if;
  elsif old.status<>'open' and (new.locked_amount is distinct from old.locked_amount
    or new.payment_started_by is distinct from old.payment_started_by
    or new.payment_started_at is distinct from old.payment_started_at) then
    raise exception using errcode='55000',message='PAYROLL_LOCK_SNAPSHOT_IMMUTABLE';
  end if;
  if not v_is_reopen and (new.last_reopen_reason is distinct from old.last_reopen_reason
    or new.last_reopened_by is distinct from old.last_reopened_by
    or new.last_reopened_at is distinct from old.last_reopened_at) then
    raise exception using errcode='55000',message='PAYROLL_REOPEN_RECORD_IMMUTABLE'; end if;
  return new;
end $$;

create or replace function private.assert_payroll_cycle_total(p_payroll_cycle_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare v_cycle public.payroll_cycles; v_count bigint; v_total bigint;
begin
  select * into v_cycle from public.payroll_cycles where id=p_payroll_cycle_id;
  if v_cycle.id is null then return; end if;
  select count(*),coalesce(sum(amount),0) into v_count,v_total from (
    select locked_amount::bigint amount from public.payroll_items where payroll_cycle_id=v_cycle.id
    union all select locked_amount from public.payroll_adjustment_items where payroll_cycle_id=v_cycle.id
    union all select -locked_amount from public.payroll_carry_items where payroll_cycle_id=v_cycle.id
  ) amounts;
  if v_cycle.status<>'open' and (v_count=0 or v_total<=0 or v_cycle.locked_amount<>v_total) then
    raise exception using errcode='23514',message='PAYROLL_LOCKED_AMOUNT_MISMATCH'; end if;
end $$;

create constraint trigger payroll_adjustment_items_check_cycle_total
after insert or update or delete on public.payroll_adjustment_items deferrable initially deferred
for each row execute function private.check_payroll_item_cycle_total();
create constraint trigger payroll_carry_items_check_cycle_total
after insert or update or delete on public.payroll_carry_items deferrable initially deferred
for each row execute function private.check_payroll_item_cycle_total();

create function private.claim_payroll_sources(p_cycle_id uuid,p_maid uuid,p_week date)
returns void language plpgsql set search_path='' as $$
begin
  insert into public.payroll_items(payroll_cycle_id,earning_id,maid_profile_id,locked_amount)
  select p_cycle_id,e.id,p_maid,e.total_amount from public.earnings e
  where e.maid_profile_id=p_maid and e.earned_on>=p_week and e.earned_on<p_week+7
    and e.total_amount>0
    and not exists(select 1 from public.payroll_adjustments a where a.late_carried_earning_id=e.id)
    and not exists(select 1 from public.payroll_items i where i.earning_id=e.id)
  order by e.earned_on,e.id on conflict(earning_id) do nothing;
  insert into public.payroll_adjustment_items(payroll_cycle_id,adjustment_id,maid_profile_id,locked_amount)
  select p_cycle_id,a.id,p_maid,a.amount from public.payroll_adjustments a
  where a.maid_profile_id=p_maid and a.available_week_start=p_week
    and not exists(select 1 from public.payroll_adjustment_items i where i.adjustment_id=a.id)
  order by a.available_week_start,a.created_at,a.id on conflict(adjustment_id) do nothing;
  insert into public.payroll_carry_items(payroll_cycle_id,carry_id,maid_profile_id,locked_amount)
  select p_cycle_id,c.id,p_maid,c.amount from public.payroll_residual_carries c
  where c.maid_profile_id=p_maid and c.available_week_start=p_week
    and not exists(select 1 from public.payroll_carry_items i where i.carry_id=c.id)
  order by c.available_week_start,c.created_at,c.id on conflict(carry_id) do nothing;
end $$;
revoke all on function private.claim_payroll_sources(uuid,uuid,date)
from public,anon,authenticated,service_role;

create function private.payroll_cycle_amounts(p_cycle_id uuid)
returns table(earning_amount bigint,adjustment_amount bigint,carry_in_amount bigint,payable_amount bigint)
language sql stable set search_path='' as $$
  select e.amount,a.amount,-c.amount,e.amount+a.amount-c.amount from
  (select coalesce(sum(locked_amount),0)::bigint amount from public.payroll_items where payroll_cycle_id=p_cycle_id)e,
  (select coalesce(sum(locked_amount),0)::bigint amount from public.payroll_adjustment_items where payroll_cycle_id=p_cycle_id)a,
  (select coalesce(sum(locked_amount),0)::bigint amount from public.payroll_carry_items where payroll_cycle_id=p_cycle_id)c
$$;
revoke all on function private.payroll_cycle_amounts(uuid)
from public,anon,authenticated,service_role;

create or replace function private.project_payroll_cycle_bounded(
  p_week_start date,p_maid_profile_id uuid,p_nested_limit integer
) returns jsonb language sql stable set search_path='' as $$
with cycle_row as (
  select cycle.id cycle_id,cycle.status,cycle.locked_amount,cycle.payment_started_at,
    cycle.version,cycle.offset_settled_at
  from (select 1) singleton left join public.payroll_cycles cycle
    on cycle.maid_profile_id=p_maid_profile_id and cycle.week_start=p_week_start
), projected_items as (
  select item.earning_id,e.earned_on,item.locked_amount amount,true already_claimed
  from cycle_row cycle join public.payroll_items item on item.payroll_cycle_id=cycle.cycle_id
  join public.earnings e on e.id=item.earning_id
  union all
  select e.id,e.earned_on,e.total_amount,false from cycle_row cycle join public.earnings e
    on e.maid_profile_id=p_maid_profile_id and e.earned_on>=p_week_start and e.earned_on<p_week_start+7
  where coalesce(cycle.status='open' and cycle.offset_settled_at is null,true)
    and e.total_amount>0
    and not exists(select 1 from public.payroll_items claimed where claimed.earning_id=e.id)
    and not exists(select 1 from public.payroll_adjustments a where a.late_carried_earning_id=e.id)
), item_totals as (
  select count(*)::integer item_count,coalesce(sum(amount),0)::bigint total_amount from projected_items
), item_page as (
  select * from projected_items order by earned_on,earning_id limit p_nested_limit
), projected_adjustments as (
  select a.id,a.available_week_start,a.created_at,i.locked_amount amount,a.reason_code,true already_claimed
  from cycle_row cycle join public.payroll_adjustment_items i on i.payroll_cycle_id=cycle.cycle_id
  join public.payroll_adjustments a on a.id=i.adjustment_id
  union all
  select a.id,a.available_week_start,a.created_at,a.amount,a.reason_code,false
  from cycle_row cycle join public.payroll_adjustments a
    on a.maid_profile_id=p_maid_profile_id and a.available_week_start=p_week_start
  where coalesce(cycle.status='open' and cycle.offset_settled_at is null,true)
    and not exists(select 1 from public.payroll_adjustment_items claimed where claimed.adjustment_id=a.id)
), adjustment_totals as (
  select count(*)::integer item_count,coalesce(sum(amount),0)::bigint total_amount from projected_adjustments
), projected_carries as (
  select c.id,c.available_week_start,i.locked_amount amount from cycle_row cycle
  join public.payroll_carry_items i on i.payroll_cycle_id=cycle.cycle_id
  join public.payroll_residual_carries c on c.id=i.carry_id
  union all
  select c.id,c.available_week_start,c.amount from cycle_row cycle join public.payroll_residual_carries c
    on c.maid_profile_id=p_maid_profile_id and c.available_week_start=p_week_start
  where coalesce(cycle.status='open' and cycle.offset_settled_at is null,true)
    and not exists(select 1 from public.payroll_carry_items claimed where claimed.carry_id=c.id)
), carry_totals as (
  select count(*)::integer item_count,coalesce(sum(amount),0)::bigint total_amount from projected_carries
), late_items as (
  select e.id earning_id,e.earned_on,e.total_amount amount from cycle_row cycle join public.earnings e
    on e.maid_profile_id=p_maid_profile_id and e.earned_on>=p_week_start and e.earned_on<p_week_start+7
  where cycle.cycle_id is not null and (cycle.status<>'open' or cycle.offset_settled_at is not null)
    and e.total_amount>0
    and not exists(select 1 from public.payroll_items claimed where claimed.earning_id=e.id)
    and not exists(select 1 from public.payroll_adjustments a where a.late_carried_earning_id=e.id)
), late_totals as (
  select count(*)::integer item_count,coalesce(sum(amount),0)::bigint total_amount from late_items
), late_page as (
  select * from late_items order by earned_on,earning_id limit p_nested_limit
)
select jsonb_build_object(
  'cycleId',cycle.cycle_id,'maidProfileId',p_maid_profile_id,'weekStart',p_week_start,
  'status',coalesce(cycle.status::text,'open'),'version',coalesce(cycle.version,0),
  'lockedAmount',cycle.locked_amount,'paymentStartedAt',cycle.payment_started_at,
  'offsetSettled',cycle.offset_settled_at is not null,
  'itemCount',items.item_count,'totalAmount',items.total_amount,
  'adjustmentAmount',adjustments.total_amount,'carryInAmount',-carries.total_amount,
  'carryOutAmount',coalesce(settlement.net_amount,0),
  'payableAmount',coalesce(cycle.locked_amount::bigint,
    items.total_amount+adjustments.total_amount-carries.total_amount),
  'items',coalesce((select jsonb_agg(jsonb_build_object('earningId',p.earning_id,
    'earnedOn',p.earned_on,'amount',p.amount,'alreadyClaimed',p.already_claimed)
    order by p.earned_on,p.earning_id) from item_page p),'[]'::jsonb),
  'itemsHasMore',items.item_count>p_nested_limit,
  'itemsLastEarnedOn',(select earned_on from item_page order by earned_on desc,earning_id desc limit 1),
  'itemsLastEarningId',(select earning_id from item_page order by earned_on desc,earning_id desc limit 1),
  'lateEarningCount',late.item_count,'lateEarningAmount',late.total_amount,
  'lateEarnings',coalesce((select jsonb_agg(jsonb_build_object('earningId',p.earning_id,
    'earnedOn',p.earned_on,'amount',p.amount) order by p.earned_on,p.earning_id) from late_page p),'[]'::jsonb),
  'lateEarningsHasMore',late.item_count>p_nested_limit,
  'lateEarningsLastEarnedOn',(select earned_on from late_page order by earned_on desc,earning_id desc limit 1),
  'lateEarningsLastEarningId',(select earning_id from late_page order by earned_on desc,earning_id desc limit 1),
  'adjustmentCount',adjustments.item_count
) from cycle_row cycle cross join item_totals items cross join adjustment_totals adjustments
cross join carry_totals carries cross join late_totals late
left join public.payroll_offset_settlements settlement on settlement.payroll_cycle_id=cycle.cycle_id
$$;

create or replace function public.list_payroll_entries_page(
  p_actor_profile_id uuid,p_week_start date,p_maid_profile_id uuid,p_kind text,
  p_after_earned_on date default null,p_after_earning_id uuid default null,p_limit integer default 25
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_actor public.profiles; v_cycle public.payroll_cycles; v_rows jsonb;
  v_count integer; v_last_date date; v_last_id uuid;
begin
  perform private.assert_closed_payroll_week(p_week_start);
  v_actor:=private.assert_payroll_reader(p_actor_profile_id);
  if p_limit is null or p_limit<1 or p_limit>50 then
    raise exception using errcode='22023',message='PAYROLL_PAGE_LIMIT_INVALID'; end if;
  if p_kind not in ('items','lateEarnings','adjustments') then
    raise exception using errcode='22023',message='PAYROLL_PAGE_KIND_INVALID'; end if;
  if (p_after_earned_on is null)<>(p_after_earning_id is null) then
    raise exception using errcode='22023',message='PAYROLL_CURSOR_INVALID'; end if;
  if v_actor.role='maid' and p_maid_profile_id<>v_actor.id then
    raise exception using errcode='42501',message='PAYROLL_ACCESS_REQUIRED';
  elsif v_actor.role='admin' and not exists(select 1 from public.profiles maid
    where maid.id=p_maid_profile_id and maid.role='maid') then
    raise exception using errcode='P0002',message='PAYROLL_MAID_NOT_FOUND'; end if;
  select * into v_cycle from public.payroll_cycles where maid_profile_id=p_maid_profile_id and week_start=p_week_start;
  with earning_items as (
    select i.earning_id id,e.earned_on entry_date,i.locked_amount amount,true already_claimed,null::text reason
    from public.payroll_items i join public.earnings e on e.id=i.earning_id where i.payroll_cycle_id=v_cycle.id
    union all select e.id,e.earned_on,e.total_amount,false,null from public.earnings e
    where e.maid_profile_id=p_maid_profile_id and e.earned_on>=p_week_start and e.earned_on<p_week_start+7
      and e.total_amount>0
      and coalesce(v_cycle.status='open' and v_cycle.offset_settled_at is null,true)
      and not exists(select 1 from public.payroll_items i where i.earning_id=e.id)
      and not exists(select 1 from public.payroll_adjustments a where a.late_carried_earning_id=e.id)
  ), late_items as (
    select e.id,e.earned_on,e.total_amount,null::boolean,null::text from public.earnings e
    where e.maid_profile_id=p_maid_profile_id and e.earned_on>=p_week_start and e.earned_on<p_week_start+7
      and e.total_amount>0
      and v_cycle.id is not null and (v_cycle.status<>'open' or v_cycle.offset_settled_at is not null)
      and not exists(select 1 from public.payroll_items i where i.earning_id=e.id)
      and not exists(select 1 from public.payroll_adjustments a where a.late_carried_earning_id=e.id)
  ), adjustment_items as (
    select a.id,a.available_week_start,i.locked_amount,true,a.reason_code
    from public.payroll_adjustment_items i join public.payroll_adjustments a on a.id=i.adjustment_id
    where i.payroll_cycle_id=v_cycle.id
    union all select a.id,a.available_week_start,a.amount,false,a.reason_code from public.payroll_adjustments a
    where a.maid_profile_id=p_maid_profile_id and a.available_week_start=p_week_start
      and coalesce(v_cycle.status='open' and v_cycle.offset_settled_at is null,true)
      and not exists(select 1 from public.payroll_adjustment_items i where i.adjustment_id=a.id)
  ), selected as (
    select * from earning_items where p_kind='items' union all
    select * from late_items where p_kind='lateEarnings' union all
    select * from adjustment_items where p_kind='adjustments'
  ), candidates as (
    select * from selected where p_after_earned_on is null or (entry_date,id)>(p_after_earned_on,p_after_earning_id)
    order by entry_date,id limit p_limit+1
  ), page as (select * from candidates order by entry_date,id limit p_limit)
  select coalesce(jsonb_agg(case when p_kind='adjustments' then jsonb_build_object(
      'adjustmentId',id,'availableWeekStart',entry_date,'amount',amount,
      'reasonCode',reason,'alreadyClaimed',already_claimed)
    when p_kind='items' then jsonb_build_object('earningId',id,'earnedOn',entry_date,
      'amount',amount,'alreadyClaimed',already_claimed)
    else jsonb_build_object('earningId',id,'earnedOn',entry_date,'amount',amount) end
    order by entry_date,id),'[]'::jsonb),
    (select count(*) from candidates),(select entry_date from page order by entry_date desc,id desc limit 1),
    (select id from page order by entry_date desc,id desc limit 1)
  into v_rows,v_count,v_last_date,v_last_id from page;
  return jsonb_build_object('entries',v_rows,'hasMore',v_count>p_limit,
    'lastEarnedOn',v_last_date,'lastEarningId',v_last_id);
end $$;

create function private.payroll_adjustment_projection(p_adjustment public.payroll_adjustments)
returns jsonb language sql stable set search_path='' as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'adjustmentId',p_adjustment.id,'maidProfileId',p_adjustment.maid_profile_id,
    'bookVersion',p_adjustment.book_version,'amount',p_adjustment.amount,
    'currency',p_adjustment.currency,'reasonCode',p_adjustment.reason_code,
    'rootEarningId',p_adjustment.root_earning_id,
    'correctionOfEarningId',p_adjustment.correction_of_earning_id,
    'correctionOfAdjustmentId',p_adjustment.correction_of_adjustment_id,
    'reversalOfEarningId',p_adjustment.reversal_of_earning_id,
    'reversalOfAdjustmentId',p_adjustment.reversal_of_adjustment_id,
    'lateCarriedEarningId',p_adjustment.late_carried_earning_id,
    'availableWeekStart',p_adjustment.available_week_start,
    'createdAt',p_adjustment.created_at))
$$;
revoke all on function private.payroll_adjustment_projection(public.payroll_adjustments)
from public,anon,authenticated,service_role;

create function private.payroll_source_available_week(
  p_maid uuid,p_earning_id uuid,p_adjustment_id uuid
) returns date language plpgsql set search_path='' as $$
declare v_week date; v_cycle public.payroll_cycles;
begin
  if p_earning_id is not null then
    select date_trunc('week',e.earned_on)::date into v_week from public.earnings e
    where e.id=p_earning_id and e.maid_profile_id=p_maid;
    select cycle.* into v_cycle from public.payroll_items item join public.payroll_cycles cycle
      on cycle.id=item.payroll_cycle_id where item.earning_id=p_earning_id;
  else
    select a.available_week_start into v_week from public.payroll_adjustments a
    where a.id=p_adjustment_id and a.maid_profile_id=p_maid;
    select cycle.* into v_cycle from public.payroll_adjustment_items item join public.payroll_cycles cycle
      on cycle.id=item.payroll_cycle_id where item.adjustment_id=p_adjustment_id;
  end if;
  if v_week is null then raise exception using errcode='P0002',message='PAYROLL_SOURCE_NOT_FOUND'; end if;
  if v_cycle.status in ('paying','check') then
    raise exception using errcode='55000',message='PAYROLL_SOURCE_PAYMENT_UNCERTAIN'; end if;
  if v_cycle.status='paid' or v_cycle.offset_settled_at is not null then v_week:=v_cycle.week_start+7; end if;
  loop
    select * into v_cycle from public.payroll_cycles cycle
    where cycle.maid_profile_id=p_maid and cycle.week_start=v_week;
    exit when v_cycle.id is null or (v_cycle.status='open' and v_cycle.offset_settled_at is null);
    if v_cycle.status in ('paying','check') then
      raise exception using errcode='55000',message='PAYROLL_SOURCE_PAYMENT_UNCERTAIN'; end if;
    v_week:=v_week+7;
  end loop;
  return v_week;
end $$;
revoke all on function private.payroll_source_available_week(uuid,uuid,uuid)
from public,anon,authenticated,service_role;

create function public.record_payroll_correction(
  p_actor_profile_id uuid,p_source_earning_id uuid,p_source_adjustment_id uuid,
  p_amount integer,p_expected_book_version bigint,p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor public.profiles; v_earning public.earnings; v_source public.payroll_adjustments;
  v_book public.payroll_adjustment_books; v_adjustment public.payroll_adjustments;
  v_maid uuid; v_root uuid; v_week date; v_reason text; v_replay jsonb;
  v_now timestamptz:=clock_timestamp(); v_notification uuid;
begin
  v_replay:=private.replay_command(p_actor_profile_id,'payroll.adjustment.correct',p_idempotency_key,p_request_hash);
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into v_actor from public.profiles where id=p_actor_profile_id and role='admin'
    and status='active' and not must_change_password for no key update;
  if v_actor.id is null then raise exception using errcode='42501',message='ADMIN_REQUIRED'; end if;
  if v_replay is not null then return v_replay; end if;
  if num_nonnulls(p_source_earning_id,p_source_adjustment_id)<>1 or p_amount is null or p_amount=0 then
    raise exception using errcode='22023',message='PAYROLL_ADJUSTMENT_INVALID'; end if;
  if p_source_earning_id is not null then
    select * into v_earning from public.earnings where id=p_source_earning_id;
    if v_earning.id is null then raise exception using errcode='P0002',message='PAYROLL_SOURCE_NOT_FOUND'; end if;
    v_maid:=v_earning.maid_profile_id; v_root:=v_earning.id; v_reason:='earning_correction';
  else
    select * into v_source from public.payroll_adjustments where id=p_source_adjustment_id;
    if v_source.id is null or v_source.reason_code='late_earning_carry' then
      raise exception using errcode='P0002',message='PAYROLL_SOURCE_NOT_FOUND'; end if;
    v_maid:=v_source.maid_profile_id; v_root:=v_source.root_earning_id; v_reason:='adjustment_correction';
  end if;
  insert into public.payroll_adjustment_books(maid_profile_id) values(v_maid) on conflict do nothing;
  select * into v_book from public.payroll_adjustment_books where maid_profile_id=v_maid for update;
  if p_expected_book_version is null or p_expected_book_version<>v_book.version then
    raise exception using errcode='40001',message='STALE_ADJUSTMENT_VERSION'; end if;
  v_week:=private.payroll_source_available_week(v_maid,p_source_earning_id,p_source_adjustment_id);
  insert into public.payroll_adjustments(maid_profile_id,book_version,amount,reason_code,
    root_earning_id,correction_of_earning_id,correction_of_adjustment_id,available_week_start,created_by,created_at)
  values(v_maid,v_book.version+1,p_amount,v_reason,v_root,p_source_earning_id,p_source_adjustment_id,
    v_week,v_actor.id,v_now) returning * into v_adjustment;
  update public.payroll_adjustment_books set version=v_adjustment.book_version,updated_at=v_now where maid_profile_id=v_maid;
  insert into public.audit_events(actor_profile_id,event_type,entity_type,entity_id,effective_at,reason_code,
    after_state,idempotency_key) values(v_actor.id,'payroll.adjustment_recorded','payroll_adjustment',
    v_adjustment.id,v_now,v_reason,jsonb_build_object('reasonCode',v_reason,'bookVersion',v_adjustment.book_version,
      'availableWeekStart',v_week),private.audit_command_key(v_actor.id,'payroll.adjustment.correct',p_idempotency_key));
  insert into public.notifications(recipient_profile_id,category,title,body,dedupe_key,requires_action,occurred_at)
    values(v_maid,'payroll_adjustment_recorded','주급 정정 반영','주급 정정 항목이 원장에 반영되었습니다.',
      'payroll-adjustment:'||v_adjustment.id,false,v_now) returning id into v_notification;
  insert into private.notification_outbox(notification_id,channel,delivery_status,next_attempt_at,created_at)
    values(v_notification,'web_push','pending',v_now,v_now);
  v_replay:=private.payroll_adjustment_projection(v_adjustment);
  perform private.complete_command(v_actor.id,'payroll.adjustment.correct',p_idempotency_key,p_request_hash,
    v_adjustment.id,v_replay);
  return v_replay;
end $$;

create function public.reverse_payroll_source(
  p_actor_profile_id uuid,p_source_earning_id uuid,p_source_adjustment_id uuid,
  p_expected_book_version bigint,p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor public.profiles; v_earning public.earnings; v_source public.payroll_adjustments;
  v_book public.payroll_adjustment_books; v_adjustment public.payroll_adjustments;
  v_maid uuid; v_root uuid; v_amount integer; v_week date; v_reason text; v_replay jsonb;
  v_now timestamptz:=clock_timestamp(); v_notification uuid;
begin
  v_replay:=private.replay_command(p_actor_profile_id,'payroll.adjustment.reverse',p_idempotency_key,p_request_hash);
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into v_actor from public.profiles where id=p_actor_profile_id and role='admin'
    and status='active' and not must_change_password for no key update;
  if v_actor.id is null then raise exception using errcode='42501',message='ADMIN_REQUIRED'; end if;
  if v_replay is not null then return v_replay; end if;
  if num_nonnulls(p_source_earning_id,p_source_adjustment_id)<>1 then
    raise exception using errcode='22023',message='PAYROLL_ADJUSTMENT_INVALID'; end if;
  if p_source_earning_id is not null then
    select * into v_earning from public.earnings where id=p_source_earning_id;
    if v_earning.id is null then raise exception using errcode='P0002',message='PAYROLL_SOURCE_NOT_FOUND'; end if;
    v_maid:=v_earning.maid_profile_id;v_root:=v_earning.id;v_amount:=-v_earning.total_amount;v_reason:='earning_reversal';
  else
    select * into v_source from public.payroll_adjustments where id=p_source_adjustment_id;
    if v_source.id is null or v_source.reason_code='late_earning_carry' then
      raise exception using errcode='P0002',message='PAYROLL_SOURCE_NOT_FOUND'; end if;
    v_maid:=v_source.maid_profile_id;v_root:=v_source.root_earning_id;v_amount:=-v_source.amount;v_reason:='adjustment_reversal';
  end if;
  if v_amount=0 then raise exception using errcode='22023',message='PAYROLL_ADJUSTMENT_INVALID'; end if;
  insert into public.payroll_adjustment_books(maid_profile_id) values(v_maid) on conflict do nothing;
  select * into v_book from public.payroll_adjustment_books where maid_profile_id=v_maid for update;
  if p_expected_book_version is null or p_expected_book_version<>v_book.version then
    raise exception using errcode='40001',message='STALE_ADJUSTMENT_VERSION'; end if;
  v_week:=private.payroll_source_available_week(v_maid,p_source_earning_id,p_source_adjustment_id);
  begin
    insert into public.payroll_adjustments(maid_profile_id,book_version,amount,reason_code,root_earning_id,
      reversal_of_earning_id,reversal_of_adjustment_id,available_week_start,created_by,created_at)
    values(v_maid,v_book.version+1,v_amount,v_reason,v_root,p_source_earning_id,p_source_adjustment_id,
      v_week,v_actor.id,v_now) returning * into v_adjustment;
  exception when unique_violation then
    raise exception using errcode='23505',message='PAYROLL_SOURCE_ALREADY_REVERSED';
  end;
  update public.payroll_adjustment_books set version=v_adjustment.book_version,updated_at=v_now where maid_profile_id=v_maid;
  insert into public.audit_events(actor_profile_id,event_type,entity_type,entity_id,effective_at,reason_code,
    after_state,idempotency_key) values(v_actor.id,'payroll.adjustment_reversed','payroll_adjustment',v_adjustment.id,
      v_now,v_reason,jsonb_build_object('reasonCode',v_reason,'bookVersion',v_adjustment.book_version,
        'availableWeekStart',v_week),private.audit_command_key(v_actor.id,'payroll.adjustment.reverse',p_idempotency_key));
  insert into public.notifications(recipient_profile_id,category,title,body,dedupe_key,requires_action,occurred_at)
    values(v_maid,'payroll_adjustment_reversed','주급 원장 반전','주급 원장 항목이 전액 반전되었습니다.',
      'payroll-reversal:'||v_adjustment.id,false,v_now) returning id into v_notification;
  insert into private.notification_outbox(notification_id,channel,delivery_status,next_attempt_at,created_at)
    values(v_notification,'web_push','pending',v_now,v_now);
  v_replay:=private.payroll_adjustment_projection(v_adjustment);
  perform private.complete_command(v_actor.id,'payroll.adjustment.reverse',p_idempotency_key,p_request_hash,
    v_adjustment.id,v_replay);
  return v_replay;
end $$;

create function public.carry_late_payroll_earning(
  p_actor_profile_id uuid,p_earning_id uuid,p_expected_book_version bigint,
  p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor public.profiles; v_earning public.earnings; v_book public.payroll_adjustment_books;
  v_source_cycle public.payroll_cycles; v_target_cycle public.payroll_cycles;
  v_adjustment public.payroll_adjustments; v_week date; v_replay jsonb;
  v_now timestamptz:=clock_timestamp(); v_notification uuid;
begin
  v_replay:=private.replay_command(p_actor_profile_id,'payroll.late_earning.carry',p_idempotency_key,p_request_hash);
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into v_actor from public.profiles where id=p_actor_profile_id and role='admin'
    and status='active' and not must_change_password for no key update;
  if v_actor.id is null then raise exception using errcode='42501',message='ADMIN_REQUIRED'; end if;
  if v_replay is not null then return v_replay; end if;
  select * into v_earning from public.earnings where id=p_earning_id;
  if v_earning.id is null then raise exception using errcode='P0002',message='PAYROLL_SOURCE_NOT_FOUND'; end if;
  if v_earning.total_amount<=0 or exists(select 1 from public.payroll_items i where i.earning_id=v_earning.id) then
    raise exception using errcode='55000',message='PAYROLL_EARNING_NOT_LATE'; end if;
  insert into public.payroll_adjustment_books(maid_profile_id) values(v_earning.maid_profile_id) on conflict do nothing;
  select * into v_book from public.payroll_adjustment_books where maid_profile_id=v_earning.maid_profile_id for update;
  if p_expected_book_version is null or p_expected_book_version<>v_book.version then
    raise exception using errcode='40001',message='STALE_ADJUSTMENT_VERSION'; end if;
  v_week:=date_trunc('week',v_earning.earned_on)::date;
  select * into v_source_cycle from public.payroll_cycles cycle
  where cycle.maid_profile_id=v_earning.maid_profile_id and cycle.week_start=v_week for update;
  if v_source_cycle.id is null or (v_source_cycle.status<>'paid' and v_source_cycle.offset_settled_at is null) then
    if v_source_cycle.status in ('paying','check') then
      raise exception using errcode='55000',message='PAYROLL_SOURCE_PAYMENT_UNCERTAIN'; end if;
    raise exception using errcode='55000',message='PAYROLL_EARNING_NOT_LATE';
  end if;
  v_week:=v_week+7;
  select * into v_target_cycle from public.payroll_cycles cycle
  where cycle.maid_profile_id=v_earning.maid_profile_id and cycle.week_start=v_week for update;
  if v_target_cycle.id is not null and (v_target_cycle.status<>'open' or v_target_cycle.offset_settled_at is not null) then
    raise exception using errcode='55000',message='PAYROLL_LATE_CARRY_TARGET_FROZEN'; end if;
  begin
    insert into public.payroll_adjustments(maid_profile_id,book_version,amount,reason_code,root_earning_id,
      late_carried_earning_id,available_week_start,created_by,created_at)
    values(v_earning.maid_profile_id,v_book.version+1,v_earning.total_amount,'late_earning_carry',v_earning.id,
      v_earning.id,v_week,v_actor.id,v_now) returning * into v_adjustment;
  exception when unique_violation then
    raise exception using errcode='23505',message='PAYROLL_LATE_EARNING_ALREADY_CARRIED';
  end;
  update public.payroll_adjustment_books set version=v_adjustment.book_version,updated_at=v_now
  where maid_profile_id=v_earning.maid_profile_id;
  insert into public.audit_events(actor_profile_id,event_type,entity_type,entity_id,effective_at,reason_code,
    after_state,idempotency_key) values(v_actor.id,'payroll.late_earning_carried','payroll_adjustment',v_adjustment.id,
    v_now,'late_earning_carry',jsonb_build_object('reasonCode','late_earning_carry',
      'bookVersion',v_adjustment.book_version,'availableWeekStart',v_week),
    private.audit_command_key(v_actor.id,'payroll.late_earning.carry',p_idempotency_key));
  insert into public.notifications(recipient_profile_id,category,title,body,dedupe_key,requires_action,occurred_at)
    values(v_earning.maid_profile_id,'payroll_late_earning_carried','늦은 수익 이월','늦게 확정된 수익이 다음 주차에 반영되었습니다.',
      'payroll-late-carry:'||v_adjustment.id,false,v_now) returning id into v_notification;
  insert into private.notification_outbox(notification_id,channel,delivery_status,next_attempt_at,created_at)
    values(v_notification,'web_push','pending',v_now,v_now);
  v_replay:=private.payroll_adjustment_projection(v_adjustment);
  perform private.complete_command(v_actor.id,'payroll.late_earning.carry',p_idempotency_key,p_request_hash,
    v_adjustment.id,v_replay);
  return v_replay;
end $$;

create or replace function public.start_payroll_cycle(
  p_actor_profile_id uuid,p_maid_profile_id uuid,p_week_start date,p_expected_version bigint,
  p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor public.profiles; v_cycle public.payroll_cycles;
  v_replay jsonb; v_result jsonb; v_created boolean:=false; v_amounts record;
  v_event_id bigint; v_notification uuid; v_now timestamptz:=clock_timestamp();
begin
  v_replay:=private.replay_command(p_actor_profile_id,'payroll.start',p_idempotency_key,p_request_hash);
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into v_actor from public.profiles where id=p_actor_profile_id and role='admin'
    and status='active' and not must_change_password for no key update;
  if v_actor.id is null then raise exception using errcode='42501',message='ADMIN_REQUIRED'; end if;
  perform private.assert_closed_payroll_week(p_week_start);
  if p_expected_version is null or p_expected_version<0 then
    raise exception using errcode='22023',message='INVALID_EXPECTED_VERSION'; end if;
  if not exists(select 1 from public.profiles maid where maid.id=p_maid_profile_id and maid.role='maid') then
    raise exception using errcode='P0002',message='PAYROLL_MAID_NOT_FOUND'; end if;
  if v_replay is not null then return v_replay; end if;
  insert into public.payroll_adjustment_books(maid_profile_id) values(p_maid_profile_id) on conflict do nothing;
  perform 1 from public.payroll_adjustment_books where maid_profile_id=p_maid_profile_id for update;
  select * into v_cycle from public.payroll_cycles cycle where cycle.maid_profile_id=p_maid_profile_id
    and cycle.week_start=p_week_start for update;
  if v_cycle.id is null then
    if p_expected_version<>0 then raise exception using errcode='40001',message='STALE_VERSION'; end if;
    insert into public.payroll_cycles(maid_profile_id,week_start) values(p_maid_profile_id,p_week_start)
    returning * into v_cycle; v_created:=true;
  elsif v_cycle.offset_settled_at is not null then
    raise exception using errcode='55000',message='PAYROLL_CYCLE_ECONOMICALLY_FROZEN';
  elsif v_cycle.status<>'open' then raise exception using errcode='55000',message='PAYROLL_CYCLE_NOT_OPEN';
  elsif v_cycle.version<>p_expected_version then raise exception using errcode='40001',message='STALE_VERSION'; end if;
  if exists(select 1 from public.payroll_residual_carries carry
    where carry.maid_profile_id=p_maid_profile_id and carry.available_week_start<p_week_start
      and not exists(select 1 from public.payroll_carry_items item where item.carry_id=carry.id)) then
    raise exception using errcode='55000',message='PAYROLL_EARLIER_CARRY_PENDING'; end if;
  perform private.claim_payroll_sources(v_cycle.id,p_maid_profile_id,p_week_start);
  select * into v_amounts from private.payroll_cycle_amounts(v_cycle.id);
  if v_amounts.payable_amount<=0 then
    raise exception using errcode='22023',message='PAYROLL_NONPOSITIVE_REQUIRES_CARRY'; end if;
  update public.payroll_cycles cycle set status='paying',locked_amount=v_amounts.payable_amount::integer,
    payment_started_by=v_actor.id,payment_started_at=v_now,
    version=case when v_created then 1 else cycle.version+1 end
  where cycle.id=v_cycle.id and cycle.status='open' and cycle.version=v_cycle.version returning * into v_cycle;
  if v_cycle.id is null then raise exception using errcode='40001',message='STALE_VERSION'; end if;
  insert into public.payroll_events(payroll_cycle_id,maid_profile_id,event_type,before_status,after_status,
    actor_profile_id,cycle_version,locked_amount,occurred_at)
  values(v_cycle.id,v_cycle.maid_profile_id,'payment_started','open','paying',v_actor.id,v_cycle.version,
    v_cycle.locked_amount,v_now) returning id into v_event_id;
  insert into public.audit_events(actor_profile_id,event_type,entity_type,entity_id,effective_at,after_state,
    idempotency_key) values(v_actor.id,'payroll.payment_started','payroll_cycle',v_cycle.id,v_now,
    jsonb_build_object('weekStart',v_cycle.week_start,'status',v_cycle.status,'version',v_cycle.version,
      'payrollEventId',v_event_id),private.audit_command_key(v_actor.id,'payroll.start',p_idempotency_key));
  insert into public.notifications(recipient_profile_id,category,title,body,dedupe_key,requires_action,occurred_at)
    values(v_cycle.maid_profile_id,'payroll_payment_started','주급 지급 처리 시작','종료된 주차의 주급 지급 처리가 시작되었습니다.',
      'payroll-start:'||v_cycle.id||':'||v_cycle.version,false,v_now) returning id into v_notification;
  insert into private.notification_outbox(notification_id,channel,delivery_status,next_attempt_at,created_at)
    values(v_notification,'web_push','pending',v_now,v_now);
  v_result:=private.project_payroll_cycle_bounded(p_week_start,p_maid_profile_id,10);
  perform private.complete_command(v_actor.id,'payroll.start',p_idempotency_key,p_request_hash,v_cycle.id,v_result);
  return v_result;
end $$;

create function public.carry_forward_payroll_cycle(
  p_actor_profile_id uuid,p_maid_profile_id uuid,p_week_start date,p_expected_version bigint,
  p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor public.profiles; v_cycle public.payroll_cycles;
  v_replay jsonb; v_result jsonb; v_created boolean:=false; v_amounts record;
  v_settlement_id uuid:=gen_random_uuid(); v_carry_id uuid; v_notification uuid;
  v_now timestamptz:=clock_timestamp();
begin
  v_replay:=private.replay_command(p_actor_profile_id,'payroll.carry_forward',p_idempotency_key,p_request_hash);
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into v_actor from public.profiles where id=p_actor_profile_id and role='admin'
    and status='active' and not must_change_password for no key update;
  if v_actor.id is null then raise exception using errcode='42501',message='ADMIN_REQUIRED'; end if;
  perform private.assert_closed_payroll_week(p_week_start);
  if p_expected_version is null or p_expected_version<0 then
    raise exception using errcode='22023',message='INVALID_EXPECTED_VERSION'; end if;
  if not exists(select 1 from public.profiles maid where maid.id=p_maid_profile_id and maid.role='maid') then
    raise exception using errcode='P0002',message='PAYROLL_MAID_NOT_FOUND'; end if;
  if v_replay is not null then return v_replay; end if;
  insert into public.payroll_adjustment_books(maid_profile_id) values(p_maid_profile_id) on conflict do nothing;
  perform 1 from public.payroll_adjustment_books where maid_profile_id=p_maid_profile_id for update;
  select * into v_cycle from public.payroll_cycles cycle where cycle.maid_profile_id=p_maid_profile_id
    and cycle.week_start=p_week_start for update;
  if v_cycle.id is null then
    if p_expected_version<>0 then raise exception using errcode='40001',message='STALE_VERSION'; end if;
    insert into public.payroll_cycles(maid_profile_id,week_start) values(p_maid_profile_id,p_week_start)
    returning * into v_cycle;v_created:=true;
  elsif v_cycle.offset_settled_at is not null then
    raise exception using errcode='55000',message='PAYROLL_CYCLE_ECONOMICALLY_FROZEN';
  elsif v_cycle.status<>'open' then raise exception using errcode='55000',message='PAYROLL_CYCLE_NOT_OPEN';
  elsif v_cycle.version<>p_expected_version then raise exception using errcode='40001',message='STALE_VERSION'; end if;
  if exists(select 1 from public.payroll_residual_carries carry
    where carry.maid_profile_id=p_maid_profile_id and carry.available_week_start<p_week_start
      and not exists(select 1 from public.payroll_carry_items item where item.carry_id=carry.id)) then
    raise exception using errcode='55000',message='PAYROLL_EARLIER_CARRY_PENDING'; end if;
  perform private.claim_payroll_sources(v_cycle.id,p_maid_profile_id,p_week_start);
  select * into v_amounts from private.payroll_cycle_amounts(v_cycle.id);
  if v_amounts.payable_amount>0 then
    raise exception using errcode='22023',message='PAYROLL_POSITIVE_REQUIRES_START'; end if;
  if v_amounts.payable_amount<0 then v_carry_id:=gen_random_uuid(); end if;
  insert into public.payroll_offset_settlements(id,payroll_cycle_id,maid_profile_id,week_start,cycle_version,
    earning_amount,adjustment_amount,carry_in_amount,net_amount,carry_out_id,settled_by,settled_at)
  values(v_settlement_id,v_cycle.id,p_maid_profile_id,p_week_start,
    case when v_created then 1 else v_cycle.version+1 end,v_amounts.earning_amount::integer,
    v_amounts.adjustment_amount::integer,v_amounts.carry_in_amount::integer,v_amounts.payable_amount::integer,
    v_carry_id,v_actor.id,v_now);
  if v_carry_id is not null then
    insert into public.payroll_residual_carries(id,maid_profile_id,source_settlement_id,available_week_start,amount)
    values(v_carry_id,p_maid_profile_id,v_settlement_id,p_week_start+7,(-v_amounts.payable_amount)::integer);
  end if;
  update public.payroll_cycles cycle set offset_settled_at=v_now,offset_settled_by=v_actor.id,
    version=case when v_created then 1 else cycle.version+1 end where id=v_cycle.id and status='open'
    and version=v_cycle.version returning * into v_cycle;
  if v_cycle.id is null then raise exception using errcode='40001',message='STALE_VERSION'; end if;
  insert into public.audit_events(actor_profile_id,event_type,entity_type,entity_id,effective_at,after_state,
    idempotency_key) values(v_actor.id,'payroll.offset_settled','payroll_offset_settlement',v_settlement_id,v_now,
    jsonb_build_object('weekStart',p_week_start,'version',v_cycle.version,'hasCarryOut',v_carry_id is not null),
    private.audit_command_key(v_actor.id,'payroll.carry_forward',p_idempotency_key));
  insert into public.notifications(recipient_profile_id,category,title,body,dedupe_key,requires_action,occurred_at)
    values(p_maid_profile_id,'payroll_offset_settled','주급 상계 이월','0원 이하 주급이 다음 주차 상계로 이월되었습니다.',
      'payroll-offset:'||v_settlement_id,false,v_now) returning id into v_notification;
  insert into private.notification_outbox(notification_id,channel,delivery_status,next_attempt_at,created_at)
    values(v_notification,'web_push','pending',v_now,v_now);
  v_result:=private.project_payroll_cycle_bounded(p_week_start,p_maid_profile_id,10);
  perform private.complete_command(v_actor.id,'payroll.carry_forward',p_idempotency_key,p_request_hash,
    v_settlement_id,v_result);
  return v_result;
end $$;

-- Safe developer audit projection: never return signed amounts, raw state,
-- request hashes, idempotency keys or another maid's identity.
alter function public.list_developer_audit_events(
  uuid,text[],uuid,timestamptz,timestamptz,timestamptz,uuid,integer
) set schema private;
alter function private.list_developer_audit_events(
  uuid,text[],uuid,timestamptz,timestamptz,timestamptz,uuid,integer
) rename to list_developer_audit_events_before_adjustments;
revoke all on function private.list_developer_audit_events_before_adjustments(
  uuid,text[],uuid,timestamptz,timestamptz,timestamptz,uuid,integer
) from public,anon,authenticated,service_role;

create function public.list_developer_audit_events(
  p_actor_profile_id uuid,p_event_types text[] default null,
  p_filter_actor_profile_id uuid default null,p_from timestamptz default null,
  p_to timestamptz default null,p_before_recorded_at timestamptz default null,
  p_before_id uuid default null,p_limit integer default 50
) returns table(id uuid,event_type text,entity_type text,entity_id uuid,
  actor_profile_id uuid,actor_display_name text,effective_at timestamptz,
  recorded_at timestamptz,reason_code text,summary jsonb)
language plpgsql security definer set search_path='' as $$
declare v_previous_types text[];v_from timestamptz:=coalesce(p_from,clock_timestamp()-interval '7 days');
  v_to timestamptz:=coalesce(p_to,clock_timestamp());
begin
  if p_event_types is not null and coalesce(cardinality(p_event_types),0)=0 then
    raise exception using errcode='22023',message='INVALID_AUDIT_QUERY'; end if;
  if p_event_types is null then v_previous_types:=null;
  else
    select coalesce(array_agg(requested),array[]::text[]) into v_previous_types
    from unnest(p_event_types) requested where requested not in (
      'payroll.adjustment_recorded','payroll.adjustment_reversed',
      'payroll.offset_settled','payroll.late_earning_carried');
    if cardinality(v_previous_types)=0 then v_previous_types:=array['account.created']; end if;
  end if;
  return query select merged.* from (
    select previous.* from private.list_developer_audit_events_before_adjustments(
      p_actor_profile_id,v_previous_types,p_filter_actor_profile_id,p_from,p_to,
      p_before_recorded_at,p_before_id,p_limit) previous
    where p_event_types is null or previous.event_type=any(p_event_types)
    union all
    select audit.id,audit.event_type,audit.entity_type,audit.entity_id,audit.actor_profile_id,
      audit.actor_display_name_snapshot,audit.effective_at,audit.recorded_at,audit.reason_code,
      jsonb_strip_nulls(jsonb_build_object(
        'reasonCode',audit.after_state->>'reasonCode',
        'weekStart',audit.after_state->'weekStart',
        'availableWeekStart',audit.after_state->'availableWeekStart',
        'version',coalesce(audit.after_state->'version',audit.after_state->'bookVersion'),
        'hasCarryOut',audit.after_state->'hasCarryOut'))
    from public.audit_events audit
    where audit.event_type in ('payroll.adjustment_recorded','payroll.adjustment_reversed',
      'payroll.offset_settled','payroll.late_earning_carried')
      and (p_event_types is null or audit.event_type=any(p_event_types))
      and audit.recorded_at>=v_from and audit.recorded_at<=v_to
      and (p_filter_actor_profile_id is null or audit.actor_profile_id=p_filter_actor_profile_id)
      and (p_before_recorded_at is null or (audit.recorded_at,audit.id)<(p_before_recorded_at,p_before_id))
    order by recorded_at desc,id desc limit p_limit
  ) merged order by merged.recorded_at desc,merged.id desc limit p_limit;
end $$;

comment on table public.payroll_adjustments is
'#102 immutable signed KRW correction/reversal ledger. Reversal-of-reversal is an exact inverse chain; every source can be reversed once and root cumulative entitlement cannot fall below zero.';
comment on table public.payroll_offset_settlements is
'#102 immutable non-positive weekly offset. It creates no PAYING/PAID event and economically freezes the OPEN cycle.';
comment on table public.payroll_residual_carries is
'#102 immutable debt magnitude available only in the immediately following KST week; successive non-positive weeks require successive carry-forward commands.';

revoke all privileges on public.payroll_adjustment_books,public.payroll_adjustments,
  public.payroll_adjustment_items,public.payroll_residual_carries,
  public.payroll_carry_items,public.payroll_offset_settlements
from public,anon,authenticated,service_role;
grant select on public.payroll_adjustment_books,public.payroll_adjustments,
  public.payroll_adjustment_items,public.payroll_residual_carries,
  public.payroll_carry_items,public.payroll_offset_settlements to authenticated;

revoke all on function public.record_payroll_correction(uuid,uuid,uuid,integer,bigint,text,text),
  public.reverse_payroll_source(uuid,uuid,uuid,bigint,text,text),
  public.carry_late_payroll_earning(uuid,uuid,bigint,text,text),
  public.carry_forward_payroll_cycle(uuid,uuid,date,bigint,text,text),
  public.start_payroll_cycle(uuid,uuid,date,bigint,text,text),
  public.list_developer_audit_events(uuid,text[],uuid,timestamptz,timestamptz,timestamptz,uuid,integer)
from public,anon,authenticated,service_role;
grant execute on function public.record_payroll_correction(uuid,uuid,uuid,integer,bigint,text,text),
  public.reverse_payroll_source(uuid,uuid,uuid,bigint,text,text),
  public.carry_late_payroll_earning(uuid,uuid,bigint,text,text),
  public.carry_forward_payroll_cycle(uuid,uuid,date,bigint,text,text),
  public.start_payroll_cycle(uuid,uuid,date,bigint,text,text),
  public.list_developer_audit_events(uuid,text[],uuid,timestamptz,timestamptz,timestamptz,uuid,integer)
to service_role;
