import { describe, expect, it, vi } from 'vitest';

const pureModule = '../scripts/db-lint-baseline.mjs';
const runnerModule = '../scripts/check-db-lint-baseline.mjs';
const {
  CATALOG_SQL, EXPECTED_CATALOG, EXPECTED_LINT, EXPECTED_WARNING_COUNT, LOCAL_DB_CONTAINER,
  LOCAL_PROJECT_ID, PROCESS_MAX_BUFFER, PROCESS_TIMEOUT_MS, STRICT_LINT_ARGS,
  validateInstalledCatalog, validateLintBaseline, validateLintStderr, validateLintWarnings,
  validateLocalContainer, validateLocalDockerEndpoint, validateLocalProjectConfig, validateProcessResult,
} = await import(pureModule);
const { runLocalBaselineCheck } = await import(runnerModule);

type Warning = { level: string; message: string; sqlState: string };
type Group = { function: string; issues: Warning[] };
type Catalog = Record<string, unknown>;
type Result = { status: number | null; signal: string | null; error?: Error; stdout: string; stderr: string };
const at = <T>(entries: T[], index: number): T => {
  const entry = entries[index];
  if (entry === undefined) throw new Error('Invalid test fixture index');
  return entry;
};
const warning = (parameter: string): Warning => ({ level: 'warning extra', message: `unused parameter "${parameter}"`, sqlState: '00000' });
// Spell out the approved tuple set independently of implementation constants.
const lintFixture = (): Group[] => [
  { function: 'public.confirm_assignment_duration_policy', issues: [
    'p_expected_version', 'p_standard_minutes', 'p_premium_minutes', 'p_ocean_premium_minutes',
    'p_ocean_family_minutes', 'p_idempotency_key', 'p_request_hash',
  ].map(warning) },
  { function: 'private.assignment_preview_source_reason', issues: [warning('p_duration_minutes')] },
  { function: 'private.assignment_preview_source_reason_before_stay_segments', issues: [warning('p_command_at')] },
];
const catalogFixture = (): Catalog[] => structuredClone(EXPECTED_CATALOG);
const progress = 'Connecting to local database...\nLinting schema: public\nLinting schema: private\n';
const result = (stdout: string, status = 0, stderr = ''): Result => ({ status, signal: null, stdout, stderr });
const valid = () => ({ lint: result(JSON.stringify(lintFixture()), 1, progress), catalog: result(JSON.stringify(catalogFixture())) });
const localConfig = (port = 54322) => `project_id = "${LOCAL_PROJECT_ID}"\n[db]\nport = ${port}\n`;
const containerFixture = (port = 54322) => ({
  name: `/${LOCAL_DB_CONTAINER}`, running: true, project: LOCAL_PROJECT_ID,
  ports: { '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: String(port) }, { HostIp: '::', HostPort: String(port) }] },
});

describe('exact approved DB lint compatibility baseline', () => {
  it('accepts exactly nine warnings while retaining the original strict FAIL and exit 1', () => {
    expect(validateLintBaseline(valid())).toEqual({ rawStrictResult: 'FAIL', rawStrictExitCode: 1, acceptedWarningCount: 9, catalogFunctionCount: 3 });
    expect(EXPECTED_WARNING_COUNT).toBe(9);
    expect(EXPECTED_LINT).toEqual(lintFixture());
    expect(Object.isFrozen(EXPECTED_CATALOG)).toBe(true);
    expect(EXPECTED_CATALOG.every((row: Catalog) => /^[a-f0-9]{32}$/.test(String(row.sourceMd5)))).toBe(true);
    expect(EXPECTED_CATALOG.map((row: Catalog) => row.sourceMd5)).toEqual([
      '5536dad130df79162031d85929d32133', '0a1a56ddfb864a1f4709af5a82075f00', '6645c7dc97faadd39c752bb4846cce0c',
    ]);
  });

  it('accepts group/key/issue ordering differences, without altering data', () => {
    const fixture = lintFixture().reverse().map((group) => ({ issues: group.issues.reverse(), function: group.function }));
    const before = JSON.stringify(fixture);
    expect(validateLintWarnings(before)).toBe(9);
    expect(JSON.stringify(fixture)).toBe(before);
    expect(validateInstalledCatalog(JSON.stringify(catalogFixture().reverse()))).toBe(3);
  });

  it.each([0, 2, 13, 17])('rejects a warning inventory with %i entries', (count) => {
    const fixture = lintFixture();
    if (count < 9) at(fixture, 0).issues = at(fixture, 0).issues.slice(0, Math.max(0, count - 2));
    else fixture.push({ function: 'public.other_function', issues: Array.from({ length: count - 9 }, (_, index) => warning(`p_extra_${index}`)) });
    expect(() => validateLintWarnings(JSON.stringify(fixture))).toThrow('DB lint baseline rejected');
    if (count === 0) expect(() => validateLintWarnings('[]')).toThrow();
  });

  it.each([
    (groups: Group[]) => groups.pop(),
    (groups: Group[]) => groups.push(at(groups, 0)),
    (groups: Group[]) => { groups[1] = at(groups, 0); },
    (groups: Group[]) => { at(groups, 0).function = 'private.confirm_assignment_duration_policy'; },
    (groups: Group[]) => { at(groups, 0).issues[0] = warning('p_actor_profile_id'); },
    (groups: Group[]) => { at(groups, 0).issues[0] = warning('p_name'); },
    (groups: Group[]) => { at(groups, 0).issues[0] = at(at(groups, 0).issues, 1); },
    (groups: Group[]) => { at(at(groups, 0).issues, 0).level = 'warning'; },
    (groups: Group[]) => { at(at(groups, 0).issues, 0).level = 'error'; },
    (groups: Group[]) => { at(at(groups, 0).issues, 0).sqlState = '42601'; },
    (groups: Group[]) => { at(at(groups, 0).issues, 0).message += ' '; },
    (groups: Group[]) => Object.assign(at(groups, 0), { ignored: true }),
    (groups: Group[]) => Object.assign(at(at(groups, 0).issues, 0), { hint: 'additional diagnostic' }),
    (groups: Group[]) => { Reflect.deleteProperty(at(at(groups, 0).issues, 0), 'sqlState'); },
  ])('rejects unknown, missing, duplicate, error or expanded warning tuples (%#)', (mutate) => {
    const fixture = lintFixture(); mutate(fixture);
    expect(() => validateLintWarnings(JSON.stringify(fixture))).toThrow('DB lint baseline rejected');
  });

  it.each(['', 'null', '{}', '{"results":[]}', '[', '[] trailing', 'Connecting to local database...\n[]'])('rejects invalid lint/catalog JSON %j', (raw) => {
    expect(() => validateLintWarnings(raw)).toThrow();
    expect(() => validateInstalledCatalog(raw)).toThrow();
  });

  it.each([
    ['sourceMd5', 'f'.repeat(32)], ['volatility', 'V'], ['returnType', 'jsonb'],
    ['owner', 'service_role'], ['securityDefiner', false], ['settings', ['search_path=public']],
    ['strict', true], ['parallel', 's'], ['leakproof', true], ['language', 'sql'],
    ['defaultCount', 1], ['defaults', 'NULL::integer'], ['kind', 'w'], ['returnsSet', true],
    ['argumentModes', ['i', 'i', 'o']], ['allArgumentTypes', ['public.cleaning_targets', 'integer', 'text']],
    ['variadicType', 'integer'], ['argumentTypes', ['public.cleaning_targets', 'bigint', 'timestamp with time zone']],
    ['argNames', ['p_target', 'p_changed', 'p_command_at']], ['acl', ['postgres=X/postgres', '=X/postgres']],
  ])('rejects installed function %s drift', (field, value) => {
    const fixture = catalogFixture(); at(fixture, 1)[String(field)] = value;
    expect(() => validateInstalledCatalog(JSON.stringify(fixture))).toThrow('installed source or catalog drift');
  });

  it.each([
    (rows: Catalog[]) => rows.pop(),
    (rows: Catalog[]) => rows.push({ ...rows[0], argumentTypes: ['uuid'] }),
    (rows: Catalog[]) => { rows[1] = at(rows, 0); },
    (rows: Catalog[]) => { at(rows, 0).function = 'public.other'; },
    (rows: Catalog[]) => { at(rows, 0).sourceMd5 = 'INVALID'; },
    (rows: Catalog[]) => Object.assign(at(rows, 0), { extension: 'unknown' }),
    (rows: Catalog[]) => Reflect.deleteProperty(at(rows, 0), 'acl'),
  ])('rejects missing/extra functions, overloads and incomplete catalog records (%#)', (mutate) => {
    const fixture = catalogFixture(); mutate(fixture);
    expect(() => validateInstalledCatalog(JSON.stringify(fixture))).toThrow('DB lint baseline rejected');
  });

  it('queries every overload by name in a read-only transaction with exact raw source hashes', () => {
    expect(CATALOG_SQL).toContain('begin read only;');
    expect(CATALOG_SQL).toContain("set local search_path = '';");
    expect(CATALOG_SQL).toContain('pg_catalog.md5(p.prosrc)');
    expect(CATALOG_SQL).toContain('p.proargdefaults');
    expect(CATALOG_SQL).not.toContain('::regprocedure');
    expect(CATALOG_SQL).not.toMatch(/\b(create|alter|update|delete|insert|grant|revoke)\b/i);
  });
});

describe('fail-closed subprocess diagnostics', () => {
  it.each([0, 2, null])('rejects original strict lint exit %j', (status) => {
    const fixture = valid(); fixture.lint.status = status;
    expect(() => validateLintBaseline(fixture)).toThrow('execution failed');
  });
  it.each(['SIGTERM', 'SIGKILL'])('rejects a strict lint signal %s', (signal) => {
    const fixture = valid(); fixture.lint.signal = signal;
    expect(() => validateLintBaseline(fixture)).toThrow('execution failed');
  });
  it.each(['ETIMEDOUT', 'ENOBUFS', 'ENOENT'])('rejects execution errors even with apparently valid output (%s)', (code) => {
    const fixture = valid(); fixture.lint.error = Object.assign(new Error(code), { code });
    expect(() => validateLintBaseline(fixture)).toThrow('execution failed');
  });
  it('rejects unavailable/oversized process streams and nonzero SQL results', () => {
    expect(() => validateProcessResult({ ...result(''), stdout: null }, 0, 'fixture')).toThrow('stdout is unavailable');
    expect(() => validateProcessResult(result('x'.repeat(PROCESS_MAX_BUFFER + 1)), 0, 'fixture')).toThrow('oversized');
    const sqlFailure = valid(); sqlFailure.catalog.status = 1;
    expect(() => validateLintBaseline(sqlFailure)).toThrow('installed function catalog execution failed');
    const sqlStderr = valid(); sqlStderr.catalog.stderr = 'ERROR: catalog query failed\n';
    expect(() => validateLintBaseline(sqlStderr)).toThrow('catalog emitted a diagnostic');
    const truncated = valid(); truncated.catalog.stdout = '[';
    expect(() => validateLintBaseline(truncated)).toThrow('not a complete JSON');
  });

  it('allows only known progress, strict-failure explanation and complete update notices', () => {
    const update = 'A new version of Supabase CLI is available: v2.116.0 (currently installed v2.115.0)\n'
      + 'We recommend updating regularly for new features and bug fixes: https://supabase.com/docs/guides/cli/getting-started#updating-the-supabase-cli\n';
    expect(() => validateLintStderr(progress)).not.toThrow();
    expect(() => validateLintStderr(`${progress}\u001b[31mfail-on is set to warning, non-zero exit\u001b[0m\nTry rerunning the command with --debug to troubleshoot the error.\n${update}`)).not.toThrow();
    expect(() => validateLintStderr(`${progress}${update.split('\n')[0]}\n`)).toThrow('incomplete');
  });
  it.each(['ERROR: connection refused', 'FATAL: database unavailable', 'panic: unexpected state', 'sqlState: 42601', 'unknown message', '\u001b[2J', 'Connecting to remote database...'])('rejects unrecognized stderr %s', (diagnostic) => {
    expect(() => validateLintStderr(`${progress}${diagnostic}\n`)).toThrow('unrecognized diagnostic');
  });
  it('rejects missing local progress and duplicate known diagnostics', () => {
    expect(() => validateLintStderr('')).toThrow('missing local schema progress');
    expect(() => validateLintStderr(`${progress}Linting schema: private\n`)).toThrow('duplicate');
  });
});

describe('fixed local runner without real Docker, Supabase or DB execution', () => {
  const harness = () => {
    const writes = { stdout: '', stderr: '' };
    const outputs: Result[] = [
      result(JSON.stringify('unix:///var/run/docker.sock')),
      result(JSON.stringify(containerFixture())),
      valid().lint, valid().catalog,
    ];
    const spawnSyncImpl = vi.fn(() => outputs.shift());
    const readFileSyncImpl = vi.fn((file: string) => file.endsWith('config.toml') ? localConfig()
      : file.includes('node_modules') ? JSON.stringify({ name: 'supabase', version: '2.115.0' })
      : JSON.stringify({ devDependencies: { supabase: '2.115.0' } }));
    const options = { spawnSyncImpl, readFileSyncImpl, env: {}, args: [],
      stdout: { write: (text: string) => { writes.stdout += text; } },
      stderr: { write: (text: string) => { writes.stderr += text; } } };
    return { writes, outputs, spawnSyncImpl, readFileSyncImpl, options };
  };
  it('runs only the pinned local command and local read-only catalog with bounded capture and visible raw FAIL', () => {
    const h = harness();
    expect(runLocalBaselineCheck(h.options).acceptedWarningCount).toBe(9);
    expect(h.spawnSyncImpl).toHaveBeenCalledTimes(4);
    const calls = h.spawnSyncImpl.mock.calls as unknown as [string, string[], Record<string, unknown>][];
    expect(at(calls, 2)[0]).toBe(process.execPath);
    expect(at(calls, 2)[1].slice(1, 3)).toEqual(['--workdir', at(calls, 2)[2].cwd]);
    expect(at(calls, 2)[1].slice(3)).toEqual(STRICT_LINT_ARGS);
    expect(at(calls, 2)[1][0]).toMatch(/node_modules[\\/]supabase[\\/]dist[\\/]supabase\.js$/);
    expect(at(calls, 2)[2].env).toEqual({
      DOCKER_CONTEXT: 'default', DOCKER_HOST: 'unix:///var/run/docker.sock',
      SUPABASE_PROJECT_ID: LOCAL_PROJECT_ID, SUPABASE_DB_PORT: '54322', SUPABASE_SERVICES_HOSTNAME: '127.0.0.1',
    });
    expect(at(calls, 0)[2].env).toEqual({});
    expect(at(calls, 3)[2].env).toEqual({});
    expect(h.options.env).toEqual({});
    expect(at(calls, 3)[1]).toEqual(['--context', 'default', 'exec', LOCAL_DB_CONTAINER, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-c', CATALOG_SQL]);
    for (const [, commandArgs, options] of calls) {
      expect(commandArgs).not.toContain('--linked'); expect(commandArgs).not.toContain('--db-url');
      expect(options).toMatchObject({ shell: false, encoding: 'utf8', windowsHide: true, timeout: PROCESS_TIMEOUT_MS, maxBuffer: PROCESS_MAX_BUFFER });
    }
    expect(h.writes.stdout).toContain(JSON.stringify(lintFixture()));
    expect(h.writes.stderr).toContain(progress);
    expect(h.writes.stdout).toContain('original strict lint exit=1 signal=none');
    expect(h.writes.stdout).toContain('Original strict lint remains FAIL, exit 1');
    expect(h.writes.stdout).not.toContain('Original strict lint: PASS');
  });
  it('keeps all raw lint streams visible on rejection', () => {
    const h = harness(); at(h.outputs, 2).stderr += 'FATAL: synthetic failure\n';
    expect(() => runLocalBaselineCheck(h.options)).toThrow('unrecognized diagnostic');
    expect(h.writes.stdout).toContain(JSON.stringify(lintFixture()));
    expect(h.writes.stderr).toContain('FATAL: synthetic failure\n');
    expect(h.writes.stdout).not.toContain('DB lint baseline: PASS');
  });
  it.each(['--linked', '--db-url', '--schema', '--target'])('rejects command-line overrides %s before executing', (argument) => {
    const h = harness();
    expect(() => runLocalBaselineCheck({ ...h.options, args: [argument] })).toThrow('accepts no arguments');
    expect(h.spawnSyncImpl).not.toHaveBeenCalled();
  });
  it.each(['SUPABASE_CLI_BINARY_OVERRIDE', 'SUPABASE_WORKDIR', 'SUPABASE_PROJECT_ID', 'SUPABASE_DB_PORT', 'SUPABASE_SERVICES_HOSTNAME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'])('rejects environment override %s before executing', (variable) => {
    const h = harness();
    expect(() => runLocalBaselineCheck({ ...h.options, env: { [variable]: 'override' } })).toThrow('environment override');
    expect(h.spawnSyncImpl).not.toHaveBeenCalled();
  });
  it.each([
    'project_id = "other-project"\n', 'project_id = "room-management-system-backend"\nproject_id = "other"\n',
  ])('rejects project config mismatch before executing', (config) => {
    const h = harness(); h.readFileSyncImpl.mockImplementation(() => config);
    expect(() => runLocalBaselineCheck(h.options)).toThrow('project_id differs');
    expect(h.spawnSyncImpl).not.toHaveBeenCalled();
  });
  it.each(['2.114.0', '^2.115.0', 'latest'])('rejects an unpinned or different CLI version %s', (version) => {
    const h = harness(); h.readFileSyncImpl.mockImplementation((file: string) => file.endsWith('config.toml') ? localConfig()
      : file.includes('node_modules') ? JSON.stringify({ name: 'supabase', version })
      : JSON.stringify({ devDependencies: { supabase: version } }));
    expect(() => runLocalBaselineCheck(h.options)).toThrow('pinned and installed');
    expect(h.spawnSyncImpl).not.toHaveBeenCalled();
  });
  it.each(['unix:///var/run/docker.sock', 'npipe:////./pipe/docker_engine', 'npipe:////./pipe/dockerDesktopLinuxEngine'])('accepts local engine endpoint %s', (endpoint) => {
    expect(() => validateLocalDockerEndpoint(JSON.stringify(endpoint))).not.toThrow();
  });
  it.each(['unix:///var/run/docker.sock', 'npipe:////./pipe/docker_engine', 'npipe:////./pipe/dockerDesktopLinuxEngine'])('binds only strict CLI to the verified local engine %s', (endpoint) => {
    const h = harness(); at(h.outputs, 0).stdout = JSON.stringify(endpoint);
    const env = { PATH: 'synthetic inherited path' };
    runLocalBaselineCheck({ ...h.options, env });
    const calls = h.spawnSyncImpl.mock.calls as unknown as [string, string[], { env: Record<string, string> }][];
    expect(at(calls, 2)[2].env).toEqual({
      ...env, DOCKER_CONTEXT: 'default', DOCKER_HOST: endpoint,
      SUPABASE_PROJECT_ID: LOCAL_PROJECT_ID, SUPABASE_DB_PORT: '54322', SUPABASE_SERVICES_HOSTNAME: '127.0.0.1',
    });
    for (const index of [0, 1, 3]) expect(at(calls, index)[2].env).toEqual(env);
    expect(env).toEqual({ PATH: 'synthetic inherited path' });
  });
  it.each(['tcp://127.0.0.1:2375', 'ssh://example.invalid', 'tcp://remote:2376', 'unix:///other.sock'])('rejects non-approved Docker endpoint %s', (endpoint) => {
    expect(() => validateLocalDockerEndpoint(JSON.stringify(endpoint))).toThrow('not an approved local');
    const h = harness(); at(h.outputs, 0).stdout = JSON.stringify(endpoint);
    expect(() => runLocalBaselineCheck(h.options)).toThrow('not an approved local');
    expect(h.spawnSyncImpl).toHaveBeenCalledTimes(1);
  });
  it.each([
    { ...containerFixture(), name: '/other' },
    { ...containerFixture(), running: false },
    { ...containerFixture(), project: 'other' },
    { name: `/${LOCAL_DB_CONTAINER}`, running: true, ports: containerFixture().ports },
  ])('rejects mismatched/stopped local DB identity', (identity) => {
    expect(() => validateLocalContainer(JSON.stringify(identity), 54322)).toThrow();
    const h = harness(); at(h.outputs, 1).stdout = JSON.stringify(identity);
    expect(() => runLocalBaselineCheck(h.options)).toThrow();
    expect(h.spawnSyncImpl).toHaveBeenCalledTimes(2);
  });

  it('extracts only the explicit db.port and preserves a matching nondefault local port', () => {
    expect(validateLocalProjectConfig(`${localConfig()}\n[db.pooler]\nport = 54329\n`)).toEqual({ projectId: LOCAL_PROJECT_ID, dbPort: 54322 });
    expect(validateLocalProjectConfig(localConfig(55432).replace(/\n/g, '\r\n'))).toEqual({ projectId: LOCAL_PROJECT_ID, dbPort: 55432 });
    expect(() => validateLocalContainer(JSON.stringify(containerFixture(55432)), 55432)).not.toThrow();
    const h = harness(); at(h.outputs, 1).stdout = JSON.stringify(containerFixture(55432));
    h.readFileSyncImpl.mockImplementation((file: string) => file.endsWith('config.toml') ? localConfig(55432)
      : file.includes('node_modules') ? JSON.stringify({ name: 'supabase', version: '2.115.0' })
      : JSON.stringify({ devDependencies: { supabase: '2.115.0' } }));
    expect(runLocalBaselineCheck(h.options).acceptedWarningCount).toBe(9);
    const calls = h.spawnSyncImpl.mock.calls as unknown as [string, string[], { env: Record<string, string> }][];
    expect(at(calls, 2)[2].env).toEqual({
      DOCKER_CONTEXT: 'default', DOCKER_HOST: 'unix:///var/run/docker.sock',
      SUPABASE_PROJECT_ID: LOCAL_PROJECT_ID, SUPABASE_DB_PORT: '55432', SUPABASE_SERVICES_HOSTNAME: '127.0.0.1',
    });
  });

  it.each([
    `project_id = "${LOCAL_PROJECT_ID}"\n`,
    `project_id = "${LOCAL_PROJECT_ID}"\n[db.pooler]\nport = 54322\n`,
    `${localConfig()}port = 55432\n`,
    `${localConfig()}[db]\nport = 54322\n`,
    ...['0', '65536', '-1', '54322.0', '"54322"', 'env(PORT)', '054322'].map((port) => `project_id = "${LOCAL_PROJECT_ID}"\n[db]\nport = ${port}\n`),
  ])('rejects missing, duplicate or malformed explicit db.port (%#)', (config) => {
    expect(() => validateLocalProjectConfig(config)).toThrow('DB lint baseline rejected');
    const h = harness(); h.readFileSyncImpl.mockImplementation(() => config);
    expect(() => runLocalBaselineCheck(h.options)).toThrow('DB lint baseline rejected');
    expect(h.spawnSyncImpl).not.toHaveBeenCalled();
  });

  it.each([
    {}, null,
    { '5432/tcp': null }, { '5432/tcp': [] },
    { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '54323' }] },
    { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: 54322 }] },
    { '5432/tcp': [{ HostIp: '192.0.2.10', HostPort: '54322' }] },
    { '5432/tcp': [{ HostPort: '54322' }] },
    { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '54322', extra: true }] },
    { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '54322' }, { HostIp: '::', HostPort: '54323' }] },
    { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '54322' }, { HostIp: '127.0.0.1', HostPort: '54322' }] },
    { ...containerFixture().ports, '6432/tcp': null },
    { '5432/udp': [{ HostIp: '127.0.0.1', HostPort: '54322' }] },
  ])('rejects missing, additional or mismatched published container ports (%#)', (ports) => {
    const identity = { ...containerFixture(), ports };
    expect(() => validateLocalContainer(JSON.stringify(identity), 54322)).toThrow('DB lint baseline rejected');
    const h = harness(); at(h.outputs, 1).stdout = JSON.stringify(identity);
    expect(() => runLocalBaselineCheck(h.options)).toThrow('DB lint baseline rejected');
    expect(h.spawnSyncImpl).toHaveBeenCalledTimes(2);
  });
  it.each([0, 65536, -1, 54322.5, '54322', null])('rejects invalid configured container validation port %j', (port) => {
    expect(() => validateLocalContainer(JSON.stringify(containerFixture()), port)).toThrow('configured local DB port is invalid');
  });
});
