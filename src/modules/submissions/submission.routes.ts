import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/app-error.js';
import type { SubmissionActor, SubmissionService } from './submission.service.js';

const id = z.uuid();
const reason = z.string().regex(/^[A-Z0-9_]{2,80}$/);
const bombReason = {
  approved: ['BOMB_CONFIRMED'],
  rejected: ['BOMB_NOT_CONFIRMED', 'BOMB_EVIDENCE_INSUFFICIENT']
} as const;
const inspectionReason = {
  approve: ['QUALITY_OK'],
  reject: ['QUALITY_REWORK', 'EVIDENCE_INCOMPLETE', 'CLEANING_INCOMPLETE']
} as const;
const key = (request: FastifyRequest) => z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/).parse(request.headers['idempotency-key']);
const attemptParams = z.object({ attemptId: id });
const submissionParams = z.object({ submissionId: id });
const bombMemo = z.string().min(1).max(500).refine((value) => value.trim().length > 0);
function noQuery(request: FastifyRequest): void {
  if (Object.keys(request.query as Record<string, unknown>).length > 0) {
    throw new AppError(400, 'VALIDATION_ERROR', '이 경로는 query parameter를 허용하지 않습니다.');
  }
}
async function requireMaid(request: FastifyRequest): Promise<void> {
  if (request.actor.role !== 'maid') throw new AppError(403, 'MAID_REQUIRED', '담당 메이드만 제출할 수 있습니다.');
}

export type AuthenticateLimitedSubmission = (request: FastifyRequest) => Promise<SubmissionActor>;

export function createSubmissionRoutes(
  service: SubmissionService,
  authenticateLimitedSubmission?: AuthenticateLimitedSubmission
): FastifyPluginAsync {
  return async (app) => {
    const authenticated = [app.authenticate, app.requirePasswordChanged];
    const maid = [...authenticated, requireMaid];
    const admin = [...authenticated, app.requireAdmin];
    const limitedActors = new WeakMap<FastifyRequest, SubmissionActor>();
    const submissionMaid = authenticateLimitedSubmission
      ? [async (request: FastifyRequest) => {
          const limitedActor = await authenticateLimitedSubmission(request);
          if (limitedActor.mustChangePassword) throw new AppError(403, 'PASSWORD_CHANGE_REQUIRED', '계속하려면 먼저 임시 비밀번호를 변경해 주세요.');
          if (limitedActor.role !== 'maid') throw new AppError(403, 'CAPABILITY_ACCESS_REQUIRED', '허용된 제한 수행 권한이 필요합니다.');
          limitedActors.set(request, limitedActor);
        }]
      : maid;
    app.post('/v1/attempts/:attemptId/bomb-room-reports', { preHandler: maid }, async (request, reply) => {
      noQuery(request);
      const { attemptId } = attemptParams.parse(request.params);
      const body = z.object({ evidencePhotoIds: z.array(id).min(1).max(20).refine((ids) => new Set(ids).size === ids.length), memo: bombMemo }).strict().parse(request.body);
      return reply.code(201).send({ bombReport: await service.reportBomb(request.actor, attemptId, body.evidencePhotoIds, body.memo, key(request)) });
    });
    app.post('/v1/attempts/:attemptId/submissions', { preHandler: submissionMaid }, async (request, reply) => {
      noQuery(request);
      const { attemptId } = attemptParams.parse(request.params);
      const body = z.object({ clientSubmissionId: id, expectedRevision: z.int().min(0), candleCount: z.int().min(0) }).strict().parse(request.body);
      const commandActor = limitedActors.get(request) ?? request.actor;
      return reply.code(201).send({ submission: await service.create(commandActor, attemptId, body.clientSubmissionId, body.expectedRevision, body.candleCount, key(request)) });
    });
    app.get('/v1/attempts/:attemptId/submissions', { preHandler: authenticated }, async (request) => {
      noQuery(request);
      const { attemptId } = attemptParams.parse(request.params);
      return { submissions: await service.list(request.actor, attemptId) };
    });
    app.get('/v1/inspections', { preHandler: admin }, async (request) => {
      noQuery(request);
      return { submissions: await service.list(request.actor) };
    });
    app.get('/v1/inspections/:submissionId', { preHandler: admin }, async (request) => {
      noQuery(request);
      const { submissionId } = submissionParams.parse(request.params);
      return { submission: await service.detail(request.actor, submissionId) };
    });
    app.post('/v1/inspections/:submissionId/bomb-room-decision', { preHandler: admin }, async (request) => {
      noQuery(request);
      const { submissionId } = submissionParams.parse(request.params);
      const body = z.object({ decision: z.enum(['approved', 'rejected']), reasonCode: reason }).strict().parse(request.body);
      if (!(bombReason[body.decision] as readonly string[]).includes(body.reasonCode)) throw new AppError(400, 'VALIDATION_ERROR', '폭탄방 판정 사유를 확인해 주세요.');
      return { bombDecision: await service.decideBomb(request.actor, submissionId, body.decision, body.reasonCode, key(request)) };
    });
    for (const decision of ['approve', 'reject'] as const) app.post(`/v1/inspections/:submissionId/${decision}`, { preHandler: admin }, async (request) => {
      noQuery(request);
      const { submissionId } = submissionParams.parse(request.params);
      const body = z.object({ reasonCode: reason }).strict().parse(request.body);
      if (!(inspectionReason[decision] as readonly string[]).includes(body.reasonCode)) throw new AppError(400, 'VALIDATION_ERROR', '검수 사유를 확인해 주세요.');
      return { inspection: await service.decide(request.actor, submissionId, decision, body.reasonCode, key(request)) };
    });
  };
}
