/** Fixed catalog queries and bounded exact text-cell state collection; never emits row data. */
import { copyMigrationData } from './migration-evidence-input.mjs';
import { createMigrationStateSnapshot } from './migration-state-snapshot.mjs';

const catalogSql = `WITH namespaces AS (SELECT oid,nspname,nspowner,nspacl FROM pg_catalog.pg_namespace WHERE nspname=ANY($1::text[])),
relations AS (SELECT c.*,n.nspname FROM pg_catalog.pg_class c JOIN namespaces n ON n.oid=c.relnamespace),
functions AS (SELECT p.*,n.nspname FROM pg_catalog.pg_proc p JOIN namespaces n ON n.oid=p.pronamespace),
objects AS (
 SELECT 'schema' kind,nspname identity,pg_catalog.jsonb_build_object('owner',pg_catalog.pg_get_userbyid(nspowner),'acl',nspacl,'comment',pg_catalog.obj_description(oid,'pg_namespace'))::text definition FROM namespaces
 UNION ALL SELECT 'relation',nspname||'.'||relname,pg_catalog.jsonb_build_object('kind',relkind,'persistence',relpersistence,'owner',pg_catalog.pg_get_userbyid(relowner),'acl',relacl,'rls',relrowsecurity,'force',relforcerowsecurity,'partition',pg_catalog.pg_get_expr(relpartbound,oid),'options',reloptions,'replicaIdentity',relreplident,'comment',pg_catalog.obj_description(oid,'pg_class'),'accessMethod',(SELECT amname FROM pg_catalog.pg_am WHERE oid=relam),'tablespace',(SELECT spcname FROM pg_catalog.pg_tablespace WHERE oid=reltablespace))::text FROM relations
 UNION ALL SELECT 'column',r.nspname||'.'||r.relname||'.'||a.attname,pg_catalog.jsonb_build_object('position',a.attnum,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'collation',CASE WHEN a.attcollation=0 THEN NULL ELSE a.attcollation::pg_catalog.regcollation::text END,'acl',a.attacl,'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid),'storage',a.attstorage,'compression',a.attcompression,'options',a.attoptions,'comment',pg_catalog.col_description(r.oid,a.attnum))::text FROM relations r JOIN pg_catalog.pg_attribute a ON a.attrelid=r.oid AND a.attnum>0 AND NOT a.attisdropped LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=r.oid AND d.adnum=a.attnum
 UNION ALL SELECT 'constraint',n.nspname||'.'||c.conname||':'||CASE WHEN c.conrelid=0 THEN c.contypid::pg_catalog.regtype::text ELSE c.conrelid::pg_catalog.regclass::text END,pg_catalog.jsonb_build_object('definition',pg_catalog.pg_get_constraintdef(c.oid,false),'validated',c.convalidated,'local',c.conislocal,'noInherit',c.connoinherit,'comment',pg_catalog.obj_description(c.oid,'pg_constraint'))::text FROM pg_catalog.pg_constraint c JOIN namespaces n ON n.oid=c.connamespace
 UNION ALL SELECT 'index',r.nspname||'.'||r.relname,pg_catalog.pg_get_indexdef(r.oid) FROM relations r WHERE r.relkind IN ('i','I')
 UNION ALL SELECT 'function',nspname||'.'||proname||'('||pg_catalog.pg_get_function_identity_arguments(oid)||')',pg_catalog.jsonb_build_object('kind',prokind,'owner',pg_catalog.pg_get_userbyid(proowner),'acl',proacl,'language',(SELECT lanname FROM pg_catalog.pg_language WHERE oid=prolang),'definition',CASE WHEN prokind='a' THEN NULL ELSE pg_catalog.pg_get_functiondef(oid) END,'support',CASE WHEN prosupport=0 THEN NULL ELSE prosupport::pg_catalog.regprocedure::text END,'comment',pg_catalog.obj_description(oid,'pg_proc'))::text FROM functions
 UNION ALL SELECT 'owner','relation:'||nspname||'.'||relname,pg_catalog.pg_get_userbyid(relowner)::text FROM relations
 UNION ALL SELECT 'acl','relation:'||nspname||'.'||relname,COALESCE(relacl::text,'NULL') FROM relations
 UNION ALL SELECT 'acl','default:'||pg_catalog.pg_get_userbyid(d.defaclrole)||':'||COALESCE((SELECT nspname FROM pg_catalog.pg_namespace WHERE oid=d.defaclnamespace),'GLOBAL')||':'||d.defaclobjtype::text,d.defaclacl::text FROM pg_catalog.pg_default_acl d WHERE d.defaclnamespace IN(SELECT oid FROM namespaces) OR d.defaclnamespace=0
 UNION ALL SELECT 'rls',nspname||'.'||relname,pg_catalog.jsonb_build_object('enabled',relrowsecurity,'forced',relforcerowsecurity)::text FROM relations WHERE relkind IN('r','p')
 UNION ALL SELECT 'policy',r.nspname||'.'||r.relname||'.'||p.polname,pg_catalog.jsonb_build_object('cmd',p.polcmd,'permissive',p.polpermissive,'roles',(SELECT pg_catalog.jsonb_agg(CASE WHEN role=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(role) END ORDER BY CASE WHEN role=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(role) END) FROM pg_catalog.unnest(p.polroles) role),'using',pg_catalog.pg_get_expr(p.polqual,p.polrelid),'check',pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid),'comment',pg_catalog.obj_description(p.oid,'pg_policy'))::text FROM pg_catalog.pg_policy p JOIN relations r ON r.oid=p.polrelid
 UNION ALL SELECT 'trigger',r.nspname||'.'||r.relname||'.'||t.tgname,pg_catalog.jsonb_build_object('enabled',t.tgenabled,'definition',pg_catalog.pg_get_triggerdef(t.oid,false),'comment',pg_catalog.obj_description(t.oid,'pg_trigger'))::text FROM pg_catalog.pg_trigger t JOIN relations r ON r.oid=t.tgrelid
 UNION ALL SELECT 'type',n.nspname||'.'||t.typname,pg_catalog.jsonb_build_object('kind',t.typtype,'owner',pg_catalog.pg_get_userbyid(t.typowner),'acl',t.typacl,'base',CASE WHEN t.typbasetype=0 THEN NULL ELSE t.typbasetype::pg_catalog.regtype::text END,'element',CASE WHEN t.typelem=0 THEN NULL ELSE t.typelem::pg_catalog.regtype::text END,'notnull',t.typnotnull,'default',t.typdefault,'enums',(SELECT pg_catalog.jsonb_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_catalog.pg_enum e WHERE e.enumtypid=t.oid),'comment',pg_catalog.obj_description(t.oid,'pg_type'))::text FROM pg_catalog.pg_type t JOIN namespaces n ON n.oid=t.typnamespace
 UNION ALL SELECT 'relation',r.nspname||'.'||r.relname||':sequence',pg_catalog.jsonb_build_object('type',s.seqtypid::pg_catalog.regtype::text,'start',s.seqstart,'increment',s.seqincrement,'max',s.seqmax,'min',s.seqmin,'cache',s.seqcache,'cycle',s.seqcycle)::text FROM pg_catalog.pg_sequence s JOIN relations r ON r.oid=s.seqrelid
 UNION ALL SELECT 'relation',r.nspname||'.'||r.relname||':view',pg_catalog.pg_get_viewdef(r.oid,false) FROM relations r WHERE r.relkind IN('v','m')
 UNION ALL SELECT 'relation',r.nspname||'.'||r.relname||':rule:'||w.rulename,pg_catalog.jsonb_build_object('definition',pg_catalog.pg_get_ruledef(w.oid,false),'enabled',w.ev_enabled,'comment',pg_catalog.obj_description(w.oid,'pg_rewrite'))::text FROM pg_catalog.pg_rewrite w JOIN relations r ON r.oid=w.ev_class
 UNION ALL SELECT 'relation',r.nspname||'.'||r.relname||':inherits:'||i.inhseqno::text,i.inhparent::pg_catalog.regclass::text FROM pg_catalog.pg_inherits i JOIN relations r ON r.oid=i.inhrelid
 UNION ALL SELECT 'unsupported','type:'||n.nspname||'.'||t.typname,t.typtype::text FROM pg_catalog.pg_type t JOIN namespaces n ON n.oid=t.typnamespace WHERE t.typtype IN('d','r','m') OR (t.typtype='b' AND t.typelem=0)
 UNION ALL SELECT 'unsupported','aggregate:'||nspname||'.'||proname,oid::text FROM functions WHERE prokind='a'
 UNION ALL SELECT 'unsupported','operator:'||n.nspname||'.'||o.oprname,o.oid::text FROM pg_catalog.pg_operator o JOIN namespaces n ON n.oid=o.oprnamespace
 UNION ALL SELECT 'unsupported','opclass:'||n.nspname||'.'||o.opcname,o.oid::text FROM pg_catalog.pg_opclass o JOIN namespaces n ON n.oid=o.opcnamespace
 UNION ALL SELECT 'unsupported','opfamily:'||n.nspname||'.'||o.opfname,o.oid::text FROM pg_catalog.pg_opfamily o JOIN namespaces n ON n.oid=o.opfnamespace
 UNION ALL SELECT 'unsupported','collation:'||n.nspname||'.'||c.collname,c.oid::text FROM pg_catalog.pg_collation c JOIN namespaces n ON n.oid=c.collnamespace
 UNION ALL SELECT 'unsupported','textsearch:'||n.nspname||'.'||c.cfgname,c.oid::text FROM pg_catalog.pg_ts_config c JOIN namespaces n ON n.oid=c.cfgnamespace
) SELECT kind::text,identity::text,definition::text FROM objects ORDER BY kind COLLATE "C",identity COLLATE "C" LIMIT 100001`;
const inventorySql = `SELECT n.nspname::text,c.relname::text,c.relkind::text,a.attname::text,pg_catalog.format_type(a.atttypid,a.atttypmod)::text
 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
 WHERE n.nspname=ANY($1::text[]) AND c.relkind IN('r','p','S','f','m') ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C",a.attnum LIMIT 100001`;
const quote = value => `"${value}"`;
const relation = value => value.split('.').map(quote).join('.');
function rows(result, width) {
  if (result?.command !== 'SELECT' || !Array.isArray(result.rows) || result.rows.length > 100000
    || result.rowCount !== result.rows.length || !Array.isArray(result.fields) || result.fields.length !== width
    || result.fields.some(field => field.dataTypeID !== 25 || field.format !== 'text')
    || result.rows.some(row => !Array.isArray(row) || row.length !== width || row.some(cell => cell !== null && typeof cell !== 'string'))) throw new Error('MIGRATION_STATE_READ_FAILED');
  return result.rows;
}

/** query is an internal, authenticated, bounded transaction-local driver function. */
export async function readPostgresMigrationState(query, rawCoverage) {
  try {
    const coverage = copyMigrationData(rawCoverage);
    // Validate identifiers/limits before constructing any SQL. Empty declared rows are only for shape checking.
    createMigrationStateSnapshot({ coverage, catalog: [], data: coverage.dataRelations.map(item => ({ relation: item.name, rows: [] })),
      sequences: coverage.sequences.map(name => ({ name, lastValue: '0', isCalled: false })) });
    const inventory = rows(await query(inventorySql, [coverage.schemas]), 5);
    const actual = new Map(); const sequenceNames = new Set();
    for (const [schema, name, kind, column, type] of inventory) {
      const key = `${schema}.${name}`;
      if (kind === 'f' || kind === 'm') throw new Error(); // Foreign/materialized data needs separately reviewed coverage.
      if (kind === 'S') { sequenceNames.add(key); continue; }
      if (!actual.has(key)) actual.set(key, []);
      actual.get(key).push({ name: column, postgresType: type });
    }
    if (actual.size !== coverage.dataRelations.length || sequenceNames.size !== coverage.sequences.length
      || coverage.sequences.some(name => !sequenceNames.has(name))
      || coverage.dataRelations.some(item => JSON.stringify(actual.get(item.name)) !== JSON.stringify(item.columns))) throw new Error();
    const catalog = rows(await query(catalogSql, [coverage.schemas]), 3).map(([kind, identity, definition]) => ({ kind, identity, definition }));
    const foundSchemas = catalog.filter(row => row.kind === 'schema').map(row => row.identity);
    if (foundSchemas.length !== coverage.schemas.length || coverage.schemas.some(schema => !foundSchemas.includes(schema))) throw new Error();
    const data = []; let totalBytes = 0; let totalRows = 0;
    for (const table of coverage.dataRelations) {
      const expression = `pg_catalog.json_build_array(${table.columns.map(column => `${quote(column.name)}::text`).join(',')})::text`;
      const source = `ONLY ${relation(table.name)}`;
      const census = rows(await query(`SELECT pg_catalog.count(*)::text,COALESCE(pg_catalog.sum(pg_catalog.octet_length(${expression})),0)::text FROM ${source}`), 2);
      if (census.length !== 1 || census[0].some(value => !/^(?:0|[1-9][0-9]*)$/u.test(value))) throw new Error();
      const count = Number(census[0][0]); const bytes = Number(census[0][1]);
      totalRows += count; totalBytes += bytes;
      if (!Number.isSafeInteger(totalRows) || totalRows > 100000 || !Number.isSafeInteger(totalBytes) || totalBytes > 32 * 1024 * 1024) throw new Error();
      const values = rows(await query(`SELECT ${expression} FROM ${source} LIMIT 100001`), 1).map(([value]) => JSON.parse(value));
      if (values.length !== count) throw new Error();
      data.push({ relation: table.name, rows: values });
    }
    const sequences = [];
    for (const name of coverage.sequences) {
      const value = rows(await query(`SELECT last_value::text,is_called::text FROM ${relation(name)}`), 2);
      if (value.length !== 1 || !['true', 'false'].includes(value[0][1])) throw new Error();
      sequences.push({ name, lastValue: value[0][0], isCalled: value[0][1] === 'true' });
    }
    return createMigrationStateSnapshot({ coverage, catalog, data, sequences });
  } catch { throw new Error('MIGRATION_STATE_READ_FAILED'); }
}
