import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validateLocalContainer, validateLocalDockerEndpoint, validateLocalProjectConfig } from './db-lint-baseline.mjs';

// Explicit execution only after approval. No migration/reset/remote connection.
// Fresh local synthetic fixture only, with exact-ID cleanup, never broad deletion.
const container = 'supabase_db_room-management-system-backend';
const args = ['exec', '-i', container, 'psql', '-XqAt', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'];
const id = n => `f4420000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export function assertAuthContextFresh(value, manifest) {
  assert.deepEqual(value, { users: 0, profiles: 0, sessions: 0, targets: 0,
    count: manifest.totalCount, head: manifest.head }, 'AUTH_CONTEXT_REQUIRES_FRESH_LOCAL_DB');
}
export function assertAuthContextRace(result) {
  assert.equal(result.exitCode, 0, 'AUTH_CONTEXT_RACE_PROCESS_FAILED');
  assert.equal(result.output.trim(), 'SESSION_REVOKED', 'AUTH_CONTEXT_STALE_AUTHORIZATION');
}

async function main() {
  const pending = [];
  let fixture = false;
  function command(exe, argv, input) {
    try { return execFileSync(exe, argv, { input, encoding: 'utf8', timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 }).trim(); }
    catch { throw new Error('AUTH_CONTEXT_LOCAL_COMMAND_FAILED'); }
  }
  const sql = input => command('docker', args, `set statement_timeout='10s';${input}`);
  function connection() {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', closed = false;
    const timer = setTimeout(() => child.kill(), 20000);
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.resume(); // Never print SQL, identifiers, credentials or raw errors.
    child.stdin.on('error', () => {});
    const done = new Promise(resolve => {
      child.once('error', () => { closed = true; clearTimeout(timer); resolve({ exitCode: -1, output: '' }); });
      child.once('close', exitCode => { closed = true; clearTimeout(timer); resolve({ exitCode, output }); });
    });
    const item = { child, done, output: () => output, closed: () => closed };
    pending.push(item);
    return item;
  }
  async function until(check) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (check()) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error('AUTH_CONTEXT_RACE_BARRIER_TIMEOUT');
  }
  try {
    assert.equal(process.argv.length, 2);
    for (const name of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH',
      'SUPABASE_WORKDIR', 'SUPABASE_PROJECT_ID', 'SUPABASE_CLI_BINARY_OVERRIDE']) assert(!process.env[name]);
    const config = validateLocalProjectConfig(readFileSync(new URL('../supabase/config.toml', import.meta.url), 'utf8'));
    validateLocalDockerEndpoint(command('docker', ['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}']));
    validateLocalContainer(command('docker', ['inspect', container, '--format',
      '{"name":{{json .Name}},"running":{{json .State.Running}},"project":{{json (index .Config.Labels "com.supabase.cli.project")}},"ports":{{json .NetworkSettings.Ports}}}']), config.dbPort);
    const manifest = JSON.parse(readFileSync(new URL('../supabase/migration-manifest.dev.json', import.meta.url), 'utf8'));
    assertAuthContextFresh(JSON.parse(sql(`select jsonb_build_object(
      'users',(select count(*) from auth.users),'profiles',(select count(*) from public.profiles),
      'sessions',(select count(*) from auth.sessions),'targets',(select count(*) from public.cleaning_targets),
      'count',(select count(*) from supabase_migrations.schema_migrations),
      'head',(select name from supabase_migrations.schema_migrations order by version desc limit 1));`)), manifest);
    assert.equal(sql(`select coalesce(to_regprocedure('public.get_active_auth_context(uuid,text)')::text,'missing')`),
      'get_active_auth_context(uuid,text)');
    fixture = true; // Cleanup also after an uncertain commit acknowledgement.
    sql(`begin;
      insert into auth.users(id) values('${id(1)}');
      insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
        login_sequence,role,status,must_change_password) values('${id(11)}','${id(1)}',
        'context-race','context-race','context-race','context-race',0,'maid','active',false);
      insert into auth.sessions(id,user_id) values('${id(21)}','${id(1)}'); commit;`);
    for (const mode of ['revoke', 'expiry']) {
      if (mode === 'expiry') sql(`insert into auth.sessions(id,user_id) values('${id(21)}','${id(1)}');`);
      const holder = connection();
      holder.child.stdin.write(`begin;set local statement_timeout='10s';set local idle_in_transaction_session_timeout='15s';
        lock table public.profiles in access exclusive mode;select 'HELD';\n`);
      await until(() => holder.output().includes('HELD'));
      const reader = connection();
      reader.child.stdin.write(`set application_name='auth_context442_${mode}';set statement_timeout='15s';
        select public.get_active_auth_context('${id(1)}','${id(21)}')->>'code';\n`);
      await until(() => sql(`select exists(select 1 from pg_stat_activity a join pg_locks l on l.pid=a.pid
        where a.application_name='auth_context442_${mode}' and a.wait_event_type='Lock'
        and l.relation='public.profiles'::regclass and not l.granted);`) === 't');
      // The real profile read has begun and is waiting. Commit session removal
      // or let a future hard deadline elapse before releasing that profile read.
      if (mode === 'revoke') sql(`delete from auth.sessions where id='${id(21)}' and user_id='${id(1)}';`);
      else {
        sql(`update auth.sessions set not_after=clock_timestamp()+interval '250 milliseconds'
          where id='${id(21)}' and user_id='${id(1)}';`);
        await until(() => sql(`select not_after <= clock_timestamp() from auth.sessions where id='${id(21)}';`) === 't');
      }
      holder.child.stdin.end('commit;\n');
      assert.equal((await holder.done).exitCode, 0);
      reader.child.stdin.end('\\q\n');
      assertAuthContextRace(await reader.done);
    }
  } finally {
    // End holders before cleanup; server-side statement/idle timeouts bound all waits.
    for (const item of pending) if (!item.closed()) item.child.stdin.end('rollback;\n\\q\n');
    await Promise.all(pending.map(item => item.done));
    if (fixture) {
      sql(`begin;delete from auth.sessions where id='${id(21)}' and user_id='${id(1)}';
        delete from public.profiles where id='${id(11)}' and auth_user_id='${id(1)}';
        delete from auth.users where id='${id(1)}';commit;`);
      assert.equal(sql(`select (select count(*) from auth.users)+(select count(*) from public.profiles)
        +(select count(*) from auth.sessions);`), '0', 'AUTH_CONTEXT_FIXTURE_CLEANUP_FAILED');
    }
  }
  console.log('Auth context concurrency PASS: both real lock races denied; exact synthetic fixture cleanup verified.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Auth context concurrency FAIL: redacted local validation failure; inspect fixture state before retry.'); process.exitCode = 1; });
}
