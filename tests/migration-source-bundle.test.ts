import { spawn, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, realpath: vi.fn(actual.realpath), lstat: vi.fn(actual.lstat), open: vi.fn(actual.open) };
});

type Source = { projectRef: string; sourceRef: string; headSha1: string; treeSha1: string; manifestSha256: string; historySha256: string };
type Extent = { startByte: number; endByte: number; sha256: string };
type Approval = { modelSource: Source; sqlSha256: string; begin: Extent; commit: Extent };
type LfCopy = { path: string; temporaryPath: string; modelSource: Source; gitBlobSha1: string; gitRawSha256: string; canonicalSha256: string; temporarySha256: string; normalization: string };
type Input = { repositoryPath: string; expectedSource: Source; manifestPath: string; parserMajor: number; planPaths: string[]; wrapperApprovals: { path: string; approval: Approval }[]; lfCopyApprovals: LfCopy[]; limits: { totalMs: number; gitProcessMs: number } };
type Plan = { sqlSha256: string; byteLength: number; executionAllowed: false; parserEvidenceVerified: boolean; sourceEvidenceVerified: false; sourceReviewRequired: true; statements: (Extent & { astKind: string; requiresBodyReview: boolean })[]; wrapper: { begin: Extent; commit: Extent } | null; statementsSha256: string };
type Row = { path: string; gitBlobSha1: string; gitRawSha256: string; canonicalSha256: string; gitByteLength: number; inputMode: string; plan: Plan | null };
type Bundle = { mode: string; executionAllowed: false; operationalApproval: false; DBHistoryVerified: false; fullStateVerified: false; sourceEvidenceVerified: true; sourceEvidenceScope: string; sourceReviewRequired: true; checkoutSqlVerified: false; modelSource: Source; files: Row[]; totalCount: number; plannedCount: number; bundleSha256: string };
type Api = { SOURCE_BUNDLE_MAX_TOTAL_MS: number; SOURCE_BUNDLE_MAX_GIT_MS: number; createMigrationSourceBundle(value: unknown): Promise<Bundle>; isOwnedMigrationSourceBundle(value: unknown): boolean };
const api = await import(new URL('../scripts/lib/migration-source-bundle.mjs', import.meta.url).href) as Api;
const actualChild = await vi.importActual<typeof import('node:child_process')>('node:child_process');
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const oid = (kind: string, value: Uint8Array) => createHash('sha1').update(`${kind} ${value.byteLength}\0`).update(value).digest('hex');
const clone = <T>(value: T): T => structuredClone(value);
const mutable = (value: object) => value as Record<string, unknown>;
const repositoryPath = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const firstPath = 'supabase/migrations/20261001000000_first.sql';
const secondPath = 'supabase/migrations/20261002000000_second.sql';
const manifestPath = 'supabase/migration-manifest.dev.json';
const temporaryPath = join(dirname(repositoryPath), 'approved-source-copy.sql');
const spawnMock = vi.mocked(spawn);
const realpathMock = vi.mocked(realpath);
const lstatMock = vi.mocked(lstat);
const openMock = vi.mocked(open);

class Child extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => { queueMicrotask(() => this.emit('close', null)); return true; });
}
type File = { path: string; raw: Buffer };
type Fixture = ReturnType<typeof fixture>;
type TreeRow = { mode: string; basename: string; oid: string };
function encodeTree(rows: TreeRow[]) {
  const order = (row: TreeRow) => Buffer.from(`${row.basename}${row.mode === '40000' ? '/' : '\0'}`);
  const sorted = [...rows].sort((a, b) => Buffer.compare(order(a), order(b)));
  return Buffer.concat(sorted.flatMap((row) => [Buffer.from(`${row.mode} ${row.basename}\0`, 'utf8'), Buffer.from(row.oid, 'hex')]));
}
function trees(records: string[]) {
  const entries = records.map((row) => {
    const match = /^(\d{6}) (blob|tree|commit) ([a-f0-9]{40})\t(.+)$/u.exec(row);
    if (!match) throw new Error('FIXTURE_TREE_ROW_INVALID');
    return { mode: match[1] === '040000' ? '40000' : match[1] ?? '', oid: match[3] ?? '', path: match[4] ?? '' };
  });
  const migrationRaw = encodeTree(entries.filter((row) => row.path.startsWith('supabase/migrations/')).map((row) => ({ ...row, basename: row.path.slice('supabase/migrations/'.length) })));
  const migrationOid = oid('tree', migrationRaw);
  const supabaseRaw = encodeTree(entries.filter((row) => row.path.startsWith('supabase/') && !row.path.startsWith('supabase/migrations/')).map((row) => ({ ...row,
    oid: row.path === 'supabase/migrations' && row.mode === '40000' ? migrationOid : row.oid,
    basename: row.path.slice('supabase/'.length) })));
  const supabaseOid = oid('tree', supabaseRaw);
  const rootRaw = encodeTree(entries.filter((row) => row.path === 'supabase').map((row) => ({ ...row,
    oid: row.mode === '40000' ? supabaseOid : row.oid, basename: row.path })));
  const rootOid = oid('tree', rootRaw);
  return { rootRaw, rootOid, supabaseRaw, supabaseOid, migrationRaw, migrationOid,
    objects: new Map([[rootOid, rootRaw], [supabaseOid, supabaseRaw], [migrationOid, migrationRaw]]) };
}
function fixture(files: File[] = [{ path: firstPath, raw: Buffer.from('SELECT 1;\n') }, { path: secondPath, raw: Buffer.from("-- 한글\r\nSELECT '가;나';\r\nSELECT $$끝;문장$$;\r\n") }]) {
  const blobs = new Map<string, Buffer>();
  const names = files.map((file) => /^supabase\/migrations\/\d{14}_([a-z0-9_]+)\.sql$/u.exec(file.path)?.[1] ?? 'invalid');
  const manifest = { schemaVersion: 1, release: 'dev', hashAlgorithm: 'sha256-lf-utf8', totalCount: files.length,
    baseline: { count: 1, head: names[0] }, pending: { count: files.length - 1, first: names[1] ?? null, head: files.length === 1 ? null : names.at(-1) },
    head: names.at(-1), migrations: files.map((file, index) => ({ order: index + 1, name: names[index], sha256: sha(file.raw.toString('utf8').replaceAll('\r\n', '\n')) })) };
  const rawManifest = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestOid = oid('blob', rawManifest); blobs.set(manifestOid, rawManifest);
  const fileRows = files.map((file) => { const fileOid = oid('blob', file.raw); blobs.set(fileOid, file.raw); return { ...file, oid: fileOid }; });
  const records = [`040000 tree ${'a'.repeat(40)}\tsupabase`, `040000 tree ${'b'.repeat(40)}\tsupabase/migrations`,
    `100644 blob ${manifestOid}\t${manifestPath}`, ...fileRows.map((file) => `100644 blob ${file.oid}\t${file.path}`)];
  const binaryTrees = trees(records);
  const modelSource: Source = { projectRef: 'abcdefghijklmnopqrst', sourceRef: 'refs/heads/main', headSha1: 'c'.repeat(40),
    treeSha1: binaryTrees.rootOid, manifestSha256: sha(rawManifest), historySha256: 'd'.repeat(64) };
  const input: Input = { repositoryPath, expectedSource: modelSource, manifestPath, parserMajor: 15,
    planPaths: [files.at(-1)?.path ?? secondPath], wrapperApprovals: [], lfCopyApprovals: [], limits: { totalMs: 120000, gitProcessMs: 1000 } };
  return { input, files: fileRows, manifest, rawManifest, binaryTrees, blobs, records, headReads: 0, children: [] as Child[], commands: [] as string[][] };
}
type Override = (args: string[], value: Fixture) => Buffer | 'HANG' | 'ERROR' | undefined;
function useGit(value: Fixture, override?: Override) {
  value.binaryTrees = trees(value.records); value.input.expectedSource.treeSha1 = value.binaryTrees.rootOid;
  spawnMock.mockImplementation(((command: string, args: string[], options: SpawnOptions) => {
    expect(command).toBe('git'); expect(options.shell).toBe(false); expect(options.windowsHide).toBe(true);
    const start = args.indexOf(value.input.repositoryPath) + 1; const operation = args.slice(start);
    expect(args).toContain('--no-lazy-fetch');
    expect(start).toBeGreaterThan(0); value.commands.push(operation);
    const child = new Child(); value.children.push(child);
    queueMicrotask(() => {
      const changed = override?.(operation, value);
      if (changed === 'HANG') return;
      if (changed === 'ERROR') { child.stderr.end('native detail includes private path and SQL'); child.emit('error', new Error('native untrusted detail')); return; }
      let result = changed;
      if (!result) {
        if (operation[0] === 'rev-parse' && operation[1] === '--show-toplevel') result = Buffer.from(`${repositoryPath}\n`);
        else if (operation[0] === 'rev-parse' && operation[1] === '--show-object-format') result = Buffer.from('sha1\n');
        else if (operation[0] === 'rev-parse' && operation.at(-1) === 'HEAD^{tree}') result = Buffer.from(`${value.input.expectedSource.treeSha1}\n`);
        else if (operation[0] === 'rev-parse') { value.headReads++; result = Buffer.from(`${value.input.expectedSource.headSha1}\n`); }
        else if (operation[0] === 'cat-file' && operation[1] === 'tree') result = value.binaryTrees.objects.get(operation[2] ?? '');
        else if (operation[0] === 'cat-file') result = value.blobs.get(operation[2] ?? '');
      }
      if (!result) { child.emit('close', 1); return; }
      child.stdout.end(result); child.stderr.end(); child.emit('close', 0);
    });
    return child;
  }) as unknown as typeof spawn);
}
function replaceManifest(value: Fixture, raw: Buffer) {
  const newOid = oid('blob', raw); value.blobs.set(newOid, raw);
  value.records[2] = `100644 blob ${newOid}\t${manifestPath}`;
  value.input.expectedSource.manifestSha256 = sha(raw);
}
function withLf(value: Fixture) {
  const file = value.files.at(-1); if (!file) throw new Error('FIXTURE_EMPTY');
  const canonical = Buffer.from(file.raw.toString('utf8').replaceAll('\r\n', '\n'));
  value.input.lfCopyApprovals = [{ path: file.path, temporaryPath, modelSource: clone(value.input.expectedSource),
    gitBlobSha1: file.oid, gitRawSha256: sha(file.raw), canonicalSha256: sha(canonical), temporarySha256: sha(canonical), normalization: 'CRLF_TO_LF_EXACT' }];
  const stat = { isFile: () => true, isSymbolicLink: () => false, size: canonical.length, dev: 1, ino: 2, mtimeMs: 3, ctimeMs: 4 };
  realpathMock.mockImplementation(async (path) => String(path));
  lstatMock.mockResolvedValue(stat as Awaited<ReturnType<typeof lstat>>);
  const close = vi.fn(async () => {});
  const read = vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
    canonical.copy(buffer, offset, position, position + length); return { bytesRead: length, buffer };
  });
  openMock.mockResolvedValue({ stat: async () => stat, read, close } as unknown as Awaited<ReturnType<typeof open>>);
  return { canonical, stat, read, close };
}

beforeEach(() => { vi.clearAllMocks(); realpathMock.mockImplementation(actualFs.realpath); lstatMock.mockImplementation(actualFs.lstat); openMock.mockImplementation(actualFs.open); });
afterEach(() => { spawnMock.mockImplementation(actualChild.spawn); vi.useRealTimers(); });

describe('#378 immutable local source bundle (synthetic Git driver, actual parser)', () => {
  it.each([15, 17])('binds exact blob, manifest, AST bytes and source without execution in PG%i', async (major) => {
    const value = fixture(); value.input.parserMajor = major; useGit(value);
    const bundle = await api.createMigrationSourceBundle(value.input);
    expect(bundle).toMatchObject({ mode: 'LOCAL_GIT_SOURCE_ONLY', executionAllowed: false, operationalApproval: false,
      DBHistoryVerified: false, fullStateVerified: false, sourceEvidenceVerified: true,
      sourceEvidenceScope: 'LOCAL_GIT_OBJECT_MATCH_ONLY', sourceReviewRequired: true, checkoutSqlVerified: false,
      remoteSourceVerified: false, historyHashIsCallerClaim: true, projectIdentityIsCallerClaim: true, totalCount: 2, plannedCount: 1 });
    const row = bundle.files[1]; const file = value.files[1]; if (!row || !file) throw new Error('FIXTURE_EMPTY');
    expect(row.gitRawSha256).toBe(sha(file.raw)); expect(row.gitBlobSha1).toBe(oid('blob', file.raw));
    expect(row.canonicalSha256).not.toBe(row.gitRawSha256); expect(row.inputMode).toBe('RAW_GIT_BLOB');
    expect(row.plan).toMatchObject({ parserEvidenceVerified: true, sourceEvidenceVerified: false, sourceReviewRequired: true,
      executionAllowed: false, sqlSha256: sha(file.raw), byteLength: file.raw.length });
    expect(row.plan?.statements).toHaveLength(2);
    for (const statement of row.plan?.statements ?? []) expect(statement.sha256).toBe(sha(file.raw.subarray(statement.startByte, statement.endByte)));
    expect(value.commands.filter((args) => args.at(-1) === 'HEAD^{commit}')).toHaveLength(2);
    expect(value.commands.filter((args) => args[0] === 'cat-file' && args[1] === 'tree').map((args) => args[2]))
      .toEqual([value.binaryTrees.rootOid, value.binaryTrees.supabaseOid, value.binaryTrees.migrationOid]);
    expect(value.commands.some((args) => args[0] === 'ls-tree')).toBe(false);
    expect(api.isOwnedMigrationSourceBundle(bundle)).toBe(true);
    expect(api.isOwnedMigrationSourceBundle(clone(bundle))).toBe(false); expect(api.isOwnedMigrationSourceBundle({ ...bundle, executionAllowed: true })).toBe(false);
    expect(Object.isFrozen(bundle)).toBe(true); expect(Object.isFrozen(bundle.files)).toBe(true); expect(Object.isFrozen(row)).toBe(true);
    expect(Object.isFrozen(bundle.modelSource)).toBe(true); expect(Object.isFrozen(row.plan?.statements)).toBe(true);
    expect(() => { mutable(bundle).executionAllowed = true; }).toThrow();
    expect(JSON.stringify(bundle)).not.toMatch(/SELECT|가;나|끝;문장|sqlBytes|rawSql|approved-source-copy/u);
  });

  it('does not accept caller VERIFIED flags, parser handles, SQL buffers or metadata injection', async () => {
    const value = fixture(); useGit(value);
    for (const extra of [{ sourceEvidenceVerified: 'VERIFIED' }, { parserPlan: {} }, { sqlBytes: Buffer.from('SELECT 9') }, { executionAllowed: true }]) {
      await expect(api.createMigrationSourceBundle({ ...value.input, ...extra })).rejects.toThrow('SOURCE_BUNDLE_INPUT_INVALID');
    }
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.each(['planPaths', 'wrapperApprovals', 'lfCopyApprovals'] as const)('copies %s before asynchronous reads', async (key) => {
    const value = fixture(); useGit(value); const task = api.createMigrationSourceBundle(value.input);
    value.input[key].length = 0; value.input.expectedSource.headSha1 = 'f'.repeat(40);
    // Git fixture must retain the immutable expected source used by the mock process.
    value.input = { ...value.input, expectedSource: { ...value.input.expectedSource, headSha1: 'c'.repeat(40) } };
    const bundle = await task; expect(bundle.plannedCount).toBe(1); expect(bundle.modelSource.headSha1).toBe('c'.repeat(40));
  });

  it.each(['../supabase/migrations/20261002000000_second.sql', 'supabase/migrations/../second.sql', '/absolute.sql', 'supabase\\migrations\\20261002000000_second.sql', 'supabase/migrations/20261002000000_Second.sql', 'supabase/migrations/20261002000000_second.sql\0'])('rejects unsafe plan path %s', async (path) => {
    const value = fixture(); value.input.planPaths = [path]; useGit(value);
    await expect(api.createMigrationSourceBundle(value.input)).rejects.toThrow('SOURCE_BUNDLE_PATH_INVALID'); expect(spawnMock).not.toHaveBeenCalled();
  });

  it.each(['refs/heads/dev', 'refs/heads/codex/378-finite-migration-executor', 'refs/heads/main --upload-pack=x', 'refs/tags/v0.9.0'])('rejects unsupported ref %s before launching Git', async (ref) => {
    const value = fixture(); value.input.expectedSource.sourceRef = ref; useGit(value);
    await expect(api.createMigrationSourceBundle(value.input)).rejects.toThrow('SOURCE_BUNDLE_INPUT_INVALID'); expect(spawnMock).not.toHaveBeenCalled();
  });

  it.each([0, -1, Infinity, 120001, 0.5])('rejects unbounded/invalid total budget %s', async (totalMs) => {
    const value = fixture(); value.input.limits.totalMs = totalMs; useGit(value);
    await expect(api.createMigrationSourceBundle(value.input)).rejects.toThrow('SOURCE_BUNDLE_LIMIT_INVALID');
  });
  it.each([0, -1, Infinity, 10001, 0.5])('rejects unbounded/invalid subprocess budget %s', async (gitProcessMs) => {
    const value = fixture(); value.input.limits.gitProcessMs = gitProcessMs; useGit(value);
    await expect(api.createMigrationSourceBundle(value.input)).rejects.toThrow('SOURCE_BUNDLE_LIMIT_INVALID');
  });

  it.each(['head', 'ref', 'tree', 'end-head', 'end-ref', 'end-tree'])('rejects %s mismatch or drift', async (kind) => {
    const value = fixture(); let observations = 0;
    useGit(value, (args) => {
      if (args[1] === '--show-object-format') observations++;
      const match = kind.includes('tree') ? args.at(-1) === 'HEAD^{tree}' : kind.includes('ref') ? args.at(-1) === 'refs/heads/main^{commit}' : args.at(-1) === 'HEAD^{commit}';
      if (match && (!kind.startsWith('end-') || observations === 2)) return Buffer.from(`${'e'.repeat(40)}\n`);
      return undefined;
    });
    await expect(api.createMigrationSourceBundle(value.input)).rejects.toThrow('SOURCE_BUNDLE_SOURCE_DRIFT');
  });

  it.each(['160000 commit', '120000 blob', '100755 blob', '040000 tree'])('rejects migration mode/type %s', async (mode) => {
    const value = fixture(); value.records[4] = `${mode} ${value.files[1]?.oid}\t${secondPath}`; useGit(value);
    await expect(api.createMigrationSourceBundle(value.input)).rejects.toThrow('SOURCE_BUNDLE_TREE_UNSAFE');
  });
  it.each(['supabase', 'supabase/migrations'])('rejects symlink/submodule ancestor %s', async (path) => {
    const value = fixture(); value.records[value.records.findIndex((row) => row.endsWith(`\t${path}`))] = `120000 blob ${'a'.repeat(40)}\t${path}`; useGit(value);
    await expect(api.createMigrationSourceBundle(value.input)).rejects.toThrow('SOURCE_BUNDLE_TREE_UNSAFE');
  });

  it.each(['supabase', 'migrations'])('rejects corrupted %s raw subtree even when all blob/manifest hashes stay unchanged', async (kind) => {
    const value = fixture();
    useGit(value, (args) => {
      const target = kind === 'supabase' ? value.binaryTrees.supabaseOid : value.binaryTrees.migrationOid;
      if (args[0] !== 'cat-file' || args[1] !== 'tree' || args[2] !== target) return undefined;
      const original = value.binaryTrees.objects.get(target); if (!original) throw new Error('FIXTURE_EMPTY');
      const corrupted = Buffer.from(original); corrupted[0] = (original[0] ?? 0) ^ 128; return corrupted;
    });
    await expect(api.createMigrationSourceBundle(value.input)).rejects.toThrow('SOURCE_BUNDLE_TREE_HASH_MISMATCH');
  });

  it('rejects raw root→supabase OID mismatch instead of trusting independently valid child bodies', async () => {
    const value = fixture(); const wrongOid = 'f'.repeat(40);
    useGit(value, (args) => args[0] === 'cat-file' && args[1] === 'tree' && args[2] === wrongOid ? value.binaryTrees.supabaseRaw : undefined);
    const root = encodeTree([{ mode: '40000', basename: 'supabase', oid: wrongOid }]);
    const rootOid = oid('tree', root); value.input.expectedSource.treeSha1 = rootOid; value.binaryTrees.objects.set(rootOid, root);
    await expect(api.createMigrationSourceBundle(value.input)).rejects.toThrow('SOURCE_BUNDLE_TREE_HASH_MISMATCH');
  });

  it('rejects migration timestamp/path tampering below an unchanged parent tree link', async () => {
    const value = fixture();
    useGit(value, (args) => args[0] === 'cat-file' && args[1] === 'tree' && args[2] === value.binaryTrees.migrationOid
      ? Buffer.from(value.binaryTrees.migrationRaw.toString('latin1').replace('20261002000000_second.sql', '20261003000000_second.sql'), 'latin1') : undefined);
    await expect(api.createMigrationSourceBundle(value.input)).rejects.toThrow('SOURCE_BUNDLE_TREE_HASH_MISMATCH');
  });

  it.each(['truncated-oid', 'fake-text', 'wrong-mode-bytes', 'slash-basename', 'duplicate-name'])('rejects invalid raw Git tree framing %s', async (kind) => {
    const value = fixture(); useGit(value);
    let raw = value.binaryTrees.rootRaw;
    if (kind === 'truncated-oid') raw = raw.subarray(0, -1);
    if (kind === 'fake-text') raw = Buffer.from('not Git tree framing');
    if (kind === 'wrong-mode-bytes') { raw = Buffer.from(raw); raw[0] = 180; }
    if (kind === 'slash-basename') raw = encodeTree([{ mode: '40000', basename: 'supabase/evil', oid: value.binaryTrees.supabaseOid }]);
    if (kind === 'duplicate-name') raw = encodeTree([{ mode: '40000', basename: 'supabase', oid: value.binaryTrees.supabaseOid }, { mode: '40000', basename: 'supabase', oid: value.binaryTrees.supabaseOid }]);
    const rootOid = oid('tree', raw); value.input.expectedSource.treeSha1 = rootOid; value.binaryTrees.objects.set(rootOid, raw);
    await expect(api.createMigrationSourceBundle(value.input)).rejects.toThrow(kind === 'duplicate-name' ? 'SOURCE_BUNDLE_DUPLICATE' : kind === 'slash-basename' ? 'SOURCE_BUNDLE_PATH_INVALID' : 'SOURCE_BUNDLE_TREE_INVALID');
  });

  it.each(['subdirectory', 'alias-root', 'symlink-root', 'end-root'])('rejects Git top-level %s before using an outside-root LF claim', async (kind) => {
    const value = fixture(); let observations = 0;
    if (kind === 'subdirectory') value.input.repositoryPath = join(repositoryPath, 'scripts');
    if (kind === 'symlink-root') realpathMock.mockImplementation(async (path) => String(path) === repositoryPath ? `${repositoryPath}.redirected` : String(path));
    useGit(value, (args) => {
      if (args[1] !== '--show-toplevel') return undefined;
      observations++;
      if (kind === 'alias-root' || kind === 'end-root' && observations === 2) return Buffer.from(`${join(repositoryPath, '..', 'alias-repository')}\n`);
      return undefined;
    });
    await expect(api.createMigrationSourceBundle(value.input)).rejects.toThrow('SOURCE_BUNDLE_REPOSITORY_UNSAFE');
    if (kind !== 'end-root') expect(value.commands.some((args) => args[0] === 'cat-file')).toBe(false);
  });

  it('parses exact LF or CRLF Git line terminators without trimming path/body data', async () => {
    const value = fixture(); useGit(value, (args) => {
      if (args[0] !== 'rev-parse') return undefined;
      if (args[1] === '--show-toplevel') return Buffer.from(`${repositoryPath}\r\n`);
      if (args[1] === '--show-object-format') return Buffer.from('sha1\r\n');
      return Buffer.from(`${args.at(-1) === 'HEAD^{tree}' ? value.input.expectedSource.treeSha1 : value.input.expectedSource.headSha1}\r\n`);
    });
    const bundle = await api.createMigrationSourceBundle(value.input); expect(bundle.executionAllowed).toBe(false);
  });

  it.each(['missing-lf', 'extra-line', 'embedded-cr'])('rejects ambiguous Git top-level line %s', async (kind) => {
    const value = fixture(); useGit(value, (args) => args[1] === '--show-toplevel'
      ? Buffer.from(kind === 'missing-lf' ? repositoryPath : kind === 'extra-line' ? `${repositoryPath}\nextra\n` : `${repositoryPath}\rwrong\n`) : undefined);
    await expect(api.createMigrationSourceBundle(value.input)).rejects.toThrow('SOURCE_BUNDLE_GIT_OUTPUT_INVALID');
  });

  it.each(['missing', 'extra', 'duplicate', 'nested', 'same-version', 'name-mismatch'])('rejects %s file-set mismatch', async (kind) => {
    const value = fixture();
    if (kind === 'missing') value.records.pop();
    if (kind === 'extra') value.records.push(`100644 blob ${value.files[1]?.oid}\tsupabase/migrations/20261003000000_extra.sql`);
    if (kind === 'duplicate') value.records.push(value.records[4] ?? '');
    if (kind === 'nested') value.records[4] = `100644 blob ${value.files[1]?.oid}\tsupabase/migrations/nested/20261002000000_second.sql`;
    if (kind === 'same-version') value.records[4] = `100644 blob ${value.files[1]?.oid}\tsupabase/migrations/20261001000000_second.sql`;
    if (kind === 'name-mismatch') value.records[4] = `100644 blob ${value.files[1]?.oid}\tsupabase/migrations/20261002000000_other.sql`;
    useGit(value);
    await expect(api.createMigrationSourceBundle(value.input)).rejects.toThrow(kind === 'duplicate' ? 'SOURCE_BUNDLE_DUPLICATE' : kind === 'nested' ? 'SOURCE_BUNDLE_PATH_INVALID' : 'SOURCE_BUNDLE_FILE_SET_MISMATCH');
  });

  it.each(['tree-hash', 'manifest-hash', 'blob-hash', 'canonical-hash'])('rejects %s without trusting Git caller claims', async (kind) => {
    const value = fixture();
    if (kind === 'manifest-hash') value.input.expectedSource.manifestSha256 = 'f'.repeat(64);
    if (kind === 'canonical-hash') { value.manifest.migrations[1] = { order: 2, name: 'second', sha256: 'e'.repeat(64) }; replaceManifest(value, Buffer.from(`${JSON.stringify(value.manifest, null, 2)}\n`)); }
    useGit(value, (args) => kind === 'tree-hash' && args[1] === 'tree' ? Buffer.from('wrong tree') : kind === 'blob-hash' && args[2] === value.files[1]?.oid ? Buffer.from('SELECT 9;') : undefined);
    await expect(api.createMigrationSourceBundle(value.input)).rejects.toThrow(`SOURCE_BUNDLE_${kind.toUpperCase().replace('-', '_')}_MISMATCH`);
  });

  it.each(['duplicate-name', 'wrong-order', 'extra-key', 'duplicate-json-key', 'count', 'baseline', 'pending', 'algorithm', 'noncanonical-json'])('rejects invalid manifest %s', async (kind) => {
    const value = fixture(); let raw: Buffer;
    if (kind === 'duplicate-name') value.manifest.migrations[1] = { ...value.manifest.migrations[1], order: 2, name: 'first', sha256: 'e'.repeat(64) };
    if (kind === 'wrong-order') value.manifest.migrations[1] = { order: 1, name: 'second', sha256: 'e'.repeat(64) };
    if (kind === 'extra-key') mutable(value.manifest).VERIFIED = true;
    if (kind === 'count') value.manifest.totalCount = 3;
    if (kind === 'baseline') value.manifest.baseline.head = 'wrong';
    if (kind === 'pending') value.manifest.pending.first = 'wrong';
    if (kind === 'algorithm') value.manifest.hashAlgorithm = 'sha256';
    raw = Buffer.from(`${JSON.stringify(value.manifest, null, 2)}\n`);
    if (kind === 'duplicate-json-key') raw = Buffer.from(raw.toString('utf8').replace('"schemaVersion": 1,', '"schemaVersion": 1,\n  "schemaVersion": 1,'));
    if (kind === 'noncanonical-json') raw = Buffer.from(JSON.stringify(value.manifest));
    replaceManifest(value, raw); useGit(value);
    await expect(api.createMigrationSourceBundle(value.input)).rejects.toThrow(kind === 'duplicate-name' ? 'SOURCE_BUNDLE_DUPLICATE' : kind === 'extra-key' ? 'SOURCE_BUNDLE_INPUT_INVALID' : 'SOURCE_BUNDLE_MANIFEST_INVALID');
  });

  it.each(['duplicate', 'missing', 'order'])('rejects selected plan %s', async (kind) => {
    const value = fixture();
    value.input.planPaths = kind === 'duplicate' ? [secondPath, secondPath] : kind === 'missing' ? ['supabase/migrations/20261003000000_absent.sql'] : [secondPath, firstPath];
    useGit(value);
    await expect(api.createMigrationSourceBundle(value.input)).rejects.toThrow(kind === 'duplicate' ? 'SOURCE_BUNDLE_DUPLICATE' : kind === 'missing' ? 'SOURCE_BUNDLE_PLAN_MISSING' : 'SOURCE_BUNDLE_PLAN_ORDER_MISMATCH');
  });

  it('accepts exact explicit LF copy but never implicitly normalizes plan bytes', async () => {
    const value = fixture(); const copy = withLf(value); useGit(value);
    const bundle = await api.createMigrationSourceBundle(value.input); const row = bundle.files[1];
    expect(row?.inputMode).toBe('APPROVED_EXACT_LF_COPY'); expect(row?.plan?.sqlSha256).toBe(sha(copy.canonical));
    expect(row?.gitRawSha256).not.toBe(row?.plan?.sqlSha256); expect(copy.close).toHaveBeenCalledOnce();
    expect(bundle.operationalApproval).toBe(false); expect(JSON.stringify(bundle)).not.toContain(temporaryPath);
  });

  it.each(['raw-hash', 'canonical-hash', 'temp-hash', 'blob', 'model-source', 'normalization', 'inside-repository', 'redirect', 'symlink', 'changed-read', 'changed-stat'])('rejects LF mapping %s', async (kind) => {
    const value = fixture(); const copy = withLf(value); const mapping = value.input.lfCopyApprovals[0]; if (!mapping) throw new Error('FIXTURE_EMPTY');
    if (kind === 'raw-hash') mapping.gitRawSha256 = 'e'.repeat(64);
    if (kind === 'canonical-hash') mapping.canonicalSha256 = 'e'.repeat(64);
    if (kind === 'temp-hash') mapping.temporarySha256 = 'e'.repeat(64);
    if (kind === 'blob') mapping.gitBlobSha1 = 'e'.repeat(40);
    if (kind === 'model-source') mapping.modelSource.treeSha1 = 'e'.repeat(40);
    if (kind === 'normalization') mapping.normalization = 'AUTO_NORMALIZE';
    if (kind === 'inside-repository') mapping.temporaryPath = join(repositoryPath, 'inside.sql');
    if (kind === 'redirect') realpathMock.mockImplementation(async (path) => String(path) === temporaryPath ? `${temporaryPath}.other` : String(path));
    if (kind === 'symlink') lstatMock.mockResolvedValue({ ...copy.stat, isSymbolicLink: () => true } as Awaited<ReturnType<typeof lstat>>);
    if (kind === 'changed-read') copy.read.mockImplementationOnce(async (buffer: Buffer) => { buffer.fill(32); return { bytesRead: buffer.length, buffer }; });
    if (kind === 'changed-stat') lstatMock.mockResolvedValueOnce(copy.stat as Awaited<ReturnType<typeof lstat>>).mockResolvedValueOnce({ ...copy.stat, ino: 3 } as Awaited<ReturnType<typeof lstat>>);
    useGit(value);
    await expect(api.createMigrationSourceBundle(value.input)).rejects.toThrow(kind === 'model-source' || kind === 'normalization' ? 'SOURCE_BUNDLE_APPROVAL_MISMATCH'
      : ['inside-repository', 'redirect', 'symlink'].includes(kind) ? 'SOURCE_BUNDLE_TEMP_PATH_UNSAFE'
      : ['changed-read', 'changed-stat'].includes(kind) ? 'SOURCE_BUNDLE_TEMP_DRIFT' : 'SOURCE_BUNDLE_LF_MAPPING_MISMATCH');
    if (kind === 'changed-read' || kind === 'changed-stat') expect(copy.close).toHaveBeenCalledOnce();
  });

  it('combines owned parser wrapper extents without stripping the original outer pair', async () => {
    const raw = Buffer.from("BEGIN;\nSELECT '한글;문자';\nCOMMIT;\n");
    const value = fixture([{ path: firstPath, raw: Buffer.from('SELECT 1;\n') }, { path: secondPath, raw }]);
    const begin: Extent = { startByte: 0, endByte: 5, sha256: sha(raw.subarray(0, 5)) };
    const startByte = raw.indexOf(Buffer.from('COMMIT')) - 1; const endByte = raw.lastIndexOf(59);
    const commit = { startByte, endByte, sha256: sha(raw.subarray(startByte, endByte)) };
    value.input.wrapperApprovals = [{ path: secondPath, approval: { modelSource: clone(value.input.expectedSource), sqlSha256: sha(raw), begin, commit } }];
    useGit(value); const bundle = await api.createMigrationSourceBundle(value.input);
    expect(bundle.files[1]?.plan?.wrapper).toMatchObject({ begin, commit }); expect(bundle.files[1]?.plan?.statements).toHaveLength(3);
    expect(bundle.files[1]?.plan?.sqlSha256).toBe(sha(raw)); expect(bundle.executionAllowed).toBe(false);
  });

  it.each(['VACUUM;', 'DROP INDEX CONCURRENTLY idx;', 'BEGIN; SELECT 1; COMMIT;', 'CREATE EXTENSION pgcrypto;', 'SET statement_timeout=0;'])('does not promote parser hard reject %s', async (sql) => {
    const value = fixture([{ path: firstPath, raw: Buffer.from('SELECT 1;\n') }, { path: secondPath, raw: Buffer.from(sql) }]); useGit(value);
    await expect(api.createMigrationSourceBundle(value.input)).rejects.toThrow('SOURCE_BUNDLE_FAILED');
  });
  it('retains source/body review for function calls and DO bodies', async () => {
    const value = fixture([{ path: firstPath, raw: Buffer.from('SELECT 1;\n') }, { path: secondPath, raw: Buffer.from('SELECT arbitrary_fn(); DO $$BEGIN PERFORM 1; END$$;') }]); useGit(value);
    const bundle = await api.createMigrationSourceBundle(value.input);
    expect(bundle.files[1]?.plan?.statements[1]?.requiresBodyReview).toBe(true); expect(bundle.sourceReviewRequired).toBe(true); expect(bundle.executionAllowed).toBe(false);
  });

  it('uses sanitized fixed error codes and no inherited credential or Git config environment', async () => {
    const value = fixture(); useGit(value, () => 'ERROR');
    let failure: unknown; try { await api.createMigrationSourceBundle(value.input); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error); expect((failure as Error).message).toBe('SOURCE_BUNDLE_GIT_FAILED');
    expect((failure as Error).cause).toBeUndefined(); expect(JSON.stringify(failure)).not.toMatch(/native|private|SQL/u);
    const options = spawnMock.mock.calls[0]?.[2]; const env = options?.env;
    expect(Object.keys(env ?? {}).sort()).toEqual(Object.keys(env ?? {}).filter((key) => ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_ATTR_NOSYSTEM', 'GIT_NO_REPLACE_OBJECTS', 'GIT_NO_LAZY_FETCH', 'GIT_TERMINAL_PROMPT', 'GIT_OPTIONAL_LOCKS'].includes(key)).sort());
    expect(env?.GIT_TERMINAL_PROMPT).toBe('0'); expect(env?.GIT_NO_REPLACE_OBJECTS).toBe('1'); expect(env?.GIT_NO_LAZY_FETCH).toBe('1');
    for (const args of value.commands) expect(['rev-parse', 'cat-file', 'ls-tree']).toContain(args[0]);
  });
  it('terminates only its owned hung Git child once within the subprocess bound', async () => {
    const value = fixture(); value.input.limits.gitProcessMs = 30; useGit(value, () => 'HANG');
    const start = performance.now(); await expect(api.createMigrationSourceBundle(value.input)).rejects.toThrow('SOURCE_BUNDLE_GIT_TIMEOUT');
    expect(performance.now() - start).toBeLessThan(1000); expect(value.children[0]?.kill).toHaveBeenCalledOnce(); expect(value.children).toHaveLength(1);
  });
  it('rejects output overrun and terminates only the owned child once', async () => {
    const value = fixture(); useGit(value, (args) => Buffer.alloc(args[1] === '--show-toplevel' ? 3000 : 100, 32));
    await expect(api.createMigrationSourceBundle(value.input)).rejects.toThrow('SOURCE_BUNDLE_GIT_OUTPUT_LIMIT'); expect(value.children[0]?.kill).toHaveBeenCalledOnce();
  });
  it('bounds a stuck filesystem lookup and never starts Git afterward', async () => {
    const value = fixture(); value.input.limits = { totalMs: 30, gitProcessMs: 20 }; realpathMock.mockImplementation(() => new Promise(() => {})); useGit(value);
    await expect(api.createMigrationSourceBundle(value.input)).rejects.toThrow('SOURCE_BUNDLE_DEADLINE'); expect(spawnMock).not.toHaveBeenCalled();
  });
  it('rejects starting the parser without its finite bound plus final Git readback reserve', async () => {
    const value = fixture(); value.input.limits = { totalMs: 1000, gitProcessMs: 100 }; useGit(value);
    await expect(api.createMigrationSourceBundle(value.input)).rejects.toThrow('SOURCE_BUNDLE_DEADLINE');
  });

  it('actually reads the local Git HEAD and fails closed for an unrelated approved-ref claim (no mutations)', async () => {
    const value = fixture(); spawnMock.mockImplementation(actualChild.spawn);
    await expect(api.createMigrationSourceBundle(value.input)).rejects.toThrow('SOURCE_BUNDLE_SOURCE_DRIFT');
    expect(spawnMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
  it('actually rejects repo/scripts as the local Git root (no Git/index/filesystem mutation)', async () => {
    const value = fixture(); value.input.repositoryPath = join(repositoryPath, 'scripts'); spawnMock.mockImplementation(actualChild.spawn);
    await expect(api.createMigrationSourceBundle(value.input)).rejects.toThrow('SOURCE_BUNDLE_REPOSITORY_UNSAFE');
    expect(spawnMock.mock.calls).toHaveLength(1);
  });
});
