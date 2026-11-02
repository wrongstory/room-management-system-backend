import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => ({ clients: [], sql: [], bundle: null, material: null, before: null, after: null, state: null, committed: false, failCommit: false, failSql: false, wrongTls: false, lock: true }));
vi.mock('node:tls', async original => {
  const actual = await original(); const events = await import('node:events');
  class Socket extends events.EventEmitter {
    encrypted = true; authorized = true; destroyed = false;
    disableRenegotiation() {} destroy() { this.destroyed = true; }
  }
  return { ...actual, TLSSocket: Socket, checkServerIdentity: () => undefined };
});
vi.mock('pg', async () => {
  const { TLSSocket } = await import('node:tls');
  const events = await import('node:events');
  const select = values => ({ command: 'SELECT', rowCount: values.length, rows: values, fields: Array.from({ length: values[0]?.length ?? 5 }, () => ({ dataTypeID: 25, format: 'text' })) });
  class Client extends events.EventEmitter {
    constructor(config) { super(); this.config = config; this.connection = new events.EventEmitter(); this.connection.stream = new TLSSocket(); this.connectionParameters = { password: config.password }; this.index = memory.clients.length; memory.clients.push(this); }
    async connect() { this.connection.emit('sslconnect'); }
    async end() { this.connection.stream.destroy(); this.ended = true; }
    async query({ text, values }) {
      memory.sql.push({ client: this.index, text, values });
      if (text.startsWith('BEGIN')) { this.readOnly = text.endsWith('READ ONLY'); return { command: 'BEGIN' }; }
      if (text === 'ROLLBACK') return { command: 'ROLLBACK' };
      if (text === 'COMMIT') { memory.committed = true; if (memory.failCommit) throw new Error('sensitive SQL'); return { command: 'COMMIT' }; }
      if (text.includes('pg_try_advisory_lock')) return select([[String(memory.lock)]]);
      if (text.includes('pg_backend_pid')) return select([[String(100 + this.index), '2026-10-25T00:00:00.000001Z', '1', '2', 'postgres', 'postgres', this.config.application_name, '170011', this.readOnly ? 'on' : 'off', 'repeatable read', 'UTF8', 'UTF8', 'on']]);
      if (text.includes("set_config('statement_timeout'")) { this.limits = values.slice(0, 3).map(value => value.slice(0, -2)); return select([values]); }
      if (text.includes("name='statement_timeout'")) return select([this.limits]);
      if (text.startsWith('INSERT INTO supabase_migrations')) return { command: 'INSERT', rowCount: 1 };
      if (text.includes('FROM pg_catalog.pg_stat_activity WHERE pid=')) {
        const writer = memory.clients[0];
        return writer.connection.stream.destroyed ? select([]) : select([['2026-10-25T00:00:00.000001Z', '1', '2', writer.config.application_name, 'idle']]);
      }
      if (text === 'SELECT 1') { if (memory.failSql) throw new Error('sensitive SQL'); return select([['1']]); }
      throw new Error('unexpected synthetic SQL');
    }
  }
  return { Client };
});
vi.mock('../scripts/lib/migration-source-bundle.mjs', () => ({ isOwnedMigrationSourceBundle: value => value === memory.bundle,
  migrationExecutionMaterial: () => ({ plan: memory.material.plan, sqlBytes: Buffer.from(memory.material.sqlBytes) }) }));
vi.mock('../scripts/lib/migration-history-codec.mjs', () => ({ migrationHistoryWriteMaterial: model => ({ version: model.version, name: model.name, statements: ['SELECT 1'] }), migrationHistoryPolicyRows: snapshot => snapshot.rows }));
vi.mock('../scripts/lib/migration-readonly-postgres.mjs', () => ({
  migrationPostgresConnectionInput: input => ({ target: input.target, password: input.credential.password, caPem: input.caPem }),
  migrationPostgresTlsIdentity: client => { if (memory.wrongTls) throw new Error('untrusted peer'); return { socket: client.connection.stream, peerCertificateSha256: 'a'.repeat(64) }; },
  readMigrationHistoryInTransaction: async () => memory.committed ? memory.after : memory.before,
}));
vi.mock('../scripts/lib/migration-postgres-state.mjs', () => ({ readPostgresMigrationState: async () => memory.state }));
const { createAtomicMigrationSessionFactory } = await import('../scripts/lib/migration-atomic-postgres.mjs');
const { prepareMigrationRelease } = await import('../scripts/lib/migration-release-preflight.mjs');
const { superviseMigrationRelease } = await import('../scripts/lib/migration-release-supervisor.mjs');
const { createMigrationStateSnapshot, migrationStateDigests } = await import('../scripts/lib/migration-state-snapshot.mjs');
const sha = value => createHash('sha256').update(value).digest('hex');
const h = number => number.toString(16).padStart(64, '0');
let counter = 0;
function fixture() {
  counter += 1;
  const coverage = { serverMajor: 17, schemas: ['public'], catalogKinds: ['schema', 'relation', 'column', 'constraint', 'index', 'function', 'owner', 'acl', 'rls', 'policy', 'trigger', 'type'], dataRelations: [], sequences: [] };
  memory.state = createMigrationStateSnapshot({ coverage, catalog: [], data: [], sequences: [] });
  const state = migrationStateDigests(memory.state);
  const source = { projectRef: 'a'.repeat(19) + String.fromCharCode(97 + counter), sourceRef: 'refs/heads/main', headSha1: 'a'.repeat(40), treeSha1: 'b'.repeat(40), manifestSha256: h(10), historySha256: h(11) };
  const baseline = [{ version: '20260101000000', name: 'baseline', statementsSha256: h(12) }];
  const migration = { version: '20260102000000', name: 'first', sqlSha256: sha('SELECT 1;'), statementsSha256: h(14), statementSha256s: [sha('SELECT 1')], preHistorySha256: h(11), postHistorySha256: h(17), preState: state, postState: state };
  const request = prepareMigrationRelease({ repository: 'wrongstory/room-management-system-backend', policy: { expectedSource: source, observedSource: source,
    expectedHistory: baseline, observedHistory: baseline, pending: [migration], observedPending: [migration], budget: { overallMs: 10000, statementMs: 1000, lockMs: 200, idleTransactionMs: 1000 } },
    remote: { repository: 'wrongstory/room-management-system-backend', ...source, mergedReleasePr: 500, application: 'PASS', migration: 'FULL_DB_PASS', independentReview: 'PASS' }, validationFingerprint: h(50), recoveryEvidenceSha256: h(51) });
  const plan = { sqlSha256: migration.sqlSha256, statementSha256s: migration.statementSha256s, statements: [{ startByte: 0, endByte: 8, transactionKind: null }] };
  const bundle = { modelSource: source, parserMajor: 17, bundleSha256: h(52), files: [{ path: 'first.sql', version: migration.version, name: migration.name, plan }] };
  memory.bundle = bundle; memory.material = { plan, sqlBytes: Buffer.from('SELECT 1;') };
  memory.before = { historySha256: h(11), rows: baseline, rowCount: 1 };
  memory.after = { historySha256: h(17), rows: [...baseline, { version: migration.version, name: migration.name, statementsSha256: h(14) }], rowCount: 2 };
  const historyModels = [{ version: migration.version, name: migration.name, sourceBinding: { bundleSha256: h(52) }, historyStatementsSha256: h(14) }];
  return { request, bundle, historyModels, coverage: [{ version: migration.version, before: coverage, after: coverage }], connection: { target: { scope: 'SUPABASE', mode: 'direct', projectRef: source.projectRef, host: `db.${source.projectRef}.supabase.co`, port: 5432, database: 'postgres', role: 'postgres' }, credential: { password: 'synthetic-only' }, caPem: 'synthetic-ca' } };
}
const authorize = ({ requestSha256, runId }) => ({ requestSha256, runId, issuedAtMs: Date.now(), expiresAtMs: Date.now() + 60000, action: 'APPLY_EXACT_MIGRATIONS_ONCE' });
beforeEach(() => { Object.assign(memory, { clients: [], sql: [], committed: false, failCommit: false, failSql: false, wrongTls: false, lock: true }); });
describe('#378 pg adapter with every connection replaced by an in-memory Client', () => {
  it('is lazy and sends SQL/history on the same owned transaction, followed by separate readback', async () => {
    const value = fixture(); const factory = createAtomicMigrationSessionFactory(value);
    expect(memory.clients).toHaveLength(0);
    const result = await superviseMigrationRelease({ request: value.request, authorize, openSession: factory.openSession });
    expect(result).toMatchObject({ classification: 'APPLIED', appliedCount: 1, code: 'MIGRATION_SUPERVISOR_COMPLETE' });
    const sqlIndex = memory.sql.findIndex(row => row.text === 'SELECT 1'); const historyIndex = memory.sql.findIndex(row => row.text.startsWith('INSERT INTO'));
    const commitIndex = memory.sql.findIndex(row => row.text === 'COMMIT');
    expect(sqlIndex).toBeGreaterThan(0); expect(historyIndex).toBeGreaterThan(sqlIndex); expect(commitIndex).toBeGreaterThan(historyIndex);
    expect([memory.sql[sqlIndex].client, memory.sql[historyIndex].client, memory.sql[commitIndex].client]).toEqual([0, 0, 0]);
    expect(memory.sql[historyIndex].values).toEqual(['20260102000000', 'first', ['SELECT 1']]);
    expect(memory.clients).toHaveLength(2); expect(memory.clients.every(client => client.ended && client.connectionParameters.password === null)).toBe(true);
    expect(memory.clients[0].config.ssl.rejectUnauthorized).toBe(true); expect(memory.clients[0].config.enableChannelBinding).toBe(true);
    factory.dispose();
  });
  it('reconciles a lost commit from a fresh connection without reissuing SQL', async () => {
    const value = fixture(); memory.failCommit = true; const factory = createAtomicMigrationSessionFactory(value);
    const result = await superviseMigrationRelease({ request: value.request, authorize, openSession: factory.openSession });
    expect(result).toMatchObject({ classification: 'APPLIED', appliedCount: 1 });
    expect(memory.sql.filter(row => row.text === 'SELECT 1')).toHaveLength(1); expect(memory.clients).toHaveLength(2); factory.dispose();
  });
  it('does not write history or commit after SQL failure, and recognizes exact pre-state plus a gone writer', async () => {
    const value = fixture(); memory.failSql = true; const factory = createAtomicMigrationSessionFactory(value);
    const result = await superviseMigrationRelease({ request: value.request, authorize, openSession: factory.openSession });
    expect(result).toMatchObject({ classification: 'NOT_APPLIED', appliedCount: 0 });
    expect(memory.sql.some(row => row.text.startsWith('INSERT INTO') || row.text === 'COMMIT')).toBe(false); factory.dispose();
  });
  it.each(['wrongTls', 'lock'])('rejects missing TLS/ownership proof before any migration SQL: %s', async key => {
    const value = fixture(); memory[key] = key === 'wrongTls'; const factory = createAtomicMigrationSessionFactory(value);
    const result = await superviseMigrationRelease({ request: value.request, authorize, openSession: factory.openSession });
    expect(result.code).not.toBe('MIGRATION_SUPERVISOR_COMPLETE'); expect(memory.sql.some(row => row.text === 'SELECT 1')).toBe(false); factory.dispose();
  });
  it.each(['bundle', 'historyModels', 'coverage'])('rejects source/codec/coverage mismatch before construction: %s', key => {
    const value = fixture(); value[key] = key === 'bundle' ? structuredClone(value.bundle) : [];
    expect(() => createAtomicMigrationSessionFactory(value)).toThrow('MIGRATION_ATOMIC_DRIVER_INVALID'); expect(memory.clients).toHaveLength(0);
  });
  it('rejects tampered parser bytes and target project before construction', () => {
    const value = fixture(); memory.material.sqlBytes = Buffer.from('SELECT 2;');
    expect(() => createAtomicMigrationSessionFactory(value)).toThrow(); expect(memory.clients).toHaveLength(0);
  });
});
