import { Readable } from 'node:stream';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/app-error.js';
import { PHOTO_INPUT_MAX_BYTES, PHOTO_MAX_BYTES } from '../photos/photo-binary.js';
import { projectPostApprovalRoomIssueUpload, validatePostApprovalRoomIssueUpload } from './post-approval-room-issue-upload-contract.js';
import type { SupabasePostApprovalRoomIssueEvidenceService } from './post-approval-room-issue-evidence.service.js';

export const POST_APPROVAL_ROOM_ISSUE_EVIDENCE_UPLOAD_PATH = '/v1/cleaning-history/submissions/:sourceSubmissionId/supplemental-room-issues/drafts/:clientReportId/evidence/:evidenceId/upload';
export const POST_APPROVAL_ROOM_ISSUE_EVIDENCE_STATUS_PATH = '/v1/post-approval-room-issue-evidence-uploads/:operationId';
export const POST_APPROVAL_ROOM_ISSUE_EVIDENCE_CONTENT_PATH = '/v1/post-approval-room-issue-evidence/:evidenceId/versions/:revision/content';
export type PostApprovalRoomIssueEvidenceHttpService = Pick<SupabasePostApprovalRoomIssueEvidenceService, 'upload' | 'status' | 'content'>;
const id = z.uuid().transform(value => value.toLowerCase());
const uploadParams = z.object({ sourceSubmissionId: id, clientReportId: id, evidenceId: id }).strict();
const statusParams = z.object({ operationId: id }).strict();
const contentParams = z.object({ evidenceId: id, revision: z.string() }).strict();
export const postApprovalRoomIssueEvidenceHttpErrorStatuses: Readonly<Record<string, number>> = Object.freeze({
  VALIDATION_ERROR: 400, INVALID_POST_APPROVAL_ROOM_ISSUE: 400, INVALID_PHOTO_BINARY: 400,
  MISSING_ACCESS_TOKEN: 401, INVALID_ACCESS_TOKEN: 401, PROFILE_NOT_FOUND: 401, SESSION_REVOKED: 401, AUTH_CONTEXT_UNAVAILABLE: 503,
  PASSWORD_CHANGE_REQUIRED: 403, ACCOUNT_INACTIVE: 403, ADMIN_REQUIRED: 403, CAPABILITY_ACCESS_REQUIRED: 403,
  POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED: 403, POST_APPROVAL_ROOM_ISSUE_SOURCE_UNAVAILABLE: 409,
  POST_APPROVAL_ROOM_ISSUE_DRAFT_CONFLICT: 409, POST_APPROVAL_ROOM_ISSUE_EVIDENCE_CONFLICT: 409,
  POST_APPROVAL_ROOM_ISSUE_REPORT_SEALED: 409, POST_APPROVAL_ROOM_ISSUE_EVIDENCE_INVALID: 409,
  POST_APPROVAL_ROOM_ISSUE_UPLOAD_NOT_ACCEPTED: 409, IDEMPOTENCY_KEY_REUSED: 409,
  PHOTO_UPLOAD_ADMISSION_EXPIRED: 409, PHOTO_UPLOAD_FENCE_CONFLICT: 409,
  PHOTO_UPLOAD_TIME_INVALID: 409, PHOTO_PROVIDER_IDENTITY_CONFLICT: 409,
  POST_APPROVAL_ROOM_ISSUE_MEDIA_PURGED: 410, PHOTO_BODY_TIMEOUT: 408,
  PHOTO_TOO_LARGE: 413, PHOTO_DECODE_LIMIT_EXCEEDED: 413, PHOTO_MEDIA_TYPE_UNSUPPORTED: 415,
  PHOTO_UPLOAD_RATE_LIMITED: 429, PHOTO_UPLOAD_LIMIT_EXCEEDED: 429,
  PHOTO_STORAGE_QUOTA_EXCEEDED: 503, PHOTO_STORAGE_QUOTA_UNAVAILABLE: 503, PHOTO_DECODER_UNAVAILABLE: 503,
  POST_APPROVAL_ROOM_ISSUE_EVIDENCE_RETRY_REQUIRED: 503,
  POST_APPROVAL_ROOM_ISSUE_EVIDENCE_COMMAND_FAILED: 500, POST_APPROVAL_ROOM_ISSUE_EVIDENCE_PROJECTION_INVALID: 500
});
function invalid(): never { throw new AppError(400, 'VALIDATION_ERROR', '증빙 요청 조건을 확인해 주세요.'); }
function singleHeader(request: FastifyRequest, name: string, required = true): string | null {
  const occurrences = request.raw.rawHeaders.filter((_value, index) => index % 2 === 0)
    .filter(value => value.toLowerCase() === name).length;
  if (occurrences > 1 || (required && occurrences !== 1)) invalid();
  const value = request.headers[name];
  if (value === undefined && !required) return null;
  if (typeof value !== 'string') invalid();
  return value;
}
function decimal(value: unknown, min: number): number {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) invalid();
  const integer = Number(value);
  if (!Number.isSafeInteger(integer) || integer < min) invalid();
  return integer;
}
function parameters<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value); if (!parsed.success) invalid(); return parsed.data;
}
function noBody(request: FastifyRequest): void {
  const length = singleHeader(request, 'content-length', false);
  if (request.body !== undefined || request.headers['transfer-encoding'] !== undefined
    || (length !== null && decimal(length, 0) !== 0)) invalid();
}
function projectionFailure(): never {
  throw new AppError(500, 'POST_APPROVAL_ROOM_ISSUE_EVIDENCE_PROJECTION_INVALID', '증빙 응답을 확인하지 못했습니다.');
}
/** Isolated candidate only: it must not be registered before typed SQL, independent QA and actual DB gates. */
export function createPostApprovalRoomIssueEvidenceRoutes(service: PostApprovalRoomIssueEvidenceHttpService): FastifyPluginAsync {
  return async app => {
    // Encapsulated stream parser: no JSON, multipart, base64, decoder or buffering before admission.
    app.removeAllContentTypeParsers();
    app.addContentTypeParser('*', (_request, payload, done) => done(null, payload));
    app.addHook('onRequest', async (_request, reply) => { reply.header('cache-control', 'no-store'); });
    app.setErrorHandler((error, request, reply) => {
      let code = 'POST_APPROVAL_ROOM_ISSUE_EVIDENCE_COMMAND_FAILED';
      try {
        if (error instanceof AppError && Object.hasOwn(postApprovalRoomIssueEvidenceHttpErrorStatuses, error.code)) code = error.code;
        else if (error && typeof error === 'object' && 'code' in error) {
          if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') code = 'PHOTO_TOO_LARGE';
          else if (error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') code = 'PHOTO_MEDIA_TYPE_UNSUPPORTED';
          else if (['FST_ERR_CTP_INVALID_CONTENT_LENGTH', 'FST_ERR_CTP_INVALID_JSON_BODY', 'FST_ERR_CTP_EMPTY_JSON_BODY'].includes(String(error.code))) code = 'VALIDATION_ERROR';
        }
      } catch { /* Never expose exception/getter values, SQL, locator, token, PIN or extra headers. */ }
      const requestId = typeof request.id === 'string' && z.uuid().safeParse(request.id).success ? request.id.toLowerCase() : 'unavailable';
      return reply.code(postApprovalRoomIssueEvidenceHttpErrorStatuses[code] ?? 500).header('cache-control', 'no-store')
        .send({ error: { code, message: '사후 특이사항 증빙 조건을 확인해 주세요.' }, requestId });
    });
    const onRequest = [app.authenticate, app.requirePasswordChanged, async (request: FastifyRequest) => {
      if (request.actor.role !== 'maid' && request.actor.role !== 'admin') {
        throw new AppError(403, 'POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED', '본인 수행 이력 또는 관리자 권한이 필요합니다.');
      }
      if ((request.raw.url ?? '').includes('?')) invalid();
      if (request.method !== 'POST') noBody(request);
    }];
    const options = { onRequest, bodyLimit: PHOTO_INPUT_MAX_BYTES, logLevel: 'silent' as const, exposeHeadRoute: false };
    app.post(POST_APPROVAL_ROOM_ISSUE_EVIDENCE_UPLOAD_PATH, options, async request => {
      const params = parameters(uploadParams, request.params);
      const input = validatePostApprovalRoomIssueUpload({ ...params,
        expectedDraftRevision: decimal(singleHeader(request, 'if-draft-revision'), 1),
        expectedEvidenceRevision: decimal(singleHeader(request, 'if-evidence-revision'), 0),
        expectedItemRevision: decimal(singleHeader(request, 'if-item-revision'), 0) });
      const key = singleHeader(request, 'idempotency-key');
      if (key === null || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) invalid();
      const contentLength = singleHeader(request, 'content-length', false), contentType = singleHeader(request, 'content-type', false);
      const result = projectPostApprovalRoomIssueUpload(await service.upload(request.actor, input, key, async () => {
        if (!(request.body instanceof Readable)) invalid();
        return { stream: Readable.toWeb(request.body) as ReadableStream<Uint8Array>, contentLength, contentType };
      }));
      if (result.evidenceId !== params.evidenceId) projectionFailure();
      return result;
    });
    app.get(POST_APPROVAL_ROOM_ISSUE_EVIDENCE_STATUS_PATH, options, async request => {
      const params = parameters(statusParams, request.params);
      const result = projectPostApprovalRoomIssueUpload(await service.status(request.actor, params.operationId));
      if (result.operationId !== params.operationId) projectionFailure();
      return result;
    });
    app.get(POST_APPROVAL_ROOM_ISSUE_EVIDENCE_CONTENT_PATH, options, async (request, reply) => {
      const params = parameters(contentParams, request.params), revision = decimal(params.revision, 1);
      const result = await service.content(request.actor, params.evidenceId, revision);
      if (!(result.bytes instanceof Uint8Array) || result.bytes.byteLength < 1 || result.bytes.byteLength > PHOTO_MAX_BYTES
        || (result.mimeType !== 'image/jpeg' && result.mimeType !== 'image/webp')) projectionFailure();
      return reply.header('content-type', result.mimeType).header('cache-control', 'no-store').send(Buffer.from(result.bytes));
    });
  };
}
