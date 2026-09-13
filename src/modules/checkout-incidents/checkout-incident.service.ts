import { createHash } from 'node:crypto';
import type { Actor } from '../../domain/actor.js';
import { AppError } from '../../lib/app-error.js';
import type { SupabaseClients } from '../../lib/supabase.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export type CheckoutIncidentDecision = 'EXTEND_CHECKOUT' | 'CONFIRM_DEPARTED' | 'FALSE_REPORT';
export interface CheckoutIncidentReassignment {
  maidProfileId: string;
  sequenceNumber: number;
  serviceDate: string;
  availableFrom: string;
  dueAt: string;
}
export interface CheckoutIncidentReportInput {
  expectedExecutionVersion: number;
  expectedAssignmentId: string;
  expectedAssignmentRevision: number;
}
export interface CheckoutIncidentDecisionInput {
  expectedVersion: number;
  expectedImpactFingerprint: string;
  decision: CheckoutIncidentDecision;
  reasonCode: string;
  newCheckoutAt: string | null;
  reassignment: CheckoutIncidentReassignment;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, canonical(nested)]));
  return value;
}
function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
function sessionId(actor: Actor): string {
  try {
    const encoded = actor.accessToken.split('.')[1];
    if (!encoded) throw new Error();
    const claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as { session_id?: unknown };
    if (typeof claims.session_id !== 'string' || !uuidPattern.test(claims.session_id)) throw new Error();
    return claims.session_id.toLowerCase();
  } catch { throw new AppError(401, 'INVALID_ACCESS_TOKEN', '로그인이 필요합니다.'); }
}
function projectionError(): never {
  throw new AppError(500, 'CHECKOUT_INCIDENT_COMMAND_FAILED', '퇴실 미진행 사건을 처리하지 못했습니다.');
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) projectionError();
  return value.toLowerCase();
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !timestampPattern.test(value) || !Number.isFinite(Date.parse(value))) projectionError();
  return value;
}
function projectDecision(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) projectionError();
  const row = value as Record<string, unknown>;
  const expectedReason = row.decision === 'EXTEND_CHECKOUT' ? 'GUEST_STILL_PRESENT_EXTENDED'
    : row.decision === 'CONFIRM_DEPARTED' ? 'GUEST_DEPARTURE_CONFIRMED'
    : row.decision === 'FALSE_REPORT' ? 'REPORT_FALSE_CONFIRMED' : null;
  if (expectedReason === null || row.reasonCode !== expectedReason || !Number.isSafeInteger(row.incidentVersion)) projectionError();
  const projected: Record<string, unknown> = {
    decisionId: uuid(row.decisionId), incidentId: uuid(row.incidentId), incidentVersion: row.incidentVersion,
    decision: row.decision, reasonCode: row.reasonCode, decidedBy: uuid(row.decidedBy),
    decidedAt: timestamp(row.decidedAt), nextAssignmentId: uuid(row.nextAssignmentId)
  };
  if (row.newCheckoutAt !== undefined && row.newCheckoutAt !== null) projected.newCheckoutAt = timestamp(row.newCheckoutAt);
  if (row.nextAttemptId !== undefined && row.nextAttemptId !== null) projected.nextAttemptId = uuid(row.nextAttemptId);
  return projected;
}
export function checkoutIncidentProjection(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) projectionError();
  const row = value as Record<string, unknown>;
  if (row.reasonCode !== 'GUEST_STILL_PRESENT' || !['open', 'resolved'].includes(String(row.status))
    || !Number.isSafeInteger(row.version)) projectionError();
  const projected: Record<string, unknown> = {
    incidentId: uuid(row.incidentId), reservationId: uuid(row.reservationId), roomId: uuid(row.roomId),
    cleaningTargetId: uuid(row.cleaningTargetId), assignmentId: uuid(row.assignmentId),
    attemptId: uuid(row.attemptId), reportedBy: uuid(row.reportedBy), reasonCode: row.reasonCode,
    status: row.status, version: row.version, reportedAt: timestamp(row.reportedAt)
  };
  if (typeof row.impactFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(row.impactFingerprint)) projectionError();
  projected.impactFingerprint = row.impactFingerprint;
  if (row.resolvedAt !== undefined && row.resolvedAt !== null) projected.resolvedAt = timestamp(row.resolvedAt);
  if (row.currentDecisionId !== undefined && row.currentDecisionId !== null) projected.currentDecisionId = uuid(row.currentDecisionId);
  if (row.decision !== undefined && row.decision !== null) projected.decision = projectDecision(row.decision);
  return projected;
}
export function checkoutIncidentDatabaseError(error: { message?: string } | null): AppError {
  const code = error?.message ?? '';
  const statuses: Record<string, number> = {
    MAID_REQUIRED: 403, ADMIN_REQUIRED: 403, PIN_ACCESS_REQUIRED: 403, SESSION_REVOKED: 401,
    CHECKOUT_INCIDENT_REPORT_REQUIRED: 403, CHECKOUT_INCIDENT_ACCESS_REQUIRED: 403,
    CHECKOUT_INCIDENT_NOT_FOUND: 404, CHECKOUT_INCIDENT_OPEN: 409,
    CHECKOUT_INCIDENT_REPORT_CONFLICT: 409, CHECKOUT_INCIDENT_VERSION_CONFLICT: 409,
    CHECKOUT_INCIDENT_IMPACT_CHANGED: 409,
    ASSIGNMENT_MAID_UNAVAILABLE: 409, ASSIGNMENT_SEQUENCE_CONFLICT: 409,
    IDEMPOTENCY_KEY_REUSED: 409, INVALID_CHECKOUT_INCIDENT_REPORT: 400,
    INVALID_CHECKOUT_INCIDENT_DECISION: 400
  };
  return Object.hasOwn(statuses, code)
    ? new AppError(statuses[code] ?? 500, code, '퇴실 미진행 사건의 권한·상태·version을 확인해 주세요.')
    : new AppError(500, 'CHECKOUT_INCIDENT_COMMAND_FAILED', '퇴실 미진행 사건을 처리하지 못했습니다.');
}

export interface CheckoutIncidentService {
  report(actor: Actor, attemptId: string, input: CheckoutIncidentReportInput, key: string): Promise<unknown>;
  get(actor: Actor, incidentId: string): Promise<unknown>;
  decide(actor: Actor, incidentId: string, input: CheckoutIncidentDecisionInput, key: string): Promise<unknown>;
}

export class SupabaseCheckoutIncidentService implements CheckoutIncidentService {
  constructor(private readonly clients: SupabaseClients) {}
  private async rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await this.clients.admin.rpc(name, args);
    if (error) throw checkoutIncidentDatabaseError(error);
    return checkoutIncidentProjection(data);
  }
  async report(actor: Actor, attemptId: string, input: CheckoutIncidentReportInput, key: string) {
    const canonicalActorId = uuid(actor.profileId);
    const canonicalAttemptId = uuid(attemptId);
    const canonicalAssignmentId = uuid(input.expectedAssignmentId);
    const command = { actorProfileId: canonicalActorId, attemptId: canonicalAttemptId,
      expectedExecutionVersion: input.expectedExecutionVersion, expectedAssignmentId: canonicalAssignmentId,
      expectedAssignmentRevision: input.expectedAssignmentRevision };
    return this.rpc('report_checkout_presence_incident', {
      p_actor_profile_id: canonicalActorId, p_session_id: sessionId(actor), p_attempt_id: canonicalAttemptId,
      p_expected_execution_version: input.expectedExecutionVersion,
      p_expected_assignment_id: canonicalAssignmentId,
      p_expected_assignment_revision: input.expectedAssignmentRevision,
      p_idempotency_key: key, p_request_hash: hash(command)
    });
  }
  async get(actor: Actor, incidentId: string) {
    return this.rpc('get_checkout_presence_incident', {
      p_actor_profile_id: uuid(actor.profileId), p_session_id: sessionId(actor), p_incident_id: uuid(incidentId)
    });
  }
  async decide(actor: Actor, incidentId: string, input: CheckoutIncidentDecisionInput, key: string) {
    const canonicalActorId = uuid(actor.profileId);
    const canonicalIncidentId = uuid(incidentId);
    const normalizedInput = { ...input, reassignment: { ...input.reassignment,
      maidProfileId: uuid(input.reassignment.maidProfileId) } };
    const command = { actorProfileId: canonicalActorId, incidentId: canonicalIncidentId, ...normalizedInput };
    return this.rpc('decide_checkout_presence_incident', {
      p_actor_profile_id: canonicalActorId, p_session_id: sessionId(actor), p_incident_id: canonicalIncidentId,
      p_expected_version: input.expectedVersion,
      p_expected_impact_fingerprint: input.expectedImpactFingerprint,
      p_decision: input.decision,
      p_reason_code: input.reasonCode, p_new_checkout_at: input.newCheckoutAt,
      p_reassignment: normalizedInput.reassignment, p_idempotency_key: key, p_request_hash: hash(command)
    });
  }
}
