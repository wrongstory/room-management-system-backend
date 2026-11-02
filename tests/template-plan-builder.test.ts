import { describe, expect, it, vi } from 'vitest';
import { requestHash } from '../src/lib/command.js';
import { buildTemplateReseedProposal } from '../src/modules/developer-reset/template-plan-builder.js';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hash = (n: string) => n.repeat(64);
const now = () => new Date('2026-10-25T04:00:00.000Z');
const content = { roomTypeId: id(1), cleaningKind: 'checkout' as const, durationMinutes: null,
  slots: [{ slotKey: 'cleaning-proof', displayOrder: 0, required: true, label: '합성 사진', maxPhotos: 20 },
    { slotKey: 'bomb-proof', displayOrder: 1, required: false, label: '합성 추가', maxPhotos: 10 }] };
function fixture() {
  const templates = (['published', 'retired', 'draft'] as const).map((status, n) => ({ id: id(10 + n), status,
    version: n + 1, createdBy: id(2), createdAt: '2026-10-01T00:00:00Z', content: structuredClone(content) }));
  const references = [] as { referenceId: string; sourceId: string; kind: 'CURRENT_POINTER' | 'HISTORICAL_SNAPSHOT' }[];
  const binding = { projectRef: 'a'.repeat(20), sourceCommit: 'a'.repeat(40), snapshotId: hash('b'),
    catalogFingerprint: hash('c'), contentFingerprint: requestHash({ templates, references }) };
  return { expected: structuredClone(binding), developerId: id(3), selection: 'ALL_VERSIONS' as 'ALL_VERSIONS' | 'CURRENT_PUBLISHED',
    inventory: { binding, complete: true, referencesComplete: true, templateCount: 3, referenceCount: 0, templates, references } };
}
type F = ReturnType<typeof fixture>;
function rehash(f: F) {
  const templates = [...f.inventory.templates].sort((a, b) => a.id.localeCompare(b.id)).map(t => ({ ...t,
    content: { ...t.content, slots: [...t.content.slots].sort((a, b) => a.displayOrder - b.displayOrder) } }));
  const references = [...f.inventory.references].sort((a, b) => a.referenceId.localeCompare(b.referenceId));
  const digest = requestHash({ templates, references });
  f.expected.contentFingerprint = digest; f.inventory.binding.contentFingerprint = digest;
}
function run(f = fixture()) { let n = 100; return buildTemplateReseedProposal(f, { now, newId: () => id(n++) }); }

describe('explicit template handover proposal generation', () => {
  it('allocates unique IDs and actual new provenance while preserving all source content and author history', () => {
    const f = fixture(); const before = structuredClone(f); const result = run(f);
    expect(result).toMatchObject({ generated: true, executionEnabled: false, counts: { inventory: 3, selected: 3, excluded: 0 } });
    if (!result.generated) throw new Error('bad fixture');
    expect(result.plan.replacements.map(r => r.newId)).toEqual([id(100), id(101), id(102)]);
    for (const [n, r] of result.plan.replacements.entries()) {
      expect(r).toMatchObject({ sourceId: f.inventory.templates[n]?.id, createdBy: id(3), createdAt: now().toISOString(), reason: 'OPERATIONAL_HANDOVER_INITIALIZATION' });
      expect(r.content).toEqual(content); expect(r).not.toHaveProperty('status'); expect(r).not.toHaveProperty('version');
    }
    expect(result.originalProvenance.map(r => r.createdBy)).toEqual([id(2), id(2), id(2)]);
    expect(f).toEqual(before); result.plan.replacements[0]!.content.slots[0]!.label = 'changed proposal'; expect(f).toEqual(before);
    expect(result.blockers).toContain('TEMPLATE_STATUS_AND_VERSION_POLICY_REQUIRED');
    expect(result.blockers).toContain('TEMPLATE_HISTORY_PROTECTION_REQUIRED');
  });
  it('requires explicit selection and can prepare either alternative without activating it', () => {
    const f = fixture(); f.selection = 'CURRENT_PUBLISHED';
    expect(run(f)).toMatchObject({ generated: true, counts: { selected: 1, excluded: 2 }, executionEnabled: false });
    expect(buildTemplateReseedProposal({ ...f, selection: undefined }).generated).toBe(false);
  });
  it('does not rewrite either historical identities or current pointers', () => {
    const f = fixture(); f.inventory.references.push(
      { referenceId: id(20), sourceId: id(10), kind: 'HISTORICAL_SNAPSHOT' },
      { referenceId: id(21), sourceId: id(11), kind: 'CURRENT_POINTER' });
    f.inventory.referenceCount = 2; rehash(f);
    const result = run(f); expect(result).toMatchObject({ generated: true, counts: { currentReferences: 1, historicalReferences: 1 } });
    if (!result.generated) throw new Error('bad fixture');
    expect(result.plan.references).toEqual([]); expect(result.plan.referencesComplete).toBe(false);
    expect(result.blockers).toContain('INCOMPLETE_REFERENCES');
    expect(result.blockers).toContain('TEMPLATE_HISTORY_PROTECTION_REQUIRED');
  });
  it('canonicalizes array order without changing display order or the selected-to-new mapping', () => {
    const f = fixture(); const before = run(f);
    f.inventory.templates.reverse(); for (const t of f.inventory.templates) t.content.slots.reverse();
    const result = run(f); expect(result.generated).toBe(true);
    if (result.generated && before.generated) {
      expect(result.plan.replacements.map(r => [r.sourceId, r.newId])).toEqual(before.plan.replacements.map(r => [r.sourceId, r.newId]));
    }
  });
  it.each([
    ['TEMPLATE_BUILDER_CENSUS_MISMATCH', (f: F) => { f.inventory.templateCount++; }],
    ['TEMPLATE_BUILDER_CENSUS_MISMATCH', (f: F) => { f.inventory.templates[1]!.id = id(10); }],
    ['TEMPLATE_BUILDER_CENSUS_MISMATCH', (f: F) => { f.inventory.referenceCount = 1; }],
    ['TEMPLATE_BUILDER_BINDING_CHANGED', (f: F) => { f.inventory.binding.snapshotId = hash('d'); }],
    ['TEMPLATE_BUILDER_BINDING_CHANGED', (f: F) => { f.inventory.binding.projectRef = 'z'.repeat(20); }],
    ['TEMPLATE_BUILDER_BINDING_CHANGED', (f: F) => { f.inventory.binding.sourceCommit = 'b'.repeat(40); }],
    ['TEMPLATE_BUILDER_CONTENT_CHANGED', (f: F) => { f.inventory.templates[0]!.content.slots[0]!.label = 'same count altered'; }],
    ['TEMPLATE_BUILDER_CONTENT_CHANGED', (f: F) => { f.inventory.templates[0]!.createdBy = id(4); }],
    ['TEMPLATE_BUILDER_INPUT_INVALID', (f: F) => { f.inventory.complete = false; }],
    ['TEMPLATE_BUILDER_INPUT_INVALID', (f: F) => { f.inventory.referencesComplete = false; }],
  ] as const)('blocks %s before allocating any identifiers', (code, mutate) => {
    const f = fixture(); mutate(f); const allocate = vi.fn(() => id(100));
    const result = buildTemplateReseedProposal(f, { now, newId: allocate });
    expect(result).toMatchObject({ generated: false, plan: null, planFingerprint: null, blockers: [code] }); expect(allocate).not.toHaveBeenCalled();
  });
  it('refuses detached history and ambiguous current publications instead of inventing a selection', () => {
    const f = fixture(); f.inventory.references = [{ referenceId: id(20), sourceId: id(90), kind: 'HISTORICAL_SNAPSHOT' }]; f.inventory.referenceCount = 1; rehash(f);
    expect(run(f).blockers).toEqual(['TEMPLATE_BUILDER_DETACHED_REFERENCE']);
    const duplicate = fixture(); duplicate.inventory.templates[1]!.status = 'published'; rehash(duplicate);
    expect(run(duplicate).blockers).toEqual(['TEMPLATE_BUILDER_PUBLICATION_AMBIGUOUS']);
  });
  it('rejects IDs colliding with unselected versions and bounds repeated allocation failures', () => {
    const f = fixture(); f.selection = 'CURRENT_PUBLISHED';
    const newId = vi.fn().mockReturnValueOnce(id(11)).mockReturnValueOnce(id(100));
    const result = buildTemplateReseedProposal(f, { now, newId });
    expect(result.generated && result.plan.replacements[0]?.newId).toBe(id(100));
    const collision = vi.fn(() => id(12));
    expect(buildTemplateReseedProposal(f, { now, newId: collision }).blockers).toEqual(['TEMPLATE_BUILDER_ID_EXHAUSTED']);
    expect(collision).toHaveBeenCalledTimes(8);
    expect(buildTemplateReseedProposal(f, { now, newId: () => 'bad' }).blockers).toEqual(['TEMPLATE_BUILDER_ID_INVALID']);
  });
  it('never returns partial plans after allocation failure or a false registration clock', () => {
    let calls = 0;
    expect(buildTemplateReseedProposal(fixture(), { now, newId: () => { if (++calls === 2) throw new Error('synthetic-private'); return id(100); } })).toMatchObject({ generated: false, plan: null, originalProvenance: null, blockers: ['TEMPLATE_BUILDER_UNAVAILABLE'] });
    expect(buildTemplateReseedProposal(fixture(), { now: () => new Date('invalid') }).blockers).toEqual(['TEMPLATE_BUILDER_CLOCK_INVALID']);
    expect(buildTemplateReseedProposal(fixture(), { now: () => new Date('2026-10-01T00:00:00Z') }).blockers).toEqual(['TEMPLATE_BUILDER_CLOCK_NOT_AFTER_SOURCE']);
  });
  it('never treats an empty bound inventory as publication or reset permission', () => {
    const f = fixture(); f.inventory.templates = []; f.inventory.templateCount = 0; rehash(f);
    expect(run(f)).toMatchObject({ generated: true, executionEnabled: false, counts: { selected: 0 } });
    expect(JSON.stringify(buildTemplateReseedProposal({ rawSecret: 'synthetic-private' }))).not.toContain('synthetic-private');
  });
});
