-- #559 rollback-only regression. Actual SQL/PLpgSQL execution is NOT RUN during development.
begin;
select no_plan();

create function pg_temp.availability_guard_before_559(
  p_version_id uuid, p_week_start date, p_dates date[], p_command_at timestamptz
) returns void language plpgsql set search_path = pg_catalog as $$
begin
  if p_version_id is null and exists (select 1 from unnest(p_dates) d where d < (p_command_at at time zone 'Asia/Seoul')::date) then
    raise exception using errcode = '22023', message = 'PAST_AVAILABILITY_DATE_NOT_ALLOWED';
  end if;
  if exists (
    select 1 from public.availability_days d
    where d.availability_version_id = p_version_id
      and d.work_date < (p_command_at at time zone 'Asia/Seoul')::date
      and d.available is distinct from (d.work_date = any(p_dates))
  ) then
    raise exception using errcode = '22023', message = 'PAST_AVAILABILITY_DATE_NOT_ALLOWED';
  end if;
end;
$$;

insert into auth.users(id) values ('55900000-0000-4000-8000-000000000101');
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
  login_sequence,role,status,must_change_password)
values ('55900000-0000-4000-8000-000000000001','55900000-0000-4000-8000-000000000101',
  '가드 합성559','가드 합성559','availability-guard-559','availability-guard-559',0,'maid','active',false);
insert into public.availability_versions(id,maid_profile_id,week_start,version,submitted_at)
values ('55900000-0000-4000-8000-000000000201','55900000-0000-4000-8000-000000000001','2026-11-02',1,'2026-11-01 12:00:00+09');
insert into public.availability_days(availability_version_id,work_date,available)
select '55900000-0000-4000-8000-000000000201'::uuid,'2026-11-02'::date+n,n=0 from generate_series(0,6)n;

create function pg_temp.check_availability_guard_559() returns void language plpgsql as $availability_guard_559$
declare expected jsonb; actual record; actual_acl text[];
begin
  if to_regprocedure('private.assert_availability_past_unchanged(uuid,date[],timestamptz)') is not null then
    raise exception using errcode='55000',message='AVAILABILITY_GUARD_SOURCE_DRIFT';
  end if;
  for expected in select value from jsonb_array_elements($origins$[{"identity":"private.assert_availability_past_unchanged(uuid,date,date[],timestamptz)","beforeSha256":"e24f147079881aa327529ad2df2283aa502e9c96229ee0f6d358886ed8d1c390","afterSha256":"e24f147079881aa327529ad2df2283aa502e9c96229ee0f6d358886ed8d1c390","returnType":"void","securityDefiner":false,"argumentNames":["p_version_id","p_week_start","p_dates","p_command_at"],"settings":["search_path=pg_catalog"]},{"identity":"private.request_availability_change_at(uuid,date,date[],text,integer,text,timestamptz)","beforeSha256":"219b6a499f4e19b10743c06a047a8255ff32b81ce184fa7f1d931c9845547354","afterSha256":"24d5287e5137557a16143c3122010abee62721bb3e46c8211bc79a5531d11327","returnType":"public.availability_change_requests","securityDefiner":true,"argumentNames":["p_actor_profile_id","p_week_start","p_requested_available_dates","p_reason_code","p_expected_version","p_idempotency_key","p_command_at"],"settings":["search_path=pg_catalog, public, extensions"]},{"identity":"private.decide_availability_change_at(uuid,uuid,public.availability_request_status,text,integer,text,timestamptz)","beforeSha256":"906b3b5602a45e83450a2d7d76cdca178b76f6c3f68dc69085989436c6dd0c20","afterSha256":"bd1cb599f4d4764ad7d47877d29c5da7c83d09550882eb1e104c04afda06c3f5","returnType":"public.availability_change_requests","securityDefiner":true,"argumentNames":["p_actor_profile_id","p_change_request_id","p_decision","p_reason_code","p_expected_version","p_idempotency_key","p_command_at"],"settings":["search_path=pg_catalog, public, extensions"]}]$origins$::jsonb) loop
    select p.*,r.rolname as owner_name,l.lanname as language_name into actual
      from pg_proc p join pg_roles r on r.oid=p.proowner join pg_language l on l.oid=p.prolang
      where p.oid=to_regprocedure(expected->>'identity');
    if not found then
      raise exception using errcode='55000',message='AVAILABILITY_GUARD_SOURCE_DRIFT';
    end if;
    select array_agg(a::text order by a::text) into actual_acl
      from unnest(coalesce(actual.proacl,acldefault('f',actual.proowner))) a;
    if encode(extensions.digest(replace(actual.prosrc,E'\r\n',E'\n'),'sha256'),'hex')<>expected->>'beforeSha256'
      or position(E'\r' in replace(actual.prosrc,E'\r\n',E'\n'))<>0
      or actual.prokind<>'f' or actual.language_name<>'plpgsql' or actual.owner_name<>'postgres'
      or actual.provolatile<>'v' or actual.proisstrict or actual.proretset
      or actual.prosecdef is distinct from (expected->>'securityDefiner')::boolean
      or actual.prorettype<>to_regtype(expected->>'returnType')
      or to_jsonb(actual.proargnames) is distinct from expected->'argumentNames'
      or to_jsonb(actual.proconfig) is distinct from expected->'settings'
      or actual_acl is distinct from array['postgres=X/postgres']::text[]
      or actual.proleakproof or actual.proparallel<>'u'
      or actual.pronargdefaults<>0 or actual.proargdefaults is not null
      or actual.proargmodes is not null or actual.proallargtypes is not null
      or actual.provariadic<>0 or actual.prosupport<>0 or actual.probin is not null
      or actual.procost<>100 or actual.prorows<>0
      or (select count(*) from pg_proc p where p.pronamespace=actual.pronamespace and p.proname=actual.proname)<>1 then
      raise exception using errcode='55000',message='AVAILABILITY_GUARD_SOURCE_DRIFT';
    end if;
  end loop;
end
$availability_guard_559$;

select throws_ok('select pg_temp.check_availability_guard_559()','55000','AVAILABILITY_GUARD_SOURCE_DRIFT',
  'already corrected helper identity cannot be silently reapplied');

-- No reset/start is added: reconstruct and apply in this one rolled-back transaction.
\ir availability_guard_unused_parameter_fixture.psql

select lives_ok('select pg_temp.check_availability_guard_559()','exact previous source and catalog are accepted');
create function pg_temp.availability_guard_rejects_source_drift_559() returns boolean language plpgsql as $$
declare original text; body text; rejected boolean:=false;
begin
  select pg_get_functiondef(p.oid),p.prosrc into strict original,body from pg_proc p
    where p.oid='private.request_availability_change_at(uuid,date,date[],text,integer,text,timestamptz)'::regprocedure;
  execute replace(original,body,body||E'\n-- synthetic559 source drift');
  begin
    perform pg_temp.check_availability_guard_559();
  exception when sqlstate '55000' then
    rejected:=sqlerrm='AVAILABILITY_GUARD_SOURCE_DRIFT';
  end;
  execute original;
  return rejected;
end $$;
select ok(pg_temp.availability_guard_rejects_source_drift_559(),'unexpected caller body is rejected by the actual prestate guard');
select lives_ok('select pg_temp.check_availability_guard_559()','exact source is restored after rejection');

create temporary table availability_guard_before_catalog_559 as
select p.oid,to_jsonb(p)-'prosrc' as attributes,p.prosrc
from pg_proc p where p.oid in (
  'private.assert_availability_past_unchanged(uuid,date,date[],timestamptz)'::regprocedure,
  'private.request_availability_change_at(uuid,date,date[],text,integer,text,timestamptz)'::regprocedure,
  'private.decide_availability_change_at(uuid,uuid,public.availability_request_status,text,integer,text,timestamptz)'::regprocedure
);
create temporary table availability_guard_before_rows_559 as
select
  (select count(*) from public.availability_versions) as versions,
  (select count(*) from public.availability_days) as days,
  (select count(*) from public.availability_change_requests) as requests,
  (select count(*) from public.audit_events) as audits;
\ir ../migrations/20261101235415_availability_guard_unused_parameter.sql

select ok(to_regprocedure('private.assert_availability_past_unchanged(uuid,date,date[],timestamptz)') is null,
  'old private four-argument identity is removed');
select is((select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='private' and p.proname='assert_availability_past_unchanged'),1::bigint,'only the new private overload exists');
select ok((select p.oid not in (select oid from availability_guard_before_catalog_559)
  from pg_proc p where p.oid='private.assert_availability_past_unchanged(uuid,date[],timestamptz)'::regprocedure),
  'changed private signature intentionally receives a new OID');
select is((select count(*) from availability_guard_before_catalog_559 b join pg_proc p on p.oid=b.oid
  where p.proname in ('request_availability_change_at','decide_availability_change_at')
    and to_jsonb(p)-'prosrc'=b.attributes),2::bigint,'both callers preserve OID and every non-body catalog field');
select is((select prosrc from pg_proc where oid='private.assert_availability_past_unchanged(uuid,date[],timestamptz)'::regprocedure),
  (select prosrc from pg_proc where oid='pg_temp.availability_guard_before_559(uuid,date,date[],timestamptz)'::regprocedure),
  'new helper has the exact original body');
select is((select to_jsonb(p)-array['oid','pronargs','proargtypes','proargnames','prosrc']
  from pg_proc p where p.oid='private.assert_availability_past_unchanged(uuid,date[],timestamptz)'::regprocedure),
  (select attributes-array['oid','pronargs','proargtypes','proargnames'] from availability_guard_before_catalog_559
   where attributes->>'proname'='assert_availability_past_unchanged'),
  'new helper preserves all other catalog fields');
select ok(not has_function_privilege(role_name,'private.assert_availability_past_unchanged(uuid,date[],timestamptz)','EXECUTE'),
  'private helper is not executable by '||role_name) from unnest(array['anon','authenticated','service_role']) role_name;
select is((select array_agg(a::text order by a::text) from pg_proc p,
  lateral unnest(coalesce(p.proacl,acldefault('f',p.proowner))) a
  where p.oid='private.assert_availability_past_unchanged(uuid,date[],timestamptz)'::regprocedure),
  array['postgres=X/postgres']::text[],'new helper ACL contains only its owner');
select ok((select versions=(select count(*) from public.availability_versions)
  and days=(select count(*) from public.availability_days)
  and requests=(select count(*) from public.availability_change_requests)
  and audits=(select count(*) from public.audit_events) from availability_guard_before_rows_559),
  'append creates no availability version/day/request/audit rows');

create function pg_temp.availability_guard_outcome_559(p_old boolean,p_version uuid,p_dates date[],p_at timestamptz)
returns text language plpgsql as $$
begin
  if p_old then perform pg_temp.availability_guard_before_559(p_version,'2026-11-02',p_dates,p_at);
  else perform private.assert_availability_past_unchanged(p_version,p_dates,p_at); end if;
  return 'OK';
exception when others then return sqlstate||':'||sqlerrm;
end $$;
create temporary table availability_guard_cases_559(label text,version_id uuid,dates date[],command_at timestamptz,expected text);
insert into availability_guard_cases_559 values
  ('first request future days',null,array['2026-11-05'::date],'2026-11-04 12:00:00+09','OK'),
  ('first request today',null,array['2026-11-04'::date],'2026-11-04 12:00:00+09','OK'),
  ('first request past day',null,array['2026-11-03'::date],'2026-11-04 12:00:00+09','22023:PAST_AVAILABILITY_DATE_NOT_ALLOWED'),
  ('first request empty days',null,'{}'::date[],'2026-11-04 12:00:00+09','OK'),
  ('existing past true and false preserved','55900000-0000-4000-8000-000000000201',array['2026-11-02'::date],'2026-11-04 12:00:00+09','OK'),
  ('existing past true cannot clear','55900000-0000-4000-8000-000000000201','{}'::date[],'2026-11-04 12:00:00+09','22023:PAST_AVAILABILITY_DATE_NOT_ALLOWED'),
  ('existing past false cannot set','55900000-0000-4000-8000-000000000201',array['2026-11-02'::date,'2026-11-03'::date],'2026-11-04 12:00:00+09','22023:PAST_AVAILABILITY_DATE_NOT_ALLOWED'),
  ('existing today and future can change','55900000-0000-4000-8000-000000000201',array['2026-11-02'::date,'2026-11-04'::date,'2026-11-05'::date],'2026-11-04 12:00:00+09','OK'),
  ('KST boundary before midnight',null,array['2026-11-03'::date],'2026-11-03 14:59:59.999999+00','OK'),
  ('KST boundary at midnight',null,array['2026-11-03'::date],'2026-11-03 15:00:00+00','22023:PAST_AVAILABILITY_DATE_NOT_ALLOWED');
select is(pg_temp.availability_guard_outcome_559(false,version_id,dates,command_at),expected,label)
from availability_guard_cases_559;
select is(pg_temp.availability_guard_outcome_559(false,version_id,dates,command_at),
  pg_temp.availability_guard_outcome_559(true,version_id,dates,command_at),'old/new behavior: '||label)
from availability_guard_cases_559;

-- Existing weekly_availability.sql retains complete request/approval/CAS/replay/role tests.
select * from finish();
rollback;
