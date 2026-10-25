import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Actor } from '../../domain/actor.js';
import { AppError } from '../../lib/app-error.js';
import { requestHash } from '../../lib/command.js';
import type { DriveObject, DriveReadObject, PhotoProvider } from '../photos/google-drive.js';
import { PhotoError, PHOTO_INPUT_MAX_BYTES, photoMime, readPhotoBody, verifyPhotoBinary } from '../photos/photo-binary.js';
import {
  POST_APPROVAL_ROOM_ISSUE_UPLOAD_MAX_BYTES, preparePostApprovalRoomIssueUpload,
  preparePostApprovalRoomIssueUploadKey, projectPostApprovalRoomIssueUpload,
  type PostApprovalRoomIssueUploadActor, type PostApprovalRoomIssueUploadMetadata,
  type PostApprovalRoomIssueUploadOperation, type PreparedPostApprovalRoomIssueUpload
} from './post-approval-room-issue-upload-contract.js';

export interface PostApprovalRoomIssueEvidenceRpc {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}
export interface PostApprovalRoomIssueEvidenceBody {
  stream: ReadableStream<Uint8Array> | null;
  contentLength: string | null;
  contentType: string | null;
}
export type PostApprovalRoomIssueEvidenceBodyReader = () => Promise<PostApprovalRoomIssueEvidenceBody>;
const locator = z.string().regex(/^[A-Za-z0-9_-]{10,200}$/);
const id = z.uuid().transform(value => value.toLowerCase());
const metadataShape = { mimeType: z.enum(['image/jpeg', 'image/webp']),
  sizeBytes: z.int().min(1).max(POST_APPROVAL_ROOM_ISSUE_UPLOAD_MAX_BYTES), sha256: z.string().regex(/^[0-9a-f]{64}$/) };
const providerSchema = z.object({ objectId: id, fileId: locator.nullable(), folderId: locator.nullable(),
  fileName: z.string(), uploadDate: z.iso.date(), roomNumber: z.string().regex(/^\d{3}$/), ...metadataShape
}).refine(value => (value.fileId === null) === (value.folderId === null)).refine(value => {
  const extension = value.mimeType === 'image/jpeg' ? 'jpg' : 'webp';
  return new RegExp(`^${value.uploadDate}_특이사항_${value.roomNumber}_(?:0[1-9]|[1-9][0-9]+)\\.${extension}$`).test(value.fileName);
});
const admissionSchema = z.object({ admissionId: id, expiresAt: z.iso.datetime({ offset: true }),
  reservedBytes: z.literal(POST_APPROVAL_ROOM_ISSUE_UPLOAD_MAX_BYTES), quotaWarning: z.boolean() });
const quotaPermitSchema = z.object({ permitId: id, expiresAt: z.iso.datetime({ offset: true }) });
const quotaSchema = z.object({ refreshStartedAt: z.iso.datetime({ offset: true }), usageBytes: z.string().regex(/^(?:0|[1-9][0-9]{0,15})$/)
  .refine(value => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER)) });
const folderSchema = z.object({ folderId: locator, parentFolderId: locator, name: z.string() });
const deleteSchema = z.object({ deleteToken: id, objectId: id, fileId: locator });
const candidateSchema = z.tuple([locator, locator, locator]).refine(value => new Set(value).size === 3);
const readSchema = z.object({ fileId: locator, ...metadataShape });
const contentInputSchema = z.object({ evidenceId: id, revision: z.int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict();
type ProviderContext = z.infer<typeof providerSchema>;
const messages: Readonly<Record<string, number>> = {
  SESSION_REVOKED: 401, PASSWORD_CHANGE_REQUIRED: 403, ADMIN_REQUIRED: 403, CAPABILITY_ACCESS_REQUIRED: 403,
  POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED: 403, POST_APPROVAL_ROOM_ISSUE_SOURCE_UNAVAILABLE: 409,
  POST_APPROVAL_ROOM_ISSUE_DRAFT_CONFLICT: 409, POST_APPROVAL_ROOM_ISSUE_EVIDENCE_CONFLICT: 409,
  POST_APPROVAL_ROOM_ISSUE_REPORT_SEALED: 409, POST_APPROVAL_ROOM_ISSUE_EVIDENCE_INVALID: 409,
  POST_APPROVAL_ROOM_ISSUE_MEDIA_PURGED: 410,
  POST_APPROVAL_ROOM_ISSUE_DELETE_NOT_ALLOWED: 409,
  PHOTO_UPLOAD_RATE_LIMITED: 429, PHOTO_UPLOAD_LIMIT_EXCEEDED: 429,
  PHOTO_STORAGE_QUOTA_EXCEEDED: 503, PHOTO_STORAGE_QUOTA_UNAVAILABLE: 503,
  PHOTO_UPLOAD_ADMISSION_EXPIRED: 409, PHOTO_UPLOAD_FENCE_CONFLICT: 409,
  PHOTO_UPLOAD_TIME_INVALID: 409, PHOTO_PROVIDER_IDENTITY_CONFLICT: 409,
  IDEMPOTENCY_KEY_REUSED: 409, INVALID_POST_APPROVAL_ROOM_ISSUE: 400
};
export function postApprovalRoomIssueEvidenceDatabaseError(error: unknown): AppError {
  let code: unknown = null;
  try { if (error && typeof error === 'object' && 'message' in error) code = error.message; } catch { /* Redacted getter errors. */ }
  return typeof code === 'string' && Object.hasOwn(messages, code)
    ? new AppError(messages[code] ?? 500, code, '사후 특이사항 증빙 조건을 확인해 주세요.')
    : new AppError(500, 'POST_APPROVAL_ROOM_ISSUE_EVIDENCE_COMMAND_FAILED', '증빙을 처리하지 못했습니다.');
}
function unavailable(): AppError {
  return new AppError(503, 'POST_APPROVAL_ROOM_ISSUE_EVIDENCE_RETRY_REQUIRED', '같은 요청으로 증빙 상태를 다시 확인해 주세요.');
}
function projection<T>(schema: z.ZodType<T>, value: unknown): T {
  try { const parsed = schema.safeParse(value); if (parsed.success) return parsed.data; } catch { /* Redacted. */ }
  throw new AppError(500, 'POST_APPROVAL_ROOM_ISSUE_EVIDENCE_PROJECTION_INVALID', '증빙 응답을 확인하지 못했습니다.');
}
export function postApprovalRoomIssueEvidenceActorContext(actor: Actor): PostApprovalRoomIssueUploadActor {
  if (actor.mustChangePassword) throw new AppError(403, 'PASSWORD_CHANGE_REQUIRED', '비밀번호 변경이 필요합니다.');
  if (actor.role !== 'maid' && actor.role !== 'admin') {
    throw new AppError(403, 'POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED', '본인 수행 이력 또는 관리자 권한이 필요합니다.');
  }
  try {
    // The app must verify authentication first. This extracts the bound session, never verifies a JWT.
    const parts = actor.accessToken.split('.'); if (parts.length !== 3) throw new Error();
    const claims: unknown = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'));
    return Object.freeze({ actorProfileId: id.parse(actor.profileId),
      sessionId: z.object({ session_id: id }).parse(claims).session_id });
  } catch { throw new AppError(401, 'INVALID_ACCESS_TOKEN', '로그인이 필요합니다.'); }
}
const context = postApprovalRoomIssueEvidenceActorContext;
function actorArgs(actor: PostApprovalRoomIssueUploadActor) {
  return { p_actor_profile_id: actor.actorProfileId, p_session_id: actor.sessionId };
}
function sameMetadata(left: PostApprovalRoomIssueUploadMetadata, right: PostApprovalRoomIssueUploadMetadata): boolean {
  return left.mimeType === right.mimeType && left.sizeBytes === right.sizeBytes && left.sha256 === right.sha256;
}
function privateObject(value: ProviderContext): DriveObject {
  if (value.fileId === null || value.folderId === null) throw unavailable();
  return { objectId: value.objectId, fileId: value.fileId, folderId: value.folderId,
    fileName: value.fileName, mime: value.mimeType, sizeBytes: value.sizeBytes, sha256: value.sha256 };
}
function binaryError(error: unknown): AppError {
  const known: Readonly<Record<string, number>> = { INVALID_PHOTO_BINARY: 400, PHOTO_BODY_TIMEOUT: 408,
    PHOTO_TOO_LARGE: 413, PHOTO_DECODE_LIMIT_EXCEEDED: 413, PHOTO_MEDIA_TYPE_UNSUPPORTED: 415, PHOTO_DECODER_UNAVAILABLE: 503 };
  return error instanceof PhotoError && Object.hasOwn(known, error.code) && known[error.code] === error.statusCode
    ? new AppError(error.statusCode, error.code, '사진 형식과 크기를 확인해 주세요.') : unavailable();
}

/** Unregistered server module. No caller can submit an accepted receipt or a provider locator. */
export class SupabasePostApprovalRoomIssueEvidenceService {
  constructor(private readonly db: PostApprovalRoomIssueEvidenceRpc,
    private readonly provider: () => PhotoProvider, private readonly initializeDecoder: () => Promise<void>) {}
  private async rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      const result = await this.db.rpc(name, args);
      if (result.error) throw postApprovalRoomIssueEvidenceDatabaseError(result.error);
      return result.data;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw postApprovalRoomIssueEvidenceDatabaseError(null);
    }
  }
  private operation(value: unknown, command: PreparedPostApprovalRoomIssueUpload, operationId?: string) {
    const result = projectPostApprovalRoomIssueUpload(value);
    if (result.evidenceId !== command.input.evidenceId || !sameMetadata(result, command.metadata)
      || (operationId !== undefined && result.operationId !== operationId)
      || result.itemRevision !== command.input.expectedItemRevision + (result.status === 'accepted' ? 1 : 0)
      || result.evidenceRevision !== command.input.expectedEvidenceRevision + (result.status === 'accepted' ? 1 : 0)) {
      throw new AppError(500, 'POST_APPROVAL_ROOM_ISSUE_EVIDENCE_PROJECTION_INVALID', '증빙 응답 identity를 확인하지 못했습니다.');
    }
    return result;
  }
  private fence(actor: PostApprovalRoomIssueUploadActor, operationId: string) {
    return createHash('sha256').update(`${actor.actorProfileId}:post-approval-evidence:${operationId}:`)
      .update(randomBytes(32)).digest('hex');
  }
  private leaseArgs(command: PreparedPostApprovalRoomIssueUpload, op: PostApprovalRoomIssueUploadOperation, fence: string) {
    return { ...actorArgs(command.actor), p_operation_id: op.operationId,
      p_lease_version: op.leaseVersion, p_fence_token_digest: fence };
  }
  private async renew(command: PreparedPostApprovalRoomIssueUpload, op: PostApprovalRoomIssueUploadOperation, fence: string) {
    const renewed = this.operation(await this.rpc('renew_post_approval_room_issue_evidence_upload',
      this.leaseArgs(command, op, fence)), command, op.operationId);
    if (renewed.leaseVersion !== op.leaseVersion || renewed.status !== op.status) throw unavailable();
    return renewed;
  }
  private async providerContext(command: PreparedPostApprovalRoomIssueUpload, op: PostApprovalRoomIssueUploadOperation, fence: string, expected?: ProviderContext) {
    const value = projection(providerSchema, await this.rpc('get_post_approval_room_issue_evidence_provider_context',
      this.leaseArgs(command, op, fence)));
    if (!sameMetadata(value, command.metadata) || (expected !== undefined && (
      value.objectId !== expected.objectId || value.fileName !== expected.fileName || value.uploadDate !== expected.uploadDate
      || value.roomNumber !== expected.roomNumber || (expected.fileId !== null && value.fileId !== expected.fileId)
      || (expected.folderId !== null && value.folderId !== expected.folderId)))) throw unavailable();
    return value;
  }
  async upload(actor: Actor, input: unknown, rawKey: unknown, readBody: PostApprovalRoomIssueEvidenceBodyReader): Promise<PostApprovalRoomIssueUploadOperation> {
    const key = preparePostApprovalRoomIssueUploadKey(context(actor), input, rawKey), value = key.input;
    const args = {
      ...actorArgs(key.actor), p_source_submission_id: value.sourceSubmissionId, p_client_report_id: value.clientReportId,
      p_evidence_id: value.evidenceId, p_expected_draft_revision: value.expectedDraftRevision,
      p_expected_evidence_revision: value.expectedEvidenceRevision, p_expected_item_revision: value.expectedItemRevision,
      p_idempotency_key_digest: key.idempotencyKeyDigest
    };
    let admitted: unknown;
    try { admitted = await this.rpc('admit_post_approval_room_issue_evidence_upload', args); }
    catch (error) {
      if (!(error instanceof AppError) || error.code !== 'PHOTO_STORAGE_QUOTA_UNAVAILABLE') throw error;
      // Durable per-request gate couples CPU charge with the later admission.
      // The stale attempt rolled back; this permit is charged ONCE, never twice.
      const permit = projection(quotaPermitSchema, await this.rpc('admit_post_approval_room_issue_quota_refresh', {
        ...args, p_gate_request_digest: requestHash({ actorProfileId: key.actor.actorProfileId, quotaReadNonce: randomUUID() })
      }));
      let quota: z.infer<typeof quotaSchema>;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { quota = projection(quotaSchema, await Promise.race([
        this.provider().quota(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(unavailable()), 10_000); })
      ])); } catch { throw unavailable(); } finally { if (timer) clearTimeout(timer); }
      projection(z.object({ refreshed: z.literal(true) }), await this.rpc('refresh_post_approval_room_issue_quota', {
        ...actorArgs(key.actor), p_permit_id: permit.permitId, p_refresh_started_at: quota.refreshStartedAt, p_usage_bytes: quota.usageBytes
      }));
      admitted = await this.rpc('admit_post_approval_room_issue_evidence_upload', { ...args, p_quota_refresh_permit_id: permit.permitId });
    }
    const admission = projection(admissionSchema, admitted);
    let normalized: Awaited<ReturnType<typeof verifyPhotoBinary>>;
    try {
      const body = await readBody(), mime = photoMime(body.contentType);
      const bytes = await readPhotoBody(body.stream, body.contentLength, PHOTO_INPUT_MAX_BYTES);
      await this.initializeDecoder(); normalized = await verifyPhotoBinary(bytes, mime);
    } catch (error) { throw binaryError(error); }
    if (normalized.bytes.length !== normalized.sizeBytes
      || createHash('sha256').update(normalized.bytes).digest('hex') !== normalized.sha256) throw unavailable();
    const command = preparePostApprovalRoomIssueUpload(key, {
      sha256: normalized.sha256, mimeType: normalized.mime, sizeBytes: normalized.sizeBytes
    });
    let op = this.operation(await this.rpc('begin_post_approval_room_issue_evidence_upload', {
      ...actorArgs(command.actor), p_admission_id: admission.admissionId, p_sha256: command.metadata.sha256,
      p_mime_type: command.metadata.mimeType, p_size_bytes: command.metadata.sizeBytes,
      p_idempotency_key_digest: command.idempotencyKeyDigest, p_request_hash: command.requestHash
    }), command);
    if (op.status === 'accepted') return op;
    if (op.status === 'compensated') throw new AppError(409, 'POST_APPROVAL_ROOM_ISSUE_UPLOAD_NOT_ACCEPTED', '미수락 업로드가 정리되었습니다.');
    const fence = this.fence(command.actor, op.operationId);
    op = this.operation(await this.rpc('claim_post_approval_room_issue_evidence_upload', {
      ...actorArgs(command.actor), p_operation_id: op.operationId, p_fence_token_digest: fence
    }), command, op.operationId);
    if (op.status === 'accepted') return op;
    if (op.leaseVersion < 1) throw unavailable();
    if (op.status === 'compensation_pending') return this.compensate(command, op, fence);
    let providerContext = await this.providerContext(command, op, fence);
    const provider = this.provider();
    if (providerContext.fileId === null) {
      await this.renew(command, op, fence);
      let candidates: [string, string, string];
      try { candidates = projection(candidateSchema, await provider.generateUploadIds()); } catch { throw unavailable(); }
      await this.renew(command, op, fence);
      const [fileId, dateId, roomId] = candidates;
      const root = projection(locator, provider.rootFolderId());
      let dateFolder: string | undefined;
      for (const [scope, candidate] of [['date', dateId], ['room', roomId]] as const) {
        const folder = projection(folderSchema, await this.rpc('reserve_post_approval_room_issue_evidence_folder', {
          ...this.leaseArgs(command, op, fence), p_scope: scope, p_root_folder_id: root, p_candidate_folder_id: candidate
        }));
        if (folder.name !== (scope === 'date' ? providerContext.uploadDate : providerContext.roomNumber)
          || folder.parentFolderId !== (scope === 'date' ? root : dateFolder)) throw unavailable();
        await this.providerContext(command, op, fence, providerContext);
        try { await provider.ensureFolder(folder); } catch { throw unavailable(); }
        await this.renew(command, op, fence);
        if (scope === 'date') dateFolder = folder.folderId;
        if (scope === 'room') {
          const reserved = projection(providerSchema, await this.rpc('reserve_post_approval_room_issue_evidence_identity', {
            ...this.leaseArgs(command, op, fence), p_provider_file_id: fileId, p_provider_folder_id: folder.folderId
          }));
          if (!sameMetadata(reserved, command.metadata) || reserved.objectId !== providerContext.objectId
            || reserved.fileName !== providerContext.fileName || reserved.uploadDate !== providerContext.uploadDate
            || reserved.roomNumber !== providerContext.roomNumber) throw unavailable();
          providerContext = reserved;
        }
      }
    }
    // A lost create/record/finalize response is uncertain, never proof that deletion is safe.
    try {
      providerContext = await this.providerContext(command, op, fence, providerContext);
      let uploadedAt: string;
      if (op.status === 'reconciliation_pending' || op.status === 'provider_succeeded') {
        uploadedAt = (await provider.inspect(privateObject(providerContext))).uploadedAt;
      } else {
        op = this.operation(await this.rpc('prepare_post_approval_room_issue_evidence_provider_write',
          this.leaseArgs(command, op, fence)), command, op.operationId);
        if (op.status !== 'reconciliation_pending') throw unavailable();
        uploadedAt = (await provider.upload(privateObject(providerContext), normalized.bytes)).uploadedAt;
      }
      await this.renew(command, op, fence);
      op = this.operation(await this.rpc('record_post_approval_room_issue_evidence_provider_success', {
        ...this.leaseArgs(command, op, fence), p_uploaded_at: projection(z.iso.datetime({ offset: true }), uploadedAt)
      }), command, op.operationId);
      if (op.status === 'compensation_pending') return await this.compensate(command, op, fence);
      return await this.finish(command, op, fence);
    } catch (error) {
      if (error instanceof AppError && (error.statusCode < 500 || error.code.endsWith('PROJECTION_INVALID'))) throw error;
      return this.reconcile(command, op, fence, providerContext);
    }
  }
  private async finish(command: PreparedPostApprovalRoomIssueUpload, op: PostApprovalRoomIssueUploadOperation, fence: string) {
    const finalized = this.operation(await this.rpc('finalize_post_approval_room_issue_evidence_upload',
      this.leaseArgs(command, op, fence)), command, op.operationId);
    if (finalized.status !== 'accepted') throw unavailable();
    return finalized;
  }
  private async reconcile(command: PreparedPostApprovalRoomIssueUpload, op: PostApprovalRoomIssueUploadOperation, fence: string,
    expectedContext: ProviderContext): Promise<PostApprovalRoomIssueUploadOperation> {
    // Read persisted status first: a successful acceptance may merely have lost its response.
    let current = this.operation(await this.rpc('get_post_approval_room_issue_evidence_upload', {
      ...actorArgs(command.actor), p_operation_id: op.operationId
    }), command, op.operationId);
    if (current.status === 'accepted') return current;
    if (current.status === 'compensated') throw new AppError(409, 'POST_APPROVAL_ROOM_ISSUE_UPLOAD_NOT_ACCEPTED', '미수락 업로드가 정리되었습니다.');
    if (current.status === 'compensation_pending') return this.compensate(command, current, fence);
    try {
      // Make uncertainty durable BEFORE inspect. Reconciliation can only read
      // this exact bound identity; it cannot allocate or write with stale draft CAS.
      if (current.status === 'reserved') current = this.operation(await this.rpc('mark_post_approval_room_issue_evidence_unknown',
        this.leaseArgs(command, current, fence)), command, op.operationId);
      const saved = await this.providerContext(command, current, fence, expectedContext);
      const observed = await this.provider().inspect(privateObject(saved));
      await this.renew(command, current, fence);
      current = this.operation(await this.rpc('record_post_approval_room_issue_evidence_provider_success', {
        ...this.leaseArgs(command, current, fence), p_uploaded_at: projection(z.iso.datetime({ offset: true }), observed.uploadedAt)
      }), command, op.operationId);
      if (current.status === 'compensation_pending') return await this.compensate(command, current, fence);
      return await this.finish(command, current, fence);
    } catch (error) {
      if (error instanceof AppError && (error.statusCode < 500 || error.code.endsWith('PROJECTION_INVALID'))) throw error;
      if (current.status === 'compensation_pending') throw unavailable();
      this.operation(await this.rpc('mark_post_approval_room_issue_evidence_unknown',
        this.leaseArgs(command, current, fence)), command, op.operationId);
      throw unavailable();
    }
  }
  private async compensate(command: PreparedPostApprovalRoomIssueUpload, op: PostApprovalRoomIssueUploadOperation, fence: string): Promise<never> {
    // SQL must prove terminal failed create + never accepted + exact fence/binding. No generic orphan cleanup.
    const prepared = projection(deleteSchema, await this.rpc('prepare_post_approval_room_issue_evidence_delete',
      this.leaseArgs(command, op, fence)));
    const authorized = projection(deleteSchema, await this.rpc('prepare_post_approval_room_issue_evidence_delete',
      this.leaseArgs(command, op, fence)));
    if (JSON.stringify(authorized) !== JSON.stringify(prepared)) throw unavailable();
    let result: 'deleted' | 'not_found';
    try { result = projection(z.enum(['deleted', 'not_found']), await this.provider().remove(prepared.fileId)); } catch { throw unavailable(); }
    const settled = this.operation(await this.rpc('settle_post_approval_room_issue_evidence_delete', {
      ...this.leaseArgs(command, op, fence), p_delete_token: prepared.deleteToken, p_result: result
    }), command, op.operationId);
    if (settled.status !== 'compensated') throw unavailable();
    throw new AppError(409, 'POST_APPROVAL_ROOM_ISSUE_UPLOAD_NOT_ACCEPTED', '미수락 업로드가 정리되었습니다.');
  }
  /** Server-internal only: called after the explicit admin handover RPC. Never
   * bind fence or lease arguments from HTTP. Inspect existing identity only;
   * missing bytes/identity and compensation require a separate recovery path. */
  async recoverHandover(actor: Actor, handedOver: PostApprovalRoomIssueUploadOperation, fence: string): Promise<PostApprovalRoomIssueUploadOperation> {
    const trusted = context(actor);
    if (actor.role !== 'admin') throw new AppError(403, 'ADMIN_REQUIRED', '관리자 권한이 필요합니다.');
    let baseline = projectPostApprovalRoomIssueUpload(handedOver);
    if (baseline.leaseVersion < 1 || !/^[0-9a-f]{64}$/.test(fence)) throw unavailable();
    const args = { ...actorArgs(trusted), p_operation_id: baseline.operationId,
      p_lease_version: baseline.leaseVersion, p_fence_token_digest: fence };
    const checked = (value: unknown) => {
      const op = projectPostApprovalRoomIssueUpload(value);
      const delta = op.status === 'accepted' && baseline.status !== 'accepted' ? 1 : 0;
      if (op.operationId !== baseline.operationId || op.evidenceId !== baseline.evidenceId
        || op.leaseVersion !== baseline.leaseVersion || !sameMetadata(op, baseline)
        || op.itemRevision !== baseline.itemRevision + delta || op.evidenceRevision !== baseline.evidenceRevision + delta) {
        throw new AppError(500, 'POST_APPROVAL_ROOM_ISSUE_EVIDENCE_PROJECTION_INVALID', '증빙 복구 응답을 확인하지 못했습니다.');
      }
      return op;
    };
    let op = checked(await this.rpc('get_post_approval_room_issue_evidence_upload', {
      ...actorArgs(trusted), p_operation_id: baseline.operationId
    }));
    if (op.status === 'accepted') return op;
    if (op.status === 'compensated') throw new AppError(409, 'POST_APPROVAL_ROOM_ISSUE_UPLOAD_NOT_ACCEPTED', '미수락 업로드가 정리되었습니다.');
    if (op.status === 'compensation_pending') throw unavailable();
    // Only the current executor can claim; expired leases rotate within the
    // existing eight-version limit. The same receipt-derived fence is reused.
    const claimed = projectPostApprovalRoomIssueUpload(await this.rpc('claim_post_approval_room_issue_evidence_upload', {
      ...actorArgs(trusted), p_operation_id: baseline.operationId, p_fence_token_digest: fence
    }));
    if (claimed.leaseVersion < baseline.leaseVersion || claimed.leaseVersion > baseline.leaseVersion + 1) throw unavailable();
    baseline = Object.freeze({ ...baseline, leaseVersion: claimed.leaseVersion });
    op = checked(claimed);
    args.p_lease_version = op.leaseVersion;
    if (op.status === 'accepted') return op;
    if (op.status === 'compensated' || op.status === 'compensation_pending') throw unavailable();
    const saved = projection(providerSchema, await this.rpc('get_post_approval_room_issue_evidence_provider_context', args));
    if (!sameMetadata(saved, baseline)) throw unavailable();
    const object = privateObject(saved); // Missing identity is not permission to allocate/upload.
    if (op.status === 'reserved') {
      op = checked(await this.rpc('mark_post_approval_room_issue_evidence_unknown', args));
      if (op.status !== 'reconciliation_pending') throw unavailable();
    }
    const before = checked(await this.rpc('renew_post_approval_room_issue_evidence_upload', args));
    if (before.status !== op.status) throw unavailable();
    let uploadedAt: string;
    try { uploadedAt = projection(z.iso.datetime({ offset: true }), (await this.provider().inspect(object)).uploadedAt); }
    catch { throw unavailable(); } // Unknown or 404 does not prove that a delayed write cannot succeed.
    const after = checked(await this.rpc('renew_post_approval_room_issue_evidence_upload', args));
    if (after.status !== before.status) throw unavailable();
    op = checked(await this.rpc('record_post_approval_room_issue_evidence_provider_success', { ...args, p_uploaded_at: uploadedAt }));
    if (op.status !== 'provider_succeeded') throw unavailable();
    op = checked(await this.rpc('finalize_post_approval_room_issue_evidence_upload', args));
    if (op.status !== 'accepted') throw unavailable();
    return op;
  }
  async status(actor: Actor, operationId: string): Promise<PostApprovalRoomIssueUploadOperation> {
    const trusted = context(actor), parsed = id.safeParse(operationId);
    if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', '업로드 identity를 확인해 주세요.');
    const result = projectPostApprovalRoomIssueUpload(await this.rpc('get_post_approval_room_issue_evidence_upload', {
      ...actorArgs(trusted), p_operation_id: parsed.data
    }));
    if (result.operationId !== parsed.data) throw unavailable();
    return result;
  }
  async content(actor: Actor, evidenceId: string, revision: number): Promise<{ bytes: Uint8Array; mimeType: 'image/jpeg' | 'image/webp' }> {
    const trusted = context(actor), parsed = contentInputSchema.safeParse({ evidenceId, revision });
    if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', '증빙 identity를 확인해 주세요.');
    const args = { ...actorArgs(trusted), p_evidence_id: parsed.data.evidenceId, p_revision: parsed.data.revision };
    const authorize = async () => projection(readSchema, await this.rpc('get_post_approval_room_issue_evidence_content', args));
    const before = await authorize(), object: DriveReadObject = { fileId: before.fileId, mime: before.mimeType,
      sizeBytes: before.sizeBytes, sha256: before.sha256 };
    let bytes: Uint8Array;
    try { bytes = await this.provider().read(object); } catch { throw unavailable(); }
    const after = await authorize();
    if (JSON.stringify(before) !== JSON.stringify(after) || bytes.byteLength !== after.sizeBytes
      || createHash('sha256').update(bytes).digest('hex') !== after.sha256) throw unavailable();
    return { bytes, mimeType: after.mimeType };
  }
}
