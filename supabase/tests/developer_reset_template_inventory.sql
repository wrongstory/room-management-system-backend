-- #396 source-only regression. Actual DB execution remains NOT RUN during development.
begin;
select no_plan();
select is((select provolatile::text from pg_proc where oid='private.collect_developer_reset_template_inventory()'::regprocedure),
  's','all template states use the common STABLE snapshot');
select ok((select prosecdef from pg_proc where oid='private.collect_developer_reset_template_inventory()'::regprocedure),
  'bounded collector owns private reads without new table grants');
select ok(not has_function_privilege('service_role','private.collect_developer_reset_template_inventory()','EXECUTE'),
  'service role cannot bypass public developer/session gate');
select ok(not has_function_privilege('authenticated','private.collect_developer_reset_template_inventory()','EXECUTE'),
  'authenticated caller cannot query template inventory directly');
select ok(not has_function_privilege('anon','private.inspect_reset_template_shape(jsonb,text,bigint)','EXECUTE'),
  'anonymous caller cannot execute the internal shape helper');
select ok(not has_function_privilege('service_role','private.inspect_reset_template_shape(jsonb,text,bigint)','EXECUTE'),
  'shape helper grants do not broaden the publishing API');
create temporary table reset_template_shapes as
select jsonb_build_object('id','39000000-0000-4000-8000-000000000002','version',9,
  'cleaning_kind','checkout','duration_minutes',null,'photo_slots',private.flat_cleaning_photo_slots()) flat,
  jsonb_build_object('id','39000000-0000-4000-8000-000000000003','version',7,
    'cleaning_kind','checkout','duration_minutes',null,'photo_slots',
    (select jsonb_agg(jsonb_build_object('slotKey',case when i=0 then 'tv-on' else 'legacy-'||i end,
      'label','Synthetic','displayOrder',i,'required',i<9) order by i) from generate_series(0,9) i)) legacy;
select is(private.inspect_reset_template_shape(flat,'standard',10),
  '{"historicallyReadable":true,"registrationShapeValid":true}'::jsonb,
  'current exact flat content is readable and satisfies fresh publication shape without modification') from reset_template_shapes;
select is(private.inspect_reset_template_shape(legacy,'standard',8),
  '{"historicallyReadable":true,"registrationShapeValid":false}'::jsonb,
  'historical v7 remains readable but cannot silently become a fresh maxPhotos-less publication') from reset_template_shapes;
select is(private.inspect_reset_template_shape(flat||jsonb_build_object('version',1,'photo_slots',
  (select jsonb_agg(value order by ord desc) from jsonb_array_elements(flat->'photo_slots') with ordinality s(value,ord))),
  'standard',2)->'registrationShapeValid','true'::jsonb,
  'a permuted flat draft uses the normalized v9 floor just like fresh publication') from reset_template_shapes;
select is(private.inspect_reset_template_shape(flat,'standard',2147483648)->'registrationShapeValid','false'::jsonb,
  'exhausted version is not a valid registration proposal') from reset_template_shapes;
select is(private.inspect_reset_template_shape(flat||'{"duration_minutes":0}'::jsonb,'standard',10)->'registrationShapeValid','false'::jsonb,
  'invalid duration cannot pass a template proposal') from reset_template_shapes;
select is(private.inspect_reset_template_shape(flat,'unreviewed-room-type',10)->'registrationShapeValid','false'::jsonb,
  'unknown room policy is never invented') from reset_template_shapes;
select is(private.inspect_reset_template_shape(null,null,null),
  '{"historicallyReadable":false,"registrationShapeValid":false}'::jsonb,'NULL helper inputs fail closed');
select throws_ok($$select public.get_developer_reset_preview(null,null,null)$$,'42501',null,
  'NULL actor cannot reach template collection');
select throws_ok($$select public.get_developer_reset_preview('39000000-0000-4000-8000-000000000002',
  '39000000-0000-4000-8000-000000000002','malformed')$$,'42501',null,
  'malformed session cannot reach template collection');
-- Role/actor/password/expired session cases remain in developer_reset_preview.sql.
-- No actual publication, history rewrite or reset command is introduced here.
select * from finish();
rollback;
