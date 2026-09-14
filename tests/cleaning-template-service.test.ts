import { describe, expect, it } from 'vitest';
import type { Actor } from '../src/domain/actor.js';
import type { SupabaseClients } from '../src/lib/supabase.js';
import { SupabaseCleaningTemplateService } from '../src/modules/cleaning-templates/cleaning-template.service.js';

const sessionId = '51000000-0000-4000-8000-000000000001';
const token = `e30.${Buffer.from(JSON.stringify({ session_id: sessionId })).toString('base64url')}.signature`;
const actor: Actor = {
  authUserId: '10000000-0000-4000-8000-000000000001',
  profileId: '20000000-0000-4000-8000-000000000001',
  displayName: '관리자',
  role: 'admin',
  mustChangePassword: false,
  accessToken: token
};
function slots() {
  return Array.from({ length: 10 }, (_, displayOrder) => ({
    slotKey: displayOrder === 0 ? 'tv-on' : `slot-${displayOrder}`,
    displayOrder,
    required: displayOrder < 9,
    label: `사진 ${displayOrder + 1}`
  }));
}
function setup(data: unknown, message?: string) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const clients = {
    admin: {
      rpc: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return { data, error: message ? { message } : null };
      }
    }
  } as unknown as SupabaseClients;
  return { calls, service: new SupabaseCleaningTemplateService(clients) };
}

function catalog() {
  return {
    cleaningKind: 'checkout',
    roomTypes: (['standard', 'premium', 'oceanPremium', 'oceanFamily'] as const).map((roomTypeCode) => ({
      roomTypeCode,
      roomTypeName: roomTypeCode,
      cleaningKind: 'checkout',
      configured: false,
      expectedVersion: 0,
      currentPublished: null
    }))
  };
}

describe('SupabaseCleaningTemplateService', () => {
  it('binds GET to the authenticated JWT session', async () => {
    const data = catalog();
    const { calls, service } = setup(data);
    await expect(service.listCheckout(actor)).resolves.toEqual(data);
    expect(calls).toEqual([{
      name: 'list_checkout_cleaning_templates',
      args: { p_actor_profile_id: actor.profileId, p_session_id: sessionId }
    }]);
  });

  it('sorts immutable slots and sends a stable scoped request hash', async () => {
    const data = {
      id: '30000000-0000-4000-8000-000000000001', version: 7, status: 'published',
      durationMinutes: 60, slots: slots(), publishedAt: '2030-01-01T00:00:00Z', createdAt: '2030-01-01T00:00:00Z'
    };
    const first = setup(data);
    const second = setup(data);
    const input = {
      roomTypeCode: 'standard' as const, cleaningKind: 'checkout' as const,
      expectedVersion: 0, durationMinutes: 60, slots: slots().reverse(),
      idempotencyKey: 'template-publish-0001'
    };
    await first.service.publishCheckout(actor, input);
    await second.service.publishCheckout(actor, { ...input, slots: [...input.slots].reverse() });
    const firstCall = first.calls[0];
    if (!firstCall) throw new Error('publish RPC was not called');
    expect(firstCall.name).toBe('publish_checkout_cleaning_template');
    expect(firstCall.args.p_session_id).toBe(sessionId);
    expect((firstCall.args.p_slots as Array<{ displayOrder: number }>).map((slot) => slot.displayOrder))
      .toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(firstCall.args.p_request_hash).toBe(second.calls[0]?.args.p_request_hash);
    expect(String(firstCall.args.p_request_hash)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('maps stale/replay/session errors and redacts unknown database details', async () => {
    for (const [message, status, code] of [
      ['CLEANING_TEMPLATE_VERSION_CONFLICT', 409, 'CLEANING_TEMPLATE_VERSION_CONFLICT'],
      ['IDEMPOTENCY_KEY_REUSED', 409, 'IDEMPOTENCY_KEY_REUSED'],
      ['SESSION_REVOKED', 401, 'SESSION_REVOKED']
    ] as const) {
      const { service } = setup(null, message);
      await expect(service.listCheckout(actor)).rejects.toMatchObject({ statusCode: status, code });
    }
    const { service } = setup(null, 'raw SQL contains secret phone');
    await expect(service.listCheckout(actor)).rejects.toEqual(expect.objectContaining({
      statusCode: 500,
      code: 'CLEANING_TEMPLATE_COMMAND_FAILED'
    }));
  });

  it('fails closed when a database projection is malformed', async () => {
    const malformed = catalog();
    const firstRoomType = malformed.roomTypes[0];
    if (!firstRoomType) throw new Error('catalog fixture is empty');
    firstRoomType.roomTypeCode = 'premium';
    const { service } = setup(malformed);
    await expect(service.listCheckout(actor)).rejects.toMatchObject({
      statusCode: 500,
      code: 'CLEANING_TEMPLATE_COMMAND_FAILED'
    });
  });

  it('rejects non-admin and tokens without a session before RPC', async () => {
    const { calls, service } = setup({});
    await expect(service.listCheckout({ ...actor, role: 'maid' })).rejects.toMatchObject({ code: 'ADMIN_REQUIRED' });
    await expect(service.listCheckout({ ...actor, accessToken: 'not-a-jwt' })).rejects.toMatchObject({ code: 'INVALID_ACCESS_TOKEN' });
    expect(calls).toHaveLength(0);
  });
});
