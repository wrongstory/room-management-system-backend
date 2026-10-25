-- PREPARED ONLY: isolated synthetic rollback-only final DB validation. NOT RUN.
begin;
select no_plan();
insert into auth.users(id) values('13300000-0000-4000-8000-000000000101');
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,login_sequence,role,status,must_change_password)
values('13300000-0000-4000-8000-000000000001','13300000-0000-4000-8000-000000000101','scheduler admin','scheduler admin','scheduler-admin','scheduler-admin',0,'admin','active',false);
create function pg_temp.h(command text) returns text language sql immutable as $$
  select encode(extensions.digest('{"command":"'||command||'"}','sha256'),'hex')
$$;
create function pg_temp.acquire(request_id text,nonce text) returns jsonb language sql as $$
  select public.acquire_operation_reservation_scheduler(repeat('a',20),nonce,clock_timestamp()+interval '1 minute',
    '13300000-0000-4000-8000-000000000001','reservation-scheduler-202610250400','2026-10-25 04:00:00+00',request_id,
    pg_temp.h('reservation.process_due_transitions'),pg_temp.h('assignment.process_due_lifecycle'))
$$;
select ok(not has_function_privilege('authenticated','public.complete_operation_reservation_scheduler(text,uuid,text)','EXECUTE'),
  'ordinary sessions cannot clear scheduler admissions');
select is(pg_temp.acquire('inactive',repeat('a',64))->>'admissionId',null,'absence is legacy behavior, not readiness');
insert into private.developer_operation_control(target_ref,policy_hash,reauth_ttl_seconds,lifecycle)
values(repeat('a',20),repeat('a',64),120,'PROVISIONING');
-- An earlier legacy invocation may reuse this request ID and report future
-- client timestamps. Only a NEW server-maintained heartbeat attempt may drain.
select public.record_scheduler_heartbeat('13300000-0000-4000-8000-000000000001','reservation-scheduler-202610250400',
  '2026-10-25 04:00:00+00','succeeded',0,null,clock_timestamp(),clock_timestamp()+interval '1 day','request-one');
create temp table scheduler_admission as select (pg_temp.acquire('request-one',repeat('b',64))->>'admissionId')::uuid id;
select throws_ok($q$select pg_temp.acquire('request-one',repeat('c',64))$q$,'23505',
  'duplicate key value violates unique constraint "operation_scheduler_request_once"','request identity cannot be reused by another run');
select throws_ok($q$select public.complete_operation_reservation_scheduler(repeat('a',20),(select id from scheduler_admission),repeat('b',64))$q$,
  '42501','OPERATION_SCHEDULER_COMPLETION_UNVERIFIED','HTTP success or empty business tables cannot prove completion');
-- Create synthetic immutable command receipts, without running business work.
select private.complete_command('13300000-0000-4000-8000-000000000001','reservation.process_due_transitions.v66',
  'reservation-scheduler-202610250400',pg_temp.h('reservation.process_due_transitions'),null,'{}');
select throws_ok($q$select public.complete_operation_reservation_scheduler(repeat('a',20),(select id from scheduler_admission),repeat('b',64))$q$,
  '42501','OPERATION_SCHEDULER_COMPLETION_UNVERIFIED','one committed phase does not complete the worker');
select private.complete_command('13300000-0000-4000-8000-000000000001','assignment.process_due_lifecycle',
  'reservation-scheduler-202610250400',pg_temp.h('assignment.process_due_lifecycle'),null,'{}');
select throws_ok($q$select public.complete_operation_reservation_scheduler(repeat('a',20),(select id from scheduler_admission),repeat('b',64))$q$,
  '42501','OPERATION_SCHEDULER_COMPLETION_UNVERIFIED','preexisting same-ID future heartbeat plus exact receipts cannot release a new run');
select public.record_scheduler_heartbeat('13300000-0000-4000-8000-000000000001','reservation-scheduler-202610250400',
  '2026-10-25 04:00:00+00','succeeded',0,null,clock_timestamp(),clock_timestamp(),'other-request');
select throws_ok($q$select public.complete_operation_reservation_scheduler(repeat('a',20),(select id from scheduler_admission),repeat('b',64))$q$,
  '42501','OPERATION_SCHEDULER_COMPLETION_UNVERIFIED','later or different heartbeat cannot release this request');
select public.record_scheduler_heartbeat('13300000-0000-4000-8000-000000000001','reservation-scheduler-202610250400',
  '2026-10-25 04:00:00+00','failed',null,'RESERVATION_SCHEDULER_FAILED',clock_timestamp(),clock_timestamp(),'request-one');
select throws_ok($q$select public.complete_operation_reservation_scheduler(repeat('a',20),(select id from scheduler_admission),repeat('b',64))$q$,
  '42501','OPERATION_SCHEDULER_COMPLETION_UNVERIFIED','failed heartbeat cannot complete work');
update private.developer_operation_control set maintenance='REQUESTED',version=version+1 where singleton;
select throws_ok($q$select pg_temp.acquire('request-two',repeat('d',64))$q$,'42501','OPERATION_ADMISSION_REJECTED',
  'maintenance stops new scheduler work before business commands');
select public.record_scheduler_heartbeat('13300000-0000-4000-8000-000000000001','reservation-scheduler-202610250400',
  '2026-10-25 04:00:00+00','succeeded',0,null,clock_timestamp(),clock_timestamp(),'request-one');
select throws_ok($q$select public.complete_operation_reservation_scheduler(repeat('a',20),(select id from scheduler_admission),repeat('e',64))$q$,
  '42501','OPERATION_SCHEDULER_COMPLETION_UNVERIFIED','wrong nonce cannot borrow exact receipts');
select lives_ok($q$select public.complete_operation_reservation_scheduler(repeat('a',20),(select id from scheduler_admission),repeat('b',64))$q$,
  'both immutable receipts plus exact successful heartbeat drain existing work during maintenance');
select * from finish();
rollback;
