import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '../src/domain/actor.js';
import type { SupabaseClients } from '../src/lib/supabase.js';
import { SupabaseRoomService } from '../src/modules/rooms/room.service.js';
import { openApiDocument } from '../supabase/functions/_shared/openapi.js';

const adminSessionId = '50000000-0000-4000-8000-000000000000';
const adminActor: Actor = {
  authUserId: '10000000-0000-4000-8000-000000000001',
  profileId: '20000000-0000-4000-8000-000000000001',
  displayName: '운영 관리자',
  role: 'admin',
  mustChangePassword: false,
  accessToken: `e30.${Buffer.from(JSON.stringify({ session_id: adminSessionId })).toString('base64url')}.signature`
};

const maidSessionId = '50000000-0000-4000-8000-000000000001';
const maidActor: Actor = {
  authUserId: '10000000-0000-4000-8000-000000000002',
  profileId: '20000000-0000-4000-8000-000000000002',
  displayName: '담당 메이드',
  role: 'maid',
  mustChangePassword: false,
  accessToken: `e30.${Buffer.from(JSON.stringify({ session_id: maidSessionId })).toString('base64url')}.signature`
};

const roomRow = {
  id: '30000000-0000-4000-8000-000000000001',
  room_number: '101',
  room_type_code: 'standard',
  room_type_name: '스탠다드 더블 로프트',
  elevator_zone: 'A',
  data_status: 'verified',
  state_version: 3,
  evaluated_at: '2026-09-16T08:00:00.000Z',
  reservation_phase: 'upcoming',
  server_time: '2026-09-16T08:00:00.000Z',
  occupancy_status: 'VACANT',
  reservation_lifecycle: 'FUTURE',
  readiness_status: 'READY',
  primary_display_status: 'READY',
  canonical_primary_display_status: 'READY',
  display_status_override: null,
  next_reservation_id: '40000000-0000-4000-8000-000000000001',
  next_check_in_at: '2026-09-18T07:00:00.000Z',
  next_check_out_at: '2026-09-19T02:00:00.000Z',
  blocking_reason_codes: [],
  readiness_reason_codes: [],
  occupied: false,
  cleaning_required: false,
  candle_count: 0,
  pin_sync_status: 'verified',
  allocation_blocked: false,
  allocation_ready: true,
  reason_codes: []
};

describe('current room status public contract', () => {
  it('maps a missing durable PIN entitlement to the stable Fastify contract', async () => {
    const rpc = vi.fn(async () => ({
      data: null,
      error: { message: 'PIN_ENTITLEMENT_REQUIRED' }
    }));
    const clients = {
      admin: { rpc },
      publicClient: {},
      forAccessToken: vi.fn()
    } as unknown as SupabaseClients;
    const service = new SupabaseRoomService(clients);

    await expect(service.revealPin(maidActor, {
      roomId: roomRow.id,
      assignmentId: '60000000-0000-4000-8000-000000000001'
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'PIN_ENTITLEMENT_REQUIRED'
    });
    expect(rpc).toHaveBeenCalledWith('begin_room_pin_reveal', expect.objectContaining({
      p_actor_profile_id: maidActor.profileId,
      p_session_id: maidSessionId,
      p_assignment_id: '60000000-0000-4000-8000-000000000001'
    }));
  });

  it('maps the authoritative evaluation instant and reservation phase in Fastify', async () => {
    const rpc = vi.fn(async () => ({ data: [roomRow], error: null }));
    const clients = {
      admin: { rpc },
      publicClient: {},
      forAccessToken: vi.fn()
    } as unknown as SupabaseClients;
    const service = new SupabaseRoomService(clients);

    await expect(service.list(adminActor)).resolves.toEqual([
      expect.objectContaining({
        evaluatedAt: '2026-09-16T08:00:00.000Z',
        reservationPhase: 'upcoming',
        serverTime: '2026-09-16T08:00:00.000Z',
        occupancyStatus: 'VACANT',
        reservationLifecycle: 'FUTURE',
        readinessStatus: 'READY',
        primaryDisplayStatus: 'READY',
        canonicalPrimaryDisplayStatus: 'READY',
        displayStatusOverride: null,
        nextReservationId: '40000000-0000-4000-8000-000000000001',
        occupied: false,
        cleaningRequired: false,
        allocationReady: true
      })
    ]);
  });

  it('publishes compatible and independent current room axes in OpenAPI', () => {
    const schema = openApiDocument.components.schemas.RoomProjection;

    expect(schema.required).toEqual(expect.arrayContaining([
      'evaluatedAt',
      'reservationPhase',
      'serverTime',
      'occupancyStatus',
      'reservationLifecycle',
      'readinessStatus',
      'primaryDisplayStatus',
      'canonicalPrimaryDisplayStatus',
      'displayStatusOverride',
      'nextReservationId',
      'blockingReasonCodes',
      'readinessReasonCodes'
    ]));
    expect(schema.properties.evaluatedAt).toMatchObject({
      type: 'string',
      format: 'date-time'
    });
    expect(schema.properties.reservationPhase).toMatchObject({
      type: 'string',
      enum: ['none', 'upcoming', 'current']
    });
    expect(openApiDocument.components.schemas.RoomReservationLifecycle.enum).toEqual([
      'NONE',
      'FUTURE',
      'RESERVATION_PRESENT',
      'ARRIVAL_PENDING',
      'OCCUPIED'
    ]);
    expect(openApiDocument.components.schemas.RoomPrimaryDisplayStatus.enum).toEqual([
      'BLOCKED',
      'OCCUPIED',
      'ARRIVAL_PENDING',
      'RESERVATION_PRESENT',
      'CLEANING_REQUIRED',
      'READY'
    ]);
    expect(schema.properties.serverTime.description).toContain('evaluatedAt');
    expect(openApiDocument.components.schemas.RoomReadinessReasonCode.enum).toEqual(
      expect.arrayContaining(['CLEANING_REQUIRED', 'PIN_MISMATCH', 'PIN_UNCONFIGURED'])
    );
    expect(openApiDocument.components.schemas.RoomReasonCode.enum).toContain(
      'RESERVATION_CURRENT'
    );
    expect(Object.keys(openApiDocument.paths)).toHaveLength(128);
  });

  it('publishes an admin-only append-only occupancy correction contract', () => {
    const operation = openApiDocument.paths['/v1/rooms/{roomId}/occupancy-corrections'].post;
    expect(operation).toMatchObject({
      operationId: 'correctRoomOccupancy',
      'x-required-roles': ['admin']
    });
    expect(openApiDocument.components.schemas.RoomOccupancyCorrectionRequest.required)
      .toEqual(expect.arrayContaining([
        'reservationId', 'occupied', 'effectiveAt', 'expectedRoomVersion', 'reasonCode'
      ]));
  });

  it('publishes a display-only override without weakening canonical room axes', () => {
    const operation = openApiDocument.paths['/v1/rooms/{roomId}/display-status-overrides'].post;
    expect(operation).toMatchObject({
      operationId: 'overrideRoomDisplayStatus',
      'x-required-roles': ['admin']
    });
    expect(operation.description).toContain('bookability');
    expect(operation.description).toContain('operation-block');
    expect(openApiDocument.components.schemas.RoomDisplayStatusOverrideRequest.required)
      .toEqual(['targetStatus', 'expectedRoomVersion', 'reasonCode']);
  });

  it.each([
    ['RESERVATION_NOT_FOUND', 404],
    ['STAY_SEGMENT_CONTRACT_MISMATCH', 409],
    ['OCCUPANCY_CORRECTION_ROOM_MISMATCH', 409],
    ['ROOM_OCCUPANCY_CONFLICT', 409]
  ] as const)('maps %s to a stable Fastify response', async (databaseCode, statusCode) => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: databaseCode } }));
    const clients = {
      admin: { rpc },
      publicClient: {},
      forAccessToken: vi.fn()
    } as unknown as SupabaseClients;
    const service = new SupabaseRoomService(clients);

    await expect(service.correctOccupancy(adminActor, {
      roomId: roomRow.id,
      reservationId: '40000000-0000-4000-8000-000000000001',
      occupied: true,
      effectiveAt: '2026-09-20T00:00:00.000Z',
      expectedRoomVersion: 3,
      reasonCode: 'FRONT_DESK_VERIFIED',
      idempotencyKey: `room-status-${databaseCode.toLowerCase()}`
    })).rejects.toMatchObject({ statusCode, code: databaseCode });
    expect(rpc).toHaveBeenCalledWith('correct_room_occupancy', expect.objectContaining({
      p_session_id: adminSessionId
    }));
  });
});
