// Test-only preparation for the existing local concurrency suite. This does not
// deliver, settle, resume blocked jobs, or change the production claim contract.
export const DELIVERY_DRAIN_PASS_LIMIT = 100;
export const DELIVERY_DRAIN_CLAIM_LIMIT = 10;

const SUMMARY_KEYS = Object.freeze([
  'pendingJobs', 'claimableTargets', 'duePendingTargets', 'dueRetryTargets',
  'expiredClaimTargets', 'blockedDueTargets', 'otherParentDueTargets',
  'futureTargets', 'liveClaimTargets', 'invalidJobs', 'invalidTargets',
]);
const JOB_STATES_SQL = "'pending','materialized','completed','suppressed','dead_letter','operator_blocked'";
const TARGET_STATES_SQL = "'pending','claimed','retry','delivered','suppressed','dead_letter','operator_blocked'";

// A new digest is used for every drain claim, so an unexpired same-digest replay
// is not drainable work. Match the production fresh-claim predicate, including
// the parent materialized state and equality at both time boundaries.
export const DELIVERY_DRAIN_SUMMARY_SQL = `with drain_clock as materialized (
  select clock_timestamp() as at_time
), drain_jobs as (
  select count(*) filter (where j.status='pending') as pending_jobs,
    count(*) filter (where j.status is null or j.status not in (${JOB_STATES_SQL})) as invalid_jobs
  from private.notification_delivery_jobs j
), drain_targets as (
  select j.status as parent_status,t.status,t.next_attempt_at,t.lease_expires_at,
    t.next_attempt_at<=c.at_time
      and (t.status<>'claimed' or t.lease_expires_at<=c.at_time) as due,
    t.next_attempt_at>c.at_time as future,
    t.status='claimed' and t.next_attempt_at<=c.at_time and t.lease_expires_at>c.at_time as live_claim,
    t.status is null or t.status not in (${TARGET_STATES_SQL}) or t.next_attempt_at is null
      or (t.status='claimed' and t.lease_expires_at is null) as invalid
  from private.notification_delivery_targets t
  join private.notification_delivery_jobs j on j.outbox_id=t.outbox_id
  cross join drain_clock c
), drain_counts as (
  select count(*) filter (where parent_status='materialized' and status in ('pending','retry','claimed') and due) as claimable,
    count(*) filter (where parent_status='materialized' and status='pending' and due) as pending,
    count(*) filter (where parent_status='materialized' and status='retry' and due) as retry,
    count(*) filter (where parent_status='materialized' and status='claimed' and due) as expired,
    count(*) filter (where parent_status='operator_blocked' and status in ('pending','retry','claimed') and due) as blocked,
    count(*) filter (where parent_status not in ('materialized','operator_blocked') and status in ('pending','retry','claimed') and due) as other_parent,
    count(*) filter (where parent_status='materialized' and status in ('pending','retry','claimed') and future) as future,
    count(*) filter (where parent_status='materialized' and live_claim) as live_claim,
    count(*) filter (where invalid) as invalid
  from drain_targets
)
select jsonb_build_object(
  'pendingJobs',j.pending_jobs,'claimableTargets',t.claimable,
  'duePendingTargets',t.pending,'dueRetryTargets',t.retry,'expiredClaimTargets',t.expired,
  'blockedDueTargets',t.blocked,'otherParentDueTargets',t.other_parent,
  'futureTargets',t.future,'liveClaimTargets',t.live_claim,
  'invalidJobs',j.invalid_jobs,'invalidTargets',t.invalid
)::text from drain_jobs j cross join drain_counts t;`;

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => isRecord(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const count = value => Number.isSafeInteger(value) && value >= 0;
const failure = code => new Error(`Notification delivery fixture drain: ${code}`);

function parseJson(raw, maxLength, code) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > maxLength) throw failure(code);
  try { return JSON.parse(raw); } catch { throw failure(code); }
}

export function parseDeliveryDrainSummary(raw) {
  const summary = parseJson(raw, 8192, 'SUMMARY_INVALID');
  if (!exactKeys(summary, SUMMARY_KEYS) || !SUMMARY_KEYS.every(key => count(summary[key]))) {
    throw failure('SUMMARY_INVALID');
  }
  const expected = summary.duePendingTargets + summary.dueRetryTargets + summary.expiredClaimTargets;
  if (!Number.isSafeInteger(expected) || summary.claimableTargets !== expected
    || !Number.isSafeInteger(summary.pendingJobs + summary.claimableTargets)) throw failure('SUMMARY_INVALID');
  if (summary.invalidJobs !== 0 || summary.invalidTargets !== 0) throw failure('SUMMARY_INVALID_STATE');
  return Object.freeze(summary);
}

const ITEM_REQUIRED_KEYS = Object.freeze([
  'targetId', 'notificationId', 'subscriptionRevisionId', 'status',
  'leaseVersion', 'leaseExpiresAt', 'nextAttemptAt',
]);
const ITEM_ALLOWED_KEYS = new Set([...ITEM_REQUIRED_KEYS, 'reasonCode']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const instant = value => typeof value === 'string' && value.length <= 40 && INSTANT.test(value)
  && Number.isFinite(Date.parse(value));

export function validateDeliveryDrainClaim(result) {
  if (!exactKeys(result, ['value', 'error']) || typeof result.error !== 'string' || result.error !== '') {
    throw failure('CLAIM_FAILED');
  }
  const claim = parseJson(result.value, 131072, 'CLAIM_INVALID');
  if (!exactKeys(claim, ['items', 'suppressed', 'blocked']) || !Array.isArray(claim.items)
    || !count(claim.suppressed) || !count(claim.blocked)
    || claim.items.length + claim.suppressed + claim.blocked > DELIVERY_DRAIN_CLAIM_LIMIT) {
    throw failure('CLAIM_INVALID');
  }
  for (const item of claim.items) {
    if (!isRecord(item) || !ITEM_REQUIRED_KEYS.every(key => Object.hasOwn(item, key))
      || Object.keys(item).some(key => !ITEM_ALLOWED_KEYS.has(key))
      || !['targetId', 'notificationId', 'subscriptionRevisionId'].every(key => typeof item[key] === 'string' && UUID.test(item[key]))
      || item.status !== 'claimed' || !Number.isInteger(item.leaseVersion) || item.leaseVersion < 1 || item.leaseVersion > 8
      || !instant(item.leaseExpiresAt) || !instant(item.nextAttemptAt)
      || (Object.hasOwn(item, 'reasonCode') && item.reasonCode !== null)) throw failure('CLAIM_INVALID');
  }
  return { claimed: claim.items.length, suppressed: claim.suppressed, blocked: claim.blocked };
}

function checkpoint(code, passes, summary) {
  // Only fixed field names, finite counts and a bounded pass number reach logs.
  const safe = Object.fromEntries(SUMMARY_KEYS.map(key => [key, summary[key]]));
  return `Notification delivery fixture drain: ${code}; passes=${passes}; ${JSON.stringify(safe)}`;
}

export async function drainNotificationDeliveryFixtures(options) {
  if (!isRecord(options) || Object.keys(options).some(key => !['readSummary', 'claim', 'report'].includes(key))
    || typeof options.readSummary !== 'function' || typeof options.claim !== 'function'
    || (options.report !== undefined && typeof options.report !== 'function')) throw failure('DEPENDENCIES_INVALID');
  let passes = 0;
  let summary;
  async function read() {
    let raw;
    try { raw = await options.readSummary(); } catch { throw failure('SUMMARY_READ_FAILED'); }
    return parseDeliveryDrainSummary(raw);
  }
  summary = await read();
  while (summary.pendingJobs + summary.claimableTargets > 0 && passes < DELIVERY_DRAIN_PASS_LIMIT) {
    passes += 1;
    let result;
    try { result = await options.claim(DELIVERY_DRAIN_CLAIM_LIMIT); }
    catch { throw new Error(checkpoint('CLAIM_FAILED', passes, summary)); }
    try { validateDeliveryDrainClaim(result); }
    catch { throw new Error(checkpoint('CLAIM_REJECTED', passes, summary)); }
    // Recount even on pass 100: the last permitted claim may have consumed the
    // final pending job or moved the final due target into its bounded lease.
    summary = await read();
  }
  if (summary.pendingJobs + summary.claimableTargets !== 0) {
    throw new Error(checkpoint('LIMIT_EXHAUSTED', passes, summary));
  }
  if (options.report) options.report(checkpoint('NO_CURRENTLY_CLAIMABLE_WORK', passes, summary));
  return { passes, summary };
}

// Exercise the same aggregate SQL using temporary synthetic rows only. Fixed
// replacements are confined to this test probe; the real drain has no target,
// time, predicate, budget or table override.
function probeQuery() {
  const replacements = [
    ['private.notification_delivery_jobs', 'pg_temp.rms371_drain_jobs', 2],
    ['private.notification_delivery_targets', 'pg_temp.rms371_drain_targets', 1],
    ['clock_timestamp()', "'2026-10-04T00:00:00Z'::timestamptz", 1],
  ];
  let query = DELIVERY_DRAIN_SUMMARY_SQL;
  for (const [source, replacement, occurrences] of replacements) {
    if (query.split(source).length !== occurrences + 1) throw failure('PROBE_SOURCE_DRIFT');
    query = query.replaceAll(source, replacement);
  }
  return query;
}

export const DELIVERY_DRAIN_PREDICATE_PROBE_SQL = `begin;
create temporary table rms371_drain_jobs(outbox_id integer primary key,status text) on commit drop;
create temporary table rms371_drain_targets(outbox_id integer,status text,next_attempt_at timestamptz,lease_expires_at timestamptz) on commit drop;
insert into rms371_drain_jobs values
  (1,'pending'),(2,'materialized'),(3,'operator_blocked'),(4,'suppressed'),(5,'dead_letter'),(6,'completed');
insert into rms371_drain_targets values
  (2,'pending','2026-10-03T23:59:59Z',null),(2,'pending','2026-10-04T00:00:00Z',null),
  (2,'retry','2026-10-03T23:59:59Z',null),(2,'retry','2026-10-04T00:00:00Z',null),
  (2,'claimed','2026-10-03T23:59:59Z','2026-10-03T23:59:59Z'),
  (2,'claimed','2026-10-03T23:59:59Z','2026-10-04T00:00:00Z'),
  (2,'claimed','2026-10-03T23:59:59Z','2026-10-04T00:00:01Z'),
  (2,'pending','2026-10-04T00:00:01Z',null),(2,'retry','2026-10-04T00:00:01Z',null),
  (2,'claimed','2026-10-04T00:00:01Z','2026-10-03T23:59:59Z'),
  (3,'pending','2026-10-03T23:59:59Z',null),(3,'retry','2026-10-03T23:59:59Z',null),
  (3,'claimed','2026-10-03T23:59:59Z','2026-10-03T23:59:59Z'),
  (1,'retry','2026-10-03T23:59:59Z',null),(4,'pending','2026-10-03T23:59:59Z',null),
  (5,'claimed','2026-10-03T23:59:59Z','2026-10-03T23:59:59Z'),(6,'retry','2026-10-03T23:59:59Z',null),
  (2,'delivered','2026-10-03T23:59:59Z',null),(2,'suppressed','2026-10-03T23:59:59Z',null),
  (2,'dead_letter','2026-10-03T23:59:59Z',null),(2,'operator_blocked','2026-10-03T23:59:59Z',null);
${probeQuery()}
rollback;`;

export function assertDeliveryDrainPredicateProbe(raw) {
  const actual = parseDeliveryDrainSummary(raw);
  const expected = {
    pendingJobs: 1, claimableTargets: 6, duePendingTargets: 2, dueRetryTargets: 2,
    expiredClaimTargets: 2, blockedDueTargets: 3, otherParentDueTargets: 4,
    futureTargets: 3, liveClaimTargets: 1, invalidJobs: 0, invalidTargets: 0,
  };
  if (!SUMMARY_KEYS.every(key => actual[key] === expected[key])) throw failure('PREDICATE_PROBE_MISMATCH');
}
