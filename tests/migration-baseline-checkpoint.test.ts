import { createHash } from 'node:crypto';
import { readFileSync,readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe,expect,it } from 'vitest';
import { baselineMetadataFixture } from './helpers/baseline-metadata.js';
import { BASELINE_OUTPUT_SETTINGS } from '../scripts/lib/migration-baseline-metadata.mjs';
type FileEntry={file:string;raw:Buffer;isFile:boolean;isSymbolicLink:boolean};
type Source={files:{file:string;version:string;name:string;sha256:string;rawSha256:string}[];totalCount:number;prefixCount:number;prefixSha256:string};
type Api={validateBaselineCheckpointSource(m:unknown,e:unknown):Source;validateBaselineCheckpointGate(v:unknown):unknown;
  baselineCheckpointReadSql(nonce:string):string;decodeBaselineCheckpointOutput(raw:string,expected:unknown,nonce:string):{baselineAccepted:false;fullDbProofVerified:false;metadata:{history:unknown[]}};
  validateBaselineCheckpointEnvironment(env:unknown,root:unknown,supabase:unknown):void;
  validateBaselineCheckpointReplacement(before:unknown,after:unknown,started:number,finished:number):string;
  assertCheckpointHistory(actual:unknown,source:Source,count?:number):void;BASELINE_CHECKPOINT_VERSION:string};
const api=await import(new URL('../scripts/test-migration-baseline-checkpoint.mjs',import.meta.url).href) as Api;
const { Parser }=createRequire(import.meta.url)('@pgsql/parser') as {Parser:new(o:{version:number})=>{parse(sql:string):Promise<{stmts:{stmt:object}[]}>}};
const hash=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
function source(){
  const manifest=JSON.parse(readFileSync(new URL('../supabase/migration-manifest.dev.json',import.meta.url),'utf8')) as {totalCount:number;head:string;migrations:{name:string;order:number;sha256:string}[]};
  const directory=new URL('../supabase/migrations/',import.meta.url);
  const entries:FileEntry[]=readdirSync(directory).filter(f=>f.endsWith('.sql')).map(file=>({file,
    raw:Buffer.from(readFileSync(new URL(file,directory),'utf8').replaceAll('\r\n','\n')),isFile:true,isSymbolicLink:false}));
  return {manifest,entries};
}
function gate(){return {env:{GITHUB_ACTIONS:'true',GITHUB_WORKFLOW:'quality',RMS_FINAL_DB_GATE_MODE:'full',
  GITHUB_REPOSITORY:'wrongstory/room-management-system-backend',GITHUB_SHA:'a'.repeat(40),RMS_FINAL_DB_INPUT_SHA256:'b'.repeat(64),
  GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',GITHUB_EVENT_NAME:'pull_request'},head:'a'.repeat(40),inputFingerprint:'b'.repeat(64),
  event:{pull_request:{base:{ref:'main',repo:{full_name:'wrongstory/room-management-system-backend'}},head:{ref:'release/v1.0.0',repo:{full_name:'wrongstory/room-management-system-backend'}}}}};}
const nonce=`rms_h1_${'1'.repeat(32)}`;
function output(){const f=baselineMetadataFixture(),identity=['12345','postgres','postgres','170006','on','repeatable read',nonce,'2026-10-25T01:02:03.123456Z',...BASELINE_OUTPUT_SETTINGS.map(s=>s.value)];
  const lines=[JSON.stringify(identity),JSON.stringify(f.history.rows),JSON.stringify(f.catalog.rows),JSON.stringify(identity),'BASELINE_CHECKPOINT_ROLLBACK_ACK'];
  return {...f,identity,lines};}
describe('#14 prefix122 checkpoint source and synthetic boundary, no database',()=>{
  it('pins exact prefix and binds the complete current source tip',()=>{
    const f=source(),r=api.validateBaselineCheckpointSource(f.manifest,f.entries);
    expect(r).toMatchObject({totalCount:f.manifest.totalCount,prefixCount:122});expect(r.files[121]?.version).toBe(api.BASELINE_CHECKPOINT_VERSION);
    expect(r.files.at(-1)?.name).toBe(f.manifest.head);expect(Object.isFrozen(r.files)).toBe(true);
  });
  it('supports a separately source-bound future tip without a hardcoded135 ceiling',()=>{
    const f=source(),raw=Buffer.from('select 1;\n'),file='20261026000000_synthetic_future_tail.sql';
    f.entries.push({file,raw,isFile:true,isSymbolicLink:false});f.manifest.totalCount++;f.manifest.head='synthetic_future_tail';
    f.manifest.migrations.push({order:f.manifest.totalCount,name:'synthetic_future_tail',sha256:hash(raw)});
    const r=api.validateBaselineCheckpointSource(f.manifest,f.entries);expect(r.files.at(-1)?.file).toBe(file);
    expect(()=>api.assertCheckpointHistory(r.files.slice(0,-1).map(({version,name})=>({version,name})),r)).toThrow();
  });
  it.each(['prefix','tail','extra','missing','link','order','manifest-count','head'])('rejects %s source drift',kind=>{
    const f=source(),first=f.entries[0],record=f.manifest.migrations[0],last=f.entries.at(-1);if(!first||!record||!last)throw new Error();
    if(kind==='prefix'){first.raw=Buffer.concat([first.raw,Buffer.from('\n-- changed\n')]);record.sha256=hash(first.raw);}
    if(kind==='tail')last.raw=Buffer.from('select 0;');
    if(kind==='extra')f.entries.push({...first});if(kind==='missing')f.entries.pop();if(kind==='link')first.isSymbolicLink=true;
    if(kind==='order')record.order=2;if(kind==='manifest-count')f.manifest.totalCount--;if(kind==='head')f.manifest.head='unknown';
    expect(()=>api.validateBaselineCheckpointSource(f.manifest,f.entries)).toThrow(/^BASELINE_CHECKPOINT_UNAVAILABLE$/);
  });
  it('requires the existing full release gate and same merge-tree fingerprint',()=>{
    expect(api.validateBaselineCheckpointGate(gate())).toMatchObject({executionApprovalVerified:false});
  });
  it.each(['dev','main','reused','manual','repository','fingerprint','head','attempt'])('rejects %s execution route',kind=>{
    const f=gate();if(kind==='dev')f.event.pull_request.base.ref='dev';if(kind==='main')f.env.GITHUB_EVENT_NAME='push';
    if(kind==='reused')f.env.RMS_FINAL_DB_GATE_MODE='reused';if(kind==='manual')f.env.GITHUB_ACTIONS='false';
    if(kind==='repository')f.env.GITHUB_REPOSITORY='other/repo';if(kind==='fingerprint')f.inputFingerprint='c'.repeat(64);
    if(kind==='head')f.head='c'.repeat(40);if(kind==='attempt')f.env.GITHUB_RUN_ATTEMPT='0';
    expect(()=>api.validateBaselineCheckpointGate(f)).toThrow();
  });
  it('decodes only one matching RO/RR session followed by rollback acknowledgement',()=>{
    const f=output(),r=api.decodeBaselineCheckpointOutput(f.lines.join('\n'),f.expected,nonce);
    expect(r.metadata.history).toHaveLength(122);expect(r).toMatchObject({baselineAccepted:false,fullDbProofVerified:false});
  });
  it.each(['backend','nonce','version','read-write','isolation','timezone','date-style','rollback','truncated','extra','raw'])('rejects %s observation',kind=>{
    const f=output();if(kind==='backend')f.identity[0]='54321';if(kind==='nonce')f.identity[6]=`rms_h1_${'2'.repeat(32)}`;
    if(kind==='version')f.identity[3]='160001';if(kind==='read-write')f.identity[4]='off';if(kind==='isolation')f.identity[5]='read committed';
    if(kind==='timezone')f.identity[8]='Asia/Seoul';if(kind==='date-style')f.identity[9]='SQL, DMY';
    f.lines[3]=JSON.stringify(f.identity);if(kind==='rollback')f.lines[4]='';if(kind==='truncated')f.lines.pop();
    if(kind==='extra')f.lines.push('{}');if(kind==='raw')f.lines[1]='private SQL content';
    expect(()=>api.decodeBaselineCheckpointOutput(f.lines.join('\n'),f.expected,nonce)).toThrow(/^BASELINE_CHECKPOINT_UNAVAILABLE$/);
  });
  it('allows only one successful reset replacement in the bounded time interval',()=>{
    const started=Date.parse('2026-10-25T01:00:00Z'),before={id:'a'.repeat(64),image:`sha256:${'b'.repeat(64)}`,daemon:'synthetic-daemon'};
    const after={...before,id:'c'.repeat(64),created:'2026-10-25T01:00:30.123456789Z'};
    expect(api.validateBaselineCheckpointReplacement(before,after,started,started+60000)).toBe(after.id);
    for(const changed of [{...after,id:before.id},{...after,image:`sha256:${'d'.repeat(64)}`},{...after,daemon:'other'},
      {...after,created:'2026-10-25T00:59:59Z'},{...after,created:'2026-10-25T01:01:01Z'}]){
      expect(()=>api.validateBaselineCheckpointReplacement(before,changed,started,started+60000)).toThrow();
    }
    expect(()=>api.validateBaselineCheckpointReplacement(before,after,started,started+180001)).toThrow();
  });
  it('refuses mutable project dotenv and runtime target overrides without reading their values',()=>{
    expect(()=>api.validateBaselineCheckpointEnvironment({},['.env.example'],[])).not.toThrow();
    for(const file of ['.env','.env.local','.env.development','.env.production.local'])expect(()=>api.validateBaselineCheckpointEnvironment({},[file],[])).toThrow();
    for(const key of ['SUPABASE_EXPERIMENTAL','SUPABASE_PROJECT_ID','PGHOST','DOTENV_PRIVATE_KEY','NODE_OPTIONS','DOCKER_HOST']){
      expect(()=>api.validateBaselineCheckpointEnvironment({[key]:'synthetic-value'},[],[])).toThrow();
    }
  });
  it.each([15,17])('parses the fixed transaction on PostgreSQL %i without executing it',async version=>{
    const parsed=await new Parser({version}).parse(api.baselineCheckpointReadSql(nonce));
    const kinds=parsed.stmts.flatMap(s=>Object.keys(s.stmt));
    expect(new Set(kinds)).toEqual(new Set(['TransactionStmt','VariableSetStmt','SelectStmt']));
    expect(kinds.filter(s=>s==='TransactionStmt')).toHaveLength(2);
    expect(()=>api.baselineCheckpointReadSql("bad';delete")).toThrow();
  });
  it('preserves existing full validation/cleanup and only publishes the oracle before final proof',()=>{
    const text=readFileSync(new URL('../.github/workflows/quality.yml',import.meta.url),'utf8').replaceAll('\r\n','\n');
    expect(text).toContain('run: node scripts/test-migration-baseline-checkpoint.mjs');
    for(const command of ['db:test:template-contract','db:test:migration-readonly-tls','db:lint:baseline','backup:dry-run','npm run db:test\n','db:test:static-warning','db:test:long-stay-clock','db:test:concurrency','db:stop'])expect(text).toContain(command);
    expect(text.indexOf('run: npm run db:stop')).toBeLessThan(text.indexOf('uses: actions/upload-artifact@'));
    expect(text.indexOf('uses: actions/upload-artifact@')).toBeLessThan(text.indexOf('- name: Full DB proof'));
    expect(text).toContain('if-no-files-found: error');expect(text).toContain('timeout-minutes: 40');
  });
});
