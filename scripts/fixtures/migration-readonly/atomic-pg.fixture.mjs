/** Actual local PG/TLS atomic adapter tests. Not the production CLI/approval flow.
 * Only the transport destination and source-bundle ownership are fixture adapters.
 * SQL parser, history codec, state collector, pg, TLS and supervisor remain real.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, it, vi } from 'vitest';

const memory = vi.hoisted(() => ({ input: null, bundle: null, bytes: null, plan: null,
  fault: '', clients: [], sentStatements: 0, sentHistory: 0, sentCommits: 0 }));
const project = 'aaaaaaaaaaaaaaaaaaaa';
const hostname = `db.${project}.supabase.co`;
vi.mock('pg', async original => {
  const actual = await original();
  class Client extends actual.Client {
    constructor(config) {
      // No fallback to a hosted address, even for an incorrect caller config.
      if (!memory.input || config.host !== 'db.aaaaaaaaaaaaaaaaaaaa.supabase.co' ||
          config.port !== 5432 || config.database !== 'postgres' || config.user !== 'postgres' ||
          !config.application_name?.startsWith('rms_mig_')) throw new Error('FIXTURE_TRANSPORT_REJECTED');
      super({ ...config, host: '127.0.0.1', port: memory.input.port });
      memory.clients.push(this);
    }
    async query(input) {
      const text = input.text;
      if (text.startsWith('INSERT INTO rms_atomic_fixture.effects')) memory.sentStatements++;
      if (text.startsWith('INSERT INTO supabase_migrations.schema_migrations')) {
        if (memory.fault === 'history-loss') { await this.end(); throw new Error('FIXTURE_TRANSPORT_LOSS'); }
        memory.sentHistory++;
      }
      if (text === 'COMMIT') {
        if (memory.fault === 'before-commit') { await this.end(); throw new Error('FIXTURE_TRANSPORT_LOSS'); }
        memory.sentCommits++;
        const result = await super.query(input);
        if (memory.fault === 'after-commit') { await this.end(); throw new Error('FIXTURE_TRANSPORT_LOSS'); }
        return result;
      }
      if (memory.fault === 'readback-loss' && memory.sentCommits && text.startsWith('BEGIN')) {
        await this.end(); throw new Error('FIXTURE_TRANSPORT_LOSS');
      }
      return super.query(input);
    }
  }
  return { ...actual, Client };
});
vi.mock('../../lib/migration-source-bundle.mjs', () => ({
  isOwnedMigrationSourceBundle: value => value === memory.bundle,
  migrationExecutionMaterial: (bundle, path) => {
    if (bundle !== memory.bundle || path !== 'fixture.sql') throw new Error('FIXTURE_SOURCE_REJECTED');
    return { plan: memory.plan, sqlBytes: Buffer.from(memory.bytes) };
  },
  bindMigrationHistorySource: ({ bundle, path, sqlBytes }) => {
    if (bundle !== memory.bundle || path !== 'fixture.sql' || !sqlBytes.equals(memory.bytes)) throw new Error('FIXTURE_SOURCE_REJECTED');
    return { version: '20260102000000', name: 'atomic_fixture', sqlSha256: memory.plan.sqlSha256,
      planStatementsSha256: memory.plan.statementsSha256, parserEvidenceBound: true };
  },
}));
const { Client: ActualClient } = await vi.importActual('pg');
const { createAtomicMigrationSessionFactory } = await import('../../lib/migration-atomic-postgres.mjs');
const { createMigrationSqlPlan } = await import('../../lib/migration-sql-plan.mjs');
const { createMigrationHistoryModel, createExpectedMigrationHistorySnapshot, migrationHistoryPolicyRows } = await import('../../lib/migration-history-codec.mjs');
const { prepareMigrationRelease } = await import('../../lib/migration-release-preflight.mjs');
const { superviseMigrationRelease } = await import('../../lib/migration-release-supervisor.mjs');
const { readPostgresMigrationState } = await import('../../lib/migration-postgres-state.mjs');
const { migrationStateDigests } = await import('../../lib/migration-state-snapshot.mjs');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const root = realpathSync(fileURLToPath(new URL('../../..', import.meta.url)));
const coverage = { serverMajor: 17, schemas: ['rms_atomic_fixture'],
  catalogKinds: ['schema', 'relation', 'column', 'constraint', 'index', 'function', 'owner', 'acl', 'rls', 'policy', 'trigger', 'type'],
  dataRelations: [{ name: 'rms_atomic_fixture.effects', columns: [{ name: 'id', postgresType: 'integer' }, { name: 'value', postgresType: 'text' }] }], sequences: [] };
const write = "INSERT INTO rms_atomic_fixture.effects(id,value) VALUES (1,'synthetic only')";
let admin;
const query = (text, values = []) => admin.query({ text, values, rowMode: 'array',
  types: { getTypeParser: () => value => value } });
async function observedState() {
  await query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try { return migrationStateDigests(await readPostgresMigrationState(query, coverage)); }
  finally { await query('ROLLBACK'); }
}
beforeAll(async () => {
  const path = realpathSync(process.env.RMS_ATOMIC_FIXTURE_PATH ?? '');
  const part = relative(resolve(root, '.tmp'), path).replaceAll('\\', '/');
  assert(/^pg378-tls-[a-zA-Z0-9]+\/atomic-input.json$/.test(part));
  const input = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(Object.keys(input).sort(), ['caPem', 'password', 'port', 'untrustedCaPem']);
  assert(Number.isInteger(input.port) && input.port > 1024 && input.port <= 65535);
  assert(typeof input.password === 'string' && /^[a-f0-9]{48}$/.test(input.password));
  assert(input.caPem.includes('BEGIN CERTIFICATE') && input.untrustedCaPem.includes('BEGIN CERTIFICATE'));
  memory.input = input;
  admin = new ActualClient({ host: '127.0.0.1', port: input.port, database: 'postgres', user: 'postgres',
    password: input.password, ssl: { ca: input.caPem, rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    connectionTimeoutMillis: 3000, statement_timeout: 5000, application_name: 'rms_atomic_fixture_setup' });
  await admin.connect();
  await query('CREATE SCHEMA rms_atomic_fixture');
  await query('CREATE TABLE rms_atomic_fixture.effects(id integer PRIMARY KEY,value text NOT NULL)');
});
beforeEach(async () => {
  for (const client of memory.clients) await client.end().catch(() => {});
  Object.assign(memory, { fault: '', clients: [], sentStatements: 0, sentHistory: 0, sentCommits: 0 });
  await query('TRUNCATE rms_atomic_fixture.effects, supabase_migrations.schema_migrations');
  await query('INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES ($1,$2,$3::text[])',
    ['20260101000000', 'fixture_baseline', ['SELECT 1']]);
});
afterAll(async () => {
  for (const client of memory.clients) await client.end().catch(() => {});
  if (admin) await admin.end();
  memory.input = null;
});
async function prepared(sql = `${write};`) {
  const baseline = createMigrationHistoryModel({ version: '20260101000000', name: 'fixture_baseline', sqlBytes: Buffer.from('SELECT 1;'), sourceBinding: null });
  const beforeHistory = createExpectedMigrationHistorySnapshot({ models: [baseline] });
  const source = { projectRef: project, sourceRef: 'refs/heads/main', headSha1: 'a'.repeat(40), treeSha1: 'b'.repeat(40),
    manifestSha256: 'c'.repeat(64), historySha256: beforeHistory.historySha256 };
  const bytes = Buffer.from(sql);
  const plan = await createMigrationSqlPlan({ sqlBytes: bytes, parserMajor: 17, expectedSource: source,
    observedSource: source, expectedSqlSha256: sha(bytes), wrapperApproval: null });
  const bundle = { modelSource: source, parserMajor: 17, bundleSha256: sha(bytes),
    files: [{ path: 'fixture.sql', version: '20260102000000', name: 'atomic_fixture', plan }] };
  Object.assign(memory, { bundle, bytes, plan });
  const model = createMigrationHistoryModel({ version: '20260102000000', name: 'atomic_fixture', sqlBytes: bytes, sourceBinding: { bundle, path: 'fixture.sql' } });
  const afterHistory = createExpectedMigrationHistorySnapshot({ models: [baseline, model] });
  const preState = await observedState();
  await query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  let postState;
  try { await query(write); postState = migrationStateDigests(await readPostgresMigrationState(query, coverage)); }
  finally { await query('ROLLBACK'); }
  const history = migrationHistoryPolicyRows(beforeHistory);
  const pending = [{ version: model.version, name: model.name, sqlSha256: model.sqlSha256,
    statementsSha256: model.historyStatementsSha256, statementSha256s: plan.statementSha256s,
    preHistorySha256: beforeHistory.historySha256, postHistorySha256: afterHistory.historySha256, preState, postState }];
  const request = prepareMigrationRelease({ repository: 'wrongstory/room-management-system-backend',
    policy: { expectedSource: source, observedSource: source, expectedHistory: history, observedHistory: history,
      pending, observedPending: pending, budget: { overallMs: 12000, statementMs: 3000, lockMs: 500, idleTransactionMs: 3000 } },
    // Fixture input only; no remote verifier, production approval or Full DB proof is minted.
    remote: { repository: 'wrongstory/room-management-system-backend', ...source, mergedReleasePr: 1,
      application: 'PASS', migration: 'FULL_DB_PASS', independentReview: 'PASS' },
    validationFingerprint: 'd'.repeat(64), recoveryEvidenceSha256: 'e'.repeat(64) });
  return { request, bundle, historyModels: [model], coverage: [{ version: model.version, before: coverage, after: coverage }],
    connection: { target: { scope: 'SUPABASE', mode: 'direct', projectRef: project, host: hostname, port: 5432, database: 'postgres', role: 'postgres' },
      credential: { password: memory.input.password }, caPem: memory.input.caPem } };
}
async function execute(value) {
  const factory = createAtomicMigrationSessionFactory(value);
  try { return await superviseMigrationRelease({ request: value.request, openSession: factory.openSession,
    authorize: ({ requestSha256, runId }) => ({ requestSha256, runId, issuedAtMs: Date.now(), expiresAtMs: Date.now() + 60000, action: 'APPLY_EXACT_MIGRATIONS_ONCE' }) }); }
  finally { factory.dispose(); }
}
async function expectCounts(effect, history) {
  assert.equal((await query('SELECT count(*)::text FROM rms_atomic_fixture.effects')).rows[0][0], String(effect));
  assert.equal((await query("SELECT count(*)::text FROM supabase_migrations.schema_migrations WHERE version='20260102000000'")).rows[0][0], String(history));
}
describe('actual isolated atomic PG17 writer and independent committed readback', () => {
  it('commits exact SQL and history once and verifies the real state', async () => {
    const result = await execute(await prepared());
    assert.equal(result.classification, 'APPLIED'); assert.equal(result.appliedCount, 1);
    assert.equal(memory.sentStatements, 1); assert.equal(memory.sentHistory, 1); assert.equal(memory.sentCommits, 1);
    await expectCounts(1, 1);
  });
  it.each(['history-loss', 'before-commit'])('rolls back real SQL after transport loss: %s', async fault => {
    const value = await prepared(); memory.fault = fault;
    const result = await execute(value);
    assert.equal(result.classification, 'NOT_APPLIED'); assert.equal(result.appliedCount, 0);
    assert.equal(memory.sentStatements, 1); await expectCounts(0, 0);
  });
  it('reconciles an acknowledged-server COMMIT whose response is hidden', async () => {
    const value = await prepared(); memory.fault = 'after-commit';
    const result = await execute(value);
    assert.equal(result.classification, 'APPLIED'); assert.equal(memory.sentStatements, 1); assert.equal(memory.sentCommits, 1);
    await expectCounts(1, 1);
  });
  it('rolls back a real constraint failure without recording history', async () => {
    const result = await execute(await prepared(`${write}; ${write};`));
    assert.equal(result.classification, 'NOT_APPLIED'); assert.equal(memory.sentHistory, 0); await expectCounts(0, 0);
  });
  it('keeps UNKNOWN when committed readback is unavailable; it never retries SQL', async () => {
    const value = await prepared(); memory.fault = 'readback-loss';
    const result = await execute(value);
    assert.equal(result.classification, 'UNKNOWN'); assert.equal(memory.sentStatements, 1); await expectCounts(1, 1);
  });
  it('rejects an actual untrusted TLS peer before SQL', async () => {
    const value = await prepared(); value.connection.caPem = memory.input.untrustedCaPem;
    const result = await execute(value);
    assert.notEqual(result.classification, 'APPLIED'); assert.equal(memory.sentStatements, 0); await expectCounts(0, 0);
  });
  it('respects a real held project advisory lock before SQL', async () => {
    const value = await prepared();
    const lock = BigInt.asIntN(64, BigInt(`0x${sha(Buffer.from(project)).slice(0, 16)}`)).toString();
    await query('SELECT pg_advisory_lock($1::bigint)', [lock]);
    try {
      const result = await execute(value);
      assert.notEqual(result.classification, 'APPLIED'); assert.equal(memory.sentStatements, 0); await expectCounts(0, 0);
    } finally { await query('SELECT pg_advisory_unlock($1::bigint)', [lock]); }
  });
});
