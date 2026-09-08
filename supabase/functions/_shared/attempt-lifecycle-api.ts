import { idempotencyKey, readJsonBody } from "./account-api.ts";
import { attemptDatabaseError, projectAttempt } from "./attempt-api.ts";
import {
  type EdgeActor,
  type EdgeClients,
  EdgeError,
  type LimitedAttemptIdentity,
  requireBusinessAdmin,
  requirePasswordChanged,
  verifiedRequestSessionId,
} from "./runtime.ts";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const lifecycleActions = [
  "allow_finish",
  "allow_upload",
  "interrupt_handover",
  "expire_scheduled",
] as const;
type LifecycleAction = typeof lifecycleActions[number];
const capabilityActions: Record<string, string[]> = {
  finish_current: ["complete_field_work"],
  upload_submit: ["upload_evidence", "validate_evidence", "submit"],
  evidence_upload: ["upload_evidence", "validate_evidence"],
};

function invalid(): never {
  throw new EdgeError(
    400,
    "VALIDATION_ERROR",
    "허용된 수명주기 명령과 version만 전달해 주세요.",
  );
}
function uuid(value: unknown): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) invalid();
  return value.toLowerCase();
}
function version(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    invalid();
  }
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[]): void {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) invalid();
}
function timestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/
      .test(value) ||
    !Number.isFinite(Date.parse(value))
  ) invalid();
  date(value.slice(0, 10));
  return new Date(value).toISOString();
}
function date(value: unknown): string {
  if (
    typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
  ) invalid();
  return value;
}
async function requestHash(actor: EdgeActor, action: string, input: unknown) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify({ actorProfileId: actor.profileId, action, input }),
    ),
  );
  return [...new Uint8Array(bytes)].map((value) =>
    value.toString(16).padStart(2, "0")
  ).join("");
}
export function lifecyclePath(path: string): string | null {
  const match = /^\/v1\/attempts\/([^/]+)\/lifecycle$/.exec(path);
  return match ? uuid(match[1]) : null;
}
export function limitedAttemptPath(
  path: string,
): { attemptId: string; action: "read" | "complete" } | null {
  const match = /^\/v1\/limited\/attempts\/([^/]+)(\/complete-field-work)?$/
    .exec(path);
  return match
    ? { attemptId: uuid(match[1]), action: match[2] ? "complete" : "read" }
    : null;
}
export function lifecycleDatabaseError(
  error: { message?: string } | null,
): EdgeError {
  const codes: Record<string, number> = {
    ADMIN_REQUIRED: 403,
    CAPABILITY_ACCESS_REQUIRED: 403,
    SESSION_REVOKED: 401,
    ACCOUNT_VERSION_CONFLICT: 409,
    ACCOUNT_EXECUTION_LIFECYCLE_REQUIRED: 409,
    ASSIGNMENT_SCHEDULE_INVALID: 409,
    ASSIGNMENT_SEQUENCE_CONFLICT: 409,
    CLEANING_WINDOW_NOT_EXPIRED: 409,
    ROLLOVER_NOT_ALLOWED: 409,
  };
  const code = error?.message ?? "";
  return Object.hasOwn(codes, code)
    ? new EdgeError(
      codes[code],
      code,
      "현재 수행 권한과 수명주기를 다시 확인해 주세요.",
    )
    : attemptDatabaseError(error);
}

// 관리자 projection도 현재 target/room/PII hydration 없이 RPC의 고정 DTO만 사용한다.
function safeAttempt(value: unknown, actor: EdgeActor) {
  if (actor.role === "maid") return projectAttempt(value, actor);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw attemptDatabaseError(null);
  }
  return projectAttempt(value, {
    ...actor,
    profileId: String((value as Record<string, unknown>).maidProfileId),
  });
}
function capability(value: unknown, attempt: ReturnType<typeof safeAttempt>) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw attemptDatabaseError(null);
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.capabilityId !== "string" ||
    !uuidPattern.test(row.capabilityId) ||
    row.attemptId !== attempt.attemptId ||
    row.assignmentId !== attempt.assignmentId ||
    row.assignmentRevision !== attempt.assignmentRevision ||
    !["finish_current", "upload_submit", "evidence_upload"].includes(
      String(row.kind),
    ) ||
    !Array.isArray(row.allowedActions) ||
    row.allowedActions.length !== capabilityActions[String(row.kind)]?.length ||
    row.allowedActions.some((action, index) =>
      action !== capabilityActions[String(row.kind)]?.[index]
    ) ||
    typeof row.issuedAt !== "string" ||
    !Number.isFinite(Date.parse(row.issuedAt)) ||
    typeof row.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(row.expiresAt)) ||
    (row.revokedAt !== null &&
      (typeof row.revokedAt !== "string" ||
        !Number.isFinite(Date.parse(row.revokedAt))))
  ) throw attemptDatabaseError(null);
  return {
    capabilityId: row.capabilityId,
    attemptId: attempt.attemptId,
    assignmentId: attempt.assignmentId,
    assignmentRevision: attempt.assignmentRevision,
    kind: row.kind as string,
    allowedActions: [...row.allowedActions] as string[],
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt as string | null,
  };
}
function projection(value: unknown, actor: EdgeActor, allowInactive = false) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw attemptDatabaseError(null);
  }
  const row = value as Record<string, unknown>;
  const attempt = safeAttempt(row.attempt, actor);
  if (
    !(allowInactive
      ? [
        "active",
        "deactivation_pending",
        "upload_only",
        "inactive",
        "departed",
      ]
      : ["active", "deactivation_pending", "upload_only"]).includes(
        String(row.profileStatus),
      )
  ) throw attemptDatabaseError(null);
  return {
    attempt,
    capability: capability(row.capability, attempt),
    profileStatus: row.profileStatus as string,
  };
}
function mutationProjection(
  value: unknown,
  actor: EdgeActor,
  allowInactive = false,
) {
  const base = projection(value, actor, allowInactive);
  const row = value as Record<string, unknown>;
  if (
    typeof row.effectiveAt !== "string" ||
    !Number.isFinite(Date.parse(row.effectiveAt)) ||
    typeof row.recordedAt !== "string" ||
    !Number.isFinite(Date.parse(row.recordedAt)) ||
    typeof row.profileVersion !== "number" ||
    !Number.isSafeInteger(row.profileVersion) || row.profileVersion < 1
  ) throw attemptDatabaseError(null);
  const nextAttempt = row.nextAttempt === null
    ? null
    : safeAttempt(row.nextAttempt, actor);
  if (
    nextAttempt &&
    (nextAttempt.cleaningTargetId !== base.attempt.cleaningTargetId ||
      nextAttempt.attemptId === base.attempt.attemptId)
  ) throw attemptDatabaseError(null);
  return {
    ...base,
    profileVersion: row.profileVersion,
    nextAttempt,
    effectiveAt: row.effectiveAt,
    recordedAt: row.recordedAt,
  };
}
function cas(body: Record<string, unknown>, attemptId: string) {
  return {
    attemptId: uuid(attemptId),
    expectedExecutionVersion: version(body.expectedExecutionVersion),
    expectedAssignmentId: uuid(body.expectedAssignmentId),
    expectedAssignmentRevision: version(body.expectedAssignmentRevision),
  };
}
function rpcCas(input: ReturnType<typeof cas>) {
  return {
    p_attempt_id: input.attemptId,
    p_expected_execution_version: input.expectedExecutionVersion,
    p_expected_assignment_id: input.expectedAssignmentId,
    p_expected_assignment_revision: input.expectedAssignmentRevision,
  };
}

export async function lifecycleImpact(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
) {
  requirePasswordChanged(actor);
  requireBusinessAdmin(actor);
  const query = new URL(request.url).searchParams;
  if (query.size !== 1 || query.getAll("assignmentId").length !== 1) invalid();
  const assignmentId = uuid(query.get("assignmentId"));
  const { data, error } = await clients.admin.rpc(
    "get_cleaning_attempt_lifecycle_impact",
    {
      p_actor_profile_id: actor.profileId,
      p_session_id: verifiedRequestSessionId(request),
      p_assignment_id: assignmentId,
    },
  );
  if (error) throw lifecycleDatabaseError(error);
  const result = projection(data, actor, true);
  if (result.attempt.assignmentId !== assignmentId) {
    throw attemptDatabaseError(null);
  }
  const row = data as Record<string, unknown>;
  if (
    typeof row.profileVersion !== "number" ||
    !Number.isSafeInteger(row.profileVersion) || row.profileVersion < 1 ||
    typeof row.targetAssignmentVersion !== "number" ||
    !Number.isSafeInteger(row.targetAssignmentVersion) ||
    row.targetAssignmentVersion < 1
  ) throw attemptDatabaseError(null);
  return {
    ...result,
    profileVersion: row.profileVersion,
    targetAssignmentVersion: row.targetAssignmentVersion,
  };
}

export async function manageAttemptLifecycle(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  attemptId: string,
) {
  requirePasswordChanged(actor);
  requireBusinessAdmin(actor);
  if (new URL(request.url).search) invalid();
  const body = await readJsonBody(request);
  exact(body, [
    "expectedExecutionVersion",
    "expectedAssignmentId",
    "expectedAssignmentRevision",
    "expectedProfileVersion",
    "action",
    "payload",
    "reasonCode",
  ]);
  if (!lifecycleActions.includes(body.action as LifecycleAction)) invalid();
  const action = body.action as LifecycleAction;
  const rawPayload = object(body.payload);
  let payload: Record<string, unknown> = {};
  if (action === "interrupt_handover") {
    exact(rawPayload, [
      "maidProfileId",
      "sequenceNumber",
      "serviceDate",
      "availableFrom",
      "dueAt",
      "deactivateOld",
    ]);
    if (
      typeof rawPayload.serviceDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(rawPayload.serviceDate) ||
      typeof rawPayload.deactivateOld !== "boolean"
    ) invalid();
    payload = {
      maidProfileId: uuid(rawPayload.maidProfileId),
      sequenceNumber: version(rawPayload.sequenceNumber),
      serviceDate: date(rawPayload.serviceDate),
      availableFrom: timestamp(rawPayload.availableFrom),
      dueAt: timestamp(rawPayload.dueAt),
      deactivateOld: rawPayload.deactivateOld,
    };
  } else exact(rawPayload, []);
  const reason = action === "allow_finish"
    ? "DEACTIVATION_FINISH_CURRENT"
    : action === "allow_upload"
    ? "DEACTIVATION_UPLOAD_ONLY"
    : action === "expire_scheduled"
    ? "SCHEDULE_EXPIRED"
    : payload.deactivateOld
    ? "DEACTIVATION_HANDOVER"
    : "ADMIN_HANDOVER";
  if (body.reasonCode !== reason) invalid();
  const input = {
    ...cas(body, attemptId),
    expectedProfileVersion: version(body.expectedProfileVersion),
    action,
    payload,
    reasonCode: reason,
  };
  const { data, error } = await clients.admin.rpc(
    "manage_cleaning_attempt_lifecycle",
    {
      p_actor_profile_id: actor.profileId,
      p_session_id: verifiedRequestSessionId(request),
      ...rpcCas(input),
      p_expected_profile_version: input.expectedProfileVersion,
      p_action: action,
      p_payload: payload,
      p_reason_code: input.reasonCode,
      p_idempotency_key: idempotencyKey(request),
      p_request_hash: await requestHash(actor, action, input),
    },
  );
  if (error) throw lifecycleDatabaseError(error);
  // 만료 scheduled 정리는 owner를 재활성화하지 않으므로 inactive/departed도 결과로 보존한다.
  const result = mutationProjection(data, actor, true);
  if (
    result.attempt.attemptId !== input.attemptId ||
    result.attempt.assignmentId !== input.expectedAssignmentId ||
    result.attempt.assignmentRevision !== input.expectedAssignmentRevision
  ) throw attemptDatabaseError(null);
  return result;
}

export async function getLimitedAttempt(
  request: Request,
  clients: EdgeClients,
  identity: LimitedAttemptIdentity,
  attemptId: string,
) {
  const query = new URL(request.url).searchParams;
  if (
    query.size !== 1 || query.getAll("assignmentRevision").length !== 1 ||
    !/^[1-9]\d*$/.test(query.get("assignmentRevision") ?? "")
  ) invalid();
  const assignmentRevision = version(Number(query.get("assignmentRevision")));
  const { data, error } = await clients.admin.rpc(
    "get_limited_cleaning_attempt",
    {
      p_actor_profile_id: identity.actor.profileId,
      p_session_id: identity.sessionId,
      p_attempt_id: uuid(attemptId),
      p_assignment_revision: assignmentRevision,
    },
  );
  if (error) throw lifecycleDatabaseError(error);
  const result = projection(data, identity.actor);
  if (
    result.attempt.attemptId !== attemptId ||
    result.attempt.assignmentRevision !== assignmentRevision ||
    result.capability === null
  ) throw attemptDatabaseError(null);
  return result;
}

export async function completeLimitedAttempt(
  request: Request,
  clients: EdgeClients,
  identity: LimitedAttemptIdentity,
  attemptId: string,
) {
  if (new URL(request.url).search) invalid();
  const body = await readJsonBody(request);
  exact(body, [
    "expectedExecutionVersion",
    "expectedAssignmentId",
    "expectedAssignmentRevision",
  ]);
  const input = cas(body, attemptId);
  const { data, error } = await clients.admin.rpc(
    "complete_limited_cleaning_attempt_field_work",
    {
      p_actor_profile_id: identity.actor.profileId,
      p_session_id: identity.sessionId,
      ...rpcCas(input),
      p_idempotency_key: idempotencyKey(request),
      p_request_hash: await requestHash(
        identity.actor,
        "complete_limited",
        input,
      ),
    },
  );
  if (error) throw lifecycleDatabaseError(error);
  const result = mutationProjection(data, identity.actor);
  if (
    result.attempt.attemptId !== input.attemptId ||
    result.attempt.assignmentId !== input.expectedAssignmentId ||
    result.attempt.assignmentRevision !== input.expectedAssignmentRevision ||
    result.attempt.executionVersion !== input.expectedExecutionVersion + 1 ||
    result.attempt.status !== "field_completed" || result.nextAttempt !== null
  ) throw attemptDatabaseError(null);
  return result;
}
