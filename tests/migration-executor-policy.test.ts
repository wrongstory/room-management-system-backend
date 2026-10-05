import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

type Source = { projectRef: string; sourceRef: string; headSha1: string; treeSha1: string; manifestSha256: string; historySha256: string };
type Digest = { coverageSha256: string; catalogSha256: string; dataSha256: string; sequencesSha256: string };
type History = { version: string; name: string; statementsSha256: string };
type Migration = History & { sqlSha256: string; statementSha256s: string[]; preHistorySha256: string; postHistorySha256: string; preState: Digest; postState: Digest };
type Backend = { pid: number; backendStart: string; databaseOid: number; roleOid: number; runId: string; connectionMode: string };
type Fixture = {
  expectedSource: Source; observedSource: Source; expectedHistory: History[]; observedHistory: History[];
  pending: Migration[]; observedPending: Migration[];
  budget: { overallMs: number; statementMs: number; lockMs: number; idleTransactionMs: number };
};
type Observation = {
  verification: string; snapshotKind: string; modelSource: Source; historySha256: string; history: History[]; state: Digest;
  backend: { verification: string; identity: Backend; status: string; transactionStatus: string };
};
type Snapshot = {
  mode: string; executionAllowed: false; retryAllowed: false; pidTerminationAllowed: false;
  phase: string; classification: string | null; code: string; terminal: boolean; nextStatementIndex: number;
  startedAtMs: number; lastClockMs: number; deadlineMs: number; phaseDeadlineMs: number | null;
};
type BudgetSnapshot = {
  mode: string; executionAllowed: false; remainingMs: number; statementMs: number; lockMs: number;
  idleTransactionMs: number; transactionTimeoutSupported: false;
};
type Run = { snapshot(): Snapshot; transition(event: unknown, nowMs: unknown): Snapshot; observe(value: unknown, nowMs: unknown): Snapshot; nextStatementBudget(nowMs: unknown): Snapshot | BudgetSnapshot };
type Policy = {
  MIGRATION_POLICY_MODE: string; PG15_TRANSACTION_TIMEOUT_SUPPORTED: false; PID_ONLY_TERMINATION_ALLOWED: false;
  createMigrationPolicyModel(input: unknown): Readonly<{ mode: string; executionAllowed: false; pendingCount: number }>;
  startMigrationPolicyModel(plan: unknown, backend: unknown, startedAtMs: unknown): Run;
};

// A typed dynamic ESM boundary keeps the owned change to three files. No type
// suppression or new declaration/package file; runtime shape is tested below.
const moduleUrl = new URL('../scripts/lib/migration-executor-policy.mjs', import.meta.url);
const policy = await import(moduleUrl.href) as Policy;
const h = (number: number) => number.toString(16).padStart(64, '0');
const clone = <T>(value: T): T => structuredClone(value);
const mutable = (value: object) => value as Record<string, unknown>;

function digest(number: number): Digest {
  return { coverageSha256: h(1), catalogSha256: h(number), dataSha256: h(number + 1), sequencesSha256: h(number + 2) };
}

function fixture(): Fixture {
  const source: Source = {
    projectRef: 'abcdefghijklmnopqrst', sourceRef: 'refs/heads/release/v0.9.0', headSha1: 'a'.repeat(40),
    treeSha1: 'b'.repeat(40), manifestSha256: h(10), historySha256: h(11),
  };
  const history: History[] = [{ version: '20260101000000', name: 'synthetic_baseline', statementsSha256: h(12) }];
  const first: Migration = { version: '20260102000000', name: 'synthetic_first', sqlSha256: h(13), statementsSha256: h(14),
    statementSha256s: [h(15), h(16)], preHistorySha256: h(11), postHistorySha256: h(17), preState: digest(20), postState: digest(30) };
  const second: Migration = { version: '20260103000000', name: 'synthetic_second', sqlSha256: h(40), statementsSha256: h(41),
    statementSha256s: [h(42)], preHistorySha256: h(17), postHistorySha256: h(43), preState: digest(30), postState: digest(50) };
  return { expectedSource: source, observedSource: clone(source), expectedHistory: history, observedHistory: clone(history),
    pending: [first, second], observedPending: clone([first, second]), budget: { overallMs: 1000, statementMs: 200, lockMs: 50, idleTransactionMs: 100 } };
}

function owned(): Backend {
  return { pid: 321, backendStart: '2030-01-02T03:04:05.123456+00:00', databaseOid: 100, roleOid: 200,
    runId: '10000000-0000-4000-8000-000000000001', connectionMode: 'direct' };
}

function first(data: Fixture): Migration {
  const value = data.pending[0];
  if (!value) throw new Error('SYNTHETIC_FIXTURE_MISSING');
  return value;
}

function events(data: Fixture) {
  const current = first(data);
  return [
    { type: 'BEGIN' }, { type: 'BEGIN_ACK' },
    { type: 'SQL', statementIndex: 0, statementSha256: current.statementSha256s[0] }, { type: 'SQL_ACK' },
    { type: 'SQL', statementIndex: 1, statementSha256: current.statementSha256s[1] }, { type: 'SQL_ACK' },
    { type: 'HISTORY', version: current.version, name: current.name, statementsSha256: current.statementsSha256, historySha256: current.postHistorySha256 },
    { type: 'HISTORY_ACK' }, { type: 'COMMIT' }, { type: 'COMMIT_ACK' }, { type: 'READBACK' },
  ];
}

function model(data = fixture(), identity = owned(), start = 0) {
  return policy.startMigrationPolicyModel(policy.createMigrationPolicyModel(data), identity, start);
}

function drive(run: Run, data: Fixture, until = 'READBACK_SENT', start = 0) {
  let now = start;
  if (until === 'READY') return now;
  for (const event of events(data)) {
    now += 1;
    const result = run.transition(event, now);
    expect(result.terminal).toBe(false);
    if (result.phase === until) return now;
  }
  throw new Error('SYNTHETIC_PHASE_MISSING');
}

function observation(data: Fixture, kind: 'post' | 'pre' = 'post', identity = owned()): Observation {
  const current = first(data);
  return {
    verification: 'VERIFIED', snapshotKind: 'INDEPENDENT_COMMITTED_SNAPSHOT', modelSource: clone(data.expectedSource),
    historySha256: kind === 'post' ? current.postHistorySha256 : current.preHistorySha256,
    history: kind === 'post' ? [...clone(data.expectedHistory), { version: current.version, name: current.name, statementsSha256: current.statementsSha256 }] : clone(data.expectedHistory),
    state: clone(kind === 'post' ? current.postState : current.preState),
    backend: { verification: 'VERIFIED', identity: clone(identity), status: 'DEFINITIVELY_GONE', transactionStatus: 'NO_BACKEND' },
  };
}

describe('#378 pure migration policy boundary', () => {
  it('has no operational entry point, IO, credential, native error, or parser facade', async () => {
    expect(Object.keys(policy).sort()).toEqual(['MIGRATION_POLICY_MODE', 'PG15_TRANSACTION_TIMEOUT_SUPPORTED', 'PID_ONLY_TERMINATION_ALLOWED', 'createMigrationPolicyModel', 'startMigrationPolicyModel'].sort());
    const source = await readFile(moduleUrl, 'utf8');
    expect(source).not.toMatch(/(?:\bimport\s|\bprocess\.|\bfetch\s*\(|\bsetTimeout\s*\(|\bDate\.now\s*\(|\bperformance\.)/u);
    expect(source).not.toMatch(/(?:child_process|node:fs|node:net|node:tls|Deno\.|executeSql|dbPush|pg_terminate_backend)/u);
    expect(policy.PG15_TRANSACTION_TIMEOUT_SUPPORTED).toBe(false);
    expect(policy.PID_ONLY_TERMINATION_ALLOWED).toBe(false);
    const plan = policy.createMigrationPolicyModel(fixture());
    expect(plan).toEqual({ mode: 'POLICY_MODEL_ONLY', executionAllowed: false, pendingCount: 2 });
    expect(Object.isFrozen(plan)).toBe(true);
  });

  it.each(['approved', 'backupVerified', 'executionAllowed', 'releaseMerged'])('rejects a self-asserted operational gate %s', (field) => {
    const data = fixture();
    mutable(data)[field] = true;
    expect(() => policy.createMigrationPolicyModel(data)).toThrow('POLICY_INPUT_INVALID');
  });

  it('rejects a forged or serialized plan handle', () => {
    const plan = policy.createMigrationPolicyModel(fixture());
    expect(() => policy.startMigrationPolicyModel({ ...plan }, owned(), 0)).toThrow('POLICY_PLAN_NOT_OWNED');
    expect(() => policy.startMigrationPolicyModel(JSON.parse(JSON.stringify(plan)), owned(), 0)).toThrow('POLICY_PLAN_NOT_OWNED');
  });

  it.each(['projectRef', 'sourceRef', 'headSha1', 'treeSha1', 'manifestSha256', 'historySha256'] as const)('compares exact source field %s independently', (field) => {
    const data = fixture();
    data.observedSource[field] = field === 'projectRef' ? 'z'.repeat(20) : field === 'sourceRef' ? 'refs/heads/main' : 'c'.repeat(field.endsWith('Sha1') ? 40 : 64);
    expect(() => policy.createMigrationPolicyModel(data)).toThrow('POLICY_SOURCE_MISMATCH');
  });

  it.each(['refs/heads/dev', 'refs/heads/codex/378-test', 'main', 'release/v0.9.0', 'refs/tags/v0.9.0', 'refs/heads/release/v0.9'])('rejects non-final source ref %s', (ref) => {
    const data = fixture();
    data.expectedSource.sourceRef = ref;
    data.observedSource.sourceRef = ref;
    expect(() => policy.createMigrationPolicyModel(data)).toThrow('POLICY_SOURCE_REF_NOT_RELEASE_OR_MAIN');
  });

  it('accepts main as a model identity, never as proof of protected merge', () => {
    const data = fixture();
    data.expectedSource.sourceRef = 'refs/heads/main';
    data.observedSource.sourceRef = 'refs/heads/main';
    expect(policy.createMigrationPolicyModel(data).executionAllowed).toBe(false);
  });

  it.each(['version', 'name', 'statementsSha256'] as const)('rejects existing history %s drift without repair', (field) => {
    const data = fixture();
    const row = data.observedHistory[0];
    if (!row) throw new Error('SYNTHETIC_FIXTURE_MISSING');
    row[field] = field === 'version' ? '20260101000001' : field === 'name' ? 'synthetic_other' : h(999);
    expect(() => policy.createMigrationPolicyModel(data)).toThrow('POLICY_HISTORY_MISMATCH');
  });

  it.each(['missing', 'duplicate', 'additional', 'reordered'])('rejects %s hosted history', (kind) => {
    const data = fixture();
    const original = data.expectedHistory[0];
    if (!original) throw new Error('SYNTHETIC_FIXTURE_MISSING');
    if (kind === 'missing') data.observedHistory = [];
    if (kind === 'duplicate') data.observedHistory.push(clone(original));
    if (kind === 'additional') data.observedHistory.push({ version: '20260101000001', name: 'synthetic_extra', statementsSha256: h(99) });
    if (kind === 'reordered') {
      data.expectedHistory.push({ version: '20260101000001', name: 'synthetic_extra', statementsSha256: h(99) });
      data.observedHistory = clone(data.expectedHistory).reverse();
    }
    expect(() => policy.createMigrationPolicyModel(data)).toThrow(/POLICY_HISTORY_(?:MISMATCH|ORDER_INVALID)/u);
  });

  it.each(['version', 'name', 'sqlSha256', 'statementsSha256', 'preHistorySha256', 'postHistorySha256'] as const)('rejects pending %s mismatch', (field) => {
    const data = fixture();
    const row = data.observedPending[0];
    if (!row) throw new Error('SYNTHETIC_FIXTURE_MISSING');
    row[field] = field === 'version' ? '20260102000001' : field === 'name' ? 'synthetic_other' : h(999);
    expect(() => policy.createMigrationPolicyModel(data)).toThrow('POLICY_PENDING_MISMATCH');
  });

  it.each(['missing', 'additional', 'reordered', 'duplicate', 'applied-version', 'applied-name', 'statement-missing', 'statement-changed', 'empty-statement'])('rejects %s pending plan', (kind) => {
    const data = fixture();
    if (kind === 'missing') data.observedPending.pop();
    if (kind === 'additional') data.observedPending.push({ ...clone(first(data)), version: '20260104000000', name: 'synthetic_extra' });
    if (kind === 'reordered') data.observedPending.reverse();
    if (kind === 'duplicate') data.observedPending.push(clone(first(data)));
    if (kind === 'applied-version') first(data).version = '20260101000000';
    if (kind === 'applied-name') first(data).name = 'synthetic_baseline';
    if (kind === 'statement-missing') data.observedPending[0]?.statementSha256s.pop();
    if (kind === 'statement-changed') { const row = data.observedPending[0]; if (row) row.statementSha256s[0] = h(999); }
    if (kind === 'empty-statement') first(data).statementSha256s = [];
    if (kind.startsWith('applied-') || kind === 'empty-statement') data.observedPending = clone(data.pending);
    expect(() => policy.createMigrationPolicyModel(data)).toThrow(/POLICY_PENDING_(?:MISMATCH|ORDER_INVALID|INVALID)/u);
  });

  it.each(['history', 'catalog', 'data', 'sequences', 'coverage'])('rejects discontinuous inter-migration %s chain', (field) => {
    const data = fixture();
    const second = data.pending[1];
    if (!second) throw new Error('SYNTHETIC_FIXTURE_MISSING');
    if (field === 'history') second.preHistorySha256 = h(999);
    else mutable(second.preState)[`${field}Sha256`] = h(999);
    data.observedPending = clone(data.pending);
    expect(() => policy.createMigrationPolicyModel(data)).toThrow('POLICY_CHAIN_MISMATCH');
  });

  it('does not silently normalize SQL or hosted history content hashes', () => {
    const data = fixture();
    first(data).sqlSha256 = 'A'.repeat(64);
    data.observedPending = clone(data.pending);
    expect(() => policy.createMigrationPolicyModel(data)).toThrow('POLICY_PENDING_INVALID');
  });

  it('copies nested snapshots, statements, history and backend identity instead of holding mutable input', () => {
    const data = fixture();
    const exact = clone(data);
    const identity = owned();
    const run = model(data, identity);
    data.expectedSource.headSha1 = 'c'.repeat(40);
    first(data).statementSha256s[0] = h(999);
    first(data).postState.dataSha256 = h(999);
    data.expectedHistory.length = 0;
    identity.pid = 999;
    const now = drive(run, exact);
    expect(run.observe(observation(exact), now + 1).classification).toBe('APPLIED');
    const snapshot = run.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => { mutable(snapshot).executionAllowed = true; }).toThrow();
    expect(run.snapshot().executionAllowed).toBe(false);
  });

  it.each([null, undefined, new Date(), [], Object.create({ approved: true })])('rejects non-data model input %#', (input) => {
    expect(() => policy.createMigrationPolicyModel(input)).toThrow('POLICY_INPUT_INVALID');
  });

  it('rejects getters without invoking them and strips native/proxy failures', () => {
    let invoked = 0;
    const data = fixture();
    Object.defineProperty(data, 'expectedSource', { enumerable: true, get() { invoked += 1; return fixture().expectedSource; } });
    expect(() => policy.createMigrationPolicyModel(data)).toThrow('POLICY_INPUT_INVALID');
    expect(invoked).toBe(0);
    const sentinel = 'SYNTHETIC_NATIVE_SECRET_SENTINEL';
    const proxy = new Proxy({}, { getPrototypeOf() { throw new Error(sentinel); } });
    try { policy.createMigrationPolicyModel(proxy); throw new Error('SYNTHETIC_EXPECTED_FAILURE'); }
    catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('POLICY_INPUT_INVALID');
      expect(String((error as Error).stack)).not.toContain(sentinel);
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it('rejects sparse arrays, getter elements, extra array keys and symbols', () => {
    for (const kind of ['sparse', 'getter', 'extra', 'symbol']) {
      const data = fixture();
      if (kind === 'sparse') delete mutable(data.observedHistory)['0'];
      if (kind === 'getter') Object.defineProperty(data.observedHistory, '0', { enumerable: true, get: () => { throw new Error('SYNTHETIC_GETTER'); } });
      if (kind === 'extra') mutable(data.observedHistory).extra = true;
      if (kind === 'symbol') Object.defineProperty(data, Symbol('extra'), { value: true, enumerable: true });
      expect(() => policy.createMigrationPolicyModel(data)).toThrow(/POLICY_(?:INPUT_INVALID|HISTORY_ORDER_INVALID)/u);
    }
  });
});

describe('#378 finite monotonic budget model', () => {
  const invalid = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '100', null, undefined];
  it.each(['overallMs', 'statementMs', 'lockMs', 'idleTransactionMs'])('rejects every non-positive/unsafe/coerced %s', (field) => {
    for (const value of invalid) {
      const data = fixture(); mutable(data.budget)[field] = value;
      expect(() => policy.createMigrationPolicyModel(data)).toThrow('POLICY_BUDGET_INVALID');
    }
  });

  it.each(['statementMs', 'lockMs', 'idleTransactionMs'])('rejects PostgreSQL integer overflow in %s', (field) => {
    const data = fixture(); data.budget.overallMs = Number.MAX_SAFE_INTEGER;
    mutable(data.budget)[field] = 2_147_483_648;
    expect(() => policy.createMigrationPolicyModel(data)).toThrow('POLICY_BUDGET_INVALID');
  });

  it.each(['statementMs', 'lockMs', 'idleTransactionMs'])('cannot exceed overall budget in %s', (field) => {
    const data = fixture(); mutable(data.budget)[field] = 1001;
    expect(() => policy.createMigrationPolicyModel(data)).toThrow('POLICY_BUDGET_INVALID');
  });

  it('rejects disabled/equal lock timeout and a PG15 transaction_timeout facade', () => {
    const equal = fixture(); equal.budget.lockMs = equal.budget.statementMs;
    expect(() => policy.createMigrationPolicyModel(equal)).toThrow('POLICY_BUDGET_INVALID');
    const unsupported = fixture(); mutable(unsupported.budget).transactionTimeoutMs = 1000;
    expect(() => policy.createMigrationPolicyModel(unsupported)).toThrow('POLICY_BUDGET_INVALID');
  });

  it.each(invalid.filter((value) => value !== 0))('rejects invalid initial monotonic sample %#', (value) => {
    expect(() => policy.startMigrationPolicyModel(policy.createMigrationPolicyModel(fixture()), owned(), value)).toThrow('POLICY_CLOCK_INVALID');
  });

  it('accepts zero as a monotonic origin, not as a disabled timeout', () => {
    expect(model().snapshot()).toMatchObject({ startedAtMs: 0, deadlineMs: 1000 });
  });

  it('rejects whole-deadline overflow and permits exact safe-integer boundary', () => {
    expect(() => model(fixture(), owned(), Number.MAX_SAFE_INTEGER - 999)).toThrow('POLICY_BUDGET_OVERFLOW');
    const run = model(fixture(), owned(), Number.MAX_SAFE_INTEGER - 1000);
    expect(run.snapshot().deadlineMs).toBe(Number.MAX_SAFE_INTEGER);
    expect(run.transition({ type: 'BEGIN' }, Number.MAX_SAFE_INTEGER - 1).code).toBe('POLICY_DEADLINE_EXPIRED');
  });

  it('bounds every server timeout to remaining time without resetting the whole deadline', () => {
    const run = model();
    expect(run.nextStatementBudget(900)).toMatchObject({ remainingMs: 100, statementMs: 100, lockMs: 50, idleTransactionMs: 100, transactionTimeoutSupported: false, executionAllowed: false });
    expect(run.nextStatementBudget(998)).toMatchObject({ remainingMs: 2, statementMs: 2, lockMs: 1, idleTransactionMs: 2 });
    expect(run.nextStatementBudget(999)).toMatchObject({ classification: 'UNKNOWN', terminal: true, code: 'POLICY_DEADLINE_EXPIRED' });
    expect(run.snapshot().deadlineMs).toBe(1000);
  });

  it.each([1000, 1001])('expires at/after whole deadline %i', (now) => {
    expect(model().transition({ type: 'BEGIN' }, now)).toMatchObject({ terminal: true, classification: 'UNKNOWN', code: 'POLICY_DEADLINE_EXPIRED' });
  });

  it.each([201, 202])('expires at/after active statement deadline %i', (now) => {
    const run = model(); run.transition({ type: 'BEGIN' }, 1);
    expect(run.transition({ type: 'BEGIN_ACK' }, now)).toMatchObject({ terminal: true, classification: 'UNKNOWN', code: 'POLICY_DEADLINE_EXPIRED' });
  });

  it('permits an acknowledgement just before the statement deadline', () => {
    const run = model(); run.transition({ type: 'BEGIN' }, 1);
    expect(run.transition({ type: 'BEGIN_ACK' }, 200)).toMatchObject({ phase: 'SQL_READY', terminal: false, phaseDeadlineMs: null });
  });

  it('stops when the clock moves backward, including between SQL and readback', () => {
    const run = model(); run.transition({ type: 'BEGIN' }, 2);
    expect(run.transition({ type: 'BEGIN_ACK' }, 1).code).toBe('POLICY_CLOCK_REVERSED');
    const data = fixture(); const second = model(data); const now = drive(second, data);
    expect(second.observe(observation(data), now - 1).code).toBe('POLICY_CLOCK_REVERSED');
  });

  it('overall expiry between statements prevents history/commit/readback continuation', () => {
    const data = fixture(); const run = model(data); drive(run, data, 'SQL_COMPLETE');
    expect(run.transition(events(data)[6], 1000).code).toBe('POLICY_DEADLINE_EXPIRED');
    expect(run.transition({ type: 'COMMIT' }, 1001).classification).toBe('UNKNOWN');
    expect(run.observe(observation(data), 1002).classification).toBe('UNKNOWN');
  });

  it('bounds readback itself, and cannot probe again after readback deadline', () => {
    const data = fixture(); const run = model(data); const now = drive(run, data, 'READBACK_REQUIRED');
    expect(run.nextStatementBudget(now)).toMatchObject({ statementMs: 200, executionAllowed: false });
    run.transition({ type: 'READBACK' }, now + 1);
    expect(run.observe(observation(data), now + 201).code).toBe('POLICY_DEADLINE_EXPIRED');
    expect(run.transition({ type: 'READBACK' }, now + 202).classification).toBe('UNKNOWN');
  });
});

describe('#378 single migration SQL/history/commit phase model', () => {
  const phases = ['READY', 'BEGIN_SENT', 'SQL_READY', 'SQL_SENT', 'SQL_COMPLETE', 'HISTORY_SENT', 'COMMIT_READY', 'COMMIT_SENT', 'READBACK_REQUIRED', 'READBACK_SENT'];
  const eventTypes = ['BEGIN', 'BEGIN_ACK', 'SQL', 'SQL_ACK', 'HISTORY', 'HISTORY_ACK', 'COMMIT', 'COMMIT_ACK', 'READBACK'];
  const valid: Record<string, string> = { READY: 'BEGIN', BEGIN_SENT: 'BEGIN_ACK', SQL_READY: 'SQL', SQL_SENT: 'SQL_ACK', SQL_COMPLETE: 'HISTORY', HISTORY_SENT: 'HISTORY_ACK', COMMIT_READY: 'COMMIT', COMMIT_SENT: 'COMMIT_ACK', READBACK_REQUIRED: 'READBACK' };
  for (const phase of phases) {
    it.each(eventTypes.filter((type) => type !== valid[phase]))(`rejects out-of-order %s from ${phase}`, (type) => {
      const data = fixture(); const run = model(data); const now = drive(run, data, phase);
      const event = type === 'SQL' ? events(data)[2] : type === 'HISTORY' ? events(data)[6] : { type };
      expect(run.transition(event, now + 1)).toMatchObject({ terminal: true, classification: 'UNKNOWN', code: 'POLICY_TRANSITION_INVALID' });
    });
  }

  it('requires every SQL hash, the exact history row, and commit before readback', () => {
    const data = fixture(); const run = model(data);
    const now = drive(run, data);
    expect(run.snapshot()).toMatchObject({ phase: 'READBACK_SENT', classification: null, terminal: false, nextStatementIndex: 2 });
    expect(run.observe(observation(data), now + 1)).toMatchObject({ phase: 'RESOLVED', classification: 'APPLIED', terminal: true, executionAllowed: false, retryAllowed: false });
  });

  it.each([0, 2, -1, 1.5, '1'])('rejects missing/replayed/coerced second SQL ordinal %#', (ordinal) => {
    const data = fixture(); const run = model(data);
    for (const event of events(data).slice(0, 4)) run.transition(event, 1);
    expect(run.transition({ type: 'SQL', statementIndex: ordinal, statementSha256: first(data).statementSha256s[1] }, 2).code).toBe('POLICY_STATEMENT_MISMATCH');
  });

  it('rejects correct ordinal with changed SQL hash', () => {
    const data = fixture(); const run = model(data); const now = drive(run, data, 'SQL_READY');
    expect(run.transition({ type: 'SQL', statementIndex: 0, statementSha256: h(999) }, now + 1).code).toBe('POLICY_STATEMENT_MISMATCH');
  });

  it.each(['version', 'name', 'statementsSha256', 'historySha256'])('rejects changed HISTORY %s', (field) => {
    const data = fixture(); const run = model(data); const now = drive(run, data, 'SQL_COMPLETE');
    const event = clone(events(data)[6]);
    if (!event) throw new Error('SYNTHETIC_FIXTURE_MISSING');
    mutable(event)[field] = field === 'version' ? '20260102000001' : field === 'name' ? 'synthetic_other' : h(999);
    expect(run.transition(event, now + 1).code).toBe('POLICY_HISTORY_MISMATCH');
  });

  it.each(phases.filter((phase) => phase !== 'READY' && phase !== 'READBACK_REQUIRED' && phase !== 'READBACK_SENT'))('loss during %s prohibits all further writes and requires observation', (phase) => {
    const data = fixture(); const run = model(data); const now = drive(run, data, phase);
    expect(run.transition({ type: 'RESPONSE_LOST' }, now + 1)).toMatchObject({ phase: 'READBACK_REQUIRED', terminal: false, classification: null });
    expect(run.transition({ type: 'COMMIT' }, now + 2)).toMatchObject({ phase: 'STOPPED', terminal: true, classification: 'UNKNOWN' });
  });

  it('SQL/history failure never acts as proof of rollback or permits COMMIT', () => {
    const data = fixture(); const run = model(data); const now = drive(run, data, 'HISTORY_SENT');
    expect(run.transition({ type: 'FAILURE' }, now + 1)).toMatchObject({ phase: 'READBACK_REQUIRED', classification: null });
    expect(run.transition({ type: 'COMMIT' }, now + 2).classification).toBe('UNKNOWN');
  });

  it('commit acknowledgement alone is not APPLIED', () => {
    const data = fixture(); const run = model(data); drive(run, data, 'READBACK_REQUIRED');
    expect(run.snapshot().classification).toBeNull();
    expect(run.snapshot().code).toBe('POLICY_READBACK_REQUIRED');
  });

  it.each(['RESPONSE_LOST', 'FAILURE'])('readback %s stops UNKNOWN instead of automatically probing again', (type) => {
    const data = fixture(); const run = model(data); const now = drive(run, data);
    expect(run.transition({ type }, now + 1)).toMatchObject({ terminal: true, classification: 'UNKNOWN', code: 'POLICY_STATE_UNKNOWN' });
    expect(run.observe(observation(data), now + 2).classification).toBe('UNKNOWN');
  });

  it.each(phases)('forbids PID-only termination from %s', (phase) => {
    const data = fixture(); const run = model(data); const now = drive(run, data, phase);
    expect(run.transition({ type: 'PID_TERMINATION' }, now + 1)).toMatchObject({ code: 'POLICY_PID_TERMINATION_DISALLOWED', classification: 'UNKNOWN', pidTerminationAllowed: false });
  });

  it('does not run an event getter or expose native event failures', () => {
    let invoked = false; const run = model();
    const event = Object.defineProperty({}, 'type', { enumerable: true, get() { invoked = true; throw new Error('SYNTHETIC_NATIVE_SENTINEL'); } });
    const result = run.transition(event, 1);
    expect(result.code).toBe('POLICY_INPUT_INVALID'); expect(invoked).toBe(false);
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_NATIVE_SENTINEL');
  });
});

describe('#378 response-loss evidence model', () => {
  function waiting(data = fixture(), phase = 'COMMIT_SENT') {
    const run = model(data); const now = drive(run, data, phase);
    run.transition({ type: 'RESPONSE_LOST' }, now + 1);
    run.transition({ type: 'READBACK' }, now + 2);
    return { run, now: now + 3 };
  }

  it('models APPLIED from exact committed post-state and exact whole history after lost commit response', () => {
    const data = fixture(); const { run, now } = waiting(data);
    expect(run.observe(observation(data), now)).toMatchObject({ classification: 'APPLIED', code: 'POLICY_EXACT_POST_STATE', terminal: true, executionAllowed: false });
  });

  it('permits committed post-state with the exact original backend live only when idle', () => {
    const data = fixture(); const proof = observation(data); proof.backend.status = 'SAME_BACKEND_LIVE'; proof.backend.transactionStatus = 'IDLE';
    const { run, now } = waiting(data);
    expect(run.observe(proof, now).classification).toBe('APPLIED');
  });

  it('models NOT_APPLIED before commit only with exact complete pre-state and original backend definitively gone', () => {
    const data = fixture(); const { run, now } = waiting(data, 'SQL_SENT');
    expect(run.observe(observation(data, 'pre'), now)).toMatchObject({ classification: 'NOT_APPLIED', code: 'POLICY_EXACT_PRE_STATE_BACKEND_GONE', terminal: true, retryAllowed: false });
  });

  it.each(['LIVE', 'UNKNOWN', 'PID_REUSED', 'SAME_BACKEND_LIVE'])('does not infer rollback from absent history and backend %s', (status) => {
    const data = fixture(); const proof = observation(data, 'pre'); proof.backend.status = status; proof.backend.transactionStatus = status === 'SAME_BACKEND_LIVE' ? 'IDLE' : 'UNKNOWN';
    const { run, now } = waiting(data);
    expect(run.observe(proof, now).classification).toBe('UNKNOWN');
  });

  it.each(['verification', 'snapshotKind', 'modelSource', 'historySha256', 'history', 'state', 'backend'])('missing %s proof is UNKNOWN, never success', (field) => {
    const data = fixture(); const proof = observation(data); delete mutable(proof)[field];
    const { run, now } = waiting(data);
    expect(run.observe(proof, now)).toMatchObject({ classification: 'UNKNOWN', terminal: true, executionAllowed: false });
  });

  it.each(['verification', 'snapshotKind', 'backend-verification', 'backend-unknown', 'backend-reused', 'backend-in-transaction'])('rejects unverified/ambiguous %s even with exact post hashes', (field) => {
    const data = fixture(); const proof = observation(data);
    if (field === 'verification') proof.verification = 'UNVERIFIED';
    if (field === 'snapshotKind') proof.snapshotKind = 'SAME_CONNECTION_UNCOMMITTED';
    if (field === 'backend-verification') proof.backend.verification = 'UNVERIFIED';
    if (field === 'backend-unknown') proof.backend.status = 'UNKNOWN';
    if (field === 'backend-reused') proof.backend.status = 'PID_REUSED';
    if (field === 'backend-in-transaction') { proof.backend.status = 'SAME_BACKEND_LIVE'; proof.backend.transactionStatus = 'IN_TRANSACTION'; }
    const { run, now } = waiting(data);
    expect(run.observe(proof, now).classification).toBe('UNKNOWN');
  });

  it.each(['pid', 'backendStart', 'databaseOid', 'roleOid', 'runId', 'connectionMode'] as const)('rejects original backend %s drift', (field) => {
    const data = fixture(); const proof = observation(data);
    if (field === 'pid' || field === 'databaseOid' || field === 'roleOid') proof.backend.identity[field] += 1;
    if (field === 'backendStart') proof.backend.identity.backendStart = '2030-01-02T03:04:05.123457+00:00';
    if (field === 'runId') proof.backend.identity.runId = '10000000-0000-4000-8000-000000000002';
    if (field === 'connectionMode') proof.backend.identity.connectionMode = 'session';
    const { run, now } = waiting(data);
    expect(run.observe(proof, now).classification).toBe('UNKNOWN');
  });

  it('rejects a PID-only identity and transaction pooler model', () => {
    expect(() => model(fixture(), { pid: 321 } as Backend)).toThrow('POLICY_BACKEND_INVALID');
    const identity = owned(); identity.connectionMode = 'transaction';
    expect(() => model(fixture(), identity)).toThrow('POLICY_BACKEND_INVALID');
  });

  it.each(['projectRef', 'sourceRef', 'headSha1', 'treeSha1', 'manifestSha256', 'historySha256'] as const)('requires the immutable model source %s in readback', (field) => {
    const data = fixture(); const proof = observation(data);
    proof.modelSource[field] = field === 'projectRef' ? 'z'.repeat(20) : field === 'sourceRef' ? 'refs/heads/main' : 'c'.repeat(field.endsWith('Sha1') ? 40 : 64);
    const { run, now } = waiting(data);
    expect(run.observe(proof, now).classification).toBe('UNKNOWN');
  });

  it.each(['coverageSha256', 'catalogSha256', 'dataSha256', 'sequencesSha256'] as const)('requires exact %s for both APPLIED and NOT_APPLIED', (field) => {
    for (const kind of ['pre', 'post'] as const) {
      const data = fixture(); const proof = observation(data, kind); proof.state[field] = h(999);
      const { run, now } = waiting(data);
      expect(run.observe(proof, now).classification).toBe('UNKNOWN');
    }
  });

  it.each(['version', 'name', 'statementsSha256', 'historySha256', 'missing-row', 'extra-row'])('requires whole exact history (%s) as well as post-state', (field) => {
    const data = fixture(); const proof = observation(data);
    const row = proof.history.at(-1); if (!row) throw new Error('SYNTHETIC_FIXTURE_MISSING');
    if (field === 'version') row.version = '20260102000001';
    if (field === 'name') row.name = 'synthetic_other';
    if (field === 'statementsSha256') row.statementsSha256 = h(999);
    if (field === 'historySha256') proof.historySha256 = h(999);
    if (field === 'missing-row') proof.history.pop();
    if (field === 'extra-row') proof.history.push({ version: '20260104000000', name: 'synthetic_extra', statementsSha256: h(999) });
    const { run, now } = waiting(data);
    expect(run.observe(proof, now).classification).toBe('UNKNOWN');
  });

  it('partial/nontransactional sequence change prevents NOT_APPLIED despite absent history', () => {
    const data = fixture(); const proof = observation(data, 'pre'); proof.state.sequencesSha256 = h(999);
    const { run, now } = waiting(data, 'SQL_SENT');
    expect(run.observe(proof, now).classification).toBe('UNKNOWN');
  });

  it.each(['APPLIED', 'NOT_APPLIED', 'UNKNOWN'])('is terminal after %s, with no advance or retry permission', (expected) => {
    const data = fixture(); const proof = observation(data, expected === 'NOT_APPLIED' ? 'pre' : 'post');
    if (expected === 'UNKNOWN') proof.state.dataSha256 = h(999);
    const { run, now } = waiting(data); const result = run.observe(proof, now);
    expect(result.classification).toBe(expected);
    expect(Object.keys(run).sort()).toEqual(['snapshot', 'transition', 'observe', 'nextStatementBudget'].sort());
    expect(run.transition({ type: 'BEGIN' }, now + 1)).toEqual(result);
    expect(run.transition({ type: 'PID_TERMINATION' }, now + 2)).toEqual(result);
    expect(run.observe(observation(data), now + 3)).toEqual(result);
    expect(run.nextStatementBudget(now + 4)).toEqual(result);
  });

  it('serializes only fixed safe codes/scalars when an observation accessor throws', () => {
    const data = fixture(); const proof = observation(data); const sentinel = 'SYNTHETIC_NATIVE_SECRET_SENTINEL';
    Object.defineProperty(proof, 'state', { enumerable: true, get() { throw new Error(sentinel); } });
    const { run, now } = waiting(data); const result = run.observe(proof, now);
    expect(result).toMatchObject({ classification: 'UNKNOWN', code: 'POLICY_INPUT_INVALID', terminal: true });
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(result).not.toHaveProperty('message'); expect(result).not.toHaveProperty('stack'); expect(result).not.toHaveProperty('cause');
  });

  it('returns a fixed code for a native proxy failure, not its message or cause', () => {
    const data = fixture(); const { run, now } = waiting(data);
    const proxy = new Proxy({}, { getPrototypeOf() { throw new Error('SYNTHETIC_PROXY_SECRET_SENTINEL', { cause: 'SYNTHETIC_SECRET_CAUSE' }); } });
    const result = run.observe(proxy, now);
    expect(result).toMatchObject({ classification: 'UNKNOWN', code: 'POLICY_INPUT_INVALID' });
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC_PROXY_SECRET_SENTINEL|SYNTHETIC_SECRET_CAUSE/u);
  });
});
