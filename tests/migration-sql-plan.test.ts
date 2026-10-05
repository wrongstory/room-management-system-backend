import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';

type Source = { projectRef: string; sourceRef: string; headSha1: string; treeSha1: string; manifestSha256: string; historySha256: string };
type Statement = { index: number; astKind: string; startByte: number; endByte: number; sha256: string; transactionKind: string | null; requiresBodyReview: boolean; sourceReviewRequired: boolean };
type Parsed = { version: number; stmts: { stmt: Record<string, Record<string, unknown>>; stmt_location?: number; stmt_len?: number }[] };
type Wrapper = { modelSource: Source; sqlSha256: string; begin: Pick<Statement, 'startByte' | 'endByte' | 'sha256'>; commit: Pick<Statement, 'startByte' | 'endByte' | 'sha256'> };
type Input = { sqlBytes: Uint8Array; parserMajor: number; expectedSource: Source; observedSource: Source; expectedSqlSha256: string; wrapperApproval: Wrapper | null };
type Plan = { mode: string; executionAllowed: false; parserEvidenceVerified: boolean; sourceEvidenceVerified: false; sourceReviewRequired: true; parserMajor: number; astVersion: number; modelSource: Source; sqlSha256: string; byteLength: number; statements: Statement[]; statementSha256s: string[]; statementsSha256: string; wrapper: { begin: Statement; commit: Statement } | null };
type Codec = { mode: string; executionAllowed: false; parserEvidenceVerified: false; statements: Statement[] };
type Api = { SQL_PLAN_MAX_BYTES: number; SQL_PLAN_TIMEOUT_MS: number; createMigrationSqlPlan(input: unknown): Promise<Plan>; inspectMigrationSqlAst(bytes: Uint8Array, ast: unknown, major: number): Codec };
const moduleUrl = new URL('../scripts/lib/migration-sql-plan.mjs', import.meta.url);
const api = await import(moduleUrl.href) as Api;
const { Parser } = createRequire(import.meta.url)('@pgsql/parser') as { Parser: new (options: { version: number }) => { parse(sql: string): Promise<Parsed> } };
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const clone = <T>(value: T): T => structuredClone(value);
const mutable = (value: object) => value as Record<string, unknown>;

function input(sql = 'SELECT 1; SELECT 2', parserMajor = 15): Input {
  const modelSource = { projectRef: 'abcdefghijklmnopqrst', sourceRef: 'refs/heads/release/v0.9.0', headSha1: 'a'.repeat(40), treeSha1: 'b'.repeat(40), manifestSha256: 'c'.repeat(64), historySha256: 'd'.repeat(64) };
  const sqlBytes = Buffer.from(sql, 'utf8');
  return { sqlBytes, parserMajor, expectedSource: modelSource, observedSource: clone(modelSource), expectedSqlSha256: hash(sqlBytes), wrapperApproval: null };
}
async function wrapperInput(sql = "-- 승인 원문\r\nBEGIN;\r\nSELECT '가;나';\r\nCOMMIT;\r\n", major = 15) {
  const value = input(sql, major);
  const parsed = await new Parser({ version: major }).parse(sql);
  const rows = api.inspectMigrationSqlAst(value.sqlBytes, parsed, major).statements;
  const begin = rows[0]; const commit = rows.at(-1);
  if (!begin || !commit) throw new Error('SYNTHETIC_FIXTURE_MISSING');
  const extent = ({ startByte, endByte, sha256 }: Statement) => ({ startByte, endByte, sha256 });
  value.wrapperApproval = { modelSource: clone(value.expectedSource), sqlSha256: value.expectedSqlSha256, begin: extent(begin), commit: extent(commit) };
  return value;
}

describe('#378 real PG15/PG17 parser byte evidence', () => {
  it.each([15, 17])('uses an actual pinned parser in a bounded private worker for PG%i', async (major) => {
    const value = input("-- 한글\r\nSELECT '가;나'; /* 중첩 ; /* ; */ */\r\nSELECT $$끝;문장$$", major);
    const plan = await api.createMigrationSqlPlan(value);
    expect(plan).toMatchObject({ mode: 'AST_SOURCE_ONLY', executionAllowed: false, sourceEvidenceVerified: false, parserEvidenceVerified: true, sourceReviewRequired: true, parserMajor: major });
    expect(Math.trunc(plan.astVersion / 10000)).toBe(major);
    expect(plan.byteLength).toBe(value.sqlBytes.length);
    expect(plan.sqlSha256).toBe(hash(value.sqlBytes));
    expect(plan.statements).toHaveLength(2);
    for (const statement of plan.statements) expect(statement.sha256).toBe(hash(value.sqlBytes.subarray(statement.startByte, statement.endByte)));
    expect(plan.statements[1]?.startByte).toBeGreaterThan(27);
    expect(Object.isFrozen(plan)).toBe(true); expect(Object.isFrozen(plan.statements)).toBe(true);
    expect(Object.isFrozen(plan.modelSource)).toBe(true);
    expect(plan.statementSha256s).toEqual(plan.statements.map((row) => row.sha256));
    expect(plan.statementsSha256).toBe(hash(JSON.stringify({ format: 'exact-byte-statements-v1', statementSha256s: plan.statementSha256s })));
    expect(JSON.stringify(plan)).not.toMatch(/SELECT|가;나|끝;문장|sqlBytes|rawSql/u);
  });

  it.each([
    "SELECT 'one;two'; SELECT E'a\\'b;';",
    'SELECT $$one;two$$; SELECT $tag$three;four$tag$;',
    '/* ; /* nested ; */ ; */ SELECT 1;; -- trailing ;\r\n',
    'DO $body$BEGIN PERFORM 1; PERFORM 2; END$body$;',
    'CREATE FUNCTION f() RETURNS integer LANGUAGE sql AS $$SELECT 1;$$;',
    'CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $f$BEGIN PERFORM 1; END$f$;',
    "CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql SET search_path='' AS $f$BEGIN PERFORM 1; END$f$;",
    'CREATE FUNCTION f() RETURNS integer LANGUAGE sql BEGIN ATOMIC SELECT 1; END;',
  ])('does not split quoted/commented/dollar/body semicolons %#', async (sql) => {
    const plan = await api.createMigrationSqlPlan(input(sql));
    const expected = sql.startsWith('SELECT') ? 2 : 1;
    expect(plan.statements).toHaveLength(expected);
    expect(plan.executionAllowed).toBe(false);
    if (sql.startsWith('DO') || sql.startsWith('CREATE FUNCTION')) expect(plan.statements[0]?.requiresBodyReview).toBe(true);
  });

  it('preserves CRLF and trailing no-semicolon extent instead of normalizing', async () => {
    const crlf = input('-- 한글\r\nSELECT 1;\r\nSELECT 2');
    const lf = input('-- 한글\nSELECT 1;\nSELECT 2');
    const first = await api.createMigrationSqlPlan(crlf); const second = await api.createMigrationSqlPlan(lf);
    expect(first.sqlSha256).not.toBe(second.sqlSha256);
    expect(first.statementSha256s).not.toEqual(second.statementSha256s);
    expect(first.statements.at(-1)?.endByte).toBe(crlf.sqlBytes.byteLength);
  });

  it('copies caller bytes/source before asynchronous parsing', async () => {
    const value = input(); const original = Buffer.from(value.sqlBytes); const expected = clone(value.expectedSource);
    const result = api.createMigrationSqlPlan(value);
    value.sqlBytes.fill(0); value.expectedSource.headSha1 = 'e'.repeat(40); value.observedSource.headSha1 = 'e'.repeat(40);
    const plan = await result;
    expect(plan.sqlSha256).toBe(hash(original)); expect(plan.modelSource).toEqual(expected);
    expect(() => { mutable(plan).executionAllowed = true; }).toThrow();
  });

  it('inventory parses every current migration in both majors without executing SQL', async () => {
    const files = (await readdir(new URL('../supabase/migrations/', import.meta.url))).filter((file) => file.endsWith('.sql')).sort();
    expect(files.length).toBeGreaterThanOrEqual(103);
    for (const major of [15, 17]) {
      const parser = new Parser({ version: major }); const kinds = new Set<string>(); let total = 0;
      for (const file of files) {
        const sql = await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8');
        const parsed = await parser.parse(sql); expect(Math.trunc(parsed.version / 10000)).toBe(major);
        total += parsed.stmts.length; for (const row of parsed.stmts) for (const kind of Object.keys(row.stmt)) kinds.add(kind);
      }
      expect(total).toBeGreaterThanOrEqual(3363); expect(kinds.size).toBeGreaterThanOrEqual(29);
      expect(kinds.has('TransactionStmt')).toBe(true); expect(kinds.has('DoStmt')).toBe(true);
    }
  }, 20_000);
});

describe('#378 exact source and original outer-wrapper model', () => {
  it.each(['projectRef', 'sourceRef', 'headSha1', 'treeSha1', 'manifestSha256', 'historySha256'] as const)('rejects expected/observed source %s drift before parsing', async (field) => {
    const value = input(); value.observedSource[field] = field === 'projectRef' ? 'z'.repeat(20) : field === 'sourceRef' ? 'refs/heads/main' : 'e'.repeat(field.endsWith('Sha1') ? 40 : 64);
    await expect(api.createMigrationSqlPlan(value)).rejects.toThrow('SQL_PLAN_SOURCE_MISMATCH');
  });
  it('does not accept a version-looking/hash-looking value as actual approval', async () => {
    const plan = await api.createMigrationSqlPlan(input());
    expect(plan.sourceEvidenceVerified).toBe(false); expect(plan.executionAllowed).toBe(false);
    expect(plan.sourceReviewRequired).toBe(true);
  });
  it('rejects raw source/hash mismatch', async () => {
    const value = input(); value.expectedSqlSha256 = 'f'.repeat(64);
    await expect(api.createMigrationSqlPlan(value)).rejects.toThrow('SQL_PLAN_SQL_HASH_MISMATCH');
  });
  it.each([15, 17])('preserves precisely approved original outer BEGIN/COMMIT metadata PG%i', async (major) => {
    const value = await wrapperInput(undefined, major); const plan = await api.createMigrationSqlPlan(value);
    expect(plan.wrapper?.begin.transactionKind).toBe('TRANS_STMT_BEGIN');
    expect(plan.wrapper?.commit.transactionKind).toBe('TRANS_STMT_COMMIT');
    expect(plan.statements).toHaveLength(3); expect(plan.statementSha256s).toHaveLength(1);
    expect(plan.sqlSha256).toBe(value.expectedSqlSha256); expect(plan.executionAllowed).toBe(false);
  });
  it('does not blindly strip an unapproved pair', async () => {
    await expect(api.createMigrationSqlPlan(input('BEGIN; SELECT 1; COMMIT;'))).rejects.toThrow('SQL_PLAN_WRAPPER_APPROVAL_REQUIRED');
  });
  it.each(['20260913075134_room_pin_nonce_reservation_hardening.sql', '20260919230733_generated_room_pin_confirmation.sql'])('binds actual preserved wrapper bytes rather than rewritten SQL: %s', async (file) => {
    const raw = await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url));
    const value = await wrapperInput(raw.toString('utf8'));
    expect(Buffer.from(value.sqlBytes).equals(raw)).toBe(true);
    const plan = await api.createMigrationSqlPlan(value);
    expect(plan.sqlSha256).toBe(hash(raw)); expect(plan.wrapper).not.toBeNull();
    expect(plan.statementSha256s.length).toBe(plan.statements.length - 2);
    expect(plan.executionAllowed).toBe(false); expect(plan.sourceEvidenceVerified).toBe(false);
  });
  it.each(['source', 'sqlSha256', 'begin-start', 'begin-end', 'begin-hash', 'commit-start', 'commit-end', 'commit-hash'])('rejects changed wrapper %s', async (field) => {
    const value = await wrapperInput(); const proof = value.wrapperApproval;
    if (!proof) throw new Error('SYNTHETIC_FIXTURE_MISSING');
    if (field === 'source') proof.modelSource.headSha1 = 'f'.repeat(40);
    else if (field === 'sqlSha256') proof.sqlSha256 = 'f'.repeat(64);
    else { const [key, property] = field.split('-'); const extent = key === 'begin' ? proof.begin : proof.commit;
      if (property === 'start') extent.startByte += 1; else if (property === 'end') extent.endByte += 1; else extent.sha256 = 'f'.repeat(64); }
    await expect(api.createMigrationSqlPlan(value)).rejects.toThrow(/SQL_PLAN_WRAPPER_(?:BINDING_MISMATCH|APPROVAL_REQUIRED)/u);
  });
  it('rejects wrapper metadata on an unwrapped source', async () => {
    const value = input(); value.wrapperApproval = (await wrapperInput()).wrapperApproval;
    await expect(api.createMigrationSqlPlan(value)).rejects.toThrow('SQL_PLAN_WRAPPER_UNEXPECTED');
  });
  it.each(['BEGIN;BEGIN;SELECT 1;COMMIT;COMMIT;', 'BEGIN;SELECT 1;ROLLBACK;', 'SELECT 1;COMMIT;', 'BEGIN;COMMIT;', 'BEGIN READ ONLY;SELECT 1;COMMIT;', 'BEGIN;SELECT 1;COMMIT AND CHAIN;', 'BEGIN;SAVEPOINT s;SELECT 1;COMMIT;', 'START TRANSACTION;SELECT 1;COMMIT;'])('rejects nested/altered/partial transaction controls %#', async (sql) => {
    await expect(api.createMigrationSqlPlan(input(sql))).rejects.toThrow('SQL_PLAN_TRANSACTION_DISALLOWED');
  });
});

describe('#378 fail-closed AST/safe parser boundary', () => {
  it.each([15, 17])('rejects actual DROP INDEX CONCURRENTLY outside a transaction in PG%i', async (major) => {
    await expect(api.createMigrationSqlPlan(input('DROP INDEX CONCURRENTLY synthetic_index;', major)))
      .rejects.toThrow('SQL_PLAN_TRANSACTION_OUTSIDE');
  });
  it.each([
    'CREATE INDEX CONCURRENTLY i ON t(c);', 'REINDEX INDEX CONCURRENTLY i;', 'VACUUM t;',
    'CREATE DATABASE x;', 'DROP DATABASE x;', 'CREATE TABLESPACE x LOCATION \'/synthetic\';',
    'ALTER SYSTEM SET work_mem=\'1MB\';', "COPY t TO PROGRAM 'synthetic';", "COPY t TO '/synthetic';",
    'CREATE SERVER x FOREIGN DATA WRAPPER x;', 'CREATE EXTENSION pgcrypto;',
    'DROP EXTENSION pgcrypto;', 'DROP SERVER x;', "DO LANGUAGE plpythonu $$print('synthetic')$$;",
    'ALTER ROLE x SET statement_timeout=0;', 'SET statement_timeout=0;', 'CALL x();',
    "CREATE FUNCTION f() RETURNS void LANGUAGE sql SET statement_timeout=0 AS $$SELECT 1;$$;",
    "CREATE FUNCTION f() RETURNS void AS '/synthetic', 'f' LANGUAGE c;",
    'CREATE FUNCTION f() RETURNS void AS \'f\' LANGUAGE internal;',
    'REFRESH MATERIALIZED VIEW CONCURRENTLY v;', 'CHECKPOINT;', 'TRUNCATE t;',
  ])('never turns forbidden/external/unknown statement %# into an executable plan', async (sql) => {
    await expect(api.createMigrationSqlPlan(input(sql))).rejects.toThrow(/^SQL_PLAN_(?:STATEMENT_DISALLOWED|TRANSACTION_OUTSIDE|EXTERNAL_LANGUAGE|UNKNOWN_AST|NESTED_UNSAFE)$/u);
  });
  it('does not call arbitrary functions or treat their AST as side-effect proof', async () => {
    const plan = await api.createMigrationSqlPlan(input('SELECT pg_read_file(\'/synthetic\');'));
    expect(plan.sourceReviewRequired).toBe(true); expect(plan.executionAllowed).toBe(false);
    expect(plan.statements[0]?.sourceReviewRequired).toBe(true);
  });
  it.each(["DO $$BEGIN COMMIT; END$$;", "DO $$BEGIN EXECUTE 'COPY t TO PROGRAM'; END$$;"] )('blocks ambiguous DO body pending separate source review %#', async (sql) => {
    const plan = await api.createMigrationSqlPlan(input(sql));
    expect(plan.statements[0]?.requiresBodyReview).toBe(true); expect(plan.executionAllowed).toBe(false);
  });
  it.each(['', '-- only comment', 'SELECT \u0000', 'SELECT \ud800'])('rejects empty/NUL/unrepresentable parser input %#', async (sql) => {
    const value = input(sql);
    if (sql.includes('\ud800')) { value.sqlBytes = new Uint8Array([0xed, 0xa0, 0x80]); value.expectedSqlSha256 = hash(value.sqlBytes); }
    await expect(api.createMigrationSqlPlan(value)).rejects.toThrow(/^SQL_PLAN_/u);
  });
  it('limits original input bytes, not JavaScript character count', async () => {
    const value = input(); value.sqlBytes = new Uint8Array(api.SQL_PLAN_MAX_BYTES + 1); value.expectedSqlSha256 = hash(value.sqlBytes);
    await expect(api.createMigrationSqlPlan(value)).rejects.toThrow('SQL_PLAN_SIZE_INVALID');
    expect(api.SQL_PLAN_MAX_BYTES).toBe(2097152); expect(api.SQL_PLAN_TIMEOUT_MS).toBe(10000);
  });
  it.each([14, 16, 18, '15', 15.1, Number.NaN, Number.POSITIVE_INFINITY])('rejects unsupported/unverified requested version %#', async (major) => {
    const value = input(); mutable(value).parserMajor = major;
    await expect(api.createMigrationSqlPlan(value)).rejects.toThrow('SQL_PLAN_VERSION_UNSUPPORTED');
  });
  it('sanitizes real syntax errors without returning SQL, native details or cause', async () => {
    const sentinel = 'SYNTHETIC_SQL_SECRET_SENTINEL';
    try { await api.createMigrationSqlPlan(input(`invalid ${sentinel};`)); throw new Error('SYNTHETIC_EXPECTED_FAILURE'); }
    catch (error) { expect(error).toBeInstanceOf(Error); expect((error as Error).message).toBe('SQL_PLAN_PARSER_FAILED');
      expect((error as Error).cause).toBeUndefined(); expect(String((error as Error).stack)).not.toContain(sentinel); expect(error).not.toHaveProperty('sqlDetails'); }
  });
  it('rejects getters and extra approval keys without evaluating accessors', async () => {
    let called = false; const value = input();
    Object.defineProperty(value, 'sqlBytes', { enumerable: true, get() { called = true; throw new Error('SYNTHETIC_NATIVE_SENTINEL'); } });
    await expect(api.createMigrationSqlPlan(value)).rejects.toThrow('SQL_PLAN_INPUT_INVALID'); expect(called).toBe(false);
    const extra = input(); mutable(extra).executionAllowed = true;
    await expect(api.createMigrationSqlPlan(extra)).rejects.toThrow('SQL_PLAN_INPUT_INVALID');
  });
  it('uses actual worker isolation rather than a Promise.race around synchronous WASM', async () => {
    const source = await readFile(moduleUrl, 'utf8');
    expect(source).toContain('new Worker(new URL(import.meta.url)'); expect(source).toContain('worker.terminate()');
    expect(source).toContain('performance.now() >= deadline'); expect(source).not.toContain('Promise.race');
    expect(source).toContain('stdout: true, stderr: true, execArgv: []');
    expect(source).not.toMatch(/console\.|child_process|executeSql|pg_terminate_backend|dbPush/u);
  });
  it('actual finite timer terminates an isolated synthetic busy worker without retry', async () => {
    const source = await readFile(moduleUrl, 'utf8');
    const start = source.indexOf('async function boundedParse(');
    const end = source.indexOf('/** Source-only pinned parser evidence.', start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end).replace('new URL(import.meta.url)', 'new URL("file:///synthetic-parser.mjs")');
    let created = 0; let terminated = 0; let termination: Promise<number> | undefined;
    class BusyWorker extends Worker {
      constructor() {
        super('while (true) {}', { eval: true, stdout: true, stderr: true });
        created += 1;
      }
      override terminate() { terminated += 1; termination = super.terminate(); return termination; }
    }
    // Same production boundedParse control path; replace only parser payload with
    // a synthetic CPU loop. This is not a real DB/driver/cancel or WASM-hang proof.
    const parse = runInNewContext(`${body}\nboundedParse`, {
      Worker: BusyWorker, URL, performance, setTimeout, clearTimeout,
      SQL_PLAN_TIMEOUT_MS: api.SQL_PLAN_TIMEOUT_MS, safeErrors: new WeakMap(),
    }) as (raw: Uint8Array, major: number) => Promise<unknown>;
    const started = performance.now();
    await expect(parse(Buffer.from('synthetic'), 15)).rejects.toThrow('SQL_PLAN_PARSE_TIMEOUT');
    expect(performance.now() - started).toBeGreaterThanOrEqual(api.SQL_PLAN_TIMEOUT_MS - 20);
    expect(created).toBe(1); expect(terminated).toBe(1); expect(termination).toBeDefined();
    expect(await termination).toBe(1);
  }, 20_000);
});

describe('#378 injected AST codec is not parser-owned evidence', () => {
  const sql = Buffer.from("SELECT '한글'; SELECT 2");
  const parsed = (): Parsed => ({ version: 150001, stmts: [
    { stmt: { SelectStmt: {} }, stmt_location: 0, stmt_len: 15 },
    { stmt: { SelectStmt: {} }, stmt_location: 16 },
  ] });
  it('marks a mock AST as unverified and operationally forbidden', () => {
    const result = api.inspectMigrationSqlAst(sql, parsed(), 15);
    expect(result).toMatchObject({ parserEvidenceVerified: false, executionAllowed: false });
    expect(result.statements).toHaveLength(2);
  });
  it.each(['wrong-major', 'overlap', 'negative-location', 'past-end', 'mid-utf8', 'fraction-length', 'nonfinal-zero', 'wrong-semicolon', 'double-node', 'unknown-node', 'nested-control'])('rejects malformed parser extent/type %s', (kind) => {
    const ast = parsed(); const first = ast.stmts[0]; const last = ast.stmts[1];
    if (!first || !last) throw new Error('SYNTHETIC_FIXTURE_MISSING');
    if (kind === 'wrong-major') ast.version = 170004;
    if (kind === 'overlap') last.stmt_location = 12;
    if (kind === 'negative-location') first.stmt_location = -1;
    if (kind === 'past-end') first.stmt_len = 999;
    if (kind === 'mid-utf8') first.stmt_location = 9;
    if (kind === 'fraction-length') first.stmt_len = 1.5;
    if (kind === 'nonfinal-zero') first.stmt_len = 0;
    if (kind === 'wrong-semicolon') first.stmt_len = 14;
    if (kind === 'double-node') mutable(first.stmt).DoStmt = {};
    if (kind === 'unknown-node') first.stmt = { SyntheticUnknownStmt: {} };
    if (kind === 'nested-control') first.stmt = { SelectStmt: { unexpected: { TransactionStmt: {} } } };
    expect(() => api.inspectMigrationSqlAst(sql, ast, 15)).toThrow(/^SQL_PLAN_/u);
  });
});
