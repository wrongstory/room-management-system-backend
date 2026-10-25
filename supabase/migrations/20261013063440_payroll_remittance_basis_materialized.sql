-- #416 source candidate only; actual application requires separate user approval.
-- Keep the eight monetary fields and latest authorization/command locks unchanged.
do $basis_materialized$
declare
  function_oid oid := to_regprocedure('private.payroll_remittance_basis(uuid,date)');
  old_source text;
  new_source text;
  definition text;
  before_catalog jsonb;
  after_catalog jsonb;
  old_fragment constant text := 'with projected as (';
  new_fragment constant text := 'with projected as materialized (';
begin
  if function_oid is null then
    raise exception 'PAYROLL_BASIS_FUNCTION_MISSING';
  end if;
  select replace(p.prosrc, E'\r\n', E'\n'),
    replace(pg_get_functiondef(p.oid), E'\r\n', E'\n'), to_jsonb(p) - 'prosrc'
    into strict old_source, definition, before_catalog from pg_proc p where p.oid = function_oid;
  if md5(old_source) <> '76783f5e09455472ee2774ba6d3e9766' then
    raise exception 'PAYROLL_BASIS_SOURCE_DRIFT';
  end if;
  if (length(old_source) - length(replace(old_source, old_fragment, ''))) / length(old_fragment) <> 1
    or (length(definition) - length(replace(definition, old_source, ''))) / length(old_source) <> 1 then
    raise exception 'PAYROLL_BASIS_FRAGMENT_DRIFT';
  end if;
  new_source := replace(old_source, old_fragment, new_fragment);
  execute replace(definition, old_source, new_source);
  select to_jsonb(p) - 'prosrc' into strict after_catalog from pg_proc p where p.oid = function_oid;
  if to_regprocedure('private.payroll_remittance_basis(uuid,date)') <> function_oid
    or after_catalog is distinct from before_catalog
    or (select prosrc from pg_proc where oid = function_oid) is distinct from new_source then
    raise exception 'PAYROLL_BASIS_CATALOG_DRIFT';
  end if;
end;
$basis_materialized$;
