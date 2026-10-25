import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { validateResetCatalog } from '../scripts/reset-catalog-contract.mjs';
import { RESET_ROW_RULE_FINGERPRINT } from '../scripts/reset-row-policy.mjs';
import { inspectResetReadOnlyReview, resetReviewEvidenceSql } from '../src/modules/developer-reset/snapshot-read-source.js';
import { resetReadIdentitySql, resetReadSafetySql } from '../src/modules/developer-reset/snapshot-read-plan.js';
import { resetReviewFixture, reviewDbSnapshot } from './helpers/reset-review.js';

const select = (names: string[], rows: (string | null)[][]) => ({ command: 'SELECT', fields: names.map(name => ({ name, dataTypeID: 25 })), rows });
const json = (input: unknown) => select(['payload'], [[JSON.stringify(input)]]);
const names = ['pid', 'database_name', 'role_name', 'read_only', 'isolation', 'row_security', 'nonce', 'encoding',
  'timezone', 'datestyle', 'intervalstyle', 'bytea_output', 'float_digits', 'bypass_rls', 'snapshot', 'statement_timeout', 'lock_timeout'];
function reviewSourceHarness() {
  const f = resetReviewFixture();
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
  const state = { scope: reviewDbSnapshot, statementId: f.sidecar.statementId, failClose: false, corruptContent: false,
    mutate: (input: unknown): unknown => input };
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith('BEGIN')) return { command: 'BEGIN', rows: [] };
    if (sql.startsWith('LOCK TABLE')) return { command: 'LOCK', rows: [] };
    if (sql === 'ROLLBACK') return { command: 'ROLLBACK', rows: [] };
    if (sql.startsWith('SET LOCAL')) { nonce = sql.match(/application_name = '([^']+)'/)?.[1] ?? ''; return Array.from({ length: 11 }, () => ({ command: 'SET', rows: [] })); }
    if (sql === resetReadIdentitySql) return select(names, [['123', 'postgres', 'postgres', 'on', 'repeatable read', 'off', nonce,
      'UTF8', 'UTC', 'ISO, MDY', 'iso_8601', 'hex', '3', 'true', reviewDbSnapshot, '4s', '1s']]);
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

describe('closed review collector composition with an inert connection port', () => {
  it('collects both observations and the existing STABLE sidecar inside the same RR then rolls back and closes', async () => {
    const h = reviewSourceHarness(); const result = await h.run();
    expect(result.review).toMatchObject({ reviewPrepared: true, receiptStatus: { status: 'PREPARED' }, executionEnabled: false, liveDatabaseVerified: false });
    expect(h.client.query.mock.calls).toHaveLength(14);
    expect(h.client.query.mock.calls.findIndex(([sql]) => sql === resetReviewEvidenceSql)).toBe(9);
    expect(h.client.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK'); expect(h.client.close).toHaveBeenCalledOnce();
    expect(h.client.destroy).not.toHaveBeenCalled();
  });
  it.each(['snapshot', 'statement', 'template', 'extra'])('rejects a %s sidecar substitution instead of trusting its labels', async mode => {
    const h = reviewSourceHarness();
    if (mode === 'snapshot') h.state.scope = '200:300:';
    if (mode === 'statement') h.state.statementId = '1'.repeat(64);
    if (mode === 'template') h.f.sidecar.templateEvidence.snapshotId = '1'.repeat(64);
    if (mode === 'extra') h.state.mutate = value => ({ ...(value as object), authorized: true });
    expect((await h.run()).review).toBeNull();
  });
  it('returns no partial candidate after census mutation or connection close failure', async () => {
    for (const name of ['corruptContent', 'failClose'] as const) {
      const h = reviewSourceHarness(); h.state[name] = true;
      const result = await h.run(); expect(result.review).toBeNull(); expect(result.snapshotValid).toBe(false);
      expect(JSON.stringify(result)).not.toContain('private transport');
    }
  });
  it('rejects absent/malformed review intent before opening a connection', async () => {
    const h = reviewSourceHarness();
    expect((await inspectResetReadOnlyReview(h.source, undefined, h.open)).review).toBeNull();
    expect(h.open).not.toHaveBeenCalled();
  });
  it('parses the fixed read-only statement on PostgreSQL15/17 without executing SQL', async () => {
    const require = createRequire(import.meta.url);
    const { Parser } = require('@pgsql/parser');
    for (const version of [15, 17]) {
      const parser = new Parser({ version });
      expect(await parser.parse(resetReviewEvidenceSql)).toBeTruthy();
    }
  });
});
