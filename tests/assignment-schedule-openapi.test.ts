import { describe, expect, it } from 'vitest';
import { openApiDocument } from '../supabase/functions/_shared/openapi.js';

const schemas = openApiDocument.components.schemas;
const scheduleFields = ['capturedAt', 'scheduleRevision', 'scheduleReasonCode',
  'sourceReservationVersion', 'plannedCheckoutAt', 'actualCheckoutAt',
  'plannedRoomDepartureAt', 'actualRoomDepartureAt', 'nextCheckInAt',
  'nextRoomArrivalAt', 'nextArrivalKind', 'isEarlyCheckIn', 'isLateCheckout',
  'isScheduleUpdated'];

describe('#328 assignment schedule OpenAPI contract', () => {
  it('adds required nullable packs only to read cards', () => {
    const card = schemas.AssignmentCard;
    for (const [field, reference] of [
      ['scheduleSnapshot', 'AssignmentScheduleSnapshot'],
      ['currentDeparture', 'AssignmentCurrentDeparture']
    ] as const) {
      expect(card.required).toContain(field);
      expect(card.properties[field].anyOf).toEqual([
        { $ref: `#/components/schemas/${reference}` }, { type: 'null' }
      ]);
    }
    expect(card.additionalProperties).toBe(false);
    expect(new Set(card.required).size).toBe(card.required.length);
    for (const name of ['AssignmentPreviewRow', 'AssignmentCommitCandidate',
      'AssignmentCommitBlockedCandidate', 'AssignmentCommitUnassignedTarget'] as const) {
      expect(schemas[name].properties).not.toHaveProperty('scheduleSnapshot');
      expect(schemas[name].properties).not.toHaveProperty('currentDeparture');
    }
  });

  it('whitelists an immutable complete non-PII schedule pack', () => {
    const snapshot = schemas.AssignmentScheduleSnapshot;
    expect(snapshot.additionalProperties).toBe(false);
    expect([...snapshot.required].sort()).toEqual([...scheduleFields].sort());
    expect(Object.keys(snapshot.properties).sort()).toEqual([...scheduleFields].sort());
    expect(snapshot.properties.capturedAt).toMatchObject({ type: 'string', format: 'date-time' });
    expect(snapshot.properties.scheduleRevision).toMatchObject({ type: 'integer', minimum: 1 });
    expect(snapshot.properties.sourceReservationVersion).toMatchObject({ type: ['integer', 'null'], minimum: 1 });
    expect(snapshot.properties.scheduleReasonCode).toMatchObject({ type: 'string', minLength: 1 });
    expect(Object.keys(snapshot.properties).some((field) =>
      /guestName|guestCount|phone|pin|reservationId|segmentId|eventId|sourceKey/i.test(field))).toBe(false);
  });

  it('separates nullable planned, actual and room-move times from KST badges', () => {
    const properties = schemas.AssignmentScheduleSnapshot.properties;
    for (const field of ['plannedCheckoutAt', 'actualCheckoutAt', 'plannedRoomDepartureAt',
      'actualRoomDepartureAt', 'nextCheckInAt', 'nextRoomArrivalAt'] as const) {
      expect(properties[field]).toMatchObject({ type: ['string', 'null'], format: 'date-time' });
    }
    expect(properties.nextArrivalKind.enum).toEqual(['check_in', 'room_move', null]);
    expect(properties.isEarlyCheckIn.type).toEqual(['boolean', 'null']);
    expect(properties.isEarlyCheckIn.description).toContain('KST 16:00');
    expect(properties.isEarlyCheckIn.description).toContain('room_move');
    expect(properties.isLateCheckout.type).toEqual(['boolean', 'null']);
    expect(properties.isLateCheckout.description).toContain('KST 11:00');
    expect(properties.nextCheckInAt.description).toContain('dueAt에서 역산하지 않습니다');
    expect(properties.isScheduleUpdated.type).toBe('boolean');
    expect(properties.isScheduleUpdated.description).toContain('CAS 증가');
  });

  it('documents current-only facts and immutable history without endpoint or version changes', () => {
    const departure = schemas.AssignmentCurrentDeparture;
    expect(departure.additionalProperties).toBe(false);
    expect(departure.required).toEqual(['evaluatedAt', 'actualCheckoutAt', 'actualRoomDepartureAt']);
    expect(Object.keys(departure.properties)).toEqual(departure.required);
    expect(departure.properties.evaluatedAt).toMatchObject({ type: 'string', format: 'date-time' });
    expect(departure.description).toContain('history/includeHistory는 항상 null');
    expect(departure.description).toContain('점유 재개');
    expect(schemas.AssignmentCard.properties.scheduleSnapshot.description).toContain('backfill하지 않습니다');
    const paths = openApiDocument.paths;
    expect(paths['/v1/assignments'].get.description).toContain('includeHistory=true에서는 모든 행이 null');
    expect(paths['/v1/assignments/{cleaningTargetId}/history'].get.description).toContain('항상 null');
    expect(paths['/v1/assignments'].get['x-required-roles']).toEqual(['admin', 'maid']);
    expect(paths['/v1/assignments/{cleaningTargetId}/history'].get['x-required-roles']).toEqual(['admin', 'maid']);
    expect(Object.keys(paths)).toHaveLength(140);
    expect(Object.values(paths).flatMap((path) => Object.keys(path).filter((method) =>
      ['get', 'post', 'put', 'patch', 'delete'].includes(method)))).toHaveLength(151);
    expect(openApiDocument.info.version).toBe('0.6.0');
  });
});
