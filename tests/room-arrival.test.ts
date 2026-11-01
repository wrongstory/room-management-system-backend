import { describe, expect, it } from 'vitest';
import { parseRoomArrival } from '../src/modules/rooms/room-arrival-contract.js';
import { readFileSync } from 'node:fs';

const pending = {
  status: 'CHECKIN_PENDING', checkInReady: false, reasonCodes: ['CLEANING_REQUIRED'],
  actualCheckInAt: null, recordedAt: '2026-11-01T09:00:00+09:00'
};
describe('#548 independent arrival facts', () => {
  it.each(['SCHEDULED', 'CHECKIN_PENDING'])('does not equate %s with completed check-in', status => {
    expect(parseRoomArrival({ ...pending, status })).toEqual({ ...pending, status });
  });
  it('keeps pending-but-ready distinct from checked in', () => {
    expect(parseRoomArrival({ ...pending, checkInReady: true, reasonCodes: [] })?.status).toBe('CHECKIN_PENDING');
  });
  it('does not manufacture history for unavailable projections', () => {
    expect(parseRoomArrival(null)).toBeNull();
    expect(parseRoomArrival(undefined)).toBeNull();
  });
  it('keeps a future room move separate from completed arrival at that room', () => {
    expect(parseRoomArrival({ status: 'ROOM_MOVE_PENDING', checkInReady: null,
      reasonCodes: null, actualCheckInAt: '2026-10-31T16:00:00+09:00',
      recordedAt: '2026-10-30T09:00:00+09:00' })?.status).toBe('ROOM_MOVE_PENDING');
  });
  it('rejects readiness for an absent reservation and missing registration facts', () => {
    expect(() => parseRoomArrival({ status: 'NONE', checkInReady: true,
      reasonCodes: [], actualCheckInAt: null, recordedAt: null })).toThrow('ROOM_ARRIVAL_INVALID');
    expect(() => parseRoomArrival({ ...pending, status: 'SCHEDULED', recordedAt: null })).toThrow('ROOM_ARRIVAL_INVALID');
  });
  it.each([
    { checkInReady: true }, { reasonCodes: [] }, { status: 'CHECKED_IN' },
    { actualCheckInAt: '2026-11-01T09:00:00Z' }, { reasonCodes: ['private-secret'] },
    { recordedAt: 'not-a-date' }, { checkInReady: null }, { status: 'NONE' }
  ])('rejects inconsistent or unsafe facts %j', patch => {
    expect(() => parseRoomArrival({ ...pending, ...patch })).toThrow('ROOM_ARRIVAL_INVALID');
  });
  it('strips unexpected private payload', () => {
    const value = { ...pending, privatePayload: 'do-not-return' };
    expect(parseRoomArrival(value)).toEqual(pending);
  });
  it('keeps the SQL wrapper read-only and retains actor/session and historical boundaries', () => {
    const sql = readFileSync(new URL('../supabase/migrations/20261101104125_room_arrival_readiness_projection.sql', import.meta.url), 'utf8');
    expect(sql).toContain('private.assert_attempt_actor_session(p_actor_profile_id, p_session_id, true)');
    expect(sql).toContain("board.projection_mode <> 'LIVE'");
    expect(sql).toContain('board.id, board.evaluated_at, true, true, reservation.id');
    expect(sql).toContain("r.status = 'active' and r.actual_checkout_at is null");
    expect(sql).not.toMatch(/^\s*(update|insert|delete|truncate|alter table)\b/im);
    expect(sql).not.toContain('process_due_reservation_transitions');
    expect(sql).toContain('from public, anon, authenticated');
  });
});
