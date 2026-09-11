import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '../src/domain/actor.js';
import { AppError } from '../src/lib/app-error.js';
import {
  assertNotificationResponseSize,
  NotificationCursorCodec,
  notificationCursorScope
} from '../src/modules/notifications/notification-cursor.js';
import { createNotificationRoutes } from '../src/modules/notifications/notification.routes.js';
import {
  type NotificationService,
  SupabaseNotificationService
} from '../src/modules/notifications/notification.service.js';

const sessionId = '10800000-0000-4000-8000-000000000901';
function token(session = sessionId): string {
  return `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ session_id: session })).toString('base64url')}.x`;
}
const actor: Actor = {
  authUserId: '10800000-0000-4000-8000-000000000101',
  profileId: '10800000-0000-4000-8000-000000000001',
  displayName: '알림 메이드',
  role: 'maid',
  mustChangePassword: false,
  accessToken: token()
};
const notice = {
  id: '10800000-0000-4000-8000-000000001001',
  category: 'assignment_changed',
  title: '배정이 변경되었습니다',
  body: '업무 앱에서 최신 배정을 확인해 주세요.',
  roomId: null,
  cleaningTargetId: null,
  requiresAction: true,
  readAt: null,
  resolvedAt: null,
  occurredAt: '2026-09-11T01:00:00Z'
};
const secret = 'notification-cursor-test-secret-123456789';

describe('notification cursor and service', () => {
  it('binds the signed cursor to actor, role, stream, and sort', () => {
    const codec = new NotificationCursorCodec(secret);
    const scope = notificationCursorScope(actor);
    const cursor = codec.encode(scope, { occurredAt: notice.occurredAt, id: notice.id });
    expect(codec.decode(cursor, scope)).toEqual({ occurredAt: notice.occurredAt, id: notice.id });
    expect(() => codec.decode(`${cursor.slice(0, -1)}A`, scope)).toThrowError(
      expect.objectContaining({ code: 'INVALID_NOTIFICATION_CURSOR' })
    );
    expect(() => codec.decode(cursor, notificationCursorScope({ ...actor, profileId: '10800000-0000-4000-8000-000000000002' })))
      .toThrowError(expect.objectContaining({ code: 'INVALID_NOTIFICATION_CURSOR' }));
    expect(() => codec.decode(cursor, notificationCursorScope({ ...actor, role: 'admin' })))
      .toThrowError(expect.objectContaining({ code: 'INVALID_NOTIFICATION_CURSOR' }));
    expect(() => new NotificationCursorCodec('short')).toThrowError(
      expect.objectContaining({ code: 'NOTIFICATION_CURSOR_NOT_CONFIGURED' })
    );
  });

  it('passes the exact session to bounded RPCs and projects no internal fields', async () => {
    const rpc = vi.fn(async (name: string) => ({
      data: name === 'list_notifications_page'
        ? { notifications: [notice], hasMore: false, lastOccurredAt: null, lastId: null }
        : { ...notice, readAt: '2026-09-11T02:00:00Z' },
      error: null
    }));
    const service = new SupabaseNotificationService({ admin: { rpc } } as never, secret);
    const listed = await service.list(actor, {});
    expect(listed).toEqual({ notifications: [notice], nextCursor: null });
    expect(rpc).toHaveBeenCalledWith('list_notifications_page', expect.objectContaining({
      p_actor_profile_id: actor.profileId,
      p_session_id: sessionId,
      p_limit: 50
    }));
    expect(JSON.stringify(listed)).not.toMatch(/dedupeKey|groupKey|recipientProfileId|sessionId/);
    await expect(service.markRead({ ...actor, role: 'developer' }, notice.id)).rejects.toMatchObject({
      code: 'NOTIFICATION_ACCESS_REQUIRED'
    });
    await expect(service.list({ ...actor, accessToken: token('not-a-uuid') }, {})).rejects.toMatchObject({
      code: 'INVALID_ACCESS_TOKEN'
    });
  });

  it('maps cross-recipient absence to the stable 404 and enforces 128 KiB', async () => {
    const service = new SupabaseNotificationService({
      admin: { rpc: vi.fn(async () => ({ data: null, error: { message: 'NOTIFICATION_NOT_FOUND' } })) }
    } as never, secret);
    await expect(service.markRead(actor, notice.id)).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOTIFICATION_NOT_FOUND'
    });
    expect(() => assertNotificationResponseSize({
      notifications: [{ ...notice, body: '가'.repeat(50_000) }],
      nextCursor: null
    })).toThrowError(expect.objectContaining({ code: 'NOTIFICATION_RESPONSE_TOO_LARGE' }));
  });
});

describe('notification Fastify routes', () => {
  async function app(service: NotificationService) {
    const instance = Fastify({ logger: false });
    instance.decorateRequest('actor');
    instance.decorate('authenticate', async (request) => { request.actor = actor; });
    instance.decorate('requirePasswordChanged', async () => undefined);
    instance.setErrorHandler((error, request, reply) => {
      if (error instanceof AppError) {
        return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message }, requestId: request.id });
      }
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: '요청 값이 올바르지 않습니다.' } });
    });
    await instance.register(createNotificationRoutes(service), { prefix: '/v1/notifications' });
    return instance;
  }

  it('uses the exact list/read routes, no-store, and accepts no client timestamp', async () => {
    const service: NotificationService = {
      list: vi.fn(async () => ({ notifications: [notice], nextCursor: null })),
      markRead: vi.fn(async () => ({ ...notice, readAt: '2026-09-11T02:00:00Z' }))
    };
    const instance = await app(service);
    const listed = await instance.inject({ method: 'GET', url: '/v1/notifications?limit=50' });
    expect(listed.statusCode).toBe(200);
    expect(listed.headers['cache-control']).toBe('no-store');
    const marked = await instance.inject({ method: 'POST', url: `/v1/notifications/${notice.id}/read`, payload: {} });
    expect(marked.statusCode).toBe(200);
    expect(marked.headers['cache-control']).toBe('no-store');
    for (const payload of [
      { readAt: '2099-01-01T00:00:00Z' },
      { resolvedAt: null },
      { title: '변조' }
    ]) {
      const response = await instance.inject({ method: 'POST', url: `/v1/notifications/${notice.id}/read`, payload });
      expect(response.statusCode).toBe(400);
      expect(service.markRead).toHaveBeenCalledTimes(1);
    }
    expect((await instance.inject({ method: 'POST', url: `/v1/notifications/${notice.id}/read/extra`, payload: {} })).statusCode).toBe(404);
    expect((await instance.inject({ method: 'GET', url: '/v1/notifications?limit=101' })).statusCode).toBe(400);
    expect((await instance.inject({ method: 'GET', url: '/v1/notifications?cursor=' })).statusCode).toBe(400);
    expect((await instance.inject({ method: 'GET', url: '/v1/notifications?limit=1&limit=2' })).statusCode).toBe(400);
    await instance.close();

    const crossRecipient = await app({
      list: vi.fn(async () => ({ notifications: [], nextCursor: null })),
      markRead: vi.fn(async () => {
        throw new AppError(404, 'NOTIFICATION_NOT_FOUND', '알림을 찾을 수 없습니다.');
      })
    });
    const hidden = await crossRecipient.inject({
      method: 'POST',
      url: `/v1/notifications/${notice.id}/read`,
      payload: {}
    });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json().error.code).toBe('NOTIFICATION_NOT_FOUND');
    expect(hidden.headers['cache-control']).toBe('no-store');
    await crossRecipient.close();
  });
});
