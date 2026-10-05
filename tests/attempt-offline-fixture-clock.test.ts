import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const fixtureModule = '../scripts/test-attempt-offline-concurrency.mjs';
const {
  prepareAndStartOfflineFixture, offlineFixtureInputClockSQL, offlineFixtureStartSQL,
  offlineClockProbeSQL, offlineLockProbeSQL, offlineLockReadyPid, testAttemptOfflineConcurrency,
} = await import(fixtureModule);
const uuid = '00000000-0000-0000-0000-000000000001';
const input = () => ({
  p_actor_profile_id: uuid, p_session_id: uuid, p_attempt_id: uuid,
  p_expected_execution_version: 1, p_expected_assignment_id: uuid,
  p_expected_assignment_revision: 2, p_idempotency_key: uuid, p_request_hash: 'd'.repeat(64),
});
const source = readFileSync(new URL('../scripts/test-attempt-offline-concurrency.mjs', import.meta.url), 'utf8');

describe('#388 offline fixture preparation versus expiry clock', () => {
  it.each([
    ['execution', 7200000, 6001], ['metadata', 7776000000, 6001],
    ['execution', 7200000, 60000], ['metadata', 7776000000, 60000],
  ])('selects the %s issuance anchor (TTL %sms) only after %sms simulated setup', async (horizon, span, delay) => {
    // Simulated DB time is independent of the host clock. No real SQL/Auth/DB
    // executes here; the source contract below connects this seam to DB SQL.
    let dbNow = Date.parse('2026-10-04T14:59:58Z');
    const before = dbNow;
    const events: string[] = [];
    const rows = Object.freeze({ targetId: uuid, notifiedAt: new Date(dbNow - Number(span)).toISOString() });
    const prepare = async () => {
      for (const table of ['Auth', 'profile', 'room', 'target', 'assignment', 'attempt']) {
        events.push(table); dbNow += Number(delay) / 6;
      }
      return rows;
    };
    const start = vi.fn((prepared: typeof rows) => {
      expect(prepared).toBe(rows);
      expect(events).toEqual(['Auth', 'profile', 'room', 'target', 'assignment', 'attempt']);
      expect(offlineFixtureStartSQL(input(), horizon)).toContain('clock_timestamp()');
      const issuedAt = dbNow - Number(span) + 5000;
      events.push('DB clock/start');
      return { issuedAt, expiresAt: issuedAt + 7200000, metadataExpiresAt: issuedAt + 7776000000 };
    });
    const lease = await prepareAndStartOfflineFixture(prepare, start);
    expect(start).toHaveBeenCalledTimes(1);
    expect(dbNow - before).toBeCloseTo(Number(delay), 2);
    const deadline = horizon === 'execution' ? lease.expiresAt : lease.metadataExpiresAt;
    expect(deadline - dbNow).toBe(5000);
    expect(before - Number(span) + 5000 + Number(span)).toBeLessThan(dbNow); // old pre-setup anchor expires
    expect(lease.expiresAt - lease.issuedAt).toBe(7200000);
    expect(lease.metadataExpiresAt - lease.issuedAt).toBe(7776000000);
    expect(events.at(-1)).toBe('DB clock/start');
  });

  it('awaits all fixture preparation and does not issue a lease on setup failure', async () => {
    let complete: (value: object) => void = () => {};
    const preparation = new Promise<object>((resolve) => { complete = resolve; });
    const start = vi.fn((rows: object) => rows);
    const pending = prepareAndStartOfflineFixture(() => preparation, start);
    expect(start).not.toHaveBeenCalled();
    const rows = Object.freeze({ prepared: true }); complete(rows);
    expect(await pending).toBe(rows);
    expect(start).toHaveBeenCalledOnce();
    const deniedStart = vi.fn();
    await expect(prepareAndStartOfflineFixture(async () => { throw new Error('SETUP_FAILED'); }, deniedStart))
      .rejects.toThrow('SETUP_FAILED');
    expect(deniedStart).not.toHaveBeenCalled();
  });

  it('propagates failed start instead of silently renewing or retrying issuance', async () => {
    const start = vi.fn(() => { throw new Error('START_FAILED'); });
    await expect(prepareAndStartOfflineFixture(() => Promise.resolve({ ready: true }), start)).rejects.toThrow('START_FAILED');
    expect(start).toHaveBeenCalledOnce();
  });

  it.each([-1, 1.5, 10001, Number.NaN, Number.POSITIVE_INFINITY, '6000'])('rejects invalid preparation delay %s before creating Auth or business fixtures', async (delay) => {
    const createUser = vi.fn();
    const client = { supabaseUrl: 'http://localhost:54321', auth: { admin: { createUser } } };
    await expect(testAttemptOfflineConcurrency(client, { clockFixturePreparationDelayMs: delay }))
      .rejects.toThrow('bounded offline clock fixture preparation delay');
    expect(createUser).not.toHaveBeenCalled();
  });

  it.each([['execution', '2 hours'], ['metadata', '90 days']])('uses one DB clock and exact five-second %s anchor', (horizon, span) => {
    const statement = offlineFixtureStartSQL(input(), horizon);
    expect(statement).toContain('with fixture_clock as materialized (select clock_timestamp() as at_time)');
    expect(statement.match(/clock_timestamp\(\)/g)).toHaveLength(1);
    expect(statement).toContain(`fixture_clock.at_time-interval '${span}'+interval '5 seconds'`);
    expect(statement).toContain('select private.start_attempt_with_lease_at(');
    expect(statement).not.toMatch(/Date\.now|current_timestamp|statement_timestamp|\b(update|alter|disable|delete)\b/i);
    const businessClock = offlineFixtureInputClockSQL(horizon);
    expect(businessClock).toBe(`select to_json(clock_timestamp()-interval '${span}');`);
    expect(businessClock).not.toContain('5 seconds');
  });

  it.each(['unknown', 'constructor', '__proto__', "execution'; select 1; --"])('rejects unsupported horizon %s', (horizon) => {
    expect(() => offlineFixtureStartSQL(input(), horizon)).toThrow('fixed offline clock horizon');
    expect(() => offlineFixtureInputClockSQL(horizon)).toThrow('fixed offline clock horizon');
    expect(() => offlineClockProbeSQL(uuid, horizon)).toThrow('fixed offline clock horizon');
  });

  it.each(['p_actor_profile_id', 'p_session_id', 'p_attempt_id', 'p_expected_assignment_id', 'p_idempotency_key'])('rejects unsafe fixture %s', (key) => {
    expect(() => offlineFixtureStartSQL({ ...input(), [key]: "'; select 1; --" }, 'execution')).toThrow('fixed offline fixture UUID');
  });

  it.each([
    { p_expected_execution_version: 2 }, { p_expected_assignment_revision: 3 }, { p_request_hash: "'; select 1; --" },
  ])('keeps original start CAS/hash shape for %j', (invalid) => {
    expect(() => offlineFixtureStartSQL({ ...input(), ...invalid }, 'execution')).toThrow('fixed offline fixture start');
  });

  it.each([['execution', 'expires_at'], ['metadata', 'metadata_expires_at']])('observes the actual %s DB deadline without host clock dependence', (horizon, column) => {
    const statement = offlineClockProbeSQL(uuid, horizon);
    expect(statement).toContain(`lease.${column}>fixture_clock.at_time`);
    expect(statement).toContain(`extract(epoch from (lease.${column}-fixture_clock.at_time))*1000`);
    expect(statement.match(/clock_timestamp\(\)/g)).toHaveLength(1);
    expect(statement).not.toMatch(/\b(update|alter|disable|delete)\b/i);
    expect(() => offlineClockProbeSQL("bad'", horizon)).toThrow('fixed offline fixture UUID');
  });

  it('ties the real public RPC waiter to the exact fixture holder, not any matching RPC lock', () => {
    const statement = offlineLockProbeSQL('sync_cleaning_attempt_event', 1234);
    expect(statement).toContain("state='active'");
    expect(statement).toContain("wait_event_type='Lock'");
    expect(statement).toContain("query like '%sync_cleaning_attempt_event%'");
    expect(statement).toContain('1234=any(pg_blocking_pids(pid))');
    expect(statement).not.toMatch(/\b(update|alter|disable|delete)\b/i);
    expect(() => offlineLockProbeSQL("unsafe'", 1234)).toThrow('fixed offline lock filter');
    for (const pid of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => offlineLockProbeSQL('sync_cleaning_attempt_event', pid)).toThrow('fixed offline lock filter');
    }
  });

  it('waits for the complete PID line even when stdout splits its digits across chunks', () => {
    expect(offlineLockReadyPid('synthetic-row\nLOCK_READY:12')).toBeNull();
    expect(offlineLockReadyPid('synthetic-row\nLOCK_READY:1234\n')).toBe(1234);
    expect(offlineLockReadyPid('LOCK_READY:1234\r')).toBeNull();
    expect(offlineLockReadyPid('LOCK_READY:1234\r\n')).toBe(1234);
    for (const output of ['LOCK_READY:0\n', 'LOCK_READY:-1\n', 'LOCK_READY:9007199254740992\n', 'LOCK_READY:NaN\n']) {
      expect(offlineLockReadyPid(output)).toBeNull();
    }
    expect(source).toContain('const pid = offlineLockReadyPid(output);');
  });

  it.each([
    ['KST day', '2026-10-04T16:59:58Z', 7200000],
    ['KST week', '2026-10-04T14:59:58Z', 7776000000],
  ])('preserves historical business inputs during a %s crossing without rebinding issued clocks', async (_boundary, preparedAt, span) => {
    let dbNow = Date.parse(String(preparedAt));
    const kstDay = (at: number) => new Date(at + 9 * 3600000).toISOString().slice(0, 10);
    const setupDay = kstDay(dbNow - Number(span));
    const rows = Object.freeze({ day: setupDay, notifiedAt: new Date(dbNow - Number(span)).toISOString() });
    const issued = await prepareAndStartOfflineFixture(async () => {
      dbNow += 6001; return rows;
    }, (prepared: typeof rows) => {
      expect(prepared).toBe(rows);
      return dbNow - Number(span) + 5000;
    });
    const nextDay = new Date(Date.parse(`${setupDay}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    expect(kstDay(issued)).toBe(nextDay);
    expect(rows.day).toBe(setupDay);
    expect(rows.notifiedAt).toBe(new Date(Date.parse(String(preparedAt)) - Number(span)).toISOString());
    const overdue = readFileSync(new URL('../supabase/migrations/20261001001449_cleaning_overdue_preserve_work.sql', import.meta.url), 'utf8');
    expect(overdue).toContain("if p_target.effective_service_date < v_today then return ''CLEANING_SERVICE_DATE_EXPIRED''; end if;', ''");
    expect(overdue).toContain("if p_target.due_at is not null and p_target.due_at <= p_command_at then return ''CLEANING_WINDOW_EXPIRED''; end if;', ''");
  });

  it('connects preparation, DB start, observed live lock crossing, and immutable clock checks in the real runner', () => {
    const prepare = source.slice(source.indexOf('async function prepareFixture'), source.indexOf('async function fixture('));
    expect(prepare).toContain("await account('maid')");
    for (const table of ['rooms', 'cleaning_targets', 'cleaning_assignments', 'cleaning_attempts']) {
      expect(prepare).toContain(`await client.from('${table}').insert`);
    }
    expect(prepare).toContain('sql(offlineFixtureInputClockSQL(horizon))');
    expect(prepare.indexOf('clockFixturePreparationDelayMs));')).toBeGreaterThan(prepare.indexOf("client.from('cleaning_attempts').insert"));
    expect(source).toContain('clockFixturePreparationDelayMs <= 10000');
    expect(source).toContain('prepareAndStartOfflineFixture(() => prepareFixture(horizon), async (prepared) => {');
    expect(source).toContain('sql(offlineFixtureStartSQL(input, horizon))');
    expect(source).toContain('const item = await fixture(horizon);');
    expect(source).not.toMatch(/Date\.now\(\) - span \+ 5000|fixture\(new Date\(Date\.now\(\) -/);
    expect(source).toContain('initialClock.live && initialClock.remainingMs > 0 && initialClock.remainingMs <= 5000');
    expect(source).toContain('await waitForLock(rpcName, release.backendPid)');
    expect(source).toContain('blockedClock.live && blockedClock.remainingMs > 0');
    expect(source).toContain("assert(sql(offlineLockProbeSQL(rpcName, release.backendPid)) === 't'");
    expect(source).toContain("assert(readClock().live === false");
    expect(source).toContain("assert(immutableClock() === 't', 'waiting never rewrites the original issued lease clocks')");
    expect(source).toContain("result.data.outcome === 'quarantined' && result.data.reasonCode === 'LEASE_EXPIRED'");
    expect(source).toContain("result.error?.message === 'OFFLINE_EVENT_EXPIRED'");
    expect(source).toContain("'OFFLINE_EVENT_EXPIRED', 'OFFLINE_LEASE_UNKNOWN'");
    expect(source).toContain("'SESSION_REVOKED'");
    expect(source).toContain('for (let i = 0; i < 50; i += 1)');
    expect(source).toContain("set local idle_in_transaction_session_timeout='15s'");
    expect(source).not.toMatch(/update\s+private\.offline_work_leases|disable\s+trigger|\.skip\(/i);
  });
});
