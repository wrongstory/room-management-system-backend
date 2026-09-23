import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '../src/domain/actor.js';
import { AppError } from '../src/lib/app-error.js';
import type { SupabaseClients } from '../src/lib/supabase.js';
import {
  RoomOperationCursorCodec,
  roomOperationCursorScope
} from '../src/modules/rooms/room-operation-cursor.js';
import { SupabaseRoomService } from '../src/modules/rooms/room.service.js';

const actor = {
  profileId: '20000000-0000-4000-8000-000000000001',
  role: 'admin' as const
};
const roomId = '30000000-0000-4000-8000-000000000001';
const after = {
  occurredAt: '2026-09-20T00:00:00.000Z',
  id: '50000000-0000-4000-8000-000000000001'
};
const sessionId = '70000000-0000-4000-8000-000000000001';
const adminActor: Actor = {
  authUserId: '10000000-0000-4000-8000-000000000001',
  profileId: actor.profileId,
  displayName: '운영 관리자',
  role: 'admin',
  mustChangePassword: false,
  accessToken: `e30.${Buffer.from(JSON.stringify({ session_id: sessionId })).toString('base64url')}.signature`
};

function code(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
  return undefined;
}

describe('room operation cursor', () => {
  it('round-trips only in the exact actor, room and stream scope', () => {
    const codec = new RoomOperationCursorCodec('room-operation-cursor-test-secret-123456789');
    const scope = roomOperationCursorScope(actor, roomId, 'operation-blocks');
    const cursor = codec.encode(scope, after);
    expect(codec.decode(cursor, scope)).toEqual(after);
    expect(code(() => codec.decode(
      cursor,
      roomOperationCursorScope(actor, roomId, 'issues')
    ))).toBe('INVALID_ROOM_OPERATION_CURSOR');
    expect(code(() => codec.decode(
      cursor,
      roomOperationCursorScope(actor, '30000000-0000-4000-8000-000000000002', 'operation-blocks')
    ))).toBe('INVALID_ROOM_OPERATION_CURSOR');
    expect(code(() => codec.decode(`${cursor.slice(0, -1)}x`, scope)))
      .toBe('INVALID_ROOM_OPERATION_CURSOR');
  });

  it('fails closed when the signing key is absent or too short', () => {
    expect(code(() => new RoomOperationCursorCodec('short')))
      .toBe('ROOM_OPERATION_CURSOR_NOT_CONFIGURED');
  });

  it('maps a bounded DB page, signs continuation and forwards the decoded keyset', async () => {
    const rpc = vi.fn(async () => ({
      error: null,
      data: {
        roomId,
        roomStateVersion: 4,
        evaluatedAt: '2026-09-20T01:00:00.000Z',
        items: [{
          id: after.id,
          reasonCode: 'MAINTENANCE',
          startsAt: after.occurredAt,
          endsAt: null,
          status: 'active',
          createdAt: '2026-09-19T00:00:00.000Z',
          raw_pin: 'must-not-leak'
        }],
        hasMore: true,
        nextCursor: after,
        raw_state: 'must-not-leak'
      }
    }));
    const clients = {
      admin: { rpc },
      publicClient: {},
      forAccessToken: vi.fn()
    } as unknown as SupabaseClients;
    const service = new SupabaseRoomService(
      clients,
      undefined,
      'room-operation-cursor-test-secret-123456789'
    );
    const first = await service.listOperationBlocks(adminActor, roomId, { limit: 1 });
    expect(first).toMatchObject({ hasMore: true, items: [{ id: after.id }] });
    expect(first).not.toHaveProperty('raw_state');
    expect(first.items[0]).not.toHaveProperty('raw_pin');
    expect(typeof first.nextCursor).toBe('string');
    await service.listOperationBlocks(adminActor, roomId, {
      limit: 1,
      cursor: first.nextCursor ?? undefined
    });
    expect(rpc).toHaveBeenLastCalledWith('list_room_operation_blocks_page', expect.objectContaining({
      p_actor_profile_id: adminActor.profileId,
      p_session_id: sessionId,
      p_limit: 1,
      p_cursor_at: after.occurredAt,
      p_cursor_id: after.id
    }));
  });

  it('fails closed when the DB page crosses the requested room or page boundary', async () => {
    const data: {
      roomId: string;
      roomStateVersion: number;
      evaluatedAt: string;
      items: unknown[];
      hasMore: boolean;
      nextCursor: null;
    } = {
      roomId: '30000000-0000-4000-8000-000000000002',
      roomStateVersion: 4,
      evaluatedAt: '2026-09-20T01:00:00.000Z',
      items: [],
      hasMore: false,
      nextCursor: null
    };
    const rpc = vi.fn(async () => ({ error: null, data }));
    const clients = {
      admin: { rpc },
      publicClient: {},
      forAccessToken: vi.fn()
    } as unknown as SupabaseClients;
    const service = new SupabaseRoomService(
      clients,
      undefined,
      'room-operation-cursor-test-secret-123456789'
    );
    await expect(service.listOperationBlocks(adminActor, roomId, { limit: 1 }))
      .rejects.toMatchObject({ code: 'ROOM_PROJECTION_INVALID' });

    data.roomId = roomId;
    data.items = [{}, {}];
    await expect(service.listOperationBlocks(adminActor, roomId, { limit: 1 }))
      .rejects.toMatchObject({ code: 'ROOM_PROJECTION_INVALID' });
  });
});
