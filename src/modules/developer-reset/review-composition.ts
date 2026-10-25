import { createHash } from 'node:crypto';
import { z } from 'zod';
import { requestHash } from '../../lib/command.js';
import { inspectResetLogicalReferences } from './logical-reference-inspector.js';
import { RESET_LOGICAL_REFERENCE_RULES, RESET_LOGICAL_REFERENCE_REGISTRY_FINGERPRINT } from './logical-reference-registry.js';
import { summarizeOperationGates } from './operation-gates.js';
import { createResetReceipt, inspectResetReceipt } from './reset-receipt.js';
import { RESET_TEMPLATE_REFERENCE_PATHS, summarizeResetTemplateEvidence } from './reset-template-evidence.js';
import { buildTemplateReseedProposal, templateInventoryFingerprint } from './template-plan-builder.js';
import { captureResetPlanTemplate, resetPlanTemplateDependencies } from './plan-revalidation.js';
import { RESET_HANDOVER_POLICY, RESET_HANDOVER_POLICY_FINGERPRINT, inspectHandoverReauthenticationPolicy, approvedTemplateSelectionEvidence } from './approved-handover-policy.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const surface = z.object({ relation: z.string().max(128), path: z.string().max(160) }).strict();
const receiptIntent = z.object({ actorProfileId: z.uuid(), authUserId: z.uuid(), sessionDigest: hash,
  passwordVersionDigest: hash, expectedPostconditionFingerprint: hash, policyHash: hash,
  approvalScopeHash: hash, backupProofHash: hash, idempotencyKeyDigest: hash,
  expiresAt: z.number().int().min(1).max(8640000000000000),
  steps: z.array(z.object({ id: hash, kind: z.enum(['DATABASE', 'AUTH', 'EXTERNAL']) }).strict()).min(1).max(100),
}).strict();
/** Server-selected inventory/intent only. Explicit selection must match the
 * approved T1 policy; null still permits an incomplete diagnostic review. */
export const resetReviewRequestSchema = z.object({
  surfaces: z.array(surface).max(1000),
  templateSelection: z.literal(RESET_HANDOVER_POLICY.templateSelection).nullable(),
  developerId: z.uuid().nullable(), receipt: receiptIntent.nullable(),
}).strict();
export type ResetReviewRequest = z.infer<typeof resetReviewRequestSchema>;
export type ReviewCell = { name: string; pgType: string; value: string | null };
export type ReviewRow = { relation: string; key: string; keyFields: string[]; values: ReviewCell[];
  disposition: 'keep' | 'remove' | 'roomBaseline' | 'templateSource' | 'unresolved' };
type Binding = { projectRef: string; sourceCommit: string; catalogFingerprint: string;
  classificationFingerprint: string; contentFingerprint: string; snapshotId: string };
const ownedFailures = new WeakMap<object, string>();
const fail = (code: string): never => {
  const error = new Error('RESET_REVIEW_REJECTED'); ownedFailures.set(error, code); throw error;
};
/** Return only the private registration's fixed code, never error.message/cause. */
export const resetReviewFailureCode = (error: unknown) => error !== null && typeof error === 'object'
  ? ownedFailures.get(error) : undefined;
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const value = (row: ReviewRow, name: string) => {
  const found = row.values.find(cell => cell.name === name);
  return found ? found.value : fail('RESET_REVIEW_COLUMN_MISSING');
};
const text = (row: ReviewRow, name: string) => value(row, name) ?? fail('RESET_REVIEW_VALUE_INVALID');
const integer = (v: string) => /^(0|[1-9][0-9]*)$/.test(v) && Number.isSafeInteger(Number(v))
  ? Number(v) : fail('RESET_REVIEW_VALUE_INVALID');
const json = (v: string | null): unknown => v === null ? null : JSON.parse(v) as unknown;
const objectField = (v: unknown, key: string): unknown => v && typeof v === 'object' && !Array.isArray(v)
  ? (v as Record<string, unknown>)[key] ?? null : null;
const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
// Exact PG UTC timestamp codec; retain microseconds rather than rounding to JS milliseconds.
function pgTime(v: string): { iso: string; micros: bigint } {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d{1,6})?\+00$/.exec(v);
  if (!m) return fail('RESET_REVIEW_TIMESTAMP_UNSUPPORTED');
  const base = `${m[1]}T${m[2]}Z`, ms = Date.parse(base);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().replace('.000Z', 'Z') !== base) return fail('RESET_REVIEW_TIMESTAMP_UNSUPPORTED');
  return { iso: `${m[1]}T${m[2]}${m[3] ?? ''}Z`, micros: BigInt(ms) * 1000n + BigInt((m[3]?.slice(1) ?? '').padEnd(6, '0')) };
}
const sidecarSchema = z.object({ scopeId: hash, statementId: hash, statementAt: z.string().max(64),
  templateEvidence: z.unknown(), gateEvidence: z.unknown() }).strict();

/** Called only inside the one-use snapshot builder after BOTH independent row
 * observations and the complete census agree. It returns summaries and a bound
 * PREPARED receipt candidate, never rows, template provenance, an executable plan
 * or a reusable capture capability. Synthetic ports still cannot prove live DB.
 */
export function composeResetReview(input: { request: ResetReviewRequest; binding: Binding; scopeId: string;
  relations: readonly string[]; rows: ReviewRow[]; independent: { relation: string; key: string }[];
  census: { relation: string; count: number }[]; sidecar: unknown; pending: string[];
}, planCapture?: object) {
  const { request, binding, rows } = input;
  const sidecar = sidecarSchema.parse(input.sidecar);
  if (sidecar.scopeId !== input.scopeId) return fail('RESET_REVIEW_MIXED_SCOPE');
  const statement = pgTime(sidecar.statementAt);
  const get = (name: string) => {
    if (!input.relations.includes(name)) return fail('RESET_REVIEW_RELATION_MISSING');
    return rows.filter(row => row.relation === name);
  };
  const census = new Map(input.census.map(row => [row.relation, { known: true as const, count: row.count }]));
  const blockers = new Set(input.pending);
  if (request.developerId) {
    if (request.receipt && request.receipt.actorProfileId.toLowerCase() !== request.developerId.toLowerCase()) return fail('RESET_REVIEW_ACTOR_MISMATCH');
    const allProfiles = get('public.profiles');
    if (allProfiles.filter(row => text(row, 'role') === 'developer').length !== 1) return fail('RESET_REVIEW_ACTOR_UNAVAILABLE');
    const profiles = allProfiles.filter(row => text(row, 'id').toLowerCase() === request.developerId?.toLowerCase());
    const profile = profiles.length === 1 ? profiles[0] : undefined;
    if (!profile || text(profile, 'role') !== 'developer' || text(profile, 'status') !== 'active' ||
      text(profile, 'must_change_password') !== 'false') return fail('RESET_REVIEW_ACTOR_UNAVAILABLE');
    const authId = text(profile, 'auth_user_id').toLowerCase();
    if (get('auth.users').filter(row => text(row, 'id').toLowerCase() === authId).length !== 1 ||
      (request.receipt && request.receipt.authUserId.toLowerCase() !== authId)) return fail('RESET_REVIEW_ACTOR_MISMATCH');
    // This is same-snapshot consistency, not a fresh session/reauthentication proof.
  }
  const expectedSurfaces = new Set(request.surfaces.map(s => `${s.relation}:${s.path}`));
  if (RESET_LOGICAL_REFERENCE_RULES.some(s => !expectedSurfaces.has(`${s.relation}:${s.path}`))) {
    return fail('RESET_REVIEW_SURFACE_INVENTORY_INCOMPLETE');
  }
  const disposition = (row: ReviewRow) => row.disposition === 'keep' ? 'preserve' as const
    : row.disposition === 'templateSource' ? 'unresolved' as const : row.disposition;
  const observations = [];
  const logicalCensus = [];
  for (const s of request.surfaces) {
    const sourceRows = get(s.relation);
    if (sourceRows.some(row => row.disposition === 'unresolved' || row.disposition === 'templateSource')) {
      blockers.add('RESET_REVIEW_PRESERVATION_PLAN_UNRESOLVED');
    }
    const retained = sourceRows.filter(row => row.disposition === 'keep' || row.disposition === 'roomBaseline');
    const retainedKeys = new Set(retained.map(row => row.key));
    // Count from the independently collected content stream, not observations.
    logicalCensus.push({ ...s, count: input.independent.filter(row => row.relation === s.relation && retainedKeys.has(row.key)).length });
    const rule = RESET_LOGICAL_REFERENCE_RULES.find(r => r.relation === s.relation && r.path === s.path);
    for (const row of retained) {
      const before = value(row, s.path);
      const variant = s.relation === 'private.developer_catalog_previews' ? value(row, 'preview_kind')
        : s.relation === 'private.actor_activity_events' ? value(row, 'resource_type') : null;
      let target = null;
      if (rule?.semantics === 'CURRENT_POINTER' && variant && before) {
        const relation = rule.targets[variant];
        if (relation) {
          // Only reviewed scalar UUID targets. Unknown/composite identities block.
          const matches = get(relation).filter(r => r.values.some(c => c.name === 'id' && c.pgType === 'pg_catalog.uuid' && c.value?.toLowerCase() === before.toLowerCase()));
          const found = matches.length === 1 ? matches[0] : undefined;
          if (found?.keyFields.length === 1 && found.keyFields[0] === 'id') target = { relation, value: before, disposition: disposition(found) };
        }
      }
      observations.push({ ...s, rowToken: row.key, disposition: row.disposition === 'keep' ? 'preserve' : 'roomBaseline',
        variant, before, retained: before, target });
    }
  }
  const logical = inspectResetLogicalReferences({ binding, surfaces: request.surfaces,
    registryFingerprint: RESET_LOGICAL_REFERENCE_REGISTRY_FINGERPRINT },
  { binding, complete: true, census: logicalCensus, observations });
  for (const code of logical.blockers) blockers.add(code);

  const templateEvidence = summarizeResetTemplateEvidence(sidecar.templateEvidence, census, sidecar.statementId);
  if (!templateEvidence.available) return fail('RESET_REVIEW_TEMPLATE_EVIDENCE_MISSING');
  const templates = get('public.cleaning_template_versions').map(row => ({
    id: text(row, 'id').toLowerCase(), content: { roomTypeId: text(row, 'room_type_id').toLowerCase(), cleaningKind: text(row, 'cleaning_kind'),
      durationMinutes: value(row, 'duration_minutes') === null ? null : integer(text(row, 'duration_minutes')), slots: json(value(row, 'photo_slots')) },
    status: text(row, 'status'), version: integer(text(row, 'version')), createdBy: text(row, 'created_by').toLowerCase(), createdAt: pgTime(text(row, 'created_at')).iso,
  }));
  const ids = new Set(templates.map(t => t.id));
  const references: { referenceId: string; sourceId: string; kind: 'HISTORICAL_SNAPSHOT' }[] = [];
  const refCounts = { edges: 0, absent: 0, malformed: 0, detached: 0, matched: 0 };
  // Projection of the SAME seven paths owned by source129, not a new reference registry.
  for (const [relation, path] of RESET_TEMPLATE_REFERENCE_PATHS) {
    const [column, nested] = path.split('.');
    if (!column) return fail('RESET_REVIEW_TEMPLATE_PATH_INVALID');
    for (const row of get(relation)) {
      const raw = value(row, column);
      const field = nested ? json(raw) : raw;
      const values = column === 'previous_slots'
        ? Array.isArray(field) ? field.map(item => objectField(item, nested ?? '')) : [false]
        : [nested ? objectField(field, nested) : field];
      for (const [index, found] of values.entries()) {
        refCounts.edges++;
        if (refCounts.edges > 10000) return fail('RESET_REVIEW_REFERENCE_LIMIT');
        if (found === null) { refCounts.absent++; continue; }
        if (typeof found !== 'string' || !uuid.test(found)) { refCounts.malformed++; continue; }
        const sourceId = found.toLowerCase();
        if (ids.has(sourceId)) refCounts.matched++; else refCounts.detached++;
        const id = requestHash({ row: row.key, relation, path, index });
        const referenceId = `${id.slice(0, 8)}-${id.slice(8, 12)}-4${id.slice(13, 16)}-8${id.slice(17, 20)}-${id.slice(20, 32)}`;
        references.push({ referenceId, sourceId, kind: 'HISTORICAL_SNAPSHOT' });
        if (references.length > 10000) return fail('RESET_REVIEW_REFERENCE_LIMIT');
      }
    }
  }
  if (requestHash(refCounts) !== requestHash(templateEvidence.referenceCounts)) return fail('RESET_REVIEW_TEMPLATE_REFERENCE_DRIFT');
  const evidenceRows = (sidecar.templateEvidence as { templates: { sourceId: string; status: string; cleaningKind: string;
    registrationShapeValid: boolean; currentPublicationPathSupported: boolean; versionAvailable: boolean }[] }).templates;
  if (templates.some(t => !evidenceRows.some(e => e.sourceId.toLowerCase() === t.id && e.status === t.status && e.cleaningKind === t.content.cleaningKind))) {
    return fail('RESET_REVIEW_TEMPLATE_CONTENT_DRIFT');
  }
  const selectedEvidence = request.templateSelection ? approvedTemplateSelectionEvidence(evidenceRows, templateEvidence.blockers) : null;
  for (const code of selectedEvidence?.blockers ?? templateEvidence.blockers) blockers.add(code);
  const templateDigest = templateInventoryFingerprint(templates, references);
  const templateBinding = { projectRef: binding.projectRef, sourceCommit: binding.sourceCommit, catalogFingerprint: binding.catalogFingerprint,
    snapshotId: binding.snapshotId, contentFingerprint: templateDigest };
  const proposal = request.templateSelection && request.developerId ? buildTemplateReseedProposal({ expected: templateBinding,
    developerId: request.developerId, selection: request.templateSelection, handoverPolicy: RESET_HANDOVER_POLICY.id,
    inventory: { binding: templateBinding, complete: true, referencesComplete: true, templateCount: templates.length,
      referenceCount: references.length, templates, references } }, planCapture ? resetPlanTemplateDependencies(planCapture) : undefined) : null;
  if (planCapture) captureResetPlanTemplate(planCapture, proposal);
  if (!proposal) blockers.add('RESET_REVIEW_TEMPLATE_SELECTION_REQUIRED');
  const proposalBlockers = (proposal?.blockers ?? []).filter(code =>
    code !== 'TEMPLATE_PUBLICATION_COMPATIBILITY_NOT_VERIFIED' || !selectedEvidence?.registrationShapeCompatible);
  for (const code of proposalBlockers) blockers.add(code);

  const gates = summarizeOperationGates(sidecar.gateEvidence);
  const control = get('private.developer_operation_control');
  if (control.length > 1 || (control.length === 1) !== gates.policyConfigured) return fail('RESET_REVIEW_GATE_CONTROL_DRIFT');
  const c = control[0];
  if (c && (text(c, 'singleton') !== 'true' || text(c, 'target_ref') !== binding.projectRef || text(c, 'version') !== gates.controlVersion ||
    text(c, 'lifecycle') !== gates.lifecycle || text(c, 'maintenance') !== gates.maintenance)) return fail('RESET_REVIEW_GATE_CONTROL_DRIFT');
  const reauthenticationPolicy = inspectHandoverReauthenticationPolicy(c ? text(c, 'reauth_ttl_seconds') : null);
  for (const code of reauthenticationPolicy.blockers) blockers.add(code);
  const unfinished = get('private.developer_operation_admissions').filter(row => value(row, 'completed_at') === null);
  const expired = unfinished.filter(row => pgTime(text(row, 'deadline_at')).micros <= statement.micros).length;
  const passwords = get('private.password_change_commands').filter(row => ['auth_pending', 'inconsistent', 'reset_pending'].includes(text(row, 'state'))).length;
  const resets = get('private.password_reset_auth_markers').filter(row => text(row, 'state') === 'prepared').length;
  if (gates.unfinishedAdmissions !== unfinished.length || gates.expiredUnfinishedAdmissions !== expired ||
      gates.unresolvedPasswordChanges !== passwords || gates.preparedPasswordResets !== resets) return fail('RESET_REVIEW_GATE_CENSUS_DRIFT');
  for (const code of gates.blockers) blockers.add(code);
  blockers.add('RESET_REVIEW_FULL_COVERAGE_NOT_VERIFIED');
  const planFingerprint = requestHash({ binding, logical, templateEvidence, templateProposal: proposal?.planFingerprint ?? null,
    templateSelection: request.templateSelection, selectedEvidence, handoverPolicy: RESET_HANDOVER_POLICY_FINGERPRINT,
    gates, reauthenticationPolicy, pending: input.pending,
    dispositions: rows.map(({ relation, key, disposition }) => ({ relation, key, disposition })).sort((a, b) => order(`${a.relation}:${a.key}`, `${b.relation}:${b.key}`)) });
  // Explicit inputs are intent, not proof of approval/backup/fresh authentication.
  // A candidate does not clear any blocker and cannot authorize an effect.
  const receipt = request.receipt && logical.logicalReferencesValid && proposal?.generated
    ? (() => {
      const { idempotencyKeyDigest, expiresAt, steps, ...intentBinding } = request.receipt;
      const createdAt = Date.now();
      return createResetReceipt({ binding: { ...intentBinding, projectRef: binding.projectRef, sourceCommit: binding.sourceCommit,
        catalogFingerprint: binding.catalogFingerprint, contentFingerprint: binding.contentFingerprint, planFingerprint },
      idempotencyKeyDigest, createdAt, expiresAt, steps }, createdAt);
    })() : null;
  if (!request.receipt) blockers.add('RESET_REVIEW_RECEIPT_INTENT_REQUIRED');
  else if (!receipt) blockers.add('RESET_REVIEW_RECEIPT_NOT_PREPARED');
  // This projection helper cannot assert that its caller ran the collector.
  // Only the owning builder adds contentVerified/reviewPrepared after validation.
  return { executionEnabled: false, liveDatabaseVerified: false,
    completeResetCoverage: false, contentFingerprint: binding.contentFingerprint, planFingerprint,
    logical, templates: { evidence: templateEvidence, selectedEvidence, proposal: proposal ? { generated: proposal.generated,
      counts: proposal.counts, planFingerprint: proposal.planFingerprint, blockers: proposalBlockers,
      plannedDraftCount: proposal.handover?.drafts.length ?? null } : null }, gates,
    handoverPolicy: RESET_HANDOVER_POLICY, reauthenticationPolicy,
    receipt, receiptStatus: receipt ? inspectResetReceipt(receipt, receipt.createdAt) : null, blockers: [...blockers].sort() };
}

// Source-owned statement identity. Exported only to let the closed connector
// check that source129 ran in its current RR snapshot, not to accept caller SQL.
export function resetReviewStatementId(databaseSnapshot: string, statementAt: string) {
  return createHash('sha256').update(databaseSnapshot + statementAt).digest('hex');
}
