-- Synthetic transactional regression. Execute only during approved final DB validation.
begin;
select no_plan();
create function pg_temp.tid(n integer) returns uuid language sql immutable as $$
 select ('f4520000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
insert into auth.users(id) values(pg_temp.tid(101)),(pg_temp.tid(102));
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,
 login_id,login_id_normalized,login_sequence,role,status,must_change_password) values
 (pg_temp.tid(1),pg_temp.tid(101),'가져오기 테스트','가져오기 테스트','pin-transfer-admin','pin-transfer-admin',0,'admin','active',false),
 (pg_temp.tid(2),pg_temp.tid(102),'가져오기 메이드','가져오기 메이드','pin-transfer-maid','pin-transfer-maid',0,'maid','active',false);
insert into auth.sessions(id,user_id) values(pg_temp.tid(201),pg_temp.tid(101)),(pg_temp.tid(202),pg_temp.tid(102));
create function pg_temp.candidate(n integer) returns jsonb language sql stable as $$
 select jsonb_build_object('roomId',id,'envelopeFormat',1,'keyVersion','test-transfer',
 'ciphertextBase64',encode(digest(id::text||'cipher','sha256'),'base64'),
 'nonceBase64',encode(substring(digest(id::text||'transfer-nonce','sha256') for 12),'base64'),
 'authTagBase64',encode(substring(digest(id::text||'tag','sha256') for 16),'base64'),
 'aadEnvironment','test','aadProjectRef','local') from public.rooms order by id offset n-1 limit 1;
$$;
select throws_ok($$select public.get_room_pin_transfer_snapshot(pg_temp.tid(2),pg_temp.tid(202))$$,
 '42501','ADMIN_REQUIRED','maid cannot export or import');
select throws_ok($$select public.get_room_pin_transfer_snapshot(pg_temp.tid(1),pg_temp.tid(999))$$,
 '42501','SESSION_REVOKED','revoked session cannot export');
select ok(not has_function_privilege('authenticated','public.apply_room_pin_transfer(uuid,uuid,jsonb,jsonb,text,text,integer,timestamptz)','execute'),
 'client cannot invoke service-role import RPC');
create temporary table transfer_snapshot as select private.room_pin_transfer_versions() expected;
select is(public.apply_room_pin_transfer(pg_temp.tid(1),pg_temp.tid(201),null,null,'transfer-test-001',repeat('1',64)),
 null::jsonb,'receipt lookup has no mutation');
select throws_ok($$select public.apply_room_pin_transfer(pg_temp.tid(1),pg_temp.tid(201),
 jsonb_build_array(pg_temp.candidate(1)),'[]','transfer-stale-001',repeat('2',64),0,clock_timestamp()+interval '5 minutes')$$,
 '40001','ROOM_PIN_TRANSFER_STALE','stale snapshot is rejected');
select is(public.apply_room_pin_transfer(pg_temp.tid(1),pg_temp.tid(201),jsonb_build_array(pg_temp.candidate(1)),
 (select expected from transfer_snapshot),'transfer-test-001',repeat('1',64),0,clock_timestamp()+interval '5 minutes'),
 '{"updated":1,"unchanged":0}'::jsonb,'imports one encrypted revision');
select is((select source from private.room_pin_revisions where room_id=(pg_temp.candidate(1)->>'roomId')::uuid order by pin_version desc limit 1),
 'sheet_import','source is explicit');
select is(private.current_pin_sync_status((pg_temp.candidate(1)->>'roomId')::uuid),'mismatch',
 'import does not claim physical verification');
select is(public.apply_room_pin_transfer(pg_temp.tid(1),pg_temp.tid(201),null,null,'transfer-test-001',repeat('1',64)),
 '{"updated":1,"unchanged":0}'::jsonb,'retry returns receipt');
select throws_ok($$select public.apply_room_pin_transfer(pg_temp.tid(1),pg_temp.tid(201),null,null,'transfer-test-001',repeat('2',64))$$,
 '23505','IDEMPOTENCY_KEY_REUSED','different payload cannot reuse receipt');
-- Force failure on a later candidate after an earlier valid insert. The exception rolls back the whole command.
create temporary table before_failure as select count(*) n from private.room_pin_revisions;
select throws_ok($$select public.apply_room_pin_transfer(pg_temp.tid(1),pg_temp.tid(201),
 jsonb_build_array(pg_temp.candidate(2),pg_temp.candidate(3)||'{"nonceBase64":""}'::jsonb),
 private.room_pin_transfer_versions(),'transfer-rollback-001',repeat('3',64),0,clock_timestamp()+interval '5 minutes')$$,
 '23514',null,'invalid second envelope rolls back batch');
select is((select count(*) from private.room_pin_revisions),(select n from before_failure),'no partial revisions after failure');
select is(public.apply_room_pin_transfer(pg_temp.tid(1),pg_temp.tid(201),null,null,'transfer-rollback-001',repeat('3',64)),
 null::jsonb,'failed command has no receipt');
select lives_ok($$select public.get_room_pin_transfer_snapshot(pg_temp.tid(1),pg_temp.tid(201),private.room_pin_transfer_versions(),true)$$,
 'explicit stored-value export audit supports mismatch values');
select * from finish();
rollback;
