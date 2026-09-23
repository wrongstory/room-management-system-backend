import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '../src/domain/actor.js';
import { AppError } from '../src/lib/app-error.js';
import { createAssignmentRoutes } from '../src/modules/assignments/assignment.routes.js';
import {
  type AssignmentService,
  SupabaseAssignmentService
} from '../src/modules/assignments/assignment.service.js';

const maidId = '10000000-0000-4000-8000-000000000001';
const otherMaidId = '10000000-0000-4000-8000-000000000002';
const targetIds = [1, 2, 3, 4].map((value) => `20000000-0000-4000-8000-00000000000${value}`);
const assignmentIds = [1, 2, 3, 4].map((value) => `30000000-0000-4000-8000-00000000000${value}`);

const admin: Actor = {
  authUserId: '40000000-0000-4000-8000-000000000001',
  profileId: '50000000-0000-4000-8000-000000000001',
  displayName: '관리자',
  role: 'admin',
  mustChangePassword: false,
  accessToken: 'admin-token'
};
const maid: Actor = {
  authUserId: '40000000-0000-4000-8000-000000000002',
  profileId: maidId,
  displayName: '메이드',
  role: 'maid',
  mustChangePassword: false,
  accessToken: 'maid-token'
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

function query(initialRows: Row[]) {
  let rows = [...initialRows];
  const builder = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      rows = rows.filter((row) => row[column] === value);
      return builder;
    },
    not: (column: string, operator: string) => {
      if (operator === 'is') rows = rows.filter((row) => row[column] !== null);
      return builder;
    },
    in: (column: string, values: unknown[]) => {
      rows = rows.filter((row) => values.includes(row[column]));
      return builder;
    },
    order: () => builder,
    // biome-ignore lint/suspicious/noThenProperty: Supabase query builders are intentionally awaitable.
    then: (resolve: (value: { data: Row[]; error: null }) => unknown) =>
      Promise.resolve({ data: rows, error: null }).then(resolve)
  };
  return builder;
}

function service(overrides: Partial<Record<string, Row[]>> = {}) {
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
  const from = (table: string) => query(tables[table] ?? []);
  return new SupabaseAssignmentService({
    admin: { from },
    publicClient: {},
    forAccessToken: () => ({ from })
  } as never);
}

describe('assignment card projection', () => {
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
