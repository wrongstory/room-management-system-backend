/** #378 exact release request binding. Consistency checking is not approval authentication. */
import { createHash } from 'node:crypto';
import { copyMigrationData, exactMigrationKeys } from './migration-evidence-input.mjs';
import { createMigrationPolicyModel } from './migration-executor-policy.mjs';

const prepared = new WeakMap();
const sourceKeys = ['projectRef', 'sourceRef', 'headSha1', 'treeSha1', 'manifestSha256', 'historySha256'];
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Prepare a reviewable exact request; source/history inputs retain their provenance limits. */
export function prepareMigrationRelease(input) {
  try {
    const value = copyMigrationData(input);
    const keys = ['repository', 'policy', 'remote', 'validationFingerprint', 'recoveryEvidenceSha256'];
    if (Object.hasOwn(value, 'historySourceMappings')) keys.push('historySourceMappings');
    exactMigrationKeys(value, keys);
    if (value.repository !== 'wrongstory/room-management-system-backend') throw new Error();
    const plan = createMigrationPolicyModel(value.policy);
    const remote = value.remote;
    exactMigrationKeys(remote, ['repository', 'projectRef', 'sourceRef', 'headSha1', 'treeSha1', 'manifestSha256', 'historySha256', 'mergedReleasePr', 'application', 'migration', 'independentReview']);
    if (remote.repository !== value.repository || !sourceKeys.every(key => remote[key] === value.policy.expectedSource[key])
      || !Number.isSafeInteger(remote.mergedReleasePr) || remote.mergedReleasePr < 1
      || remote.application !== 'PASS' || remote.migration !== 'FULL_DB_PASS' || remote.independentReview !== 'PASS') throw new Error();
    for (const key of ['validationFingerprint', 'recoveryEvidenceSha256']) if (!/^[a-f0-9]{64}$/u.test(value[key])) throw new Error();
    if (Object.hasOwn(value, 'historySourceMappings')) {
      if (!Array.isArray(value.historySourceMappings)) throw new Error();
      const seen = new Set();
      for (const mapping of value.historySourceMappings) {
        exactMigrationKeys(mapping, ['sourceVersion', 'historyVersion', 'name', 'sqlSha256', 'statementsSha256']);
        if (!/^[0-9]{14}$/u.test(mapping.sourceVersion) || !/^[0-9]{14}$/u.test(mapping.historyVersion)
          || mapping.sourceVersion === mapping.historyVersion || seen.has(mapping.sourceVersion)
          || !/^[a-f0-9]{64}$/u.test(mapping.sqlSha256) || !/^[a-f0-9]{64}$/u.test(mapping.statementsSha256)
          || !value.policy.expectedHistory.some(row => row.version === mapping.historyVersion && row.name === mapping.name && row.statementsSha256 === mapping.statementsSha256)) throw new Error();
        seen.add(mapping.sourceVersion);
      }
    }
    if (value.policy.pending.length === 0 || value.policy.budget.overallMs > 120_000) throw new Error();
    const requestSha256 = sha({ format: 'migration-release-request-v1', value });
    const result = Object.freeze({ mode: 'EXACT_RELEASE_REQUEST', requestSha256,
      sourceSha256: sha(value.policy.expectedSource), pendingCount: plan.pendingCount,
      remoteEvidenceAuthenticated: false, approvalAuthenticated: false });
    prepared.set(result, { value, plan });
    return result;
  } catch { throw new Error('MIGRATION_RELEASE_PREFLIGHT_FAILED'); }
}

/** Trusted runtime modules only. No SQL/credentials; serialized input cannot forge an owned request. */
export function migrationReleaseConfiguration(request) {
  const entry = prepared.get(request);
  if (!entry) throw new Error('MIGRATION_RELEASE_REQUEST_NOT_OWNED');
  return entry.value;
}

/** Validate a specific one-run receipt after the trusted authority adapter authenticates its origin. */
export function validateMigrationApprovalReceipt(input) {
  try {
    exactMigrationKeys(input, ['request', 'receipt', 'runId', 'nowMs']);
    migrationReleaseConfiguration(input.request);
    const receipt = copyMigrationData(input.receipt);
    exactMigrationKeys(receipt, ['requestSha256', 'runId', 'issuedAtMs', 'expiresAtMs', 'action']);
    if (receipt.requestSha256 !== input.request.requestSha256 || receipt.runId !== input.runId
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(receipt.runId)
      || receipt.action !== 'APPLY_EXACT_MIGRATIONS_ONCE'
      || !Number.isSafeInteger(input.nowMs) || !Number.isSafeInteger(receipt.issuedAtMs) || !Number.isSafeInteger(receipt.expiresAtMs)
      || receipt.issuedAtMs < 0 || receipt.issuedAtMs > input.nowMs || receipt.expiresAtMs <= input.nowMs
      || receipt.expiresAtMs - receipt.issuedAtMs > 15 * 60_000) throw new Error();
    return receipt;
  } catch { throw new Error('MIGRATION_RELEASE_APPROVAL_MISMATCH'); }
}
