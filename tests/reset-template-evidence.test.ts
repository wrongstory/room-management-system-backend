import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { summarizeResetTemplateEvidence } from '../src/modules/developer-reset/reset-template-evidence.js';
import type { ResetCensus } from '../src/modules/developer-reset/reset-row-impact.js';
import { summarizeResetPreview } from '../src/modules/developer-reset/reset-preview.js';
import { resetRelationGroups } from '../src/modules/developer-reset/reset-preview-groups.js';

const snapshotId = 'a'.repeat(64);
const sourceId = '11111111-1111-4111-8111-111111111111';
function at<T>(items: T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error('Missing fixture item');
  return item;
}
const references: [string, string][] = [
  ['public.cleaning_targets', 'template_snapshot.id'],
  ['public.cleaning_attempts', 'template_snapshot.id'],
  ['private.target_photo_snapshot_contracts', 'frozen_snapshot.templateVersionId'],
  ['private.target_photo_slot_snapshots', 'template_version_id'],
  ['private.flat_evidence_migration_receipts', 'previous_template_snapshot.id'],
  ['private.flat_evidence_migration_receipts', 'previous_photo_contract.templateVersionId'],
  ['private.flat_evidence_migration_receipts', 'previous_slots.template_version_id'],
];
function fixture() {
  const census: ResetCensus = new Map([
    ['public.cleaning_template_versions', { known: true, count: 1 }],
    ['private.photo_template_slots', { known: true, count: 3 }],
    ...references.map(([relation]) => [relation, { known: true, count: 0 }] as const),
  ]);
  const data = {
    format: 'reset-template-inventory-v1', snapshotId, templateCount: 1, slotCount: 3, orphanSlots: 0,
    templates: [{ sourceId, status: 'published', cleaningKind: 'checkout', contentDigest: 'b'.repeat(64),
      slotRows: 3, historicallyReadable: true, registrationShapeValid: true, slotProjectionMatches: true,
      versionAvailable: true, currentPublicationPathSupported: true, creatorExists: true }],
    references: references.map(([relation, path]) => ({ relation, path, sourceRows: 0, edgeRows: 0,
      absent: 0, malformed: 0, detached: 0, matched: 0 })),
  };
  return { data, census, run: () => summarizeResetTemplateEvidence(data, census, snapshotId) };
}

describe('all-status template handover evidence', () => {
  it('accepts complete same-snapshot evidence while retaining status/history decisions', () => {
    const result = fixture().run();
    expect(result).toMatchObject({ available: true, diagnosticComplete: true, executionEnabled: false,
      templateCount: 1, contentFingerprintsCollected: 1, registrationShapeInvalid: 0,
      statusCounts: { draft: 0, published: 1, retired: 0 },
      blockers: ['TEMPLATE_SELECTION_AND_STATUS_POLICY_REQUIRED', 'TEMPLATE_HISTORY_ARCHIVE_NOT_VERIFIED'] });
    expect(JSON.stringify(result)).not.toContain(sourceId);
    expect(JSON.stringify(result)).not.toContain('b'.repeat(64));
  });
  it('does not select or silently discard draft/retired versions', () => {
    const f = fixture();
    f.data.templates.push({ ...at(f.data.templates, 0), sourceId: '22222222-2222-4222-8222-222222222222', status: 'draft', slotRows: 0 },
      { ...at(f.data.templates, 0), sourceId: '33333333-3333-4333-8333-333333333333', status: 'retired', slotRows: 3 });
    f.data.templateCount = 3; f.data.slotCount = 6;
    f.census.set('public.cleaning_template_versions', { known: true, count: 3 });
    f.census.set('private.photo_template_slots', { known: true, count: 6 });
    expect(f.run().selectionAlternatives).toEqual([
      { scope: 'currentPublished', selected: 1, excludedDraft: 1, excludedRetired: 1, statusPolicyDecided: false },
      { scope: 'allVersions', selected: 3, excludedDraft: 0, excludedRetired: 0, statusPolicyDecided: false },
    ]);
  });
  it('keeps readable legacy history separate from fresh publication compatibility', () => {
    const f = fixture(); at(f.data.templates, 0).registrationShapeValid = false;
    expect(f.run()).toMatchObject({ historicallyUnreadable: 0, registrationShapeInvalid: 1,
      blockers: expect.arrayContaining(['TEMPLATE_FRESH_REGISTRATION_SHAPE_INCOMPATIBLE']) });
  });
  it('reports an unreadable historical shape even if a fresh shape candidate is valid', () => {
    const f = fixture(); at(f.data.templates, 0).historicallyReadable = false;
    expect(f.run()).toMatchObject({ historicallyUnreadable: 1, registrationShapeInvalid: 0,
      blockers: expect.arrayContaining(['TEMPLATE_HISTORICAL_SHAPE_UNREADABLE']) });
  });
  it('reports non-checkout current API limits without inventing broad developer publishing rights', () => {
    const f = fixture(); at(f.data.templates, 0).cleaningKind = 'stayover';
    at(f.data.templates, 0).currentPublicationPathSupported = false;
    expect(f.run().blockers).toContain('TEMPLATE_EXISTING_PUBLICATION_PATH_NOT_APPLICABLE');
  });
  it('reports detached historical identities without rewriting them or declaring corruption', () => {
    const f = fixture(); const r = at(f.data.references, 0);
    Object.assign(r, { sourceRows: 2, edgeRows: 2, matched: 1, detached: 1 });
    f.census.set(r.relation, { known: true, count: 2 });
    expect(f.run()).toMatchObject({ referenceCounts: { edges: 2, matched: 1, detached: 1 },
      blockers: expect.arrayContaining(['TEMPLATE_HISTORICAL_REFERENCES_REQUIRE_PROTECTION']) });
  });
  it('supports zero templates without fabricating a default operational template', () => {
    const f = fixture(); f.data.templates = []; f.data.templateCount = 0; f.data.slotCount = 0;
    f.census.set('public.cleaning_template_versions', { known: true, count: 0 });
    f.census.set('private.photo_template_slots', { known: true, count: 0 });
    expect(f.run()).toMatchObject({ templateCount: 0, executionEnabled: false, blockers: [] });
  });
  it('keeps an older server that did not collect templates unavailable', () => {
    expect(summarizeResetTemplateEvidence(undefined, new Map(), snapshotId)).toMatchObject({
      available: false, diagnosticComplete: false, executionEnabled: false, blockers: ['TEMPLATE_INVENTORY_NOT_COLLECTED'],
    });
  });
  it.each([
    ['snapshot', (f: ReturnType<typeof fixture>) => { f.data.snapshotId = 'c'.repeat(64); }],
    ['incomplete templates', (f: ReturnType<typeof fixture>) => { f.data.templateCount = 2; }],
    ['slot census', (f: ReturnType<typeof fixture>) => { f.data.slotCount = 4; }],
    ['missing path', (f: ReturnType<typeof fixture>) => { f.data.references.pop(); }],
    ['duplicate path', (f: ReturnType<typeof fixture>) => { f.data.references[1] = at(f.data.references, 0); }],
    ['unknown path', (f: ReturnType<typeof fixture>) => { at(f.data.references, 0).path = 'other'; }],
    ['reference census', (f: ReturnType<typeof fixture>) => { at(f.data.references, 0).sourceRows = 1; }],
    ['edge count', (f: ReturnType<typeof fixture>) => { at(f.data.references, 0).edgeRows = 1; }],
    ['negative count', (f: ReturnType<typeof fixture>) => { f.data.orphanSlots = -1; }],
    ['duplicate source', (f: ReturnType<typeof fixture>) => { f.data.templates.push({ ...at(f.data.templates, 0) }); f.data.templateCount = 2; f.census.set('public.cleaning_template_versions', { known: true, count: 2 }); }],
    ['unknown state', (f: ReturnType<typeof fixture>) => { at(f.data.templates, 0).status = 'archived'; }],
    ['digest', (f: ReturnType<typeof fixture>) => { at(f.data.templates, 0).contentDigest = 'raw content'; }],
    ['forged generic publisher', (f: ReturnType<typeof fixture>) => { at(f.data.templates, 0).cleaningKind = 'reclean'; }],
    ['version contradiction', (f: ReturnType<typeof fixture>) => { at(f.data.templates, 0).versionAvailable = false; }],
    ['raw payload field', (f: ReturnType<typeof fixture>) => { Object.assign(at(f.data.templates, 0), { rawLabel: 'private text' }); }],
    ['unclassified census', (f: ReturnType<typeof fixture>) => { f.census.set('public.cleaning_template_versions', { known: false, count: 1 }); }],
  ])('rejects %s', (_label, mutate) => { const f = fixture(); mutate(f); expect(f.run).toThrow('RESET_TEMPLATE_EVIDENCE_INVALID'); });
  it('reports malformed references and slot/authorship issues as actual blockers', () => {
    const f = fixture(); const r = at(f.data.references, 3);
    Object.assign(r, { sourceRows: 1, edgeRows: 1, malformed: 1 });
    f.census.set(r.relation, { known: true, count: 1 });
    Object.assign(at(f.data.templates, 0), { creatorExists: false, slotProjectionMatches: false });
    expect(f.run().blockers).toEqual(expect.arrayContaining([
      'TEMPLATE_HISTORICAL_REFERENCE_MALFORMED', 'TEMPLATE_SLOT_PROJECTION_MISMATCH', 'TEMPLATE_CREATOR_REFERENCE_MISSING',
    ]));
  });
});

describe('template SQL source boundaries (not a database execution proof)', () => {
  const sql = readFileSync('supabase/migrations/20261025031218_developer_reset_template_inventory.sql', 'utf8');
  it('uses original validators, bounded all-status content and both snapshot gates', () => {
    expect(sql).toContain('private.normalized_checkout_template_slots');
    expect(sql).toContain('private.photo_snapshot_valid');
    expect(sql).toContain('case when normalized=private.flat_cleaning_photo_slots() then 9 else 8 end');
    expect(sql).toContain('private.collect_developer_operation_gates()');
    expect(sql).toContain('private.collect_developer_reset_row_impact()');
    expect(sql).toContain("'template',t,'slots',selected_slots");
    expect(sql).toContain('pg_current_snapshot()::text||statement_timestamp()::text');
    expect(sql).toContain("clock_timestamp()>=deadline");
    expect(sql).toContain("message='RESET_TEMPLATE_INVENTORY_LIMIT'");
    expect(sql).toContain('limit 10001');
    expect(sql).not.toMatch(/where\s+status\s*=\s*'published'/i);
  });
  it('adds no execution grants, publication, author update, DML or Auth reads', () => {
    expect(sql).not.toMatch(/grant\s+execute|insert\s+into|delete\s+from|update\s+public\.|truncate\s|auth\.users/i);
    expect(sql).toContain('from public,anon,authenticated,service_role');
    expect(sql).toContain("returns jsonb language plpgsql stable security definer set search_path=pg_catalog");
    expect(sql).toContain('or c.relispartition');
  });
});

it('connects the actual template RPC contract to the developer preview with sanitized failure', () => {
  const f = fixture();
  const rpc = {
    format: 'reset-preview-inventory-v1', readOnly: true, capturedAt: '2026-10-25T03:00:00Z', snapshotId,
    relations: Object.values(resetRelationGroups).flat().map((relation) => ({
      relation, kind: 'r', partition: false, observedRows: f.census.get(relation)?.count ?? 0, exact: true,
    })),
    templateEvidence: f.data,
  };
  const result = summarizeResetPreview(rpc);
  expect(result.templateEvidence).toMatchObject({ available: true, templateCount: 1 });
  expect(result.executionEnabled).toBe(false);
  expect(JSON.stringify(result)).not.toContain(sourceId);
  f.data.templateCount = 99;
  expect(() => summarizeResetPreview(rpc)).toThrow('RESET_PREVIEW_UNAVAILABLE');
});
