/** Bind the executing first-party module tree to the approved immutable main Git blobs. */
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrationReleaseConfiguration } from './migration-release-preflight.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const paths = ['package.json', 'package-lock.json', 'scripts/execute-production-migrations.mjs', 'scripts/migration-execution-child.mjs', 'scripts/db-validation-gate.mjs', 'scripts/migration-baseline-review-evidence.json',
  ...['atomic-postgres', 'baseline-metadata', 'baseline-review-design', 'evidence-input', 'execution-approval', 'execution-command', 'executor-policy', 'history-codec', 'postgres-state', 'process-supervisor', 'readonly-postgres',
    'release-preflight', 'release-supervisor', 'remote-release', 'runtime-integrity', 'runtime-plan', 'source-bundle', 'sql-plan', 'state-snapshot']
    .map(name => `scripts/lib/migration-${name}.mjs`)];
function current(path) {
  const absolute = resolve(root, path); const metadata = lstatSync(absolute);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > 4 * 1024 * 1024
    || realpathSync(absolute) !== absolute) throw new Error();
  const bytes = readFileSync(absolute); if (bytes.length !== metadata.size) throw new Error(); return bytes;
}
// Capture during module initialization so edits between startup and apply are rejected too.
let startup;
try { startup = new Map(paths.map(path => [path, current(path)])); } catch { startup = null; }

export function verifyMigrationRuntimeIntegrity({ request, repositoryPath }) {
  try {
    const source = migrationReleaseConfiguration(request).policy.expectedSource;
    if (!startup || !isAbsolute(repositoryPath) || realpathSync(repositoryPath) !== root || realpathSync(root) !== root
      || source.sourceRef !== 'refs/heads/main' || process.execArgv.length !== 0
      || process.env.NODE_OPTIONS || process.env.NODE_PATH) throw new Error();
    const env = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
    for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR']) if (typeof process.env[key] === 'string') env[key] = process.env[key];
    for (const path of paths) {
      const git = execFileSync('git', ['--no-replace-objects', '--no-lazy-fetch', '-C', root, 'cat-file', 'blob', `${source.headSha1}:${path}`],
        { timeout: 3000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env });
      if (!Buffer.isBuffer(git) || !git.equals(startup.get(path)) || !git.equals(current(path))) throw new Error();
    }
    return Object.freeze({ sourceSha1: source.headSha1, runtimeSourceVerified: true, firstPartyFileCount: paths.length });
  } catch { throw new Error('MIGRATION_RUNTIME_INTEGRITY_FAILED'); }
}
