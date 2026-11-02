import { describe, expect, it } from 'vitest';
import { inspectTemplateReseedInventory } from '../src/modules/developer-reset/template-reseed-inventory.js';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
function at<T>(rows: T[], index = 0): T {
  const row = rows[index]; if (row === undefined) throw new Error('missing fixture'); return row;
}
function fixture() {
  const content = { roomTypeId: id(1), cleaningKind: 'checkout', durationMinutes: null,
    slots: [{ slotKey: 'cleaning-proof', displayOrder: 0, required: true, label: '합성 사진', maxPhotos: 20 }] };
  const snapshotId = 'a'.repeat(64); const catalogFingerprint = 'b'.repeat(64);
  return { snapshotId, catalogFingerprint,
    plan: { developerId: id(2), registrationTime: '2026-10-25T00:00:00Z', sourceComplete: true, referencesComplete: true,
      sources: [{ id: id(3), content }],
      replacements: [{ sourceId: id(3), newId: id(4), createdBy: id(2), createdAt: '2026-10-25T00:00:00Z',
        reason: 'OPERATIONAL_HANDOVER_INITIALIZATION', content: structuredClone(content) }],
      references: [{ referenceId: id(5), sourceId: id(3), newId: id(4) }],
    },
    inventory: { snapshotId, catalogFingerprint, sourceCount: 1, referenceCount: 1, existingTemplateCount: 2,
      sourceIds: [id(3)], existingTemplateIds: [id(3), id(8)], references: [{ referenceId: id(5), sourceId: id(3) }] },
  };
}
type F = ReturnType<typeof fixture>;
describe('independent template re-registration inventory', () => {
  it('preserves proposal validation and never authorizes registration', () => {
    const f = fixture(); const before = structuredClone(f);
    expect(inspectTemplateReseedInventory(f)).toMatchObject({ inventoryValid: true, executionEnabled: false,
      templateCount: 1, referenceCount: 1, blockers: [] });
    expect(f).toEqual(before);
  });
  it.each([
    ['TEMPLATE_INVENTORY_BINDING_MISMATCH', (f: F) => { f.inventory.snapshotId = 'c'.repeat(64); }],
    ['TEMPLATE_INVENTORY_BINDING_MISMATCH', (f: F) => { f.inventory.catalogFingerprint = 'c'.repeat(64); }],
    ['TEMPLATE_INVENTORY_COUNT_MISMATCH', (f: F) => { f.inventory.sourceCount = 2; }],
    ['TEMPLATE_INVENTORY_COUNT_MISMATCH', (f: F) => { f.inventory.referenceCount = 2; }],
    ['TEMPLATE_INVENTORY_COUNT_MISMATCH', (f: F) => { f.inventory.existingTemplateCount = 3; }],
    ['TEMPLATE_SOURCE_COVERAGE_MISMATCH', (f: F) => { f.plan.sources = []; f.plan.replacements = []; f.plan.references = []; }],
    ['TEMPLATE_REFERENCE_COVERAGE_MISMATCH', (f: F) => { f.plan.references = []; }],
    ['TEMPLATE_REFERENCE_COVERAGE_MISMATCH', (f: F) => { at(f.inventory.references).sourceId = id(8); }],
    ['TEMPLATE_REFERENCE_COVERAGE_MISMATCH', (f: F) => { at(f.inventory.references).referenceId = id(9); }],
    ['TEMPLATE_SOURCE_NOT_IN_INVENTORY', (f: F) => { f.inventory.existingTemplateIds[0] = id(9); }],
    ['EXISTING_TEMPLATE_ID_REUSED', (f: F) => { at(f.plan.replacements).newId = id(8); at(f.plan.references).newId = id(8); }],
    ['DUPLICATE_TEMPLATE_INVENTORY', (f: F) => { f.inventory.sourceIds.push(id(3)); }],
    ['DUPLICATE_TEMPLATE_INVENTORY', (f: F) => { f.inventory.existingTemplateIds.push(id(3)); }],
    ['DUPLICATE_TEMPLATE_INVENTORY', (f: F) => { f.inventory.references.push(at(f.inventory.references)); }],
    ['CONTENT_CHANGED', (f: F) => { at(at(f.plan.replacements).content.slots).label = '변경'; }],
    ['PROVENANCE_MISMATCH', (f: F) => { at(f.plan.replacements).createdBy = id(8); }],
    ['INCOMPLETE_SOURCE', (f: F) => { f.plan.sourceComplete = false; }],
    ['INCOMPLETE_REFERENCES', (f: F) => { f.plan.referencesComplete = false; }],
  ] as const)('blocks %s', (blocker, change) => {
    const f = fixture(); change(f); const result = inspectTemplateReseedInventory(f);
    expect(result).toMatchObject({ inventoryValid: false, executionEnabled: false, fingerprint: null });
    expect(result.blockers).toContain(blocker);
  });
  it('canonicalizes inventory order and binds every observed existing ID', () => {
    const f = fixture(); const before = inspectTemplateReseedInventory(f);
    f.inventory.existingTemplateIds.reverse();
    expect(inspectTemplateReseedInventory(f)).toEqual(before);
    f.inventory.existingTemplateIds.push(id(9)); f.inventory.existingTemplateCount++;
    expect(inspectTemplateReseedInventory(f).inventoryValid).toBe(true);
    expect(inspectTemplateReseedInventory(f).fingerprint).not.toBe(before.fingerprint);
  });
  it('detects a collision outside the source selection after UUID case normalization', () => {
    const f = fixture(); const other = 'abcdefab-0000-4000-8000-000000000008';
    f.inventory.existingTemplateIds[1] = other.toUpperCase();
    at(f.plan.replacements).newId = other; at(f.plan.references).newId = other;
    expect(inspectTemplateReseedInventory(f).blockers).toContain('EXISTING_TEMPLATE_ID_REUSED');
  });
  it('accepts explicitly empty independent inventories without claiming live emptiness', () => {
    const f = fixture(); f.plan.sources = []; f.plan.replacements = []; f.plan.references = [];
    f.inventory.sourceIds = []; f.inventory.existingTemplateIds = []; f.inventory.references = [];
    f.inventory.sourceCount = 0; f.inventory.existingTemplateCount = 0; f.inventory.referenceCount = 0;
    expect(inspectTemplateReseedInventory(f)).toMatchObject({ inventoryValid: true, executionEnabled: false, templateCount: 0 });
  });
  it('rejects old input and raw values without reflecting them', () => {
    expect(inspectTemplateReseedInventory(fixture().plan).blockers).toEqual(['INVALID_TEMPLATE_INVENTORY']);
    const result = inspectTemplateReseedInventory({ ...fixture(), secret: 'never-return' });
    expect(result.blockers).toEqual(['INVALID_TEMPLATE_INVENTORY']);
    expect(JSON.stringify(result)).not.toContain('never-return');
  });
});
