import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AvailabilityService } from './availability.service.js';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parts = value.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}, '유효한 날짜를 입력해야 합니다.');
const availableDatesSchema = z.array(dateSchema).max(7).refine(
  (dates) => new Set(dates).size === dates.length,
  '가능일은 중복 없이 입력해야 합니다.'
);
const reasonCodeSchema = z.string().trim().min(2).max(80).regex(/^[A-Z0-9_]+$/);

const listSchema = z.object({
  weekStart: dateSchema,
  maidProfileId: z.uuid().optional()
});
const candidatesSchema = z.object({ workDate: dateSchema });
const changeRequestListSchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
  weekStart: dateSchema.optional(),
  maidProfileId: z.uuid().optional()
});
const submitSchema = z.object({
  weekStart: dateSchema,
  availableDates: availableDatesSchema,
  expectedVersion: z.int().min(0)
});
const requestChangeSchema = z.object({
  weekStart: dateSchema,
  requestedAvailableDates: availableDatesSchema,
  reasonCode: reasonCodeSchema,
  expectedVersion: z.int().min(1)
});
const decisionParamsSchema = z.object({ requestId: z.uuid() });
const decisionSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  reasonCode: reasonCodeSchema,
  expectedVersion: z.int().min(1)
});

function idempotencyKey(request: FastifyRequest): string {
  return z.string()
    .min(8)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/)
    .parse(request.headers['idempotency-key']);
}

export function createAvailabilityRoutes(service: AvailabilityService): FastifyPluginAsync {
  return async (app) => {
    const authenticated = [app.authenticate, app.requirePasswordChanged];
    const admin = [...authenticated, app.requireAdmin];

    app.get('/', { preHandler: authenticated }, async (request) => {
      const query = listSchema.parse(request.query);
      return {
        availability: await service.listCurrent(
          request.actor,
          query.weekStart,
          query.maidProfileId
        )
      };
    });

    app.post('/submissions', { preHandler: authenticated }, async (request, reply) => {
      const input = submitSchema.parse(request.body);
      const availability = await service.submit(request.actor, {
        ...input,
        idempotencyKey: idempotencyKey(request)
      });
      return reply.code(201).send({ availability });
    });

    app.post('/change-requests', { preHandler: authenticated }, async (request, reply) => {
      const input = requestChangeSchema.parse(request.body);
      const changeRequest = await service.requestChange(request.actor, {
        ...input,
        idempotencyKey: idempotencyKey(request)
      });
      return reply.code(201).send({ changeRequest });
    });

    app.get('/change-requests', { preHandler: authenticated }, async (request) => ({
      changeRequests: await service.listChangeRequests(
        request.actor,
        changeRequestListSchema.parse(request.query)
      )
    }));

    app.post(
      '/change-requests/:requestId/decision',
      { preHandler: admin },
      async (request) => {
        const { requestId } = decisionParamsSchema.parse(request.params);
        const input = decisionSchema.parse(request.body);
        return {
          changeRequest: await service.decideChange(request.actor, {
            changeRequestId: requestId,
            ...input,
            idempotencyKey: idempotencyKey(request)
          })
        };
      }
    );

    app.get('/candidates', { preHandler: admin }, async (request) => {
      const { workDate } = candidatesSchema.parse(request.query);
      return { candidates: await service.listCandidates(request.actor, workDate) };
    });
  };
}
