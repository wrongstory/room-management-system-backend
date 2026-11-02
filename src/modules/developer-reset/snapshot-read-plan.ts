import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { validateResetCatalog, type ResetCatalogRelation } from '../../../scripts/reset-catalog-contract.mjs';
import { RESET_ROW_RULE_FINGERPRINT, resetRowDispositionExpression } from '../../../scripts/reset-row-policy.mjs';

const bindingSchema = z.object({ projectRef: z.string().regex(/^[a-z]{20}$/), sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  catalogFingerprint: z.string().regex(/^[a-f0-9]{64}$/), classificationFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const fail = (): never => { throw new Error('RESET_READ_PLAN_REJECTED'); };
const identifier = (value: string) => {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) return fail();
  return `"${value}"`;
};
const relation = (value: string) => {
  const [schema, name, extra] = value.split('.');
  if (!schema || !name || extra || !['public', 'private', 'auth'].includes(schema)) return fail();
  return `${identifier(schema)}.${identifier(name)}`;
};
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const primary = (table: ResetCatalogRelation) => table.keys.find(key => key.primary)?.columns ?? fail();

// This repository-owned source is the same catalog-v2 query used by the diagnostic.
// Strip only the exact transaction wrapper; callers cannot provide or replace SQL.
const catalogSource = readFileSync(new URL('../../../scripts/reset-catalog.sql', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const start = catalogSource.indexOf('WITH app_relations AS (');
if (start < 0 || !catalogSource.endsWith('ROLLBACK;\n')) fail();
export const resetCatalogReadSql = catalogSource.slice(start, -'ROLLBACK;\n'.length).trim();

export const resetReadIdentitySql = `SELECT pg_catalog.pg_backend_pid()::text AS pid,
 pg_catalog.current_database()::text AS database_name, current_user::text AS role_name,
 pg_catalog.current_setting('transaction_read_only')::text AS read_only,
 pg_catalog.current_setting('transaction_isolation')::text AS isolation,
 pg_catalog.current_setting('row_security')::text AS row_security,
 pg_catalog.current_setting('application_name')::text AS nonce,
 pg_catalog.current_setting('client_encoding')::text AS encoding,
 pg_catalog.current_setting('TimeZone')::text AS timezone,
 pg_catalog.current_setting('DateStyle')::text AS datestyle,
 pg_catalog.current_setting('IntervalStyle')::text AS intervalstyle,
 pg_catalog.current_setting('bytea_output')::text AS bytea_output,
 pg_catalog.current_setting('extra_float_digits')::text AS float_digits,
 (SELECT (rolsuper OR rolbypassrls)::text FROM pg_catalog.pg_roles WHERE rolname=current_user) AS bypass_rls,
 pg_catalog.pg_current_snapshot()::text AS snapshot,
 pg_catalog.current_setting('statement_timeout')::text AS statement_timeout,
 pg_catalog.current_setting('lock_timeout')::text AS lock_timeout`;

// No custom type output function, inheritance/partition/FDW or unresolved FK operator.
// Catalog-v2 describes structure; this independent catalog guard checks read semantics.
export const resetReadSafetySql = `WITH wanted AS (SELECT value AS relation FROM pg_catalog.jsonb_array_elements_text($1::jsonb)),
 tables AS (SELECT c.*, n.nspname||'.'||c.relname AS relation FROM pg_catalog.pg_class c
 JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN wanted w ON w.relation=n.nspname||'.'||c.relname),
 columns AS (SELECT c.relation,a.attname,t.oid,t.typtype,t.typelem,nt.nspname AS type_schema,
 opn.nspname AS output_schema,et.typtype AS element_kind,en.nspname AS element_output_schema
 FROM tables c JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
 JOIN pg_catalog.pg_type t ON t.oid=a.atttypid JOIN pg_catalog.pg_namespace nt ON nt.oid=t.typnamespace
 JOIN pg_catalog.pg_proc op ON op.oid=t.typoutput JOIN pg_catalog.pg_namespace opn ON opn.oid=op.pronamespace
 LEFT JOIN pg_catalog.pg_type et ON et.oid=t.typelem LEFT JOIN pg_catalog.pg_proc ep ON ep.oid=et.typoutput
 LEFT JOIN pg_catalog.pg_namespace en ON en.oid=ep.pronamespace
 WHERE c.relation<>'auth.users' OR a.attname='id'),
 fk AS (SELECT k.*,opn.nspname AS operator_schema,pn.nspname AS procedure_schema,op.oprname,
 a.atttypid=op.oprright AND b.atttypid=op.oprleft AND a.attcollation=b.attcollation AS exact_equality
 FROM pg_catalog.pg_constraint k JOIN tables src ON src.oid=k.conrelid
 CROSS JOIN LATERAL ROWS FROM (pg_catalog.unnest(k.conkey),pg_catalog.unnest(k.confkey),pg_catalog.unnest(k.conpfeqop)) WITH ORDINALITY x(sc,tc,opid,ord)
 JOIN pg_catalog.pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=x.sc
 JOIN pg_catalog.pg_attribute b ON b.attrelid=k.confrelid AND b.attnum=x.tc
 JOIN pg_catalog.pg_operator op ON op.oid=x.opid JOIN pg_catalog.pg_namespace opn ON opn.oid=op.oprnamespace
 JOIN pg_catalog.pg_proc p ON p.oid=op.oprcode JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
 WHERE k.contype='f' AND src.relation<>'auth.users')
 SELECT pg_catalog.jsonb_build_object('relations',(SELECT count(*) FROM tables),
 'relationIdentities',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',relation,'oid',oid::text) ORDER BY relation) FROM tables),
 'unlockedRelations',(SELECT count(*) FROM tables c WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_locks l
   WHERE l.locktype='relation' AND l.pid=pg_catalog.pg_backend_pid() AND l.relation=c.oid
   AND l.mode='AccessShareLock' AND l.granted)),
 'unsafeRelations',(SELECT count(*) FROM tables WHERE relkind<>'r' OR relispartition OR relhassubclass),
 'unsafeTypes',(SELECT count(*) FROM columns WHERE output_schema<>'pg_catalog'
   OR NOT(typtype='e' OR (type_schema='pg_catalog' AND typtype='b'))
   OR (typelem<>0 AND (element_output_schema IS DISTINCT FROM 'pg_catalog' OR element_kind NOT IN ('b','e')))
   OR EXISTS(SELECT 1 FROM pg_catalog.pg_cast c JOIN pg_catalog.pg_proc p ON p.oid=c.castfunc
     JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE c.castsource=columns.oid AND c.casttarget=25 AND n.nspname<>'pg_catalog')),
 'foreignKeyColumns',(SELECT count(*) FROM fk),
 'unsafeEquality',(SELECT count(*) FROM fk WHERE operator_schema<>'pg_catalog' OR procedure_schema<>'pg_catalog'
   OR oprname<>'=' OR exact_equality IS DISTINCT FROM true))::text AS payload`;

/** Closed query compiler for reviewed catalog data. Never accepts caller SQL or executes it. */
export function createResetReadPlan(catalogInput: unknown, bindingInput: unknown) {
  const result = validateResetCatalog(catalogInput); const parsed = bindingSchema.safeParse(bindingInput);
  if (!parsed.success) return fail();
  const binding = parsed.data; const catalog = result.catalog;
  if (binding.catalogFingerprint !== result.catalogFingerprint || binding.classificationFingerprint !== RESET_ROW_RULE_FINGERPRINT ||
      result.unsupportedKeyCount || result.unsupportedForeignKeyCount || result.missingPrimaryKeyCount ||
      catalog.boundaryRelations.some(table => table.name !== 'auth.users') ||
      catalog.foreignKeys.some(fk => fk.source.startsWith('auth.'))) return fail();
  const all = [...catalog.relations, ...catalog.boundaryRelations];
  const tables = new Map(all.map(table => [table.name, table]));
  if (['id', 'auth_user_id', 'role'].some(name => !tables.get('public.profiles')?.columns.some(column => column.name === name))) return fail();
  for (const table of all) {
    const expression = resetRowDispositionExpression(table.name, 'r');
    if (table.kind !== 'r' || !expression || [...expression.matchAll(/\br\.([a-z_][a-z0-9_]*)/g)]
      .some(match => !table.columns.some(column => column.name === match[1]))) return fail();
    if (primary(table).some(key => table.columns.find(column => column.name === key)?.nullable !== false)) return fail();
  }
  const columns = (table: ResetCatalogRelation) => table.name === 'auth.users' ? table.columns.filter(column => column.name === 'id') : table.columns;
  const cell = (table: ResetCatalogRelation, name: string, alias: 'r' | 't') => {
    const column = columns(table).find(column => column.name === name); if (!column) return fail();
    return `pg_catalog.jsonb_build_object('name',${literal(name)},'pgType',${literal(column.type)},'value',${alias}.${identifier(name)}::pg_catalog.text)`;
  };
  const array = (items: string[]) => {
    const chunks: string[] = [];
    for (let i = 0; i < items.length; i += 100) chunks.push(`pg_catalog.jsonb_build_array(${items.slice(i, i + 100).join(',')})`);
    return chunks.length ? `(${chunks.join('||')})` : "'[]'::pg_catalog.jsonb";
  };
  const cells = (table: ResetCatalogRelation, names: string[], alias: 'r' | 't') => array(names.map(name => cell(table, name, alias)));
  const statements = all.map(table => {
    const fks = catalog.foreignKeys.filter(fk => fk.source === table.name);
    const keys = cells(table, primary(table), 'r');
    const values = cells(table, columns(table).map(column => column.name), 'r');
    const refs = fks.map(fk => {
      const target = tables.get(fk.target); if (!target) return fail();
      const equality = fk.sourceColumns.map((name, index) => {
        const targetName = fk.targetColumns[index]; if (!targetName) return fail();
        return `t.${identifier(targetName)} OPERATOR(pg_catalog.=) r.${identifier(name)}`;
      }).join(' AND ');
      return `pg_catalog.jsonb_build_object('constraint',${literal(fk.name)},'targetKey',
 (SELECT ${cells(target, primary(target), 't')} FROM ONLY ${relation(fk.target)} t WHERE ${equality}),
 'sourceNulls',pg_catalog.jsonb_build_array(${fk.sourceColumns.map(name => `r.${identifier(name)} IS NULL`).join(',')}))`;
    });
    const content = `'relation',${literal(table.name)},'key',${keys},'values',${values}`;
    return { relation: table.name,
      countSql: `SELECT count(*)::text AS row_count FROM (SELECT 1 FROM ONLY ${relation(table.name)} LIMIT 10001) bounded`,
      rowsSql: `SELECT pg_catalog.jsonb_build_object(${content},'candidate',(${resetRowDispositionExpression(table.name, 'r')}),
 'references',${array(refs)})::text AS payload FROM ONLY ${relation(table.name)} r LIMIT 10001`,
      contentSql: `SELECT pg_catalog.jsonb_build_object(${content})::text AS payload FROM ONLY ${relation(table.name)} r LIMIT 10001`,
    };
  });
  return { binding, catalogFingerprint: result.catalogFingerprint, statements,
    // ACCESS SHARE prevents concurrent DDL retargeting between catalog verification and row reads.
    lockSql: `LOCK TABLE ${all.map(table => `ONLY ${relation(table.name)}`).join(',')} IN ACCESS SHARE MODE`,
    expected: { binding, relations: all.map(table => ({ relation: table.name,
      columns: columns(table).map(column => ({ name: column.name, pgType: column.type })), primaryKey: primary(table) })),
    foreignKeys: catalog.foreignKeys.map(fk => ({ source: fk.source, target: fk.target, name: fk.name,
      sourceNullable: fk.sourceColumns.map(name => tables.get(fk.source)?.columns.find(column => column.name === name)?.nullable ?? fail()),
      match: fk.match, validated: true as const })) },
    foreignKeyColumns: catalog.foreignKeys.reduce((count, fk) => count + fk.sourceColumns.length, 0),
  };
}
