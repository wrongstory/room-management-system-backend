import { createHash } from 'node:crypto';
import { AppError } from '../../lib/app-error.js';
import type { PhotoIdentity, PhotoRpc } from '../photos/photo-service.js';
import { dtoInstant, projectLimitedAttempt, projectLimitedDiscovery } from './limited-attempt-contract.js';

export interface LimitedCompleteInput {
  attemptId: string;
  expectedExecutionVersion: number;
  expectedAssignmentId: string;
  expectedAssignmentRevision: number;
}
export function limitedDatabaseError(error: unknown): AppError {
  const code = error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  const statuses: Record<string, number> = { CAPABILITY_ACCESS_REQUIRED: 403, SESSION_REVOKED: 401,
    PASSWORD_CHANGE_REQUIRED: 403,
    LIMITED_DISCOVERY_LIMIT_EXCEEDED: 500, LIMITED_SESSION_LIMIT_EXCEEDED: 500, ATTEMPT_ACCESS_REQUIRED: 403, ATTEMPT_VERSION_CONFLICT: 409,
    ASSIGNMENT_VERSION_CONFLICT: 409, ATTEMPT_INVALID_TRANSITION: 409, CHECKOUT_INCIDENT_OPEN: 409,
    IDEMPOTENCY_KEY_REUSED: 409, INVALID_ATTEMPT_COMMAND: 400 };
  return Object.hasOwn(statuses, code)
    ? new AppError(statuses[code] ?? 500, code, '현재 수행 권한과 version을 확인해 주세요.')
    : new AppError(500, 'ATTEMPT_COMMAND_FAILED', '수행 정보를 처리하지 못했습니다.');
}
export class LimitedAttemptService {
  constructor(private readonly db: PhotoRpc) {}
  private async rpc(name: string, identity: PhotoIdentity, args: Record<string, unknown> = {}) {
    const { data, error } = await this.db.rpc(name, {
      p_actor_profile_id: identity.profileId, p_session_id: identity.sessionId, ...args,
    });
    if (error) throw limitedDatabaseError(error);
    return data;
  }
  async list(identity: PhotoIdentity) {
    const data = await this.rpc('list_limited_cleaning_attempts', identity);
    try {
      const result = projectLimitedDiscovery(data);
      if (result.profileStatus !== identity.profileStatus) throw limitedDatabaseError(null);
      return result;
    } catch { throw limitedDatabaseError(null); }
  }
  async get(identity: PhotoIdentity, attemptId: string, assignmentRevision: number) {
    const data = await this.rpc('get_limited_cleaning_attempt', identity, {
      p_attempt_id: attemptId, p_assignment_revision: assignmentRevision,
    });
    try {
      const result = projectLimitedAttempt(data, identity.profileId);
      if (result.attempt.attemptId !== attemptId || result.attempt.assignmentRevision !== assignmentRevision) throw limitedDatabaseError(null);
      return result;
    } catch { throw limitedDatabaseError(null); }
  }
  async complete(identity: PhotoIdentity, input: LimitedCompleteInput, key: string) {
    const requestHash = createHash('sha256').update(JSON.stringify({ actorProfileId: identity.profileId,
      action: 'complete_limited', input })).digest('hex');
    const data = await this.rpc('complete_limited_cleaning_attempt_field_work', identity, {
      p_attempt_id: input.attemptId, p_expected_execution_version: input.expectedExecutionVersion,
      p_expected_assignment_id: input.expectedAssignmentId, p_expected_assignment_revision: input.expectedAssignmentRevision,
      p_idempotency_key: key, p_request_hash: requestHash,
    });
    try {
      const result = projectLimitedAttempt(data, identity.profileId);
      const row = data as Record<string, unknown>;
      if (result.attempt.attemptId !== input.attemptId || result.attempt.assignmentId !== input.expectedAssignmentId
        || result.attempt.assignmentRevision !== input.expectedAssignmentRevision
        || result.attempt.executionVersion !== input.expectedExecutionVersion + 1
        || result.attempt.status !== 'field_completed' || row.nextAttempt !== null
        || typeof row.profileVersion !== 'number' || !Number.isSafeInteger(row.profileVersion) || row.profileVersion < 1) throw limitedDatabaseError(null);
      dtoInstant(row.effectiveAt); dtoInstant(row.recordedAt);
      return { ...result, profileVersion: row.profileVersion, nextAttempt: null,
        effectiveAt: row.effectiveAt as string, recordedAt: row.recordedAt as string };
    } catch { throw limitedDatabaseError(null); }
  }
}
