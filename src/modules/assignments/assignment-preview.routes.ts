import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/app-error.js';
import type { AssignmentPreviewService } from './assignment-preview.service.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const previewBody = z.object({
  serviceDate: date,
  previewSeed: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional()
}).strict();

function noQuery(request: FastifyRequest): void {
  if ([...new URL(request.raw.url ?? '/', 'http://internal').searchParams.keys()].length > 0) {
    throw new z.ZodError([{
      code: 'custom',
      path: ['query'],
      message: 'query 항목은 허용되지 않습니다.'
    }]);
  }
}

const adminGuards = (app: Parameters<FastifyPluginAsync>[0]) => [
  app.authenticate,
  app.requirePasswordChanged,
  app.requireAdmin
];

export function createAssignmentPreviewRoutes(service: AssignmentPreviewService): FastifyPluginAsync {
  return async (app) => {
    app.post('/preview', { preHandler: adminGuards(app) }, async (request) =>
      service.preview(request.actor, previewBody.parse(request.body)));
  };
}

export function createAssignmentDurationPolicyRoutes(
  service: AssignmentPreviewService
): FastifyPluginAsync {
  return async (app) => {
    app.get('/duration-policy', { preHandler: adminGuards(app) }, async (request) => {
      noQuery(request);
      return { durationPolicy: await service.durationPolicy(request.actor) };
    });
    app.post('/duration-policy', { preHandler: adminGuards(app) }, async (request) => {
      noQuery(request);
      throw new AppError(
        410,
        'ASSIGNMENT_DURATION_POLICY_RETIRED',
        '예상 시간 정책은 폐기되어 더 이상 확정할 수 없습니다.'
      );
    });
  };
}
