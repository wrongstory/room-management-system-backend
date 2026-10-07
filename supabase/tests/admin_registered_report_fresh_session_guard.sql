begin;
select no_plan();

-- Owner-only synthetic fixtures; every Auth/business change is rolled back.
-- Requires the real #329 helper and both #332 migrations. This test does not
-- widen or replace #329's strict migration-time 21/6/18/2 inventory.
create function pg_temp.rfid(n integer) returns uuid language sql immutable as $$
  select ('33240000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
insert into auth.users(id) select pg_temp.rfid(n+100) from generate_series(1,7)n;
select public.bootstrap_first_developer_profile(pg_temp.rfid(3),pg_temp.rfid(103),
  'report fresh developer','report fresh developer','0031','report-fresh-bootstrap-hash','report-fresh-bootstrap-key');
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
  login_sequence,role,status,must_change_password)
select pg_temp.rfid(n),pg_temp.rfid(n+100),'report-fresh-'||n,'report-fresh-'||n,
  'report-fresh-'||n,'report-fresh-'||n,0,
  (case when n=2 then 'maid' else 'admin' end)::public.app_role,
  (case n when 4 then 'inactive' when 5 then 'departed' else 'active' end)::public.account_status,n=6
from generate_series(1,7)n where n<>3;
insert into auth.sessions(id,user_id,not_after)
select pg_temp.rfid(n+200),pg_temp.rfid(n+100),null from generate_series(1,7)n;
create function pg_temp.rfroom() returns uuid language sql stable as $$
  select id from public.rooms order by id limit 1
$$;

select ok((select p.provolatile='v' and p.prosecdef and p.prokind='f'
  and p.prorettype='jsonb'::regtype and p.pronargdefaults=3
  and p.proconfig=array['search_path=""']::text[]
  and md5(replace(p.prosrc,E'\r\n',E'\n'))='5981a7d9c2d1a4ecba51c45bb4f04ffb'
  and md5(replace(replace(p.prosrc,'private.assert_attempt_actor_session_fresh(',
    'private.assert_attempt_actor_session('),E'\r\n',E'\n'))='5244a78ce24b971106cae3d7bd49d46b'
  and strpos(p.prosrc,'private.assert_attempt_actor_session(')=0
  and (length(p.prosrc)-length(replace(p.prosrc,'private.assert_attempt_actor_session_fresh(','')))
    /length('private.assert_attempt_actor_session_fresh(')=1
  from pg_proc p where p.oid='public.list_room_reports_page(uuid,uuid,uuid,integer,timestamptz,uuid)'::regprocedure),
  'report RPC retains original VOLATILE/security/defaults/query body with exactly one fresh call');
select ok((select p.provolatile='v' and p.prosecdef and p.prorettype='public.profiles'::regtype
  and p.proconfig=array['search_path=""']::text[]
  from pg_proc p where p.oid='private.assert_attempt_actor_session_fresh(uuid,uuid,boolean)'::regprocedure),
  'real #329 fresh dependency retains its VOLATILE private identity contract');
select ok(has_function_privilege('service_role',
  'public.list_room_reports_page(uuid,uuid,uuid,integer,timestamptz,uuid)','EXECUTE'),
  'registered report RPC remains service-role callable');
select ok(not has_function_privilege(name,
  'public.list_room_reports_page(uuid,uuid,uuid,integer,timestamptz,uuid)','EXECUTE'),
  'no direct report RPC access for '||name) from (values('anon'),('authenticated'))roles(name);
select ok(not has_function_privilege(name,
  'private.assert_attempt_actor_session_fresh(uuid,uuid,boolean)','EXECUTE'),
  'fresh helper is private from '||name) from (values('anon'),('authenticated'),('service_role'))roles(name);

-- Explicit original submatrix, not a global census of later feature callers.
select ok((select count(*)=6 and bool_and(p.provolatile='s'
    and (length(p.prosrc)-length(replace(p.prosrc,'private.assert_attempt_actor_session(','')))
      /length('private.assert_attempt_actor_session(')=1)
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
    and p.proname=any(array['get_limited_cleaning_attempt','get_cleaning_attempt_lifecycle_impact',
      'get_offline_event_quarantine','list_offline_event_quarantine',
      'list_checkout_cleaning_templates','list_room_type_catalog']::text[])),
  'all original six snapshot callers remain STABLE with their one original helper call');
select ok((select count(*)=18 and bool_and(p.provolatile='v'
    and strpos(p.prosrc,'private.assert_attempt_actor_session_fresh(')>0)
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname||'.'||p.proname=any(array[
    'private.assert_photo_upload_actor','private.cancel_unavailable_cleaning_assignment_at',
    'private.complete_limited_attempt_at','private.create_cleaning_submission_session_core',
    'private.manage_cleaning_attempt_lifecycle_at','private.resolve_offline_quarantine_at',
    'private.start_attempt_with_lease_at','private.sync_attempt_event_at',
    'public.correct_room_occupancy','public.get_photo_upload_receipt_with_session',
    'public.list_limited_cleaning_attempts','public.list_room_events','public.list_room_issues',
    'public.list_room_issues_page','public.list_room_operation_blocks','public.list_room_operation_blocks_page',
    'public.override_room_display_status','public.publish_checkout_cleaning_template']::text[])),
  'all original eighteen fresh callers remain unchanged in their VOLATILE fresh class');
select ok((select count(*)=2 and bool_and(
    (length(p.prosrc)-length(replace(p.prosrc,'private.assert_attempt_actor_session_at_clock(','')))
      /length('private.assert_attempt_actor_session_at_clock(')=1
    and p.provolatile=case p.proname when 'assert_attempt_actor_session' then 's'::"char" else 'v'::"char" end)
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private'
    and p.proname=any(array['assert_attempt_actor_session','assert_attempt_actor_session_fresh']::text[])),
  'original two at-clock wrappers retain exact calls and distinct snapshot/fresh volatility');

create temporary table report_fresh_preserved as
select to_jsonb(r) room_row from public.rooms r where r.id=pg_temp.rfroom();
select lives_ok($$select public.list_room_reports_page(pg_temp.rfid(1),pg_temp.rfid(201),pg_temp.rfroom())$$,
  'active password-complete admin and actual live session can read');
select is(jsonb_array_length(public.list_room_reports_page(pg_temp.rfid(1),pg_temp.rfid(201),pg_temp.rfroom())->'items'),
  0,'empty registered-report projection remains empty, not current uploads');
select throws_ok(format('select public.list_room_reports_page(%L,%L,%L)',
  pg_temp.rfid(n),pg_temp.rfid(n+200),pg_temp.rfroom()),'42501','ADMIN_REQUIRED',
  'latest non-admin/non-active profile is rejected '||n) from generate_series(2,5)n;
select throws_ok($$select public.list_room_reports_page(pg_temp.rfid(6),pg_temp.rfid(206),pg_temp.rfroom())$$,
  '42501','PASSWORD_CHANGE_REQUIRED','latest password gate is retained');
select throws_ok($$select public.list_room_reports_page(pg_temp.rfid(1),pg_temp.rfid(207),pg_temp.rfroom())$$,
  '42501','SESSION_REVOKED','another admin session cannot impersonate the actor');
select throws_ok($$select public.list_room_reports_page(pg_temp.rfid(1),null,pg_temp.rfroom())$$,
  '42501','SESSION_REVOKED','NULL session is never a snapshot fallback');

-- Real Auth row is expired within a single outer query: the old STABLE helper
-- deliberately sees that query's snapshot; the real report RPC must see fresh.
update auth.sessions set not_after=clock_timestamp()+interval '1 hour' where id=pg_temp.rfid(201);
create function pg_temp.rfexpire() returns boolean language plpgsql as $$
begin
  update auth.sessions set not_after=clock_timestamp()-interval '1 microsecond' where id=pg_temp.rfid(201);
  return true;
end $$;
create function pg_temp.rfdenied() returns boolean language plpgsql as $$
begin
  perform public.list_room_reports_page(pg_temp.rfid(1),pg_temp.rfid(201),pg_temp.rfroom());
  return false;
exception when sqlstate '42501' then return sqlerrm='SESSION_REVOKED';
end $$;
with expired as materialized(select pg_temp.rfexpire() changed)
select ok(changed and (private.assert_attempt_actor_session(pg_temp.rfid(1),pg_temp.rfid(201),true)).id=pg_temp.rfid(1)
  and pg_temp.rfdenied(),'same outer statement preserves old snapshot semantics but report fresh guard rejects the just-expired session')
from expired;
select throws_ok($$select public.list_room_reports_page(pg_temp.rfid(1),pg_temp.rfid(201),pg_temp.rfroom())$$,
  '42501','SESSION_REVOKED','already hard-expired real session is rejected');
update auth.sessions set not_after=null where id=pg_temp.rfid(201);
delete from auth.sessions where id=pg_temp.rfid(201);
select throws_ok($$select public.list_room_reports_page(pg_temp.rfid(1),pg_temp.rfid(201),pg_temp.rfroom())$$,
  '42501','SESSION_REVOKED','deleted real session cannot read registered reports');

select set_config('test.report_fresh_room',pg_temp.rfroom()::text,true);
set local role service_role;
select lives_ok($$select public.list_room_reports_page('33240000-0000-4000-8000-000000000007',
  '33240000-0000-4000-8000-000000000207',current_setting('test.report_fresh_room')::uuid)$$,
  'actual service role executes only the narrowed verified admin RPC');
select throws_ok($$select private.assert_attempt_actor_session_fresh(null,null,true)$$,
  '42501',null,'actual service role cannot directly invoke the private fresh helper');
reset role;
set local role anon;
select throws_ok($$select public.list_room_reports_page(null,null,null)$$,'42501',null,'actual anonymous report RPC denied');
reset role;
set local role authenticated;
select throws_ok($$select public.list_room_reports_page(null,null,null)$$,'42501',null,'actual authenticated report RPC denied');
reset role;
select is((select to_jsonb(r) from public.rooms r where r.id=pg_temp.rfroom()),
  (select room_row from report_fresh_preserved),'report reads and all denials leave room CAS/current state untouched');
select * from finish();
rollback;
