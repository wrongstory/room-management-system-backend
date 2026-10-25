/** #378 finite sequential execution core. No CLI, environment, credential or DB connection access.
 * Authority/session adapters are trusted runtime code, never JSON/user callbacks from a public route.
 */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { copyMigrationData, exactMigrationKeys } from './migration-evidence-input.mjs';
import { createMigrationPolicyModel, startMigrationPolicyModel } from './migration-executor-policy.mjs';
import { migrationReleaseConfiguration, validateMigrationApprovalReceipt } from './migration-release-preflight.mjs';

const consumed = new WeakSet();
const usedRequests = new Set();
const activeProjects = new Set();
const failed = code => new Error(code);
function verifyInitialState(value, source, history, migration, identity) {
  const proof = copyMigrationData(value);
  exactMigrationKeys(proof, ['modelSource', 'historySha256', 'history', 'state', 'backend']);
  exactMigrationKeys(proof.modelSource, Object.keys(source));
  exactMigrationKeys(proof.state, Object.keys(migration.preState));
  exactMigrationKeys(proof.backend, ['identity', 'transactionStatus']);
  exactMigrationKeys(proof.backend.identity, Object.keys(identity));
  if (!Object.keys(source).every(key => proof.modelSource[key] === source[key])
    || proof.historySha256 !== migration.preHistorySha256 || proof.backend.transactionStatus !== 'IN_TRANSACTION'
    || !Object.keys(identity).every(key => proof.backend.identity[key] === identity[key])
    || !Object.keys(migration.preState).every(key => proof.state[key] === migration.preState[key])
    || !Array.isArray(proof.history) || proof.history.length !== history.length) throw failed('MIGRATION_SUPERVISOR_PRESTATE_MISMATCH');
  for (const [index, row] of history.entries()) {
    exactMigrationKeys(proof.history[index], Object.keys(row));
    if (!Object.keys(row).every(key => proof.history[index][key] === row[key])) throw failed('MIGRATION_SUPERVISOR_PRESTATE_MISMATCH');
  }
}

/**
 * Runs real bounded adapter operations in order. The runtime must authenticate exact approval,
 * revalidate live source/state, and supply an owned atomic session before exposing this core.
 * This module does not contain such a production bootstrap; tests use in-memory adapters only.
 */
export async function superviseMigrationRelease(input) {
  try { exactMigrationKeys(input, ['request', 'authorize', 'openSession']); }
  catch { throw failed('MIGRATION_SUPERVISOR_REQUEST_INVALID'); }
  const { request, authorize, openSession } = input;
  let configuration;
  try { configuration = migrationReleaseConfiguration(request); } catch { throw failed('MIGRATION_SUPERVISOR_REQUEST_INVALID'); }
  const project = configuration.policy.expectedSource.projectRef;
  if (typeof authorize !== 'function' || typeof openSession !== 'function' || consumed.has(request)
    || usedRequests.has(request.requestSha256) || activeProjects.has(project) || usedRequests.size >= 1024) throw failed('MIGRATION_SUPERVISOR_REQUEST_CONSUMED');
  consumed.add(request); // Reject simultaneous invocations and all retries of this exact owned request.
  usedRequests.add(request.requestSha256);
  activeProjects.add(project);
  const started = Math.floor(performance.now());
  const deadline = started + configuration.policy.budget.overallMs;
  const runId = randomUUID();
  let appliedCount = 0;
  let active = null;
  let controller = null;
  let receipt;
  const now = () => Math.floor(performance.now());
  const result = (classification, code) => {
    if (classification === 'NOT_STARTED' || code === 'MIGRATION_SUPERVISOR_COMPLETE') activeProjects.delete(project);
    return Object.freeze({ classification, code, appliedCount,
    pendingCount: configuration.policy.pending.length, requestSha256: request.requestSha256,
    runId, elapsedMs: Math.max(0, now() - started), retryAllowed: false, evidenceScope: 'TRUSTED_ADAPTER_RESULTS' });
  };
  function abortOwned() {
    try { controller?.abort(); } catch { /* no native errors */ }
    try { active?.abort(); } catch { /* adapter only owns its own session */ }
  }
  async function bounded(action, maximum, code, disposeLate) {
    const milliseconds = Math.min(maximum, deadline - now());
    if (milliseconds <= 0) throw failed('MIGRATION_SUPERVISOR_DEADLINE');
    return await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; abortOwned(); reject(failed(code)); } }, milliseconds);
      Promise.resolve().then(() => {
        if (settled || now() >= deadline) throw failed('MIGRATION_SUPERVISOR_DEADLINE');
        return action();
      }).then(value => {
        clearTimeout(timer);
        if (settled) { try { disposeLate?.(value); } catch { /* no foreign errors */ } return; }
        settled = true;
        if (now() >= deadline) { abortOwned(); reject(failed('MIGRATION_SUPERVISOR_DEADLINE')); } else resolve(value);
      }, () => { clearTimeout(timer); if (!settled) { settled = true; abortOwned(); reject(failed(code)); } });
    });
  }
  async function closeOwned() {
    if (!active) return true;
    const session = active;
    active = null;
    let timer;
    try {
      const closed = await Promise.race([
        Promise.resolve().then(() => session.close()).then(() => true, () => false),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), 500); }),
      ]);
      if (!closed) { try { session.abort(); } catch { /* fixed result only */ } }
      return closed;
    } finally { clearTimeout(timer); }
  }
  try {
    controller = new AbortController();
    receipt = await bounded(() => authorize(Object.freeze({ requestSha256: request.requestSha256, runId, signal: controller.signal })),
      configuration.policy.budget.statementMs, 'MIGRATION_SUPERVISOR_AUTHORITY_FAILED');
    validateMigrationApprovalReceipt({ request, receipt, runId, nowMs: Date.now() });
    if (receipt.expiresAtMs - Date.now() < deadline - now()) return result('NOT_STARTED', 'MIGRATION_SUPERVISOR_APPROVAL_TOO_SHORT');
    let history = configuration.policy.expectedHistory;
    for (const migration of configuration.policy.pending) {
      validateMigrationApprovalReceipt({ request, receipt, runId, nowMs: Date.now() });
      const remainingMs = deadline - now();
      if (remainingMs <= 1) return result('UNKNOWN', 'MIGRATION_SUPERVISOR_DEADLINE');
      const statementMs = Math.min(configuration.policy.budget.statementMs, remainingMs);
      const budget = { overallMs: remainingMs, statementMs,
        lockMs: Math.min(configuration.policy.budget.lockMs, statementMs - 1),
        idleTransactionMs: Math.min(configuration.policy.budget.idleTransactionMs, remainingMs) };
      const source = Object.freeze({ ...configuration.policy.expectedSource, historySha256: migration.preHistorySha256 });
      const policy = createMigrationPolicyModel({ expectedSource: source, observedSource: source, expectedHistory: history, observedHistory: history,
        pending: [migration], observedPending: [migration], budget });
      controller = new AbortController();
      const session = await bounded(() => openSession(Object.freeze({ requestSha256: request.requestSha256, runId,
        migration, modelSource: source, expectedHistory: history, budget, signal: controller.signal })), statementMs, 'MIGRATION_SUPERVISOR_CONNECT_FAILED', late => {
          try { late?.abort(); } catch { /* late owned connection must not be reused */ }
        });
      active = session;
      if (!session || ['begin', 'executeStatement', 'recordHistory', 'commit', 'readback', 'close', 'abort'].some(key => typeof session[key] !== 'function')
        || session.identity?.runId !== runId) throw failed('MIGRATION_SUPERVISOR_SESSION_INVALID');
      const identity = copyMigrationData(session.identity);
      const machine = startMigrationPolicyModel(policy, identity, now());
      const transition = event => {
        const state = machine.transition(event, now());
        if (state.terminal) throw failed('MIGRATION_SUPERVISOR_POLICY_STOPPED');
      };
      async function operation(sent, acknowledged, action) {
        validateMigrationApprovalReceipt({ request, receipt, runId, nowMs: Date.now() });
        const stepBudget = machine.nextStatementBudget(now());
        if (stepBudget.terminal) throw failed('MIGRATION_SUPERVISOR_POLICY_STOPPED');
        transition(sent);
        await bounded(() => action(stepBudget, controller.signal), stepBudget.statementMs, 'MIGRATION_SUPERVISOR_RESPONSE_LOST');
        transition({ type: acknowledged });
      }
      let preflightRejected = false;
      try {
        await operation({ type: 'BEGIN' }, 'BEGIN_ACK', async (limits, signal) => {
          const before = await session.begin(limits, signal);
          preflightRejected = true;
          verifyInitialState(before, source, history, migration, identity);
          preflightRejected = false;
        });
        for (const [statementIndex, statementSha256] of migration.statementSha256s.entries()) {
          await operation({ type: 'SQL', statementIndex, statementSha256 }, 'SQL_ACK',
            (limits, signal) => session.executeStatement(Object.freeze({ statementIndex, statementSha256, limits, signal })));
        }
        await operation({ type: 'HISTORY', version: migration.version, name: migration.name, statementsSha256: migration.statementsSha256,
          historySha256: migration.postHistorySha256 }, 'HISTORY_ACK', (limits, signal) => session.recordHistory(limits, signal));
        await operation({ type: 'COMMIT' }, 'COMMIT_ACK', (limits, signal) => session.commit(limits, signal));
      } catch {
        abortOwned();
        const current = machine.snapshot();
        if (!current.terminal && current.phase !== 'READY' && current.phase !== 'READBACK_REQUIRED') machine.transition({ type: 'RESPONSE_LOST' }, now());
      }
      if (preflightRejected) { await closeOwned(); return result('UNKNOWN', 'MIGRATION_SUPERVISOR_PRESTATE_MISMATCH'); }
      const state = machine.snapshot();
      if (state.terminal || state.phase !== 'READBACK_REQUIRED') { await closeOwned(); return result('UNKNOWN', 'MIGRATION_SUPERVISOR_STATE_UNKNOWN'); }
      // A fresh signal is required: readback uses an independent connection even after writer abort.
      controller = new AbortController();
      transition({ type: 'READBACK' });
      let classification;
      try {
        const observation = await bounded(() => session.readback(Object.freeze({ runId, signal: controller.signal,
          remainingMs: Math.max(0, deadline - now()) })), statementMs, 'MIGRATION_SUPERVISOR_READBACK_FAILED');
        classification = machine.observe(observation, now()).classification;
      } catch { classification = 'UNKNOWN'; }
      const closed = await closeOwned();
      if (classification === 'APPLIED') appliedCount += 1;
      if (!closed) return result(classification ?? 'UNKNOWN', 'MIGRATION_SUPERVISOR_CLOSE_FAILED');
      if (classification !== 'APPLIED') return result(classification ?? 'UNKNOWN', 'MIGRATION_SUPERVISOR_STOPPED');
      history = Object.freeze([...history, Object.freeze({ version: migration.version, name: migration.name, statementsSha256: migration.statementsSha256 })]);
    }
    return result('APPLIED', 'MIGRATION_SUPERVISOR_COMPLETE');
  } catch {
    abortOwned();
    await closeOwned();
    return result(appliedCount === 0 && !receipt ? 'NOT_STARTED' : 'UNKNOWN', 'MIGRATION_SUPERVISOR_STOPPED');
  }
}
