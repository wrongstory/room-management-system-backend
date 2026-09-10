-- Issue #103: append-only evidence for administrator-attested external payroll
-- payment results. The application never calls a payment provider.

create table public.payroll_payment_attempts (
  id uuid primary key default gen_random_uuid(),
  payroll_cycle_id uuid not null,
  maid_profile_id uuid not null,
  attempt_number integer not null check (attempt_number > 0),
  start_event_id bigint not null unique references public.payroll_events(id) on delete restrict,
  start_cycle_version bigint not null check (start_cycle_version > 0),
  locked_amount integer not null check (locked_amount > 0),
  started_by uuid not null references public.profiles(id) on delete restrict,
  started_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  constraint payroll_payment_attempts_cycle_maid_fk foreign key (payroll_cycle_id,maid_profile_id)
    references public.payroll_cycles(id,maid_profile_id) on delete restrict,
  constraint payroll_payment_attempts_id_cycle_maid_unique unique(id,payroll_cycle_id,maid_profile_id),
  constraint payroll_payment_attempts_cycle_number_unique unique(payroll_cycle_id,attempt_number)
);

create index payroll_payment_attempts_maid_started_idx
on public.payroll_payment_attempts(maid_profile_id,started_at desc,id desc);

create table public.payroll_payment_results (
  id uuid primary key default gen_random_uuid(),
  payment_attempt_id uuid not null,
  payroll_cycle_id uuid not null,
  maid_profile_id uuid not null,
  result_type text not null check (result_type in ('check','paid','reopened')),
  before_status public.payment_status not null,
  after_status public.payment_status not null,
  cycle_version bigint not null check (cycle_version > 0),
  locked_amount integer not null check (locked_amount > 0),
  payment_method text,
  canonical_reference text,
  reason_code text,
  actor_profile_id uuid not null references public.profiles(id) on delete restrict,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  constraint payroll_payment_results_attempt_cycle_maid_fk
    foreign key(payment_attempt_id,payroll_cycle_id,maid_profile_id)
    references public.payroll_payment_attempts(id,payroll_cycle_id,maid_profile_id) on delete restrict,
  constraint payroll_payment_results_shape_check check (
    (result_type='check' and before_status='paying' and after_status='check'
      and payment_method is null and canonical_reference is null
      and reason_code='TRANSFER_RESULT_UNCERTAIN')
    or
    (result_type='paid' and before_status in ('paying','check') and after_status='paid'
      and payment_method='bank_transfer' and canonical_reference is not null and reason_code is null)
    or
    (result_type='reopened' and before_status in ('paying','check') and after_status='open'
      and payment_method is null and canonical_reference is null
      and reason_code='NO_TRANSFER_CONFIRMED')
  ),
  constraint payroll_payment_results_canonical_reference_check check (
    canonical_reference is null or (
      char_length(canonical_reference) between 8 and 64
      and canonical_reference collate "C" ~ '^[A-Z0-9][A-Z0-9._:-]{7,63}$'
      and canonical_reference collate "C" ~ '[A-Z]'
      and canonical_reference collate "C" ~ '[0-9]'
      and canonical_reference collate "C" !~ '[0-9]{7}'
      and canonical_reference collate "C" !~ '(^WWW\.|HTTP)'
      and canonical_reference=upper(canonical_reference)
    )
  ),
  unique(payment_attempt_id,result_type)
);

create unique index payroll_payment_results_terminal_attempt_unique
on public.payroll_payment_results(payment_attempt_id)
where result_type in ('paid','reopened');
create unique index payroll_payment_results_reference_unique
on public.payroll_payment_results(payment_method,canonical_reference)
where canonical_reference is not null;
create index payroll_payment_results_cycle_occurred_idx
on public.payroll_payment_results(payroll_cycle_id,occurred_at desc,id desc);
create index payroll_payment_results_maid_occurred_idx
on public.payroll_payment_results(maid_profile_id,occurred_at desc,id desc);

alter table public.payroll_payment_attempts enable row level security;
alter table public.payroll_payment_results enable row level security;

create function private.prevent_payroll_payment_evidence_mutation()
returns trigger language plpgsql set search_path='' as $$
begin
  raise exception using errcode='55000',message='PAYROLL_PAYMENT_EVIDENCE_IMMUTABLE';
end $$;
revoke all on function private.prevent_payroll_payment_evidence_mutation()
from public,anon,authenticated,service_role;
create trigger payroll_payment_attempts_append_only before update or delete
on public.payroll_payment_attempts for each row execute function private.prevent_payroll_payment_evidence_mutation();
create trigger payroll_payment_results_append_only before update or delete
on public.payroll_payment_results for each row execute function private.prevent_payroll_payment_evidence_mutation();

create function private.guard_payroll_payment_attempt()
returns trigger language plpgsql set search_path='' as $$
declare v_event public.payroll_events; v_expected integer;
begin
  select * into v_event from public.payroll_events where id=new.start_event_id;
  if v_event.id is null or v_event.payroll_cycle_id<>new.payroll_cycle_id
    or v_event.maid_profile_id<>new.maid_profile_id or v_event.event_type<>'payment_started'
    or v_event.before_status<>'open' or v_event.after_status<>'paying'
    or v_event.actor_profile_id<>new.started_by or v_event.cycle_version<>new.start_cycle_version
    or v_event.locked_amount<>new.locked_amount or v_event.occurred_at<>new.started_at then
    raise exception using errcode='23514',message='PAYROLL_PAYMENT_ATTEMPT_SOURCE_MISMATCH';
  end if;
  select count(*)::integer+1 into v_expected from public.payroll_payment_attempts
  where payroll_cycle_id=new.payroll_cycle_id;
  if new.attempt_number<>v_expected then
    raise exception using errcode='23514',message='PAYROLL_PAYMENT_ATTEMPT_SEQUENCE_INVALID';
  end if;
  return new;
end $$;
revoke all on function private.guard_payroll_payment_attempt()
from public,anon,authenticated,service_role;
create trigger payroll_payment_attempts_guard before insert on public.payroll_payment_attempts
for each row execute function private.guard_payroll_payment_attempt();

create function private.guard_payroll_payment_result()
returns trigger language plpgsql set search_path='' as $$
declare v_attempt public.payroll_payment_attempts; v_cycle public.payroll_cycles;
begin
  select * into v_attempt from public.payroll_payment_attempts where id=new.payment_attempt_id;
  select * into v_cycle from public.payroll_cycles where id=new.payroll_cycle_id;
  if v_attempt.id is null or v_cycle.id is null
    or v_attempt.payroll_cycle_id<>new.payroll_cycle_id
    or v_attempt.maid_profile_id<>new.maid_profile_id
    or v_attempt.locked_amount<>new.locked_amount
    or v_cycle.maid_profile_id<>new.maid_profile_id
    or v_cycle.status<>new.after_status or v_cycle.version<>new.cycle_version then
    raise exception using errcode='23514',message='PAYROLL_PAYMENT_RESULT_SOURCE_MISMATCH';
  end if;
  if new.result_type in ('check','paid') and v_cycle.locked_amount<>new.locked_amount then
    raise exception using errcode='23514',message='PAYROLL_PAYMENT_RESULT_AMOUNT_MISMATCH';
  end if;
  if new.result_type='reopened' and (v_cycle.locked_amount is not null
    or v_cycle.last_reopen_reason<>'NO_TRANSFER_CONFIRMED'
    or v_cycle.last_reopened_by<>new.actor_profile_id
    or v_cycle.last_reopened_at<>new.occurred_at) then
    raise exception using errcode='23514',message='PAYROLL_PAYMENT_REOPEN_PROJECTION_MISMATCH';
  end if;
  return new;
end $$;
revoke all on function private.guard_payroll_payment_result()
from public,anon,authenticated,service_role;
create trigger payroll_payment_results_guard before insert on public.payroll_payment_results
for each row execute function private.guard_payroll_payment_result();

-- Existing payment-start events prove attempts, but historical CHECK/PAID rows
-- do not prove external transfer results and are intentionally not synthesized.
insert into public.payroll_payment_attempts(payroll_cycle_id,maid_profile_id,attempt_number,start_event_id,
  start_cycle_version,locked_amount,started_by,started_at,recorded_at)
select event.payroll_cycle_id,event.maid_profile_id,
  row_number() over(partition by event.payroll_cycle_id order by event.cycle_version,event.id)::integer,
  event.id,event.cycle_version,event.locked_amount,event.actor_profile_id,event.occurred_at,event.recorded_at
from public.payroll_events event where event.event_type='payment_started'
order by event.payroll_cycle_id,event.cycle_version,event.id;

-- Only transitions captured after this migration require new result evidence;
-- historical CHECK/PAID state is deliberately not inferred or backfilled.
create table private.payroll_payment_projection_transitions (
  id bigint generated always as identity primary key,
  payroll_cycle_id uuid not null,
  maid_profile_id uuid not null,
  before_status public.payment_status not null,
  after_status public.payment_status not null,
  cycle_version bigint not null,
  locked_amount integer,
  payment_started_by uuid,
  payment_started_at timestamptz,
  paid_at timestamptz,
  check_reason text,
  last_reopen_reason text,
  last_reopened_by uuid,
  last_reopened_at timestamptz,
  payment_attempt_id uuid,
  recorded_at timestamptz not null default now(),
  constraint payroll_payment_projection_transitions_cycle_maid_fk
    foreign key(payroll_cycle_id,maid_profile_id)
    references public.payroll_cycles(id,maid_profile_id) on delete restrict,
  constraint payroll_payment_projection_transitions_attempt_fk
    foreign key(payment_attempt_id,payroll_cycle_id,maid_profile_id)
    references public.payroll_payment_attempts(id,payroll_cycle_id,maid_profile_id)
    on delete restrict deferrable initially deferred,
  constraint payroll_payment_projection_transitions_unique
    unique(payroll_cycle_id,cycle_version,before_status,after_status)
);

create function private.require_open_payroll_cycle_insert()
returns trigger language plpgsql set search_path='' as $$
begin
  if new.status<>'open' or new.version<>1 or new.locked_amount is not null
    or new.payment_started_by is not null or new.payment_started_at is not null
    or new.paid_at is not null or new.check_reason is not null
    or new.last_reopen_reason is not null or new.last_reopened_by is not null
    or new.last_reopened_at is not null then
    raise exception using errcode='23514',message='PAYROLL_PAYMENT_EVIDENCE_REQUIRED';
  end if;
  return new;
end $$;
revoke all on function private.require_open_payroll_cycle_insert()
from public,anon,authenticated,service_role;
create trigger payroll_cycles_require_open_insert before insert on public.payroll_cycles
for each row execute function private.require_open_payroll_cycle_insert();

create function private.capture_payroll_payment_projection_transition()
returns trigger language plpgsql set search_path='' as $$
declare v_attempt_id uuid;
begin
  if new.status is not distinct from old.status then return new; end if;
  if not (
    (old.status='open' and new.status='paying')
    or (old.status='paying' and new.status in ('check','paid','open'))
    or (old.status='check' and new.status in ('paid','open'))
  ) then return new; end if;
  if not (old.status='open' and new.status='paying') then
    select attempt.id into v_attempt_id from public.payroll_payment_attempts attempt
    where attempt.payroll_cycle_id=new.id order by attempt.attempt_number desc limit 1;
  end if;
  insert into private.payroll_payment_projection_transitions(
    payroll_cycle_id,maid_profile_id,before_status,after_status,cycle_version,locked_amount,
    payment_started_by,payment_started_at,paid_at,check_reason,last_reopen_reason,
    last_reopened_by,last_reopened_at,payment_attempt_id)
  values(new.id,new.maid_profile_id,old.status,new.status,new.version,new.locked_amount,
    new.payment_started_by,new.payment_started_at,new.paid_at,new.check_reason,
    new.last_reopen_reason,new.last_reopened_by,new.last_reopened_at,v_attempt_id);
  return new;
end $$;
revoke all on function private.capture_payroll_payment_projection_transition()
from public,anon,authenticated,service_role;
create trigger payroll_cycles_capture_payment_projection
after update on public.payroll_cycles for each row
execute function private.capture_payroll_payment_projection_transition();

create function private.assert_payroll_payment_projection_evidence(p_transition_id bigint)
returns void language plpgsql security definer set search_path='' as $$
declare v_transition private.payroll_payment_projection_transitions; v_count integer;
begin
  select * into v_transition from private.payroll_payment_projection_transitions
  where id=p_transition_id;
  if v_transition.id is null then
    raise exception using errcode='23514',message='PAYROLL_PAYMENT_EVIDENCE_REQUIRED';
  end if;
  if v_transition.before_status='open' and v_transition.after_status='paying' then
    select count(*) into v_count from public.payroll_events event
    where event.payroll_cycle_id=v_transition.payroll_cycle_id
      and event.maid_profile_id=v_transition.maid_profile_id
      and event.event_type='payment_started' and event.before_status='open'
      and event.after_status='paying' and event.cycle_version=v_transition.cycle_version
      and event.locked_amount=v_transition.locked_amount
      and event.actor_profile_id=v_transition.payment_started_by
      and event.occurred_at=v_transition.payment_started_at;
    if v_count<>1 then
      raise exception using errcode='23514',message='PAYROLL_PAYMENT_EVIDENCE_REQUIRED'; end if;
    select count(*) into v_count from public.payroll_payment_attempts attempt
    join public.payroll_events event on event.id=attempt.start_event_id
    where attempt.payroll_cycle_id=v_transition.payroll_cycle_id
      and attempt.maid_profile_id=v_transition.maid_profile_id
      and attempt.start_cycle_version=v_transition.cycle_version
      and attempt.locked_amount=v_transition.locked_amount
      and attempt.started_by=v_transition.payment_started_by
      and attempt.started_at=v_transition.payment_started_at;
    if v_count<>1 then
      raise exception using errcode='23514',message='PAYROLL_PAYMENT_EVIDENCE_REQUIRED'; end if;
  else
    if v_transition.payment_attempt_id is null then
      raise exception using errcode='23514',message='PAYROLL_PAYMENT_EVIDENCE_REQUIRED'; end if;
    select count(*) into v_count from public.payroll_payment_results result
    where result.payment_attempt_id=v_transition.payment_attempt_id
      and result.payroll_cycle_id=v_transition.payroll_cycle_id
      and result.maid_profile_id=v_transition.maid_profile_id
      and result.before_status=v_transition.before_status
      and result.after_status=v_transition.after_status
      and result.cycle_version=v_transition.cycle_version
      and result.locked_amount=coalesce(v_transition.locked_amount,result.locked_amount)
      and (
        (v_transition.after_status='check' and result.result_type='check'
          and result.reason_code='TRANSFER_RESULT_UNCERTAIN'
          and v_transition.check_reason='TRANSFER_RESULT_UNCERTAIN')
        or (v_transition.after_status='paid' and result.result_type='paid'
          and result.payment_method='bank_transfer' and result.canonical_reference is not null
          and result.occurred_at=v_transition.paid_at)
        or (v_transition.after_status='open' and result.result_type='reopened'
          and result.reason_code='NO_TRANSFER_CONFIRMED'
          and result.actor_profile_id=v_transition.last_reopened_by
          and result.occurred_at=v_transition.last_reopened_at
          and v_transition.last_reopen_reason='NO_TRANSFER_CONFIRMED')
      );
    if v_count<>1 then
      raise exception using errcode='23514',message='PAYROLL_PAYMENT_EVIDENCE_REQUIRED'; end if;
  end if;
end $$;
revoke all on function private.assert_payroll_payment_projection_evidence(bigint)
from public,anon,authenticated,service_role;

create function private.validate_payroll_payment_projection_transition()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  perform private.assert_payroll_payment_projection_evidence(new.id);
  return null;
end $$;
revoke all on function private.validate_payroll_payment_projection_transition()
from public,anon,authenticated,service_role;
create constraint trigger payroll_payment_projection_requires_evidence
after insert on private.payroll_payment_projection_transitions
deferrable initially deferred for each row
execute function private.validate_payroll_payment_projection_transition();

create function private.validate_payroll_payment_attempt_transition()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_transition_id bigint;
begin
  select transition.id into v_transition_id
  from private.payroll_payment_projection_transitions transition
  where transition.payroll_cycle_id=new.payroll_cycle_id
    and transition.maid_profile_id=new.maid_profile_id
    and transition.before_status='open' and transition.after_status='paying'
    and transition.cycle_version=new.start_cycle_version
    and transition.locked_amount=new.locked_amount
    and transition.payment_started_by=new.started_by
    and transition.payment_started_at=new.started_at;
  if v_transition_id is null then
    raise exception using errcode='23514',message='PAYROLL_PAYMENT_EVIDENCE_REQUIRED'; end if;
  perform private.assert_payroll_payment_projection_evidence(v_transition_id);
  return null;
end $$;
revoke all on function private.validate_payroll_payment_attempt_transition()
from public,anon,authenticated,service_role;
create constraint trigger payroll_payment_attempt_requires_transition
after insert on public.payroll_payment_attempts
deferrable initially deferred for each row
execute function private.validate_payroll_payment_attempt_transition();

create function private.validate_payroll_payment_result_transition()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_transition_id bigint;
begin
  select transition.id into v_transition_id
  from private.payroll_payment_projection_transitions transition
  where transition.payroll_cycle_id=new.payroll_cycle_id
    and transition.maid_profile_id=new.maid_profile_id
    and transition.payment_attempt_id=new.payment_attempt_id
    and transition.before_status=new.before_status
    and transition.after_status=new.after_status
    and transition.cycle_version=new.cycle_version;
  if v_transition_id is null then
    raise exception using errcode='23514',message='PAYROLL_PAYMENT_EVIDENCE_REQUIRED'; end if;
  perform private.assert_payroll_payment_projection_evidence(v_transition_id);
  return null;
end $$;
revoke all on function private.validate_payroll_payment_result_transition()
from public,anon,authenticated,service_role;
create constraint trigger payroll_payment_result_requires_transition
after insert on public.payroll_payment_results
deferrable initially deferred for each row
execute function private.validate_payroll_payment_result_transition();

create trigger payroll_payment_projection_transitions_append_only
before update or delete on private.payroll_payment_projection_transitions for each row
execute function private.prevent_payroll_payment_evidence_mutation();
revoke all privileges on private.payroll_payment_projection_transitions
from public,anon,authenticated,service_role;

create function private.assert_payment_reference(p_reference text)
returns text language plpgsql immutable set search_path='' as $$
declare v_value text;
begin
  if p_reference is null or char_length(p_reference) not between 8 and 64
    or p_reference collate "C" !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$'
    or p_reference collate "C" !~ '[A-Za-z]'
    or p_reference collate "C" !~ '[0-9]'
    or p_reference collate "C" ~ '[0-9]{7}'
    or lower(p_reference) like '%http%'
    or lower(p_reference) like 'www.%' then
    raise exception using errcode='22023',message='PAYROLL_PAYMENT_REFERENCE_INVALID';
  end if;
  v_value:=upper(p_reference);
  return v_value;
end $$;
revoke all on function private.assert_payment_reference(text)
from public,anon,authenticated,service_role;

create function private.payment_result_projection(p_result public.payroll_payment_results)
returns jsonb language sql stable set search_path='' as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'paymentResultId',p_result.id,'paymentAttemptId',p_result.payment_attempt_id,
    'payrollCycleId',p_result.payroll_cycle_id,'resultType',p_result.result_type,
    'beforeStatus',p_result.before_status,'afterStatus',p_result.after_status,
    'cycleVersion',p_result.cycle_version,'lockedAmount',p_result.locked_amount,
    'paymentMethod',p_result.payment_method,'providerReferenceId',p_result.canonical_reference,
    'reasonCode',p_result.reason_code,'occurredAt',p_result.occurred_at))
$$;
revoke all on function private.payment_result_projection(public.payroll_payment_results)
from public,anon,authenticated,service_role;

create function private.current_payment_attempt_fields(p_cycle_id uuid)
returns jsonb language sql stable set search_path='' as $$
  select coalesce((select jsonb_build_object(
    'paymentAttemptId',attempt.id,'paymentAttemptNumber',attempt.attempt_number,
    'paidAt',cycle.paid_at,
    -- Version 39 allowed free-form operational reasons. Preserve those rows in
    -- PostgreSQL, but never expose their raw text through the v40 API contract.
    'checkReasonCode',case when cycle.check_reason is null then null
      else 'TRANSFER_RESULT_UNCERTAIN' end,
    'lastReopenReasonCode',case when cycle.last_reopen_reason is null then null
      else 'NO_TRANSFER_CONFIRMED' end)
  from public.payroll_cycles cycle left join lateral(
    select a.* from public.payroll_payment_attempts a where a.payroll_cycle_id=cycle.id
    order by a.attempt_number desc limit 1) attempt on true
  where cycle.id=p_cycle_id),'{}'::jsonb)
$$;
revoke all on function private.current_payment_attempt_fields(uuid)
from public,anon,authenticated,service_role;

alter function private.project_payroll_cycle_bounded(date,uuid,integer)
rename to project_payroll_cycle_bounded_before_payment_results;
revoke all on function private.project_payroll_cycle_bounded_before_payment_results(date,uuid,integer)
from public,anon,authenticated,service_role;
create function private.project_payroll_cycle_bounded(p_week_start date,p_maid_profile_id uuid,p_nested_limit integer)
returns jsonb language sql stable set search_path='' as $$
  with projected as (
    select private.project_payroll_cycle_bounded_before_payment_results(
      p_week_start,p_maid_profile_id,p_nested_limit) value
  )
  select projected.value || case when projected.value->>'cycleId' is null then jsonb_build_object(
    'paymentAttemptId',null,'paymentAttemptNumber',null,'paidAt',null,
    'checkReasonCode',null,'lastReopenReasonCode',null)
  else private.current_payment_attempt_fields((projected.value->>'cycleId')::uuid) end
  from projected
$$;
revoke all on function private.project_payroll_cycle_bounded(date,uuid,integer)
from public,anon,authenticated,service_role;

create function private.assert_current_payment_attempt(p_attempt_id uuid)
returns public.payroll_payment_attempts language plpgsql stable set search_path='' as $$
declare v_attempt public.payroll_payment_attempts;
begin
  select * into v_attempt from public.payroll_payment_attempts where id=p_attempt_id;
  if v_attempt.id is null then
    raise exception using errcode='P0002',message='PAYROLL_PAYMENT_ATTEMPT_NOT_FOUND';
  end if;
  if exists(select 1 from public.payroll_payment_attempts newer
    where newer.payroll_cycle_id=v_attempt.payroll_cycle_id and newer.attempt_number>v_attempt.attempt_number)
    or exists(select 1 from public.payroll_payment_results terminal
      where terminal.payment_attempt_id=v_attempt.id and terminal.result_type in ('paid','reopened')) then
    raise exception using errcode='55000',message='PAYROLL_PAYMENT_ATTEMPT_TERMINAL';
  end if;
  return v_attempt;
end $$;
revoke all on function private.assert_current_payment_attempt(uuid)
from public,anon,authenticated,service_role;

create function private.guard_payroll_payment_cycle_transition()
returns trigger language plpgsql set search_path='' as $$
begin
  -- Legacy v39 reason text is immutable history. It may survive an unrelated
  -- UPDATE, but every v40 reason change and every new status transition must
  -- use the source-controlled code (or clear the field when leaving CHECK).
  if new.check_reason is distinct from old.check_reason
    or new.status is distinct from old.status then
    if new.status='check'
      and new.check_reason is distinct from 'TRANSFER_RESULT_UNCERTAIN' then
      raise exception using errcode='23514',message='PAYROLL_PAYMENT_REASON_INVALID';
    end if;
    if new.status<>'check' and new.check_reason is not null and not (
      old.status='check' and new.status='paid'
      and old.check_reason is not null
      and old.check_reason<>'TRANSFER_RESULT_UNCERTAIN'
      and new.check_reason is not distinct from old.check_reason
    ) then
      raise exception using errcode='23514',message='PAYROLL_PAYMENT_REASON_INVALID';
    end if;
  end if;
  if new.last_reopen_reason is distinct from old.last_reopen_reason
    and new.last_reopen_reason is not null
    and new.last_reopen_reason<>'NO_TRANSFER_CONFIRMED' then
    raise exception using errcode='23514',message='PAYROLL_PAYMENT_REOPEN_REASON_INVALID';
  end if;
  if new.status is distinct from old.status and not (
    (old.status='open' and new.status='paying')
    or (old.status='paying' and new.status in ('check','paid','open'))
    or (old.status='check' and new.status in ('paid','open'))
  ) then
    raise exception using errcode='55000',message='PAYROLL_PAYMENT_TRANSITION_INVALID';
  end if;
  return new;
end $$;
revoke all on function private.guard_payroll_payment_cycle_transition()
from public,anon,authenticated,service_role;
create trigger payroll_cycles_validate_payment_transition before update on public.payroll_cycles
for each row execute function private.guard_payroll_payment_cycle_transition();

-- Preserve the #31/#101 inspection behavior while fixing its lock order. The
-- actor row must not be locked before the global payroll/inspection fence.
create or replace function private.finalize_submission_inspection(
  p_actor_profile_id uuid,p_submission_id uuid,p_decision text,p_reason_code text,
  p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.profiles; s public.cleaning_submissions; a public.cleaning_attempts; t public.cleaning_targets;
  bseal private.bomb_room_report_seals; bdecision private.bomb_room_decisions; replay jsonb; result jsonb;
  reclean_template public.cleaning_template_versions; reclean_template_count integer; reclean_due_at timestamptz;
  reclean_sequence integer; checkout_obligation_id uuid; decision_id uuid; reclean_id uuid;
  reclean_assignment_id uuid; earning_id uuid; notice_id uuid; at_time timestamptz:=clock_timestamp();
begin
  replay:=private.replay_command(p_actor_profile_id,'inspection.'||p_decision,p_idempotency_key,p_request_hash);
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  p:=private.assert_submission_admin(p_actor_profile_id);
  if replay is not null then return replay; end if;
  s:=private.assert_current_submission(p_submission_id);
  select * into a from public.cleaning_attempts where id=s.cleaning_attempt_id for update;
  select * into t from public.cleaning_targets where id=a.cleaning_target_id for update;
  if not private.inspection_reason_valid(p_decision,p_reason_code)
    or a.status<>'submitted' or t.status<>'inspection_pending' then
    raise exception using errcode='55000',message='INSPECTION_INVALID_TRANSITION'; end if;
  select * into bseal from private.bomb_room_report_seals where submission_id=s.id;
  if bseal.report_id is not null then
    select * into bdecision from private.bomb_room_decisions where submission_id=s.id;
    if bdecision.id is null then raise exception using errcode='55000',message='BOMB_DECISION_REQUIRED'; end if;
  end if;
  if t.source='post_approval_complaint_reclean' and bseal.report_id is not null then
    raise exception using errcode='55000',message='BOMB_REPORT_NOT_ALLOWED'; end if;
  if p_decision='rejected' and t.source<>'post_approval_complaint_reclean' then
    if not exists(select 1 from public.profiles maid where maid.id=a.maid_profile_id
      and maid.role='maid' and maid.status='active') then
      raise exception using errcode='55000',message='RECLEAN_ORIGINAL_MAID_UNAVAILABLE';
    end if;
    select count(*) into reclean_template_count from public.cleaning_template_versions template
      join public.room_types room_type on room_type.id=template.room_type_id
      where room_type.code=t.room_type_snapshot->>'code' and template.cleaning_kind='reclean'
        and template.status='published';
    if reclean_template_count<>1 then
      raise exception using errcode='23514',message='RECLEAN_TEMPLATE_NOT_CONFIGURED'; end if;
    select template.* into reclean_template from public.cleaning_template_versions template
      join public.room_types room_type on room_type.id=template.room_type_id
      where room_type.code=t.room_type_snapshot->>'code' and template.cleaning_kind='reclean'
        and template.status='published';
    select min(reservation.check_in_at-interval '30 minutes') into reclean_due_at
      from public.reservations reservation where reservation.room_id=t.room_id
        and reservation.status='active' and reservation.check_in_at>at_time;
    if reclean_due_at is not null and reclean_due_at<=at_time then
      raise exception using errcode='55000',message='RECLEAN_WINDOW_NOT_AVAILABLE'; end if;
    select coalesce(max(assignment.sequence_number),0)+1 into reclean_sequence
      from public.cleaning_assignments assignment
      join public.cleaning_targets target on target.id=assignment.cleaning_target_id
      where assignment.maid_profile_id=a.maid_profile_id and assignment.is_current
        and target.effective_service_date=(at_time at time zone 'Asia/Seoul')::date;
  end if;
  insert into public.inspection_decisions(submission_id,decision,reason_code,reason_detail,
    bomb_room_decision,decided_by,decided_at)
  values(s.id,p_decision,p_reason_code,null,bdecision.decision,p.id,at_time)
  returning id into decision_id;
  update public.cleaning_submissions set status=p_decision::public.submission_status where id=s.id;
  update public.cleaning_attempts set status=p_decision::public.attempt_status where id=a.id;
  update public.cleaning_targets set status=p_decision::public.cleaning_target_status where id=t.id;
  if p_decision='approved' then
    with recursive ancestry(target_id,depth) as (
      select t.id,0 union all
      select origin_attempt.cleaning_target_id,ancestry.depth+1 from ancestry
        join public.cleaning_targets child on child.id=ancestry.target_id and child.source='inspection_reclean'
        join public.cleaning_attempts origin_attempt on origin_attempt.id=child.reclean_of_attempt_id
      where ancestry.depth<32
    ) select target.checkout_obligation_id into checkout_obligation_id from ancestry
      join public.cleaning_targets target on target.id=ancestry.target_id
      where target.checkout_obligation_id is not null order by ancestry.depth desc limit 1;
    if checkout_obligation_id is not null then
      update public.checkout_cleaning_obligations set status='completed',completion_submission_id=s.id,
        version=version+1 where id=checkout_obligation_id;
    end if;
    update public.preparation_obligations obligation set status='approved',current_attempt_id=a.id,
      approved_submission_id=s.id,invalidated_reason_code=null,version=version+1
    where obligation.id=(select candidate.id from public.preparation_obligations candidate
      join public.reservations r on r.id=candidate.reservation_id
      where candidate.room_id=t.room_id and candidate.status in ('pending','invalidated') and r.status='active'
        and r.check_in_at>=at_time and t.available_from is not null
        and t.available_from>=coalesce((select max(coalesce(previous.actual_checkout_at,previous.check_out_at))
          from public.reservations previous where previous.room_id=r.room_id and previous.id<>r.id
            and previous.status<>'cancelled' and previous.check_in_at<r.check_in_at),candidate.created_at)
        and a.started_at is not null and a.field_completed_at is not null and a.ended_at is not null
        and a.started_at>=t.available_from and a.field_completed_at>=a.started_at
        and a.ended_at>=a.field_completed_at and s.submitted_at>=a.ended_at
        and at_time>=s.submitted_at and at_time<=r.check_in_at order by r.check_in_at limit 1);
    if t.source not in ('inspection_reclean','post_approval_complaint_reclean') then
      insert into public.earnings(earning_entitlement_id,compensation_entitlement_id,submission_id,
        maid_profile_id,earned_on,base_amount,bomb_room_bonus,bomb_room_decision_id)
      values(s.id,null,s.id,a.maid_profile_id,(a.field_completed_at at time zone 'Asia/Seoul')::date,
        t.fee_snapshot,case when bdecision.decision='approved' then t.fee_snapshot else 0 end,
        case when bdecision.decision='approved' then bdecision.id end) returning id into earning_id;
    elsif t.source='post_approval_complaint_reclean' then
      earning_id:=private.create_compensation_entitlement_earning(
        t.complaint_compensation_decision_id,a.id,s.id,decision_id,at_time);
    end if;
  elsif t.source<>'post_approval_complaint_reclean' then
    reclean_id:=gen_random_uuid();
    insert into public.cleaning_targets(id,room_id,reservation_id,cleaning_kind,source,source_key,
      original_service_date,effective_service_date,carryover_count,available_from,due_at,status,
      assignment_version,room_type_snapshot,fee_snapshot,template_snapshot,created_by,
      reclean_of_attempt_id,reclean_maid_profile_id,reclean_of_submission_id,
      reclean_of_inspection_decision_id)
    values(reclean_id,t.room_id,null,'reclean','inspection_reclean','inspection-reclean:'||decision_id::text,
      (at_time at time zone 'Asia/Seoul')::date,(at_time at time zone 'Asia/Seoul')::date,0,at_time,
      reclean_due_at,'notified',1,t.room_type_snapshot,0,
      jsonb_build_object('id',reclean_template.id,'version',reclean_template.version,
        'durationMinutes',reclean_template.duration_minutes,'photoSlots',reclean_template.photo_slots),
      p.id,a.id,a.maid_profile_id,s.id,decision_id);
    insert into public.cleaning_target_schedule_revisions(cleaning_target_id,revision,effective_service_date,
      available_from,due_at,reason_code,changed_by)
    values(reclean_id,1,(at_time at time zone 'Asia/Seoul')::date,at_time,reclean_due_at,
      'INSPECTION_REJECTED',p.id);
    reclean_assignment_id:=gen_random_uuid();
    insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,
      is_current,notified_at,changed_by)
    values(reclean_assignment_id,reclean_id,a.maid_profile_id,reclean_sequence,1,true,at_time,p.id);
  end if;
  insert into public.notifications(recipient_profile_id,category,title,body,room_id,cleaning_target_id,
    dedupe_key,requires_action,occurred_at)
  values(a.maid_profile_id,'cleaning_inspection_'||p_decision,
    case when p_decision='approved' then '청소 검수 승인' else '청소 검수 반려' end,
    case when p_decision='approved' then '제출한 청소가 승인되었습니다.'
      when t.source='post_approval_complaint_reclean' then '컴플레인 재작업 제출이 반려되었습니다.'
      else '제출한 청소가 반려되어 재청소가 필요합니다.' end,
    t.room_id,case when p_decision='approved' or t.source='post_approval_complaint_reclean'
      then t.id else reclean_id end,'inspection:'||decision_id::text,
    p_decision='rejected' and t.source<>'post_approval_complaint_reclean',at_time)
  returning id into notice_id;
  insert into private.notification_outbox(notification_id,channel,delivery_status,next_attempt_at,created_at)
  values(notice_id,'web_push','pending',at_time,at_time);
  result:=jsonb_build_object('submissionId',s.id,'decisionId',decision_id,'decision',p_decision,
    'reasonCode',p_reason_code,'decidedAt',at_time,'earningId',earning_id,
    'recleanTargetId',reclean_id,'recleanAssignmentId',reclean_assignment_id);
  insert into public.audit_events(event_type,entity_type,entity_id,actor_profile_id,
    actor_display_name_snapshot,effective_at,reason_code,after_state,idempotency_key)
  values('inspection.'||p_decision,'inspection_decision',decision_id,p.id,p.display_name,at_time,p_reason_code,
    jsonb_build_object('submissionId',s.id,'attemptId',a.id,'cleaningTargetId',t.id,
      'maidProfileId',a.maid_profile_id,'decision',p_decision,'earningId',earning_id,
      'recleanTargetId',reclean_id,'earningProvenance',case when earning_id is null then null
        when t.source='post_approval_complaint_reclean' then 'compensation' else 'original' end),
    private.audit_command_key(p.id,'inspection.'||p_decision,p_idempotency_key));
  perform private.complete_command(p.id,'inspection.'||p_decision,p_idempotency_key,
    p_request_hash,decision_id,result);
  return result;
end $$;

create or replace function public.start_payroll_cycle(
  p_actor_profile_id uuid,p_maid_profile_id uuid,p_week_start date,p_expected_version bigint,
  p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor public.profiles; v_cycle public.payroll_cycles;
  v_replay jsonb; v_result jsonb; v_created boolean:=false; v_amounts record;
  v_event_id bigint; v_attempt public.payroll_payment_attempts; v_notification uuid;
  v_now timestamptz:=clock_timestamp();
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
  perform private.assert_no_prior_unhandled_late_earnings(p_maid_profile_id,p_week_start);
  perform private.claim_payroll_sources(v_cycle.id,p_maid_profile_id,p_week_start);
  select * into v_amounts from private.payroll_cycle_amounts(v_cycle.id);
  if v_amounts.payable_amount<=0 then
    raise exception using errcode='22023',message='PAYROLL_NONPOSITIVE_REQUIRES_CARRY'; end if;
  update public.payroll_cycles cycle set status='paying',locked_amount=v_amounts.payable_amount::integer,
    payment_started_by=v_actor.id,payment_started_at=v_now,paid_at=null,check_reason=null,
    version=case when v_created then 1 else cycle.version+1 end
  where cycle.id=v_cycle.id and cycle.status='open' and cycle.version=v_cycle.version returning * into v_cycle;
  if v_cycle.id is null then raise exception using errcode='40001',message='STALE_VERSION'; end if;
  insert into public.payroll_events(payroll_cycle_id,maid_profile_id,event_type,before_status,after_status,
    actor_profile_id,cycle_version,locked_amount,occurred_at)
  values(v_cycle.id,v_cycle.maid_profile_id,'payment_started','open','paying',v_actor.id,v_cycle.version,
    v_cycle.locked_amount,v_now) returning id into v_event_id;
  insert into public.payroll_payment_attempts(payroll_cycle_id,maid_profile_id,attempt_number,start_event_id,
    start_cycle_version,locked_amount,started_by,started_at)
  values(v_cycle.id,v_cycle.maid_profile_id,
    (select count(*)::integer+1 from public.payroll_payment_attempts a where a.payroll_cycle_id=v_cycle.id),
    v_event_id,v_cycle.version,v_cycle.locked_amount,v_actor.id,v_now) returning * into v_attempt;
  insert into public.audit_events(actor_profile_id,event_type,entity_type,entity_id,effective_at,after_state,
    idempotency_key) values(v_actor.id,'payroll.payment_started','payroll_cycle',v_cycle.id,v_now,
    jsonb_build_object('weekStart',v_cycle.week_start,'status',v_cycle.status,'version',v_cycle.version,
      'payrollEventId',v_event_id,'paymentAttemptNumber',v_attempt.attempt_number),
    private.audit_command_key(v_actor.id,'payroll.start',p_idempotency_key));
  insert into public.notifications(recipient_profile_id,category,title,body,dedupe_key,requires_action,occurred_at)
    values(v_cycle.maid_profile_id,'payroll_payment_started','주급 지급 처리 시작','종료된 주차의 주급 지급 처리가 시작되었습니다.',
      'payroll-start:'||v_cycle.id||':'||v_cycle.version,false,v_now) returning id into v_notification;
  insert into private.notification_outbox(notification_id,channel,delivery_status,next_attempt_at,created_at)
    values(v_notification,'web_push','pending',v_now,v_now);
  v_result:=private.project_payroll_cycle_bounded(p_week_start,p_maid_profile_id,10)
    ||private.current_payment_attempt_fields(v_cycle.id);
  perform private.complete_command(v_actor.id,'payroll.start',p_idempotency_key,p_request_hash,v_cycle.id,v_result);
  return v_result;
end $$;

create function public.record_payroll_payment_check(
  p_actor_profile_id uuid,p_payment_attempt_id uuid,p_expected_version bigint,p_reason_code text,
  p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor public.profiles; v_attempt public.payroll_payment_attempts; v_cycle public.payroll_cycles;
  v_result public.payroll_payment_results; v_replay jsonb; v_notification uuid;
  v_now timestamptz:=clock_timestamp();
begin
  v_replay:=private.replay_command(p_actor_profile_id,'payroll.payment.check',p_idempotency_key,p_request_hash);
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into v_actor from public.profiles where id=p_actor_profile_id and role='admin'
    and status='active' and not must_change_password for no key update;
  if v_actor.id is null then raise exception using errcode='42501',message='ADMIN_REQUIRED'; end if;
  if v_replay is not null then return v_replay; end if;
  if p_reason_code is distinct from 'TRANSFER_RESULT_UNCERTAIN' then
    raise exception using errcode='22023',message='PAYROLL_PAYMENT_REASON_INVALID'; end if;
  select * into v_attempt from private.assert_current_payment_attempt(p_payment_attempt_id);
  insert into public.payroll_adjustment_books(maid_profile_id) values(v_attempt.maid_profile_id) on conflict do nothing;
  perform 1 from public.payroll_adjustment_books where maid_profile_id=v_attempt.maid_profile_id for update;
  select * into v_cycle from public.payroll_cycles where id=v_attempt.payroll_cycle_id for update;
  select * into v_attempt from public.payroll_payment_attempts where id=p_payment_attempt_id for update;
  if v_cycle.status<>'paying' then raise exception using errcode='55000',message='PAYROLL_PAYMENT_TRANSITION_INVALID'; end if;
  if p_expected_version is null or v_cycle.version<>p_expected_version then
    raise exception using errcode='40001',message='STALE_VERSION'; end if;
  if v_cycle.locked_amount<>v_attempt.locked_amount then
    raise exception using errcode='23514',message='PAYROLL_PAYMENT_RESULT_AMOUNT_MISMATCH'; end if;
  update public.payroll_cycles set status='check',check_reason='TRANSFER_RESULT_UNCERTAIN',version=version+1,
    updated_at=v_now where id=v_cycle.id and version=v_cycle.version returning * into v_cycle;
  insert into public.payroll_payment_results(payment_attempt_id,payroll_cycle_id,maid_profile_id,result_type,
    before_status,after_status,cycle_version,locked_amount,reason_code,actor_profile_id,occurred_at)
  values(v_attempt.id,v_cycle.id,v_cycle.maid_profile_id,'check','paying','check',v_cycle.version,
    v_attempt.locked_amount,'TRANSFER_RESULT_UNCERTAIN',v_actor.id,v_now) returning * into v_result;
  insert into public.audit_events(actor_profile_id,event_type,entity_type,entity_id,effective_at,reason_code,
    after_state,idempotency_key) values(v_actor.id,'payroll.payment_check_recorded','payroll_payment_attempt',
    v_attempt.id,v_now,'TRANSFER_RESULT_UNCERTAIN',jsonb_build_object('status','check','version',v_cycle.version,
      'reasonCode','TRANSFER_RESULT_UNCERTAIN','paymentAttemptNumber',v_attempt.attempt_number),
    private.audit_command_key(v_actor.id,'payroll.payment.check',p_idempotency_key));
  insert into public.notifications(recipient_profile_id,category,title,body,dedupe_key,requires_action,occurred_at)
    values(v_cycle.maid_profile_id,'payroll_payment_check','주급 지급 결과 확인 중','외부 송금 결과를 확인하고 있습니다.',
      'payroll-check:'||v_attempt.id,false,v_now) returning id into v_notification;
  insert into private.notification_outbox(notification_id,channel,delivery_status,next_attempt_at,created_at)
    values(v_notification,'web_push','pending',v_now,v_now);
  v_replay:=private.payment_result_projection(v_result);
  perform private.complete_command(v_actor.id,'payroll.payment.check',p_idempotency_key,p_request_hash,v_result.id,v_replay);
  return v_replay;
end $$;

create function public.record_payroll_payment_paid(
  p_actor_profile_id uuid,p_payment_attempt_id uuid,p_expected_version bigint,p_payment_method text,
  p_canonical_reference text,p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor public.profiles; v_attempt public.payroll_payment_attempts; v_cycle public.payroll_cycles;
  v_result public.payroll_payment_results; v_replay jsonb; v_notification uuid; v_reference text;
  v_amounts record; v_before public.payment_status; v_now timestamptz:=clock_timestamp();
begin
  v_replay:=private.replay_command(p_actor_profile_id,'payroll.payment.paid',p_idempotency_key,p_request_hash);
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into v_actor from public.profiles where id=p_actor_profile_id and role='admin'
    and status='active' and not must_change_password for no key update;
  if v_actor.id is null then raise exception using errcode='42501',message='ADMIN_REQUIRED'; end if;
  if v_replay is not null then return v_replay; end if;
  if p_payment_method is distinct from 'bank_transfer' then
    raise exception using errcode='22023',message='PAYROLL_PAYMENT_METHOD_INVALID'; end if;
  v_reference:=private.assert_payment_reference(p_canonical_reference);
  if v_reference is distinct from p_canonical_reference then
    raise exception using errcode='22023',message='PAYROLL_PAYMENT_REFERENCE_INVALID'; end if;
  select * into v_attempt from private.assert_current_payment_attempt(p_payment_attempt_id);
  insert into public.payroll_adjustment_books(maid_profile_id) values(v_attempt.maid_profile_id) on conflict do nothing;
  perform 1 from public.payroll_adjustment_books where maid_profile_id=v_attempt.maid_profile_id for update;
  select * into v_cycle from public.payroll_cycles where id=v_attempt.payroll_cycle_id for update;
  select * into v_attempt from public.payroll_payment_attempts where id=p_payment_attempt_id for update;
  if v_cycle.status not in ('paying','check') then
    raise exception using errcode='55000',message='PAYROLL_PAYMENT_TRANSITION_INVALID'; end if;
  if p_expected_version is null or v_cycle.version<>p_expected_version then
    raise exception using errcode='40001',message='STALE_VERSION'; end if;
  select * into v_amounts from private.payroll_cycle_amounts(v_cycle.id);
  if v_cycle.locked_amount is null or v_cycle.locked_amount<=0
    or v_cycle.locked_amount<>v_attempt.locked_amount or v_amounts.payable_amount<>v_attempt.locked_amount then
    raise exception using errcode='23514',message='PAYROLL_PAYMENT_RESULT_AMOUNT_MISMATCH'; end if;
  v_before:=v_cycle.status;
  update public.payroll_cycles set status='paid',paid_at=v_now,
    check_reason=case
      when v_cycle.status='check'
        and v_cycle.check_reason is not null
        and v_cycle.check_reason<>'TRANSFER_RESULT_UNCERTAIN'
      then v_cycle.check_reason
      else null
    end,
    version=version+1,
    updated_at=v_now where id=v_cycle.id and version=v_cycle.version returning * into v_cycle;
  begin
    insert into public.payroll_payment_results(payment_attempt_id,payroll_cycle_id,maid_profile_id,result_type,
      before_status,after_status,cycle_version,locked_amount,payment_method,canonical_reference,
      actor_profile_id,occurred_at)
    values(v_attempt.id,v_cycle.id,v_cycle.maid_profile_id,'paid',v_before,'paid',v_cycle.version,
      v_attempt.locked_amount,'bank_transfer',v_reference,v_actor.id,v_now) returning * into v_result;
  exception when unique_violation then
    raise exception using errcode='23505',message='PAYROLL_PAYMENT_REFERENCE_ALREADY_USED';
  end;
  insert into public.audit_events(actor_profile_id,event_type,entity_type,entity_id,effective_at,after_state,
    idempotency_key) values(v_actor.id,'payroll.payment_paid','payroll_payment_attempt',v_attempt.id,v_now,
    jsonb_build_object('status','paid','version',v_cycle.version,'paymentMethod','bank_transfer',
      'paymentAttemptNumber',v_attempt.attempt_number),
    private.audit_command_key(v_actor.id,'payroll.payment.paid',p_idempotency_key));
  insert into public.notifications(recipient_profile_id,category,title,body,dedupe_key,requires_action,occurred_at)
    values(v_cycle.maid_profile_id,'payroll_payment_paid','주급 지급 완료','외부 송금 완료가 확인되었습니다.',
      'payroll-paid:'||v_attempt.id,false,v_now) returning id into v_notification;
  insert into private.notification_outbox(notification_id,channel,delivery_status,next_attempt_at,created_at)
    values(v_notification,'web_push','pending',v_now,v_now);
  v_replay:=private.payment_result_projection(v_result);
  perform private.complete_command(v_actor.id,'payroll.payment.paid',p_idempotency_key,p_request_hash,v_result.id,v_replay);
  return v_replay;
end $$;

create function public.reopen_payroll_payment_attempt(
  p_actor_profile_id uuid,p_payment_attempt_id uuid,p_expected_version bigint,p_reason_code text,
  p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor public.profiles; v_attempt public.payroll_payment_attempts; v_cycle public.payroll_cycles;
  v_result public.payroll_payment_results; v_replay jsonb; v_notification uuid;
  v_before public.payment_status; v_now timestamptz:=clock_timestamp();
begin
  v_replay:=private.replay_command(p_actor_profile_id,'payroll.payment.reopen',p_idempotency_key,p_request_hash);
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into v_actor from public.profiles where id=p_actor_profile_id and role='admin'
    and status='active' and not must_change_password for no key update;
  if v_actor.id is null then raise exception using errcode='42501',message='ADMIN_REQUIRED'; end if;
  if v_replay is not null then return v_replay; end if;
  if p_reason_code is distinct from 'NO_TRANSFER_CONFIRMED' then
    raise exception using errcode='22023',message='PAYROLL_PAYMENT_REOPEN_REASON_INVALID'; end if;
  select * into v_attempt from private.assert_current_payment_attempt(p_payment_attempt_id);
  insert into public.payroll_adjustment_books(maid_profile_id) values(v_attempt.maid_profile_id) on conflict do nothing;
  perform 1 from public.payroll_adjustment_books where maid_profile_id=v_attempt.maid_profile_id for update;
  select * into v_cycle from public.payroll_cycles where id=v_attempt.payroll_cycle_id for update;
  select * into v_attempt from public.payroll_payment_attempts where id=p_payment_attempt_id for update;
  if v_cycle.status not in ('paying','check') then
    raise exception using errcode='55000',message='PAYROLL_PAYMENT_TRANSITION_INVALID'; end if;
  if p_expected_version is null or v_cycle.version<>p_expected_version then
    raise exception using errcode='40001',message='STALE_VERSION'; end if;
  if v_cycle.locked_amount<>v_attempt.locked_amount then
    raise exception using errcode='23514',message='PAYROLL_PAYMENT_RESULT_AMOUNT_MISMATCH'; end if;
  v_before:=v_cycle.status;
  update public.payroll_cycles set status='open',locked_amount=null,payment_started_by=null,
    payment_started_at=null,paid_at=null,check_reason=null,last_reopen_reason='NO_TRANSFER_CONFIRMED',
    last_reopened_by=v_actor.id,last_reopened_at=v_now,version=version+1,updated_at=v_now
  where id=v_cycle.id and version=v_cycle.version returning * into v_cycle;
  insert into public.payroll_payment_results(payment_attempt_id,payroll_cycle_id,maid_profile_id,result_type,
    before_status,after_status,cycle_version,locked_amount,reason_code,actor_profile_id,occurred_at)
  values(v_attempt.id,v_cycle.id,v_cycle.maid_profile_id,'reopened',v_before,'open',v_cycle.version,
    v_attempt.locked_amount,'NO_TRANSFER_CONFIRMED',v_actor.id,v_now) returning * into v_result;
  insert into public.audit_events(actor_profile_id,event_type,entity_type,entity_id,effective_at,reason_code,
    after_state,idempotency_key) values(v_actor.id,'payroll.payment_reopened','payroll_payment_attempt',
    v_attempt.id,v_now,'NO_TRANSFER_CONFIRMED',jsonb_build_object('status','open','version',v_cycle.version,
      'reasonCode','NO_TRANSFER_CONFIRMED','paymentAttemptNumber',v_attempt.attempt_number),
    private.audit_command_key(v_actor.id,'payroll.payment.reopen',p_idempotency_key));
  insert into public.notifications(recipient_profile_id,category,title,body,dedupe_key,requires_action,occurred_at)
    values(v_cycle.maid_profile_id,'payroll_payment_reopened','주급 지급 재확인','외부 송금 없음이 확인되어 지급 처리가 다시 열렸습니다.',
      'payroll-reopen:'||v_attempt.id,false,v_now) returning id into v_notification;
  insert into private.notification_outbox(notification_id,channel,delivery_status,next_attempt_at,created_at)
    values(v_notification,'web_push','pending',v_now,v_now);
  v_replay:=private.payment_result_projection(v_result);
  perform private.complete_command(v_actor.id,'payroll.payment.reopen',p_idempotency_key,p_request_hash,v_result.id,v_replay);
  return v_replay;
end $$;

create function private.payment_evidence_rls_admin()
returns boolean language sql stable security definer set search_path=pg_catalog,public,private as $$
  select private.payroll_rls_session_is_active() and exists(
    select 1 from public.profiles actor where actor.auth_user_id=(select auth.uid())
      and actor.role='admin' and actor.status='active' and not actor.must_change_password)
$$;
revoke all on function private.payment_evidence_rls_admin()
from public,anon,authenticated,service_role;
grant execute on function private.payment_evidence_rls_admin() to authenticated;

create policy payroll_payment_attempts_admin_read
on public.payroll_payment_attempts for select to authenticated
using ((select private.payment_evidence_rls_admin()));
create policy payroll_payment_results_admin_read
on public.payroll_payment_results for select to authenticated
using ((select private.payment_evidence_rls_admin()));

-- Extend the developer audit allowlist with safe result summaries only. The
-- transfer reference, amount, maid identity, raw state and request hash remain
-- unavailable through this projection.
alter function public.list_developer_audit_events(
  uuid,text[],uuid,timestamptz,timestamptz,timestamptz,uuid,integer
) set schema private;
alter function private.list_developer_audit_events(
  uuid,text[],uuid,timestamptz,timestamptz,timestamptz,uuid,integer
) rename to list_developer_audit_events_before_payment_results;
revoke all on function private.list_developer_audit_events_before_payment_results(
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
      'payroll.payment_check_recorded','payroll.payment_paid','payroll.payment_reopened');
    if cardinality(v_previous_types)=0 then v_previous_types:=array['account.created']; end if;
  end if;
  return query select merged.* from (
    select previous.* from private.list_developer_audit_events_before_payment_results(
      p_actor_profile_id,v_previous_types,p_filter_actor_profile_id,p_from,p_to,
      p_before_recorded_at,p_before_id,p_limit) previous
    where p_event_types is null or previous.event_type=any(p_event_types)
    union all
    select audit.id,audit.event_type,audit.entity_type,audit.entity_id,audit.actor_profile_id,
      audit.actor_display_name_snapshot,audit.effective_at,audit.recorded_at,audit.reason_code,
      jsonb_strip_nulls(jsonb_build_object(
        'status',audit.after_state->'status','version',audit.after_state->'version',
        'reasonCode',audit.after_state->'reasonCode','paymentMethod',audit.after_state->'paymentMethod',
        'paymentAttemptNumber',audit.after_state->'paymentAttemptNumber'))
    from public.audit_events audit
    where audit.event_type in ('payroll.payment_check_recorded','payroll.payment_paid','payroll.payment_reopened')
      and (p_event_types is null or audit.event_type=any(p_event_types))
      and audit.recorded_at>=v_from and audit.recorded_at<=v_to
      and (p_filter_actor_profile_id is null or audit.actor_profile_id=p_filter_actor_profile_id)
      and (p_before_recorded_at is null or (audit.recorded_at,audit.id)<(p_before_recorded_at,p_before_id))
    order by recorded_at desc,id desc limit p_limit
  ) merged order by merged.recorded_at desc,merged.id desc limit p_limit;
end $$;

comment on table public.payroll_payment_attempts is
'#103 immutable external-payment attempts derived from payment_started events; no provider call is made.';
comment on table public.payroll_payment_results is
'#103 immutable admin attestations. Paid amount is the server-locked full KRW snapshot; canonical bank reference is admin-only.';
comment on column public.payroll_payment_results.canonical_reference is
'Fail-closed provisional bank reference: uppercase ASCII letter+digit, 8..64, no seven consecutive digits. Expand only by a future migration after provider formats are confirmed.';

revoke all privileges on public.payroll_payment_attempts,public.payroll_payment_results
from public,anon,authenticated,service_role;
grant select on public.payroll_payment_attempts,public.payroll_payment_results to authenticated;

-- v39 exposed free-form operational reasons on the raw table. Keep the safe
-- payroll columns and row-level admin/self scope, but remove both reason
-- columns from authenticated Data API privileges. Table SELECT must be revoked
-- before column grants because it otherwise overrides column-level revocation.
revoke select on public.payroll_cycles from authenticated;
revoke select(check_reason,last_reopen_reason) on public.payroll_cycles from authenticated;
grant select(
  id,maid_profile_id,week_start,status,locked_amount,payment_started_by,
  payment_started_at,paid_at,version,created_at,updated_at,last_reopened_by,
  last_reopened_at,offset_settled_at,offset_settled_by
) on public.payroll_cycles to authenticated;

revoke all on function public.record_payroll_payment_check(uuid,uuid,bigint,text,text,text),
  public.record_payroll_payment_paid(uuid,uuid,bigint,text,text,text,text),
  public.reopen_payroll_payment_attempt(uuid,uuid,bigint,text,text,text),
  public.start_payroll_cycle(uuid,uuid,date,bigint,text,text),
  public.list_developer_audit_events(uuid,text[],uuid,timestamptz,timestamptz,timestamptz,uuid,integer)
from public,anon,authenticated,service_role;
grant execute on function public.record_payroll_payment_check(uuid,uuid,bigint,text,text,text),
  public.record_payroll_payment_paid(uuid,uuid,bigint,text,text,text,text),
  public.reopen_payroll_payment_attempt(uuid,uuid,bigint,text,text,text),
  public.start_payroll_cycle(uuid,uuid,date,bigint,text,text),
  public.list_developer_audit_events(uuid,text[],uuid,timestamptz,timestamptz,timestamptz,uuid,integer)
to service_role;
