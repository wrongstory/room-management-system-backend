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

const loginRateLimitKey = createHash('sha256')
  .update(`edge-login-concurrency-${randomUUID()}`)
  .digest('hex');
const loginRateLimitResults = await Promise.all(Array.from({ length: 20 }, () => (
  client.rpc('consume_login_rate_limit', {
    p_key_hash: loginRateLimitKey,
    p_limit: 10,
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

const authUserId = randomUUID();
const actorProfileId = randomUUID();
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
    p_expected_room_version: refreshedRoom.state_version,
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

console.log(
  'Concurrency checks passed: login-rate-limit=10/20, reservation-create=1/2, manual-checkout=1/2.'
);
