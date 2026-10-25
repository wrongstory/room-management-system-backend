import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => ({ configuration: null, replies: {}, calls: [], proof: null, fingerprint: 'a'.repeat(64), branchReads: 0, drift: false }));
vi.mock('node:child_process', () => ({ execFileSync: vi.fn((_command, args) => args.includes('ls-tree') ? 'synthetic tree' : 'b'.repeat(40)) }));
vi.mock('../scripts/lib/migration-release-preflight.mjs', () => ({ migrationReleaseConfiguration: () => memory.configuration }));
vi.mock('../scripts/db-validation-gate.mjs', () => ({ fingerprint: () => memory.fingerprint, planValidation: vi.fn(async input => { memory.proofInput = input; return memory.proof; }) }));
const { verifyMigrationRemoteRelease } = await import('../scripts/lib/migration-remote-release.mjs');
const { execFileSync } = await import('node:child_process');
const source = { projectRef: 'aodikrxcczbogjpsjwjt', sourceRef: 'refs/heads/main', headSha1: 'a'.repeat(40), treeSha1: 'b'.repeat(40) };
const request = { requestSha256: 'c'.repeat(64) };
const run = () => verifyMigrationRemoteRelease({ request, repositoryPath: 'synthetic-only', githubToken: 'synthetic-token' });
beforeEach(() => {
  memory.configuration = { policy: { expectedSource: { ...source } }, repository: 'wrongstory/room-management-system-backend', remote: { mergedReleasePr: 500 }, validationFingerprint: 'a'.repeat(64) };
  memory.proof = { mode: 'reused', full: false, runId: 123, attempt: 2 }; memory.fingerprint = 'a'.repeat(64); memory.calls = []; memory.branchReads = 0; memory.drift = false;
  memory.replies = {
    'branches/main': { commit: { sha: source.headSha1 }, protected: true },
    'branches/main/protection': { enforce_admins: { enabled: true }, required_pull_request_reviews: {}, required_conversation_resolution: { enabled: true }, required_status_checks: { contexts: ['application', 'migration'] } },
    [`git/commits/${source.headSha1}`]: { sha: source.headSha1, tree: { sha: source.treeSha1 } },
    'pulls/500': { merged_at: '2026-10-25', merge_commit_sha: source.headSha1, base: { ref: 'main', repo: { full_name: memory.configuration.repository } }, head: { ref: 'release/v1.0.0', repo: { full_name: memory.configuration.repository } } },
    [`commits/${source.headSha1}/check-runs?per_page=100`]: { total_count: 2, check_runs: ['application', 'migration'].map((name, index) => ({ name, id: index + 1, app: { slug: 'github-actions' }, head_sha: source.headSha1, status: 'completed', conclusion: 'success' })) },
  };
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    const path = url.split('/room-management-system-backend/')[1]; memory.calls.push({ path, options });
    if (path === 'branches/main' && ++memory.branchReads === 2 && memory.drift) return new Response(JSON.stringify({ commit: { sha: 'd'.repeat(40) } }));
    return new Response(JSON.stringify(memory.replies[path]));
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe('#378 remote evidence boundary with all HTTP and Git replaced', () => {
  it('requires protected main and reuses the exact full-DB proof checker, then rereads head', async () => {
    expect(await run()).toEqual({ requestSha256: request.requestSha256, sourceSha1: source.headSha1, remoteSourceVerified: true, fullDbProofRunId: 123, fullDbProofAttempt: 2 });
    expect(memory.branchReads).toBe(2); expect(memory.proofInput).toMatchObject({ eventName: 'push', sha: source.headSha1, hash: 'a'.repeat(64), sourceBlobs: { 'scripts/db-validation-gate.mjs': 'b'.repeat(40) } });
    expect(memory.calls.every(call => call.options.redirect === 'error' && call.options.signal instanceof AbortSignal)).toBe(true);
    expect(vi.mocked(execFileSync).mock.calls.every(call => call[2].windowsHide && call[2].timeout === 3000 && !JSON.stringify(call[1]).includes('synthetic-token'))).toBe(true);
  });
  it.each([
    () => { memory.configuration.policy.expectedSource.projectRef = 'matalcofimnhuzslfhdd'; },
    () => { memory.configuration.policy.expectedSource.sourceRef = 'refs/heads/dev'; },
    () => { memory.replies['branches/main'].protected = false; },
    () => { memory.replies['branches/main/protection'].enforce_admins.enabled = false; },
    () => { memory.replies['branches/main/protection'].required_status_checks.contexts = ['application']; },
    () => { memory.replies['pulls/500'].head.ref = 'dev'; },
    () => { memory.replies['pulls/500'].head.repo.full_name = 'fork/repo'; },
    () => { memory.replies[`git/commits/${source.headSha1}`].tree.sha = 'd'.repeat(40); },
    () => { memory.replies[`commits/${source.headSha1}/check-runs?per_page=100`].check_runs[1].conclusion = 'failure'; },
    () => { memory.replies[`commits/${source.headSha1}/check-runs?per_page=100`].total_count = 101; },
    () => { memory.fingerprint = 'd'.repeat(64); },
    () => { memory.proof = { mode: 'manifest', full: false }; },
    () => { memory.drift = true; },
  ])('rejects stale/incomplete evidence %#', async change => { change(); await expect(run()).rejects.toThrow('MIGRATION_REMOTE_EVIDENCE_FAILED'); });
  it('rejects a later failed retry even if an older check passed', async () => {
    memory.replies[`commits/${source.headSha1}/check-runs?per_page=100`].check_runs.push({ name: 'migration', id: 99, app: { slug: 'github-actions' }, head_sha: source.headSha1, status: 'completed', conclusion: 'failure' });
    await expect(run()).rejects.toThrow('MIGRATION_REMOTE_EVIDENCE_FAILED');
  });
  it('sanitizes network/native errors without exposing the token', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('synthetic-token')); await expect(run()).rejects.toThrow(/^MIGRATION_REMOTE_EVIDENCE_FAILED$/);
  });
});
