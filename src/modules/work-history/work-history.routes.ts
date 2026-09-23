import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/app-error.js';
import type { WorkHistoryInput } from './work-history.service.js';
import type { WorkHistoryService } from './work-history.service.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value && parsed.getUTCDay() === 1;
});
const limit = z.union([
  z.number().int().min(1).max(100),
  z.string().regex(/^[1-9]\d*$/).transform(Number).refine((value) => value <= 100)
]);
const maidProfileId = z.uuid();
const cursor = z.string().min(1).max(1024);

function invalidQuery(): never {
  throw new AppError(400, 'INVALID_WORK_HISTORY_QUERY', '업무 기록 조회 조건이 올바르지 않습니다.');
}

function invalidCursor(): never {
  throw new AppError(400, 'INVALID_WORK_HISTORY_CURSOR', '업무 기록 cursor가 올바르지 않습니다.');
}

function exactQuery(request: FastifyRequest): void {
  const parameters = new URL(request.raw.url ?? '/', 'http://internal').searchParams;
  const allowed = ['weekStart', 'maidProfileId', 'limit', 'cursor'];
  for (const key of parameters.keys()) {
    if (!allowed.includes(key) || parameters.getAll(key).length !== 1) {
      invalidQuery();
    }
  }
}

function parseQuery(request: FastifyRequest): WorkHistoryInput {
  exactQuery(request);
  const value = request.query as Record<string, unknown>;
  const parsedWeekStart = date.safeParse(value.weekStart);
  if (!parsedWeekStart.success) invalidQuery();
  const parsedMaid = value.maidProfileId === undefined
    ? undefined
    : maidProfileId.safeParse(value.maidProfileId);
  if (parsedMaid !== undefined && !parsedMaid.success) invalidQuery();
  const parsedLimit = value.limit === undefined ? undefined : limit.safeParse(value.limit);
  if (parsedLimit !== undefined && !parsedLimit.success) invalidQuery();
  const parsedCursor = value.cursor === undefined ? undefined : cursor.safeParse(value.cursor);
  if (parsedCursor !== undefined && !parsedCursor.success) invalidCursor();
  return {
    weekStart: parsedWeekStart.data,
    maidProfileId: parsedMaid?.data,
    limit: parsedLimit?.data,
    cursor: parsedCursor?.data
  };
}

export function createWorkHistoryRoutes(service: WorkHistoryService): FastifyPluginAsync {
  return async (app) => {
    app.get('/', {
      preHandler: [app.authenticate, app.requirePasswordChanged],
      prefixTrailingSlash: 'no-slash'
    }, async (request, reply) => {
      reply.header('cache-control', 'no-store');
      return service.list(request.actor, parseQuery(request));
    });
  };
}
