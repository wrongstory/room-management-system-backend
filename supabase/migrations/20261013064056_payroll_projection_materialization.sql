-- #414: reuse a one-row projection within this SQL call, never across requests.
-- Source candidate: actual DB execution requires explicit final-release approval.
do $payroll_projection$
declare
  patch record;
  function_oid oid;
  original text;
  definition text;
  changed text;
  before_catalog jsonb;
  after_catalog jsonb;
begin
  for patch in select * from (values
    ('private.project_payroll_cycle_before_workflow(date,uuid,integer)', '0f2f288532d83a8b49259e96815d4628'),
    ('private.payroll_remittance_basis(uuid,date)', '76783f5e09455472ee2774ba6d3e9766')
  ) reviewed(signature, source_md5) loop
    function_oid:=to_regprocedure(patch.signature);
    if function_oid is null then raise exception 'PAYROLL_PROJECTION_FUNCTION_MISSING'; end if;
    select replace(prosrc,E'\r\n',E'\n'),replace(pg_get_functiondef(oid),E'\r\n',E'\n'),to_jsonb(p)-'prosrc'
      into strict original,definition,before_catalog from pg_proc p where oid=function_oid;
    if md5(original)<>patch.source_md5 then raise exception 'PAYROLL_PROJECTION_SOURCE_DRIFT'; end if;
    if (length(original)-length(replace(original,'with projected as (','')))/length('with projected as (')<>1
      or (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then
      raise exception 'PAYROLL_PROJECTION_FRAGMENT_DRIFT';
    end if;
    changed:=replace(original,'with projected as (','with projected as materialized (');
    execute replace(definition,original,changed);
    select to_jsonb(p)-'prosrc' into strict after_catalog from pg_proc p where oid=function_oid;
    if to_regprocedure(patch.signature)<>function_oid or after_catalog is distinct from before_catalog
      or (select prosrc from pg_proc where oid=function_oid) is distinct from changed then
      raise exception 'PAYROLL_PROJECTION_CATALOG_DRIFT';
    end if;
  end loop;
end;
$payroll_projection$;
