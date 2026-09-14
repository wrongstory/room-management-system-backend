-- Issue #93: side-effect-free payroll projection and the atomic OPEN -> PAYING
-- assembly command. Existing payroll migrations are already applied, so this
-- file only appends ledgers, guards, policies, and app-owned RPCs.

-- Payroll authorization failures use the same bounded activity aggregate as
-- the other HTTP boundaries. Keep the table constraints and recording RPC in
-- sync so denial telemetry can never replace the original 403.
alter table private.actor_authorization_denial_aggregates
  drop constraint actor_authorization_denial_aggregates_source_check,
  add constraint actor_authorization_denial_aggregates_source_check check (
    source in (
      'edge.authorization.accounts',
      'edge.authorization.developer',
      'edge.authorization.availability',
      'edge.authorization.assignments',
      'edge.authorization.attempts',
      'edge.authorization.photos',
      'edge.authorization.payroll',
      'edge.authorization.reservations',
      'edge.authorization.rooms'
    )
  ),
  drop constraint actor_authorization_denial_aggregates_reason_code_check,
  add constraint actor_authorization_denial_aggregates_reason_code_check check (
    reason_code in (
      'ACCOUNT_MANAGER_REQUIRED',
      'ADMIN_REQUIRED',
      'ASSIGNMENT_ACCESS_REQUIRED',
      'ATTEMPT_ACCESS_REQUIRED',
      'CAPABILITY_ACCESS_REQUIRED',
      'PHOTO_ACCESS_REQUIRED',
      'AVAILABILITY_ACCESS_REQUIRED',
      'DEVELOPER_REQUIRED',
      'MAID_REQUIRED',
      'BOMB_REPORT_ACCESS_REQUIRED',
      'SUBMISSION_ACCESS_REQUIRED',
      'PAYROLL_ACCESS_REQUIRED',
      'PASSWORD_CHANGE_REQUIRED'
    )
  );

create or replace function public.record_authorization_denial(
  p_actor_profile_id uuid,
  p_source text,
  p_reason_code text,
  p_occurred_at timestamptz default clock_timestamp()
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles%rowtype;
  v_bucket timestamptz;
begin
  if p_occurred_at is null
    or abs(extract(epoch from (clock_timestamp() - p_occurred_at))) > 300
    or p_source not in (
      'edge.authorization.accounts',
      'edge.authorization.developer',
      'edge.authorization.availability',
      'edge.authorization.assignments',
      'edge.authorization.attempts',
      'edge.authorization.photos',
      'edge.authorization.payroll',
      'edge.authorization.reservations',
      'edge.authorization.rooms'
    )
    or p_reason_code not in (
      'ACCOUNT_MANAGER_REQUIRED',
      'ADMIN_REQUIRED',
      'ASSIGNMENT_ACCESS_REQUIRED',
      'ATTEMPT_ACCESS_REQUIRED',
      'CAPABILITY_ACCESS_REQUIRED',
      'PHOTO_ACCESS_REQUIRED',
      'AVAILABILITY_ACCESS_REQUIRED',
      'DEVELOPER_REQUIRED',
      'MAID_REQUIRED',
      'BOMB_REPORT_ACCESS_REQUIRED',
      'SUBMISSION_ACCESS_REQUIRED',
      'PAYROLL_ACCESS_REQUIRED',
      'PASSWORD_CHANGE_REQUIRED'
    ) then
    raise exception using errcode = '22023', message = 'INVALID_ACTIVITY_EVENT';
  end if;

  select * into v_profile
  from public.profiles profile
  where profile.id = p_actor_profile_id
    and (
      profile.status = 'active'
      or (
        profile.role = 'maid'
        and profile.status in ('deactivation_pending', 'upload_only')
        and (
          (
            p_source = 'edge.authorization.attempts'
            and p_reason_code in (
              'CAPABILITY_ACCESS_REQUIRED', 'SUBMISSION_ACCESS_REQUIRED'
            )
          )
          or (
            p_source = 'edge.authorization.photos'
            and p_reason_code in (
              'PHOTO_ACCESS_REQUIRED', 'CAPABILITY_ACCESS_REQUIRED'
            )
          )
        )
      )
    );

  if not found then
    raise exception using errcode = '22023', message = 'INVALID_ACTIVITY_ACTOR';
  end if;

  v_bucket := date_trunc('minute', p_occurred_at);

  insert into private.actor_authorization_denial_aggregates (
    actor_profile_id,
    actor_role_snapshot,
    category,
    event_type,
    outcome,
    source,
    reason_code,
    bucket_started_at,
    occurrence_count,
    first_occurred_at,
    last_occurred_at
  ) values (
    v_profile.id,
    v_profile.role,
    'authorization',
    'authorization.denied',
    'denied',
    p_source,
    p_reason_code,
    v_bucket,
    1,
    p_occurred_at,
    p_occurred_at
  )
  on conflict (actor_profile_id, source, reason_code, bucket_started_at)
  do update set
    occurrence_count = least(
      private.actor_authorization_denial_aggregates.occurrence_count + 1,
      600
    ),
    last_occurred_at = greatest(
      private.actor_authorization_denial_aggregates.last_occurred_at,
      excluded.last_occurred_at
    );

  delete from private.actor_authorization_denial_aggregates aggregate
  where aggregate.id in (
    select expired.id
    from private.actor_authorization_denial_aggregates expired
    where expired.bucket_started_at < v_bucket - interval '31 days'
    order by expired.bucket_started_at
    limit 64
  );
end;
$$;

create table public.payroll_events (
  id bigint generated always as identity primary key,
  payroll_cycle_id uuid not null,
  maid_profile_id uuid not null,
  event_type text not null check (event_type = 'payment_started'),
  before_status public.payment_status not null check (before_status = 'open'),
  after_status public.payment_status not null check (after_status = 'paying'),
  actor_profile_id uuid not null references public.profiles(id) on delete restrict,
  cycle_version bigint not null check (cycle_version > 0),
  locked_amount integer not null check (locked_amount > 0),
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  constraint payroll_events_cycle_maid_fk
    foreign key (payroll_cycle_id, maid_profile_id)
    references public.payroll_cycles (id, maid_profile_id)
    on delete restrict,
  unique (payroll_cycle_id, cycle_version, event_type)
);

create index payroll_events_maid_week_read_idx
on public.payroll_events (maid_profile_id, occurred_at desc, id desc);

create index payroll_events_actor_profile_id_idx
on public.payroll_events (actor_profile_id, occurred_at desc);

alter table public.payroll_events enable row level security;

-- Payroll rows are unavailable until an active administrator or maid has
-- completed the mandatory first-password change. The private predicate keeps
-- the profiles base table closed while resolving every read from fresh DB state.
create function private.can_read_payroll_row(p_maid_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.profiles actor
    where actor.auth_user_id = (select auth.uid())
      and actor.status = 'active'
      and actor.must_change_password = false
      and (
        actor.role = 'admin'
        or (actor.role = 'maid' and actor.id = p_maid_profile_id)
      )
  )
$$;

revoke all on function private.can_read_payroll_row(uuid)
from public, anon, authenticated, service_role;
grant execute on function private.can_read_payroll_row(uuid) to authenticated;

drop policy if exists earnings_read_scoped on public.earnings;
create policy earnings_read_scoped on public.earnings
for select to authenticated
using ((select private.can_read_payroll_row(earnings.maid_profile_id)));

drop policy if exists payroll_read_scoped on public.payroll_cycles;
create policy payroll_read_scoped on public.payroll_cycles
for select to authenticated
using ((select private.can_read_payroll_row(payroll_cycles.maid_profile_id)));

drop policy if exists payroll_items_read_scoped on public.payroll_items;
create policy payroll_items_read_scoped on public.payroll_items
for select to authenticated
using ((select private.can_read_payroll_row(payroll_items.maid_profile_id)));

create policy payroll_events_read_scoped on public.payroll_events
for select to authenticated
using ((select private.can_read_payroll_row(payroll_events.maid_profile_id)));

create function private.prevent_payroll_event_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception using errcode = '55000', message = 'PAYROLL_EVENT_IMMUTABLE';
end;
$$;

revoke all on function private.prevent_payroll_event_mutation()
from public, anon, authenticated, service_role;

create trigger payroll_events_append_only
before update or delete on public.payroll_events
for each row execute function private.prevent_payroll_event_mutation();

create function private.prevent_payroll_cycle_delete()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception using errcode = '55000', message = 'PAYROLL_CYCLE_DELETE_FORBIDDEN';
end;
$$;

revoke all on function private.prevent_payroll_cycle_delete()
from public, anon, authenticated, service_role;

create trigger payroll_cycles_prevent_delete
before delete on public.payroll_cycles
for each row execute function private.prevent_payroll_cycle_delete();

-- These pre-existing deferred constraint triggers can fire after the public
-- SECURITY DEFINER RPC has returned to service_role. Run the two trigger
-- adapters as their owner so private-schema revocation does not turn a valid
-- command into a commit-time permission failure.
alter function private.check_payroll_item_cycle_total() security definer;
alter function private.check_payroll_cycle_total() security definer;

revoke all on function private.check_payroll_item_cycle_total(),
  private.check_payroll_cycle_total(),
  private.assert_payroll_cycle_total(uuid)
from public, anon, authenticated, service_role;

create function private.assert_payroll_reader(p_actor_profile_id uuid)
returns public.profiles
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor public.profiles;
begin
  select * into v_actor
  from public.profiles profile
  where profile.id = p_actor_profile_id
    and profile.status = 'active'
    and not profile.must_change_password
    and profile.role in ('admin', 'maid');

  if v_actor.id is null then
    raise exception using errcode = '42501', message = 'PAYROLL_ACCESS_REQUIRED';
  end if;

  return v_actor;
end;
$$;

revoke all on function private.assert_payroll_reader(uuid)
from public, anon, authenticated, service_role;

create function private.assert_closed_payroll_week(p_week_start date)
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  v_current_week date := date_trunc(
    'week', statement_timestamp() at time zone 'Asia/Seoul'
  )::date;
begin
  if p_week_start is null or extract(isodow from p_week_start) <> 1 then
    raise exception using errcode = '22023', message = 'PAYROLL_WEEK_MUST_START_MONDAY';
  end if;

  if p_week_start >= v_current_week then
    raise exception using errcode = '22023', message = 'PAYROLL_WEEK_NOT_CLOSED';
  end if;
end;
$$;

revoke all on function private.assert_closed_payroll_week(date)
from public, anon, authenticated, service_role;

create function public.list_payroll_cycles(
  p_actor_profile_id uuid,
  p_week_start date,
  p_maid_profile_id uuid default null
)
returns setof jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor public.profiles;
begin
  perform private.assert_closed_payroll_week(p_week_start);
  v_actor := private.assert_payroll_reader(p_actor_profile_id);

  if v_actor.role = 'maid' then
    if p_maid_profile_id is not null and p_maid_profile_id <> v_actor.id then
      raise exception using errcode = '42501', message = 'PAYROLL_ACCESS_REQUIRED';
    end if;
    p_maid_profile_id := v_actor.id;
  elsif p_maid_profile_id is not null and not exists (
    select 1
    from public.profiles maid
    where maid.id = p_maid_profile_id
      and maid.role = 'maid'
  ) then
    raise exception using errcode = 'P0002', message = 'PAYROLL_MAID_NOT_FOUND';
  end if;

  return query
  with target_maids as (
    select maid.id
    from public.profiles maid
    where maid.role = 'maid'
      and (p_maid_profile_id is null or maid.id = p_maid_profile_id)
  ), cycle_rows as (
    select
      target.id as maid_profile_id,
      cycle.id as cycle_id,
      cycle.status,
      cycle.locked_amount,
      cycle.payment_started_at,
      cycle.version
    from target_maids target
    left join public.payroll_cycles cycle
      on cycle.maid_profile_id = target.id
     and cycle.week_start = p_week_start
  ), projected_items as (
    select
      cycle.maid_profile_id,
      item.earning_id,
      earning.earned_on,
      item.locked_amount as amount,
      true as already_claimed
    from cycle_rows cycle
    join public.payroll_items item on item.payroll_cycle_id = cycle.cycle_id
    join public.earnings earning on earning.id = item.earning_id

    union all

    select
      cycle.maid_profile_id,
      earning.id,
      earning.earned_on,
      earning.total_amount,
      false
    from cycle_rows cycle
    join public.earnings earning
      on earning.maid_profile_id = cycle.maid_profile_id
     and earning.earned_on >= p_week_start
     and earning.earned_on < p_week_start + 7
     and earning.total_amount > 0
    where coalesce(cycle.status = 'open', true)
      and not exists (
        select 1 from public.payroll_items claimed
        where claimed.earning_id = earning.id
      )
  ), item_rollups as (
    select
      item.maid_profile_id,
      count(*)::integer as item_count,
      coalesce(sum(item.amount), 0)::bigint as total_amount,
      jsonb_agg(
        jsonb_build_object(
          'earningId', item.earning_id,
          'earnedOn', item.earned_on,
          'amount', item.amount,
          'alreadyClaimed', item.already_claimed
        ) order by item.earned_on, item.earning_id
      ) as items
    from projected_items item
    group by item.maid_profile_id
  ), late_item_rollups as (
    select
      cycle.maid_profile_id,
      count(*)::integer as item_count,
      coalesce(sum(earning.total_amount), 0)::bigint as total_amount,
      jsonb_agg(
        jsonb_build_object(
          'earningId', earning.id,
          'earnedOn', earning.earned_on,
          'amount', earning.total_amount
        ) order by earning.earned_on, earning.id
      ) as items
    from cycle_rows cycle
    join public.earnings earning
      on earning.maid_profile_id = cycle.maid_profile_id
     and earning.earned_on >= p_week_start
     and earning.earned_on < p_week_start + 7
     and earning.total_amount > 0
    where cycle.status is not null
      and cycle.status <> 'open'
      and not exists (
        select 1 from public.payroll_items claimed
        where claimed.earning_id = earning.id
      )
    group by cycle.maid_profile_id
  )
  select jsonb_build_object(
    'cycleId', cycle.cycle_id,
    'maidProfileId', cycle.maid_profile_id,
    'weekStart', p_week_start,
    'status', coalesce(cycle.status::text, 'open'),
    'version', coalesce(cycle.version, 0),
    'lockedAmount', cycle.locked_amount,
    'paymentStartedAt', cycle.payment_started_at,
    'itemCount', coalesce(rollup.item_count, 0),
    'totalAmount', coalesce(cycle.locked_amount::bigint, rollup.total_amount, 0),
    'items', coalesce(rollup.items, '[]'::jsonb),
    'lateEarningCount', coalesce(late.item_count, 0),
    'lateEarningAmount', coalesce(late.total_amount, 0),
    'lateEarnings', coalesce(late.items, '[]'::jsonb)
  )
  from cycle_rows cycle
  left join item_rollups rollup on rollup.maid_profile_id = cycle.maid_profile_id
  left join late_item_rollups late on late.maid_profile_id = cycle.maid_profile_id
  order by cycle.maid_profile_id;
end;
$$;

create function public.start_payroll_cycle(
  p_actor_profile_id uuid,
  p_maid_profile_id uuid,
  p_week_start date,
  p_expected_version bigint,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.profiles;
  v_cycle public.payroll_cycles;
  v_replay jsonb;
  v_result jsonb;
  v_created boolean := false;
  v_total bigint;
  v_event_id bigint;
  v_notification_id uuid;
  v_started_at timestamptz;
begin
  -- #31 inspection approval takes this same lock before it reads or creates an
  -- earning. Taking it before every payroll table read gives the two commands
  -- one serialization order and prevents a half-observed approval.
  perform pg_advisory_xact_lock(
    hashtextextended('room-management:reservation-command', 0)
  );

  v_replay := private.replay_command(
    p_actor_profile_id,
    'payroll.start',
    p_idempotency_key,
    p_request_hash
  );

  select * into v_actor
  from public.profiles profile
  where profile.id = p_actor_profile_id
    and profile.role = 'admin'
    and profile.status = 'active'
    and not profile.must_change_password
  for no key update;

  if v_actor.id is null then
    raise exception using errcode = '42501', message = 'ADMIN_REQUIRED';
  end if;

  perform private.assert_closed_payroll_week(p_week_start);

  if p_expected_version is null or p_expected_version < 0 then
    raise exception using errcode = '22023', message = 'INVALID_EXPECTED_VERSION';
  end if;

  if not exists (
    select 1
    from public.profiles maid
    where maid.id = p_maid_profile_id
      and maid.role = 'maid'
  ) then
    raise exception using errcode = 'P0002', message = 'PAYROLL_MAID_NOT_FOUND';
  end if;

  if v_replay is not null then
    return v_replay;
  end if;

  select * into v_cycle
  from public.payroll_cycles cycle
  where cycle.maid_profile_id = p_maid_profile_id
    and cycle.week_start = p_week_start
  for update;

  if v_cycle.id is null then
    if p_expected_version <> 0 then
      raise exception using errcode = '40001', message = 'STALE_VERSION';
    end if;

    insert into public.payroll_cycles (maid_profile_id, week_start)
    values (p_maid_profile_id, p_week_start)
    returning * into v_cycle;
    v_created := true;
  elsif v_cycle.status <> 'open' then
    raise exception using errcode = '55000', message = 'PAYROLL_CYCLE_NOT_OPEN';
  elsif v_cycle.version <> p_expected_version then
    raise exception using errcode = '40001', message = 'STALE_VERSION';
  end if;

  insert into public.payroll_items (
    payroll_cycle_id,
    earning_id,
    maid_profile_id,
    locked_amount
  )
  select
    v_cycle.id,
    earning.id,
    p_maid_profile_id,
    earning.total_amount
  from public.earnings earning
  where earning.maid_profile_id = p_maid_profile_id
    and earning.earned_on >= p_week_start
    and earning.earned_on < p_week_start + 7
    and earning.total_amount > 0
    and not exists (
      select 1 from public.payroll_items claimed
      where claimed.earning_id = earning.id
    )
  order by earning.earned_on, earning.id
  on conflict (earning_id) do nothing;

  select coalesce(sum(item.locked_amount), 0)
  into v_total
  from public.payroll_items item
  where item.payroll_cycle_id = v_cycle.id;

  if v_total <= 0 then
    raise exception using errcode = '22023', message = 'NO_PAYROLL_AMOUNT';
  end if;

  v_started_at := clock_timestamp();

  update public.payroll_cycles cycle
  set
    status = 'paying',
    locked_amount = v_total::integer,
    payment_started_by = v_actor.id,
    payment_started_at = v_started_at,
    version = case when v_created then 1 else cycle.version + 1 end
  where cycle.id = v_cycle.id
    and cycle.status = 'open'
    and cycle.version = v_cycle.version
  returning * into v_cycle;

  if v_cycle.id is null then
    raise exception using errcode = '40001', message = 'STALE_VERSION';
  end if;

  insert into public.payroll_events (
    payroll_cycle_id,
    maid_profile_id,
    event_type,
    before_status,
    after_status,
    actor_profile_id,
    cycle_version,
    locked_amount,
    occurred_at
  ) values (
    v_cycle.id,
    v_cycle.maid_profile_id,
    'payment_started',
    'open',
    'paying',
    v_actor.id,
    v_cycle.version,
    v_cycle.locked_amount,
    v_started_at
  ) returning id into v_event_id;

  insert into public.audit_events (
    actor_profile_id,
    event_type,
    entity_type,
    entity_id,
    effective_at,
    after_state,
    idempotency_key
  ) values (
    v_actor.id,
    'payroll.payment_started',
    'payroll_cycle',
    v_cycle.id,
    v_started_at,
    jsonb_build_object(
      'weekStart', v_cycle.week_start,
      'status', v_cycle.status,
      'version', v_cycle.version,
      'payrollEventId', v_event_id
    ),
    private.audit_command_key(v_actor.id, 'payroll.start', p_idempotency_key)
  );

  insert into public.notifications (
    recipient_profile_id,
    category,
    title,
    body,
    dedupe_key,
    requires_action,
    occurred_at
  ) values (
    v_cycle.maid_profile_id,
    'payroll_payment_started',
    '주급 지급 처리 시작',
    '종료된 주차의 주급 지급 처리가 시작되었습니다.',
    'payroll-start:' || v_cycle.id::text || ':' || v_cycle.version::text,
    false,
    v_started_at
  ) returning id into v_notification_id;

  insert into private.notification_outbox (
    notification_id,
    channel,
    delivery_status,
    next_attempt_at,
    created_at
  ) values (
    v_notification_id,
    'web_push',
    'pending',
    v_started_at,
    v_started_at
  );

  select projection.value into v_result
  from public.list_payroll_cycles(
    v_actor.id,
    p_week_start,
    p_maid_profile_id
  ) as projection(value)
  limit 1;

  perform private.complete_command(
    v_actor.id,
    'payroll.start',
    p_idempotency_key,
    p_request_hash,
    v_cycle.id,
    v_result
  );

  return v_result;
end;
$$;

-- Extend the developer audit allowlist without returning raw audit JSON.
-- Every older event type remains delegated to the prior reviewed projection.
alter function public.list_developer_audit_events(
  uuid, text[], uuid, timestamptz, timestamptz, timestamptz, uuid, integer
) set schema private;

alter function private.list_developer_audit_events(
  uuid, text[], uuid, timestamptz, timestamptz, timestamptz, uuid, integer
) rename to list_developer_audit_events_before_payroll;

revoke all on function private.list_developer_audit_events_before_payroll(
  uuid, text[], uuid, timestamptz, timestamptz, timestamptz, uuid, integer
) from public, anon, authenticated, service_role;

create function public.list_developer_audit_events(
  p_actor_profile_id uuid,
  p_event_types text[] default null,
  p_filter_actor_profile_id uuid default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_before_recorded_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 50
)
returns table(
  id uuid,
  event_type text,
  entity_type text,
  entity_id uuid,
  actor_profile_id uuid,
  actor_display_name text,
  effective_at timestamptz,
  recorded_at timestamptz,
  reason_code text,
  summary jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_previous_types text[];
  v_from timestamptz := coalesce(p_from, clock_timestamp() - interval '7 days');
  v_to timestamptz := coalesce(p_to, clock_timestamp());
begin
  if p_event_types is not null and coalesce(cardinality(p_event_types), 0) = 0 then
    raise exception using errcode = '22023', message = 'INVALID_AUDIT_QUERY';
  end if;

  if p_event_types is null then
    v_previous_types := null;
  else
    select coalesce(array_agg(requested), array[]::text[])
    into v_previous_types
    from unnest(p_event_types) requested
    where requested <> 'payroll.payment_started';

    if cardinality(v_previous_types) = 0 then
      -- The delegated call still owns common actor/range/cursor/limit checks.
      v_previous_types := array['account.created'];
    end if;
  end if;

  return query
  select merged.*
  from (
    select previous.*
    from private.list_developer_audit_events_before_payroll(
      p_actor_profile_id,
      v_previous_types,
      p_filter_actor_profile_id,
      p_from,
      p_to,
      p_before_recorded_at,
      p_before_id,
      p_limit
    ) previous
    where p_event_types is null or previous.event_type = any(p_event_types)

    union all

    select
      audit.id,
      audit.event_type,
      audit.entity_type,
      audit.entity_id,
      audit.actor_profile_id,
      audit.actor_display_name_snapshot,
      audit.effective_at,
      audit.recorded_at,
      audit.reason_code,
      jsonb_strip_nulls(jsonb_build_object(
        'weekStart', audit.after_state->'weekStart',
        'status', audit.after_state->>'status',
        'version', audit.after_state->'version',
        'payrollEventId', audit.after_state->'payrollEventId'
      ))
    from public.audit_events audit
    where audit.event_type = 'payroll.payment_started'
      and (p_event_types is null or audit.event_type = any(p_event_types))
      and audit.recorded_at >= v_from
      and audit.recorded_at <= v_to
      and (
        p_filter_actor_profile_id is null
        or audit.actor_profile_id = p_filter_actor_profile_id
      )
      and (
        p_before_recorded_at is null
        or (audit.recorded_at, audit.id) < (p_before_recorded_at, p_before_id)
      )
    order by recorded_at desc, id desc
    limit p_limit
  ) merged
  order by merged.recorded_at desc, merged.id desc
  limit p_limit;
end;
$$;

-- Raw payroll mutation and service-role hydration are intentionally absent.
-- Authenticated reads remain protected by the exact active admin/maid RLS
-- policies, while the server role can only call the two reviewed RPCs below.
revoke all privileges on public.earnings, public.payroll_cycles,
  public.payroll_items, public.payroll_events
from anon, service_role;

revoke insert, update, delete, truncate, references, trigger
on public.payroll_cycles, public.payroll_items, public.payroll_events
from authenticated;

grant select on public.earnings, public.payroll_cycles,
  public.payroll_items, public.payroll_events
to authenticated;

revoke all on sequence public.payroll_events_id_seq
from public, anon, authenticated, service_role;

revoke all on function public.list_payroll_cycles(uuid, date, uuid),
  public.start_payroll_cycle(uuid, uuid, date, bigint, text, text),
  public.list_developer_audit_events(
    uuid, text[], uuid, timestamptz, timestamptz, timestamptz, uuid, integer
  )
from public, anon, authenticated, service_role;

grant execute on function public.list_payroll_cycles(uuid, date, uuid),
  public.start_payroll_cycle(uuid, uuid, date, bigint, text, text),
  public.list_developer_audit_events(
    uuid, text[], uuid, timestamptz, timestamptz, timestamptz, uuid, integer
  )
to service_role;
