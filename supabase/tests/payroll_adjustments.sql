begin;
select no_plan();

create function pg_temp.pid(n integer) returns uuid language sql immutable as $$
  select ('10200000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
create function pg_temp.week(n integer) returns date language sql stable as $$
  select date_trunc('week',clock_timestamp() at time zone 'Asia/Seoul')::date+n*7
$$;

insert into auth.users(id) select pg_temp.pid(100+n) from generate_series(1,11)n;
select public.bootstrap_first_developer_profile(pg_temp.pid(5),pg_temp.pid(105),'adjust-dev','adjust-dev',
  '0102',repeat('d',64),'adjust-dev-bootstrap');
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
  login_sequence,role,status,must_change_password) values
  (pg_temp.pid(1),pg_temp.pid(101),'adjust-admin','adjust-admin','adjust-admin','adjust-admin',0,'admin','active',false),
  (pg_temp.pid(2),pg_temp.pid(102),'adjust-maid','adjust-maid','adjust-maid','adjust-maid',0,'maid','active',false),
  (pg_temp.pid(3),pg_temp.pid(103),'adjust-other','adjust-other','adjust-other','adjust-other',0,'maid','active',false),
  (pg_temp.pid(4),pg_temp.pid(104),'adjust-temp','adjust-temp','adjust-temp','adjust-temp',0,'admin','active',true),
  (pg_temp.pid(6),pg_temp.pid(106),'late-paying','late-paying','late-paying','late-paying',0,'maid','active',false),
  (pg_temp.pid(7),pg_temp.pid(107),'late-check','late-check','late-check','late-check',0,'maid','active',false),
  (pg_temp.pid(8),pg_temp.pid(108),'late-paid','late-paid','late-paid','late-paid',0,'maid','active',false),
  (pg_temp.pid(9),pg_temp.pid(109),'late-offset','late-offset','late-offset','late-offset',0,'maid','active',false),
  (pg_temp.pid(10),pg_temp.pid(110),'normal-absent','normal-absent','normal-absent','normal-absent',0,'maid','active',false),
  (pg_temp.pid(11),pg_temp.pid(111),'normal-open','normal-open','normal-open','normal-open',0,'maid','active',false);
insert into auth.sessions(id,user_id) select pg_temp.pid(900+n),pg_temp.pid(100+n) from generate_series(1,5)n;

create function pg_temp.add_earning(n integer,p_maid integer,p_day date,p_amount integer)
returns uuid language plpgsql as $$
declare v_room public.rooms;v_target uuid:=pg_temp.pid(1000+n);v_assignment uuid:=pg_temp.pid(2000+n);
  v_attempt uuid:=pg_temp.pid(3000+n);v_submission uuid:=pg_temp.pid(4000+n);
  v_earning uuid:=pg_temp.pid(5000+n);v_at timestamptz:=(p_day::timestamp+time '12:00') at time zone 'Asia/Seoul';
begin
  select * into v_room from public.rooms order by room_number limit 1;
  insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,
    effective_service_date,available_from,due_at,status,assignment_version,room_type_snapshot,fee_snapshot,
    template_snapshot,created_by) values(v_target,v_room.id,'additional','manual_room_request','adjust-'||n,
    p_day,p_day,v_at-interval '2 hours',v_at+interval '2 hours','approved',1,
    jsonb_build_object('id',v_room.room_type_id),p_amount,'{}',pg_temp.pid(1));
  insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,service_date,sequence_number,
    revision,is_current,notified_at,changed_by) values(v_assignment,v_target,pg_temp.pid(p_maid),p_day,n+1,1,true,
    v_at-interval '2 hours',pg_temp.pid(1));
  insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,
    assignment_revision,started_at,field_completed_at,ended_at,template_snapshot,room_snapshot)
    values(v_attempt,v_target,v_assignment,pg_temp.pid(p_maid),1,'approved',1,v_at-interval '1 hour',v_at,v_at,'{}',
      jsonb_build_object('roomId',v_room.id));
  insert into public.cleaning_submissions(id,cleaning_attempt_id,client_submission_id,version,status,photo_manifest,
    submitted_by,submitted_at) values(v_submission,v_attempt,pg_temp.pid(6000+n),1,'approved','{}',pg_temp.pid(p_maid),v_at);
  insert into public.inspection_decisions(submission_id,decision,reason_code,decided_by,decided_at)
    values(v_submission,'approved','QUALITY_OK',pg_temp.pid(1),v_at);
  insert into public.earnings(id,earning_entitlement_id,submission_id,maid_profile_id,earned_on,base_amount,bomb_room_bonus)
    values(v_earning,v_submission,v_submission,pg_temp.pid(p_maid),p_day,p_amount,0);
  return v_earning;
end $$;

create function pg_temp.freeze_cycle(p_maid integer,p_week date,p_status public.payment_status,p_offset boolean)
returns uuid language plpgsql as $$
declare v_cycle uuid; v_attempt uuid;
begin
  if p_status='open' then
    insert into public.payroll_cycles(maid_profile_id,week_start)
    values(pg_temp.pid(p_maid),p_week) returning id into v_cycle;
    if p_offset then
      update public.payroll_cycles set offset_settled_at=clock_timestamp(),offset_settled_by=pg_temp.pid(1),
        version=version+1 where id=v_cycle;
    end if;
    return v_cycle;
  end if;

  perform pg_temp.add_earning(100+p_maid,p_maid,p_week+1,1);
  perform public.start_payroll_cycle(pg_temp.pid(1),pg_temp.pid(p_maid),p_week,0,
    'adjust-fixture-start-'||p_maid,repeat('a',64));
  select id into v_cycle from public.payroll_cycles
  where maid_profile_id=pg_temp.pid(p_maid) and week_start=p_week;
  select id into v_attempt from public.payroll_payment_attempts where payroll_cycle_id=v_cycle;
  if p_status='check' then
    perform public.record_payroll_payment_check(pg_temp.pid(1),v_attempt,
      (select version from public.payroll_cycles where id=v_cycle),'TRANSFER_RESULT_UNCERTAIN',
      'adjust-fixture-check-'||p_maid,repeat('b',64));
  elsif p_status='paid' then
    perform public.record_payroll_payment_paid(pg_temp.pid(1),v_attempt,
      (select version from public.payroll_cycles where id=v_cycle),'bank_transfer','HIST-'||p_maid||'-A1',
      'adjust-fixture-paid-'||p_maid,repeat('c',64));
  end if;
  return v_cycle;
end $$;

create function pg_temp.resolve_historical_cycle(p_maid integer,p_week date)
returns void language plpgsql as $$
declare v_cycle public.payroll_cycles; v_attempt uuid;
begin
  select * into v_cycle from public.payroll_cycles
  where maid_profile_id=pg_temp.pid(p_maid) and week_start=p_week;
  select id into v_attempt from public.payroll_payment_attempts where payroll_cycle_id=v_cycle.id;
  perform public.record_payroll_payment_paid(pg_temp.pid(1),v_attempt,v_cycle.version,'bank_transfer',
    'RESOLVE-'||p_maid||'-A1','adjust-fixture-resolve-'||p_maid,repeat('d',64));
end $$;

create function pg_temp.invalid_carry_pair(p_kind text,p_n integer)
returns void language plpgsql as $$
declare v_cycle uuid:=gen_random_uuid();v_cycle_two uuid:=gen_random_uuid();
  v_settlement uuid:=gen_random_uuid();v_settlement_two uuid:=gen_random_uuid();
  v_carry uuid:=gen_random_uuid();v_carry_two uuid:=gen_random_uuid();v_week date:=pg_temp.week(-20-p_n);
begin
  insert into public.payroll_cycles(id,maid_profile_id,week_start) values(v_cycle,pg_temp.pid(3),v_week);
  if p_kind='missing_carry' then
    insert into public.payroll_offset_settlements(id,payroll_cycle_id,maid_profile_id,week_start,cycle_version,
      earning_amount,adjustment_amount,carry_in_amount,net_amount,carry_out_id,settled_by,settled_at)
    values(v_settlement,v_cycle,pg_temp.pid(3),v_week,1,0,-100,0,-100,v_carry,pg_temp.pid(1),clock_timestamp());
  elsif p_kind='one_sided_carry' then
    insert into public.payroll_offset_settlements(id,payroll_cycle_id,maid_profile_id,week_start,cycle_version,
      earning_amount,adjustment_amount,carry_in_amount,net_amount,carry_out_id,settled_by,settled_at)
    values(v_settlement,v_cycle,pg_temp.pid(3),v_week,1,0,0,0,0,null,pg_temp.pid(1),clock_timestamp());
    insert into public.payroll_residual_carries(id,maid_profile_id,source_settlement_id,available_week_start,amount)
    values(v_carry,pg_temp.pid(3),v_settlement,v_week+7,100);
  elsif p_kind in ('wrong_amount','wrong_week') then
    insert into public.payroll_offset_settlements(id,payroll_cycle_id,maid_profile_id,week_start,cycle_version,
      earning_amount,adjustment_amount,carry_in_amount,net_amount,carry_out_id,settled_by,settled_at)
    values(v_settlement,v_cycle,pg_temp.pid(3),v_week,1,0,-100,0,-100,v_carry,pg_temp.pid(1),clock_timestamp());
    insert into public.payroll_residual_carries(id,maid_profile_id,source_settlement_id,available_week_start,amount)
    values(v_carry,pg_temp.pid(3),v_settlement,
      case when p_kind='wrong_week' then v_week+14 else v_week+7 end,
      case when p_kind='wrong_amount' then 99 else 100 end);
  elsif p_kind='crossed_pair' then
    insert into public.payroll_cycles(id,maid_profile_id,week_start) values(v_cycle_two,pg_temp.pid(3),v_week+7);
    insert into public.payroll_offset_settlements(id,payroll_cycle_id,maid_profile_id,week_start,cycle_version,
      earning_amount,adjustment_amount,carry_in_amount,net_amount,carry_out_id,settled_by,settled_at) values
      (v_settlement,v_cycle,pg_temp.pid(3),v_week,1,0,-100,0,-100,v_carry,pg_temp.pid(1),clock_timestamp()),
      (v_settlement_two,v_cycle_two,pg_temp.pid(3),v_week+7,1,0,-100,0,-100,v_carry_two,pg_temp.pid(1),clock_timestamp());
    insert into public.payroll_residual_carries(id,maid_profile_id,source_settlement_id,available_week_start,amount) values
      (v_carry,pg_temp.pid(3),v_settlement_two,v_week+14,100),
      (v_carry_two,pg_temp.pid(3),v_settlement,v_week+7,100);
  end if;
  set constraints payroll_offset_settlements_carry_pair,
    payroll_residual_carries_settlement_pair immediate;
end $$;

select pg_temp.add_earning(1,2,pg_temp.week(-3),10000);
select lives_ok($$select public.record_payroll_correction(pg_temp.pid(1),pg_temp.pid(5001),null,-3000,0,
  'adjust-correct-1',repeat('a',64))$$,'negative earning correction is typed and append-only');
select is((public.record_payroll_correction(pg_temp.pid(1),pg_temp.pid(5001),null,-3000,0,
    'adjust-correct-1',repeat('a',64))->>'adjustmentId')::uuid,
  (select id from public.payroll_adjustments where correction_of_earning_id=pg_temp.pid(5001)),
  'same scoped idempotency key and canonical request hash replays one logical adjustment');
select throws_ok($$select public.record_payroll_correction(pg_temp.pid(1),pg_temp.pid(5001),null,-2000,0,
  'adjust-correct-1',repeat('b',64))$$,'23505','IDEMPOTENCY_KEY_REUSED',
  'same scoped idempotency key with a different payload fails closed');
select is((select reason_code from public.payroll_adjustments where correction_of_earning_id=pg_temp.pid(5001)),
  'earning_correction','correction reason is server-derived');
select lives_ok($$select public.reverse_payroll_source(pg_temp.pid(1),null,
  (select id from public.payroll_adjustments where correction_of_earning_id=pg_temp.pid(5001)),1,
  'adjust-reverse-1',repeat('b',64))$$,'adjustment reversal is the exact inverse');
select is((select amount from public.payroll_adjustments where reason_code='adjustment_reversal'),3000,
  'reversal amount cannot be client spoofed');
select throws_ok($$select public.reverse_payroll_source(pg_temp.pid(1),null,
  (select id from public.payroll_adjustments where correction_of_earning_id=pg_temp.pid(5001)),2,
  'adjust-reverse-dup',repeat('c',64))$$,'23505','PAYROLL_SOURCE_ALREADY_REVERSED',
  'one source can be reversed only once');
select throws_ok($$select public.record_payroll_correction(pg_temp.pid(1),pg_temp.pid(5001),null,-11000,2,
  'adjust-floor',repeat('d',64))$$,'23514','PAYROLL_ROOT_ENTITLEMENT_NEGATIVE',
  'root cumulative entitlement cannot fall below zero');

-- Pay one source, then create a negative next-week correction and settle it.
select pg_temp.add_earning(2,2,pg_temp.week(-3)+1,20000);
select lives_ok($$select public.start_payroll_cycle(pg_temp.pid(1),pg_temp.pid(2),pg_temp.week(-3),0,
  'adjust-start-paid',repeat('e',64))$$,'positive earning plus adjustments starts');
select ok((select (projection->>'totalAmount')::int=30000
    and (projection->>'adjustmentAmount')::int=0
    and (projection->>'payableAmount')::int=30000
  from (select private.project_payroll_cycle_bounded(pg_temp.week(-3),pg_temp.pid(2),10) projection) p),
  'projection preserves gross earning total separately from signed adjustment and payable totals');
select public.record_payroll_payment_paid(pg_temp.pid(1),
  (select id from public.payroll_payment_attempts where maid_profile_id=pg_temp.pid(2)),
  (select version from public.payroll_cycles where maid_profile_id=pg_temp.pid(2) and week_start=pg_temp.week(-3)),
  'bank_transfer','ADJUST-01','adjust-paid-fixture',repeat('0',64));
select lives_ok($$select public.record_payroll_correction(pg_temp.pid(1),pg_temp.pid(5002),null,-5000,2,
  'adjust-negative-next',repeat('f',64))$$,'paid source correction is assigned to a later cycle');
select throws_ok($$select public.start_payroll_cycle(pg_temp.pid(1),pg_temp.pid(2),pg_temp.week(-2),0,
  'adjust-start-negative',repeat('1',64))$$,'22023','PAYROLL_NONPOSITIVE_REQUIRES_CARRY',
  'start rejects non-positive net and rolls candidate claims back');
select is((select count(*) from public.payroll_cycles where maid_profile_id=pg_temp.pid(2)
  and week_start=pg_temp.week(-2)),0::bigint,'failed start writes no cycle');
select lives_ok($$select public.carry_forward_payroll_cycle(pg_temp.pid(1),pg_temp.pid(2),pg_temp.week(-2),0,
  'adjust-carry-negative',repeat('2',64))$$,'non-positive week is offset-settled');
select ok((select offset_settled_at is not null and status='open' from public.payroll_cycles
  where maid_profile_id=pg_temp.pid(2) and week_start=pg_temp.week(-2)),
  'offset settlement economically freezes an OPEN-status cycle');
select is((select count(*) from public.payroll_events e join public.payroll_cycles c on c.id=e.payroll_cycle_id
  where c.week_start=pg_temp.week(-2)),0::bigint,'carry-forward creates no payment event');
select throws_ok($$select public.start_payroll_cycle(pg_temp.pid(1),pg_temp.pid(2),pg_temp.week(-2),1,
  'adjust-frozen-start',repeat('3',64))$$,'55000','PAYROLL_CYCLE_ECONOMICALLY_FROZEN',
  'offset-settled cycle can never start payment');
select is((select amount from public.payroll_residual_carries where maid_profile_id=pg_temp.pid(2)),5000,
  'negative residual is preserved once for the immediately following week');

select pg_temp.add_earning(3,2,pg_temp.week(-1),9000);
select lives_ok($$select public.start_payroll_cycle(pg_temp.pid(1),pg_temp.pid(2),pg_temp.week(-1),0,
  'adjust-start-carry-in',repeat('4',64))$$,'next positive week consumes the residual exactly once');
select is((select locked_amount from public.payroll_cycles where maid_profile_id=pg_temp.pid(2)
  and week_start=pg_temp.week(-1)),4000,'carry reduces the next positive payable');
select is((select count(*) from public.payroll_carry_items),1::bigint,'residual is claimed exactly once');

-- Zero boundary records settlement but no carry and no zero-value payment event.
select pg_temp.add_earning(4,3,pg_temp.week(-2),7000);
select lives_ok($$select public.record_payroll_correction(pg_temp.pid(1),pg_temp.pid(5004),null,1000,0,
  'adjust-positive-correction',repeat('5',64))$$,'positive correction is a typed signed adjustment');
select lives_ok($$select public.record_payroll_correction(pg_temp.pid(1),pg_temp.pid(5004),null,-8000,1,
  'adjust-zero-correction',repeat('5',64))$$,'exact zero correction is accepted');
select lives_ok($$select public.carry_forward_payroll_cycle(pg_temp.pid(1),pg_temp.pid(3),pg_temp.week(-2),0,
  'adjust-zero-carry',repeat('6',64))$$,'zero net creates an offset settlement');
select is((select count(*) from public.payroll_residual_carries where maid_profile_id=pg_temp.pid(3)),0::bigint,
  'zero net creates no residual carry row');

-- A frozen cycle late earning remains visible until explicitly carried once.
select pg_temp.add_earning(5,3,pg_temp.week(-2)+2,4000);
select is((private.project_payroll_cycle_bounded(pg_temp.week(-2),pg_temp.pid(3),10)->>'lateEarningCount')::int,1,
  'late earning remains visible before explicit carry');
select lives_ok($$select public.carry_late_payroll_earning(pg_temp.pid(1),pg_temp.pid(5005),2,
  'adjust-late-carry',repeat('7',64))$$,'admin explicitly carries a frozen-cycle late earning');
select is((private.project_payroll_cycle_bounded(pg_temp.week(-2),pg_temp.pid(3),10)->>'lateEarningCount')::int,0,
  'carried late earning leaves the late projection and cannot be claimed as original earning');
select throws_ok($$select public.carry_late_payroll_earning(pg_temp.pid(1),pg_temp.pid(5005),3,
  'adjust-late-dup',repeat('8',64))$$,'23505','PAYROLL_LATE_EARNING_ALREADY_CARRIED',
  'late source carry is unique');

-- A following week cannot freeze while its immediate source week has an unhandled positive late earning.
select pg_temp.freeze_cycle(6,pg_temp.week(-8),'paying',false);
select pg_temp.add_earning(20,6,pg_temp.week(-8)+1,4000);
select pg_temp.add_earning(21,6,pg_temp.week(-7)+1,6000);
select throws_ok($$select public.start_payroll_cycle(pg_temp.pid(1),pg_temp.pid(6),pg_temp.week(-7),0,
  'late-paying-next-start',repeat('a',64))$$,'55000','PAYROLL_PRIOR_LATE_EARNING_PENDING',
  'PAYING source week late earning blocks next positive start');
select throws_ok($$select public.carry_late_payroll_earning(pg_temp.pid(1),pg_temp.pid(5020),0,
  'late-paying-before-result',repeat('b',64))$$,'55000','PAYROLL_SOURCE_PAYMENT_UNCERTAIN',
  'PAYING source must resolve before its late earning can be carried');
select pg_temp.resolve_historical_cycle(6,pg_temp.week(-8));
select lives_ok($$select public.carry_late_payroll_earning(pg_temp.pid(1),pg_temp.pid(5020),0,
  'late-paying-after-result',repeat('c',64))$$,'resolved PAYING source late earning is carried');
select lives_ok($$select public.start_payroll_cycle(pg_temp.pid(1),pg_temp.pid(6),pg_temp.week(-7),0,
  'late-paying-next-retry',repeat('d',64))$$,'next positive start proceeds after explicit late carry');
select throws_ok($$select pg_temp.add_earning(28,6,pg_temp.week(-8)+2,1000)$$,'55000',
  'PAYROLL_PRIOR_LATE_EARNING_PENDING',
  'a next-week freeze winner rejects a later source-week earning instead of stranding it');

select pg_temp.freeze_cycle(7,pg_temp.week(-8),'check',false);
select pg_temp.add_earning(22,7,pg_temp.week(-8)+1,4000);
select pg_temp.add_earning(23,7,pg_temp.week(-7)+1,6000);
select throws_ok($$select public.start_payroll_cycle(pg_temp.pid(1),pg_temp.pid(7),pg_temp.week(-7),0,
  'late-check-next-start',repeat('e',64))$$,'55000','PAYROLL_PRIOR_LATE_EARNING_PENDING',
  'CHECK source week late earning blocks next positive start');
select pg_temp.resolve_historical_cycle(7,pg_temp.week(-8));
select public.carry_late_payroll_earning(pg_temp.pid(1),pg_temp.pid(5022),0,
  'late-check-after-result',repeat('f',64));
select lives_ok($$select public.start_payroll_cycle(pg_temp.pid(1),pg_temp.pid(7),pg_temp.week(-7),0,
  'late-check-next-retry',repeat('1',64))$$,'next start proceeds after CHECK resolves and late earning is carried');

select pg_temp.freeze_cycle(8,pg_temp.week(-8),'paid',false);
select pg_temp.add_earning(24,8,pg_temp.week(-8)+1,5000);
select public.record_payroll_correction(pg_temp.pid(1),pg_temp.pid(5024),null,-5000,0,
  'late-paid-negative',repeat('2',64));
select throws_ok($$select public.carry_forward_payroll_cycle(pg_temp.pid(1),pg_temp.pid(8),pg_temp.week(-7),0,
  'late-paid-next-offset',repeat('3',64))$$,'55000','PAYROLL_PRIOR_LATE_EARNING_PENDING',
  'PAID source week late earning blocks next zero/negative offset settlement');
select public.carry_late_payroll_earning(pg_temp.pid(1),pg_temp.pid(5024),1,
  'late-paid-carry',repeat('4',64));
select lives_ok($$select public.carry_forward_payroll_cycle(pg_temp.pid(1),pg_temp.pid(8),pg_temp.week(-7),0,
  'late-paid-next-offset-retry',repeat('5',64))$$,'offset settlement proceeds after PAID late earning carry');

select pg_temp.freeze_cycle(9,pg_temp.week(-8),'open',true);
select pg_temp.add_earning(25,9,pg_temp.week(-8)+1,5000);
select public.record_payroll_correction(pg_temp.pid(1),pg_temp.pid(5025),null,-5000,0,
  'late-offset-negative',repeat('6',64));
select throws_ok($$select public.carry_forward_payroll_cycle(pg_temp.pid(1),pg_temp.pid(9),pg_temp.week(-7),0,
  'late-offset-next-offset',repeat('7',64))$$,'55000','PAYROLL_PRIOR_LATE_EARNING_PENDING',
  'offset-settled source week late earning blocks next zero/negative offset settlement');
select public.carry_late_payroll_earning(pg_temp.pid(1),pg_temp.pid(5025),1,
  'late-offset-carry',repeat('8',64));
select lives_ok($$select public.carry_forward_payroll_cycle(pg_temp.pid(1),pg_temp.pid(9),pg_temp.week(-7),0,
  'late-offset-next-offset-retry',repeat('9',64))$$,'offset path proceeds after prior offset late earning carry');

-- No source cycle or an ordinary OPEN source is not "late": W remains independently processable.
select pg_temp.freeze_cycle(10,pg_temp.week(-9),'paying',false);
select lives_ok($$select pg_temp.add_earning(26,10,pg_temp.week(-10)+1,4000)$$,
  'a missing source cycle accepts its normal W earning even when W+1 is frozen');
select lives_ok($$select public.start_payroll_cycle(pg_temp.pid(1),pg_temp.pid(10),pg_temp.week(-10),0,
  'normal-absent-source-start',repeat('a',64))$$,'the previously absent W cycle can claim and start normally');
select pg_temp.freeze_cycle(11,pg_temp.week(-10),'open',false);
select pg_temp.freeze_cycle(11,pg_temp.week(-9),'paying',false);
select lives_ok($$select pg_temp.add_earning(27,11,pg_temp.week(-10)+1,4000)$$,
  'an ordinary OPEN source accepts its normal W earning even when W+1 is frozen');
select lives_ok($$select public.start_payroll_cycle(pg_temp.pid(1),pg_temp.pid(11),pg_temp.week(-10),1,
  'normal-open-source-start',repeat('b',64))$$,'the OPEN W cycle remains normally processable');

-- Deferred pair checks reject every cross-table economic mismatch at transaction validation time.
select throws_ok($$select pg_temp.invalid_carry_pair('wrong_amount',1)$$,'23514',
  'PAYROLL_CARRY_INVARIANT_VIOLATION','wrong residual amount is rejected at deferred validation');
select throws_ok($$select pg_temp.invalid_carry_pair('wrong_week',2)$$,'23514',
  'PAYROLL_CARRY_INVARIANT_VIOLATION','wrong residual week is rejected at deferred validation');
select throws_ok($$select pg_temp.invalid_carry_pair('crossed_pair',3)$$,'23514',
  'PAYROLL_CARRY_INVARIANT_VIOLATION','crossed settlement and carry pairs are rejected');
select throws_ok($$select pg_temp.invalid_carry_pair('one_sided_carry',4)$$,'23514',
  'PAYROLL_CARRY_INVARIANT_VIOLATION','net-zero settlement cannot have a one-sided residual carry');
select throws_ok($$select pg_temp.invalid_carry_pair('missing_carry',5)$$,'23514',
  'PAYROLL_CARRY_INVARIANT_VIOLATION',
  'negative settlement cannot retain a one-sided missing carry reference');
set constraints payroll_offset_settlements_carry_pair,
  payroll_residual_carries_settlement_pair immediate;
set constraints payroll_offset_settlements_carry_pair,
  payroll_residual_carries_settlement_pair deferred;

select pg_temp.add_earning(6,3,pg_temp.week(-3),0);
select is((private.project_payroll_cycle_bounded(pg_temp.week(-3),pg_temp.pid(3),10)->>'itemCount')::int,0,
  'zero-KRW compensation-shaped earning remains provenance and never becomes a payroll candidate');
select is((public.list_payroll_entries_page(pg_temp.pid(1),pg_temp.week(-3),pg_temp.pid(3),'items',null,null,25)
  ->'entries')::text,'[]','zero-KRW earning is absent from bounded payroll entry projection');
select throws_ok($$select public.reverse_payroll_source(pg_temp.pid(1),pg_temp.pid(5006),null,3,
  'adjust-zero-reversal',repeat('9',64))$$,'22023','PAYROLL_ADJUSTMENT_INVALID',
  'zero-KRW provenance cannot create a meaningless zero adjustment reversal');

select ok((select summary ? 'reasonCode' and not(summary ?| array['amount','maidProfileId','requestHash','after_state'])
  from public.list_developer_audit_events(pg_temp.pid(5),array['payroll.adjustment_recorded'],null,
    clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day',null,null,10) limit 1),
  'developer audit exposes only safe adjustment summary fields');
select ok((select count(distinct event_type)=4
    and bool_and(not(summary ?| array['amount','maidProfileId','requestHash','before_state','after_state',
      'idempotencyKey','rootEarningId','sourceEarningId','sourceAdjustmentId']))
  from public.list_developer_audit_events(pg_temp.pid(5),array[
    'payroll.adjustment_recorded','payroll.adjustment_reversed','payroll.offset_settled',
    'payroll.late_earning_carried'],null,clock_timestamp()-interval '1 day',
    clock_timestamp()+interval '1 day',null,null,100)),
  'developer can query all four #102 events only through their cross-maid-safe summaries');

select ok(not exists(select 1 from unnest(array['anon','service_role']) role_name
  cross join unnest(array['public.payroll_adjustment_books','public.payroll_adjustments','public.payroll_adjustment_items',
    'public.payroll_residual_carries','public.payroll_carry_items','public.payroll_offset_settlements']) relation
  cross join unnest(array['SELECT','INSERT','UPDATE','DELETE']) privilege
  where has_table_privilege(role_name,relation,privilege)),
  'anon and service_role have no raw new-ledger table privileges');

create function pg_temp.visible_payroll_adjustment_rows(p_maid uuid default null)
returns bigint language sql stable as $$
  select (select count(*) from public.payroll_adjustment_books where p_maid is null or maid_profile_id=p_maid)
    +(select count(*) from public.payroll_adjustments where p_maid is null or maid_profile_id=p_maid)
    +(select count(*) from public.payroll_adjustment_items where p_maid is null or maid_profile_id=p_maid)
    +(select count(*) from public.payroll_residual_carries where p_maid is null or maid_profile_id=p_maid)
    +(select count(*) from public.payroll_carry_items where p_maid is null or maid_profile_id=p_maid)
    +(select count(*) from public.payroll_offset_settlements where p_maid is null or maid_profile_id=p_maid)
$$;
grant execute on function pg_temp.visible_payroll_adjustment_rows(uuid) to authenticated;
create temporary table rls_counts as select
  pg_temp.visible_payroll_adjustment_rows() all_rows,
  pg_temp.visible_payroll_adjustment_rows(pg_temp.pid(2)) maid_two_rows;
grant select on rls_counts to authenticated;
set local role authenticated;
set local request.jwt.claims='{"sub":"10200000-0000-4000-8000-000000000102"}';
select is(pg_temp.visible_payroll_adjustment_rows(),0::bigint,
  'missing live session hides every adjustment/carry table');
set local request.jwt.claims='{"sub":"10200000-0000-4000-8000-000000000102","session_id":"bad"}';
select is(pg_temp.visible_payroll_adjustment_rows(),0::bigint,
  'malformed live session hides every adjustment/carry table without cast errors');
set local request.jwt.claims='{"sub":"10200000-0000-4000-8000-000000000102","session_id":"10200000-0000-4000-8000-000000000901"}';
select is(pg_temp.visible_payroll_adjustment_rows(),0::bigint,
  'another user live session hides every adjustment/carry table');
set local request.jwt.claims='{"sub":"10200000-0000-4000-8000-000000000102","session_id":"10200000-0000-4000-8000-000000000902"}';
select is(pg_temp.visible_payroll_adjustment_rows(),(select maid_two_rows from pg_temp.rls_counts),
  'active password-complete maid sees only self rows across every adjustment/carry table');
select is(pg_temp.visible_payroll_adjustment_rows(pg_temp.pid(3)),0::bigint,
  'maid cannot read another maid rows across every adjustment/carry table');
set local request.jwt.claims='{"sub":"10200000-0000-4000-8000-000000000104","session_id":"10200000-0000-4000-8000-000000000904"}';
select is(pg_temp.visible_payroll_adjustment_rows(),0::bigint,
  'temporary-password admin sees zero adjustment/carry rows');
set local request.jwt.claims='{"sub":"10200000-0000-4000-8000-000000000105","session_id":"10200000-0000-4000-8000-000000000905"}';
select is(pg_temp.visible_payroll_adjustment_rows(),0::bigint,
  'developer sees zero adjustment/carry rows');
reset role;

update public.profiles set status='inactive' where id=pg_temp.pid(2);
set local role authenticated;
set local request.jwt.claims='{"sub":"10200000-0000-4000-8000-000000000102","session_id":"10200000-0000-4000-8000-000000000902"}';
select is(pg_temp.visible_payroll_adjustment_rows(),0::bigint,
  'inactive maid sees zero adjustment/carry rows');
reset role;

select throws_ok($$update public.payroll_adjustments set amount=1$$,'55000','PAYROLL_LEDGER_IMMUTABLE',
  'adjustments are append-only');
select throws_ok($$delete from public.payroll_offset_settlements$$,'55000','PAYROLL_LEDGER_IMMUTABLE',
  'offset settlements are append-only');

select * from finish();
rollback;
