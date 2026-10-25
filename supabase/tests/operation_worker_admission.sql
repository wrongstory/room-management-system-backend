-- #396 PREPARED ONLY: rollback-only isolated synthetic DB tests, not executed.
-- Fixture helpers reuse notification_delivery_worker.sql; no external push calls.
begin;
select no_plan();

create function pg_temp.did(n integer) returns uuid language sql immutable as $$
  select ('11100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
create function pg_temp.sha(value text) returns text language sql immutable as $$
  select encode(digest(value,'sha256'),'hex')
$$;
create function pg_temp.register(profile_n integer,user_n integer,session_n integer,subscription_n integer,seed text,expires timestamptz default null)
returns jsonb language sql as $$
  select public.register_web_push_subscription(
    pg_temp.did(profile_n),pg_temp.did(session_n),pg_temp.did(subscription_n),null,null,
    pg_temp.sha('endpoint-'||seed),pg_temp.sha('session-'||seed),pg_temp.sha('material-'||seed),
    expires,'v1',encode(convert_to('sealed-'||seed,'utf8'),'base64'),
    encode(repeat('n',12)::bytea,'base64'),encode(repeat('t',16)::bytea,'base64'),
    'delivery-register-'||seed,pg_temp.sha('request-'||seed),'vapid-v1'
  )
$$;
create function pg_temp.notice(profile_n integer,notice_n integer,outbox_n integer,at_time timestamptz default clock_timestamp())
returns void language plpgsql as $$
begin
  perform set_config('app.notification_writer_mode','typed_v1',true);
  insert into private.notification_groups(id,recipient_profile_id,group_family,scope_kind,scope_id,started_at,ends_at,created_at)
  values(pg_temp.did(notice_n),pg_temp.did(profile_n),'cleaning_assignment_notified','room',pg_temp.did(notice_n),
    at_time,at_time+interval '10 minutes',at_time);
  insert into public.notifications(id,recipient_profile_id,category,title,body,dedupe_key,contract_version,
    actor_profile_id,event_family,source_entity_kind,source_entity_id,deep_link_kind,deep_link_entity_id,
    notification_group_id,requires_action,occurred_at,created_at)
  values(pg_temp.did(notice_n),pg_temp.did(profile_n),'cleaning_assignment_notified','청소 배정','새 청소 배정이 등록되었습니다.',
    'delivery-'||notice_n,1,pg_temp.did(1),'assignment.commit_notified','cleaning_assignment',pg_temp.did(notice_n)::text,
    'cleaningTarget',pg_temp.did(notice_n),pg_temp.did(notice_n),true,at_time,at_time);
  insert into private.notification_delivery_outbox(id,notification_id,event_family,enqueued_at)
  values(pg_temp.did(outbox_n),pg_temp.did(notice_n),'assignment.commit_notified',at_time);
  perform set_config('app.notification_writer_mode','',true);
end $$;

insert into auth.users(id) values(pg_temp.did(101)),(pg_temp.did(102));
insert into auth.sessions(id,user_id) values(pg_temp.did(901),pg_temp.did(101)),(pg_temp.did(902),pg_temp.did(102));
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,login_sequence,role,status,must_change_password)
values(pg_temp.did(1),pg_temp.did(101),'worker admin','worker admin','worker-admin','worker-admin',0,'admin','active',false),
  (pg_temp.did(2),pg_temp.did(102),'worker maid','worker maid','worker-maid','worker-maid',0,'maid','active',false);
select ok(not has_function_privilege('authenticated',
  'public.claim_operation_notification_deliveries(text,text,timestamptz,text,integer)','EXECUTE'),'ordinary callers cannot claim worker authority');
select ok(not has_function_privilege('anon',
  'public.complete_operation_notification_deliveries(text,uuid,text)','EXECUTE'),'anon cannot complete worker effects');
select is(public.claim_operation_notification_deliveries(repeat('a',20),repeat('a',64),clock_timestamp()+interval '1 minute',repeat('a',64),10)->>'admissionId',null,
  'no control preserves legacy work without asserting reset readiness');
insert into private.developer_operation_control(target_ref,policy_hash,reauth_ttl_seconds,lifecycle)
values(repeat('a',20),repeat('a',64),120,'PROVISIONING');
create temp table empty_admission as select public.claim_operation_notification_deliveries(
  repeat('a',20),repeat('b',64),clock_timestamp()+interval '1 minute',repeat('b',64),10) value;
select lives_ok($q$select public.complete_operation_notification_deliveries(repeat('a',20),
  (select (value->>'admissionId')::uuid from empty_admission),repeat('b',64))$q$,'empty actual claim has no provider effects');
select pg_temp.register(2,102,902,1001,'worker');
select pg_temp.notice(2,2001,3001);
create temp table first_admission as select public.claim_operation_notification_deliveries(
  repeat('a',20),repeat('c',64),clock_timestamp()+interval '1 minute',repeat('d',64),10) value;
create temp table first_target as select (value->'claim'->'items'->0->>'targetId')::uuid id from first_admission;
select throws_ok($q$select public.claim_operation_notification_deliveries(repeat('a',20),repeat('e',64),
  clock_timestamp()+interval '1 minute',repeat('d',64),10)$q$,'23505',
  'duplicate key value violates unique constraint "operation_notification_claim_once"',
  'another invocation cannot reuse a claim and borrow its future terminal receipt');
select is(jsonb_array_length((select value->'claim'->'items' from first_admission)),1,'wrapper captures actual claim');
select is(jsonb_array_length((select worker_context->'targets' from private.developer_operation_admissions
  where id=(select (value->>'admissionId')::uuid from first_admission))),1,'same transaction captures immutable attempt');
select throws_ok($q$select public.complete_operation_notification_deliveries(repeat('a',20),
  (select (value->>'admissionId')::uuid from first_admission),repeat('c',64))$q$,
  '42501','OPERATION_WORKER_COMPLETION_UNVERIFIED','claim/HTTP success is not terminal effect proof');
select public.get_notification_delivery_envelope((select id from first_target),1,repeat('d',64));
select public.permit_notification_delivery((select id from first_target),1,repeat('d',64),pg_temp.did(902));
-- Synthetic provider receipt, not a real notification send.
select public.settle_notification_delivery((select id from first_target),1,repeat('d',64),'accepted',null,null);
select throws_ok($q$select public.complete_operation_notification_deliveries(repeat('a',20),
  (select (value->>'admissionId')::uuid from first_admission),repeat('e',64))$q$,
  '42501','OPERATION_WORKER_COMPLETION_UNVERIFIED','different run cannot release completed attempt');
update private.developer_operation_control set maintenance='REQUESTED',version=version+1 where singleton;
select throws_ok($q$select public.claim_operation_notification_deliveries(repeat('a',20),repeat('e',64),
  clock_timestamp()+interval '1 minute',repeat('e',64),10)$q$,'42501','OPERATION_ADMISSION_REJECTED','maintenance rejects new claims before business mutation');
select lives_ok($q$select public.complete_operation_notification_deliveries(repeat('a',20),
  (select (value->>'admissionId')::uuid from first_admission),repeat('c',64))$q$,
  'known terminal work can drain after maintenance is requested');
select throws_ok($q$select public.record_operation_notification_configuration_failure(repeat('a',20),repeat('f',64),clock_timestamp()+interval '1 minute')$q$,
  '42501','OPERATION_ADMISSION_REJECTED','configuration heartbeat cannot bypass requested maintenance');
update private.developer_operation_control set maintenance='OPEN',version=version+1 where singleton;
select lives_ok($q$select public.record_operation_notification_configuration_failure(repeat('a',20),repeat('f',64),clock_timestamp()+interval '1 minute')$q$,
  'configuration heartbeat completes atomically when admission is open');
select is((select status from private.notification_delivery_heartbeat where singleton),'degraded','existing failure audit preserved');
select pg_temp.notice(2,2002,3002);
create temp table retry_admission as select public.claim_operation_notification_deliveries(
  repeat('a',20),repeat('1',64),clock_timestamp()+interval '1 minute',repeat('2',64),10) value;
create temp table retry_target as select (value->'claim'->'items'->0->>'targetId')::uuid id from retry_admission;
select public.get_notification_delivery_envelope((select id from retry_target),1,repeat('2',64));
select public.permit_notification_delivery((select id from retry_target),1,repeat('2',64),pg_temp.did(902));
select public.settle_notification_delivery((select id from retry_target),1,repeat('2',64),'retryable','NETWORK_ERROR',null);
select set_config('app.notification_delivery_writer_mode','typed_v1',true);
update private.notification_delivery_targets set next_attempt_at=clock_timestamp()-interval '1 second' where id=(select id from retry_target);
select set_config('app.notification_delivery_writer_mode','',true);
create temp table later_admission as select public.claim_operation_notification_deliveries(
  repeat('a',20),repeat('3',64),clock_timestamp()+interval '1 minute',repeat('4',64),10) value;
select public.get_notification_delivery_envelope((select id from retry_target),2,repeat('4',64));
select public.permit_notification_delivery((select id from retry_target),2,repeat('4',64),pg_temp.did(902));
select public.settle_notification_delivery((select id from retry_target),2,repeat('4',64),'accepted',null,null);
select is((select status from private.notification_delivery_targets where id=(select id from retry_target)),'delivered','later attempt really completed current target');
select throws_ok($q$select public.complete_operation_notification_deliveries(repeat('a',20),
  (select (value->>'admissionId')::uuid from retry_admission),repeat('1',64))$q$,
  '42501','OPERATION_WORKER_COMPLETION_UNVERIFIED','later success cannot resolve earlier ambiguous remote send');
select lives_ok($q$select public.complete_operation_notification_deliveries(repeat('a',20),
  (select (value->>'admissionId')::uuid from later_admission),repeat('3',64))$q$,
  'only the exact later attempt can complete its own admission');
update private.developer_operation_admissions set created_at=clock_timestamp()-interval '2 minutes',deadline_at=clock_timestamp()-interval '1 minute'
where id=(select (value->>'admissionId')::uuid from retry_admission);
select is(private.collect_developer_operation_gates()->>'expiredUnfinishedAdmissions','1','expired unknown send still blocks reset');
select * from finish();
rollback;
