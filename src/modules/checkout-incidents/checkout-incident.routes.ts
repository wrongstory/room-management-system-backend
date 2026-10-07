import type { FastifyPluginAsync, FastifyRequest, onRequestAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/app-error.js';
import { checkoutIncidentListQuery } from './checkout-incident-cursor.js';
import {
  type CheckoutIncidentService,
  isCheckoutIncidentTimestamp,
} from './checkout-incident.service.js';

const uuid = z.uuid();
const version = z.int().min(1);
const timestamp = z.string().refine(isCheckoutIncidentTimestamp);
const idempotencyKey = (request: FastifyRequest) => z.string().min(8).max(128)
  .regex(/^[A-Za-z0-9._:-]+$/).parse(request.headers['idempotency-key']);
const reassignment = z.object({
  maidProfileId: uuid, sequenceNumber: z.int().min(1), serviceDate: z.iso.date(),
  availableFrom: timestamp, dueAt: timestamp
}).strict();
const reasons = {
  EXTEND_CHECKOUT: 'GUEST_STILL_PRESENT_EXTENDED',
  CONFIRM_DEPARTED: 'GUEST_DEPARTURE_CONFIRMED',
  FALSE_REPORT: 'REPORT_FALSE_CONFIRMED'
} as const;
function noQuery(request: FastifyRequest): void {
  if (Object.keys(request.query as Record<string, unknown>).length) {
    throw new AppError(400, 'VALIDATION_ERROR', '이 경로는 query parameter를 허용하지 않습니다.');
  }
}

// Register on the root app before CORS/rate-limit: unmatched methods and paths do
// not run an encapsulated route hook. Only this API family gains cache headers.
export const checkoutIncidentCollectionGuard: onRequestAsyncHookHandler = async (request, reply) => {
  const path = request.url.split('?')[0] ?? '';
  const normalized = path.replace(/\/+/g, '/').replace(/\/+$/, '');
  const collectionPath = '/v1/checkout-incidents';
  if (normalized !== collectionPath && !normalized.startsWith(`${collectionPath}/`)) return;
  reply.header('Cache-Control', 'no-store');
  // OPTIONS is transport-level CORS preflight, not a collection operation.
  if (normalized === collectionPath && request.method !== 'OPTIONS'
    && (request.method !== 'GET' || path !== collectionPath)) {
    throw new AppError(404, 'ROUTE_NOT_FOUND', '요청한 API 경로를 찾을 수 없습니다.');
  }
};

export function createCheckoutIncidentRoutes(service: CheckoutIncidentService): FastifyPluginAsync {
  return async (app) => {
    const authenticated = [app.authenticate, app.requirePasswordChanged];
    app.get('/v1/checkout-incidents', {
      exposeHeadRoute: false,
      onRequest: async (_request, reply) => { reply.header('Cache-Control', 'no-store'); },
      preHandler: authenticated
    }, async (request) => {
      if (request.actor.role !== 'admin') throw new AppError(403, 'ADMIN_REQUIRED', '관리자만 목록을 조회할 수 있습니다.');
      const query = checkoutIncidentListQuery(new URL(request.url, 'http://localhost').searchParams);
      return service.list(request.actor, query);
    });
    app.post('/v1/attempts/:attemptId/checkout-not-completed', { preHandler: authenticated }, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      noQuery(request);
      if (request.actor.role !== 'maid') throw new AppError(403, 'MAID_REQUIRED', '담당 메이드만 신고할 수 있습니다.');
      const { attemptId } = z.object({ attemptId: uuid }).parse(request.params);
      const body = z.object({ expectedExecutionVersion: version, expectedAssignmentId: uuid,
        expectedAssignmentRevision: version }).strict().parse(request.body);
      return reply.code(201).send({ incident: await service.report(request.actor, attemptId, body, idempotencyKey(request)) });
    });
    app.get('/v1/checkout-incidents/:incidentId', { preHandler: authenticated }, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      noQuery(request);
      if (request.actor.role !== 'maid' && request.actor.role !== 'admin') {
        throw new AppError(403, 'CHECKOUT_INCIDENT_ACCESS_REQUIRED', '사건 조회 권한이 필요합니다.');
      }
      const { incidentId } = z.object({ incidentId: uuid }).parse(request.params);
      return { incident: await service.get(request.actor, incidentId) };
    });
    app.post('/v1/checkout-incidents/:incidentId/decision', { preHandler: authenticated }, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      noQuery(request);
      if (request.actor.role !== 'admin') throw new AppError(403, 'ADMIN_REQUIRED', '관리자만 결정할 수 있습니다.');
      const { incidentId } = z.object({ incidentId: uuid }).parse(request.params);
      const body = z.object({ expectedVersion: version,
        expectedImpactFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
        decision: z.enum(['EXTEND_CHECKOUT','CONFIRM_DEPARTED','FALSE_REPORT']),
        reasonCode: z.string().regex(/^[A-Z0-9_]{2,80}$/),
        newCheckoutAt: timestamp.nullable(), reassignment }).strict().parse(request.body);
      if (body.reasonCode !== reasons[body.decision]
        || (body.decision === 'EXTEND_CHECKOUT') !== (body.newCheckoutAt !== null)) {
        throw new AppError(400, 'VALIDATION_ERROR', '결정 사유와 체크아웃 시각을 확인해 주세요.');
      }
      return { incident: await service.decide(request.actor, incidentId, body, idempotencyKey(request)) };
    });
  };
}
