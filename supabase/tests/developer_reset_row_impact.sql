-- #396 source-only regression. This file has NOT been executed during development.
begin;
select no_plan();
select is((select provolatile::text from pg_proc where oid='private.collect_developer_reset_row_impact()'::regprocedure),
  's','row candidate and FK reads share the STABLE caller snapshot');
select is((select provolatile::text from pg_proc where oid='private.collect_developer_reset_impact_preview()'::regprocedure),
  's','independent inventory and row counts share one snapshot');
select ok((select prosecdef from pg_proc where oid='private.collect_developer_reset_row_impact()'::regprocedure),
  'private collector owns the bounded read without granting table access');
select ok(not has_function_privilege('service_role','private.collect_developer_reset_row_impact()','EXECUTE'),
  'service role cannot bypass developer authorization through private collector');
select ok(not has_function_privilege('authenticated','private.collect_developer_reset_row_impact()','EXECUTE'),
  'authenticated role cannot collect raw relation/FK metadata');
select ok(not has_function_privilege('anon','private.developer_reset_disposition_expression(text,text)','EXECUTE'),
  'anonymous role cannot inspect policy helper');
select ok(not has_function_privilege('service_role','private.collect_developer_reset_impact_preview()','EXECUTE'),
  'combined collector remains private');
select is(private.developer_reset_disposition_expression('private.future_unreviewed','r'),null::text,
  'unknown relations never receive a wildcard reset rule');
select is(private.developer_reset_disposition_expression('public.profiles','r;select 1'),null::text,
  'only fixed internal SQL aliases are allowed');
select is(private.developer_reset_disposition_expression('public.submission_photos','r'),
  '''photoHold''::text','submission photo bindings remain under the photo HOLD');
select is(private.developer_reset_disposition_expression('private.room_pin_nonce_reservations','r'),
  '''preserve''::text','global nonce registry is never a reset candidate');
create temporary table reset_auth_before as
select private.collect_developer_reset_row_impact()->'authBoundary' evidence;
insert into auth.users(id,email) values ('39000000-0000-4000-8000-000000000001','reset-row-orphan@example.invalid');
select is((private.collect_developer_reset_row_impact()#>>'{authBoundary,unresolved}')::bigint,
  (select (evidence->>'unresolved')::bigint+1 from reset_auth_before),
  'an Auth ID without a profile is counted as unresolved, never silently omitted');
select is((private.collect_developer_reset_row_impact()#>>'{authBoundary,rowCount}')::bigint,
  (select (evidence->>'rowCount')::bigint+1 from reset_auth_before),
  'the independent Auth census includes the unlinked account');
select throws_ok($$ select public.get_developer_reset_preview(null,null,null) $$,'42501',null,
  'NULL identity cannot trigger impact collection');
select throws_ok($$ select public.get_developer_reset_preview('00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000001','malformed') $$,'42501',null,
  'malformed session cannot trigger impact collection');
-- Existing developer_reset_preview.sql supplies developer/admin/maid, actor mismatch,
-- expired/other session, password gate and authenticated EXECUTE regressions for the
-- same replaced public RPC. Do not broaden its service-only EXECUTE ACL.
select * from finish();
rollback;
