import { describe, expect, it } from 'vitest';
import { openApiDocument } from '../supabase/functions/_shared/openapi.js';

const schemas = openApiDocument.components.schemas;
const metadata = ['cleaningKind', 'sourceKind', 'roomTypeSnapshot', 'roomTypeCode',
  'roomTypeName', 'elevatorZone', 'feeSnapshot', 'originalServiceDate',
  'effectiveServiceDate', 'rolloverCount', 'rolloverReason', 'canCancel', 'cancelReasonCode'];

describe('#326 assignment read OpenAPI contract', () => {
  it.each(['AssignmentPreviewRow', 'AssignmentPreviewBlockedTarget', 'AssignmentPreviewRemainingTarget',
    'AssignmentCard', 'AssignmentCommitCandidate', 'AssignmentCommitBlockedCandidate',
    'AssignmentCommitUnassignedTarget'] as const)('%s has complete whitelisted metadata and unique required keys', (name) => {
    const schema = schemas[name];
    for (const field of metadata) {
      expect(schema.required).toContain(field);
      expect(schema.properties).toHaveProperty(field);
    }
    expect(new Set(schema.required).size).toBe(schema.required.length);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties).not.toHaveProperty('sourceKey');
    expect(schema.properties).not.toHaveProperty('domainIdentity');
    expect(schema.properties).not.toHaveProperty('manualCleaningRequestId');
    expect(schema.properties).not.toHaveProperty('targetVersion');
  });

  it('preserves preview classifier/fee compatibility while adding a canonical nullable snapshot', () => {
    expect(schemas.AssignmentPreviewRow.properties.roomTypeCode.enum).toContain('unknown');
    expect(schemas.AssignmentPreviewRow.properties.roomTypeCode.type).toBe('string');
    expect(schemas.AssignmentPreviewRow.properties.elevatorZone.type).toBe('string');
    expect(schemas.AssignmentPreviewRow.properties.feeSnapshot).toMatchObject({ type: 'integer', minimum: 0 });
    expect(schemas.AssignmentRoomTypeSnapshot.required).toEqual(['code', 'name', 'elevatorZone']);
    for (const property of Object.values(schemas.AssignmentRoomTypeSnapshot.properties)) {
      expect(property.type).toEqual(['string', 'null']);
    }
    expect(schemas.AssignmentPreviewRow.properties.targetAssignmentVersion.minimum).toBe(1);
  });

  it('represents legacy commit receipt unknowns without claiming zero/no rollover', () => {
    const row = schemas.AssignmentCommitUnassignedTarget.properties;
    expect(row.feeSnapshot.type).toEqual(['integer', 'null']);
    expect(row.rolloverCount.type).toEqual(['integer', 'null']);
    expect(row.originalServiceDate.type).toEqual(['string', 'null']);
    expect(row.roomTypeSnapshot.anyOf).toContainEqual({ type: 'null' });
    expect(row.cancelReasonCode.enum).toContain('CAPABILITY_UNAVAILABLE');
    expect(row.canCancel.description).toContain('담당 해제');
    expect(row.canCancel.description).toContain('session/상태/CAS/멱등성');
  });

  it.each(['AssignmentPreviewBlockedTarget', 'AssignmentPreviewRemainingTarget'] as const)(
    '%s describes the full preview target metadata output without extra properties', (name) => {
      const schema = schemas[name];
      const fields = [...metadata, 'cleaningTargetId', 'roomId', 'roomNumber', 'serviceDate',
        'expectedAssignmentVersion', 'targetAssignmentVersion', 'durationMinutes', 'availableFrom', 'dueAt', 'reason',
        ...(name === 'AssignmentPreviewRemainingTarget' ? ['reasonCodes'] : [])];
      expect(Object.keys(schema.properties).sort()).toEqual(fields.sort());
      expect([...schema.required].sort()).toEqual(fields.sort());
      expect(schema.properties.durationMinutes.type).toBe('null');
      expect(schema.properties.expectedAssignmentVersion).toMatchObject({ type: 'integer', minimum: 1 });
    });

  it('does not add endpoints or change the target-cancel request keys', () => {
    const paths = openApiDocument.paths;
    expect(Object.keys(paths)).toHaveLength(139);
    expect(Object.values(paths).flatMap((path) => Object.keys(path).filter((method) =>
      ['get', 'post', 'put', 'patch', 'delete'].includes(method)))).toHaveLength(150);
    expect(schemas.ReservationMutationRequest.required).toEqual(['expectedVersion', 'reasonCode']);
  });
});
