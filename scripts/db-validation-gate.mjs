import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const workflow = '.github/workflows/quality.yml';
const gate = 'scripts/db-validation-gate.mjs';
const release = /^release\/v\d+\.\d+\.\d+$/;
const hotfix = /^hotfix\/[a-zA-Z0-9][a-zA-Z0-9/_-]*$/;
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

// Hash Git objects, not checkout bytes (CRLF), commit IDs or cached DB volumes.
// Only narrative documentation is excluded; SQL/config/manifests/fixtures/tools remain inputs.
export function fingerprint(tree) {
  const entries = tree.split('\0').filter(Boolean).filter(entry => {
    const path = entry.slice(entry.indexOf('\t') + 1);
    return !((path.startsWith('docs/') && path.endsWith('.md')) || path === 'AGENTS.md' || path === 'README.md');
  });
  if (!entries.length) throw new Error('Empty validation input');
  return createHash('sha256').update('db-validation-v1\0').update(entries.join('\0')).digest('hex');
}

export function classify(eventName, event, repository) {
  if (eventName === 'pull_request') {
    const pr = event.pull_request;
    if (pr?.base?.repo?.full_name !== repository) throw new Error('Unexpected base repository');
    if (pr.base.ref === 'dev' && !release.test(pr.head.ref)) return { mode: 'development', pr };
    if (pr.base.ref === 'main' && (release.test(pr.head.ref) || hotfix.test(pr.head.ref))
      && pr.head.repo?.full_name === repository) return { mode: 'release', pr };
    throw new Error('Unsupported PR route');
  }
  if (eventName === 'push' && event.ref === 'refs/heads/main' && !event.deleted) return { mode: 'main' };
  throw new Error('Unsupported validation event');
}

export function hasFullProof(jobs, hash) {
  const matches = jobs.filter(job => job.name === 'migration');
  return matches.length === 1 && matches[0].conclusion === 'success'
    && matches[0].steps?.some(step => step.name === `Full DB proof ${hash}` && step.conclusion === 'success');
}

// API errors are blockers, not cache misses. Never log credentials or API response bodies.
function githubApi(repository) {
  return async path => {
    try {
      return JSON.parse(execFileSync('gh', ['api', `repos/${repository}/${path}`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 8 * 1024 * 1024 }));
    } catch { throw new Error('GitHub validation evidence lookup failed'); }
  };
}

export async function findProof({ api, pr, repository, hash, currentRunId, sourceBlobs }) {
  // Bounded scan. Missing/expired history leads to a fresh release run, never main fallback PASS.
  for (let page = 1; page <= 3; page++) {
    const result = await api(`actions/workflows/quality.yml/runs?event=pull_request&branch=${encodeURIComponent(pr.head.ref)}&per_page=100&page=${page}`);
    if (!Array.isArray(result.workflow_runs)) throw new Error('Invalid workflow evidence');
    for (const run of result.workflow_runs) {
      if (String(run.id) === String(currentRunId) || run.status !== 'completed' || run.conclusion !== 'success'
        || run.event !== 'pull_request' || run.path !== workflow || run.head_repository?.full_name !== repository
        || run.head_branch !== pr.head.ref
        || !/^[a-f0-9]{40}$/.test(run.head_sha) || !Number.isSafeInteger(run.run_attempt)) continue;
      // GitHub clears workflow run pull_requests after a PR is merged. Recover the
      // association from the run's exact commit, never from branch-name equality alone.
      if (!Array.isArray(run.pull_requests)) throw new Error('Invalid run PR associations');
      let associated = run.pull_requests.some(item => item.number === pr.number && item.base?.ref === 'main');
      if (!associated && run.pull_requests.length === 0) {
        const pulls = await api(`commits/${run.head_sha}/pulls?per_page=100`);
        associated = pulls.some(item => item.number === pr.number && item.base?.ref === 'main'
          && item.base.repo?.full_name === repository && item.head.repo?.full_name === repository
          && item.head.ref === pr.head.ref);
      }
      if (!associated) continue;
      // A changed workflow/gate cannot invent a matching proof step name.
      let trusted = true;
      for (const path of [workflow, gate]) {
        const file = await api(`contents/${path}?ref=${run.head_sha}`);
        if (file.sha !== sourceBlobs[path]) { trusted = false; break; }
      }
      if (!trusted) continue;
      const result = await api(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
      if (!Array.isArray(result.jobs) || result.total_count > 100) throw new Error('Invalid job evidence');
      if (hasFullProof(result.jobs, hash)) return { runId: run.id, attempt: run.run_attempt };
    }
    if (result.workflow_runs.length < 100) break;
  }
  return null;
}

export async function planValidation({ eventName, event, repository, sha, hash, api, currentRunId, sourceBlobs }) {
  const route = classify(eventName, event, repository);
  if (route.mode === 'development') return { mode: 'development', full: false, hash };
  let pr = route.pr;
  if (route.mode === 'main') {
    const pulls = await api(`commits/${sha}/pulls?per_page=100`);
    const matches = pulls.filter(item => item.merged_at && item.merge_commit_sha === sha
      && item.base?.ref === 'main' && item.base.repo?.full_name === repository
      && item.head.repo?.full_name === repository && (release.test(item.head.ref) || hotfix.test(item.head.ref)));
    if (matches.length !== 1) throw new Error('Main must match exactly one merged release/hotfix PR');
    pr = matches[0];
  }
  const proof = await findProof({ api, pr, repository, hash, currentRunId, sourceBlobs });
  if (proof) return { mode: 'reused', full: false, hash, ...proof };
  if (route.mode === 'main') throw new Error('No matching successful release DB proof; deployment blocked');
  return { mode: 'full', full: true, hash };
}

async function main() {
  const env = process.env;
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? '') || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')) {
    throw new Error('Expected GitHub Actions repository and SHA');
  }
  if (git('rev-parse', 'HEAD').trim() !== env.GITHUB_SHA) throw new Error('Checkout does not match tested merge SHA');
  const result = await planValidation({
    eventName: env.GITHUB_EVENT_NAME,
    event: JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')),
    repository: env.GITHUB_REPOSITORY, sha: env.GITHUB_SHA, currentRunId: env.GITHUB_RUN_ID,
    hash: fingerprint(git('ls-tree', '-r', '-z', 'HEAD')),
    sourceBlobs: Object.fromEntries([workflow, gate].map(path => [path, git('rev-parse', `HEAD:${path}`).trim()])),
    api: githubApi(env.GITHUB_REPOSITORY),
  });
  appendFileSync(env.GITHUB_OUTPUT, `full=${result.full}\nfingerprint=${result.hash}\nmode=${result.mode}\n`);
  const detail = result.mode === 'development' ? 'Full DB NOT RUN: deferred to final release; manifest checks still required.'
    : result.mode === 'full' ? 'Final release full DB validation required; not yet PASS.'
    : `Full DB result reused from run ${result.runId}, attempt ${result.attempt}; no DB rebuild.`;
  appendFileSync(env.GITHUB_STEP_SUMMARY, `## DB validation gate\n${detail}\n\nInput: \`${result.hash}\`\n`);
  console.log(detail);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
