import { execFile, execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { roomPinConcurrencyTargetIdentity } from './test-room-pin-concurrency.mjs';

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

async function holdWorkerStateLock() {
  const process = spawn('docker', [
    'exec', '-i', 'supabase_db_room-management-system-backend', 'psql', '-X', '-A', '-t', '-q',
    '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  let ready = false;
  let output = '';
  let stderr = '';
  const exited = new Promise(resolve => process.once('close', resolve));
  process.stderr.on('data', chunk => { stderr += chunk.toString(); });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      process.kill();
      reject(new Error('PIN Sheet worker-state lock barrier timed out'));
    }, 10_000);
    process.once('error', () => {
      clearTimeout(timeout);
      reject(new Error('PIN Sheet worker-state lock process failed'));
    });
    process.once('close', () => {
      if (!ready) {
        clearTimeout(timeout);
        reject(new Error('PIN Sheet worker-state lock setup failed'));
      }
    });
    process.stdout.on('data', chunk => {
      output += chunk.toString();
      if (!ready && output.includes('WORKER_STATE_LOCK_READY')) {
        ready = true;
        output = '';
        clearTimeout(timeout);
        resolve();
      }
    });
    process.stdin.write(
      "begin; set local statement_timeout='40s'; set local idle_in_transaction_session_timeout='45s'; " +
      'select singleton from private.room_pin_sheet_sync_worker_state where singleton=true for update;\n' +
      '\\echo WORKER_STATE_LOCK_READY\n',
    );
  });
  let releasePromise;
  return () => {
    if (!releasePromise) {
      releasePromise = (async () => {
        process.stdin.end('commit;\n\\q\n');
        const exitCode = await exited;
        if (exitCode !== 0) {
          const reason = stderr.split(/\r?\n/).find(line => line.trim()) ?? 'unknown';
          throw new Error(`PIN Sheet worker-state lock transaction failed: ${reason}`);
        }
      })();
    }
    return releasePromise;
  };
}

async function waitForWorkerStateLock(applicationName) {
  assert(/^[a-z0-9-]{1,63}$/.test(applicationName), 'source-controlled PIN Sheet barrier name');
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const waiting = sql(
      `select exists(select 1 from pg_stat_activity where application_name='${applicationName}' ` +
      "and state='active' and wait_event_type='Lock')",
    );
    if (waiting === 't') return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${applicationName} did not reach the worker-state lock barrier`);
}

async function runOrderedClaimRace(firstKind, fullSql, incrementalSql) {
  const suffix = randomUUID().slice(0, 8);
  const applicationNames = {
    full: `pin-sheet-full-${firstKind}-${suffix}`,
    incremental: `pin-sheet-incremental-${firstKind}-${suffix}`,
  };
  const invocations = {
    full: () => sqlAsync(`set application_name='${applicationNames.full}'; ${fullSql}`),
    incremental: () => sqlAsync(`set application_name='${applicationNames.incremental}'; ${incrementalSql}`),
  };
  const secondKind = firstKind === 'full' ? 'incremental' : 'full';
  const release = await holdWorkerStateLock();
  const pending = {};
  try {
    pending[firstKind] = invocations[firstKind]();
    await waitForWorkerStateLock(applicationNames[firstKind]);
    pending[secondKind] = invocations[secondKind]();
    await waitForWorkerStateLock(applicationNames[secondKind]);
    await release();
    const [full, incremental] = await Promise.all([pending.full, pending.incremental]);
    return { full, incremental };
  } catch (error) {
    await release();
    await Promise.allSettled(Object.values(pending));
    throw error;
  }
}

const targetDigest = 'a'.repeat(64);

export async function testRoomPinSheetFullResyncConcurrency(client, actorProfileId) {
  const { environment, projectRef } = roomPinConcurrencyTargetIdentity;
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
    p_expected_environment: environment, p_expected_project_ref: projectRef,
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
  assert(sql(`select (id=recovery_root_run_id)::text from private.room_pin_sheet_full_resync_runs where actor_profile_id='${actorProfileId}'::uuid and idempotency_key='${identicalKey}'`) === 'true', 'ordinary concurrent request winner self-roots exactly once');

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

  const fullFirstClaim = randomUUID();
  const fullFirstIncrementalClaim = randomUUID();
  const fullFirstRace = await runOrderedClaimRace(
    'full',
    `select public.claim_room_pin_sheet_full_resync('${fullFirstClaim}'::uuid,'${environment}','${projectRef}','${targetDigest}')::text`,
    `select public.claim_room_pin_sheet_sync('${fullFirstIncrementalClaim}'::uuid,10,'${environment}','${projectRef}')::text`,
  );
  assert(!/40P01|deadlock detected/i.test(fullFirstRace.full.error + fullFirstRace.incremental.error), 'full-first claim barrier has no deadlock');
  assert(!fullFirstRace.full.error && !fullFirstRace.incremental.error, `full-first claim barrier has no generic failure: ${JSON.stringify(fullFirstRace)}`);
  const fullFirstResult = JSON.parse(fullFirstRace.full.value);
  const fullFirstIncrementalResult = JSON.parse(fullFirstRace.incremental.value);
  assert(fullFirstResult.status === 'claimed', `full-first barrier grants the full claim: ${JSON.stringify(fullFirstResult)}`);
  assert(fullFirstIncrementalResult.status === 'busy' && fullFirstIncrementalResult.items.length === 0, 'full-first barrier returns one bounded incremental busy loser');
  const fullFirstPermit = await sqlAsync(`select public.authorize_room_pin_sheet_full_resync_write('${fullFirstResult.operation.runId}'::uuid,'${fullFirstClaim}'::uuid,${fullFirstResult.leaseFence})::text`);
  assert(!fullFirstPermit.error && JSON.parse(fullFirstPermit.value).status === 'authorized', 'full-first winner obtains the sole provider permit');
  const fullFirstSettle = await sqlAsync(`select public.settle_room_pin_sheet_full_resync('${fullFirstResult.operation.runId}'::uuid,'${fullFirstClaim}'::uuid,${fullFirstResult.leaseFence},'succeeded',null)::text`);
  assert(!fullFirstSettle.error && JSON.parse(fullFirstSettle.value).status === 'succeeded', 'full-first winner settles its provider success');
  const fullFirstHeartbeat = await sqlAsync(`select public.record_room_pin_sheet_sync_heartbeat('${fullFirstClaim}'::uuid,${fullFirstResult.leaseFence},'succeeded',1,1,0,0,0,0,null)::text`);
  assert(!fullFirstHeartbeat.error, 'full-first winner releases the singleton with a durable heartbeat');

  sql(`update private.room_pin_sheet_sync_outbox set status='pending',completed_at=null,claim_id=null,
    claimed_at=null,claim_expires_at=null,lease_fence=null,provider_write_started_at=null,
    retry_count=0,next_attempt_at=clock_timestamp(),last_error_code=null where id='${outboxId}'::uuid`);
  const incrementalFirstFence = Number(sql('select lease_fence from private.room_pin_sheet_sync_worker_state where singleton=true'));
  const incrementalFirstKey = `full-incremental-first-${randomUUID()}`;
  const incrementalFirstRequest = await client.rpc('request_room_pin_sheet_full_resync', {
    ...identicalArgs,
    p_expected_fence: incrementalFirstFence,
    p_idempotency_key: incrementalFirstKey,
    p_request_hash: '6'.repeat(64),
  });
  assert(!incrementalFirstRequest.error, `incremental-first full run fixture is accepted: ${JSON.stringify(incrementalFirstRequest)}`);
  const incrementalFirstFullClaim = randomUUID();
  const incrementalFirstClaim = randomUUID();
  const incrementalFirstRace = await runOrderedClaimRace(
    'incremental',
    `select public.claim_room_pin_sheet_full_resync('${incrementalFirstFullClaim}'::uuid,'${environment}','${projectRef}','${targetDigest}')::text`,
    `select public.claim_room_pin_sheet_sync('${incrementalFirstClaim}'::uuid,10,'${environment}','${projectRef}')::text`,
  );
  assert(!/40P01|deadlock detected/i.test(incrementalFirstRace.full.error + incrementalFirstRace.incremental.error), 'incremental-first claim barrier has no deadlock');
  assert(!incrementalFirstRace.full.error && !incrementalFirstRace.incremental.error, `incremental-first claim barrier has no generic failure: ${JSON.stringify(incrementalFirstRace)}`);
  const incrementalFirstFullResult = JSON.parse(incrementalFirstRace.full.value);
  const incrementalFirstResult = JSON.parse(incrementalFirstRace.incremental.value);
  assert(incrementalFirstResult.status === 'claimed' && incrementalFirstResult.items.some(item => item.outboxId === outboxId), `incremental-first barrier grants the incremental claim: ${JSON.stringify(incrementalFirstResult)}`);
  assert(incrementalFirstFullResult.status === 'busy', 'incremental-first barrier returns one bounded full busy loser');
  const incrementalFirstPermit = await sqlAsync(`select public.authorize_room_pin_sheet_write('${outboxId}'::uuid,'${incrementalFirstClaim}'::uuid,${incrementalFirstResult.leaseFence},${pinVersion})::text`);
  assert(!incrementalFirstPermit.error && JSON.parse(incrementalFirstPermit.value).status === 'authorized', 'incremental-first winner obtains the sole provider permit');
  const incrementalFirstSettle = await sqlAsync(`select public.settle_room_pin_sheet_sync('${outboxId}'::uuid,'${incrementalFirstClaim}'::uuid,${incrementalFirstResult.leaseFence},${pinVersion},'succeeded',null)::text`);
  assert(!incrementalFirstSettle.error && JSON.parse(incrementalFirstSettle.value).status === 'succeeded', 'incremental-first winner settles its provider success');
  const incrementalFirstHeartbeat = await sqlAsync(`select public.record_room_pin_sheet_sync_heartbeat('${incrementalFirstClaim}'::uuid,${incrementalFirstResult.leaseFence},'succeeded',1,1,0,0,0,0,null)::text`);
  assert(!incrementalFirstHeartbeat.error, 'incremental-first winner releases the singleton with a durable heartbeat');
  const followupFullClaim = randomUUID();
  const followupClaim = await sqlAsync(`select public.claim_room_pin_sheet_full_resync('${followupFullClaim}'::uuid,'${environment}','${projectRef}','${targetDigest}')::text`);
  assert(!followupClaim.error && JSON.parse(followupClaim.value).status === 'claimed', 'pending full run is reclaimed after the incremental-first winner');
  const followup = JSON.parse(followupClaim.value);
  const followupPermit = await sqlAsync(`select public.authorize_room_pin_sheet_full_resync_write('${followup.operation.runId}'::uuid,'${followupFullClaim}'::uuid,${followup.leaseFence})::text`);
  assert(!followupPermit.error && JSON.parse(followupPermit.value).status === 'authorized', 'pending full run obtains its later sequential permit');
  const followupSettle = await sqlAsync(`select public.settle_room_pin_sheet_full_resync('${followup.operation.runId}'::uuid,'${followupFullClaim}'::uuid,${followup.leaseFence},'succeeded',null)::text`);
  assert(!followupSettle.error && JSON.parse(followupSettle.value).status === 'succeeded', 'pending full run settles after the incremental-first winner');
  const followupHeartbeat = await sqlAsync(`select public.record_room_pin_sheet_sync_heartbeat('${followupFullClaim}'::uuid,${followup.leaseFence},'succeeded',1,1,0,0,0,0,null)::text`);
  assert(!followupHeartbeat.error, 'sequential full run releases the singleton');

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
  const exhaustionClaim = JSON.parse(sql(`select public.claim_room_pin_sheet_full_resync('${exhaustionClaimId}'::uuid,'${environment}','${projectRef}','${targetDigest}')::text`));
  assert(exhaustionClaim.status === 'claimed', 'eighth retry fixture claims the singleton');
  const exhaustedRunId = exhaustionClaim.operation.runId;
  const blockedFence = exhaustionClaim.leaseFence;
  const exhausted = JSON.parse(sql(`select public.settle_room_pin_sheet_full_resync('${exhaustedRunId}'::uuid,'${exhaustionClaimId}'::uuid,${blockedFence},'retryable','PROVIDER_UNAVAILABLE')::text`));
  assert(exhausted.status === 'operator_blocked', 'eighth retry enters operator-blocked');
  assert(sql(`select lease_fence from private.room_pin_sheet_full_resync_runs where id='${exhaustedRunId}'::uuid`) === String(blockedFence), 'retry exhaustion preserves the recovery fence');

  const recoveryKeys = [`full-recovery-a-${randomUUID()}`, `full-recovery-b-${randomUUID()}`];
  const recoveryRequests = await Promise.all(recoveryKeys.map((key, index) => client.rpc(
    'request_room_pin_sheet_full_resync',
    {
      ...identicalArgs,
      p_expected_fence: blockedFence,
      p_idempotency_key: key,
      p_request_hash: String(index + 8).repeat(64),
    },
  )));
  assert(recoveryRequests.every(result => result.error?.code !== '40P01'), 'same-root recovery requests have no deadlock');
  assert(recoveryRequests.filter(result => !result.error).length === 1, `same-root recovery requests have one winner: ${JSON.stringify(recoveryRequests)}`);
  assert(recoveryRequests.filter(result => result.error?.message === 'ROOM_PIN_SHEET_FULL_RESYNC_PENDING').length === 1, 'same-root recovery request loser gets the bounded active-run conflict');
  const recoveryKey = recoveryKeys[recoveryRequests.findIndex(result => !result.error)];
  const recoveryRunId = sql(`select id from private.room_pin_sheet_full_resync_runs
    where actor_profile_id='${actorProfileId}'::uuid and idempotency_key='${recoveryKey}'`);
  assert(sql(`select (recovery_root_run_id='${exhaustedRunId}'::uuid)::text from private.room_pin_sheet_full_resync_runs where id='${recoveryRunId}'::uuid`) === 'true', 'same-root request winner inherits the exhausted root exactly');
  const recoveryClaimIds = [randomUUID(), randomUUID()];
  const recoveryClaims = await Promise.all(recoveryClaimIds.map(claimId => sqlAsync(
    `select public.claim_room_pin_sheet_full_resync('${claimId}'::uuid,'${environment}','${projectRef}','${targetDigest}')::text`,
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
  assert(sql(`select (id=recovery_root_run_id)::text from private.room_pin_sheet_full_resync_runs where id='${mismatchRunId}'::uuid`) === 'true', 'target-drift source run retains its self root');
  const mismatchFullClaimId = randomUUID();
  const mismatchIncrementalClaimId = randomUUID();
  const mismatchClaims = await runOrderedClaimRace(
    'full',
    `select public.claim_room_pin_sheet_full_resync('${mismatchFullClaimId}'::uuid,'${environment}','${projectRef}','${targetDigest}')::text`,
    `select public.claim_room_pin_sheet_sync('${mismatchIncrementalClaimId}'::uuid,10,'mismatched-environment','${projectRef}')::text`,
  );
  assert(!/40P01|deadlock detected/i.test(mismatchClaims.full.error + mismatchClaims.incremental.error), 'full/incremental target-mismatch claims have no deadlock');
  assert(!mismatchClaims.full.error && !mismatchClaims.incremental.error, `full/incremental target-mismatch claims have no generic failure: ${JSON.stringify(mismatchClaims)}`);
  const mismatchResults = [mismatchClaims.full, mismatchClaims.incremental].map(result => JSON.parse(result.value));
  assert(mismatchResults.every(result => result.status === 'operator_blocked'), `target mismatch blocks full and incremental claimants: ${JSON.stringify(mismatchResults)}`);
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
  assert(sql(`select (recovery_root_run_id='${mismatchRunId}'::uuid)::text from private.room_pin_sheet_full_resync_runs where id='${mismatchRecoveryRunId}'::uuid`) === 'true', 'target recovery inherits the original mismatch root');
  const mismatchRecoveryClaimIds = [randomUUID(), randomUUID()];
  const mismatchRecoveryClaims = await Promise.all(mismatchRecoveryClaimIds.map(claimId => sqlAsync(
    `select public.claim_room_pin_sheet_full_resync('${claimId}'::uuid,'${environment}','${projectRef}','${targetDigest}')::text`,
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
  console.log('Room PIN Sheet full-resync concurrency passed: same-key replay=1 run, different-key active/recovery=1 winner, explicit full-first and incremental-first barriers each=1 winner + 1 busy loser, mismatch fail-closed=2 claimants, retry and target-drift recoveries each=1/2 claim and 1 provider permit, 40P01/generic errors=0.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  throw new Error('Run through npm run db:test:concurrency so the shared admin fixture is available.');
}
