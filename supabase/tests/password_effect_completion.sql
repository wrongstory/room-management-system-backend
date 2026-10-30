begin;
select no_plan();
create function pg_temp.pid(n integer) returns uuid language sql immutable as $$
 select ('54300000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid
$$;
create function pg_temp.start_case(n integer, apply_effect boolean default true) returns void language plpgsql as $$
begin
 insert into auth.users(id) values(pg_temp.pid(100+n));
 insert into auth.sessions(id,user_id) values(pg_temp.pid(900+n),pg_temp.pid(100+n));
 insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,login_sequence,role,status,must_change_password)
 values(pg_temp.pid(n),pg_temp.pid(100+n),'effect '||n,'effect '||n,'effect-'||n,'effect-'||n,0,'maid','active',true);
 perform public.prepare_password_change(pg_temp.pid(n),pg_temp.pid(100+n),pg_temp.pid(900+n),'effect-key-'||n,repeat('a',64),repeat('b',64),repeat('e',64));
 if apply_effect then update auth.users set encrypted_password='synthetic-effect-hash-'||n where id=pg_temp.pid(100+n); end if;
 delete from auth.sessions where id=pg_temp.pid(900+n);
end $$;
create function pg_temp.complete_case(n integer, claim text default repeat('b',64)) returns jsonb language sql as $$
 select public.complete_password_change(pg_temp.pid(n),pg_temp.pid(100+n),pg_temp.pid(900+n),'effect-key-'||n,repeat('a',64),claim)
$$;
select pg_temp.start_case(n) from generate_series(1,6) as cases(n);
select pg_temp.start_case(7,false);
select throws_ok($$select pg_temp.complete_case(2,repeat('c',64))$$,'40001','PASSWORD_CHANGE_CLAIM_STALE','wrong claim cannot finish an effect');
select throws_ok($$select public.complete_password_change(pg_temp.pid(2),pg_temp.pid(102),pg_temp.pid(999),'effect-key-2',repeat('a',64),repeat('b',64))$$,'42501','PASSWORD_CHANGE_SESSION_MISMATCH','different original session cannot take over');
select throws_ok($$select public.complete_password_change(pg_temp.pid(2),pg_temp.pid(102),null,'effect-key-2',repeat('a',64),repeat('b',64))$$,'42501','PASSWORD_CHANGE_SESSION_MISMATCH','null original session cannot take over');
update private.password_change_commands set lease_expires_at=clock_timestamp()-interval '1 second' where actor_profile_id=pg_temp.pid(3);
select throws_ok($$select pg_temp.complete_case(3)$$,'42501','SESSION_REVOKED','expired lease needs separate operator recovery');
update public.profiles set status='inactive' where id=pg_temp.pid(4);
select throws_ok($$select pg_temp.complete_case(4)$$,'42501','ACTIVE_ACCOUNT_REQUIRED','inactive actor cannot complete');
select throws_ok($$select pg_temp.complete_case(7)$$,'40001','PASSWORD_STATE_INCONSISTENT','no Auth effect cannot clear the gate');
select throws_ok($$select public.inspect_password_change(pg_temp.pid(5),pg_temp.pid(105),pg_temp.pid(905),'effect-key-5')$$,'42501','SESSION_REVOKED','inspect still requires a live session');
select throws_ok($$select public.prepare_password_change(pg_temp.pid(5),pg_temp.pid(105),pg_temp.pid(905),'new-effect-key',repeat('a',64),repeat('b',64),repeat('e',64))$$,'42501','SESSION_REVOKED','prepare still requires a live session');
select throws_ok($$select public.complete_password_change(pg_temp.pid(2),pg_temp.pid(102),pg_temp.pid(902),'effect-key-2',null,repeat('b',64))$$,'23505','IDEMPOTENCY_KEY_REUSED','null fingerprint cannot bypass binding');
select throws_ok($$select public.complete_password_change(pg_temp.pid(2),pg_temp.pid(103),pg_temp.pid(902),'effect-key-2',repeat('a',64),repeat('b',64))$$,'42501','ACTIVE_ACCOUNT_REQUIRED','cross Auth identity is rejected');
update auth.users set encrypted_password='second-synthetic-password' where id=pg_temp.pid(106);
select throws_ok($$select pg_temp.complete_case(6)$$,'40001','PASSWORD_STATE_INCONSISTENT','later Auth effect cannot complete older receipt');
insert into auth.sessions(id,user_id) values(pg_temp.pid(905),pg_temp.pid(105));
select public.finish_password_change_failure(pg_temp.pid(5),pg_temp.pid(105),pg_temp.pid(905),'effect-key-5',repeat('b',64),'PASSWORD_STATE_INCONSISTENT');
delete from auth.sessions where id=pg_temp.pid(905);
select throws_ok($$select pg_temp.complete_case(5)$$,'42501','SESSION_REVOKED','inconsistent receipt is not an expired-session capability');
-- Synthetic operator fixture: isolate a prepared reset barrier without mutating the receipt.
update public.profiles set role='admin',must_change_password=false where id=pg_temp.pid(6);
insert into private.command_executions(id,actor_profile_id,command_type,idempotency_key,request_hash,entity_id,response_payload)
values(pg_temp.pid(800),pg_temp.pid(6),'account.password.reset','synthetic-reset-barrier',repeat('f',64),pg_temp.pid(2),'{}'::jsonb);
insert into private.password_reset_auth_markers(command_execution_id,actor_profile_id,target_profile_id,effect_marker,state)
values(pg_temp.pid(800),pg_temp.pid(6),pg_temp.pid(2),repeat('f',64),'prepared');
select throws_ok($$select pg_temp.complete_case(2)$$,'40001','PASSWORD_STATE_INCONSISTENT','prepared reset prevents completion even while old effect still matches');
insert into auth.sessions(id,user_id) values(pg_temp.pid(999),pg_temp.pid(101));
select is(pg_temp.complete_case(1)->>'completed','true','original exact claim completes proven effect without old session');
select is((select state from private.password_change_commands where actor_profile_id=pg_temp.pid(1)),'completed','receipt completed');
select is((select must_change_password from public.profiles where id=pg_temp.pid(1)),false,'first change gate cleared only after proof');
select is((select count(*) from auth.sessions where user_id=pg_temp.pid(101)),0::bigint,'no replacement session is created and other sessions are revoked');
select is((select count(*) from public.audit_events where actor_profile_id=pg_temp.pid(1) and event_type='account.password_changed'),1::bigint,'audit exactly once');
select throws_ok($$select pg_temp.complete_case(1)$$,'42501','SESSION_REVOKED','completed replay without live session is not a new capability');
select is((select count(*) from public.audit_events where actor_profile_id=pg_temp.pid(1) and event_type='account.password_changed'),1::bigint,'rejected replay does not duplicate audit');
select is((select count(*) from private.password_change_commands where state in ('auth_pending','inconsistent')),6::bigint,'negative cases preserve pending evidence');
select * from finish();
rollback;
