import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { openApiDocument } from '../supabase/functions/_shared/openapi.js';
import { preparePostApprovalOpenApi } from '../scripts/generate-post-approval-openapi.js';
import { postApprovalRoomIssueModuleOpenApiFragment } from '../src/modules/post-approval-room-issues/post-approval-room-issue-module.openapi.js';

describe('#406 frontend handoff contract corrections', () => {
  it('validates photo count 0..20 and rejects 21 without changing per-slot limits', () => {
    const slot = openApiDocument.components.schemas.AttemptPhotoSlots.properties.slots.items.properties;
    const validate = new Ajv2020({ strict: false }).compile(slot.photoCount);
    for (const count of [0, 1, 10, 11, 20]) expect(validate(count)).toBe(true);
    for (const count of [-1, 21, 1.5, '20']) expect(validate(count)).toBe(false);
    expect(slot.photoCount.maximum).toBe(slot.photos.maxItems);
    expect(slot.maxPhotos.enum).toEqual([1, 10, 20]);
  });
  it('rejects an unverified release annotation', () => {
    const fragment = structuredClone(postApprovalRoomIssueModuleOpenApiFragment);
    const operation = Object.values(fragment.paths)[0];
    if (!operation) throw new Error('missing operation');
    const value = Object.values(operation)[0] as unknown as Record<string, unknown>;
    value['x-deployed-release'] = 'v9.9.9';
    expect(() => preparePostApprovalOpenApi(fragment)).toThrow('auth/status drift');
  });
});
