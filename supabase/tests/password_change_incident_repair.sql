begin;
select no_plan();
\ir password_change_incident_repair_helper.psql

insert into auth.users(id) values ('53500000-0000-4000-8000-000000000001');
insert into auth.sessions(id,user_id) values ('53500000-0000-4000-8000-000000000003','53500000-0000-4000-8000-000000000001');
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,login_sequence,role,status,must_change_password)
values ('53500000-0000-4000-8000-000000000002','53500000-0000-4000-8000-000000000001','repair fixture','repair fixture','repair-fixture','repair-fixture',0,'maid','active',true);
-- Only synthetic fixture timestamps are changed; production helper never changes versions.
update private.auth_password_versions set password_version=repeat('a',64),rotated_at=now()-interval '2 hours'
where auth_user_id='53500000-0000-4000-8000-000000000001';
insert into private.password_change_commands(id,actor_profile_id,auth_user_id,idempotency_key,request_hash,effect_marker,session_digest,state,claim_digest,lease_expires_at,created_at,updated_at)
values ('53500000-0000-4000-8000-000000000004','53500000-0000-4000-8000-000000000002','53500000-0000-4000-8000-000000000001','repair-old-key',repeat('b',64),repeat('c',64),private.password_change_session_digest('53500000-0000-4000-8000-000000000003'),'auth_pending',repeat('d',64),now()-interval '59 minutes',now()-interval '1 hour',now()-interval '1 hour');

select throws_ok($$select pg_temp.repair_unstarted_password_change('53500000-0000-4000-8000-000000000004',now()-interval '1 hour',now()-interval '1 hour',repeat('a',64),now())$$,'P0001','PASSWORD_REPAIR_EVIDENCE_REQUIRED','recent executions are not drained');
select throws_ok($$select pg_temp.repair_unstarted_password_change('53500000-0000-4000-8000-000000000004',now()-interval '1 hour',now()-interval '1 hour',repeat('f',64),now()-interval '30 minutes')$$,'P0001','PASSWORD_REPAIR_STATE_CHANGED','changed Auth version blocks repair');
select throws_ok($$select pg_temp.repair_unstarted_password_change('53500000-0000-4000-8000-000000000004',now()-interval '1 hour',now(),repeat('a',64),now()-interval '30 minutes')$$,'P0001','PASSWORD_REPAIR_STATE_CHANGED','stale receipt snapshot blocks repair');
update private.password_change_commands set lease_expires_at=now()+interval '1 minute' where id='53500000-0000-4000-8000-000000000004';
select throws_ok($$select pg_temp.repair_unstarted_password_change('53500000-0000-4000-8000-000000000004',now()-interval '1 hour',now()-interval '1 hour',repeat('a',64),now()-interval '30 minutes')$$,'P0001','PASSWORD_REPAIR_STATE_CHANGED','active lease blocks repair');
update private.password_change_commands set lease_expires_at=now()-interval '59 minutes' where id='53500000-0000-4000-8000-000000000004';

select ok(not has_function_privilege('service_role','pg_temp.repair_unstarted_password_change(uuid,timestamptz,timestamptz,text,timestamptz)','EXECUTE'),'service role cannot repair');
select ok(not has_function_privilege('authenticated','pg_temp.repair_unstarted_password_change(uuid,timestamptz,timestamptz,text,timestamptz)','EXECUTE'),'authenticated cannot repair');
select ok(not has_function_privilege('anon','pg_temp.repair_unstarted_password_change(uuid,timestamptz,timestamptz,text,timestamptz)','EXECUTE'),'anon cannot repair');
update private.auth_password_versions set rotated_at=now() where auth_user_id='53500000-0000-4000-8000-000000000001';
select throws_ok($$select pg_temp.repair_unstarted_password_change('53500000-0000-4000-8000-000000000004',now()-interval '1 hour',now()-interval '1 hour',repeat('a',64),now()-interval '30 minutes')$$,'P0001','PASSWORD_REPAIR_STATE_CHANGED','later password mutation blocks repair');
update private.auth_password_versions set rotated_at=now()-interval '2 hours' where auth_user_id='53500000-0000-4000-8000-000000000001';
update private.password_change_commands set attempt_count=2 where id='53500000-0000-4000-8000-000000000004';
select throws_ok($$select pg_temp.repair_unstarted_password_change('53500000-0000-4000-8000-000000000004',now()-interval '1 hour',now()-interval '1 hour',repeat('a',64),now()-interval '30 minutes')$$,'P0001','PASSWORD_REPAIR_STATE_CHANGED','reclaimed receipt blocks repair');
update private.password_change_commands set attempt_count=1 where id='53500000-0000-4000-8000-000000000004';
update public.profiles set must_change_password=false where id='53500000-0000-4000-8000-000000000002';
select throws_ok($$select pg_temp.repair_unstarted_password_change('53500000-0000-4000-8000-000000000004',now()-interval '1 hour',now()-interval '1 hour',repeat('a',64),now()-interval '30 minutes')$$,'P0001','PASSWORD_REPAIR_STATE_CHANGED','already completed account blocks repair');
update public.profiles set must_change_password=true where id='53500000-0000-4000-8000-000000000002';
update public.profiles set status='inactive' where id='53500000-0000-4000-8000-000000000002';
select throws_ok($$select pg_temp.repair_unstarted_password_change('53500000-0000-4000-8000-000000000004',now()-interval '1 hour',now()-interval '1 hour',repeat('a',64),now()-interval '30 minutes')$$,'P0001','PASSWORD_REPAIR_STATE_CHANGED','inactive account blocks repair');
update public.profiles set status='active' where id='53500000-0000-4000-8000-000000000002';
select ok(pg_temp.repair_unstarted_password_change('53500000-0000-4000-8000-000000000004',now()-interval '1 hour',now()-interval '1 hour',repeat('a',64),now()-interval '30 minutes'),'proven unstarted request is terminated');
select throws_ok($$select pg_temp.repair_unstarted_password_change('53500000-0000-4000-8000-000000000004',now()-interval '1 hour',now()-interval '1 hour',repeat('a',64),now()-interval '30 minutes')$$,'P0001','PASSWORD_REPAIR_STATE_CHANGED','completed repair cannot run twice');
select is((select state from private.password_change_commands where id='53500000-0000-4000-8000-000000000004'),'failed','receipt is preserved as failed');
select ok((select must_change_password from public.profiles where id='53500000-0000-4000-8000-000000000002'),'password gate remains closed');
select is(public.get_auth_password_version('53500000-0000-4000-8000-000000000001'),repeat('a',64),'repair does not mutate password');
select is(public.inspect_password_change('53500000-0000-4000-8000-000000000002','53500000-0000-4000-8000-000000000001','53500000-0000-4000-8000-000000000003','repair-new-key')->>'state','absent','new key can restart normal current-password verification');
select is(public.inspect_password_change('53500000-0000-4000-8000-000000000002','53500000-0000-4000-8000-000000000001','53500000-0000-4000-8000-000000000003','repair-old-key')->>'state','failed','old failed key is not reused');
select is(public.prepare_password_change('53500000-0000-4000-8000-000000000002','53500000-0000-4000-8000-000000000001','53500000-0000-4000-8000-000000000003','repair-new-key',repeat('b',64),repeat('d',64),repeat('e',64)),jsonb_build_object('state','execute','attemptCount',1,'effectMarker',repeat('e',64)),'new request receives its exact effect marker');
select is((select count(*) from private.password_change_commands where actor_profile_id='53500000-0000-4000-8000-000000000002'),2::bigint,'old failure and new request coexist');
select * from finish();
rollback;
