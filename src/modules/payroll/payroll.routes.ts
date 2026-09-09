import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { PayrollService } from './payroll.service.js';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const [yearText, monthText, dayText] = value.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}, '유효한 날짜를 입력해야 합니다.');

const listSchema = z.object({
  weekStart: dateSchema,
  maidProfileId: z.uuid().optional()
}).strict();

const startSchema = z.object({
  maidProfileId: z.uuid(),
  weekStart: dateSchema,
  expectedVersion: z.int().min(0)
}).strict();
const noQuerySchema = z.object({}).strict();

function idempotencyKey(request: FastifyRequest): string {
  return z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/)
    .parse(request.headers['idempotency-key']);
}

export function createPayrollRoutes(service: PayrollService): FastifyPluginAsync {
  return async (app) => {
    const authenticated = [app.authenticate, app.requirePasswordChanged];
    const admin = [...authenticated, app.requireAdmin];

    app.get('/', {
      preHandler: authenticated,
      prefixTrailingSlash: 'no-slash'
    }, async (request) => {
      const query = listSchema.parse(request.query);
      return {
        payroll: await service.list(request.actor, query.weekStart, query.maidProfileId)
      };
    });

    app.post('/start', { preHandler: admin }, async (request) => {
      noQuerySchema.parse(request.query);
      const input = startSchema.parse(request.body);
      return {
        payroll: await service.start(request.actor, {
          ...input,
          idempotencyKey: idempotencyKey(request)
        })
      };
    });
  };
}
