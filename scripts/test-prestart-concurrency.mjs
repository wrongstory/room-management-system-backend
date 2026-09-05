import { randomUUID } from 'node:crypto';

function assert(value,message) { if(!value) throw new Error(message); }
function ok(result,label) { assert(!result.error,`${label}: ${result.error?.message}`);return result.data; }

// 기존 runner의 fresh/local client만 받는다. production 연결을 구성하지 않는다.
export async function testPrestartConcurrency(client,actorProfileId) {
  const maids=[];
  const day=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
  const weekday=new Date(`${day}T00:00:00Z`).getUTCDay() || 7;
  const week=new Date(Date.parse(`${day}T00:00:00Z`)-(weekday-1)*86400000).toISOString().slice(0,10);
  for(let i=0;i<2;i++) {
    const id=randomUUID();
    ok(await client.auth.admin.createUser({id,email:`prestart-${id}@test.invalid`,password:`T:${randomUUID()}`,email_confirm:true}),'maid Auth fixture');
    const profile=randomUUID();
    ok(await client.from('profiles').insert({id:profile,auth_user_id:id,display_name:`prestart-${id}`,display_name_normalized:`prestart-${id}`,
      login_id:`prestart-${id}`,login_id_normalized:`prestart-${id}`,login_sequence:0,role:'maid',status:'active'}),'maid fixture');
    const v=randomUUID();
    ok(await client.from('availability_versions').insert({id:v,maid_profile_id:profile,week_start:week,version:1,submitted_at:new Date().toISOString()}),'availability fixture');
    ok(await client.from('availability_days').insert(Array.from({length:7},(_,d)=>({availability_version_id:v,
      work_date:new Date(Date.parse(`${week}T00:00:00Z`)+d*86400000).toISOString().slice(0,10),available:true}))),'availability days');
    maids.push(profile);
  }
  const rooms=ok(await client.from('rooms').select('id').order('room_number').range(90,105),'rooms');
  let n=0;
  async function fixture() {
    const target=randomUUID();const assignment=randomUUID();const seq=++n;
    ok(await client.from('cleaning_targets').insert({id:target,room_id:rooms[seq].id,cleaning_kind:'additional',source:'manual_room_request',
      source_key:`prestart-race-${target}`,original_service_date:day,effective_service_date:day,available_from:`${day}T08:00:00+09:00`,due_at:`${day}T23:00:00+09:00`,
      status:'notified',assignment_version:2,room_type_snapshot:{},fee_snapshot:10000,template_snapshot:{},created_by:actorProfileId}),'target fixture');
    ok(await client.from('cleaning_assignments').insert({id:assignment,cleaning_target_id:target,maid_profile_id:maids[0],sequence_number:seq,revision:2,
      notified_at:new Date().toISOString(),changed_by:actorProfileId}),'assignment fixture');
    return {target,assignment,seq};
  }
  const args=f=>({p_actor_profile_id:actorProfileId,p_cleaning_target_id:f.target,p_expected_current_assignment_id:f.assignment,
    p_expected_assignment_version:2,p_reason_code:'OPERATIONAL_CHANGE',p_idempotency_key:`prestart-${randomUUID()}`,p_request_hash:'a'.repeat(64)});
  const change=f=>({...args(f),p_maid_profile_id:maids[1],p_sequence_number:f.seq});
  const request=f=>({...args(f),p_actor_profile_id:maids[0],p_reason_code:'PERSONAL_REASON'});
  const decision=(f,q)=>{const a=args(f);delete a.p_cleaning_target_id;return {...a,p_request_id:q.requestId,p_decision:'approved'};};
  function closed(results,pattern) { assert(results.filter(r=>r.error).every(r=>pattern.test(r.error.message)),'race loser must be stable, not deadlock/provider failure'); }

  // 실제 병렬 HTTP transaction. 시작이 먼저면 변경 거부, 변경이 먼저면 stale assignment 시작 거부.
  for(let repeat=0;repeat<3;repeat++) {
    const f=await fixture();
    const results=await Promise.all([client.rpc('change_cleaning_assignment_prestart',change(f)),client.from('cleaning_attempts').insert({
      cleaning_target_id:f.target,assignment_id:f.assignment,maid_profile_id:maids[0],attempt_number:1,assignment_revision:2,status:'scheduled',template_snapshot:{},room_snapshot:{}})]);
    assert(results.filter(r=>!r.error).length===1,'change versus activation exactly one winner');
    closed(results,/ASSIGNMENT_ALREADY_STARTED|ASSIGNMENT_VERSION_CONFLICT/);
  }
  const f=await fixture();
  const changes=await Promise.all([client.rpc('change_cleaning_assignment_prestart',change(f)),client.rpc('change_cleaning_assignment_prestart',change(f))]);
  assert(changes.filter(r=>!r.error).length===1,'two changes same version exactly one winner');closed(changes,/ASSIGNMENT_VERSION_CONFLICT/);

  const g=await fixture();
  const changeRequest=await Promise.all([client.rpc('change_cleaning_assignment_prestart',change(g)),client.rpc('request_assignment_cancellation',request(g))]);
  ok(changeRequest[0],'change/request change winner');closed(changeRequest,/ASSIGNMENT_VERSION_CONFLICT|ASSIGNMENT_CHANGE_REQUEST_ACCESS_REQUIRED/);
  const pending=ok(await client.from('assignment_change_requests').select('id').eq('assignment_id',g.assignment).eq('status','pending'),'pending query');
  assert(pending.length===0,'no ghost request after reassignment');

  const h=await fixture();const q=ok(await client.rpc('request_assignment_cancellation',request(h)),'decision race request');
  const decisionChange=await Promise.all([client.rpc('decide_assignment_cancellation_request',decision(h,q)),client.rpc('change_cleaning_assignment_prestart',change(h))]);
  assert(decisionChange.filter(r=>!r.error).length===1,'decision versus change exactly one winner');
  closed(decisionChange,/ASSIGNMENT_CHANGE_REQUEST_STALE|ASSIGNMENT_NOT_FOUND|ASSIGNMENT_VERSION_CONFLICT/);
  const current=ok(await client.from('cleaning_assignments').select('id,maid_profile_id').eq('cleaning_target_id',h.target).eq('is_current',true),'current query');
  assert(decisionChange[1].error ? current.length===0 : current.length===1 && current[0].maid_profile_id===maids[1],'stale request never cancels new assignment');

  const j=await fixture();const jq=ok(await client.rpc('request_assignment_cancellation',request(j)),'double decision request');
  const d=decision(j,jq);
  const decisions=await Promise.all([client.rpc('decide_assignment_cancellation_request',d),client.rpc('decide_assignment_cancellation_request',d)]);
  assert(decisions.every(r=>!r.error) && JSON.stringify(decisions[0].data)===JSON.stringify(decisions[1].data),'concurrent decision replay same logical response');
  const notices=ok(await client.from('notifications').select('id').eq('dedupe_key',`assignment-decision:${jq.requestId}`),'decision notice');
  const audits=ok(await client.from('audit_events').select('id').eq('entity_id',jq.requestId).eq('event_type','assignment.cancellation_decided'),'decision audit');
  assert(notices.length===1 && audits.length===1,'exactly one decision notification/audit');
  console.log('Prestart races PASS: change/activation (3), two changes/CAS, change/request, decision/change, concurrent decision replay; no ghost pending or duplicate decision.');
}
