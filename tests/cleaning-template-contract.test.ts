import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { openApiDocument } from '../supabase/functions/_shared/openapi.js';
import { flatTemplateRequest, historicalTemplateRequest, invalidFlatTemplateRequests, templateProjection } from './fixtures/cleaning-template-contract.js';

// Validate the serialized document consumers receive, including $ref and 2020-12 tuples.
const document = JSON.parse(JSON.stringify(openApiDocument));
const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
const validate = ajv.compile({
  $ref: '#/components/schemas/PublishCleaningTemplateRequest', components: document.components
});
const read = ajv.compile({
  $ref: '#/components/schemas/PublishedCleaningTemplate', components: document.components
});

describe('cleaning template wire schema', () => {
  it.each(['standard', 'premium', 'oceanPremium', 'oceanFamily'])('accepts initial and CAS v9 publication for %s', (roomTypeCode) => {
    for (const expectedVersion of [0, 9, 12]) {
      expect(validate({ ...flatTemplateRequest, roomTypeCode, expectedVersion }), JSON.stringify(validate.errors)).toBe(true);
    }
    expect(validate({ ...flatTemplateRequest, roomTypeCode, durationMinutes: null })).toBe(true);
    expect(read(templateProjection())).toBe(true);
  });

  it.each(invalidFlatTemplateRequests())('rejects %s', (_name, request) => {
    expect(validate(JSON.parse(JSON.stringify(request)))).toBe(false);
  });

  it('describes the DB canonical labels and metadata boundary', () => {
    for (const patch of [{ label: '다른 이름' }, { section: '새 구역' }]) {
      expect(validate({ ...flatTemplateRequest, slots: flatTemplateRequest.slots.map((slot) => ({ ...slot, ...patch })) })).toBe(false);
    }
  });

  it.each(['standard', 'premium', 'oceanPremium', 'oceanFamily'])('keeps %s v8 and pre-A replay/read shapes separate', (roomTypeCode) => {
    for (const legacy of [false, true]) {
      const request = historicalTemplateRequest(roomTypeCode, legacy);
      expect(validate(request), JSON.stringify(validate.errors)).toBe(true);
      expect(read({ ...templateProjection(), version: legacy ? 12 : 8, slots: request.slots })).toBe(true);
      expect(validate({ ...request, slots: request.slots.slice(1) })).toBe(false);
    }
    expect(document.components.schemas.CheckoutCleaningTemplateLegacyReplaySlots.description).toContain('receipt가 없으면');
  });
});
