\set ON_ERROR_STOP on

create function pg_temp.upgrade_pid(n integer) returns uuid language sql immutable as $$
  select ('14000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;

do $$
declare v_projection jsonb; v_attempt uuid;
begin
  -- Applying v40 must not rewrite or infer any historical reason text.
  if (select last_reopen_reason from public.payroll_cycles where id=pg_temp.upgrade_pid(7001))
      <> 'LEGACY_OPERATOR_CONFIRMED_NO_TRANSFER'
    or (select check_reason from public.payroll_cycles where id=pg_temp.upgrade_pid(7002))
      <> 'LEGACY_BANK_STATUS_PENDING'
    or (select check_reason from public.payroll_cycles where id=pg_temp.upgrade_pid(7003))
      <> 'LEGACY_MANUAL_CHECK'
    or (select check_reason from public.payroll_cycles where id=pg_temp.upgrade_pid(7004))
      <> 'LEGACY_PAID_REVIEW'
    or (select check_reason from public.payroll_cycles where id=pg_temp.upgrade_pid(7005))
      <> 'LEGACY_PAID_MANUAL'
    or (select check_reason from public.payroll_cycles where id=pg_temp.upgrade_pid(7006))
      <> 'TRANSFER_RESULT_UNCERTAIN' then
    raise exception 'UPGRADE_V40_REWROTE_LEGACY_REASON';
  end if;

  if (select count(*) from public.payroll_payment_attempts)<>3
    or not exists(select 1 from public.payroll_payment_attempts where payroll_cycle_id=pg_temp.upgrade_pid(7002))
    or not exists(select 1 from public.payroll_payment_attempts where payroll_cycle_id=pg_temp.upgrade_pid(7004))
    or not exists(select 1 from public.payroll_payment_attempts where payroll_cycle_id=pg_temp.upgrade_pid(7006))
    or exists(select 1 from public.payroll_payment_attempts where payroll_cycle_id in(
      pg_temp.upgrade_pid(7003),pg_temp.upgrade_pid(7005))) then
    raise exception 'UPGRADE_V40_ATTEMPT_BACKFILL_NOT_EVIDENCE_SCOPED';
  end if;

  v_projection:=private.project_payroll_cycle_bounded(date '2026-07-13',pg_temp.upgrade_pid(3),10);
  if v_projection->>'checkReasonCode'<>'TRANSFER_RESULT_UNCERTAIN'
    or v_projection::text like '%LEGACY_BANK_STATUS_PENDING%' then
    raise exception 'UPGRADE_V40_CHECK_PROJECTION_LEAKED_LEGACY_REASON';
  end if;
  v_projection:=private.project_payroll_cycle_bounded(date '2026-07-20',pg_temp.upgrade_pid(4),10);
  if v_projection->>'checkReasonCode'<>'TRANSFER_RESULT_UNCERTAIN'
    or v_projection::text like '%LEGACY_MANUAL_CHECK%' then
    raise exception 'UPGRADE_V40_NO_EVENT_CHECK_PROJECTION_INVALID';
  end if;
  v_projection:=private.project_payroll_cycle_bounded(date '2026-07-27',pg_temp.upgrade_pid(5),10);
  if v_projection->>'checkReasonCode'<>'TRANSFER_RESULT_UNCERTAIN'
    or v_projection::text like '%LEGACY_PAID_REVIEW%' then
    raise exception 'UPGRADE_V40_PAID_EVENT_PROJECTION_INVALID';
  end if;
  v_projection:=private.project_payroll_cycle_bounded(date '2026-08-03',pg_temp.upgrade_pid(6),10);
  if v_projection->>'checkReasonCode'<>'TRANSFER_RESULT_UNCERTAIN'
    or v_projection::text like '%LEGACY_PAID_MANUAL%' then
    raise exception 'UPGRADE_V40_PAID_NO_EVENT_PROJECTION_INVALID';
  end if;

  -- An unchanged legacy reason is allowed to survive ordinary projection
  -- maintenance, but changing it to another free-form value is forbidden.
  update public.payroll_cycles set updated_at=updated_at
  where id=pg_temp.upgrade_pid(7003);
  begin
    update public.payroll_cycles set check_reason='NEW_FREE_FORM_REASON'
    where id=pg_temp.upgrade_pid(7003);
    raise exception 'UPGRADE_V40_ACCEPTED_NEW_LEGACY_CHECK_REASON';
  exception when check_violation then
    if sqlerrm<>'PAYROLL_PAYMENT_REASON_INVALID' then raise; end if;
  end;

  begin
    insert into public.payroll_cycles(
      maid_profile_id,week_start,last_reopen_reason,last_reopened_by,last_reopened_at
    ) values(
      pg_temp.upgrade_pid(2),date '2026-06-29','NEW_FREE_FORM_REASON',
      pg_temp.upgrade_pid(1),clock_timestamp()
    );
    raise exception 'UPGRADE_V40_ACCEPTED_NEW_LEGACY_REOPEN_REASON';
  exception when check_violation then
    if sqlerrm<>'PAYROLL_PAYMENT_EVIDENCE_REQUIRED' then raise; end if;
  end;

  -- A legacy OPEN cycle can start a new v40 attempt without rewriting its
  -- historical reopen reason. The HTTP projection receives only the enum.
  perform public.start_payroll_cycle(
    pg_temp.upgrade_pid(1),pg_temp.upgrade_pid(2),date '2026-07-06',2,
    'upgrade-legacy-open-start',repeat('1',64)
  );
  if (select status from public.payroll_cycles where id=pg_temp.upgrade_pid(7001))<>'paying'
    or (select last_reopen_reason from public.payroll_cycles where id=pg_temp.upgrade_pid(7001))
      <> 'LEGACY_OPERATOR_CONFIRMED_NO_TRANSFER' then
    raise exception 'UPGRADE_V40_LEGACY_OPEN_RESTART_FAILED';
  end if;
  v_projection:=private.project_payroll_cycle_bounded(date '2026-07-06',pg_temp.upgrade_pid(2),10);
  if v_projection->>'lastReopenReasonCode'<>'NO_TRANSFER_CONFIRMED'
    or v_projection::text like '%LEGACY_OPERATOR_CONFIRMED_NO_TRANSFER%' then
    raise exception 'UPGRADE_V40_REOPEN_PROJECTION_LEAKED_LEGACY_REASON';
  end if;

  -- Historical CHECK can complete only when v39 payment_started evidence
  -- exists. No-event history remains readable without an invented attempt.
  select id into v_attempt from public.payroll_payment_attempts
  where payroll_cycle_id=pg_temp.upgrade_pid(7002);
  begin
    update public.payroll_cycles
    set status='paid',paid_at=clock_timestamp(),check_reason='NEW_FREE_FORM_REASON',version=version+1
    where id=pg_temp.upgrade_pid(7002);
    raise exception 'UPGRADE_V40_ACCEPTED_CHANGED_LEGACY_REASON_ON_PAID';
  exception when check_violation then
    if sqlerrm<>'PAYROLL_PAYMENT_REASON_INVALID' then raise; end if;
  end;
  perform public.record_payroll_payment_paid(
    pg_temp.upgrade_pid(1),v_attempt,2,'bank_transfer','UPGRADE-A12',
    'upgrade-legacy-check-paid',repeat('2',64)
  );
  if (select status from public.payroll_cycles where id=pg_temp.upgrade_pid(7002))<>'paid'
    or (select check_reason from public.payroll_cycles where id=pg_temp.upgrade_pid(7002))
      <> 'LEGACY_BANK_STATUS_PENDING'
    or (select count(*) from public.payroll_payment_results
      where payment_attempt_id=v_attempt and result_type='paid')<>1 then
    raise exception 'UPGRADE_V40_LEGACY_CHECK_PAID_REASON_NOT_PRESERVED';
  end if;
  v_projection:=private.project_payroll_cycle_bounded(date '2026-07-13',pg_temp.upgrade_pid(3),10);
  if v_projection->>'checkReasonCode'<>'TRANSFER_RESULT_UNCERTAIN'
    or v_projection::text like '%LEGACY_BANK_STATUS_PENDING%' then
    raise exception 'UPGRADE_V40_PAID_PROJECTION_LEAKED_LEGACY_REASON';
  end if;

  -- A v39 raw reason may happen to equal the v40 enum. The missing immutable
  -- typed CHECK result, not the string, still proves this row is legacy.
  select id into v_attempt from public.payroll_payment_attempts
  where payroll_cycle_id=pg_temp.upgrade_pid(7006);
  perform public.record_payroll_payment_paid(
    pg_temp.upgrade_pid(1),v_attempt,2,'bank_transfer','UPGRADE-B34',
    'upgrade-fixed-looking-legacy-paid',repeat('3',64)
  );
  if (select status from public.payroll_cycles where id=pg_temp.upgrade_pid(7006))<>'paid'
    or (select check_reason from public.payroll_cycles where id=pg_temp.upgrade_pid(7006))
      <> 'TRANSFER_RESULT_UNCERTAIN'
    or exists(select 1 from public.payroll_payment_results
      where payment_attempt_id=v_attempt and result_type='check') then
    raise exception 'UPGRADE_V40_FIXED_LOOKING_LEGACY_REASON_NOT_PRESERVED';
  end if;
  if exists(select 1 from public.payroll_payment_attempts where payroll_cycle_id=pg_temp.upgrade_pid(7003)) then
    raise exception 'UPGRADE_V40_INFERRED_NO_EVENT_ATTEMPT';
  end if;
end $$;
