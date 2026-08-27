select '1..19';

with checks(test_number, description, passed) as (
  values
    (
      1,
      'room-wide active cleaning target index is removed',
      not exists (
        select 1 from pg_indexes
        where schemaname = 'public' and indexname = 'cleaning_targets_one_active_per_room'
      )
    ),
    (
      2,
      'checkout obligation is unique per reservation',
      exists (
        select 1 from pg_indexes
        where schemaname = 'public' and indexname = 'cleaning_targets_one_checkout_per_reservation'
      )
    ),
    (
      3,
      'cleaning target and reservation must reference the same room',
      exists (
        select 1 from pg_constraint
        where conrelid = 'public.cleaning_targets'::regclass
          and conname = 'cleaning_targets_reservation_room_fk'
      )
    ),
    (
      4,
      'attempt references one matching assignment contract',
      exists (
        select 1 from pg_constraint
        where conrelid = 'public.cleaning_attempts'::regclass
          and conname = 'cleaning_attempts_assignment_contract_fk'
      )
    ),
    (
      5,
      'submission author matches the attempt maid',
      exists (
        select 1 from pg_constraint
        where conrelid = 'public.cleaning_submissions'::regclass
          and conname = 'cleaning_submissions_attempt_maid_fk'
      )
    ),
    (
      6,
      'earning owner matches the submission maid',
      exists (
        select 1 from pg_constraint
        where conrelid = 'public.earnings'::regclass
          and conname = 'earnings_submission_maid_fk'
      )
    ),
    (
      7,
      'inspection reclean compensation earning source is removed',
      not exists (
        select 1 from information_schema.columns
        where table_schema = 'public'
          and table_name = 'earnings'
          and column_name = 'reclean_compensation_decision_id'
      )
    ),
    (
      8,
      'bomb-room bonus is zero or exactly the base amount',
      exists (
        select 1 from pg_constraint
        where conrelid = 'public.earnings'::regclass
          and conname = 'earnings_bomb_bonus_exact_check'
      )
    ),
    (
      9,
      'payroll cycle no longer stores earning UUID arrays',
      not exists (
        select 1 from information_schema.columns
        where table_schema = 'public'
          and table_name = 'payroll_cycles'
          and column_name = 'locked_earning_ids'
      )
    ),
    (
      10,
      'normalized payroll items table exists',
      to_regclass('public.payroll_items') is not null
    ),
    (
      11,
      'an earning can be claimed by only one payroll item',
      exists (
        select 1 from pg_constraint
        where conrelid = 'public.payroll_items'::regclass
          and conname = 'payroll_items_earning_id_key'
          and contype = 'u'
      )
    ),
    (
      12,
      'payroll state and timestamps have a database invariant',
      exists (
        select 1 from pg_constraint
        where conrelid = 'public.payroll_cycles'::regclass
          and conname = 'payroll_cycles_state_check'
      )
    ),
    (
      13,
      'payroll items have RLS enabled',
      (select relrowsecurity from pg_class where oid = 'public.payroll_items'::regclass)
    ),
    (
      14,
      'authenticated users have explicit payroll item select privilege',
      has_table_privilege('authenticated', 'public.payroll_items', 'select')
    ),
    (
      15,
      'anonymous users cannot read payroll items',
      not has_table_privilege('anon', 'public.payroll_items', 'select')
    ),
    (
      16,
      'assignment trigger enforces active maid and reclean ownership',
      exists (
        select 1 from pg_trigger
        where tgrelid = 'public.cleaning_assignments'::regclass
          and tgname = 'cleaning_assignments_enforce_contract'
          and not tgisinternal
      )
    ),
    (
      17,
      'inspection reclean origin is immutable after creation',
      position(
        'CLEANING_TARGET_ORIGIN_IMMUTABLE'
        in pg_get_functiondef('private.enforce_reclean_origin_room()'::regprocedure)
      ) > 0
    ),
    (
      18,
      'payroll item trigger checks cycle state and earning week',
      position(
        'PAYROLL_CYCLE_NOT_OPEN'
        in pg_get_functiondef('private.set_payroll_item_amount()'::regprocedure)
      ) > 0
      and position(
        'EARNING_OUTSIDE_PAYROLL_WEEK'
        in pg_get_functiondef('private.set_payroll_item_amount()'::regprocedure)
      ) > 0
    ),
    (
      19,
      'payroll cycle snapshot rewrite trigger exists',
      exists (
        select 1 from pg_trigger
        where tgrelid = 'public.payroll_cycles'::regclass
          and tgname = 'payroll_cycles_prevent_snapshot_rewrite'
          and not tgisinternal
      )
    )
)
select case
  when passed then format('ok %s - %s', test_number, description)
  else format('not ok %s - %s', test_number, description)
end
from checks
order by test_number;
