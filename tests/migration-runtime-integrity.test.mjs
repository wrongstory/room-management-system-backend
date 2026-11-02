import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => ({ changed: false, gitChanged: false, symlink: false, calls: [] }));
vi.mock('node:fs', () => ({ realpathSync: path => path, lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => memory.symlink, size: 9 }), readFileSync: () => Buffer.from(memory.changed ? 'different' : 'synthetic') }));
vi.mock('node:child_process', () => ({ execFileSync: (_program, args, options) => { memory.calls.push({ args, options }); return Buffer.from(memory.gitChanged ? 'different' : 'synthetic'); } }));
vi.mock('../scripts/lib/migration-release-preflight.mjs', () => ({ migrationReleaseConfiguration: () => ({ policy: { expectedSource: { sourceRef: 'refs/heads/main', headSha1: 'a'.repeat(40) } } }) }));
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let originalArgs;
beforeEach(() => { vi.resetModules(); Object.assign(memory, { changed: false, gitChanged: false, symlink: false, calls: [] }); originalArgs = process.execArgv; process.execArgv = []; vi.stubEnv('NODE_OPTIONS', ''); vi.stubEnv('NODE_PATH', ''); });
afterEach(() => { process.execArgv = originalArgs; vi.unstubAllEnvs(); });
const load = () => import('../scripts/lib/migration-runtime-integrity.mjs');
describe('#378 executing-source check with all files/Git replaced', () => {
  it('compares startup and current copies of every execution module with approved main blobs', async () => {
    const { verifyMigrationRuntimeIntegrity } = await load();
    expect(verifyMigrationRuntimeIntegrity({ request: {}, repositoryPath: root })).toMatchObject({ runtimeSourceVerified: true, firstPartyFileCount: 25 });
    expect(memory.calls).toHaveLength(25);
    expect(memory.calls.every(call => call.options.timeout === 3000 && call.options.windowsHide)).toBe(true);
    expect(memory.calls.some(call => call.args.at(-1).endsWith(':scripts/lib/migration-atomic-postgres.mjs'))).toBe(true);
    for (const path of ['scripts/lib/migration-baseline-metadata.mjs', 'scripts/lib/migration-baseline-review-design.mjs', 'scripts/migration-baseline-review-evidence.json']) {
      expect(memory.calls.some(call => call.args.at(-1).endsWith(`:${path}`))).toBe(true);
    }
  });
  it.each(['changed', 'gitChanged', 'symlink'])('rejects %s files without accepting a code-path claim', async key => {
    const { verifyMigrationRuntimeIntegrity } = await load(); memory[key] = true;
    expect(() => verifyMigrationRuntimeIntegrity({ request: {}, repositoryPath: root })).toThrow('MIGRATION_RUNTIME_INTEGRITY_FAILED');
  });
  it('rejects another checkout even if its Git objects match', async () => {
    const { verifyMigrationRuntimeIntegrity } = await load();
    expect(() => verifyMigrationRuntimeIntegrity({ request: {}, repositoryPath: resolve(root, '../other') })).toThrow('MIGRATION_RUNTIME_INTEGRITY_FAILED');
  });
  it.each(['NODE_OPTIONS', 'NODE_PATH'])('rejects injected loader environment %s', async name => {
    const { verifyMigrationRuntimeIntegrity } = await load(); vi.stubEnv(name, 'synthetic');
    expect(() => verifyMigrationRuntimeIntegrity({ request: {}, repositoryPath: root })).toThrow('MIGRATION_RUNTIME_INTEGRITY_FAILED');
  });
  it('rejects process flags that can replace imported modules', async () => {
    const { verifyMigrationRuntimeIntegrity } = await load(); process.execArgv = ['--import=synthetic'];
    expect(() => verifyMigrationRuntimeIntegrity({ request: {}, repositoryPath: root })).toThrow('MIGRATION_RUNTIME_INTEGRITY_FAILED');
  });
});
