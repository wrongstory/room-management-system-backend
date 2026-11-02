import { isDeepStrictEqual } from 'node:util';

export const impactMetadataKeys = ['cleaningKind', 'sourceKind', 'roomTypeSnapshot', 'roomTypeCode',
  'roomTypeName', 'elevatorZone', 'feeSnapshot', 'originalServiceDate', 'effectiveServiceDate',
  'rolloverCount', 'rolloverReason', 'canCancel', 'cancelReasonCode'];
const collections = ['committableDrafts', 'blockedDrafts', 'remainingUnassignedTargets'];
// This pre140 fixture has no memo. Validate its exact additive contract before
// projecting to the old response; never discard arbitrary new keys or values.
export function assertLegacyImpactRows(before, after, { baselineHasMetadata = false } = {}) {
  if (baselineHasMetadata) {
    const header = value => Object.fromEntries(Object.entries(value).filter(([key]) => !collections.includes(key)));
    if (!isDeepStrictEqual(header(before), header(after))) throw new Error('LEGACY_IMPACT_TOP_LEVEL_FIELDS');
  }
  for (const collection of collections) {
    const fail = reason => { throw new Error(`LEGACY_IMPACT_${collection}_${reason}`); };
    if (!Array.isArray(before[collection]) || !Array.isArray(after[collection])) fail('ARRAY');
    if (before[collection].length !== after[collection].length) fail('COUNT');
    const projected = after[collection].map(row => {
      const assigned = row.assignmentId != null && row.assignmentId !== '';
      if (assigned) {
        if (!Object.hasOwn(row, 'instructionMemo') || row.instructionMemo !== null) fail('MEMO_NULL');
      } else if (Object.hasOwn(row, 'instructionMemo')) fail('UNASSIGNED_MEMO');
      return Object.fromEntries(Object.entries(row).filter(([key]) =>
        (baselineHasMetadata || !impactMetadataKeys.includes(key)) && !(assigned && key === 'instructionMemo')));
    });
    if (!isDeepStrictEqual(projected, before[collection])) fail('ORIGINAL_FIELDS');
  }
}
