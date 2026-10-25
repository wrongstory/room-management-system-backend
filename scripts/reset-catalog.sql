-- #396 diagnostic only: no business rows, writes, or execution permissions.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '2s';
SET LOCAL search_path = pg_catalog;
WITH app_relations AS (
  SELECT c.oid, n.nspname || '.' || c.relname AS name,
    c.relkind::text AS kind, c.relrowsecurity AS rls,
    c.relforcerowsecurity AS force_rls
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public','private') AND c.relkind IN ('r','p','f')
), foreign_keys AS (
  SELECT k.oid, k.conrelid, k.confrelid, k.conindid,
    ns.nspname || '.' || src.relname AS source,
    nt.nspname || '.' || dst.relname AS target,
    k.conname AS name, pg_get_constraintdef(k.oid) AS definition,
    ARRAY(SELECT a.attname FROM unnest(k.conkey) WITH ORDINALITY x(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = x.attnum ORDER BY x.ord) AS source_columns,
    ARRAY(SELECT a.attname FROM unnest(k.confkey) WITH ORDINALITY x(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = x.attnum ORDER BY x.ord) AS target_columns,
    idx.relname AS target_key, k.confmatchtype::text AS match,
    k.confdeltype::text AS on_delete, k.confupdtype::text AS on_update,
    k.convalidated AS validated, k.condeferrable AS deferrable, k.condeferred AS initially_deferred
  FROM pg_constraint k
  JOIN pg_class src ON src.oid = k.conrelid
  JOIN pg_namespace ns ON ns.oid = src.relnamespace
  JOIN pg_class dst ON dst.oid = k.confrelid
  JOIN pg_namespace nt ON nt.oid = dst.relnamespace
  JOIN pg_class idx ON idx.oid = k.conindid
  WHERE k.contype = 'f' AND
    (k.conrelid IN (SELECT oid FROM app_relations) OR k.confrelid IN (SELECT oid FROM app_relations))
), relations AS (
  SELECT * FROM app_relations
  UNION ALL
  SELECT c.oid, n.nspname || '.' || c.relname, c.relkind::text, c.relrowsecurity, c.relforcerowsecurity
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.oid NOT IN (SELECT oid FROM app_relations)
    AND (c.oid IN (SELECT conrelid FROM foreign_keys) OR c.oid IN (SELECT confrelid FROM foreign_keys))
), relation_objects AS (
  SELECT r.oid, r.name, jsonb_build_object(
    'name',r.name,'kind',r.kind,'rls',r.rls,'forceRls',r.force_rls,
    'columns',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'name',a.attname,'position',a.attnum,'type',tn.nspname || '.' || t.typname,
      'nullable',NOT a.attnotnull) ORDER BY a.attnum)
      FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
      JOIN pg_namespace tn ON tn.oid = t.typnamespace
      WHERE a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped),'[]'::jsonb),
    'keys',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'name',idx.relname,'columns',ARRAY(
        SELECT a.attname FROM unnest(i.indkey) WITH ORDINALITY x(attnum,ord)
        JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum = x.attnum
        WHERE x.ord <= i.indnkeyatts ORDER BY x.ord),
      'primary',i.indisprimary,'valid',i.indisvalid,'immediate',i.indimmediate,
      'partial',i.indpred IS NOT NULL,'expressions',i.indexprs IS NOT NULL) ORDER BY idx.relname)
      FROM pg_index i JOIN pg_class idx ON idx.oid = i.indexrelid
      WHERE i.indrelid = r.oid AND (i.indisprimary OR i.indexrelid IN (SELECT conindid FROM foreign_keys))),
      '[]'::jsonb)) AS item
  FROM relations r
), triggers AS (
  SELECT r.name AS relation, t.tgname AS name, t.tgenabled::text AS enabled,
    md5(pg_get_triggerdef(t.oid)) AS definition_hash,
    md5(pg_get_functiondef(t.tgfoid)) AS function_hash
  FROM pg_trigger t JOIN app_relations r ON r.oid = t.tgrelid
  WHERE NOT t.tgisinternal
)
SELECT jsonb_build_object(
  'format', 'reset-catalog-v2',
  'readOnly', current_setting('transaction_read_only') = 'on',
  'relations', COALESCE((SELECT jsonb_agg(item ORDER BY name) FROM relation_objects
    WHERE oid IN (SELECT oid FROM app_relations)), '[]'::jsonb),
  'boundaryRelations', COALESCE((SELECT jsonb_agg(item ORDER BY name) FROM relation_objects
    WHERE oid NOT IN (SELECT oid FROM app_relations)), '[]'::jsonb),
  'foreignKeys', COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'source',source,'target',target,'name',name,'definition',definition,
    'sourceColumns',source_columns,'targetColumns',target_columns,'targetKey',target_key,
    'match',match,'onDelete',on_delete,'onUpdate',on_update,'validated',validated,
    'deferrable',deferrable,'initiallyDeferred',initially_deferred)
    ORDER BY source,name) FROM foreign_keys), '[]'::jsonb),
  'triggers', COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'relation',relation,'name',name,'enabled',enabled,
    'definitionHash',definition_hash,'functionHash',function_hash)
    ORDER BY relation,name) FROM triggers), '[]'::jsonb)
);
ROLLBACK;
