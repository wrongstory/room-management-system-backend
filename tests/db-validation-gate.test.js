import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { assertUiOnlyChange, classify, fingerprint, hasFullProof, planValidation,
  reuseApprovedUiProof, uiProof, verifyApprovedUiEvidence } from '../scripts/db-validation-gate.mjs';

const repository = 'wrongstory/room-management-system-backend';
const sha = 'a'.repeat(40);
const hash = 'b'.repeat(64);
const sourceBlobs = { '.github/workflows/quality.yml': 'workflow-blob', 'scripts/db-validation-gate.mjs': 'gate-blob' };
const pr = { number: 430, base: { ref: 'main', repo: { full_name: repository } },
  head: { ref: 'release/v0.9.3', repo: { full_name: repository } } };
const run = { id: 123, run_attempt: 1, head_sha: sha, head_repository: { full_name: repository },
  head_branch: 'release/v0.9.3',
  path: '.github/workflows/quality.yml', status: 'completed', conclusion: 'success', event: 'pull_request',
  pull_requests: [{ number: 430, base: { ref: 'main' } }] };
const job = { name: 'migration', conclusion: 'success', steps: [{ name: `Full DB proof ${hash}`, conclusion: 'success' }] };

describe('#469 bounded UI-only proof bridge', () => {
  const paths = ['tools/backend-console/src/room_management_console/ui.py',
    'tools/backend-console/tests/test_ui.py', 'scripts/db-validation-gate.mjs',
    'tests/db-validation-gate.test.js', 'supabase/migrations/example.sql', 'src/server.ts',
    'tools/backend-console/src/room_management_console/api_client.py', 'package-lock.json',
    'tools/backend-console/uv.lock', '.github/workflows/quality.yml'];
  const entry = (path, blob = 'a'.repeat(40), mode = '100644') => `${mode} blob ${blob}\t${path}`;
  const tree = paths.map(path => entry(path)).join('\0');
  it('accepts only the exact reviewed registry-only checker blob', () => {
    const path = 'scripts/check-edge-functions.mjs';
    const base = `${tree}\0${entry(path)}`;
    const approved = `${tree}\0${entry(path, '823dcc7941479afec047295482ada316dc17a053')}`;
    expect(() => assertUiOnlyChange(base, approved)).not.toThrow();
    for (const changed of [tree, `${tree}\0${entry(path, 'b'.repeat(40))}`,
      `${tree}\0${entry(path, '823dcc7941479afec047295482ada316dc17a053', '120000')}`]) {
      expect(() => assertUiOnlyChange(base, changed)).toThrow();
    }
  });
  it('allows only the four reviewed UI/policy paths plus narrative docs', () => {
    for (const path of paths.slice(0, 4)) {
      expect(() => assertUiOnlyChange(tree, tree.replace(entry(path), entry(path, 'b'.repeat(40))))).not.toThrow();
    }
    expect(() => assertUiOnlyChange(tree, tree + '\0' + entry('docs/UI.md'))).not.toThrow();
  });
  it.each(paths.slice(4))('rejects protected input mutation/addition/deletion: %s', path => {
    for (const changed of [tree.replace(entry(path), entry(path, 'b'.repeat(40))),
      tree.replace(entry(path), ''), tree + '\0' + entry(`${path}.new`)]) {
      expect(() => assertUiOnlyChange(tree, changed)).toThrow();
    }
  });
  it.each(paths.slice(0, 4))('rejects deleting UI/policy files or replacing them with symlinks: %s', path => {
    expect(() => assertUiOnlyChange(tree, tree.replace(entry(path), ''))).toThrow();
    expect(() => assertUiOnlyChange(tree, tree.replace(entry(path), entry(path, 'a'.repeat(40), '120000')))).toThrow();
  });
  const evidence = (changeRun = {}, changePr = {}, jobs) => {
    const approvedPr = { ...pr, merged_at: '2026-10-22', merge_commit_sha: uiProof.baseline,
      head: { ...pr.head, ref: 'release/v0.9.7', sha: uiProof.head }, ...changePr };
    const approvedRun = { ...run, id: uiProof.runId, head_sha: uiProof.head,
      head_branch: 'release/v0.9.7', ...changeRun };
    return vi.fn(async path => {
      if (path === 'pulls/468') return approvedPr;
      if (path === `actions/runs/${uiProof.runId}`) return approvedRun;
      if (path === `actions/runs/${uiProof.runId}/attempts/1/jobs?per_page=100`) return {
        total_count: 1, jobs: jobs ?? [{ ...job, steps: [{ name: `Full DB proof ${uiProof.hash}`, conclusion: 'success' }] }],
      };
      throw new Error('Unexpected evidence route');
    });
  };
  it('follows the original full proof, not a reuse marker', async () => {
    expect(await verifyApprovedUiEvidence({ repository, api: evidence() })).toEqual({
      mode: 'reused', full: false, hash: uiProof.hash, runId: uiProof.runId, attempt: 1,
    });
    for (const jobs of [[], [{ ...job, steps: [] }], [{ ...job, conclusion: 'failure' }]]) {
      await expect(verifyApprovedUiEvidence({ repository, api: evidence({}, {}, jobs) })).rejects.toThrow();
    }
  });
  it.each([{ conclusion: 'failure' }, { status: 'in_progress' }, { run_attempt: 2 },
    { head_sha: sha }, { head_branch: 'other' }, { event: 'push' }, { path: 'other.yml' },
    { head_repository: { full_name: 'fork/repo' } }])('rejects changed source run %j', async change => {
    await expect(verifyApprovedUiEvidence({ repository, api: evidence(change) })).rejects.toThrow();
  });
  it('rejects wrong merge, tree, repository, unavailable evidence; never falls back to a DB run', async () => {
    await expect(verifyApprovedUiEvidence({ repository, api: evidence({}, { merge_commit_sha: sha }) })).rejects.toThrow();
    await expect(verifyApprovedUiEvidence({ repository: 'fork/repo', api: evidence() })).rejects.toThrow();
    await expect(verifyApprovedUiEvidence({ repository, api: async () => { throw new Error('offline'); } })).rejects.toThrow();
    await expect(reuseApprovedUiProof({ repository, api: evidence(), baselineTree: tree, currentTree: tree })).rejects.toThrow('baseline');
    await expect(planValidation({ ...harness().input,
      event: { pull_request: { ...pr, head: { ...pr.head, ref: uiProof.branch } } },
      loadUiTrees: () => { throw new Error('changed API input'); },
    })).rejects.toThrow('changed API input');
  });
});
function harness({ runs = [run], jobs = [job], blobs = sourceBlobs, pulls, reject = false } = {}) {
  const api = vi.fn(async path => {
    if (reject) throw new Error('API unavailable');
    if (path.includes('/pulls?')) return pulls ?? [{ ...pr, merged_at: '2026-10-10', merge_commit_sha: sha }];
    if (path.includes('/runs?')) return { workflow_runs: runs };
    if (path.startsWith('contents/')) return { sha: blobs[path.slice(9).split('?')[0]] };
    if (path.includes('/jobs?')) return { jobs, total_count: jobs.length };
    throw new Error(`Unexpected route ${path}`);
  });
  return { api, input: { eventName: 'pull_request', event: { pull_request: pr }, repository, sha, hash, api,
    sourceBlobs, currentRunId: 999 } };
}

describe('#431 final-only full DB validation gate', () => {
  it('dev requires no GitHub evidence or DB rebuild and does not claim full PASS', async () => {
    const { api, input } = harness();
    const result = await planValidation({ ...input, event: { pull_request: { ...pr, base: { ...pr.base, ref: 'dev' }, head: { ...pr.head, ref: 'codex/431-ci' } } } });
    expect(result).toEqual({ mode: 'development', full: false, hash });
    expect(api).not.toHaveBeenCalled();
  });
  it('fresh release runs full suite; successful proof skips rebuild', async () => {
    expect(await planValidation(harness({ runs: [] }).input)).toMatchObject({ full: true, mode: 'full' });
    expect(await planValidation(harness().input)).toMatchObject({ full: false, mode: 'reused', runId: 123 });
  });
  it('main only verifies matching merged release proof', async () => {
    const input = { ...harness().input, eventName: 'push', event: { ref: 'refs/heads/main' } };
    expect(await planValidation(input)).toMatchObject({ mode: 'reused', full: false });
    await expect(planValidation({ ...input, api: harness({ runs: [] }).api })).rejects.toThrow('deployment blocked');
  });
  it.each(['failure', 'cancelled', 'skipped', 'timed_out', null])('rejects job or proof step %s', async conclusion => {
    expect(hasFullProof([{ ...job, conclusion }], hash)).toBe(false);
    expect(hasFullProof([{ ...job, steps: [{ ...job.steps[0], conclusion }] }], hash)).toBe(false);
    expect(await planValidation(harness({ jobs: [{ ...job, conclusion }] }).input)).toMatchObject({ full: true });
  });
  it.each([
    { conclusion: 'failure' }, { status: 'in_progress' }, { event: 'push' }, { id: 999 },
    { head_repository: { full_name: 'other/repository' } }, { head_branch: 'release/v1.0.0' },
    { pull_requests: [{ number: 431, base: { ref: 'main' } }] }, { path: 'other.yml' },
    { head_sha: 'invalid' }, { run_attempt: null },
  ])('rejects untrusted/stale run metadata %j', async change => {
    expect(await planValidation(harness({ runs: [{ ...run, ...change }] }).input)).toMatchObject({ full: true });
  });
  it('merged runs with empty PR arrays require exact commit association, not branch name alone', async () => {
    const fixture = harness({ runs: [{ ...run, pull_requests: [] }] });
    expect(await planValidation(fixture.input)).toMatchObject({ mode: 'reused' });
    expect(fixture.api).toHaveBeenCalledWith(`commits/${sha}/pulls?per_page=100`);
    expect(await planValidation({ ...fixture.input, eventName: 'push', event: { ref: 'refs/heads/main' } }))
      .toMatchObject({ mode: 'reused' });
    for (const pulls of [[], [{ ...pr, number: 432 }], [{ ...pr, head: { ...pr.head, ref: 'release/v1.0.0' } }],
      [{ ...pr, base: { ...pr.base, repo: { full_name: 'other/repo' } } }]]) {
      expect(await planValidation(harness({ runs: [{ ...run, pull_requests: [] }], pulls }).input)).toMatchObject({ full: true });
    }
  });
  it('rejects changed workflow/gate, mismatched hash, duplicate jobs and skipped proof', async () => {
    for (const file of Object.keys(sourceBlobs)) {
      expect(await planValidation(harness({ blobs: { ...sourceBlobs, [file]: 'changed' } }).input)).toMatchObject({ full: true });
    }
    expect(hasFullProof([job], 'c'.repeat(64))).toBe(false);
    expect(hasFullProof([job, job], hash)).toBe(false);
    expect(hasFullProof([{ ...job, steps: [] }], hash)).toBe(false);
  });
  it('old workflow without the new gate script is a miss, without querying its absent file', async () => {
    const fixture = harness({ blobs: { ...sourceBlobs, '.github/workflows/quality.yml': 'old-workflow' } });
    expect(await planValidation(fixture.input)).toMatchObject({ full: true });
    expect(fixture.api.mock.calls.some(([path]) => path.includes('contents/scripts/'))).toBe(false);
  });
  it('missing/ambiguous/wrong merged PR cannot authorize main', async () => {
    for (const pulls of [[], [pr], [{ ...pr, merged_at: 'yes', merge_commit_sha: 'c'.repeat(40) }],
      [1, 2].map(() => ({ ...pr, merged_at: 'yes', merge_commit_sha: sha }))]) {
      const { input } = harness({ pulls });
      await expect(planValidation({ ...input, eventName: 'push', event: { ref: 'refs/heads/main' } })).rejects.toThrow('exactly one');
    }
  });
  it('API outage fails instead of treating it as a reusable proof or cache miss', async () => {
    await expect(planValidation(harness({ reject: true }).input)).rejects.toThrow('API unavailable');
  });
  it('supports hotfix final validation, rejects unknown events/routes and cross-repo release', () => {
    expect(classify('pull_request', { pull_request: { ...pr, head: { ...pr.head, ref: 'hotfix/pin' } } }, repository).mode).toBe('release');
    for (const input of [
      ['workflow_dispatch', {}], ['push', { ref: 'refs/heads/dev' }], ['push', { ref: 'refs/heads/main', deleted: true }],
      ['pull_request', { pull_request: { ...pr, head: { ...pr.head, ref: 'dev' } } }],
      ['pull_request', { pull_request: { ...pr, head: { ...pr.head, repo: { full_name: 'fork/repo' } } } }],
      ['pull_request', { pull_request: { ...pr, base: { ...pr.base, repo: { full_name: 'other/repo' } } } }],
    ]) expect(() => classify(...input, repository)).toThrow();
  });
  it('fingerprint ignores commit/CRLF and narrative docs, includes every executable/config/data input', () => {
    const entry = (path, blob = sha, mode = '100644') => `${mode} blob ${blob}\t${path}\0`;
    const baseline = entry('supabase/migrations/first.sql');
    expect(fingerprint(baseline + entry('docs/RELEASE.md'))).toBe(fingerprint(baseline));
    expect(fingerprint(baseline + entry('README.md') + entry('AGENTS.md'))).toBe(fingerprint(baseline));
    for (const path of ['docs/migrations.json', 'src/app.ts', 'tests/gate.test.js', 'scripts/new.mjs',
      '.github/workflows/quality.yml', 'supabase/config.toml', 'package-lock.json', 'unknown/file', 'scripts/data.md']) {
      expect(fingerprint(baseline + entry(path))).not.toBe(fingerprint(baseline));
    }
    expect(fingerprint(entry('supabase/migrations/first.sql', 'c'.repeat(40)))).not.toBe(fingerprint(baseline));
    expect(fingerprint(entry('supabase/migrations/first.sql', sha, '100755'))).not.toBe(fingerprint(baseline));
    expect(() => fingerprint('')).toThrow('Empty');
  });
  it('keeps every full DB command gated, manifest unconditional, proof after successful cleanup', () => {
    const workflow = readFileSync(new URL('../.github/workflows/quality.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
    const migration = workflow.split('  migration:')[1];
    for (const command of ['db:start:ci', 'db:verify', 'db:test:template-contract', 'backup:dry-run', 'db:test',
      'db:test:static-warning', 'db:test:long-stay-clock', 'db:test:concurrency']) {
      expect(migration).toContain(`- run: npm run ${command}\n        if: steps.db_gate.outputs.full == 'true'`);
    }
    expect(migration).toContain("if: steps.db_gate.outputs.full == 'true'\n        run: npm run db:lint:baseline");
    expect(migration).toContain('- run: npm run db:manifest:verify\n      - run:');
    expect(migration.indexOf('Full DB proof')).toBeGreaterThan(migration.indexOf('run: npm run db:stop'));
    expect(migration).toContain("if: success() && steps.db_gate.outputs.full == 'true'");
    expect(workflow).not.toContain('continue-on-error');
    expect(workflow).not.toContain('pull_request_target');
  });
});
