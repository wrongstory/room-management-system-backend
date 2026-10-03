import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Disposable local95→96 only; finally restore the original workspace's current
// migrations. Later migrations must not weaken or invalidate this exact interval.
// No remote DB, secret/PIN output, receipt
// hydration or history-key exclusions. Baseline95 already owns the #328 packs.
const root = fileURLToPath(new URL('..', import.meta.url));
const cli = fileURLToPath(new URL('../node_modules/supabase/dist/supabase.js', import.meta.url));
const psqlArgs = ['exec', '-i', 'supabase_db_room-management-system-backend', 'psql', '-X', '-qAt',
  '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'];
const baseline = '20261002101126';
const added = '20261002161001';
const manifestPath = fileURLToPath(new URL('../supabase/migration-manifest.dev.json', import.meta.url));
const migrationDirectory = fileURLToPath(new URL('../supabase/migrations', import.meta.url));
const initialManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const expectedCount = initialManifest.totalCount;
assert(Number.isSafeInteger(expectedCount) && expectedCount >= 96);
const migrationPattern = /^(\d{14})_([a-z0-9_]+)\.sql$/;
const temporaryRoot = fileURLToPath(new URL('../.tmp', import.meta.url));
const temporaryPrefix = 'checkout-incident-list-upgrade-';
const fixtureSource = readFileSync(new URL('../supabase/tests/checkout_incident_admin_list.sql', import.meta.url), 'utf8');
const fixtureBegin = '-- CHECKOUT_LIST_FIXTURE_BEGIN';
const fixtureEnd = '-- CHECKOUT_LIST_FIXTURE_END';
assert.equal(fixtureSource.split(fixtureBegin).length, 2, 'One exact source-controlled setup start');
assert.equal(fixtureSource.split(fixtureEnd).length, 2, 'One exact source-controlled setup end');
const fixture = fixtureSource.split(fixtureBegin)[1].split(fixtureEnd)[0];
const pinFixture = readFileSync(new URL('../supabase/tests/room_pin_fixture.psql', import.meta.url), 'utf8');
const id = (n) => `f3270000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const literal = (value) => `'${value.replaceAll("'", "''")}'`;
const rpcSignature = 'public.list_checkout_presence_incidents_page(uuid,uuid,uuid,uuid,date,timestamptz,uuid,integer)';
const listSql = `select public.list_checkout_presence_incidents_page('${id(3)}','${id(203)}',null,null,null,null,null,50);`;
const reportSql = `select public.report_checkout_presence_incident('${id(2)}','${id(202)}',
  (select attempt_id from public.checkout_presence_incidents where reservation_id='${id(1001)}'),1,
  (select assignment_id from public.checkout_presence_incidents where reservation_id='${id(1001)}'),
  (select assignment_revision from public.checkout_presence_incidents where reservation_id='${id(1001)}'),
  'checkout-list-real-report',repeat('5',64));`;
let phase = 'local-identity';
let resetStarted = false;
let temporaryWorkspace;
function sourceMigrationFiles(manifest) {
  const files = readdirSync(migrationDirectory, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith('.sql'))
    .sort((left, right) => left.name.localeCompare(right.name));
  assert.equal(files.length, manifest.totalCount, 'Current manifest and source migration count must match');
  assert.equal(manifest.migrations.length, files.length, 'Every migration has source-controlled metadata');
  let previousVersion = '';
  for (const [index, entry] of files.entries()) {
    const match = migrationPattern.exec(entry.name);
    assert(entry.isFile() && match && match[1] > previousVersion, 'Only regular ordered source migrations are allowed');
    assert.equal(manifest.migrations[index].order, index + 1, 'Manifest order is exact');
    assert.equal(manifest.migrations[index].name, match[2], 'Manifest source filename is exact');
    previousVersion = match[1];
  }
  return files.map((entry) => entry.name);
}
function prepareIntervalWorkspace() {
  const files = sourceMigrationFiles(initialManifest).slice(0, 96);
  assert.equal(files.length, 96, 'The isolated interval contains exactly96 source migrations');
  assert(files[94].startsWith(`${baseline}_`) && files[95].startsWith(`${added}_`), 'Exact baseline95 and successor96');
  const configPath = fileURLToPath(new URL('../supabase/config.toml', import.meta.url));
  const configSource = readFileSync(configPath, 'utf8');
  const projectAssignments = configSource.match(/^[ \t]*project_id[ \t]*=/gm) ?? [];
  const configuredProject = /^[ \t]*project_id[ \t]*=[ \t]*"([^"\r\n]+)"[ \t]*(?:#[^\r\n]*)?\r?$/m.exec(configSource);
  assert.equal(projectAssignments.length, 1, 'The source config has one unambiguous local project');
  assert.equal(configuredProject?.[1], 'room-management-system-backend',
    'Both CLI workspaces must address the fixed Docker psql project');
  mkdirSync(temporaryRoot, { recursive: true });
  assert.equal(relative(realpathSync(root), realpathSync(temporaryRoot)), '.tmp', 'Generated workspace stays inside original .tmp');
  temporaryWorkspace = mkdtempSync(join(temporaryRoot, temporaryPrefix));
  const temporarySupabase = join(temporaryWorkspace, 'supabase');
  const temporaryMigrations = join(temporarySupabase, 'migrations');
  mkdirSync(temporaryMigrations, { recursive: true });
  // Deliberately do not copy .env, .temp, linked project metadata, credentials,
  // functions or user files. The checked-in config keeps the same local project.
  copyFileSync(configPath, join(temporarySupabase, 'config.toml'), constants.COPYFILE_EXCL);
  for (const [index, file] of files.entries()) {
    const source = join(migrationDirectory, file);
    const canonical = readFileSync(source, 'utf8').replaceAll('\r\n', '\n');
    assert(!canonical.includes('\r'), 'Migration canonicalization preserves the source manifest contract');
    assert.equal(createHash('sha256').update(canonical, 'utf8').digest('hex'), initialManifest.migrations[index].sha256,
      'Every copied migration matches its complete source-controlled hash');
    copyFileSync(source, join(temporaryMigrations, file), constants.COPYFILE_EXCL);
  }
  return temporaryWorkspace;
}
function sql(input) {
  try {
    // Complete definitions/ACLs for every existing function exceed Node's
    // default 1 MiB stdout buffer. Keep that preservation proof intact with a
    // bounded local buffer; catalog/raw data must still never be logged.
    return execFileSync('docker', psqlArgs, { cwd: root, input, encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 16 * 1024 * 1024 }).trim();
  } catch {
    // Never interpolate subprocess stdout/stderr, SQL, identities or raw data.
    throw new Error('CHECKOUT_INCIDENT_LIST_UPGRADE_SQL_FAILED');
  }
}
function reset(version, workdir = root) {
  const args = [cli, '--workdir', workdir, 'db', 'reset', '--local', '--no-seed'];
  if (version) args.push('--version', version);
  execFileSync(process.execPath, args, { cwd: workdir, stdio: 'inherit' });
}
function tableShape() {
  return JSON.parse(sql(`select coalesce(jsonb_agg(jsonb_build_object('table',table_name,'columns',columns)
    order by table_name),'[]') from (
    select format('%I.%I',n.nspname,c.relname) table_name,jsonb_agg(a.attname order by a.attnum) columns
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
    where n.nspname in('public','private') and c.relkind='r' group by n.nspname,c.relname) tables;`));
}
function digest(shape) {
  const rows = shape.map(({ table }) => {
    assert(/^(public|private)\.[a-z_][a-z_0-9]*$/.test(table), 'Source-controlled table identifier');
    return `select ${literal(table)} tag,to_jsonb(t)::text data from ${table} t`;
  });
  return sql(`select md5(coalesce(string_agg(tag||':'||data,'|' order by tag,data),''))
    from (${rows.join(' union all ')}) history;`);
}
function protectionCatalog() {
  return JSON.parse(sql(`select jsonb_build_object(
    'tables',(select coalesce(jsonb_object_agg(format('%I.%I',n.nspname,c.relname),
      jsonb_build_object('acl',to_jsonb(c.relacl),'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,
        'columns',(select jsonb_agg(jsonb_build_object('name',a.attname,'acl',to_jsonb(a.attacl)) order by a.attnum)
          from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped))), '{}')
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname in('public','private') and c.relkind='r'),
    'policies',(select coalesce(jsonb_object_agg(format('%I.%I.%I',n.nspname,c.relname,p.polname),
      jsonb_build_object('command',p.polcmd,'permissive',p.polpermissive,'roles',to_jsonb(p.polroles),
        'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid))), '{}')
      from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace
      where n.nspname in('public','private')),
    'functions',(select coalesce(jsonb_object_agg(format('%I.%I(%s)',n.nspname,p.proname,
      pg_get_function_identity_arguments(p.oid)),jsonb_build_object('definition',pg_get_functiondef(p.oid),
        'acl',to_jsonb(p.proacl),'owner',p.proowner,'config',to_jsonb(p.proconfig),'volatility',p.provolatile)), '{}')
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in('public','private') and p.prokind='f'));`));
}
try {
  const status = JSON.parse(execFileSync(process.execPath, [cli, 'status', '--output', 'json'],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert(['localhost', '127.0.0.1'].includes(new URL(status.API_URL).hostname), 'Only disposable local reset is allowed');
  phase = 'isolated-source-workspace';
  const intervalWorkspace = prepareIntervalWorkspace();
  resetStarted = true;
  phase = 'baseline-95';
  reset(baseline, intervalWorkspace);
  assert.equal(sql('select count(*) from supabase_migrations.schema_migrations;'), '95');
  phase = 'baseline-fixture-setup';
  sql(`begin; ${pinFixture}
    select set_config('app.checkout_list_fixture_count','3',true);
    ${fixture}
    commit;`);
  phase = 'baseline-table-shape';
  const shape = tableShape();
  assert(shape.find(({ table }) => table === 'public.cleaning_assignments').columns.includes('notified_reservation_schedule_snapshot'));
  assert(shape.find(({ table }) => table === 'public.cleaning_target_schedule_revisions').columns.includes('reservation_schedule_snapshot'));
  phase = 'baseline-capture-packs';
  assert.equal(sql(`select (select count(*) from public.checkout_presence_incidents)=3
    and exists(select 1 from public.cleaning_assignments where notified_reservation_schedule_snapshot is not null)
    and exists(select 1 from public.cleaning_target_schedule_revisions where reservation_schedule_snapshot is not null);`), 't',
  'Actual baseline has open reports and non-null #328 capture packs');
  phase = 'baseline-report-receipt';
  const originalReceipt = JSON.parse(sql(reportSql));
  phase = 'baseline-existing-detail';
  const originalDetail = JSON.parse(sql(`select public.get_checkout_presence_incident('${id(3)}','${id(203)}',
    (select id from public.checkout_presence_incidents where reservation_id='${id(1001)}'));`));
  phase = 'baseline-protection-catalog';
  const catalog = protectionCatalog();
  phase = 'baseline-complete-row-digest';
  const preserved = digest(shape);
  phase = '95-to-96';
  execFileSync(process.execPath, [cli, '--workdir', intervalWorkspace, 'migration', 'up', '--local'],
    { cwd: intervalWorkspace, stdio: 'inherit' });
  assert.equal(sql('select count(*) from supabase_migrations.schema_migrations;'), '96');
  assert.equal(sql('select max(version) from supabase_migrations.schema_migrations;'), added);
  assert.equal(sql(`select exists(select 1 from supabase_migrations.schema_migrations where version='${added}');`), 't');
  assert.deepEqual(tableShape(), shape, 'No public/private table or column is added, removed or reordered');
  assert.equal(digest(shape), preserved, 'Every complete baseline row is exact, including #328 snapshot and receipt keys');
  const installed = protectionCatalog();
  assert.deepEqual(installed.tables, catalog.tables, 'Every existing table/column ACL and RLS setting is unchanged');
  assert.deepEqual(installed.policies, catalog.policies, 'Every existing RLS policy is unchanged');
  for (const [signature, prior] of Object.entries(catalog.functions)) {
    assert.deepEqual(installed.functions[signature], prior, 'Every existing complete function/ACL/config is unchanged');
  }
  assert.equal(Object.keys(installed.functions).length, Object.keys(catalog.functions).length + 1,
    'Exactly one additive public read RPC, no helper/command replacement');
  assert.equal(sql(`select has_function_privilege('service_role','${rpcSignature}','EXECUTE')
    and not has_function_privilege('authenticated','${rpcSignature}','EXECUTE')
    and not has_function_privilege('anon','${rpcSignature}','EXECUTE')
    and not has_table_privilege('service_role','public.checkout_presence_incidents','SELECT');`), 't');
  phase = 'read-only-and-exact-replay';
  const list = JSON.parse(sql(listSql));
  assert.deepEqual(Object.keys(list), ['items']);
  assert.equal(list.items.length, 3);
  assert.equal(list.items[0].incidentId, originalReceipt.incidentId);
  assert(list.items.every((item) => Object.keys(item).length === 10 && item.status === 'open'));
  assert.equal(list.items[1].reportedAt, '2001-01-01T00:00:00.123457Z');
  assert.equal(list.items[2].reportedAt, '2001-01-01T00:00:00.123456Z');
  sql(`begin read only; ${listSql} rollback;`);
  assert.deepEqual(JSON.parse(sql(reportSql)), originalReceipt, 'Successful report receipt replays exact without hydration');
  assert.deepEqual(JSON.parse(sql(`select public.get_checkout_presence_incident('${id(3)}','${id(203)}',
    (select id from public.checkout_presence_incidents where reservation_id='${id(1001)}'));`)), originalDetail,
  'Existing latest detail/version/fingerprint and ownership contract is exact');
  assert.equal(digest(shape), preserved, 'Read-only list, detail and successful replay leave all original rows exact');
  console.log('Checkout incident admin list96 / upgrade95→96: PASS; complete rows, #328 packs, exact receipts, existing function/ACL/RLS and read-only behavior preserved.');
} catch (error) {
  const sourceLine = error instanceof Error ? error.stack?.match(/test-checkout-incident-list-upgrade\.mjs:(\d+):\d+/)?.[1] : null;
  console.error(`Checkout incident list upgrade FAIL: ${JSON.stringify({ phase,
    kind: error instanceof assert.AssertionError ? 'ASSERTION_FAILED' : 'VALIDATION_FAILED',
    sourceLine: sourceLine ? Number(sourceLine) : null })}`);
  process.exitCode = 1;
} finally {
  if (resetStarted) {
    try {
      // Restore every current source migration, including future97+, before the
      // full SQL suite. The preservation proof above remains fixed at 95→96.
      reset();
      const latestManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const latestFiles = sourceMigrationFiles(latestManifest);
      assert.equal(sql('select count(*) from supabase_migrations.schema_migrations;'), String(latestManifest.totalCount));
      assert.equal(sql('select max(version) from supabase_migrations.schema_migrations;'), migrationPattern.exec(latestFiles.at(-1))[1]);
    } catch { console.error('Checkout incident list upgrade fresh cleanup FAIL'); process.exitCode = 1; }
  }
  if (temporaryWorkspace) {
    try {
      // Never delete the original workspace, .tmp itself or another user's path.
      // Resolve both boundaries again immediately before deleting this mkdtemp.
      assert.equal(relative(realpathSync(root), realpathSync(temporaryRoot)), '.tmp');
      const resolvedWorkspace = realpathSync(temporaryWorkspace);
      assert.equal(relative(realpathSync(temporaryRoot), resolvedWorkspace), basename(temporaryWorkspace));
      assert(basename(temporaryWorkspace).startsWith(temporaryPrefix));
      rmSync(resolvedWorkspace, { recursive: true, force: false });
    } catch { console.error('Checkout incident list upgrade generated workspace cleanup FAIL'); process.exitCode = 1; }
  }
}
