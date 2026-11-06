import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AssignmentService } from './assignment.service.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
});
const boolean = z.union([z.boolean(), z.enum(['true', 'false']).transform((value) => value === 'true')]);
const listQuery = z.object({ serviceDate: date, maidProfileId: z.uuid().optional(), includeHistory: boolean.optional() }).strict();
const historyParams = z.object({ cleaningTargetId: z.uuid() }).strict();

function exactQuery(request: FastifyRequest): void {
  const parameters = new URL(request.raw.url ?? '/', 'http://internal').searchParams;
  for (const key of parameters.keys()) {
    if (!['serviceDate', 'maidProfileId', 'includeHistory'].includes(key) || parameters.getAll(key).length !== 1) {
      throw new z.ZodError([{ code: 'custom', path: [key], message: '허용되지 않거나 중복된 query 항목입니다.' }]);
    }
  }
}

export function createAssignmentRoutes(service: AssignmentService): FastifyPluginAsync {
  return async (app) => {
    app.get('/:cleaningTargetId/force-recall', { preHandler: [app.authenticate, app.requirePasswordChanged, app.requireAdmin] },
      async (request, reply) => {
        z.object({}).strict().parse(request.query);
        reply.header('cache-control','no-store');
        return service.recallCandidate(request.actor,historyParams.parse(request.params).cleaningTargetId);
      });
    app.post('/:cleaningTargetId/force-recall', { preHandler: [app.authenticate, app.requirePasswordChanged, app.requireAdmin] },
      async (request, reply) => {
        z.object({}).strict().parse(request.query);
        const {cleaningTargetId} = historyParams.parse(request.params);
        const key = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/).parse(request.headers['idempotency-key']);
        reply.header('cache-control','no-store');
        return service.forceRecall(request.actor,cleaningTargetId,request.body,key);
      });
    app.get('/',  { preHandler: [app.authenticate, app.requirePasswordChanged], prefixTrailingSlash: 'no-slash' },
      async (request, reply) => {
        exactQuery(request);
        reply.header('cache-control', 'no-store');
        return { assignments: await service.list(request.actor, listQuery.parse(request.query)) };
      });
    app.get('/:cleaningTargetId/history', { preHandler: [app.authenticate, app.requirePasswordChanged] },
      async (request, reply) => {
        reply.header('cache-control', 'no-store');
        const params = historyParams.parse(request.params);
        return { assignments: await service.history(request.actor, params.cleaningTargetId) };
      });
  };
}
