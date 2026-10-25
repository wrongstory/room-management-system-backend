-- #396 PREPARED ONLY: run only in the separately approved final DB suite.
-- Synthetic command rows test terminal matching, not business lifecycle effects.
begin;
select no_plan();
create function pg_temp.lifecycle_id(n integer) returns uuid language sql immutable as $$
  select ('f3961370-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid;
$$;
insert into auth.users(id) values(pg_temp.lifecycle_id(1)),(pg_temp.lifecycle_id(2));
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,
  login_id,login_id_normalized,login_sequence,role,status,must_change_password)
values(pg_temp.lifecycle_id(11),pg_temp.lifecycle_id(1),'lifecycle-admin','lifecycle-admin',
  'lifecycle-admin','lifecycle-admin',0,'admin','active',false),
  (pg_temp.lifecycle_id(12),pg_temp.lifecycle_id(2),'lifecycle-maid','lifecycle-maid',
  'lifecycle-maid','lifecycle-maid',0,'maid','active',false);
insert into auth.sessions(id,user_id,not_after)
values(pg_temp.lifecycle_id(21),pg_temp.lifecycle_id(1),null),
  (pg_temp.lifecycle_id(22),pg_temp.lifecycle_id(2),null);
insert into private.developer_operation_control(target_ref,policy_hash,reauth_ttl_seconds,lifecycle)
values('synthetic-target',repeat('a',64),300,'PROVISIONING');
select ok(not has_function_privilege('anon',
  'public.acquire_operation_lifecycle_admission(text,bigint,uuid,uuid,text,text,timestamptz,text,text,text)','EXECUTE'),
  'anon cannot acquire a privileged lifecycle admission');
select ok(not has_function_privilege('authenticated',
  'public.acquire_operation_lifecycle_admission(text,bigint,uuid,uuid,text,text,timestamptz,text,text,text)','EXECUTE'),
  'authenticated cannot acquire directly');
select ok(has_function_privilege('service_role',
  'public.acquire_operation_lifecycle_admission(text,bigint,uuid,uuid,text,text,timestamptz,text,text,text)','EXECUTE'),
  'only trusted service transport uses fresh database authority');
select ok(not has_table_privilege('service_role','private.developer_operation_admissions','UPDATE'),
  'service cannot forge the exact command binding');
create function pg_temp.lifecycle_acquire(n integer,action text default 'allow_finish',
  command_hash text default repeat('c',64)) returns jsonb language sql volatile as $$
  select public.acquire_operation_lifecycle_admission('synthetic-target',1,pg_temp.lifecycle_id(11),
    pg_temp.lifecycle_id(1),pg_temp.lifecycle_id(21)::text,lpad(n::text,64,'0'),
    clock_timestamp()+interval '1 minute',action,'synthetic-lifecycle-key',command_hash);
$$;
select throws_ok($q$select pg_temp.lifecycle_acquire(1,null)$q$,
  '22023','OPERATION_COMMAND_BINDING_REJECTED','NULL action rejected');
select throws_ok($q$select pg_temp.lifecycle_acquire(1,'expire_scheduled')$q$,
  '22023','OPERATION_COMMAND_BINDING_REJECTED','retired expiry action not added');
select throws_ok($q$select pg_temp.lifecycle_acquire(1,'ALLOW_FINISH')$q$,
  '22023','OPERATION_COMMAND_BINDING_REJECTED','action is exact case');
select throws_ok($q$select pg_temp.lifecycle_acquire(1,'allow_finish',null)$q$,
  '22023','OPERATION_COMMAND_BINDING_REJECTED','NULL request hash rejected');
select throws_ok($q$select public.acquire_operation_lifecycle_admission('synthetic-target',1,
  pg_temp.lifecycle_id(12),pg_temp.lifecycle_id(2),pg_temp.lifecycle_id(22)::text,repeat('d',64),
  clock_timestamp()+interval '1 minute','allow_finish','synthetic-lifecycle-key',repeat('c',64))$q$,
  '42501','ADMIN_REQUIRED','active maid cannot claim administrator effect');
select throws_ok($q$select public.acquire_operation_lifecycle_admission('synthetic-target',1,
  pg_temp.lifecycle_id(11),pg_temp.lifecycle_id(2),pg_temp.lifecycle_id(21)::text,repeat('d',64),
  clock_timestamp()+interval '1 minute','allow_finish','synthetic-lifecycle-key',repeat('c',64))$q$,
  '42501','OPERATION_IDENTITY_REJECTED','another Auth user cannot bind the actor');
create temp table lifecycle_admitted as select 1 as n,pg_temp.lifecycle_acquire(1) as receipt
  union all select 2,pg_temp.lifecycle_acquire(2,'allow_upload')
  union all select 3,pg_temp.lifecycle_acquire(3,'interrupt_handover')
  union all select 4,pg_temp.lifecycle_acquire(4,'allow_finish',repeat('d',64));
create function pg_temp.lifecycle_complete(n integer,nonce text default null) returns jsonb language sql volatile as $$
  select public.complete_operation_http_admission(
    (select (receipt->>'admissionId')::uuid from lifecycle_admitted a where a.n=$1),
    coalesce(nonce,lpad(n::text,64,'0')),pg_temp.lifecycle_id(11),pg_temp.lifecycle_id(1),pg_temp.lifecycle_id(21)::text);
$$;
select is((select count(*) from lifecycle_admitted where receipt->>'completionMode'='COMMAND_RECEIPT'),4::bigint,
  'all admitted actions require command receipts');
select throws_ok($q$select pg_temp.lifecycle_complete(1)$q$,'42501','OPERATION_COMPLETION_UNVERIFIED',
  'success without immutable terminal stays unresolved');
insert into private.command_executions(actor_profile_id,command_type,idempotency_key,request_hash,entity_id,response_payload,completed_at)
values(pg_temp.lifecycle_id(11),'cleaning.lifecycle.allow_upload','synthetic-lifecycle-key',repeat('c',64),null,'{}',clock_timestamp());
select throws_ok($q$select pg_temp.lifecycle_complete(1)$q$,'42501','OPERATION_COMPLETION_UNVERIFIED',
  'sibling action terminal cannot complete allow_finish');
select throws_ok($q$select pg_temp.lifecycle_complete(2,repeat('e',64))$q$,'42501','OPERATION_COMPLETION_UNVERIFIED',
  'wrong nonce cannot complete a matching action');
select lives_ok($q$select pg_temp.lifecycle_complete(2)$q$,'exact old/replayed terminal with NULL entity is valid');
insert into private.command_executions(actor_profile_id,command_type,idempotency_key,request_hash,entity_id,response_payload,completed_at)
values(pg_temp.lifecycle_id(11),'cleaning.lifecycle.allow_finish','synthetic-lifecycle-key',repeat('c',64),null,'{}',clock_timestamp()),
  (pg_temp.lifecycle_id(11),'cleaning.lifecycle.interrupt_handover','synthetic-lifecycle-key',repeat('c',64),null,'{}',clock_timestamp());
select throws_ok($q$select pg_temp.lifecycle_complete(4)$q$,'42501','OPERATION_COMPLETION_UNVERIFIED',
  'same action and key with a different hash cannot complete');
update private.developer_operation_control set maintenance='REQUESTED',version=version+1;
select throws_ok($q$select pg_temp.lifecycle_acquire(5)$q$,'42501','OPERATION_ADMISSION_REJECTED',
  'maintenance rejects a new action even after earlier OPEN observation');
select lives_ok($q$select pg_temp.lifecycle_complete(1)$q$,'exact terminal completes after maintenance requested');
select lives_ok($q$select pg_temp.lifecycle_complete(3)$q$,'handover uses its own exact terminal');
select throws_ok($q$select pg_temp.lifecycle_complete(1)$q$,'42501','OPERATION_COMPLETION_UNVERIFIED',
  'terminal completion is one-time');
select is(private.collect_developer_operation_gates()->>'coverage','NOT_INTEGRATED',
  'three action terminal adapters do not prove complete reset coverage');
select * from finish();
rollback;
