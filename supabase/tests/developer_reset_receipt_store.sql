-- #396 PREPARED ONLY. Synthetic rollback-only fixtures; actual DB execution NOT RUN.
begin;
select no_plan();
-- Fixed Node requestHash literals, not hashes recomputed by SQL alone.
create temp table receipt_golden as select '{"binding":{"actorProfileId":"11111111-1111-4111-8111-111111111111","authUserId":"22222222-2222-4222-8222-222222222222","sessionDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","passwordVersionDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","projectRef":"aaaaaaaaaaaaaaaaaaaa","sourceCommit":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","catalogFingerprint":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","contentFingerprint":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","planFingerprint":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","expectedPostconditionFingerprint":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","policyHash":"1111111111111111111111111111111111111111111111111111111111111111","approvalScopeHash":"2222222222222222222222222222222222222222222222222222222222222222","backupProofHash":"3333333333333333333333333333333333333333333333333333333333333333"},"header":{"format":"reset-receipt-v1","commandHash":"8e922c58ff1a78b68d407e2a9d6ca5e4278828f26e283b57a923eafe20d27bb1","bindingHash":"4d574c965997cf895bd2a490c68b62e740491683ebfbad8bc7beb38781ad300d","idempotencyKeyDigest":"4444444444444444444444444444444444444444444444444444444444444444","expectedPostconditionFingerprint":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","createdAt":1000,"expiresAt":2000,"steps":[{"id":"5555555555555555555555555555555555555555555555555555555555555555","kind":"DATABASE"}]},"events":[{"sequence":1,"at":1100,"previousHash":"5e13e280f43c42e2304801850f13a5fe3c7d13c106bbe3b1c4a1ec5a597886d1","event":{"type":"STARTED","stepId":"5555555555555555555555555555555555555555555555555555555555555555","bindingHash":"4d574c965997cf895bd2a490c68b62e740491683ebfbad8bc7beb38781ad300d"},"hash":"0dcb7f99a38f77b1537782a6821c4d81770bcce43c451b277b38a56844489f90"},{"sequence":2,"at":1200,"previousHash":"0dcb7f99a38f77b1537782a6821c4d81770bcce43c451b277b38a56844489f90","event":{"type":"OBSERVED","stepId":"5555555555555555555555555555555555555555555555555555555555555555","outcome":"APPLIED","evidenceHash":"6666666666666666666666666666666666666666666666666666666666666666"},"hash":"9d76983a8f1df8544bc09d8ae0a228f6e851eee4878ded2f40066a0c3de51cd0"},{"sequence":3,"at":1300,"previousHash":"9d76983a8f1df8544bc09d8ae0a228f6e851eee4878ded2f40066a0c3de51cd0","event":{"type":"FINAL_VERIFIED","postconditionFingerprint":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","evidenceHash":"7777777777777777777777777777777777777777777777777777777777777777","remoteQuiescent":true},"hash":"356efb80f352d1ed739e1475388ee8dd728bc7ce38c55444211be1c0c22cd7b8"}],"headerHash":"5e13e280f43c42e2304801850f13a5fe3c7d13c106bbe3b1c4a1ec5a597886d1"}'::jsonb value;
select is(private.reset_receipt_hash(value->'binding'),value#>>'{header,bindingHash}','Node and SQL binding canonical hash agree') from receipt_golden;
select is(private.reset_receipt_hash(value->'header'),value->>'headerHash','Node and SQL full header canonical hash agree') from receipt_golden;
select lives_ok(format('select private.validate_reset_receipt(%L::jsonb,%L::jsonb,%L::jsonb,1500)',value->'binding',value->'header',value->'events'),'Node STARTED/OBSERVED/FINAL_VERIFIED hash chain validates in SQL') from receipt_golden;

create temp table receipt_numeric_step as select value->'binding' binding,value->'header' header,
  jsonb_set(value#>'{events,0}','{event,stepId}',to_jsonb(repeat('5',64)::numeric)) entry from receipt_golden;
update receipt_numeric_step set entry=(entry-'hash')||jsonb_build_object('hash',private.reset_receipt_hash(entry-'hash'));
select throws_ok(format('select private.validate_reset_receipt(%L::jsonb,%L::jsonb,%L::jsonb,1500)',
  binding,header,jsonb_build_array(entry)),'22023','RESET_RECEIPT_STEP_REJECTED','numeric JSON step ID cannot impersonate all-digit string hash') from receipt_numeric_step;
create function pg_temp.receipt_id(n integer) returns uuid language sql immutable as $$
  select ('f3961350-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
insert into auth.users(id) values(pg_temp.receipt_id(1));
set local role service_role;
select public.bootstrap_first_developer_profile(pg_temp.receipt_id(11),pg_temp.receipt_id(1),
  'receipt-developer','receipt-developer','0135','receipt-test-phone','receipt-test-bootstrap');
reset role;
insert into auth.sessions(id,user_id,created_at,not_after)
values(pg_temp.receipt_id(21),pg_temp.receipt_id(1),clock_timestamp(),null);
create temp table receipt_input(binding jsonb,header jsonb,entry jsonb);
insert into receipt_input(binding) select jsonb_build_object(
  'actorProfileId',pg_temp.receipt_id(11),'authUserId',pg_temp.receipt_id(1),
  'sessionDigest',private.operation_secret_digest(pg_temp.receipt_id(21)::text),
  'passwordVersionDigest',private.operation_secret_digest(public.get_auth_password_version(pg_temp.receipt_id(1))),
  'projectRef',repeat('a',20),'sourceCommit',repeat('a',40),'catalogFingerprint',repeat('b',64),
  'contentFingerprint',repeat('c',64),'planFingerprint',repeat('d',64),'expectedPostconditionFingerprint',repeat('e',64),
  'policyHash',repeat('f',64),'approvalScopeHash',repeat('1',64),'backupProofHash',repeat('2',64));
update receipt_input set header=jsonb_build_object('bindingHash',private.reset_receipt_hash(binding),
  'idempotencyKeyDigest',repeat('3',64),'expectedPostconditionFingerprint',repeat('e',64),
  'createdAt',floor(extract(epoch from clock_timestamp())*1000)::bigint,
  'expiresAt',floor(extract(epoch from clock_timestamp())*1000)::bigint+60000,
  'steps',jsonb_build_array(jsonb_build_object('id',repeat('4',64),'kind','DATABASE')));
update receipt_input set header=header||jsonb_build_object('format','reset-receipt-v1','commandHash',private.reset_receipt_hash(header));
update receipt_input set entry=jsonb_build_object('sequence',1,'at',floor(extract(epoch from clock_timestamp())*1000)::bigint,
  'previousHash',private.reset_receipt_hash(header),'event',jsonb_build_object('type','STARTED',
    'stepId',repeat('4',64),'bindingHash',header->>'bindingHash'));
update receipt_input set entry=entry||jsonb_build_object('hash',private.reset_receipt_hash(entry));

create function pg_temp.receipt_call(mode text,version integer default 0,head text default null,item jsonb default null)
returns jsonb language sql volatile as $$
  select public.store_developer_reset_receipt(mode,pg_temp.receipt_id(11),pg_temp.receipt_id(1),pg_temp.receipt_id(21)::text,
    binding,header,version,coalesce(head,private.reset_receipt_hash(header)),item) from pg_temp.receipt_input
$$;
select ok(not has_function_privilege('anon','public.store_developer_reset_receipt(text,uuid,uuid,text,jsonb,jsonb,integer,text,jsonb)','EXECUTE'),'anon denied');
select ok(not has_function_privilege('authenticated','public.store_developer_reset_receipt(text,uuid,uuid,text,jsonb,jsonb,integer,text,jsonb)','EXECUTE'),'authenticated denied');
select ok(has_function_privilege('service_role','public.store_developer_reset_receipt(text,uuid,uuid,text,jsonb,jsonb,integer,text,jsonb)','EXECUTE'),'server adapter RPC granted');
select ok(not has_table_privilege('service_role','private.developer_reset_receipt_heads','UPDATE'),'direct CAS overwrite denied');
select ok(not has_table_privilege('service_role','private.developer_reset_receipt_events','INSERT'),'direct event injection denied');
select is(pg_temp.receipt_call('CREATE')#>>'{anchor,version}','0','create persists immutable zero-event head');
select is(pg_temp.receipt_call('CREATE')#>>'{anchor,version}','0','same key create only reads existing journal');
select is((select count(*) from private.developer_reset_receipt_heads),1::bigint,'actor/project/key unique');
select is(pg_temp.receipt_call('APPEND',0,null,(select entry from receipt_input))#>>'{anchor,version}','1','append advances exactly once');
select throws_ok($q$select pg_temp.receipt_call('APPEND',0,null,(select entry from receipt_input))$q$,
  '40001','RESET_RECEIPT_STALE_VERSION','same effect cannot append twice');
select is(pg_temp.receipt_call('READ',1,(select entry->>'hash' from receipt_input))#>>'{anchor,version}','1','exact durable head readback');
select throws_ok($q$select pg_temp.receipt_call('READ',2,repeat('f',64))$q$,
  '22023','RESET_RECEIPT_PREFIX_ROLLBACK','truncated prefix cannot satisfy later anchor');
select throws_ok($q$select pg_temp.receipt_call('READ',1,repeat('f',64))$q$,
  '22023','RESET_RECEIPT_PREFIX_ROLLBACK','same version different head rejected');
select throws_ok($q$update private.developer_reset_receipt_heads set header=header||'{"expiresAt":9999999999999}'::jsonb$q$,
  '42501','RESET_RECEIPT_HEAD_REJECTED','immutable expiry/header cannot change');
select throws_ok($q$update private.developer_reset_receipt_heads set version=0$q$,
  '42501','RESET_RECEIPT_HEAD_REJECTED','prefix rollback cannot rewind durable head');
select throws_ok($q$update private.developer_reset_receipt_events set entry='{}'$q$,
  '42501','RESET_RECEIPT_IMMUTABLE','events cannot be overwritten');
select throws_ok($q$delete from private.developer_reset_receipt_events$q$,
  '42501','RESET_RECEIPT_IMMUTABLE','events cannot be deleted');
select throws_ok($q$truncate private.developer_reset_receipt_events$q$,
  '42501','RESET_RECEIPT_IMMUTABLE','events cannot be truncated');
select throws_ok($q$select private.validate_reset_receipt(binding,header,jsonb_build_array(entry||'{"unknown":"raw"}'::jsonb),
  floor(extract(epoch from clock_timestamp())*1000)::bigint) from receipt_input$q$,
  '22023','RESET_RECEIPT_CHAIN_INVALID','unknown fields cannot enter receipt');
select throws_ok($q$select public.store_developer_reset_receipt('READ',pg_temp.receipt_id(11),pg_temp.receipt_id(1),pg_temp.receipt_id(22)::text,
  binding,header,0,private.reset_receipt_hash(header),null) from receipt_input$q$,
  '42501','OPERATION_ACTOR_REJECTED','absent Auth session rejected');
update public.profiles set must_change_password=true where id=pg_temp.receipt_id(11);
select throws_ok($q$select pg_temp.receipt_call('READ')$q$,
  '42501','OPERATION_ACTOR_REJECTED','latest developer password gate rechecked');
update public.profiles set must_change_password=false where id=pg_temp.receipt_id(11);
create temp table original_password_version as select password_version from private.auth_password_versions where auth_user_id=pg_temp.receipt_id(1);
update private.auth_password_versions set password_version=repeat('0',64) where auth_user_id=pg_temp.receipt_id(1);
select throws_ok($q$select pg_temp.receipt_call('READ')$q$,
  '42501','RESET_RECEIPT_IDENTITY_REJECTED','changed password version invalidates original binding');
update private.auth_password_versions set password_version=(select password_version from original_password_version) where auth_user_id=pg_temp.receipt_id(1);
-- Inject an identity change between the before/after checks; the whole CREATE must rollback.
create function pg_temp.invalidate_receipt_actor() returns trigger language plpgsql as $$
begin update public.profiles set must_change_password=true where id=pg_temp.receipt_id(11); return new; end $$;
create trigger receipt_test_auth_change after insert on private.developer_reset_receipt_heads
for each row execute function pg_temp.invalidate_receipt_actor();
create temp table original_receipt_input as select * from receipt_input;
update receipt_input set header=(header-'commandHash')||jsonb_build_object('idempotencyKeyDigest',repeat('9',64));
update receipt_input set header=header||jsonb_build_object('commandHash',private.reset_receipt_hash(header-'format'));
select throws_ok($q$select pg_temp.receipt_call('CREATE')$q$,
  '42501','OPERATION_ACTOR_REJECTED','post-write identity change rolls back head and all effects');
select is((select count(*) from private.developer_reset_receipt_heads),1::bigint,'failed post-auth creates no new head');
select is((select must_change_password from public.profiles where id=pg_temp.receipt_id(11)),false,'failed transaction also rolls back injected identity change');
drop trigger receipt_test_auth_change on private.developer_reset_receipt_heads;
update receipt_input set header=(select header from original_receipt_input);
delete from auth.sessions where id=pg_temp.receipt_id(21);
select throws_ok($q$select pg_temp.receipt_call('READ')$q$,
  '42501','OPERATION_ACTOR_REJECTED','revoked session cannot read or write journal');
select is(private.developer_reset_disposition_expression('private.developer_reset_receipt_heads','r'),'''preserve''::text','head preserved');
select is(private.developer_reset_disposition_expression('private.developer_reset_receipt_events','r'),'''preserve''::text','events preserved');
select * from finish();
rollback;
