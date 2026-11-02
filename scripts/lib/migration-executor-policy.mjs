/**
 * #378 data-only policy model. No SQL/parser/driver/IO/clock/credential access.
 * Every returned object forbids operational execution. Caller-supplied evidence
 * models an observation; it does NOT verify an approval, backup, or DB fact.
 */
export const MIGRATION_POLICY_MODE = "POLICY_MODEL_ONLY";
export const PG15_TRANSACTION_TIMEOUT_SUPPORTED = false;
export const PID_ONLY_TERMINATION_ALLOWED = false;

const sha1 = /^[a-f0-9]{40}$/u;
const sha256 = /^[a-f0-9]{64}$/u;
const projectRef = /^[a-z]{20}$/u;
const version = /^\d{14}$/u;
const name = /^[a-z][a-z0-9_]{0,127}$/u;
const sourceRef = /^refs\/heads\/(?:main|release\/v\d+\.\d+\.\d+)$/u;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const maxPgMilliseconds = 2_147_483_647;
const policyPlans = new WeakMap();
const validationErrors = new WeakMap();
const sourceKeys = ["projectRef", "sourceRef", "headSha1", "treeSha1", "manifestSha256", "historySha256"];
const stateKeys = ["coverageSha256", "catalogSha256", "dataSha256", "sequencesSha256"];
const historyKeys = ["version", "name", "statementsSha256"];
const backendKeys = ["pid", "backendStart", "databaseOid", "roleOid", "runId", "connectionMode"];

function fail(code) {
  const error = new Error(code);
  validationErrors.set(error, code);
  throw error;
}

function protect(callback) {
  try {
    return callback();
  } catch (error) {
    // Never retain native error message, cause, name, stack, or input values.
    throw new Error(validationErrors.get(error) ?? "POLICY_INPUT_INVALID");
  }
}

function record(value, keys, code = "POLICY_INPUT_INVALID") {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actualKeys = Reflect.ownKeys(descriptors);
  if (actualKeys.length !== keys.length || actualKeys.some((key) => !keys.includes(key))) fail(code);
  const result = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) fail(code);
    result[key] = descriptor.value;
  }
  return result;
}

function array(value, maximum, code) {
  if (!Array.isArray(value) || value.length > maximum || Object.getPrototypeOf(value) !== Array.prototype) fail(code);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) fail(code);
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) fail(code);
    return descriptor.value;
  });
}

function matches(value, pattern, code) {
  if (typeof value !== "string" || !pattern.test(value)) fail(code);
  return value;
}

function integer(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code);
  return value;
}

function same(left, right, keys) {
  return keys.every((key) => left[key] === right[key]);
}

function state(value) {
  const result = record(value, stateKeys, "POLICY_STATE_INVALID");
  for (const key of stateKeys) matches(result[key], sha256, "POLICY_STATE_INVALID");
  return Object.freeze(result);
}

function source(value) {
  const result = record(value, sourceKeys, "POLICY_SOURCE_INVALID");
  matches(result.projectRef, projectRef, "POLICY_SOURCE_INVALID");
  matches(result.sourceRef, sourceRef, "POLICY_SOURCE_REF_NOT_RELEASE_OR_MAIN");
  for (const key of ["headSha1", "treeSha1"]) matches(result[key], sha1, "POLICY_SOURCE_INVALID");
  for (const key of ["manifestSha256", "historySha256"]) matches(result[key], sha256, "POLICY_SOURCE_INVALID");
  return Object.freeze(result);
}

function historyRow(value) {
  const result = record(value, historyKeys, "POLICY_HISTORY_INVALID");
  matches(result.version, version, "POLICY_HISTORY_INVALID");
  matches(result.name, name, "POLICY_HISTORY_INVALID");
  matches(result.statementsSha256, sha256, "POLICY_HISTORY_INVALID");
  return Object.freeze(result);
}

function orderedRows(values, validator, code) {
  const rows = array(values, 10_000, code).map(validator);
  const names = new Set();
  let previous = "";
  for (const row of rows) {
    if (row.version <= previous || names.has(row.name)) fail(code);
    previous = row.version;
    names.add(row.name);
  }
  return Object.freeze(rows);
}

function sameRows(left, right, keys) {
  return left.length === right.length && left.every((row, index) => same(row, right[index], keys));
}

function migration(value) {
  const result = record(value, [
    "version", "name", "sqlSha256", "statementsSha256", "statementSha256s",
    "preHistorySha256", "postHistorySha256", "preState", "postState",
  ], "POLICY_PENDING_INVALID");
  matches(result.version, version, "POLICY_PENDING_INVALID");
  matches(result.name, name, "POLICY_PENDING_INVALID");
  for (const key of ["sqlSha256", "statementsSha256", "preHistorySha256", "postHistorySha256"]) {
    matches(result[key], sha256, "POLICY_PENDING_INVALID");
  }
  result.statementSha256s = Object.freeze(array(result.statementSha256s, 10_000, "POLICY_PENDING_INVALID")
    .map((hash) => matches(hash, sha256, "POLICY_PENDING_INVALID")));
  if (result.statementSha256s.length === 0 || result.preHistorySha256 === result.postHistorySha256) fail("POLICY_PENDING_INVALID");
  result.preState = state(result.preState);
  result.postState = state(result.postState);
  return Object.freeze(result);
}

function budget(value) {
  const result = record(value, ["overallMs", "statementMs", "lockMs", "idleTransactionMs"], "POLICY_BUDGET_INVALID");
  integer(result.overallMs, 1, Number.MAX_SAFE_INTEGER, "POLICY_BUDGET_INVALID");
  for (const key of ["statementMs", "lockMs", "idleTransactionMs"]) {
    integer(result[key], 1, maxPgMilliseconds, "POLICY_BUDGET_INVALID");
    if (result[key] > result.overallMs) fail("POLICY_BUDGET_INVALID");
  }
  if (result.lockMs >= result.statementMs) fail("POLICY_BUDGET_INVALID");
  return Object.freeze(result);
}

function backend(value) {
  const result = record(value, backendKeys, "POLICY_BACKEND_INVALID");
  integer(result.pid, 1, 2_147_483_647, "POLICY_BACKEND_INVALID");
  for (const key of ["databaseOid", "roleOid"]) integer(result[key], 1, 4_294_967_295, "POLICY_BACKEND_INVALID");
  // Server-produced timestamp, including microseconds. Opaque exact identity;
  // a parser/driver must independently verify it before operational use.
  matches(result.backendStart, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/u, "POLICY_BACKEND_INVALID");
  matches(result.runId, uuid, "POLICY_BACKEND_INVALID");
  if (!['direct', 'session'].includes(result.connectionMode)) fail("POLICY_BACKEND_INVALID");
  return Object.freeze(result);
}

/** Freeze exact model inputs. This function performs no operational verification. */
export function createMigrationPolicyModel(input) {
  return protect(() => {
    const value = record(input, ["expectedSource", "observedSource", "expectedHistory", "observedHistory", "pending", "observedPending", "budget"]);
    const expectedSource = source(value.expectedSource);
    const observedSource = source(value.observedSource);
    if (!same(expectedSource, observedSource, sourceKeys)) fail("POLICY_SOURCE_MISMATCH");
    const expectedHistory = orderedRows(value.expectedHistory, historyRow, "POLICY_HISTORY_ORDER_INVALID");
    const observedHistory = orderedRows(value.observedHistory, historyRow, "POLICY_HISTORY_ORDER_INVALID");
    if (!sameRows(expectedHistory, observedHistory, historyKeys)) fail("POLICY_HISTORY_MISMATCH");
    const pending = orderedRows(value.pending, migration, "POLICY_PENDING_ORDER_INVALID");
    const observedPending = orderedRows(value.observedPending, migration, "POLICY_PENDING_ORDER_INVALID");
    if (pending.length !== observedPending.length || pending.some((row, index) => {
      const observed = observedPending[index];
      return !same(row, observed, ["version", "name", "sqlSha256", "statementsSha256", "preHistorySha256", "postHistorySha256"])
        || !same(row.preState, observed.preState, stateKeys) || !same(row.postState, observed.postState, stateKeys)
        || row.statementSha256s.length !== observed.statementSha256s.length
        || row.statementSha256s.some((hash, i) => hash !== observed.statementSha256s[i]);
    })) fail("POLICY_PENDING_MISMATCH");
    let previousVersion = expectedHistory.at(-1)?.version ?? "";
    let previousHistory = expectedSource.historySha256;
    let previousState;
    const allNames = new Set(expectedHistory.map((row) => row.name));
    for (const row of pending) {
      if (row.version <= previousVersion || allNames.has(row.name)) fail("POLICY_PENDING_ORDER_INVALID");
      if (row.preHistorySha256 !== previousHistory || (previousState && !same(row.preState, previousState, stateKeys))) fail("POLICY_CHAIN_MISMATCH");
      allNames.add(row.name);
      previousVersion = row.version;
      previousHistory = row.postHistorySha256;
      previousState = row.postState;
    }
    const plan = Object.freeze({ mode: MIGRATION_POLICY_MODE, executionAllowed: false, pendingCount: pending.length });
    policyPlans.set(plan, Object.freeze({ expectedSource, expectedHistory, pending, budget: budget(value.budget) }));
    return plan;
  });
}

/**
 * Model the FIRST pending migration only. No advance/retry/cancel/terminate API.
 * A real release supervisor and explicit verified next-migration gate are absent.
 */
export function startMigrationPolicyModel(plan, ownedBackend, startedAtMs) {
  return protect(() => {
    const configuration = policyPlans.get(plan);
    if (!configuration) fail("POLICY_PLAN_NOT_OWNED");
    if (configuration.pending.length === 0) fail("POLICY_NO_PENDING");
    const originalBackend = backend(ownedBackend);
    const started = integer(startedAtMs, 0, Number.MAX_SAFE_INTEGER, "POLICY_CLOCK_INVALID");
    const deadline = started + configuration.budget.overallMs;
    if (!Number.isSafeInteger(deadline)) fail("POLICY_BUDGET_OVERFLOW");
    const current = configuration.pending[0];
    const postHistory = Object.freeze([...configuration.expectedHistory, historyRow({
      version: current.version, name: current.name, statementsSha256: current.statementsSha256,
    })]);
    let phase = "READY";
    let nextStatementIndex = 0;
    let lastClock = started;
    let phaseDeadline = null;
    let classification = null;
    let code = "POLICY_READY";
    let terminal = false;

    function snapshot() {
      return Object.freeze({
        mode: MIGRATION_POLICY_MODE, executionAllowed: false, retryAllowed: false,
        pidTerminationAllowed: false, phase, nextStatementIndex, classification,
        code, terminal, startedAtMs: started, lastClockMs: lastClock, deadlineMs: deadline,
        phaseDeadlineMs: phaseDeadline,
      });
    }

    function stop(reason) {
      phase = "STOPPED";
      classification = "UNKNOWN";
      code = reason;
      terminal = true;
      return snapshot();
    }

    function clock(now) {
      integer(now, 0, Number.MAX_SAFE_INTEGER, "POLICY_CLOCK_INVALID");
      if (now < lastClock) fail("POLICY_CLOCK_REVERSED");
      lastClock = now;
      if (now >= deadline || (phaseDeadline !== null && now >= phaseDeadline)) fail("POLICY_DEADLINE_EXPIRED");
    }

    function guarded(callback) {
      if (terminal) return snapshot();
      try {
        return callback();
      } catch (error) {
        return stop(validationErrors.get(error) ?? "POLICY_INPUT_INVALID");
      }
    }

    function sent(nextPhase) {
      if (deadline - lastClock <= 1) fail("POLICY_DEADLINE_EXPIRED");
      phase = nextPhase;
      // Subtract first: even near MAX_SAFE_INTEGER this cannot overflow.
      phaseDeadline = lastClock + Math.min(configuration.budget.statementMs, deadline - lastClock);
    }

    function acknowledged(nextPhase) {
      phase = nextPhase;
      phaseDeadline = null;
    }

    function transition(event, nowMs) {
      return guarded(() => {
        clock(nowMs);
        const eventType = event !== null && typeof event === "object"
          ? Object.getOwnPropertyDescriptor(event, "type")?.value : undefined;
        const keys = eventType === "SQL" ? ["type", "statementIndex", "statementSha256"]
          : eventType === "HISTORY" ? ["type", "version", "name", "statementsSha256", "historySha256"] : ["type"];
        const value = record(event, keys);
        if (value.type === "PID_TERMINATION") return stop("POLICY_PID_TERMINATION_DISALLOWED");
        if (value.type === "RESPONSE_LOST" || value.type === "FAILURE") {
          if (phase === "READBACK_SENT") return stop("POLICY_STATE_UNKNOWN");
          if (phase === "READY" || phase === "READBACK_REQUIRED") return stop("POLICY_TRANSITION_INVALID");
          acknowledged("READBACK_REQUIRED");
          code = "POLICY_READBACK_REQUIRED";
          return snapshot();
        }
        if (phase === "READY" && value.type === "BEGIN") sent("BEGIN_SENT");
        else if (phase === "BEGIN_SENT" && value.type === "BEGIN_ACK") acknowledged("SQL_READY");
        else if (phase === "SQL_READY" && value.type === "SQL") {
          if (value.statementIndex !== nextStatementIndex || value.statementSha256 !== current.statementSha256s[nextStatementIndex]) fail("POLICY_STATEMENT_MISMATCH");
          sent("SQL_SENT");
        } else if (phase === "SQL_SENT" && value.type === "SQL_ACK") {
          nextStatementIndex += 1;
          acknowledged(nextStatementIndex === current.statementSha256s.length ? "SQL_COMPLETE" : "SQL_READY");
        } else if (phase === "SQL_COMPLETE" && value.type === "HISTORY") {
          if (!same(value, current, ["version", "name", "statementsSha256"]) || value.historySha256 !== current.postHistorySha256) fail("POLICY_HISTORY_MISMATCH");
          sent("HISTORY_SENT");
        }
        else if (phase === "HISTORY_SENT" && value.type === "HISTORY_ACK") acknowledged("COMMIT_READY");
        else if (phase === "COMMIT_READY" && value.type === "COMMIT") sent("COMMIT_SENT");
        else if (phase === "COMMIT_SENT" && value.type === "COMMIT_ACK") acknowledged("READBACK_REQUIRED");
        else if (phase === "READBACK_REQUIRED" && value.type === "READBACK") sent("READBACK_SENT");
        else return stop("POLICY_TRANSITION_INVALID");
        code = phase === "READBACK_REQUIRED" ? "POLICY_READBACK_REQUIRED" : "POLICY_PHASE_RECORDED";
        return snapshot();
      });
    }

    function observe(observation, nowMs) {
      return guarded(() => {
        clock(nowMs);
        if (phase !== "READBACK_SENT") return stop("POLICY_TRANSITION_INVALID");
        const value = record(observation, ["verification", "snapshotKind", "modelSource", "historySha256", "history", "state", "backend"]);
        if (value.verification !== "VERIFIED" || value.snapshotKind !== "INDEPENDENT_COMMITTED_SNAPSHOT") return stop("POLICY_EVIDENCE_UNVERIFIED");
        if (!same(source(value.modelSource), configuration.expectedSource, sourceKeys)) return stop("POLICY_OBSERVATION_SOURCE_MISMATCH");
        const backendEvidence = record(value.backend, ["verification", "identity", "status", "transactionStatus"]);
        const observedBackend = backend(backendEvidence.identity);
        if (backendEvidence.verification !== "VERIFIED" || !same(originalBackend, observedBackend, backendKeys)) return stop("POLICY_BACKEND_UNVERIFIED");
        if (backendEvidence.status === "PID_REUSED" || backendEvidence.status === "UNKNOWN") return stop("POLICY_BACKEND_UNVERIFIED");
        if (!(backendEvidence.status === "DEFINITIVELY_GONE" && backendEvidence.transactionStatus === "NO_BACKEND")
          && !(backendEvidence.status === "SAME_BACKEND_LIVE" && backendEvidence.transactionStatus === "IDLE")) return stop("POLICY_BACKEND_UNVERIFIED");
        const observedState = state(value.state);
        const observedHistory = orderedRows(value.history, historyRow, "POLICY_HISTORY_ORDER_INVALID");
        matches(value.historySha256, sha256, "POLICY_HISTORY_INVALID");
        if (value.historySha256 === current.postHistorySha256 && sameRows(observedHistory, postHistory, historyKeys) && same(observedState, current.postState, stateKeys)) {
          classification = "APPLIED";
          code = "POLICY_EXACT_POST_STATE";
        } else if (backendEvidence.status === "DEFINITIVELY_GONE" && value.historySha256 === current.preHistorySha256
          && sameRows(observedHistory, configuration.expectedHistory, historyKeys) && same(observedState, current.preState, stateKeys)) {
          classification = "NOT_APPLIED";
          code = "POLICY_EXACT_PRE_STATE_BACKEND_GONE";
        } else return stop("POLICY_STATE_UNKNOWN");
        phase = "RESOLVED";
        terminal = true;
        return snapshot();
      });
    }

    function nextStatementBudget(nowMs) {
      return guarded(() => {
        clock(nowMs);
        if (!['READY', 'SQL_READY', 'SQL_COMPLETE', 'COMMIT_READY', 'READBACK_REQUIRED'].includes(phase)) return stop("POLICY_TRANSITION_INVALID");
        const remainingMs = deadline - lastClock;
        const statementMs = Math.min(configuration.budget.statementMs, remainingMs);
        // Never send zero to Postgres: zero disables these settings.
        if (statementMs <= 1) return stop("POLICY_DEADLINE_EXPIRED");
        return Object.freeze({ mode: MIGRATION_POLICY_MODE, executionAllowed: false, remainingMs, statementMs,
          lockMs: Math.min(configuration.budget.lockMs, statementMs - 1),
          idleTransactionMs: Math.min(configuration.budget.idleTransactionMs, remainingMs),
          transactionTimeoutSupported: PG15_TRANSACTION_TIMEOUT_SUPPORTED });
      });
    }

    return Object.freeze({ snapshot, transition, observe, nextStatementBudget });
  });
}
