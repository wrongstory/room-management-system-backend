import { readFileSync } from 'node:fs';
import { checkServerIdentity } from 'node:tls';
import { describe, expect, it } from 'vitest';
import { ATOMIC_FIXTURE_TARGETS, atomicFixtureTarget, mapAtomicFixtureConnection } from '../scripts/fixtures/migration-readonly/atomic-fixture-targets.mjs';
import { prepareMigrationRelease } from '../scripts/lib/migration-release-preflight.mjs';
import { superviseMigrationRelease } from '../scripts/lib/migration-release-supervisor.mjs';
import { createMigrationStateSnapshot, migrationStateDigests } from '../scripts/lib/migration-state-snapshot.mjs';

const h = n => n.toString(16).padStart(64, '0');
const coverage = { serverMajor: 17, schemas: ['rms_atomic_fixture'],
  catalogKinds: ['schema', 'relation', 'column', 'constraint', 'index', 'function', 'owner', 'acl', 'rls', 'policy', 'trigger', 'type'],
  dataRelations: [], sequences: [] };
const state = migrationStateDigests(createMigrationStateSnapshot({ coverage, catalog: [], data: [], sequences: [] }));
const requestFor = (target, fingerprint = h(50)) => {
  const source = { projectRef: target.project, sourceRef: 'refs/heads/main', headSha1: 'a'.repeat(40), treeSha1: 'b'.repeat(40),
    manifestSha256: h(10), historySha256: h(11) };
  const history = [{ version: '20260101000000', name: 'fixture_baseline', statementsSha256: h(12) }];
  const pending = [{ version: '20260102000000', name: 'atomic_fixture', sqlSha256: h(13), statementsSha256: h(14),
    statementSha256s: [h(15)], preHistorySha256: h(11), postHistorySha256: h(17), preState: state, postState: state }];
  return prepareMigrationRelease({ repository: 'wrongstory/room-management-system-backend',
    policy: { expectedSource: source, observedSource: source, expectedHistory: history, observedHistory: history,
      pending, observedPending: pending, budget: { overallMs: 12000, statementMs: 3000, lockMs: 500, idleTransactionMs: 3000 } },
    remote: { repository: 'wrongstory/room-management-system-backend', ...source, mergedReleasePr: 1,
      application: 'PASS', migration: 'FULL_DB_PASS', independentReview: 'PASS' },
    validationFingerprint: fingerprint, recoveryEvidenceSha256: h(51) });
};
const authorize = ({ requestSha256, runId }) => ({ requestSha256, runId, issuedAtMs: Date.now(),
  expiresAtMs: Date.now() + 60000, action: 'APPLY_EXACT_MIGRATIONS_ONCE' });
const connectionFor = target => ({ host: target.host, port: 5432, database: 'postgres', user: 'postgres',
  application_name: 'rms_mig_synthetic', password: 'synthetic-only',
  ssl: { rejectUnauthorized: true, checkServerIdentity, ca: 'synthetic-test-ca', minVersion: 'TLSv1.2' },
  enableChannelBinding: true, query_timeout: 3000 });

describe('isolated atomic fixture case identity without DB or pg clients', () => {
  it('keeps eight independent fault cases distinct without clearing consumed-request or failed-project protection', async () => {
    expect(ATOMIC_FIXTURE_TARGETS).toHaveLength(8);
    expect(new Set(ATOMIC_FIXTURE_TARGETS.map(t => t.project)).size).toBe(8);
    expect(ATOMIC_FIXTURE_TARGETS.every(t => /^[a-z]{20}$/.test(t.project))).toBe(true);
    const requests = ATOMIC_FIXTURE_TARGETS.map(target => requestFor(target));
    expect(new Set(requests.map(request => request.requestSha256)).size).toBe(8);
    let opened = 0;
    const refuseInMemorySession = () => { opened++; throw new Error('SYNTHETIC_ADAPTER_REFUSAL'); };
    for (const [index, request] of requests.entries()) {
      const result = await superviseMigrationRelease({ request, authorize, openSession: refuseInMemorySession });
      expect(result.classification).toBe('UNKNOWN');
      expect(opened).toBe(index + 1);
      const duplicate = requestFor(ATOMIC_FIXTURE_TARGETS[index]);
      expect(duplicate).not.toBe(request);
      expect(duplicate.requestSha256).toBe(request.requestSha256);
      await expect(superviseMigrationRelease({ request: duplicate, authorize, openSession: refuseInMemorySession }))
        .rejects.toThrow('MIGRATION_SUPERVISOR_REQUEST_CONSUMED');
      const changed = requestFor(ATOMIC_FIXTURE_TARGETS[index], h(60));
      expect(changed.requestSha256).not.toBe(request.requestSha256);
      await expect(superviseMigrationRelease({ request: changed, authorize, openSession: refuseInMemorySession }))
        .rejects.toThrow('MIGRATION_SUPERVISOR_REQUEST_CONSUMED');
      expect(opened).toBe(index + 1);
    }
  });

  it('binds the certificate fixture to exactly these eight names plus the existing loopback names', () => {
    const text = readFileSync(new URL('../scripts/fixtures/migration-readonly/pg378-fixture-server.ext', import.meta.url), 'utf8');
    const lines = text.split(/\r?\n/).filter(line => line.startsWith('subjectAltName='));
    expect(lines).toHaveLength(1);
    const sans = lines[0].slice('subjectAltName='.length).split(',');
    expect(sans).toEqual(['DNS:localhost', 'IP:127.0.0.1', 'IP:::1', ...ATOMIC_FIXTURE_TARGETS.map(t => `DNS:${t.host}`)]);
    const certificate = { subjectaltname: sans.map(value => value.replace(/^IP:/, 'IP Address:')).join(', ') };
    for (const target of ATOMIC_FIXTURE_TARGETS) expect(checkServerIdentity(target.host, certificate)).toBeUndefined();
    expect(checkServerIdentity('db.zzzzzzzzzzzzzzzzzzzz.supabase.co', certificate)).toBeInstanceOf(Error);
  });

  it.each(ATOMIC_FIXTURE_TARGETS)('maps only the owned current $caseId target to loopback and preserves real TLS options', target => {
    expect(atomicFixtureTarget(target.caseId)).toBe(target);
    const config = connectionFor(target);
    const mapped = mapAtomicFixtureConnection(config, target, 56322);
    expect(mapped).toEqual({ ...config, host: '127.0.0.1', port: 56322 });
    expect(mapped.ssl).toBe(config.ssl);
    expect(config.host).toBe(target.host);
    for (const other of ATOMIC_FIXTURE_TARGETS.filter(t => t !== target)) {
      expect(() => mapAtomicFixtureConnection(connectionFor(other), target, 56322)).toThrow('FIXTURE_TRANSPORT_REJECTED');
    }
  });

  it('rejects unknown/cloned targets and malformed transport before any driver can be constructed', () => {
    const target = atomicFixtureTarget('commit');
    const config = connectionFor(target);
    expect(() => atomicFixtureTarget('unknown')).toThrow('FIXTURE_TRANSPORT_REJECTED');
    for (const foreign of [null, undefined, { ...target }, { ...target, project: 'z'.repeat(20) }]) {
      expect(() => mapAtomicFixtureConnection(config, foreign, 56322)).toThrow('FIXTURE_TRANSPORT_REJECTED');
    }
    for (const patch of [{ host: '127.0.0.1' }, { host: 'db.zzzzzzzzzzzzzzzzzzzz.supabase.co' }, { port: 6543 },
      { database: 'other' }, { user: 'other' }, { application_name: 'other' }, { application_name: 123 }]) {
      expect(() => mapAtomicFixtureConnection({ ...config, ...patch }, target, 56322)).toThrow('FIXTURE_TRANSPORT_REJECTED');
    }
    for (const port of [undefined, 0, 1024, 65536, 1.5, '56322']) {
      expect(() => mapAtomicFixtureConnection(config, target, port)).toThrow('FIXTURE_TRANSPORT_REJECTED');
    }
  });
});
