import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { validateResetCatalog } from '../scripts/reset-catalog-contract.mjs';
import { RESET_ROW_RULE_FINGERPRINT } from '../scripts/reset-row-policy.mjs';
import { createResetReadPlan, resetReadIdentitySql, resetReadSafetySql } from '../src/modules/developer-reset/snapshot-read-plan.js';
import { inspectResetReadOnlySource } from '../src/modules/developer-reset/snapshot-read-source.js';
import { resetCatalog } from './helpers/reset-catalog.js';

const names = ['pid', 'database_name', 'role_name', 'read_only', 'isolation', 'row_security', 'nonce', 'encoding',
  'timezone', 'datestyle', 'intervalstyle', 'bytea_output', 'float_digits', 'bypass_rls', 'snapshot', 'statement_timeout', 'lock_timeout'];
const id = '11111111-1111-4111-8111-111111111111';
const authId = '22222222-2222-4222-8222-222222222222';
function fixture() {
  const catalog = resetCatalog();
  catalog.relations[0]?.columns.push({ name: 'role', position: 3, type: 'public.app_role', nullable: false });
  const binding = { projectRef: 'a'.repeat(20), sourceCommit: 'b'.repeat(40),
    catalogFingerprint: validateResetCatalog(catalog).catalogFingerprint, classificationFingerprint: RESET_ROW_RULE_FINGERPRINT };
  return { catalog, binding, database: 'postgres', role: 'postgres' };
}
const result = (names: string[], rows: (string | null)[][]) => ({ command: 'SELECT', fields: names.map(name => ({ name, dataTypeID: 25 })), rows });
const json = (value: unknown) => result(['payload'], [[JSON.stringify(value)]]);
const cell = (name: string, value: string, pgType = 'pg_catalog.uuid') => ({ name, value, pgType });
const safety = () => ({ relations: 3, unsafeRelations: 0, unsafeTypes: 0, foreignKeyColumns: 1, unsafeEquality: 0,
  relationIdentities: ['auth.users', 'public.profiles', 'public.rooms'].map((name, index) => ({ name, oid: String(index + 100) })), unlockedRelations: 0 });
function harness() {
  const input = fixture(); const plan = createResetReadPlan(input.catalog, input.binding);
  const profile = { relation: 'public.profiles', key: [cell('id', id)], values: [cell('id', id), cell('auth_user_id', authId), cell('role', 'developer', 'public.app_role')],
    candidate: 'preserve', references: [{ constraint: 'profiles_auth_fkey', targetKey: [cell('id', authId)], sourceNulls: [false] }] };
  const auth = { relation: 'auth.users', key: [cell('id', authId)], values: [cell('id', authId)], candidate: 'preserve', references: [] };
  const rows: Record<string, unknown>[] = [profile, auth];
  const state = { nonce: '', identities: 0, catalogs: 0, closed: false, destroyed: false,
    mutate: (_sql: string, value: unknown): unknown => value };
  const query = vi.fn(async (sql: string, values: readonly string[]) => {
    let value: unknown;
    if (sql.startsWith('BEGIN')) value = { command: 'BEGIN', rows: [] };
    else if (sql.startsWith('LOCK TABLE')) value = { command: 'LOCK', rows: [] };
    else if (sql === 'ROLLBACK') value = { command: 'ROLLBACK', rows: [] };
    else if (sql.startsWith('SET LOCAL')) {
      state.nonce = sql.match(/application_name = '([^']+)'/)?.[1] ?? '';
      value = Array.from({ length: 11 }, () => ({ command: 'SET', rows: [] }));
    } else if (sql === resetReadIdentitySql) {
      state.identities++; value = result(names, [['123', 'postgres', 'postgres', 'on', 'repeatable read', 'off', state.nonce,
        'UTF8', 'UTC', 'ISO, MDY', 'iso_8601', 'hex', '3', 'true', '100:200:110,112', '4s', '1s']]);
    } else if (sql === resetReadSafetySql) value = json(safety());
    else if (sql.includes('WITH app_relations AS')) { state.catalogs++; value = json(input.catalog); }
    else if (sql.includes('counted.row_count')) value = result(['relation', 'row_count'], [['public.profiles', '1'], ['public.rooms', '0'], ['auth.users', '1']]);
    else if (sql.includes("'candidate'")) value = result(['payload'], rows.map(row => [JSON.stringify(row)]));
    else value = result(['payload'], rows.map(({ candidate: _candidate, references: _refs, ...row }) => [JSON.stringify(row)]));
    return state.mutate(sql, value);
  });
  const client = { query, destroy: () => { state.destroyed = true; }, close: async () => { state.closed = true; } };
  const open = vi.fn(async () => client);
  return { input, plan, state, rows, client, open, run: () => inspectResetReadOnlySource(input, open) };
}
function alterRecord(value: unknown, mutate: (value: ReturnType<typeof result>) => void) { const copy = structuredClone(value) as ReturnType<typeof result>; mutate(copy); return copy; }

describe('closed readonly reset collector with synthetic connection (DB execution zero)', () => {
  it('runs one bounded RR transaction, independently reads count/content and returns no raw values', async () => {
    const h = harness(); const outcome = await h.run();
    expect(outcome).toMatchObject({ snapshotValid: true, executionEnabled: false, liveDatabaseVerified: false, consistency: 'repeatable-read' });
    expect(h.state).toMatchObject({ identities: 2, catalogs: 2, closed: true, destroyed: false });
    expect(h.client.query.mock.calls).toHaveLength(13);
    expect(h.client.query.mock.calls[0]?.[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(h.client.query.mock.calls[1]?.[0]).toMatch(/^SET LOCAL/);
    expect(h.client.query.mock.calls[2]?.[0]).toMatch(/^LOCK TABLE/);
    expect(h.client.query.mock.calls[3]?.[0]).toBe(resetReadIdentitySql);
    expect(h.client.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    for (const forbidden of [id, authId, 'public.profiles', 'pg_catalog', 'nonce']) expect(JSON.stringify(outcome)).not.toContain(forbidden);
  });
  it.each([
    ['readonly', 3, 'off'], ['isolation', 4, 'read committed'], ['RLS', 5, 'on'], ['nonce', 6, 'other'],
    ['encoding', 7, 'SQL_ASCII'], ['timezone', 8, 'Asia/Seoul'], ['bypass', 13, 'false'], ['statement timeout', 15, '0'],
  ])('rejects an unsafe %s observation before business reads', async (_label, index, value) => {
    const h = harness(); h.state.mutate = (sql, result) => sql === resetReadIdentitySql ? alterRecord(result, r => { if (r.rows[0]) r.rows[0][Number(index)] = String(value); }) : result;
    expect((await h.run()).blockers).toContain('RESET_READ_IDENTITY_INVALID'); expect(h.state.destroyed).toBe(true);
    expect(h.client.query.mock.calls.some(([sql]) => sql.includes("'candidate'"))).toBe(false);
  });
  it.each(['unsafeRelations', 'unsafeTypes', 'unsafeEquality', 'unlockedRelations'])('rejects %s without a partial snapshot', async key => {
    const h = harness(); h.state.mutate = (sql, result) => sql === resetReadSafetySql ? json({ ...safety(), [key]: 1 }) : result;
    expect((await h.run()).blockers).toContain('RESET_READ_SEMANTICS_UNSUPPORTED');
  });
  it('rejects relation OID changes and malformed SET completion instead of accepting a partial lock scope', async () => {
    const h = harness(); let reads = 0;
    h.state.mutate = (sql, value) => {
      if (sql === resetReadSafetySql && ++reads === 2) {
        const changed = safety(); if (changed.relationIdentities[0]) changed.relationIdentities[0].oid = '777'; return json(changed);
      } return value;
    };
    expect((await h.run()).blockers).toContain('RESET_READ_RELATION_IDENTITY_CHANGED');
    const config = harness(); config.state.mutate = (sql, value) => sql.startsWith('SET LOCAL') ? [{ command: 'SET', rows: [] }] : value;
    expect((await config.run()).blockers).toContain('RESET_READ_CONFIG_INVALID');
    expect(config.client.query.mock.calls.some(([sql]) => sql.startsWith('LOCK TABLE'))).toBe(false);
  });
  it('fails when the second independent content read changes a value at the same count', async () => {
    const h = harness(); h.state.mutate = (sql, value) => {
      if (sql.includes("'values'") && !sql.includes("'candidate'")) return alterRecord(value, v => {
        const first = JSON.parse(v.rows[0]?.[0] ?? ''); first.values[2].value = 'maid'; if (v.rows[0]) v.rows[0][0] = JSON.stringify(first);
      }); return value;
    };
    expect((await h.run()).blockers).toContain('CENSUS_CONTENT_MISMATCH');
  });
  it('does not map an unresolved candidate into keep/remove or skip independent content reads', async () => {
    const h = harness(); if (h.rows[0]) h.rows[0].candidate = 'templateSource';
    expect((await h.run()).blockers).toContain('RESET_TEMPLATE_DISPOSITION_UNRESOLVED');
    expect(h.state).toMatchObject({ identities: 2, catalogs: 2, closed: true });
  });
  it('rejects final identity drift and catalog changes', async () => {
    const h = harness(); h.state.mutate = (sql, value) => sql === resetReadIdentitySql && h.state.identities === 2 ? alterRecord(value, v => { if (v.rows[0]) v.rows[0][0] = '456'; }) : value;
    expect((await h.run()).blockers).toContain('RESET_READ_IDENTITY_CHANGED');
    const c = harness(); c.state.mutate = (sql, value) => {
      if (!sql.includes('WITH app_relations AS') || c.state.catalogs !== 2) return value;
      const changed = structuredClone(c.input.catalog); if (changed.relations[0]) changed.relations[0].rls = false; return json(changed);
    };
    expect((await c.run()).blockers).toContain('RESET_READ_CATALOG_CHANGED');
  });
  it('stops at an oversized independent count before retrieving row values', async () => {
    const h = harness(); h.state.mutate = (sql, value) => sql.includes('counted.row_count') ? result(['relation', 'row_count'], [['public.profiles', '10001']]) : value;
    expect((await h.run()).blockers).toContain('RESET_READ_ROW_LIMIT'); expect(h.client.query.mock.calls.some(([sql]) => sql.includes("'candidate'"))).toBe(false);
  });
  it('masks transport errors and rejects unsafe result codecs and missing zero census', async () => {
    const h = harness(); h.state.mutate = () => { throw new Error('synthetic-secret'); };
    expect((await h.run()).blockers).toEqual(['RESET_READ_SOURCE_FAILED']);
    const codec = harness(); codec.state.mutate = (sql, value) => sql === resetReadIdentitySql ? alterRecord(value, v => { if (v.fields[0]) v.fields[0].dataTypeID = 3802; }) : value;
    expect((await codec.run()).blockers).toContain('RESET_READ_RESULT_INVALID');
    const census = harness(); census.state.mutate = (sql, value) => sql.includes('counted.row_count') ? result(['relation', 'row_count'], [['public.profiles', '1'], ['auth.users', '1']]) : value;
    expect((await census.run()).blockers).toContain('RESET_READ_CENSUS_INVALID');
  });
  it('aborts a pending read without returning valid evidence or waiting for remote cooperation', async () => {
    const h = harness(); const abort = new AbortController();
    h.client.query.mockImplementation(async () => { queueMicrotask(() => abort.abort()); return new Promise(() => {}); });
    expect((await inspectResetReadOnlySource(h.input, h.open, abort.signal)).blockers).toContain('RESET_READ_CANCELLED');
    expect(h.state.destroyed).toBe(true);
  });
  it('rejects binding changes before opening the client', async () => {
    const h = harness(); h.input.binding.catalogFingerprint = 'f'.repeat(64);
    expect((await h.run()).blockers).toContain('RESET_READ_PLAN_REJECTED'); expect(h.open).not.toHaveBeenCalled();
  });
  it('rejects oversized wire payload before parsing contents', async () => {
    const h = harness(); h.state.mutate = (sql, value) => sql.includes("'candidate'") ? result(['payload'], [['x'.repeat(16 * 1024 * 1024 + 1)]]) : value;
    expect((await h.run()).blockers).toContain('RESET_READ_WIRE_LIMIT'); expect(h.state.destroyed).toBe(true);
  });
  it('treats rollback or close failure as failure even after complete content reads', async () => {
    const rollback = harness(); rollback.state.mutate = (sql, value) => sql === 'ROLLBACK' ? { command: 'COMMIT', rows: [] } : value;
    expect((await rollback.run()).blockers).toContain('RESET_READ_COMMAND_INVALID');
    const close = harness(); close.client.close = async () => { throw new Error('synthetic-close-secret'); };
    expect((await close.run()).blockers).toContain('RESET_READ_SOURCE_FAILED'); expect(close.state.destroyed).toBe(true);
  });
  it('bounds a hanging close and destroys a connection that opens after cancellation', async () => {
    vi.useFakeTimers();
    try {
      const h = harness(); h.client.close = () => new Promise(() => {});
      const running = h.run(); await vi.advanceTimersByTimeAsync(351);
      expect((await running).blockers).toContain('RESET_READ_DEADLINE'); expect(h.state.destroyed).toBe(true);
      const late = harness(); const abort = new AbortController(); let resolve!: (client: typeof late.client) => void;
      const pending = inspectResetReadOnlySource(late.input, () => new Promise(done => { resolve = done; }), abort.signal);
      await vi.advanceTimersByTimeAsync(0); abort.abort();
      expect((await pending).blockers).toContain('RESET_READ_CANCELLED'); resolve(late.client);
      await vi.advanceTimersByTimeAsync(0); expect(late.state.destroyed).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it('fails on injected scope or extra raw fields rather than silently overwriting them', async () => {
    const h = harness(); if (h.rows[0]) h.rows[0].scopeId = 'a'.repeat(64);
    expect((await h.run()).blockers).toContain('RESET_READ_RESULT_INVALID');
  });
});

describe('SQL source compiler only', () => {
  it('parses the actual generated SELECT/LOCK source without running PostgreSQL', async () => {
    const h = harness(); await h.run();
    const { Parser } = createRequire(import.meta.url)('@pgsql/parser'); const parser = new Parser({ version: 17 });
    for (const [sql] of h.client.query.mock.calls) expect(await parser.parse(sql)).toBeTruthy();
  });
  it('keeps Auth rows ID-only, closed identifiers, real target PK and guarded SQL equality', () => {
    const h = harness(); const auth = h.plan.statements.find(row => row.relation === 'auth.users');
    expect(auth?.rowsSql).not.toMatch(/encrypted_password|auth\.users\.\*|r\."role"/);
    expect(h.plan.statements[0]?.rowsSql).toContain('OPERATOR(pg_catalog.=)');
    expect(resetReadSafetySql).toContain('a.atttypid=op.oprright'); expect(resetReadSafetySql).toContain('a.attcollation=b.attcollation');
    // PG17 expands only unqualified multi-array unnest. Explicit ROWS FROM
    // keeps each schema-qualified built-in call unary during semantic analysis.
    expect(resetReadSafetySql).toContain('ROWS FROM (pg_catalog.unnest(k.conkey),pg_catalog.unnest(k.confkey),pg_catalog.unnest(k.conpfeqop))');
    expect(resetReadSafetySql).toContain("src.relation<>'auth.users'");
    expect(h.plan.lockSql).toContain('IN ACCESS SHARE MODE');
  });
});
