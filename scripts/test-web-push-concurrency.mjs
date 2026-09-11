import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

function assert(condition,message){if(!condition)throw new Error(message);}
function digest(value){return createHash('sha256').update(value).digest('hex');}
function sealed(value){return Buffer.from(value).toString('base64');}
function query(sql){return execFileSync('docker',['exec','-i','supabase_db_room-management-system-backend','psql','-X','-A','-t','-q','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-c',sql],{encoding:'utf8',timeout:15000}).trim();}
const execFileAsync=promisify(execFile);
async function queryAsync(sql){const {stdout}=await execFileAsync('docker',['exec','-i','supabase_db_room-management-system-backend','psql','-X','-A','-t','-q','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-c',sql],{encoding:'utf8',timeout:15000});return stdout.trim();}

export async function testWebPushConcurrency(client){
  const authUserId=randomUUID(),profileId=randomUUID(),email=`push-${randomUUID()}@test.invalid`;
  const created=await client.auth.admin.createUser({id:authUserId,email,email_confirm:true});assert(!created.error,'web push auth fixture');
  const displayName=`push concurrency ${profileId}`;
  const profile=await client.from('profiles').insert({id:profileId,auth_user_id:authUserId,display_name:displayName,display_name_normalized:displayName,login_id:`push-${profileId}`,login_id_normalized:`push-${profileId}`,login_sequence:0,role:'maid',status:'active',must_change_password:false});assert(!profile.error,'web push profile fixture');
  const sessionIds=Array.from({length:4},()=>randomUUID());
  query(`insert into auth.sessions(id,user_id) values ${sessionIds.map(id=>`('${id}'::uuid,'${authUserId}'::uuid)`).join(',')}`);
  const args=(sessionId,proposedId,key,endpoint,material,expectedId=null,expectedVersion=null)=>({
    p_actor_profile_id:profileId,p_session_id:sessionId,p_proposed_subscription_id:proposedId,
    p_expected_subscription_id:expectedId,p_expected_version:expectedVersion,p_endpoint_digest:digest(`endpoint:${profileId}:${endpoint}`),
    p_session_digest:digest(`session:${sessionId}`),p_material_digest:digest(`material:${material}`),p_expiration_at:null,p_key_version:'v1',
    p_ciphertext_base64:sealed(`sealed:${material}`),p_nonce_base64:sealed('n'.repeat(12)),p_auth_tag_base64:sealed('t'.repeat(16)),
    p_idempotency_key:key,p_request_hash:digest(`request:${endpoint}:${material}:${expectedId??''}:${expectedVersion??''}`)
  });
  const replayKey=`push-concurrent-${randomUUID()}`;
  const concurrent=await Promise.all([randomUUID(),randomUUID()].map(id=>client.rpc('register_web_push_subscription',args(sessionIds[0],id,replayKey,'one','one'))));
  const firstSummary=concurrent.map(result=>({id:result.data?.id??null,error:result.error?.message??null}));
  assert(concurrent.every(r=>!r.error)&&new Set(concurrent.map(r=>r.data.id)).size===1,`concurrent first register must replay one logical result: ${JSON.stringify(firstSummary)}`);
  const subscriptionId=concurrent[0].data.id;
  assert(query(`select count(*) from private.web_push_subscriptions where id='${subscriptionId}'::uuid`)==='1','concurrent first has one logical row');
  assert(query(`select count(*) from private.web_push_subscription_revisions where subscription_id='${subscriptionId}'::uuid`)==='1','concurrent first has one revision');
  assert(query(`select count(*) from private.web_push_subscription_secrets s join private.web_push_subscription_revisions r on r.id=s.revision_id where r.subscription_id='${subscriptionId}'::uuid`)==='1','concurrent first has one envelope');

  const otherAuthUserId=randomUUID(),otherProfileId=randomUUID(),otherSessionId=randomUUID(),sharedOwnerSessionId=randomUUID();
  const otherEmail=`push-${randomUUID()}@test.invalid`;
  const otherUser=await client.auth.admin.createUser({id:otherAuthUserId,email:otherEmail,email_confirm:true});
  assert(!otherUser.error,'cross-profile endpoint auth fixture');
  const otherDisplayName=`push concurrency ${otherProfileId}`;
  const otherProfile=await client.from('profiles').insert({id:otherProfileId,auth_user_id:otherAuthUserId,display_name:otherDisplayName,display_name_normalized:otherDisplayName,login_id:`push-${otherProfileId}`,login_id_normalized:`push-${otherProfileId}`,login_sequence:0,role:'maid',status:'active',must_change_password:false});
  assert(!otherProfile.error,'cross-profile endpoint profile fixture');
  query(`insert into auth.sessions(id,user_id) values('${otherSessionId}'::uuid,'${otherAuthUserId}'::uuid),('${sharedOwnerSessionId}'::uuid,'${authUserId}'::uuid)`);
  const sharedEndpointDigest=digest(`shared-endpoint:${randomUUID()}`);
  const ownEndpointArgs={...args(sharedOwnerSessionId,randomUUID(),`push-endpoint-owner-${randomUUID()}`,'shared-owner','shared-owner'),p_endpoint_digest:sharedEndpointDigest};
  const otherEndpointArgs={...args(otherSessionId,randomUUID(),`push-endpoint-other-${randomUUID()}`,'shared-other','shared-other'),p_actor_profile_id:otherProfileId,p_session_digest:digest(`session:${otherSessionId}`),p_endpoint_digest:sharedEndpointDigest};
  const endpointRace=await Promise.all([
    client.rpc('register_web_push_subscription',ownEndpointArgs),
    client.rpc('register_web_push_subscription',otherEndpointArgs)
  ]);
  assert(endpointRace.filter(result=>!result.error).length===1&&endpointRace.filter(result=>/WEB_PUSH_ENDPOINT_CONFLICT/.test(result.error?.message??'')).length===1,'concurrent cross-profile endpoint claim returns one opaque conflict');
  assert(query(`select count(*) from private.web_push_subscriptions where active_endpoint_digest='${sharedEndpointDigest}'`)==='1','global endpoint digest remains unique after cross-profile race');
  if(!endpointRace[0].error){
    const cleanup=await client.rpc('retire_web_push_subscription',{p_actor_profile_id:profileId,p_session_id:sharedOwnerSessionId,p_subscription_id:endpointRace[0].data.id,p_expected_version:1,p_idempotency_key:`push-endpoint-cleanup-${randomUUID()}`,p_request_hash:digest('endpoint-cleanup')});
    assert(!cleanup.error,'cross-profile endpoint profile-cap isolation cleanup');
  }

  const race=await Promise.all([
    client.rpc('register_web_push_subscription',args(sessionIds[0],subscriptionId,`push-rotate-${randomUUID()}`,'one','two',subscriptionId,1)),
    client.rpc('retire_web_push_subscription',{p_actor_profile_id:profileId,p_session_id:sessionIds[0],p_subscription_id:subscriptionId,p_expected_version:1,p_idempotency_key:`push-retire-${randomUUID()}`,p_request_hash:digest('retire-race')})
  ]);
  assert(race.filter(r=>!r.error).length===1&&race.filter(r=>r.error).length===1,'rotate versus retire has one CAS winner');
  const state=query(`select status||':'||(select count(*) from private.web_push_subscription_secrets s join private.web_push_subscription_revisions r on r.id=s.revision_id where r.subscription_id=w.id)::text from private.web_push_subscriptions w where id='${subscriptionId}'::uuid`);
  assert(state==='active:1'||state==='retired:0','rotate/retire winner leaves exact secret state');

  const distinct=await Promise.all([1,2].map(i=>client.rpc('register_web_push_subscription',args(sessionIds[i],randomUUID(),`push-isolated-${i}-${randomUUID()}`,`isolated-${i}`,`isolated-${i}`))));
  const distinctSummary=distinct.map(result=>({id:result.data?.id??null,error:result.error?.message??null}));
  assert(distinct.every(r=>!r.error)&&new Set(distinct.map(r=>r.data.id)).size===2,`different live sessions register independently: ${JSON.stringify(distinctSummary)}`);

  const sessionCapId=randomUUID();
  query(`insert into auth.sessions(id,user_id) values('${sessionCapId}'::uuid,'${authUserId}'::uuid)`);
  const sessionCap=await Promise.all([1,2].map(i=>client.rpc('register_web_push_subscription',args(sessionCapId,randomUUID(),`push-session-cap-${i}-${randomUUID()}`,`session-cap-${i}`,`session-cap-${i}`))));
  assert(sessionCap.filter(result=>!result.error).length===1&&sessionCap.filter(result=>/WEB_PUSH_CAS_REQUIRED/.test(result.error?.message??'')).length===1,'concurrent same-session registrations allow exactly one active subscription');

  const revokedSessionId=sessionIds[3];
  const revokeSubscriptionId=randomUUID();
  const [registerAfterRace]=await Promise.all([
    client.rpc('register_web_push_subscription',args(revokedSessionId,revokeSubscriptionId,`push-revoke-race-${randomUUID()}`,'revoke-race','revoke-race')),
    queryAsync(`delete from auth.sessions where id='${revokedSessionId}'::uuid`)
  ]);
  assert(registerAfterRace.error===null||/WEB_PUSH_SESSION_REVOKED/.test(registerAfterRace.error.message),'session revoke race has only success-before-revoke or revoked-session outcome');
  assert(query(`select count(*) from auth.sessions where id='${revokedSessionId}'::uuid`)==='0','revocation race ends with no live session');
  const racedRows=Number(query(`select count(*) from private.web_push_subscriptions where id='${revokeSubscriptionId}'::uuid`));
  assert(racedRows===(registerAfterRace.error?0:1),'session revoke race leaves no partial registration');

  const activeBefore=Number(query(`select count(*) from private.web_push_subscriptions where profile_id='${profileId}'::uuid and status='active'`));
  const fillSessionIds=Array.from({length:6-activeBefore},()=>randomUUID());
  query(`insert into auth.sessions(id,user_id) values ${fillSessionIds.map(id=>`('${id}'::uuid,'${authUserId}'::uuid)`).join(',')}`);
  const fill=await Promise.all(fillSessionIds.map((sessionId,index)=>client.rpc('register_web_push_subscription',args(sessionId,randomUUID(),`push-profile-cap-${index}-${randomUUID()}`,`profile-cap-${index}`,`profile-cap-${index}`))));
  assert(fill.filter(result=>!result.error).length===5-activeBefore&&fill.filter(result=>/WEB_PUSH_PROFILE_LIMIT/.test(result.error?.message??'')).length===1,'concurrent profile cap admits exactly five active subscriptions');
  assert(query(`select count(*) from private.web_push_subscriptions where profile_id='${profileId}'::uuid and status='active'`)==='5','profile active cap remains exactly five');
  console.log('Web Push concurrency passed: first replay=1/2, cross-profile endpoint=1/2 opaque conflict, rotate-vs-retire=1/2, session cap=1/2, profile cap=5, session revoke linearized, secret state exact.');
}
