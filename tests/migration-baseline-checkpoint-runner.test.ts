import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { BASELINE_OUTPUT_SETTINGS } from '../scripts/lib/migration-baseline-metadata.mjs';
import { baselineMetadataFixture,hashMetadata } from './helpers/baseline-metadata.js';

const seam=vi.hoisted(()=>({artifact:[] as string[],phase:'before',failure:'',calls:[] as string[],drift:false}));
vi.mock('node:child_process',()=>({execFileSync:vi.fn()}));
vi.mock('node:fs',async importOriginal=>{
  const fs=await importOriginal<typeof import('node:fs')>();
  return {...fs,mkdirSync:vi.fn(),writeFileSync:(_path:unknown,value:string)=>{seam.artifact.push(value);},
    realpathSync:(path:Parameters<typeof fs.realpathSync>[0])=>String(path).replaceAll('\\','/').endsWith('/.tmp')?resolve(String(path)):fs.realpathSync(path),
    readFileSync:(path:Parameters<typeof fs.readFileSync>[0],options:unknown)=>{
      if(String(path)==='SYNTHETIC_EVENT')return JSON.stringify({pull_request:{base:{ref:'main',repo:{full_name:'wrongstory/room-management-system-backend'}},head:{ref:'release/v1.0.0',repo:{full_name:'wrongstory/room-management-system-backend'}}}});
      if(seam.drift&&String(path).endsWith('config.toml'))return Buffer.from('changed config');
      return fs.readFileSync(path,options as never);
    }};
});
const actualFs=await vi.importActual<typeof import('node:fs')>('node:fs');
const {fingerprint}=await import(new URL('../scripts/db-validation-gate.mjs',import.meta.url).href) as {fingerprint(tree:string):string};
const api=await import(new URL('../scripts/test-migration-baseline-checkpoint.mjs',import.meta.url).href) as {runMigrationBaselineCheckpoint():boolean};
const root=fileURLToPath(new URL('..',import.meta.url));
const sourcePaths=['supabase/migration-manifest.dev.json','supabase/config.toml','scripts/test-migration-baseline-checkpoint.mjs',
  'scripts/lib/migration-baseline-metadata.mjs','scripts/lib/migration-evidence-input.mjs','scripts/db-validation-gate.mjs',
  'scripts/db-lint-baseline.mjs','scripts/test-post-approval-room-issue-upgrade.mjs','package.json','package-lock.json','.github/workflows/quality.yml',
  ...actualFs.readdirSync(join(root,'supabase/migrations')).filter(f=>f.endsWith('.sql')).map(f=>`supabase/migrations/${f}`)];
const tree=[...sourcePaths.map(path=>{const bytes=actualFs.readFileSync(join(root,path));return `100644 blob ${createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')}\t${path}`;}),''].join('\0');
const files=sourcePaths.filter(p=>p.startsWith('supabase/migrations/')).sort().map(path=>{
  const match=/\/(\d{14})_([a-z0-9_]+)\.sql$/u.exec(path);if(!match?.[1]||!match[2])throw new Error();return {version:match[1],name:match[2]};});
const oldId='a'.repeat(64),newId='b'.repeat(64),image=`sha256:${'c'.repeat(64)}`;
const time=Date.parse('2026-10-25T01:00:00Z');
const argv=process.argv,environment=process.env,platform=Object.getOwnPropertyDescriptor(process,'platform');
beforeEach(()=>{
  vi.clearAllMocks();
  seam.artifact=[];seam.calls=[];seam.phase='before';seam.failure='';seam.drift=false;
  process.argv=[process.execPath,join(root,'scripts/test-migration-baseline-checkpoint.mjs')];
  Object.defineProperty(process,'platform',{value:'linux'});
  process.env={GITHUB_ACTIONS:'true',GITHUB_WORKFLOW:'quality',RMS_FINAL_DB_GATE_MODE:'full',RMS_FINAL_DB_INPUT_SHA256:fingerprint(tree),
    GITHUB_REPOSITORY:'wrongstory/room-management-system-backend',GITHUB_SHA:'d'.repeat(40),GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',
    GITHUB_EVENT_NAME:'pull_request',GITHUB_EVENT_PATH:'SYNTHETIC_EVENT'};
  vi.spyOn(Date,'now').mockReturnValue(time);vi.spyOn(console,'error').mockImplementation(()=>{});vi.spyOn(console,'log').mockImplementation(()=>{});
  vi.mocked(execFileSync).mockImplementation((binary,args,options)=>{
    const a=(args??[]) as string[],o=(options??{}) as {input?:string};
    if(binary==='git'){if(a[0]==='ls-tree')return tree;if(a.join(' ')==='rev-parse HEAD')return `${'d'.repeat(40)}\n`;throw new Error('Unexpected git');}
    if(a.includes('db')&&a.includes('reset')){
      seam.calls.push('reset122');if(seam.failure==='reset')throw new Error('private reset detail');seam.phase='prefix';
      if(seam.failure==='config-after-reset')seam.drift=true;return '';
    }
    if(a.includes('migration')&&a.includes('up')){seam.calls.push('up-tip');if(seam.failure==='up')throw new Error('private SQL detail');seam.phase='tip';return '';}
    if(a.includes('status'))return JSON.stringify({API_URL:'http://127.0.0.1:54321'});
    if(a.includes('--version'))return '2.115.0\n';
    if(binary==='docker'){
      if(a.includes('context'))return '"unix:///var/run/docker.sock"\n';
      if(a.includes('info'))return 'synthetic-daemon\n';
      if(a.includes('inspect')){
        const format=a[a.indexOf('--format')+1]??'';
        const id=seam.phase==='before'?oldId:newId;
        if(format==='{{.Id}}')return `${seam.failure==='late-replacement'&&seam.phase==='tip'?'e'.repeat(64):id}\n`;
        if(format.includes('"image"'))return JSON.stringify({id,image:seam.failure==='image'&&seam.phase!=='before'?`sha256:${'e'.repeat(64)}`:image,created:'2026-10-25T01:00:00.000000000Z'});
        return JSON.stringify({name:'/supabase_db_room-management-system-backend',running:true,project:'room-management-system-backend',ports:{'5432/tcp':[{HostIp:'127.0.0.1',HostPort:'54322'}]}});
      }
      if(a.includes('psql')){
        const sql=o.input??'';
        if(sql.includes('AS statement_hashes')){
          seam.calls.push('capture122');if(seam.failure==='capture')throw new Error('private query detail');
          const nonce=/application_name='(rms_h1_[a-f0-9]{32})'/u.exec(sql)?.[1];if(!nonce)throw new Error('Missing nonce');
          const identity=['12345','postgres','postgres','170006','on','repeatable read',nonce,'2026-10-25T01:00:00.000000Z',...BASELINE_OUTPUT_SETTINGS.map(s=>s.value)];
          const rows=files.slice(0,122).map(f=>[f.version,hashMetadata(f.name),'1','1','1','1',JSON.stringify([['1','9',hashMetadata('SELECT 1;')]]),'122']);
          return [JSON.stringify(identity),JSON.stringify(rows),JSON.stringify(baselineMetadataFixture().catalog.rows),JSON.stringify(identity),'BASELINE_CHECKPOINT_ROLLBACK_ACK'].join('\n');
        }
        if(sql.includes('pg_catalog.pg_stat_activity'))return seam.failure==='backend-open'?'1':'0';
        if(sql.includes("jsonb_build_object('version',version,'name',name)")){
          const count=seam.phase==='prefix'?122:files.length-(seam.failure==='tip-history'?1:0);return JSON.stringify(files.slice(0,count));
        }
        if(sql.includes('publicWithoutRls')){
          seam.calls.push('fresh-tip');const names=[...sql.matchAll(/\('((?:public|private|auth)\.[a-z_]+)'/gu)].map(m=>m[1]);
          return JSON.stringify({rooms:121,roomTypes:4,publicWithoutRls:0,rows:Object.fromEntries(names.map(n=>[n,seam.failure==='freshness'?1:0]))});
        }
      }
    }
    throw new Error(`Unrecognized synthetic command ${String(binary)}`);
  });
});
afterEach(()=>{process.argv=argv;process.env=environment;if(platform)Object.defineProperty(process,'platform',platform);vi.restoreAllMocks();});
describe('#14 actual checkpoint orchestration with only fake child I/O and memory artifact',()=>{
  it('runs one fresh122 reset, hash capture, exact pending apply, final freshness and safe artifact in order',()=>{
    expect(api.runMigrationBaselineCheckpoint()).toBe(true);
    expect(seam.calls).toEqual(['reset122','capture122','up-tip','fresh-tip']);expect(seam.artifact).toHaveLength(1);
    const artifact=JSON.parse(seam.artifact[0]??'{}');
    expect(artifact).toMatchObject({prefixCount:122,finalCount:files.length,baselineAccepted:false,executionAllowed:false,
      fullDbProofVerified:false,exactFinalHistoryIdentitiesObserved:true,mode:'DISPOSABLE_LOCAL_UNIX_SOCKET_NOT_TLS'});
    expect(seam.artifact[0]).not.toContain('SELECT 1');
  });
  it.each(['reset','config-after-reset','image','capture','backend-open','up','tip-history','late-replacement','freshness'])('fails closed without artifact or automatic retry after %s',failure=>{
    seam.failure=failure;expect(api.runMigrationBaselineCheckpoint()).toBe(false);expect(seam.artifact).toHaveLength(0);
    expect(seam.calls.filter(c=>c==='reset122')).toHaveLength(1);
    if(['reset','config-after-reset','image','capture','backend-open'].includes(failure))expect(seam.calls).not.toContain('up-tip');
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).not.toContain('private');
  });
  it('does not invoke Docker/CLI at all for the normal dev route',()=>{
    process.env.RMS_FINAL_DB_GATE_MODE='development';expect(api.runMigrationBaselineCheckpoint()).toBe(false);
    expect(vi.mocked(execFileSync).mock.calls.some(c=>c[0]==='docker')).toBe(false);expect(seam.calls).toHaveLength(0);
  });
});
