import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateLocalDockerEndpoint } from './db-lint-baseline.mjs';

// Local synthetic metadata only: no HTTP/Drive, real photos, keys or remote DB.
const root = fileURLToPath(new URL('..', import.meta.url));
const cli = fileURLToPath(new URL('../node_modules/supabase/dist/supabase.js', import.meta.url));
const args = ['exec', '-i', 'supabase_db_room-management-system-backend', 'psql', '-X', '-qAt',
  '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'];
const source = readFileSync(new URL('../supabase/tests/photo_collection_provider_context.sql', import.meta.url), 'utf8');
function section(name) {
  const begin = `-- BEGIN PHOTO CONTEXT ${name}`, end = `-- END PHOTO CONTEXT ${name}`;
  assert.equal(source.split(begin).length, 2); assert.equal(source.split(end).length, 2);
  return source.split(begin)[1].split(end)[0];
}
const fixture = section('SHARED FIXTURE'), rpcHelpers = section('RPC HELPERS');
assert(!/\\ir|\b(?:no_plan|plan|finish)\s*\(/i.test(fixture));
assert(!/\b(?:insert|update|delete)\s+into\s+(?:auth|public|private)\./i.test(rpcHelpers));
const id = n => `88384000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const helpers = `create function pg_temp.cid(n integer) returns uuid language sql immutable as $$
  select ('88384000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
  create temp table context_fixture(n integer primary key,target_id uuid,assignment_id uuid,attempt_id uuid);
  insert into context_fixture values(1,'${id(301)}','${id(401)}','${id(501)}'),
    (4,'${id(304)}','${id(404)}','${id(504)}'); ${rpcHelpers}`;
const full = (k, cr, item = k, ir = 0, n = 1) =>
  `select pg_temp.finish_upload(${n},${k},pg_temp.open_upload(${n},${k},'cleaning-proof',${item},${cr},${ir}));`;
const remove = (cr, ir, k) => `select public.delete_photo_collection_item('${id(2)}','${id(902)}',
  '${id(501)}','${id(401)}',2,pg_temp.slot(1,'cleaning-proof'),'${id(10001)}',${cr},${ir},lpad('${k}',64,'0'),repeat('e',64));`;
const known = ['PHOTO_COLLECTION_VERSION_CONFLICT', 'PHOTO_ITEM_VERSION_CONFLICT', 'PHOTO_COLLECTION_LIMIT_EXCEEDED',
  'PHOTO_UPLOAD_IN_FLIGHT', 'PHOTO_VERSION_CONFLICT', 'IDEMPOTENCY_KEY_REUSED', 'PASSWORD_CHANGE_REQUIRED', 'SESSION_REVOKED'];
let phase = 'identity', cleanupRequired = false;
const pending = [];
function sql(input) {
  try { return execFileSync('docker', args, { cwd: root, input: `set statement_timeout='15s';${input}`,
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 20000, maxBuffer: 8 * 1024 * 1024 }).trim(); }
  catch { throw new Error('PHOTO_CONTEXT_LOCAL_SQL_FAILED'); }
}
function result(child) {
  let output = '', error = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { error += chunk; });
  return new Promise(resolve => {
    child.once('error', () => resolve({ exitCode: -1, code: null, output: '' }));
    child.once('close', exitCode => resolve({ exitCode, code: known.find(code => error.includes(code)) ?? null, output: output.trim() }));
  });
}
async function holder(input, name) {
  const child = spawn('docker', args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  const done = result(child);
  await new Promise((resolve, reject) => {
    let ready = false;
    const timer = setTimeout(() => { child.kill(); reject(new Error('PHOTO_CONTEXT_HOLDER_TIMEOUT')); }, 15000);
    child.stdout.on('data', chunk => { if (!ready && chunk.toString().includes('PHOTO_CONTEXT_LOCK_READY')) {
      ready = true; clearTimeout(timer); resolve();
    } });
    child.once('close', () => { if (!ready) { clearTimeout(timer); reject(new Error('PHOTO_CONTEXT_HOLDER_FAILED')); } });
    child.once('error', () => { clearTimeout(timer); reject(new Error('PHOTO_CONTEXT_HOLDER_FAILED')); });
    child.stdin.write(`${helpers} begin; set local application_name='${name}';
      set local statement_timeout='20s'; set local idle_in_transaction_session_timeout='25s';
      ${input}\n\\echo PHOTO_CONTEXT_LOCK_READY\n`);
  });
  let released = false;
  const release = async () => { if (!released) { released = true; child.stdin.end('commit;\n\\q\n'); } return done; };
  pending.push({ child, done, release });
  return { child, done, release };
}
async function race(firstSql, secondSql, suffix) {
  assert(/^[a-z_]+$/.test(suffix));
  const first = await holder(firstSql, `photo_context_holder_${suffix}`);
  const child = spawn('docker', args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  const done = result(child); pending.push({ child, done });
  const name = `photo_context_contender_${suffix}`;
  child.stdin.end(`${helpers} begin;set local application_name='${name}';set local statement_timeout='20s';${secondSql}commit;`);
  try {
    let blocked = false;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (sql(`select exists(select 1 from pg_stat_activity where application_name='${name}' and wait_event_type='Lock' and xact_start is not null);`) === 't') { blocked = true; break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(blocked, 'Both real transactions must overlap and the contender must wait on a DB lock');
  } finally { assert.equal((await first.release()).exitCode, 0, 'First transaction commits'); }
  return done;
}
function state(n = 1) {
  return JSON.parse(sql(`select json_build_object('revision',s.revision,
    'active',(select count(*) from private.attempt_photo_collection_items where cleaning_attempt_id=s.cleaning_attempt_id and active),
    'photos',(select count(*) from private.attempt_photo_versions where cleaning_attempt_id=s.cleaning_attempt_id),
    'accepted',(select count(*) from private.photo_upload_acceptances x join private.photo_upload_operations o on o.id=x.operation_id where o.cleaning_attempt_id=s.cleaning_attempt_id),
    'changes',(select count(*) from private.attempt_photo_collection_changes where cleaning_attempt_id=s.cleaning_attempt_id),
    'ordinary',(select count(*) from private.attempt_photo_current where cleaning_attempt_id=s.cleaning_attempt_id))
    from private.attempt_photo_collection_states s where cleaning_attempt_id='${id(500+n)}';`));
}
function rejected(value, code) { assert.notEqual(value.exitCode, 0); assert.equal(value.code, code); }
try {
  assert.equal(process.argv.length, 2, 'No target/URL overrides');
  for (const name of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'SUPABASE_WORKDIR', 'SUPABASE_CLI_BINARY_OVERRIDE']) assert(!process.env[name], 'No external runtime overrides');
  const config = readFileSync(new URL('../supabase/config.toml', import.meta.url), 'utf8');
  assert.equal((config.match(/^[ \t]*project_id[ \t]*=/gm) ?? []).length, 1);
  assert(/^[ \t]*project_id[ \t]*=[ \t]*"room-management-system-backend"\r?$/m.test(config));
  validateLocalDockerEndpoint(execFileSync('docker', ['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const status = JSON.parse(execFileSync(process.execPath, [cli, 'status', '--output', 'json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert(['localhost', '127.0.0.1'].includes(new URL(status.API_URL).hostname));
  assert.equal(sql('select (select count(*) from auth.users)+(select count(*) from public.profiles)+(select count(*) from public.cleaning_targets)+(select count(*) from private.photo_upload_operations);'), '0', 'Require fresh disposable local DB');
  const manifest = JSON.parse(readFileSync(new URL('../supabase/migration-manifest.dev.json', import.meta.url), 'utf8'));
  assert.equal(sql('select count(*) from supabase_migrations.schema_migrations;'), String(manifest.totalCount));
  assert.equal(sql('select name from supabase_migrations.schema_migrations order by version desc limit 1;'), manifest.head);
  cleanupRequired = true;
  sql(`begin;${fixture} select pg_temp.additional_fixture(4,false); ${full(1,0)} commit;`);
  phase = 'append';
  rejected(await race(full(2,1), full(3,1), 'append'), 'PHOTO_COLLECTION_VERSION_CONFLICT');
  assert.deepEqual(state(), { revision: 2, active: 2, photos: 2, accepted: 2, changes: 2, ordinary: 0 });
  phase = 'identical_retry';
  const replay = await race(full(4,2), `select public.begin_admitted_photo_collection_upload('${id(2)}','${id(902)}',
    (pg_temp.admit(1,4,'cleaning-proof',4,2,0)->>'admissionId')::uuid,repeat('a',64),'image/jpeg',100,lpad('4',64,'0'),repeat('b',64));`, 'retry');
  assert.equal(replay.exitCode,0); assert.equal(JSON.parse(replay.output).status,'accepted');
  assert.deepEqual(state(), { revision: 3, active: 3, photos: 3, accepted: 3, changes: 3, ordinary: 0 });
  phase = 'replacement_then_delete';
  rejected(await race(full(5,3,1,1), remove(3,1,6), 'replacement'), 'PHOTO_COLLECTION_VERSION_CONFLICT');
  assert.equal(sql(`select display_order||':'||revision from private.attempt_photo_collection_items where id='${id(10001)}';`),'0:2');
  assert.deepEqual(state(), { revision: 4, active: 3, photos: 4, accepted: 4, changes: 4, ordinary: 0 });
  phase = 'delete_then_replacement';
  rejected(await race(remove(4,2,7), full(8,4,1,2), 'delete'), 'PHOTO_COLLECTION_VERSION_CONFLICT');
  assert.deepEqual(state(), { revision: 5, active: 2, photos: 4, accepted: 4, changes: 5, ordinary: 0 });
  assert.equal(sql(`select not active and photo_version_id is null and revision=3 and display_order=0 from private.attempt_photo_collection_items where id='${id(10001)}';`),'t');
  phase = 'nineteen_to_twenty';
  sql(`${helpers} begin;do $$begin for n in 1..19 loop
    perform pg_temp.finish_upload(4,100+n,pg_temp.open_upload(4,100+n,'cleaning-proof',100+n,n-1));
    end loop;end $$;commit;`);
  rejected(await race(full(120,19,120,0,4), full(121,19,121,0,4), 'cap'), 'PHOTO_COLLECTION_VERSION_CONFLICT');
  assert.deepEqual(state(4), { revision: 20, active: 20, photos: 20, accepted: 20, changes: 20, ordinary: 0 });
  assert.equal(sql(`select count(*) from private.photo_upload_operations where cleaning_attempt_id='${id(504)}';`),'20');
  phase = 'password_and_session';
  const opened = JSON.parse(sql(`${helpers} select pg_temp.open_upload(1,200,'cleaning-proof',200,5);`));
  assert(/^[0-9a-f-]{36}$/.test(opened.operationId));
  const context = `select public.get_photo_provider_context('${id(2)}','${id(902)}','${opened.operationId}',1,repeat('c',64));`;
  rejected(await race(`update public.profiles set must_change_password=true where id='${id(2)}';`,context,'password'), 'PASSWORD_CHANGE_REQUIRED');
  sql(`update public.profiles set must_change_password=false where id='${id(2)}';`);
  rejected(await race(`delete from auth.sessions where id='${id(902)}';`,context,'session'), 'SESSION_REVOKED');
  assert.equal(sql(`select count(*) from private.photo_drive_identities where operation_id='${opened.operationId}';`),'0');
  assert.deepEqual(state(), { revision: 5, active: 2, photos: 4, accepted: 4, changes: 5, ordinary: 0 });
  console.log('Photo collection provider context concurrency PASS: 7 observed two-session lock races; append/cap CAS, identical accepted retry, both replacement/delete orders, password/session freshness; no duplicate acceptance or denied identity.');
} catch (error) {
  console.error(`Photo collection provider context concurrency FAIL: ${JSON.stringify({ phase, kind: error instanceof assert.AssertionError ? 'ASSERTION_FAILED' : 'VALIDATION_FAILED' })}`);
  process.exitCode = 1;
} finally {
  for (const item of pending) { try { if (item.release) await item.release(); else await item.done; } catch { item.child.kill(); process.exitCode = 1; } }
  if (cleanupRequired) {
    try {
      execFileSync(process.execPath,[cli,'db','reset','--local','--no-seed'],{ cwd:root,stdio:['ignore','pipe','pipe'],timeout:120000,maxBuffer:16*1024*1024 });
      assert.equal(sql('select (select count(*) from auth.users)+(select count(*) from public.profiles)+(select count(*) from public.cleaning_targets)+(select count(*) from private.photo_upload_operations);'),'0');
      console.log('Photo context concurrency fresh local cleanup PASS');
    } catch { console.error('Photo context concurrency fresh local cleanup FAIL'); process.exitCode = 1; }
  }
}
