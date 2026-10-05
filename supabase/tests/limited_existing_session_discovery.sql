begin;
select no_plan();
\ir limited_existing_session_fixture.psql

select is((select provolatile::text from pg_proc where oid='private.assert_attempt_actor_session(uuid,uuid,boolean)'::regprocedure),
  's','existing session helper preserves STABLE request-snapshot contract');
select is((select provolatile::text from pg_proc where oid='private.assert_attempt_actor_session_at_clock(uuid,uuid,boolean,timestamptz)'::regprocedure),
  's','shared private clock core is STABLE and contains no wall clock');
select is((select provolatile::text from pg_proc where oid='private.assert_attempt_actor_session_fresh(uuid,uuid,boolean)'::regprocedure),
  'v','fresh private wrapper is explicitly VOLATILE');
select ok((select strpos(prosrc,'statement_timestamp()')>0 and strpos(prosrc,'clock_timestamp()')=0
  from pg_proc where oid='private.assert_attempt_actor_session(uuid,uuid,boolean)'::regprocedure),
  'snapshot wrapper selects core with the request statement clock only');
select ok((select strpos(prosrc,'select * into result from private.assert_attempt_actor_session_at_clock(p_actor,p_session,p_admin,clock_timestamp());')>0
  from pg_proc where oid='private.assert_attempt_actor_session_fresh(uuid,uuid,boolean)'::regprocedure),
  'fresh wrapper uses an explicit internal SELECT with fresh snapshot and wall clock');
select ok((select strpos(prosrc,'clock_timestamp')=0 and strpos(prosrc,'statement_timestamp')=0
  from pg_proc where oid='private.assert_attempt_actor_session_at_clock(uuid,uuid,boolean,timestamptz)'::regprocedure),
  'core cannot accidentally choose a different clock');

-- #389: only these exact, separately approved post-#329 append signatures may
-- extend the installed catalog. This never edits the migration's strict initial
-- 21 / final 6 snapshot + 18 fresh + 2 core installation inventories.
-- BEGIN APPROVED SESSION CALLER EXTENSIONS
create temp table limited_session_caller_extensions(signature text primary key,qualified_name text unique,
  helper_kind text not null,volatility text not null);
insert into limited_session_caller_extensions values
  ('public.get_room_board_projection(uuid,uuid,date,uuid)','public.get_room_board_projection','snapshot','s'),
  ('public.list_room_reports_page(uuid,uuid,uuid,integer,timestamptz,uuid)','public.list_room_reports_page','fresh','v');
-- END APPROVED SESSION CALLER EXTENSIONS
select ok(not exists(select 1 from limited_session_caller_extensions e
  join pg_namespace n on n.nspname=split_part(e.qualified_name,'.',1)
  join pg_proc p on p.pronamespace=n.oid and p.proname=split_part(e.qualified_name,'.',2)
  where p.oid is distinct from to_regprocedure(e.signature)::oid),
  'approved extension names cannot hide a missing exact signature or an extra overload');
select ok(to_regprocedure('public.list_room_reports_page(uuid,uuid,uuid,integer,timestamptz,uuid)') is null
  or to_regprocedure('public.get_room_board_projection(uuid,uuid,date,uuid)') is not null,
  'approved installation order is baseline 6/18 then room board 7/18 then registered reports 7/19');
select ok(coalesce((select p.prokind='f' and l.lanname='plpgsql' and p.provolatile::text=e.volatility
  and p.prosecdef and p.proowner='postgres'::regrole and p.proconfig=array['search_path=""']::text[]
  and (length(p.prosrc)-length(replace(p.prosrc,case when e.helper_kind='snapshot'
    then 'private.assert_attempt_actor_session(' else 'private.assert_attempt_actor_session_fresh(' end,'')))
    /length(case when e.helper_kind='snapshot' then 'private.assert_attempt_actor_session('
      else 'private.assert_attempt_actor_session_fresh(' end)=1
  and strpos(p.prosrc,case when e.helper_kind='snapshot'
    then 'private.assert_attempt_actor_session_fresh(' else 'private.assert_attempt_actor_session(' end)=0
  and strpos(p.prosrc,'private.assert_attempt_actor_session_at_clock(')=0
  and (select array_agg(a.grantor::text||':'||a.grantee::text||':'||a.privilege_type||':'||a.is_grantable::text
    order by a.grantor,a.grantee,a.privilege_type,a.is_grantable)
    from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a)
    = array[(p.proowner::text||':'||p.proowner::text||':EXECUTE:false'),
      (p.proowner::text||':'||('service_role'::regrole::oid)::text||':EXECUTE:false')]
  from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=to_regprocedure(e.signature)),false),
  'installed approved extension has exact helper/attributes/owner/service-only ACL: '||e.signature)
from limited_session_caller_extensions e where to_regprocedure(e.signature) is not null;

select is((select array_agg(n.nspname||'.'||p.proname order by n.nspname,p.proname)
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname in ('public','private') and strpos(p.prosrc,'private.assert_attempt_actor_session(')>0),
  (select array_agg(name order by name) from (select unnest(array[
    'public.get_cleaning_attempt_lifecycle_impact','public.get_limited_cleaning_attempt',
    'public.get_offline_event_quarantine','public.list_checkout_cleaning_templates',
    'public.list_offline_event_quarantine','public.list_room_type_catalog']::text[]) name
    union all select qualified_name from limited_session_caller_extensions
      where helper_kind='snapshot' and to_regprocedure(signature) is not null) expected),
  'exact six baseline snapshot RPCs plus only installed approved snapshot signatures');
select ok(coalesce((select count(*)=6+(select count(*) from limited_session_caller_extensions
    where helper_kind='snapshot' and to_regprocedure(signature) is not null) and bool_and(p.provolatile='s')
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname in ('public','private') and strpos(p.prosrc,'private.assert_attempt_actor_session(')>0),false),
  'all baseline and approved snapshot RPCs preserve STABLE GET/HEAD and POST read-only attributes');
select is((select array_agg(n.nspname||'.'||p.proname order by n.nspname,p.proname)
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname in ('public','private') and strpos(p.prosrc,'private.assert_attempt_actor_session_fresh(')>0),
  (select array_agg(name order by name) from (select unnest(array[
    'private.assert_photo_upload_actor','private.cancel_unavailable_cleaning_assignment_at',
    'private.complete_limited_attempt_at','private.create_cleaning_submission_session_core',
    'private.manage_cleaning_attempt_lifecycle_at','private.resolve_offline_quarantine_at',
    'private.start_attempt_with_lease_at','private.sync_attempt_event_at',
    'public.correct_room_occupancy','public.get_photo_upload_receipt_with_session',
    'public.list_limited_cleaning_attempts','public.list_room_events','public.list_room_issues',
    'public.list_room_issues_page','public.list_room_operation_blocks','public.list_room_operation_blocks_page',
    'public.override_room_display_status','public.publish_checkout_cleaning_template']::text[]) name
    union all select qualified_name from limited_session_caller_extensions
      where helper_kind='fresh' and to_regprocedure(signature) is not null) expected),
  'exact eighteen baseline direct fresh callers plus only installed approved fresh signatures');
select ok(coalesce((select count(*)=18+(select count(*) from limited_session_caller_extensions
    where helper_kind='fresh' and to_regprocedure(signature) is not null) and bool_and(p.provolatile='v')
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname in ('public','private') and strpos(p.prosrc,'private.assert_attempt_actor_session_fresh(')>0),false),
  'baseline and approved fresh caller attributes are explicitly preserved as VOLATILE');
select is((select array_agg(n.nspname||'.'||p.proname order by n.nspname,p.proname)
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname in ('public','private') and strpos(p.prosrc,'private.assert_attempt_actor_session_at_clock(')>0),
  array['private.assert_attempt_actor_session','private.assert_attempt_actor_session_fresh']::text[],
  'exact two original clock-core callers remain unchanged by approved extensions');

-- A signature/OID comparison additionally rejects removed baseline signatures
-- replaced by same-name overloads, even when the name/count comparisons match.
select is((select array_agg(p.oid order by p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname in ('public','private') and (strpos(p.prosrc,'private.assert_attempt_actor_session(')>0
    or strpos(p.prosrc,'private.assert_attempt_actor_session_fresh(')>0)),
  (select array_agg(to_regprocedure(signature)::oid order by to_regprocedure(signature)::oid) from (
    values ('public.get_limited_cleaning_attempt(uuid,uuid,uuid,bigint)'),
      ('public.get_cleaning_attempt_lifecycle_impact(uuid,uuid,uuid)'),
      ('public.get_offline_event_quarantine(uuid,uuid,uuid)'),
      ('public.list_offline_event_quarantine(uuid,uuid,timestamptz,timestamptz,integer,timestamptz,uuid)'),
      ('public.list_checkout_cleaning_templates(uuid,uuid)'),('public.list_room_type_catalog(uuid,uuid)'),
      ('private.manage_cleaning_attempt_lifecycle_at(uuid,uuid,uuid,bigint,uuid,bigint,bigint,text,jsonb,text,text,text,timestamptz)'),
      ('private.complete_limited_attempt_at(uuid,uuid,uuid,bigint,uuid,bigint,text,text,timestamptz)'),
      ('private.start_attempt_with_lease_at(uuid,uuid,uuid,bigint,uuid,bigint,text,text,timestamptz)'),
      ('private.sync_attempt_event_at(uuid,uuid,uuid,uuid,bigint,timestamptz,bigint,timestamptz)'),
      ('private.resolve_offline_quarantine_at(uuid,uuid,uuid,text,bigint,text,text,text,timestamptz)'),
      ('private.assert_photo_upload_actor(uuid,uuid,uuid)'),
      ('public.publish_checkout_cleaning_template(uuid,uuid,text,integer,integer,jsonb,text,text)'),
      ('public.list_room_operation_blocks(uuid,uuid,uuid,text)'),('public.list_room_issues(uuid,uuid,uuid,text)'),
      ('public.list_room_events(uuid,uuid,uuid,integer)'),
      ('public.correct_room_occupancy(uuid,uuid,uuid,uuid,boolean,timestamptz,bigint,text,text,text)'),
      ('public.override_room_display_status(uuid,uuid,uuid,text,bigint,text,text,text)'),
      ('private.cancel_unavailable_cleaning_assignment_at(uuid,uuid,uuid,uuid,bigint,uuid,bigint,text,text,text,timestamptz)'),
      ('public.list_room_operation_blocks_page(uuid,uuid,uuid,text,integer,timestamptz,uuid)'),
      ('public.list_room_issues_page(uuid,uuid,uuid,text,integer,timestamptz,uuid)'),
      ('public.list_limited_cleaning_attempts(uuid,uuid)'),
      ('private.create_cleaning_submission_session_core(uuid,uuid,uuid,uuid,bigint,integer,text,text)'),
      ('public.get_photo_upload_receipt_with_session(uuid,uuid,uuid)')
    union all select signature from limited_session_caller_extensions where to_regprocedure(signature) is not null
  ) expected(signature)), 'global direct caller OIDs exactly match every original signature plus approved installed signatures');
select ok(coalesce((select p.prokind='f' and l.lanname='plpgsql' and p.prosecdef
  and p.proowner='postgres'::regrole and p.proconfig=array['search_path=""']::text[]
  and (select count(*)=1 from pg_proc same_name where same_name.pronamespace=p.pronamespace
    and same_name.proname=p.proname)
  and (select array_agg(a.grantor::text||':'||a.grantee::text||':'||a.privilege_type||':'||a.is_grantable::text
    order by a.grantor,a.grantee,a.privilege_type,a.is_grantable)
    from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a)
    = array[(p.proowner::text||':'||p.proowner::text||':EXECUTE:false')]
  from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=signature::regprocedure),false),
  'private helper exact owner-only ACL/kind/language/security/search_path remains unchanged: '||signature)
from unnest(array['private.assert_attempt_actor_session(uuid,uuid,boolean)',
  'private.assert_attempt_actor_session_at_clock(uuid,uuid,boolean,timestamptz)',
  'private.assert_attempt_actor_session_fresh(uuid,uuid,boolean)'])signature;
select ok((select bool_and(not has_function_privilege(role_name,p.oid,'EXECUTE'))
  from pg_proc p cross join (values ('anon'),('authenticated'),('service_role')) roles(role_name)
  where p.oid in ('private.assert_attempt_actor_session(uuid,uuid,boolean)'::regprocedure,
    'private.assert_attempt_actor_session_at_clock(uuid,uuid,boolean,timestamptz)'::regprocedure,
    'private.assert_attempt_actor_session_fresh(uuid,uuid,boolean)'::regprocedure)),
  'runtime roles cannot execute any private snapshot, at-clock or fresh helper');

-- Exact time comparison is deterministic and never accepts a NULL clock.
update auth.sessions set not_after='2030-01-01 00:00:00+00' where id=pg_temp.lid(204);
select lives_ok($$select private.assert_attempt_actor_session_at_clock(pg_temp.lid(4),pg_temp.lid(204),false,
  '2029-12-31 23:59:59.999999+00')$$,'private core accepts exactly one microsecond before the hard session deadline');
select throws_ok($$select private.assert_attempt_actor_session_at_clock(pg_temp.lid(4),pg_temp.lid(204),false,
  '2030-01-01 00:00:00+00')$$,'42501','SESSION_REVOKED','private core denies exact hard deadline equality');
select throws_ok($$select private.assert_attempt_actor_session_at_clock(pg_temp.lid(4),pg_temp.lid(204),false,
  '2030-01-01 00:00:00.000001+00')$$,'42501','SESSION_REVOKED','private core denies one microsecond past the hard deadline');
select throws_ok($$select private.assert_attempt_actor_session_at_clock(pg_temp.lid(4),pg_temp.lid(204),false,null)$$,
  '42501','SESSION_REVOKED','NULL internal clock fails closed');

-- A materialized write precedes both checks inside one outer SQL statement.
-- The STABLE read keeps that statement snapshot; the VOLATILE internal SELECT
-- must see the just-expired real Auth row. No sleep, fake grant or GUC is used.
create function pg_temp.lexpire_active_session() returns boolean language plpgsql as $$
begin
  update auth.sessions set not_after=clock_timestamp()-interval '1 microsecond' where id=pg_temp.lid(204);
  return true;
end $$;
create function pg_temp.lfresh_expiry_denied() returns boolean language plpgsql as $$
begin
  perform private.assert_attempt_actor_session_fresh(pg_temp.lid(4),pg_temp.lid(204),false);
  return false;
exception when insufficient_privilege then
  return sqlerrm='SESSION_REVOKED';
end $$;
create temp table limited_clock_result(snapshot_allowed boolean,fresh_denied boolean);
with expired as materialized (select pg_temp.lexpire_active_session() changed)
insert into limited_clock_result select
  (private.assert_attempt_actor_session(pg_temp.lid(4),pg_temp.lid(204),false)).id=pg_temp.lid(4),
  pg_temp.lfresh_expiry_denied() from expired where changed;
select ok((select snapshot_allowed and fresh_denied from limited_clock_result),
  'request snapshot read remains compatible while explicit fresh SELECT observes same-statement Auth expiry');
update auth.sessions set not_after=null where id=pg_temp.lid(204);

select ok((select strpos(prosrc,E'  select * into a from public.cleaning_attempts where id=p_attempt_id for update;\n  at_time:=coalesce(p_command_at,clock_timestamp());\n  perform private.assert_attempt_actor_session_fresh(p_actor_profile_id,p_session_id,true);')>0
  from pg_proc where oid='private.manage_cleaning_attempt_lifecycle_at(uuid,uuid,uuid,bigint,uuid,bigint,bigint,text,jsonb,text,text,text,timestamptz)'::regprocedure),
  'exact main lifecycle lock anchor rechecks session after its fresh clock');
select ok((select strpos(prosrc,E'    perform pg_advisory_xact_lock(hashtextextended(\'availability:\'||next_maid::text||\':\'||wk::text,0));\n    at_time:=coalesce(p_command_at,clock_timestamp());\n    perform private.assert_attempt_actor_session_fresh(p_actor_profile_id,p_session_id,true);')>0
  from pg_proc where oid='private.manage_cleaning_attempt_lifecycle_at(uuid,uuid,uuid,bigint,uuid,bigint,bigint,text,jsonb,text,text,text,timestamptz)'::regprocedure),
  'distinct handover availability-wait anchor also rechecks session, not a broad count allowance');
select ok((select strpos(prosrc,E'  perform private.complete_command(p_actor_profile_id,cmd,p_idempotency_key,p_request_hash,a.id,result);\n  perform private.assert_attempt_actor_session_fresh(p_actor_profile_id,p_session_id,false);\n  if g.expires_at<=clock_timestamp()')>0
  from pg_proc where oid='private.complete_limited_attempt_at(uuid,uuid,uuid,bigint,uuid,bigint,text,text,timestamptz)'::regprocedure),
  'limited completion checks session and actual-clock TTL after receipt/notification writer');
select ok((select strpos(prosrc,E'  perform private.complete_command(p_actor_profile_id,\'submission.create\',p_idempotency_key,p_request_hash,sid,result);\n  if p_session_id is not null then\n    perform private.assert_attempt_actor_session_fresh')>0
  from pg_proc where oid='private.create_cleaning_submission_session_core(uuid,uuid,uuid,uuid,bigint,integer,text,text)'::regprocedure),
  'session-bound submission rechecks after writer before return');

select is((select count(*)::integer from private.limited_session_roots),0,'fresh migration does not invent session evidence');
select is(jsonb_array_length(public.list_limited_cleaning_attempts(pg_temp.lid(4),pg_temp.lid(204))->'items'),0,
  'ordinary active maid has an empty limited discovery, not an active-work bootstrap');
select throws_ok($$select public.list_limited_cleaning_attempts(pg_temp.lid(1),pg_temp.lid(201))$$,
  '42501','CAPABILITY_ACCESS_REQUIRED','administrator is not a limited-work maid');
select throws_ok($$select public.list_limited_cleaning_attempts(pg_temp.lid(2),null)$$,
  '42501','SESSION_REVOKED','missing session never obtains discovery');
select throws_ok($$select public.list_limited_cleaning_attempts(pg_temp.lid(2),pg_temp.lid(203))$$,
  '42501','SESSION_REVOKED','another actor session is not authority');
select throws_ok($$select public.list_limited_cleaning_attempts(pg_temp.lid(2),pg_temp.lid(402))$$,
  '42501','SESSION_REVOKED','already expired Auth row is not live');
create temp table limited_results(label text primary key,result jsonb);
insert into limited_results values('finish',pg_temp.lmanage(1,'allow_finish'));
select is((select count(*)::integer from private.limited_session_roots where actor_profile_id=pg_temp.lid(2)),1,
  'first actual active-to-pending transition records one immutable root');
select is((select count(*)::integer from private.limited_session_eligibility),2,
  'only actually visible NULL/future sessions are frozen, expired row excluded');
select ok(not exists(select 1 from private.limited_session_eligibility where session_digest=pg_temp.lid(202)::text),
  'private evidence stores domain-separated digest, never raw session UUID');
select ok((select bool_and(session_digest~'^[0-9a-f]{64}$') from private.limited_session_eligibility),
  'frozen session evidence has SHA256 shape');
insert into limited_results values('discovery',public.list_limited_cleaning_attempts(pg_temp.lid(2),pg_temp.lid(202)));
select is((select result->>'profileStatus' from limited_results where label='discovery'),'deactivation_pending',
  'discovery reports actual restricted state, never active');
select is((select jsonb_array_length(result->'items') from limited_results where label='discovery'),1,
  'discovery returns exactly owned live attempt');
select is((select array_agg(key order by key) from limited_results,jsonb_object_keys(result->'items'->0) key where label='discovery'),
  array['allowedActions','assignmentId','assignmentRevision','attemptId','executionVersion','expiresAt','issuedAt','kind','status']::text[],
  'discovery exact nine-key projection excludes capability/session/room/PIN/PII');
select is((select result#>>'{items,0,kind}' from limited_results where label='discovery'),'finish_current','finish matrix is preserved');
select ok((select (result#>>'{items,0,issuedAt}')::timestamptz<=(result->>'evaluatedAt')::timestamptz
  and (result#>>'{items,0,expiresAt}')::timestamptz>(result->>'evaluatedAt')::timestamptz
  from limited_results where label='discovery'),'server clock is within exact microsecond grant window');
select lives_ok($$select public.get_limited_cleaning_attempt(pg_temp.lid(2),pg_temp.lid(302),pg_temp.lid(501),2)$$,
  'another pre-existing live session shares the exact frozen root');
insert into auth.sessions(id,user_id,created_at) values(pg_temp.lid(502),pg_temp.lid(102),clock_timestamp()-interval '30 days');
select throws_ok($$select public.list_limited_cleaning_attempts(pg_temp.lid(2),pg_temp.lid(502))$$,
  '42501','CAPABILITY_ACCESS_REQUIRED','post-transition session with old created_at never becomes eligible');
select throws_ok($$select public.get_limited_cleaning_attempt(pg_temp.lid(2),pg_temp.lid(502),pg_temp.lid(501),2)$$,
  '42501','CAPABILITY_ACCESS_REQUIRED','old single-read endpoint also rejects newly created sessions');
select throws_ok($$select public.get_limited_cleaning_attempt(pg_temp.lid(2),pg_temp.lid(202),pg_temp.lid(502),2)$$,
  '42501','CAPABILITY_ACCESS_REQUIRED','known other attempt ID is not limited authority');
select throws_ok($$select public.get_current_cleaning_attempt(pg_temp.lid(2),pg_temp.lid(401))$$,
  '42501','MAID_REQUIRED','general active-only account endpoint remains denied');
select throws_ok($$update private.limited_session_roots set captured_at=clock_timestamp()$$,
  '55000','ATTEMPT_CAPABILITY_IMMUTABLE','session root cannot renew by update');
select throws_ok($$delete from private.limited_session_eligibility$$,
  '55000','ATTEMPT_CAPABILITY_IMMUTABLE','eligible session evidence cannot be deleted');
select throws_ok($$update private.attempt_capability_session_roots set actor_profile_id=pg_temp.lid(3)$$,
  '55000','ATTEMPT_CAPABILITY_IMMUTABLE','capability-root evidence is immutable');
select throws_ok($$insert into private.attempt_capability_session_roots(capability_id,root_id,actor_profile_id)
  select g.id,r.id,pg_temp.lid(3) from private.attempt_capability_grants g cross join private.limited_session_roots r limit 1$$,
  '23514','CAPABILITY_SESSION_ROOT_IDENTITY_INVALID','cross-actor root binding is rejected before it can authorize');
insert into limited_results values('complete',public.complete_limited_cleaning_attempt_field_work(pg_temp.lid(2),pg_temp.lid(202),
  pg_temp.lid(501),1,pg_temp.lid(401),2,'limited-complete',repeat('b',64)));
select is((select count(*)::integer from private.limited_session_roots where actor_profile_id=pg_temp.lid(2)),1,
  'finish-to-upload does not recapture sessions');
select is((select count(distinct root_id)::integer from private.attempt_capability_session_roots b
  join private.attempt_capability_grants g on g.id=b.capability_id where g.actor_profile_id=pg_temp.lid(2)),1,
  'successor upload grant inherits identical initial root');
select is((select expires_at-issued_at from private.attempt_capability_grants where attempt_id=pg_temp.lid(501) and kind='upload_submit'),
  interval '24 hours','successor immutable upload TTL remains exactly 24h');
select is(public.complete_limited_cleaning_attempt_field_work(pg_temp.lid(2),pg_temp.lid(202),pg_temp.lid(501),1,
  pg_temp.lid(401),2,'limited-complete',repeat('b',64)),(select result from limited_results where label='complete'),
  'eligible lost-response replay converges without new grant/root');
select throws_ok($$select public.complete_limited_cleaning_attempt_field_work(pg_temp.lid(2),pg_temp.lid(502),pg_temp.lid(501),1,
  pg_temp.lid(401),2,'limited-complete',repeat('b',64))$$,'42501','CAPABILITY_ACCESS_REQUIRED',
  'new session cannot read an existing completion receipt');
select is(public.list_limited_cleaning_attempts(pg_temp.lid(2),pg_temp.lid(202))#>>'{items,0,kind}','upload_submit',
  'discovery tracks successor upload capability without credential renewal');

insert into limited_results values('upload',pg_temp.lmanage(2,'allow_upload'));
select throws_ok($$select public.create_cleaning_submission(pg_temp.lid(3),pg_temp.lid(502),gen_random_uuid(),0,0,
  'limited-old-service-submit',repeat('b',64))$$,'42501','SUBMISSION_ACCESS_REQUIRED',
  'session-free old service RPC cannot bypass limited session freeze');
select throws_ok($$select public.create_cleaning_submission_with_session(pg_temp.lid(3),null,pg_temp.lid(502),gen_random_uuid(),0,0,
  'limited-null-submit',repeat('b',64))$$,'42501','SESSION_REVOKED','new submission requires explicit verified session');
insert into auth.sessions(id,user_id) values(pg_temp.lid(503),pg_temp.lid(103));
select throws_ok($$select public.begin_photo_upload(pg_temp.lid(3),pg_temp.lid(503),pg_temp.lid(502),pg_temp.lid(402),2,
  pg_temp.lslot(2),0,repeat('a',64),'image/jpeg',100,repeat('b',64),repeat('c',64))$$,
  '42501','CAPABILITY_ACCESS_REQUIRED','new photo mutation also rejects post-freeze session');
insert into limited_results values('photo',public.begin_photo_upload(pg_temp.lid(3),pg_temp.lid(203),pg_temp.lid(502),pg_temp.lid(402),2,
  pg_temp.lslot(2),0,repeat('a',64),'image/jpeg',100,repeat('b',64),repeat('c',64)));
create function pg_temp.lop() returns uuid language sql stable as $$
  select (result->>'operationId')::uuid from limited_results where label='photo'
$$;
select public.claim_photo_upload(pg_temp.lid(3),pg_temp.lid(203),pg_temp.lop(),repeat('d',64));
select public.record_photo_provider_success(pg_temp.lop(),1,repeat('d',64),'limited_synthetic_provider',clock_timestamp());
update limited_results set result=public.finalize_photo_upload(pg_temp.lid(3),pg_temp.lid(203),pg_temp.lop(),1,repeat('d',64)) where label='photo';
select is(public.get_photo_upload_receipt_with_session(pg_temp.lid(3),pg_temp.lid(203),pg_temp.lop()),
  (select result from limited_results where label='photo'),'eligible accepted photo receipt is identical safe projection');
select throws_ok($$select public.get_photo_upload_receipt_with_session(pg_temp.lid(3),pg_temp.lid(503),pg_temp.lop())$$,
  '42501','CAPABILITY_ACCESS_REQUIRED','new session cannot converge accepted receipt');
select throws_ok($$select public.get_photo_upload_receipt_with_session(pg_temp.lid(2),pg_temp.lid(202),pg_temp.lop())$$,
  '42501','PHOTO_ACCESS_REQUIRED','accepted photo operation remains actor and immutable-attempt owned');
insert into limited_results values('submission',public.create_cleaning_submission_with_session(pg_temp.lid(3),pg_temp.lid(203),
  pg_temp.lid(502),pg_temp.lid(800),0,0,'limited-new-submit',repeat('e',64)));
select is((select result->>'status' from limited_results where label='submission'),'submitted','eligible limited maid submits actual accepted evidence');
select is(public.create_cleaning_submission_with_session(pg_temp.lid(3),pg_temp.lid(203),pg_temp.lid(502),pg_temp.lid(800),0,0,
  'limited-new-submit',repeat('e',64)),(select result from limited_results where label='submission'),
  'session-bound submitted receipt replays after terminal capability status without renewal');
select is(jsonb_array_length(public.list_limited_cleaning_attempts(pg_temp.lid(3),pg_temp.lid(203))->'items'),0,
  'submitted work does not reappear as newly authorized work');
select is(public.get_photo_upload_receipt_with_session(pg_temp.lid(3),pg_temp.lid(203),pg_temp.lop())->>'status','accepted',
  'accepted historical receipt survives submission transition without new mutation');
delete from auth.sessions where id=pg_temp.lid(203);
select throws_ok($$select public.get_photo_upload_receipt_with_session(pg_temp.lid(3),pg_temp.lid(203),pg_temp.lop())$$,
  '42501','SESSION_REVOKED','revoked session cannot converge accepted receipt');
select throws_ok($$select public.create_cleaning_submission_with_session(pg_temp.lid(3),pg_temp.lid(203),pg_temp.lid(502),pg_temp.lid(800),0,0,
  'limited-new-submit',repeat('e',64))$$,'42501','SESSION_REVOKED','revoked session cannot replay submission receipt');
select is(public.reconcile_photo_upload(pg_temp.lop(),repeat('f',64))->>'status','accepted',
  'internal worker accepted-history reconciliation remains independent of former session');
select is((select count(*)::integer from public.cleaning_submissions),1,'denied replay creates no second submission');
select is((select count(*)::integer from private.limited_session_roots),2,'all reads/replays preserve frozen roots');
select throws_ok($$select public.list_limited_cleaning_attempts(pg_temp.lid(5),pg_temp.lid(205))$$,
  '42501','CAPABILITY_ACCESS_REQUIRED','legacy limited account with no immutable evidence fails closed');
select private.issue_attempt_capability(a,'evidence_upload',pg_temp.lid(1),clock_timestamp())
  from public.cleaning_attempts a where a.id=pg_temp.lid(503);
select is(public.list_limited_cleaning_attempts(pg_temp.lid(4),pg_temp.lid(204))#>>'{items,0,kind}','evidence_upload',
  'ordinary active handover owner retains existing active evidence permission');

-- 1000/1001 are server implementation guards, not a product/device policy. Never
-- return a partial list or partially freeze a larger set of live sessions.
create temp table limited_bound_ids as select n,gen_random_uuid() target_id,gen_random_uuid() assignment_id,
  gen_random_uuid() attempt_id from generate_series(1,1000)n;
insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,effective_service_date,
  available_from,due_at,status,assignment_version,room_type_snapshot,fee_snapshot,template_snapshot,created_by)
select b.target_id,t.room_id,t.cleaning_kind,t.source,'limited-bound-'||b.n,t.original_service_date,t.effective_service_date,
  t.available_from,t.due_at,t.status,t.assignment_version,t.room_type_snapshot,t.fee_snapshot,t.template_snapshot,t.created_by
from limited_bound_ids b cross join public.cleaning_targets t where t.id=pg_temp.lid(303);
insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,notified_at,changed_by)
select assignment_id,target_id,pg_temp.lid(4),100+n,2,clock_timestamp()-interval '1 hour',pg_temp.lid(1) from limited_bound_ids;
insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,
  assignment_revision,started_at,ended_at,end_reason,template_snapshot,room_snapshot)
select b.attempt_id,b.target_id,b.assignment_id,pg_temp.lid(4),1,'interrupted',2,clock_timestamp()-interval '1 hour',
  clock_timestamp()-interval '30 minutes','ADMIN_HANDOVER',t.template_snapshot,jsonb_build_object('roomId',t.room_id)
from limited_bound_ids b join public.cleaning_targets t on t.id=b.target_id;
insert into private.attempt_capability_grants(actor_profile_id,attempt_id,assignment_id,assignment_revision,kind,
  allowed_actions,issued_at,expires_at,granted_by)
select pg_temp.lid(4),attempt_id,assignment_id,2,'evidence_upload',array['upload_evidence','validate_evidence'],
  statement_timestamp(),statement_timestamp()+interval '24 hours',pg_temp.lid(1) from limited_bound_ids where n<1000;
select is(jsonb_array_length(public.list_limited_cleaning_attempts(pg_temp.lid(4),pg_temp.lid(204))->'items'),1000,
  'exactly 1000 own live items converge in one bounded discovery');
select ok((select array_agg((item->>'attemptId')::uuid order by ordinal)=array_agg((item->>'attemptId')::uuid order by (item->>'attemptId')::uuid)
  from jsonb_array_elements(public.list_limited_cleaning_attempts(pg_temp.lid(4),pg_temp.lid(204))->'items') with ordinality x(item,ordinal)),
  'discovery is deterministically ordered by UUID attemptId');
insert into private.attempt_capability_grants(actor_profile_id,attempt_id,assignment_id,assignment_revision,kind,
  allowed_actions,issued_at,expires_at,granted_by)
select pg_temp.lid(4),attempt_id,assignment_id,2,'evidence_upload',array['upload_evidence','validate_evidence'],
  statement_timestamp(),statement_timestamp()+interval '24 hours',pg_temp.lid(1) from limited_bound_ids where n=1000;
select throws_ok($$select public.list_limited_cleaning_attempts(pg_temp.lid(4),pg_temp.lid(204))$$,
  '54000','LIMITED_DISCOVERY_LIMIT_EXCEEDED','1001 own live items fail closed, never truncate');
select throws_ok($$update public.profiles set status='upload_only' where id=pg_temp.lid(4)$$,
  '54000','LIMITED_DISCOVERY_LIMIT_EXCEEDED','oversized capability binding freezes no partial root');
select is((select count(*)::integer from private.limited_session_roots where actor_profile_id=pg_temp.lid(4)),0,
  'oversized binding transition rolls back its whole root/session evidence');
insert into private.attempt_capability_revocations(capability_id,revoked_at,reason_code,actor_profile_id)
select g.id,clock_timestamp(),'ACCOUNT_CHANGED',pg_temp.lid(1) from private.attempt_capability_grants g
  join limited_bound_ids b on b.attempt_id=g.attempt_id where b.n=1000;
insert into auth.sessions(id,user_id) select gen_random_uuid(),pg_temp.lid(104) from generate_series(1,1000);
select throws_ok($$update public.profiles set status='upload_only' where id=pg_temp.lid(4)$$,
  '54000','LIMITED_SESSION_LIMIT_EXCEEDED','1001 visible sessions fail the transition atomically');
delete from auth.sessions where id=(select id from auth.sessions where user_id=pg_temp.lid(104) and id<>pg_temp.lid(204) limit 1);
select lives_ok($$update public.profiles set status='upload_only' where id=pg_temp.lid(4)$$,
  'exactly 1000 visible sessions and grants freeze without partial evidence');
select is((select count(*)::integer from private.limited_session_eligibility e join private.limited_session_roots r on r.id=e.root_id
  where r.actor_profile_id=pg_temp.lid(4)),1000,'freeze preserves exactly 1000 eligible sessions');
select is(jsonb_array_length(public.list_limited_cleaning_attempts(pg_temp.lid(4),pg_temp.lid(204))->'items'),1000,
  'limited discovery preserves the full allowed bounded set');
update public.profiles set status='inactive' where id=pg_temp.lid(4);
select throws_ok($$select public.list_limited_cleaning_attempts(pg_temp.lid(4),pg_temp.lid(204))$$,
  '42501','CAPABILITY_ACCESS_REQUIRED','inactive terminal profile cannot discover previously frozen work');
update public.profiles set status='departed' where id=pg_temp.lid(4);
select throws_ok($$select public.list_limited_cleaning_attempts(pg_temp.lid(4),pg_temp.lid(204))$$,
  '42501','CAPABILITY_ACCESS_REQUIRED','departed terminal profile cannot re-enter');
update auth.sessions set not_after=statement_timestamp() where id=pg_temp.lid(202);
select throws_ok($$select public.list_limited_cleaning_attempts(pg_temp.lid(2),pg_temp.lid(202))$$,
  '42501','SESSION_REVOKED','session deadline equality is denied');
update auth.sessions set not_after=statement_timestamp()-interval '1 microsecond' where id=pg_temp.lid(302);
select throws_ok($$select public.get_limited_cleaning_attempt(pg_temp.lid(2),pg_temp.lid(302),pg_temp.lid(501),2)$$,
  '42501','SESSION_REVOKED','one microsecond past session deadline is denied');
select ok(not has_table_privilege('service_role','private.limited_session_eligibility','SELECT'),
  'service role has no raw digest-table access');
select ok(not has_function_privilege('service_role','private.create_cleaning_submission_session_core(uuid,uuid,uuid,uuid,bigint,integer,text,text)','EXECUTE'),
  'unbound private submission core is not exposed as service RPC');
select ok(has_function_privilege('service_role','public.list_limited_cleaning_attempts(uuid,uuid)','EXECUTE')
  and not has_function_privilege('authenticated','public.list_limited_cleaning_attempts(uuid,uuid)','EXECUTE')
  and not has_function_privilege('anon','public.list_limited_cleaning_attempts(uuid,uuid)','EXECUTE'),
  'discovery is service-only, not a general authenticated RLS bypass');

-- Execute the actual denied statements under each database role, not only ACL
-- metadata checks. Schema denial and relation ACL denial both have code42501.
create function pg_temp.lrole_dml() returns setof text language plpgsql as $$
declare relation text;
begin
  foreach relation in array array['limited_session_roots','limited_session_eligibility','attempt_capability_session_roots'] loop
    return next throws_ok(format('select * from private.%I',relation),'42501',null,'actual role cannot SELECT private evidence');
    return next throws_ok(format('insert into private.%I default values',relation),'42501',null,'actual role cannot INSERT private evidence');
    return next throws_ok(format('update private.%I set %I=%I',relation,
      case when relation='limited_session_roots' then 'captured_at' else 'root_id' end,
      case when relation='limited_session_roots' then 'captured_at' else 'root_id' end),
      '42501',null,'actual role cannot UPDATE private evidence');
    return next throws_ok(format('delete from private.%I',relation),'42501',null,'actual role cannot DELETE private evidence');
  end loop;
  return next throws_ok('select private.assert_attempt_actor_session(null,null,false)',
    '42501',null,'actual role cannot execute private snapshot helper');
  return next throws_ok('select private.assert_attempt_actor_session_at_clock(null,null,false,null)',
    '42501',null,'actual role cannot supply a private at-clock helper clock');
  return next throws_ok('select private.assert_attempt_actor_session_fresh(null,null,false)',
    '42501',null,'actual role cannot execute private fresh helper');
end $$;
set local role anon;
select * from pg_temp.lrole_dml();
select throws_ok($$select public.list_limited_cleaning_attempts(null,null)$$,'42501','permission denied for schema public',
  'actual anon cannot execute discovery');
reset role;
set local role authenticated;
select * from pg_temp.lrole_dml();
select throws_ok($$select public.list_limited_cleaning_attempts(null,null)$$,'42501','permission denied for function list_limited_cleaning_attempts',
  'actual authenticated cannot execute discovery');
reset role;
set local role service_role;
select * from pg_temp.lrole_dml();
select throws_ok($$select public.list_limited_cleaning_attempts(pg_temp.lid(2),pg_temp.lid(202))$$,'42501','SESSION_REVOKED',
  'actual service can execute discovery but expired session is still denied');
select throws_ok($$select public.create_cleaning_submission(pg_temp.lid(2),pg_temp.lid(501),gen_random_uuid(),0,0,
  'role-old-limited-submit',repeat('a',64))$$,'42501','SUBMISSION_ACCESS_REQUIRED','actual service old submission cannot bypass limited freeze');
reset role;
update auth.sessions set not_after=clock_timestamp()+interval '1 day' where id=pg_temp.lid(302);
set local role service_role;
select is(jsonb_array_length(public.list_limited_cleaning_attempts(pg_temp.lid(2),pg_temp.lid(302))->'items'),1,
  'actual service can invoke minimal discovery with valid pre-existing future session');
reset role;
select * from finish();
rollback;
