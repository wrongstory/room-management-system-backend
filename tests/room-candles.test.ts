import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '../src/domain/actor.js';
import type { SupabaseClients } from '../src/lib/supabase.js';
import { SupabaseRoomService } from '../src/modules/rooms/room.service.js';
import { openApiDocument } from '../supabase/functions/_shared/openapi.js';

const id = '33000000-0000-4000-8000-000000000001';
const session = '33000000-0000-4000-8000-000000000002';
const actor: Actor = { profileId: id, authUserId: id, displayName: '합성 메이드', role: 'maid', mustChangePassword: false,
  accessToken: `e30.${Buffer.from(JSON.stringify({ session_id: session })).toString('base64url')}.signature` };
const item = { roomId: id, roomNumber: '350', count: 2, roomStateVersion: 8 };
const input = { roomId: id, action: 'set_candle_count' as const, expectedRoomVersion: 8, reasonCode: 'CANDLE_COLLECTED', payload: { count: 0, physicallyVerified: true }, idempotencyKey: 'candle-test-1' };
function fixture(data: unknown, message?: string) {
  const rpc = vi.fn(async () => ({ data, error: message ? { message } : null }));
  return { rpc, service: new SupabaseRoomService({ admin: { rpc } } as unknown as SupabaseClients) };
}
describe('shared room candle capability', () => {
  it('returns only minimal fields for an unrelated maid and binds the verified session', async () => {
    const { service, rpc } = fixture({ items: [{ ...item, pin: 'not-returned', guestName: 'not-returned' }], nextCursor: null });
    expect(await service.listCandles(actor, { roomId: id })).toEqual({ items: [item], nextCursor: null });
    expect(rpc).toHaveBeenCalledWith('list_room_candles', expect.objectContaining({ p_actor_profile_id: id, p_session_id: session, p_room_id: id, p_limit: 50 }));
  });
  it.each(['admin', 'maid'] as const)('uses only dedicated command for %s and keeps the retry hash stable', async (role) => {
    const { service, rpc } = fixture({ entity_id: id, room_id: id, room_state_version: 9, recorded_at: '2026-09-30T00:00:00Z' });
    await service.mutateOperation({ ...actor, role }, input);
    await service.mutateOperation({ ...actor, role }, input);
    const calls = vi.mocked(rpc).mock.calls as unknown as Array<[string, Record<string, unknown>]>;
    expect(calls[0]?.[0]).toBe('set_room_candle_count');
    expect(calls[0]?.[1]).toMatchObject({ p_session_id: session, p_payload: input.payload });
    expect(calls[0]?.[1]).not.toHaveProperty('p_action');
    expect(calls[0]?.[1].p_request_hash).toBe(calls[1]?.[1].p_request_hash);
  });
  it('does not give developer candle access or maid unrelated command access', async () => {
    const { service, rpc } = fixture(null);
    await expect(service.listCandles({ ...actor, role: 'developer' }, {})).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.mutateOperation(actor, { ...input, action: 'create_block' })).rejects.toMatchObject({ statusCode: 403 });
    expect(rpc).not.toHaveBeenCalled();
  });
  it.each([
    ['SESSION_REVOKED', 401], ['CANDLE_ACCESS_REQUIRED', 403], ['PASSWORD_CHANGE_REQUIRED', 403],
    ['CANDLE_VERIFICATION_REQUIRED', 400], ['INVALID_CANDLE_REQUEST', 400], ['STALE_VERSION', 409], ['IDEMPOTENCY_KEY_REUSED', 409]
  ])('maps %s without exposing raw DB text', async (code, statusCode) => {
    const { service } = fixture(null, `${code}: private-detail`);
    await expect(service.mutateOperation(actor, input)).rejects.toMatchObject({ statusCode });
    await expect(service.mutateOperation(actor, input)).rejects.not.toHaveProperty('message', `${code}: private-detail`);
  });
  it.each([
    { items: [{ ...item, count: -1 }], nextCursor: null },
    { items: [{ ...item, roomStateVersion: 0 }], nextCursor: null },
    { items: [item], nextCursor: id },
    { items: [{ ...item, roomId: session }], nextCursor: null }
  ])('rejects malformed or wrong-room projections', async (page) => {
    await expect(fixture(page).service.listCandles(actor, { roomId: id })).rejects.toMatchObject({ statusCode: 500 });
  });
  it('documents the narrow exception without changing general room permissions', () => {
    const paths = openApiDocument.paths as Record<string, Record<string, Record<string, unknown>>>;
    expect(paths['/v1/rooms/candles']?.get?.['x-required-roles']).toEqual(['admin', 'maid']);
    expect(paths['/v1/rooms/{roomId}/candles']?.post?.['x-required-roles']).toEqual(['admin', 'maid']);
    expect(paths['/v1/rooms/{roomId}/candles']?.post?.description).not.toContain('admin만');
    expect(paths['/v1/rooms/{roomId}']?.get?.['x-required-roles']).toEqual(['admin']);
  });
});
