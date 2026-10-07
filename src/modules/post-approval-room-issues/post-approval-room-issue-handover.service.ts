import { createHmac } from 'node:crypto';
import type { Actor } from '../../domain/actor.js';
import { AppError } from '../../lib/app-error.js';
import { preparePostApprovalRoomIssueHandover } from './post-approval-room-issue-handover-contract.js';
import { postApprovalRoomIssueEvidenceActorContext, postApprovalRoomIssueEvidenceDatabaseError,
  type PostApprovalRoomIssueEvidenceRpc, type SupabasePostApprovalRoomIssueEvidenceService } from './post-approval-room-issue-evidence.service.js';
import { projectPostApprovalRoomIssueUpload, type PostApprovalRoomIssueUploadOperation } from './post-approval-room-issue-upload-contract.js';

/** Unregistered adapter. Caller MUST authenticate before supplying Actor.
 * Inject a dedicated persistent server key, identical across replicas/restarts.
 * Do not use a per-request random key or silently rotate it during receipt replay.
 * Recovery only inspects existing provider identity; no original uploader
 * impersonation or public fence disclosure.
 */
export class SupabasePostApprovalRoomIssueHandoverService {
  readonly #fenceKey: Buffer;
  constructor(private readonly db: PostApprovalRoomIssueEvidenceRpc, fenceKey: Uint8Array,
    private readonly recovery?: Pick<SupabasePostApprovalRoomIssueEvidenceService, 'recoverHandover'>) {
    if (!(fenceKey instanceof Uint8Array) || fenceKey.byteLength !== 32) {
      throw new AppError(503, 'POST_APPROVAL_ROOM_ISSUE_EVIDENCE_RETRY_REQUIRED', '증빙 인계 설정을 확인해 주세요.');
    }
    this.#fenceKey = Buffer.from(fenceKey);
  }

  private prepare(actor: Actor, input: unknown, rawKey: unknown) {
    const trusted = postApprovalRoomIssueEvidenceActorContext(actor);
    if (actor.role !== 'admin') throw new AppError(403, 'ADMIN_REQUIRED', '관리자 권한이 필요합니다.');
    const command = preparePostApprovalRoomIssueHandover(trusted, input, rawKey);
    // Receipt-specific and session-independent. Keep the server key stable for
    // ALL replayable receipts, including completed ones. Rotation needs an explicit
    // versioned migration strategy; it must never silently reclaim a lease.
    const fence = createHmac('sha256', this.#fenceKey)
      .update(`post-approval-evidence-handover:v1:${command.idempotencyKeyDigest}:${command.requestHash}`)
      .digest('hex');
    return { command, fence };
  }
  async handover(actor: Actor, input: unknown, rawKey: unknown): Promise<PostApprovalRoomIssueUploadOperation> {
    return (await this.acquire(actor, input, rawKey)).operation;
  }
  async recover(actor: Actor, input: unknown, rawKey: unknown): Promise<PostApprovalRoomIssueUploadOperation> {
    // Never mutate ownership if the server recovery dependency is absent.
    if (!this.recovery) throw new AppError(503, 'POST_APPROVAL_ROOM_ISSUE_EVIDENCE_RETRY_REQUIRED', '증빙 복구 설정을 확인해 주세요.');
    const { operation, fence } = await this.acquire(actor, input, rawKey);
    return this.recovery.recoverHandover(actor, operation, fence);
  }
  private async acquire(actor: Actor, input: unknown, rawKey: unknown) {
    const { command, fence } = this.prepare(actor, input, rawKey);
    let data: unknown;
    try {
      const result = await this.db.rpc('handover_post_approval_room_issue_evidence_upload', {
        p_actor_profile_id: command.actor.actorProfileId, p_session_id: command.actor.sessionId,
        p_operation_id: command.input.operationId, p_expected_lease_version: command.input.expectedLeaseVersion,
        p_idempotency_key_digest: command.idempotencyKeyDigest, p_request_hash: command.requestHash,
        p_fence_token_digest: fence
      });
      if (result.error) throw postApprovalRoomIssueEvidenceDatabaseError(result.error);
      data = result.data;
    } catch (error) {
      if (error instanceof AppError) throw postApprovalRoomIssueEvidenceDatabaseError({ message: error.code });
      throw postApprovalRoomIssueEvidenceDatabaseError(null);
    }
    const operation = projectPostApprovalRoomIssueUpload(data);
    if (operation.operationId !== command.input.operationId
      || operation.leaseVersion < command.input.expectedLeaseVersion + 1) {
      throw new AppError(500, 'POST_APPROVAL_ROOM_ISSUE_EVIDENCE_PROJECTION_INVALID', '증빙 인계 응답을 확인하지 못했습니다.');
    }
    return { operation, fence };
  }
}
