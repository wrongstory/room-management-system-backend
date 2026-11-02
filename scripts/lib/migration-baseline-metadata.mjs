/** H1 fixed hash-only catalog/history projection. No SQL execution or acceptance capability. */
import { createHash } from 'node:crypto';
import { copyMigrationData } from './migration-evidence-input.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const freeze = value => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };
export const BASELINE_METADATA_COUNT = 122;
export const BASELINE_METADATA_SCHEMAS = Object.freeze(['public', 'private', 'auth']);
export const BASELINE_METADATA_MAX_ROWS = 100_000;
export const BASELINE_METADATA_MAX_BYTES = 32 * 1024 * 1024;
export const BASELINE_OUTPUT_SETTINGS = freeze([
  { name:'TimeZone',field:'timezone',value:'UTC' },{ name:'DateStyle',field:'date_style',value:'ISO, YMD' },
  { name:'IntervalStyle',field:'interval_style',value:'postgres' },{ name:'extra_float_digits',field:'extra_float_digits',value:'3' },
  { name:'bytea_output',field:'bytea_output',value:'hex' },{ name:'standard_conforming_strings',field:'standard_conforming_strings',value:'on' },
]);
export const BASELINE_OUTPUT_CONFIGURE_SQL = `SELECT ${BASELINE_OUTPUT_SETTINGS.map(s=>`pg_catalog.set_config('${s.name}','${s.value}',true)::text AS ${s.field}`).join(',')}`;
export const BASELINE_OUTPUT_READ_SQL = `SELECT ${BASELINE_OUTPUT_SETTINGS.map(s=>`pg_catalog.current_setting('${s.name}')::text AS ${s.field}`).join(',')}`;
const bad = () => { throw new Error('BASELINE_METADATA_UNAVAILABLE'); };
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const number = (value, low, high) => {
  if (typeof value !== 'string' || !/^(?:0|-?[1-9][0-9]*)$/u.test(value)) return bad();
  const n = Number(value); if (!Number.isSafeInteger(n) || n < low || n > high) return bad(); return n;
};

// Names/definitions/comments/configuration values stay on the server. Even object
// identities are hashed JSON tuples, avoiding ambiguous dotted names and raw data.
const history = `SELECT version::text AS version,
 pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(name,'UTF8')),'hex')::text AS name_sha256,
 pg_catalog.array_ndims(statements)::text AS dimensions,
 pg_catalog.array_lower(statements,1)::text AS lower_bound,
 pg_catalog.array_length(statements,1)::text AS dimension_length,
 pg_catalog.cardinality(statements)::text AS cardinality,
 (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(ord::text,
   pg_catalog.octet_length(statement)::text,
   pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(statement,'UTF8')),'hex')) ORDER BY ord),'[]'::jsonb)::text
  FROM pg_catalog.unnest(statements) WITH ORDINALITY AS s(statement,ord)) AS statement_hashes,
 pg_catalog.count(*) OVER()::text AS total_count
 FROM ONLY supabase_migrations.schema_migrations ORDER BY version COLLATE "C" LIMIT 123`;
const catalog = `WITH namespaces AS (SELECT oid,nspname,nspowner,nspacl FROM pg_catalog.pg_namespace WHERE nspname IN('public','private','auth')),
 relations AS (SELECT c.*,n.nspname FROM pg_catalog.pg_class c JOIN namespaces n ON n.oid=c.relnamespace),
 functions AS (SELECT p.*,n.nspname FROM pg_catalog.pg_proc p JOIN namespaces n ON n.oid=p.pronamespace),
 objects(kind,identity,definition) AS (
 SELECT 'schema',pg_catalog.jsonb_build_array(nspname),pg_catalog.jsonb_build_object('owner',pg_catalog.pg_get_userbyid(nspowner),'acl',nspacl,'comment',pg_catalog.obj_description(oid,'pg_namespace'))::text FROM namespaces
 UNION ALL SELECT 'relation',pg_catalog.jsonb_build_array(nspname,relname),pg_catalog.jsonb_build_object('kind',relkind,'persistence',relpersistence,'owner',pg_catalog.pg_get_userbyid(relowner),'acl',relacl,'rls',relrowsecurity,'force',relforcerowsecurity,'partition',pg_catalog.pg_get_expr(relpartbound,oid),'options',reloptions,'replicaIdentity',relreplident,'comment',pg_catalog.obj_description(oid,'pg_class'),'accessMethod',(SELECT amname FROM pg_catalog.pg_am WHERE oid=relam),'tablespace',(SELECT spcname FROM pg_catalog.pg_tablespace WHERE oid=reltablespace))::text FROM relations
 UNION ALL SELECT 'column',pg_catalog.jsonb_build_array(r.nspname,r.relname,a.attname),pg_catalog.jsonb_build_object('position',a.attnum,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'collation',CASE WHEN a.attcollation=0 THEN NULL ELSE a.attcollation::pg_catalog.regcollation::text END,'acl',a.attacl,'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid),'storage',a.attstorage,'compression',a.attcompression,'options',a.attoptions,'comment',pg_catalog.col_description(r.oid,a.attnum))::text FROM relations r JOIN pg_catalog.pg_attribute a ON a.attrelid=r.oid AND a.attnum>0 AND NOT a.attisdropped LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=r.oid AND d.adnum=a.attnum
 UNION ALL SELECT 'constraint',pg_catalog.jsonb_build_array(n.nspname,c.conname,CASE WHEN c.conrelid=0 THEN c.contypid::pg_catalog.regtype::text ELSE c.conrelid::pg_catalog.regclass::text END),pg_catalog.jsonb_build_object('definition',pg_catalog.pg_get_constraintdef(c.oid,false),'validated',c.convalidated,'local',c.conislocal,'noInherit',c.connoinherit,'comment',pg_catalog.obj_description(c.oid,'pg_constraint'))::text FROM pg_catalog.pg_constraint c JOIN namespaces n ON n.oid=c.connamespace
 UNION ALL SELECT 'index',pg_catalog.jsonb_build_array(r.nspname,r.relname),pg_catalog.jsonb_build_object('definition',pg_catalog.pg_get_indexdef(r.oid),'valid',i.indisvalid,'ready',i.indisready,'live',i.indislive,'clustered',i.indisclustered,'replicaIdentity',i.indisreplident)::text FROM relations r JOIN pg_catalog.pg_index i ON i.indexrelid=r.oid
 UNION ALL SELECT 'function',pg_catalog.jsonb_build_array(nspname,proname,pg_catalog.pg_get_function_identity_arguments(oid)),pg_catalog.jsonb_build_object('kind',prokind,'owner',pg_catalog.pg_get_userbyid(proowner),'acl',proacl,'securityDefiner',prosecdef,'config',proconfig,'language',(SELECT lanname FROM pg_catalog.pg_language WHERE oid=prolang),'definition',CASE WHEN prokind='a' THEN NULL ELSE pg_catalog.pg_get_functiondef(oid) END,'support',CASE WHEN prosupport=0 THEN NULL ELSE prosupport::pg_catalog.regprocedure::text END,'comment',pg_catalog.obj_description(oid,'pg_proc'))::text FROM functions
 UNION ALL SELECT 'default_acl',pg_catalog.jsonb_build_array(pg_catalog.pg_get_userbyid(d.defaclrole),COALESCE((SELECT nspname FROM pg_catalog.pg_namespace WHERE oid=d.defaclnamespace),'GLOBAL'),d.defaclobjtype),d.defaclacl::text FROM pg_catalog.pg_default_acl d WHERE d.defaclnamespace IN(SELECT oid FROM namespaces) OR d.defaclnamespace=0
 UNION ALL SELECT 'policy',pg_catalog.jsonb_build_array(r.nspname,r.relname,p.polname),pg_catalog.jsonb_build_object('cmd',p.polcmd,'permissive',p.polpermissive,'roles',(SELECT pg_catalog.jsonb_agg(role_name ORDER BY role_name COLLATE "C") FROM (SELECT CASE WHEN role=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(role) END role_name FROM pg_catalog.unnest(p.polroles) role) names),'using',pg_catalog.pg_get_expr(p.polqual,p.polrelid),'check',pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid),'comment',pg_catalog.obj_description(p.oid,'pg_policy'))::text FROM pg_catalog.pg_policy p JOIN relations r ON r.oid=p.polrelid
 UNION ALL SELECT 'trigger',pg_catalog.jsonb_build_array(r.nspname,r.relname,t.tgname),pg_catalog.jsonb_build_object('enabled',t.tgenabled,'internal',t.tgisinternal,'definition',pg_catalog.pg_get_triggerdef(t.oid,false),'comment',pg_catalog.obj_description(t.oid,'pg_trigger'))::text FROM pg_catalog.pg_trigger t JOIN relations r ON r.oid=t.tgrelid
 UNION ALL SELECT 'type',pg_catalog.jsonb_build_array(n.nspname,t.typname),pg_catalog.jsonb_build_object('kind',t.typtype,'owner',pg_catalog.pg_get_userbyid(t.typowner),'acl',t.typacl,'base',CASE WHEN t.typbasetype=0 THEN NULL ELSE t.typbasetype::pg_catalog.regtype::text END,'element',CASE WHEN t.typelem=0 THEN NULL ELSE t.typelem::pg_catalog.regtype::text END,'notnull',t.typnotnull,'default',t.typdefault,'enums',(SELECT pg_catalog.jsonb_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_catalog.pg_enum e WHERE e.enumtypid=t.oid),'comment',pg_catalog.obj_description(t.oid,'pg_type'))::text FROM pg_catalog.pg_type t JOIN namespaces n ON n.oid=t.typnamespace
 UNION ALL SELECT 'sequence',pg_catalog.jsonb_build_array(r.nspname,r.relname),pg_catalog.jsonb_build_object('type',s.seqtypid::pg_catalog.regtype::text,'start',s.seqstart,'increment',s.seqincrement,'max',s.seqmax,'min',s.seqmin,'cache',s.seqcache,'cycle',s.seqcycle)::text FROM pg_catalog.pg_sequence s JOIN relations r ON r.oid=s.seqrelid
 UNION ALL SELECT 'view',pg_catalog.jsonb_build_array(r.nspname,r.relname),pg_catalog.pg_get_viewdef(r.oid,false) FROM relations r WHERE r.relkind IN('v','m')
 UNION ALL SELECT 'rule',pg_catalog.jsonb_build_array(r.nspname,r.relname,w.rulename),pg_catalog.jsonb_build_object('definition',pg_catalog.pg_get_ruledef(w.oid,false),'enabled',w.ev_enabled,'comment',pg_catalog.obj_description(w.oid,'pg_rewrite'))::text FROM pg_catalog.pg_rewrite w JOIN relations r ON r.oid=w.ev_class
 UNION ALL SELECT 'inherits',pg_catalog.jsonb_build_array(r.nspname,r.relname,i.inhseqno),i.inhparent::pg_catalog.regclass::text FROM pg_catalog.pg_inherits i JOIN relations r ON r.oid=i.inhrelid
 UNION ALL SELECT 'role',pg_catalog.jsonb_build_array(rolname),pg_catalog.jsonb_build_object('super',rolsuper,'inherit',rolinherit,'createRole',rolcreaterole,'createDb',rolcreatedb,'canLogin',rolcanlogin,'replication',rolreplication,'bypassRls',rolbypassrls,'connectionLimit',rolconnlimit,'validUntil',rolvaliduntil,'config',rolconfig)::text FROM pg_catalog.pg_roles
 UNION ALL SELECT 'membership',pg_catalog.jsonb_build_array(pg_catalog.pg_get_userbyid(roleid),pg_catalog.pg_get_userbyid(member),pg_catalog.pg_get_userbyid(grantor)),pg_catalog.jsonb_build_object('admin',admin_option,'inherit',pg_catalog.to_jsonb(m)->'inherit_option','set',pg_catalog.to_jsonb(m)->'set_option')::text FROM pg_catalog.pg_auth_members m
 UNION ALL SELECT 'role_setting',pg_catalog.jsonb_build_array(CASE WHEN s.setdatabase=0 THEN 'ALL' ELSE d.datname END,CASE WHEN s.setrole=0 THEN 'ALL' ELSE pg_catalog.pg_get_userbyid(s.setrole) END),pg_catalog.to_jsonb(s.setconfig)::text FROM pg_catalog.pg_db_role_setting s LEFT JOIN pg_catalog.pg_database d ON d.oid=s.setdatabase WHERE s.setdatabase=0 OR d.datname=pg_catalog.current_database()
 UNION ALL SELECT 'extension',pg_catalog.jsonb_build_array(e.extname),pg_catalog.jsonb_build_object('version',e.extversion,'schema',n.nspname,'owner',pg_catalog.pg_get_userbyid(e.extowner),'relocatable',e.extrelocatable)::text FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace
 UNION ALL SELECT 'unsupported',pg_catalog.jsonb_build_array('type',n.nspname,t.typname),t.typtype::text FROM pg_catalog.pg_type t JOIN namespaces n ON n.oid=t.typnamespace WHERE t.typtype IN('d','r','m') OR (t.typtype='b' AND t.typelem=0)
 UNION ALL SELECT 'unsupported',pg_catalog.jsonb_build_array('aggregate',nspname,proname,pg_catalog.pg_get_function_identity_arguments(oid)),'aggregate' FROM functions WHERE prokind='a'
 UNION ALL SELECT 'unsupported',pg_catalog.jsonb_build_array('relation',nspname,relname),relkind::text FROM relations WHERE relkind NOT IN('r','p','i','I','S','v','t')
 UNION ALL SELECT 'unsupported',pg_catalog.jsonb_build_array('operator',n.nspname,o.oprname,o.oprleft::pg_catalog.regtype::text,o.oprright::pg_catalog.regtype::text),'operator' FROM pg_catalog.pg_operator o JOIN namespaces n ON n.oid=o.oprnamespace
 UNION ALL SELECT 'unsupported',pg_catalog.jsonb_build_array('opclass',n.nspname,o.opcname),'opclass' FROM pg_catalog.pg_opclass o JOIN namespaces n ON n.oid=o.opcnamespace
 UNION ALL SELECT 'unsupported',pg_catalog.jsonb_build_array('opfamily',n.nspname,o.opfname),'opfamily' FROM pg_catalog.pg_opfamily o JOIN namespaces n ON n.oid=o.opfnamespace
 UNION ALL SELECT 'unsupported',pg_catalog.jsonb_build_array('collation',n.nspname,c.collname),'collation' FROM pg_catalog.pg_collation c JOIN namespaces n ON n.oid=c.collnamespace
 UNION ALL SELECT 'unsupported',pg_catalog.jsonb_build_array('textsearch',n.nspname,c.cfgname),'textsearch' FROM pg_catalog.pg_ts_config c JOIN namespaces n ON n.oid=c.cfgnamespace
 ), hashed AS (SELECT kind,pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(identity::text,'UTF8')),'hex') identity_sha256,
 pg_catalog.octet_length(pg_catalog.jsonb_build_array(definition)::text) definition_bytes,
 pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_array(definition)::text,'UTF8')),'hex') definition_sha256 FROM objects)
 SELECT kind::text,identity_sha256::text,definition_bytes::text,definition_sha256::text,
 pg_catalog.count(*) OVER()::text AS total_count,pg_catalog.sum(definition_bytes) OVER()::text AS total_bytes
 FROM hashed ORDER BY kind COLLATE "C",identity_sha256 COLLATE "C" LIMIT 100001`;
export const BASELINE_METADATA_QUERIES = freeze({ history, catalog });
export const BASELINE_METADATA_QUERY_SHA256 = sha(JSON.stringify({queries:BASELINE_METADATA_QUERIES,outputSettings:BASELINE_OUTPUT_SETTINGS}));
export const BASELINE_HISTORY_FIELDS = Object.freeze(['version','name_sha256','dimensions','lower_bound','dimension_length','cardinality','statement_hashes','total_count']);
export const BASELINE_CATALOG_FIELDS = Object.freeze(['kind','identity_sha256','definition_bytes','definition_sha256','total_count','total_bytes']);
const kinds = new Set(['schema','relation','column','constraint','index','function','default_acl','policy','trigger','type','sequence','view','rule','inherits','role','membership','role_setting','extension','unsupported']);
function rows(result, fields, limit) {
  if (result?.command !== 'SELECT' || !Array.isArray(result.rows) || result.rows.length > limit || result.rowCount !== result.rows.length
    || !Array.isArray(result.fields) || result.fields.length !== fields.length
    || result.fields.some((f,i) => f.name !== fields[i] || f.dataTypeID !== 25 || f.format !== 'text')
    || result.rows.some(r => !Array.isArray(r) || r.length !== fields.length || r.some(c => c !== null && typeof c !== 'string'))) return bad();
  return result.rows;
}
/** Decoder only: caller data/callbacks cannot mint a live observation. Used by the
 * owned TLS driver and the separately identified disposable local checkpoint. */
export function decodeBaselineMetadata(historyResult, catalogResult, expected) {
  try {
    expected = copyMigrationData(expected);
    if (!Array.isArray(expected) || expected.length !== 122 || expected.some((e,i) => !e || typeof e.name !== 'string'
      || !/^[a-z0-9_]{1,256}$/u.test(e.name) || typeof e.version !== 'string' || !/^[0-9]{14}$/u.test(e.version) || i > 0 && e.version <= expected[i-1].version)
      || new Set(expected.map(e => e.name)).size !== 122) return bad();
    const hs = rows(historyResult, BASELINE_HISTORY_FIELDS, 122); if (hs.length !== 122) return bad();
    let historyBytes = 0;
    const historyRows = hs.map((r,i) => {
      if (r[0] !== expected[i].version || r[1] !== sha(expected[i].name) || r[7] !== '122' || r[2] !== '1') return bad();
      const count = number(r[5],1,10000), lowerBound = number(r[3],-2147483648,2147483647);
      if (number(r[4],1,10000) !== count || typeof r[6] !== 'string' || Buffer.byteLength(r[6]) > BASELINE_METADATA_MAX_BYTES) return bad();
      const values = JSON.parse(r[6]); if (!Array.isArray(values) || values.length !== count) return bad();
      const statements = values.map((v,j) => {
        if (!Array.isArray(v) || v.length !== 3 || v[0] !== String(j+1) || !digest(v[2])) return bad();
        const bytes = number(v[1],0,2*1024*1024); historyBytes += bytes;
        if (historyBytes > BASELINE_METADATA_MAX_BYTES) return bad();
        return { ordinal: j+1, byteLength: bytes, sha256: v[2] };
      });
      return { version: r[0], name: expected[i].name, dimensions: [{ lowerBound,length: count }], statements };
    });
    const cs = rows(catalogResult, BASELINE_CATALOG_FIELDS, BASELINE_METADATA_MAX_ROWS); if (!cs.length) return bad();
    let catalogBytes = 0, previous = '';
    const catalogRows = cs.map(r => {
      const key = `${r[0]}:${r[1]}`;
      if (!kinds.has(r[0]) || !digest(r[1]) || !digest(r[3]) || key <= previous || number(r[4],1,BASELINE_METADATA_MAX_ROWS) !== cs.length) return bad();
      previous = key; const bytes = number(r[2],1,2*1024*1024); catalogBytes += bytes;
      return { kind: r[0],identitySha256: r[1],definitionBytes: bytes,definitionSha256: r[3] };
    });
    if (catalogBytes > BASELINE_METADATA_MAX_BYTES || cs.some(r => number(r[5],1,BASELINE_METADATA_MAX_BYTES) !== catalogBytes)
      || BASELINE_METADATA_SCHEMAS.some(name => !catalogRows.some(r => r.kind === 'schema' && r.identitySha256 === sha(JSON.stringify([name]))))) return bad();
    const payload = { format: 'baseline-hash-metadata-v1',querySha256: BASELINE_METADATA_QUERY_SHA256,
      schemas: BASELINE_METADATA_SCHEMAS,history: historyRows,catalog: catalogRows,historyBytes,catalogBytes };
    return freeze({ ...payload,metadataSha256: sha(JSON.stringify(payload)),historyMetadataSha256: sha(JSON.stringify(historyRows)),
      catalogMetadataSha256: sha(JSON.stringify(catalogRows)),unsupportedObjectCount: catalogRows.filter(r => r.kind === 'unsupported').length,
      baselineAccepted: false,executionAllowed: false,operationalApproval: false,fullStateVerified: false,
      liveObservationVerified: false,globalCoverageVerified: false,historicalEffectsVerified: false });
  } catch { return bad(); }
}
export async function readBaselineMetadata(query, expected) {
  try { return decodeBaselineMetadata(await query(history),await query(catalog),expected); }
  catch { return bad(); }
}
