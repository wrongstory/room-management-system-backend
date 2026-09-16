import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '../src/domain/actor.js';
import type { SupabaseClients } from '../src/lib/supabase.js';
import { SupabaseRoomService } from '../src/modules/rooms/room.service.js';
import { openApiDocument } from '../supabase/functions/_shared/openapi.js';

const adminActor: Actor = {
  authUserId: '10000000-0000-4000-8000-000000000001',
  profileId: '20000000-0000-4000-8000-000000000001',
  displayName: '운영 관리자',
  role: 'admin',
  mustChangePassword: false,
  accessToken: 'access-token'
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
  occupied: false,
  cleaning_required: false,
  candle_count: 0,
  pin_sync_status: 'verified',
  allocation_blocked: false,
  allocation_ready: true,
  reason_codes: []
};

describe('current room status public contract', () => {
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
        occupied: false,
        cleaningRequired: false,
        allocationReady: true
      })
    ]);
  });

  it('publishes the timestamp and closed reservation phase vocabulary in OpenAPI', () => {
    const schema = openApiDocument.components.schemas.RoomProjection;

    expect(schema.required).toEqual(expect.arrayContaining(['evaluatedAt', 'reservationPhase']));
    expect(schema.properties.evaluatedAt).toMatchObject({
      type: 'string',
      format: 'date-time'
    });
    expect(schema.properties.reservationPhase).toMatchObject({
      type: 'string',
      enum: ['none', 'upcoming', 'current']
    });
    expect(openApiDocument.components.schemas.RoomReasonCode.enum).toContain(
      'RESERVATION_CURRENT'
    );
    expect(Object.keys(openApiDocument.paths)).toHaveLength(109);
  });
});
