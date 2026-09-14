import { describe, expect, it } from 'vitest';
import {
  assessPhotoCompleteness,
  PhotoSubmissionContractError,
  projectPhotoTemplateForValidation,
  validatePhotoTemplateSnapshot
} from '../supabase/functions/_shared/photo-submission-contract.js';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing synthetic fixture');
  return value;
}
function template(version = 7, count = 10, roomTypeCode = 'standard') {
  return {
    templateVersionId: id(1), version, roomTypeCode, cleaningKind: 'checkout',
    slots: Array.from({ length: count }, (_, i) => ({
      slotKey: i === 0 && version >= 7 ? 'tv-on' : `fixture-${i}`,
      required: i < count - 1, displayOrder: i
    }))
  };
}
function fixture() {
  const snapshot = template();
  return {
    targetId: id(2), attemptId: id(3), snapshot,
    slotSnapshots: snapshot.slots.map((slot, i) => ({
      id: id(10 + i), targetId: id(2), templateVersionId: id(1), ...slot
    })),
    currentPhotos: snapshot.slots.filter((slot) => slot.required).map((_, i) => ({
      id: id(100 + i), attemptId: id(3), targetId: id(2), targetSlotId: id(10 + i),
      version: 1, validationStatus: 'verified', uploadedAt: '2037-01-05T12:00:00Z',
      purgeAfter: '2037-01-12T12:00:00Z', purgedAt: null as string | null
    })),
    asOf: '2037-01-06T00:00:00Z'
  };
}

describe('platform-neutral photo contract under Node', () => {
  it.each([['standard', 10], ['premium', 11], ['oceanPremium', 13], ['oceanFamily', 15]] as const)(
    'validates v7 %s count without inventing slot names', (type, count) => {
      expect(validatePhotoTemplateSnapshot(template(7, count, type)).slots).toHaveLength(count);
      expect(() => validatePhotoTemplateSnapshot(template(7, count - 1, type))).toThrow(PhotoSubmissionContractError);
      const noTv = template(7, count, type);
      required(noTv.slots[0]).slotKey = 'fixture-without-tv';
      expect(() => validatePhotoTemplateSnapshot(noTv)).toThrow(PhotoSubmissionContractError);
    }
  );
  it('preserves original legacy snapshot and rejects unconfigured required slots', () => {
    const legacy = template(6, 9), before = JSON.stringify(legacy);
    expect(validatePhotoTemplateSnapshot(legacy).slots).toHaveLength(9);
    expect(JSON.stringify(legacy)).toBe(before);
    expect(() => validatePhotoTemplateSnapshot({ ...legacy, slots: [] })).toThrow(PhotoSubmissionContractError);
    legacy.slots.forEach((slot) => { slot.required = false; });
    expect(() => validatePhotoTemplateSnapshot(legacy)).toThrow(PhotoSubmissionContractError);
  });
  it('requires all required photos but returns no submission or execution permission', () => {
    const input = fixture(), result = assessPhotoCompleteness(input);
    expect(result.complete).toBe(true);
    expect(result.photoReferences).toHaveLength(9);
    expect(result).not.toHaveProperty('canSubmit');
    expect(result).not.toHaveProperty('fieldCompletedAt');
    input.currentPhotos = [];
    expect(assessPhotoCompleteness(input).complete).toBe(false);
  });
  it('rejects cross attempt, target, slot, duplicates, and raw locator fields', () => {
    for (const change of [{ attemptId: id(999) }, { targetId: id(999) }, { targetSlotId: id(999) }, { targetSlotId: null }, { driveFileId: 'untrusted' }]) {
      const input = fixture(); Object.assign(required(input.currentPhotos[0]), change);
      expect(() => assessPhotoCompleteness(input)).toThrow(PhotoSubmissionContractError);
    }
    const input = fixture(); required(input.currentPhotos[1]).targetSlotId = id(10);
    expect(() => assessPhotoCompleteness(input)).toThrow(PhotoSubmissionContractError);
  });
  it('keeps existing manifest references immutable after current photo replacement', () => {
    const input = fixture(), old = assessPhotoCompleteness(input);
    required(input.currentPhotos[0]).id = id(999); required(input.currentPhotos[0]).version = 2;
    const next = assessPhotoCompleteness(input);
    expect(old.photoReferences[0]?.photoId).toBe(id(100));
    expect(next.photoReferences[0]?.photoId).toBe(id(999));
    expect(Object.isFrozen(old.photoReferences[0])).toBe(true);
  });
  it('distinguishes an empty optional slot from a selected invalid optional photo', () => {
    const input = fixture();
    expect(assessPhotoCompleteness(input).complete).toBe(true);
    input.currentPhotos.push({ ...required(input.currentPhotos[0]), id: id(999), targetSlotId: id(19), validationStatus: 'failed' });
    const result = assessPhotoCompleteness(input);
    expect(result.complete).toBe(false);
    expect(result.missingRequiredSlotKeys).toEqual([]);
    expect(result.invalidCurrentSlotKeys).toEqual(['fixture-9']);
    input.currentPhotos.pop();
    expect(assessPhotoCompleteness(input).complete).toBe(true);
  });
  it('retains PostgreSQL microsecond expiry precision and exact seven-day retention', () => {
    const input = fixture();
    required(input.currentPhotos[0]).uploadedAt = '2037-01-05T12:00:00.000001Z';
    required(input.currentPhotos[0]).purgeAfter = '2037-01-12T12:00:00.000002Z';
    expect(() => assessPhotoCompleteness(input)).toThrow(PhotoSubmissionContractError);
    required(input.currentPhotos[0]).purgeAfter = '2037-01-12T12:00:00.000001Z';
    input.asOf = '2037-01-12T12:00:00.000000Z';
    expect(assessPhotoCompleteness(input).photoReferences.some((photo) => photo.slotKey === 'tv-on')).toBe(true);
    input.asOf = '2037-01-12T12:00:00.000001Z';
    expect(assessPhotoCompleteness(input).photoReferences).toHaveLength(0);
  });
  it('applies resource bounds separately from legacy photo-count policy', () => {
    const legacy = template(6, 100);
    expect(validatePhotoTemplateSnapshot(legacy).slots).toHaveLength(100);
    expect(() => validatePhotoTemplateSnapshot(template(6, 101))).toThrow(PhotoSubmissionContractError);
    required(legacy.slots[0]).slotKey = 'a'.repeat(80);
    expect(validatePhotoTemplateSnapshot(legacy).slots).toHaveLength(100);
    required(legacy.slots[0]).slotKey = 'a'.repeat(81);
    expect(() => validatePhotoTemplateSnapshot(legacy)).toThrow(PhotoSubmissionContractError);
    required(legacy.slots[0]).slotKey = 'fixture-0';
    required(legacy.slots[99]).displayOrder = 100;
    expect(() => validatePhotoTemplateSnapshot(legacy)).toThrow(PhotoSubmissionContractError);
  });
  it('projects full metadata for validation without replacing the immutable full snapshot', () => {
    const source = template();
    const full = { ...source, slots: source.slots.map((slot) => ({ ...slot,
      label: '합성 슬롯 표시명', section: 'fixture-section', description: '합성 설명',
      repeat: { instance: 1, count: 2 }, uploaded: true
    })) };
    const original = JSON.stringify(full);
    expect(() => validatePhotoTemplateSnapshot(full)).toThrow(PhotoSubmissionContractError);
    const projection = projectPhotoTemplateForValidation(full);
    expect(projection.slots).toHaveLength(10);
    expect(JSON.stringify(full)).toBe(original);
    expect(projection.slots[0]).not.toHaveProperty('label');
    expect(projection.slots[0]).not.toHaveProperty('uploaded');
    const input = fixture();
    const result = assessPhotoCompleteness({ ...input, snapshot: projection, currentPhotos: [] });
    expect(result.complete).toBe(false);
  });
  it('matches PostgreSQL UUID and int32 template-version representation', () => {
    const input = { ...template(), templateVersionId: '11111111-1111-0111-0111-111111111111' };
    expect(validatePhotoTemplateSnapshot(input).templateVersionId).toBe(input.templateVersionId);
    expect(() => validatePhotoTemplateSnapshot({ ...input, version: 2147483648 })).toThrow(PhotoSubmissionContractError);
  });
});
