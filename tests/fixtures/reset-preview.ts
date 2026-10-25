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
  const emptyTemplates = { format: 'reset-template-inventory-v1', snapshotId: base.snapshotId,
    templateCount: 0, slotCount: 0, orphanSlots: 0, templates: [] as Record<string, unknown>[],
    references: [
      ['public.cleaning_targets', 'template_snapshot.id'], ['public.cleaning_attempts', 'template_snapshot.id'],
      ['private.target_photo_snapshot_contracts', 'frozen_snapshot.templateVersionId'],
      ['private.target_photo_slot_snapshots', 'template_version_id'],
      ['private.flat_evidence_migration_receipts', 'previous_template_snapshot.id'],
      ['private.flat_evidence_migration_receipts', 'previous_photo_contract.templateVersionId'],
      ['private.flat_evidence_migration_receipts', 'previous_slots.template_version_id'],
    ].map(([relation, path]) => ({ relation, path, sourceRows: 0, edgeRows: 0, absent: 0, malformed: 0, detached: 0, matched: 0 })) };
  const templates = { ...emptyTemplates, templateCount: 3, slotCount: 6,
    templates: ['draft', 'published', 'retired'].map((status, index) => ({
      sourceId: `39000000-0000-4000-8000-00000000000${index + 1}`, status, cleaningKind: 'checkout',
      contentDigest: 'b'.repeat(64), slotRows: status === 'draft' ? 0 : 3,
      historicallyReadable: true, registrationShapeValid: true, slotProjectionMatches: true,
      versionAvailable: true, currentPublicationPathSupported: true, creatorExists: true,
    })) };
  const counts = new Map([['public.cleaning_template_versions', 3], ['private.photo_template_slots', 6]]);
  const templateBase = { ...base, relations: relations.map(row => ({ ...row, observedRows: counts.get(row.relation) ?? 0 })) };
  const templateRows = { ...rowImpact, relations: rowImpact.relations.map(row => ({ ...row,
    rowCount: counts.get(row.relation) ?? 0, counts: { ...row.counts, templateSource: counts.get(row.relation) ?? 0 } })) };
  return [
    { name: 'legacy-uncollected', input: base },
    { name: 'unknown', input: { ...base, rowImpact, gateEvidence: unknown } },
    { name: 'configured', input: { ...base, rowImpact, gateEvidence: configured } },
    { name: 'started', input: { ...base, rowImpact, gateEvidence: { ...configured, lifecycle: 'STARTED' } } },
    { name: 'unfinished-effects', input: { ...base, rowImpact, gateEvidence: { ...configured,
      unfinishedAdmissions: 2, expiredUnfinishedAdmissions: 1, unresolvedPasswordChanges: 1, preparedPasswordResets: 1 } } },
    { name: 'templates-empty', input: { ...base, rowImpact, gateEvidence: configured, templateEvidence: emptyTemplates } },
    { name: 'templates-all-statuses', input: { ...templateBase, rowImpact: templateRows, gateEvidence: configured, templateEvidence: templates } },
    { name: 'templates-history-problem', input: { ...templateBase, rowImpact: templateRows, gateEvidence: configured,
      templateEvidence: { ...templates, templates: templates.templates.map(row => row.status === 'retired'
        ? { ...row, historicallyReadable: false, registrationShapeValid: false } : row) } } },
  ];
}
export function resetPreviewContractResponses() {
  return resetPreviewContractInputs().map(({ name, input }) => ({ name, body: summarizeResetPreview(input) }));
}
