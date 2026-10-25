import { summarizeResetPreview } from '../../src/modules/developer-reset/reset-preview.js';
import { resetRelationGroups, resetRowRuleFingerprint } from '../../src/modules/developer-reset/reset-preview-groups.js';

/** Shared, synthetic SQL aggregate fixtures; no real identities or credentials. */
export function resetPreviewContractInputs() {
  const relations = Object.values(resetRelationGroups).flat().map(relation => ({
    relation, kind: 'r', partition: false, observedRows: 0, exact: true,
  }));
  const base = { format: 'reset-preview-inventory-v1', readOnly: true,
    capturedAt: '2026-10-25T00:00:00+00:00', snapshotId: 'a'.repeat(64), relations };
  const rowImpact = { format: 'reset-row-impact-v1', snapshotId: base.snapshotId, ruleFingerprint: resetRowRuleFingerprint,
    relations: relations.map(({ relation }) => ({ relation, rowCount: 0,
      counts: { preserve: 0, roomBaseline: 0, resetCandidate: 0, templateSource: 0, photoHold: 0, unresolved: 0 } })),
    authBoundary: { rowCount: 0, independentCount: 0, preserve: 0, resetCandidate: 0, unresolved: 0 },
    expectedForeignKeys: 0, unsupportedForeignKeys: 0, foreignKeys: [] };
  const unknown = { format: 'developer-operation-gates-v1', lifecycle: 'UNKNOWN', controlVersion: null as string | null,
    maintenance: 'UNKNOWN', policyConfigured: false, unfinishedAdmissions: 0, expiredUnfinishedAdmissions: 0,
    unresolvedPasswordChanges: 0, preparedPasswordResets: 0, coverage: 'NOT_INTEGRATED',
    recentReauthentication: 'NOT_EVALUATED', executionEnabled: false };
  const configured = { ...unknown, lifecycle: 'PROVISIONING', controlVersion: '12', maintenance: 'REQUESTED', policyConfigured: true };
  return [
    { name: 'legacy-uncollected', input: base },
    { name: 'unknown', input: { ...base, rowImpact, gateEvidence: unknown } },
    { name: 'configured', input: { ...base, rowImpact, gateEvidence: configured } },
    { name: 'started', input: { ...base, rowImpact, gateEvidence: { ...configured, lifecycle: 'STARTED' } } },
    { name: 'unfinished-effects', input: { ...base, rowImpact, gateEvidence: { ...configured,
      unfinishedAdmissions: 2, expiredUnfinishedAdmissions: 1, unresolvedPasswordChanges: 1, preparedPasswordResets: 1 } } },
  ];
}
export function resetPreviewContractResponses() {
  return resetPreviewContractInputs().map(({ name, input }) => ({ name, body: summarizeResetPreview(input) }));
}
