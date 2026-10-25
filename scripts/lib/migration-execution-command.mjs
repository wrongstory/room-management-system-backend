/** Explicit plan/apply entry. No credentials in argv, environment or files; defaults to disabled. */
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { createAtomicMigrationSessionFactory } from './migration-atomic-postgres.mjs';
import { copyMigrationData, exactMigrationKeys } from './migration-evidence-input.mjs';
import { consumeMigrationApproval } from './migration-execution-approval.mjs';
import { migrationReleaseConfiguration } from './migration-release-preflight.mjs';
import { superviseMigrationRelease } from './migration-release-supervisor.mjs';
import { verifyMigrationRemoteRelease } from './migration-remote-release.mjs';
import { verifyMigrationRuntimeIntegrity } from './migration-runtime-integrity.mjs';
import { buildMigrationRuntimePlan, migrationRuntimeMaterial } from './migration-runtime-plan.mjs';

async function secureInput(stream) {
  if (stream.isTTY) throw new Error();
  const chunks = []; let size = 0; let timer;
  try {
    const read = (async () => {
      for await (const chunk of stream) {
        const bytes = Buffer.from(chunk); size += bytes.length;
        if (size > 196608) { bytes.fill(0); stream.destroy(); throw new Error(); }
        chunks.push(bytes);
      }
      const raw = Buffer.concat(chunks);
      try { return copyMigrationData(JSON.parse(raw.toString('utf8'))); } finally { raw.fill(0); }
    })();
    return await Promise.race([read, new Promise((_, reject) => { timer = setTimeout(() => { stream.destroy(); reject(new Error()); }, 30000); })]);
  } catch { stream.destroy(); throw new Error(); }
  finally { clearTimeout(timer); for (const chunk of chunks) chunk.fill(0); }
}
export async function runMigrationCommand(args, input = process.stdin, executionBoundary = async () => {}, credentialBoundary = async () => {}) {
  let factory;
  try {
    const mode = args[0];
    if (!['plan', 'apply'].includes(mode) || args[1] !== '--request' || !isAbsolute(args[2] ?? '')
      || mode === 'plan' && args.length !== 3 || mode === 'apply' && (args.length !== 5 || args[3] !== '--approval-id'
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(args[4]))) throw new Error();
    const path = resolve(args[2]); const info = await stat(path);
    if (!info.isFile() || info.size < 1 || info.size > 4 * 1024 * 1024) throw new Error();
    const raw = await readFile(path, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') !== info.size || Buffer.byteLength(raw, 'utf8') > 4 * 1024 * 1024) throw new Error();
    const document = copyMigrationData(JSON.parse(raw));
    exactMigrationKeys(document, ['requestInput', 'bundleInput', 'coverage', 'target']);
    const plan = await buildMigrationRuntimePlan(document);
    if (mode === 'plan') return Object.freeze({ mode: 'PLAN_ONLY', ...plan });
    verifyMigrationRuntimeIntegrity({ request: plan.request, repositoryPath: document.bundleInput.repositoryPath });
    await credentialBoundary();
    const secret = await secureInput(input);
    exactMigrationKeys(secret, ['password', 'caPem', 'githubToken']);
    const proof = await verifyMigrationRemoteRelease({ request: plan.request, repositoryPath: document.bundleInput.repositoryPath, githubToken: secret.githubToken });
    if (!proof.remoteSourceVerified || proof.requestSha256 !== plan.request.requestSha256 || document.target.scope !== 'SUPABASE'
      || document.target.projectRef !== 'aodikrxcczbogjpsjwjt' || document.target.role !== 'postgres') throw new Error();
    factory = createAtomicMigrationSessionFactory({ ...migrationRuntimeMaterial(plan), coverage: document.coverage,
      connection: { target: document.target, credential: { password: secret.password }, caPem: secret.caPem } });
    await executionBoundary({ requestSha256: plan.request.requestSha256, overallMs: migrationReleaseConfiguration(plan.request).policy.budget.overallMs });
    const result = await superviseMigrationRelease({ request: plan.request,
      authorize: context => consumeMigrationApproval({ approvalId: args[4], request: plan.request, runId: context.runId }),
      openSession: factory.openSession });
    return Object.freeze({ mode: 'APPLY_RESULT', ...result, fullDbProofRunId: proof.fullDbProofRunId });
  } catch { throw new Error('MIGRATION_EXECUTION_FAILED'); }
  finally { factory?.dispose(); }
}
