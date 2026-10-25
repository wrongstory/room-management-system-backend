import { vi } from 'vitest';
import { validateResetCatalog } from '../../scripts/reset-catalog-contract.mjs';
import { RESET_ROW_RULE_FINGERPRINT } from '../../scripts/reset-row-policy.mjs';
import { inspectResetReadOnlyReview, resetReviewEvidenceSql } from '../../src/modules/developer-reset/snapshot-read-source.js';
import { resetReadIdentitySql, resetReadSafetySql } from '../../src/modules/developer-reset/snapshot-read-plan.js';
import { resetReviewFixture, reviewDbSnapshot } from './reset-review.js';
const select = (names: string[], rows: (string | null)[][]) => ({ command: 'SELECT', fields: names.map(name => ({ name, dataTypeID: 25 })), rows });
const json = (input: unknown) => select(['payload'], [[JSON.stringify(input)]]);
const names = ['pid', 'database_name', 'role_name', 'read_only', 'isolation', 'row_security', 'nonce', 'encoding',
  'timezone', 'datestyle', 'intervalstyle', 'bytea_output', 'float_digits', 'bypass_rls', 'snapshot', 'statement_timeout', 'lock_timeout'];
export function reviewSourceHarness(configure?: (fixture: ReturnType<typeof resetReviewFixture>) => void) {
  const f = resetReviewFixture();
  configure?.(f);
  const tables = f.metadata.relations.map(table => ({ name: table.relation, kind: 'r', rls: true, forceRls: false,
    columns: table.columns.map((column, position) => ({ name: column.name, position: position + 1, type: column.pgType, nullable: !table.primaryKey.includes(column.name) })),
    keys: [{ name: `${table.relation.split('.')[1]}_pkey`, columns: table.primaryKey, primary: true, valid: true, immediate: true, partial: false, expressions: false }] }));
  const catalog = { format: 'reset-catalog-v2', readOnly: true, relations: tables.filter(t => !t.name.startsWith('auth.')),
    boundaryRelations: tables.filter(t => t.name.startsWith('auth.')), foreignKeys: [{ source: 'public.profiles', target: 'auth.users', name: 'profiles_auth_fkey',
      definition: 'FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE RESTRICT', sourceColumns: ['auth_user_id'], targetColumns: ['id'],
      targetKey: 'users_pkey', match: 's', onDelete: 'r', onUpdate: 'a', validated: true, deferrable: false, initiallyDeferred: false }], triggers: [] };
  const profile = f.rows.find(row => row.relation === 'public.profiles'), auth = f.rows.find(row => row.relation === 'auth.users');
  if (!profile || !auth) throw new Error('fixture missing');
  profile.references.push({ constraint: 'profiles_auth_fkey', targetKey: auth.key, sourceNulls: [false] });
  const binding = { ...f.metadata.binding, catalogFingerprint: validateResetCatalog(catalog).catalogFingerprint, classificationFingerprint: RESET_ROW_RULE_FINGERPRINT };
  const source = { catalog, binding, database: 'postgres', role: 'postgres' };
  let nonce = '';
  const state = { scope: reviewDbSnapshot, identitySnapshot: reviewDbSnapshot, statementId: f.sidecar.statementId, failClose: false, corruptContent: false,
    mutate: (input: unknown): unknown => input };
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith('BEGIN')) return { command: 'BEGIN', rows: [] };
    if (sql.startsWith('LOCK TABLE')) return { command: 'LOCK', rows: [] };
    if (sql === 'ROLLBACK') return { command: 'ROLLBACK', rows: [] };
    if (sql.startsWith('SET LOCAL')) { nonce = sql.match(/application_name = '([^']+)'/)?.[1] ?? ''; return Array.from({ length: 11 }, () => ({ command: 'SET', rows: [] })); }
    if (sql === resetReadIdentitySql) return select(names, [['123', 'postgres', 'postgres', 'on', 'repeatable read', 'off', nonce,
      'UTF8', 'UTC', 'ISO, MDY', 'iso_8601', 'hex', '3', 'true', state.identitySnapshot, '4s', '1s']]);
    if (sql === resetReadSafetySql) return json({ relations: tables.length, unsafeRelations: 0, unsafeTypes: 0, foreignKeyColumns: 1, unsafeEquality: 0,
      relationIdentities: tables.map((table, i) => ({ name: table.name, oid: String(i + 100) })), unlockedRelations: 0 });
    if (sql.includes('WITH app_relations AS')) return json(catalog);
    if (sql.includes('counted.row_count')) return select(['relation', 'row_count'], f.census.map(c => [c.header.relation, String(c.header.count)]));
    if (sql === resetReviewEvidenceSql) return json(state.mutate({ databaseSnapshot: state.scope, statementAt: f.sidecar.statementAt,
      statementId: state.statementId, templateEvidence: f.sidecar.templateEvidence, gateEvidence: f.sidecar.gateEvidence }));
    if (sql.includes("'candidate'")) return select(['payload'], f.rows.map(({ scopeId: _scope, disposition, ...row }) => [JSON.stringify({ ...row,
      candidate: disposition === 'keep' ? 'preserve' : disposition === 'remove' ? 'resetCandidate' : disposition })]));
    const contents = f.census.flatMap(c => c.contents).map(({ scopeId: _scope, ...row }) => structuredClone(row));
    if (state.corruptContent && contents[0]?.values[0]) contents[0].values[0].value = 'different';
    return select(['payload'], contents.map(row => [JSON.stringify(row)]));
  });
  const client = { query, destroy: vi.fn(), close: vi.fn(async () => { if (state.failClose) throw new Error('private transport failure'); }) };
  const open = vi.fn(async () => client);
  return { f, source, state, client, open, run: () => inspectResetReadOnlyReview(source, f.request, open) };
}
