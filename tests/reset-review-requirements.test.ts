import { describe, expect, it } from 'vitest';
const modulePath = '../scripts/reset-review-requirements.mjs';
const { RESET_REVIEW_REQUIREMENTS, summarizeResetReviewRequirements } = await import(modulePath);

describe('reset mixed/review dependency inventory', () => {
  it('names all 135 mixed/review relations without approving their disposition', () => {
    expect(summarizeResetReviewRequirements()).toMatchObject({ relationCount: 135, classificationComplete: false, executionEnabled: false });
    const names: string[] = RESET_REVIEW_REQUIREMENTS.flatMap((group: { relations: string[] }) => group.relations);
    expect(new Set(names).size).toBe(135);
    expect(names).not.toContain('private.room_pin_nonce_reservations');
    expect(names).not.toContain('public.room_types');
  });
  it('retains the photo hold and the nonce, security and external projection boundaries', () => {
    const groups = summarizeResetReviewRequirements().groups;
    expect(groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PHOTO_AND_EVIDENCE', required: expect.arrayContaining(['PHOTO_DELETION_ON_HOLD', 'PROVIDER_IDENTITY_PRESERVATION']) }),
      expect.objectContaining({ code: 'PIN_AND_SHEET', required: expect.arrayContaining(['NONCE_REGISTRY_PRESERVATION', 'SHEET_REIMPORT_BOUNDARY']) }),
      expect.objectContaining({ code: 'ACCOUNT_SECURITY', required: expect.arrayContaining(['DEVELOPER_PRESERVATION', 'AUTH_DRAIN']) }),
    ]));
    expect(JSON.stringify(summarizeResetReviewRequirements())).not.toContain('public.profiles');
  });
  it('freezes every source-controlled rule', () => {
    expect(Object.isFrozen(RESET_REVIEW_REQUIREMENTS)).toBe(true);
    for (const group of RESET_REVIEW_REQUIREMENTS) {
      expect(Object.isFrozen(group)).toBe(true);
      expect(Object.isFrozen(group.relations)).toBe(true);
      expect(Object.isFrozen(group.required)).toBe(true);
    }
  });
});
