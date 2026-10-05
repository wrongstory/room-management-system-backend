import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDecodedMigrationHistorySnapshot } from './lib/migration-history-codec.mjs';
import { comparePostgresHistoryObservation, isOwnedPostgresHistoryObservation, observePostgresMigrationHistory } from './lib/migration-readonly-postgres.mjs';

assert.equal(process.argv.length, 2);
const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
mkdirSync(join(root, '.tmp'), { recursive: true });
const temporary = realpathSync(join(root, '.tmp'));
const fixtures = join(root, 'scripts', 'fixtures', 'migration-readonly');
assert.equal(relative(root, temporary), '.tmp');
const task = mkdtempSync(join(temporary, 'pg378-tls-'));
const openssl = process.platform === 'win32' ? 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe' : 'openssl';
const image = 'public.ecr.aws/supabase/postgres@sha256:6942962433a569e87f228b4d4ab7e11db5deca64e43babb3a038443ad6c4f1bb';
const name = `rms378-readonly-${randomUUID().replaceAll('-', '')}`;
const owner = randomUUID();
const fixturePassword = randomBytes(24).toString('hex'); // Synthetic disposable role only. Never emitted.
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const ownedSources = ['scripts/lib/migration-readonly-postgres.mjs','tests/migration-readonly-postgres.test.ts','docs/MIGRATION_READONLY_POSTGRES.md','package.json','package-lock.json'];
const sources = new Map(ownedSources.map(path => [path, sha(readFileSync(join(root, path)))]));
const run = (file, args, options = {}) => {
  try { return execFileSync(file, args, { encoding: 'utf8', timeout: 30_000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...options }); }
  catch { throw new Error('ISOLATED_FIXTURE_COMMAND_FAILED'); } // No argv/stderr/SQL/password exposure.
};
const docker = (args, options) => run('docker', args, options);
const crypto = args => run(openssl, args, { cwd: task });
const emit = text => process.stdout.write(`${text}\n`);
let created = false;
let checks = 0;
let major = null;
const verifyOwner = () => {
  const meta = JSON.parse(docker(['inspect', name]))[0];
  assert.equal(meta.Config.Labels['rms.fixture.owner'], owner);
  assert.equal(meta.Config.Labels['rms.fixture.kind'], '378-readonly-tls');
  assert.equal(meta.Image, image.split('@')[1]);
  assert.equal(meta.Mounts.length, 0);
  assert.equal(meta.HostConfig.Binds, null);
  assert.deepEqual(meta.HostConfig.Tmpfs, { '/fixture': 'rw,noexec,nosuid,size=256m' });
  return meta;
};
const sql = command => { verifyOwner(); return docker(['exec','-i','-u','postgres',name,'psql','-X','-q','-A','-t','-U','postgres','-d','postgres','-h','/tmp','-v','ON_ERROR_STOP=1'], { input: command }); };
const version = '20261001000000';
const q = text => `'${text.replaceAll("'", "''")}'`;
let target;
let caPem;
const observe = (patch = {}) => observePostgresMigrationHistory({ target, credential: { password: fixturePassword }, caPem, expectedVersions: [version], deadlineMs: 15_000, queryMs: 5_000, ...patch });
const check = (label, passed) => { assert(passed, label); checks++; emit(`PASS ${label}`); };
const reject = async (label, action, expected) => {
  let caught = null;
  try { await action(); } catch (error) { caught = error; }
  assert(caught instanceof Error && expected.test(caught.message), label);
  assert(!String(caught.stack).includes(fixturePassword));
  checks++; emit(`PASS ${label}: fixed safe rejection`);
};
try {
  assert(/^sha256:[a-f0-9]{64}$/u.test(docker(['image','inspect',image,'--format','{{.Id}}']).trim()));
  crypto(['req','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','2','-keyout','ca.key','-out','ca.crt','-subj','/CN=RMS isolated test CA','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign']);
  crypto(['req','-new','-newkey','rsa:2048','-nodes','-sha256','-keyout','server.key','-out','server.csr','-subj','/CN=localhost']);
  crypto(['x509','-req','-in','server.csr','-CA','ca.crt','-CAkey','ca.key','-CAcreateserial','-sha256','-days','2','-out','server.crt','-extfile',join(fixtures,'pg378-fixture-server.ext')]);
  caPem = readFileSync(join(task,'ca.crt'),'utf8');
  docker(['run','-d','--pull','never','--name',name,'--label',`rms.fixture.owner=${owner}`,'--label','rms.fixture.kind=378-readonly-tls','--user','0','--tmpfs','/fixture:rw,noexec,nosuid,size=256m','-p','127.0.0.1::5432','--entrypoint','/bin/sleep',image,'1800']);
  created = true;
  verifyOwner();
  for (const file of ['ca.crt','server.crt','server.key']) {
    docker(['cp',join(task,file),`${name}:/tmp/${file}`]);
    docker(['exec',name,'cp',`/tmp/${file}`,`/fixture/${file}`]);
  }
  docker(['cp',join(fixtures,'pg378-fixture-hba.conf'),`${name}:/tmp/pg_hba.conf`]);
  docker(['exec',name,'cp','/tmp/pg_hba.conf','/fixture/pg_hba.conf']);
  emit('Fixture setup: assign permissions to exact disposable paths.');
  try {
    execFileSync('docker', ['exec',name,'chown','100:101','/fixture','/fixture/ca.crt','/fixture/server.crt','/fixture/server.key','/fixture/pg_hba.conf'], {encoding:'utf8',timeout:30_000,windowsHide:true,stdio:['ignore','pipe','pipe']});
  } catch(error) {
    // This one setup call has no credential/SQL input. Restrict diagnostic to
    // fixed missing-file names rather than arbitrary driver/provider errors.
    const missing = ['ca.crt','server.crt','server.key','pg_hba.conf'].filter(file => String(error.stderr).includes(`/fixture/${file}`));
    throw new Error(`ISOLATED_PERMISSION_SETUP_FAILED:${missing.join(',')}`);
  }
  docker(['exec',name,'chmod','0600','/fixture/server.key']);
  docker(['exec','-u','postgres',name,'initdb','-D','/fixture/data','--auth-local=trust','--auth-host=trust','--encoding=UTF8','--no-locale']);
  const options = "-p 5432 -h 0.0.0.0 -k /tmp -c ssl=on -c ssl_cert_file=/fixture/server.crt -c ssl_key_file=/fixture/server.key -c hba_file=/fixture/pg_hba.conf -c max_connections=12";
  docker(['exec','-u','postgres',name,'pg_ctl','-D','/fixture/data','-l','/fixture/postgres.log','-o',options,'-w','-t','20','start']);
  const meta = verifyOwner();
  const mapped = meta.NetworkSettings.Ports['5432/tcp'];
  assert(mapped.length === 1 && mapped[0].HostIp === '127.0.0.1');
  target = { scope: 'ISOLATED_LOCAL', mode: 'direct', projectRef: null, host: '127.0.0.1', port: Number(mapped[0].HostPort), database: 'postgres', role: 'postgres' };
  const rawVersion = sql(`SELECT current_setting('server_version_num');`).trim();
  major = Math.floor(Number(rawVersion)/10000);
  assert.equal(major,17);
  sql(`ALTER ROLE postgres PASSWORD ${q(fixturePassword)}; CREATE SCHEMA supabase_migrations; CREATE TABLE supabase_migrations.schema_migrations(version text NOT NULL PRIMARY KEY); ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN statements text[]; ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN name text;`);
  const set = (nameValue, expression) => sql(`TRUNCATE supabase_migrations.schema_migrations; INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES (${q(version)},${nameValue === null ? 'NULL' : q(nameValue)},${expression});`);
  const cases = [
    { label:'null name / null statements', name:null, expression:'NULL::text[]', statements:null },
    { label:'empty name / empty array', name:'', expression:'ARRAY[]::text[]', statements:{ dimensions:[], values:[] } },
    { label:'ordered null / empty / Unicode CRLF / quoted values', name:'unicode', expression:`ARRAY['',NULL,'NULL',${q('😀\r\n--x;')},${q("BEGIN;COMMIT;'$x$'")} ]::text[]`, statements:{ dimensions:[{length:5,lowerBound:1}], values:['',null,'NULL','😀\r\n--x;',"BEGIN;COMMIT;'$x$'"] } },
    { label:'nondefault negative array lower bound', name:'lower', expression:`${q('[-2:-1]={"SELECT 1",NULL}')}::text[]`, statements:{dimensions:[{length:2,lowerBound:-2}],values:['SELECT 1',null]} },
  ];
  for (const item of cases) {
    set(item.name,item.expression);
    const result = await observe();
    const expected = createDecodedMigrationHistorySnapshot({expectedVersions:[version],rows:[{version,name:item.name,statements:item.statements}]});
    check(item.label,isOwnedPostgresHistoryObservation(result) && comparePostgresHistoryObservation({observation:result,expected}).matches);
    assert.equal(result.backend.major,17);
    assert.equal(result.driverReadbackObserved,true);
    assert.equal(result.tlsPeerValidated,true);
    for(const flag of ['executionAllowed','operationalApproval','DBHistoryVerified','fullStateVerified','cliParityVerified','remoteProjectVerified']) assert.equal(result[flag],false);
  }
  set('first',"ARRAY['SELECT 1']::text[]");
  const first = await observe(); const second = await observe();
  check('actual PID/backend_start/nonce tuple is owned and independently generated',first.backend.connectionNonce !== second.backend.connectionNonce);
  check('serialized observation cannot impersonate owned driver I/O',!isOwnedPostgresHistoryObservation(JSON.parse(JSON.stringify(first))));
  const publicCa = readFileSync(join(task,'ca.crt'),'utf8');
  crypto(['req','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','2','-keyout','untrusted.key','-out','untrusted.crt','-subj','/CN=Untrusted isolated CA','-addext','basicConstraints=critical,CA:TRUE']);
  await reject('actual wrong CA TLS handshake',()=>observe({caPem:readFileSync(join(task,'untrusted.crt'),'utf8')}),/^POSTGRES_CONNECTION_FAILED$/u);
  await reject('actual wrong password SCRAM authentication',()=>observe({credential:{password:'wrong-synthetic-test-password'}}),/^POSTGRES_CONNECTION_FAILED$/u);
  set('two',"ARRAY[['a','b'],['c','d']]::text[]");
  await reject('actual 2D text array census',()=>observe(),/^POSTGRES_HISTORY_INVALID$/u);
  set('first',"ARRAY['SELECT 1']::text[]");
  await reject('actual unexpected version set',()=>observe({expectedVersions:[]}),/^POSTGRES_HISTORY_INVALID$/u);
  sql(`INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES ('20261002000000','unexpected',NULL);`);
  await reject('actual additional history row',()=>observe(),/^POSTGRES_HISTORY_INVALID$/u);
  set('first',"ARRAY['SELECT 1']::text[]");
  sql(`ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN extra text;`);
  await reject('actual catalog rejects unexpected fourth column',()=>observe(),/^POSTGRES_RESULT_INVALID$/u);
  sql(`ALTER TABLE supabase_migrations.schema_migrations DROP COLUMN extra; ALTER TABLE supabase_migrations.schema_migrations ENABLE ROW LEVEL SECURITY;`);
  await reject('actual RLS history relation refused',()=>observe(),/^POSTGRES_HISTORY_SCHEMA_INVALID$/u);
  sql(`ALTER TABLE supabase_migrations.schema_migrations DISABLE ROW LEVEL SECURITY;`);
  set('large',"ARRAY[repeat('x',33*1024*1024)]::text[]");
  await reject('actual encoded history byte census exceeds 32 MiB before full result',()=>observe(),/^POSTGRES_HISTORY_LIMIT$/u);
  set('first',"ARRAY['SELECT 1']::text[]");
  sql(`INSERT INTO supabase_migrations.schema_migrations(version,name,statements) SELECT ('20261002'||lpad(n::text,6,'0')),'extra',NULL FROM generate_series(1,512) n;`);
  await reject('actual history row census exceeds 512 before full result',()=>observe(),/^POSTGRES_HISTORY_LIMIT$/u);
  set('first',"ARRAY['SELECT 1']::text[]");
  check('no adapter data/schema writes',sql(`SELECT count(*)::text || ':' || string_agg(version,',') FROM supabase_migrations.schema_migrations;`).trim() === `1:${version}`);
  check('actual adapter sessions closed after success and rejected attempts',sql(`SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'rms_ro_%';`).trim()==='0');
  check('CA remained fixed during suite',caPem===publicCa);
  crypto(['x509','-req','-in','server.csr','-CA','ca.crt','-CAkey','ca.key','-CAcreateserial','-sha256','-days','2','-out','wrong-server.crt','-extfile',join(fixtures,'pg378-fixture-wrong-san.ext')]);
  docker(['exec','-u','postgres',name,'pg_ctl','-D','/fixture/data','-w','-t','20','-m','fast','stop']);
  docker(['cp',join(task,'wrong-server.crt'),`${name}:/tmp/wrong-server.crt`]);
  docker(['exec',name,'cp','/tmp/wrong-server.crt','/fixture/server.crt']);
  docker(['exec',name,'chown','100:101','/fixture/server.crt']);
  docker(['exec','-u','postgres',name,'pg_ctl','-D','/fixture/data','-l','/fixture/postgres.log','-o',options,'-w','-t','20','start']);
  await reject('actual SAN mismatch TLS handshake despite trusted CA',()=>observe(),/^POSTGRES_CONNECTION_FAILED$/u);
  for(const [path,digest] of sources) assert.equal(sha(readFileSync(join(root,path))),digest,'source byte preservation');
  emit(`ACTUAL PG${major} TLS/read-only fixture PASS: ${checks} checks; real migrations/remote/CLI parity/production/backup NOT RUN`);
} finally {
  if(created) {
    verifyOwner();
    docker(['rm','-f',name]); // Exact owned tmpfs-only synthetic fixture. No user/supabase container or volume.
    emit('Removed exact owned disposable TLS fixture container; no persistent volume existed.');
  }
}
