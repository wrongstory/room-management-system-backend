import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {Client} from 'pg';
import {assignmentMemoLocalConnection,closeAssignmentMemoConnections} from './test-assignment-instruction-concurrency.mjs';
import {observeRoomFixedMemoLock,withRoomFixedMemoCleanup} from './test-room-fixed-memo-concurrency.mjs';

// Import is inert. This thirteenth direct program is prepared, never run without approval.
export const feeConcurrencyLimits=Object.freeze({workMs:90000,cleanupMs:10000});
export const feeId=n=>`57700000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export function feeFixture(){
 const source=readFileSync('supabase/tests/room_type_cleaning_fee.sql','utf8');
 const start='-- BEGIN ROOM TYPE FEE FIXTURE',end='-- END ROOM TYPE FEE FIXTURE';
 assert(source.split(start).length===2&&source.split(end).length===2,'FEE_FIXTURE_MARKERS');
 const result=source.split(start)[1].split(end)[0];
 assert(!/\\ir|\b(?:no_plan|plan|finish)\s*\(/i.test(result),'FEE_SETUP_ONLY');return result;
}
export function feeCommand({actor,session,type,version,fee,key}){
 assert([actor,session,type].every(x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x)),'FEE_IDENTITIES');
 assert(Number.isSafeInteger(version)&&version>0&&version<Number.MAX_SAFE_INTEGER,'FEE_VERSION');
 assert(Number.isInteger(fee)&&fee>=0&&fee<=1073741823,'FEE_AMOUNT');
 assert(typeof key==='string'&&/^fee577-[a-z0-9-]{1,80}$/.test(key),'FEE_KEY');
 const hash=createHash('sha256').update(JSON.stringify([actor,type,version,fee,true])).digest('hex');
 return {text:'select public.set_room_type_cleaning_fee($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::integer,$6::boolean,$7::text,$8::text) as result',
  values:[actor,session,type,version,fee,true,key,hash]};
}
export async function testRoomTypeFeeConcurrency(connectionString,onPhase=()=>{}){
 const config=assignmentMemoLocalConnection(connectionString);
 const entries=Array.from({length:3},()=>({client:new Client({...config,application_name:'room_type_fee577'}),connected:false,busy:false,failed:false}));
 for(const entry of entries) entry.client.on('error',()=>{entry.failed=true;});
 const [probe,first,second]=entries;
 onPhase('setup');
 await withRoomFixedMemoCleanup(async signal=>{
  const query=async(entry,text,values=[])=>{assert(!signal.stopped&&!entry.busy&&!entry.failed,'FEE_WORK_STOPPED');entry.busy=true;
   try{return await entry.client.query(text,values);}finally{entry.busy=false;}};
  await Promise.all(entries.map(async entry=>{await entry.client.connect();entry.connected=true;}));
  const identities=await Promise.all(entries.map(entry=>query(entry,'select pg_backend_pid() as pid,current_database() as db')));
  const pids=identities.map(x=>x.rows[0].pid);assert(new Set(pids).size===3&&identities.every(x=>x.rows[0].db==='postgres'),'FEE_DISTINCT_LOCAL_SESSIONS');
  assert.equal((await query(probe,'select count(*)::integer n from public.profiles')).rows[0].n,0,'FEE_FRESH_DISPOSABLE_DB');
  await query(probe,`begin;${feeFixture()}commit;`);
  await query(probe,'select pg_temp.fee_request(1)');
  const before=(await query(probe,'select to_jsonb(t) value from public.cleaning_targets t where id=$1',[feeId(1001)])).rows[0].value;
  const type=(await query(probe,'select id from public.room_types where code=\'standard\'')).rows[0].id;
  const current=async()=>{const r=(await query(probe,'select version,base_cleaning_fee fee from public.room_types where id=$1',[type])).rows[0];return {version:Number(r.version),fee:r.fee};};
  const cmd=(state,key,amount,who=1)=>feeCommand({actor:feeId(who),session:feeId(200+who),type,version:state.version,fee:amount,key});
  async function pair(a,b,expected,midWait=async()=>{}){
   await query(first,'begin');await query(first,'set local role service_role');
   assert.equal((await query(first,'select current_role as role')).rows[0].role,'service_role','FEE_FIRST_RUNTIME_ROLE');
   const winner=(await query(first,a.text,a.values)).rows[0].result;
   await query(second,'begin');await query(second,'set local role service_role');
   assert.equal((await query(second,'select current_role as role')).rows[0].role,'service_role','FEE_SECOND_RUNTIME_ROLE');
   const pending=query(second,b.text,b.values).then(r=>({ok:true,value:r.rows[0].result}),error=>({ok:false,code:error.code,domain:['STALE_VERSION','IDEMPOTENCY_KEY_REUSED','SESSION_REVOKED'].includes(error.message)?error.message:'UNEXPECTED'}));
   await observeRoomFixedMemoLock(async(_a,_b)=>{const r=await query(probe,"select wait_event_type='Lock' and $1::int=any(pg_blocking_pids(pid)) as blocked from pg_stat_activity where pid=$2",[pids[1],pids[2]]);return r.rows[0]?.blocked===true;},pids[1],pids[2]);
   await midWait();await query(first,'commit');const loser=await pending;await query(second,loser.ok?'commit':'rollback');
   if(!loser.ok&&loser.domain==='UNEXPECTED') throw Object.assign(new Error('FEE_UNEXPECTED_SQL'),{code:loser.code});
   for(const [command,value] of [[a,winner],...(loser.ok?[[b,loser.value]]:[])]) if(command.text.startsWith('select public.set_room_type_cleaning_fee')) {
    assert.equal(value.roomTypeId,type,'FEE_RECEIPT_TYPE');assert.equal(value.baseCleaningFee,command.values[4],'FEE_RECEIPT_PRICE');
    assert.equal(value.version,command.values[3]+1,'FEE_RECEIPT_VERSION');
   }
   assert(winner!==null,'FEE_FIRST_COMMITTED_RESULT');
   if(expected==='replay'){assert(loser.ok,'FEE_REPLAY_SUCCESS');assert.deepEqual(loser.value,winner,'FEE_EXACT_RECEIPT');}
   else if(expected==='success')assert(loser.ok,'FEE_SECOND_SUCCESS');
   else {const [code,domain]=expected;assert.deepEqual(loser,{ok:false,code,domain},'FEE_EXACT_EXPECTED_CONFLICT');}
  }
  const initial=await current();
  async function effects(n,fee){
   const value=await current();assert.deepEqual(value,{version:initial.version+n,fee},'FEE_EXACT_CATALOG_EFFECT');
   const counts=(await query(probe,"select (select count(*)::int from public.audit_events where event_type='room_type.cleaning_fee_changed') audits,(select count(*)::int from private.command_executions where command_type='room_type.cleaning_fee.set') receipts")).rows[0];
   assert.deepEqual(counts,{audits:n,receipts:n},'FEE_EXACT_AUDIT_AND_RECEIPT_EFFECTS');
  }
  onPhase('replay');let state=initial;let a=cmd(state,'fee577-race-replay',state.fee+1);await pair(a,a,'replay');await effects(1,initial.fee+1);
  onPhase('cas');
  state=await current();await pair(cmd(state,'fee577-race-cas-a',state.fee+1),cmd(state,'fee577-race-cas-b',state.fee+2,2),['40001','STALE_VERSION']);await effects(2,initial.fee+2);
  onPhase('key');
  state=await current();await pair(cmd(state,'fee577-race-key',state.fee+1),cmd(state,'fee577-race-key',state.fee+2),['23505','IDEMPOTENCY_KEY_REUSED']);await effects(3,initial.fee+3);
  onPhase('price-before-create');
  const request=async n=>{const room=(await query(probe,"select id,state_version from public.rooms where room_type_id=$1 and active and data_status='verified' order by room_number offset $2 limit 1",[type,n])).rows[0];
   return {text:`select public.create_manual_cleaning_request($1::uuid,$2::uuid,$3::uuid,null,'additional',(transaction_timestamp() at time zone 'Asia/Seoul')::date,transaction_timestamp(),transaction_timestamp()+interval '1 hour',$4::bigint,'ADMIN_ADDITIONAL_REQUEST',$5::text,$6::text) as result`,values:[feeId(1),feeId(1000+n),room.id,Number(room.state_version),`fee577-request-${n}`,createHash('sha256').update(`request-${n}`).digest('hex')]};};
  state=await current();await pair(cmd(state,'fee577-price-before-create',20000),await request(10),'success');await effects(4,20000);
  assert.equal((await query(probe,'select fee_snapshot from public.cleaning_targets where id=$1',[feeId(1010)])).rows[0].fee_snapshot,20000,'FEE_COMMITTED_PRICE_PRECEDES_CREATION');
  onPhase('create-before-price');state=await current();await pair(await request(11),cmd(state,'fee577-create-before-price',14000),'success');await effects(5,14000);
  assert.equal((await query(probe,'select fee_snapshot from public.cleaning_targets where id=$1',[feeId(1011)])).rows[0].fee_snapshot,state.fee,'FEE_CREATED_TARGET_PRESERVED_AFTER_CATALOG_CHANGE');
  onPhase('authority');state=await current();await pair(cmd(state,'fee577-authority-first',15000),cmd(state,'fee577-authority-revoked',16000,2),['42501','SESSION_REVOKED'],
   ()=>query(probe,"update auth.sessions set not_after=clock_timestamp()-interval '1 second' where id=$1",[feeId(202)]));await effects(6,15000);
  assert.deepEqual((await query(probe,'select to_jsonb(t) value from public.cleaning_targets t where id=$1',[feeId(1001)])).rows[0].value,before,'FEE_PRIOR_TARGET_FULL_ROW_PRESERVED');
  assert.equal((await query(probe,"select count(*)::integer n from private.command_executions where command_type='room_type.cleaning_fee.set' and idempotency_key in ('fee577-race-cas-b','fee577-authority-revoked')")).rows[0].n,0,'FEE_CONFLICTS_LEAVE_NO_RECEIPTS');
 },()=>closeAssignmentMemoConnections(entries),feeConcurrencyLimits);
 console.log('Room type fee concurrency PASS: six observed lock races, replay/CAS/key conflict, both target-creation orders, post-wait revoked session and historical target preservation.');
}
export async function runRoomTypeFeeConcurrency(){
 const cli='node_modules/supabase/dist/supabase.js';let resetStarted=false;let phase='local-identity';
 const reset=()=>execFileSync(process.execPath,[cli,'db','reset','--local','--no-seed'],{stdio:'inherit',timeout:180000});
 try{
  const status=JSON.parse(execFileSync(process.execPath,[cli,'status','-o','json'],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:15000}));
  assignmentMemoLocalConnection(status.DB_URL);resetStarted=true;phase='fresh-reset';reset();phase='fee-races';await testRoomTypeFeeConcurrency(status.DB_URL,stage=>{phase='fee-'+stage;});
 }catch(error){const sourceLine=error instanceof Error?error.stack?.match(/test-room-type-fee-concurrency\.mjs:(\d{1,6}):\d+/)?.[1]:null;
  const sqlState=['23514','23505','40001','42501','P0001','P0002','40P01','55P03','57014','23P01','42601'].includes(error?.code)?error.code:null;
  console.error(`Room type fee concurrency FAIL: ${JSON.stringify({phase,kind:error instanceof assert.AssertionError?'ASSERTION_FAILED':'VALIDATION_FAILED',sourceLine:sourceLine?Number(sourceLine):null,sqlState})}`);process.exitCode=1;
 }finally{if(resetStarted){try{reset();}catch{console.error('Room type fee fresh cleanup FAIL');process.exitCode=1;}}}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) await runRoomTypeFeeConcurrency();
