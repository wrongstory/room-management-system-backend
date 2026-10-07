begin;
select no_plan();
\ir db_static_warning_remediation_fixture.psql

create function pg_temp.warning_list(p_actor uuid default pg_temp.warning_id(2),
  p_session uuid default pg_temp.warning_id(202)) returns jsonb language sql as $$
  select public.list_cleaning_history(p_actor,p_session,
    (select service_date from warning_clock),null,null,100,null,null)
$$;
create function pg_temp.warning_item(p_attempt integer) returns jsonb language sql as $$
  select item from jsonb_array_elements(pg_temp.warning_list()->'items')item
  where item->>'attemptId'=pg_temp.warning_id(p_attempt)::text
$$;
create function pg_temp.warning_detail(p_actor uuid default pg_temp.warning_id(3),
  p_session uuid default pg_temp.warning_id(203)) returns jsonb language sql as $$
  select public.get_cleaning_history_submission(p_actor,p_session,pg_temp.warning_id(1002))
$$;
create function pg_temp.warning_state() returns text language plpgsql as $$
declare relation record; row_digest text; pieces text[]:='{}';
begin
  for relation in select n.nspname,c.relname from pg_class c
    join pg_namespace n on n.oid=c.relnamespace where c.relkind='r'
      and (n.nspname in ('public','private') or (n.nspname='auth' and c.relname in ('users','sessions')))
    order by n.nspname,c.relname loop
    execute format('select coalesce(string_agg(to_jsonb(t)::text,''|'' order by to_jsonb(t)::text),'''') from %I.%I t',
      relation.nspname,relation.relname) into row_digest;
    pieces:=array_append(pieces,relation.nspname||'.'||relation.relname||':'||row_digest);
  end loop;
  return md5(array_to_string(pieces,'|'));
end $$;
create temp table warning_checkpoints(label text primary key,value text);

-- #376: the exact LF canonical output is the same for either authorized pre101 line-ending variant.
select is((select md5(prosrc) from pg_proc where oid=signature::regprocedure),expected_md5,
  'CRLF-compatible remediation installs the exact canonical source: '||signature)
from (values
  ('public.list_cleaning_inspections_page(uuid,uuid,timestamptz,uuid,integer)',
   'a8138f7f69f796fc0dd1d8d7d8b72569'),
  ('public.get_developer_room_catalog(uuid)','f9bd73161810abfaec749042fa8be758'))canonical(signature,expected_md5);
select ok((select strpos(prosrc,chr(13))=0 from pg_proc where oid=signature::regprocedure),
  'CRLF-compatible remediation leaves no CR in canonical source: '||signature)
from unnest(array['public.list_cleaning_inspections_page(uuid,uuid,timestamptz,uuid,integer)',
  'public.get_developer_room_catalog(uuid)'])signature;

select is((select provolatile::text from pg_proc where oid=signature::regprocedure),'s',
  'read projection remains STABLE: '||signature)
from unnest(array['public.list_cleaning_history(uuid,uuid,date,uuid,text,integer,timestamptz,uuid)',
  'public.get_cleaning_history_submission(uuid,uuid,uuid)','public.get_developer_room_catalog(uuid)',
  'private.assert_active_developer_snapshot(uuid)'])signature;
select is((select provolatile::text from pg_proc
  where oid='private.assert_active_developer(uuid)'::regprocedure),'v',
  'shared developer command guard remains VOLATILE');
select is((select md5(prosrc) from pg_proc
  where oid='private.assert_active_developer(uuid)'::regprocedure),
  '2d06b2b81ab1081d1aa77ad6683035ab','shared developer command guard source is byte-identical');
select is((select md5(prosrc) from pg_proc where oid=signature::regprocedure),expected_md5,
  'legacy unused-parameter function source is unchanged: '||signature)
from (values
  ('public.confirm_assignment_duration_policy(uuid,bigint,integer,integer,integer,integer,text,text)',
   '5536dad130df79162031d85929d32133'),
  ('private.assignment_preview_source_reason(public.cleaning_targets,integer,timestamptz)',
   '0a1a56ddfb864a1f4709af5a82075f00'),
  ('private.assignment_preview_source_reason_before_stay_segments(public.cleaning_targets,integer,timestamptz)',
   '6645c7dc97faadd39c752bb4846cce0c'))compat(signature,expected_md5);
select ok((select prosecdef and proowner='postgres'::regrole
  and proconfig=array['search_path=""']::text[] from pg_proc
  where oid='private.assert_active_developer_snapshot(uuid)'::regprocedure),
  'snapshot guard is owner-only SECURITY DEFINER with empty search_path');
select ok(not has_function_privilege(role_name,'private.assert_active_developer_snapshot(uuid)','EXECUTE'),
  role_name||' cannot directly execute the snapshot guard')
from unnest(array['anon','authenticated','service_role'])role_name;
select ok(not exists(select 1 from pg_proc p,
  lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a
  where p.oid='private.assert_active_developer_snapshot(uuid)'::regprocedure
    and a.grantee=0 and a.privilege_type='EXECUTE'),'PUBLIC has no snapshot guard EXECUTE');
select ok(has_function_privilege('service_role',signature,'EXECUTE')
  and not has_function_privilege('anon',signature,'EXECUTE')
  and not has_function_privilege('authenticated',signature,'EXECUTE'),
  'public projection remains service-role only: '||signature)
from unnest(array['public.list_cleaning_history(uuid,uuid,date,uuid,text,integer,timestamptz,uuid)',
  'public.get_cleaning_history_submission(uuid,uuid,uuid)','public.get_developer_room_catalog(uuid)'])signature;

insert into warning_checkpoints values('before-valid-reads',pg_temp.warning_state());
select is((public.get_developer_room_catalog(pg_temp.warning_id(1))->>'generatedAt')::timestamptz,
  statement_timestamp(),'catalog generatedAt uses the exact statement clock');
insert into warning_checkpoints values('first-generated-at',
  public.get_developer_room_catalog(pg_temp.warning_id(1))->>'generatedAt');
select pg_sleep(0.02);
select ok((public.get_developer_room_catalog(pg_temp.warning_id(1))->>'generatedAt')::timestamptz
  >(select value::timestamptz from warning_checkpoints where label='first-generated-at'),
  'next statement in the same transaction advances generatedAt rather than reusing now()');
select is(jsonb_array_length(pg_temp.warning_list()->'items'),2,'admin reads both synthetic completed attempts');
select is(jsonb_array_length(pg_temp.warning_list(pg_temp.warning_id(3),pg_temp.warning_id(203))->'items'),
  2,'actual performer retains own completed history');
select is(jsonb_array_length(pg_temp.warning_list(pg_temp.warning_id(4),pg_temp.warning_id(204))->'items'),
  0,'another maid cannot see the performer history');
select is(pg_temp.warning_item(901)->>'roomNumber','snapshot-363','history uses the immutable room label');
select is(pg_temp.warning_item(902)->>'expiresAt',null::text,'retention-v2 NULL expiry is not replaced by legacy purge_after');
select is(pg_temp.warning_detail()#>>'{photos,0,mediaAvailability}','available','NULL retention expiry preserves available detail');
select is(pg_temp.warning_detail()#>>'{photos,0,expiresAt}',null::text,'detail preserves the meaningful NULL retention expiry');
select ok(not (pg_temp.warning_detail()->'photos'->0 ?| array['providerLocator','providerFileId','credential','pin']),
  'history photo metadata exposes no provider locator or PIN');
select is(pg_temp.warning_state(),(select value from warning_checkpoints where label='before-valid-reads'),
  'valid projections preserve every public/private/Auth whole row and all ledgers');

-- Deterministic exact boundaries use a volatile test wrapper: its UPDATE is
-- visible to the subsequent SELECT while the enclosing statement clock stays fixed.
-- Only the enclosing, transaction-local synthesis block changes replica mode;
-- invoker functions neither elevate privileges nor change server parameters.
create function pg_temp.warning_photo_boundary(p_delta interval,p_null boolean default false,
  p_delay double precision default 0) returns jsonb language plpgsql as $$
declare result jsonb;
begin
  if current_setting('session_replication_role')<>'replica' then
    raise exception 'WARNING_BOUNDARY_SYNTHESIS_MODE_REQUIRED';
  end if;
  update private.attempt_photo_versions set purge_after=statement_timestamp()+p_delta,
    uploaded_at=statement_timestamp()+p_delta-interval '168 hours' where id=pg_temp.warning_id(1201);
  update private.photo_retention_records set
    retention_starts_at=case when p_null then null else statement_timestamp()+p_delta-interval '168 hours' end,
    expires_at=case when p_null then null else statement_timestamp()+p_delta end
    where object_id=pg_temp.warning_id(1402);
  if p_delay>0 then perform pg_sleep(p_delay); end if;
  select jsonb_build_object('legacy',pg_temp.warning_item(901)->>'mediaAvailability',
    'v2List',pg_temp.warning_item(902)->>'mediaAvailability',
    'v2Expiry',pg_temp.warning_item(902)->>'expiresAt',
    'detail',pg_temp.warning_detail()#>>'{photos,0,mediaAvailability}',
    'detailExpiry',pg_temp.warning_detail()#>>'{photos,0,expiresAt}') into result;
  return result;
end $$;
set local session_replication_role = replica;
select is(pg_temp.warning_photo_boundary(interval '-1 day')->>'legacy','unavailable','past legacy expiry is unavailable');
select is(pg_temp.warning_photo_boundary(interval '0')->>'legacy','unavailable','exact legacy expiry is excluded');
select is(pg_temp.warning_photo_boundary(interval '1 day')->>'legacy','available','future legacy expiry is available');
select is(pg_temp.warning_photo_boundary(interval '-1 day')->>'detail','expired','past retention detail is expired');
select is(pg_temp.warning_photo_boundary(interval '0')->>'detail','expired','exact retention expiry is excluded');
select is(pg_temp.warning_photo_boundary(interval '1 day')->>'detail','available','future retention detail remains available');
select is(pg_temp.warning_photo_boundary(interval '-1 day')->>'v2List','available',
  'list retains the authoritative stored retention availability rather than changing existing semantics');
select is(pg_temp.warning_photo_boundary(interval '1 day',true)->>'v2Expiry',null::text,
  'boundary fixture retains NULL expiry in list');
select is(pg_temp.warning_photo_boundary(interval '1 day',true)->>'detailExpiry',null::text,
  'boundary fixture retains NULL expiry in detail');
select is(pg_temp.warning_photo_boundary(interval '10 milliseconds',false,0.05)->>'legacy','available',
  'legacy expiry stays fixed to statement time even after wall-clock expiry');
select is(pg_temp.warning_photo_boundary(interval '10 milliseconds',false,0.05)->>'detail','available',
  'retention detail stays fixed to statement time even after wall-clock expiry');
select pg_temp.warning_photo_boundary(interval '1 day',true);
set local session_replication_role = origin;
select is(current_setting('session_replication_role'),'origin',
  'photo boundary synthesis restores normal trigger execution before actor/session tests');

insert into warning_checkpoints values('before-denied-reads',pg_temp.warning_state());
select throws_ok(format('select public.get_developer_room_catalog(%L)',pg_temp.warning_id(n)),
  '42501','DEVELOPER_REQUIRED','catalog rejects a non-developer or missing profile: '||n)
from unnest(array[2,3,999])n;
select throws_ok($$select public.get_developer_room_catalog(null)$$,'42501','DEVELOPER_REQUIRED','catalog rejects a NULL actor');
select throws_ok($$select pg_temp.warning_list(null,pg_temp.warning_id(202))$$,
  '42501','CLEANING_HISTORY_ACCESS_REQUIRED','history list rejects a NULL actor');
select throws_ok($$select pg_temp.warning_detail(null,pg_temp.warning_id(202))$$,
  '42501','CLEANING_HISTORY_ACCESS_REQUIRED','history detail rejects a NULL actor');
select throws_ok(format('select pg_temp.warning_list(%L,%L)',pg_temp.warning_id(n),pg_temp.warning_id(200+n)),
  '42501','CLEANING_HISTORY_ACCESS_REQUIRED','list rejects inactive/limited/password-change actor: '||n)
from unnest(array[5,6,7,8])n;
select throws_ok(format('select pg_temp.warning_detail(%L,%L)',pg_temp.warning_id(n),pg_temp.warning_id(200+n)),
  '42501','CLEANING_HISTORY_ACCESS_REQUIRED','detail rejects inactive/limited/password-change actor: '||n)
from unnest(array[5,6,7,8])n;
select throws_ok($$select pg_temp.warning_detail(pg_temp.warning_id(4),pg_temp.warning_id(204))$$,
  '42501','CLEANING_HISTORY_ACCESS_REQUIRED','another maid cannot read a guessed submission ID');
select throws_ok($$select pg_temp.warning_list(pg_temp.warning_id(2),pg_temp.warning_id(203))$$,
  '42501','ACTIVE_SESSION_REQUIRED','list rejects an actor using another user session');
select throws_ok($$select pg_temp.warning_detail(pg_temp.warning_id(2),pg_temp.warning_id(203))$$,
  '42501','CLEANING_HISTORY_ACCESS_REQUIRED','detail rejects an actor using another user session');
select throws_ok($$select pg_temp.warning_list(pg_temp.warning_id(2),pg_temp.warning_id(402))$$,
  '42501','ACTIVE_SESSION_REQUIRED','list rejects a hard-expired session that still exists');
select throws_ok($$select pg_temp.warning_detail(pg_temp.warning_id(2),pg_temp.warning_id(402))$$,
  '42501','CLEANING_HISTORY_ACCESS_REQUIRED','detail rejects a hard-expired session that still exists');
select throws_ok($$select pg_temp.warning_list(pg_temp.warning_id(2),null)$$,
  '42501','ACTIVE_SESSION_REQUIRED','list rejects a NULL session');
select throws_ok($$select pg_temp.warning_detail(pg_temp.warning_id(2),pg_temp.warning_id(999))$$,
  '42501','CLEANING_HISTORY_ACCESS_REQUIRED','detail rejects a missing or revoked session');
select lives_ok($$select pg_temp.warning_list(pg_temp.warning_id(2),pg_temp.warning_id(302))$$,
  'future hard-expiry session still permits the history list');
select lives_ok($$select pg_temp.warning_detail(pg_temp.warning_id(2),pg_temp.warning_id(302))$$,
  'future hard-expiry session still permits history detail');
select is(pg_temp.warning_state(),(select value from warning_checkpoints where label='before-denied-reads'),
  'denied and future-session reads create no receipt/audit/outbox or other row changes');

create function pg_temp.warning_session_boundary() returns jsonb language plpgsql as $$
declare list_error text; detail_error text;
begin
  update auth.sessions set not_after=statement_timestamp() where id=pg_temp.warning_id(202);
  begin perform pg_temp.warning_list(); exception when insufficient_privilege then list_error:=sqlerrm; end;
  begin perform pg_temp.warning_detail(pg_temp.warning_id(2),pg_temp.warning_id(202));
    exception when insufficient_privilege then detail_error:=sqlerrm; end;
  return jsonb_build_object('list',list_error,'detail',detail_error);
end $$;
select is(pg_temp.warning_session_boundary()->>'list','ACTIVE_SESSION_REQUIRED','list denies exact session hard expiry');
select is(pg_temp.warning_session_boundary()->>'detail','CLEANING_HISTORY_ACCESS_REQUIRED','detail denies exact session hard expiry');
update auth.sessions set not_after=null where id=pg_temp.warning_id(202);

-- This test-only mutation demonstrates that read snapshot and fresh command
-- guards remain different. The protected developer cannot enter this state via
-- production commands; replica mode is confined to the enclosing synthetic block.
create function pg_temp.warning_developer_password(p_required boolean) returns void language plpgsql as $$
begin
  if current_setting('session_replication_role')<>'replica' then
    raise exception 'WARNING_GUARD_SYNTHESIS_MODE_REQUIRED';
  end if;
  update public.profiles set must_change_password=p_required where id=pg_temp.warning_id(1);
end $$;
create function pg_temp.warning_guard_snapshots() returns jsonb language plpgsql stable as $$
declare read_allowed boolean:=false; command_denied boolean:=false;
begin
  perform pg_temp.warning_developer_password(true);
  perform private.assert_active_developer_snapshot(pg_temp.warning_id(1));
  read_allowed:=true;
  begin perform private.assert_active_developer(pg_temp.warning_id(1));
  exception when insufficient_privilege then command_denied:=sqlerrm='DEVELOPER_REQUIRED'; end;
  return jsonb_build_object('snapshotAllowed',read_allowed,'freshCommandDenied',command_denied);
end $$;
set local session_replication_role = replica;
select is(pg_temp.warning_guard_snapshots(),
  '{"snapshotAllowed":true,"freshCommandDenied":true}'::jsonb,
  'read guard uses the calling snapshot while existing command guard observes a fresh DB state');
set local session_replication_role = origin;
select throws_ok($$select public.get_developer_room_catalog(pg_temp.warning_id(1))$$,
  '42501','DEVELOPER_REQUIRED','next catalog statement observes the latest password-change restriction');
set local session_replication_role = replica;
select pg_temp.warning_developer_password(false);
update public.profiles set status='inactive' where id=pg_temp.warning_id(1);
set local session_replication_role = origin;
select throws_ok($$select public.get_developer_room_catalog(pg_temp.warning_id(1))$$,
  '42501','DEVELOPER_REQUIRED','snapshot catalog guard rejects a synthetic inactive developer');
set local session_replication_role = replica;
update public.profiles set status='active' where id=pg_temp.warning_id(1);
set local session_replication_role = origin;

-- Test caller is an invoker and records only SQLSTATE class, so an existing
-- schema denial and a function ACL denial both prove that direct execution fails.
create function pg_temp.warning_direct_guard_denied() returns boolean language plpgsql as $$
begin
  perform private.assert_active_developer_snapshot(pg_temp.warning_id(1));
  return false;
exception when insufficient_privilege then return true;
end $$;
insert into warning_checkpoints values('before-actual-role-reads',pg_temp.warning_state());
set local role anon;
select ok(pg_temp.warning_direct_guard_denied(),'actual anon cannot directly invoke the private snapshot guard');
reset role;
set local role authenticated;
select ok(pg_temp.warning_direct_guard_denied(),'actual authenticated cannot directly invoke the private snapshot guard');
reset role;
set local role service_role;
select ok(pg_temp.warning_direct_guard_denied(),'actual service role cannot directly invoke the private snapshot guard');
select lives_ok($$select public.get_developer_room_catalog(pg_temp.warning_id(1))$$,
  'actual service role can use the actor-checked public catalog');
select lives_ok($$select pg_temp.warning_list()$$,'actual service role can use the session-checked public history list');
select lives_ok($$select pg_temp.warning_detail()$$,'actual service role can use the session-checked public history detail');
reset role;
select is(pg_temp.warning_state(),(select value from warning_checkpoints where label='before-actual-role-reads'),
  'actual caller-role ACL checks and service projections create no persistent row changes');
select is(current_setting('session_replication_role'),'origin','all bounded synthetic mutations restore normal trigger execution');

select * from finish();
rollback;
