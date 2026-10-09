import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LOCAL_DB_CONTAINER, validateLocalContainer, validateLocalDockerEndpoint, validateLocalProjectConfig } from './db-lint-baseline.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reject = () => { throw new Error('PERF416_LOCAL_BENCHMARK_REJECTED'); };
const compact = (text) => text.replace(/\s+/g, ' ').trim().toLowerCase();

export function validateBenchmarkSource(board, indexes) {
  for (const table of ['room_candle_events', 'room_pin_sync_events']) {
    if (!compact(board).includes(`from public.${table} event where event.room_id = p_room_id and event.effective_at <= p_at order by event.effective_at desc, event.recorded_at desc, event.id desc limit 1`)) reject();
    if (!compact(indexes).includes(`create index ${table}_room_idx on public.${table} (room_id, recorded_at desc);`)) reject();
  }
}

// Only aggregate counters are emitted. Never forward SQL text, filters, row data or raw errors.
export function summarizePlans(raw) {
  const input = JSON.parse(raw);
  if (input.scope !== 'synthetic-event-order-component' || input.rooms !== 121 ||
      typeof input.serverVersion !== 'string' || !/^\d+\.\d+(?:\.\d+)?$/.test(input.serverVersion) ||
      !Array.isArray(input.results) || input.results.length !== 54) reject();
  const seen = new Set();
  const results = input.results.map((row) => {
    if (![1,100,1000].includes(row.eventsPerRoom) || !['before','middle','latest'].includes(row.cutoff) ||
      !['recorded_only','effective_candidate'].includes(row.mode) || ![1,2,3].includes(row.sample) || row.resultEquivalent !== true) reject();
    const key = `${row.eventsPerRoom}/${row.cutoff}/${row.mode}/${row.sample}`;
    if (seen.has(key)) reject();
    seen.add(key);
    const observed = row.plan?.[0];
    const plan = observed?.Plan;
    const number = (value) => { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) reject(); return value; };
    if (plan?.['Actual Rows'] !== 121) reject();
    const nodes = [];
    const visit = (node) => { nodes.push(node); for (const child of node.Plans ?? []) visit(child); };
    visit(plan);
    return {
      eventsPerRoom: row.eventsPerRoom, cutoff: row.cutoff, mode: row.mode, sample: row.sample,
      executionMs: number(observed['Execution Time']), planningMs: number(observed['Planning Time']),
      localHitBlocks: number(plan['Local Hit Blocks'] ?? 0), localReadBlocks: number(plan['Local Read Blocks'] ?? 0),
      sortNodes: nodes.filter((node) => node['Node Type'] === 'Sort').length,
      effectiveIndexUsed: nodes.some((node) => node['Index Name'] === 'perf416_effective'),
      extraIndexBytes: number(row.extraIndexBytes), resultEquivalent: true,
    };
  });
  return { scope: input.scope, serverVersion: input.serverVersion, rooms: 121, results };
}

export function runBenchmark({ env = process.env, run = spawnSync, read = readFileSync } = {}) {
  for (const name of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH','SUPABASE_WORKDIR','SUPABASE_DB_PORT','SUPABASE_PROJECT_ID']) {
    if (env[name]) reject();
  }
  const { dbPort } = validateLocalProjectConfig(read(resolve(root, 'supabase/config.toml'), 'utf8'));
  validateBenchmarkSource(
    read(resolve(root, 'supabase/migrations/20261004231650_room_board_date_filters.sql'), 'utf8'),
    read(resolve(root, 'supabase/migrations/20260827224644_room_reservation_commands.sql'), 'utf8'),
  );
  const command = (args, input) => {
    const result = run('docker', ['--context','default', ...args], { cwd: root, env, input,
      encoding: 'utf8', timeout: 120000, maxBuffer: 8*1024*1024, windowsHide: true, shell: false });
    if (result.error || result.signal || result.status !== 0 || result.stderr?.trim()) reject();
    return result.stdout;
  };
  validateLocalDockerEndpoint(command(['context','inspect','default','--format','{{json .Endpoints.docker.Host}}']));
  validateLocalContainer(command(['inspect','--format',
    '{"name":{{json .Name}},"running":{{json .State.Running}},"project":{{json (index .Config.Labels "com.supabase.cli.project")}},"ports":{{json .NetworkSettings.Ports}}}', LOCAL_DB_CONTAINER]), dbPort);
  const sql = read(resolve(root, 'scripts/fixtures/query-plan-event-order.sql'), 'utf8');
  return summarizePlans(command(['exec','-i',LOCAL_DB_CONTAINER,'psql','-XqAt','-h','/var/run/postgresql','-p','5432','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'], sql));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) reject();
    process.stdout.write(`${JSON.stringify(runBenchmark(), null, 2)}\n`);
  } catch {
    process.stderr.write('PERF416_LOCAL_BENCHMARK_REJECTED: local synthetic check failed; raw diagnostics withheld.\n');
    process.exitCode = 1;
  }
}
