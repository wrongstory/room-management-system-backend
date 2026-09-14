begin;
select no_plan();

create function pg_temp.pid(n integer) returns uuid language sql immutable as $$
  select ('10300000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
create function pg_temp.week(n integer) returns date language sql stable as $$
  select date_trunc('week',clock_timestamp() at time zone 'Asia/Seoul')::date+n*7
$$;

insert into auth.users(id) select pg_temp.pid(100+n) from generate_series(1,8)n;
insert into auth.sessions(id,user_id) select pg_temp.pid(900+n),pg_temp.pid(100+n) from generate_series(1,8)n;
select public.bootstrap_first_developer_profile(pg_temp.pid(4),pg_temp.pid(104),'pay-dev','pay-dev',
  '0103',repeat('d',64),'payment-result-dev-bootstrap');
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
  login_sequence,role,status,must_change_password) values
  (pg_temp.pid(1),pg_temp.pid(101),'pay-admin','pay-admin','pay-admin','pay-admin',0,'admin','active',false),
  (pg_temp.pid(2),pg_temp.pid(102),'pay-maid','pay-maid','pay-maid','pay-maid',0,'maid','active',false),
  (pg_temp.pid(3),pg_temp.pid(103),'pay-temp','pay-temp','pay-temp','pay-temp',0,'admin','active',true),
  (pg_temp.pid(5),pg_temp.pid(105),'pay-inactive','pay-inactive','pay-inactive','pay-inactive',0,'admin','inactive',false),
  (pg_temp.pid(6),pg_temp.pid(106),'pay-other','pay-other','pay-other','pay-other',0,'maid','active',false);

select throws_ok($$insert into public.payroll_cycles(id,maid_profile_id,week_start,status,version,
  locked_amount,payment_started_by,payment_started_at)
  values(pg_temp.pid(7000),pg_temp.pid(2),pg_temp.week(-8),'paying',1,100,
    pg_temp.pid(1),clock_timestamp())$$,'23514','PAYROLL_PAYMENT_EVIDENCE_REQUIRED',
  'future payroll cycles must be inserted in pristine OPEN state');

create function pg_temp.start_without_evidence() returns void language plpgsql as $$
begin
  insert into public.payroll_cycles(id,maid_profile_id,week_start)
  values(pg_temp.pid(7001),pg_temp.pid(2),pg_temp.week(-8));
  update public.payroll_cycles set status='paying',version=1,locked_amount=100,
    payment_started_by=pg_temp.pid(1),payment_started_at=clock_timestamp()
  where id=pg_temp.pid(7001);
  execute 'set constraints private.payroll_payment_projection_requires_evidence immediate';
end $$;
select throws_ok($$select pg_temp.start_without_evidence()$$,'23514','PAYROLL_PAYMENT_EVIDENCE_REQUIRED',
  'OPEN to PAYING direct DML cannot commit without exact event and attempt evidence');

create function pg_temp.attempt_without_transition() returns void language plpgsql as $$
declare v_event bigint;v_at timestamptz:=clock_timestamp();
begin
  insert into public.payroll_cycles(id,maid_profile_id,week_start)
  values(pg_temp.pid(7002),pg_temp.pid(2),pg_temp.week(-8));
  insert into public.payroll_events(payroll_cycle_id,maid_profile_id,event_type,before_status,after_status,
    actor_profile_id,cycle_version,locked_amount,occurred_at)
  values(pg_temp.pid(7002),pg_temp.pid(2),'payment_started','open','paying',pg_temp.pid(1),1,100,v_at)
  returning id into v_event;
  insert into public.payroll_payment_attempts(payroll_cycle_id,maid_profile_id,attempt_number,start_event_id,
    start_cycle_version,locked_amount,started_by,started_at)
  values(pg_temp.pid(7002),pg_temp.pid(2),1,v_event,1,100,pg_temp.pid(1),v_at);
  execute 'set constraints public.payroll_payment_attempt_requires_transition immediate';
end $$;
select throws_ok($$select pg_temp.attempt_without_transition()$$,'23514','PAYROLL_PAYMENT_EVIDENCE_REQUIRED',
  'attempt evidence cannot be synthesized without its captured OPEN to PAYING transition');

create function pg_temp.add_earning(n integer,p_maid integer,p_day date,p_amount integer)
returns uuid language plpgsql as $$
declare v_room public.rooms;v_target uuid:=pg_temp.pid(1000+n);v_assignment uuid:=pg_temp.pid(2000+n);
  v_attempt uuid:=pg_temp.pid(3000+n);v_submission uuid:=pg_temp.pid(4000+n);
  v_earning uuid:=pg_temp.pid(5000+n);v_at timestamptz:=(p_day::timestamp+time '12:00') at time zone 'Asia/Seoul';
begin
  select * into v_room from public.rooms order by room_number limit 1;
  insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,
    effective_service_date,available_from,due_at,status,assignment_version,room_type_snapshot,fee_snapshot,
    template_snapshot,created_by) values(v_target,v_room.id,'additional','manual_room_request','pay-result-'||n,
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

select pg_temp.add_earning(1,2,pg_temp.week(-4),21000);
select lives_ok($$select public.start_payroll_cycle(pg_temp.pid(1),pg_temp.pid(2),pg_temp.week(-4),0,
  'payment-start-1',repeat('1',64))$$,'start creates the first immutable payment attempt');
select is((select count(*) from public.payroll_payment_attempts),1::bigint,'one attempt exists');
select ok((select attempt_number=1 and locked_amount=21000 and start_cycle_version=1
  from public.payroll_payment_attempts),'attempt preserves the exact payment_started snapshot');
create function pg_temp.check_without_evidence(p_cycle uuid) returns void language plpgsql as $$
begin
  update public.payroll_cycles set status='check',check_reason='TRANSFER_RESULT_UNCERTAIN',version=version+1
  where id=p_cycle;
  execute 'set constraints private.payroll_payment_projection_requires_evidence immediate';
end $$;
create function pg_temp.paid_without_evidence(p_cycle uuid) returns void language plpgsql as $$
begin
  update public.payroll_cycles set status='paid',paid_at=clock_timestamp(),check_reason=null,
    version=version+1 where id=p_cycle;
  execute 'set constraints private.payroll_payment_projection_requires_evidence immediate';
end $$;
create function pg_temp.reopen_without_evidence(p_cycle uuid) returns void language plpgsql as $$
begin
  update public.payroll_cycles set status='open',locked_amount=null,payment_started_by=null,
    payment_started_at=null,check_reason=null,last_reopen_reason='NO_TRANSFER_CONFIRMED',
    last_reopened_by=pg_temp.pid(1),last_reopened_at=clock_timestamp(),version=version+1 where id=p_cycle;
  execute 'set constraints private.payroll_payment_projection_requires_evidence immediate';
end $$;
select throws_ok($$select pg_temp.check_without_evidence((select id from public.payroll_cycles
  where maid_profile_id=pg_temp.pid(2) and week_start=pg_temp.week(-4)))$$,
  '23514','PAYROLL_PAYMENT_EVIDENCE_REQUIRED','PAYING to CHECK cannot commit without a check result');
select throws_ok($$select pg_temp.paid_without_evidence((select id from public.payroll_cycles
  where maid_profile_id=pg_temp.pid(2) and week_start=pg_temp.week(-4)))$$,
  '23514','PAYROLL_PAYMENT_EVIDENCE_REQUIRED','PAYING to PAID cannot commit without a paid result');
select throws_ok($$select pg_temp.reopen_without_evidence((select id from public.payroll_cycles
  where maid_profile_id=pg_temp.pid(2) and week_start=pg_temp.week(-4)))$$,
  '23514','PAYROLL_PAYMENT_EVIDENCE_REQUIRED','PAYING to OPEN cannot commit without a reopened result');
select lives_ok($$select public.record_payroll_payment_paid(pg_temp.pid(1),
  (select id from public.payroll_payment_attempts),1,'bank_transfer','ABC-12.XY',
  'payment-paid-1',repeat('2',64))$$,'PAYING transitions directly to PAID');
select ok((select status='paid' and locked_amount=21000 and paid_at is not null and version=2
  from public.payroll_cycles where maid_profile_id=pg_temp.pid(2) and week_start=pg_temp.week(-4)),
  'PAID keeps the exact positive locked snapshot and server paidAt');
select ok((select result_type='paid' and locked_amount=21000 and canonical_reference='ABC-12.XY'
  from public.payroll_payment_results),'paid result stores full amount and canonical reference');
select is((public.record_payroll_payment_paid(pg_temp.pid(1),
  (select id from public.payroll_payment_attempts),1,'bank_transfer','ABC-12.XY',
  'payment-paid-1',repeat('2',64))->>'paymentResultId')::uuid,
  (select id from public.payroll_payment_results where canonical_reference='ABC-12.XY'),
  'same canonical paid command replays the immutable result');
select throws_ok($$select public.record_payroll_payment_paid(pg_temp.pid(1),
  (select id from public.payroll_payment_attempts),1,'bank_transfer','ABC-12.XY',
  'payment-paid-1',repeat('3',64))$$,'23505','IDEMPOTENCY_KEY_REUSED',
  'same paid key with a different canonical request hash fails closed');
select throws_ok($$update public.payroll_cycles set status='open' where maid_profile_id=pg_temp.pid(2)
  and week_start=pg_temp.week(-4)$$,'55000','PAID_PAYROLL_IMMUTABLE','PAID projection cannot reopen');
select throws_ok($$delete from public.payroll_payment_results$$,'55000','PAYROLL_PAYMENT_EVIDENCE_IMMUTABLE',
  'payment result ledger cannot be deleted');

select pg_temp.add_earning(2,2,pg_temp.week(-3),18000);
select public.start_payroll_cycle(pg_temp.pid(1),pg_temp.pid(2),pg_temp.week(-3),0,
  'payment-start-2',repeat('3',64));
select lives_ok($$select public.record_payroll_payment_check(pg_temp.pid(1),
  (select id from public.payroll_payment_attempts order by started_at desc limit 1),1,
  'TRANSFER_RESULT_UNCERTAIN','payment-check-2',repeat('4',64))$$,'PAYING transitions to CHECK');
select ok((select status='check' and check_reason='TRANSFER_RESULT_UNCERTAIN' and version=2
  from public.payroll_cycles where maid_profile_id=pg_temp.pid(2) and week_start=pg_temp.week(-3)),
  'CHECK uses only the fixed uncertain result code');
select throws_ok($$select pg_temp.paid_without_evidence((select id from public.payroll_cycles
  where maid_profile_id=pg_temp.pid(2) and week_start=pg_temp.week(-3)))$$,
  '23514','PAYROLL_PAYMENT_EVIDENCE_REQUIRED','CHECK to PAID cannot commit without a paid result');
select throws_ok($$select pg_temp.reopen_without_evidence((select id from public.payroll_cycles
  where maid_profile_id=pg_temp.pid(2) and week_start=pg_temp.week(-3)))$$,
  '23514','PAYROLL_PAYMENT_EVIDENCE_REQUIRED','CHECK to OPEN cannot commit without a reopened result');
select lives_ok($$select public.record_payroll_payment_paid(pg_temp.pid(1),
  (select id from public.payroll_payment_attempts order by started_at desc limit 1),2,
  'bank_transfer','REF:AB12','payment-paid-2',repeat('5',64))$$,'same CHECK attempt transitions to PAID');
select ok((select status='paid' and check_reason is null
  from public.payroll_cycles where maid_profile_id=pg_temp.pid(2) and week_start=pg_temp.week(-3)),
  'v40 fixed CHECK reason is cleared by the current PAID transition contract');
select is((select count(*) from public.payroll_payment_results where result_type='check'),1::bigint,
  'CHECK history remains immutable after PAID');

select pg_temp.add_earning(3,2,pg_temp.week(-2),17000);
select public.start_payroll_cycle(pg_temp.pid(1),pg_temp.pid(2),pg_temp.week(-2),0,
  'payment-start-3',repeat('6',64));
select lives_ok($$select public.reopen_payroll_payment_attempt(pg_temp.pid(1),
  (select id from public.payroll_payment_attempts order by started_at desc limit 1),1,
  'NO_TRANSFER_CONFIRMED','payment-reopen-3',repeat('7',64))$$,'PAYING reopens only after confirmed no transfer');
select ok((select status='open' and locked_amount is null and payment_started_at is null
  and last_reopen_reason='NO_TRANSFER_CONFIRMED' and version=2 from public.payroll_cycles
  where maid_profile_id=pg_temp.pid(2) and week_start=pg_temp.week(-2)),
  'reopen clears payment snapshot and preserves fixed terminal evidence');
select lives_ok($$select public.start_payroll_cycle(pg_temp.pid(1),pg_temp.pid(2),pg_temp.week(-2),2,
  'payment-restart-3',repeat('8',64))$$,'reopened cycle creates a new attempt');
select is((select max(attempt_number) from public.payroll_payment_attempts where payroll_cycle_id=(select id
  from public.payroll_cycles where maid_profile_id=pg_temp.pid(2) and week_start=pg_temp.week(-2))),2,
  'retry uses a new monotonically numbered attempt');
select throws_ok($$select public.record_payroll_payment_check(pg_temp.pid(1),
  (select id from public.payroll_payment_attempts where attempt_number=1 and payroll_cycle_id=(select id
    from public.payroll_cycles where maid_profile_id=pg_temp.pid(2) and week_start=pg_temp.week(-2))),3,
  'TRANSFER_RESULT_UNCERTAIN','payment-old-attempt',repeat('9',64))$$,'55000','PAYROLL_PAYMENT_ATTEMPT_TERMINAL',
  'terminal prior attempt cannot receive another result');

create function pg_temp.current_attempt() returns uuid language sql stable as $$
  select attempt.id from public.payroll_payment_attempts attempt
  join public.payroll_cycles cycle on cycle.id=attempt.payroll_cycle_id
  where cycle.maid_profile_id=pg_temp.pid(2) and cycle.week_start=pg_temp.week(-2)
  order by attempt.attempt_number desc limit 1
$$;

select throws_ok($$select public.record_payroll_payment_check(pg_temp.pid(1),
  pg_temp.current_attempt(),3,'free text',
  'payment-invalid-check',repeat('a',64))$$,'22023','PAYROLL_PAYMENT_REASON_INVALID','free-form CHECK reason is rejected');
select throws_ok($$select public.reopen_payroll_payment_attempt(pg_temp.pid(1),
  pg_temp.current_attempt(),3,'retry',
  'payment-invalid-reopen',repeat('b',64))$$,'22023','PAYROLL_PAYMENT_REOPEN_REASON_INVALID','free-form reopen reason is rejected');
select throws_ok($$select public.record_payroll_payment_paid(pg_temp.pid(1),
  pg_temp.current_attempt(),3,'cash','BANKAB12',
  'payment-invalid-method',repeat('c',64))$$,'22023','PAYROLL_PAYMENT_METHOD_INVALID','non-source-controlled method is rejected');
select throws_ok($$select public.record_payroll_payment_paid(pg_temp.pid(1),
  pg_temp.current_attempt(),3,'bank_transfer','abc-12.xy',
  'payment-raw-ref',repeat('d',64))$$,'22023','PAYROLL_PAYMENT_REFERENCE_INVALID','DB accepts canonical references only');
select throws_ok($$select public.record_payroll_payment_paid(pg_temp.pid(1),
  pg_temp.current_attempt(),3,'bank_transfer','ABCDEFGH',
  'payment-no-digit',repeat('e',64))$$,'22023','PAYROLL_PAYMENT_REFERENCE_INVALID','reference requires a digit');
select throws_ok($$select public.record_payroll_payment_paid(pg_temp.pid(1),
  pg_temp.current_attempt(),3,'bank_transfer','AB1234567',
  'payment-long-digits',repeat('f',64))$$,'22023','PAYROLL_PAYMENT_REFERENCE_INVALID','seven consecutive digits are rejected');
select throws_ok($$select public.record_payroll_payment_paid(pg_temp.pid(1),
  pg_temp.current_attempt(),3,'bank_transfer','WWW.AB12',
  'payment-url-like',repeat('9',64))$$,'22023','PAYROLL_PAYMENT_REFERENCE_INVALID','URL-like references are rejected');
select throws_ok($$select public.record_payroll_payment_paid(pg_temp.pid(1),
  pg_temp.current_attempt(),2,'bank_transfer','BANKAB12',
  'payment-stale',repeat('0',64))$$,'40001','STALE_VERSION',
  'current attempt rejects a stale cycle version');

select lives_ok($$select public.record_payroll_payment_check(pg_temp.pid(1),
  pg_temp.current_attempt(),3,
  'TRANSFER_RESULT_UNCERTAIN','payment-check-replay',repeat('a',64))$$,
  'first canonical CHECK command succeeds');
create function pg_temp.old_attempt_result_without_transition() returns void language plpgsql as $$
begin
  insert into public.payroll_payment_results(payment_attempt_id,payroll_cycle_id,maid_profile_id,result_type,
    before_status,after_status,cycle_version,locked_amount,reason_code,actor_profile_id,occurred_at)
  select old_attempt.id,cycle.id,cycle.maid_profile_id,'check','paying','check',cycle.version,
    old_attempt.locked_amount,'TRANSFER_RESULT_UNCERTAIN',pg_temp.pid(1),clock_timestamp()
  from public.payroll_cycles cycle join public.payroll_payment_attempts old_attempt
    on old_attempt.payroll_cycle_id=cycle.id and old_attempt.attempt_number=1
  where cycle.maid_profile_id=pg_temp.pid(2) and cycle.week_start=pg_temp.week(-2);
  execute 'set constraints public.payroll_payment_result_requires_transition immediate';
end $$;
select throws_ok($$select pg_temp.old_attempt_result_without_transition()$$,
  '23514','PAYROLL_PAYMENT_EVIDENCE_REQUIRED',
  'result evidence must reference the attempt captured by the exact status transition');
select is((public.record_payroll_payment_check(pg_temp.pid(1),
  pg_temp.current_attempt(),3,
  'TRANSFER_RESULT_UNCERTAIN','payment-check-replay',repeat('a',64))->>'paymentResultId')::uuid,
  (select id from public.payroll_payment_results where payment_attempt_id=pg_temp.current_attempt() and result_type='check'),
  'same canonical command replays the immutable result');
select throws_ok($$select public.record_payroll_payment_check(pg_temp.pid(1),
  pg_temp.current_attempt(),3,
  'TRANSFER_RESULT_UNCERTAIN','payment-check-replay',repeat('b',64))$$,'23505','IDEMPOTENCY_KEY_REUSED',
  'same key with a different canonical request hash fails closed');
select lives_ok($$select public.reopen_payroll_payment_attempt(pg_temp.pid(1),
  pg_temp.current_attempt(),4,'NO_TRANSFER_CONFIRMED',
  'payment-check-reopen',repeat('c',64))$$,'CHECK reopens only with the fixed no-transfer confirmation');
select ok((select status='open' and version=5 and last_reopen_reason='NO_TRANSFER_CONFIRMED'
  from public.payroll_cycles where maid_profile_id=pg_temp.pid(2) and week_start=pg_temp.week(-2)),
  'CHECK reopen preserves its actor/server-time projection without a paid event');

select pg_temp.add_earning(4,6,pg_temp.week(-1),16000);
select public.start_payroll_cycle(pg_temp.pid(1),pg_temp.pid(6),pg_temp.week(-1),0,
  'payment-reference-start',repeat('d',64));
select throws_ok($$select public.record_payroll_payment_paid(pg_temp.pid(1),
  (select attempt.id from public.payroll_payment_attempts attempt join public.payroll_cycles cycle
    on cycle.id=attempt.payroll_cycle_id where cycle.maid_profile_id=pg_temp.pid(6)),1,
  'bank_transfer','ABC-12.XY','payment-duplicate-reference',repeat('e',64))$$,
  '23505','PAYROLL_PAYMENT_REFERENCE_ALREADY_USED','canonical reference is globally unique across cycles');
select ok((select status='paying' and version=1 from public.payroll_cycles
  where maid_profile_id=pg_temp.pid(6) and week_start=pg_temp.week(-1)),
  'duplicate reference rolls back the PAID projection atomically');

create function pg_temp.fail_payment_notification() returns trigger language plpgsql as $$
begin
  if new.contract_version=1 and new.event_family='payroll.payment_check_recorded' then
    raise exception 'TEST_PAYMENT_NOTIFICATION_FAILURE';
  end if;
  return new;
end $$;
create trigger fail_payment_notification before insert on public.notifications
for each row execute function pg_temp.fail_payment_notification();
select throws_ok($$select public.record_payroll_payment_check(pg_temp.pid(1),
  (select attempt.id from public.payroll_payment_attempts attempt join public.payroll_cycles cycle
    on cycle.id=attempt.payroll_cycle_id where cycle.maid_profile_id=pg_temp.pid(6)),1,
  'TRANSFER_RESULT_UNCERTAIN','payment-outbox-failure',repeat('f',64))$$,
  'P0001','TEST_PAYMENT_NOTIFICATION_FAILURE','typed notification failure aborts the whole payment result command');
drop trigger fail_payment_notification on public.notifications;
select ok((select cycle.status='paying' and cycle.version=1
  and not exists(select 1 from public.payroll_payment_results result
    where result.payment_attempt_id=attempt.id)
  and not exists(select 1 from public.audit_events audit
    where audit.idempotency_key=private.audit_command_key(pg_temp.pid(1),'payroll.payment.check','payment-outbox-failure'))
  from public.payroll_cycles cycle join public.payroll_payment_attempts attempt
    on attempt.payroll_cycle_id=cycle.id where cycle.maid_profile_id=pg_temp.pid(6)),
  'failed outbox leaves cycle, result, audit and receipt unchanged');

select throws_ok($$update public.payroll_payment_attempts set attempt_number=99$$,
  '55000','PAYROLL_PAYMENT_EVIDENCE_IMMUTABLE','payment attempt ledger cannot be changed');

select throws_ok($$select public.record_payroll_payment_check(pg_temp.pid(3),
  pg_temp.current_attempt(),4,
  'TRANSFER_RESULT_UNCERTAIN','payment-temp',repeat('1',64))$$,'42501','ADMIN_REQUIRED','temporary-password admin is denied');
select throws_ok($$select public.record_payroll_payment_check(pg_temp.pid(5),
  pg_temp.current_attempt(),4,
  'TRANSFER_RESULT_UNCERTAIN','payment-inactive',repeat('2',64))$$,'42501','ADMIN_REQUIRED','inactive admin is denied');
select throws_ok($$select public.record_payroll_payment_check(pg_temp.pid(4),
  pg_temp.current_attempt(),4,
  'TRANSFER_RESULT_UNCERTAIN','payment-developer',repeat('3',64))$$,'42501','ADMIN_REQUIRED','developer is denied');
select throws_ok($$select public.record_payroll_payment_check(pg_temp.pid(2),
  pg_temp.current_attempt(),4,
  'TRANSFER_RESULT_UNCERTAIN','payment-maid',repeat('4',64))$$,'42501','ADMIN_REQUIRED','maid cannot attest payment');

select ok((select bool_and(after_state::text not like '%ABC-12.XY%' and after_state::text not like '%REF:AB12%')
  from public.audit_events where event_type like 'payroll.payment_%'),'audit payload never contains bank reference');
select ok((select bool_and(body not like '%ABC-12.XY%' and body not like '%REF:AB12%')
  from public.notifications where category like 'payroll_payment_%'),'notification never contains bank reference');
select is((select count(*) from private.notification_delivery_outbox outbox join public.notifications notice
  on notice.id=outbox.notification_id where notice.category in ('payroll_payment_check','payroll_payment_paid',
  'payroll_payment_reopened')),0::bigint,
  'informational payment results are inbox-only');
select ok((select bool_and(summary ? 'status' and summary ? 'version'
  and not summary ? 'paidAmount' and not summary ? 'canonicalReference'
  and summary::text not like '%ABC-12.XY%' and summary::text not like '%REF:AB12%')
  from public.list_developer_audit_events(pg_temp.pid(4),array[
    'payroll.payment_check_recorded','payroll.payment_paid','payroll.payment_reopened'])),
  'developer audit exposes only safe payment status metadata without amount or reference');

set constraints private.payroll_payment_projection_requires_evidence,
  public.payroll_payment_attempt_requires_transition,
  public.payroll_payment_result_requires_transition immediate;
set constraints private.payroll_payment_projection_requires_evidence,
  public.payroll_payment_attempt_requires_transition,
  public.payroll_payment_result_requires_transition deferred;

select ok(not has_table_privilege('authenticated','public.payroll_cycles','SELECT'),
  'authenticated has no table-level payroll cycle SELECT that could expose raw reasons');
select ok(has_column_privilege('authenticated','public.payroll_cycles','id','SELECT')
  and has_column_privilege('authenticated','public.payroll_cycles','status','SELECT')
  and has_column_privilege('authenticated','public.payroll_cycles','version','SELECT')
  and not has_column_privilege('authenticated','public.payroll_cycles','check_reason','SELECT')
  and not has_column_privilege('authenticated','public.payroll_cycles','last_reopen_reason','SELECT'),
  'authenticated receives only safe payroll cycle columns and no raw reason columns');

set local role authenticated;
set local request.jwt.claims='{"sub":"10300000-0000-4000-8000-000000000101","session_id":"10300000-0000-4000-8000-000000000901"}';
select ok((select count(*)>0 from public.payroll_cycles),
  'live exact admin session reads safe payroll cycle columns');
select throws_ok($$select check_reason from public.payroll_cycles$$,'42501',
  'permission denied for table payroll_cycles','admin Data API cannot read raw check reasons');
select throws_ok($$select last_reopen_reason from public.payroll_cycles$$,'42501',
  'permission denied for table payroll_cycles','admin Data API cannot read raw reopen reasons');
select ok((select count(*)>0 from public.payroll_payment_attempts),'live exact admin session reads attempt evidence');
select ok((select count(*)>0 from public.payroll_payment_results),'live exact admin session reads result evidence');
set local request.jwt.claims='{"sub":"10300000-0000-4000-8000-000000000102","session_id":"10300000-0000-4000-8000-000000000902"}';
select ok((select count(*)>0 and bool_and(maid_profile_id=pg_temp.pid(2)) from public.payroll_cycles),
  'live maid reads only their own safe payroll cycle columns');
select throws_ok($$select check_reason from public.payroll_cycles$$,'42501',
  'permission denied for table payroll_cycles','maid Data API cannot read raw check reasons');
select throws_ok($$select last_reopen_reason from public.payroll_cycles$$,'42501',
  'permission denied for table payroll_cycles','maid Data API cannot read raw reopen reasons');
select is((select count(*) from public.payroll_payment_attempts),0::bigint,'maid raw attempt evidence is hidden');
select is((select count(*) from public.payroll_payment_results),0::bigint,'maid raw result/reference evidence is hidden');
set local request.jwt.claims='{"sub":"10300000-0000-4000-8000-000000000101"}';
select is((select count(*) from public.payroll_cycles),0::bigint,'missing live session claim hides safe payroll cycles');
select is((select count(*) from public.payroll_payment_attempts),0::bigint,'missing live session claim hides attempts');
select is((select count(*) from public.payroll_payment_results),0::bigint,'missing live session claim fails closed');
set local request.jwt.claims='{"sub":"10300000-0000-4000-8000-000000000101","session_id":"bad"}';
select is((select count(*) from public.payroll_payment_attempts),0::bigint,'malformed session claim hides attempts');
select is((select count(*) from public.payroll_payment_results),0::bigint,'malformed session claim fails closed');
set local request.jwt.claims='{"sub":"10300000-0000-4000-8000-000000000101","session_id":"10300000-0000-4000-8000-000000000902"}';
select is((select count(*) from public.payroll_payment_attempts),0::bigint,'session bound to another user hides attempts');
select is((select count(*) from public.payroll_payment_results),0::bigint,'session bound to another user fails closed');
set local request.jwt.claims='{"sub":"10300000-0000-4000-8000-000000000103","session_id":"10300000-0000-4000-8000-000000000903"}';
select is((select count(*) from public.payroll_cycles),0::bigint,'temporary-password admin safe payroll cycles are hidden');
select is((select count(*) from public.payroll_payment_results),0::bigint,'temporary-password admin raw evidence is hidden');
set local request.jwt.claims='{"sub":"10300000-0000-4000-8000-000000000104","session_id":"10300000-0000-4000-8000-000000000904"}';
select is((select count(*) from public.payroll_payment_results),0::bigint,'developer raw evidence is hidden');
set local request.jwt.claims='{"sub":"10300000-0000-4000-8000-000000000105","session_id":"10300000-0000-4000-8000-000000000905"}';
select is((select count(*) from public.payroll_payment_results),0::bigint,'inactive admin raw evidence is hidden');
reset role;

select * from finish();
rollback;
