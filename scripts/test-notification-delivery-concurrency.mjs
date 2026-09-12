import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const digest = value => createHash('sha256').update(value).digest('hex');
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

export async function testNotificationDeliveryConcurrency(client) {
  const authUserId = randomUUID(), profileId = randomUUID(), sessionId = randomUUID(), subscriptionId = randomUUID();
  const notificationId = randomUUID(), groupId = randomUUID(), outboxId = randomUUID();
  const user = await client.auth.admin.createUser({ id: authUserId, email: `delivery-${randomUUID()}@test.invalid`, email_confirm: true });
  assert(!user.error, 'notification delivery auth fixture');
  const profile = await client.from('profiles').insert({ id: profileId, auth_user_id: authUserId,
    display_name: `delivery ${profileId}`, display_name_normalized: `delivery ${profileId}`,
    login_id: `delivery-${profileId}`, login_id_normalized: `delivery-${profileId}`,
    login_sequence: 0, role: 'maid', status: 'active', must_change_password: false });
  assert(!profile.error, 'notification delivery profile fixture');
  sql(`insert into auth.sessions(id,user_id) values('${sessionId}'::uuid,'${authUserId}'::uuid)`);
  const registration = await client.rpc('register_web_push_subscription', {
    p_actor_profile_id: profileId, p_session_id: sessionId, p_proposed_subscription_id: subscriptionId,
    p_expected_subscription_id: null, p_expected_version: null,
    p_endpoint_digest: digest(`endpoint:${subscriptionId}`), p_session_digest: digest(`session:${sessionId}`),
    p_material_digest: digest(`material:${subscriptionId}`), p_expiration_at: null, p_key_version: 'v1',
    p_ciphertext_base64: Buffer.from('sealed').toString('base64'), p_nonce_base64: Buffer.from('n'.repeat(12)).toString('base64'),
    p_auth_tag_base64: Buffer.from('t'.repeat(16)).toString('base64'), p_idempotency_key: `delivery-${randomUUID()}`,
    p_request_hash: digest(`request:${subscriptionId}`),
  });
  assert(!registration.error, 'notification delivery subscription fixture');
  // Earlier concurrency suites intentionally leave typed outbox work behind. Drain only
  // currently due work through the public bounded claim contract so this test's first
  // fanout race is not displaced by unrelated fixtures.
  for (let pass = 0; pass < 100; pass++) {
    const due = Number(sql(`select
      (select count(*) from private.notification_delivery_jobs where status='pending')+
      (select count(*) from private.notification_delivery_targets
        where status in ('pending','retry','claimed') and next_attempt_at<=clock_timestamp()
          and (status<>'claimed' or lease_expires_at<=clock_timestamp()))`));
    if (due === 0) break;
    const drain = await sqlAsync(`select public.claim_notification_deliveries('${digest(`drain:${randomUUID()}`)}',10)::text`);
    assert(!drain.error, `bounded delivery fixture drain succeeds: ${drain.error}`);
    assert(pass < 99, 'bounded delivery fixture drain converges');
  }
  sql(`begin;
    select set_config('app.notification_writer_mode','typed_v1',true);
    insert into private.notification_groups(id,recipient_profile_id,group_family,scope_kind,scope_id,started_at,ends_at)
      values('${groupId}'::uuid,'${profileId}'::uuid,'cleaning_assignment_notified','room','${notificationId}'::uuid,clock_timestamp(),clock_timestamp()+interval '10 minutes');
    insert into public.notifications(id,recipient_profile_id,category,title,body,dedupe_key,contract_version,actor_profile_id,
      event_family,source_entity_kind,source_entity_id,deep_link_kind,deep_link_entity_id,notification_group_id,requires_action,occurred_at)
      values('${notificationId}'::uuid,'${profileId}'::uuid,'cleaning_assignment_notified','청소 배정','새 청소 배정이 등록되었습니다.',
      'delivery:${notificationId}',1,(select id from public.profiles where role='admin' limit 1),'assignment.commit_notified',
      'cleaning_assignment','${notificationId}','cleaningTarget','${notificationId}'::uuid,'${groupId}'::uuid,true,clock_timestamp());
    insert into private.notification_delivery_outbox(id,notification_id,event_family) values('${outboxId}'::uuid,'${notificationId}'::uuid,'assignment.commit_notified');
    commit;`);

  const claimA = digest(`claim-a:${randomUUID()}`), claimB = digest(`claim-b:${randomUUID()}`);
  const race = await Promise.all([
    sqlAsync(`select public.claim_notification_deliveries('${claimA}',10)::text`),
    sqlAsync(`select public.claim_notification_deliveries('${claimB}',10)::text`),
  ]);
  assert(race.every(result => !/40P01|deadlock detected/i.test(result.error)), 'parallel first fanout has no deadlock');
  const parsed = race.filter(result => result.value).map(result => JSON.parse(result.value));
  const ownItems = parsed.flatMap(value => value.items).filter(item => item.notificationId === notificationId);
  assert(ownItems.length === 1, `parallel claim owns target exactly once: ${JSON.stringify(race)}`);
  assert(sql(`select count(*) from private.notification_delivery_targets where outbox_id='${outboxId}'::uuid`) === '1', 'parallel fanout creates one target');
  assert(sql(`select count(*) from private.notification_delivery_attempts a join private.notification_delivery_targets t on t.id=a.target_id where t.outbox_id='${outboxId}'::uuid`) === '1', 'parallel claim creates one attempt');
  const targetId = ownItems[0].targetId;
  const winnerResult = race.find(result => result.value && JSON.parse(result.value).items.some(item => item.notificationId === notificationId));
  const winnerDigest = winnerResult === race[0] ? claimA : claimB;

  sql(`begin; select set_config('app.notification_delivery_writer_mode','typed_v1',true);
    update private.notification_delivery_targets set lease_expires_at=clock_timestamp()-interval '1 second' where id='${targetId}'::uuid; commit;`);
  const takeoverA = digest(`takeover-a:${randomUUID()}`), takeoverB = digest(`takeover-b:${randomUUID()}`);
  const takeovers = await Promise.all([
    sqlAsync(`select public.claim_notification_deliveries('${takeoverA}',10)::text`),
    sqlAsync(`select public.claim_notification_deliveries('${takeoverB}',10)::text`),
  ]);
  assert(takeovers.every(result => !/40P01|deadlock detected/i.test(result.error)), 'expired takeover has no deadlock');
  const takeoverParsed = takeovers.filter(result => result.value).map(result => JSON.parse(result.value));
  const ownTakeovers = takeoverParsed.flatMap(value => value.items).filter(item => item.notificationId === notificationId);
  assert(ownTakeovers.length === 1, `expired lease has one takeover winner: ${JSON.stringify(takeovers)}`);
  assert(sql(`select count(*) from private.notification_delivery_attempts where target_id='${targetId}'::uuid`) === '2', 'takeover appends one new attempt');
  const stale = await sqlAsync(`select public.settle_notification_delivery('${targetId}'::uuid,1,'${winnerDigest}','accepted',null,null)`);
  assert(/NOTIFICATION_DELIVERY_FENCE_CONFLICT|NOTIFICATION_DELIVERY_PERMIT_REQUIRED/.test(stale.error), 'stale first lease cannot settle after takeover');
  const takeoverWinner = takeovers.find(result => result.value && JSON.parse(result.value).items.some(item => item.notificationId === notificationId));
  const takeoverDigest = takeoverWinner === takeovers[0] ? takeoverA : takeoverB;
  const envelope = JSON.parse(sql(`select public.get_notification_delivery_envelope('${targetId}'::uuid,2,'${takeoverDigest}')::text`));
  assert(envelope.sendAllowed === true, 'takeover exact context remains available');
  const permit = JSON.parse(sql(`select public.permit_notification_delivery('${targetId}'::uuid,2,'${takeoverDigest}','${sessionId}'::uuid)::text`));
  assert(permit.sendAllowed === true && permit.payload.notificationId === notificationId, 'takeover permit preserves stable notification id');
  const settled = JSON.parse(sql(`select public.settle_notification_delivery('${targetId}'::uuid,2,'${takeoverDigest}','accepted',null,null)::text`));
  assert(settled.status === 'delivered', 'takeover winner settles terminally');

  const secondSessionId = randomUUID(), secondSubscriptionId = randomUUID();
  sql(`insert into auth.sessions(id,user_id) values('${secondSessionId}'::uuid,'${authUserId}'::uuid)`);
  const secondRegistration = await client.rpc('register_web_push_subscription', {
    p_actor_profile_id: profileId, p_session_id: secondSessionId, p_proposed_subscription_id: secondSubscriptionId,
    p_expected_subscription_id: null, p_expected_version: null,
    p_endpoint_digest: digest(`endpoint:${secondSubscriptionId}`), p_session_digest: digest(`session:${secondSessionId}`),
    p_material_digest: digest(`material:${secondSubscriptionId}`), p_expiration_at: null, p_key_version: 'v1',
    p_ciphertext_base64: Buffer.from('sealed-2').toString('base64'), p_nonce_base64: Buffer.from('o'.repeat(12)).toString('base64'),
    p_auth_tag_base64: Buffer.from('u'.repeat(16)).toString('base64'), p_idempotency_key: `delivery-${randomUUID()}`,
    p_request_hash: digest(`request:${secondSubscriptionId}`),
  });
  assert(!secondRegistration.error, 'second delivery subscription fixture');
  const blockedNotificationId = randomUUID(), blockedGroupId = randomUUID(), blockedOutboxId = randomUUID();
  sql(`begin;
    select set_config('app.notification_writer_mode','typed_v1',true);
    insert into private.notification_groups(id,recipient_profile_id,group_family,scope_kind,scope_id,started_at,ends_at)
      values('${blockedGroupId}'::uuid,'${profileId}'::uuid,'cleaning_assignment_notified','room','${blockedNotificationId}'::uuid,clock_timestamp(),clock_timestamp()+interval '10 minutes');
    insert into public.notifications(id,recipient_profile_id,category,title,body,dedupe_key,contract_version,actor_profile_id,
      event_family,source_entity_kind,source_entity_id,deep_link_kind,deep_link_entity_id,notification_group_id,requires_action,occurred_at)
      values('${blockedNotificationId}'::uuid,'${profileId}'::uuid,'cleaning_assignment_notified','청소 배정','새 청소 배정이 등록되었습니다.',
      'delivery:${blockedNotificationId}',1,(select id from public.profiles where role='admin' limit 1),'assignment.commit_notified',
      'cleaning_assignment','${blockedNotificationId}','cleaningTarget','${blockedNotificationId}'::uuid,'${blockedGroupId}'::uuid,true,clock_timestamp());
    insert into private.notification_delivery_outbox(id,notification_id,event_family)
      values('${blockedOutboxId}'::uuid,'${blockedNotificationId}'::uuid,'assignment.commit_notified');
    commit;`);
  const blockedDigest = digest(`blocked:${randomUUID()}`);
  const blockedClaim = JSON.parse(sql(`select public.claim_notification_deliveries('${blockedDigest}',10)::text`));
  const blockedItems = blockedClaim.items.filter(item => item.notificationId === blockedNotificationId);
  assert(blockedItems.length === 2, 'two-device fanout is claimed once');
  const blockedTargetId = blockedItems[0].targetId;
  const blockedEnvelope = JSON.parse(sql(`select public.get_notification_delivery_envelope('${blockedTargetId}'::uuid,1,'${blockedDigest}')::text`));
  assert(blockedEnvelope.sendAllowed === true, 'blocked fixture envelope available');
  const blockedPermit = JSON.parse(sql(`select public.permit_notification_delivery('${blockedTargetId}'::uuid,1,'${blockedDigest}','${sessionId}'::uuid)::text`));
  assert(blockedPermit.sendAllowed === true, 'blocked fixture permit succeeds');
  const blockedSettle = JSON.parse(sql(`select public.settle_notification_delivery('${blockedTargetId}'::uuid,1,'${blockedDigest}','provider_configuration_error','PROVIDER_CONFIGURATION_ERROR',null)::text`));
  assert(blockedSettle.status === 'operator_blocked', 'configuration failure blocks parent job');
  sql(`begin; select set_config('app.notification_delivery_writer_mode','typed_v1',true);
    update private.notification_delivery_targets set lease_expires_at=clock_timestamp()-interval '1 second'
      where outbox_id='${blockedOutboxId}'::uuid and status='claimed'; commit;`);
  const blockedClaims = await Promise.all(Array.from({ length: 4 }, () =>
    sqlAsync(`select public.claim_notification_deliveries('${digest(`blocked-claim:${randomUUID()}`)}',10)::text`)));
  assert(blockedClaims.every(result => !result.error), `blocked sibling claims have no 40P01/generic error: ${JSON.stringify(blockedClaims)}`);
  assert(blockedClaims.flatMap(result => JSON.parse(result.value).items)
    .filter(item => item.notificationId === blockedNotificationId).length === 0,
  'expired siblings remain unclaimed before explicit resume');
  assert(sql(`select count(*) from private.notification_delivery_attempts a join private.notification_delivery_targets t on t.id=a.target_id where t.outbox_id='${blockedOutboxId}'::uuid`) === '2',
    'blocked repeated claims append zero attempts');
  const resumes = await Promise.all(Array.from({ length: 4 }, () =>
    sqlAsync('select public.resume_blocked_notification_deliveries(10)::text')));
  assert(resumes.every(result => !result.error), `concurrent resumes have no 40P01/generic error: ${JSON.stringify(resumes)}`);
  assert(resumes.reduce((sum, result) => sum + Number(result.value), 0) === 2,
    `concurrent resume moves each sibling once: ${JSON.stringify(resumes)}`);
  const resumedA = digest(`resumed-a:${randomUUID()}`), resumedB = digest(`resumed-b:${randomUUID()}`);
  const resumedClaims = await Promise.all([
    sqlAsync(`select public.claim_notification_deliveries('${resumedA}',10)::text`),
    sqlAsync(`select public.claim_notification_deliveries('${resumedB}',10)::text`),
  ]);
  assert(resumedClaims.every(result => !result.error), `resumed sibling claims have no 40P01/generic error: ${JSON.stringify(resumedClaims)}`);
  assert(resumedClaims.flatMap(result => JSON.parse(result.value).items)
    .filter(item => item.notificationId === blockedNotificationId).length === 2,
  'explicit resume permits exactly two sibling claims');
  assert(sql(`select count(*) from private.notification_delivery_attempts a join private.notification_delivery_targets t on t.id=a.target_id where t.outbox_id='${blockedOutboxId}'::uuid`) === '4',
    'resume and parallel claims append one new attempt per sibling');
  const resumedDigests = [resumedA, resumedB];
  const resumedWorkloads = resumedClaims.flatMap((result, index) => JSON.parse(result.value).items
    .filter(item => item.notificationId === blockedNotificationId)
    .map(item => ({ ...item, claimDigest: resumedDigests[index] })));
  assert(new Set(resumedWorkloads.map(item => item.targetId)).size === 2,
    'resumed provider workload contains each target once');

  const firstBlockedWorkload = resumedWorkloads[0];
  const firstBlockedPermit = JSON.parse(sql(`select public.permit_notification_delivery(
    '${firstBlockedWorkload.targetId}'::uuid,${firstBlockedWorkload.leaseVersion},'${firstBlockedWorkload.claimDigest}','${sessionId}'::uuid
  )::text`));
  assert(firstBlockedPermit.sendAllowed === true, 'cross-race fixture permit succeeds');
  const firstBlockedSettle = JSON.parse(sql(`select public.settle_notification_delivery(
    '${firstBlockedWorkload.targetId}'::uuid,${firstBlockedWorkload.leaseVersion},'${firstBlockedWorkload.claimDigest}',
    'provider_configuration_error','PROVIDER_CONFIGURATION_ERROR',null
  )::text`));
  assert(firstBlockedSettle.status === 'operator_blocked', 'cross-race fixture blocks parent job');
  let staleFence = resumedWorkloads[1];
  sql(`begin; select set_config('app.notification_delivery_writer_mode','typed_v1',true);
    update private.notification_delivery_targets set lease_expires_at=clock_timestamp()-interval '1 second'
      where id='${staleFence.targetId}'::uuid; commit;`);

  // This fixture enters the crossed race at lease version 2, so six rounds
  // exercise every permitted takeover through the max-attempt version 8.
  const crossRaceRounds = 6;
  const providerAttemptIds = new Set();
  const providerWorkloadKeys = new Set();
  for (let round = 0; round < crossRaceRounds; round++) {
    const attemptsBefore = Number(sql(`select count(*) from private.notification_delivery_attempts a
      join private.notification_delivery_targets t on t.id=a.target_id
      where t.outbox_id='${blockedOutboxId}'::uuid`));
    const resumedEventsBefore = Number(sql(`select count(*) from private.notification_delivery_events
      where outbox_id='${blockedOutboxId}'::uuid and state='resumed'`));
    const permitsBefore = Number(sql(`select count(*) from private.notification_delivery_permits p
      join private.notification_delivery_attempts a on a.id=p.attempt_id
      join private.notification_delivery_targets t on t.id=a.target_id
      where t.outbox_id='${blockedOutboxId}'::uuid`));
    const crossClaimDigest = digest(`claim-resume-cross:${round}:${randomUUID()}`);
    const crossed = await Promise.all([
      sqlAsync(`select public.claim_notification_deliveries('${crossClaimDigest}',10)::text`),
      sqlAsync('select public.resume_blocked_notification_deliveries(10)::text'),
    ]);
    assert(crossed.every(result => !result.error),
      `claim/resume cross race ${round} has no 40P01 or generic error: ${JSON.stringify(crossed)}`);
    assert(Number(crossed[1].value) === 2,
      `claim/resume cross race ${round} resumes both targets exactly once: ${JSON.stringify(crossed)}`);

    let workloadDigest = crossClaimDigest;
    let workloads = JSON.parse(crossed[0].value).items
      .filter(item => item.notificationId === blockedNotificationId);
    assert(workloads.length === 0 || workloads.length === 2,
      `claim/resume cross race ${round} observes an atomic parent state: ${JSON.stringify(crossed)}`);
    if (workloads.length === 0) {
      workloadDigest = digest(`claim-resume-drain:${round}:${randomUUID()}`);
      const drained = await sqlAsync(`select public.claim_notification_deliveries('${workloadDigest}',10)::text`);
      assert(!drained.error, `claim/resume cross race ${round} post-race claim succeeds: ${drained.error}`);
      workloads = JSON.parse(drained.value).items
        .filter(item => item.notificationId === blockedNotificationId);
    }
    assert(workloads.length === 2 && new Set(workloads.map(item => item.targetId)).size === 2,
      `claim/resume cross race ${round} creates one provider workload per target`);
    for (const workload of workloads) {
      const workloadKey = `${workload.targetId}:${workload.leaseVersion}`;
      assert(!providerWorkloadKeys.has(workloadKey),
        `claim/resume cross race ${round} does not duplicate provider workload ${workloadKey}`);
      providerWorkloadKeys.add(workloadKey);
    }
    assert(Number(sql(`select count(*) from private.notification_delivery_attempts a
      join private.notification_delivery_targets t on t.id=a.target_id
      where t.outbox_id='${blockedOutboxId}'::uuid`)) === attemptsBefore + 2,
    `claim/resume cross race ${round} appends one attempt per target`);
    assert(Number(sql(`select count(*) from private.notification_delivery_events
      where outbox_id='${blockedOutboxId}'::uuid and state='resumed'`)) === resumedEventsBefore + 2,
    `claim/resume cross race ${round} appends one resume event per target`);
    assert(sql(`select count(*) from (
      select a.target_id,a.lease_version from private.notification_delivery_attempts a
      join private.notification_delivery_targets t on t.id=a.target_id
      where t.outbox_id='${blockedOutboxId}'::uuid
      group by a.target_id,a.lease_version having count(*)>1
    ) duplicate_attempts`) === '0', `claim/resume cross race ${round} has no duplicate attempts`);

    const staleSettle = await sqlAsync(`select public.settle_notification_delivery(
      '${staleFence.targetId}'::uuid,${staleFence.leaseVersion},'${staleFence.claimDigest}',
      'accepted',null,null
    )`);
    assert(/NOTIFICATION_DELIVERY_FENCE_CONFLICT/.test(staleSettle.error),
      `claim/resume cross race ${round} rejects the previous stale fence`);

    const blockingWorkload = workloads[round % workloads.length];
    const nextStaleWorkload = workloads[(round + 1) % workloads.length];
    const currentEnvelope = JSON.parse(sql(`select public.get_notification_delivery_envelope(
      '${blockingWorkload.targetId}'::uuid,${blockingWorkload.leaseVersion},'${workloadDigest}'
    )::text`));
    assert(currentEnvelope.sendAllowed === true,
      `claim/resume cross race ${round} exact workload remains sendable`);
    const currentPermit = JSON.parse(sql(`select public.permit_notification_delivery(
      '${blockingWorkload.targetId}'::uuid,${blockingWorkload.leaseVersion},'${workloadDigest}','${sessionId}'::uuid
    )::text`));
    assert(currentPermit.sendAllowed === true && !providerAttemptIds.has(currentPermit.attemptId),
      `claim/resume cross race ${round} authorizes one unique provider attempt`);
    providerAttemptIds.add(currentPermit.attemptId);
    assert(Number(sql(`select count(*) from private.notification_delivery_permits p
      join private.notification_delivery_attempts a on a.id=p.attempt_id
      join private.notification_delivery_targets t on t.id=a.target_id
      where t.outbox_id='${blockedOutboxId}'::uuid`)) === permitsBefore + 1,
    `claim/resume cross race ${round} appends one provider permit`);
    const currentSettle = JSON.parse(sql(`select public.settle_notification_delivery(
      '${blockingWorkload.targetId}'::uuid,${blockingWorkload.leaseVersion},'${workloadDigest}',
      'provider_configuration_error','PROVIDER_CONFIGURATION_ERROR',null
    )::text`));
    assert(currentSettle.status === 'operator_blocked',
      `claim/resume cross race ${round} re-blocks the parent job`);
    staleFence = { ...nextStaleWorkload, claimDigest: workloadDigest };
    sql(`begin; select set_config('app.notification_delivery_writer_mode','typed_v1',true);
      update private.notification_delivery_targets set lease_expires_at=clock_timestamp()-interval '1 second'
        where id='${staleFence.targetId}'::uuid; commit;`);
  }
  assert(providerWorkloadKeys.size === crossRaceRounds * 2,
    'claim/resume cross races create no duplicate provider workload');
  assert(providerAttemptIds.size === crossRaceRounds,
    'claim/resume cross races create one unique provider permit per round');
  console.log('Notification delivery concurrency passed: bounded backlog drain, first fanout/claim exactly once, fenced takeover, stale settle rejection, stable notification id, parent block/resume sibling fencing, repeated claim/resume cross-race duplicate-free workload.');
}
