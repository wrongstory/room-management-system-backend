/** Exact prefix122 oracle + exact final source tip; never a baseline acceptance.
 * Only the existing approved Full DB CI path may run this destructive LOCAL
 * fresh test. Importing this file performs no I/O. No production target option. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash,randomUUID } from 'node:crypto';
import { lstatSync,mkdirSync,readFileSync,readdirSync,realpathSync,writeFileSync } from 'node:fs';
import { join,relative } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { classify,fingerprint } from './db-validation-gate.mjs';
import { LOCAL_DB_CONTAINER,validateLocalDockerEndpoint } from './db-lint-baseline.mjs';
import { validatePostApprovalUpgradeLocal,assertPostApprovalUpgradeFresh,postApprovalUpgradeFreshSql } from './test-post-approval-room-issue-upgrade.mjs';
import { BASELINE_METADATA_QUERIES,BASELINE_METADATA_QUERY_SHA256,BASELINE_HISTORY_FIELDS,BASELINE_CATALOG_FIELDS,BASELINE_OUTPUT_SETTINGS,decodeBaselineMetadata } from './lib/migration-baseline-metadata.mjs';

export const BASELINE_CHECKPOINT_PREFIX_SHA256='2087fa7a9ce68a5cada241694b2017dd9573ca6883b0505e86fc9b4d502a0b58';
export const BASELINE_CHECKPOINT_VERSION='20261022135443';
const sha=value=>createHash('sha256').update(value).digest('hex');
const bad=()=>{throw new Error('BASELINE_CHECKPOINT_UNAVAILABLE');};
const root=fileURLToPath(new URL('..',import.meta.url));
const pattern=/^(\d{14})_([a-z0-9_]+)\.sql$/u;
const artifactPath='.tmp/baseline122-oracle.json';
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};

/** Pure validation, not a source ownership/DB capability. The actual runner
 * additionally binds every checkout byte to its immutable Git blob. */
export function validateBaselineCheckpointSource(manifest,entries) {
  try {
    assert(manifest.schemaVersion===1&&manifest.release==='dev'&&manifest.hashAlgorithm==='sha256-lf-utf8');
    assert(Number.isSafeInteger(manifest.totalCount)&&manifest.totalCount>=122&&manifest.totalCount<=512);
    assert(Array.isArray(entries)&&entries.length===manifest.totalCount&&manifest.migrations.length===entries.length);
    const sorted=[...entries].sort((a,b)=>a.file.localeCompare(b.file));
    const files=sorted.map((entry,i)=>{
      const m=pattern.exec(entry.file),record=manifest.migrations[i];
      assert(m&&Buffer.isBuffer(entry.raw)&&entry.raw.length>0&&entry.raw.length<=2*1024*1024);
      assert(entry.isFile===true&&entry.isSymbolicLink===false&&record.order===i+1&&record.name===m[2]);
      assert(i===0||entry.file>sorted[i-1].file);
      const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(entry.raw);assert(!text.includes('\0'));
      assert(Buffer.from(text).equals(entry.raw));const canonical=text.replaceAll('\r\n','\n');
      assert(sha(canonical)===record.sha256);
      return {file:entry.file,version:m[1],name:m[2],sha256:record.sha256,rawSha256:sha(entry.raw)};
    });
    assert(files.reduce((n,f)=>n+entries.find(e=>e.file===f.file).raw.length,0)<=32*1024*1024);
    assert(manifest.head===files.at(-1).name&&files[121].file===`${BASELINE_CHECKPOINT_VERSION}_post_approval_memo_only.sql`);
    assert(sha(JSON.stringify(files.slice(0,122).map(({file,sha256})=>({file,sha256}))))===BASELINE_CHECKPOINT_PREFIX_SHA256);
    return freeze({files,totalCount:files.length,prefixCount:122,prefixSha256:BASELINE_CHECKPOINT_PREFIX_SHA256,
      sourceFilesSha256:sha(JSON.stringify(files)),finalHead:files.at(-1)});
  } catch { return bad(); }
}
export function validateBaselineCheckpointGate({env,event,head,inputFingerprint}) {
  try {
    assert(env.GITHUB_ACTIONS==='true'&&env.GITHUB_WORKFLOW==='quality'&&env.RMS_FINAL_DB_GATE_MODE==='full');
    assert(env.GITHUB_REPOSITORY==='wrongstory/room-management-system-backend'&&/^[a-f0-9]{40}$/u.test(head)&&head===env.GITHUB_SHA);
    assert(/^[a-f0-9]{64}$/u.test(inputFingerprint)&&inputFingerprint===env.RMS_FINAL_DB_INPUT_SHA256);
    assert(/^[1-9][0-9]*$/u.test(env.GITHUB_RUN_ID)&&/^[1-9][0-9]*$/u.test(env.GITHUB_RUN_ATTEMPT));
    assert(classify(env.GITHUB_EVENT_NAME,event,env.GITHUB_REPOSITORY).mode==='release');
    return freeze({inputFingerprint,head,runId:env.GITHUB_RUN_ID,runAttempt:env.GITHUB_RUN_ATTEMPT,
      executionApprovalVerified:false});
  } catch { return bad(); }
}
export function validateBaselineCheckpointEnvironment(env,rootEntries,supabaseEntries) {
  try {
    assert(!Object.keys(env).some(key=>/^(?:SUPABASE_|PG[A-Z_]|DOTENV_PRIVATE_KEY|DOCKER_|NODE_OPTIONS$|NODE_PATH$|LD_PRELOAD$|LD_LIBRARY_PATH$|DATABASE_URL$)/u.test(key)&&env[key]));
    for(const entries of [rootEntries,supabaseEntries])assert(Array.isArray(entries)&&!entries.some(name=>
      typeof name!=='string'||name==='.env'||name.startsWith('.env.')&&!['.env.example','.env.template'].includes(name)));
  } catch { return bad(); }
}
/** Exactly one replacement performed by the successful owned local CLI reset.
 * Not a failover/follow-by-name policy and not a human approval capability. */
export function validateBaselineCheckpointReplacement(before,after,started,finished) {
  try {
    assert(Number.isSafeInteger(started)&&Number.isSafeInteger(finished)&&finished>=started&&finished-started<=180_000);
    for(const value of [before,after])assert(value&&/^[a-f0-9]{64}$/u.test(value.id)&&/^sha256:[a-f0-9]{64}$/u.test(value.image)
      &&typeof value.daemon==='string'&&/^[A-Za-z0-9:-]{1,128}$/u.test(value.daemon));
    assert(after.id!==before.id&&after.image===before.image&&after.daemon===before.daemon);
    assert(typeof after.created==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(after.created));
    const created=Date.parse(after.created);assert(Number.isFinite(created)&&created>=started&&created<=finished);
    return after.id;
  } catch { return bad(); }
}
const identitySql=`SELECT pg_catalog.jsonb_build_array(pg_catalog.pg_backend_pid()::text,
 pg_catalog.current_database(),current_user,pg_catalog.current_setting('server_version_num'),
 pg_catalog.current_setting('transaction_read_only'),pg_catalog.current_setting('transaction_isolation'),
 pg_catalog.current_setting('application_name'),pg_catalog.to_char(a.backend_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
 ${BASELINE_OUTPUT_SETTINGS.map(s=>`pg_catalog.current_setting('${s.name}')`).join(',')})::text
 FROM pg_catalog.pg_stat_activity a WHERE a.pid=pg_catalog.pg_backend_pid()`;
function wrapped(sql,fields) {
  assert(fields.every(f=>/^[a-z_][a-z0-9_]*$/u.test(f)));
  return `SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(${fields.map(f=>`q.${f}`).join(',')})),'[]'::jsonb)::text FROM (${sql}) q;`;
}
export function baselineCheckpointReadSql(nonce) {
  assert(/^rms_h1_[a-f0-9]{32}$/u.test(nonce));
  return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
 SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='2s';SET LOCAL idle_in_transaction_session_timeout='5s';
 SET LOCAL search_path='pg_catalog';SET LOCAL application_name='${nonce}';
 ${BASELINE_OUTPUT_SETTINGS.map(s=>`SET LOCAL "${s.name}"='${s.value}';`).join('\n')}
 ${identitySql};
 ${wrapped(BASELINE_METADATA_QUERIES.history,BASELINE_HISTORY_FIELDS)}
 ${wrapped(BASELINE_METADATA_QUERIES.catalog,BASELINE_CATALOG_FIELDS)}
 ${identitySql};
 ROLLBACK;
 SELECT 'BASELINE_CHECKPOINT_ROLLBACK_ACK';`;
}
const result=(fields,rows)=>({command:'SELECT',rowCount:rows.length,rows,fields:fields.map(name=>({name,dataTypeID:25,format:'text'}))});
/** Plain decoded candidate only; a fake stdout/callback cannot mint a live TLS
 * observation or successful Full DB proof. */
export function decodeBaselineCheckpointOutput(raw,expected,nonce) {
  try {
    assert(typeof raw==='string'&&Buffer.byteLength(raw)<=40*1024*1024);
    const lines=raw.trim().split(/\r?\n/u);assert(lines.length===5&&lines[4]==='BASELINE_CHECKPOINT_ROLLBACK_ACK');
    const before=JSON.parse(lines[0]),after=JSON.parse(lines[3]);
    assert(Array.isArray(before)&&before.length===8+BASELINE_OUTPUT_SETTINGS.length&&before.every(v=>typeof v==='string')&&JSON.stringify(before)===JSON.stringify(after));
    assert(/^[1-9][0-9]{0,9}$/u.test(before[0])&&Number(before[0])<=2147483647);
    assert(before[1]==='postgres'&&before[2]==='postgres'&&/^(?:15|17)[0-9]{4}$/u.test(before[3]));
    assert(before[4]==='on'&&before[5]==='repeatable read'&&before[6]===nonce);
    assert(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/u.test(before[7]));
    assert.deepEqual(before.slice(8),BASELINE_OUTPUT_SETTINGS.map(s=>s.value));
    const metadata=decodeBaselineMetadata(result(BASELINE_HISTORY_FIELDS,JSON.parse(lines[1])),result(BASELINE_CATALOG_FIELDS,JSON.parse(lines[2])),expected);
    return freeze({metadata,backend:{pid:Number(before[0]),serverVersion:Number(before[3]),nonce,backendStart:before[7]},
      baselineAccepted:false,liveObservationVerified:false,fullDbProofVerified:false});
  } catch { return bad(); }
}
export function assertCheckpointHistory(actual,source,count=source.totalCount) {
  assert([122,source.totalCount].includes(count));
  assert.deepEqual(actual,source.files.slice(0,count).map(({version,name})=>({version,name})));
}

export function runMigrationBaselineCheckpoint() {
  // CLI scope/CI metadata are an execution boundary, not cryptographic human
  // authorization. The exact release CI run still requires the user's approval.
  let phase='gate';
  const run=(binary,args,options={})=>{
    try{return execFileSync(binary,args,{cwd:root,encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:30_000,
      maxBuffer:40*1024*1024,windowsHide:true,shell:false,...options});}catch{return bad();}
  };
  const git=(...args)=>run('git',args,{timeout:10_000});
  try {
    assert(process.argv.length===2&&process.platform==='linux');
    const safeEnvironment=()=>validateBaselineCheckpointEnvironment(process.env,readdirSync(root),readdirSync(join(root,'supabase')));
    safeEnvironment();
    const head=git('rev-parse','HEAD').trim(),tree=git('ls-tree','-r','-z','HEAD');
    const gate=validateBaselineCheckpointGate({env:process.env,event:JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8')),
      head,inputFingerprint:fingerprint(tree)});
    const blobs=new Map(tree.split('\0').filter(Boolean).map(line=>{const m=/^(100644) blob ([a-f0-9]{40})\t(.+)$/u.exec(line);return m?[m[3],m[2]]:[line,null];}));
    const exactFile=path=>{
      const full=join(root,path),meta=lstatSync(full);assert(meta.isFile()&&!meta.isSymbolicLink()&&realpathSync(full)===full&&meta.size<=4*1024*1024);
      const raw=readFileSync(full);assert(createHash('sha1').update(`blob ${raw.length}\0`).update(raw).digest('hex')===blobs.get(path));return raw;
    };
    const readSource=()=>{
      const manifestRaw=exactFile('supabase/migration-manifest.dev.json');
      const entries=readdirSync(join(root,'supabase/migrations')).filter(f=>f.endsWith('.sql')).map(file=>({file,raw:exactFile(`supabase/migrations/${file}`),isFile:true,isSymbolicLink:false}));
      const source=validateBaselineCheckpointSource(JSON.parse(manifestRaw.toString('utf8')),entries);
      assert([...blobs.keys()].filter(p=>/^supabase\/migrations\/.*\.sql$/u.test(p)).length===entries.length);
      return {...source,manifestSha256:sha(manifestRaw)};
    };
    const source=readSource();const config=exactFile('supabase/config.toml').toString('utf8');
    const executionPaths=['supabase/config.toml','scripts/test-migration-baseline-checkpoint.mjs','scripts/lib/migration-baseline-metadata.mjs',
      'scripts/lib/migration-evidence-input.mjs','scripts/db-validation-gate.mjs','scripts/db-lint-baseline.mjs',
      'scripts/test-post-approval-room-issue-upgrade.mjs','package.json','package-lock.json','.github/workflows/quality.yml'];
    for(const path of executionPaths)exactFile(path);
    const cli=join(root,'node_modules/supabase/dist/supabase.js');
    phase='owned-local';
    const endpoint=run('docker',['--context','default','context','inspect','default','--format','{{json .Endpoints.docker.Host}}']);
    const inspect=()=>run('docker',['--context','default','inspect','--format','{"name":{{json .Name}},"running":{{json .State.Running}},"project":{{json (index .Config.Labels "com.supabase.cli.project")}},"ports":{{json .NetworkSettings.Ports}}}',LOCAL_DB_CONTAINER]);
    const containerId=()=>run('docker',['--context','default','inspect','--format','{{.Id}}',LOCAL_DB_CONTAINER]).trim();
    const daemonId=()=>run('docker',['--context','default','info','--format','{{.ID}}']).trim();
    const stamp=()=>({...JSON.parse(run('docker',['--context','default','inspect','--format','{"id":{{json .Id}},"image":{{json .Image}},"created":{{json .Created}}}',LOCAL_DB_CONTAINER])),daemon:daemonId()});
    const initial=stamp();let ownedContainer=initial.id;assert(/^[a-f0-9]{64}$/u.test(ownedContainer));
    const status=JSON.parse(run(process.execPath,[cli,'status','--output','json']));
    validatePostApprovalUpgradeLocal({args:[],env:process.env,config,endpoint,status,container:inspect(),cliVersion:run(process.execPath,[cli,'--version'])});
    const localEnv={...process.env,DOCKER_HOST:validateLocalDockerEndpoint(endpoint),DOCKER_CONTEXT:'default'};
    const sameInputs=()=>{
      safeEnvironment();assert(git('rev-parse','HEAD').trim()===head);assert.deepEqual(readSource(),source);
      for(const path of executionPaths)exactFile(path);
      validatePostApprovalUpgradeLocal({args:[],env:process.env,config:exactFile('supabase/config.toml').toString('utf8'),endpoint,
        status:JSON.parse(run(process.execPath,[cli,'status','--output','json'])),container:inspect(),cliVersion:run(process.execPath,[cli,'--version'])});
      assert(run('docker',['--context','default','context','inspect','default','--format','{{json .Endpoints.docker.Host}}'])===endpoint);
      assert(daemonId()===initial.daemon);
    };
    const sameLocal=()=>{sameInputs();assert(containerId()===ownedContainer);};
    const sql=input=>run('docker',['--context','default','exec','-i',ownedContainer,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-v','VERBOSITY=sqlstate','-U','postgres','-d','postgres'],{input,env:localEnv});
    const history=()=>JSON.parse(sql(`BEGIN READ ONLY;SET LOCAL statement_timeout='5s';
      SELECT COALESCE(jsonb_agg(jsonb_build_object('version',version,'name',name) ORDER BY version),'[]'::jsonb) FROM supabase_migrations.schema_migrations;ROLLBACK;`).trim());
    phase='fresh-prefix122';sameLocal();
    const resetStarted=Date.now();
    run(process.execPath,[cli,'db','reset','--local','--no-seed','--version',BASELINE_CHECKPOINT_VERSION],{env:localEnv,timeout:180_000});
    const resetFinished=Date.now();sameInputs();
    // Pinned CLI2.115.0 PG15+ resets rebuild this one local container/volume.
    // Rebind once after success + exact unchanged inputs/local metadata checks.
    // No retries, no substitution after this point, no following a failed reset.
    ownedContainer=validateBaselineCheckpointReplacement(initial,stamp(),resetStarted,resetFinished);
    sameLocal();assertCheckpointHistory(history(),source,122);
    phase='readonly-prefix-metadata';
    const nonce=`rms_h1_${randomUUID().replaceAll('-','')}`;
    const observation=decodeBaselineCheckpointOutput(sql(baselineCheckpointReadSql(nonce)),source.files.slice(0,122),nonce);
    sameLocal();
    const remaining=sql(`BEGIN READ ONLY;SET LOCAL statement_timeout='5s';SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE pid=${observation.backend.pid} AND application_name='${nonce}';ROLLBACK;`).trim();
    assert(remaining==='0');
    phase='exact-pending-to-tip';sameLocal();
    run(process.execPath,[cli,'migration','up','--local'],{env:localEnv,timeout:180_000});
    assertCheckpointHistory(history(),source);sameLocal();
    assertPostApprovalUpgradeFresh(JSON.parse(sql(`BEGIN READ ONLY;SET LOCAL statement_timeout='5s';${postApprovalUpgradeFreshSql()};ROLLBACK;`).trim()));
    phase='safe-artifact';sameLocal();
    const temporary=join(root,'.tmp');mkdirSync(temporary,{recursive:true});assert(relative(realpathSync(root),realpathSync(temporary))==='.tmp');
    const evidence={format:'baseline122-local-oracle-v1',...gate,prefixCount:122,prefixSha256:source.prefixSha256,
      sourceFilesSha256:source.sourceFilesSha256,manifestSha256:source.manifestSha256,finalCount:source.totalCount,finalHead:source.finalHead,
      querySha256:BASELINE_METADATA_QUERY_SHA256,mode:'DISPOSABLE_LOCAL_UNIX_SOCKET_NOT_TLS',observation,
      ownedLocalConnectionClosed:true,exactFinalHistoryIdentitiesObserved:true,fullDbProofVerified:false,baselineAccepted:false,executionAllowed:false};
    writeFileSync(join(root,artifactPath),`${JSON.stringify(evidence)}\n`,{encoding:'utf8',flag:'wx',mode:0o600});
    console.log(`Baseline checkpoint source122 -> exact${source.totalCount} captured; acceptance/Full DB proof NOT claimed; query=${BASELINE_METADATA_QUERY_SHA256}`);
    return true;
  } catch {
    // The existing workflow's always() local stop is mandatory cleanup, including
    // failure. No automatic fresh reset/retry and no output of native errors.
    console.error(`BASELINE_CHECKPOINT_FAILED:${phase}`);return false;
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){if(!runMigrationBaselineCheckpoint())process.exitCode=1;}
