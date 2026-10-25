import { z } from 'zod';
import { copyMigrationData } from '../../../scripts/lib/migration-evidence-input.mjs';
import { RESET_REVIEW_REQUIREMENTS } from '../../../scripts/reset-review-requirements.mjs';
import { requestHash } from '../../lib/command.js';
import { inspectResetReferenceCapture, resetReferenceCaptureSchema } from './reset-reference-plan.js';
import { resetRelationGroups, resetRowRuleFingerprint } from './reset-preview-groups.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const bindingSchema = z.object({ projectRef: z.string().regex(/^[a-z]{20}$/), sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  catalogFingerprint: hash, classificationFingerprint: hash, contentFingerprint: hash, snapshotId: hash }).strict();
const schema = z.object({ binding: bindingSchema,
  selection: z.object({ binding: bindingSchema, templateSelection: z.enum(['CURRENT_PUBLISHED', 'ALL_VERSIONS']).nullable(),
    requestFingerprint: hash, reviewPlanFingerprint: hash.nullable() }).strict(),
  referenceCapture: resetReferenceCaptureSchema,
}).strict();

const fixed = { executionEnabled: false as const, executionGranted: false as const, liveDatabaseVerified: false as const,
  completeResetCoverage: false as const, backupVerified: false as const, restoreVerified: false as const,
  reservationBackupAcceptedAsResetProof: false as const };
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const identity = (relation: string, key: string) => `${relation}:${key}`;
const appRelations = new Set<string>(Object.values(resetRelationGroups).flat());
const requiredRelations = new Set([...appRelations, 'auth.users']);
const preserve = new Set<string>(resetRelationGroups.preserve);
const template = new Set<string>(resetRelationGroups.reseed);
const reviewDomains = new Map(RESET_REVIEW_REQUIREMENTS.flatMap(group => group.relations.map(relation => [relation, group.code] as const)));
const photo = new Set(RESET_REVIEW_REQUIREMENTS.filter(group => group.code === 'PHOTO_AND_EVIDENCE').flatMap(group => [...group.relations]));
photo.add('public.submission_photos');
// Only existing, reviewed clear relations get these domain-specific requirements.
// Naming a domain never selects an operation or changes a candidate disposition.
const payroll = new Set(['public.compensation_entitlements', 'public.earnings', 'public.payroll_adjustment_books',
  'public.payroll_adjustment_items', 'public.payroll_adjustments', 'public.payroll_carry_items', 'public.payroll_cycles',
  'public.payroll_events', 'public.payroll_items', 'public.payroll_offset_settlements', 'public.payroll_payment_attempts',
  'public.payroll_payment_results', 'public.payroll_residual_carries']);
function domain(relation: string) {
  if (relation === 'auth.users') return 'AUTH_BOUNDARY';
  if (photo.has(relation)) return 'PHOTO_AND_EVIDENCE';
  if (preserve.has(relation)) return 'PRESERVED_HISTORY_AND_REFERENCE';
  if (template.has(relation)) return 'TEMPLATE_HISTORY';
  if (payroll.has(relation)) return 'PAYROLL_HISTORY';
  return reviewDomains.get(relation) ?? 'APP_BUSINESS';
}
const requirements: Readonly<Record<string, readonly string[]>> = {
  AUTH_BOUNDARY: ['AUTH_IDENTITY_RECOVERY_NOT_VERIFIED', 'AUTH_SESSION_DRAIN_NOT_VERIFIED'],
  ACCOUNT_SECURITY: ['DEVELOPER_SECURITY_PRESERVATION_NOT_VERIFIED', 'AUTH_SESSION_DRAIN_NOT_VERIFIED'],
  PHOTO_AND_EVIDENCE: ['PHOTO_HOLD_REQUIRES_IN_PLACE_PRESERVATION', 'PROVIDER_OBJECTS_NOT_VERIFIED'],
  PIN_AND_SHEET: ['PIN_KEY_VERSION_AND_AAD_RECOVERY_NOT_VERIFIED', 'PIN_NONCE_HISTORY_PRESERVATION_REQUIRED', 'PHYSICAL_LOCK_OUTSIDE_DB_RECOVERY'],
  PAYROLL_HISTORY: ['IMMUTABLE_LEDGER_RECOVERY_NOT_VERIFIED', 'NO_EXTERNAL_PAYMENT_OR_DELIVERY'],
  TEMPLATE_HISTORY: ['ORIGINAL_TEMPLATE_HISTORY_PROTECTION_NOT_VERIFIED', 'NO_HISTORICAL_REFERENCE_REWRITE'],
  PRESERVED_HISTORY_AND_REFERENCE: ['IN_PLACE_PRESERVATION_NOT_VERIFIED'],
  APP_BUSINESS: ['EXACT_ROW_RECOVERY_NOT_VERIFIED', 'NO_OUTBOX_REDELIVERY'],
};

/** Internal impact model over the existing opaque FK capture. Its caller is the
 * owning builder/composer, after independent content/census/NULL checks. This
 * function alone cannot prove that capture happened. It accepts no backup proof,
 * provider result, authorization Boolean, secret, raw row value or restore SQL.
 * The full review plan already binds the existing logical/template inspections;
 * this model computes FK closure only and never promotes history to live edges.
 */
export function inspectResetProtectionPlan(input: unknown) {
  const invalid = (blockers: string[]) => ({ ...fixed, manifestPrepared: false as const,
    manifestFingerprint: null, selectionBinding: null, counts: null, relations: null, domains: null, blockers });
  try {
    const parsed = schema.safeParse(copyMigrationData(input));
    if (!parsed.success) return invalid(['RESET_PROTECTION_INPUT_INVALID']);
    const p = parsed.data, graph = p.referenceCapture;
    if (requestHash(p.binding) !== requestHash(p.selection.binding) ||
        p.binding.catalogFingerprint !== graph.catalogFingerprint || graph.snapshotCatalogFingerprint !== p.binding.catalogFingerprint) {
      return invalid(['RESET_PROTECTION_BINDING_CHANGED']);
    }
    if (p.binding.classificationFingerprint !== resetRowRuleFingerprint) return invalid(['RESET_PROTECTION_CLASSIFICATION_CHANGED']);
    const supplied = new Set(graph.relations);
    if (supplied.size !== requiredRelations.size || [...requiredRelations].some(name => !supplied.has(name))) {
      return invalid(['RESET_PROTECTION_RELATION_COVERAGE_INCOMPLETE']);
    }
    // The existing inspector owns coverage, FK identity, duplicates and null edges.
    // Only a disposition conflict may produce a diagnostic, never a valid plan.
    const checked = inspectResetReferenceCapture(graph);
    if (checked.blockers.some(code => code !== 'PRESERVED_ROW_REFERENCES_REMOVED_ROW')) {
      return invalid(['RESET_PROTECTION_REFERENCE_CAPTURE_INVALID']);
    }
    if (graph.rows.some(row => !/^[a-f0-9]{64}$/.test(row.key) || row.references.some(ref => ref.targetKey !== null && !/^[a-f0-9]{64}$/.test(ref.targetKey)))) {
      return invalid(['RESET_PROTECTION_OPAQUE_IDENTITY_REQUIRED']);
    }
    const rows = new Map(graph.rows.map(row => [identity(row.relation, row.key), row]));
    const targets = new Map(graph.foreignKeys.map(fk => [identity(fk.source, fk.name), fk.target]));
    const roots = graph.rows.filter(row => row.disposition === 'keep' || preserve.has(row.relation) || photo.has(row.relation));
    const required = new Set(roots.map(row => identity(row.relation, row.key)));
    const queue = [...required];
    for (let at = 0; at < queue.length; at++) {
      const row = rows.get(queue[at] ?? '');
      if (!row) return invalid(['RESET_PROTECTION_REFERENCE_CAPTURE_INVALID']);
      for (const ref of row.references) {
        if (ref.targetKey === null) continue;
        const target = targets.get(identity(row.relation, ref.constraint));
        if (!target) return invalid(['RESET_PROTECTION_REFERENCE_CAPTURE_INVALID']);
        const id = identity(target, ref.targetKey);
        if (!rows.has(id)) return invalid(['RESET_PROTECTION_REFERENCE_CAPTURE_INVALID']);
        if (!required.has(id)) { required.add(id); queue.push(id); }
      }
    }
    const relationCounts = new Map([...requiredRelations].sort(compare).map(relation => [relation, {
      relation, domain: domain(relation), captured: 0, kept: 0, removalCandidates: 0, pending: 0,
      requiredByPreservation: 0, preservationConflicts: 0,
    }]));
    for (const row of graph.rows) {
      const count = relationCounts.get(row.relation);
      if (!count) return invalid(['RESET_PROTECTION_RELATION_COVERAGE_INCOMPLETE']);
      count.captured++;
      if (row.disposition === 'keep') count.kept++;
      else if (row.disposition === 'remove') count.removalCandidates++;
      else count.pending++;
      if (required.has(identity(row.relation, row.key))) {
        count.requiredByPreservation++;
        if (row.disposition === 'remove') count.preservationConflicts++;
      }
    }
    const relations = [...relationCounts.values()];
    const domains = [...new Set(relations.map(row => row.domain))].sort(compare).map(name => ({
      domain: name, captured: relations.filter(row => row.domain === name).reduce((sum, row) => sum + row.captured, 0),
      backup: 'NOT_OBSERVED' as const, restore: 'NOT_OBSERVED' as const,
      requirements: [...(requirements[name] ?? ['EXACT_ROW_RECOVERY_NOT_VERIFIED', 'NO_OUTBOX_REDELIVERY'])],
    }));
    const counts = { relations: relations.length, rows: graph.rows.length, preservationRoots: roots.length,
      requiredByPreservation: required.size, preservationConflicts: relations.reduce((sum, row) => sum + row.preservationConflicts, 0),
      removalCandidates: relations.reduce((sum, row) => sum + row.removalCandidates, 0),
      pending: relations.reduce((sum, row) => sum + row.pending, 0) };
    const blockers = new Set(['RESET_PROTECTION_LIVE_BACKUP_AND_RESTORE_NOT_VERIFIED',
      'RESET_PROTECTION_CAPACITY_LOCATION_RETENTION_NOT_VERIFIED', 'RESET_PROTECTION_RESERVATION_BACKUP_INSUFFICIENT']);
    if (counts.preservationConflicts) blockers.add('RESET_PROTECTION_PRESERVATION_CONFLICT');
    if (counts.pending) blockers.add('RESET_PROTECTION_DISPOSITIONS_UNRESOLVED');
    if (!p.selection.templateSelection) blockers.add('RESET_PROTECTION_SELECTION_REQUIRED');
    if (!p.selection.reviewPlanFingerprint) blockers.add('RESET_PROTECTION_FINAL_REVIEW_NOT_COMPOSED');
    const sortedRows = [...graph.rows].map(row => ({ ...row,
      references: [...row.references].sort((a, b) => compare(a.constraint, b.constraint)) })).sort((a, b) => compare(identity(a.relation, a.key), identity(b.relation, b.key)));
    const selectionBinding = p.selection.reviewPlanFingerprint ? 'REVIEW_PLAN' as const : 'CAPTURE_INTENT_ONLY' as const;
    return { ...fixed, manifestPrepared: true as const, selectionBinding, counts, relations, domains,
      manifestFingerprint: requestHash({ format: 'reset-protection-plan-v1', binding: p.binding, selection: p.selection,
        graph: { rows: sortedRows, foreignKeys: [...graph.foreignKeys].sort((a, b) => compare(identity(a.source, a.name), identity(b.source, b.name))) },
        relations, domains }), blockers: [...blockers].sort(compare) };
  } catch { return invalid(['RESET_PROTECTION_INPUT_INVALID']); }
}
