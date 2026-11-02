import { requestHash } from '../../lib/command.js';
import type { templateReseedPlanSchema } from './template-reseed-plan.js';
import type { z } from 'zod';

/** 2026-10-25 human choice. A policy selection, never an execution approval or
 * evidence that this policy has already been installed on the target database. */
export const RESET_HANDOVER_POLICY = Object.freeze({
  id: 'reset-handover-2026-10-25-r1-t1-s1' as const,
  reauthenticationTtlSeconds: 300,
  templateSelection: 'CURRENT_PUBLISHED' as const,
  registrationStatus: 'draft' as const,
  publication: 'AFTER_CONTENT_AND_CURRENT_FORMAT_VALIDATION' as const,
  historicalReferences: 'PRESERVE_WITHOUT_REWIRING' as const,
});
export const RESET_HANDOVER_POLICY_FINGERPRINT = requestHash(RESET_HANDOVER_POLICY);

/** The value comes from the existing owned content collector, not HTTP input.
 * Matching configuration does not prove recent reauthentication or permission. */
export function inspectHandoverReauthenticationPolicy(value: string | null) {
  if (value !== null && (typeof value !== 'string' || !/^[1-9][0-9]{0,9}$/.test(value) || Number(value) > 2147483647)) {
    throw new Error('RESET_REAUTH_POLICY_VALUE_INVALID');
  }
  const configuredTtlSeconds = value === null ? null : Number(value);
  const matchesApprovedPolicy = configuredTtlSeconds === RESET_HANDOVER_POLICY.reauthenticationTtlSeconds;
  return { requiredTtlSeconds: RESET_HANDOVER_POLICY.reauthenticationTtlSeconds, configuredTtlSeconds,
    matchesApprovedPolicy, executionEnabled: false as const,
    blockers: matchesApprovedPolicy ? [] : [value === null ? 'RESET_REAUTH_POLICY_NOT_INSTALLED' : 'RESET_REAUTH_POLICY_MISMATCH'] };
}

type TemplateEvidence = { sourceId: string; status: string; cleaningKind: string;
  registrationShapeValid: boolean; currentPublicationPathSupported: boolean; versionAvailable: boolean };
/** The general inventory still diagnoses every status. T1 narrows only fresh
 * registration checks; it never drops unreadable history or protection blockers. */
export function approvedTemplateSelectionEvidence(rows: TemplateEvidence[], inventoryBlockers: string[]) {
  const selected = rows.filter(row => row.status === 'published');
  const blockers = inventoryBlockers.filter(code => ![
    'TEMPLATE_SELECTION_AND_STATUS_POLICY_REQUIRED', 'TEMPLATE_FRESH_REGISTRATION_SHAPE_INCOMPATIBLE',
    'TEMPLATE_EXISTING_PUBLICATION_PATH_NOT_APPLICABLE', 'TEMPLATE_VERSION_RANGE_EXHAUSTED',
  ].includes(code));
  if (selected.some(row => !row.registrationShapeValid)) blockers.push('TEMPLATE_SELECTED_REGISTRATION_SHAPE_INCOMPATIBLE');
  if (selected.some(row => !row.currentPublicationPathSupported)) blockers.push('TEMPLATE_SELECTED_PUBLICATION_PATH_NOT_APPLICABLE');
  if (selected.some(row => !row.versionAvailable)) blockers.push('TEMPLATE_SELECTED_VERSION_RANGE_EXHAUSTED');
  const registrationShapeCompatible = selected.length > 0 && selected.every(row =>
    row.registrationShapeValid && row.currentPublicationPathSupported && row.versionAvailable);
  if (!selected.length) blockers.push('TEMPLATE_NO_CURRENT_PUBLICATION');
  return { selectedCount: selected.length, excludedCount: rows.length - selected.length,
    registrationShapeCompatible, executionEnabled: false as const, blockers };
}

type Content = z.infer<typeof templateReseedPlanSchema>['sources'][number]['content'];
type Source = { id: string; version: number; status: 'draft' | 'published' | 'retired'; content: Content };
type Replacement = { sourceId: string; newId: string; content: Content };
// Exact existing SQL canonical v9 shape, including labels and absence of extra
// fields. A role/count-only check would incorrectly choose the v9 version floor.
const flatSlots = [
  { slotKey: 'cleaning-proof', displayOrder: 0, required: true, label: '청소 사진', maxPhotos: 20 },
  { slotKey: 'bomb-proof', displayOrder: 1, required: false, label: '폭탄방 증빙', maxPhotos: 10 },
  { slotKey: 'issue-proof', displayOrder: 2, required: false, label: '특이사항 증빙', maxPhotos: 10 },
];
/** Called with the builder's already validated complete inventory. This only
 * plans draft rows; the existing same-snapshot source129 checks publication.
 * Previous rows/references are retained, never retired, rewritten or deleted. */
export function planApprovedTemplateLifecycle(templates: Source[], replacements: Replacement[]) {
  const drafts = replacements.map(replacement => {
    const source = templates.find(t => t.id === replacement.sourceId);
    if (source?.status !== 'published') throw new Error('RESET_TEMPLATE_SELECTION_MISMATCH');
    const group = templates.filter(t => t.content.roomTypeId === source.content.roomTypeId &&
      t.content.cleaningKind === source.content.cleaningKind);
    const maximumVersion = Math.max(...group.map(t => t.version));
    if (maximumVersion >= 2147483647) throw new Error('RESET_TEMPLATE_VERSION_EXHAUSTED');
    const slots = [...replacement.content.slots].sort((a, b) => a.displayOrder - b.displayOrder);
    const minimumVersion = requestHash(slots) === requestHash(flatSlots) ? 9 : 8;
    return { sourceId: source.id, newId: replacement.newId, expectedCurrentVersion: source.version,
      maximumVersion, version: Math.max(maximumVersion + 1, minimumVersion), status: 'draft' as const,
      publicationRequired: true as const };
  });
  return { policy: RESET_HANDOVER_POLICY, policyFingerprint: RESET_HANDOVER_POLICY_FINGERPRINT,
    drafts, preservedSourceIds: templates.map(t => t.id).sort(), referencesRewired: false as const,
    publicationExecuted: false as const, executionEnabled: false as const };
}
