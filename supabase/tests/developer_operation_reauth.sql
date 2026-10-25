-- #396 SOURCE PREPARED ONLY. No real credentials; run only after per-run DB approval.
begin;
select no_plan();
create function pg_temp.operation_id(n integer) returns uuid language sql immutable as $$
  select ('f3961281-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid
$$;
insert into auth.users(id) values(pg_temp.operation_id(1));
set local role service_role;
select public.bootstrap_first_developer_profile(pg_temp.operation_id(11),pg_temp.operation_id(1),
  'operation-developer','operation-developer','0396','operation-gate-phone-hash','operation-gate-bootstrap');
reset role;
insert into auth.sessions(id,user_id,created_at,not_after)
  values(pg_temp.operation_id(21),pg_temp.operation_id(1),clock_timestamp(),null);
insert into private.developer_operation_control(target_ref,policy_hash,reauth_ttl_seconds,lifecycle)
  values('synthetic-target',repeat('a',64),120,'PROVISIONING');
create temp table challenge as select public.begin_developer_operation_reauth(pg_temp.operation_id(11),
  pg_temp.operation_id(1),pg_temp.operation_id(21)::text,'synthetic-target',1,'REQUEST_MAINTENANCE') as receipt;
create function pg_temp.verify_operation(probe uuid, nonce text) returns void language sql volatile as $$
  select public.verify_developer_operation_probe(pg_temp.operation_id(11),pg_temp.operation_id(1),
    pg_temp.operation_id(21)::text,(select (receipt->>'challengeId')::uuid from challenge),nonce,probe)
$$;
create function pg_temp.finish_operation() returns void language sql volatile as $$
  select public.finish_developer_operation_reauth(pg_temp.operation_id(11),pg_temp.operation_id(1),
    pg_temp.operation_id(21)::text,(select (receipt->>'challengeId')::uuid from challenge),(select receipt->>'nonce' from challenge))
$$;
select throws_ok($q$select pg_temp.verify_operation(pg_temp.operation_id(21),(select receipt->>'nonce' from challenge))$q$,
  '42501','OPERATION_REAUTH_REJECTED','existing original session cannot be a fresh password probe');
insert into auth.sessions(id,user_id,created_at,not_after)
  values(pg_temp.operation_id(22),pg_temp.operation_id(1),clock_timestamp(),null);
select throws_ok($q$select pg_temp.verify_operation(pg_temp.operation_id(22),(select receipt->>'nonce' from challenge))$q$,
  '42501','OPERATION_REAUTH_REJECTED','fresh session without password AMR rejected');
insert into auth.mfa_amr_claims(session_id,created_at,updated_at,authentication_method)
  values(pg_temp.operation_id(22),clock_timestamp(),clock_timestamp(),'password');
select throws_ok($q$select pg_temp.verify_operation(pg_temp.operation_id(22),repeat('b',64))$q$,
  '42501','OPERATION_REAUTH_REJECTED','nonce substitution rejected');
select lives_ok($q$select pg_temp.verify_operation(pg_temp.operation_id(22),(select receipt->>'nonce' from challenge))$q$,
  'actual fresh Auth session and AMR can record a probe');
select is((select state from private.developer_operation_reauth where id=(select (receipt->>'challengeId')::uuid from challenge)),
  'PROBE_VERIFIED','probe observation alone is not READY');
select throws_ok($q$select pg_temp.finish_operation()$q$,'42501','OPERATION_REAUTH_REJECTED','provider session must actually disappear before READY');
delete from auth.sessions where id=pg_temp.operation_id(22);
select lives_ok($q$select pg_temp.finish_operation()$q$,'DB absence readback finalizes the receipt');
select is((select state from private.developer_operation_reauth where id=(select (receipt->>'challengeId')::uuid from challenge)),
  'READY','fresh reauthentication receipt ready only after cleanup');
select throws_ok($q$select private.transition_developer_operation(pg_temp.operation_id(11),pg_temp.operation_id(1),
  pg_temp.operation_id(21)::text,(select (receipt->>'challengeId')::uuid from challenge),(select receipt->>'nonce' from challenge),'START_OPERATION')$q$,
  '42501','OPERATION_TRANSITION_REJECTED','receipt action cannot be substituted');
select lives_ok($q$select private.transition_developer_operation(pg_temp.operation_id(11),pg_temp.operation_id(1),
  pg_temp.operation_id(21)::text,(select (receipt->>'challengeId')::uuid from challenge),(select receipt->>'nonce' from challenge),'REQUEST_MAINTENANCE')$q$,
  'bound one-time receipt performs one atomic transition');
select is((select maintenance from private.developer_operation_control),'REQUESTED','maintenance is requested');
select is((select version from private.developer_operation_control),2::bigint,'CAS advances once');
select is((select count(*) from private.developer_operation_events),1::bigint,'one append-only event records the consumed receipt');
select throws_ok($q$select private.transition_developer_operation(pg_temp.operation_id(11),pg_temp.operation_id(1),
  pg_temp.operation_id(21)::text,(select (receipt->>'challengeId')::uuid from challenge),(select receipt->>'nonce' from challenge),'REQUEST_MAINTENANCE')$q$,
  '42501','OPERATION_TRANSITION_REJECTED','consumed receipt replay rejected');
select throws_ok($q$delete from private.developer_operation_events$q$,'42501','OPERATION_EVENTS_APPEND_ONLY','event deletion denied');
select throws_ok($q$update private.developer_operation_events set action='START_OPERATION'$q$,'42501','OPERATION_EVENTS_APPEND_ONLY','event overwrite denied');
select * from finish();
rollback;
