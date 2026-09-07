import { randomUUID } from 'node:crypto';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// Local integration runner supplies a service client and a synthetic admin.
// Configuration is deliberately a separate command from the zero-write snapshot.
export async function testAssignmentPreviewConcurrency(client, actorProfileId) {
  const current = await client.rpc('get_assignment_duration_policy', {
    p_actor_profile_id: actorProfileId
  });
  assert(!current.error, 'preview policy current read failed');
  const version = current.data?.version ?? 0;
  const key = `preview-policy-concurrent-${randomUUID()}`;
  const input = {
    p_actor_profile_id: actorProfileId,
    p_expected_version: version,
    p_standard_minutes: 30,
    p_premium_minutes: 40,
    p_ocean_premium_minutes: 50,
    p_ocean_family_minutes: 60,
    p_idempotency_key: key,
    p_request_hash: '1'.repeat(64)
  };
  const duplicates = await Promise.all(Array.from({ length: 8 }, () =>
    client.rpc('confirm_assignment_duration_policy', input)));
  assert(duplicates.every((result) => !result.error), 'same-policy concurrent replay must succeed');
  assert(duplicates.every((result) => result.data.id === duplicates[0].data.id),
    'same-policy concurrency creates one logical policy');
  const contenders = await Promise.all([2, 3].map((value) =>
    client.rpc('confirm_assignment_duration_policy', {
      ...input,
      p_expected_version: version + 1,
      p_standard_minutes: 30 + value,
      p_idempotency_key: `preview-policy-contender-${randomUUID()}`,
      p_request_hash: String(value).repeat(64)
    })));
  assert(contenders.filter((result) => !result.error).length === 1, 'policy CAS has exactly one winner');
  assert(contenders.some((result) => result.error?.message === 'ASSIGNMENT_DURATION_POLICY_VERSION_CONFLICT'),
    'policy CAS loser fails closed');
  const after = await client.rpc('get_assignment_duration_policy', { p_actor_profile_id: actorProfileId });
  assert(!after.error && after.data.version === version + 2, 'policy version advances once per logical update');
  const event = await client.from('audit_events').select('id').eq('event_type', 'assignment.duration_policy_confirmed')
    .eq('entity_id', duplicates[0].data.id);
  assert(!event.error && event.data.length === 1, 'idempotent policy has exactly one audit event');
  console.log('assignment preview duration policy CAS / duplicate retry concurrency PASS');
}
