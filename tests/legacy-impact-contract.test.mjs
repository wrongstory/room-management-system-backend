import { expect, it } from 'vitest';
import { assertLegacyImpactRows, impactMetadataKeys } from '../scripts/lib/legacy-impact-contract.mjs';

const fixture = () => ({ committableDrafts: [{ assignmentId: 'a', version: 1 }],
  blockedDrafts: [{ assignmentId: 'b', reason: 'blocked' }],
  remainingUnassignedTargets: [{ assignmentId: null, targetId: 'c' }] });
const upgraded = before => Object.fromEntries(Object.entries(before).map(([key, rows]) =>
  [key, rows.map(row => ({ ...row, ...Object.fromEntries(impactMetadataKeys.map(k => [k, null])),
    ...(row.assignmentId ? { instructionMemo: null } : {}) }))]));
it('accepts exact additive metadata and null memo without mutating observations', () => {
  const before = fixture(), after = upgraded(before), saved = structuredClone(after);
  assertLegacyImpactRows(before, after);
  expect(after).toEqual(saved);
});
for (const collection of Object.keys(fixture())) {
  for (const mutation of ['old-value', 'unknown-key', 'removed-field', 'count', 'memo']) {
    it(`rejects ${collection} ${mutation} without exposing row values`, () => {
      const before = fixture(), after = upgraded(before), row = after[collection][0];
      if (mutation === 'old-value') row.assignmentId = 'PRIVATE_VALUE';
      if (mutation === 'unknown-key') row.unexpected = 'PRIVATE_VALUE';
      if (mutation === 'removed-field') delete row.assignmentId;
      if (mutation === 'count') after[collection].pop();
      if (mutation === 'memo') row.instructionMemo = 'PRIVATE_VALUE';
      expect(() => assertLegacyImpactRows(before, after)).toThrow(/^LEGACY_IMPACT_/);
      try { assertLegacyImpactRows(before, after); } catch (error) {
        expect(error.message).not.toContain('PRIVATE_VALUE');
      }
    });
  }
}
it('rejects missing assigned memo and even null memo on unassigned rows', () => {
  const before = fixture(), after = upgraded(before);
  delete after.committableDrafts[0].instructionMemo;
  expect(() => assertLegacyImpactRows(before, after)).toThrow(/MEMO_NULL/);
  after.committableDrafts[0].instructionMemo = null;
  after.remainingUnassignedTargets[0].instructionMemo = null;
  expect(() => assertLegacyImpactRows(before, after)).toThrow(/UNASSIGNED_MEMO/);
});
