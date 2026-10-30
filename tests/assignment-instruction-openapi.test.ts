import { describe, expect, it } from 'vitest';
import { openApiDocument } from '../supabase/functions/_shared/openapi.js';

const schemas = openApiDocument.components.schemas;
describe('#534 assignment instruction public contract', () => {
  it.each(['AssignmentDraftRequest', 'AssignmentPrestartChangeRequest'] as const)('%s accepts optional nullable memo', name => {
    const schema = schemas[name];
    expect(schema.required).not.toContain('instructionMemo');
    expect(schema.properties.instructionMemo).toMatchObject({ type: ['string', 'null'], minLength: 0, maxLength: 500 });
    expect(schema.additionalProperties).toBe(false);
  });
  it.each(['Assignment', 'AssignmentCard', 'AssignmentCommitCandidate', 'AssignmentCommitBlockedCandidate', 'AttemptExecution'] as const)('%s has a revision-bound nullable read value', name => {
    const schema = schemas[name];
    expect(schema.required).toContain('instructionMemo');
    expect(schema.properties.instructionMemo).toMatchObject({ type: ['string', 'null'], minLength: 1, maxLength: 500 });
    expect(schema.properties.instructionMemo.description).toContain('미배포 후보');
    expect(schema.additionalProperties).toBe(false);
  });
  it('does not turn an unassign or cancellation into a memo edit', () => {
    for (const name of ['AssignmentPrestartUnassignRequest', 'AssignmentCancellationRequest', 'AssignmentCancellationDecisionRequest'] as const) {
      expect(schemas[name].properties).not.toHaveProperty('instructionMemo');
    }
  });
});
