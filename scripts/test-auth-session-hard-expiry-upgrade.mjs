import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Exact local99→100 interval, independent of any later source migrations.
// Never move original source/config/credentials; finally restore root latest DB.
const root = fileURLToPath(new URL('..', import.meta.url));
const cli = fileURLToPath(new URL('../node_modules/supabase/dist/supabase.js', import.meta.url));
const project = 'room-management-system-backend';
const psqlArgs = ['exec', '-i', `supabase_db_${project}`, 'psql', '-X', '-qAt',
  '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'];
const baseline = '20261003064220', added = '20261003095426';
const migrationPattern = /^(\d{14})_([a-z0-9_]+)\.sql$/;
const manifestPath = fileURLToPath(new URL('../supabase/migration-manifest.dev.json', import.meta.url));
const migrationDirectory = fileURLToPath(new URL('../supabase/migrations', import.meta.url));
const initialManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
assert(Number.isSafeInteger(initialManifest.totalCount) && initialManifest.totalCount >= 100);
const temporaryRoot = fileURLToPath(new URL('../.tmp', import.meta.url));
const temporaryPrefix = 'auth-session-hard-expiry-upgrade-';
const fixture = readFileSync(new URL('../supabase/tests/auth_session_hard_expiry_fixture.psql', import.meta.url), 'utf8');
assert(!/\\ir|\b(?:no_plan|plan|finish)\s*\(/i.test(fixture));
const id = n => `f3520000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const literal = value => `'${value.replaceAll("'", "''")}'`;
const signature = 'public.is_active_auth_session(uuid,uuid)';
const command = session => `select public.manage_cleaning_attempt_lifecycle('${id(1)}','${id(session)}',
  '${id(801)}',2,'${id(701)}',2,1,'allow_finish','{}','DEACTIVATION_FINISH_CURRENT',
  'session-upgrade-allow-finish',repeat('b',64));`;
const adminRead = session => `select public.get_cleaning_attempt_lifecycle_impact('${id(1)}','${id(session)}','${id(701)}');`;
const limitedRead = `select public.get_limited_cleaning_attempt('${id(2)}','${id(202)}','${id(801)}',2);`;
let phase = 'local-identity', resetStarted = false, temporaryWorkspace;

function sourceMigrationFiles(manifest) {
  const entries = readdirSync(migrationDirectory, { withFileTypes: true }).filter(x => x.name.endsWith('.sql'))
    .sort((a, b) => a.name.localeCompare(b.name));
  assert.equal(entries.length, manifest.totalCount); assert.equal(manifest.migrations.length, entries.length);
  let previous = '';
  for (const [i, entry] of entries.entries()) {
    const match = migrationPattern.exec(entry.name);
    assert(entry.isFile() && match && match[1] > previous);
    assert.equal(manifest.migrations[i].order, i + 1); assert.equal(manifest.migrations[i].name, match[2]);
    const canonical = readFileSync(join(migrationDirectory, entry.name), 'utf8').replaceAll('\r\n', '\n');
    assert(!canonical.includes('\r'));
    assert.equal(createHash('sha256').update(canonical, 'utf8').digest('hex'), manifest.migrations[i].sha256);
    previous = match[1];
  }
  return entries.map(x => x.name);
}
function prepareWorkspace() {
  const files = sourceMigrationFiles(initialManifest).slice(0, 100);
  assert.equal(files.length, 100);
  assert(files[98].startsWith(`${baseline}_`) && files[99] === `${added}_auth_session_hard_expiry.sql`);
  const config = fileURLToPath(new URL('../supabase/config.toml', import.meta.url));
  const configSource = readFileSync(config, 'utf8');
  assert.equal((configSource.match(/^[ \t]*project_id[ \t]*=/gm) ?? []).length, 1);
  assert.equal(/^[ \t]*project_id[ \t]*=[ \t]*"([^"\r\n]+)"[ \t]*(?:#[^\r\n]*)?\r?$/m.exec(configSource)?.[1], project);
  mkdirSync(temporaryRoot, { recursive: true });
  assert.equal(relative(realpathSync(root), realpathSync(temporaryRoot)), '.tmp');
  temporaryWorkspace = mkdtempSync(join(temporaryRoot, temporaryPrefix));
  const target = join(temporaryWorkspace, 'supabase', 'migrations');
  mkdirSync(target, { recursive: true });
  copyFileSync(config, join(temporaryWorkspace, 'supabase', 'config.toml'), constants.COPYFILE_EXCL);
  for (const file of files) copyFileSync(join(migrationDirectory, file), join(target, file), constants.COPYFILE_EXCL);
  return temporaryWorkspace;
}
function sql(input) {
  try {
    return execFileSync('docker', psqlArgs, { cwd: root, input, encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 16 * 1024 * 1024 }).trim();
  } catch { throw new Error('AUTH_SESSION_EXPIRY_UPGRADE_SQL_FAILED'); }
}
function reset(version, workdir = root) {
  const args = [cli, '--workdir', workdir, 'db', 'reset', '--local', '--no-seed'];
  if (version) args.push('--version', version);
  execFileSync(process.execPath, args, { cwd: workdir, stdio: 'inherit' });
}
function shape() {
  return JSON.parse(sql(`select coalesce(jsonb_agg(jsonb_build_object('table',table_name,'columns',columns)
    order by table_name),'[]') from (select format('%I.%I',n.nspname,c.relname) table_name,
    jsonb_agg(a.attname order by a.attnum) columns from pg_class c join pg_namespace n on n.oid=c.relnamespace
    join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped where c.relkind='r'
      and (n.nspname in('public','private') or (n.nspname='auth' and c.relname in('users','sessions')))
    group by n.nspname,c.relname) tables;`));
}
function digest(tables) {
  const rows = tables.map(({ table }) => {
    assert(/^(public|private|auth)\.[a-z_][a-z_0-9]*$/.test(table));
    return `select ${literal(table)} tag,to_jsonb(t)::text data from ${table} t`;
  });
  return sql(`select md5(coalesce(string_agg(tag||':'||data,'|' order by tag,data),''))
    from (${rows.join(' union all ')}) preserved_rows;`);
}
function catalog() {
  return JSON.parse(sql(`select jsonb_build_object(
    'tables',(select coalesce(jsonb_object_agg(format('%I.%I',n.nspname,c.relname),
      jsonb_build_object('acl',to_jsonb(c.relacl),'owner',c.relowner,'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,
        'columns',(select jsonb_agg(jsonb_build_object('name',a.attname,'acl',to_jsonb(a.attacl)) order by a.attnum)
          from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped))), '{}')
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private','auth') and c.relkind='r'),
    'policies',(select coalesce(jsonb_object_agg(format('%I.%I.%I',n.nspname,c.relname,p.polname),
      jsonb_build_object('command',p.polcmd,'permissive',p.polpermissive,'roles',to_jsonb(p.polroles),
        'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid))), '{}')
      from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace
      where n.nspname in('public','private','auth')),
    'indexes',(select coalesce(jsonb_object_agg(format('%I.%I',n.nspname,c.relname),pg_get_indexdef(c.oid)), '{}')
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private','auth') and c.relkind='i'),
    'constraints',(select coalesce(jsonb_object_agg(format('%I.%I.%I',n.nspname,c.relname,x.conname),
      pg_get_constraintdef(x.oid,true)), '{}') from pg_constraint x join pg_class c on c.oid=x.conrelid
      join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private','auth')),
    'triggers',(select coalesce(jsonb_object_agg(format('%I.%I.%I',n.nspname,c.relname,t.tgname),
      pg_get_triggerdef(t.oid,true)), '{}') from pg_trigger t join pg_class c on c.oid=t.tgrelid
      join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private','auth')),
    'functions',(select coalesce(jsonb_object_agg(format('%I.%I(%s)',n.nspname,p.proname,
      pg_get_function_identity_arguments(p.oid)),jsonb_build_object('definition',pg_get_functiondef(p.oid),
        'source',p.prosrc,'acl',to_jsonb(p.proacl),'oid',p.oid,'owner',p.proowner,'config',to_jsonb(p.proconfig),
        'volatility',p.provolatile,'securityDefiner',p.prosecdef,'returnType',p.prorettype,'language',p.prolang,
        'strict',p.proisstrict,'leakproof',p.proleakproof,'parallel',p.proparallel)), '{}')
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','private','auth') and p.prokind='f'));`));
}
function denied(commandSql) {
  sql(`do $denial$ begin begin
    ${commandSql.replace(/^select /, 'perform ')}
    raise exception 'EXPECTED_SESSION_DENIAL';
  exception when sqlstate '42501' then
    if sqlerrm<>'SESSION_REVOKED' then raise exception 'UNEXPECTED_SESSION_DENIAL'; end if;
  end; end $denial$;`);
}
try {
  const status = JSON.parse(execFileSync(process.execPath, [cli, '--workdir', root, 'status', '--output', 'json'],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert(['localhost', '127.0.0.1'].includes(new URL(status.API_URL).hostname));
  phase = 'isolated-source-manifest';
  const interval = prepareWorkspace(); resetStarted = true;
  phase = 'baseline99'; reset(baseline, interval);
  assert.equal(sql('select count(*) from supabase_migrations.schema_migrations;'), '99');
  assert.equal(sql('select max(version) from supabase_migrations.schema_migrations;'), baseline);
  phase = 'baseline-real-ledgers-and-receipt'; sql(`begin;${fixture}commit;`);
  const receipt = JSON.parse(sql(command(201)));
  assert.equal(sql(`select status from public.profiles where id='${id(2)}';`), 'deactivation_pending');
  assert.equal(sql(`select count(*) from private.command_executions where actor_profile_id='${id(1)}'
    and command_type='cleaning.lifecycle.allow_finish' and idempotency_key='session-upgrade-allow-finish';`), '1');
  assert.equal(sql(`select public.is_active_auth_session('${id(101)}','${id(401)}');`), 't',
    'pre100 reproduces the narrow helper gap with a still-existing expired row');
  assert(JSON.parse(sql(adminRead(401))).attempt);
  assert(JSON.parse(sql(limitedRead)).capability);
  const oldShape = shape(), oldCatalog = catalog(), oldRows = digest(oldShape);
  const helperKeys = Object.keys(oldCatalog.functions).filter(key => key.startsWith('public.is_active_auth_session('));
  assert.equal(helperKeys.length, 1); const helperKey = helperKeys[0];
  const migrationSource = readFileSync(join(migrationDirectory, `${added}_auth_session_hard_expiry.sql`), 'utf8');
  const expectedSource = migrationSource.split('as $$')[1]?.split('$$;')[0];
  assert(expectedSource && /s\.not_after is null or s\.not_after > statement_timestamp\(\)/.test(expectedSource));
  phase = '99-to100';
  execFileSync(process.execPath, [cli, '--workdir', interval, 'migration', 'up', '--local'],
    { cwd: interval, stdio: 'inherit' });
  assert.equal(sql('select count(*) from supabase_migrations.schema_migrations;'), '100');
  assert.equal(sql('select max(version) from supabase_migrations.schema_migrations;'), added);
  assert.deepEqual(shape(), oldShape, 'Every old table/column shape remains exact');
  assert.equal(digest(oldShape), oldRows, 'Every old business/Auth whole row and receipt remains exact');
  const installed = catalog();
  for (const group of ['tables', 'policies', 'indexes', 'constraints', 'triggers']) {
    assert.deepEqual(installed[group], oldCatalog[group], `All old ${group} definitions, ACL and RLS remain exact`);
  }
  assert.deepEqual(Object.keys(installed.functions).sort(), Object.keys(oldCatalog.functions).sort());
  for (const [key, previous] of Object.entries(oldCatalog.functions)) {
    if (key !== helperKey) assert.deepEqual(installed.functions[key], previous, 'All other functions remain byte-exact');
  }
  const { definition: oldDefinition, source: oldSource, ...oldHelperContract } = oldCatalog.functions[helperKey];
  const { definition: newDefinition, source: newSource, ...newHelperContract } = installed.functions[helperKey];
  assert.deepEqual(newHelperContract, oldHelperContract, 'Helper identity/owner/ACL/STABLE/SECDEF/search_path/type remain exact');
  assert.notEqual(newDefinition, oldDefinition); assert.notEqual(newSource, oldSource);
  assert.equal(newSource.replaceAll('\r\n', '\n').trim(), expectedSource.replaceAll('\r\n', '\n').trim());
  assert.equal(sql(`select has_function_privilege('service_role',${literal(signature)},'EXECUTE')
    and not has_function_privilege('anon',${literal(signature)},'EXECUTE')
    and not has_function_privilege('authenticated',${literal(signature)},'EXECUTE');`), 't');
  phase = 'valid-read-and-replay';
  assert.deepEqual(JSON.parse(sql(command(301))), receipt, 'Future session replays the exact old command receipt');
  assert(JSON.parse(sql(adminRead(201))).attempt); assert(JSON.parse(sql(limitedRead)).capability);
  assert.equal(digest(oldShape), oldRows, 'Valid NULL/future reads/replay create no duplicate state');
  phase = 'expired-read-and-replay-denial';
  assert.equal(sql(`select public.is_active_auth_session('${id(101)}','${id(401)}');`), 'f');
  denied(adminRead(401)); denied(command(401));
  sql(`update auth.sessions set not_after=statement_timestamp()-interval '1 day' where id='${id(202)}';`);
  const expiredRows = digest(oldShape); denied(limitedRead);
  assert.equal(digest(oldShape), expiredRows, 'Expired limited read changes no row');
  sql(`update auth.sessions set not_after=null where id='${id(202)}';`);
  assert.equal(digest(oldShape), oldRows, 'Expired read/replay denials preserve every old receipt and whole row');
  console.log('Auth session hard expiry100 / upgrade99→100 PASS: exact source interval, all old business/Auth rows and receipt preserved; helper-only body change with exact existing ACL/contract; valid replay preserved, expired read/limited-read/replay rejected.');
} catch (error) {
  const line = error instanceof Error ? error.stack?.match(/test-auth-session-hard-expiry-upgrade\.mjs:(\d+):\d+/)?.[1] : null;
  console.error(`Auth session hard expiry upgrade FAIL: ${JSON.stringify({ phase,
    kind: error instanceof assert.AssertionError ? 'ASSERTION_FAILED' : 'VALIDATION_FAILED', sourceLine: line ? Number(line) : null })}`);
  process.exitCode = 1;
} finally {
  if (resetStarted) {
    try {
      reset(); const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')), files = sourceMigrationFiles(manifest);
      assert.equal(sql('select count(*) from supabase_migrations.schema_migrations;'), String(manifest.totalCount));
      assert.equal(sql('select max(version) from supabase_migrations.schema_migrations;'), migrationPattern.exec(files.at(-1))[1]);
      assert.equal(sql('select count(*) from public.profiles;'), '0');
      assert.equal(sql('select count(*) from auth.users;'), '0');
    } catch { console.error('Auth session hard expiry upgrade fresh cleanup FAIL'); process.exitCode = 1; }
  }
  if (temporaryWorkspace) {
    try {
      assert.equal(relative(realpathSync(root), realpathSync(temporaryRoot)), '.tmp');
      const path = realpathSync(temporaryWorkspace);
      assert.equal(relative(realpathSync(temporaryRoot), path), basename(temporaryWorkspace));
      assert(basename(temporaryWorkspace).startsWith(temporaryPrefix));
      rmSync(path, { recursive: true, force: false });
    } catch { console.error('Auth session hard expiry upgrade generated workspace cleanup FAIL'); process.exitCode = 1; }
  }
}
