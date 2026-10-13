import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '../src/domain/actor.js';
import { AppError } from '../src/lib/app-error.js';
import { frozenSchedule } from './fixtures/assignment-schedule.js';
import { createAssignmentRoutes } from '../src/modules/assignments/assignment.routes.js';
import {
  type AssignmentService,
  SupabaseAssignmentService
} from '../src/modules/assignments/assignment.service.js';

const maidId = '10000000-0000-4000-8000-000000000001';
const otherMaidId = '10000000-0000-4000-8000-000000000002';
const targetIds = [1, 2, 3, 4].map((value) => `20000000-0000-4000-8000-00000000000${value}`);
const assignmentIds = [1, 2, 3, 4].map((value) => `30000000-0000-4000-8000-00000000000${value}`);
const sessionId = '90000000-0000-4000-8000-000000000001';
const accessToken = `unit.${Buffer.from(JSON.stringify({ session_id: sessionId })).toString('base64url')}.unit`;

const admin: Actor = {
  authUserId: '40000000-0000-4000-8000-000000000001',
  profileId: '50000000-0000-4000-8000-000000000001',
  displayName: '관리자',
  role: 'admin',
  mustChangePassword: false,
  accessToken
};
const maid: Actor = {
  authUserId: '40000000-0000-4000-8000-000000000002',
  profileId: maidId,
  displayName: '메이드',
  role: 'maid',
  mustChangePassword: false,
  accessToken
};

const assignments = assignmentIds.map((id, index) => ({
  id,
  cleaning_target_id: targetIds[index],
  maid_profile_id: maidId,
  service_date: index === 3 ? '2026-09-21' : '2026-09-20',
  sequence_number: index + 1,
  revision: index === 3 ? 2 : 1,
  is_current: index !== 3,
  available_from_snapshot: '2026-09-20T02:00:00Z',
  due_at_snapshot: null,
  notified_at: '2026-09-19T00:00:00Z',
  notified_room_id_snapshot: `60000000-0000-4000-8000-00000000000${index + 1}`,
  notified_room_number_snapshot: `통보-${index + 1}`,
  ended_at: index === 3 ? '2026-09-20T15:00:00Z' : null,
  created_at: '2026-09-19T00:00:00Z'
}));

const kinds = ['checkout', 'stayover', 'additional', 'reclean'];
const targets = targetIds.map((id, index) => ({
  id,
  room_id: `70000000-0000-4000-8000-00000000000${index + 1}`,
  cleaning_kind: kinds[index],
  source: ['scheduled_checkout', 'stayover_request', 'manual_room_request', 'inspection_reclean'][index],
  original_service_date: '2026-09-20',
  effective_service_date: index === 3 ? '2026-09-22' : '2026-09-20',
  carryover_count: index === 3 ? 2 : 0,
  status: index === 3 ? 'draft_assigned' : 'unassigned',
  assignment_version: index === 3 ? 3 : 1,
  room_type_snapshot: {
    code: `TYPE-${index + 1}`,
    name: `객실 유형 ${index + 1}`,
    elevatorZone: index % 2 === 0 ? 'A' : null
  },
  fee_snapshot: 10000 + index * 1000,
  template_snapshot: { durationMinutes: index === 0 ? null : 30 + index },
  rooms: { room_number: `현재-${index + 1}` }
}));

type Row = Record<string, unknown>;

function query(initialRows: Row[], countOverride?: number | null, onIds?: (ids: unknown[]) => void, beforeRead?: () => Promise<void>) {
  let rows = [...initialRows];
  let maximum = 1000;
  const builder = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      rows = rows.filter((row) => row[column] === value);
      return builder;
    },
    not: (column: string, operator: string, value?: string) => {
      if (operator === 'is') rows = rows.filter((row) => row[column] !== null);
      if (column === 'cleaning_targets.status') rows = rows.filter((row) => !(value ?? '').slice(1, -1).split(',').includes((row.cleaning_targets as Row).status as string));
      return builder;
    },
    lt: (column: string, value: string) => {
      rows = rows.filter((row) => (row[column] as string) < value);
      return builder;
    },
    limit: (value: number) => { maximum = value; return builder; },
    in: (column: string, values: unknown[]) => {
      onIds?.(values);
      rows = rows.filter((row) => values.includes(row[column]));
      return builder;
    },
    order: () => builder,
    // biome-ignore lint/suspicious/noThenProperty: Supabase query builders are intentionally awaitable.
    then: (resolve: (value: { data: Row[]; error: null; count: number | null }) => unknown) =>
      Promise.resolve().then(beforeRead).then(() => ({ data: rows.slice(0, maximum), error: null, count: countOverride === undefined ? rows.length : countOverride })).then(resolve)
  };
  return builder;
}

function service(overrides: Partial<Record<string, Row[]>> = {}, clock: () => Date = () => new Date(), counts: Partial<Record<string, number | null>> = {}, onIds?: (ids: unknown[]) => void,
  read?: (args: Record<string, unknown>) => { data: unknown; error: { message: string } | null },
  beforeRead?: (table: string) => Promise<void>) {
  const tables: Record<string, Row[]> = {
    cleaning_assignments: assignments,
    cleaning_targets: targets,
    profiles: [{ id: maidId, display_name: '메이드' }],
    cleaning_attempts: [{
      id: '80000000-0000-4000-8000-000000000001',
      assignment_id: assignmentIds[0],
      attempt_number: 1,
      status: 'in_progress'
    }],
    cleaning_submissions: [{
      cleaning_attempt_id: '80000000-0000-4000-8000-000000000001',
      version: 2,
      status: 'submitted'
    }],
    cleaning_target_schedule_revisions: [{
      cleaning_target_id: targetIds[3],
      revision: 2,
      effective_service_date: '2026-09-21',
      reason_code: 'ROLLED_OVER_NOT_STARTED'
    }, {
      cleaning_target_id: targetIds[3],
      revision: 3,
      effective_service_date: '2026-09-22',
      reason_code: 'ROLLED_OVER_UNASSIGNED'
    }],
    ...overrides
  };
  const from = (table: string) => query(table === 'cleaning_assignments'
    ? (tables[table] ?? []).map((row) => ({ ...row, cleaning_targets: tables.cleaning_targets?.find((target) => target.id === row.cleaning_target_id) }))
    : tables[table] ?? [], counts[table], onIds, () => beforeRead?.(table) ?? Promise.resolve());
  return new SupabaseAssignmentService({
    admin: { from, rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      expect(name).toBe('get_assignment_schedule_read_for_plan');
      expect(args.p_session_id).toBe(sessionId);
      expect(['admin', 'maid']).toContain(args.p_expected_actor_role);
      return read?.(args) ?? { data: (args.p_assignment_ids as string[]).map((assignmentId) =>
        ({ assignmentId, scheduleSnapshot: null, currentDeparture: null })), error: null };
    }) },
    publicClient: {},
    forAccessToken: () => ({ from })
  } as never, clock);
}

describe('assignment hydration dependency pipeline', () => {
  it.each(['cleaning_targets', 'profiles', 'cleaning_target_schedule_revisions'])(
    'reads submissions before slow %s finishes, but revalidates authority last', async (slowTable) => {
      let release = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const events: string[] = [];
      const read = vi.fn(() => { events.push('authority'); return { data: [], error: { message: 'SESSION_REVOKED' } }; });
      const pending = service({}, undefined, {}, undefined, read, async (table) => {
        events.push(`start:${table}`);
        if (table === slowTable) await gate;
        events.push(`end:${table}`);
      }).list(admin, { serviceDate: '2026-09-20' });
      const rejection = expect(pending).rejects.toMatchObject({ code: 'SESSION_REVOKED' });
      try {
        await vi.waitFor(() => expect(events).toContain('end:cleaning_submissions'));
        expect(events).not.toContain(`end:${slowTable}`);
        expect(read).not.toHaveBeenCalled();
      } finally { release(); }
      await rejection;
      expect(events.at(-1)).toBe('authority');
    }
  );

  it.each([null, 1001, 2])('rejects incomplete submissions (%s), without returning partial cards', async (count) => {
    const read = vi.fn();
    await expect(service({}, undefined, { cleaning_submissions: count }, undefined, read)
      .list(admin, { serviceDate: '2026-09-20' })).rejects.toMatchObject({ code: 'ASSIGNMENT_QUERY_FAILED' });
    expect(read).not.toHaveBeenCalled();
  });

  it.each([1, 100, 1000])('keeps bounded calls, order and payload for %s complete cards', async (size) => {
    const rows = Array.from({ length: size }, (_, i) => ({ ...assignments[0], id: `assignment-${i}`, cleaning_target_id: `target-${i}`, sequence_number: i + 1 }));
    const targetRows = rows.map((row) => ({ ...targets[0], id: row.cleaning_target_id }));
    const attempts = rows.map((row, i) => ({ id: `attempt-${i}`, assignment_id: row.id, attempt_number: 1, status: 'in_progress' }));
    const submissions = attempts.map((row) => ({ cleaning_attempt_id: row.id, version: 1, status: 'submitted' }));
    const calls: string[] = [];
    const batches: number[] = [];
    const authorityBatches: number[] = [];
    const result = await service({ cleaning_assignments: rows, cleaning_targets: targetRows, cleaning_attempts: attempts,
      cleaning_submissions: submissions, cleaning_target_schedule_revisions: [] }, () => new Date('2026-09-19T00:00:00Z'), {},
      (ids) => batches.push(ids.length), (args) => {
        const ids = args.p_assignment_ids as string[];
        authorityBatches.push(ids.length);
        return { data: ids.map((assignmentId) => ({ assignmentId, scheduleSnapshot: null, currentDeparture: null })), error: null };
      }, async (table) => { calls.push(table); })
      .list(admin, { serviceDate: '2026-09-20' });
    expect(result).toHaveLength(size);
    expect(batches.every((size) => size <= 100)).toBe(true);
    // Assignment read + one profile read + four batched relation reads; final RPC is unchanged.
    // Tomorrow planning adds one bounded backlog query, not one query per card.
    expect(calls).toHaveLength(3 + 4 * Math.ceil(size / 100));
    expect(authorityBatches).toHaveLength(Math.ceil(size / 100));
    expect(authorityBatches.every((size) => size <= 100)).toBe(true);
    for (let i = 0; i < size; i++) {
      expect(result[i]).toEqual({ ...(result[0] as Row), assignmentId: `assignment-${i}`, cleaningTargetId: `target-${i}`, sequenceNumber: i + 1 });
      expect(result[i]).toMatchObject({ attemptStatus: 'in_progress', submissionStatus: 'submitted', scheduleSnapshot: null, currentDeparture: null });
    }
  });
});

describe('today current assignment backlog', () => {
  const midnight = () => new Date('2026-09-20T15:00:00Z');
  const oldRow = assignments[0] as Row;
  const todayRow = { ...assignments[1], service_date: '2026-09-21' } as Row;
  const currentTargets = targets.map((row, index) => ({ ...row, status: index === 1 ? 'approved' : 'submitted' }));

  it('includes past unfinished and today terminal rows without changing original dates or snapshots', async () => {
    const result = await service({ cleaning_assignments: [todayRow, oldRow], cleaning_targets: currentTargets }, midnight)
      .list(maid, { serviceDate: '2026-09-21' });
    expect(result.map((row) => (row as Row).serviceDate)).toEqual(['2026-09-20', '2026-09-21']);
    expect(result[0]).toMatchObject({ assignmentId: oldRow.id, sequenceNumber: 1, roomNumber: '통보-1' });
  });

  it.each(['approved', 'cancelled'])('excludes terminal past %s while retaining today cards', async (status) => {
    const result = await service({ cleaning_assignments: [todayRow, oldRow], cleaning_targets: currentTargets.map((row, index) => index === 0 ? { ...row, status } : row) }, midnight)
      .list(admin, { serviceDate: '2026-09-21' });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ assignmentId: todayRow.id });
  });

  it('expands admin tomorrow backlog but keeps history and maid tomorrow exact-date', async () => {
    const clock = vi.fn(midnight);
    const subject = service({ cleaning_assignments: [oldRow, todayRow], cleaning_targets: currentTargets }, clock);
    expect(await subject.list(admin, { serviceDate: '2026-09-22' })).toHaveLength(1);
    expect(await subject.list(admin, { serviceDate: '2026-09-21', includeHistory: true })).toHaveLength(1);
    expect(clock).toHaveBeenCalledTimes(2);
    expect(await service({ cleaning_assignments: [oldRow, todayRow], cleaning_targets: currentTargets }, () => new Date('2026-09-20T14:59:59.999Z'))
      .list(admin, { serviceDate: '2026-09-21' })).toHaveLength(2);
    expect(await subject.list(maid, { serviceDate: '2026-09-22' })).toEqual([]);
    expect(await subject.list(admin, { serviceDate: '2026-09-23' })).toEqual([]);
    expect(await service({ cleaning_assignments: [oldRow], cleaning_targets: currentTargets.map(row => ({ ...row, status: 'inspection_pending' })) }, midnight)
      .list(admin, { serviceDate: '2026-09-22' })).toEqual([]);
  });

  it('shows a past assignment on the maid notified planning day, not prematurely on today', async () => {
    const subject = service({ cleaning_assignments: [oldRow], cleaning_targets: currentTargets }, midnight, {}, undefined,
      args => ({ data: (args.p_assignment_ids as string[]).map(assignmentId => ({ assignmentId,
        scheduleSnapshot: null, currentDeparture: null, planningDate: '2026-09-22' })), error: null }));
    expect(await subject.list(maid, { serviceDate: '2026-09-21' })).toEqual([]);
    const tomorrow = await subject.list(maid, { serviceDate: '2026-09-22' });
    expect(tomorrow).toHaveLength(1);
    expect(tomorrow[0]).toMatchObject({ serviceDate: oldRow.service_date, planningDate: '2026-09-22' });
  });

  it.each([null, 1001, 2])('rejects unavailable, excessive or truncated counts (%s) without returning partial cards', async (count) => {
    await expect(service({ cleaning_assignments: [oldRow] }, midnight, { cleaning_assignments: count })
      .list(admin, { serviceDate: '2026-09-20' })).rejects.toMatchObject({ code: 'ASSIGNMENT_QUERY_FAILED' });
  });

  it.each(['approved', 'cancelled', 'inspection_pending', 'upload_pending', 'rejected'])('excludes past %s from admin tomorrow planning', async (status) => {
    expect(await service({ cleaning_assignments: [oldRow], cleaning_targets: currentTargets.map(row => ({ ...row, status })) }, midnight)
      .list(admin, { serviceDate: '2026-09-22' })).toEqual([]);
  });

  it('rejects truncated related histories rather than projecting a wrong attempt or rollover', async () => {
    await expect(service({}, midnight, { cleaning_attempts: 1001 }).list(admin, { serviceDate: '2026-09-20' }))
      .rejects.toMatchObject({ code: 'ASSIGNMENT_QUERY_FAILED' });
  });

  it('accepts exactly 1000 complete cards with bounded 100-ID hydration batches', async () => {
    const rows = Array.from({ length: 1000 }, (_, index) => ({ ...oldRow, id: `assignment-${index}`, cleaning_target_id: `target-${index}` }));
    const targetRows = rows.map((row) => ({ ...targets[0], id: row.cleaning_target_id, status: 'submitted' }));
    const batches: number[] = [];
    const result = await service({ cleaning_assignments: rows, cleaning_targets: targetRows, cleaning_attempts: [], cleaning_target_schedule_revisions: [] }, midnight, {}, (ids) => batches.push(ids.length))
      .list(admin, { serviceDate: '2026-09-21' });
    expect(result).toHaveLength(1000);
    expect(Math.max(...batches)).toBe(100);
    expect(batches.filter((size) => size === 100).length).toBeGreaterThanOrEqual(30);
  });

  it('rejects a combined currentday and past board above 1000 even when each DB read is complete', async () => {
    const rows = Array.from({ length: 1001 }, (_, index) => ({ ...oldRow, id: `assignment-${index}`, cleaning_target_id: `target-${index}`, service_date: index < 500 ? '2026-09-21' : '2026-09-20' }));
    const targetRows = rows.map((row) => ({ ...targets[0], id: row.cleaning_target_id, status: 'submitted' }));
    const hydration = vi.fn();
    await expect(service({ cleaning_assignments: rows, cleaning_targets: targetRows }, midnight, {}, hydration).list(admin, { serviceDate: '2026-09-21' }))
      .rejects.toMatchObject({ code: 'ASSIGNMENT_QUERY_FAILED' });
    expect(hydration).not.toHaveBeenCalled();
  });
});

describe('assignment card projection', () => {
  it('adds immutable provenance and preserves historical effective dates instead of future target dates', async () => {
    const current = await service().list(admin, { serviceDate: '2026-09-20' });
    expect(current[1]).toMatchObject({ sourceKind: 'stayover_request', canCancel: true, cancelReasonCode: null,
      roomTypeSnapshot: { code: 'TYPE-2', name: '객실 유형 2', elevatorZone: null }, effectiveServiceDate: '2026-09-20' });
    const past = await service().history(admin, targetIds[3] as string);
    expect(past[0]).toMatchObject({ sourceKind: 'inspection_reclean', effectiveServiceDate: '2026-09-21',
      rolloverCount: 1, canCancel: false, cancelReasonCode: 'ASSIGNMENT_NOT_CURRENT' });
    const maidRows = await service().list(maid, { serviceDate: '2026-09-20' });
    expect(maidRows.every((row) => (row as Row).canCancel === false && (row as Row).cancelReasonCode === 'ADMIN_REQUIRED')).toBe(true);
  });

  it('allows stale current drafts and scheduled attempts without PIN or due-date conditions', async () => {
    const row = { ...assignments[2], revision: 1, service_date: '2026-09-20' } as Row;
    const target = { ...targets[2], status: 'draft_assigned', assignment_version: 9,
      effective_service_date: '2026-09-23', fee_snapshot: 0, room_type_snapshot: {} } as Row;
    const result = await service({ cleaning_assignments: [row], cleaning_targets: [target],
      cleaning_attempts: [{ id: 'scheduled', assignment_id: row.id, attempt_number: 3, status: 'scheduled', started_at: null },
        { id: 'old', assignment_id: row.id, attempt_number: 1, status: 'superseded', started_at: '2026-09-19T01:00:00Z' }] }).history(admin, targetIds[2] as string);
    expect(result[0]).toMatchObject({ canCancel: true, cancelReasonCode: null, targetAssignmentVersion: 9,
      effectiveServiceDate: '2026-09-20', feeSnapshot: 0, roomTypeSnapshot: { code: null, name: null, elevatorZone: null } });
  });

  it.each([
    ['scheduled', '2026-09-20T02:00:00Z', 'CLEANING_REQUEST_CANCEL_CONFLICT'],
    ['in_progress', null, 'CLEANING_REQUEST_CANCEL_CONFLICT'],
    ['field_completed', null, 'CLEANING_REQUEST_CANCEL_CONFLICT'],
    ['scheduled', undefined, 'CAPABILITY_UNAVAILABLE'],
  ])('uses all relevant attempts rather than the newest display row: %s/%s', async (status, startedAt, reason) => {
    const row = assignments[2] as Row;
    const result = await service({ cleaning_assignments: [row], cleaning_targets: [targets[2] as Row],
      cleaning_attempts: [{ id: 'latest', assignment_id: row.id, attempt_number: 3, status: 'scheduled', started_at: null },
        { id: 'earlier', assignment_id: row.id, attempt_number: 2, status, ...(startedAt === undefined ? {} : { started_at: startedAt }) }] }).history(admin, targetIds[2] as string);
    expect(result[0]).toMatchObject({ attemptStatus: 'scheduled', canCancel: false, cancelReasonCode: reason });
  });

  it.each(['approved', 'cancelled', 'submitted', 'in_progress'])('denies terminal or started target state %s', async (status) => {
    const result = await service({ cleaning_assignments: [assignments[2] as Row], cleaning_targets: [{ ...targets[2], status }] })
      .history(admin, targetIds[2] as string);
    expect(result[0]).toMatchObject({ canCancel: false, cancelReasonCode: 'CLEANING_REQUEST_CANCEL_CONFLICT' });
  });

  it('keeps missing legacy source unknown without inferring it from cleaning kind', async () => {
    const legacy = { ...targets[2] } as Row;
    delete legacy.source;
    const result = await service({ cleaning_assignments: [assignments[2] as Row], cleaning_targets: [legacy] })
      .history(admin, targetIds[2] as string);
    expect(result[0]).toMatchObject({ sourceKind: null, canCancel: false, cancelReasonCode: 'CAPABILITY_UNAVAILABLE' });
  });

  it.each([
    {}, { code: '', name: '', elevatorZone: '' },
    { code: 1234, name: false, elevatorZone: ['A'] },
    { code: null, name: {}, elevatorZone: null }
  ])('normalizes raw stored snapshot optional attributes like the SQL projection: %j', async (roomType) => {
    // Stored historical optional values are normalized by SQL too. This does
    // not weaken the separate fresh canonical metadata corruption gate.
    const result = await service({ cleaning_targets: [{ ...targets[2], room_type_snapshot: roomType }] })
      .history(admin, targetIds[2] as string);
    expect(result[0]).toMatchObject({ roomTypeCode: null, roomTypeName: null, elevatorZone: null,
      roomTypeSnapshot: { code: null, name: null, elevatorZone: null }, feeSnapshot: 12000 });
  });

  it.each([101, 1001])('preserves a historical snapshot name of %i characters without inventing a display limit', async (length) => {
    // Baseline card text and the stored TEXT/OpenAPI contract have no length
    // cap. Keep fresh canonical corruption checks separate from valid length.
    const name = 'n'.repeat(length);
    const result = await service({ cleaning_targets: [{ ...targets[2], room_type_snapshot: { code: 'a'.repeat(101), name, elevatorZone: 'A' } }] })
      .history(admin, targetIds[2] as string);
    expect(result[0]).toMatchObject({ roomTypeCode: 'a'.repeat(101), roomTypeName: name,
      roomTypeSnapshot: { code: 'a'.repeat(101), name, elevatorZone: 'A' } });
  });

  it('projects every cleaning kind and immutable card snapshots for admin', async () => {
    const result = await service().list(admin, {
      serviceDate: '2026-09-20',
      includeHistory: true
    });

    expect(result).toHaveLength(3);
    expect(result.map((row) => (row as Row).cleaningKind)).toEqual([
      'checkout',
      'stayover',
      'additional'
    ]);
    expect(result[0]).toMatchObject({
      roomNumber: '현재-1',
      roomTypeCode: 'TYPE-1',
      roomTypeName: '객실 유형 1',
      elevatorZone: 'A',
      feeSnapshot: 10000,
      durationMinutes: null,
      originalServiceDate: '2026-09-20',
      rolloverCount: 0,
      rolloverReason: null,
      targetStatus: 'unassigned',
      attemptStatus: 'in_progress',
      submissionStatus: 'submitted'
    });
    expect(result[1]).toMatchObject({ durationMinutes: 31, attemptStatus: null, submissionStatus: null });
  });

  it('keeps a historical maid card on its notified room and assignment revision', async () => {
    const result = await service().history(maid, '20000000-0000-4000-8000-000000000004');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      cleaningKind: 'reclean',
      roomId: '60000000-0000-4000-8000-000000000004',
      roomNumber: '통보-4',
      targetAssignmentVersion: 2,
      originalServiceDate: '2026-09-20',
      rolloverCount: 1,
      rolloverReason: 'ROLLED_OVER_NOT_STARTED',
      targetStatus: null
    });
    expect(result[0]).not.toMatchObject({ roomNumber: '현재-4', targetAssignmentVersion: 3 });
  });

  it('does not infer rollover from reservation schedule dates moving backward or forward', async () => {
    for (const serviceDate of ['2026-09-19', '2026-09-22']) {
      const row = {
        ...(assignments[0] ?? {}),
        service_date: serviceDate,
        revision: 4
      } as Row;
      const target = {
        ...(targets[0] ?? {}),
        effective_service_date: serviceDate,
        carryover_count: 2,
        assignment_version: 6
      } as Row;
      const result = await service({
        cleaning_assignments: [row],
        cleaning_targets: [target],
        cleaning_target_schedule_revisions: [{
          cleaning_target_id: targetIds[0],
          revision: 4,
          effective_service_date: serviceDate,
          reason_code: 'RESERVATION_CHANGED'
        }, {
          cleaning_target_id: targetIds[0],
          revision: 5,
          effective_service_date: '2026-09-23',
          reason_code: 'ROLLED_OVER_NOT_STARTED'
        }, {
          cleaning_target_id: targetIds[0],
          revision: 6,
          effective_service_date: '2026-09-24',
          reason_code: 'ROLLED_OVER_UNASSIGNED'
        }]
      }).history(admin, '20000000-0000-4000-8000-000000000001');

      expect(result[0]).toMatchObject({
        serviceDate,
        originalServiceDate: '2026-09-20',
        rolloverCount: 0,
        rolloverReason: null
      });
    }
  });

  it('keeps developer and cross-maid reads denied', async () => {
    await expect(service().list({ ...admin, role: 'developer' }, { serviceDate: '2026-09-20' }))
      .rejects.toMatchObject({ statusCode: 403, code: 'ASSIGNMENT_ACCESS_REQUIRED' });
    await expect(service().list(maid, { serviceDate: '2026-09-20', maidProfileId: otherMaidId }))
      .rejects.toMatchObject({ statusCode: 403, code: 'ASSIGNMENT_ACCESS_REQUIRED' });
  });
});

describe('assignment schedule reads', () => {
  it('requests current actual facts only for current list, never target history or includeHistory', async () => {
    const modes: unknown[] = [];
    const currentDeparture = { evaluatedAt: '2026-10-02T03:00:00Z', actualCheckoutAt: '2026-10-02T02:00:00Z', actualRoomDepartureAt: null };
    const read = (args: Record<string, unknown>) => {
      expect(args.p_actor_profile_id).toBe(maid.profileId);
      expect(args.p_expected_actor_role).toBe('maid');
      expect(args.p_assignment_ids).toEqual([assignmentIds[0]]);
      modes.push(args.p_include_current);
      return { data: [{ assignmentId: assignmentIds[0], scheduleSnapshot: frozenSchedule,
        currentDeparture: args.p_include_current ? currentDeparture : null }], error: null };
    };
    const subject = service({ cleaning_assignments: [assignments[0] as Row] }, undefined, {}, undefined, read);
    const current = await subject.list(maid, { serviceDate: '2026-09-20' });
    expect(current[0]).toMatchObject({ scheduleSnapshot: frozenSchedule, currentDeparture });
    for (const result of [await subject.history(maid, targetIds[0] as string),
      await subject.list(maid, { serviceDate: '2026-09-20', includeHistory: true })]) {
      expect(result[0]).toMatchObject({ scheduleSnapshot: frozenSchedule, currentDeparture: null });
    }
    expect(modes).toEqual([true, false, false]);
  });
  it.each(['ASSIGNMENT_ACCESS_REQUIRED', 'SESSION_REVOKED', 'PASSWORD_CHANGE_REQUIRED', 'unsafe SQL secret'])
  ('does not publish partial cards after latest DB authorization failure: %s', async (message) => {
    await expect(service({}, undefined, {}, undefined, () => ({ data: null, error: { message } }))
      .history(maid, targetIds[0] as string)).rejects.toMatchObject({
        code: message === 'unsafe SQL secret' ? 'ASSIGNMENT_QUERY_FAILED' : message
      });
  });
  it.each([[], [{ assignmentId: assignmentIds[1], scheduleSnapshot: null, currentDeparture: null }],
    [{ assignmentId: assignmentIds[0], scheduleSnapshot: { ...frozenSchedule, guestName: 'private' }, currentDeparture: null }]].map((data) => [data]))
  ('fails safely on truncated/cross-ID/private metadata RPC: %j', async (data) => {
    await expect(service({}, undefined, {}, undefined, () => ({ data, error: null }))
      .history(maid, targetIds[0] as string)).rejects.toMatchObject({ code: 'ASSIGNMENT_QUERY_FAILED' });
  });
  it('denies invalid bearer session claims and password-incomplete actor', async () => {
    await expect(service().history({ ...maid, accessToken: 'bad-token' }, targetIds[0] as string))
      .rejects.toMatchObject({ code: 'INVALID_ACCESS_TOKEN' });
    await expect(service().history({ ...maid, mustChangePassword: true }, targetIds[0] as string))
      .rejects.toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED' });
  });
  it.each([['admin', 'maid'], ['maid', 'admin']] as const)
  ('rejects the entire history when role changes from %s to %s during hydration', async (initialRole, latestRole) => {
    const original = { ...maid, role: initialRole };
    await expect(service({}, undefined, {}, undefined, (args) => {
      expect(args.p_expected_actor_role).toBe(initialRole);
      expect(args.p_expected_actor_role).not.toBe(latestRole);
      return { data: null, error: { message: 'ASSIGNMENT_ACCESS_REQUIRED' } };
    }).history(original, targetIds[0] as string)).rejects.toMatchObject({
      statusCode: 403, code: 'ASSIGNMENT_ACCESS_REQUIRED'
    });
  });
});

describe('assignment card Fastify routes', () => {
  it('returns no-store list/history envelopes and rejects query aliases', async () => {
    const assignmentService: AssignmentService = {
      list: vi.fn(async () => [{ assignmentId: assignmentIds[0], cleaningKind: 'checkout' }]),
      history: vi.fn(async () => [{ assignmentId: assignmentIds[0], cleaningKind: 'checkout' }])
    };
    const app = Fastify();
    app.decorateRequest('actor');
    app.decorate('authenticate', async (request) => { request.actor = admin; });
    app.decorate('requirePasswordChanged', async () => {});
    app.setErrorHandler((error, _request, reply) => reply
      .code(error instanceof AppError ? error.statusCode : 400)
      .send({ error: { code: error instanceof AppError ? error.code : 'VALIDATION_ERROR' } }));
    await app.register(createAssignmentRoutes(assignmentService), { prefix: '/v1/assignments' });

    const listed = await app.inject({ method: 'GET', url: '/v1/assignments?serviceDate=2026-09-20' });
    const history = await app.inject({ method: 'GET', url: `/v1/assignments/${targetIds[0]}/history` });
    const alias = await app.inject({ method: 'GET', url: '/v1/assignments?service_date=2026-09-20' });

    expect(listed.statusCode).toBe(200);
    expect(listed.headers['cache-control']).toBe('no-store');
    expect(listed.json()).toEqual({ assignments: [{ assignmentId: assignmentIds[0], cleaningKind: 'checkout' }] });
    expect(history.statusCode).toBe(200);
    expect(history.headers['cache-control']).toBe('no-store');
    expect(alias.statusCode).toBe(400);
    expect(assignmentService.list).toHaveBeenCalledOnce();
    expect(assignmentService.history).toHaveBeenCalledOnce();
    await app.close();
  });
});
