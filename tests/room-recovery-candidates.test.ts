import { describe, expect, it } from 'vitest';
import { roomRecoveryCandidates } from '../src/modules/rooms/room-recovery-candidates.js';

const conflict = {
  id: 'room-a', roomNumber: '201', evaluatedAt: '2026-11-25T02:00:00Z', projectionMode: 'LIVE',
  arrival: null, displayStatusOverride: 'READY', readinessStatus: 'CHECKIN_BLOCKED',
  readinessReasonCodes: ['PIN_MISMATCH', 'CLEANING_REQUIRED']
};

describe('room recovery candidates', () => {
  it('shows an explicit READY conflict without exposing unrelated fields', () => {
    const list = roomRecoveryCandidates([
      { ...conflict, guestName: 'private' } as typeof conflict,
      { ...conflict, id: 'b', displayStatusOverride: null },
      { ...conflict, id: 'c', readinessStatus: 'READY', readinessReasonCodes: [] },
      { ...conflict, id: 'd', readinessReasonCodes: ['PIN_MISMATCH'] }
    ]);
    expect(list).toEqual({ evaluatedAt: conflict.evaluatedAt, candidates: [{
      roomId: 'room-a', roomNumber: '201', displayStatus: 'READY', readinessStatus: 'CHECKIN_BLOCKED',
      reasonCodes: ['CLEANING_REQUIRED'], recommendedAction: 'PREVIEW_READY_CORRECTION'
    }] });
  });
  it('includes a current arrival-specific cleaning obligation but excludes unrelated arrival blockers', () => {
    const room = { ...conflict, readinessReasonCodes: [] };
    const result = roomRecoveryCandidates([
      { ...room, arrival: { checkInReady: false, reasonCodes: ['CLEANING_REQUIRED'] } },
      { ...room, id: 'other', arrival: { checkInReady: false, reasonCodes: ['RESERVATION_CURRENT'] } }
    ]);
    expect(result.candidates.map(item => item.roomId)).toEqual([room.id]);
  });
  it('accepts empty results and rejects invalid snapshots', () => {
    expect(roomRecoveryCandidates([]).candidates).toEqual([]);
    expect(() => roomRecoveryCandidates([conflict, conflict])).toThrow();
    expect(() => roomRecoveryCandidates([{ ...conflict, projectionMode: 'PAST_END_OF_DAY' }])).toThrow();
  });
});
