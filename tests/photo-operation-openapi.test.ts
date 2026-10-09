import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { openApiDocument } from '../supabase/functions/_shared/openapi.js';
import { projectPhotoUploadOperation as edgeProject } from '../supabase/functions/_shared/photo-upload-contract.js';
import { photoOperationRetentionCases } from './fixtures/photo-operation-retention.js';

const document = JSON.parse(JSON.stringify(openApiDocument));
const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
const operation = ajv.compile({ $ref: '#/components/schemas/PhotoUploadOperation', components: document.components });
const upload = ajv.compile({ $ref: '#/components/schemas/PhotoUploadResponse', components: document.components });
const cases = photoOperationRetentionCases();
describe('#410 actual photo operation retention wire contract', () => {
  it.each(cases)('accepts Fastify and Edge projection $name in status and upload responses', ({ body }) => {
    expect(edgeProject(body)).toEqual(body);
    expect(operation(body), JSON.stringify(operation.errors)).toBe(true);
    expect(upload({ ...body, quotaWarning: false }), JSON.stringify(upload.errors)).toBe(true);
    expect(upload(body)).toBe(false);
  });
  it.each(['provider_succeeded', 'accepted', 'compensation_pending', 'compensated'])('rejects missing retention after %s', status => {
    const base = cases[0]; if (!base) throw new Error('fixture missing');
    expect(operation({ ...base.body, status })).toBe(false);
  });
  it('rejects unknown enums, mismatched null pairs, omissions and private fields', () => {
    const base = cases[0]; if (!base) throw new Error('fixture missing');
    for (const patch of [
      { retentionPolicy: 'unknown', mediaAvailability: 'available' },
      { retentionPolicy: 'cleaning_submission', mediaAvailability: 'unknown' },
      { retentionPolicy: 'cleaning_submission', mediaAvailability: null },
      { retentionPolicy: null, mediaAvailability: 'available' },
      { providerLocator: 'synthetic-private' },
    ]) expect(operation({ ...base.body, ...patch })).toBe(false);
    for (const field of ['retentionPolicy', 'mediaAvailability']) {
      const value: Record<string, unknown> = { ...base.body }; delete value[field];
      expect(operation(value)).toBe(false);
    }
  });
  it('does not relax retained photo item metadata', () => {
    for (const field of ['retentionPolicy', 'mediaAvailability']) {
      const validate = ajv.compile(document.components.schemas.AttemptPhotoItem.properties[field]);
      expect(validate(null)).toBe(false);
    }
  });
});
