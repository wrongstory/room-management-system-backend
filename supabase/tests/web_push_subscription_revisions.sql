begin;
select no_plan();

create function pg_temp.pid(n integer) returns uuid language sql immutable as $$
  select ('11000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
create function pg_temp.call_register(profile_n integer,session_n integer,proposed_n integer,
  expected_n integer,expected_version integer,endpoint_seed text,session_seed text,material_seed text,
  command_key text,expiration_at timestamptz default null) returns jsonb language sql as $$
  select public.register_web_push_subscription(
    pg_temp.pid(profile_n),pg_temp.pid(session_n),pg_temp.pid(proposed_n),
    case when expected_n is null then null else pg_temp.pid(expected_n) end,expected_version,
    encode(digest('endpoint-'||endpoint_seed,'sha256'),'hex'),
    encode(digest('session-'||session_seed,'sha256'),'hex'),
    encode(digest('material-'||material_seed,'sha256'),'hex'),expiration_at,'v1',
    encode(convert_to('sealed-'||material_seed,'utf8'),'base64'),encode(repeat('n',12)::bytea,'base64'),
    encode(repeat('t',16)::bytea,'base64'),command_key,encode(digest(command_key||':'||material_seed,'sha256'),'hex'))
$$;

insert into auth.users(id) select pg_temp.pid(100+n) from generate_series(1,8)n;
insert into auth.sessions(id,user_id) values
  (pg_temp.pid(901),pg_temp.pid(101)),(pg_temp.pid(902),pg_temp.pid(102)),
  (pg_temp.pid(903),pg_temp.pid(103)),(pg_temp.pid(904),pg_temp.pid(104)),
  (pg_temp.pid(905),pg_temp.pid(105)),(pg_temp.pid(906),pg_temp.pid(106)),
  (pg_temp.pid(907),pg_temp.pid(107)),(pg_temp.pid(908),pg_temp.pid(108)),
  (pg_temp.pid(911),pg_temp.pid(108)),(pg_temp.pid(912),pg_temp.pid(108)),
  (pg_temp.pid(913),pg_temp.pid(108)),(pg_temp.pid(914),pg_temp.pid(108));
select public.bootstrap_first_developer_profile(pg_temp.pid(3),pg_temp.pid(103),'push developer','push developer','0110',repeat('d',64),'push-dev-bootstrap');
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,login_sequence,role,status,must_change_password) values
  (pg_temp.pid(1),pg_temp.pid(101),'push admin','push admin','push-admin','push-admin',0,'admin','active',false),
  (pg_temp.pid(2),pg_temp.pid(102),'push maid','push maid','push-maid','push-maid',0,'maid','active',false),
  (pg_temp.pid(4),pg_temp.pid(104),'push inactive','push inactive','push-inactive','push-inactive',0,'admin','inactive',false),
  (pg_temp.pid(5),pg_temp.pid(105),'push temp','push temp','push-temp','push-temp',0,'maid','active',true),
  (pg_temp.pid(6),pg_temp.pid(106),'push limited','push limited','push-limited','push-limited',0,'maid','upload_only',false),
  (pg_temp.pid(7),pg_temp.pid(107),'push other','push other','push-other','push-other',0,'maid','active',false),
  (pg_temp.pid(8),pg_temp.pid(108),'push devices','push devices','push-devices','push-devices',0,'maid','active',false);

select ok(has_function_privilege('service_role','public.register_web_push_subscription(uuid,uuid,uuid,uuid,integer,text,text,text,timestamptz,text,text,text,text,text,text)','EXECUTE'),'service role owns register RPC');
select ok(not has_function_privilege('authenticated','public.register_web_push_subscription(uuid,uuid,uuid,uuid,integer,text,text,text,timestamptz,text,text,text,text,text,text)','EXECUTE'),'authenticated cannot call register RPC');
select ok(not has_function_privilege('anon','public.retire_web_push_subscription(uuid,uuid,uuid,integer,text,text)','EXECUTE'),'anon cannot call retire RPC');
select ok(not has_table_privilege('service_role','private.web_push_subscription_secrets','SELECT'),'service role raw secret SELECT denied');
select ok(not has_table_privilege('service_role','private.web_push_subscriptions','UPDATE'),'service role raw logical UPDATE denied');
select ok(not has_table_privilege('authenticated','private.web_push_subscription_revisions','SELECT'),'authenticated raw revision SELECT denied');
select throws_ok($$insert into private.web_push_subscriptions(id,profile_id,status,version,active_endpoint_digest,active_session_digest,created_at,updated_at)
  values(pg_temp.pid(9901),pg_temp.pid(1),'active',1,repeat('a',64),repeat('b',64),clock_timestamp(),clock_timestamp())$$,
  '55000','WEB_PUSH_LEDGER_IMMUTABLE','fresh session without writer capability cannot mutate the ledger');

create temporary table push_results(label text primary key,value jsonb);
insert into push_results values('first',pg_temp.call_register(1,901,1001,null,null,'a','a','a','push-first-0001'));
insert into push_results values('receipt-replay',pg_temp.call_register(1,901,1999,null,null,'a','a','a','push-first-0001'));
insert into push_results values('logical-replay',pg_temp.call_register(1,901,1998,null,null,'a','a','a','push-logical-0002'));
select is((select value from push_results where label='receipt-replay'),(select value from push_results where label='first'),'same command replay returns exact receipt');
select is((select value->>'id' from push_results where label='logical-replay'),pg_temp.pid(1001)::text,'same material new command reuses logical subscription');
select is((select count(*) from private.web_push_subscriptions where profile_id=pg_temp.pid(1)),1::bigint,'replay creates no duplicate logical row');
select is((select count(*) from private.web_push_subscription_revisions where subscription_id=pg_temp.pid(1001)),1::bigint,'replay creates no revision');
select is((select count(*) from private.web_push_subscription_secrets),1::bigint,'first registration stores one encrypted secret only');

insert into push_results values('rotate-one',pg_temp.call_register(1,901,1001,1001,1,'a','a','b','push-rotate-0003'));
insert into push_results values('rotate-two',pg_temp.call_register(1,901,1001,1001,2,'a','a','c','push-rotate-0004'));
select is((select (value->>'version')::integer from push_results where label='rotate-two'),3,'two rotations advance CAS version');
select is((select count(*) from private.web_push_subscription_revisions where subscription_id=pg_temp.pid(1001)),3::bigint,'rotations append immutable revisions');
select is((select count(*) from private.web_push_subscription_secrets),1::bigint,'rotation crypto-shreds every superseded envelope');
select throws_ok($$select pg_temp.call_register(1,901,1001,1001,1,'a','a','d','push-stale-0005')$$,'40001','WEB_PUSH_STALE_VERSION','stale rotation CAS fails closed');

select throws_ok($$select pg_temp.call_register(2,902,2001,null,null,'a','b','a','push-cross-0001')$$,'23505','WEB_PUSH_ENDPOINT_CONFLICT','cross-profile endpoint conflict reveals no owner');
select throws_ok($$select pg_temp.call_register(2,902,2001,null,null,'b','b','a','push-expired-001','2000-01-01Z')$$,'22023','INVALID_WEB_PUSH_SUBSCRIPTION','past expiration is rejected');
select lives_ok($$select pg_temp.call_register(2,902,2001,null,null,'b','b','a','push-future-0001',clock_timestamp()+interval '1 day')$$,'future expiration is accepted');
select throws_ok($$select pg_temp.call_register(2,999,2999,null,null,'x','x','x','push-revoked-001')$$,'28000','WEB_PUSH_SESSION_REVOKED','missing or revoked session is rejected');
select throws_ok($$select pg_temp.call_register(2,901,2999,null,null,'x','x','x','push-mismatch-01')$$,'28000','WEB_PUSH_SESSION_REVOKED','session user mismatch is rejected');
select throws_ok($$select pg_temp.call_register(3,903,3001,null,null,'d','d','d','push-developer1')$$,'42501','WEB_PUSH_ACCESS_REQUIRED','developer denied');
select throws_ok($$select pg_temp.call_register(4,904,4001,null,null,'i','i','i','push-inactive01')$$,'42501','WEB_PUSH_ACCESS_REQUIRED','inactive denied');
select throws_ok($$select pg_temp.call_register(5,905,5001,null,null,'t','t','t','push-temp-0001')$$,'42501','WEB_PUSH_ACCESS_REQUIRED','temporary password denied');
select throws_ok($$select pg_temp.call_register(6,906,6001,null,null,'l','l','l','push-limited01')$$,'42501','WEB_PUSH_ACCESS_REQUIRED','limited account denied');

do $$begin
  for i in 1..10 loop
    perform pg_temp.call_register(7,907,7000+i,null,null,'rate','rate','rate','push-rate-'||lpad(i::text,4,'0'));
  end loop;
end$$;
select throws_ok($$select pg_temp.call_register(7,907,7099,null,null,'rate','rate','rate','push-rate-0011')$$,
  'P0001','WEB_PUSH_RATE_LIMITED','durable profile limiter saturates at ten registrations per server minute');

select lives_ok($$select pg_temp.call_register(8,908,8001,null,null,'81','81','81','push-device-01')$$,'device one');
select lives_ok($$select pg_temp.call_register(8,911,8002,null,null,'82','82','82','push-device-02')$$,'device two');
select lives_ok($$select pg_temp.call_register(8,912,8003,null,null,'83','83','83','push-device-03')$$,'device three');
select lives_ok($$select pg_temp.call_register(8,913,8004,null,null,'84','84','84','push-device-04')$$,'device four');
select lives_ok($$select pg_temp.call_register(8,914,8005,null,null,'85','85','85','push-device-05')$$,'device five');
insert into auth.sessions(id,user_id) values(pg_temp.pid(915),pg_temp.pid(108));
select throws_ok($$select pg_temp.call_register(8,915,8006,null,null,'86','86','86','push-device-06')$$,'23505','WEB_PUSH_PROFILE_LIMIT','profile active device cap is five without eviction');
select throws_ok($$select pg_temp.call_register(8,908,8099,null,null,'89','81','89','push-session-cap')$$,'40001','WEB_PUSH_CAS_REQUIRED','live session active cap requires explicit rotation');

insert into push_results values('retire',public.retire_web_push_subscription(pg_temp.pid(1),pg_temp.pid(901),pg_temp.pid(1001),3,'push-retire-001',encode(digest('retire-1','sha256'),'hex')));
insert into push_results values('retire-replay',public.retire_web_push_subscription(pg_temp.pid(1),pg_temp.pid(901),pg_temp.pid(1001),3,'push-retire-002',encode(digest('retire-1','sha256'),'hex')));
select is((select value->>'retiredAt' from push_results where label='retire-replay'),(select value->>'retiredAt' from push_results where label='retire'),'retire replay preserves first server timestamp');
select is((select count(*) from private.web_push_subscription_secrets where revision_id in(select id from private.web_push_subscription_revisions where subscription_id=pg_temp.pid(1001))),0::bigint,'retire crypto-shreds ciphertext in the same transaction');
select throws_ok($$select pg_temp.call_register(1,901,1001,1001,4,'a','a','z','push-resurrect1')$$,'P0002','WEB_PUSH_SUBSCRIPTION_CONFLICT','retired logical subscription cannot resurrect');
select throws_ok($$select public.retire_web_push_subscription(pg_temp.pid(7),pg_temp.pid(907),pg_temp.pid(1001),3,'push-cross-ret1',encode(digest('cross','sha256'),'hex'))$$,'P0002','WEB_PUSH_SUBSCRIPTION_NOT_FOUND','cross-owner retire is stable not-found');
select throws_ok($$select public.retire_web_push_subscription(pg_temp.pid(7),pg_temp.pid(907),pg_temp.pid(9999),1,'push-unknown-01',encode(digest('unknown','sha256'),'hex'))$$,'P0002','WEB_PUSH_SUBSCRIPTION_NOT_FOUND','unknown retire is same stable not-found');

select is(current_setting('app.web_push_writer_mode',true),'','writer capability is cleared after success and exceptions');
select throws_ok($$update private.web_push_subscription_revisions set material_digest=repeat('0',64) where subscription_id=pg_temp.pid(1001)$$,'55000','WEB_PUSH_LEDGER_IMMUTABLE','immutable revision cannot be rewritten');
set local role service_role;
select throws_ok($$delete from private.web_push_subscription_secrets$$,'42501',null,'direct service-role crypto-shred is denied');
reset role;

select ok(not exists(select 1 from information_schema.columns where table_schema='private' and table_name like 'web_push%' and column_name in('endpoint','p256dh','auth','session_id','auth_session_id')),'private ledger has no raw endpoint/key/session columns');
select ok(not exists(select 1 from private.web_push_subscription_events e join private.web_push_subscriptions s on s.id=e.subscription_id where e.reason_code ~ 'https|/'),'lifecycle events contain no endpoint host or path');
select ok(not exists(select 1 from private.command_executions c cross join lateral jsonb_object_keys(c.response_payload) k
  where c.command_type like 'web_push.%' and k not in('id','version','status','createdAt','updatedAt','retiredAt')),
  'Web Push receipts contain only the safe logical projection');

select * from finish();
rollback;
