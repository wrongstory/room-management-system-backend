import { describe, expect, it, vi } from 'vitest';
import { buildTemplateReseedProposal, templateInventoryFingerprint } from '../src/modules/developer-reset/template-plan-builder.js';
import { RESET_HANDOVER_POLICY, RESET_HANDOVER_POLICY_FINGERPRINT, inspectHandoverReauthenticationPolicy,
  approvedTemplateSelectionEvidence } from '../src/modules/developer-reset/approved-handover-policy.js';
import { flatTemplateRequest } from './fixtures/cleaning-template-contract.js';
import { resetReviewFixture, reviewId } from './helpers/reset-review.js';

const id = reviewId;
const required = <T>(value: T | null | undefined): T => { if (value === null || value === undefined) throw new Error('fixture missing'); return value; };
function fixture() {
  const content = { roomTypeId: id(1), cleaningKind: 'checkout' as const, durationMinutes: null,
    slots: structuredClone(flatTemplateRequest.slots) };
  const templates = (['published', 'retired', 'draft'] as const).map((status, n) => ({ id: id(10 + n), status,
    version: 7 + n, createdBy: id(2), createdAt: '2026-01-01T00:00:00Z', content: structuredClone(content) }));
  const references = [{ referenceId: id(30), sourceId: id(11), kind: 'HISTORICAL_SNAPSHOT' as const }];
  const binding = { projectRef: 'a'.repeat(20), sourceCommit: 'b'.repeat(40), snapshotId: 'c'.repeat(64),
    catalogFingerprint: 'd'.repeat(64), contentFingerprint: templateInventoryFingerprint(templates, references) };
  return { expected: { ...binding }, developerId: id(3), selection: 'CURRENT_PUBLISHED' as const,
    handoverPolicy: RESET_HANDOVER_POLICY.id, inventory: { binding, complete: true as const, referencesComplete: true as const,
      templateCount: templates.length, referenceCount: references.length, templates, references } };
}
function rehash(f: ReturnType<typeof fixture>) {
  const hash = templateInventoryFingerprint(f.inventory.templates, f.inventory.references);
  f.expected.contentFingerprint = hash; f.inventory.binding.contentFingerprint = hash;
}
const dependencies = () => ({ now: () => new Date('2026-10-25T00:00:00Z'), newId: vi.fn(() => id(100)) });

describe('approved R1/T1/S1 policy (no DB, registration or publication)', () => {
  it('selects only current publication, plans a new draft after all version numbers and retains every source', () => {
    const f = fixture(), original = structuredClone(f), result = buildTemplateReseedProposal(f, dependencies());
    expect(result).toMatchObject({ generated: true, executionEnabled: false, counts: { selected: 1, excluded: 2 },
      handover: { policyFingerprint: RESET_HANDOVER_POLICY_FINGERPRINT, preservedSourceIds: [id(10), id(11), id(12)],
        drafts: [{ sourceId: id(10), newId: id(100), expectedCurrentVersion: 7, maximumVersion: 9, version: 10, status: 'draft' }],
        referencesRewired: false, publicationExecuted: false } });
    expect(result.blockers).not.toContain('TEMPLATE_STATUS_AND_VERSION_POLICY_REQUIRED');
    expect(result.blockers).toEqual(expect.arrayContaining(['TEMPLATE_HISTORY_PROTECTION_REQUIRED', 'TEMPLATE_DRAFT_REGISTRATION_NOT_EXECUTED', 'TEMPLATE_PUBLICATION_NOT_EXECUTED']));
    if (!result.generated) throw new Error('bad fixture');
    expect(result.plan.replacements[0]?.content).toEqual(original.inventory.templates[0]?.content);
    expect(result.plan.replacements[0]).toMatchObject({ createdBy: id(3), createdAt: '2026-10-25T00:00:00.000Z' });
    expect(result.plan.references).toEqual([]); expect(f).toEqual(original);
    expect(result.handover?.policy).toEqual(RESET_HANDOVER_POLICY);
  });
  it('requires the approved selection and rejects unknown policy before allocating IDs', () => {
    for (const patch of [{ selection: 'ALL_VERSIONS' }, { handoverPolicy: 'future-policy' }]) {
      const deps = dependencies(); expect(buildTemplateReseedProposal({ ...fixture(), ...patch }, deps).generated).toBe(false);
      expect(deps.newId).not.toHaveBeenCalled();
    }
  });
  it('preserves publication floors and never replaces old labels to make them compatible', () => {
    const f = fixture(); f.inventory.templates.forEach((row, n) => { row.version = n + 1; }); rehash(f);
    expect(buildTemplateReseedProposal(f, dependencies()).handover?.drafts[0]?.version).toBe(9);
    required(f.inventory.templates[0]).content.slots.reverse(); rehash(f);
    expect(buildTemplateReseedProposal(f, dependencies()).handover?.drafts[0]?.version).toBe(9);
    required(required(f.inventory.templates[0]).content.slots[0]).label = '기존 표시 내용'; rehash(f);
    const result = buildTemplateReseedProposal(f, dependencies());
    expect(result.handover?.drafts[0]?.version).toBe(8);
    expect(result.generated && result.plan.replacements[0]?.content.slots[0]?.label).toBe('기존 표시 내용');
    expect(result.blockers).toContain('TEMPLATE_PUBLICATION_COMPATIBILITY_NOT_VERIFIED');
  });
  it.each(['exhausted', 'duplicate', 'content-drift'] as const)('blocks %s without partial allocations', change => {
    const f = fixture();
    if (change === 'exhausted') required(f.inventory.templates[2]).version = 2147483647;
    if (change === 'duplicate') required(f.inventory.templates[2]).version = 7;
    if (change !== 'content-drift') rehash(f); else required(required(f.inventory.templates[0]).content.slots[0]).label = 'changed';
    const deps = dependencies(), result = buildTemplateReseedProposal(f, deps);
    expect(result.generated).toBe(false); expect(result.handover).toBeNull(); expect(deps.newId).not.toHaveBeenCalled();
  });
  it('narrows fresh registration checks while retaining all history/protection findings', () => {
    const rows = [{ sourceId: id(1), status: 'published', cleaningKind: 'checkout', registrationShapeValid: true,
      currentPublicationPathSupported: true, versionAvailable: true },
    { sourceId: id(2), status: 'retired', cleaningKind: 'reclean', registrationShapeValid: false,
      currentPublicationPathSupported: false, versionAvailable: false }];
    const result = approvedTemplateSelectionEvidence(rows, ['TEMPLATE_SELECTION_AND_STATUS_POLICY_REQUIRED',
      'TEMPLATE_FRESH_REGISTRATION_SHAPE_INCOMPATIBLE', 'TEMPLATE_EXISTING_PUBLICATION_PATH_NOT_APPLICABLE',
      'TEMPLATE_VERSION_RANGE_EXHAUSTED', 'TEMPLATE_HISTORICAL_SHAPE_UNREADABLE', 'TEMPLATE_HISTORY_ARCHIVE_NOT_VERIFIED']);
    expect(result).toMatchObject({ selectedCount: 1, excludedCount: 1, registrationShapeCompatible: true, executionEnabled: false });
    expect(result.blockers).toEqual(['TEMPLATE_HISTORICAL_SHAPE_UNREADABLE', 'TEMPLATE_HISTORY_ARCHIVE_NOT_VERIFIED']);
    required(rows[0]).registrationShapeValid = false;
    expect(approvedTemplateSelectionEvidence(rows, []).blockers).toContain('TEMPLATE_SELECTED_REGISTRATION_SHAPE_INCOMPATIBLE');
    expect(approvedTemplateSelectionEvidence([], []).blockers).toContain('TEMPLATE_NO_CURRENT_PUBLICATION');
  });
  it.each([null, '120', '301', '2147483647'])('does not claim policy installed for %s', value => {
    expect(inspectHandoverReauthenticationPolicy(value)).toMatchObject({ requiredTtlSeconds: 300, matchesApprovedPolicy: false, executionEnabled: false });
  });
  it.each(['0', '-1', '0300', '300.0', ' 300', '2147483648', 300, true, {}])('rejects malformed configured TTL %s', value => {
    expect(() => inspectHandoverReauthenticationPolicy(value as string)).toThrow('RESET_REAUTH_POLICY_VALUE_INVALID');
  });
  it('makes a matching 300-second configuration a diagnostic rather than fresh authentication', () => {
    expect(inspectHandoverReauthenticationPolicy('300')).toEqual({ requiredTtlSeconds: 300, configuredTtlSeconds: 300,
      matchesApprovedPolicy: true, executionEnabled: false, blockers: [] });
    expect(Object.isFrozen(RESET_HANDOVER_POLICY)).toBe(true);
  });
});

describe('approved policy in the actual snapshot composition', () => {
  it('binds the approved draft plan and policy without clearing historical/operational blockers', async () => {
    const f = resetReviewFixture(); const result = await f.run();
    expect(result.review).toMatchObject({ handoverPolicy: RESET_HANDOVER_POLICY,
      templates: { proposal: { plannedDraftCount: 1 }, selectedEvidence: { selectedCount: 1 } },
      reauthenticationPolicy: { matchesApprovedPolicy: false, configuredTtlSeconds: null }, executionEnabled: false });
    expect(result.review?.blockers).not.toContain('TEMPLATE_SELECTION_AND_STATUS_POLICY_REQUIRED');
    expect(result.review?.blockers).toEqual(expect.arrayContaining(['RESET_REAUTH_POLICY_NOT_INSTALLED', 'TEMPLATE_HISTORY_PROTECTION_REQUIRED', 'PRE_OPERATION_STATE_UNKNOWN', 'TEMPLATE_PUBLICATION_NOT_EXECUTED']));
    const text = JSON.stringify(result); expect(text).not.toContain(id(6)); expect(text).not.toContain('synthetic private slot');
  });
  it.each(['120', '300'])('reads actual configuration %s without upgrading lifecycle or authentication', async ttl => {
    const f = resetReviewFixture(); f.push('private.developer_operation_control', 50, { singleton: 'true', target_ref: 'a'.repeat(20),
      version: '1', lifecycle: 'UNKNOWN', maintenance: 'OPEN', reauth_ttl_seconds: ttl });
    f.refreshCensus(); Object.assign(f.sidecar.gateEvidence, { policyConfigured: true, lifecycle: 'UNKNOWN', controlVersion: '1', maintenance: 'OPEN' });
    const result = await f.run();
    expect(result.review?.reauthenticationPolicy).toMatchObject({ configuredTtlSeconds: Number(ttl), matchesApprovedPolicy: ttl === '300' });
    expect(result.review?.blockers).toEqual(expect.arrayContaining(['PRE_OPERATION_STATE_UNKNOWN', 'RECENT_REAUTHENTICATION_NOT_EVALUATED', 'MAINTENANCE_NOT_REQUESTED']));
    if (ttl !== '300') expect(result.review?.blockers).toContain('RESET_REAUTH_POLICY_MISMATCH');
    expect(result.review?.executionEnabled).toBe(false);
  });
  it('rejects an obsolete alternate selection before trusting any capture', async () => {
    const f = resetReviewFixture(); Object.assign(f.request, { templateSelection: 'ALL_VERSIONS' });
    expect((await f.run()).review).toBeNull();
  });
  it('keeps incompatible selected content blocked even when it was previously published', async () => {
    const f = resetReviewFixture(); required(f.sidecar.templateEvidence.templates[0]).registrationShapeValid = false;
    expect((await f.run()).review?.blockers).toEqual(expect.arrayContaining(['TEMPLATE_SELECTED_REGISTRATION_SHAPE_INCOMPATIBLE', 'TEMPLATE_PUBLICATION_COMPATIBILITY_NOT_VERIFIED']));
  });
});
