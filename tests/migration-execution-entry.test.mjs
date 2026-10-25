import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ document: null, sourceFailure: false, remoteFailure: false, integrityFailure: false, approvalFailure: false, connectionCount: 0, disposeCount: 0, consumed: false }));
vi.mock('node:fs/promises', () => ({ stat: async () => ({ isFile: () => true, size: Buffer.byteLength(JSON.stringify(fixture.document)) }), readFile: async () => JSON.stringify(fixture.document) }));
vi.mock('../scripts/lib/migration-runtime-integrity.mjs', () => ({ verifyMigrationRuntimeIntegrity: () => { if (fixture.integrityFailure) throw new Error('private path'); return { runtimeSourceVerified: true }; } }));
vi.mock('../scripts/lib/migration-release-preflight.mjs', () => ({ migrationReleaseConfiguration: () => ({ policy: { budget: { overallMs: 1000 } } }) }));
vi.mock('../scripts/lib/migration-runtime-plan.mjs', () => ({ buildMigrationRuntimePlan: async () => { if (fixture.sourceFailure) throw new Error('raw source secret'); return { request: { requestSha256: 'a'.repeat(64) }, bundleSha256: 'b'.repeat(64), sourceBound: true, pendingCount: 1 }; }, migrationRuntimeMaterial: plan => ({ request: plan.request, bundle: {}, historyModels: [] }) }));
vi.mock('../scripts/lib/migration-remote-release.mjs', () => ({ verifyMigrationRemoteRelease: async () => { if (fixture.remoteFailure) throw new Error('raw github token'); return { remoteSourceVerified: true, requestSha256: 'a'.repeat(64), fullDbProofRunId: 1 }; } }));
vi.mock('../scripts/lib/migration-execution-approval.mjs', () => ({ consumeMigrationApproval: async () => { if (fixture.approvalFailure || fixture.consumed) throw new Error('raw approval path'); fixture.consumed = true; return {}; } }));
vi.mock('../scripts/lib/migration-atomic-postgres.mjs', () => ({ createAtomicMigrationSessionFactory: () => ({ dispose: () => { fixture.disposeCount += 1; }, openSession: async () => { fixture.connectionCount += 1; return {}; } }) }));
vi.mock('../scripts/lib/migration-release-supervisor.mjs', () => ({ superviseMigrationRelease: async input => { await input.authorize({ runId: '10000000-0000-4000-8000-000000000001' }); await input.openSession(); return { code: 'MIGRATION_SUPERVISOR_COMPLETE', classification: 'APPLIED' }; } }));
const { runMigrationCommand } = await import('../scripts/lib/migration-execution-command.mjs');
const path = process.platform === 'win32' ? 'C:\\synthetic\\request.json' : '/synthetic/request.json';
const args = ['apply', '--request', path, '--approval-id', '10000000-0000-4000-8000-000000000001'];
function input(value = { password: 'synthetic-only', caPem: 'synthetic-ca', githubToken: 'synthetic-github' }) { const stream = new PassThrough(); stream.end(JSON.stringify(value)); return stream; }
beforeEach(() => { Object.assign(fixture, { document: { requestInput: {}, bundleInput: { repositoryPath: path }, coverage: [], target: { scope: 'SUPABASE', projectRef: 'aodikrxcczbogjpsjwjt', role: 'postgres' } }, sourceFailure: false, remoteFailure: false, integrityFailure: false, approvalFailure: false, consumed: false, connectionCount: 0, disposeCount: 0 }); });
describe('#378 explicit production entry with all effects replaced by synthetic adapters', () => {
  it.each([[], ['apply'], ['plan', '--execute'], ['apply', '--request', path], [...args, '--password', 'unsafe']])('defaults to closed for incomplete/extra arguments %#', async argv => {
    await expect(runMigrationCommand(argv, input())).rejects.toThrow('MIGRATION_EXECUTION_FAILED'); expect(fixture.connectionCount).toBe(0);
  });
  it('plans without reading credentials or calling the DB path', async () => {
    const stream = new PassThrough();
    expect(await runMigrationCommand(['plan', '--request', path], stream)).toMatchObject({ mode: 'PLAN_ONLY', pendingCount: 1 });
    expect(stream.readableFlowing).toBe(null); expect(fixture.connectionCount).toBe(0);
  });
  it.each(['sourceFailure', 'remoteFailure', 'integrityFailure', 'approvalFailure'])('rejects missing %s evidence with no connection', async key => {
    fixture[key] = true; await expect(runMigrationCommand(args, input())).rejects.toThrow('MIGRATION_EXECUTION_FAILED'); expect(fixture.connectionCount).toBe(0);
  });
  it('allows one exact approved path and disposes credential material afterward', async () => {
    const result = await runMigrationCommand(args, input()); expect(result).toMatchObject({ mode: 'APPLY_RESULT', code: 'MIGRATION_SUPERVISOR_COMPLETE' });
    expect(fixture.connectionCount).toBe(1); expect(fixture.disposeCount).toBe(1);
    await expect(runMigrationCommand(args, input())).rejects.toThrow('MIGRATION_EXECUTION_FAILED'); expect(fixture.connectionCount).toBe(1);
    expect(JSON.stringify(result)).not.toMatch(/synthetic-only|synthetic-ca|synthetic-github/);
  });
  it('cannot select the recovery project or a new role', async () => {
    fixture.document.target.projectRef = 'matalcofimnhuzslfhdd';
    await expect(runMigrationCommand(args, input())).rejects.toThrow('MIGRATION_EXECUTION_FAILED'); expect(fixture.connectionCount).toBe(0);
  });
  it('rejects credential channels beyond the fixed memory payload', async () => {
    await expect(runMigrationCommand(args, input({ password: 'synthetic', caPem: 'synthetic', githubToken: 'synthetic', connectionString: 'unsafe' }))).rejects.toThrow();
    expect(fixture.connectionCount).toBe(0);
  });
  it('destroys oversized secret input before opening any connection', async () => {
    const stream = input({ password: 'x'.repeat(200000), caPem: 'synthetic', githubToken: 'synthetic' });
    await expect(runMigrationCommand(args, stream)).rejects.toThrow('MIGRATION_EXECUTION_FAILED');
    expect(stream.destroyed).toBe(true); expect(fixture.connectionCount).toBe(0);
  });
});
