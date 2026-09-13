import { idempotencyKey, readJsonBody } from "./account-api.ts";
import {
  type EdgeActor,
  type EdgeClients,
  EdgeError,
  requirePasswordChanged,
  verifiedRequestSessionId,
} from "./runtime.ts";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const reasons = {
  EXTEND_CHECKOUT: "GUEST_STILL_PRESENT_EXTENDED",
  CONFIRM_DEPARTED: "GUEST_DEPARTURE_CONFIRMED",
  FALSE_REPORT: "REPORT_FALSE_CONFIRMED",
} as const;
type Decision = keyof typeof reasons;

function invalid(): never {
  throw new EdgeError(
    400,
    "VALIDATION_ERROR",
    "허용된 사건 ID, version, 결정만 전달해 주세요.",
  );
}
function uuid(value: unknown): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) invalid();
  return value.toLowerCase();
}
function positive(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    invalid();
  }
  return value;
}
function time(value: unknown): string {
  if (
    typeof value !== "string" || !Number.isFinite(Date.parse(value)) ||
    !/[zZ]|[+-]\d{2}:\d{2}$/.test(value)
  ) invalid();
  return value;
}
function exactKeys(value: Record<string, unknown>, keys: string[]): void {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(value, k))
  ) invalid();
}
function strictTime(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
      .test(value) ||
    !Number.isFinite(Date.parse(value))
  ) throw checkoutIncidentDatabaseError(null);
  return value;
}
async function digest(value: unknown): Promise<string> {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
      ? Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
          a.localeCompare(b)
        ).map(([k, n]) => [k, sort(n)]),
      )
      : v;
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(sort(value))),
  );
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
function actorRole(actor: EdgeActor, role: "maid" | "admin"): void {
  requirePasswordChanged(actor);
  if (actor.role !== role) {
    throw new EdgeError(
      403,
      role === "maid" ? "MAID_REQUIRED" : "ADMIN_REQUIRED",
      role === "maid"
        ? "담당 메이드만 신고할 수 있습니다."
        : "관리자만 결정할 수 있습니다.",
    );
  }
}
export function checkoutIncidentDatabaseError(
  error: { message?: string } | null,
): EdgeError {
  const code = error?.message ?? "";
  const map: Record<string, number> = {
    MAID_REQUIRED: 403,
    ADMIN_REQUIRED: 403,
    PIN_ACCESS_REQUIRED: 403,
    SESSION_REVOKED: 401,
    CHECKOUT_INCIDENT_REPORT_REQUIRED: 403,
    CHECKOUT_INCIDENT_ACCESS_REQUIRED: 403,
    CHECKOUT_INCIDENT_NOT_FOUND: 404,
    CHECKOUT_INCIDENT_OPEN: 409,
    CHECKOUT_INCIDENT_REPORT_CONFLICT: 409,
    CHECKOUT_INCIDENT_VERSION_CONFLICT: 409,
    CHECKOUT_INCIDENT_IMPACT_CHANGED: 409,
    ASSIGNMENT_MAID_UNAVAILABLE: 409,
    ASSIGNMENT_SEQUENCE_CONFLICT: 409,
    IDEMPOTENCY_KEY_REUSED: 409,
    INVALID_CHECKOUT_INCIDENT_REPORT: 400,
    INVALID_CHECKOUT_INCIDENT_DECISION: 400,
  };
  return Object.hasOwn(map, code)
    ? new EdgeError(
      map[code],
      code,
      "퇴실 미진행 사건의 권한·상태·version을 확인해 주세요.",
    )
    : new EdgeError(
      500,
      "CHECKOUT_INCIDENT_COMMAND_FAILED",
      "퇴실 미진행 사건을 처리하지 못했습니다.",
    );
}
export function checkoutIncidentPath(
  path: string,
): { kind: "report" | "detail" | "decision"; id: string } | null {
  let match = /^\/v1\/attempts\/([^/]+)\/checkout-not-completed$/.exec(path);
  if (match) return { kind: "report", id: uuid(match[1]) };
  match = /^\/v1\/checkout-incidents\/([^/]+)(\/decision)?$/.exec(path);
  return match
    ? { kind: match[2] ? "decision" : "detail", id: uuid(match[1]) }
    : null;
}
function project(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw checkoutIncidentDatabaseError(null);
  }
  const row = value as Record<string, unknown>;
  if (
    [
      "incidentId",
      "reservationId",
      "roomId",
      "cleaningTargetId",
      "assignmentId",
      "attemptId",
      "reportedBy",
    ].some((k) =>
      typeof row[k] !== "string" || !uuidPattern.test(row[k] as string)
    ) || !Number.isSafeInteger(row.version) ||
    row.reasonCode !== "GUEST_STILL_PRESENT" ||
    !["open", "resolved"].includes(row.status as string)
  ) throw checkoutIncidentDatabaseError(null);
  const projected: Record<string, unknown> = {
    incidentId: uuid(row.incidentId),
    reservationId: uuid(row.reservationId),
    roomId: uuid(row.roomId),
    cleaningTargetId: uuid(row.cleaningTargetId),
    assignmentId: uuid(row.assignmentId),
    attemptId: uuid(row.attemptId),
    reportedBy: uuid(row.reportedBy),
    reasonCode: row.reasonCode,
    status: row.status,
    version: row.version,
    reportedAt: strictTime(row.reportedAt),
  };
  if (
    typeof row.impactFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(row.impactFingerprint)
  ) throw checkoutIncidentDatabaseError(null);
  projected.impactFingerprint = row.impactFingerprint;
  if (row.resolvedAt !== undefined && row.resolvedAt !== null) {
    projected.resolvedAt = strictTime(row.resolvedAt);
  }
  if (row.currentDecisionId !== undefined && row.currentDecisionId !== null) {
    projected.currentDecisionId = uuid(row.currentDecisionId);
  }
  if (row.decision !== undefined && row.decision !== null) {
    projected.decision = projectDecision(row.decision);
  }
  return projected;
}
function projectDecision(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw checkoutIncidentDatabaseError(null);
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.decision !== "string" || !Object.hasOwn(reasons, row.decision) ||
    row.reasonCode !== reasons[row.decision as Decision] ||
    !Number.isSafeInteger(row.incidentVersion)
  ) throw checkoutIncidentDatabaseError(null);
  const projected: Record<string, unknown> = {
    decisionId: uuid(row.decisionId),
    incidentId: uuid(row.incidentId),
    incidentVersion: row.incidentVersion,
    decision: row.decision,
    reasonCode: row.reasonCode,
    decidedBy: uuid(row.decidedBy),
    decidedAt: strictTime(row.decidedAt),
    nextAssignmentId: uuid(row.nextAssignmentId),
  };
  if (row.newCheckoutAt !== undefined && row.newCheckoutAt !== null) {
    projected.newCheckoutAt = strictTime(row.newCheckoutAt);
  }
  if (row.nextAttemptId !== undefined && row.nextAttemptId !== null) {
    projected.nextAttemptId = uuid(row.nextAttemptId);
  }
  return projected;
}
export async function reportCheckoutIncident(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  attemptId: string,
): Promise<Record<string, unknown>> {
  actorRole(actor, "maid");
  if (new URL(request.url).search) invalid();
  const body = await readJsonBody(request);
  exactKeys(body, [
    "expectedExecutionVersion",
    "expectedAssignmentId",
    "expectedAssignmentRevision",
  ]);
  const input = {
    attemptId: uuid(attemptId),
    expectedExecutionVersion: positive(body.expectedExecutionVersion),
    expectedAssignmentId: uuid(body.expectedAssignmentId),
    expectedAssignmentRevision: positive(body.expectedAssignmentRevision),
  };
  const { data, error } = await clients.admin.rpc(
    "report_checkout_presence_incident",
    {
      p_actor_profile_id: actor.profileId,
      p_session_id: verifiedRequestSessionId(request),
      p_attempt_id: input.attemptId,
      p_expected_execution_version: input.expectedExecutionVersion,
      p_expected_assignment_id: input.expectedAssignmentId,
      p_expected_assignment_revision: input.expectedAssignmentRevision,
      p_idempotency_key: idempotencyKey(request),
      p_request_hash: await digest({
        actorProfileId: actor.profileId,
        ...input,
      }),
    },
  );
  if (error) throw checkoutIncidentDatabaseError(error);
  return project(data);
}
export async function getCheckoutIncident(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  incidentId: string,
): Promise<Record<string, unknown>> {
  requirePasswordChanged(actor);
  if (new URL(request.url).search) invalid();
  if (actor.role !== "maid" && actor.role !== "admin") {
    throw new EdgeError(
      403,
      "CHECKOUT_INCIDENT_ACCESS_REQUIRED",
      "사건 조회 권한이 필요합니다.",
    );
  }
  const { data, error } = await clients.admin.rpc(
    "get_checkout_presence_incident",
    {
      p_actor_profile_id: actor.profileId,
      p_session_id: verifiedRequestSessionId(request),
      p_incident_id: uuid(incidentId),
    },
  );
  if (error) throw checkoutIncidentDatabaseError(error);
  return project(data);
}
export async function decideCheckoutIncident(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  incidentId: string,
): Promise<Record<string, unknown>> {
  actorRole(actor, "admin");
  if (new URL(request.url).search) invalid();
  const body = await readJsonBody(request);
  exactKeys(body, [
    "expectedVersion",
    "expectedImpactFingerprint",
    "decision",
    "reasonCode",
    "newCheckoutAt",
    "reassignment",
  ]);
  if (
    typeof body.decision !== "string" ||
    !Object.hasOwn(reasons, body.decision) ||
    body.reasonCode !== reasons[body.decision as Decision]
  ) invalid();
  const decision = body.decision as Decision;
  if ((decision === "EXTEND_CHECKOUT") !== (body.newCheckoutAt !== null)) {
    invalid();
  }
  if (
    !body.reassignment || typeof body.reassignment !== "object" ||
    Array.isArray(body.reassignment)
  ) invalid();
  const raw = body.reassignment as Record<string, unknown>;
  exactKeys(raw, [
    "maidProfileId",
    "sequenceNumber",
    "serviceDate",
    "availableFrom",
    "dueAt",
  ]);
  const reassignment = {
    maidProfileId: uuid(raw.maidProfileId),
    sequenceNumber: positive(raw.sequenceNumber),
    serviceDate:
      typeof raw.serviceDate === "string" && datePattern.test(raw.serviceDate)
        ? raw.serviceDate
        : invalid(),
    availableFrom: time(raw.availableFrom),
    dueAt: time(raw.dueAt),
  };
  const input = {
    incidentId: uuid(incidentId),
    expectedVersion: positive(body.expectedVersion),
    expectedImpactFingerprint:
      typeof body.expectedImpactFingerprint === "string" &&
        /^[0-9a-f]{64}$/.test(body.expectedImpactFingerprint)
        ? body.expectedImpactFingerprint
        : invalid(),
    decision,
    reasonCode: body.reasonCode,
    newCheckoutAt: body.newCheckoutAt === null
      ? null
      : time(body.newCheckoutAt),
    reassignment,
  };
  const { data, error } = await clients.admin.rpc(
    "decide_checkout_presence_incident",
    {
      p_actor_profile_id: actor.profileId,
      p_session_id: verifiedRequestSessionId(request),
      p_incident_id: input.incidentId,
      p_expected_version: input.expectedVersion,
      p_expected_impact_fingerprint: input.expectedImpactFingerprint,
      p_decision: input.decision,
      p_reason_code: input.reasonCode,
      p_new_checkout_at: input.newCheckoutAt,
      p_reassignment: input.reassignment,
      p_idempotency_key: idempotencyKey(request),
      p_request_hash: await digest({
        actorProfileId: actor.profileId,
        ...input,
      }),
    },
  );
  if (error) throw checkoutIncidentDatabaseError(error);
  return project(data);
}
