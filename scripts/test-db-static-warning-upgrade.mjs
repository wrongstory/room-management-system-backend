import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, constants, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_DB_CONTAINER, SUPABASE_CLI_VERSION, validateLocalContainer, validateLocalDockerEndpoint, validateLocalProjectConfig, validateProcessResult } from './db-lint-baseline.mjs';

// Exact100 -> #363 interval; unrelated later migrations are excluded, then latest local DB restored.
const root = fileURLToPath(new URL('..', import.meta.url));
const cli = fileURLToPath(new URL('../node_modules/supabase/dist/supabase.js', import.meta.url));
const project = 'room-management-system-backend';
const baseline = '20261003095426', added = '20261003231702';
const migrationsDirectory = join(root, 'supabase/migrations');
const manifestPath = join(root, 'supabase/migration-manifest.dev.json');
const temporaryRoot = join(root, '.tmp'), temporaryPrefix = 'db-static-warning-upgrade-';
const psqlArgs = ['--context', 'default', 'exec', '-i', `supabase_db_${project}`, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'];
const changedSignatures = [
  'private.detect_cleaning_overdue_at(uuid,timestamp with time zone)',
  'public.finalize_generated_room_pin_reveal(uuid,uuid,uuid,uuid,uuid)',
  'public.confirm_generated_room_pin(uuid,uuid,uuid,bigint,text,text)',
  'public.list_cleaning_inspections_page(uuid,uuid,timestamp with time zone,uuid,integer)',
  'public.list_cleaning_history(uuid,uuid,date,uuid,text,integer,timestamp with time zone,uuid)',
  'public.get_cleaning_history_submission(uuid,uuid,uuid)',
  'public.get_developer_room_catalog(uuid)',
];
// Only these two exact, source-controlled whole-CRLF variants are authorized by #376.
const crlfTargets = [
  { signature: changedSignatures[3], lf: 'af65520fb460db7dc858645f13246450',
    crlf: 'a5105bb901c8f1f507965e9b04f52911', length: 1951, crCount: 58,
    post: 'a8138f7f69f796fc0dd1d8d7d8b72569', semanticFrom: 'p_limit > 100', semanticTo: 'p_limit > 99' },
  { signature: changedSignatures[6], lf: 'd75eefbe637fb17d942f0f89a626b5f7',
    crlf: '62d346e27ad148f7f4807ac536e9197b', length: 705, crCount: 25,
    post: 'f9bd73161810abfaec749042fa8be758', semanticFrom: "'summary',", semanticTo: "'summaryDrift'," },
];
const sourceMd5 = value => createHash('md5').update(value).digest('hex');
const snapshotGuard = 'private.assert_active_developer_snapshot(uuid)';
const historyQuery = `select coalesce(jsonb_agg(to_jsonb(m) order by m.version),'[]'::jsonb)
  from supabase_migrations.schema_migrations m;`;
const literal = value => `'${value.replaceAll("'", "''")}'`;
const fixtureId = n => `f3520000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const replayCommand = `select public.manage_cleaning_attempt_lifecycle('${fixtureId(1)}','${fixtureId(201)}',
  '${fixtureId(801)}',2,'${fixtureId(701)}',2,1,'allow_finish','{}','DEACTIVATION_FINISH_CURRENT',
  'db-static-warning-upgrade-replay',repeat('b',64));`;
let phase = 'local-identity', resetStarted = false, temporaryWorkspace, cliEnvironment;
function sql(input) {
  return execFileSync('docker', psqlArgs, { cwd: root, input, encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 32 * 1024 * 1024 }).trim();
}
function reset(version, workdir = root) {
  const args = [cli, '--workdir', workdir, 'db', 'reset', '--local', '--no-seed'];
  if (version) args.push('--version', version);
  assert(cliEnvironment);
  execFileSync(process.execPath, args, { cwd: workdir, env: cliEnvironment, stdio: 'inherit' });
}
function sourceFiles() {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const files = readdirSync(migrationsDirectory).filter(x => x.endsWith('.sql')).sort();
  assert(manifest.totalCount >= 101); assert.equal(files.length, manifest.totalCount);
  assert.equal(manifest.migrations.length, files.length);
  for (const [index, file] of files.entries()) {
    assert(/^\d{14}_[a-z0-9_]+\.sql$/.test(file));
    assert.equal(manifest.migrations[index].order, index + 1);
    assert.equal(manifest.migrations[index].name, file.slice(15, -4));
    const text = readFileSync(join(migrationsDirectory, file), 'utf8').replaceAll('\r\n', '\n');
    assert(!text.includes('\r'));
    assert.equal(createHash('sha256').update(text).digest('hex'), manifest.migrations[index].sha256);
  }
  return files;
}
function prepareWorkspace() {
  const files = sourceFiles();
  const before = files.filter(file => file.slice(0, 14) <= baseline);
  assert.equal(before.length, 100); assert(before.at(-1).startsWith(`${baseline}_`));
  const append = `${added}_db_static_warning_remediation.sql`;
  assert(files.includes(append));
  const config = join(root, 'supabase/config.toml');
  assert.equal(/^project_id = "([^"\r\n]+)"\r?$/m.exec(readFileSync(config, 'utf8'))?.[1], project);
  mkdirSync(temporaryRoot, { recursive: true });
  assert.equal(relative(realpathSync(root), realpathSync(temporaryRoot)), '.tmp');
  temporaryWorkspace = mkdtempSync(join(temporaryRoot, temporaryPrefix));
  const target = join(temporaryWorkspace, 'supabase/migrations');
  mkdirSync(target, { recursive: true });
  copyFileSync(config, join(temporaryWorkspace, 'supabase/config.toml'), constants.COPYFILE_EXCL);
  for (const file of [...before, append]) copyFileSync(join(migrationsDirectory, file), join(target, file), constants.COPYFILE_EXCL);
  return temporaryWorkspace;
}
function catalogQuery() {
  return `set search_path=''; select jsonb_build_object(
    'tables',(select coalesce(jsonb_object_agg(format('%I.%I',n.nspname,c.relname),
      jsonb_build_object('acl',c.relacl,'owner',c.relowner,'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,
        'columns',(select jsonb_agg(jsonb_build_object('name',a.attname,'acl',a.attacl,'type',a.atttypid,
          'notNull',a.attnotnull) order by a.attnum) from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped))), '{}')
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private','auth') and c.relkind='r'),
    'policies',(select coalesce(jsonb_object_agg(format('%I.%I.%I',n.nspname,c.relname,p.polname),
      jsonb_build_object('command',p.polcmd,'permissive',p.polpermissive,'roles',p.polroles,
        'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid))), '{}')
      from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private','auth')),
    'indexes',(select coalesce(jsonb_object_agg(format('%I.%I',n.nspname,c.relname),pg_get_indexdef(c.oid)), '{}')
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private','auth') and c.relkind='i'),
    'constraints',(select coalesce(jsonb_object_agg(format('%I.%I.%I',n.nspname,c.relname,x.conname),pg_get_constraintdef(x.oid,true)), '{}')
      from pg_constraint x join pg_class c on c.oid=x.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private','auth')),
    'triggers',(select coalesce(jsonb_object_agg(format('%I.%I.%I',n.nspname,c.relname,t.tgname),pg_get_triggerdef(t.oid,true)), '{}')
      from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private','auth')),
    'functions',(select coalesce(jsonb_object_agg(format('%I.%I(%s)',n.nspname,p.proname,replace(oidvectortypes(p.proargtypes),', ',',')),
      jsonb_build_object('definition',pg_get_functiondef(p.oid),'source',p.prosrc,'acl',p.proacl,'oid',p.oid,
        'owner',p.proowner,'config',p.proconfig,'volatility',p.provolatile,'securityDefiner',p.prosecdef,
        'returnType',p.prorettype,'argNames',p.proargnames,'argModes',p.proargmodes,'defaults',pg_get_expr(p.proargdefaults,0),
        'language',p.prolang,'strict',p.proisstrict,'leakproof',p.proleakproof,'parallel',p.proparallel,
        'returnsSet',p.proretset,'cost',p.procost,'rows',p.prorows,'support',p.prosupport,
        'variadic',p.provariadic,'allArgTypes',p.proallargtypes,'defaultCount',p.pronargdefaults,'binary',p.probin)), '{}')
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','private','auth') and p.prokind='f'));
  `;
}
function catalog() { return JSON.parse(sql(catalogQuery())); }
function rowDigestQuery() {
  const tables = JSON.parse(sql(`select jsonb_agg(format('%I.%I',n.nspname,c.relname) order by n.nspname,c.relname)
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r'
      and (n.nspname in('public','private') or (n.nspname='auth' and c.relname in('users','sessions')));`));
  const parts = tables.map(table => {
    assert(/^(public|private|auth)\.[a-z_][a-z_0-9]*$/.test(table));
    return `select ${literal(table)} tag,to_jsonb(t)::text data from ${table} t`;
  });
  return `select md5(coalesce(string_agg(tag||':'||data,'|' order by tag,data),'')) from (${parts.join(' union all ')}) rows;`;
}
function captureState(rowsQuery) {
  const output = sql(`${catalogQuery()}${rowsQuery}${historyQuery}`).split('\n');
  assert.equal(output.length, 3);
  assert(/^[0-9a-f]{32}$/.test(output[1]));
  return { catalog: JSON.parse(output[0]), rows: output[1], history: JSON.parse(output[2]) };
}
function replaceBody(original, body) {
  assert(original && original.source.length > 0);
  assert.equal(original.definition.split(original.source).length, 2, 'Exact single raw definition anchor');
  return `${original.definition.replace(original.source, () => body)};`;
}
function assertInstalled(before, after, canonical) {
  for (const group of ['tables', 'policies', 'indexes', 'constraints', 'triggers']) assert.deepEqual(after[group], before[group]);
  assert.deepEqual(Object.keys(after.functions).sort(), [...Object.keys(before.functions), snapshotGuard].sort());
  for (const [signature, oldFunction] of Object.entries(before.functions)) {
    const installed = after.functions[signature];
    if (!changedSignatures.includes(signature)) assert.deepEqual(installed, oldFunction);
    else {
      const { source: oldSource, definition: oldDefinition, ...oldContract } = oldFunction;
      const { source: newSource, definition: newDefinition, ...newContract } = installed;
      assert.notEqual(newSource, oldSource); assert.notEqual(newDefinition, oldDefinition);
      assert.deepEqual(newContract, oldContract, 'Exact OID, signature, defaults, types, owner, ACL and all captured attributes');
      if (canonical) {
        assert.equal(newSource, canonical.functions[signature].source, 'All variants install identical canonical source');
        assert.equal(newDefinition, canonical.functions[signature].definition);
      }
    }
  }
  const helper = after.functions[snapshotGuard];
  assert.equal(helper.owner, before.functions['private.assert_active_developer(uuid)'].owner);
  assert.equal(helper.volatility, 's'); assert.equal(helper.securityDefiner, true);
  assert.deepEqual(helper.config, ['search_path=""']);
  assert.deepEqual(helper.acl, ['postgres=X/postgres'], 'New helper remains postgres-only');
  if (canonical) {
    const oldHelper = { ...canonical.functions[snapshotGuard] }, newHelper = { ...helper };
    delete oldHelper.oid; delete newHelper.oid;
    assert.deepEqual(newHelper, oldHelper, 'Only rolled-back helper OID allocation may differ between probes');
  }
  for (const target of crlfTargets) {
    const source = after.functions[target.signature].source;
    assert.equal(sourceMd5(source), target.post); assert(!source.includes('\r'));
  }
}
function assertRejected(result, signature, cliApply = false) {
  assert.equal(result.error, undefined); assert.equal(result.signal, null);
  assert(Number.isInteger(result.status) && result.status !== 0);
  const expected = `DB_STATIC_REMEDIATION_SOURCE_DRIFT: ${signature.replaceAll('timestamp with time zone', 'timestamptz')}`;
  const stderrError = result.stderr.split(/\r?\n/).find(line => /^ERROR:\s/.test(line));
  let reported;
  if (stderrError) reported = stderrError.replace(/^ERROR:\s+/, '');
  else {
    // Pinned CLI can return its agent-mode LegacyMigrationApplyError as a JSON envelope on stdout.
    // Read only its first error line, never the printed SQL context which contains every signature.
    assert(cliApply, 'psql rejection must report its error on stderr');
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope._tag, 'Error');
    assert.equal(envelope.error?.code, 'LegacyMigrationApplyError');
    assert.equal(typeof envelope.error?.message, 'string');
    const firstLine = envelope.error.message.split(/\r?\n/)[0];
    assert(/^ERROR:\s/.test(firstLine));
    reported = firstLine.replace(/^ERROR:\s+/, '');
  }
  assert([expected, `${expected} (SQLSTATE P0001)`].includes(reported),
    'Only the exact reported source-drift error is accepted, never a signature in printed SQL');
}
function rejectSource(original, source, signature, migration, rowsQuery, replay) {
  // Persist the synthetic prestate before the failing transaction so rollback must preserve its raw bytes.
  sql(replaceBody(original, source));
  const before = captureState(rowsQuery);
  assert.equal(before.catalog.functions[signature].source, source, 'The negative fixture really installed the intended raw body');
  assert.equal(before.catalog.functions[signature].oid, original.oid);
  const rejected = spawnSync('docker', psqlArgs, { cwd: root, input: `begin;${migration};commit;`,
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
  assertRejected(rejected, signature);
  assert.deepEqual(captureState(rowsQuery), before);
  assert.deepEqual(JSON.parse(sql(replayCommand)), replay);
  assert.deepEqual(captureState(rowsQuery), before, 'Rejected migration and receipt replay change neither data nor history');
  sql(`${original.definition};`);
}
function lintInventory() {
  const lint = spawnSync(process.execPath, [cli, '--workdir', root, 'db', 'lint', '--local', '--schema', 'public,private',
    '--level', 'warning', '--fail-on', 'warning', '--output', 'json'], { cwd: root, env: cliEnvironment, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
  assert.equal(lint.error, undefined); assert.equal(lint.signal, null); assert.equal(lint.status, 1);
  return JSON.parse(lint.stdout);
}
try {
  for (const variable of ['SUPABASE_CLI_BINARY_OVERRIDE', 'SUPABASE_WORKDIR', 'SUPABASE_PROJECT_ID', 'SUPABASE_DB_PORT', 'SUPABASE_SERVICES_HOSTNAME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) {
    assert(!process.env[variable], 'Caller cannot override the local validation target');
  }
  assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).devDependencies.supabase, SUPABASE_CLI_VERSION);
  assert.equal(JSON.parse(readFileSync(join(root, 'node_modules/supabase/package.json'), 'utf8')).version, SUPABASE_CLI_VERSION);
  const projectConfig = validateLocalProjectConfig(readFileSync(join(root, 'supabase/config.toml'), 'utf8'));
  const endpoint = spawnSync('docker', ['--context', 'default', 'context', 'inspect', 'default', '--format', '{{json .Endpoints.docker.Host}}'],
    { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
  validateProcessResult(endpoint, 0, 'local Docker endpoint'); assert.equal(endpoint.stderr, '');
  validateLocalDockerEndpoint(endpoint.stdout);
  const container = spawnSync('docker', ['--context', 'default', 'inspect', '--format',
    '{"name":{{json .Name}},"running":{{json .State.Running}},"project":{{json (index .Config.Labels "com.supabase.cli.project")}},"ports":{{json .NetworkSettings.Ports}}}', LOCAL_DB_CONTAINER],
  { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
  validateProcessResult(container, 0, 'local DB container'); assert.equal(container.stderr, ''); validateLocalContainer(container.stdout, projectConfig.dbPort);
  cliEnvironment = {
    ...process.env, DOCKER_CONTEXT: 'default', DOCKER_HOST: JSON.parse(endpoint.stdout),
    SUPABASE_PROJECT_ID: projectConfig.projectId, SUPABASE_DB_PORT: String(projectConfig.dbPort),
    SUPABASE_SERVICES_HOSTNAME: '127.0.0.1',
  };
  const status = JSON.parse(execFileSync(process.execPath, [cli, '--workdir', root, 'status', '--output', 'json'],
    { cwd: root, env: cliEnvironment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert(['localhost', '127.0.0.1'].includes(new URL(status.API_URL).hostname));
  phase = 'exact100-interval'; const interval = prepareWorkspace(); resetStarted = true; reset(baseline, interval);
  assert.equal(sql('select count(*) from supabase_migrations.schema_migrations;'), '100');
  phase = 'baseline17'; assert.equal(lintInventory().flatMap(group => group.issues).length, 17);
  phase = 'real-receipt-fixture';
  sql(`begin;${readFileSync(join(root, 'supabase/tests/auth_session_hard_expiry_fixture.psql'), 'utf8')}commit;`);
  const replay = JSON.parse(sql(replayCommand));
  const rowsQuery = rowDigestQuery(), initial = captureState(rowsQuery), before = initial.catalog, rows = initial.rows;
  const migration = readFileSync(join(migrationsDirectory, `${added}_db_static_warning_remediation.sql`), 'utf8');
  phase = 'known-crlf-fixture-fingerprints';
  for (const target of crlfTargets) {
    const source = before.functions[target.signature].source;
    assert(!source.includes('\r')); assert.equal(sourceMd5(source), target.lf);
    const crlf = source.replaceAll('\n', '\r\n');
    assert.equal(sourceMd5(crlf), target.crlf); assert.equal(crlf.length, target.length);
    assert.equal(crlf.split('\r').length - 1, target.crCount);
    assert.equal(sourceMd5(crlf.replaceAll('\r\n', '\n')), target.lf);
  }
  let canonical;
  for (const [inspectionCrlf, catalogCrlf] of [[false, false], [false, true], [true, false], [true, true]]) {
    phase = `known-crlf-${Number(inspectionCrlf)}-${Number(catalogCrlf)}`;
    for (const [index, target] of crlfTargets.entries()) {
      const original = before.functions[target.signature];
      const useCrlf = index === 0 ? inspectionCrlf : catalogCrlf;
      sql(replaceBody(original, useCrlf ? original.source.replaceAll('\n', '\r\n') : original.source));
    }
    const prestate = captureState(rowsQuery);
    assert.equal(prestate.rows, rows); assert.deepEqual(prestate.history, initial.history);
    for (const [index, target] of crlfTargets.entries()) {
      const useCrlf = index === 0 ? inspectionCrlf : catalogCrlf;
      assert.equal(sourceMd5(prestate.catalog.functions[target.signature].source), useCrlf ? target.crlf : target.lf);
    }
    // The post-install snapshot and replay run in the same connection: another psql cannot see uncommitted DDL.
    const output = sql(`begin;${migration};${catalogQuery()}${rowsQuery}${historyQuery}${replayCommand}${rowsQuery}rollback;`).split('\n');
    assert.equal(output.length, 5);
    const installed = JSON.parse(output[0]);
    assertInstalled(prestate.catalog, installed, canonical);
    canonical ??= installed;
    assert.equal(output[1], rows); assert.deepEqual(JSON.parse(output[2]), initial.history);
    assert.deepEqual(JSON.parse(output[3]), replay); assert.equal(output[4], rows);
    assert.deepEqual(captureState(rowsQuery), prestate, 'Successful probe rollback restores the exact preexisting LF/CRLF catalog and history');
  }
  // Return to exact100 LF before each unknown variant; these are not authorized by a canonical-hash match alone.
  for (const target of crlfTargets) sql(`${before.functions[target.signature].definition};`);
  assert.deepEqual(captureState(rowsQuery), initial);
  for (const [index, target] of crlfTargets.entries()) {
    const original = before.functions[target.signature], source = original.source;
    assert.equal(source.split(target.semanticFrom).length, 2);
    const semantic = source.replace(target.semanticFrom, () => target.semanticTo);
    const variants = [
      ['unknown', `${source}\n-- synthetic unknown body\n`],
      ['mixed', source.replace('\n', '\r\n')],
      ['bare-cr', source.replaceAll('\n', '\r')],
      ['semantic-lf', semantic],
      ['semantic-crlf', semantic.replaceAll('\n', '\r\n')],
    ];
    for (const [label, variant] of variants) {
      phase = `reject-${index}-${label}`;
      assert.notEqual(sourceMd5(variant), target.lf); assert.notEqual(sourceMd5(variant), target.crlf);
      if (label === 'mixed') assert.equal(sourceMd5(variant.replaceAll('\r\n', '\n')), target.lf);
      rejectSource(original, variant, target.signature, migration, rowsQuery, replay);
      assert.deepEqual(captureState(rowsQuery), initial);
    }
  }
  for (const [index, signature] of changedSignatures.entries()) {
    if (crlfTargets.some(target => target.signature === signature)) continue;
    phase = `reject-unauthorized-crlf-${index}`;
    const original = before.functions[signature]; assert(!original.source.includes('\r'));
    const variant = original.source.replaceAll('\n', '\r\n'); assert.notEqual(variant, original.source);
    rejectSource(original, variant, signature, migration, rowsQuery, replay);
    assert.deepEqual(captureState(rowsQuery), initial);
  }
  phase = 'last-source-drift-cli-atomic-rollback';
  for (const target of crlfTargets) {
    const original = before.functions[target.signature];
    sql(replaceBody(original, original.source.replaceAll('\n', '\r\n')));
  }
  const knownCrlfBaseline = captureState(rowsQuery);
  const lastTarget = crlfTargets[1], lastOriginal = knownCrlfBaseline.catalog.functions[lastTarget.signature];
  assert.equal(sourceMd5(lastOriginal.source), lastTarget.crlf);
  sql(replaceBody(lastOriginal, lastOriginal.source.replace(lastTarget.semanticFrom, () => lastTarget.semanticTo)));
  const driftBaseline = captureState(rowsQuery);
  assert.equal(sourceMd5(driftBaseline.catalog.functions[crlfTargets[0].signature].source), crlfTargets[0].crlf);
  // Fix the error envelope independently of agent auto-detection (local Codex vs CI runner).
  // Force the non-agent path in this probe; the exact first error/full signature check stays unchanged.
  const rejected = spawnSync(process.execPath, [cli, '--output-format', 'json', '--agent', 'no', '--workdir', interval, 'migration', 'up', '--local'],
    { cwd: interval, env: cliEnvironment, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
  assertRejected(rejected, lastTarget.signature, true);
  assert.deepEqual(captureState(rowsQuery), driftBaseline,
    'Actual CLI late failure rolls back helper, earlier six patches, normalization, every row/catalog and full migration history');
  assert(!driftBaseline.catalog.functions[snapshotGuard]);
  assert.deepEqual(JSON.parse(sql(replayCommand)), replay);
  assert.deepEqual(captureState(rowsQuery), driftBaseline);
  sql(`${lastOriginal.definition};`);
  assert.deepEqual(captureState(rowsQuery), knownCrlfBaseline, 'Only the synthetic last-target drift is restored; known raw CRLF prestate remains');
  phase = 'apply100-to101';
  execFileSync(process.execPath, [cli, '--workdir', interval, 'migration', 'up', '--local'], { cwd: interval, env: cliEnvironment, stdio: 'inherit' });
  assert.equal(sql('select count(*) from supabase_migrations.schema_migrations;'), '101');
  assert.equal(sql('select max(version) from supabase_migrations.schema_migrations;'), added);
  const after = catalog();
  assertInstalled(knownCrlfBaseline.catalog, after, canonical);
  const installedHistory = JSON.parse(sql(historyQuery));
  assert.deepEqual(installedHistory.filter(entry => entry.version !== added), initial.history, 'Every old migration history row remains exact');
  assert.equal(installedHistory.filter(entry => entry.version === added).length, 1);
  assert.equal(installedHistory.find(entry => entry.version === added).name, 'db_static_warning_remediation');
  assert.equal(sql(rowsQuery), rows, 'All old whole business/Auth rows and command receipts remain exact');
  assert.deepEqual(JSON.parse(sql(replayCommand)), replay);
  assert.equal(sql(rowsQuery), rows, 'Old command replay creates no duplicate effect');
  phase = 'exact9-gate';
  execFileSync(process.execPath, [join(root, 'scripts/check-db-lint-baseline.mjs')], { cwd: root, stdio: 'inherit', timeout: 90000 });
  console.log('DB static warning upgrade100→101 PASS: four LF/known-CRLF combinations, fifteen unauthorized-body rejections, actual CLI last-source atomic rollback including history/raw CRLF; seven canonical source-only changes, one owner-only helper; all rows/catalog/OID/ACL/RLS/receipts and replay preserved; raw17→9, exact baseline gate PASS.');
} catch (error) {
  const line = error instanceof Error ? error.stack?.match(/test-db-static-warning-upgrade\.mjs:(\d+):\d+/)?.[1] : null;
  console.error(`DB static warning upgrade FAIL: ${JSON.stringify({ phase, kind: error instanceof assert.AssertionError ? 'ASSERTION_FAILED' : 'VALIDATION_FAILED', sourceLine: line ? Number(line) : null })}`);
  process.exitCode = 1;
} finally {
  if (resetStarted) {
    try {
      reset(); const files = sourceFiles();
      assert.equal(sql('select count(*) from supabase_migrations.schema_migrations;'), String(files.length));
      assert.equal(sql('select max(version) from supabase_migrations.schema_migrations;'), files.at(-1).slice(0, 14));
      assert.equal(sql('select count(*) from public.profiles;'), '0');
      assert.equal(sql('select count(*) from auth.users;'), '0');
    } catch { console.error('DB static warning upgrade latest local fresh cleanup FAIL'); process.exitCode = 1; }
  }
  if (temporaryWorkspace) {
    try {
      assert.equal(relative(realpathSync(root), realpathSync(temporaryRoot)), '.tmp');
      const path = realpathSync(temporaryWorkspace);
      assert.equal(relative(realpathSync(temporaryRoot), path), basename(temporaryWorkspace));
      assert(basename(temporaryWorkspace).startsWith(temporaryPrefix));
      rmSync(path, { recursive: true, force: false });
    } catch { console.error('DB static warning upgrade generated interval cleanup FAIL'); process.exitCode = 1; }
  }
}
