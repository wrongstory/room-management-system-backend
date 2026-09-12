import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

function assert(condition,message){if(!condition)throw new Error(message);}
function digest(value){return createHash('sha256').update(value).digest('hex');}
function sql(statement){return execFileSync('docker',['exec','-i','supabase_db_room-management-system-backend','psql','-X','-A','-t','-q','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-c',statement],{encoding:'utf8',timeout:15000}).trim();}

async function actorFixture(client,label){
  const authUserId=randomUUID(),profileId=randomUUID(),sessionId=randomUUID();
  const email=`password-${randomUUID()}@test.invalid`;
  const user=await client.auth.admin.createUser({id:authUserId,email,email_confirm:true});assert(!user.error,`${label} auth fixture`);
  const displayName=`password ${label} ${profileId}`;
  const profile=await client.from('profiles').insert({id:profileId,auth_user_id:authUserId,display_name:displayName,display_name_normalized:displayName,login_id:`password-${profileId}`,login_id_normalized:`password-${profileId}`,login_sequence:0,role:'maid',status:'active',must_change_password:true});
  assert(!profile.error,`${label} profile fixture`);
  sql(`insert into auth.sessions(id,user_id) values('${sessionId}'::uuid,'${authUserId}'::uuid)`);
  return {authUserId,profileId,sessionId};
}

function addSession(actor){
  const sessionId=randomUUID();
  sql(`insert into auth.sessions(id,user_id) values('${sessionId}'::uuid,'${actor.authUserId}'::uuid)`);
  return {...actor,sessionId};
}

function args(actor,key,hash,claim){return {
  p_actor_profile_id:actor.profileId,p_auth_user_id:actor.authUserId,p_session_id:actor.sessionId,
  p_idempotency_key:key,p_request_hash:hash,p_claim_digest:claim
};}

export async function testPasswordChangeConcurrency(client){
  const same=await actorFixture(client,'same-key');
  const sameKey=`password-same-${randomUUID()}`;
  const sameHash=digest(`password-safe:${same.profileId}`);
  const sameRace=await Promise.all([
    client.rpc('prepare_password_change',args(same,sameKey,sameHash,digest(randomUUID()))),
    client.rpc('prepare_password_change',args(same,sameKey,sameHash,digest(randomUUID())))
  ]);
  assert(sameRace.every(result=>!result.error),`same-key race RPC failure: ${JSON.stringify(sameRace.map(r=>r.error?.message??null))}`);
  const sameStates=sameRace.map(result=>result.data.state).sort();
  assert(JSON.stringify(sameStates)===JSON.stringify(['busy','execute']),'same-key race has exactly one Auth mutation owner');
  assert(sql(`select count(*) from private.password_change_commands where actor_profile_id='${same.profileId}'::uuid`)==='1','same-key race creates one receipt');

  const different=await actorFixture(client,'different-key');
  const differentRace=await Promise.all([
    client.rpc('prepare_password_change',args(different,`password-a-${randomUUID()}`,digest(`a:${different.profileId}`),digest(randomUUID()))),
    client.rpc('prepare_password_change',args(different,`password-b-${randomUUID()}`,digest(`b:${different.profileId}`),digest(randomUUID())))
  ]);
  assert(differentRace.every(result=>!result.error),`different-key race RPC failure: ${JSON.stringify(differentRace.map(r=>r.error?.message??null))}`);
  const differentStates=differentRace.map(result=>result.data.state).sort();
  assert(JSON.stringify(differentStates)===JSON.stringify(['execute','other_in_progress']),'different keys for one actor serialize before Auth mutation');
  assert(sql(`select count(*) from private.password_change_commands where actor_profile_id='${different.profileId}'::uuid`)==='1','different-key race creates one receipt');

  const conflicting=await actorFixture(client,'conflicting-hash');
  const conflictingKey=`password-conflict-${randomUUID()}`;
  const conflictingRace=await Promise.all([
    client.rpc('prepare_password_change',args(conflicting,conflictingKey,digest('intent-a'),digest(randomUUID()))),
    client.rpc('prepare_password_change',args(conflicting,conflictingKey,digest('intent-b'),digest(randomUUID())))
  ]);
  assert(conflictingRace.filter(result=>!result.error&&result.data.state==='execute').length===1,'conflicting same-key race has one Auth mutation owner');
  assert(conflictingRace.filter(result=>/IDEMPOTENCY_KEY_REUSED/.test(result.error?.message??'')).length===1,'conflicting same-key race has one stable conflict loser');

  const left=await actorFixture(client,'actor-left');
  const right=await actorFixture(client,'actor-right');
  const sharedRawKey=`password-shared-${randomUUID()}`;
  const isolated=await Promise.all([
    client.rpc('prepare_password_change',args(left,sharedRawKey,digest(`left:${left.profileId}`),digest(randomUUID()))),
    client.rpc('prepare_password_change',args(right,sharedRawKey,digest(`right:${right.profileId}`),digest(randomUUID())))
  ]);
  assert(isolated.every(result=>!result.error&&result.data.state==='execute'),'same raw key is isolated by actor scope');

  const crossSession=await actorFixture(client,'cross-session');
  const secondSession=addSession(crossSession);
  const crossSessionKey=`password-cross-session-${randomUUID()}`;
  const crossSessionHash=digest(`cross-session:${crossSession.profileId}`);
  const crossSessionRace=await Promise.all([
    client.rpc('prepare_password_change',args(crossSession,crossSessionKey,crossSessionHash,digest(randomUUID()))),
    client.rpc('prepare_password_change',args(secondSession,crossSessionKey,crossSessionHash,digest(randomUUID())))
  ]);
  assert(crossSessionRace.filter(result=>!result.error&&result.data.state==='execute').length===1,'cross-session race has one receipt owner');
  assert(crossSessionRace.filter(result=>/PASSWORD_CHANGE_SESSION_MISMATCH/.test(result.error?.message??'')).length===1,'another live session cannot take over the receipt');
  assert(sql(`select count(*) from private.password_change_commands where actor_profile_id='${crossSession.profileId}'::uuid`)==='1','cross-session race creates one receipt');

  console.log('Password-change concurrency passed: same-key one owner, different-key actor serialization, conflict stability, cross-actor isolation, cross-session takeover denial.');
}
