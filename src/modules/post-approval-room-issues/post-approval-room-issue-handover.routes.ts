import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/app-error.js';
import { validatePostApprovalRoomIssueHandover } from './post-approval-room-issue-handover-contract.js';
import type { SupabasePostApprovalRoomIssueHandoverService } from './post-approval-room-issue-handover.service.js';
import { postApprovalRoomIssueEvidenceHttpErrorStatuses } from './post-approval-room-issue-evidence.routes.js';
import { projectPostApprovalRoomIssueUpload } from './post-approval-room-issue-upload-contract.js';

export const POST_APPROVAL_HANDOVER_PATH = '/v1/post-approval-room-issue-evidence-uploads/:operationId/handover';
const params = z.object({ operationId: z.uuid() }).strict();
const body = z.object({ expectedLeaseVersion: z.int().min(0).max(7) }).strict();
const key = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
function invalid(): never { throw new AppError(400, 'VALIDATION_ERROR', '인계 요청을 확인해 주세요.'); }

/** Isolated candidate: do not register before runtime key, Edge and DB integration gates. */
export function createPostApprovalHandoverRoutes(
  service: Pick<SupabasePostApprovalRoomIssueHandoverService, 'recover'>
): FastifyPluginAsync {
  return async app => {
    app.addHook('onRequest', async (_request, reply) => { reply.header('cache-control', 'no-store'); });
    app.setErrorHandler((error, request, reply) => {
      let code = 'POST_APPROVAL_ROOM_ISSUE_EVIDENCE_COMMAND_FAILED';
      try {
        const errorCode = error && typeof error === 'object' && 'code' in error ? error.code : null;
        if (error instanceof AppError && typeof errorCode === 'string' && Object.hasOwn(postApprovalRoomIssueEvidenceHttpErrorStatuses, errorCode)) code = errorCode;
        else if (errorCode === 'FST_ERR_CTP_BODY_TOO_LARGE') code = 'PHOTO_TOO_LARGE';
        else if (errorCode === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') code = 'PHOTO_MEDIA_TYPE_UNSUPPORTED';
        else if (errorCode === 'FST_ERR_CTP_INVALID_JSON_BODY' || errorCode === 'FST_ERR_CTP_EMPTY_JSON_BODY') code = 'VALIDATION_ERROR';
      } catch { /* Never expose error getters or private provider details. */ }
      return reply.code(postApprovalRoomIssueEvidenceHttpErrorStatuses[code] ?? 500).send({
        error: { code, message: '증빙 인계 요청을 처리하지 못했습니다.' },
        requestId: z.uuid().safeParse(request.id).success ? request.id : 'unavailable',
      });
    });
    app.post(POST_APPROVAL_HANDOVER_PATH, { logLevel: 'silent', bodyLimit: 1024, onRequest: [
      app.authenticate, app.requirePasswordChanged,
      async request => {
        if (request.actor.role !== 'admin') throw new AppError(403, 'ADMIN_REQUIRED', '관리자 권한이 필요합니다.');
        if ((request.raw.url ?? '').includes('?')) invalid();
        const occurrences = request.raw.rawHeaders.filter((_v, i) => i % 2 === 0)
          .filter(name => name.toLowerCase() === 'idempotency-key').length;
        if (occurrences !== 1 || !key.safeParse(request.headers['idempotency-key']).success) invalid();
      },
    ] }, async request => {
      const p = params.safeParse(request.params), b = body.safeParse(request.body);
      if (!p.success || !b.success) invalid();
      const input = validatePostApprovalRoomIssueHandover({ ...p.data, ...b.data });
      const result = projectPostApprovalRoomIssueUpload(await service.recover(request.actor, input, request.headers['idempotency-key']));
      if (result.operationId !== input.operationId || result.leaseVersion <= input.expectedLeaseVersion) {
        throw new AppError(500, 'POST_APPROVAL_ROOM_ISSUE_EVIDENCE_PROJECTION_INVALID', '인계 응답을 확인해 주세요.');
      }
      return result;
    });
  };
}
