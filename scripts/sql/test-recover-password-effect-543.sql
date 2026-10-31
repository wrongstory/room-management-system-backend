-- psql only, isolated disposable/test DB with the existing password schema.
-- Requires separate execution approval. No migrations or DB reset. All changes roll back.
\set ON_ERROR_STOP on
begin;
\ir recover-password-effect-543.sql
-- Self-contained assertions: no extension install or schema upgrade required.
create function pg_temp.assert_same(actual anyelement, expected anyelement, label text)
returns text language plpgsql as $$
begin
 if actual is distinct from expected then raise exception 'ASSERTION_FAILED: %',label; end if;
 return 'PASS: '||label;
end $$;
create function pg_temp.assert_throws(statement text, expected_state text, expected_message text, label text)
returns text language plpgsql as $$
declare caught_state text; caught_message text;
begin
 begin
  execute statement;
 exception when others then
  get stacked diagnostics caught_state=returned_sqlstate,caught_message=message_text;
 end;
 if caught_state is distinct from expected_state or caught_message is distinct from expected_message then
  raise exception 'ASSERTION_FAILED: % (state %, message %)',label,caught_state,caught_message;
 end if;
 return 'PASS: '||label;
end $$;
create function pg_temp.fixture_id(n integer) returns uuid language sql immutable as $$
 select ('54310000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
create temporary table recovery_cases(n integer, c jsonb,p jsonb,v jsonb);
do $$
declare n integer;
begin
 for n in 1..4 loop
  insert into auth.users(id) values(pg_temp.fixture_id(100+n));
  insert into auth.sessions(id,user_id) values(pg_temp.fixture_id(900+n),pg_temp.fixture_id(100+n));
  insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,login_sequence,role,status,must_change_password)
  values(pg_temp.fixture_id(n),pg_temp.fixture_id(100+n),'recovery '||n,'recovery '||n,'recovery-'||n,'recovery-'||n,0,'maid','active',false);
  -- Create synthetic historical input once; immutable receipt history stays immutable.
  insert into private.password_change_commands(actor_profile_id,auth_user_id,idempotency_key,request_hash,effect_marker,session_digest,state,claim_digest,lease_expires_at,created_at,updated_at)
  values(pg_temp.fixture_id(n),pg_temp.fixture_id(100+n),'recover-key-'||n,repeat('a',64),repeat('e',64),private.password_change_session_digest(pg_temp.fixture_id(900+n)),'auth_pending',repeat('b',64),clock_timestamp()-interval '30 minutes',clock_timestamp()-interval '1 hour',clock_timestamp()-interval '1 hour');
  update auth.users set encrypted_password='synthetic-recovery-'||n where id=pg_temp.fixture_id(100+n);
  delete from auth.sessions where id=pg_temp.fixture_id(900+n);
  insert into recovery_cases
  select n,to_jsonb(c),jsonb_build_object('id',p.id,'auth_user_id',p.auth_user_id,'status',p.status,'role',p.role,'must_change_password',p.must_change_password,'failed_login_count',p.failed_login_count,'locked_until',p.locked_until),to_jsonb(v)
  from private.password_change_commands c join public.profiles p on p.id=c.actor_profile_id
  join private.auth_password_versions v on v.auth_user_id=c.auth_user_id where p.id=pg_temp.fixture_id(n);
 end loop;
end $$;
select pg_temp.assert_throws($$select pg_temp.recover_password_effect_543(c,p,v,clock_timestamp()) from recovery_cases where n=1$$,'P0001','PASSWORD_WRITERS_NOT_DRAINED','insufficient pause is rejected');
select pg_temp.assert_throws($$select pg_temp.recover_password_effect_543(c,p,v,clock_timestamp()-interval '16 minutes') from recovery_cases where n=1$$,'P0001','PASSWORD_WRITERS_NOT_PAUSED','open writer ACL is rejected');
revoke execute on function public.prepare_password_change(uuid,uuid,uuid,text,text,text,text) from service_role;
revoke execute on function public.prepare_account_password_reset(uuid,uuid,text,text) from service_role;
revoke execute on function public.prepare_password_change_admin_reset(uuid,uuid,text,text,text) from service_role;
create function pg_temp.run_recovery(n integer) returns text language sql as $$
 select pg_temp.recover_password_effect_543(c,p,v,clock_timestamp()-interval '16 minutes') from recovery_cases where recovery_cases.n=$1
$$;
insert into auth.sessions(id,user_id) values(pg_temp.fixture_id(998),pg_temp.fixture_id(101)),(pg_temp.fixture_id(997),pg_temp.fixture_id(102));
select pg_temp.assert_same(pg_temp.run_recovery(1),'completed','exact proven effect completes');
select pg_temp.assert_same((select count(*) from auth.sessions where id=pg_temp.fixture_id(998)),0::bigint,'target current session revoked');
select pg_temp.assert_same((select count(*) from auth.sessions where id=pg_temp.fixture_id(997)),1::bigint,'other account session preserved');
insert into auth.sessions(id,user_id) values(pg_temp.fixture_id(999),pg_temp.fixture_id(101));
select pg_temp.assert_same(pg_temp.run_recovery(1),'already_completed','repeat is a no-op');
select pg_temp.assert_same((select count(*) from auth.sessions where id=pg_temp.fixture_id(999)),1::bigint,'repeat preserves new login');
select pg_temp.assert_same((select count(*) from public.audit_events where actor_profile_id=pg_temp.fixture_id(1) and event_type='account.password_changed'),1::bigint,'exactly one audit');
select pg_temp.assert_same((select to_jsonb(v) from private.auth_password_versions v where auth_user_id=pg_temp.fixture_id(101)),(select v from recovery_cases where n=1),'password effect and rotation unchanged');
update public.profiles set failed_login_count=1 where id=pg_temp.fixture_id(2);
select pg_temp.assert_throws($$select pg_temp.run_recovery(2)$$,'P0001','RECOVERY_SNAPSHOT_CHANGED','later login failures preserved');
update auth.users set encrypted_password='another-synthetic-effect' where id=pg_temp.fixture_id(103);
select pg_temp.assert_throws($$select pg_temp.run_recovery(3)$$,'P0001','PASSWORD_EFFECT_CHANGED','later Auth effect blocks recovery');
insert into public.audit_events(actor_profile_id,event_type,entity_type,entity_id,effective_at,after_state,request_hash,idempotency_key)
select pg_temp.fixture_id(2),'account.password_changed','profile',pg_temp.fixture_id(4),clock_timestamp(),jsonb_build_object('mustChangePassword',false),c->>'request_hash',private.password_change_audit_key(pg_temp.fixture_id(4),c->>'idempotency_key') from recovery_cases where n=4;
select pg_temp.assert_throws($$select pg_temp.run_recovery(4)$$,'P0001','RECOVERY_SNAPSHOT_CHANGED','any existing audit key blocks recovery');
select pg_temp.assert_same((select count(*) from private.password_change_commands where actor_profile_id in(pg_temp.fixture_id(2),pg_temp.fixture_id(3),pg_temp.fixture_id(4)) and state='auth_pending'),3::bigint,'negative cases preserve pending receipts');

rollback;
