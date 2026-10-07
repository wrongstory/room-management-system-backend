begin;
select no_plan();
create function pg_temp.cid(n integer) returns uuid language sql immutable as $$
  select ('33000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
insert into auth.users(id) select pg_temp.cid(n+100) from generate_series(1,9) n;
-- Developer must be bootstrapped first; all records below are synthetic and rolled back.
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,login_sequence,role,status,must_change_password)
values(pg_temp.cid(4),pg_temp.cid(104),'개발자','개발자','admin','admin',0,'developer','active',false);
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,login_sequence,role,status,must_change_password)
select pg_temp.cid(n),pg_temp.cid(n+100),'촛불'||n,'촛불'||n,'candle-'||n,'candle-'||n,0,
  (case when n=1 then 'admin' else 'maid' end)::public.app_role,
  (case n when 5 then 'inactive' when 6 then 'departed' when 7 then 'upload_only' when 8 then 'deactivation_pending' else 'active' end)::public.account_status,n=9
from generate_series(1,9) n where n<>4;
insert into auth.sessions(id,user_id) select pg_temp.cid(n+200),pg_temp.cid(n+100) from generate_series(1,9) n;
create function pg_temp.croom() returns uuid language sql as $$select id from public.rooms where room_number='117'$$;
create function pg_temp.cset(n integer, qty integer, version bigint, key text, verified boolean default true)
returns jsonb language sql as $$
  select public.set_room_candle_count(pg_temp.cid(n),pg_temp.cid(n+200),pg_temp.croom(),version,'CANDLE_ADJUSTED',
    jsonb_build_object('count',qty,'physicallyVerified',verified),key,encode(extensions.digest(key||qty::text,'sha256'),'hex'))
$$;
create temporary table candle_results(name text primary key, value jsonb);
insert into candle_results values('admin',pg_temp.cset(1,4,(select state_version from public.rooms where id=pg_temp.croom()),'candle-admin-1'));
select is(private.current_candle_count(pg_temp.croom()),4,'admin adds current count');
insert into candle_results values('maid',pg_temp.cset(2,2,(select state_version from public.rooms where id=pg_temp.croom()),'candle-maid-1'));
select is(private.current_candle_count(pg_temp.croom()),2,'unassigned maid decreases');
insert into candle_results values('other',pg_temp.cset(3,0,(select state_version from public.rooms where id=pg_temp.croom()),'candle-other-1'));
select is(private.current_candle_count(pg_temp.croom()),0,'another unassigned maid resets without administrator approval');
select is(pg_temp.cset(3,0,1,'candle-other-1'),(select value from candle_results where name='other'),'same key/hash replays before CAS');
select throws_ok($$select pg_temp.cset(3,1,1,'candle-other-1')$$,'23505','IDEMPOTENCY_KEY_REUSED','different payload conflicts');
select throws_ok($$select pg_temp.cset(2,1,1,'candle-stale-1')$$,'40001','STALE_VERSION','stale room CAS rejected');
select is((select count(*) from public.room_candle_events where room_id=pg_temp.croom()),3::bigint,'replay and conflicts create no extra events');
select is((select count(*) from public.audit_events where entity_id=pg_temp.croom() and event_type='room.set_candle_count'),3::bigint,'one audit per successful adjustment');
select is((select count(distinct recorded_at) from public.room_candle_events where room_id=pg_temp.croom()),3::bigint,'same-transaction recording timestamps preserve event order');
insert into candle_results values('more',pg_temp.cset(1,3,(select state_version from public.rooms where id=pg_temp.croom()),'candle-more-1'));
select throws_ok($$select pg_temp.cset(2,0,(select state_version from public.rooms where id=pg_temp.croom()),'candle-unverified-1',false)$$,
 '22023','CANDLE_VERIFICATION_REQUIRED','decrease requires onsite confirmation, not admin approval');
insert into public.room_operation_blocks(room_id,reason_code,created_by,starts_at) values(pg_temp.croom(),'UNRELATED_BLOCK',pg_temp.cid(1),now());
insert into candle_results values('reset',pg_temp.cset(2,0,(select state_version from public.rooms where id=pg_temp.croom()),'candle-reset-2'));
select is((select count(*) from public.room_operation_blocks where room_id=pg_temp.croom() and released_at is null),1::bigint,'reset never releases unrelated block');
select ok((select allocation_blocked and not allocation_ready and 'OPERATION_BLOCKED'=any(reason_codes) and not ('CANDLE_PRESENT'=any(reason_codes))
 from public.get_room_operational_projection(pg_temp.cid(1),pg_temp.croom())),'zero clears only candle readiness reason');
insert into candle_results values('legacy',public.mutate_room_operation(pg_temp.cid(1),pg_temp.croom(),'set_candle_count',
 (select state_version from public.rooms where id=pg_temp.croom()),'CANDLE_ADJUSTED','{"count":0,"physicallyVerified":true}',
 'legacy-candle-replay',repeat('a',64)));
select is(public.set_room_candle_count(pg_temp.cid(1),pg_temp.cid(201),pg_temp.croom(),1,'CANDLE_ADJUSTED',
 '{"count":0,"physicallyVerified":true}','legacy-candle-replay',repeat('a',64)),
 (select value from candle_results where name='legacy'),'pre-upgrade admin command receipt replays unchanged');
select ok((select bool_and(actor_profile_id in (pg_temp.cid(1),pg_temp.cid(2),pg_temp.cid(3))) from public.room_candle_events),'actor provenance retained');
select is((public.list_room_candles(pg_temp.cid(2),pg_temp.cid(202),pg_temp.croom())#>>'{items,0,count}')::integer,0,'minimal maid lookup shows latest count');
select is((select count(*) from jsonb_object_keys(public.list_room_candles(pg_temp.cid(3),pg_temp.cid(203),pg_temp.croom())#>'{items,0}')),4::bigint,'only four safe room fields');
select is(jsonb_array_length(public.list_room_candles(pg_temp.cid(2),pg_temp.cid(202),null,null,1)->'items'),1,'bounded first page');
select isnt((public.list_room_candles(pg_temp.cid(2),pg_temp.cid(202),null,null,1)#>>'{items,0,roomId}'),
 (public.list_room_candles(pg_temp.cid(2),pg_temp.cid(202),null,(public.list_room_candles(pg_temp.cid(2),pg_temp.cid(202),null,null,1)->>'nextCursor')::uuid,1)#>>'{items,0,roomId}'),'keyset advances without duplicates');
select throws_ok(format('select public.list_room_candles(%L,%L,null,null,51)',pg_temp.cid(2),pg_temp.cid(202)),'22023','INVALID_CANDLE_REQUEST','page overflow rejected');
select throws_ok(format('select public.list_room_candles(%L,%L,%L,%L,1)',pg_temp.cid(2),pg_temp.cid(202),pg_temp.croom(),pg_temp.croom()),'22023','INVALID_CANDLE_REQUEST','filter/cursor mixing rejected');
select throws_ok(format('select pg_temp.cset(%s,1,1,%L)',n,'candle-denied-'||n),'42501','CANDLE_ACCESS_REQUIRED','role/status denied '||n) from generate_series(4,8)n;
select throws_ok(format('select public.list_room_candles(%L,%L)',pg_temp.cid(n),pg_temp.cid(n+200)),'42501','CANDLE_ACCESS_REQUIRED','read role/status denied '||n) from generate_series(4,8)n;
select throws_ok($$select pg_temp.cset(9,1,1,'candle-password-1')$$,'42501','PASSWORD_CHANGE_REQUIRED','password change gate');
select throws_ok(format('select public.list_room_candles(%L,%L)',pg_temp.cid(2),pg_temp.cid(203)),'42501','SESSION_REVOKED','cross-user session denied');
select set_config('test.candle_room_id',pg_temp.croom()::text,true);
set local role service_role;
select is(jsonb_array_length(public.list_room_candles('33000000-0000-4000-8000-000000000002',
 '33000000-0000-4000-8000-000000000202',current_setting('test.candle_room_id')::uuid)->'items'),1,'actual service role can read narrow projection');
select lives_ok($$select public.set_room_candle_count('33000000-0000-4000-8000-000000000001',
 '33000000-0000-4000-8000-000000000201',current_setting('test.candle_room_id')::uuid,1,
 'CANDLE_ADJUSTED','{"count":0,"physicallyVerified":true}','legacy-candle-replay',repeat('a',64))$$,'actual service role replays narrow command');
reset role;
set local role anon;
select throws_ok($$select public.list_room_candles(null,null)$$,'42501',null,'actual anonymous RPC denied');
reset role;
select set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.cid(102),'role','authenticated','session_id',pg_temp.cid(202))::text,true);
set local role authenticated;
select throws_ok($$select public.list_room_candles(null,null)$$,'42501',null,'actual authenticated direct RPC denied');
select throws_ok($$insert into public.room_candle_events(room_id,count_before,count_after,reason_code,actor_profile_id,effective_at)
 values(current_setting('test.candle_room_id')::uuid,0,1,'DIRECT_WRITE','33000000-0000-4000-8000-000000000002',now())$$,
 '42501',null,'actual maid direct event insert denied');
reset role;
update auth.sessions set not_after=clock_timestamp()-interval '1 second' where id=pg_temp.cid(202);
select throws_ok(format('select public.list_room_candles(%L,%L)',pg_temp.cid(2),pg_temp.cid(202)),'42501','SESSION_REVOKED','expired session denied');
delete from auth.sessions where id=pg_temp.cid(203);
select throws_ok($$select pg_temp.cset(3,0,1,'candle-other-1')$$,'42501','SESSION_REVOKED','revoked session cannot replay');
select throws_ok(format('select public.mutate_room_operation(%L,%L,%L,1,%L,%L,%L,%L)',pg_temp.cid(2),pg_temp.croom(),'create_block','BLOCK','{}','candle-forbidden-block',repeat('1',64)),
 '42501','ADMIN_REQUIRED','generic operation remains admin only');
select ok(has_function_privilege('service_role','public.set_room_candle_count(uuid,uuid,uuid,bigint,text,jsonb,text,text)','execute'),'service role executes narrow command');
select ok(not has_function_privilege(role_name,'public.set_room_candle_count(uuid,uuid,uuid,bigint,text,jsonb,text,text)','execute')
 and not has_function_privilege(role_name,'public.list_room_candles(uuid,uuid,uuid,uuid,integer)','execute'),'direct RPC denied '||role_name)
from (values('anon'),('authenticated')) roles(role_name);
select ok(not has_function_privilege('service_role','private.assert_room_candle_actor(uuid,uuid)','execute'),'private helper not exposed');
select ok((select relrowsecurity from pg_class where oid='public.room_candle_events'::regclass),'event RLS retained');
select throws_ok($$select pg_temp.cset(1,-1,1,'negative-candle')$$,'22023','INVALID_CANDLE_REQUEST','negative quantity denied');
select throws_ok(format('select public.set_room_candle_count(%L,%L,%L,1,%L,%L,%L,%L)',pg_temp.cid(1),pg_temp.cid(201),pg_temp.croom(),'CANDLE_ADJUSTED','{"count":2147483648}','overflow-candle',repeat('1',64)),
 '22023','INVALID_CANDLE_REQUEST','integer overflow denied');
select throws_ok($$update public.room_candle_events set count_after=10 where room_id=pg_temp.croom()$$,'55000',null,'history cannot be updated');
select * from finish();
rollback;
