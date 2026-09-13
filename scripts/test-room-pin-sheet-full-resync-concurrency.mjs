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

  const exhaustionFence = Number(sql('select lease_fence from private.room_pin_sheet_sync_worker_state where singleton=true'));
  const exhaustionKey = `full-exhaust-${randomUUID()}`;
  const exhaustionRequest = await client.rpc('request_room_pin_sheet_full_resync', {
    ...identicalArgs,
    p_expected_fence: exhaustionFence,
    p_idempotency_key: exhaustionKey,
    p_request_hash: '7'.repeat(64),
  });
  assert(!exhaustionRequest.error, `retry-exhaustion concurrency fixture is accepted: ${JSON.stringify(exhaustionRequest)}`);
  sql(`update private.room_pin_sheet_full_resync_runs set retry_count=7
    where actor_profile_id='${actorProfileId}'::uuid and idempotency_key='${exhaustionKey}'`);
  const exhaustionClaimId = randomUUID();
  const exhaustionClaim = JSON.parse(sql(`select public.claim_room_pin_sheet_full_resync('${exhaustionClaimId}'::uuid,'local','local','${targetDigest}')::text`));
  assert(exhaustionClaim.status === 'claimed', 'eighth retry fixture claims the singleton');
  const exhaustedRunId = exhaustionClaim.operation.runId;
  const blockedFence = exhaustionClaim.leaseFence;
  const exhausted = JSON.parse(sql(`select public.settle_room_pin_sheet_full_resync('${exhaustedRunId}'::uuid,'${exhaustionClaimId}'::uuid,${blockedFence},'retryable','PROVIDER_UNAVAILABLE')::text`));
  assert(exhausted.status === 'operator_blocked', 'eighth retry enters operator-blocked');
  assert(sql(`select lease_fence from private.room_pin_sheet_full_resync_runs where id='${exhaustedRunId}'::uuid`) === String(blockedFence), 'retry exhaustion preserves the recovery fence');

  const recoveryKey = `full-recovery-${randomUUID()}`;
  const recoveryRequest = await client.rpc('request_room_pin_sheet_full_resync', {
    ...identicalArgs,
    p_expected_fence: blockedFence,
    p_idempotency_key: recoveryKey,
    p_request_hash: '8'.repeat(64),
  });
  assert(!recoveryRequest.error, `fenced recovery request is accepted: ${JSON.stringify(recoveryRequest)}`);
  const recoveryRunId = sql(`select id from private.room_pin_sheet_full_resync_runs
    where actor_profile_id='${actorProfileId}'::uuid and idempotency_key='${recoveryKey}'`);
  const recoveryClaimIds = [randomUUID(), randomUUID()];
  const recoveryClaims = await Promise.all(recoveryClaimIds.map(claimId => sqlAsync(
    `select public.claim_room_pin_sheet_full_resync('${claimId}'::uuid,'local','local','${targetDigest}')::text`,
  )));
  assert(recoveryClaims.every(result => !/40P01|deadlock detected/i.test(result.error)), 'concurrent recovery claims have no deadlock');
  assert(recoveryClaims.every(result => !result.error), `concurrent recovery claims have no generic failure: ${JSON.stringify(recoveryClaims)}`);
  const recoveryResults = recoveryClaims.map(result => JSON.parse(result.value));
  assert(recoveryResults.filter(result => result.status === 'claimed').length === 1, `concurrent recovery has one claim winner: ${JSON.stringify(recoveryResults)}`);
  assert(recoveryResults.filter(result => result.status === 'busy').length === 1, 'concurrent recovery has one bounded busy loser');
  const recoveryPermits = await Promise.all(recoveryClaimIds.map(claimId => sqlAsync(
    `select public.authorize_room_pin_sheet_full_resync_write('${recoveryRunId}'::uuid,'${claimId}'::uuid,${recoveryResults[0].leaseFence})::text`,
  )));
  const authorizedPermits = recoveryPermits.filter(result => !result.error && JSON.parse(result.value).status === 'authorized');
  assert(authorizedPermits.length === 1, `concurrent recovery grants at most one provider write permit: ${JSON.stringify(recoveryPermits)}`);
  const winnerIndex = recoveryResults.findIndex(result => result.status === 'claimed');
  const recoveryFence = recoveryResults[winnerIndex].leaseFence;
  const recoverySettle = await sqlAsync(`select public.settle_room_pin_sheet_full_resync('${recoveryRunId}'::uuid,'${recoveryClaimIds[winnerIndex]}'::uuid,${recoveryFence},'succeeded',null)::text`);
  assert(!recoverySettle.error && JSON.parse(recoverySettle.value).status === 'succeeded', 'the sole recovery permit settles successfully');
  const recoveryHeartbeat = await sqlAsync(`select public.record_room_pin_sheet_sync_heartbeat('${recoveryClaimIds[winnerIndex]}'::uuid,${recoveryFence},'succeeded',1,1,0,0,0,0,null)::text`);
  assert(!recoveryHeartbeat.error, 'successful concurrent recovery releases the singleton');
  assert(sql(`select status from private.room_pin_sheet_full_resync_runs where id='${exhaustedRunId}'::uuid`) === 'superseded', 'recovery supersedes exactly the exhausted run');

  const mismatchBaseFence = Number(sql('select lease_fence from private.room_pin_sheet_sync_worker_state where singleton=true'));
  const mismatchKey = `full-target-drift-${randomUUID()}`;
  const mismatchRequest = await client.rpc('request_room_pin_sheet_full_resync', {
    ...identicalArgs,
    p_expected_fence: mismatchBaseFence,
    p_expected_target_identity_digest: 'b'.repeat(64),
    p_idempotency_key: mismatchKey,
    p_request_hash: '9'.repeat(64),
  });
  assert(!mismatchRequest.error, `target-drift concurrency fixture is accepted: ${JSON.stringify(mismatchRequest)}`);
  const mismatchRunId = sql(`select id from private.room_pin_sheet_full_resync_runs
    where actor_profile_id='${actorProfileId}'::uuid and idempotency_key='${mismatchKey}'`);
  const mismatchClaimIds = [randomUUID(), randomUUID()];
  const mismatchClaims = await Promise.all(mismatchClaimIds.map(claimId => sqlAsync(
    `select public.claim_room_pin_sheet_full_resync('${claimId}'::uuid,'local','local','${targetDigest}')::text`,
  )));
  assert(mismatchClaims.every(result => !/40P01|deadlock detected/i.test(result.error)), 'concurrent target-mismatch claims have no deadlock');
  assert(mismatchClaims.every(result => !result.error), `concurrent target-mismatch claims have no generic failure: ${JSON.stringify(mismatchClaims)}`);
  const mismatchResults = mismatchClaims.map(result => JSON.parse(result.value));
  assert(mismatchResults.every(result => result.status === 'operator_blocked'), `target mismatch blocks every claimant: ${JSON.stringify(mismatchResults)}`);
  const mismatchFence = Number(sql(`select lease_fence from private.room_pin_sheet_full_resync_runs where id='${mismatchRunId}'::uuid`));
  assert(mismatchFence === mismatchBaseFence + 1, 'concurrent target mismatch advances the singleton fence exactly once');
  assert(sql('select lease_fence from private.room_pin_sheet_sync_worker_state where singleton=true') === String(mismatchFence), 'target-mismatched run and singleton retain one exact fence');

  const mismatchRecoveryKey = `full-target-recovery-${randomUUID()}`;
  const mismatchRecoveryArgs = {
    ...identicalArgs,
    p_expected_fence: mismatchFence,
    p_idempotency_key: mismatchRecoveryKey,
    p_request_hash: 'a'.repeat(64),
  };
  const mismatchRecoveryRequests = await Promise.all([
    client.rpc('request_room_pin_sheet_full_resync', mismatchRecoveryArgs),
    client.rpc('request_room_pin_sheet_full_resync', mismatchRecoveryArgs),
  ]);
  assert(mismatchRecoveryRequests.every(result => !result.error), `same-key target recovery replays without generic failure: ${JSON.stringify(mismatchRecoveryRequests)}`);
  assert(JSON.stringify(mismatchRecoveryRequests[0].data) === JSON.stringify(mismatchRecoveryRequests[1].data), 'same-key target recovery replays one response');
  assert(sql(`select count(*) from private.room_pin_sheet_full_resync_runs where actor_profile_id='${actorProfileId}'::uuid and idempotency_key='${mismatchRecoveryKey}'`) === '1', 'same-key target recovery creates one run');
  const mismatchRecoveryRunId = sql(`select id from private.room_pin_sheet_full_resync_runs
    where actor_profile_id='${actorProfileId}'::uuid and idempotency_key='${mismatchRecoveryKey}'`);
  assert(sql(`select reconciles_blocked_fence from private.room_pin_sheet_full_resync_runs where id='${mismatchRecoveryRunId}'::uuid`) === String(mismatchFence), 'target recovery binds the exact dedicated mismatch fence');
  const mismatchRecoveryClaimIds = [randomUUID(), randomUUID()];
  const mismatchRecoveryClaims = await Promise.all(mismatchRecoveryClaimIds.map(claimId => sqlAsync(
    `select public.claim_room_pin_sheet_full_resync('${claimId}'::uuid,'local','local','${targetDigest}')::text`,
  )));
  assert(mismatchRecoveryClaims.every(result => !/40P01|deadlock detected/i.test(result.error)), 'concurrent target recovery claims have no deadlock');
  assert(mismatchRecoveryClaims.every(result => !result.error), `concurrent target recovery claims have no generic failure: ${JSON.stringify(mismatchRecoveryClaims)}`);
  const mismatchRecoveryResults = mismatchRecoveryClaims.map(result => JSON.parse(result.value));
  assert(mismatchRecoveryResults.filter(result => result.status === 'claimed').length === 1, `concurrent target recovery has one claim winner: ${JSON.stringify(mismatchRecoveryResults)}`);
  assert(mismatchRecoveryResults.filter(result => result.status === 'busy').length === 1, 'concurrent target recovery has one bounded busy loser');
  const mismatchRecoveryPermits = await Promise.all(mismatchRecoveryClaimIds.map((claimId, index) => sqlAsync(
    `select public.authorize_room_pin_sheet_full_resync_write('${mismatchRecoveryRunId}'::uuid,'${claimId}'::uuid,${mismatchRecoveryResults[index].leaseFence})::text`,
  )));
  const mismatchAuthorizedPermits = mismatchRecoveryPermits.filter(result => !result.error && JSON.parse(result.value).status === 'authorized');
  assert(mismatchAuthorizedPermits.length === 1, `concurrent target recovery grants at most one provider write permit: ${JSON.stringify(mismatchRecoveryPermits)}`);
  const mismatchWinnerIndex = mismatchRecoveryResults.findIndex(result => result.status === 'claimed');
  const mismatchRecoveryFence = mismatchRecoveryResults[mismatchWinnerIndex].leaseFence;
  const mismatchRecoverySettle = await sqlAsync(`select public.settle_room_pin_sheet_full_resync('${mismatchRecoveryRunId}'::uuid,'${mismatchRecoveryClaimIds[mismatchWinnerIndex]}'::uuid,${mismatchRecoveryFence},'succeeded',null)::text`);
  assert(!mismatchRecoverySettle.error && JSON.parse(mismatchRecoverySettle.value).status === 'succeeded', 'the sole target recovery provider permit settles successfully');
  const mismatchRecoveryReplay = await sqlAsync(`select public.settle_room_pin_sheet_full_resync('${mismatchRecoveryRunId}'::uuid,'${mismatchRecoveryClaimIds[mismatchWinnerIndex]}'::uuid,${mismatchRecoveryFence},'succeeded',null)::text`);
  assert(!mismatchRecoveryReplay.error && JSON.parse(mismatchRecoveryReplay.value).status === 'succeeded', 'target recovery settle replay is idempotent');
  const mismatchRecoveryHeartbeat = await sqlAsync(`select public.record_room_pin_sheet_sync_heartbeat('${mismatchRecoveryClaimIds[mismatchWinnerIndex]}'::uuid,${mismatchRecoveryFence},'succeeded',1,1,0,0,0,0,null)::text`);
  assert(!mismatchRecoveryHeartbeat.error, 'successful concurrent target recovery releases the singleton');
  assert(sql(`select status from private.room_pin_sheet_full_resync_runs where id='${mismatchRunId}'::uuid`) === 'superseded', 'target recovery supersedes exactly the mismatched run');
  const recoveredStatus = JSON.parse(sql(`select public.get_room_pin_sheet_sync_status('${actorProfileId}'::uuid,'${sessionId}'::uuid)::text`));
  assert(recoveredStatus.pending === 0 && recoveredStatus.failed === 0, `target recovery clears pending and failed projections: ${JSON.stringify(recoveredStatus)}`);
  assert(recoveredStatus.operatorBlocked === false && recoveredStatus.lastErrorCode === null, `target recovery clears operator-blocked and last-error projections: ${JSON.stringify(recoveredStatus)}`);
  assert(sql("select status from private.room_pin_sheet_sync_worker_state where singleton=true") === 'idle', 'the winning lifecycle returns the singleton to idle');
  assert(sql("select count(*) from private.room_pin_sheet_full_resync_runs where status in ('pending','processing','failed')") === '0', 'no active full-resync run is orphaned');
  assert(sql("select count(*) from private.room_pin_sheet_full_resync_runs where status='operator_blocked'") === '0', 'no reconciled operator-blocked full run is orphaned');
  assert(sql("select count(*) from private.room_pin_sheet_sync_outbox where status='processing'") === '0', 'no incremental processing row is orphaned');
  console.log('Room PIN Sheet full-resync concurrency passed: same-key=1/2 replay, different-key=1/2 active, full-vs-incremental=1 permit, retry and target-drift recoveries each=1/2 claim and 1 provider permit, 40P01/generic errors=0.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  throw new Error('Run through npm run db:test:concurrency so the shared admin fixture is available.');
}
