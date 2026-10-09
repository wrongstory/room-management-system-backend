import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { openApiDocument } from '../supabase/functions/_shared/openapi.js';

describe('photo performance additive contract', () => {
  it('declares the same optional true-only query on both upload routes', () => {
    for (const path of ['/v1/attempts/{attemptId}/photo-slots/{slotId}/upload', '/v1/attempts/{attemptId}/photo-slots/{slotId}/photos/{photoItemId}/upload'] as const) {
      const op = openApiDocument.paths[path].post;
      expect(op.parameters.filter(p => p.name === 'includePhotoSlots')).toEqual([expect.objectContaining({
        required: false, in: 'query', schema: { type: 'boolean', enum: [true] },
      })]);
      expect(op.responses['200'].headers).toHaveProperty('Server-Timing');
    }
  });
  it('validates both legacy and nullable snapshot envelopes without opening arbitrary properties', () => {
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    ajv.addSchema({ $id: 'photo', components: openApiDocument.components });
    const validate = ajv.compile({ $ref: 'photo#/components/schemas/PhotoUploadResponse' });
    const uuid = '10000000-0000-4000-8000-000000000001';
    const base = { operationId: uuid, objectId: uuid, attemptId: uuid, targetSlotId: uuid, photoItemId: null,
      status: 'accepted', leaseVersion: 1, leaseExpiresAt: null, photoId: uuid, photoVersion: 1,
      collectionRevision: null, itemRevision: null, uploadedAt: '2026-10-09T00:00:00Z', purgeAfter: '2026-10-16T00:00:00Z', retentionPolicy: 'cleaning_submission',
      retentionStartsAt: null, expiresAt: null, purgedAt: null, mediaAvailability: 'available', compensationAllowed: false, quotaWarning: false };
    expect(validate(base), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...base, photoSlots: null })).toBe(true);
    expect(validate({ ...base, status: 'accepted', photoSlots: { attemptId: uuid, assignmentId: uuid, assignmentRevision: 1, slots: [] } })).toBe(true);
    expect(validate({ ...base, photoSlots: { providerFileId: 'private' } })).toBe(false);
    expect(validate({ ...base, providerFileId: 'private' })).toBe(false);
  });
});
