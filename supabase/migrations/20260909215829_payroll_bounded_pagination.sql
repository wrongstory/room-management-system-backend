-- Issue #96: bounded keyset pagination for payroll read projections.
-- Cursor authentication stays in the HTTP adapters because its HMAC secret is
-- intentionally not stored in PostgreSQL. The database independently limits
-- every page and accepts only keyset positions extracted from a verified cursor.

create index earnings_payroll_page_idx
on public.earnings (maid_profile_id, earned_on, id)
include (total_amount);

create function private.project_payroll_cycle_bounded(
  p_week_start date,
  p_maid_profile_id uuid,
  p_nested_limit integer
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with cycle_row as (
    select
      cycle.id as cycle_id,
      cycle.status,
      cycle.locked_amount,
      cycle.payment_started_at,
      cycle.version
    from (select 1) singleton
    left join public.payroll_cycles cycle
      on cycle.maid_profile_id = p_maid_profile_id
     and cycle.week_start = p_week_start
  ), projected_items as (
    select
      item.earning_id,
      earning.earned_on,
      item.locked_amount as amount,
      true as already_claimed
    from cycle_row cycle
    join public.payroll_items item on item.payroll_cycle_id = cycle.cycle_id
    join public.earnings earning on earning.id = item.earning_id

    union all

    select
      earning.id,
      earning.earned_on,
      earning.total_amount,
      false
    from cycle_row cycle
    join public.earnings earning
      on earning.maid_profile_id = p_maid_profile_id
     and earning.earned_on >= p_week_start
     and earning.earned_on < p_week_start + 7
     and earning.total_amount > 0
    where coalesce(cycle.status = 'open', true)
      and not exists (
        select 1
        from public.payroll_items claimed
        where claimed.earning_id = earning.id
      )
  ), item_totals as (
    select count(*)::integer as item_count,
      coalesce(sum(item.amount), 0)::bigint as total_amount
    from projected_items item
  ), item_page as (
    select item.*
    from projected_items item
    order by item.earned_on, item.earning_id
    limit p_nested_limit
  ), late_items as (
    select earning.id as earning_id, earning.earned_on,
      earning.total_amount as amount
    from cycle_row cycle
    join public.earnings earning
      on earning.maid_profile_id = p_maid_profile_id
     and earning.earned_on >= p_week_start
     and earning.earned_on < p_week_start + 7
     and earning.total_amount > 0
    where cycle.status is not null
      and cycle.status <> 'open'
      and not exists (
        select 1
        from public.payroll_items claimed
        where claimed.earning_id = earning.id
      )
  ), late_totals as (
    select count(*)::integer as item_count,
      coalesce(sum(item.amount), 0)::bigint as total_amount
    from late_items item
  ), late_page as (
    select item.*
    from late_items item
    order by item.earned_on, item.earning_id
    limit p_nested_limit
  )
  select jsonb_build_object(
    'cycleId', cycle.cycle_id,
    'maidProfileId', p_maid_profile_id,
    'weekStart', p_week_start,
    'status', coalesce(cycle.status::text, 'open'),
    'version', coalesce(cycle.version, 0),
    'lockedAmount', cycle.locked_amount,
    'paymentStartedAt', cycle.payment_started_at,
    'itemCount', totals.item_count,
    'totalAmount', coalesce(cycle.locked_amount::bigint, totals.total_amount, 0),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'earningId', item.earning_id,
        'earnedOn', item.earned_on,
        'amount', item.amount,
        'alreadyClaimed', item.already_claimed
      ) order by item.earned_on, item.earning_id)
      from item_page item
    ), '[]'::jsonb),
    'itemsHasMore', totals.item_count > p_nested_limit,
    'itemsLastEarnedOn', (
      select item.earned_on from item_page item
      order by item.earned_on desc, item.earning_id desc limit 1
    ),
    'itemsLastEarningId', (
      select item.earning_id from item_page item
      order by item.earned_on desc, item.earning_id desc limit 1
    ),
    'lateEarningCount', late_totals.item_count,
    'lateEarningAmount', late_totals.total_amount,
    'lateEarnings', coalesce((
      select jsonb_agg(jsonb_build_object(
        'earningId', item.earning_id,
        'earnedOn', item.earned_on,
        'amount', item.amount
      ) order by item.earned_on, item.earning_id)
      from late_page item
    ), '[]'::jsonb),
    'lateEarningsHasMore', late_totals.item_count > p_nested_limit,
    'lateEarningsLastEarnedOn', (
      select item.earned_on from late_page item
      order by item.earned_on desc, item.earning_id desc limit 1
    ),
    'lateEarningsLastEarningId', (
      select item.earning_id from late_page item
      order by item.earned_on desc, item.earning_id desc limit 1
    )
  )
  from cycle_row cycle
  cross join item_totals totals
  cross join late_totals;
$$;

revoke all on function private.project_payroll_cycle_bounded(date, uuid, integer)
from public, anon, authenticated, service_role;

create function public.list_payroll_cycles_page(
  p_actor_profile_id uuid,
  p_week_start date,
  p_maid_profile_id uuid default null,
  p_after_maid_profile_id uuid default null,
  p_limit integer default 10
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor public.profiles;
  v_rows jsonb;
  v_count integer;
  v_last uuid;
begin
  perform private.assert_closed_payroll_week(p_week_start);
  v_actor := private.assert_payroll_reader(p_actor_profile_id);

  if p_limit is null or p_limit < 1 or p_limit > 10 then
    raise exception using errcode = '22023', message = 'PAYROLL_PAGE_LIMIT_INVALID';
  end if;

  if v_actor.role = 'maid' then
    if p_maid_profile_id is not null and p_maid_profile_id <> v_actor.id then
      raise exception using errcode = '42501', message = 'PAYROLL_ACCESS_REQUIRED';
    end if;
    p_maid_profile_id := v_actor.id;
  elsif p_maid_profile_id is not null and not exists (
    select 1 from public.profiles maid
    where maid.id = p_maid_profile_id and maid.role = 'maid'
  ) then
    raise exception using errcode = 'P0002', message = 'PAYROLL_MAID_NOT_FOUND';
  end if;

  with candidates as (
    select maid.id
    from public.profiles maid
    where maid.role = 'maid'
      and (p_maid_profile_id is null or maid.id = p_maid_profile_id)
      and (p_after_maid_profile_id is null or maid.id > p_after_maid_profile_id)
    order by maid.id
    limit p_limit + 1
  ), page as (
    select candidate.id
    from candidates candidate
    order by candidate.id
    limit p_limit
  )
  select
    coalesce(jsonb_agg(
      private.project_payroll_cycle_bounded(p_week_start, page.id, 10)
      order by page.id
    ), '[]'::jsonb),
    (select count(*) from candidates),
    (select id from page order by id desc limit 1)
  into v_rows, v_count, v_last
  from page;

  return jsonb_build_object(
    'payroll', v_rows,
    'hasMore', v_count > p_limit,
    'lastMaidProfileId', v_last
  );
end;
$$;

create function public.list_payroll_entries_page(
  p_actor_profile_id uuid,
  p_week_start date,
  p_maid_profile_id uuid,
  p_kind text,
  p_after_earned_on date default null,
  p_after_earning_id uuid default null,
  p_limit integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor public.profiles;
  v_cycle public.payroll_cycles;
  v_rows jsonb;
  v_count integer;
  v_last_date date;
  v_last_id uuid;
begin
  perform private.assert_closed_payroll_week(p_week_start);
  v_actor := private.assert_payroll_reader(p_actor_profile_id);

  if p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception using errcode = '22023', message = 'PAYROLL_PAGE_LIMIT_INVALID';
  end if;
  if p_kind not in ('items', 'lateEarnings') then
    raise exception using errcode = '22023', message = 'PAYROLL_PAGE_KIND_INVALID';
  end if;
  if (p_after_earned_on is null) <> (p_after_earning_id is null) then
    raise exception using errcode = '22023', message = 'PAYROLL_CURSOR_INVALID';
  end if;

  if v_actor.role = 'maid' and p_maid_profile_id <> v_actor.id then
    raise exception using errcode = '42501', message = 'PAYROLL_ACCESS_REQUIRED';
  elsif v_actor.role = 'admin' and not exists (
    select 1 from public.profiles maid
    where maid.id = p_maid_profile_id and maid.role = 'maid'
  ) then
    raise exception using errcode = 'P0002', message = 'PAYROLL_MAID_NOT_FOUND';
  end if;

  select * into v_cycle
  from public.payroll_cycles cycle
  where cycle.maid_profile_id = p_maid_profile_id
    and cycle.week_start = p_week_start;

  with projected_items as (
    select item.earning_id, earning.earned_on,
      item.locked_amount as amount, true as already_claimed
    from public.payroll_items item
    join public.earnings earning on earning.id = item.earning_id
    where item.payroll_cycle_id = v_cycle.id

    union all

    select earning.id, earning.earned_on, earning.total_amount, false
    from public.earnings earning
    where earning.maid_profile_id = p_maid_profile_id
      and earning.earned_on >= p_week_start
      and earning.earned_on < p_week_start + 7
      and earning.total_amount > 0
      and coalesce(v_cycle.status = 'open', true)
      and not exists (
        select 1 from public.payroll_items claimed
        where claimed.earning_id = earning.id
      )
  ), late_items as (
    select earning.id as earning_id, earning.earned_on,
      earning.total_amount as amount, null::boolean as already_claimed
    from public.earnings earning
    where earning.maid_profile_id = p_maid_profile_id
      and earning.earned_on >= p_week_start
      and earning.earned_on < p_week_start + 7
      and earning.total_amount > 0
      and v_cycle.status is not null
      and v_cycle.status <> 'open'
      and not exists (
        select 1 from public.payroll_items claimed
        where claimed.earning_id = earning.id
      )
  ), selected as (
    select * from projected_items where p_kind = 'items'
    union all
    select * from late_items where p_kind = 'lateEarnings'
  ), candidates as (
    select item.*
    from selected item
    where p_after_earned_on is null
      or (item.earned_on, item.earning_id) > (p_after_earned_on, p_after_earning_id)
    order by item.earned_on, item.earning_id
    limit p_limit + 1
  ), page as (
    select * from candidates
    order by earned_on, earning_id
    limit p_limit
  )
  select
    coalesce(jsonb_agg(
      case when p_kind = 'items' then jsonb_build_object(
        'earningId', page.earning_id,
        'earnedOn', page.earned_on,
        'amount', page.amount,
        'alreadyClaimed', page.already_claimed
      ) else jsonb_build_object(
        'earningId', page.earning_id,
        'earnedOn', page.earned_on,
        'amount', page.amount
      ) end
      order by page.earned_on, page.earning_id
    ), '[]'::jsonb),
    (select count(*) from candidates),
    (select earned_on from page order by earned_on desc, earning_id desc limit 1),
    (select earning_id from page order by earned_on desc, earning_id desc limit 1)
  into v_rows, v_count, v_last_date, v_last_id
  from page;

  return jsonb_build_object(
    'entries', v_rows,
    'hasMore', v_count > p_limit,
    'lastEarnedOn', v_last_date,
    'lastEarningId', v_last_id
  );
end;
$$;

-- Keep the #93 command's logical response shape while ensuring start and
-- idempotent replay never construct or store unbounded arrays. HTTP adapters
-- add signed continuation cursors from the internal final-key metadata.
create or replace function public.list_payroll_cycles(
  p_actor_profile_id uuid,
  p_week_start date,
  p_maid_profile_id uuid default null
)
returns setof jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select item.value
  from jsonb_array_elements(
    public.list_payroll_cycles_page(
      p_actor_profile_id,
      p_week_start,
      p_maid_profile_id,
      null,
      case when p_maid_profile_id is null then 10 else 1 end
    )->'payroll'
  ) item(value);
$$;

revoke all on function public.list_payroll_cycles_page(uuid, date, uuid, uuid, integer),
  public.list_payroll_entries_page(uuid, date, uuid, text, date, uuid, integer)
from public, anon, authenticated, service_role;
grant execute on function public.list_payroll_cycles_page(uuid, date, uuid, uuid, integer),
  public.list_payroll_entries_page(uuid, date, uuid, text, date, uuid, integer)
to service_role;

comment on function public.list_payroll_cycles_page(uuid, date, uuid, uuid, integer)
is 'Issue #96 server-only payroll cycle keyset page; max 10 rows, nested previews max 10.';
comment on function public.list_payroll_entries_page(uuid, date, uuid, text, date, uuid, integer)
is 'Issue #96 server-only payroll item/lateEarnings keyset page; max 50 rows.';
