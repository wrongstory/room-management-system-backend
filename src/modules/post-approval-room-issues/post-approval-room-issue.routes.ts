import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/app-error.js';
import { validatePostApprovalRoomIssueDraft, validatePostApprovalRoomIssueFinalization } from './post-approval-room-issue-contract.js';
import type { PostApprovalRoomIssueService } from './post-approval-room-issue.service.js';

export const POST_APPROVAL_ROOM_ISSUE_BODY_MAX_BYTES = 8192;
export const POST_APPROVAL_ROOM_ISSUE_BASE_PATH = '/v1/cleaning-history/submissions/:sourceSubmissionId/supplemental-room-issues';
export const postApprovalRoomIssueHttpErrorStatuses: Readonly<Record<string, number>> = Object.freeze({
  VALIDATION_ERROR: 400, INVALID_POST_APPROVAL_ROOM_ISSUE: 400,
  MISSING_ACCESS_TOKEN: 401, INVALID_ACCESS_TOKEN: 401, PROFILE_NOT_FOUND: 401, SESSION_REVOKED: 401,
  ADMIN_REQUIRED: 403, PASSWORD_CHANGE_REQUIRED: 403, ACCOUNT_INACTIVE: 403, CAPABILITY_ACCESS_REQUIRED: 403,
  POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED: 403, POST_APPROVAL_ROOM_ISSUE_SOURCE_UNAVAILABLE: 409,
  POST_APPROVAL_ROOM_ISSUE_DRAFT_CONFLICT: 409, POST_APPROVAL_ROOM_ISSUE_REPORT_SEALED: 409,
  POST_APPROVAL_ROOM_ISSUE_EVIDENCE_INVALID: 409, IDEMPOTENCY_KEY_REUSED: 409,
  POST_APPROVAL_ROOM_ISSUE_BODY_TOO_LARGE: 413, POST_APPROVAL_ROOM_ISSUE_MEDIA_TYPE_INVALID: 415,
  POST_APPROVAL_ROOM_ISSUE_COMMAND_FAILED: 500, POST_APPROVAL_ROOM_ISSUE_PROJECTION_INVALID: 500
});
function invalid(): never { throw new AppError(400, 'VALIDATION_ERROR', '사후 특이사항 보고 요청을 확인해 주세요.'); }
function sourceId(request: FastifyRequest): string {
  const parsed = z.object({ sourceSubmissionId: z.uuid() }).strict().safeParse(request.params);
  if (!parsed.success) invalid();
  return parsed.data.sourceSubmissionId.toLowerCase();
}
function input(request: FastifyRequest): unknown {
  const body = request.body;
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.hasOwn(body, 'sourceSubmissionId')) invalid();
  // The path is the sole source selector. Strict domain validation rejects every other extra key.
  return { ...body, sourceSubmissionId: sourceId(request) };
}
function key(request: FastifyRequest): unknown {
  const names = request.raw.rawHeaders.filter((_value, index) => index % 2 === 0)
    .filter((name) => name.toLowerCase() === 'idempotency-key');
  if (names.length !== 1) invalid();
  return request.headers['idempotency-key'];
}

/** Isolated HTTP implementation; deliberately unregistered until DB/upload/retention/outbox gates pass. */
export function createPostApprovalRoomIssueRoutes(service: PostApprovalRoomIssueService): FastifyPluginAsync {
  return async (app) => {
    app.addHook('onRequest', async (request, reply) => {
      reply.header('cache-control', 'no-store');
      if (new URL(request.raw.url ?? '/', 'http://backend.internal').searchParams.size !== 0) invalid();
    });
    app.setErrorHandler((error, request, reply) => {
      let code = 'POST_APPROVAL_ROOM_ISSUE_COMMAND_FAILED';
      try {
        const errorCode = error && typeof error === 'object' && 'code' in error ? error.code : null;
        if (error instanceof AppError && typeof errorCode === 'string' && Object.hasOwn(postApprovalRoomIssueHttpErrorStatuses, errorCode)) code = errorCode;
        else if (errorCode === 'FST_ERR_CTP_BODY_TOO_LARGE') code = 'POST_APPROVAL_ROOM_ISSUE_BODY_TOO_LARGE';
        else if (errorCode === 'FST_ERR_CTP_INVALID_JSON_BODY' || errorCode === 'FST_ERR_CTP_EMPTY_JSON_BODY' || errorCode === 'FST_ERR_CTP_INVALID_CONTENT_LENGTH') code = 'VALIDATION_ERROR';
        else if (errorCode === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') code = 'POST_APPROVAL_ROOM_ISSUE_MEDIA_TYPE_INVALID';
      } catch { /* Untrusted getters and raw exceptions must not escape. */ }
      return reply.code(postApprovalRoomIssueHttpErrorStatuses[code] ?? 500).header('cache-control', 'no-store')
        .send({ error: { code, message: '사후 특이사항 보고 요청을 처리하지 못했습니다.' },
          requestId: z.uuid().safeParse(request.id).success ? request.id : 'unavailable' });
    });
    const preHandler = [app.authenticate, app.requirePasswordChanged, async (request: FastifyRequest) => {
      if (request.actor.role !== 'maid' && request.actor.role !== 'admin') {
        throw new AppError(403, 'POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED', '본인 수행 이력 또는 관리자 권한이 필요합니다.');
      }
    }];
    const options = { preHandler, bodyLimit: POST_APPROVAL_ROOM_ISSUE_BODY_MAX_BYTES, logLevel: 'silent' as const };
    app.get(`${POST_APPROVAL_ROOM_ISSUE_BASE_PATH}/source`, options, async (request) => {
      if (request.body !== undefined) invalid();
      return service.source(request.actor, sourceId(request));
    });
    app.get(POST_APPROVAL_ROOM_ISSUE_BASE_PATH, options, async request => {
      if (request.body !== undefined) invalid();
      return service.list(request.actor, sourceId(request));
    });
    app.post(`${POST_APPROVAL_ROOM_ISSUE_BASE_PATH}/drafts`, options, async (request) => {
      const body = validatePostApprovalRoomIssueDraft(input(request));
      return service.saveDraft(request.actor, body, key(request));
    });
    app.get(`${POST_APPROVAL_ROOM_ISSUE_BASE_PATH}/drafts/:clientReportId`, options, async request => {
      if (request.body !== undefined) invalid();
      const ids = z.object({ sourceSubmissionId: z.uuid(), clientReportId: z.uuid() }).strict().safeParse(request.params);
      if (!ids.success) invalid();
      return service.draft(request.actor, ids.data.sourceSubmissionId.toLowerCase(), ids.data.clientReportId.toLowerCase());
    });
    app.post(POST_APPROVAL_ROOM_ISSUE_BASE_PATH, options, async (request, reply) => {
      const body = validatePostApprovalRoomIssueFinalization(input(request));
      return reply.code(201).send(await service.finalize(request.actor, body, key(request)));
    });
    const reportIds = (request: FastifyRequest) => {
      const result = z.object({ sourceSubmissionId: z.uuid(), reportId: z.uuid() }).strict().safeParse(request.params);
      if (!result.success) invalid();
      return { sourceSubmissionId: result.data.sourceSubmissionId.toLowerCase(), reportId: result.data.reportId.toLowerCase() };
    };
    app.get(`${POST_APPROVAL_ROOM_ISSUE_BASE_PATH}/:reportId`, options, async (request) => {
      if (request.body !== undefined) invalid();
      const ids = reportIds(request);
      return service.report(request.actor, ids.sourceSubmissionId, ids.reportId);
    });
    app.post(`${POST_APPROVAL_ROOM_ISSUE_BASE_PATH}/:reportId/close`, options, async (request) => {
      const ids = reportIds(request), body = z.object({ expectedClosureRevision: z.literal(0) }).strict().safeParse(request.body);
      if (!body.success) invalid();
      return service.close(request.actor, { ...ids, ...body.data }, key(request));
    });
  };
}
