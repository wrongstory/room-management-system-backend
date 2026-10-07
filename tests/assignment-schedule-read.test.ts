import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseAssignmentScheduleReads } from '../src/modules/assignments/assignment-schedule-core.js';
import { frozenSchedule } from './fixtures/assignment-schedule.js';
const id = '30000000-0000-4000-8000-000000000001';
const row = { assignmentId: id, scheduleSnapshot: frozenSchedule, currentDeparture: null };
const parse = (value: unknown, current = false) => parseAssignmentScheduleReads(value, [id], current);

describe('exact safe assignment schedule read boundary', () => {
  it('preserves frozen source times and known false/null without inference or mutation', () => {
    const input = [{ ...row, scheduleSnapshot: { ...frozenSchedule, sourceReservationVersion: null,
      plannedCheckoutAt: null, nextCheckInAt: null, nextRoomArrivalAt: null, nextArrivalKind: null,
      isEarlyCheckIn: null, isLateCheckout: null } }];
    const before = JSON.stringify(input);
    expect(parse(input).get(id)).toEqual({ scheduleSnapshot: input[0]?.scheduleSnapshot, currentDeparture: null });
    expect(JSON.stringify(input)).toBe(before);
    expect(parse([{ assignmentId: id, scheduleSnapshot: null, currentDeparture: null }]).get(id))
      .toEqual({ scheduleSnapshot: null, currentDeparture: null });
  });
  it('keeps current actual checkout separate from the earlier frozen planned snapshot', () => {
    const currentDeparture = { evaluatedAt: '2026-10-02T03:00:00Z',
      actualCheckoutAt: '2026-10-02T02:00:00+00:00', actualRoomDepartureAt: null };
    expect(parse([{ ...row, currentDeparture }], true).get(id)).toEqual({
      scheduleSnapshot: frozenSchedule, currentDeparture
    });
    expect(() => parse([{ ...row, currentDeparture }])).toThrow('ASSIGNMENT_SCHEDULE_READ_INVALID');
  });
  it.each([null, {}, [], [row, row], [{ ...row, assignmentId: 'other' }],
    [{ ...row, guestName: 'never-forward' }], [{ assignmentId: id }],
    [{ ...row, scheduleSnapshot: undefined }]].map((value) => [value]))
  ('rejects missing/truncated/duplicate/cross-ID and unexpected envelope fields: %j', (value) => {
    expect(() => parse(value)).toThrow('ASSIGNMENT_SCHEDULE_READ_INVALID');
  });
  it.each(Object.keys(frozenSchedule))('requires every new snapshot field: %s', (key) => {
    const invalid = { ...frozenSchedule } as Record<string, unknown>;
    delete invalid[key];
    expect(() => parse([{ ...row, scheduleSnapshot: invalid }])).toThrow('ASSIGNMENT_SCHEDULE_READ_INVALID');
  });
  it.each([
    { scheduleRevision: 0 }, { scheduleRevision: 1.5 }, { sourceReservationVersion: 0 },
    { sourceReservationVersion: '1' }, { scheduleReasonCode: 'private free text' },
    { nextArrivalKind: 'move' }, { isEarlyCheckIn: 'true' }, { isLateCheckout: 0 },
    { isScheduleUpdated: null }, { plannedCheckoutAt: '2026-02-30T11:00:00Z' },
    { capturedAt: '2026-10-02 11:00:00+09' }, { nextCheckInAt: '2026-10-02T24:00:00Z' },
    { actualCheckoutAt: '2026-10-02T03:00:00' }, { actualRoomDepartureAt: 1234 },
    { sourceReservationId: id }, { sourceRoomId: id }, { guestPhone: 'never-forward' }, { pin: 'never-forward' }
  ])('rejects malformed or internal/private snapshot fields: %j', (patch) => {
    expect(() => parse([{ ...row, scheduleSnapshot: { ...frozenSchedule, ...patch } }]))
      .toThrow('ASSIGNMENT_SCHEDULE_READ_INVALID');
  });
  it.each([
    { evaluatedAt: 'invalid', actualCheckoutAt: null, actualRoomDepartureAt: null },
    { evaluatedAt: '2026-10-02T03:00:00Z', actualCheckoutAt: '2026-10-02T03:00:01Z', actualRoomDepartureAt: null },
    { evaluatedAt: '2026-10-02T03:00:00Z', actualCheckoutAt: null, actualRoomDepartureAt: '2026-10-02T04:00:00Z' },
    { evaluatedAt: '2026-10-02T03:00:00Z', actualCheckoutAt: null },
    { evaluatedAt: '2026-10-02T03:00:00Z', actualCheckoutAt: null, actualRoomDepartureAt: null, raw: {} }
  ])('rejects invalid/future or unexpected current actual facts: %j', (currentDeparture) => {
    expect(() => parse([{ ...row, currentDeparture }], true)).toThrow('ASSIGNMENT_SCHEDULE_READ_INVALID');
  });
  it('enforces batch bound and exact ID uniqueness', () => {
    expect(() => parseAssignmentScheduleReads([], [], false)).toThrow();
    expect(() => parseAssignmentScheduleReads([row, row], [id, id], false)).toThrow();
    expect(() => parseAssignmentScheduleReads(Array(101).fill(row), Array(101).fill(id), true)).toThrow();
  });
  it('keeps Node and Edge copies of the pure validation contract identical', () => {
    const normalize = (source: string) => source.replaceAll("'", '"').replace(/\s+/g, '');
    expect(normalize(readFileSync('src/modules/assignments/assignment-schedule-core.ts', 'utf8')))
      .toBe(normalize(readFileSync('supabase/functions/_shared/assignment-schedule-core.ts', 'utf8')));
  });
});
