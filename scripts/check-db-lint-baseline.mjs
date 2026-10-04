import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CATALOG_SQL, LOCAL_DB_CONTAINER, PROCESS_MAX_BUFFER, PROCESS_TIMEOUT_MS,
  STRICT_LINT_ARGS, SUPABASE_CLI_VERSION, validateLintBaseline, validateLocalContainer,
  validateLocalDockerEndpoint, validateLocalProjectConfig, validateProcessResult,
} from './db-lint-baseline.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const reject = (message) => { throw new Error(`DB lint baseline rejected: ${message}`); };

// Dependencies are injectable only to test orchestration without Docker or DB.
// The command line has no URL, target, schema or baseline overrides.
export function runLocalBaselineCheck({
  spawnSyncImpl = spawnSync, readFileSyncImpl = readFileSync, env = process.env,
  stdout = process.stdout, stderr = process.stderr, args = process.argv.slice(2),
} = {}) {
  if (args.length !== 0) reject('this gate accepts no arguments and supports only the fixed local project');
  for (const variable of ['SUPABASE_CLI_BINARY_OVERRIDE', 'SUPABASE_WORKDIR', 'SUPABASE_PROJECT_ID', 'SUPABASE_DB_PORT', 'SUPABASE_SERVICES_HOSTNAME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) {
    if (env[variable]) reject(`environment override ${variable} is not allowed`);
  }
  const config = readFileSyncImpl(resolve(projectRoot, 'supabase/config.toml'), 'utf8');
  const { projectId, dbPort } = validateLocalProjectConfig(config);
  const manifest = JSON.parse(readFileSyncImpl(resolve(projectRoot, 'package.json'), 'utf8'));
  const installed = JSON.parse(readFileSyncImpl(resolve(projectRoot, 'node_modules/supabase/package.json'), 'utf8'));
  if (manifest.devDependencies?.supabase !== SUPABASE_CLI_VERSION || installed.name !== 'supabase' || installed.version !== SUPABASE_CLI_VERSION) {
    reject(`Supabase CLI must be pinned and installed at ${SUPABASE_CLI_VERSION}`);
  }
  // Pin the CLI as well as Docker exec; a persisted current Docker context must
  // not send lint to a different engine from the inspected catalog container.
  const localEnv = {
    ...env, DOCKER_CONTEXT: 'default', SUPABASE_PROJECT_ID: projectId,
    SUPABASE_DB_PORT: String(dbPort), SUPABASE_SERVICES_HOSTNAME: '127.0.0.1',
  };
  const options = { cwd: projectRoot, encoding: 'utf8', timeout: PROCESS_TIMEOUT_MS, maxBuffer: PROCESS_MAX_BUFFER, windowsHide: true, shell: false };
  const run = (executable, commandArgs, label, commandEnv = env) => {
    const result = spawnSyncImpl(executable, commandArgs, { ...options, env: commandEnv });
    // Keep raw stdout/stderr separate and visible even when validation rejects.
    stdout.write(`\n--- ${label} stdout ---\n`);
    if (typeof result.stdout === 'string') stdout.write(result.stdout);
    stderr.write(`\n--- ${label} stderr ---\n`);
    if (typeof result.stderr === 'string') stderr.write(result.stderr);
    stdout.write(`\n${label} exit=${result.status ?? 'unavailable'} signal=${result.signal ?? 'none'}\n`);
    if (result.error) stderr.write(`${label} execution error: ${result.error.message}\n`);
    return result;
  };
  const endpoint = run('docker', ['--context', 'default', 'context', 'inspect', 'default', '--format', '{{json .Endpoints.docker.Host}}'], 'local Docker endpoint');
  validateProcessResult(endpoint, 0, 'local Docker endpoint');
  if (endpoint.stderr !== '') reject('local Docker endpoint emitted a diagnostic');
  const localEndpoint = validateLocalDockerEndpoint(endpoint.stdout);
  const container = run('docker', ['--context', 'default', 'inspect', '--format', '{"name":{{json .Name}},"running":{{json .State.Running}},"project":{{json (index .Config.Labels "com.supabase.cli.project")}},"ports":{{json .NetworkSettings.Ports}}}', LOCAL_DB_CONTAINER], 'local DB container identity');
  validateProcessResult(container, 0, 'local DB container identity');
  if (container.stderr !== '') reject('local DB container identity emitted a diagnostic');
  validateLocalContainer(container.stdout, dbPort);
  const lint = run(process.execPath, [resolve(projectRoot, 'node_modules/supabase/dist/supabase.js'), '--workdir', projectRoot, ...STRICT_LINT_ARGS], 'original strict lint', { ...localEnv, DOCKER_HOST: localEndpoint });
  const observedStrict = lint.error || lint.signal || lint.status == null ? 'EXECUTION FAILURE' : lint.status === 0 ? 'PASS' : 'FAIL';
  stdout.write(`Original strict lint observed: ${observedStrict}, exit ${lint.status ?? 'unavailable'}. Baseline acceptance requires FAIL, exit 1.\n`);
  // Catalog access uses the local named container and a read-only transaction.
  const catalog = run('docker', ['--context', 'default', 'exec', LOCAL_DB_CONTAINER, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-c', CATALOG_SQL], 'installed function catalog');
  const accepted = validateLintBaseline({ lint, catalog });
  stdout.write(`DB lint baseline: PASS (${accepted.acceptedWarningCount} exact approved compatibility warnings; ${accepted.catalogFunctionCount} exact installed fingerprints). Original strict lint remains ${accepted.rawStrictResult}, exit ${accepted.rawStrictExitCode}.\n`);
  return accepted;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { runLocalBaselineCheck(); }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'DB lint baseline rejected: unexpected failure'}\n`);
    process.exitCode = 1;
  }
}
