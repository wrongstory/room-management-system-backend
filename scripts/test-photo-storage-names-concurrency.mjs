import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateLocalDockerEndpoint } from './db-lint-baseline.mjs';

// Disposable local metadata only. No provider calls, media, keys or remote DB.
const root = fileURLToPath(new URL('..', import.meta.url));
const cli = fileURLToPath(new URL('../node_modules/supabase/dist/supabase.js', import.meta.url));
const args = ['exec', '-i', 'supabase_db_room-management-system-backend', 'psql', '-X', '-qAt',
  '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'];
const source = readFileSync(new URL('../supabase/tests/photo_storage_names.sql', import.meta.url), 'utf8');
const begin = '-- BEGIN NAMED PHOTO SHARED FIXTURE', end = '-- END NAMED PHOTO SHARED FIXTURE';
assert.equal(source.split(begin).length, 2); assert.equal(source.split(end).length, 2);
const fixture = source.split(begin)[1].split(end)[0];
assert(!/\\ir|\b(?:no_plan|plan|finish)\s*\(/i.test(fixture));
const id = n => `38300000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const known = ['PHOTO_PROVIDER_IDENTITY_CONFLICT', 'PHOTO_UPLOAD_FENCE_CONFLICT',
  'PHOTO_ACCESS_REQUIRED', 'PASSWORD_CHANGE_REQUIRED', 'SESSION_REVOKED'];
const pending = [];
let phase = 'identity', cleanupRequired = false;
function sql(input) {
  try { return execFileSync('docker', args, { cwd: root, input: `set statement_timeout='15s';${input}`,
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 20000, maxBuffer: 8 * 1024 * 1024 }).trim(); }
  catch { throw new Error('NAMED_PHOTO_LOCAL_SQL_FAILED'); }
}
function result(child) {
  let output = '', error = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { error += chunk; });
  return new Promise(resolve => {
    child.once('error', () => resolve({ exitCode: -1, code: null, output: '' }));
    child.once('close', exitCode => resolve({ exitCode,
      code: known.find(code => error.includes(code)) ?? null, output: output.trim() }));
  });
}
async function holder(input, name) {
  const child = spawn('docker', args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  const done = result(child);
  await new Promise((resolve, reject) => {
    let ready = false;
    const timer = setTimeout(() => { child.kill(); reject(new Error('NAMED_PHOTO_HOLDER_TIMEOUT')); }, 15000);
    child.stdout.on('data', chunk => {
      if (!ready && chunk.toString().includes('NAMED_PHOTO_LOCK_READY')) {
        ready = true; clearTimeout(timer); resolve();
      }
    });
    child.once('close', () => { if (!ready) { clearTimeout(timer); reject(new Error('NAMED_PHOTO_HOLDER_FAILED')); } });
    child.once('error', () => { clearTimeout(timer); reject(new Error('NAMED_PHOTO_HOLDER_FAILED')); });
    child.stdin.write(`begin;set local application_name='${name}';
      set local statement_timeout='20s';set local idle_in_transaction_session_timeout='25s';
      ${input}\n\\echo NAMED_PHOTO_LOCK_READY\n`);
  });
  let released = false;
  const release = async () => {
    if (!released) { released = true; child.stdin.end('commit;\n\\q\n'); }
    return done;
  };
  pending.push({ child, done, release });
  return { done, release };
}
async function race(firstSql, secondSql, suffix) {
  assert(/^[a-z_]+$/.test(suffix));
  const first = await holder(firstSql, `named_photo_holder_${suffix}`);
  const child = spawn('docker', args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  const done = result(child); pending.push({ child, done });
  const name = `named_photo_contender_${suffix}`;
  child.stdin.end(`begin;set local application_name='${name}';set local statement_timeout='20s';${secondSql}commit;`);
  try {
    let blocked = false;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (sql(`select exists(select 1 from pg_stat_activity where application_name='${name}'
        and wait_event_type='Lock' and xact_start is not null);`) === 't') { blocked = true; break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(blocked, 'Both actual transactions must overlap on a database lock');
  } finally { assert.equal((await first.release()).exitCode, 0); }
  return done;
}
const contexts = new Map();
function reserve(n, { old = false, candidate = `synthetic_race_file_${n}`, actor = 2, session = 902,
  lease = 1, digest = 'c' } = {}) {
  const context = contexts.get(n);
  assert(context && /^[0-9a-f-]{36}$/.test(context.operationId));
  assert(/^[a-zA-Z0-9_-]+$/.test(context.folder)); assert(/^[a-zA-Z0-9_-]+$/.test(candidate));
  assert(Number.isInteger(lease) && /^[a-f]$/.test(digest));
  return `select public.${old ? 'reserve_photo_provider_identity' : 'reserve_named_photo_provider_identity'}(
    '${id(actor)}','${id(session)}','${context.operationId}',${lease},repeat('${digest}',64),'${candidate}','${context.folder}');`;
}
function state(n) {
  const operation = contexts.get(n).operationId;
  return JSON.parse(sql(`select json_build_object(
    'identities',(select count(*) from private.photo_drive_identities where operation_id='${operation}'),
    'names',(select count(*) from private.photo_storage_names where operation_id='${operation}'),
    'filename',(select file_name from private.photo_storage_names where operation_id='${operation}'),
    'number',(select naming_number::text from private.photo_storage_names where operation_id='${operation}'));`));
}
function rejected(value, code) { assert.notEqual(value.exitCode, 0); assert.equal(value.code, code); }
try {
  assert.equal(process.argv.length, 2, 'No target or URL overrides');
  for (const name of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'SUPABASE_WORKDIR', 'SUPABASE_CLI_BINARY_OVERRIDE']) {
    assert(!process.env[name], 'No external runtime overrides');
  }
  const config = readFileSync(new URL('../supabase/config.toml', import.meta.url), 'utf8');
  assert.equal((config.match(/^[ \t]*project_id[ \t]*=/gm) ?? []).length, 1);
  assert(/^[ \t]*project_id[ \t]*=[ \t]*"room-management-system-backend"\r?$/m.test(config));
  validateLocalDockerEndpoint(execFileSync('docker', ['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const status = JSON.parse(execFileSync(process.execPath, [cli, 'status', '--output', 'json'],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert(['localhost', '127.0.0.1'].includes(new URL(status.API_URL).hostname));
  assert.equal(sql('select (select count(*) from auth.users)+(select count(*) from public.profiles)+(select count(*) from public.cleaning_targets)+(select count(*) from private.photo_upload_operations);'), '0', 'Fresh disposable local DB required');
  const manifest = JSON.parse(readFileSync(new URL('../supabase/migration-manifest.dev.json', import.meta.url), 'utf8'));
  assert.equal(sql('select count(*) from supabase_migrations.schema_migrations;'), String(manifest.totalCount));
  assert.equal(sql('select name from supabase_migrations.schema_migrations order by version desc limit 1;'), manifest.head);
  cleanupRequired = true;
  sql(`begin;${fixture} select pg_temp.fixture(n) from generate_series(8,10)n;
    select public.refresh_photo_storage_quota(clock_timestamp(),1000);
    select pg_temp.prepare(n,'cleaning-proof') from unnest(array[1,2,3,4,6,8,9,10])n;
    select jsonb_agg(jsonb_build_object('n',n,'operationId',context->>'operationId',
      'folder',context->>'reservedFolderId')) from flow;commit;`).split('\n').filter(line => line.startsWith('[{'))
    .forEach(line => { for (const value of JSON.parse(line)) contexts.set(value.n, value); });
  assert.equal(contexts.size, 8);
  phase = 'identical_retry';
  const replay = await race(reserve(1), reserve(1), 'retry');
  assert.equal(replay.exitCode, 0);
  const firstState = state(1);
  assert.equal(firstState.identities, 1); assert.equal(firstState.names, 1);
  assert.equal(JSON.parse(replay.output).fileName, firstState.filename);
  phase = 'candidate_conflict';
  rejected(await race(reserve(2), reserve(2, { candidate: 'synthetic_race_conflict' }), 'candidate'), 'PHOTO_PROVIDER_IDENTITY_CONFLICT');
  assert.equal(state(2).identities, 1); assert.equal(state(2).names, 1);
  phase = 'different_operations';
  assert.equal((await race(reserve(3), reserve(4), 'operations')).exitCode, 0);
  assert.notEqual(state(3).filename, state(4).filename); assert.notEqual(state(3).number, state(4).number);
  phase = 'old_identity_wins';
  assert.equal((await race(reserve(6, { old: true }), reserve(6), 'legacy')).exitCode, 0);
  assert.deepEqual(state(6), { identities: 1, names: 0, filename: null, number: null });
  phase = 'named_identity_wins';
  assert.equal((await race(reserve(8), reserve(8, { old: true }), 'named')).exitCode, 0);
  assert.equal(state(8).identities, 1); assert.equal(state(8).names, 1);
  phase = 'stale_and_actor';
  for (const options of [{ lease: 2 }, { digest: 'd' }, { actor: 3, session: 903 }]) {
    assert.throws(() => sql(reserve(9, options)));
    assert.deepEqual(state(9), { identities: 0, names: 0, filename: null, number: null });
  }
  phase = 'password_and_session';
  rejected(await race(`update public.profiles set must_change_password=true where id='${id(2)}';`, reserve(9), 'password'), 'PASSWORD_CHANGE_REQUIRED');
  sql(`update public.profiles set must_change_password=false where id='${id(2)}';`);
  rejected(await race(`delete from auth.sessions where id='${id(902)}';`, reserve(10), 'session'), 'SESSION_REVOKED');
  for (const n of [9,10]) assert.deepEqual(state(n), { identities: 0, names: 0, filename: null, number: null });
  assert.deepEqual(state(1), firstState, 'Other races never rewrite immutable first binding');
  assert.equal(sql('select count(*)||\':\'||count(distinct naming_number)||\':\'||count(distinct file_name) from private.photo_storage_names;'), '5:5:5');
  console.log('Photo storage names concurrency PASS: 7 observed two-session lock races; one binding on retry/conflict, globally unique numbers/names, both old/named reservation orders, actor/session/fence rejection without identity side effects.');
} catch (error) {
  console.error(`Photo storage names concurrency FAIL: ${JSON.stringify({ phase,
    kind: error instanceof assert.AssertionError ? 'ASSERTION_FAILED' : 'VALIDATION_FAILED' })}`);
  process.exitCode = 1;
} finally {
  for (const item of pending) {
    try { if (item.release) await item.release(); else await item.done; }
    catch { item.child.kill(); process.exitCode = 1; }
  }
  if (cleanupRequired) {
    try {
      execFileSync(process.execPath, [cli,'db','reset','--local','--no-seed'],
        { cwd: root, stdio: ['ignore','pipe','pipe'], timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
      assert.equal(sql('select (select count(*) from auth.users)+(select count(*) from public.profiles)+(select count(*) from public.cleaning_targets)+(select count(*) from private.photo_upload_operations);'), '0');
      console.log('Photo storage names concurrency fresh local cleanup PASS');
    } catch { console.error('Photo storage names concurrency fresh local cleanup FAIL'); process.exitCode = 1; }
  }
}
