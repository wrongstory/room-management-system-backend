-- #396 diagnostic only: no business rows, writes, or execution permissions.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '2s';
SET LOCAL search_path = pg_catalog;
WITH relations AS (
  SELECT c.oid, n.nspname || '.' || c.relname AS name,
    c.relkind::text AS kind, c.relrowsecurity AS rls,
    c.relforcerowsecurity AS force_rls
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public','private') AND c.relkind IN ('r','p','f')
), foreign_keys AS (
  SELECT ns.nspname || '.' || src.relname AS source,
    nt.nspname || '.' || dst.relname AS target,
    k.conname AS name, pg_get_constraintdef(k.oid) AS definition
  FROM pg_constraint k
  JOIN pg_class src ON src.oid = k.conrelid
  JOIN pg_namespace ns ON ns.oid = src.relnamespace
  JOIN pg_class dst ON dst.oid = k.confrelid
  JOIN pg_namespace nt ON nt.oid = dst.relnamespace
  WHERE k.contype = 'f' AND
    (k.conrelid IN (SELECT oid FROM relations) OR k.confrelid IN (SELECT oid FROM relations))
), triggers AS (
  SELECT r.name AS relation, t.tgname AS name, t.tgenabled::text AS enabled,
    md5(pg_get_triggerdef(t.oid)) AS definition_hash,
    md5(pg_get_functiondef(t.tgfoid)) AS function_hash
  FROM pg_trigger t JOIN relations r ON r.oid = t.tgrelid
  WHERE NOT t.tgisinternal
)
SELECT jsonb_build_object(
  'format', 'reset-catalog-v1',
  'readOnly', current_setting('transaction_read_only') = 'on',
  'relations', COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'name',name,'kind',kind,'rls',rls,'forceRls',force_rls) ORDER BY name) FROM relations), '[]'::jsonb),
  'foreignKeys', COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'source',source,'target',target,'name',name,'definition',definition)
    ORDER BY source,name) FROM foreign_keys), '[]'::jsonb),
  'triggers', COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'relation',relation,'name',name,'enabled',enabled,
    'definitionHash',definition_hash,'functionHash',function_hash)
    ORDER BY relation,name) FROM triggers), '[]'::jsonb)
);
ROLLBACK;
