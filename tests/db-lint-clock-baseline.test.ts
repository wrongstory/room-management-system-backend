import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const modulePath = '../scripts/db-lint-baseline.mjs';
const runnerPath = '../scripts/check-db-lint-baseline.mjs';
const {
  CATALOG_SQL, CLOCK_EXPECTED_CATALOG, CLOCK_EXPECTED_LINT, EXPECTED_CATALOG, EXPECTED_LINT,
  FINAL_CATALOG_SQL, FINAL_EXPECTED_CATALOG, FINAL_EXPECTED_LINT, FINAL_EXPECTED_WARNING_COUNT,
  LOCAL_DB_CONTAINER, PROCESS_MAX_BUFFER, PROCESS_TIMEOUT_MS, STRICT_LINT_ARGS,
  validateFinalInstalledCatalog, validateFinalLintBaseline, validateFinalLintWarnings, validateLintBaseline,
} = await import(modulePath);
const { runLocalBaselineCheck, runLocalHistoricalCompatibilityCheck } = await import(runnerPath);
type Row = Record<string, unknown>;
type Diagnostic = { level: string; message: string; sqlState: string; statement: { lineNumber: string; text: string }; hint: string; detail: string; context?: string };
type Group = { function: string; issues: Diagnostic[] };
const read = (path: string) => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
// Exact ten diagnostic records from failed run41353299781, not an observed
// post-correction PASS. These optional fields and locations are all significant.
const clockFixture = (): Group[] => JSON.parse(read('tests/fixtures/db-lint-clock-558.json'));
const finalLint = () => [...structuredClone(EXPECTED_LINT), ...clockFixture()];
const finalCatalog = (): Row[] => structuredClone(FINAL_EXPECTED_CATALOG);
const progress = 'Connecting to local database...\nLinting schema: public\nLinting schema: private\n';
const result = (stdout: string, status = 0, stderr = '') => ({ status, signal: null as string | null, stdout, stderr });
const valid = () => ({ lint: result(JSON.stringify(finalLint()), 1, progress), catalog: result(JSON.stringify(finalCatalog())) });
const index = <T>(rows: T[], at: number): T => {
  const value = rows[at]; if (value === undefined) throw new Error('Missing fixed fixture'); return value;
};

describe('#558 exact clock guard policy, without DB execution', () => {
  it('keeps historical3/9 unchanged and requires all six groups/nineteen warnings for final input', () => {
    expect(FINAL_EXPECTED_WARNING_COUNT).toBe(19);
    expect(CLOCK_EXPECTED_LINT).toEqual(clockFixture().sort((a, b) =>
      CLOCK_EXPECTED_LINT.findIndex((row: Row) => row.function === a.function)
      - CLOCK_EXPECTED_LINT.findIndex((row: Row) => row.function === b.function)));
    expect(FINAL_EXPECTED_CATALOG.slice(0, 3)).toEqual(EXPECTED_CATALOG);
    expect(FINAL_EXPECTED_LINT.slice(0, 3)).toEqual(EXPECTED_LINT);
    expect(validateFinalLintBaseline(valid())).toEqual({ rawStrictResult: 'FAIL', rawStrictExitCode: 1, acceptedWarningCount: 19, catalogFunctionCount: 6 });
    expect(() => validateFinalLintWarnings(JSON.stringify(EXPECTED_LINT))).toThrow('six approved');
    expect(() => validateLintBaseline(valid())).toThrow('three approved');
    expect(Object.isFrozen(CLOCK_EXPECTED_CATALOG)).toBe(true);
    expect(Object.isFrozen(CLOCK_EXPECTED_LINT[0].issues[0].statement)).toBe(true);
  });

  it('allows only order differences and never changes the raw diagnostic records', () => {
    const fixture = finalLint().reverse().map((group: Group) => ({ issues: [...group.issues].reverse(), function: group.function }));
    const original = JSON.stringify(fixture);
    expect(validateFinalLintWarnings(original)).toBe(19);
    expect(JSON.stringify(fixture)).toBe(original);
    expect(validateFinalInstalledCatalog(JSON.stringify(finalCatalog().reverse()))).toBe(6);
  });

  const scalarPaths = ['level', 'message', 'sqlState', 'hint', 'detail', 'statement.lineNumber', 'statement.text', 'context'];
  const mutations = clockFixture().flatMap((group, groupIndex) => group.issues.flatMap((issue, issueIndex) =>
    scalarPaths.filter(path => path !== 'context' || issue.context !== undefined)
      .map(path => ({ groupIndex, issueIndex, path, name: `${group.function}:${issue.statement.lineNumber}:${path}` }))));
  it.each(mutations)('rejects any changed exact warning field $name', ({ groupIndex, issueIndex, path }) => {
    const clocks = clockFixture();
    const issue = index(index(clocks, groupIndex).issues, issueIndex);
    if (path === 'statement.lineNumber') issue.statement.lineNumber += '0';
    else if (path === 'statement.text') issue.statement.text += ' changed';
    else (issue as unknown as Row)[path] = `${(issue as unknown as Row)[path]} changed`;
    expect(() => validateFinalLintWarnings(JSON.stringify([...EXPECTED_LINT, ...clocks]))).toThrow('changed warning');
  });

  it.each([
    (issue: Row) => { delete issue.hint; },
    (issue: Row) => { delete issue.detail; },
    (issue: Row) => { delete issue.statement; },
    (issue: Row) => { issue.context = 'new context'; },
    (issue: Row) => { issue.unrecognized = true; },
    (issue: Row) => { (issue.statement as Row).lineNumber = 30; },
    (issue: Row) => { (issue.statement as Row).additional = 'ignored?'; },
    (issue: Row) => { issue.level = 'error'; },
  ])('rejects missing, new, wrongly typed or nested diagnostic fields (%#)', mutate => {
    const clocks = clockFixture();
    mutate(index(index(clocks, 0).issues, 0) as unknown as Row);
    expect(() => validateFinalLintWarnings(JSON.stringify([...EXPECTED_LINT, ...clocks]))).toThrow();
  });

  it.each([
    (rows: Group[]) => rows.pop(),
    (rows: Group[]) => rows.push(index(rows, 0)),
    (rows: Group[]) => { rows[1] = index(rows, 0); },
    (rows: Group[]) => { index(rows, 0).function = 'public.collect_developer_reset_inventory'; },
    (rows: Group[]) => { index(rows, 0).issues.pop(); },
    (rows: Group[]) => { index(rows, 0).issues.push(index(index(rows, 0).issues, 0)); },
    (rows: Group[]) => { index(rows, 0).issues[1] = index(index(rows, 0).issues, 0); },
  ])('rejects missing/extra/duplicate function and warning inventories (%#)', mutate => {
    const clocks = clockFixture(); mutate(clocks);
    expect(() => validateFinalLintWarnings(JSON.stringify([...EXPECTED_LINT, ...clocks]))).toThrow();
  });

  const catalogMutations: [string, unknown][] = [
    ['sourceMd5', '0'.repeat(32)], ['sourceSha256', '0'.repeat(64)], ['function', 'private.other'],
    ['argumentTypes', ['text']], ['argNames', ['p_input']], ['volatility', 'V'], ['returnType', 'text'],
    ['owner', 'service_role'], ['acl', ['postgres=X/postgres', '=X/postgres']], ['securityDefiner', false],
    ['settings', ['search_path=pg_catalog', 'lock_timeout=3s']], ['strict', true], ['parallel', 's'],
    ['leakproof', true], ['language', 'sql'], ['defaultCount', 1], ['defaults', 'NULL::text'],
    ['kind', 'p'], ['returnsSet', true], ['argumentModes', ['i']], ['allArgumentTypes', ['text']],
    ['variadicType', 'text'], ['cost', 1], ['rows', 1], ['support', 'custom_support'], ['binary', 'other'],
  ];
  it.each([0, 1, 2].flatMap(collector => catalogMutations.map(([field, value]) => ({ collector, field, value }))))(
    'rejects installed collector $collector catalog/body drift in $field', ({ collector, field, value }) => {
      const rows = finalCatalog(); index(rows, 3 + collector)[field] = value;
      expect(() => validateFinalInstalledCatalog(JSON.stringify(rows))).toThrow();
    });
  it.each([
    (rows: Row[]) => rows.pop(), (rows: Row[]) => rows.push({ ...index(rows, 3), argumentTypes: ['uuid'] }),
    (rows: Row[]) => { rows[4] = index(rows, 3); }, (rows: Row[]) => { delete index(rows, 3).sourceSha256; },
    (rows: Row[]) => { index(rows, 3).unexpected = true; }, (rows: Row[]) => { rows[3] = null as unknown as Row; },
  ])('rejects overloads, unknown, duplicated or incomplete catalog rows (%#)', mutate => {
    const rows = finalCatalog(); mutate(rows);
    expect(() => validateFinalInstalledCatalog(JSON.stringify(rows))).toThrow();
  });

  it.each(['', 'null', '{}', '[', '[] trailing', 'warning\n[]', 'x'.repeat(PROCESS_MAX_BUFFER + 1)])('rejects malformed or oversized JSON (%#)', raw => {
    expect(() => validateFinalLintWarnings(raw)).toThrow();
    expect(() => validateFinalInstalledCatalog(raw)).toThrow();
  });
  it.each([0, 2, null])('keeps original strict non-PASS semantics for exit %j', status => {
    const fixture = valid(); fixture.lint.status = status as number;
    expect(() => validateFinalLintBaseline(fixture)).toThrow('execution failed');
  });
  it('rejects cancellation, execution failure and catalog errors even with exact expected JSON', () => {
    const stopped = valid(); stopped.lint.signal = 'SIGTERM';
    expect(() => validateFinalLintBaseline(stopped)).toThrow('execution failed');
    const failed = valid(); Object.assign(failed.lint, { error: new Error('synthetic') });
    expect(() => validateFinalLintBaseline(failed)).toThrow('execution failed');
    const catalogError = valid(); catalogError.catalog.stderr = 'synthetic error';
    expect(() => validateFinalLintBaseline(catalogError)).toThrow('emitted a diagnostic');
  });

  it('binds all three exact LF function bodies from their latest append definitions', () => {
    const files = readdirSync('supabase/migrations').filter(path => path.endsWith('.sql')).sort();
    for (const row of CLOCK_EXPECTED_CATALOG as Row[]) {
      const name = String(row.function).replaceAll('.', '\\.');
      const pattern = new RegExp(`create (?:or replace )?function ${name}\\(\\)[\\s\\S]*?\\bas \\$\\$([\\s\\S]*?)\\$\\$;`, 'gi');
      const matches = files.flatMap(file => [...read(`supabase/migrations/${file}`).matchAll(pattern)]);
      const body = matches.at(-1)?.[1];
      expect(body).toBeDefined();
      expect(createHash('md5').update(body ?? '').digest('hex')).toBe(row.sourceMd5);
      expect(createHash('sha256').update(body ?? '').digest('hex')).toBe(row.sourceSha256);
    }
  });

  it.each([15, 17])('parses fixed read-only catalog SQL with PostgreSQL%i outer grammar', async version => {
    const require = createRequire(import.meta.url);
    const parser = require(`@pgsql/parser/v${version}`);
    expect((await parser.parse(FINAL_CATALOG_SQL)).stmts).toHaveLength(4);
    for (const row of CLOCK_EXPECTED_CATALOG as Row[]) expect(FINAL_CATALOG_SQL).toContain(String(row.function).split('.')[1]);
    expect(FINAL_CATALOG_SQL).toContain("extensions.digest(p.prosrc, 'sha256')");
    expect(FINAL_CATALOG_SQL).not.toContain('::regprocedure');
    expect(FINAL_CATALOG_SQL).not.toMatch(/\b(create|alter|update|delete|insert|grant|revoke)\b/i);
  });
});

describe('distinct fixed final and historical child entry points', () => {
  const harness = (historical = false) => {
    const env = {};
    const outputs = [result('"unix:///var/run/docker.sock"'), result(JSON.stringify({
      name: `/${LOCAL_DB_CONTAINER}`, running: true, project: 'room-management-system-backend',
      ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '54322' }] },
    })), historical ? result(JSON.stringify(EXPECTED_LINT), 1, progress) : valid().lint,
    historical ? result(JSON.stringify(EXPECTED_CATALOG)) : valid().catalog];
    const spawnSyncImpl = vi.fn(() => outputs.shift());
    const options = { env, args: [], spawnSyncImpl,
      readFileSyncImpl: (file: string) => file.endsWith('config.toml')
        ? 'project_id = "room-management-system-backend"\n[db]\nport = 54322\n'
        : file.includes('node_modules') ? '{"name":"supabase","version":"2.115.0"}' : '{"devDependencies":{"supabase":"2.115.0"}}',
      stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
    return { options, spawnSyncImpl };
  };
  it('runs final19 and historical9 separately with four unchanged bounded local calls', () => {
    for (const historical of [false, true]) {
      const h = harness(historical);
      const accepted = (historical ? runLocalHistoricalCompatibilityCheck : runLocalBaselineCheck)(h.options);
      expect(accepted.acceptedWarningCount).toBe(historical ? 9 : 19);
      expect(h.spawnSyncImpl).toHaveBeenCalledTimes(4);
      const calls = h.spawnSyncImpl.mock.calls as unknown as [string, string[], Row][];
      expect(index(calls, 2)[1].slice(3)).toEqual(STRICT_LINT_ARGS);
      expect(index(calls, 3)[1].at(-1)).toBe(historical ? CATALOG_SQL : FINAL_CATALOG_SQL);
      for (const call of calls) expect(call[2]).toMatchObject({ timeout: PROCESS_TIMEOUT_MS, maxBuffer: PROCESS_MAX_BUFFER, windowsHide: true, shell: false });
    }
  });
  it('never accepts old9 as a fallback in final or final19 in the historical gate', () => {
    expect(() => runLocalBaselineCheck(harness(true).options)).toThrow('six approved');
    expect(() => runLocalHistoricalCompatibilityCheck(harness(false).options)).toThrow('three approved');
  });
  it.each(['--historical', '--compatibility', '--policy=9'])('does not expose a command-line policy switch %s', argument => {
    const h = harness();
    expect(() => runLocalBaselineCheck({ ...h.options, args: [argument] })).toThrow('accepts no arguments');
    expect(h.spawnSyncImpl).not.toHaveBeenCalled();
  });
  it('retains the historical child timeout and keeps package/CI on the final entry point', () => {
    const historical = read('scripts/test-db-static-warning-upgrade.mjs');
    expect(historical).toContain("[join(root, 'scripts/check-db-lint-compatibility-baseline.mjs')], { cwd: root, stdio: 'inherit', timeout: 90000 }");
    expect(historical).not.toContain("'scripts/check-db-lint-baseline.mjs'");
    expect(JSON.parse(read('package.json')).scripts['db:lint:baseline']).toBe('node scripts/check-db-lint-baseline.mjs');
    expect(read('.github/workflows/quality.yml')).toContain('npm run db:lint:baseline');
  });
});
