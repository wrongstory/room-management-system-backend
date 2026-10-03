import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const dockerFailure = vi.hoisted(() => ({ enabled: false, calls: [] as string[][] }));
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return {
    ...original,
    spawnSync: (command: string, args: readonly string[], options: SpawnSyncOptions) => {
      if (command === 'docker' && dockerFailure.enabled) {
        dockerFailure.calls.push([...args]);
        return { status: 1, signal: null, pid: 0, output: [], stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      return original.spawnSync(command, args, options);
    }
  };
});

const scriptPath = '../scripts/prepare-v08-recovery.mjs';
const { checkedRelativePath, checkedRecoveryDirectory, compatibleRecoveryAdapter, prepareV08Recovery, readRecoverySnapshot, recoveryAdapterPath, recoveryAssetNames, recoveryBaseCommit, replaceRecoveryManifest, validateV08Recovery, verifyRecoveryArtifact, verifyRecoveryAssets } = await import(scriptPath);
const gzipPath = '../scripts/photo-gzip.mjs';
const { canonicalPhotoGzip } = await import(gzipPath);
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const workspace = realpathSync(process.cwd());
const temporary = resolve(workspace, '.tmp');
const owned: string[] = [];
let fixture: string;
let artifact: string;
let assets: Record<string, Buffer>;
let snapshot: { entries: { path: string; bytes: Buffer; oid: string }[]; excluded: string[]; tree: string };

function ownDirectory() {
  mkdirSync(temporary, { recursive: true });
  if (lstatSync(temporary).isSymbolicLink() || realpathSync(temporary) !== temporary) throw new Error('Unsafe recovery fixture base');
  const directory = mkdtempSync(resolve(temporary, 'v08-recovery-test-'));
  owned.push(directory);
  return directory;
}

beforeAll(() => {
  fixture = ownDirectory();
  const packageRoot = new URL('../', import.meta.resolve('@imagemagick/magick-wasm'));
  assets = {
    'magick.js': readFileSync(new URL('dist/index.js', packageRoot)),
    'magick.d.ts': Buffer.concat([Buffer.from('type HTMLCanvasElement = never;\ntype CanvasRenderingContext2DSettings = never;\n'), readFileSync(new URL('dist/index.d.ts', packageRoot))]),
    'magick.NOTICE': readFileSync(new URL('NOTICE', packageRoot)),
    'magick.ts': Buffer.from('// Generated pinned @imagemagick/magick-wasm 0.0.43; license: magick.NOTICE.\n// @ts-types="./magick.d.ts"\nexport * from "./magick.js";\n'),
    'magick.wasm.gz': canonicalPhotoGzip(readFileSync(new URL('dist/x86/magick.wasm', packageRoot)))
  };
  for (const [name, bytes] of Object.entries(assets)) writeFileSync(resolve(fixture, name), bytes);
  writeFileSync(resolve(fixture, '.env'), 'synthetic-untracked-secret-must-not-be-copied');
  const prepared = prepareV08Recovery({ workspace, assetsRoot: fixture });
  artifact = prepared.artifact;
  owned.push(artifact);
  snapshot = readRecoverySnapshot(workspace);
}, 30000);

afterAll(() => {
  for (const directory of owned.reverse()) {
    if (dirname(directory) !== temporary || !basename(directory).startsWith('v08-recovery-')
      || lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== directory) throw new Error('Unsafe recovery fixture cleanup target');
    rmSync(directory, { recursive: true, force: false });
  }
});

describe('#364 old-main API recovery preparation', () => {
  it('preserves every selected old-main Git blob except the exact single session-bound adapter', () => {
    const manifest = verifyRecoveryArtifact(workspace, artifact);
    expect(manifest.baseCommit).toBe(recoveryBaseCommit);
    expect(manifest.changedPaths).toEqual([recoveryAdapterPath]);
    expect(manifest.adapterDiff).toEqual({ added: 16, deleted: 1 });
    expect(manifest.validation).toEqual({ status: 'NOT RUN', database: 'NOT RUN; no database access', deployment: 'NOT RUN' });
    const changed = snapshot.entries.filter(entry => !readFileSync(resolve(artifact, entry.path)).equals(entry.bytes)).map(entry => entry.path);
    expect(changed).toEqual([recoveryAdapterPath]);
    expect(manifest.sources).toHaveLength(snapshot.entries.length);
    expect(manifest.assets.map((entry: { path: string }) => basename(entry.path))).toEqual(recoveryAssetNames);
    for (const entry of manifest.sources) expect(entry.sha256).toBe(digest(readFileSync(resolve(artifact, entry.path))));
  });

  it('retains old PIN/crypto/runtime/router/OpenAPI/scheduler bytes and deployment template', () => {
    for (const path of ['supabase/functions/_shared/room-pin-api.ts', 'supabase/functions/_shared/room-pin-crypto.ts', 'supabase/functions/_shared/runtime.ts', 'supabase/functions/_shared/openapi.ts', 'supabase/functions/api/index.ts', 'supabase/functions/reservation-scheduler/index.ts', 'supabase/functions/deno.json', 'supabase/functions/deno.lock', 'supabase/config.toml', 'src/modules/assignments/assignment-preview-core.ts']) {
      expect(readFileSync(resolve(artifact, path))).toEqual(snapshot.entries.find(entry => entry.path === path)?.bytes);
    }
    const config = readFileSync(resolve(artifact, 'supabase/config.toml'), 'utf8');
    expect(config).toContain('[functions.api]\nverify_jwt = false\nstatic_files = ["./functions/api/assets/magick.wasm.gz", "./functions/api/assets/magick.NOTICE"]');
  });

  it('keeps the existing HTTP cancel contract and verified bearer session, without legacy RPC fallback', () => {
    const source = readFileSync(resolve(artifact, recoveryAdapterPath), 'utf8');
    const cancel = source.split('export async function cancelManualCleaningRequest(')[1]?.split('export async function processReservationTransitions(')[0] ?? '';
    expect(cancel).toContain('"cancel_manual_cleaning_request_with_session"');
    expect(cancel).toContain('p_session_id: verifiedRequestSessionId(request)');
    expect(cancel).toContain('p_expected_version: input.expectedVersion');
    expect(cancel).toContain('p_idempotency_key: idempotencyKey(request)');
    expect(cancel).toContain('return toManualCleaningRequest(data as ManualCleaningRequestRow)');
    expect(source).not.toContain('"cancel_manual_cleaning_request"');
    const runtime = readFileSync(resolve(artifact, 'supabase/functions/_shared/runtime.ts'), 'utf8');
    expect(runtime).toContain('export function verifiedRequestSessionId(request: Request): string');
    expect(runtime).toContain('sessionId(bearerToken(request))');
    const schema = readFileSync(resolve(artifact, 'supabase/functions/_shared/openapi.ts'), 'utf8');
    expect(schema).toContain('operationId: "cancelManualCleaningRequest"');
    expect(schema).toContain('/v1/reservations/cleaning-requests/{targetId}/cancel');
    for (const value of ['"VALIDATION_ERROR",\n      400', '["SESSION_REVOKED", 401, "SESSION_REVOKED"', '"PASSWORD_CHANGE_REQUIRED",\n      403']) expect(source).toContain(value);
  });

  it('rejects any extra adapter behavior, old RPC restoration, or missing session and accepts CRLF only as canonical LF', () => {
    const baseline = snapshot.entries.find(entry => entry.path === recoveryAdapterPath)?.bytes;
    const candidate = readFileSync(resolve(artifact, recoveryAdapterPath));
    expect(compatibleRecoveryAdapter(baseline, Buffer.from(candidate.toString().replace(/\n/g, '\r\n')))).toEqual(candidate);
    for (const altered of [Buffer.concat([candidate, Buffer.from('// unrelated change\n')]), Buffer.from(candidate.toString().replace('cancel_manual_cleaning_request_with_session', 'cancel_manual_cleaning_request')), Buffer.from(candidate.toString().replace('      p_session_id: verifiedRequestSessionId(request),\n', ''))]) {
      expect(() => compatibleRecoveryAdapter(baseline, altered)).toThrow('exact 16 additions / 1 deletion');
    }
  });

  it('excludes env/untracked secrets/raw WASM and fails for unexpected or tampered artifact files', () => {
    const manifest = verifyRecoveryArtifact(workspace, artifact);
    expect(manifest.excludedTrackedPaths).toContain('supabase/functions/.env.example');
    const manifestText = readFileSync(resolve(artifact, 'recovery-manifest.json'), 'utf8');
    expect(manifestText).not.toContain('synthetic-untracked-secret-must-not-be-copied');
    expect(manifest.assets.some((entry: { path: string }) => entry.path.endsWith('/magick.wasm'))).toBe(false);
    const unexpected = resolve(artifact, '.env');
    writeFileSync(unexpected, 'synthetic-untracked-secret-must-not-be-copied');
    try { expect(() => verifyRecoveryArtifact(workspace, artifact)).toThrow('unexpected files'); } finally { rmSync(unexpected); }
    const source = resolve(artifact, 'supabase/functions/_shared/room-pin-api.ts');
    const original = readFileSync(source);
    writeFileSync(source, Buffer.concat([original, Buffer.from('// tampered\n')]));
    try { expect(() => verifyRecoveryArtifact(workspace, artifact)).toThrow('source parity'); } finally { writeFileSync(source, original); }
  });

  it('requires exact pinned assets; never trusts an asset filename or a package version alone', () => {
    expect(() => verifyRecoveryAssets(assets)).not.toThrow();
    for (const name of recoveryAssetNames) {
      expect(() => verifyRecoveryAssets({ ...assets, [name]: Buffer.from('synthetic-tampering') })).toThrow();
    }
    expect(() => verifyRecoveryAssets({ ...assets, '.env': Buffer.from('synthetic') })).toThrow('five-file allowlist');
  });

  it('rejects altered manifest deployment scope, security flags, source scope, validation claims, and diff metadata', () => {
    const path = resolve(artifact, 'recovery-manifest.json');
    const original = readFileSync(path);
    const baseline = JSON.parse(original.toString());
    const altered = [
      { ...baseline, deployment: { ...baseline.deployment, function: 'reservation-scheduler' } },
      { ...baseline, deployment: { ...baseline.deployment, verifyJwt: true } },
      { ...baseline, deployment: { ...baseline.deployment, otherFunctions: 'deploy all' } },
      { ...baseline, adapterDiff: { added: 17, deleted: 1 } },
      { ...baseline, schemaVersion: 2 },
      { ...baseline, excludedTrackedPaths: [] },
      { ...baseline, validation: { ...baseline.validation, deployment: 'PASS' } }
    ];
    try {
      for (const manifest of altered) {
        writeFileSync(path, JSON.stringify(manifest));
        expect(() => verifyRecoveryArtifact(workspace, artifact)).toThrow();
      }
    } finally { writeFileSync(path, original); }
  });

  it('fails closed at the first isolated Docker rejection without a PASS manifest or subsequent stages', () => {
    const before = readFileSync(resolve(artifact, 'recovery-manifest.json'));
    dockerFailure.enabled = true;
    dockerFailure.calls = [];
    try { expect(() => validateV08Recovery(workspace, artifact)).toThrow('not ready'); }
    finally { dockerFailure.enabled = false; }
    expect(dockerFailure.calls).toHaveLength(1);
    expect(dockerFailure.calls[0]).toContain(`${artifact}:/workspace:ro`);
    expect(dockerFailure.calls[0]).toContain('fmt');
    expect(dockerFailure.calls[0]).toContain('--check');
    expect(dockerFailure.calls[0]).not.toContain('--env');
    expect(readFileSync(resolve(artifact, 'recovery-manifest.json'))).toEqual(before);
    expect(verifyRecoveryArtifact(workspace, artifact).validation.status).toBe('NOT RUN');
  });

  it('rejects CLI deployment/baseline options before creating an artifact or invoking Docker', () => {
    const before = readdirSync(temporary).sort();
    const result = spawnSync(process.execPath, ['scripts/prepare-v08-recovery.mjs', '--deploy'], { cwd: workspace, encoding: 'utf8', timeout: 5000 });
    expect(result.status).not.toBe(0);
    expect(String(result.stderr)).toContain('Only --validate is supported');
    expect(readdirSync(temporary).sort()).toEqual(before);
  });

  it('does not publish through a replaced manifest symlink or changed validation input', () => {
    const path = resolve(artifact, 'recovery-manifest.json');
    const original = readFileSync(path);
    const changed = Buffer.from(`${original.toString()} `);
    writeFileSync(path, changed);
    try { expect(() => replaceRecoveryManifest(workspace, artifact, original, {})).toThrow('changed during validation'); }
    finally { writeFileSync(path, original); }
    const outside = ownDirectory();
    const sentinel = resolve(outside, 'sentinel.json');
    writeFileSync(sentinel, 'synthetic-outside-content');
    rmSync(path);
    symlinkSync(outside, path, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      expect(() => replaceRecoveryManifest(workspace, artifact, original, {})).toThrow('symlink');
      expect(readFileSync(sentinel, 'utf8')).toBe('synthetic-outside-content');
    } finally { rmSync(path); writeFileSync(path, original, { flag: 'wx' }); }
    expect(verifyRecoveryArtifact(workspace, artifact).validation.status).toBe('NOT RUN');
  });

  it('rejects traversal, absolute destinations, foreign artifact directories, and asset symlinks', () => {
    for (const path of ['../outside', '/outside', 'C:/outside', 'a/../../outside', 'a\\outside', 'a//outside', 'a/./outside']) expect(() => checkedRelativePath(path)).toThrow('Unsafe');
    expect(() => checkedRecoveryDirectory(workspace, workspace)).toThrow('Unsafe');
    const linkDirectory = ownDirectory();
    const link = resolve(linkDirectory, 'assets');
    symlinkSync(fixture, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => prepareV08Recovery({ workspace, assetsRoot: link })).toThrow('Unsafe recovery asset root');
    rmSync(link);
  });

  it('does not contain any remote deployment, DB mutation, fake auth, or grant restoration command', () => {
    const script = readFileSync(fileURLToPath(new URL(scriptPath, import.meta.url)), 'utf8');
    for (const forbidden of ['apply_migration', 'execute_sql', 'db reset', 'functions deploy', 'auth fakeactive', 'GRANT EXECUTE']) expect(script).not.toContain(forbidden);
    expect(script).toContain('not a second implementation or a deployment command');
  });
});
