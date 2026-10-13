import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { indexAssignmentSchedules, parseAssignmentScheduleReads, summarizeAssignmentRollover } from '../src/modules/assignments/assignment-schedule-core.js';
import { frozenSchedule } from './fixtures/assignment-schedule.js';
const id = '30000000-0000-4000-8000-000000000001';
const row = { assignmentId: id, scheduleSnapshot: frozenSchedule, currentDeparture: null };
const parse = (value: unknown, current = false) => parseAssignmentScheduleReads(value, [id], current);

describe('request-local schedule history index', () => {
  it('preserves identity, input order, duplicate revisions and separate requests', () => {
    const first = Object.freeze({ cleaning_target_id: 'a', revision: 2 });
    const second = Object.freeze({ cleaning_target_id: 'b', revision: 3 });
    const third = Object.freeze({ cleaning_target_id: 'a', revision: 2 });
    const rows = Object.freeze([first, second, third]);
    const index = indexAssignmentSchedules(rows);
    expect(index.get('a')).toEqual([first, third]);
    expect(index.get('a')?.[0]).toBe(first);
    expect(index.get('b')).toEqual([second]);
    expect(index.get('missing')).toBeUndefined();
    expect(indexAssignmentSchedules([]).size).toBe(0);
    expect(indexAssignmentSchedules(rows).get('a')).not.toBe(index.get('a'));
    expect(rows).toEqual([first, second, third]);
  });
  it.each([1, 100, 1000])('indexes %i targets once and visits only each target history', count => {
    let reads = 0;
    const rows = Array.from({ length: count }, (_, i) => ({
      get cleaning_target_id() { reads++; return String(i); },
      revision: 1
    }));
    const index = indexAssignmentSchedules(rows);
    expect(reads).toBe(count);
    for (let i = 0; i < count; i++) {
      expect(index.get(String(i))?.filter(row => row.cleaning_target_id === String(i)))
        .toEqual([rows[i]]);
    }
    expect(reads).toBe(2 * count);
    // Old per-card global filter examines count * count IDs.
    // This is deterministic work counting, not a production latency claim.
  });
});

describe('single-pass rollover display reduction', () => {
  const reasons = ['ROLLED_OVER_UNASSIGNED', 'ROLLED_OVER_NOT_STARTED', 'RESERVATION_CHANGED'] as const;
  it('matches the former stable filter/sort for mixed targets, revisions, ties and caps', () => {
    for (let seed = 0; seed < 60; seed++) {
      const rows = Object.freeze(Array.from({ length: seed }, (_, i) => Object.freeze({
        cleaning_target_id: i % 3 === 0 ? 'other' : 'target',
        revision: (i * 7 + seed) % 11,
        reason_code: reasons[(i + seed) % 3] ?? 'RESERVATION_CHANGED'
      })));
      for (const revision of [0, 1, 5, 10, 20]) {
        for (const cap of [0, 1, 4, 100]) {
          const evidence = rows.filter(row => row.cleaning_target_id === 'target' &&
            row.revision <= revision && reasons.slice(0, 2).includes(row.reason_code))
            .sort((a, b) => b.revision - a.revision);
          const count = Math.min(cap, evidence.length);
          expect(summarizeAssignmentRollover(rows, 'target', revision, cap)).toEqual({
            rolloverCount: count, rolloverReason: count === 0 ? null : evidence[0]?.reason_code ?? null
          });
        }
      }
    }
  });
  it('visits unsorted evidence once and keeps the first reason on equal revisions', () => {
    let visits = 0;
    const rows = [
      { cleaning_target_id: 'a', revision: 2, reason_code: reasons[1] },
      { cleaning_target_id: 'a', revision: 2, reason_code: reasons[0] },
      { cleaning_target_id: 'a', revision: 1, reason_code: reasons[0] }
    ].map(row => ({ ...row, get cleaning_target_id() { visits++; return row.cleaning_target_id; } }));
    expect(summarizeAssignmentRollover(rows, 'a', 2, 10)).toEqual({
      rolloverCount: 3, rolloverReason: reasons[1]
    });
    expect(visits).toBe(3);
    expect(summarizeAssignmentRollover(rows, 'a', 1, 10)).toEqual({
      rolloverCount: 1, rolloverReason: reasons[0]
    });
  });
});

describe('exact safe assignment schedule read boundary', () => {
  it('preserves a separate planning day without changing the original schedule', () => {
    expect(parse([{ ...row, planningDate: '2026-10-11' }]).get(id)?.planningDate).toBe('2026-10-11');
  });
  it.each([null, 20261011, '2026-02-30', '2026-13-01', '2026-10-11T00:00:00Z'])('rejects invalid planning date %j', planningDate => {
    expect(() => parse([{ ...row, planningDate }])).toThrow('ASSIGNMENT_SCHEDULE_READ_INVALID');
  });
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
