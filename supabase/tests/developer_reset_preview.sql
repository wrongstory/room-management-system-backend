-- #396 source-prepared security regression; run only in approved final DB validation.
begin;
select no_plan();
select ok(not has_function_privilege('anon','public.get_developer_reset_preview(uuid,uuid,text)','EXECUTE'),'anonymous cannot call reset preview');
select ok(not has_function_privilege('authenticated','public.get_developer_reset_preview(uuid,uuid,text)','EXECUTE'),'client JWT cannot impersonate a developer RPC actor');
select ok(has_function_privilege('service_role','public.get_developer_reset_preview(uuid,uuid,text)','EXECUTE'),'server adapter may request an authorized preview');
select ok(not has_function_privilege('service_role','private.collect_developer_reset_inventory()','EXECUTE'),'service role cannot bypass the authorization wrapper');
select ok(not has_function_privilege('anon','private.collect_developer_reset_inventory()','EXECUTE'),'anonymous cannot read internal inventory');
select is((select provolatile::text from pg_proc where oid='private.collect_developer_reset_inventory()'::regprocedure),'s','collector uses the calling statement snapshot');
select is((select provolatile::text from pg_proc where oid='public.get_developer_reset_preview(uuid,uuid,text)'::regprocedure),'v','wrapper refreshes authorization around collection');
select ok((select prosecdef from pg_proc where oid='public.get_developer_reset_preview(uuid,uuid,text)'::regprocedure),'server wrapper has explicit definer privileges');
select throws_ok($query$select public.get_developer_reset_preview('00000000-0000-4000-8000-000000000000','00000000-0000-4000-8000-000000000000','invalid')$query$,
  '42501','RESET_PREVIEW_AUTHORIZATION_FAILED','missing actor/session never reaches collection');

create function pg_temp.reset_id(n integer) returns uuid language sql immutable as $$
  select ('f3960000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid
$$;
insert into auth.users(id) values(pg_temp.reset_id(1)),(pg_temp.reset_id(2)),(pg_temp.reset_id(3));
set local role service_role;
select public.bootstrap_first_developer_profile(pg_temp.reset_id(11),pg_temp.reset_id(1),
  'reset-developer','reset-developer','0396','reset-preview-phone-hash','reset-preview-bootstrap');
reset role;
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,
  login_id_normalized,login_sequence,role,status,must_change_password) values
  (pg_temp.reset_id(12),pg_temp.reset_id(2),'reset-admin','reset-admin','reset-admin','reset-admin',0,'admin','active',false),
  (pg_temp.reset_id(13),pg_temp.reset_id(3),'reset-maid','reset-maid','reset-maid','reset-maid',0,'maid','active',false);
insert into auth.sessions(id,user_id,not_after) values
  (pg_temp.reset_id(21),pg_temp.reset_id(1),null),
  (pg_temp.reset_id(22),pg_temp.reset_id(2),null),
  (pg_temp.reset_id(23),pg_temp.reset_id(3),null),
  (pg_temp.reset_id(24),pg_temp.reset_id(1),clock_timestamp()-interval '1 second');
create function pg_temp.reset_preview(user_id uuid,profile_id uuid,session_id text) returns jsonb language sql volatile as $$
  select public.get_developer_reset_preview(user_id,profile_id,session_id)
$$;
set local role service_role;
select is(pg_temp.reset_preview(pg_temp.reset_id(1),pg_temp.reset_id(11),pg_temp.reset_id(21)::text)->>'readOnly','true','eligible developer receives a read-only inventory');
select ok(position('f3960000' in pg_temp.reset_preview(pg_temp.reset_id(1),pg_temp.reset_id(11),pg_temp.reset_id(21)::text)::text)=0,'raw fixture identities are absent from collected output');
select throws_ok($q$select pg_temp.reset_preview(pg_temp.reset_id(2),pg_temp.reset_id(12),pg_temp.reset_id(22)::text)$q$,'42501','DEVELOPER_REQUIRED','admin denied');
select throws_ok($q$select pg_temp.reset_preview(pg_temp.reset_id(3),pg_temp.reset_id(13),pg_temp.reset_id(23)::text)$q$,'42501','DEVELOPER_REQUIRED','maid denied');
select throws_ok($q$select pg_temp.reset_preview(pg_temp.reset_id(1),null,pg_temp.reset_id(21)::text)$q$,'42501','DEVELOPER_REQUIRED','NULL profile denied');
select throws_ok($q$select pg_temp.reset_preview(null,pg_temp.reset_id(11),pg_temp.reset_id(21)::text)$q$,'42501','RESET_PREVIEW_AUTHORIZATION_FAILED','NULL Auth actor denied');
select throws_ok($q$select pg_temp.reset_preview('malformed'::uuid,pg_temp.reset_id(11),pg_temp.reset_id(21)::text)$q$,'22P02','invalid input syntax for type uuid: "malformed"','malformed Auth actor cannot enter the wrapper');
select throws_ok($q$select pg_temp.reset_preview(pg_temp.reset_id(1),pg_temp.reset_id(12),pg_temp.reset_id(21)::text)$q$,'42501','DEVELOPER_REQUIRED','mismatched profile denied');
select throws_ok($q$select pg_temp.reset_preview(pg_temp.reset_id(1),pg_temp.reset_id(11),null)$q$,'42501','RESET_PREVIEW_AUTHORIZATION_FAILED','NULL session denied');
select throws_ok($q$select pg_temp.reset_preview(pg_temp.reset_id(1),pg_temp.reset_id(11),'malformed')$q$,'42501','RESET_PREVIEW_AUTHORIZATION_FAILED','malformed session denied');
select throws_ok($q$select pg_temp.reset_preview(pg_temp.reset_id(1),pg_temp.reset_id(11),pg_temp.reset_id(22)::text)$q$,'42501','RESET_PREVIEW_AUTHORIZATION_FAILED','other user session denied');
select throws_ok($q$select pg_temp.reset_preview(pg_temp.reset_id(1),pg_temp.reset_id(11),pg_temp.reset_id(24)::text)$q$,'42501','RESET_PREVIEW_AUTHORIZATION_FAILED','expired session denied');
reset role;
update public.profiles set must_change_password=true where id=pg_temp.reset_id(11);
select throws_ok($q$select pg_temp.reset_preview(pg_temp.reset_id(1),pg_temp.reset_id(11),pg_temp.reset_id(21)::text)$q$,'42501','DEVELOPER_REQUIRED','temporary-password developer denied');
set local role authenticated;
select throws_ok($q$select public.get_developer_reset_preview(null,null,null)$q$,'42501','permission denied for function get_developer_reset_preview','actual client execution permission denied');
reset role;
select ok((select 'statement_timeout=7s'=any(proconfig) from pg_proc where oid='public.get_developer_reset_preview(uuid,uuid,text)'::regprocedure),'RPC statement timeout is fixed');
select * from finish();
rollback;
