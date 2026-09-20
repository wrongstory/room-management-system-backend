import { randomUUID } from 'node:crypto';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// Local integration runner supplies a service client and a synthetic admin.
// Historical policy remains readable, but every new confirmation is retired.
export async function testAssignmentPreviewConcurrency(client, actorProfileId) {
  const before = await client.rpc('get_assignment_duration_policy', {
    p_actor_profile_id: actorProfileId
  });
  assert(!before.error, 'historical preview policy read failed');
  const auditBefore = await client.from('audit_events').select('id', { count: 'exact', head: true })
    .eq('event_type', 'assignment.duration_policy_confirmed');
  assert(!auditBefore.error, 'duration policy audit baseline read failed');
  const key = `preview-policy-concurrent-${randomUUID()}`;
  const input = {
    p_actor_profile_id: actorProfileId,
    p_expected_version: before.data?.version ?? 0,
    p_standard_minutes: 30,
    p_premium_minutes: 40,
    p_ocean_premium_minutes: 50,
    p_ocean_family_minutes: 60,
    p_idempotency_key: key,
    p_request_hash: '1'.repeat(64)
  };
  const duplicates = await Promise.all(Array.from({ length: 8 }, () =>
    client.rpc('confirm_assignment_duration_policy', input)));
  assert(duplicates.every((result) => result.error?.message === 'ASSIGNMENT_DURATION_POLICY_RETIRED'),
    'same-key concurrent confirmations must all fail with retired policy');
  const distinct = await Promise.all([2, 3].map((value) =>
    client.rpc('confirm_assignment_duration_policy', {
      ...input,
      p_standard_minutes: 30 + value,
      p_idempotency_key: `preview-policy-contender-${randomUUID()}`,
      p_request_hash: String(value).repeat(64)
    })));
  assert(distinct.every((result) => result.error?.message === 'ASSIGNMENT_DURATION_POLICY_RETIRED'),
    'distinct concurrent confirmations must all fail with retired policy');
  const after = await client.rpc('get_assignment_duration_policy', { p_actor_profile_id: actorProfileId });
  assert(!after.error && JSON.stringify(after.data) === JSON.stringify(before.data),
    'retired confirmation concurrency preserves historical policy');
  const auditAfter = await client.from('audit_events').select('id', { count: 'exact', head: true })
    .eq('event_type', 'assignment.duration_policy_confirmed');
  assert(!auditAfter.error && auditAfter.count === auditBefore.count,
    'retired confirmation concurrency creates no audit event');
  console.log('assignment preview retired duration policy concurrency PASS');
}
