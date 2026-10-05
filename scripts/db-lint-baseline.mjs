// #363/#373: this is an exact exception for retired compatibility parameters.
// It never changes or claims PASS for the original strict Supabase command.
export const SUPABASE_CLI_VERSION = '2.115.0';
export const LOCAL_PROJECT_ID = 'room-management-system-backend';
export const LOCAL_DB_CONTAINER = `supabase_db_${LOCAL_PROJECT_ID}`;
export const PROCESS_TIMEOUT_MS = 120_000;
export const PROCESS_MAX_BUFFER = 4 * 1024 * 1024;
export const STRICT_LINT_ARGS = Object.freeze([
  'db', 'lint', '--local', '--schema', 'public,private',
  '--level', 'warning', '--fail-on', 'warning', '--output', 'json',
]);

const freeze = (value) => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
const compatibilityArguments = ['public.cleaning_targets', 'integer', 'timestamp with time zone'];
const compatibilityArgNames = ['p_target', 'p_duration_minutes', 'p_command_at'];
const commonCatalog = {
  owner: 'postgres', securityDefiner: true, settings: ['search_path=""'],
  strict: false, parallel: 'u', leakproof: false, language: 'plpgsql',
  defaultCount: 0, defaults: null, kind: 'f', returnsSet: false,
  argumentModes: null, allArgumentTypes: null, variadicType: null,
};
export const EXPECTED_CATALOG = freeze([
  {
    ...commonCatalog,
    function: 'public.confirm_assignment_duration_policy',
    argumentTypes: ['uuid', 'bigint', 'integer', 'integer', 'integer', 'integer', 'text', 'text'],
    argNames: ['p_actor_profile_id', 'p_expected_version', 'p_standard_minutes', 'p_premium_minutes',
      'p_ocean_premium_minutes', 'p_ocean_family_minutes', 'p_idempotency_key', 'p_request_hash'],
    sourceMd5: '5536dad130df79162031d85929d32133',
    volatility: 'V', returnType: 'jsonb', acl: ['postgres=X/postgres', 'service_role=X/postgres'],
  },
  {
    ...commonCatalog,
    function: 'private.assignment_preview_source_reason',
    argumentTypes: compatibilityArguments, argNames: compatibilityArgNames,
    sourceMd5: '0a1a56ddfb864a1f4709af5a82075f00',
    volatility: 'S', returnType: 'text', acl: ['postgres=X/postgres'],
  },
  {
    ...commonCatalog,
    function: 'private.assignment_preview_source_reason_before_stay_segments',
    argumentTypes: compatibilityArguments, argNames: compatibilityArgNames,
    sourceMd5: '6645c7dc97faadd39c752bb4846cce0c',
    volatility: 'S', returnType: 'text', acl: ['postgres=X/postgres'],
  },
]);
const issue = (parameter) => ({
  level: 'warning extra', message: `unused parameter "${parameter}"`, sqlState: '00000',
});
export const EXPECTED_LINT = freeze([
  { function: 'public.confirm_assignment_duration_policy', issues: EXPECTED_CATALOG[0].argNames.slice(1).map(issue) },
  { function: 'private.assignment_preview_source_reason', issues: [issue('p_duration_minutes')] },
  { function: 'private.assignment_preview_source_reason_before_stay_segments', issues: [issue('p_command_at')] },
]);
export const EXPECTED_WARNING_COUNT = 9;

// Filter by names, not regprocedure, so an unexpected overload is also returned
// and rejected. No runtime role gets EXECUTE or direct access from this query.
export const CATALOG_SQL = `
begin read only;
set local search_path = '';
select coalesce(jsonb_agg(catalog order by catalog->>'function', catalog->>'argumentTypes'), '[]'::jsonb)
from (
  select jsonb_build_object(
    'function', n.nspname || '.' || p.proname,
    'argumentTypes', (select coalesce(jsonb_agg(pg_catalog.format_type(arg.type, null) order by arg.ordinality), '[]'::jsonb)
      from unnest(p.proargtypes) with ordinality as arg(type, ordinality)),
    'argNames', p.proargnames,
    'sourceMd5', pg_catalog.md5(p.prosrc),
    'volatility', upper(p.provolatile::text),
    'returnType', pg_catalog.format_type(p.prorettype, null),
    'acl', (select jsonb_agg(permission::text order by permission::text) from unnest(p.proacl) as permission),
    'owner', pg_catalog.pg_get_userbyid(p.proowner),
    'securityDefiner', p.prosecdef,
    'settings', p.proconfig,
    'strict', p.proisstrict,
    'parallel', p.proparallel::text,
    'leakproof', p.proleakproof,
    'language', l.lanname,
    'defaultCount', p.pronargdefaults,
    'defaults', pg_catalog.pg_get_expr(p.proargdefaults, 0),
    'kind', p.prokind::text,
    'returnsSet', p.proretset,
    'argumentModes', p.proargmodes,
    'allArgumentTypes', (select jsonb_agg(pg_catalog.format_type(arg.type, null) order by arg.ordinality)
      from unnest(p.proallargtypes) with ordinality as arg(type, ordinality)),
    'variadicType', case when p.provariadic = 0 then null else pg_catalog.format_type(p.provariadic, null) end
  ) as catalog
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  join pg_catalog.pg_language l on l.oid = p.prolang
  where (n.nspname = 'public' and p.proname = 'confirm_assignment_duration_policy')
    or (n.nspname = 'private' and p.proname in (
      'assignment_preview_source_reason', 'assignment_preview_source_reason_before_stay_segments'))
) as functions;
rollback;
`;

const fail = (message) => { throw new Error(`DB lint baseline rejected: ${message}`); };
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, expected, label) => {
  if (!isRecord(value) || Object.keys(value).sort().join('\0') !== [...expected].sort().join('\0')) {
    fail(`${label} has missing or additional fields`);
  }
};
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
};
const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const parseArray = (raw, label) => {
  if (typeof raw !== 'string' || raw.length === 0 || Buffer.byteLength(raw) > PROCESS_MAX_BUFFER) fail(`${label} is empty or oversized`);
  let parsed;
  try { parsed = JSON.parse(raw); } catch { fail(`${label} is not a complete JSON document`); }
  if (!Array.isArray(parsed)) fail(`${label} must be a JSON array`);
  return parsed;
};

export function validateProcessResult(result, expectedStatus, label) {
  if (!isRecord(result) || result.error != null || result.signal != null || result.status !== expectedStatus) {
    fail(`${label} execution failed or exited with unexpected status (expected ${expectedStatus})`);
  }
  for (const stream of ['stdout', 'stderr']) {
    if (typeof result[stream] !== 'string' || Buffer.byteLength(result[stream]) > PROCESS_MAX_BUFFER) {
      fail(`${label} ${stream} is unavailable or oversized`);
    }
  }
}

export function validateLintStderr(raw) {
  if (typeof raw !== 'string') fail('strict lint stderr is unavailable');
  // Strip only known ANSI styling for validation; the runner prints raw bytes.
  const styling = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
  const lines = raw.replace(styling, '').split(/\r?\n/).filter((line) => line.length > 0);
  const fixed = new Set([
    'Connecting to local database...', 'Linting schema: public', 'Linting schema: private',
    'fail-on is set to warning, non-zero exit',
    'Try rerunning the command with --debug to troubleshoot the error.',
  ]);
  const mandatory = ['Connecting to local database...', 'Linting schema: public', 'Linting schema: private'];
  const seen = new Set();
  for (const line of lines) {
    if (!fixed.has(line)
      && !/^A new version of Supabase CLI is available: v\d+\.\d+\.\d+ \(currently installed v2\.115\.0\)$/.test(line)
      && line !== 'We recommend updating regularly for new features and bug fixes: https://supabase.com/docs/guides/cli/getting-started#updating-the-supabase-cli') {
      fail('strict lint stderr contains an unrecognized diagnostic');
    }
    if (seen.has(line)) fail('strict lint stderr contains a duplicate diagnostic');
    seen.add(line);
  }
  if (mandatory.some((line) => !seen.has(line))) fail('strict lint stderr is missing local schema progress');
  const update = lines.some((line) => line.startsWith('A new version of Supabase CLI is available:'));
  const advice = seen.has('We recommend updating regularly for new features and bug fixes: https://supabase.com/docs/guides/cli/getting-started#updating-the-supabase-cli');
  if (update !== advice) fail('strict lint stderr has an incomplete CLI update notice');
}

export function validateLintWarnings(raw) {
  const groups = parseArray(raw, 'strict lint stdout');
  if (groups.length !== EXPECTED_LINT.length) fail('strict lint must contain exactly the three approved function groups');
  const seen = new Set();
  let warningCount = 0;
  for (const group of groups) {
    exactKeys(group, ['function', 'issues'], 'lint function group');
    const expected = EXPECTED_LINT.find((entry) => entry.function === group.function);
    if (!expected || seen.has(group.function)) fail('lint contains an unknown or duplicate function');
    seen.add(group.function);
    if (!Array.isArray(group.issues) || group.issues.length !== expected.issues.length) fail(`unexpected warning count for ${group.function}`);
    const issuesSeen = new Set();
    for (const actual of group.issues) {
      exactKeys(actual, ['level', 'message', 'sqlState'], 'lint warning');
      const key = JSON.stringify(canonical(actual));
      if (issuesSeen.has(key) || !expected.issues.some((allowed) => same(actual, allowed))) fail(`unknown or duplicate warning for ${group.function}`);
      issuesSeen.add(key);
      warningCount++;
    }
  }
  if (warningCount !== EXPECTED_WARNING_COUNT) fail('strict lint must contain exactly nine approved warnings');
  return warningCount;
}

export function validateInstalledCatalog(raw) {
  const rows = parseArray(raw, 'installed function catalog');
  if (rows.length !== EXPECTED_CATALOG.length) fail('installed catalog has missing functions or additional overloads');
  const seen = new Set();
  for (const row of rows) {
    exactKeys(row, Object.keys(EXPECTED_CATALOG[0]), 'installed function catalog row');
    const expected = EXPECTED_CATALOG.find((entry) => entry.function === row.function);
    if (!expected || seen.has(row.function)) fail('installed catalog has an unknown function or duplicate overload');
    seen.add(row.function);
    if (!same(row, expected)) fail(`installed source or catalog drift for ${row.function}`);
  }
  return rows.length;
}

export function validateLocalDockerEndpoint(raw) {
  let endpoint;
  try { endpoint = JSON.parse(raw); } catch { fail('Docker endpoint is not JSON'); }
  if (!['unix:///var/run/docker.sock', 'npipe:////./pipe/docker_engine', 'npipe:////./pipe/dockerDesktopLinuxEngine'].includes(endpoint)) {
    fail('Docker default context is not an approved local engine endpoint');
  }
  return endpoint;
}

export function validateLocalProjectConfig(raw) {
  if (typeof raw !== 'string') fail('local project config is unavailable');
  let section = '';
  let dbSections = 0;
  const projectIds = [];
  const dbPorts = [];
  for (const line of raw.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (header) {
      section = header[1];
      if (section === 'db') dbSections++;
      continue;
    }
    if (/^\s*project_id\s*=/.test(line)) {
      const project = line.match(/^\s*project_id\s*=\s*"([^"\r\n]+)"\s*(?:#.*)?$/);
      if (section !== '' || !project) fail('local config project_id differs from the approved project');
      projectIds.push(project[1]);
    }
    if (section === 'db' && /^\s*port\s*=/.test(line)) {
      const port = line.match(/^\s*port\s*=\s*([1-9][0-9]{0,4})\s*(?:#.*)?$/);
      if (!port || Number(port[1]) > 65535) fail('local config db.port is not a valid explicit TCP port');
      dbPorts.push(Number(port[1]));
    }
  }
  if (projectIds.length !== 1 || projectIds[0] !== LOCAL_PROJECT_ID) fail('local config project_id differs from the approved project');
  if (dbSections !== 1 || dbPorts.length !== 1) fail('local config must contain exactly one explicit db.port');
  return Object.freeze({ projectId: LOCAL_PROJECT_ID, dbPort: dbPorts[0] });
}

export function validateLocalContainer(raw, dbPort) {
  let container;
  try { container = JSON.parse(raw); } catch { fail('local Docker container inspection is not JSON'); }
  exactKeys(container, ['name', 'running', 'project', 'ports'], 'local Docker container identity');
  if (container.name !== `/${LOCAL_DB_CONTAINER}` || container.running !== true || container.project !== LOCAL_PROJECT_ID) {
    fail('running local Supabase DB container identity does not match');
  }
  if (!Number.isInteger(dbPort) || dbPort < 1 || dbPort > 65535) fail('configured local DB port is invalid');
  exactKeys(container.ports, ['5432/tcp'], 'local DB container exposed ports');
  const bindings = container.ports['5432/tcp'];
  if (!Array.isArray(bindings) || bindings.length === 0) fail('local DB container has no published PostgreSQL port');
  const seen = new Set();
  for (const binding of bindings) {
    exactKeys(binding, ['HostIp', 'HostPort'], 'local DB container port binding');
    if (!['127.0.0.1', '0.0.0.0', '::1', '::'].includes(binding.HostIp) || binding.HostPort !== String(dbPort)) {
      fail('local DB container PostgreSQL binding differs from configured db.port');
    }
    if (seen.has(binding.HostIp)) fail('local DB container has a duplicate PostgreSQL port binding');
    seen.add(binding.HostIp);
  }
}

export function validateLintBaseline({ lint, catalog }) {
  validateProcessResult(lint, 1, 'original strict lint');
  validateLintStderr(lint.stderr);
  const warningCount = validateLintWarnings(lint.stdout);
  validateProcessResult(catalog, 0, 'installed function catalog');
  if (catalog.stderr !== '') fail('installed function catalog emitted a diagnostic');
  const functionCount = validateInstalledCatalog(catalog.stdout);
  return Object.freeze({ rawStrictResult: 'FAIL', rawStrictExitCode: 1, acceptedWarningCount: warningCount, catalogFunctionCount: functionCount });
}
