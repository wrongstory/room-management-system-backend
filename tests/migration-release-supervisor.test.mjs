import { describe, expect, it, vi } from 'vitest';
import { prepareMigrationRelease, validateMigrationApprovalReceipt } from '../scripts/lib/migration-release-preflight.mjs';
import { superviseMigrationRelease } from '../scripts/lib/migration-release-supervisor.mjs';

let counter = 0;
const hash = number => number.toString(16).padStart(64, '0');
const state = number => ({ coverageSha256: hash(1), catalogSha256: hash(number), dataSha256: hash(number + 1), sequencesSha256: hash(number + 2) });
function fixture(overallMs = 10_000, statementMs = 1_000) {
  counter += 1;
  const projectRef = 'a'.repeat(18) + String.fromCharCode(97 + Math.floor(counter / 26), 97 + counter % 26);
  const source = { projectRef, sourceRef: 'refs/heads/main', headSha1: 'a'.repeat(40), treeSha1: 'b'.repeat(40), manifestSha256: hash(10), historySha256: hash(11) };
  const history = [{ version: '20260101000000', name: 'baseline', statementsSha256: hash(12) }];
  const first = { version: '20260102000000', name: 'first', sqlSha256: hash(13), statementsSha256: hash(14), statementSha256s: [hash(15), hash(16)], preHistorySha256: hash(11), postHistorySha256: hash(17), preState: state(20), postState: state(30) };
  const second = { version: '20260103000000', name: 'second', sqlSha256: hash(40), statementsSha256: hash(41), statementSha256s: [hash(42)], preHistorySha256: hash(17), postHistorySha256: hash(43), preState: state(30), postState: state(50) };
  return { repository: 'wrongstory/room-management-system-backend', policy: { expectedSource: source, observedSource: structuredClone(source), expectedHistory: history, observedHistory: structuredClone(history), pending: [first, second], observedPending: structuredClone([first, second]), budget: { overallMs, statementMs, lockMs: Math.max(1, Math.floor(statementMs / 4)), idleTransactionMs: statementMs } },
    remote: { repository: 'wrongstory/room-management-system-backend', ...source, mergedReleasePr: 500, application: 'PASS', migration: 'FULL_DB_PASS', independentReview: 'PASS' }, validationFingerprint: hash(60), recoveryEvidenceSha256: hash(61) };
}
const authorize = ({ requestSha256, runId }) => ({ requestSha256, runId, issuedAtMs: Date.now(), expiresAtMs: Date.now() + 60_000, action: 'APPLY_EXACT_MIGRATIONS_ONCE' });
function adapters(options = {}) {
  const calls = []; const sessions = [];
  const openSession = vi.fn(async context => {
    const { migration, modelSource, expectedHistory, runId } = context;
    calls.push(`${migration.name}:open`);
    const identity = { pid: 123, backendStart: '2026-10-25T00:00:00.000001Z', databaseOid: 1, roleOid: 2, runId, connectionMode: 'direct' };
    const action = name => {
      calls.push(`${migration.name}:${name}`);
      if (options.failAt === name) throw new Error('sensitive-secret-sql-error');
      if (options.hangAt === name) return new Promise(() => {});
    };
    const session = { identity,
      begin: async () => { await action('begin'); return { modelSource, historySha256: migration.preHistorySha256, history: expectedHistory,
        state: options.prestateMismatch ? state(99) : migration.preState, backend: { identity, transactionStatus: 'IN_TRANSACTION' } }; },
      executeStatement: ({ statementIndex }) => action(`sql${statementIndex}`),
      recordHistory: () => action('history'), commit: () => action('commit'),
      abort: vi.fn(() => calls.push(`${migration.name}:abort`)), close: vi.fn(() => action('close')),
      readback: async () => {
        action('readback');
        const applied = options.classification !== 'NOT_APPLIED';
        return { verification: 'VERIFIED', snapshotKind: 'INDEPENDENT_COMMITTED_SNAPSHOT', modelSource,
          historySha256: applied ? migration.postHistorySha256 : migration.preHistorySha256,
          history: applied ? [...expectedHistory, { version: migration.version, name: migration.name, statementsSha256: migration.statementsSha256 }] : expectedHistory,
          state: options.classification === 'UNKNOWN' ? state(99) : applied ? migration.postState : migration.preState,
          backend: { verification: 'VERIFIED', identity, status: options.backendStatus ?? 'DEFINITIVELY_GONE', transactionStatus: 'NO_BACKEND' } };
      } };
    sessions.push(session); return session;
  });
  return { openSession, calls, sessions };
}

describe('#378 exact remote/approval input consistency', () => {
  it('binds the entire request and never claims authentication from caller facts', () => {
    const value = fixture(); const request = prepareMigrationRelease(value);
    expect(request).toMatchObject({ pendingCount: 2, remoteEvidenceAuthenticated: false, approvalAuthenticated: false });
    const changed = structuredClone(value); changed.recoveryEvidenceSha256 = hash(62);
    expect(prepareMigrationRelease(changed).requestSha256).not.toBe(request.requestSha256);
  });
  it.each([
    value => { value.remote.migration = 'MANIFEST_PASS'; }, value => { value.remote.headSha1 = 'f'.repeat(40); },
    value => { value.remote.independentReview = 'NOT_RUN'; }, value => { value.remote.mergedReleasePr = null; },
    value => { value.repository = 'other/repo'; }, value => { value.validationFingerprint = ''; },
    value => { value.policy.observedPending.reverse(); }, value => { value.policy.budget.overallMs = 120001; },
  ])('rejects incomplete evidence without opening a connection %#', change => {
    const value = fixture(); change(value); expect(() => prepareMigrationRelease(value)).toThrow('MIGRATION_RELEASE_PREFLIGHT_FAILED');
  });
  it.each(['requestSha256', 'runId', 'action', 'issuedAtMs', 'expiresAtMs'])('rejects stale or different receipt field %s', key => {
    const request = prepareMigrationRelease(fixture()); const runId = '10000000-0000-4000-8000-000000000001';
    const receipt = authorize({ requestSha256: request.requestSha256, runId });
    receipt[key] = key === 'expiresAtMs' ? Date.now() - 1 : key === 'issuedAtMs' ? Date.now() + 10000 : 'wrong';
    expect(() => validateMigrationApprovalReceipt({ request, receipt, runId, nowMs: Date.now() })).toThrow('MIGRATION_RELEASE_APPROVAL_MISMATCH');
  });
});

describe('#378 finite sequential trusted-adapter supervisor (memory only)', () => {
  it('executes SQL then history then commit then independent readback before the next migration', async () => {
    const request = prepareMigrationRelease(fixture()); const io = adapters();
    const result = await superviseMigrationRelease({ request, authorize, openSession: io.openSession });
    expect(result).toMatchObject({ classification: 'APPLIED', appliedCount: 2, code: 'MIGRATION_SUPERVISOR_COMPLETE', retryAllowed: false });
    expect(io.calls).toEqual(['first:open', 'first:begin', 'first:sql0', 'first:sql1', 'first:history', 'first:commit', 'first:readback', 'first:close',
      'second:open', 'second:begin', 'second:sql0', 'second:history', 'second:commit', 'second:readback', 'second:close']);
    await expect(superviseMigrationRelease({ request, authorize, openSession: io.openSession })).rejects.toThrow('MIGRATION_SUPERVISOR_REQUEST_CONSUMED');
  });
  it.each(['begin', 'sql0', 'history', 'commit'])('reconciles lost %s without retransmission', async failAt => {
    const io = adapters({ failAt, classification: 'NOT_APPLIED' });
    const result = await superviseMigrationRelease({ request: prepareMigrationRelease(fixture()), authorize, openSession: io.openSession });
    expect(result).toMatchObject({ classification: 'NOT_APPLIED', appliedCount: 0, retryAllowed: false });
    expect(io.openSession).toHaveBeenCalledTimes(1); expect(io.calls.filter(call => call === `first:${failAt}`)).toHaveLength(1);
    expect(io.calls).toContain('first:readback'); expect(JSON.stringify(result)).not.toContain('sensitive');
  });
  it('advances after a lost commit only when exact post-state is observed', async () => {
    const io = adapters({ failAt: 'commit' });
    expect(await superviseMigrationRelease({ request: prepareMigrationRelease(fixture()), authorize, openSession: io.openSession })).toMatchObject({ classification: 'APPLIED', appliedCount: 2 });
    expect(io.calls.filter(call => call.endsWith(':commit'))).toHaveLength(2);
  });
  it.each([{ classification: 'UNKNOWN' }, { backendStatus: 'PID_REUSED' }, { failAt: 'readback' }, { failAt: 'close' }])('stops on ambiguous readback/ownership/close %#', async options => {
    const io = adapters(options); const result = await superviseMigrationRelease({ request: prepareMigrationRelease(fixture()), authorize, openSession: io.openSession });
    expect(result.code).not.toBe('MIGRATION_SUPERVISOR_COMPLETE'); expect(io.openSession).toHaveBeenCalledTimes(1); expect(result.retryAllowed).toBe(false);
  });
  it('refuses authority mismatch before opening any session', async () => {
    const io = adapters(); const result = await superviseMigrationRelease({ request: prepareMigrationRelease(fixture()), authorize: context => ({ ...authorize(context), requestSha256: hash(99) }), openSession: io.openSession });
    expect(result.code).toBe('MIGRATION_SUPERVISOR_STOPPED'); expect(io.openSession).not.toHaveBeenCalled();
  });
  it('checks the live pre-state in the writer transaction before any SQL or history command', async () => {
    const io = adapters({ prestateMismatch: true });
    const result = await superviseMigrationRelease({ request: prepareMigrationRelease(fixture()), authorize, openSession: io.openSession });
    expect(result).toMatchObject({ classification: 'UNKNOWN', code: 'MIGRATION_SUPERVISOR_PRESTATE_MISMATCH', appliedCount: 0 });
    expect(io.calls.some(call => call.includes(':sql') || call.includes(':history') || call.includes(':commit'))).toBe(false);
    expect(io.openSession).toHaveBeenCalledTimes(1);
  });
  it('enforces a real finite operation timer and aborts only the returned owned session', async () => {
    const io = adapters({ hangAt: 'sql0', classification: 'UNKNOWN' });
    const result = await superviseMigrationRelease({ request: prepareMigrationRelease(fixture(2000, 50)), authorize, openSession: io.openSession });
    expect(result.classification).toBe('UNKNOWN'); expect(io.sessions[0].abort).toHaveBeenCalled();
    expect(io.openSession).toHaveBeenCalledTimes(1); expect(result.elapsedMs).toBeLessThan(2000);
  });
  it('rejects concurrent execution of a different request on the same target', async () => {
    const value = fixture(2000, 50); const request = prepareMigrationRelease(value); const io = adapters({ hangAt: 'sql0', classification: 'UNKNOWN' });
    const running = superviseMigrationRelease({ request, authorize, openSession: io.openSession });
    const other = structuredClone(value); other.recoveryEvidenceSha256 = hash(75);
    await expect(superviseMigrationRelease({ request: prepareMigrationRelease(other), authorize, openSession: io.openSession })).rejects.toThrow('MIGRATION_SUPERVISOR_REQUEST_CONSUMED');
    await running;
  });
});
