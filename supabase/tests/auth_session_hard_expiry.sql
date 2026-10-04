begin;
select no_plan();
\ir auth_session_hard_expiry_fixture.psql

create function pg_temp.session_state() returns text language plpgsql as $$
declare item record; pieces text[]:='{}'; value text;
begin
  for item in select n.nspname schema_name,c.relname table_name from pg_class c
    join pg_namespace n on n.oid=c.relnamespace where c.relkind='r'
      and (n.nspname in('public','private') or (n.nspname='auth' and c.relname in('users','sessions')))
    order by n.nspname,c.relname loop
    execute format('select coalesce(string_agg(to_jsonb(t)::text,''|'' order by to_jsonb(t)::text),'''') from %I.%I t',
      item.schema_name,item.table_name) into value;
    pieces:=array_append(pieces,item.schema_name||'.'||item.table_name||':'||value);
  end loop;
  return md5(array_to_string(pieces,'|'));
end $$;
create function pg_temp.session_command(p_session uuid,p_key text default 'session-allow-finish')
returns jsonb language sql as $$
  select public.manage_cleaning_attempt_lifecycle(pg_temp.session_id(1),p_session,pg_temp.session_id(801),
    2,pg_temp.session_id(701),2,1,'allow_finish','{}','DEACTIVATION_FINISH_CURRENT',p_key,repeat('b',64))
$$;
create function pg_temp.session_exact_boundary() returns boolean language plpgsql as $$
declare result boolean;
begin
  -- Both statements share the enclosing statement clock, but the volatile
  -- wrapper makes the UPDATE visible before the STABLE helper is invoked.
  update auth.sessions set not_after=statement_timestamp() where id=pg_temp.session_id(501);
  if (select not_after from auth.sessions where id=pg_temp.session_id(501))
    is distinct from statement_timestamp() then raise exception 'SESSION_BOUNDARY_FIXTURE_INVALID'; end if;
  select public.is_active_auth_session(pg_temp.session_id(101),pg_temp.session_id(501)) into result;
  return result;
end $$;
create temp table session_checkpoints(label text primary key,value jsonb);

select is(public.is_active_auth_session(pg_temp.session_id(101),pg_temp.session_id(201)),true,'NULL not_after remains compatible');
select is(public.is_active_auth_session(pg_temp.session_id(101),pg_temp.session_id(301)),true,'future hard deadline allows the exact owner');
select is(public.is_active_auth_session(pg_temp.session_id(101),pg_temp.session_id(401)),false,'past hard deadline denies a still-existing Auth session');
select is(pg_temp.session_exact_boundary(),false,'equal statement-clock hard deadline is excluded');
select is(public.is_active_auth_session(pg_temp.session_id(101),pg_temp.session_id(999)),false,'missing session is denied');
select is(public.is_active_auth_session(pg_temp.session_id(102),pg_temp.session_id(201)),false,'wrong user cannot borrow a session');
select is(public.is_active_auth_session(pg_temp.session_id(101),null),false,'NULL session ID is denied');
select is(public.is_active_auth_session(null,pg_temp.session_id(201)),false,'NULL user ID is denied');
select is(public.is_active_auth_session(null,null),false,'both NULL IDs are denied');
select is((select prorettype from pg_proc where oid='public.is_active_auth_session(uuid,uuid)'::regprocedure),
  'boolean'::regtype::oid,'return type stays boolean');
select is((select provolatile::text from pg_proc where oid='public.is_active_auth_session(uuid,uuid)'::regprocedure),'s','helper remains STABLE');
select is((select prosecdef from pg_proc where oid='public.is_active_auth_session(uuid,uuid)'::regprocedure),true,'existing SECURITY DEFINER contract is retained');
select is((select proconfig from pg_proc where oid='public.is_active_auth_session(uuid,uuid)'::regprocedure),
  array['search_path=pg_catalog']::text[],'fixed search_path is retained');
select ok(has_function_privilege('service_role','public.is_active_auth_session(uuid,uuid)','EXECUTE'),'service role retains EXECUTE');
select ok(not has_function_privilege('anon','public.is_active_auth_session(uuid,uuid)','EXECUTE'),'anon has no direct EXECUTE');
select ok(not has_function_privilege('authenticated','public.is_active_auth_session(uuid,uuid)','EXECUTE'),'authenticated has no direct EXECUTE');
set local role anon;
select throws_ok($$select public.is_active_auth_session(null,null)$$,'42501',
  'permission denied for schema public','actual anon invocation is denied by the existing schema boundary');
reset role;
set local role authenticated;
select throws_ok($$select public.is_active_auth_session(null,null)$$,'42501',
  'permission denied for function is_active_auth_session','actual authenticated invocation is denied');
reset role;
set local role service_role;
select is(public.is_active_auth_session(pg_temp.session_id(101),pg_temp.session_id(201)),true,
  'actual service role can invoke the NULL-deadline helper');
select is(public.is_active_auth_session(pg_temp.session_id(101),pg_temp.session_id(401)),false,
  'actual service role cannot authorize a past deadline');
reset role;

insert into session_checkpoints values('before-valid-reads',to_jsonb(pg_temp.session_state()));
select lives_ok($$select public.get_cleaning_attempt_lifecycle_impact(pg_temp.session_id(1),pg_temp.session_id(201),pg_temp.session_id(701))$$,
  'representative admin read allows existing NULL deadline');
select lives_ok($$select public.list_room_operation_blocks(pg_temp.session_id(1),pg_temp.session_id(301),
  (select room_id from public.cleaning_targets where id=pg_temp.session_id(601)),'actionable')$$,
  'representative room read allows a future deadline');
select is(to_jsonb(pg_temp.session_state()),(select value from session_checkpoints where label='before-valid-reads'),
  'valid reads preserve every public/private/Auth whole row including receipt and notification ledgers');
insert into session_checkpoints values('successful-command',pg_temp.session_command(pg_temp.session_id(201)));
select is((select status::text from public.profiles where id=pg_temp.session_id(2)),
  'deactivation_pending','existing command creates the legitimate limited state');
select is((select count(*) from private.attempt_capability_grants where attempt_id=pg_temp.session_id(801)),
  1::bigint,'existing command creates exactly one capability');
select is((select count(*) from private.command_executions where actor_profile_id=pg_temp.session_id(1)
  and command_type='cleaning.lifecycle.allow_finish' and idempotency_key='session-allow-finish'),
  1::bigint,'existing command creates exactly one scoped receipt');
insert into session_checkpoints values('before-valid-replay',to_jsonb(pg_temp.session_state()));
select is(pg_temp.session_command(pg_temp.session_id(301)),
  (select value from session_checkpoints where label='successful-command'),'valid future session preserves the exact existing receipt replay');
select lives_ok($$select public.get_limited_cleaning_attempt(pg_temp.session_id(2),pg_temp.session_id(202),pg_temp.session_id(801),2)$$,
  'limited maid read allows the unchanged NULL-deadline session and live capability');
select is(to_jsonb(pg_temp.session_state()),(select value from session_checkpoints where label='before-valid-replay'),
  'valid replay and limited read create no duplicate receipt, grant, audit or delivery');

update auth.sessions set not_after=statement_timestamp()-interval '1 day'
where id in(pg_temp.session_id(201),pg_temp.session_id(202));
insert into session_checkpoints values('before-expired-calls',to_jsonb(pg_temp.session_state()));
select throws_ok($$select public.get_cleaning_attempt_lifecycle_impact(pg_temp.session_id(1),pg_temp.session_id(201),pg_temp.session_id(701))$$,
  '42501','SESSION_REVOKED','expired admin session is rejected by the representative DB read');
select throws_ok($$select public.list_room_operation_blocks(pg_temp.session_id(1),pg_temp.session_id(401),
  (select room_id from public.cleaning_targets where id=pg_temp.session_id(601)),'actionable')$$,
  '42501','SESSION_REVOKED','expired room-read session keeps the existing error');
select throws_ok($$select public.get_limited_cleaning_attempt(pg_temp.session_id(2),pg_temp.session_id(202),pg_temp.session_id(801),2)$$,
  '42501','SESSION_REVOKED','a live limited capability does not bypass expired Auth session');
select throws_ok($$select pg_temp.session_command(pg_temp.session_id(201),'session-expired-new-command')$$,
  '42501','SESSION_REVOKED','expired session cannot create a new lifecycle command');
select throws_ok($$select pg_temp.session_command(pg_temp.session_id(201))$$,
  '42501','SESSION_REVOKED','expired session is rejected before existing receipt replay');
select is(to_jsonb(pg_temp.session_state()),(select value from session_checkpoints where label='before-expired-calls'),
  'expired reads/new command/replay preserve all whole rows, receipts, capability, audit and notification/provider-intent ledgers');
select is((select count(*) from private.command_executions where idempotency_key='session-expired-new-command'),
  0::bigint,'denied command leaves no attempted receipt');

select * from finish();
rollback;
