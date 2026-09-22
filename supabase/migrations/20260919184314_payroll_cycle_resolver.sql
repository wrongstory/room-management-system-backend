-- Issue #217: resolve one already-materialized payroll cycle by its stable ID.
-- The existing bounded projection owns the response contract; this function
-- only resolves cycle identity and applies the same reader/week gates as the
-- payroll list APIs. It is server-only and has no write side effects.

create function public.get_payroll_cycle(
  p_actor_profile_id uuid,
  p_cycle_id uuid
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
begin
  v_actor := private.assert_payroll_reader(p_actor_profile_id);

  select * into v_cycle
  from public.payroll_cycles cycle
  where cycle.id = p_cycle_id;

  if v_cycle.id is null then
    raise exception using errcode = 'P0002', message = 'PAYROLL_CYCLE_NOT_FOUND';
  end if;

  perform private.assert_closed_payroll_week(v_cycle.week_start);

  if v_actor.role = 'maid' and v_cycle.maid_profile_id <> v_actor.id then
    raise exception using errcode = '42501', message = 'PAYROLL_ACCESS_REQUIRED';
  end if;

  return private.project_payroll_cycle_bounded(
    v_cycle.week_start,
    v_cycle.maid_profile_id,
    10
  );
end;
$$;

revoke all on function public.get_payroll_cycle(uuid, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.get_payroll_cycle(uuid, uuid)
to service_role;

comment on function public.get_payroll_cycle(uuid, uuid)
is 'Issue #217 server-only bounded payroll cycle resolver; admin all, maid self, materialized closed weeks only.';
