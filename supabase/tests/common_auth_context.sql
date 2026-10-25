-- #442 candidate: NOT RUN until the user approves final database validation.
begin;
select no_plan();
create function pg_temp.context_id(n integer) returns uuid language sql immutable as $$
  select ('f4420000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid
$$;
insert into auth.users(id) values(pg_temp.context_id(1)),(pg_temp.context_id(2));
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,
  login_id_normalized,login_sequence,role,status,must_change_password) values
  (pg_temp.context_id(11),pg_temp.context_id(1),'context-fixture','context-fixture',
   'context-fixture','context-fixture',0,'maid','active',true);
insert into auth.sessions(id,user_id,not_after) values
  (pg_temp.context_id(21),pg_temp.context_id(1),null),
  (pg_temp.context_id(22),pg_temp.context_id(1),clock_timestamp()+interval '1 day'),
  (pg_temp.context_id(23),pg_temp.context_id(1),clock_timestamp()-interval '1 second'),
  (pg_temp.context_id(24),pg_temp.context_id(2),null);
create function pg_temp.context_code(user_id uuid, session_id text) returns text language sql volatile as $$
  select public.get_active_auth_context(user_id, session_id)->>'code'
$$;

select is((select provolatile::text from pg_proc where oid='public.get_active_auth_context(uuid,text)'::regprocedure),
  'v','fresh snapshots require VOLATILE');
select is((select proisstrict from pg_proc where oid='public.get_active_auth_context(uuid,text)'::regprocedure),
  false,'NULL session does not bypass profile precedence');
select is((select prosecdef from pg_proc where oid='public.get_active_auth_context(uuid,text)'::regprocedure),true,'server-only definer');
select is((select proconfig from pg_proc where oid='public.get_active_auth_context(uuid,text)'::regprocedure),
  array['search_path=pg_catalog']::text[],'fixed search path');
select ok(not has_function_privilege('anon','public.get_active_auth_context(uuid,text)','EXECUTE'),'anon denied');
select ok(not has_function_privilege('authenticated','public.get_active_auth_context(uuid,text)','EXECUTE'),'authenticated denied');
select ok(has_function_privilege('service_role','public.get_active_auth_context(uuid,text)','EXECUTE'),'server allowed');
set local role authenticated;
select throws_ok($$select public.get_active_auth_context(null,null)$$,'42501',
  'permission denied for function get_active_auth_context','actual unprivileged call denied');
reset role;
set local role service_role;
select is(pg_temp.context_code(pg_temp.context_id(1),pg_temp.context_id(21)::text),'OK','NULL hard deadline');
select is(pg_temp.context_code(pg_temp.context_id(1),pg_temp.context_id(22)::text),'OK','future deadline');
select is(pg_temp.context_code(pg_temp.context_id(1),pg_temp.context_id(23)::text),'SESSION_REVOKED','past deadline');
select is(pg_temp.context_code(pg_temp.context_id(1),pg_temp.context_id(24)::text),'SESSION_REVOKED','other user session');
select is(pg_temp.context_code(pg_temp.context_id(1),pg_temp.context_id(25)::text),'SESSION_REVOKED','deleted/missing session');
select is(pg_temp.context_code(pg_temp.context_id(1),'malformed'),'SESSION_REVOKED','UUID cast after profile');
select is(pg_temp.context_code(pg_temp.context_id(1),null),'INVALID_ACCESS_TOKEN','missing claim');
select is(pg_temp.context_code(pg_temp.context_id(1),''),'INVALID_ACCESS_TOKEN','empty claim');
select is(pg_temp.context_code(pg_temp.context_id(2),null),'PROFILE_NOT_FOUND','missing profile before missing claim');
select is(pg_temp.context_code(pg_temp.context_id(2),'malformed'),'PROFILE_NOT_FOUND','missing profile before malformed claim');
select is(pg_temp.context_code(null,null),'PROFILE_NOT_FOUND','NULL user fails closed');
select is(public.get_active_auth_context(pg_temp.context_id(1),pg_temp.context_id(21)::text),
  jsonb_build_object('code','OK','profile',jsonb_build_object('id',pg_temp.context_id(11),
  'auth_user_id',pg_temp.context_id(1),'display_name','context-fixture','role','maid','must_change_password',true)),
  'exact minimal current profile; password gate carried, no token/session fields');
reset role;
update auth.sessions set not_after=clock_timestamp() where id=pg_temp.context_id(22);
select is(pg_temp.context_code(pg_temp.context_id(1),pg_temp.context_id(22)::text),'SESSION_REVOKED','exact deadline never extends');
delete from auth.sessions where id=pg_temp.context_id(21);
select is(pg_temp.context_code(pg_temp.context_id(1),pg_temp.context_id(21)::text),'SESSION_REVOKED','no success cache after deletion');
update public.profiles set status='inactive' where id=pg_temp.context_id(11);
select is(public.get_active_auth_context(pg_temp.context_id(1),null),jsonb_build_object('code','ACCOUNT_INACTIVE'),
  'inactive before missing claim, no actor fields on failure');
select is(pg_temp.context_code(pg_temp.context_id(1),'malformed'),'ACCOUNT_INACTIVE','inactive before UUID cast');
update public.profiles set status='upload_only' where id=pg_temp.context_id(11);
select is(pg_temp.context_code(pg_temp.context_id(1),null),'ACCOUNT_INACTIVE','upload-only stays on separate limited path');
update public.profiles set status='deactivation_pending' where id=pg_temp.context_id(11);
select is(pg_temp.context_code(pg_temp.context_id(1),null),'ACCOUNT_INACTIVE','pending stays on separate limited path');
select * from finish();
rollback;
