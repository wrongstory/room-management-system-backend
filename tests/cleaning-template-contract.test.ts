import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { openApiDocument } from '../supabase/functions/_shared/openapi.js';
import { flatTemplateRequest, flatTemplateSlotPermutations, historicalTemplateRequest, invalidFlatTemplateRequests, templateProjection } from './fixtures/cleaning-template-contract.js';

// Validate the serialized document consumers receive, including exact-one role membership.
const document = JSON.parse(JSON.stringify(openApiDocument));
const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
const validate = ajv.compile({
  $ref: '#/components/schemas/PublishCleaningTemplateRequest', components: document.components
});
const read = ajv.compile({
  $ref: '#/components/schemas/PublishedCleaningTemplate', components: document.components
});

describe('cleaning template wire schema', () => {
  it('keeps the six array permutations distinct without changing canonical slot fields', () => {
    const before = JSON.stringify(flatTemplateRequest);
    const cases = flatTemplateSlotPermutations();
    expect(cases).toHaveLength(6);
    expect(new Set(cases.map(({ body }) => body.slots.map((slot) => slot.slotKey).join(','))).size).toBe(6);
    for (const { body } of cases) {
      for (const slot of body.slots) {
        expect(slot).toEqual(flatTemplateRequest.slots.find((canonical) => canonical.slotKey === slot.slotKey));
      }
    }
    expect(JSON.stringify(flatTemplateRequest)).toBe(before);
  });

  it.each(flatTemplateSlotPermutations())('accepts unordered canonical v9 slots: $name (#382)', ({ body, schemaAccepted }) => {
    expect(validate(JSON.parse(JSON.stringify(body))), JSON.stringify(validate.errors)).toBe(schemaAccepted);
  });

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
    const description = document.paths['/v1/cleaning-templates'].post.description;
    expect(description).toContain('6개 순서를 모두 허용');
    expect(description).toContain('canonical request hash·저장·응답을 유지');
    expect(description).not.toContain('#382 후속');
    expect(description).not.toContain('허용 범위를 확대하지 않습니다');
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
