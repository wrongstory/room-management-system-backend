import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/app-error.js';
import {
  assertNotificationResponseSize,
  NOTIFICATION_CURSOR_MAX_LENGTH,
  NOTIFICATION_PAGE_MAX
} from './notification-cursor.js';
import type { NotificationService } from './notification.service.js';

const limitSchema = z.union([
  z.number().int().min(1).max(NOTIFICATION_PAGE_MAX),
  z.string().regex(/^[1-9]\d*$/).transform(Number).refine((value) => value <= NOTIFICATION_PAGE_MAX)
]);
const listSchema = z.object({
  limit: limitSchema.optional(),
  cursor: z.string().min(1).max(NOTIFICATION_CURSOR_MAX_LENGTH).optional()
}).strict();
const paramsSchema = z.object({ id: z.uuid() }).strict();
const emptyBodySchema = z.union([z.undefined(), z.object({}).strict()]);

function exactQuery(request: FastifyRequest, allowed: readonly string[]): void {
  const query = new URL(request.raw.url ?? '/', 'http://backend.internal').searchParams;
  for (const key of query.keys()) {
    if (!allowed.includes(key) || query.getAll(key).length !== 1) {
      throw new z.ZodError([{ code: 'custom', path: [key], message: '허용되지 않거나 중복된 query 항목입니다.' }]);
    }
    if (key === 'cursor' && query.get(key) === '') {
      throw new AppError(400, 'INVALID_NOTIFICATION_CURSOR', '알림 cursor가 올바르지 않습니다.');
    }
  }
}

function send(body: unknown): unknown {
  assertNotificationResponseSize(body);
  return body;
}

export function createNotificationRoutes(service: NotificationService): FastifyPluginAsync {
  return async (app) => {
    app.addHook('onRequest', async (_request, reply) => {
      reply.header('cache-control', 'no-store');
    });
    const authenticated = [app.authenticate, app.requirePasswordChanged];

    app.get('/', {
      preHandler: authenticated,
      prefixTrailingSlash: 'no-slash'
    }, async (request) => {
      exactQuery(request, ['limit', 'cursor']);
      return send(await service.list(request.actor, listSchema.parse(request.query)));
    });

    app.post('/:id/read', { preHandler: authenticated }, async (request) => {
      exactQuery(request, []);
      emptyBodySchema.parse(request.body);
      const { id } = paramsSchema.parse(request.params);
      return send({ notification: await service.markRead(request.actor, id) });
    });
  };
}
