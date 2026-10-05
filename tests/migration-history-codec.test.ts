import { type SpawnOptions, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
type Model = { mode: string; provenance: string; parserEvidenceBound: boolean; version: string; name: string;
  executionAllowed: false; operationalApproval: false; DBHistoryVerified: false; cliParityVerified: false;
  sourceReviewRequired: true; logicalStatementCount: number; historyStatementsSha256: string; rowSha256: string; sqlSha256: string };
type Snapshot = { historySha256: string; rowCount: number; provenance: string; rows: { name: string | null; statementsIsNull: boolean; statementCount: number | null; rowSha256: string }[] };
type Api = { HISTORY_CODEC_MAX_SQL_BYTES: number; HISTORY_CODEC_MAX_ROWS: number; HISTORY_CODEC_MAX_STATEMENTS: number;
  createMigrationHistoryModel(input: unknown): Model; isOwnedMigrationHistoryModel(input: unknown): boolean;
  createDecodedMigrationHistorySnapshot(input: unknown): Snapshot;
  createExpectedMigrationHistorySnapshot(input: unknown): Snapshot;
  compareMigrationHistorySnapshots(input: unknown): { matches: boolean; executionAllowed: false; DBHistoryVerified: false; cliParityVerified: false } };
const api = await import(new URL('../scripts/lib/migration-history-codec.mjs', import.meta.url).href) as Api;
const bundleApi = await import(new URL('../scripts/lib/migration-source-bundle.mjs', import.meta.url).href) as {
  createMigrationSourceBundle(input: unknown): Promise<unknown>;
};
const originalChild = await vi.importActual<typeof import('node:child_process')>('node:child_process');
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const clone = <T>(value: T): T => structuredClone(value);
const mutable = (value: object) => value as Record<string, unknown>;
const migrationVersion = '20261001000000';
const modelInput = (sql = 'SELECT 1;') => ({ version: migrationVersion, name: 'first', sqlBytes: Buffer.from(sql), sourceBinding: null });
const array = (values: (string | null)[], lowerBound = 1) => ({ dimensions: values.length ? [{ length: values.length, lowerBound }] : [], values });
const row = (values: (string | null)[] | null = ['SELECT 1'], name: string | null = 'first') => ({ version: migrationVersion, name, statements: values === null ? null : array(values) });
const observed = (value: unknown = row()) => api.createDecodedMigrationHistorySnapshot({ expectedVersions: [migrationVersion], rows: [value] });
const expected = (sql = 'SELECT 1;') => api.createExpectedMigrationHistorySnapshot({ models: [api.createMigrationHistoryModel(modelInput(sql))] });
const matches = (left: Snapshot, right: Snapshot) => api.compareMigrationHistorySnapshots({ expected: left, observed: right }).matches;
function tokens(sql: string, values: string[]) {
  const model = api.createMigrationHistoryModel(modelInput(sql));
  expect(model.logicalStatementCount).toBe(values.length);
  expect(model.historyStatementsSha256).toBe(sha(JSON.stringify({ format: 'cli-history-logical-statements-v1', value: values })));
  expect(matches(api.createExpectedMigrationHistorySnapshot({ models: [model] }), observed(row(values)))).toBe(true);
}
afterEach(() => { vi.mocked(spawn).mockImplementation(originalChild.spawn); vi.clearAllMocks(); });

describe('#378 bounded independent CLI logical statement source model', () => {
  it.each([
    ['', []], [' \r\n\t;', []], [';; SELECT 1;;;', ['SELECT 1']],
    [' SELECT 1;\r\n SELECT 2;\r\n', ['SELECT 1', 'SELECT 2']],
    ['-- 머리;\r\nSELECT 1;', ['-- 머리;\r\nSELECT 1']],
    ['SELECT 1; -- 꼬리;', ['SELECT 1', '-- 꼬리']],
    ['/* 밖; /* 안; */ 끝 */ SELECT 1;', ['/* 밖; /* 안; */ 끝 */ SELECT 1']],
    ["SELECT '가;😀'; SELECT 'it''s;fine';", ["SELECT '가;😀'", "SELECT 'it''s;fine'"]],
    ['SELECT "a"";b";', ['SELECT "a"";b"']],
    ['SELECT $$가;--not-comment/*x*/$$;', ['SELECT $$가;--not-comment/*x*/$$']],
    ['DO $tag$ BEGIN PERFORM 1; END $tag$;', ['DO $tag$ BEGIN PERFORM 1; END $tag$']],
    ['SELECT $한글_2$따옴표\'와;\\$한글_2$;', ["SELECT $한글_2$따옴표'와;\\$한글_2$"]],
    ['SELECT (1 + (2)); SELECT 3;', ['SELECT (1 + (2))', 'SELECT 3']],
    ['--comment-only\r\n', ['--comment-only']],
    ['/* comment-only; */', ['/* comment-only; */']],
    ['BEGIN; SELECT 1; COMMIT;', ['BEGIN', 'SELECT 1', 'COMMIT']],
    ["SELECT 'atomic'; SELECT \"ATOMIC\";", ["SELECT 'atomic'", 'SELECT "ATOMIC"']],
    ['SELECT 1\u2003;\u2003', ['SELECT 1']],
  ] as [string, string[]][])('matches independently declared ordered logical tokens for %j', (sql, values) => tokens(sql, values));

  it('keeps wrappers in the history domain rather than the execution-body domain', () => {
    const wrapped = api.createMigrationHistoryModel(modelInput('BEGIN; SELECT 1; COMMIT;'));
    const bare = api.createMigrationHistoryModel(modelInput('SELECT 1;'));
    expect(wrapped.logicalStatementCount).toBe(3);
    expect(wrapped.historyStatementsSha256).not.toBe(bare.historyStatementsSha256);
    expect(wrapped.historyStatementsSha256).not.toBe(sha(JSON.stringify({ format: 'exact-byte-statements-v1', statementSha256s: [sha(' SELECT 1')] })));
    expect(matches(expected('BEGIN; SELECT 1; COMMIT;'), observed(row(['BEGIN', 'SELECT 1', 'COMMIT'])))).toBe(true);
  });
  it('preserves CRLF and Unicode bytes inside tokens without normalization', () => {
    const lf = api.createMigrationHistoryModel(modelInput('-- 가\nSELECT $$😀;$$;'));
    const crlf = api.createMigrationHistoryModel(modelInput('-- 가\r\nSELECT $$😀;$$;'));
    expect(lf.historyStatementsSha256).not.toBe(crlf.historyStatementsSha256);
    expect(lf.sqlSha256).not.toBe(crlf.sqlSha256);
  });
  it.each(["SELECT 'unfinished", 'SELECT "unfinished', 'SELECT $$unfinished', '/* missing', 'SELECT (1;', '/* x /* y */'])('fails closed on unfinished scanner input %j', (sql) => {
    expect(() => api.createMigrationHistoryModel(modelInput(sql))).toThrow('HISTORY_CODEC_SCANNER_UNTERMINATED');
  });
  it.each(['BEGIN ATOMIC SELECT 1; END;', 'select atomic;', "SELECT E'a\\n';", "SELECT E'plain';", "SELECT e'';", 'SELECT $1$x$1$;', 'SELECT $١$x$١$;', 'SELECT 1\\;', 'SELECT $1;', 'SELECT foo$tag$x$tag$;', 'SELECT 𐐀$tag$x$tag$;', 'SELECT $²$x$²$;', 'SELECT $x-y$z$x-y$;', 'SELECT 1\r;'])('rejects unsupported/ambiguous scanner constructs %j', (sql) => {
    expect(() => api.createMigrationHistoryModel(modelInput(sql))).toThrow('HISTORY_CODEC_SCANNER_UNSUPPORTED');
  });
  it('rejects unmatched closing parentheses without guessing a split', () => {
    expect(() => api.createMigrationHistoryModel(modelInput('SELECT 1);'))).toThrow('HISTORY_CODEC_SCANNER_AMBIGUOUS');
  });
  it.each(['\ufeffSELECT 1;', '-- pg-delta: transaction=false\nSELECT 1;', '-- pg-delta: transaction=false\r\nSELECT 1;', '\ufeff-- pg-delta: transaction=false\nSELECT 1;'])('rejects unimplemented BOM/file execution metadata %j', (sql) => {
    expect(() => api.createMigrationHistoryModel(modelInput(sql))).toThrow('HISTORY_CODEC_FILE_DIRECTIVE_UNSUPPORTED');
  });
  it('does not discard commented BEGIN/COMMIT or trailing comment tokens', () => {
    tokens('-- begin\nBEGIN; SELECT 1; --commit\nCOMMIT; --tail', ['-- begin\nBEGIN', 'SELECT 1', '--commit\nCOMMIT', '--tail']);
  });
  it('bounds nesting, bytes and logical statement counts', () => {
    tokens(`SELECT ${'('.repeat(64)}1${')'.repeat(64)};`, [`SELECT ${'('.repeat(64)}1${')'.repeat(64)}`]);
    expect(() => api.createMigrationHistoryModel(modelInput(`SELECT ${'('.repeat(65)}1${')'.repeat(65)};`))).toThrow('HISTORY_CODEC_DEPTH_LIMIT');
    expect(() => api.createMigrationHistoryModel(modelInput(`${'/*'.repeat(65)}x${'*/'.repeat(65)}`))).toThrow('HISTORY_CODEC_DEPTH_LIMIT');
    expect(() => api.createMigrationHistoryModel({ ...modelInput(), sqlBytes: Buffer.alloc(api.HISTORY_CODEC_MAX_SQL_BYTES + 1, 32) })).toThrow('HISTORY_CODEC_BYTES_INVALID');
    expect(() => api.createMigrationHistoryModel(modelInput('SELECT 1;'.repeat(api.HISTORY_CODEC_MAX_STATEMENTS + 1)))).toThrow('HISTORY_CODEC_STATEMENT_LIMIT');
  });
  it.each([Buffer.from([0xff]), Buffer.from('SELECT\0'), new Uint8Array([0xc0, 0xaf])])('rejects malformed UTF8/NUL bytes %#', (sqlBytes) => {
    expect(() => api.createMigrationHistoryModel({ ...modelInput(), sqlBytes })).toThrow('HISTORY_CODEC_ENCODING_INVALID');
  });
  it.each(['SELECT 1;', [], null, new DataView(new ArrayBuffer(2))])('does not coerce non-byte source %#', (sqlBytes) => {
    expect(() => api.createMigrationHistoryModel({ ...modelInput(), sqlBytes })).toThrow('HISTORY_CODEC_BYTES_INVALID');
  });
  it('uses intrinsic typed-array bounds rather than spoofed byteLength or buffer getters', () => {
    const large = Buffer.alloc(api.HISTORY_CODEC_MAX_SQL_BYTES + 1, 32);
    Object.defineProperty(large, 'byteLength', { value: 0 });
    expect(() => api.createMigrationHistoryModel({ ...modelInput(), sqlBytes: large })).toThrow('HISTORY_CODEC_BYTES_INVALID');
    const sqlBytes = Buffer.from('SELECT 1;');
    const getter = vi.fn(() => { throw new Error('private synthetic byte metadata'); });
    for (const key of ['byteLength', 'byteOffset', 'buffer']) Object.defineProperty(sqlBytes, key, { get: getter });
    expect(api.createMigrationHistoryModel({ ...modelInput(), sqlBytes }).logicalStatementCount).toBe(1);
    expect(getter).not.toHaveBeenCalled();
  });
});

describe('#378 strict decoded PostgreSQL history shape, not wire serialization', () => {
  it('matches exact decoded row values without executing/readback claims', () => {
    const result = api.compareMigrationHistorySnapshots({ expected: expected(), observed: observed() });
    expect(result).toMatchObject({ matches: true, executionAllowed: false, operationalApproval: false,
      DBHistoryVerified: false, fullStateVerified: false, cliParityVerified: false, observedHistoryIsCallerClaim: true });
  });
  it('canonicalizes object key order only, never decoded values or array metadata', () => {
    const reordered = { statements: { values: ['SELECT 1'], dimensions: [{ lowerBound: 1, length: 1 }] }, name: 'first', version: migrationVersion };
    expect(observed(reordered).historySha256).toBe(observed().historySha256);
    expect(matches(expected(), observed(reordered))).toBe(true);
  });
  it.each([null, [], [''], [null], ['NULL']])('preserves nullable/empty/null-element statements %#', (values) => {
    const value = observed(row(values));
    expect(value.rows[0]?.statementsIsNull).toBe(values === null);
    expect(value.rows[0]?.statementCount).toBe(values?.length ?? null);
    expect(matches(expected(), value)).toBe(false);
  });
  it('distinguishes all null, empty and literal NULL forms in whole history digests', () => {
    const hashes = [null, [], [''], [null], ['NULL']].map((values) => observed(row(values)).historySha256);
    expect(new Set(hashes).size).toBe(hashes.length);
  });
  it.each([null, '', 'first', '다른 이름'])('preserves name exactness and null without coalesce %#', (name) => {
    const value = observed(row(['SELECT 1'], name));
    expect(value.rows[0]?.name).toBe(name);
    expect(matches(expected(), value)).toBe(name === 'first');
  });
  it('preserves nonstandard lower bounds, order and duplicated values instead of treating them as normal CLI arrays', () => {
    const lower = { ...row(), statements: array(['SELECT 1'], 0) };
    expect(matches(expected(), observed(lower))).toBe(false);
    expect(observed(lower).historySha256).not.toBe(observed().historySha256);
    expect(matches(expected('SELECT 1;SELECT 2;'), observed(row(['SELECT 2', 'SELECT 1'])))).toBe(false);
    tokens('SELECT 1; SELECT 1;', ['SELECT 1', 'SELECT 1']);
  });
  it.each([
    { dimensions: [{ length: 1, lowerBound: 1 }], values: [] },
    { dimensions: [], values: ['SELECT 1'] },
    { dimensions: [{ length: 0, lowerBound: 1 }], values: [] },
    { dimensions: [{ length: 1, lowerBound: 1 }, { length: 1, lowerBound: 1 }], values: ['SELECT 1'] },
    { dimensions: [{ length: 1, lowerBound: '1' }], values: ['SELECT 1'] },
    { dimensions: [{ length: 1, lowerBound: null }], values: ['SELECT 1'] },
    { dimensions: [{ length: 1, lowerBound: -2147483649 }], values: ['SELECT 1'] },
    { dimensions: [{ length: 2, lowerBound: 2147483647 }], values: ['SELECT 1', 'SELECT 2'] },
    { dimensions: [{ length: 1, lowerBound: 1, upperBound: 1 }], values: ['SELECT 1'] },
    { dimensions: [{ length: 1, lowerBound: 1 }], values: [1] },
    { dimensions: [{ length: 1, lowerBound: 1 }], values: [undefined] },
    { dimensions: [{ length: 1, lowerBound: 1 }], values: ['\ud800'] },
    { dimensions: [{ length: 1, lowerBound: 1 }], values: ['SELECT\0'] },
    ['SELECT 1'], '{"SELECT 1"}', { dimensions: [], values: [], encoded: '{}' },
  ])('fails closed on invalid/unsupported decoded array shape %#', (statements) => {
    expect(() => observed({ ...row(), statements })).toThrow(/^HISTORY_CODEC_/u);
  });
  it.each(['1', '2026100100000', '202610010000000', 20261001000000, null])('rejects non-project history versions %#', (invalid) => {
    expect(() => observed({ ...row(), version: invalid })).toThrow('HISTORY_CODEC_VERSION_INVALID');
  });
  it('rejects missing, additional, unknown, duplicate and reordered rows', () => {
    const second = { ...row(), version: '20261002000000' };
    for (const rows of [[], [row(), second], [second], [row(), row()]]) {
      expect(() => api.createDecodedMigrationHistorySnapshot({ expectedVersions: [migrationVersion], rows })).toThrow('HISTORY_CODEC_ROW_SET_MISMATCH');
    }
    expect(() => api.createDecodedMigrationHistorySnapshot({ expectedVersions: [migrationVersion, second.version], rows: [second, row()] })).toThrow('HISTORY_CODEC_ROW_SET_MISMATCH');
    for (const expectedVersions of [[migrationVersion, migrationVersion], [second.version, migrationVersion]]) {
      expect(() => api.createDecodedMigrationHistorySnapshot({ expectedVersions, rows: [row(), second] })).toThrow('HISTORY_CODEC_VERSION_ORDER_INVALID');
    }
  });
  it('accepts an explicit zero-row model without claiming a real empty DB', () => {
    const value = api.createDecodedMigrationHistorySnapshot({ expectedVersions: [], rows: [] });
    expect(value).toMatchObject({ rowCount: 0, provenance: 'UNTRUSTED_DECODED_ROW_MODEL', DBHistoryVerified: false });
    expect(matches(api.createExpectedMigrationHistorySnapshot({ models: [] }), value)).toBe(true);
  });
  it('bounds whole history size and row count', () => {
    const versions = Array.from({ length: api.HISTORY_CODEC_MAX_ROWS + 1 }, (_, index) => String(20261001000000 + index));
    expect(() => api.createDecodedMigrationHistorySnapshot({ expectedVersions: versions, rows: [] })).toThrow('HISTORY_CODEC_INPUT_INVALID');
    const values = Array(17).fill('x'.repeat(api.HISTORY_CODEC_MAX_SQL_BYTES)) as string[];
    expect(() => observed(row(values))).toThrow('HISTORY_CODEC_SIZE_LIMIT');
  });
});

describe('#378 ownership, safe public metadata and hostile objects', () => {
  it('keeps token strings/bytes private and copied while every public model stays execution-disabled', () => {
    const input = modelInput("SELECT 'synthetic-sensitive-marker';");
    const model = api.createMigrationHistoryModel(input);
    input.sqlBytes.fill(32);
    expect(api.isOwnedMigrationHistoryModel(model)).toBe(true);
    expect(api.isOwnedMigrationHistoryModel(clone(model))).toBe(false);
    expect(model).toMatchObject({ provenance: 'UNTRUSTED_INPUT_MODEL', parserEvidenceBound: false,
      executionAllowed: false, operationalApproval: false, DBHistoryVerified: false, cliParityVerified: false });
    const value = api.createExpectedMigrationHistorySnapshot({ models: [model] });
    expect(matches(value, observed(row(["SELECT 'synthetic-sensitive-marker'"])))).toBe(true);
    expect(JSON.stringify({ model, value })).not.toContain('synthetic-sensitive-marker');
    expect(JSON.stringify({ model, value })).not.toMatch(/sqlBytes|statementStrings|rawSql/u);
    expect(Object.isFrozen(model)).toBe(true); expect(Object.isFrozen(value.rows)).toBe(true);
    expect(() => { mutable(model).executionAllowed = true; }).toThrow();
  });
  it('copies decoded arrays so later caller mutation cannot alter comparison', () => {
    const input = row();
    const value = observed(input);
    if (!input.statements) throw new Error('SYNTHETIC_ROW_MISSING');
    input.statements.values[0] = 'SELECT 2'; input.statements.dimensions[0] = { length: 1, lowerBound: 0 };
    expect(matches(expected(), value)).toBe(true);
  });
  it.each([{ bundle: {}, path: 'supabase/migrations/20261001000000_first.sql' }, { bundle: { sourceEvidenceVerified: true }, path: 'anything' }])('refuses caller-created source ownership %#', (sourceBinding) => {
    expect(() => api.createMigrationHistoryModel({ ...modelInput(), sourceBinding })).toThrow('HISTORY_CODEC_SOURCE_NOT_OWNED');
  });
  it('rejects clone handles, duplicate expected models and unowned snapshots', () => {
    const model = api.createMigrationHistoryModel(modelInput());
    expect(() => api.createExpectedMigrationHistorySnapshot({ models: [clone(model)] })).toThrow('HISTORY_CODEC_MODEL_NOT_OWNED');
    expect(() => api.createExpectedMigrationHistorySnapshot({ models: [model, model] })).toThrow('HISTORY_CODEC_VERSION_ORDER_INVALID');
    expect(() => api.compareMigrationHistorySnapshots({ expected: clone(expected()), observed: observed() })).toThrow('HISTORY_CODEC_SNAPSHOT_NOT_OWNED');
  });
  it('rejects getter/symbol/extra/prototype/sparse-array shapes without invoking getters', () => {
    const getter = vi.fn(() => { throw new Error('private native metadata'); });
    const getterInput = modelInput(); Object.defineProperty(getterInput, 'name', { enumerable: true, get: getter });
    for (const input of [getterInput, { ...modelInput(), approved: true }, { ...modelInput(), [Symbol('hidden')]: 1 }, Object.create(modelInput())]) {
      expect(() => api.createMigrationHistoryModel(input)).toThrow('HISTORY_CODEC_INPUT_INVALID');
    }
    expect(getter).not.toHaveBeenCalled();
    const sparse = new Array(1);
    expect(() => api.createExpectedMigrationHistorySnapshot({ models: sparse })).toThrow('HISTORY_CODEC_INPUT_INVALID');
    const badRow = row(); Object.defineProperty(badRow, 'statements', { enumerable: true, get: getter });
    expect(() => observed(badRow)).toThrow('HISTORY_CODEC_INPUT_INVALID'); expect(getter).not.toHaveBeenCalled();
    const values = ['SELECT 1']; Object.defineProperty(values, '0', { enumerable: true, get: getter });
    expect(() => observed({ ...row(), statements: array(values) })).toThrow('HISTORY_CODEC_INPUT_INVALID'); expect(getter).not.toHaveBeenCalled();
  });
  it('sanitizes foreign Proxy errors without forwarding cause/SQL/private paths', () => {
    const input = new Proxy({}, { getPrototypeOf() { throw new Error('foreign synthetic-sensitive-marker'); } });
    let failure: unknown;
    try { api.createMigrationHistoryModel(input); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('HISTORY_CODEC_INPUT_INVALID');
    expect((failure as Error).cause).toBeUndefined();
  });
  it('has no DB/process/credential/wire/SQL accessor or external source import', () => {
    const source = readFileSync(new URL('../scripts/lib/migration-history-codec.mjs', import.meta.url), 'utf8');
    expect(source).not.toMatch(/node:(?:child_process|fs|net|tls)|process\.env|postgres|legacySplitSql|class \w+State/u);
    expect(Object.keys(api).sort()).toEqual(['HISTORY_CODEC_CLI_COMMIT', 'HISTORY_CODEC_CLI_VERSION', 'HISTORY_CODEC_MAX_ROWS',
      'HISTORY_CODEC_MAX_SQL_BYTES', 'HISTORY_CODEC_MAX_STATEMENTS', 'HISTORY_CODEC_MAX_TOTAL_BYTES',
      'compareMigrationHistorySnapshots', 'createDecodedMigrationHistorySnapshot', 'createExpectedMigrationHistorySnapshot',
      'createMigrationHistoryModel', 'isOwnedMigrationHistoryModel'].sort());
  });
});

// Synthetic immutable Git objects + actual owned bundle and actual pinned parser.
// This is NOT an actual approved-ref positive, CLI parity, PostgreSQL or DB test.
async function ownedBundle(major: number, sql: string) {
  const repositoryPath = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const path = `supabase/migrations/${migrationVersion}_first.sql`;
  const manifestPath = 'supabase/migration-manifest.dev.json';
  const raw = Buffer.from(sql);
  const oid = (kind: string, bytes: Buffer) => createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex');
  const rawOid = oid('blob', raw);
  const manifest = Buffer.from(`${JSON.stringify({ schemaVersion: 1, release: 'dev', hashAlgorithm: 'sha256-lf-utf8', totalCount: 1,
    baseline: { count: 1, head: 'first' }, pending: { count: 0, first: null, head: null }, head: 'first',
    migrations: [{ order: 1, name: 'first', sha256: sha(sql.replaceAll('\r\n', '\n')) }] }, null, 2)}\n`);
  const manifestOid = oid('blob', manifest);
  const tree = (entries: { mode: string; name: string; oid: string }[]) => Buffer.concat(entries.map((entry) =>
    Buffer.concat([Buffer.from(`${entry.mode} ${entry.name}\0`), Buffer.from(entry.oid, 'hex')])));
  const migrations = tree([{ mode: '100644', name: `${migrationVersion}_first.sql`, oid: rawOid }]);
  const migrationsOid = oid('tree', migrations);
  const supabase = tree([{ mode: '100644', name: 'migration-manifest.dev.json', oid: manifestOid }, { mode: '40000', name: 'migrations', oid: migrationsOid }]);
  const supabaseOid = oid('tree', supabase);
  const root = tree([{ mode: '40000', name: 'supabase', oid: supabaseOid }]);
  const rootOid = oid('tree', root);
  const objects = new Map([[rawOid, raw], [manifestOid, manifest], [migrationsOid, migrations], [supabaseOid, supabase], [rootOid, root]]);
  const modelSource = { projectRef: 'abcdefghijklmnopqrst', sourceRef: 'refs/heads/main', headSha1: 'c'.repeat(40),
    treeSha1: rootOid, manifestSha256: sha(manifest), historySha256: 'd'.repeat(64) };
  class Child extends EventEmitter { stdout = new PassThrough(); stderr = new PassThrough(); kill = () => true; }
  vi.mocked(spawn).mockImplementation(((command: string, args: string[], options: SpawnOptions) => {
    expect(command).toBe('git'); expect(options.shell).toBe(false);
    const child = new Child();
    const operation = args.slice(args.indexOf(repositoryPath) + 1);
    queueMicrotask(() => {
      const last = operation.at(-1);
      const output = operation[0] === 'cat-file' ? objects.get(last ?? '')
        : Buffer.from(`${operation[1] === '--show-toplevel' ? repositoryPath : operation[1] === '--show-object-format' ? 'sha1'
          : last === 'HEAD^{tree}' ? rootOid : modelSource.headSha1}\n`);
      child.stdout.end(output); child.stderr.end(); child.emit('close', output ? 0 : 1);
    });
    return child;
  }) as unknown as typeof spawn);
  const bundle = await bundleApi.createMigrationSourceBundle({ repositoryPath, expectedSource: modelSource, manifestPath,
    parserMajor: major, planPaths: [path], wrapperApprovals: [], lfCopyApprovals: [], limits: { totalMs: 120000, gitProcessMs: 1000 } });
  return { bundle, path };
}
describe('#378 actual owned plan link within synthetic Git source fixtures', () => {
  it.each([15, 17])('uses actual owned bundle/parser bytes for PG%i without history execution claims', async (major) => {
    const sql = "-- 한글\r\nSELECT '가;😀';\r\n";
    const binding = await ownedBundle(major, sql);
    const model = api.createMigrationHistoryModel({ ...modelInput(sql), sourceBinding: binding });
    expect(model).toMatchObject({ provenance: 'OWNED_LOCAL_SOURCE_BOUND_MODEL', parserEvidenceBound: true,
      executionAllowed: false, operationalApproval: false, DBHistoryVerified: false, cliParityVerified: false });
    expect(api.createExpectedMigrationHistorySnapshot({ models: [model] }).provenance).toBe('OWNED_LOCAL_SOURCE_BOUND_MODEL');
    expect(matches(api.createExpectedMigrationHistorySnapshot({ models: [model] }), observed(row(["-- 한글\r\nSELECT '가;😀'"])))).toBe(true);
    for (const input of [{ ...modelInput('SELECT 2;'), sourceBinding: binding }, { ...modelInput(sql), version: '20261002000000', sourceBinding: binding },
      { ...modelInput(sql), name: 'second', sourceBinding: binding }, { ...modelInput(sql), sourceBinding: { ...binding, path: 'supabase/migrations/20261001000000_missing.sql' } }]) {
      expect(() => api.createMigrationHistoryModel(input)).toThrow('HISTORY_CODEC_SOURCE_MISMATCH');
    }
    expect(() => api.createMigrationHistoryModel({ ...modelInput(sql), sourceBinding: clone(binding) })).toThrow('HISTORY_CODEC_SOURCE_NOT_OWNED');
  });
});
