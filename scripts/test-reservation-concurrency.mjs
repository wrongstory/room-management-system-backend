import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { testPrestartConcurrency } from './test-prestart-concurrency.mjs';

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

// Local synthetic configuration; planned checkout creation requires a published snapshot.
const { data: templateRoomTypes, error: templateRoomTypesError } =
  await client.from('room_types').select('id');
assert(!templateRoomTypesError && templateRoomTypes, 'checkout template room types');
const { error: checkoutTemplatesError } = await client.from('cleaning_template_versions')
  .insert(templateRoomTypes.map(({ id }) => ({
    room_type_id: id, cleaning_kind: 'checkout', version: 1, status: 'published',
    duration_minutes: 60, photo_slots: [], published_at: new Date().toISOString(),
    created_by: actorProfileId
  })));
assert(!checkoutTemplatesError, 'checkout template fixtures');

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

// Future checkout planning races use public commands, not synthetic materialization.
const { data: planningRooms, error: planningRoomsError } = await client.from('rooms')
  .select('id,state_version').order('room_number').range(50, 53);
assert(!planningRoomsError && planningRooms?.length === 4, 'planning race rooms');
const planningCheckIn = new Date(Math.floor((Date.now() - 86400000) / 60000) * 60000).toISOString();
const planningCheckOut = `${assignmentCommitServiceDate}T11:00:00+09:00`;
async function planningFixture(index) {
  const id = randomUUID();
  const room = planningRooms[index];
  const pin = await client.rpc('mutate_room_operation', {
    p_actor_profile_id: actorProfileId, p_room_id: room.id,
    p_action: 'record_pin_sync', p_expected_room_version: room.state_version,
    p_reason_code: 'PLANNING_RACE_FIXTURE',
    p_payload: { entityId: randomUUID(), syncStatus: 'verified', pinVersion: 1 },
    p_idempotency_key: `planning-pin-${id}`, p_request_hash: '1'.repeat(64)
  });
  assert(!pin.error, `planning PIN metadata: ${pin.error?.message}`);
  const latest = await client.from('rooms').select('state_version').eq('id',room.id).single();
  assert(!latest.error, 'planning room version');
  const created = await client.rpc('create_reservation', {
    p_actor_profile_id: actorProfileId, p_reservation_id: id, p_room_id: room.id,
    p_check_in_at: index === 1 ? `${kstToday.toISOString().slice(0,10)}T23:59:00+09:00` : planningCheckIn,
    p_check_out_at: planningCheckOut,
    p_guest_count: 2, p_guest_name_encrypted: null,
    p_expected_room_version: latest.data.state_version,
    p_idempotency_key: `planning-create-${id}`, p_request_hash: '2'.repeat(64)
  });
  assert(!created.error, `planning create: ${created.error?.message}`);
  const obligation = await client.from('checkout_cleaning_obligations')
    .select('planned_cleaning_target_id,current_cleaning_target_id,status')
    .eq('reservation_id',id).single();
  assert(!obligation.error && obligation.data.status === 'private' &&
    obligation.data.current_cleaning_target_id === null, 'planning remains private');
  const targetId = obligation.data.planned_cleaning_target_id;
  const draft = await client.rpc('save_cleaning_assignment_draft', {
    p_actor_profile_id: actorProfileId, p_cleaning_target_id: targetId,
    p_maid_profile_id: logicalAccountId, p_sequence_number: 50+index,
    p_expected_assignment_version: 1, p_idempotency_key: `planning-draft-${id}`,
    p_request_hash: '3'.repeat(64)
  });
  assert(!draft.error, `planning draft: ${draft.error?.message}`);
  return { id, targetId, roomId: room.id };
}
async function planningCommitArgs(plan) {
  const impact = await client.rpc('get_assignment_commit_impact', {
    p_actor_profile_id: actorProfileId, p_service_date: assignmentCommitServiceDate
  });
  assert(!impact.error, 'planning race preflight');
  return {
    p_actor_profile_id: actorProfileId, p_service_date: assignmentCommitServiceDate,
    p_expected_impact_fingerprint: impact.data.impactFingerprint,
    p_items: [{cleaningTargetId:plan.targetId,expectedAssignmentVersion:2,expectedAvailabilityVersion:1}],
    p_idempotency_key: `planning-commit-${plan.id}`, p_request_hash:'4'.repeat(64)
  };
}
const changePlan = await planningFixture(0);
const changeCommitArgs = await planningCommitArgs(changePlan);
const changeVsCommit = await Promise.all([
  client.rpc('change_reservation', {
    p_actor_profile_id:actorProfileId,p_reservation_id:changePlan.id,p_room_id:changePlan.roomId,
    p_check_in_at:planningCheckIn,p_check_out_at:`${assignmentCommitServiceDate}T12:00:00+09:00`,
    p_guest_count:2,p_guest_name_mode:'keep',p_guest_name_encrypted:null,p_expected_version:1,
    p_reason_code:'PLANNING_RACE_CHANGE',p_idempotency_key:`planning-change-${changePlan.id}`,
    p_request_hash:'5'.repeat(64)
  }),
  client.rpc('commit_and_notify_assignments',changeCommitArgs)
]);
assert(changeVsCommit.filter(r=>!r.error).length === 1, 'change versus notify exactly one winner');
assert(changeVsCommit.filter(r=>r.error).every(r=> /REPLAN_REQUIRED|STALE|CONFLICT|ASSIGNMENT_IMPACT_CHANGED/.test(r.error.message)),
  'change versus notify fails closed, never deadlocks');
const cancelPlan = await planningFixture(1);
const cancelArgs = await planningCommitArgs(cancelPlan);
const cancelVsCommit = await Promise.all([
  client.rpc('cancel_reservation',{
    p_actor_profile_id:actorProfileId,p_reservation_id:cancelPlan.id,p_expected_version:1,
    p_reason_code:'PLANNING_RACE_CANCEL',p_idempotency_key:`planning-cancel-${cancelPlan.id}`,
    p_request_hash:'6'.repeat(64)
  }),
  client.rpc('commit_and_notify_assignments',cancelArgs)
]);
assert(!cancelVsCommit[0].error, `cancel must finish (either before notify or with revocation): ${cancelVsCommit[0].error?.message}`);
assert(!cancelVsCommit[1].error || /STALE|CONFLICT|CANCELLED|ASSIGNMENT_IMPACT_CHANGED/.test(cancelVsCommit[1].error.message),
  'cancel versus notify rejects stale plan');
const cancelledTarget = await client.from('cleaning_targets').select('status').eq('id',cancelPlan.targetId).single();
const ghost = await client.from('cleaning_assignments').select('id',{count:'exact',head:true})
  .eq('cleaning_target_id',cancelPlan.targetId).eq('is_current',true);
assert(!cancelledTarget.error && cancelledTarget.data.status==='cancelled' && !ghost.error && ghost.count===0,
  'cancel versus notify has no ghost assignment');
const scheduledPlan = await planningFixture(2);
const scheduledCommit = await client.rpc('commit_and_notify_assignments',await planningCommitArgs(scheduledPlan));
assert(!scheduledCommit.error, 'scheduled planning notify');
const beforePromote = await client.from('cleaning_assignments').select('id').eq('cleaning_target_id',scheduledPlan.targetId).eq('is_current',true).single();
const scheduledArgs = {
  p_actor_profile_id:actorProfileId,p_as_of:planningCheckOut,
  p_idempotency_key:`planning-scheduler-retry-${randomUUID()}`,p_request_hash:'7'.repeat(64)
};
const scheduledRace = await Promise.all([client.rpc('process_due_reservation_transitions',scheduledArgs),
  client.rpc('process_due_reservation_transitions',scheduledArgs)]);
assert(scheduledRace.every(r=>!r.error) && JSON.stringify(scheduledRace[0].data)===JSON.stringify(scheduledRace[1].data),
  'scheduled checkout versus retry has one logical response');
const afterPromote = await client.from('cleaning_assignments').select('id').eq('cleaning_target_id',scheduledPlan.targetId).eq('is_current',true).single();
assert(!beforePromote.error && !afterPromote.error && beforePromote.data.id===afterPromote.data.id,
  'scheduled promotion preserves notified assignment revision');

const manualPlan = await planningFixture(3);
const checkedIn = await client.from('reservations').update({actual_check_in_at:planningCheckIn}).eq('id',manualPlan.id);
assert(!checkedIn.error,'manual/scheduled check-in fixture');
const manualVsScheduled = await Promise.all([
  client.rpc('manual_checkout_reservation',{
    p_actor_profile_id:actorProfileId,p_reservation_id:manualPlan.id,p_expected_version:1,
    p_reason_code:'PLANNING_MANUAL_RACE',p_effective_at:new Date(Math.floor(Date.now()/60000)*60000).toISOString(),
    p_idempotency_key:`planning-manual-${manualPlan.id}`,p_request_hash:'8'.repeat(64)
  }),
  client.rpc('process_due_reservation_transitions',{
    ...scheduledArgs,p_idempotency_key:`planning-scheduler-race-${manualPlan.id}`,p_request_hash:'9'.repeat(64)
  })
]);
assert(!manualVsScheduled[1].error, 'scheduler race returns a committed or empty normal result');
assert(!manualVsScheduled[0].error || /STALE|CONFLICT|INVALID_TRANSITION/.test(manualVsScheduled[0].error.message),
  'manual loser fails closed');
for (const plan of [scheduledPlan,manualPlan]) {
  const target = await client.from('cleaning_targets').select('id').eq('reservation_id',plan.id);
  const obligation = await client.from('checkout_cleaning_obligations')
    .select('planned_cleaning_target_id,current_cleaning_target_id,status').eq('reservation_id',plan.id).single();
  const events = await client.from('room_occupancy_events').select('id',{count:'exact',head:true})
    .eq('reservation_id',plan.id).in('event_type',['manual_checkout','scheduled_checkout']);
  const attempts = await client.from('cleaning_attempts').select('id',{count:'exact',head:true}).eq('cleaning_target_id',plan.targetId);
  assert(!target.error && target.data.length===1 && target.data[0].id===plan.targetId &&
    !obligation.error && obligation.data.status==='materialized' &&
    obligation.data.current_cleaning_target_id===plan.targetId && obligation.data.planned_cleaning_target_id===plan.targetId &&
    !events.error && events.count===1 && !attempts.error && attempts.count===0,
    'checkout race: same identity, one occupancy event, zero premature attempts');
}
console.log('Planning races passed: change/notify, cancel/notify, scheduled/retry, manual/scheduled; one target and zero premature attempts.');
await testPrestartConcurrency(client,actorProfileId);

console.log(
  'Concurrency checks passed: login=10/20, attacker=40/200, isolated-normal-client=1/1, account-create=1/2, authorization-denial=600/1000 with actor isolation, room-operation-replay=1 logical/2 calls, reservation-replay=1 logical/2 calls, reservation-overlap=1/2, manual-checkout=1/2, assignment-target-CAS=1/2, assignment-sequence=1/2, assignment-commit-replay=1 logical/2 calls, assignment-save-vs-commit=1/2, availability-vs-commit=1/2.'
);
