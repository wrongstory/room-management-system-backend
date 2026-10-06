import { describe, expect, it } from 'vitest';
const modulePath = '../scripts/reset-relation-classification.mjs';
const { classifyResetRelations, RESET_RELATION_NAMES, RESET_RELATION_GROUPS } = await import(modulePath);

describe('explicit reset candidate classification', () => {
  it('covers the observed 183-table candidate without enabling execution', () => {
    expect(classifyResetRelations(RESET_RELATION_NAMES)).toMatchObject({
      inventoryCoverageComplete: true, classificationComplete: false, executionEnabled: false,
      missingRelationCount: 0, unclassifiedRelationCount: 0,
      dispositionCounts: { preserve: 3, mixed: 10, reseed: 2, clear: 43, review: 125 },
    });
  });
  it('does not classify a new table by prefix or resemblance', () => {
    const result = classifyResetRelations([...RESET_RELATION_NAMES, 'public.reservations_new']);
    expect(result).toMatchObject({ inventoryCoverageComplete: false, unclassifiedRelationCount: 1, executionEnabled: false });
    expect(result.dispositionCounts.clear).toBe(43);
  });
  it('blocks a missing rule target including an unmerged candidate relation', () => {
    const names = RESET_RELATION_NAMES.filter((name: string) => name !== 'private.post_approval_room_issue_reports');
    expect(classifyResetRelations(names)).toMatchObject({
      inventoryCoverageComplete: false, missingRelationCount: 1, executionEnabled: false,
    });
  });
  it('is order independent and never mutates the observed list', () => {
    const names = [...RESET_RELATION_NAMES].reverse(); const before = [...names];
    expect(classifyResetRelations(names)).toEqual(classifyResetRelations(RESET_RELATION_NAMES));
    expect(names).toEqual(before);
  });
  it.each([null, {}, ['publicXprofiles'], ['auth.users'], ['public.rooms','public.rooms']])('rejects malformed inventory', (input) => {
    expect(() => classifyResetRelations(input)).toThrow('RESET_CLASSIFICATION_INVALID_INPUT');
  });
  it('does not silently approve an empty inventory', () => {
    expect(classifyResetRelations([])).toMatchObject({
      inventoryCoverageComplete: false, missingRelationCount: 183, executionEnabled: false,
    });
  });
  it('protects security and developer state from bulk clear classification', () => {
    expect(RESET_RELATION_GROUPS.preserve).toContain('private.room_pin_nonce_reservations');
    expect(RESET_RELATION_GROUPS.mixed).toEqual(expect.arrayContaining([
      'public.profiles','public.login_aliases','public.rooms','private.auth_password_versions',
      'private.password_verification_rate_limits','private.login_rate_limit_windows',
    ]));
    expect(RESET_RELATION_GROUPS.review).toEqual(expect.arrayContaining([
      'public.audit_events','private.photo_provider_objects','private.room_pin_sheet_sync_outbox',
      'private.post_approval_issue_provider_objects',
    ]));
    expect(RESET_RELATION_GROUPS.reseed).toEqual(expect.arrayContaining([
      'public.cleaning_template_versions','private.photo_template_slots',
    ]));
  });
  it('freezes both classification lists and their container', () => {
    expect(Object.isFrozen(RESET_RELATION_GROUPS)).toBe(true);
    expect(Object.isFrozen(RESET_RELATION_NAMES)).toBe(true);
    for (const group of Object.values(RESET_RELATION_GROUPS)) expect(Object.isFrozen(group)).toBe(true);
  });
});
