-- Synthetic session-local tables only. No application or Auth rows accessed.
BEGIN;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '2s';
SET LOCAL search_path = pg_catalog;
CREATE TEMP TABLE reset_fixture_parent (
  id text PRIMARY KEY, disposition text NOT NULL
) ON COMMIT DROP;
CREATE TEMP TABLE reset_fixture_child (
  id text PRIMARY KEY, disposition text NOT NULL,
  actor_id text REFERENCES pg_temp.reset_fixture_parent(id)
) ON COMMIT DROP;
INSERT INTO pg_temp.reset_fixture_parent VALUES ('developer','keep'), ('maid','remove');
INSERT INTO pg_temp.reset_fixture_child VALUES ('receipt','keep','maid'), ('optional','keep',NULL);

WITH fk AS (
  SELECT k.conname::text AS name,
    md5(pg_get_constraintdef(k.oid)) AS digest
  FROM pg_constraint k
  WHERE k.conrelid = 'pg_temp.reset_fixture_child'::regclass AND k.contype = 'f'
    AND k.confrelid = 'pg_temp.reset_fixture_parent'::regclass
), rows AS (
  SELECT jsonb_build_object('relation','public.profiles','key',p.id,
    'disposition',p.disposition,'references','[]'::jsonb) AS item
  FROM pg_temp.reset_fixture_parent p
  UNION ALL
  SELECT jsonb_build_object('relation','private.receipts','key',c.id,
    'disposition',c.disposition,'references',jsonb_build_array(jsonb_build_object(
      'constraint',fk.name,'targetKey',c.actor_id)))
  FROM pg_temp.reset_fixture_child c CROSS JOIN fk
)
SELECT jsonb_build_object(
  'catalogFingerprint',(SELECT digest || digest FROM fk),
  'snapshotCatalogFingerprint',(SELECT digest || digest FROM fk),
  'complete',true,
  'relations',jsonb_build_array('public.profiles','private.receipts'),
  'relationRowCounts',jsonb_build_array(
    jsonb_build_object('relation','public.profiles','count',(SELECT count(*) FROM pg_temp.reset_fixture_parent)),
    jsonb_build_object('relation','private.receipts','count',(SELECT count(*) FROM pg_temp.reset_fixture_child))),
  'foreignKeys',(SELECT jsonb_agg(jsonb_build_object(
    'source','private.receipts','target','public.profiles','name',name)) FROM fk),
  'rows',(SELECT jsonb_agg(item ORDER BY item->>'relation',item->>'key') FROM rows)
);
ROLLBACK;
