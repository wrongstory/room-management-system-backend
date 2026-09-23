import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { WorkHistoryService } from './work-history.service.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value && parsed.getUTCDay() === 1;
});
const limit = z.union([
  z.number().int().min(1).max(100),
  z.string().regex(/^[1-9]\d*$/).transform(Number).refine((value) => value <= 100)
]);
const query = z.object({
  weekStart: date,
  maidProfileId: z.uuid().optional(),
  limit: limit.optional(),
  cursor: z.string().min(1).max(1024).optional()
}).strict();

function exactQuery(request: FastifyRequest): void {
  const parameters = new URL(request.raw.url ?? '/', 'http://internal').searchParams;
  const allowed = ['weekStart', 'maidProfileId', 'limit', 'cursor'];
  for (const key of parameters.keys()) {
    if (!allowed.includes(key) || parameters.getAll(key).length !== 1) {
      throw new z.ZodError([{ code: 'custom', path: [key], message: '허용되지 않거나 중복된 query 항목입니다.' }]);
    }
  }
}

export function createWorkHistoryRoutes(service: WorkHistoryService): FastifyPluginAsync {
  return async (app) => {
    app.get('/', {
      preHandler: [app.authenticate, app.requirePasswordChanged],
      prefixTrailingSlash: 'no-slash'
    }, async (request, reply) => {
      exactQuery(request);
      reply.header('cache-control', 'no-store');
      return service.list(request.actor, query.parse(request.query));
    });
  };
}
