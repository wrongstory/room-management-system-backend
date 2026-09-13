import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const sql = value => execFileSync('docker', [
  'exec', '-i', 'supabase_db_room-management-system-backend', 'psql', '-X', '-A', '-t', '-q',
  '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', value,
], { encoding: 'utf8', timeout: 15_000 }).trim();
async function sqlAsync(value) {
  try {
    const { stdout } = await execFileAsync('docker', [
      'exec', '-i', 'supabase_db_room-management-system-backend', 'psql', '-X', '-A', '-t', '-q',
      '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', value,
    ], { encoding: 'utf8', timeout: 15_000 });
    return { value: stdout.trim(), error: '' };
  } catch (error) { return { value: '', error: `${error.stderr ?? error.message}` }; }
}

const targetDigest = 'a'.repeat(64);

export async function testRoomPinSheetFullResyncConcurrency(client, actorProfileId) {
  const sessionId = randomUUID();
  const actorUserId = sql(`select auth_user_id from public.profiles where id='${actorProfileId}'::uuid`);
  sql(`begin;
    insert into auth.sessions(id,user_id) values('${sessionId}'::uuid,'${actorUserId}'::uuid);
    update private.room_pin_sheet_full_resync_runs set status='superseded',completed_at=clock_timestamp()
      where status in ('pending','failed') and provider_write_started_at is null;
    update private.room_pin_sheet_sync_worker_state set status='idle',claim_id=null,lease_expires_at=null,
      blocked_reason_code=null where singleton=true;
    commit;`);
  const fence = Number(sql('select lease_fence from private.room_pin_sheet_sync_worker_state where singleton=true'));
  const identicalKey = `full-same-${randomUUID()}`;
  const identicalArgs = {
    p_actor_profile_id: actorProfileId, p_session_id: sessionId, p_expected_fence: fence,
    p_expected_environment: 'local', p_expected_project_ref: 'local',
    p_expected_target_identity_digest: targetDigest, p_idempotency_key: identicalKey,
    p_request_hash: '1'.repeat(64),
  };
  const identical = await Promise.all([
    client.rpc('request_room_pin_sheet_full_resync', identicalArgs),
    client.rpc('request_room_pin_sheet_full_resync', identicalArgs),
  ]);
  assert(identical.every(result => !result.error), `same-key full requests converge: ${JSON.stringify(identical)}`);
  assert(JSON.stringify(identical[0].data) === JSON.stringify(identical[1].data), 'same-key full requests replay one response');
  assert(sql(`select count(*) from private.room_pin_sheet_full_resync_runs where actor_profile_id='${actorProfileId}'::uuid and idempotency_key='${identicalKey}'`) === '1', 'same-key full requests create one run');

  sql(`update private.room_pin_sheet_full_resync_runs set status='superseded',completed_at=clock_timestamp()
    where actor_profile_id='${actorProfileId}'::uuid and idempotency_key='${identicalKey}'`);
  const outboxFixture = sql("select id::text||'|'||room_id::text||'|'||pin_version::text from private.room_pin_sheet_sync_outbox where status='pending' order by created_at,id limit 1").split('|');
  assert(outboxFixture.length === 3, 'full-resync concurrency reuses the verified PIN outbox fixture');
  const [outboxId, roomId, rawPinVersion] = outboxFixture;
  const pinVersion = Number(rawPinVersion);
  assert(roomId && Number.isSafeInteger(pinVersion) && pinVersion > 0, 'full-resync concurrency fixture is bounded');
  const differentKeys = [`full-a-${randomUUID()}`, `full-b-${randomUUID()}`];
  const different = await Promise.all(differentKeys.map((key, index) => client.rpc(
    'request_room_pin_sheet_full_resync',
    { ...identicalArgs, p_idempotency_key: key, p_request_hash: String(index + 2).repeat(64) },
  )));
  assert(different.every(result => result.error?.code !== '40P01'), 'different-key full requests have no deadlock');
  assert(different.filter(result => !result.error).length === 1, `different-key full requests have one winner: ${JSON.stringify(different)}`);
  assert(different.filter(result => result.error?.message === 'ROOM_PIN_SHEET_FULL_RESYNC_PENDING').length === 1, 'different-key loser gets the bounded active-run conflict');
  assert(sql(`select count(*) from private.room_pin_sheet_full_resync_runs where actor_profile_id='${actorProfileId}'::uuid and idempotency_key in ('${differentKeys[0]}','${differentKeys[1]}')`) === '1', 'different-key race keeps one logical active run');

  const fullClaim = randomUUID();
  const incrementalClaim = randomUUID();
  const claimRace = await Promise.all([
    sqlAsync(`select public.claim_room_pin_sheet_full_resync('${fullClaim}'::uuid,'local','local','${targetDigest}')::text`),
    sqlAsync(`select public.claim_room_pin_sheet_sync('${incrementalClaim}'::uuid,10,'local','local')::text`),
  ]);
  assert(claimRace.every(result => !/40P01|deadlock detected/i.test(result.error)), 'full versus incremental claim has no deadlock');
  assert(claimRace.every(result => !result.error), `full versus incremental claim has no generic failure: ${JSON.stringify(claimRace)}`);
  const [fullResult, incrementalResult] = claimRace.map(result => JSON.parse(result.value));
  const fullWon = fullResult.status === 'claimed';
  const incrementalWon = incrementalResult.items?.some(item => item.outboxId === outboxId) === true;
  assert(Number(fullWon) + Number(incrementalWon) === 1, `global fence grants one claim: ${JSON.stringify([fullResult, incrementalResult])}`);
  assert([fullResult, incrementalResult].filter(result => result.status === 'busy').length === 1, 'global fence returns one bounded busy loser');
  if (fullWon) {
    const permit = await sqlAsync(`select public.authorize_room_pin_sheet_full_resync_write('${fullResult.operation.runId}'::uuid,'${fullClaim}'::uuid,${fullResult.leaseFence})::text`);
    assert(!permit.error && JSON.parse(permit.value).status === 'authorized', 'full winner obtains the sole provider permit');
    const settled = await sqlAsync(`select public.settle_room_pin_sheet_full_resync('${fullResult.operation.runId}'::uuid,'${fullClaim}'::uuid,${fullResult.leaseFence},'succeeded',null)::text`);
    assert(!settled.error && JSON.parse(settled.value).status === 'succeeded', 'full winner settles its provider success');
    const heartbeat = await sqlAsync(`select public.record_room_pin_sheet_sync_heartbeat('${fullClaim}'::uuid,${fullResult.leaseFence},'succeeded',1,1,0,0,0,0,null)::text`);
    assert(!heartbeat.error, 'full winner releases the singleton with a durable heartbeat');
  } else {
    const permit = await sqlAsync(`select public.authorize_room_pin_sheet_write('${outboxId}'::uuid,'${incrementalClaim}'::uuid,${incrementalResult.leaseFence},${pinVersion})::text`);
    assert(!permit.error && JSON.parse(permit.value).status === 'authorized', 'incremental winner obtains the sole provider permit');
    const settled = await sqlAsync(`select public.settle_room_pin_sheet_sync('${outboxId}'::uuid,'${incrementalClaim}'::uuid,${incrementalResult.leaseFence},${pinVersion},'succeeded',null)::text`);
    assert(!settled.error && JSON.parse(settled.value).status === 'succeeded', 'incremental winner settles its provider success');
    const heartbeat = await sqlAsync(`select public.record_room_pin_sheet_sync_heartbeat('${incrementalClaim}'::uuid,${incrementalResult.leaseFence},'succeeded',1,1,0,0,0,0,null)::text`);
    assert(!heartbeat.error, 'incremental winner releases the singleton with a durable heartbeat');
    const followupFullClaim = randomUUID();
    const followupClaim = await sqlAsync(`select public.claim_room_pin_sheet_full_resync('${followupFullClaim}'::uuid,'local','local','${targetDigest}')::text`);
    assert(!followupClaim.error && JSON.parse(followupClaim.value).status === 'claimed', 'pending full run is reclaimed after the incremental winner');
    const followup = JSON.parse(followupClaim.value);
    const followupPermit = await sqlAsync(`select public.authorize_room_pin_sheet_full_resync_write('${followup.operation.runId}'::uuid,'${followupFullClaim}'::uuid,${followup.leaseFence})::text`);
    assert(!followupPermit.error && JSON.parse(followupPermit.value).status === 'authorized', 'pending full run obtains its later sequential permit');
    const followupSettle = await sqlAsync(`select public.settle_room_pin_sheet_full_resync('${followup.operation.runId}'::uuid,'${followupFullClaim}'::uuid,${followup.leaseFence},'succeeded',null)::text`);
    assert(!followupSettle.error && JSON.parse(followupSettle.value).status === 'succeeded', 'pending full run settles after the incremental winner');
    const followupHeartbeat = await sqlAsync(`select public.record_room_pin_sheet_sync_heartbeat('${followupFullClaim}'::uuid,${followup.leaseFence},'succeeded',1,1,0,0,0,0,null)::text`);
    assert(!followupHeartbeat.error, 'sequential full run releases the singleton');
  }
  assert(sql("select status from private.room_pin_sheet_sync_worker_state where singleton=true") === 'idle', 'the winning lifecycle returns the singleton to idle');
  assert(sql("select count(*) from private.room_pin_sheet_full_resync_runs where status in ('pending','processing','failed')") === '0', 'no active full-resync run is orphaned');
  assert(sql("select count(*) from private.room_pin_sheet_sync_outbox where status='processing'") === '0', 'no incremental processing row is orphaned');
  console.log('Room PIN Sheet full-resync concurrency passed: same-key=1/2 replay, different-key=1/2 active, full-vs-incremental=1 concurrent permit with sequential drain, 40P01/generic errors=0.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  throw new Error('Run through npm run db:test:concurrency so the shared admin fixture is available.');
}
