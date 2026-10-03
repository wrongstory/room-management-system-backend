import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Exact disposable98→99 interval, not a historical reset in the moving root.
// Copy only checked-in config/migrations; always restore the root latest DB.
const root = fileURLToPath(new URL('..', import.meta.url));
const cli = fileURLToPath(new URL('../node_modules/supabase/dist/supabase.js', import.meta.url));
const psqlArgs = ['exec', '-i', 'supabase_db_room-management-system-backend', 'psql', '-X', '-qAt',
  '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'];
const baseline = '20261003042015', added = '20261003064220';
const manifestPath = fileURLToPath(new URL('../supabase/migration-manifest.dev.json', import.meta.url));
const migrationDirectory = fileURLToPath(new URL('../supabase/migrations', import.meta.url));
const initialManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
assert(Number.isSafeInteger(initialManifest.totalCount) && initialManifest.totalCount >= 99);
const migrationPattern = /^(\d{14})_([a-z0-9_]+)\.sql$/;
const temporaryRoot = fileURLToPath(new URL('../.tmp', import.meta.url));
const temporaryPrefix = 'payroll-remittance-marker-upgrade-';
const source = readFileSync(new URL('../supabase/tests/payroll_adjustment_book.sql', import.meta.url), 'utf8');
const begin = '-- PAYROLL_BOOK_FIXTURE_BEGIN', end = '-- PAYROLL_BOOK_FIXTURE_END';
assert.equal(source.split(begin).length, 2); assert.equal(source.split(end).length, 2);
const fixture = source.split(begin)[1].split(end)[0];
assert(!/\\ir|\b(?:no_plan|plan|finish)\s*\(/i.test(fixture));
const id = n => `f3250000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const literal = value => `'${value.replaceAll("'", "''")}'`;
const newTables = ['private.payroll_remittance_marker_revisions', 'private.payroll_remittance_markers'];
const rpcSignatures = [
  'public.get_payroll_remittance_marker(uuid,uuid,text,uuid,date)',
  'public.set_payroll_remittance_marker(uuid,uuid,text,uuid,date,boolean,bigint,text,text,text)',
  'public.reconfirm_payroll_remittance_marker(uuid,uuid,text,uuid,date,bigint,text,text,text)',
  'public.list_payroll_remittance_marker_history(uuid,uuid,text,uuid,date,bigint,integer)'
];
let weeks, phase = 'local-identity', resetStarted = false, temporaryWorkspace;
const read = (offset = -4, actor = 1, maid = 2, role = 'admin') => `select public.get_payroll_remittance_marker(
  '${id(actor)}','${id(400 + actor)}','${role}','${id(maid)}',${weeks[offset]});`;
const set = (projection, marked, key, offset = -4, actor = 1) => `select public.set_payroll_remittance_marker(
  '${id(actor)}','${id(400 + actor)}','admin','${id(2)}',${weeks[offset]},${marked},
  ${projection.version},${literal(projection.basisFingerprint)},${literal(key)},repeat('a',64));`;
const correction = `select public.record_payroll_correction('${id(1)}','${id(5001)}',null,
  -100,0,'remittance-upgrade-old-correction',repeat('b',64));`;

function sourceMigrationFiles(manifest) {
  const files = readdirSync(migrationDirectory, { withFileTypes: true }).filter(x => x.name.endsWith('.sql'))
    .sort((a, b) => a.name.localeCompare(b.name));
  assert.equal(files.length, manifest.totalCount); assert.equal(manifest.migrations.length, files.length);
  let previousVersion = '';
  for (const [i, entry] of files.entries()) {
    const match = migrationPattern.exec(entry.name);
    assert(entry.isFile() && match && match[1] > previousVersion);
    assert.equal(manifest.migrations[i].order, i + 1); assert.equal(manifest.migrations[i].name, match[2]);
    previousVersion = match[1];
  }
  return files.map(x => x.name);
}
function prepareWorkspace() {
  const files = sourceMigrationFiles(initialManifest).slice(0, 99);
  assert.equal(files.length, 99);
  assert(files[97].startsWith(`${baseline}_`) && files[98].startsWith(`${added}_`));
  const config = fileURLToPath(new URL('../supabase/config.toml', import.meta.url));
  const configSource = readFileSync(config, 'utf8');
  assert.equal((configSource.match(/^[ \t]*project_id[ \t]*=/gm) ?? []).length, 1);
  assert.equal(/^[ \t]*project_id[ \t]*=[ \t]*"([^"\r\n]+)"[ \t]*(?:#[^\r\n]*)?\r?$/m.exec(configSource)?.[1],
    'room-management-system-backend');
  mkdirSync(temporaryRoot, { recursive: true });
  assert.equal(relative(realpathSync(root), realpathSync(temporaryRoot)), '.tmp');
  temporaryWorkspace = mkdtempSync(join(temporaryRoot, temporaryPrefix));
  const target = join(temporaryWorkspace, 'supabase', 'migrations');
  mkdirSync(target, { recursive: true });
  copyFileSync(config, join(temporaryWorkspace, 'supabase', 'config.toml'), constants.COPYFILE_EXCL);
  for (const [i, file] of files.entries()) {
    const canonical = readFileSync(join(migrationDirectory, file), 'utf8').replaceAll('\r\n', '\n');
    assert(!canonical.includes('\r'));
    assert.equal(createHash('sha256').update(canonical, 'utf8').digest('hex'), initialManifest.migrations[i].sha256);
    copyFileSync(join(migrationDirectory, file), join(target, file), constants.COPYFILE_EXCL);
  }
  return temporaryWorkspace;
}
function sql(input) {
  try { return execFileSync('docker', psqlArgs, { cwd: root, input, encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 16 * 1024 * 1024 }).trim(); }
  catch { throw new Error('PAYROLL_REMITTANCE_UPGRADE_SQL_FAILED'); }
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
    join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
    where n.nspname in('public','private') and c.relkind='r' group by n.nspname,c.relname) tables;`));
}
function digest(tables) {
  const rows = tables.map(({ table }) => {
    assert(/^(public|private)\.[a-z_][a-z_0-9]*$/.test(table));
    return `select ${literal(table)} tag,to_jsonb(t)::text data from ${table} t`;
  });
  return sql(`select md5(coalesce(string_agg(tag||':'||data,'|' order by tag,data),''))
    from (${rows.join(' union all ')}) preserved_rows;`);
}
function catalog() {
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
function oldReceiptDigest() {
  return sql(`select md5(coalesce(string_agg(to_jsonb(receipt)::text,'|' order by to_jsonb(receipt)::text),''))
    from private.command_executions receipt where command_type not in ('payroll.remittance.set','payroll.remittance.reconfirm');`);
}
try {
  const status = JSON.parse(execFileSync(process.execPath, [cli, 'status', '--output', 'json'],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert(['localhost', '127.0.0.1'].includes(new URL(status.API_URL).hostname));
  phase = 'isolated-full-source-manifest';
  const interval = prepareWorkspace(); resetStarted = true;
  phase = 'baseline98'; reset(baseline, interval);
  assert.equal(sql('select count(*) from supabase_migrations.schema_migrations;'), '98');
  for (const signature of rpcSignatures) assert.equal(sql(`select to_regprocedure(${literal(signature)}) is null;`), 't');
  phase = 'baseline-real-financial-ledgers'; sql(`begin;${fixture}commit;`);
  const baseWeek = sql(`select to_char(date_trunc('week',earned_on::timestamp)::date+28,'YYYY-MM-DD')
    from public.earnings where id='${id(5001)}';`);
  assert(/^\d{4}-\d{2}-\d{2}$/.test(baseWeek));
  weeks = Object.fromEntries([-6, -4, 0].map(n => [n, `${literal(baseWeek)}::date+(${n}*7)`]));
  const oldCorrection = JSON.parse(sql(correction));
  const started = JSON.parse(sql(`select public.start_payroll_cycle('${id(1)}','${id(2)}',${weeks[-6]},0,
    'remittance-upgrade-old-start',repeat('c',64));`));
  assert.equal(started.status, 'paying'); assert.equal(started.lockedAmount, 5000);
  const paidCommand = `select public.record_payroll_payment_paid('${id(1)}',${literal(started.paymentAttemptId)},
    ${started.version},'bank_transfer','UPGRADE-REM-A1','remittance-upgrade-old-paid',repeat('d',64));`;
  const oldPaid = JSON.parse(sql(paidCommand));
  assert.equal(sql(`select status from public.payroll_cycles where id=${literal(started.cycleId)};`), 'paid');
  const oldShape = shape(), oldCatalog = catalog(), oldRows = digest(oldShape), oldReceipts = oldReceiptDigest();
  phase = '98-to99';
  execFileSync(process.execPath, [cli, '--workdir', interval, 'migration', 'up', '--local'],
    { cwd: interval, stdio: 'inherit' });
  assert.equal(sql('select count(*) from supabase_migrations.schema_migrations;'), '99');
  assert.equal(sql('select max(version) from supabase_migrations.schema_migrations;'), added);
  const installedShape = shape(), installed = catalog();
  assert.deepEqual(installedShape.filter(x => !newTables.includes(x.table)), oldShape, 'All old table/column shapes exact');
  assert.deepEqual(installedShape.filter(x => newTables.includes(x.table)).map(x => x.table), newTables);
  assert.equal(digest(oldShape), oldRows, 'Every whole old row and complete receipt survives unchanged');
  for (const group of ['tables', 'policies', 'indexes', 'functions']) {
    for (const [key, old] of Object.entries(oldCatalog[group])) {
      assert.deepEqual(installed[group][key], old, `Old ${group} catalog is exact`);
    }
  }
  assert.deepEqual(installed.policies, oldCatalog.policies, 'No old/new public policy broadening');
  for (const table of newTables) {
    assert.equal(installed.tables[table].rls, true);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      assert.equal(sql(`select has_table_privilege(${literal(role)},${literal(table)},'SELECT,INSERT,UPDATE,DELETE');`), 'f');
    }
    assert.equal(sql(`select count(*) from ${table};`), '0', 'Migration does not infer display from actual payment');
  }
  for (const signature of rpcSignatures) assert.equal(sql(`select has_function_privilege('service_role',${literal(signature)},'EXECUTE')
    and not has_function_privilege('anon',${literal(signature)},'EXECUTE')
    and not has_function_privilege('authenticated',${literal(signature)},'EXECUTE');`), 't');
  phase = 'initial-readonly-and-exact-old-replay';
  const original = JSON.parse(sql(read()));
  assert.equal(original.marked, false); assert.equal(original.version, 0); assert.equal(original.needsReconfirmation, false);
  const self = JSON.parse(sql(read(-4, 2, 2, 'maid')));
  const facts = ({ canSet, canClear, canReconfirm, setBlockedReason, ...value }) => value;
  assert.deepEqual(facts(self), facts(original), 'Self maid/admin read same authoritative display facts');
  assert.equal(self.canSet, false); assert.equal(self.canClear, false); assert.equal(self.canReconfirm, false);
  assert.equal(self.setBlockedReason, 'ADMIN_REQUIRED', 'The maid sees no misleading write capability');
  assert.equal(JSON.parse(sql(read(-6))).marked, false, 'Actual PAID is not backfilled into external display');
  assert.equal(JSON.parse(sql(read(0, 1, 11))).version, 0);
  sql(`begin read only;${read()}${read(0, 1, 11)}rollback;`);
  assert.deepEqual(JSON.parse(sql(correction)), oldCorrection);
  assert.deepEqual(JSON.parse(sql(paidCommand)), oldPaid);
  assert.equal(digest(oldShape), oldRows, 'All reads and old successful replays have no effects');
  phase = 'display-only-on-off-paid-preservation';
  const financialShape = oldShape.filter(x => !['public.audit_events', 'private.command_executions'].includes(x.table));
  const financialRows = digest(financialShape);
  const onCommand = set(original, true, 'remittance-upgrade-on');
  const on = JSON.parse(sql(onCommand)); assert.equal(on.version, 1); assert.equal(on.marked, true);
  const off = JSON.parse(sql(set(on, false, 'remittance-upgrade-off')));
  assert.equal(off.version, 2); assert.equal(off.marked, false);
  assert.deepEqual(JSON.parse(sql(onCommand)), on, 'An old on receipt replays exact even after off');
  const paidInitial = JSON.parse(sql(read(-6)));
  const paidOn = JSON.parse(sql(set(paidInitial, true, 'remittance-upgrade-paid-on', -6)));
  const paidOff = JSON.parse(sql(set(paidOn, false, 'remittance-upgrade-paid-off', -6)));
  assert.equal(paidOff.marked, false);
  assert.equal(digest(financialShape), financialRows, 'Display on/off changes no old financial, notification or outbox row');
  assert.equal(oldReceiptDigest(), oldReceipts, 'Every complete preexisting successful receipt remains byte-exact after marker CRUD');
  assert.deepEqual(JSON.parse(sql(correction)), oldCorrection);
  assert.deepEqual(JSON.parse(sql(paidCommand)), oldPaid);
  assert.equal(sql(`select count(*) from private.payroll_remittance_marker_revisions;`), '4');
  console.log('Payroll remittance marker99 / upgrade98→99 PASS: full source hashes, all old whole rows/receipts/catalog exact; readonly conceptual state, no PAID backfill, display on/off leaves all financial/notification rows unchanged.');
} catch (error) {
  const line = error instanceof Error ? error.stack?.match(/test-payroll-remittance-marker-upgrade\.mjs:(\d+):\d+/)?.[1] : null;
  console.error(`Payroll remittance marker upgrade FAIL: ${JSON.stringify({ phase,
    kind: error instanceof assert.AssertionError ? 'ASSERTION_FAILED' : 'VALIDATION_FAILED', sourceLine: line ? Number(line) : null })}`);
  process.exitCode = 1;
} finally {
  if (resetStarted) {
    try {
      reset(); const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')), files = sourceMigrationFiles(manifest);
      assert.equal(sql('select count(*) from supabase_migrations.schema_migrations;'), String(manifest.totalCount));
      assert.equal(sql('select max(version) from supabase_migrations.schema_migrations;'), migrationPattern.exec(files.at(-1))[1]);
      assert.equal(sql(`select count(*) from public.profiles;`), '0');
      assert.equal(sql(`select count(*) from auth.users;`), '0');
    } catch { console.error('Payroll remittance marker upgrade fresh cleanup FAIL'); process.exitCode = 1; }
  }
  if (temporaryWorkspace) {
    try {
      assert.equal(relative(realpathSync(root), realpathSync(temporaryRoot)), '.tmp');
      const path = realpathSync(temporaryWorkspace);
      assert.equal(relative(realpathSync(temporaryRoot), path), basename(temporaryWorkspace));
      assert(basename(temporaryWorkspace).startsWith(temporaryPrefix));
      rmSync(path, { recursive: true, force: false });
    } catch { console.error('Payroll remittance marker upgrade generated workspace cleanup FAIL'); process.exitCode = 1; }
  }
}
