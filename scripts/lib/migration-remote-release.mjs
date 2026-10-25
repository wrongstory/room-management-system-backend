/** Read-only GitHub evidence checks reuse the repository's exact full-DB proof policy. */
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fingerprint, planValidation } from '../db-validation-gate.mjs';
import { migrationReleaseConfiguration } from './migration-release-preflight.mjs';

export async function verifyMigrationRemoteRelease({ request, repositoryPath, githubToken }) {
  try {
    const configuration = migrationReleaseConfiguration(request); const source = configuration.policy.expectedSource;
    if (source.sourceRef !== 'refs/heads/main' || source.projectRef !== 'aodikrxcczbogjpsjwjt'
      || typeof githubToken !== 'string' || githubToken.length < 1 || githubToken.length > 4096) throw new Error();
    const deadline = performance.now() + 60000;
    const api = async path => {
      if (performance.now() >= deadline) throw new Error();
      const response = await fetch(`https://api.github.com/repos/${configuration.repository}/${path}`, { redirect: 'error',
        headers: { Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(Math.max(1, Math.min(5000, Math.floor(deadline - performance.now())))) });
      if (!response.ok || !response.body) throw new Error();
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > 4 * 1024 * 1024) throw new Error(); chunks.push(Buffer.from(chunk)); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    };
    const branch = await api('branches/main');
    if (branch.commit?.sha !== source.headSha1 || branch.protected !== true) throw new Error();
    const protection = await api('branches/main/protection');
    const required = [...(protection.required_status_checks?.contexts ?? []), ...(protection.required_status_checks?.checks ?? []).map(row => row.context)];
    if (!protection.enforce_admins?.enabled || !protection.required_pull_request_reviews || !protection.required_conversation_resolution?.enabled
      || !['application', 'migration'].every(name => required.includes(name))) throw new Error();
    const commit = await api(`git/commits/${source.headSha1}`);
    if (commit.sha !== source.headSha1 || commit.tree?.sha !== source.treeSha1) throw new Error();
    const pr = await api(`pulls/${configuration.remote.mergedReleasePr}`);
    if (!pr.merged_at || pr.merge_commit_sha !== source.headSha1 || pr.base?.ref !== 'main'
      || !/^release\/v\d+\.\d+\.\d+$/u.test(pr.head?.ref ?? '') || pr.base.repo?.full_name !== configuration.repository
      || pr.head.repo?.full_name !== configuration.repository) throw new Error();
    const checks = await api(`commits/${source.headSha1}/check-runs?per_page=100`);
    if (!Array.isArray(checks.check_runs) || checks.total_count > 100) throw new Error();
    for (const name of ['application', 'migration']) {
      const latest = checks.check_runs.filter(row => row.name === name && row.app?.slug === 'github-actions')
        .sort((a, b) => b.id - a.id)[0];
      if (!latest || latest.head_sha !== source.headSha1 || latest.status !== 'completed' || latest.conclusion !== 'success') throw new Error();
    }
    const env = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
    for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR']) if (typeof process.env[key] === 'string') env[key] = process.env[key];
    const git = args => execFileSync('git', ['--no-replace-objects', '--no-lazy-fetch', '-C', repositoryPath, ...args],
      { encoding: 'utf8', timeout: 3000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env });
    const actual = fingerprint(git(['ls-tree', '-r', '-z', source.headSha1]));
    if (actual !== configuration.validationFingerprint) throw new Error();
    const sourceBlobs = Object.fromEntries(['.github/workflows/quality.yml', 'scripts/db-validation-gate.mjs'].map(path => [path, git(['rev-parse', `${source.headSha1}:${path}`]).trim()]));
    const proof = await planValidation({ eventName: 'push', event: { ref: 'refs/heads/main' }, repository: configuration.repository,
      sha: source.headSha1, hash: actual, api, currentRunId: 'operational-executor', sourceBlobs });
    if (proof.mode !== 'reused' || proof.full !== false) throw new Error();
    // Repeat the mutable branch read after all evidence; source drift is never silently accepted.
    if ((await api('branches/main')).commit?.sha !== source.headSha1) throw new Error();
    return Object.freeze({ requestSha256: request.requestSha256, sourceSha1: source.headSha1, remoteSourceVerified: true,
      fullDbProofRunId: proof.runId, fullDbProofAttempt: proof.attempt });
  } catch { throw new Error('MIGRATION_REMOTE_EVIDENCE_FAILED'); }
}
