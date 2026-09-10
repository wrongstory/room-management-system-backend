begin;
select no_plan();

create function pg_temp.pid(n integer) returns uuid language sql immutable as $$
  select ('10200000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
create function pg_temp.week(n integer) returns date language sql stable as $$
  select date_trunc('week',clock_timestamp() at time zone 'Asia/Seoul')::date+n*7
$$;

insert into auth.users(id) select pg_temp.pid(100+n) from generate_series(1,5)n;
select public.bootstrap_first_developer_profile(pg_temp.pid(5),pg_temp.pid(105),'adjust-dev','adjust-dev',
  '0102',repeat('d',64),'adjust-dev-bootstrap');
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
  login_sequence,role,status,must_change_password) values
  (pg_temp.pid(1),pg_temp.pid(101),'adjust-admin','adjust-admin','adjust-admin','adjust-admin',0,'admin','active',false),
  (pg_temp.pid(2),pg_temp.pid(102),'adjust-maid','adjust-maid','adjust-maid','adjust-maid',0,'maid','active',false),
  (pg_temp.pid(3),pg_temp.pid(103),'adjust-other','adjust-other','adjust-other','adjust-other',0,'maid','active',false),
  (pg_temp.pid(4),pg_temp.pid(104),'adjust-temp','adjust-temp','adjust-temp','adjust-temp',0,'admin','active',true);
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
update public.payroll_cycles set status='paid',paid_at=clock_timestamp()
where maid_profile_id=pg_temp.pid(2) and week_start=pg_temp.week(-3);
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
