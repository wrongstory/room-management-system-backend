import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { PayrollService } from './payroll.service.js';
import {
  assertPayrollResponseSize,
  PAYROLL_CURSOR_MAX_LENGTH,
  PAYROLL_CYCLE_PAGE_MAX,
  PAYROLL_ENTRY_PAGE_MAX
} from './payroll-cursor.js';

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

function pageLimitSchema(maximum: number) {
  return z.union([
    z.number().int().min(1).max(maximum),
    z.string().regex(/^[1-9]\d*$/).transform(Number)
      .refine((value) => Number.isSafeInteger(value) && value <= maximum)
  ]);
}

const listSchema = z.object({
  weekStart: dateSchema,
  maidProfileId: z.uuid().optional(),
  limit: pageLimitSchema(PAYROLL_CYCLE_PAGE_MAX).optional(),
  cursor: z.string().min(1).max(PAYROLL_CURSOR_MAX_LENGTH).optional()
}).strict();

const entriesSchema = z.object({
  weekStart: dateSchema,
  maidProfileId: z.uuid(),
  kind: z.enum(['items', 'lateEarnings', 'adjustments']),
  limit: pageLimitSchema(PAYROLL_ENTRY_PAGE_MAX).optional(),
  cursor: z.string().min(1).max(PAYROLL_CURSOR_MAX_LENGTH).optional()
}).strict();

const startSchema = z.object({
  maidProfileId: z.uuid(),
  weekStart: dateSchema,
  expectedVersion: z.int().min(0)
}).strict();
const sourceFields = {
  sourceEarningId: z.uuid().optional(),
  sourceAdjustmentId: z.uuid().optional(),
  expectedVersion: z.int().min(0)
};
const sourceSchema = z.object(sourceFields).strict().refine((value) => Number(value.sourceEarningId !== undefined) + Number(value.sourceAdjustmentId !== undefined) === 1,
  'sourceEarningId 또는 sourceAdjustmentId 중 하나만 필요합니다.');
const correctionSchema = z.object({ ...sourceFields, amount: z.int().refine((value) => value !== 0) })
  .strict().refine((value) => Number(value.sourceEarningId !== undefined) + Number(value.sourceAdjustmentId !== undefined) === 1,
    'sourceEarningId 또는 sourceAdjustmentId 중 하나만 필요합니다.');
const lateCarryParamsSchema = z.object({ earningId: z.uuid() }).strict();
const lateCarryBodySchema = z.object({ expectedVersion: z.int().min(0) }).strict();
const noQuerySchema = z.object({}).strict();

function idempotencyKey(request: FastifyRequest): string {
  return z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/)
    .parse(request.headers['idempotency-key']);
}

function requireExactQuery(request: FastifyRequest, allowed: readonly string[]): void {
  const search = new URL(request.raw.url ?? '/', 'http://backend.internal').searchParams;
  for (const key of search.keys()) {
    if (!allowed.includes(key) || search.getAll(key).length !== 1) {
      throw new z.ZodError([{
        code: 'custom',
        path: [key],
        message: '허용되지 않거나 중복된 query 항목입니다.'
      }]);
    }
  }
}

export function createPayrollRoutes(service: PayrollService): FastifyPluginAsync {
  return async (app) => {
    app.addHook('onRequest', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
    });
    const authenticated = [app.authenticate, app.requirePasswordChanged];
    const admin = [...authenticated, app.requireAdmin];

    app.get('/', {
      preHandler: authenticated,
      prefixTrailingSlash: 'no-slash'
    }, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      requireExactQuery(request, ['weekStart', 'maidProfileId', 'limit', 'cursor']);
      const query = listSchema.parse(request.query);
      const response = await service.list(request.actor, query);
      assertPayrollResponseSize(response);
      return response;
    });

    app.get('/entries', { preHandler: authenticated }, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      requireExactQuery(request, ['weekStart', 'maidProfileId', 'kind', 'limit', 'cursor']);
      const query = entriesSchema.parse(request.query);
      const response = await service.listEntries(request.actor, query);
      assertPayrollResponseSize(response);
      return response;
    });

    app.post('/start', { preHandler: admin }, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      requireExactQuery(request, []);
      noQuerySchema.parse(request.query);
      const input = startSchema.parse(request.body);
      const response = {
        payroll: await service.start(request.actor, {
          ...input,
          idempotencyKey: idempotencyKey(request)
        })
      };
      assertPayrollResponseSize(response);
      return response;
    });

    app.post('/adjustments/corrections', { preHandler: admin }, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      reply.code(201);
      requireExactQuery(request, []);
      const input = correctionSchema.parse(request.body);
      const response = { adjustment: await service.correct(request.actor, {
        ...input, idempotencyKey: idempotencyKey(request)
      }) };
      assertPayrollResponseSize(response);
      return response;
    });

    app.post('/adjustments/reversals', { preHandler: admin }, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      reply.code(201);
      requireExactQuery(request, []);
      const input = sourceSchema.parse(request.body);
      const response = { adjustment: await service.reverse(request.actor, {
        ...input, idempotencyKey: idempotencyKey(request)
      }) };
      assertPayrollResponseSize(response);
      return response;
    });

    app.post('/carry-forward', { preHandler: admin }, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      requireExactQuery(request, []);
      const input = startSchema.parse(request.body);
      const response = { payroll: await service.carryForward(request.actor, {
        ...input, idempotencyKey: idempotencyKey(request)
      }) };
      assertPayrollResponseSize(response);
      return response;
    });

    app.post('/late-earnings/:earningId/carry', { preHandler: admin }, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      reply.code(201);
      requireExactQuery(request, []);
      const params = lateCarryParamsSchema.parse(request.params);
      const body = lateCarryBodySchema.parse(request.body);
      const response = { adjustment: await service.carryLateEarning(request.actor, {
        ...params, ...body, idempotencyKey: idempotencyKey(request)
      }) };
      assertPayrollResponseSize(response);
      return response;
    });
  };
}
