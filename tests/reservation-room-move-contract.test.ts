import { describe, expect, it } from 'vitest';
import { openApiDocument } from '../supabase/functions/_shared/openapi.js';

describe('reservation room-move OpenAPI contract', () => {
  it('keeps the two existing paths and exposes during-stay preview identities', () => {
    const paths = openApiDocument.paths as Record<string, unknown>;
    expect(paths).toHaveProperty('/v1/reservations/{reservationId}/room-change/preview');
    expect(paths).toHaveProperty('/v1/reservations/{reservationId}/room-change');
    expect(paths).not.toHaveProperty('/v1/reservations/{reservationId}/room-change/commit');

    const schemas = openApiDocument.components.schemas;
    expect(schemas.ReservationRoomMovePreview.required).toEqual(
      expect.arrayContaining(['stayId', 'stayVersion', 'sourceSegmentId', 'sourceSegmentVersion'])
    );
    expect(schemas.ReservationRoomMoveMode.enum).toEqual(['BEFORE_CHECKIN', 'DURING_STAY']);
  });

  it('publishes bounded during-stay commit metadata and the stable errors', () => {
    const schemas = openApiDocument.components.schemas;
    const result = schemas.ReservationRoomMoveResult;
    expect(result.properties).toHaveProperty('stay');
    expect(result.properties).toHaveProperty('segments');
    expect(result.properties).toHaveProperty('sourceCleaningTargetId');
    expect(result.properties).toHaveProperty('pinAccessEndsAt');
    expect(result.required).not.toEqual(
      expect.arrayContaining(['stay', 'segments', 'sourceCleaningTargetId', 'pinAccessEndsAt'])
    );

    const stableCodes = [
      'OPEN_ENDED_STAY_REQUIRES_END',
      'INVALID_MOVE_EFFECTIVE_AT',
      'TARGET_ROOM_NOT_READY',
      'TARGET_ROOM_OVERLAP',
      'TARGET_ROOM_BLOCKED',
      'PIN_LEASE_ACTIVE'
    ];
    expect(schemas.ErrorCode.enum).toEqual(expect.arrayContaining(stableCodes));
    expect(schemas.ReservationRoomMoveRejectionReasonCode.enum).toEqual(
      expect.arrayContaining([
        'OPEN_ENDED_STAY_REQUIRES_END',
        'INVALID_MOVE_EFFECTIVE_AT',
        'TARGET_ROOM_NOT_READY'
      ])
    );
  });
});
