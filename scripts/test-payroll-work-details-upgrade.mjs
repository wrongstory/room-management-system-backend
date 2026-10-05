import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Exact disposable local97→98 proof. Only checked-in config and the first98
// complete source migrations are copied into an isolated generated workspace.
// Later migrations must not change this interval; finally restore root latest.
const root = fileURLToPath(new URL('..', import.meta.url));
const cli = fileURLToPath(new URL('../node_modules/supabase/dist/supabase.js', import.meta.url));
const psqlArgs = ['exec', '-i', 'supabase_db_room-management-system-backend', 'psql', '-X', '-qAt',
  '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'];
const baseline = '20261003021153';
const added = '20261003042015';
const manifestPath = fileURLToPath(new URL('../supabase/migration-manifest.dev.json', import.meta.url));
const migrationDirectory = fileURLToPath(new URL('../supabase/migrations', import.meta.url));
const initialManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
assert(Number.isSafeInteger(initialManifest.totalCount) && initialManifest.totalCount >= 98);
const migrationPattern = /^(\d{14})_([a-z0-9_]+)\.sql$/;
const temporaryRoot = fileURLToPath(new URL('../.tmp', import.meta.url));
const temporaryPrefix = 'payroll-work-details-upgrade-';
const fixtureSource = readFileSync(new URL('../supabase/tests/payroll_adjustment_book.sql', import.meta.url), 'utf8');
const fixtureBegin = '-- PAYROLL_BOOK_FIXTURE_BEGIN';
const fixtureEnd = '-- PAYROLL_BOOK_FIXTURE_END';
assert.equal(fixtureSource.split(fixtureBegin).length, 2, 'One exact source-controlled setup start');
assert.equal(fixtureSource.split(fixtureEnd).length, 2, 'One exact source-controlled setup end');
const fixture = fixtureSource.split(fixtureBegin)[1].split(fixtureEnd)[0];
assert(!/\\ir|\b(?:no_plan|plan|finish)\s*\(/i.test(fixture), 'The shared setup is not a TAP program');
const id = (n) => `f3250000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const literal = (value) => `'${value.replaceAll("'", "''")}'`;
const rpcSignature = 'public.list_payroll_work_details_page(uuid,uuid,text,date,uuid,text,date,uuid,integer)';
let weekSql;
const readSql = (maid = 2, weeks = -4, actor = 1, role = 'admin', kind = 'earnings') => `select public.list_payroll_work_details_page('${id(actor)}',
  '${id(400+actor)}','${role}',${weekSql}+(${weeks}*7),'${id(maid)}','${kind}',null,null,25);`;
const correctionSql = `select public.record_payroll_correction('${id(1)}','${id(5001)}',null,
  -100,0,'book-upgrade-first',repeat('a',64));`;
const entriesSql = () => `select public.list_payroll_entries_page('${id(1)}',${weekSql}-28,
  '${id(2)}','adjustments',null,null,25);`;
let phase = 'local-identity';
let resetStarted = false;
let temporaryWorkspace;
function sourceMigrationFiles(manifest) {
  const files = readdirSync(migrationDirectory, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith('.sql'))
    .sort((left, right) => left.name.localeCompare(right.name));
  assert.equal(files.length, manifest.totalCount, 'Current manifest/source migration count must match');
  assert.equal(manifest.migrations.length, files.length, 'Every source migration has metadata');
  let previousVersion = '';
  for (const [index, entry] of files.entries()) {
    const match = migrationPattern.exec(entry.name);
    assert(entry.isFile() && match && match[1] > previousVersion, 'Only regular ordered source migrations are allowed');
    assert.equal(manifest.migrations[index].order, index + 1, 'Manifest order is exact');
    assert.equal(manifest.migrations[index].name, match[2], 'Manifest filename is exact');
    previousVersion = match[1];
  }
  return files.map((entry) => entry.name);
}
function prepareIntervalWorkspace() {
  const files = sourceMigrationFiles(initialManifest).slice(0, 98);
  assert.equal(files.length, 98, 'The isolated interval contains exactly98 migrations');
  assert(files[96].startsWith(`${baseline}_`) && files[97].startsWith(`${added}_`), 'Exact baseline97/successor98');
  const configPath = fileURLToPath(new URL('../supabase/config.toml', import.meta.url));
  const configSource = readFileSync(configPath, 'utf8');
  assert.equal((configSource.match(/^[ \t]*project_id[ \t]*=/gm) ?? []).length, 1);
  assert.equal(/^[ \t]*project_id[ \t]*=[ \t]*"([^"\r\n]+)"[ \t]*(?:#[^\r\n]*)?\r?$/m.exec(configSource)?.[1],
    'room-management-system-backend', 'The CLI and fixed psql container must address the same local project');
  mkdirSync(temporaryRoot, { recursive: true });
  assert.equal(relative(realpathSync(root), realpathSync(temporaryRoot)), '.tmp');
  temporaryWorkspace = mkdtempSync(join(temporaryRoot, temporaryPrefix));
  const temporarySupabase = join(temporaryWorkspace, 'supabase');
  const temporaryMigrations = join(temporarySupabase, 'migrations');
  mkdirSync(temporaryMigrations, { recursive: true });
  // Never copy .env, .temp, project links, credentials, functions or user files.
  copyFileSync(configPath, join(temporarySupabase, 'config.toml'), constants.COPYFILE_EXCL);
  for (const [index, file] of files.entries()) {
    const source = join(migrationDirectory, file);
    const canonical = readFileSync(source, 'utf8').replaceAll('\r\n', '\n');
    assert(!canonical.includes('\r'), 'Canonical migration bytes have only LF');
    assert.equal(createHash('sha256').update(canonical, 'utf8').digest('hex'), initialManifest.migrations[index].sha256,
      'Each copied source migration matches its full manifest hash');
    copyFileSync(source, join(temporaryMigrations, file), constants.COPYFILE_EXCL);
  }
  return temporaryWorkspace;
}
function sql(input) {
  try {
    return execFileSync('docker', psqlArgs, { cwd: root, input, encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 16 * 1024 * 1024 }).trim();
  } catch { throw new Error('PAYROLL_WORK_DETAILS_UPGRADE_SQL_FAILED'); }
}
function reset(version, workdir = root) {
  const args = [cli, '--workdir', workdir, 'db', 'reset', '--local', '--no-seed'];
  if (version) args.push('--version', version);
  execFileSync(process.execPath, args, { cwd: workdir, stdio: 'inherit' });
}
function tableShape() {
  return JSON.parse(sql(`select coalesce(jsonb_agg(jsonb_build_object('table',table_name,'columns',columns)
    order by table_name),'[]') from (select format('%I.%I',n.nspname,c.relname) table_name,
    jsonb_agg(a.attname order by a.attnum) columns from pg_class c join pg_namespace n on n.oid=c.relnamespace
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
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private') and c.relkind='r'),
    'policies',(select coalesce(jsonb_object_agg(format('%I.%I.%I',n.nspname,c.relname,p.polname),
      jsonb_build_object('command',p.polcmd,'permissive',p.polpermissive,'roles',to_jsonb(p.polroles),
        'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid))), '{}')
      from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace
      where n.nspname in('public','private')),
    'indexes',(select coalesce(jsonb_object_agg(format('%I.%I',n.nspname,c.relname),pg_get_indexdef(c.oid)), '{}')
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private') and c.relkind='i'),
    'functions',(select coalesce(jsonb_object_agg(format('%I.%I(%s)',n.nspname,p.proname,
      pg_get_function_identity_arguments(p.oid)),jsonb_build_object('definition',pg_get_functiondef(p.oid),
        'acl',to_jsonb(p.proacl),'owner',p.proowner,'config',to_jsonb(p.proconfig),'volatility',p.provolatile)), '{}')
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','private') and p.prokind='f'));`));
}
try {
  const status = JSON.parse(execFileSync(process.execPath, [cli, 'status', '--output', 'json'],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert(['localhost', '127.0.0.1'].includes(new URL(status.API_URL).hostname), 'Only disposable local reset is allowed');
  phase = 'isolated-source-workspace';
  const intervalWorkspace = prepareIntervalWorkspace();
  resetStarted = true;
  phase = 'baseline-97';
  reset(baseline, intervalWorkspace);
  assert.equal(sql('select count(*) from supabase_migrations.schema_migrations;'), '97');
  assert.equal(sql(`select to_regprocedure('${rpcSignature}') is null;`), 't');
  phase = 'baseline-fixture-setup';
  sql(`begin; ${fixture} commit;`);
  // Bind the actual fixture week once; a KST Monday rollover during later
  // commands must not move the query away from the historical earning.
  const fixtureWeek = sql(`select to_char(date_trunc('week',earned_on::timestamp)::date+28,'YYYY-MM-DD')
    from public.earnings where id='${id(5001)}';`);
  assert(/^\d{4}-\d{2}-\d{2}$/.test(fixtureWeek), 'One exact fixture week');
  weekSql = `${literal(fixtureWeek)}::date`;
  phase = 'baseline-command-receipts';
  const originalReceipt = JSON.parse(sql(correctionSql));
  sql(`select public.record_payroll_correction('${id(1)}',null,
    (select id from public.payroll_adjustments where maid_profile_id='${id(2)}' and book_version=1),
    25,1,'book-upgrade-second',repeat('b',64));
    select public.record_payroll_correction('${id(3)}','${id(5001)}',null,
    50,2,'book-upgrade-third',repeat('c',64));`);
  assert.equal(sql(`select version from public.payroll_adjustment_books where maid_profile_id='${id(2)}';`), '3');
  const oldEntries = JSON.parse(sql(entriesSql()));
  assert.equal(oldEntries.entries.length, 3, 'The baseline contains multiple real immutable adjustments');
  phase = 'baseline-complete-row-catalog';
  const shape = tableShape();
  const catalog = protectionCatalog();
  const preserved = digest(shape);
  phase = '97-to-98';
  execFileSync(process.execPath, [cli, '--workdir', intervalWorkspace, 'migration', 'up', '--local'],
    { cwd: intervalWorkspace, stdio: 'inherit' });
  assert.equal(sql('select count(*) from supabase_migrations.schema_migrations;'), '98');
  assert.equal(sql('select max(version) from supabase_migrations.schema_migrations;'), added);
  assert.deepEqual(tableShape(), shape, 'Every public/private table and column is exact');
  assert.equal(digest(shape), preserved, 'All whole baseline rows including complete receipts remain exact');
  const installed = protectionCatalog();
  assert.deepEqual(installed.tables, catalog.tables, 'All prior table/column ACL/RLS settings are exact');
  assert.deepEqual(installed.policies, catalog.policies, 'Every old RLS policy is exact');
  assert.deepEqual(installed.indexes, catalog.indexes, 'All indexes are exact, with no speculative new index');
  for (const [signature, prior] of Object.entries(catalog.functions)) {
    assert.deepEqual(installed.functions[signature], prior, 'All prior functions, ACLs and definitions remain exact');
  }
  assert.equal(Object.keys(installed.functions).length, Object.keys(catalog.functions).length + 1,
    'Exactly one new narrow read RPC, without legacy helper or writer replacement');
  assert.equal(sql(`select has_function_privilege('service_role','${rpcSignature}','EXECUTE')
    and not has_function_privilege('authenticated','${rpcSignature}','EXECUTE')
    and not has_function_privilege('anon','${rpcSignature}','EXECUTE')
    and not has_table_privilege('service_role','public.payroll_adjustment_books','SELECT');`), 't');
  phase = 'read-only-and-exact-replay';
  const pastWeek = sql(`select to_char(${weekSql}-28,'YYYY-MM-DD');`);
  const oldCycle = JSON.parse(sql(`select private.project_payroll_cycle_bounded(${weekSql}-28,'${id(2)}',10);`));
  const detail = JSON.parse(sql(readSql()));
  assert.equal(detail.maidProfileId,id(2));
  assert.equal(detail.weekStart,pastWeek);
  assert.equal(detail.kind,'earnings');
  assert.equal(detail.entries.length,1,'Actual typed earning survives the upgrade');
  assert.equal(detail.entries[0].earningId,id(5001));
  assert.equal(detail.entries[0].baseAmount,10000);
  assert.equal(detail.entries[0].bombRoomBonus,0);
  assert.equal(detail.entries[0].totalAmount,10000);
  assert.equal(detail.summary.accrualAmount,oldCycle.accrualAmount);
  assert.equal(detail.summary.totalAmount,oldCycle.totalAmount);
  assert.equal(detail.summary.adjustmentAmount,oldCycle.adjustmentAmount);
  assert.equal(detail.summary.payableAmount,oldCycle.payableAmount);
  assert.deepEqual(JSON.parse(sql(readSql(2,-4,2,'maid'))),detail,'Self maid/admin read same narrow facts');
  assert.equal(JSON.parse(sql(readSql(11,0))).entries.length,0,'Empty current week does not materialize a cycle');
  assert.equal(JSON.parse(sql(readSql(2,-4,1,'admin','workflow'))).entries.length,0,'Actual earning never reappears as pending workflow');
  sql(`begin read only; ${readSql()} ${readSql(11,0)} rollback;`);
  assert.deepEqual(JSON.parse(sql(correctionSql)), originalReceipt,'Legacy successful receipt replays exact');
  assert.deepEqual(JSON.parse(sql(entriesSql())), oldEntries,'Legacy entries envelope and semantics stay exact');
  assert.equal(digest(shape),preserved,'New detail/self/empty reads and old replays write no rows');
  console.log('Payroll work details98 / upgrade97→98: PASS; complete rows/receipts, prior function/ACL/RLS/indexes, legacy entries and true read-only typed detail preserved.');
} catch (error) {
  const sourceLine = error instanceof Error ? error.stack?.match(/test-payroll-work-details-upgrade\.mjs:(\d+):\d+/)?.[1] : null;
  console.error(`Payroll work details upgrade FAIL: ${JSON.stringify({ phase,
    kind: error instanceof assert.AssertionError ? 'ASSERTION_FAILED' : 'VALIDATION_FAILED',
    sourceLine: sourceLine ? Number(sourceLine) : null })}`);
  process.exitCode = 1;
} finally {
  if (resetStarted) {
    try {
      reset();
      const latestManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const latestFiles = sourceMigrationFiles(latestManifest);
      assert.equal(sql('select count(*) from supabase_migrations.schema_migrations;'), String(latestManifest.totalCount));
      assert.equal(sql('select max(version) from supabase_migrations.schema_migrations;'), migrationPattern.exec(latestFiles.at(-1))[1]);
    } catch { console.error('Payroll work details upgrade fresh cleanup FAIL'); process.exitCode = 1; }
  }
  if (temporaryWorkspace) {
    try {
      assert.equal(relative(realpathSync(root), realpathSync(temporaryRoot)), '.tmp');
      const resolvedWorkspace = realpathSync(temporaryWorkspace);
      assert.equal(relative(realpathSync(temporaryRoot), resolvedWorkspace), basename(temporaryWorkspace));
      assert(basename(temporaryWorkspace).startsWith(temporaryPrefix));
      rmSync(resolvedWorkspace, { recursive: true, force: false });
    } catch { console.error('Payroll work details upgrade generated workspace cleanup FAIL'); process.exitCode = 1; }
  }
}
