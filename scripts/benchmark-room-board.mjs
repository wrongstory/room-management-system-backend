import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LOCAL_DB_CONTAINER, validateLocalContainer, validateLocalDockerEndpoint, validateLocalProjectConfig } from './db-lint-baseline.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reject = () => { throw new Error('PERF416_LOCAL_RPC_BENCHMARK_REJECTED'); };
const number = (value) => { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) reject(); return value; };

export function summarizeRoomBoard(raw) {
  const input = JSON.parse(raw);
  if (input.scope !== 'local-room-board-rpc-and-event-write' || input.rooms !== 121 || input.eventsPerRoom !== 100 ||
      typeof input.serverVersion !== 'string' || !/^\d+\.\d+(?:\.\d+)?$/.test(input.serverVersion) ||
      !Array.isArray(input.results) || input.results.length !== 30) reject();
  const seen = new Set();
  const results = input.results.map((row) => {
    if (!['recorded_only','effective_candidate'].includes(row.mode) || ![1,2,3].includes(row.sample)) reject();
    const read = row.kind === 'read';
    if (read ? (![-2,0,1].includes(row.dayOffset) || row.resultEquivalent !== true || row.denials !== 2) :
      (row.kind !== 'write' || !['room_candle_events','room_pin_sync_events'].includes(row.table))) reject();
    const key = `${row.kind}/${row.mode}/${read ? row.dayOffset : row.table}/${row.sample}`;
    if (seen.has(key)) reject();
    seen.add(key);
    const observed = row.plan?.[0];
    const plan = observed?.Plan;
    if (plan?.['Actual Rows'] !== 121 || plan['Node Type'] !== (read ? 'Function Scan' : 'ModifyTable')) reject();
    return { kind: row.kind, mode: row.mode, sample: row.sample,
      ...(read ? { dayOffset: row.dayOffset, resultEquivalent: true, denials: 2 } : { table: row.table }),
      executionMs: number(observed['Execution Time']), planningMs: number(observed['Planning Time']),
      sharedHitBlocks: number(plan['Shared Hit Blocks'] ?? 0), sharedReadBlocks: number(plan['Shared Read Blocks'] ?? 0),
      // Root counters only. Trigger work can be included in buffers/time but WAL
      // here is the executor-reported statement counter, not a cluster LSN delta.
      walBytes: number(plan['WAL Bytes'] ?? 0), walRecords: number(plan['WAL Records'] ?? 0),
      triggerMs: (observed.Triggers ?? []).reduce((sum, item) => sum + number(item.Time), 0),
      extraIndexBytes: number(row.extraIndexBytes) };
  });
  return { scope: input.scope, serverVersion: input.serverVersion, rooms: 121, eventsPerRoom: 100, results };
}

export function runRoomBoardBenchmark({ env = process.env, run = spawnSync, read = readFileSync } = {}) {
  for (const name of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH','SUPABASE_WORKDIR','SUPABASE_DB_PORT','SUPABASE_PROJECT_ID']) {
    if (env[name]) reject();
  }
  const { dbPort } = validateLocalProjectConfig(read(resolve(root, 'supabase/config.toml'), 'utf8'));
  const command = (args, input) => {
    const result = run('docker', ['--context','default', ...args], { cwd: root, env, input,
      encoding: 'utf8', timeout: 120000, maxBuffer: 8*1024*1024, windowsHide: true, shell: false });
    if (result.error || result.signal || result.status !== 0 || result.stderr?.trim()) reject();
    return result.stdout;
  };
  validateLocalDockerEndpoint(command(['context','inspect','default','--format','{{json .Endpoints.docker.Host}}']));
  validateLocalContainer(command(['inspect','--format',
    '{"name":{{json .Name}},"running":{{json .State.Running}},"project":{{json (index .Config.Labels "com.supabase.cli.project")}},"ports":{{json .NetworkSettings.Ports}}}', LOCAL_DB_CONTAINER]), dbPort);
  return summarizeRoomBoard(command(['exec','-i',LOCAL_DB_CONTAINER,'psql','-XqAt','-h','/var/run/postgresql','-p','5432',
    '-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'], read(resolve(root,'scripts/fixtures/query-plan-room-board.sql'),'utf8')));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) reject();
    process.stdout.write(`${JSON.stringify(runRoomBoardBenchmark(), null, 2)}\n`);
  } catch {
    process.stderr.write('PERF416_LOCAL_RPC_BENCHMARK_REJECTED: local check failed; raw diagnostics withheld.\n');
    process.exitCode = 1;
  }
}
