-- Prepared for the approved final DB verification. Development execution: NOT RUN.
begin;
select no_plan();
select ok(not has_function_privilege('anon','public.execute_operation_atomic_rpc(text,bigint,text,timestamptz,text,jsonb)','EXECUTE'),'anonymous cannot dispatch audit writes');
select ok(not has_function_privilege('authenticated','public.execute_operation_atomic_rpc(text,bigint,text,timestamptz,text,jsonb)','EXECUTE'),'authenticated cannot forge service audit');
select ok(has_function_privilege('service_role','public.execute_operation_atomic_rpc(text,bigint,text,timestamptz,text,jsonb)','EXECUTE'),'only trusted service path is exposed');
select throws_ok($$select public.execute_operation_atomic_rpc('fixture',null,repeat('a',64),clock_timestamp()+interval '5 seconds','execute_operation_atomic_rpc','{}')$$,'22023','OPERATION_ATOMIC_RPC_REJECTED','recursive or arbitrary dispatch rejected');
select throws_ok($$select public.execute_operation_atomic_rpc('fixture',null,repeat('a',64),clock_timestamp()+interval '5 seconds','record_unknown_login_failure','{"sql":"select 1"}')$$,'22023','OPERATION_ATOMIC_RPC_REJECTED','unknown argument cannot reach an effect');
select is(public.execute_operation_atomic_rpc('fixture',null,repeat('a',64),clock_timestamp()+interval '5 seconds','record_unknown_login_failure','{}'),'{"result":null}'::jsonb,'unconfigured mode preserves original DB default and void response');
select is((select count(*) from private.developer_operation_admissions),0::bigint,'unconfigured mode does not invent a readiness receipt');
insert into private.developer_operation_control(singleton,target_ref,policy_hash,reauth_ttl_seconds,lifecycle)
values(true,'fixture',repeat('b',64),60,'PROVISIONING');
select is(public.execute_operation_atomic_rpc('fixture',1,repeat('c',64),clock_timestamp()+interval '5 seconds','record_unknown_login_failure','{}'),'{"result":null}'::jsonb,'active control admits and completes the original audit in one transaction');
select is((select count(*) from private.developer_operation_admissions where completed_at is not null),1::bigint,'actual effect has one completed admission');
select is((select count(*) from private.developer_operation_admissions where completed_at is null),0::bigint,'no external finish call is needed');
select throws_ok($$select public.execute_operation_atomic_rpc('fixture',1,repeat('d',64),clock_timestamp()+interval '5 seconds','record_unknown_login_failure','{"p_occurred_at":null}')$$,'22023','INVALID_ACTIVITY_EVENT','explicit null is not replaced by a default or ignored');
select is((select count(*) from private.developer_operation_admissions),1::bigint,'failed original audit rolls back its admission');
select throws_ok($$select public.execute_operation_atomic_rpc('other-project',1,repeat('e',64),clock_timestamp()+interval '5 seconds','record_unknown_login_failure','{}')$$,'42501','OPERATION_CONTROL_UNAVAILABLE','wrong project blocked before an effect');
update private.developer_operation_control set maintenance='REQUESTED',version=2 where singleton;
select throws_ok($$select public.execute_operation_atomic_rpc('fixture',2,repeat('f',64),clock_timestamp()+interval '5 seconds','record_unknown_login_failure','{}')$$,'42501','OPERATION_CONTROL_UNAVAILABLE','maintenance does not silently omit an audit and report success');
select is((select count(*) from private.developer_operation_admissions),1::bigint,'maintenance rejection creates no false completion');
select * from finish();
rollback;
