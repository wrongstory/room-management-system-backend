import { describe, expect, it } from 'vitest';
import { inspectTemplateReseedPlan } from '../src/modules/developer-reset/template-reseed-plan.js';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
function fixture() {
  const content = {
    roomTypeId: id(1), cleaningKind: 'checkout', durationMinutes: null as number | null,
    slots: [
      { slotKey: 'cleaning-proof', displayOrder: 0, required: true, label: '청소 사진', maxPhotos: 20 },
      { slotKey: 'bomb-proof', displayOrder: 1, required: false, label: '폭탄방 증빙', maxPhotos: 10 },
      { slotKey: 'issue-proof', displayOrder: 2, required: false, label: '특이사항 증빙', maxPhotos: 10 },
    ],
  };
  return {
    developerId: id(2), registrationTime: '2026-10-06T06:00:00Z',
    sourceComplete: true, referencesComplete: true,
    sources: [{ id: id(3), content }],
    replacements: [{
      sourceId: id(3), newId: id(4), createdBy: id(2), createdAt: '2026-10-06T06:00:00Z',
      reason: 'OPERATIONAL_HANDOVER_INITIALIZATION', content: structuredClone(content),
    }],
    references: [{ referenceId: id(5), sourceId: id(3), newId: id(4) }],
  };
}
function first<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error('missing fixture');
  return row;
}
type F = ReturnType<typeof fixture>;
describe('template reseed proposal (not an execution permit)', () => {
  it('preserves content and leaves original input untouched', () => {
    const f = fixture(); const before = structuredClone(f);
    expect(inspectTemplateReseedPlan(f)).toMatchObject({
      planValid: true, executionEnabled: false, templateCount: 1, referenceCount: 1,
    });
    expect(f).toEqual(before);
  });
  it('accepts array permutations without losing display order', () => {
    const f = fixture(); const a = inspectTemplateReseedPlan(f);
    first(f.replacements).content.slots.reverse();
    expect(inspectTemplateReseedPlan(f)).toEqual(a);
  });
  it.each([
    ['INCOMPLETE_SOURCE', (f: F) => { f.sourceComplete = false; }],
    ['INCOMPLETE_REFERENCES', (f: F) => { f.referencesComplete = false; }],
    ['MAPPING_MISMATCH', (f: F) => { f.replacements = []; }],
    ['MAPPING_MISMATCH', (f: F) => { first(f.replacements).sourceId = id(8); }],
    ['OLD_ID_REUSED', (f: F) => { first(f.replacements).newId = id(3); }],
    ['PROVENANCE_MISMATCH', (f: F) => { first(f.replacements).createdBy = id(8); }],
    ['PROVENANCE_MISMATCH', (f: F) => { first(f.replacements).createdAt = '2020-01-01T00:00:00Z'; }],
    ['REFERENCE_MISMATCH', (f: F) => { first(f.references).newId = id(3); }],
    ['REFERENCE_MISMATCH', (f: F) => { first(f.references).sourceId = id(8); }],
    ['DUPLICATE_ID', (f: F) => { f.sources.push(first(f.sources)); }],
    ['DUPLICATE_ID', (f: F) => { f.replacements.push(first(f.replacements)); }],
    ['DUPLICATE_ID', (f: F) => { f.references.push(first(f.references)); }],
    ['CONTENT_CHANGED', (f: F) => { first(first(f.replacements).content.slots).maxPhotos = 19; }],
    ['CONTENT_CHANGED', (f: F) => { first(first(f.replacements).content.slots).label = '변경'; }],
    ['CONTENT_CHANGED', (f: F) => { first(first(f.replacements).content.slots).required = false; }],
    ['CONTENT_CHANGED', (f: F) => { first(f.replacements).content.roomTypeId = id(8); }],
    ['CONTENT_CHANGED', (f: F) => { first(f.replacements).content.durationMinutes = 60; }],
    ['INVALID_INPUT', (f: F) => { first(f.replacements).reason = 'OVERRIDE'; }],
    ['INVALID_INPUT', (f: F) => { first(f.replacements).content.slots.push(first(first(f.replacements).content.slots)); }],
    ['INVALID_INPUT', (f: F) => { f.registrationTime = '2026-02-30T00:00:00Z'; }],
  ] as const)('blocks %s', (reason, change) => {
    const f = fixture(); change(f);
    const result = inspectTemplateReseedPlan(f);
    expect(result.blockers).toContain(reason);
    expect(result).toMatchObject({ planValid: false, executionEnabled: false, fingerprint: null });
  });
  it('does not echo unknown fields or secrets in validation failures', () => {
    const result = inspectTemplateReseedPlan({ ...fixture(), secret: 'never-return' });
    expect(result.blockers).toEqual(['INVALID_INPUT']);
    expect(JSON.stringify(result)).not.toContain('never-return');
  });
  it('binds changed registration context into the diagnostic fingerprint', () => {
    const f = fixture(); const a = inspectTemplateReseedPlan(f);
    f.developerId = id(9); first(f.replacements).createdBy = id(9);
    expect(inspectTemplateReseedPlan(f).fingerprint).not.toBe(a.fingerprint);
  });
  it('rejects a new ID shared by different source templates', () => {
    const f = fixture();
    f.sources.push({ ...structuredClone(first(f.sources)), id: id(6) });
    f.replacements.push({ ...structuredClone(first(f.replacements)), sourceId: id(6) });
    expect(inspectTemplateReseedPlan(f).blockers).toContain('DUPLICATE_ID');
  });
  it('rejects reuse of another source template ID', () => {
    const f = fixture();
    f.sources.push({ ...structuredClone(first(f.sources)), id: id(6) });
    f.replacements.push({ ...structuredClone(first(f.replacements)), sourceId: id(6), newId: id(7) });
    first(f.replacements).newId = id(6);
    expect(inspectTemplateReseedPlan(f).blockers).toContain('OLD_ID_REUSED');
  });
  it('distinguishes display-order changes from array permutations', () => {
    const f = fixture();
    first(f.replacements).content.slots.forEach((s) => { s.displayOrder = 2 - s.displayOrder; });
    expect(inspectTemplateReseedPlan(f).blockers).toContain('CONTENT_CHANGED');
  });
  it('normalizes UUID casing before duplicate checks', () => {
    const f = fixture();
    const sourceId = 'abcdefab-0000-4000-8000-000000000003';
    first(f.sources).id = sourceId;
    f.sources.push({ ...structuredClone(first(f.sources)), id: sourceId.toUpperCase() });
    first(f.replacements).sourceId = sourceId;
    expect(inspectTemplateReseedPlan(f).blockers).toContain('DUPLICATE_ID');
  });
});
