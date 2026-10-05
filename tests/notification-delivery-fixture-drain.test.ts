import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const helperModule = '../scripts/notification-delivery-fixture-drain.mjs';
const {
  DELIVERY_DRAIN_PASS_LIMIT, DELIVERY_DRAIN_CLAIM_LIMIT, DELIVERY_DRAIN_SUMMARY_SQL,
  DELIVERY_DRAIN_PREDICATE_PROBE_SQL, parseDeliveryDrainSummary,
  validateDeliveryDrainClaim, drainNotificationDeliveryFixtures, assertDeliveryDrainPredicateProbe,
} = await import(helperModule);

// Independent fixtures, not implementation constants or a second production
// classifier. The DB probe separately executes the actual helper SQL.
type Summary = {
  pendingJobs: number; claimableTargets: number; duePendingTargets: number; dueRetryTargets: number;
  expiredClaimTargets: number; blockedDueTargets: number; otherParentDueTargets: number;
  futureTargets: number; liveClaimTargets: number; invalidJobs: number; invalidTargets: number;
};
const quiet = (): Summary => ({
  pendingJobs: 0, claimableTargets: 0, duePendingTargets: 0, dueRetryTargets: 0,
  expiredClaimTargets: 0, blockedDueTargets: 0, otherParentDueTargets: 0,
  futureTargets: 0, liveClaimTargets: 0, invalidJobs: 0, invalidTargets: 0,
});
const raw = (summary: Summary) => JSON.stringify(summary);
const pending = (): Summary => ({ ...quiet(), pendingJobs: 1 });
const due = (kind: 'duePendingTargets' | 'dueRetryTargets' | 'expiredClaimTargets'): Summary => ({
  ...quiet(), claimableTargets: 1, [kind]: 1,
});
const emptyClaim = () => ({ value: JSON.stringify({ items: [], suppressed: 0, blocked: 0 }), error: '' });
const workload = () => ({
  targetId: '00000000-0000-0000-0000-000000000001', notificationId: '00000000-0000-0000-0000-000000000002',
  subscriptionRevisionId: '00000000-0000-0000-0000-000000000003', status: 'claimed', leaseVersion: 1,
  leaseExpiresAt: '2026-10-04T00:02:00.000000+00:00', nextAttemptAt: '2026-10-04T00:00:00Z',
});

describe('notification delivery fixture drain fixed contract', () => {
  it('preserves finite 100 passes / limit10 and checks parent plus fresh-claim time boundaries', () => {
    expect(DELIVERY_DRAIN_PASS_LIMIT).toBe(100);
    expect(DELIVERY_DRAIN_CLAIM_LIMIT).toBe(10);
    expect(DELIVERY_DRAIN_SUMMARY_SQL).toContain("parent_status='materialized' and status in ('pending','retry','claimed') and due");
    expect(DELIVERY_DRAIN_SUMMARY_SQL).toContain("t.next_attempt_at<=c.at_time");
    expect(DELIVERY_DRAIN_SUMMARY_SQL).toContain("(t.status<>'claimed' or t.lease_expires_at<=c.at_time)");
    expect(DELIVERY_DRAIN_SUMMARY_SQL).toContain("where j.status='pending'");
    expect(DELIVERY_DRAIN_SUMMARY_SQL.match(/clock_timestamp\(\)/g)).toHaveLength(1);
    expect(DELIVERY_DRAIN_SUMMARY_SQL).not.toMatch(/\b(insert|update|delete|grant|revoke|alter|create)\b/i);
    expect(DELIVERY_DRAIN_SUMMARY_SQL).not.toContain('claim_digest');
  });

  it.each([
    ['blocked parent', { ...quiet(), blockedDueTargets: 3 }],
    ['other non-materialized parent', { ...quiet(), otherParentDueTargets: 4 }],
    ['future retry or pending', { ...quiet(), futureTargets: 3 }],
    ['unexpired lease under a different digest', { ...quiet(), liveClaimTargets: 1 }],
  ])('does not claim excluded %s, but preserves its safe diagnostic count', async (_name, state) => {
    const claim = vi.fn(); const report = vi.fn();
    const result = await drainNotificationDeliveryFixtures({ readSummary: () => raw(state as Summary), claim, report });
    expect(result.passes).toBe(0); expect(claim).not.toHaveBeenCalled();
    expect(result.summary).toEqual(state);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toContain('NO_CURRENTLY_CLAIMABLE_WORK; passes=0;');
  });

  it.each([
    ['pending job-only', pending()], ['materialized pending', due('duePendingTargets')],
    ['due retry', due('dueRetryTargets')], ['expired claim', due('expiredClaimTargets')],
  ])('claims %s and recounts after the permitted claim', async (_name, state) => {
    const snapshots = [raw(state as Summary), raw(quiet())];
    const readSummary = vi.fn(() => snapshots.shift()); const claim = vi.fn(() => emptyClaim());
    const result = await drainNotificationDeliveryFixtures({ readSummary, claim });
    expect(result).toEqual({ passes: 1, summary: quiet() });
    expect(readSummary).toHaveBeenCalledTimes(2);
    expect(claim).toHaveBeenCalledExactlyOnceWith(10);
  });

  it('accepts empty items while pending jobs are suppressed/materialized and recounts the DB instead', async () => {
    const snapshots = [raw({ ...quiet(), pendingJobs: 2 }), raw(pending()), raw(quiet())];
    const claim = vi.fn(() => ({ value: JSON.stringify({ items: [], suppressed: 1, blocked: 0 }), error: '' }));
    const result = await drainNotificationDeliveryFixtures({ readSummary: () => snapshots.shift(), claim });
    expect(result.passes).toBe(2); expect(claim).toHaveBeenCalledTimes(2);
  });

  it('succeeds when exactly the 100th claim consumes the final work, with a 101st summary read', async () => {
    let reads = 0; const claim = vi.fn(() => emptyClaim());
    const result = await drainNotificationDeliveryFixtures({
      readSummary: () => raw(reads++ < 100 ? pending() : quiet()), claim,
    });
    expect(result.passes).toBe(100); expect(reads).toBe(101);
    expect(claim).toHaveBeenCalledTimes(100);
    expect(claim.mock.calls).toEqual(Array.from({ length: 100 }, () => [10]));
  });

  it.each([pending(), due('duePendingTargets'), due('dueRetryTargets'), due('expiredClaimTargets')])(
    'still fails when claimable work remains after 100 claims (%#)', async state => {
      const readSummary = vi.fn(() => raw(state)); const claim = vi.fn(() => emptyClaim()); const report = vi.fn();
      await expect(drainNotificationDeliveryFixtures({ readSummary, claim, report })).rejects.toThrow('LIMIT_EXHAUSTED; passes=100;');
      expect(readSummary).toHaveBeenCalledTimes(101); expect(claim).toHaveBeenCalledTimes(100);
      expect(report).not.toHaveBeenCalled();
    },
  );

  it('treats claiming a due target into a live lease as no currently claimable work, not delivered', async () => {
    const snapshots = [raw(due('expiredClaimTargets')), raw({ ...quiet(), liveClaimTargets: 1 })];
    const claim = () => ({ value: JSON.stringify({ items: [workload()], suppressed: 0, blocked: 0 }), error: '' });
    const report = vi.fn();
    const result = await drainNotificationDeliveryFixtures({ readSummary: () => snapshots.shift(), claim, report });
    expect(result.summary.liveClaimTargets).toBe(1);
    expect(report.mock.calls[0]?.[0]).not.toMatch(/delivered|settled|provider/i);
  });
});

describe('fail-closed bounded input and safe diagnostics', () => {
  it.each(['', 'null', '[]', '{}', '[', '{} trailing', 'x'.repeat(8193)])('rejects invalid summary JSON (%#)', input => {
    expect(() => parseDeliveryDrainSummary(input)).toThrow('SUMMARY_INVALID');
  });
  it.each([
    { ...quiet(), extra: 'synthetic-private-value' },
    { ...quiet(), pendingJobs: -1 }, { ...quiet(), pendingJobs: 0.5 },
    { ...quiet(), pendingJobs: '1' }, { ...quiet(), pendingJobs: Number.MAX_SAFE_INTEGER + 1 },
    { ...quiet(), claimableTargets: 1 },
    { ...quiet(), pendingJobs: Number.MAX_SAFE_INTEGER, claimableTargets: 1, duePendingTargets: 1 },
    { ...quiet(), invalidJobs: 1 }, { ...quiet(), invalidTargets: 1 },
  ])('rejects unknown, malformed or invalid state summary (%#)', input => {
    expect(() => parseDeliveryDrainSummary(JSON.stringify(input))).toThrow(/SUMMARY_INVALID/);
  });
  it('rejects missing summary fields', () => {
    const input: Partial<Summary> = quiet(); delete input.pendingJobs;
    expect(() => parseDeliveryDrainSummary(JSON.stringify(input))).toThrow('SUMMARY_INVALID');
  });
  it('keeps a validated summary immutable and retains only fixed numeric fields', () => {
    const parsed = parseDeliveryDrainSummary(raw(quiet()));
    expect(parsed).toEqual(quiet()); expect(Object.isFrozen(parsed)).toBe(true);
  });

  it.each([
    { value: '', error: 'synthetic-private-credential' },
    { value: '{}', error: '' }, { value: 'null', error: '' },
    { value: JSON.stringify({ items: [], suppressed: 0, blocked: 0, raw: 'secret' }), error: '' },
    { value: JSON.stringify({ items: [], suppressed: -1, blocked: 0 }), error: '' },
    { value: JSON.stringify({ items: [], suppressed: 11, blocked: 0 }), error: '' },
    { value: JSON.stringify({ items: [], suppressed: 6, blocked: 5 }), error: '' },
    { value: JSON.stringify({ items: [null], suppressed: 0, blocked: 0 }), error: '' },
    { value: JSON.stringify({ items: [{}], suppressed: 0, blocked: 0 }), error: '' },
    { value: JSON.stringify({ items: [{ ...workload(), credential: 'secret' }], suppressed: 0, blocked: 0 }), error: '' },
    { value: JSON.stringify({ items: [{ ...workload(), leaseVersion: 9 }], suppressed: 0, blocked: 0 }), error: '' },
    { value: JSON.stringify({ items: [{ ...workload(), targetId: 'not-uuid' }], suppressed: 0, blocked: 0 }), error: '' },
    { value: JSON.stringify({ items: [{ ...workload(), status: 'delivered' }], suppressed: 0, blocked: 0 }), error: '' },
    { value: JSON.stringify({ items: [{ ...workload(), leaseExpiresAt: 'bad' }], suppressed: 0, blocked: 0 }), error: '' },
    { value: JSON.stringify({ items: [{ ...workload(), reasonCode: 'unknown' }], suppressed: 0, blocked: 0 }), error: '' },
    { value: 'x'.repeat(131073), error: '' },
    { ...emptyClaim(), unknown: 'secret' },
  ])('rejects malformed or expanded claim envelopes (%#)', input => {
    expect(() => validateDeliveryDrainClaim(input)).toThrow(/CLAIM_(FAILED|INVALID)/);
  });

  it('reports only aggregate fields when a claim callback throws private raw text', async () => {
    const secret = 'synthetic-credential-pin-session';
    try {
      await drainNotificationDeliveryFixtures({ readSummary: () => raw(pending()), claim: () => { throw new Error(secret); } });
      throw new Error('Expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain('CLAIM_FAILED; passes=1;');
      expect(message).toContain('"pendingJobs":1'); expect(message).not.toContain(secret);
    }
  });
  it('never logs raw result/SQL errors or malformed read values', async () => {
    const secret = 'synthetic-credential-pin-session'; const report = vi.fn();
    await expect(drainNotificationDeliveryFixtures({ readSummary: () => raw(pending()), claim: () => ({ value: secret, error: secret }), report }))
      .rejects.toThrow('CLAIM_REJECTED; passes=1;');
    await expect(drainNotificationDeliveryFixtures({ readSummary: () => { throw new Error(secret); }, claim: () => emptyClaim(), report }))
      .rejects.toThrow('SUMMARY_READ_FAILED');
    await expect(drainNotificationDeliveryFixtures({ readSummary: () => secret, claim: () => emptyClaim(), report }))
      .rejects.toThrow('SUMMARY_INVALID');
    expect(report).not.toHaveBeenCalled();
  });
  it('fails a malformed post-claim recount instead of treating it as convergence', async () => {
    const snapshots = [raw(pending()), '']; const claim = vi.fn(() => emptyClaim());
    await expect(drainNotificationDeliveryFixtures({ readSummary: () => snapshots.shift(), claim })).rejects.toThrow('SUMMARY_INVALID');
    expect(claim).toHaveBeenCalledTimes(1);
  });
  it.each([
    {}, { readSummary: () => raw(quiet()) },
    { readSummary: () => raw(quiet()), claim: () => emptyClaim(), maxPasses: 1000 },
    { readSummary: () => raw(quiet()), claim: () => emptyClaim(), report: 'raw logger' },
  ])('rejects missing callbacks or unsupported budget options (%#)', async input => {
    await expect(drainNotificationDeliveryFixtures(input)).rejects.toThrow('DEPENDENCIES_INVALID');
  });
});

describe('isolated SQL predicate probe and existing concurrency integration', () => {
  const expected: Summary = {
    pendingJobs: 1, claimableTargets: 6, duePendingTargets: 2, dueRetryTargets: 2,
    expiredClaimTargets: 2, blockedDueTargets: 3, otherParentDueTargets: 4,
    futureTargets: 3, liveClaimTargets: 1, invalidJobs: 0, invalidTargets: 0,
  };
  it('checks the independent expected aggregate and does not expose unexpected rows', () => {
    expect(() => assertDeliveryDrainPredicateProbe(raw(expected))).not.toThrow();
    expect(() => assertDeliveryDrainPredicateProbe(raw({ ...expected, blockedDueTargets: 0 }))).toThrow('PREDICATE_PROBE_MISMATCH');
  });
  it('runs only temporary synthetic SQL then rolls back, with fixed table/time substitution', () => {
    expect(DELIVERY_DRAIN_PREDICATE_PROBE_SQL).toMatch(/^begin;/);
    expect(DELIVERY_DRAIN_PREDICATE_PROBE_SQL).toMatch(/rollback;$/);
    expect(DELIVERY_DRAIN_PREDICATE_PROBE_SQL.match(/create temporary table/g)).toHaveLength(2);
    expect(DELIVERY_DRAIN_PREDICATE_PROBE_SQL.match(/on commit drop/g)).toHaveLength(2);
    expect(DELIVERY_DRAIN_PREDICATE_PROBE_SQL).not.toMatch(/private\.|public\.|clock_timestamp\(\)|claim_notification|set_config|truncate|delete|grant|alter|disable/i);
    expect(DELIVERY_DRAIN_PREDICATE_PROBE_SQL).toContain("(2,'pending','2026-10-04T00:00:00Z',null)");
    expect(DELIVERY_DRAIN_PREDICATE_PROBE_SQL).toContain("(2,'claimed','2026-10-03T23:59:59Z','2026-10-04T00:00:00Z')");
    expect(DELIVERY_DRAIN_PREDICATE_PROBE_SQL).toContain("(3,'operator_blocked')");
  });
  it('connects the tested helper and SQL probe to the existing runner without executing Docker', () => {
    const source = readFileSync(new URL('../scripts/test-notification-delivery-concurrency.mjs', import.meta.url), 'utf8');
    expect(source).toContain("from './notification-delivery-fixture-drain.mjs'");
    expect(source).toContain('sql(DELIVERY_DRAIN_PREDICATE_PROBE_SQL)');
    expect(source).toContain('assertDeliveryDrainPredicateProbe(predicateProbe)');
    expect(source).toContain('await drainNotificationDeliveryFixtures({');
    expect(source).toContain('readSummary: () => sql(DELIVERY_DRAIN_SUMMARY_SQL)');
    expect(source).toMatch(/digest\(`drain:\$\{randomUUID\(\)\}`\)/);
    expect(source).not.toContain("assert(pass < 99, 'bounded delivery fixture drain converges')");
    expect(source).toContain('const crossRaceRounds = 6;');
    expect(source).toContain('parallel claim owns target exactly once:');
    expect(source).toContain('claim/resume cross races create one unique provider permit per round');
  });

  it.each([
    [1, 'PREDICATE_PROBE_EXECUTION_FAILED', true], [3, 'SUMMARY_READ_FAILED', true],
    [1, 'PREDICATE_PROBE_EXECUTION_FAILED', false], [3, 'SUMMARY_READ_FAILED', false],
  ])('real child stderr failure at call %s / %s / pipe=%s', async (failAt, code, pipe) => {
    const source = readFileSync(new URL('../scripts/test-notification-delivery-concurrency.mjs', import.meta.url), 'utf8');
    const program = source.replace(/^import[\s\S]*?from '[^']+';\r?$/gm, '')
      .replace('export async function testNotificationDeliveryConcurrency', 'async function testNotificationDeliveryConcurrency');
    // Negative control: remove pipe only from this in-memory runner copy. The
    // original file stays intact; it proves the old default leaks before catch.
    const controlledProgram = pipe ? program : program.replace(", stdio: 'pipe'", '');
    const privateText = 'synthetic-private-sql-error-pin-session';
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let calls = 0;
    const execute = vi.fn((_file, _args, options) => {
      calls += 1;
      if (calls === failAt) {
        // Substitute a harmless real Node child for Docker, but use the exact
        // stdio options received from the production test runner's sql().
        return execFileSync(process.execPath, ['-e', `process.stderr.write(${JSON.stringify(privateText)}); process.exit(1)`], options);
      }
      return calls === 1 ? raw(expected) : '';
    });
    try {
      const run = runInNewContext(`${controlledProgram}\ntestNotificationDeliveryConcurrency;`, {
        execFileSync: execute, execFile: vi.fn(), promisify, createHash, randomUUID, Buffer,
        assertDeliveryDrainPredicateProbe, DELIVERY_DRAIN_PREDICATE_PROBE_SQL,
        DELIVERY_DRAIN_SUMMARY_SQL, drainNotificationDeliveryFixtures,
      }, { timeout: 1000 });
      const client = {
        auth: { admin: { createUser: async () => ({ error: null }) } },
        from: () => ({ insert: async () => ({ error: null }) }),
        rpc: async () => ({ error: null }),
      };
      const error = await run(client).catch((value: Error) => value);
      expect(error.message).toBe(`Notification delivery fixture drain: ${code}`);
      expect(error.message).not.toContain(privateText);
      expect(calls).toBe(failAt);
      expect(execute.mock.calls.every(call => call[2].stdio === (pipe ? 'pipe' : undefined))).toBe(true);
      if (pipe) expect(stderr).not.toHaveBeenCalled();
      else expect(stderr.mock.calls.map(call => String(call[0])).join('')).toContain(privateText);
    } finally {
      stderr.mockRestore();
    }
  });
});
