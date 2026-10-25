begin;
select no_plan();
-- Rollback-only synthetic fixture. Actual two-session locking is tested by the runner.
create function pg_temp.ceid(n integer) returns uuid language sql immutable as $$
  select ('f330e000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
insert into auth.users(id) select pg_temp.ceid(n+100) from generate_series(0,2) n;
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,login_sequence,role,status,must_change_password)
values(pg_temp.ceid(0),pg_temp.ceid(100),'촛불개발자','촛불개발자','admin','admin',0,'developer','active',false),
  (pg_temp.ceid(1),pg_temp.ceid(101),'만료관리자','만료관리자','candle-expiry-admin','candle-expiry-admin',0,'admin','active',false),
  (pg_temp.ceid(2),pg_temp.ceid(102),'만료메이드','만료메이드','candle-expiry-maid','candle-expiry-maid',0,'maid','active',false);
insert into auth.sessions(id,user_id) select pg_temp.ceid(n+200),pg_temp.ceid(n+100) from generate_series(0,2) n;
create function pg_temp.ceroom() returns uuid language sql as $$select id from public.rooms where room_number='117'$$;
create function pg_temp.cestate() returns text language plpgsql as $$
declare item record; pieces text[] := '{}'; value text;
begin
  for item in select n.nspname schema_name,c.relname table_name from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where c.relkind='r' and (n.nspname in('public','private') or (n.nspname='auth' and c.relname in('users','sessions')))
    order by n.nspname,c.relname
  loop
    execute format('select coalesce(string_agg(to_jsonb(t)::text,''|'' order by to_jsonb(t)::text),'''') from %I.%I t',
      item.schema_name,item.table_name) into value;
    pieces := array_append(pieces,item.schema_name||'.'||item.table_name||':'||value);
  end loop;
  return md5(array_to_string(pieces,'|'));
end $$;
create function pg_temp.ceset(n integer,session uuid,qty integer,key text) returns jsonb language sql as $$
  select public.set_room_candle_count(pg_temp.ceid(n),session,pg_temp.ceroom(),
    (select state_version from public.rooms where id=pg_temp.ceroom()),'CANDLE_ADJUSTED',
    jsonb_build_object('count',qty,'physicallyVerified',true),key,encode(extensions.digest(key||qty::text,'sha256'),'hex'))
$$;
create temporary table candle_expiry_results(label text primary key,value jsonb);

select ok((select bool_and(p.proowner='postgres'::regrole and p.prokind='f' and p.provolatile='v' and p.proparallel='u'
  and p.prosecdef and not p.proisstrict and not p.proleakproof and not p.proretset
  and p.pronargdefaults=0 and p.provariadic=0 and p.proconfig=array['search_path=""']::text[])
  from pg_proc p where p.oid in('private.assert_room_candle_actor(uuid,uuid)'::regprocedure,
    'public.set_room_candle_count(uuid,uuid,uuid,bigint,text,jsonb,text,text)'::regprocedure)),
  'both patched functions retain fixed owner, volatility, definer/search-path and calling attributes');
select is((select prorettype from pg_proc where oid='private.assert_room_candle_actor(uuid,uuid)'::regprocedure),
  'public.profiles'::regtype::oid,'guard return type remains profiles');
select is((select prorettype from pg_proc where oid='public.set_room_candle_count(uuid,uuid,uuid,bigint,text,jsonb,text,text)'::regprocedure),
  'jsonb'::regtype::oid,'command return type remains jsonb');
select ok((select prosrc like '%select not_after into session_not_after%for share;%'
  and prosrc like '%session_not_after <= clock_timestamp()%'
  from pg_proc where oid='private.assert_room_candle_actor(uuid,uuid)'::regprocedure),
  'installed guard evaluates its returned deadline after the Auth SHARE lock');
select is((select (length(prosrc)-length(replace(prosrc,
  'private.assert_room_candle_actor(p_actor_profile_id,p_session_id)','')))/length(
  'private.assert_room_candle_actor(p_actor_profile_id,p_session_id)') from pg_proc
  where oid='public.set_room_candle_count(uuid,uuid,uuid,bigint,text,jsonb,text,text)'::regprocedure),3,
  'entry, post-room-lock and final pre-receipt checks are all installed');
select ok(not has_function_privilege(role_name,'private.assert_room_candle_actor(uuid,uuid)','execute'),
  'private guard direct execute denied to '||role_name) from (values('anon'),('authenticated'),('service_role')) roles(role_name);
select ok(not has_function_privilege(role_name,'public.set_room_candle_count(uuid,uuid,uuid,bigint,text,jsonb,text,text)','execute'),
  'command direct execute denied to '||role_name) from (values('anon'),('authenticated')) roles(role_name);
select ok(has_function_privilege('service_role','public.set_room_candle_count(uuid,uuid,uuid,bigint,text,jsonb,text,text)','execute'),
  'server-only command execute remains allowed');

insert into candle_expiry_results values('null-deadline',pg_temp.ceset(1,pg_temp.ceid(201),4,'candle-expiry-valid-admin'));
update auth.sessions set not_after=clock_timestamp()+interval '1 hour' where id=pg_temp.ceid(202);
insert into candle_expiry_results values('future-deadline',pg_temp.ceset(2,pg_temp.ceid(202),0,'candle-expiry-valid-maid'));
select is(private.current_candle_count(pg_temp.ceroom()),0,'live unrelated maid still resets candle count');
select is(pg_temp.ceset(2,pg_temp.ceid(202),0,'candle-expiry-valid-maid'),
  (select value from candle_expiry_results where label='future-deadline'),'future deadline keeps exact receipt replay');
update auth.sessions set not_after=clock_timestamp()-interval '1 second' where id in(pg_temp.ceid(201),pg_temp.ceid(202));
insert into candle_expiry_results values('before-denials',to_jsonb(pg_temp.cestate()));
select throws_ok($$select pg_temp.ceset(1,pg_temp.ceid(201),2,'candle-expiry-denied-admin')$$,'42501','SESSION_REVOKED','expired admin cannot mutate');
select throws_ok($$select pg_temp.ceset(2,pg_temp.ceid(202),0,'candle-expiry-valid-maid')$$,'42501','SESSION_REVOKED','expired maid cannot replay');
select throws_ok($$select public.list_room_candles(pg_temp.ceid(2),pg_temp.ceid(202),pg_temp.ceroom())$$,
  '42501','SESSION_REVOKED','expired session cannot read minimal candles');
select is(to_jsonb(pg_temp.cestate()),(select value from candle_expiry_results where label='before-denials'),
  'expiry denials preserve every public/private/Auth row, including room, events, audits and receipt');
update auth.sessions set not_after=null where id=pg_temp.ceid(201);
select throws_ok($$select private.assert_room_candle_actor(pg_temp.ceid(1),pg_temp.ceid(202))$$,
  '42501','SESSION_REVOKED','another user cannot lend even an existing session');
select throws_ok($$select private.assert_room_candle_actor(pg_temp.ceid(1),null)$$,
  '42501','SESSION_REVOKED','NULL session is denied');
select throws_ok($$select private.assert_room_candle_actor(pg_temp.ceid(1),pg_temp.ceid(999))$$,
  '42501','SESSION_REVOKED','missing session is denied');

-- Only this synthetic command waits after audit INSERT. Real elapsed DB time,
-- not an Auth UPDATE hook or a mocked clock, exercises the final guard/rollback.
create function pg_temp.candle_expiry_audit_delay() returns trigger language plpgsql as $$
begin
  if new.actor_profile_id=pg_temp.ceid(2) and new.event_type='room.set_candle_count'
    and new.idempotency_key=private.audit_command_key(pg_temp.ceid(2),'room.operation.set_candle_count','candle-late-expiry-fixture') then
    perform pg_sleep(3);
  end if;
  return new;
end $$;
create trigger candle_expiry_fixture_delay after insert on public.audit_events
  for each row execute function pg_temp.candle_expiry_audit_delay();
create function pg_temp.candle_late_expiry_rollback() returns boolean language plpgsql as $$
declare before_state text;
begin
  update auth.sessions set not_after=clock_timestamp()+interval '2 seconds' where id=pg_temp.ceid(202);
  before_state := pg_temp.cestate();
  if not (select not_after>clock_timestamp() from auth.sessions where id=pg_temp.ceid(202)) then
    raise exception 'CANDLE_LATE_EXPIRY_FIXTURE_NOT_LIVE';
  end if;
  begin
    perform pg_temp.ceset(2,pg_temp.ceid(202),1,'candle-late-expiry-fixture');
    raise exception 'CANDLE_LATE_EXPIRY_NOT_DENIED';
  exception when sqlstate '42501' then
    if sqlerrm <> 'SESSION_REVOKED' then raise; end if;
  end;
  return (select not_after<=clock_timestamp() from auth.sessions where id=pg_temp.ceid(202))
    and pg_temp.cestate()=before_state;
end $$;
select is(pg_temp.candle_late_expiry_rollback(),true,
  'late actual hard expiry rolls back already inserted candle/audit, room CAS and attempted receipt');
select is((select count(*) from private.command_executions where actor_profile_id=pg_temp.ceid(2)
  and idempotency_key='candle-late-expiry-fixture'),0::bigint,'denied late command leaves no receipt');
select * from finish();
rollback;
