-- #396 SOURCE PREPARED ONLY. Requires separately approved final DB execution.
begin;
select no_plan();
select is(private.collect_developer_operation_gates()->>'lifecycle','UNKNOWN','no seed means UNKNOWN, not pre-operation');
select ok(not has_table_privilege('service_role','private.developer_operation_control','UPDATE'),'service role cannot set lifecycle policy');
select ok(not has_function_privilege('authenticated','public.begin_developer_operation_reauth(uuid,uuid,text,text,bigint,text)','EXECUTE'),'client cannot mint challenges directly');
select ok(not has_function_privilege('service_role','private.transition_developer_operation(uuid,uuid,text,uuid,text,text)','EXECUTE'),'no activation capability exposed to ordinary service role');
select ok(not has_function_privilege('service_role','private.collect_developer_operation_gates()','EXECUTE'),'no unguarded diagnostic read');
select is((select count(*)::integer from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='private' and c.relname in ('developer_operation_control','developer_operation_reauth',
    'developer_operation_admissions','developer_operation_events') and c.relrowsecurity),4,'all new private tables have RLS');
select throws_ok($q$select private.acquire_developer_operation_admission('synthetic-target',1,'BUSINESS_WRITE',repeat('a',64),repeat('b',64),clock_timestamp()+interval '1 minute')$q$,
  '42501','OPERATION_ADMISSION_REJECTED','unconfigured target cannot admit work');
-- Synthetic policy values used only inside this rolled-back test, not production defaults.
insert into private.developer_operation_control(target_ref,policy_hash,reauth_ttl_seconds,lifecycle)
  values('synthetic-target',repeat('c',64),120,'PROVISIONING');
create temp table admission as select private.acquire_developer_operation_admission(
  'synthetic-target',1,'BUSINESS_WRITE',repeat('a',64),repeat('b',64),clock_timestamp()+interval '1 minute') as id;
select is(private.collect_developer_operation_gates()->>'unfinishedAdmissions','1','actual acquired admission is counted');
select throws_ok($q$select private.acquire_developer_operation_admission('wrong-target',1,'BUSINESS_WRITE',repeat('a',64),repeat('b',64),clock_timestamp()+interval '1 minute')$q$,
  '42501','OPERATION_ADMISSION_REJECTED','target binding cannot be substituted');
select throws_ok($q$select private.complete_developer_operation_admission((select id from admission),repeat('a',64),repeat('d',64))$q$,
  '42501','OPERATION_ADMISSION_REJECTED','wrong owner nonce cannot complete work');
update private.developer_operation_control set maintenance='REQUESTED',version=version+1 where singleton;
select throws_ok($q$select private.acquire_developer_operation_admission('synthetic-target',2,'BACKGROUND_WORKER',repeat('a',64),repeat('b',64),clock_timestamp()+interval '1 minute')$q$,
  '42501','OPERATION_ADMISSION_REJECTED','request barrier prevents new integrated work');
select is(private.collect_developer_operation_gates()->>'coverage','NOT_INTEGRATED','request and zero counts cannot assert complete path coverage');
select lives_ok($q$select private.complete_developer_operation_admission((select id from admission),repeat('a',64),repeat('b',64))$q$,
  'existing owner can complete under requested maintenance');
select throws_ok($q$select private.complete_developer_operation_admission((select id from admission),repeat('a',64),repeat('b',64))$q$,
  '42501','OPERATION_ADMISSION_REJECTED','completion capability is consumed once');
insert into private.developer_operation_admissions(control_version,kind,owner_digest,nonce_hash,created_at,deadline_at)
  values(1,'BACKGROUND_WORKER',repeat('a',64),repeat('b',64),clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '1 minute');
select is(private.collect_developer_operation_gates()->>'expiredUnfinishedAdmissions','1','expired external effect remains unknown, never drained');
select throws_ok($q$update private.developer_operation_control set target_ref='another-target',version=version+1$q$,
  '42501','OPERATION_CONTROL_TRANSITION_REJECTED','target is immutable');
select throws_ok($q$update private.developer_operation_control set version=version+2$q$,
  '42501','OPERATION_CONTROL_TRANSITION_REJECTED','control versions advance exactly once');
update private.developer_operation_control set lifecycle='STARTED',started_at=clock_timestamp(),version=version+1 where singleton;
select throws_ok($q$update private.developer_operation_control set lifecycle='PROVISIONING',started_at=null,version=version+1$q$,
  '42501','OPERATION_CONTROL_TRANSITION_REJECTED','operation-start lock cannot reopen');
select throws_ok($q$delete from private.developer_operation_control$q$,'42501','OPERATION_CONTROL_IMMUTABLE','marker cannot be deleted');
select throws_ok($q$select public.begin_developer_operation_reauth(null,null,null,'synthetic-target',3,'START_OPERATION')$q$,
  '42501','OPERATION_ACTOR_REJECTED','unverified actor cannot mint reauthentication');
select ok(not exists(select 1 from pg_proc where proname like '%developer_operation%' and prosecdef
  and not ('search_path=pg_catalog'=any(proconfig))),'all privileged operation functions fix search_path');
select * from finish();
rollback;
