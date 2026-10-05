import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Local synthetic PostgreSQL transactions overlap with nonlocking STABLE reads.
// Actual payroll start and session deletion remain uncommitted until release.
const root=fileURLToPath(new URL('..',import.meta.url));
const cli=fileURLToPath(new URL('../node_modules/supabase/dist/supabase.js',import.meta.url));
const psqlArgs=['exec','-i','supabase_db_room-management-system-backend','psql','-X','-qAt',
  '-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres'];
const source=readFileSync(new URL('../supabase/tests/payroll_adjustment_book.sql',import.meta.url),'utf8');
const beginMarker='-- PAYROLL_BOOK_FIXTURE_BEGIN', endMarker='-- PAYROLL_BOOK_FIXTURE_END';
assert.equal(source.split(beginMarker).length,2);assert.equal(source.split(endMarker).length,2);
const fixture=source.split(beginMarker)[1].split(endMarker)[0];
assert(!/\\ir|\b(?:no_plan|plan|finish)\s*\(/i.test(fixture),'Only exact checked-in setup');
const id=n=>`f3250000-0000-4000-8000-${String(n).padStart(12,'0')}`;
let week;
const read=(actor=3)=>`select public.list_payroll_work_details_page('${id(actor)}','${id(400+actor)}',
  'admin',${week},'${id(2)}','earnings',null,null,25);`;
const start=()=>`select public.start_payroll_cycle('${id(1)}','${id(2)}',${week},0,'detail-race-start',repeat('a',64));`;
let phase='local-identity', resetStarted=false;const pending=[];
function sql(input) {
  try {return execFileSync('docker',psqlArgs,{cwd:root,input:`set statement_timeout='5s';${input}`,
    encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:10000,maxBuffer:16*1024*1024}).trim();}
  catch {throw new Error('PAYROLL_DETAILS_RACE_SQL_FAILED');}
}
function reset(){execFileSync(process.execPath,[cli,'db','reset','--local','--no-seed'],{cwd:root,stdio:'inherit'});}
function wholeState() {
  const tables = JSON.parse(sql(`select jsonb_agg(format('%I.%I',n.nspname,c.relname) order by n.nspname,c.relname)
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private') and c.relkind='r';`));
  const rows = tables.map((table) => {
    assert(/^(public|private)\.[a-z_][a-z_0-9]*$/.test(table));
    return `select '${table}' tag,to_jsonb(t)::text data from ${table} t`;
  });
  return sql(`select md5(coalesce(string_agg(tag||':'||data,'|' order by tag,data),''))
    from (${rows.join(' union all ')}) all_rows;`);
}

function processResult(child) {
  let safeCode = null;
  let output = '';
  const timer = setTimeout(() => child.kill(), 25000);
  const done = new Promise((resolve) => {
    child.once('error', () => { clearTimeout(timer); resolve({ exitCode: -1, code: 'PROCESS_FAILED' }); });
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    // Never expose raw SQL, RPC payloads, IDs or subprocess errors in failures.
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      if (text.includes('deadlock detected')) safeCode = 'DEADLOCK';
      else if (text.includes('STALE_ADJUSTMENT_VERSION')) safeCode = 'STALE_ADJUSTMENT_VERSION';
      else if (text.includes('PAYROLL_SOURCE_ALREADY_REVERSED')) safeCode = 'PAYROLL_SOURCE_ALREADY_REVERSED';
      else if (text.includes('SESSION_REVOKED')) safeCode = 'SESSION_REVOKED';
      else if (text.includes('ERROR:')) safeCode = 'OTHER_DATABASE_ERROR';
    });
    child.once('close', (exitCode) => { clearTimeout(timer); resolve({ exitCode, code: safeCode }); });
  });
  return { child, done, output: () => output };
}
async function holder(command, name) {
  assert(/^[a-z_]+$/.test(name));
  const child = spawn('docker', psqlArgs, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  const item = processResult(child);
  let ready = false;
  const readyPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('PAYROLL_DETAILS_HOLDER_TIMEOUT')); }, 10000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('PAYROLL_DETAILS_HOLDER_FAILED')); });
    child.once('close', () => { if (!ready) { clearTimeout(timer); reject(new Error('PAYROLL_DETAILS_HOLDER_FAILED')); } });
    child.stdout.on('data', (chunk) => {
      if (!ready && (item.output() + chunk.toString()).includes('PAYROLL_DETAILS_LOCK_HELD')) {
        ready = true;
        clearTimeout(timer);
        resolve();
      }
    });
  });
  let released = false;
  item.release = async () => {
    if (!released) { released = true; child.stdin.end('commit;\n\\q\n'); }
    return item.done;
  };
  pending.push(item);
  child.stdin.write(`set application_name='${name}';begin;set local statement_timeout='15s';
    set local idle_in_transaction_session_timeout='20s';${command}\n\\echo PAYROLL_DETAILS_LOCK_HELD\n`);
  await readyPromise;
  return item;
}

function observedHolder(name){
  assert(/^[a-z_]+$/.test(name));
  assert.equal(sql(`select exists(select 1 from pg_stat_activity where application_name='${name}'
    and state='idle in transaction' and xact_start is not null);`),'t','Live uncommitted holder is observed');
}
try {
  const configSource=readFileSync(new URL('../supabase/config.toml',import.meta.url),'utf8');
  assert.equal((configSource.match(/^[ \t]*project_id[ \t]*=/gm)??[]).length,1);
  assert.equal(/^[ \t]*project_id[ \t]*=[ \t]*"([^"\r\n]+)"[ \t]*(?:#[^\r\n]*)?\r?$/m.exec(configSource)?.[1],
    'room-management-system-backend','CLI reset and fixed psql container address the same local project');
  const status=JSON.parse(execFileSync(process.execPath,[cli,'status','--output','json'],
    {cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  assert(['localhost','127.0.0.1'].includes(new URL(status.API_URL).hostname),'Local-only synthetic race');
  resetStarted=true;reset();sql(`begin;${fixture}commit;`);
  const fixtureWeek=sql(`select to_char(date_trunc('week',earned_on::timestamp)::date,'YYYY-MM-DD')
    from public.earnings where id='${id(5001)}';`);
  assert(/^\d{4}-\d{2}-\d{2}$/.test(fixtureWeek),'One exact historical fixture week');
  week=`'${fixtureWeek}'::date`;
  phase='uncommitted-payroll-start';
  const before=JSON.parse(sql(read()));
  assert.equal(before.summary.cycleId,null);assert.equal(before.summary.totalAmount,10000);
  assert.equal(before.entries[0].alreadyClaimed,false);
  const held=await holder(start(),'payroll_details_start_holder');
  try {
    observedHolder('payroll_details_start_holder');
    const state=wholeState();
    const during=JSON.parse(sql(read()));
    assert.deepEqual(during,before,'Page and summary see the complete old snapshot, no half-created payment membership');
    assert.equal(wholeState(),state,'Overlapping read writes no rows');
  } finally {assert.equal((await held.release()).exitCode,0,'Real payroll start commits');}
  const after=JSON.parse(sql(read()));
  assert.equal(after.summary.cycleStatus,'paying');assert.equal(after.summary.lockedAmount,10000);
  assert.equal(after.summary.accrualAmount,10000);assert.equal(after.summary.totalAmount,10000);
  assert.equal(after.entries[0].alreadyClaimed,true);assert.equal(after.entries[0].itemContributionAmount,10000);
  assert.equal(after.entries[0].totalAmount,before.entries[0].totalAmount);
  const preserved=wholeState();
  sql(`begin read only;${read()}rollback;`);
  assert.equal(wholeState(),preserved,'Actual locked payment and receipt stay byte-exact after readonly detail');
  phase='uncommitted-session-revocation';
  const revoked=await holder(`delete from auth.sessions where id='${id(403)}';`,'payroll_details_session_holder');
  try {
    observedHolder('payroll_details_session_holder');
    assert.deepEqual(JSON.parse(sql(read())),after,'Previously committed session remains visible until revocation commits');
  } finally {assert.equal((await revoked.release()).exitCode,0,'Real session revocation commits');}
  const reader=spawn('docker',psqlArgs,{cwd:root,stdio:['pipe','pipe','pipe']});
  const result=processResult(reader);pending.push(result);
  reader.stdin.end(read());
  const denied=await result.done;
  assert.notEqual(denied.exitCode,0);assert.equal(denied.code,'SESSION_REVOKED','Next request strictly rejects committed revoked session');
  assert.deepEqual(JSON.parse(sql(read(1))),after,'Other active admin retains exact narrow projection');
  assert.equal(wholeState(),preserved,'Revoked read and alternate reader do not change business rows');
  console.log('Payroll work details concurrency PASS: observed payroll-start and session-revocation overlaps; coherent nonblocking committed snapshots, no read effects, next-request session denial.');
} catch(error){
  const line=error instanceof Error?error.stack?.match(/test-payroll-work-details-concurrency\.mjs:(\d+):\d+/)?.[1]:null;
  console.error(`Payroll work details concurrency FAIL: ${JSON.stringify({phase,
    kind:error instanceof assert.AssertionError?'ASSERTION_FAILED':'VALIDATION_FAILED',sourceLine:line?Number(line):null})}`);
  process.exitCode=1;
} finally {
  for(const item of pending){try {if(item.release)await item.release();else item.child.kill();}catch{process.exitCode=1;}}
  if(resetStarted){try{reset();}catch{console.error('Payroll work details concurrency fresh cleanup FAIL');process.exitCode=1;}}
}
