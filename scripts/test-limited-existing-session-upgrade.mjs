import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Exact local100->101, independently of future migrations. Never use remotely.
const root = fileURLToPath(new URL('..', import.meta.url));
const cli = fileURLToPath(new URL('../node_modules/supabase/dist/supabase.js', import.meta.url));
const project = 'room-management-system-backend';
const psqlArgs = ['exec', '-i', `supabase_db_${project}`, 'psql', '-X', '-qAt',
  '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'];
const baseline = '20261003095426', added = '20261003140716';
const migrationPattern = /^(\d{14})_([a-z0-9_]+)\.sql$/;
const manifestPath = fileURLToPath(new URL('../supabase/migration-manifest.dev.json', import.meta.url));
const migrationDirectory = fileURLToPath(new URL('../supabase/migrations', import.meta.url));
const initialManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
assert(Number.isSafeInteger(initialManifest.totalCount) && initialManifest.totalCount >= 101);
const temporaryRoot = fileURLToPath(new URL('../.tmp', import.meta.url));
const temporaryPrefix = 'limited-existing-session-upgrade-';
const oldFixture = readFileSync(new URL('../supabase/tests/auth_session_hard_expiry_fixture.psql', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const freshFixture = readFileSync(new URL('../supabase/tests/limited_existing_session_fixture.psql', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
for (const fixture of [oldFixture, freshFixture]) assert(!/\\ir|\b(?:no_plan|plan|finish)\s*\(/i.test(fixture));
const id = n => `f3520000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const freshId = n => `f3290000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const literal = value => `'${value.replaceAll("'", "''")}'`;
const legacyCommand = `select public.manage_cleaning_attempt_lifecycle('${id(1)}','${id(201)}',
  '${id(801)}',2,'${id(701)}',2,1,'allow_finish','{}','DEACTIVATION_FINISH_CURRENT',
  'limited-upgrade-old-receipt',repeat('b',64));`;
const newTables = ['private.attempt_capability_session_roots', 'private.limited_session_eligibility', 'private.limited_session_roots'];
const changedNames = ['private.assert_attempt_actor_session', 'private.live_attempt_capability',
  'private.complete_limited_attempt_at', 'private.manage_cleaning_attempt_lifecycle_at', 'private.assert_photo_upload_actor',
  'public.claim_photo_upload', 'public.finalize_photo_upload', 'private.submission_actor', 'public.create_cleaning_submission',
  'public.begin_photo_upload', 'public.admit_photo_upload', 'public.begin_admitted_photo_upload',
  'public.admit_photo_collection_upload', 'public.begin_admitted_photo_collection_upload',
  'public.delete_photo_collection_item', 'public.get_photo_provider_context', 'public.reserve_photo_drive_folder',
  'private.start_attempt_with_lease_at', 'private.sync_attempt_event_at', 'private.resolve_offline_quarantine_at',
  'public.publish_checkout_cleaning_template', 'public.list_room_operation_blocks', 'public.list_room_issues',
  'public.list_room_events', 'public.correct_room_occupancy', 'public.override_room_display_status',
  'private.cancel_unavailable_cleaning_assignment_at', 'public.list_room_operation_blocks_page', 'public.list_room_issues_page'];
const newNames = ['private.guard_capability_session_root_identity', 'private.limited_session_digest',
  'private.current_limited_session_root', 'private.capability_matches_session_root', 'private.freeze_limited_sessions',
  'private.inherit_limited_session_root', 'public.list_limited_cleaning_attempts',
  'private.create_cleaning_submission_session_core', 'public.create_cleaning_submission_with_session',
  'public.get_photo_upload_receipt_with_session', 'private.assert_photo_operation_session',
  'private.assert_attempt_actor_session_at_clock', 'private.assert_attempt_actor_session_fresh'];
let phase = 'local-identity', resetStarted = false;
const temporaryWorkspaces = [];

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
function prepareWorkspace(manifest, count) {
  const files = sourceMigrationFiles(manifest).slice(0, count);
  assert(Number.isSafeInteger(count) && count >= 101 && count <= manifest.totalCount);
  assert.equal(files.length, count);
  assert(files[99] === `${baseline}_auth_session_hard_expiry.sql` && files[100] === `${added}_limited_existing_session_discovery.sql`);
  const config = fileURLToPath(new URL('../supabase/config.toml', import.meta.url));
  const source = readFileSync(config, 'utf8');
  assert.equal((source.match(/^[ \t]*project_id[ \t]*=/gm) ?? []).length, 1);
  assert.equal(/^[ \t]*project_id[ \t]*=[ \t]*"([^"\r\n]+)"[ \t]*(?:#[^\r\n]*)?\r?$/m.exec(source)?.[1], project);
  mkdirSync(temporaryRoot, { recursive: true });
  assert.equal(relative(realpathSync(root), realpathSync(temporaryRoot)), '.tmp');
  const temporaryWorkspace = mkdtempSync(join(temporaryRoot, temporaryPrefix));
  assert.equal(relative(realpathSync(temporaryRoot), realpathSync(temporaryWorkspace)), basename(temporaryWorkspace));
  assert(basename(temporaryWorkspace).startsWith(temporaryPrefix));
  temporaryWorkspaces.push(temporaryWorkspace);
  const target = join(temporaryWorkspace, 'supabase', 'migrations');
  mkdirSync(target, { recursive: true });
  copyFileSync(config, join(temporaryWorkspace, 'supabase', 'config.toml'), constants.COPYFILE_EXCL);
  for (const [index, file] of files.entries()) {
    // Only the newly generated temporary file is LF-normalized. Original SQL
    // and every canonical manifest SHA remain untouched, including applied100.
    const canonical = readFileSync(join(migrationDirectory, file), 'utf8').replaceAll('\r\n', '\n');
    assert(!canonical.includes('\r'));
    const expected = manifest.migrations[index].sha256;
    assert.equal(createHash('sha256').update(canonical, 'utf8').digest('hex'), expected);
    const destination = join(target, file);
    writeFileSync(destination, canonical, { encoding: 'utf8', flag: 'wx' });
    assert.equal(createHash('sha256').update(readFileSync(destination)).digest('hex'), expected);
  }
  return temporaryWorkspace;
}
function sql(input) {
  try {
    return execFileSync('docker', psqlArgs, { cwd: root, input, encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 32 * 1024 * 1024 }).trim();
  } catch { throw new Error('LIMITED_SESSION_UPGRADE_SQL_FAILED'); }
}
function reset(version, workdir = root) {
  const args = [cli, '--workdir', workdir, 'db', 'reset', '--local', '--no-seed'];
  if (version) args.push('--version', version);
  execFileSync(process.execPath, args, { cwd: workdir, stdio: 'inherit', timeout: 180000 });
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
function denied(input, message = 'CAPABILITY_ACCESS_REQUIRED') {
  sql(`do $denial$ begin begin ${input.replace(/^select /, 'perform ')}
    raise exception 'EXPECTED_LIMITED_DENIAL'; exception when sqlstate '42501' then
    if sqlerrm<>${literal(message)} then raise exception 'UNEXPECTED_LIMITED_DENIAL'; end if; end; end $denial$;`);
}
try {
  const status = JSON.parse(execFileSync(process.execPath, [cli, '--workdir', root, 'status', '--output', 'json'],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }));
  assert(['localhost', '127.0.0.1'].includes(new URL(status.API_URL).hostname));
  phase = 'isolated-source-manifest'; const interval = prepareWorkspace(initialManifest, 101); resetStarted = true;
  phase = 'baseline100'; reset(baseline, interval);
  assert.equal(sql('select count(*) from supabase_migrations.schema_migrations;'), '100');
  assert.equal(sql('select max(version) from supabase_migrations.schema_migrations;'), baseline);
  phase = 'legacy-live-grant-and-receipt'; sql(`begin;${oldFixture}commit;`);
  const oldReceipt = JSON.parse(sql(legacyCommand));
  assert(JSON.parse(sql(`select public.get_limited_cleaning_attempt('${id(2)}','${id(202)}','${id(801)}',2);`)).capability);
  const oldShape = shape(), oldCatalog = catalog(), oldRows = digest(oldShape);
  phase = '100-to101';
  execFileSync(process.execPath, [cli, '--workdir', interval, 'migration', 'up', '--local'],
    { cwd: interval, stdio: 'inherit', timeout: 180000 });
  assert.equal(sql('select count(*) from supabase_migrations.schema_migrations;'), '101');
  assert.equal(sql('select max(version) from supabase_migrations.schema_migrations;'), added);
  const installedShape = shape();
  assert.deepEqual(installedShape.filter(x => !newTables.includes(x.table)), oldShape, 'All old table/column shapes remain exact');
  assert.deepEqual(installedShape.filter(x => newTables.includes(x.table)).map(x => x.table), newTables);
  assert.equal(digest(oldShape), oldRows, 'Every old Auth/business whole row, grant, notification and receipt remains exact');
  for (const table of newTables) assert.equal(sql(`select count(*) from ${table};`), '0', 'No legacy evidence or binding is backfilled');
  const installed = catalog();
  for (const group of ['tables', 'policies', 'indexes', 'constraints', 'triggers']) {
    for (const [key, previous] of Object.entries(oldCatalog[group])) assert.deepEqual(installed[group][key], previous,
      `Every old ${group} definition, ACL/RLS remains exact`);
  }
  const changed = [];
  for (const [key, previous] of Object.entries(oldCatalog.functions)) {
    const current = installed.functions[key]; assert(current);
    if (changedNames.some(name => key.startsWith(`${name}(`))) {
      const { definition: oldDefinition, source: oldSource, ...oldContract } = previous;
      const { definition: newDefinition, source: newSource, ...newContract } = current;
      assert.deepEqual(newContract, oldContract,
        'All changed existing functions preserve OID/ACL/owner/volatility/search_path/language/types');
      assert.notEqual(newDefinition, oldDefinition); assert.notEqual(newSource, oldSource); changed.push(key.split('(')[0]);
    } else assert.deepEqual(current, previous, 'All out-of-scope functions remain byte-exact');
  }
  assert.deepEqual(changed.sort(), [...changedNames].sort());
  const newFunctionKeys = Object.keys(installed.functions).filter(key => !Object.hasOwn(oldCatalog.functions, key));
  assert.deepEqual(newFunctionKeys.map(key => key.split('(')[0]).sort(), [...newNames].sort());
  for (const table of newTables) assert.equal(sql(`select relrowsecurity and not has_table_privilege('service_role',${literal(table)},'SELECT')
    and not has_table_privilege('authenticated',${literal(table)},'SELECT') from pg_class where oid=${literal(table)}::regclass;`), 't');
  phase = 'legacy-fail-closed-and-admin-replay';
  denied(`select public.get_limited_cleaning_attempt('${id(2)}','${id(202)}','${id(801)}',2);`);
  denied(`select public.list_limited_cleaning_attempts('${id(2)}','${id(202)}');`);
  assert.deepEqual(JSON.parse(sql(legacyCommand)), oldReceipt, 'Existing administrator receipt is not renewed or changed');
  assert.equal(digest(oldShape), oldRows, 'Legacy denial and administrator replay change no old row');
  phase = 'new-transition-eligibility'; sql(`begin;${freshFixture}commit;`);
  sql(`select public.manage_cleaning_attempt_lifecycle('${freshId(1)}','${freshId(201)}','${freshId(501)}',1,
    '${freshId(401)}',2,1,'allow_finish','{}','DEACTIVATION_FINISH_CURRENT','limited-upgrade-new-grant',repeat('c',64));`);
  const discovery = JSON.parse(sql(`select public.list_limited_cleaning_attempts('${freshId(2)}','${freshId(202)}');`));
  assert.equal(discovery.profileStatus, 'deactivation_pending'); assert.equal(discovery.items.length, 1);
  assert.deepEqual(Object.keys(discovery.items[0]).sort(), ['allowedActions','assignmentId','assignmentRevision','attemptId',
    'executionVersion','expiresAt','issuedAt','kind','status'].sort());
  assert.equal(sql(`select count(*) from private.limited_session_roots where actor_profile_id='${freshId(2)}';`), '1');
  assert.equal(sql('select count(*) from private.limited_session_eligibility;'), '2');
  sql(`insert into auth.sessions(id,user_id,created_at) values('${freshId(602)}','${freshId(102)}',clock_timestamp()-interval '1 day');`);
  denied(`select public.list_limited_cleaning_attempts('${freshId(2)}','${freshId(602)}');`);
  console.log('Limited existing session101 / upgrade100→101 PASS: exact isolated interval; all old whole rows/receipts/catalog contracts preserved; three private evidence tables empty without legacy backfill; old limited grant denied; new actual transition freezes existing sessions only.');
} catch (error) {
  const line = error instanceof Error ? error.stack?.match(/test-limited-existing-session-upgrade\.mjs:(\d+):\d+/)?.[1] : null;
  console.error(`Limited existing session upgrade FAIL: ${JSON.stringify({ phase,
    kind: error instanceof assert.AssertionError ? 'ASSERTION_FAILED' : 'VALIDATION_FAILED', sourceLine: line ? Number(line) : null })}`);
  process.exitCode = 1;
} finally {
  if (resetStarted) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')), files = sourceMigrationFiles(manifest);
      // Future102+ source must be restored fully, but through a separate known
      // fresh LF workspace. Resetting original Windows CRLF source re-breaks93.
      const latest = prepareWorkspace(manifest, manifest.totalCount); reset(undefined, latest);
      assert.equal(sql('select count(*) from supabase_migrations.schema_migrations;'), String(manifest.totalCount));
      assert.equal(sql('select max(version) from supabase_migrations.schema_migrations;'), migrationPattern.exec(files.at(-1))[1]);
      assert.equal(sql('select count(*) from public.profiles;'), '0'); assert.equal(sql('select count(*) from auth.users;'), '0');
    } catch { console.error('Limited existing session upgrade fresh cleanup FAIL'); process.exitCode = 1; }
  }
  for (const temporaryWorkspace of temporaryWorkspaces) {
    try {
      assert.equal(relative(realpathSync(root), realpathSync(temporaryRoot)), '.tmp');
      const path = realpathSync(temporaryWorkspace);
      assert.equal(relative(realpathSync(temporaryRoot), path), basename(temporaryWorkspace));
      assert(basename(temporaryWorkspace).startsWith(temporaryPrefix)); rmSync(path, { recursive: true, force: false });
    } catch { console.error('Limited existing session upgrade generated workspace cleanup FAIL'); process.exitCode = 1; }
  }
}
