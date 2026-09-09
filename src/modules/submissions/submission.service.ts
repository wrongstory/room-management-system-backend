import { createHash } from 'node:crypto';
import type { Actor } from '../../domain/actor.js';
import { AppError } from '../../lib/app-error.js';
import type { SupabaseClients } from '../../lib/supabase.js';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonical(nested)]));
  }
  return value;
}
function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function submissionDatabaseError(error: { message?: string } | null): AppError {
  const code = error?.message ?? '';
  const status: Record<string, number> = {
    MAID_REQUIRED: 403, ADMIN_REQUIRED: 403, CAPABILITY_ACCESS_REQUIRED: 403, SUBMISSION_ACCESS_REQUIRED: 403, BOMB_REPORT_ACCESS_REQUIRED: 403,
    PHOTO_EVIDENCE_INCOMPLETE: 409, BOMB_EVIDENCE_INVALID: 409, BOMB_REPORT_NOT_ALLOWED: 409, BOMB_REPORT_SEALED: 409,
    SUBMISSION_VERSION_CONFLICT: 409, STALE_VERSION: 409, SUBMISSION_INVALID_TRANSITION: 409,
    BOMB_DECISION_REQUIRED: 409, BOMB_DECISION_ALREADY_RECORDED: 409, BOMB_REPORT_NOT_FOUND: 404, INSPECTION_INVALID_TRANSITION: 409,
    RECLEAN_ORIGINAL_MAID_UNAVAILABLE: 409, RECLEAN_TEMPLATE_NOT_CONFIGURED: 409, RECLEAN_WINDOW_NOT_AVAILABLE: 409,
    IDEMPOTENCY_KEY_REUSED: 409, INVALID_BOMB_REPORT: 400, INVALID_BOMB_DECISION: 400,
    SUBMISSION_NOT_FOUND: 404
  };
  return Object.hasOwn(status, code)
    ? new AppError(status[code] ?? 500, code, '제출·검수 상태와 version을 다시 확인해 주세요.')
    : new AppError(500, 'SUBMISSION_COMMAND_FAILED', '제출·검수 정보를 처리하지 못했습니다.');
}

export type SubmissionActor = Pick<Actor, 'profileId' | 'role' | 'mustChangePassword'>;

export interface SubmissionService {
  reportBomb(actor: SubmissionActor, attemptId: string, evidencePhotoIds: string[], memo: string, idempotencyKey: string): Promise<unknown>;
  create(actor: SubmissionActor, attemptId: string, clientSubmissionId: string, expectedRevision: number, candleCount: number, idempotencyKey: string): Promise<unknown>;
  list(actor: SubmissionActor, attemptId?: string): Promise<unknown[]>;
  detail(actor: SubmissionActor, submissionId: string): Promise<unknown>;
  decideBomb(actor: SubmissionActor, submissionId: string, decision: 'approved' | 'rejected', reasonCode: string, idempotencyKey: string): Promise<unknown>;
  decide(actor: SubmissionActor, submissionId: string, decision: 'approve' | 'reject', reasonCode: string, idempotencyKey: string): Promise<unknown>;
}

export class SupabaseSubmissionService implements SubmissionService {
  constructor(private readonly clients: SupabaseClients) {}
  private async rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await this.clients.admin.rpc(name, args);
    if (error) throw submissionDatabaseError(error);
    return data;
  }
  private project(value: unknown, allowed: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw submissionDatabaseError(null);
    const row = value as Record<string, unknown>;
    return Object.fromEntries(allowed.filter((field) => Object.hasOwn(row, field)).map((field) => [field, row[field]]));
  }
  private submissionProjection(value: unknown, includeBombDetail = false): Record<string, unknown> {
    const row = this.project(value, [
      'id', 'attemptId', 'version', 'status', 'submittedBy', 'submittedAt', 'currentRevision', 'current',
      'photoCount', 'candleCount', 'bombReportId', 'bombDecision', 'inspectionDecision', 'inspectionReasonCode', 'decidedAt'
    ]);
    if (includeBombDetail && value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'bombReport')) {
      row.bombReport = this.project((value as Record<string, unknown>).bombReport, [
        'id', 'attemptId', 'memo', 'evidenceCount', 'evidencePhotoIds', 'reportedAt'
      ]);
    }
    if (includeBombDetail && value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'photos')) {
      const photos = (value as Record<string, unknown>).photos;
      if (!Array.isArray(photos)) throw submissionDatabaseError(null);
      row.photos = photos.map((photo) => this.project(photo, [
        'photoId', 'targetPhotoSlotId', 'slotKey', 'label', 'displayOrder', 'required', 'photoVersion'
      ]));
    }
    if (includeBombDetail && value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'reviewContext')) {
      row.reviewContext = this.project((value as Record<string, unknown>).reviewContext, [
        'cleaningTargetId', 'cleaningKind', 'roomNumber', 'serviceDate', 'maidProfileId'
      ]);
    }
    return row;
  }
  async reportBomb(actor: SubmissionActor, attemptId: string, evidencePhotoIds: string[], memo: string, key: string) {
    const input = { actorProfileId: actor.profileId, attemptId, evidencePhotoIds, memo };
    return this.project(await this.rpc('report_bomb_room', { p_actor_profile_id: actor.profileId, p_attempt_id: attemptId, p_evidence_photo_ids: evidencePhotoIds, p_memo: memo, p_idempotency_key: key, p_request_hash: requestHash(input) }), ['id', 'attemptId', 'evidenceCount', 'reportedAt']);
  }
  async create(actor: SubmissionActor, attemptId: string, clientSubmissionId: string, expectedRevision: number, candleCount: number, key: string) {
    const input = { actorProfileId: actor.profileId, attemptId, clientSubmissionId, expectedRevision, candleCount };
    return this.submissionProjection(await this.rpc('create_cleaning_submission', { p_actor_profile_id: actor.profileId, p_attempt_id: attemptId, p_client_submission_id: clientSubmissionId, p_expected_revision: expectedRevision, p_candle_count: candleCount, p_idempotency_key: key, p_request_hash: requestHash(input) }));
  }
  async list(actor: SubmissionActor, attemptId?: string) {
    const value = await this.rpc('list_cleaning_submissions', { p_actor_profile_id: actor.profileId, p_attempt_id: attemptId ?? null, p_pending_only: attemptId === undefined });
    if (!Array.isArray(value)) throw submissionDatabaseError(null);
    return value.map((row) => this.submissionProjection(row, attemptId === undefined));
  }
  async detail(actor: SubmissionActor, submissionId: string) {
    return this.submissionProjection(await this.rpc('get_cleaning_submission', { p_actor_profile_id: actor.profileId, p_submission_id: submissionId }), true);
  }
  async decideBomb(actor: SubmissionActor, submissionId: string, decision: 'approved' | 'rejected', reasonCode: string, key: string) {
    const input = { actorProfileId: actor.profileId, submissionId, decision, reasonCode };
    return this.project(await this.rpc('decide_bomb_room', { p_actor_profile_id: actor.profileId, p_submission_id: submissionId, p_decision: decision, p_reason_code: reasonCode, p_idempotency_key: key, p_request_hash: requestHash(input) }), ['id', 'submissionId', 'decision', 'reasonCode', 'decidedAt']);
  }
  async decide(actor: SubmissionActor, submissionId: string, decision: 'approve' | 'reject', reasonCode: string, key: string) {
    const input = { actorProfileId: actor.profileId, submissionId, decision, reasonCode };
    return this.project(await this.rpc(decision === 'approve' ? 'approve_cleaning_submission' : 'reject_cleaning_submission', { p_actor_profile_id: actor.profileId, p_submission_id: submissionId, p_reason_code: reasonCode, p_idempotency_key: key, p_request_hash: requestHash(input) }), ['submissionId', 'decisionId', 'decision', 'reasonCode', 'decidedAt', 'earningId', 'recleanTargetId', 'recleanAssignmentId']);
  }
}
