import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const status = JSON.parse(execFileSync(
  npx,
  ['supabase', 'status', '--output', 'json'],
  {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'inherit']
  }
));
const client = createClient(status.API_URL, status.SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const loginGlobalRateLimitKey = createHash('sha256')
  .update(`edge-login-global-concurrency-${randomUUID()}`)
  .digest('hex');
const loginClientRateLimitKey = createHash('sha256')
  .update(`edge-login-client-concurrency-${randomUUID()}`)
  .digest('hex');
const loginRateLimitKey = createHash('sha256')
  .update(`edge-login-concurrency-${randomUUID()}`)
  .digest('hex');
const loginRateLimitResults = await Promise.all(Array.from({ length: 20 }, () => (
  client.rpc('consume_login_rate_limits', {
    p_client_key_hash: loginClientRateLimitKey,
    p_login_key_hash: loginRateLimitKey,
    p_global_key_hash: loginGlobalRateLimitKey,
    p_client_limit: 100,
    p_login_limit: 10,
    p_global_limit: 1000,
    p_window_seconds: 60
  })
)));
assert(
  loginRateLimitResults.every((result) => !result.error && Array.isArray(result.data)),
  'concurrent login rate-limit RPC calls must all complete'
);
const loginRateLimitDecisions = loginRateLimitResults.map((result) => result.data[0]?.allowed);
assert(
  loginRateLimitDecisions.filter((allowed) => allowed === true).length === 10,
  'concurrent login rate limit must allow exactly ten requests'
);
assert(
  loginRateLimitDecisions.filter((allowed) => allowed === false).length === 10,
  'concurrent login rate limit must deny exactly ten requests'
);

const rotatingGlobalKey = createHash('sha256')
  .update(`edge-login-rotating-global-${randomUUID()}`)
  .digest('hex');
const rotatingAttackerClientKey = createHash('sha256')
  .update(`edge-login-rotating-client-${randomUUID()}`)
  .digest('hex');
const rotatingLoginResults = await Promise.all(Array.from({ length: 200 }, (_, index) => (
  client.rpc('consume_login_rate_limits', {
    p_client_key_hash: rotatingAttackerClientKey,
    p_login_key_hash: createHash('sha256')
      .update(`edge-login-rotating-${index}-${randomUUID()}`)
      .digest('hex'),
    p_global_key_hash: rotatingGlobalKey,
    p_client_limit: 40,
    p_login_limit: 10,
    p_global_limit: 200,
    p_window_seconds: 60
  })
)));
assert(
  rotatingLoginResults.every((result) => !result.error && Array.isArray(result.data)),
  'rotating login-ID limiter calls must all complete'
);
assert(
  rotatingLoginResults
    .map((result) => result.data[0]?.allowed)
    .filter((allowed) => allowed === true).length === 40,
  'one attacker client must be capped at forty rotating login IDs'
);

const isolatedNormalClientResult = await client.rpc('consume_login_rate_limits', {
  p_client_key_hash: createHash('sha256')
    .update(`edge-login-normal-client-${randomUUID()}`)
    .digest('hex'),
  p_login_key_hash: createHash('sha256')
    .update(`edge-login-normal-admin-${randomUUID()}`)
    .digest('hex'),
  p_global_key_hash: rotatingGlobalKey,
  p_client_limit: 40,
  p_login_limit: 10,
  p_global_limit: 200,
  p_window_seconds: 60
});
assert(
  !isolatedNormalClientResult.error && isolatedNormalClientResult.data?.[0]?.allowed === true,
  'an attacker client at its limit must not block a normal admin client'
);

const authUserId = randomUUID();
const actorProfileId = randomUUID();
const developerAuthUserId = randomUUID();
const developerProfileId = randomUUID();
const { error: developerAuthError } = await client.auth.admin.createUser({
  id: developerAuthUserId,
  email: `developer-${developerAuthUserId}@test.invalid`,
  password: `T:${randomUUID()}`,
  email_confirm: true
});
assert(!developerAuthError, `developer Auth fixture failed: ${developerAuthError?.message}`);
const { error: developerProfileError } = await client.rpc('bootstrap_first_developer_profile', {
  p_profile_id: developerProfileId,
  p_auth_user_id: developerAuthUserId,
  p_display_name: '동시성 테스트 개발자',
  p_display_name_normalized: '동시성 테스트 개발자',
  p_phone_last_four: '0001',
  p_phone_lookup_hash: createHash('sha256')
    .update(`activity-developer-${randomUUID()}`)
    .digest('hex'),
  p_idempotency_key: `activity-developer-${randomUUID()}`
});
assert(!developerProfileError, `developer profile fixture failed: ${developerProfileError?.message}`);

const email = `concurrency-${authUserId}@test.invalid`;
const password = `T:${randomUUID()}`;
const { error: authError } = await client.auth.admin.createUser({
  id: authUserId,
  email,
  password,
  email_confirm: true
});
assert(!authError, `auth fixture failed: ${authError?.message}`);

const { error: profileError } = await client.from('profiles').insert({
  id: actorProfileId,
  auth_user_id: authUserId,
  display_name: '동시성 테스트 관리자',
  display_name_normalized: '동시성 테스트 관리자',
  login_id: `concurrency-${authUserId}`,
  login_id_normalized: `concurrency-${authUserId}`,
  login_sequence: 0,
  role: 'admin',
  status: 'active',
  must_change_password: false
});
assert(!profileError, `profile fixture failed: ${profileError?.message}`);

const accountCandidateIds = [randomUUID(), randomUUID()];
const accountDisplayName = `동시생성${randomUUID().slice(0, 8)}`;
const accountPhoneHash = createHash('sha256')
  .update(`account-create-concurrency-${randomUUID()}`)
  .digest('hex');
const accountCreateKey = `account-${randomUUID()}`;
const accountRequestHash = createHash('sha256')
  .update(`account-create-request-${randomUUID()}`)
  .digest('hex');

const accountAuthResults = await Promise.all(accountCandidateIds.map((candidateId) => (
  client.auth.admin.createUser({
    id: candidateId,
    email: `user-${candidateId}@auth.castletheart.invalid`,
    password: `tmp:${randomUUID().slice(0, 4)}`,
    email_confirm: true,
    app_metadata: { profile_id: candidateId, role: 'maid' }
  })
)));
assert(
  accountAuthResults.every((result) => !result.error && result.data.user),
  'concurrent account-create Auth fixtures must be created'
);

const accountCreateResults = await Promise.all(accountCandidateIds.map((candidateId) => (
  client.rpc('create_account_profile', {
    p_profile_id: candidateId,
    p_auth_user_id: candidateId,
    p_actor_profile_id: actorProfileId,
    p_display_name: accountDisplayName,
    p_display_name_normalized: accountDisplayName.toLocaleLowerCase('ko-KR'),
    p_role: 'maid',
    p_phone_last_four: '0000',
    p_phone_lookup_hash: accountPhoneHash,
    p_idempotency_key: accountCreateKey,
    p_request_hash: accountRequestHash
  })
)));
assert(
  accountCreateResults.every((result) => !result.error && result.data),
  'concurrent identical account-create commands must both succeed'
);
const logicalAccountIds = new Set(accountCreateResults.map((result) => result.data.id));
assert(logicalAccountIds.size === 1, 'concurrent account-create must return one logical result');
const logicalAccountId = accountCreateResults[0].data.id;

for (const candidateId of accountCandidateIds) {
  if (candidateId !== logicalAccountId) {
    const { error } = await client.auth.admin.deleteUser(candidateId);
    assert(!error, `duplicate Auth cleanup failed: ${error?.message}`);
  }
}

const { count: logicalAccountCount, error: logicalAccountError } = await client
  .from('profiles')
  .select('id', { count: 'exact', head: true })
  .eq('phone_lookup_hash', accountPhoneHash);
assert(!logicalAccountError && logicalAccountCount === 1, 'one logical account must remain');

const authSurvivors = await Promise.all(accountCandidateIds.map(async (candidateId) => {
  const { data } = await client.auth.admin.getUserById(candidateId);
  return Boolean(data.user);
}));
assert(
  authSurvivors.filter(Boolean).length === 1 &&
    authSurvivors[accountCandidateIds.indexOf(logicalAccountId)] === true,
  'duplicate account-create compensation must leave no orphan Auth user'
);

const denialOccurredAt = new Date(
  Math.floor(Date.now() / 60_000) * 60_000 + 1_000
).toISOString();
const denialCalls = Array.from({ length: 1000 }, () => () => (
  client.rpc('record_authorization_denial', {
    p_actor_profile_id: actorProfileId,
    p_source: 'edge.authorization.developer',
    p_reason_code: 'DEVELOPER_REQUIRED',
    p_occurred_at: denialOccurredAt
  })
));
const denialResults = [];
for (let offset = 0; offset < denialCalls.length; offset += 100) {
  denialResults.push(...await Promise.all(
    denialCalls.slice(offset, offset + 100).map((call) => call())
  ));
}
assert(
  denialResults.every((result) => !result.error),
  'concurrent authorization denials must not raise unique or saturation errors'
);
const { error: isolatedDenialError } = await client.rpc('record_authorization_denial', {
  p_actor_profile_id: logicalAccountId,
  p_source: 'edge.authorization.developer',
  p_reason_code: 'DEVELOPER_REQUIRED',
  p_occurred_at: denialOccurredAt
});
assert(!isolatedDenialError, 'different actor denial must use an isolated aggregate');

async function denialProjection(profileId) {
  const { data, error } = await client.rpc('list_developer_activity_events', {
    p_actor_profile_id: developerProfileId,
    p_filter_actor_profile_id: profileId,
    p_role: null,
    p_categories: ['authorization'],
    p_event_types: ['authorization.denied'],
    p_outcomes: ['denied'],
    p_from: new Date(Date.now() - 5 * 60_000).toISOString(),
    p_to: new Date(Date.now() + 5 * 60_000).toISOString(),
    p_before_recorded_at: null,
    p_before_id: null,
    p_limit: 100
  });
  assert(!error && Array.isArray(data), `denial projection failed: ${error?.message}`);
  return data;
}

const saturatedDenials = await denialProjection(actorProfileId);
assert(
  saturatedDenials.length === 1 &&
    saturatedDenials[0].summary?.aggregateCount === 600,
  '1000 same actor/source/reason denials must converge to one saturated row'
);
const isolatedDenials = await denialProjection(logicalAccountId);
assert(
  isolatedDenials.length === 1 &&
    isolatedDenials[0].summary?.aggregateCount === 1,
  'different actors must keep isolated authorization denial rows'
);

const { data: room, error: roomError } = await client
  .from('rooms')
  .select('id,state_version')
  .eq('room_number', '117')
  .single();
assert(!roomError && room, `room fixture failed: ${roomError?.message}`);

const { error: pinError } = await client.rpc('mutate_room_operation', {
  p_actor_profile_id: actorProfileId,
  p_room_id: room.id,
  p_action: 'record_pin_sync',
  p_expected_room_version: room.state_version,
  p_reason_code: 'CONCURRENCY_TEST_PIN',
  p_payload: {
    entityId: randomUUID(),
    syncStatus: 'verified',
    pinVersion: 1
  },
  p_idempotency_key: `pin-${randomUUID()}`,
  p_request_hash: '1'.repeat(64)
});
assert(!pinError, `PIN fixture failed: ${pinError?.message}`);

const { data: refreshedRoom, error: refreshedRoomError } = await client
  .from('rooms')
  .select('state_version')
  .eq('id', room.id)
  .single();
assert(!refreshedRoomError && refreshedRoom, 'room version refresh failed');

const duplicateRoomOperationIds = [randomUUID(), randomUUID()];
const duplicateRoomOperationKey = `room-operation-duplicate-${randomUUID()}`;
const duplicateRoomOperationHash = '9'.repeat(64);
const duplicateRoomOperationResults = await Promise.all(
  duplicateRoomOperationIds.map((entityId) => client.rpc('mutate_room_operation', {
    p_actor_profile_id: actorProfileId,
    p_room_id: room.id,
    p_action: 'set_candle_count',
    p_expected_room_version: refreshedRoom.state_version,
    p_reason_code: 'CONCURRENCY_TEST_CANDLE',
    p_payload: { entityId, count: 0, physicallyVerified: false },
    p_idempotency_key: duplicateRoomOperationKey,
    p_request_hash: duplicateRoomOperationHash
  }))
);
assert(
  duplicateRoomOperationResults.every((result) => !result.error),
  'concurrent identical room operations must both succeed'
);
assert(
  new Set(duplicateRoomOperationResults.map((result) => result.data.entity_id)).size === 1,
  'concurrent identical room operations must replay one logical result'
);
const { count: duplicateRoomOperationCount, error: duplicateRoomOperationCountError } =
  await client
    .from('room_candle_events')
    .select('id', { count: 'exact', head: true })
    .in('id', duplicateRoomOperationIds);
assert(
  !duplicateRoomOperationCountError,
  `duplicate room operation count failed: ${duplicateRoomOperationCountError?.message}`
);
assert(
  duplicateRoomOperationCount === 1,
  'concurrent identical room operations must create one event'
);

const { data: roomAfterOperationReplay, error: roomAfterOperationReplayError } = await client
  .from('rooms')
  .select('state_version')
  .eq('id', room.id)
  .single();
assert(
  !roomAfterOperationReplayError && roomAfterOperationReplay,
  'room version after operation replay failed'
);

const duplicateReservationIds = [randomUUID(), randomUUID()];
const duplicateKey = `reservation-duplicate-${randomUUID()}`;
const duplicateHash = 'a'.repeat(64);
const duplicateResults = await Promise.all(duplicateReservationIds.map((reservationId) => (
  client.rpc('create_reservation', {
    p_actor_profile_id: actorProfileId,
    p_reservation_id: reservationId,
    p_room_id: room.id,
    p_check_in_at: '2034-01-01T07:00:00.000Z',
    p_check_out_at: '2034-01-02T02:00:00.000Z',
    p_guest_count: 2,
    p_guest_name_encrypted: null,
    p_expected_room_version: roomAfterOperationReplay.state_version,
    p_idempotency_key: duplicateKey,
    p_request_hash: duplicateHash
  })
)));
assert(
  duplicateResults.every((result) => !result.error),
  'concurrent identical reservation commands must both succeed'
);
assert(
  new Set(duplicateResults.map((result) => result.data.id)).size === 1,
  'concurrent identical reservation commands must replay one logical result'
);
const { count: duplicateReservationCount, error: duplicateCountError } = await client
  .from('reservations')
  .select('id', { count: 'exact', head: true })
  .in('id', duplicateReservationIds);
assert(!duplicateCountError, `duplicate reservation count failed: ${duplicateCountError?.message}`);
assert(
  duplicateReservationCount === 1,
  'concurrent identical reservation commands must create one reservation'
);

const { data: roomAfterDuplicate, error: roomAfterDuplicateError } = await client
  .from('rooms')
  .select('state_version')
  .eq('id', room.id)
  .single();
assert(!roomAfterDuplicateError && roomAfterDuplicate, 'room version after replay failed');

const reservationIds = [randomUUID(), randomUUID()];
const createResults = await Promise.all(reservationIds.map((reservationId, index) => (
  client.rpc('create_reservation', {
    p_actor_profile_id: actorProfileId,
    p_reservation_id: reservationId,
    p_room_id: room.id,
    p_check_in_at: '2035-01-01T07:00:00.000Z',
    p_check_out_at: '2035-01-02T02:00:00.000Z',
    p_guest_count: 2,
    p_guest_name_encrypted: null,
    p_expected_room_version: roomAfterDuplicate.state_version,
    p_idempotency_key: `create-${index}-${randomUUID()}`,
    p_request_hash: String(index + 2).repeat(64)
  })
)));
const createSuccesses = createResults.filter((result) => !result.error);
const createFailures = createResults.filter((result) => result.error);
assert(createSuccesses.length === 1, 'concurrent overlapping create must have exactly one winner');
assert(createFailures.length === 1, 'concurrent overlapping create must reject exactly one loser');

const winner = createSuccesses[0].data;
const { error: checkInFixtureError } = await client
  .from('reservations')
  .update({ actual_check_in_at: winner.check_in_at })
  .eq('id', winner.id);
assert(!checkInFixtureError, `check-in fixture failed: ${checkInFixtureError?.message}`);

const checkoutResults = await Promise.all([0, 1].map((index) => (
  client.rpc('manual_checkout_reservation', {
    p_actor_profile_id: actorProfileId,
    p_reservation_id: winner.id,
    p_expected_version: winner.version,
    p_reason_code: 'CONCURRENCY_TEST_CHECKOUT',
    p_effective_at: '2035-01-01T09:00:00.000Z',
    p_idempotency_key: `checkout-${index}-${randomUUID()}`,
    p_request_hash: String(index + 4).repeat(64)
  })
)));
assert(
  checkoutResults.filter((result) => !result.error).length === 1,
  'concurrent manual checkout must have exactly one winner'
);
assert(
  checkoutResults.filter((result) => result.error).length === 1,
  'concurrent manual checkout must reject exactly one loser'
);

const { data: assignmentRooms, error: assignmentRoomsError } = await client
  .from('rooms')
  .select('id,room_number')
  .in('room_number', ['135', '136', '139'])
  .order('room_number');
assert(
  !assignmentRoomsError && assignmentRooms?.length === 3,
  `assignment room fixtures failed: ${assignmentRoomsError?.message}`
);

const assignmentTargetIds = [randomUUID(), randomUUID(), randomUUID()];
const assignmentSourceSuffix = randomUUID();
const { error: assignmentTargetsError } = await client
  .from('cleaning_targets')
  .insert(assignmentTargetIds.map((id, index) => ({
    id,
    room_id: assignmentRooms[index].id,
    cleaning_kind: 'additional',
    source: 'manual_room_request',
    source_key: `assignment-concurrency-${assignmentSourceSuffix}-${index}`,
    original_service_date: '2036-01-01',
    effective_service_date: '2036-01-01',
    available_from: '2036-01-01T00:00:00.000Z',
    due_at: '2036-01-01T08:00:00.000Z',
    room_type_snapshot: {},
    fee_snapshot: 0,
    template_snapshot: {},
    created_by: actorProfileId
  })));
assert(!assignmentTargetsError, `assignment target fixtures failed: ${assignmentTargetsError?.message}`);

const targetRaceResults = await Promise.all([0, 1].map((index) => (
  client.rpc('save_cleaning_assignment_draft', {
    p_actor_profile_id: actorProfileId,
    p_cleaning_target_id: assignmentTargetIds[0],
    p_maid_profile_id: logicalAccountId,
    p_sequence_number: index + 1,
    p_expected_assignment_version: 1,
    p_idempotency_key: `assignment-target-race-${index}-${randomUUID()}`,
    p_request_hash: String(index + 6).repeat(64)
  })
)));
assert(
  targetRaceResults.filter((result) => !result.error).length === 1,
  'same-target concurrent draft saves must have exactly one CAS winner'
);
assert(
  targetRaceResults.filter((result) =>
    result.error?.message?.includes('ASSIGNMENT_VERSION_CONFLICT')
  ).length === 1,
  'same-target concurrent draft saves must reject one stale assignmentVersion'
);

const sequenceRaceResults = await Promise.all([1, 2].map((targetIndex, index) => (
  client.rpc('save_cleaning_assignment_draft', {
    p_actor_profile_id: actorProfileId,
    p_cleaning_target_id: assignmentTargetIds[targetIndex],
    p_maid_profile_id: logicalAccountId,
    p_sequence_number: 10,
    p_expected_assignment_version: 1,
    p_idempotency_key: `assignment-sequence-race-${index}-${randomUUID()}`,
    p_request_hash: String(index + 8).repeat(64)
  })
)));
assert(
  sequenceRaceResults.filter((result) => !result.error).length === 1,
  'same maid/date/sequence on different targets must have exactly one winner'
);
assert(
  sequenceRaceResults.filter((result) =>
    result.error?.message?.includes('cleaning_assignments_current_maid_date_sequence')
  ).length === 1,
  'same maid/date/sequence race must reject one unique-index loser'
);

const kstToday = new Date(Date.now() + (9 * 60 * 60 * 1000));
const assignmentCommitDate = new Date(kstToday);
assignmentCommitDate.setUTCDate(assignmentCommitDate.getUTCDate() + 1);
const assignmentCommitServiceDate = assignmentCommitDate.toISOString().slice(0, 10);
const assignmentCommitWeekStart = new Date(`${assignmentCommitServiceDate}T00:00:00.000Z`);
const isoDay = assignmentCommitWeekStart.getUTCDay() || 7;
assignmentCommitWeekStart.setUTCDate(assignmentCommitWeekStart.getUTCDate() - isoDay + 1);
const assignmentCommitWeekStartText = assignmentCommitWeekStart.toISOString().slice(0, 10);
const availabilityVersionId = randomUUID();
const { error: availabilityVersionError } = await client
  .from('availability_versions')
  .insert({
    id: availabilityVersionId,
    maid_profile_id: logicalAccountId,
    week_start: assignmentCommitWeekStartText,
    version: 1,
    status: 'submitted',
    is_current: true,
    submitted_at: new Date().toISOString()
  });
assert(
  !availabilityVersionError,
  `assignment commit availability fixture failed: ${availabilityVersionError?.message}`
);
const availabilityDates = Array.from({ length: 7 }, (_, index) => {
  const date = new Date(`${assignmentCommitWeekStartText}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + index);
  return date.toISOString().slice(0, 10);
});
const { error: availabilityDaysError } = await client
  .from('availability_days')
  .insert(availabilityDates.map((workDate) => ({
    availability_version_id: availabilityVersionId,
    work_date: workDate,
    available: true
  })));
assert(
  !availabilityDaysError,
  `assignment commit availability days failed: ${availabilityDaysError?.message}`
);

const { data: assignmentCommitRooms, error: assignmentCommitRoomsError } = await client
  .from('rooms')
  .select('id,room_number')
  .in('room_number', ['211', '314', '410'])
  .order('room_number');
assert(
  !assignmentCommitRoomsError && assignmentCommitRooms?.length === 3,
  `assignment commit room fixtures failed: ${assignmentCommitRoomsError?.message}`
);
const assignmentCommitTargetIds = [randomUUID(), randomUUID(), randomUUID()];
const assignmentCommitSourceSuffix = randomUUID();
const { error: assignmentCommitTargetsError } = await client
  .from('cleaning_targets')
  .insert(assignmentCommitTargetIds.map((id, index) => ({
    id,
    room_id: assignmentCommitRooms[index].id,
    cleaning_kind: 'additional',
    source: 'manual_room_request',
    source_key: `assignment-commit-concurrency-${assignmentCommitSourceSuffix}-${index}`,
    original_service_date: assignmentCommitServiceDate,
    effective_service_date: assignmentCommitServiceDate,
    available_from: `${assignmentCommitServiceDate}T00:00:00.000Z`,
    due_at: `${assignmentCommitServiceDate}T23:00:00.000Z`,
    room_type_snapshot: {},
    fee_snapshot: 0,
    template_snapshot: { durationMinutes: 60 },
    created_by: actorProfileId
  })));
assert(
  !assignmentCommitTargetsError,
  `assignment commit targets failed: ${assignmentCommitTargetsError?.message}`
);
for (const [index, targetId] of assignmentCommitTargetIds.entries()) {
  const { error } = await client.rpc('save_cleaning_assignment_draft', {
    p_actor_profile_id: actorProfileId,
    p_cleaning_target_id: targetId,
    p_maid_profile_id: logicalAccountId,
    p_sequence_number: 20 + index,
    p_expected_assignment_version: 1,
    p_idempotency_key: `assignment-commit-draft-${index}-${randomUUID()}`,
    p_request_hash: String(index + 1).repeat(64)
  });
  assert(!error, `assignment commit draft ${index} failed: ${error?.message}`);
}

const { data: initialImpact, error: initialImpactError } = await client.rpc(
  'get_assignment_commit_impact',
  {
    p_actor_profile_id: actorProfileId,
    p_service_date: assignmentCommitServiceDate
  }
);
assert(!initialImpactError && initialImpact, 'assignment commit preflight must succeed');
const replayItem = {
  cleaningTargetId: assignmentCommitTargetIds[0],
  expectedAssignmentVersion: 2,
  expectedAvailabilityVersion: 1
};
const replayCommitKey = `assignment-commit-replay-${randomUUID()}`;
const replayCommitHash = createHash('sha256')
  .update(`assignment-commit-replay-${randomUUID()}`)
  .digest('hex');
const replayCommitResults = await Promise.all([0, 1].map(() => client.rpc(
  'commit_and_notify_assignments',
  {
    p_actor_profile_id: actorProfileId,
    p_service_date: assignmentCommitServiceDate,
    p_expected_impact_fingerprint: initialImpact.impactFingerprint,
    p_items: [replayItem],
    p_idempotency_key: replayCommitKey,
    p_request_hash: replayCommitHash
  }
)));
assert(
  replayCommitResults.every((result) => !result.error),
  'concurrent identical assignment commits must both succeed'
);
assert(
  new Set(replayCommitResults.map((result) => JSON.stringify(result.data))).size === 1,
  'concurrent identical assignment commits must replay one logical response'
);
const { count: replayNotificationCount, error: replayNotificationCountError } = await client
  .from('notifications')
  .select('id', { count: 'exact', head: true })
  .eq('cleaning_target_id', assignmentCommitTargetIds[0]);
assert(
  !replayNotificationCountError && replayNotificationCount === 1,
  'concurrent identical assignment commit must create one notification'
);

const { data: saveRaceImpact, error: saveRaceImpactError } = await client.rpc(
  'get_assignment_commit_impact',
  { p_actor_profile_id: actorProfileId, p_service_date: assignmentCommitServiceDate }
);
assert(!saveRaceImpactError && saveRaceImpact, 'save race preflight must succeed');
const saveRaceTargetId = assignmentCommitTargetIds[1];
const saveCommitRace = await Promise.all([
  client.rpc('commit_and_notify_assignments', {
    p_actor_profile_id: actorProfileId,
    p_service_date: assignmentCommitServiceDate,
    p_expected_impact_fingerprint: saveRaceImpact.impactFingerprint,
    p_items: [{
      cleaningTargetId: saveRaceTargetId,
      expectedAssignmentVersion: 2,
      expectedAvailabilityVersion: 1
    }],
    p_idempotency_key: `assignment-commit-save-race-${randomUUID()}`,
    p_request_hash: 'd'.repeat(64)
  }),
  client.rpc('save_cleaning_assignment_draft', {
    p_actor_profile_id: actorProfileId,
    p_cleaning_target_id: saveRaceTargetId,
    p_maid_profile_id: logicalAccountId,
    p_sequence_number: 30,
    p_expected_assignment_version: 2,
    p_idempotency_key: `assignment-save-commit-race-${randomUUID()}`,
    p_request_hash: 'e'.repeat(64)
  })
]);
assert(
  saveCommitRace.filter((result) => !result.error).length === 1,
  'save versus commit race must have exactly one winner'
);
assert(
  saveCommitRace.filter((result) => result.error).length === 1,
  'save versus commit race must reject exactly one stale loser'
);

const changeRequestId = randomUUID();
const { error: changeRequestError } = await client
  .from('availability_change_requests')
  .insert({
    id: changeRequestId,
    availability_version_id: availabilityVersionId,
    maid_profile_id: logicalAccountId,
    week_start: assignmentCommitWeekStartText,
    source_version: 1,
    requested_available_dates: availabilityDates.filter(
      (date) => date !== assignmentCommitServiceDate
    ),
    reason_code: 'CONCURRENCY_UNAVAILABLE',
    status: 'pending',
    requested_at: new Date().toISOString()
  });
assert(!changeRequestError, `availability change fixture failed: ${changeRequestError?.message}`);
const { data: availabilityRaceImpact, error: availabilityRaceImpactError } = await client.rpc(
  'get_assignment_commit_impact',
  { p_actor_profile_id: actorProfileId, p_service_date: assignmentCommitServiceDate }
);
assert(
  !availabilityRaceImpactError && availabilityRaceImpact,
  'availability race preflight must succeed'
);
const availabilityRace = await Promise.all([
  client.rpc('commit_and_notify_assignments', {
    p_actor_profile_id: actorProfileId,
    p_service_date: assignmentCommitServiceDate,
    p_expected_impact_fingerprint: availabilityRaceImpact.impactFingerprint,
    p_items: [{
      cleaningTargetId: assignmentCommitTargetIds[2],
      expectedAssignmentVersion: 2,
      expectedAvailabilityVersion: 1
    }],
    p_idempotency_key: `assignment-availability-commit-${randomUUID()}`,
    p_request_hash: 'f'.repeat(64)
  }),
  client.rpc('decide_availability_change', {
    p_actor_profile_id: actorProfileId,
    p_change_request_id: changeRequestId,
    p_decision: 'approved',
    p_reason_code: 'CONCURRENCY_APPROVED',
    p_expected_version: 1,
    p_idempotency_key: `assignment-availability-decision-${randomUUID()}`
  })
]);
assert(
  availabilityRace.filter((result) => !result.error).length === 1,
  'availability versus commit race must have exactly one winner'
);
assert(
  availabilityRace.filter((result) => result.error).length === 1,
  'availability versus commit race must reject exactly one stale loser'
);

console.log(
  'Concurrency checks passed: login=10/20, attacker=40/200, isolated-normal-client=1/1, account-create=1/2, authorization-denial=600/1000 with actor isolation, room-operation-replay=1 logical/2 calls, reservation-replay=1 logical/2 calls, reservation-overlap=1/2, manual-checkout=1/2, assignment-target-CAS=1/2, assignment-sequence=1/2, assignment-commit-replay=1 logical/2 calls, assignment-save-vs-commit=1/2, availability-vs-commit=1/2.'
);
