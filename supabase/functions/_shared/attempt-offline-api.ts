import { idempotencyKey, readJsonBody } from "./account-api.ts";
import { projectAttempt } from "./attempt-api.ts";
import { lifecycleDatabaseError } from "./attempt-lifecycle-api.ts";
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
const resolutions = [
  "record_only",
  "reject_effect",
  "correction_link",
] as const;
const quarantineReasons = [
  "LEASE_EXPIRED",
  "LEASE_REVOKED",
  "ASSIGNMENT_CHANGED",
  "CLOCK_CONFLICT",
  "KST_DATE_CONFLICT",
] as const;
const resolutionReasons = {
  record_only: "OFFLINE_RECORD_ONLY",
  reject_effect: "OFFLINE_REJECT_EFFECT",
  correction_link: "OFFLINE_CORRECTION_APPROVED",
} as const;
function invalid(): never {
  throw new EdgeError(
    400,
    "VALIDATION_ERROR",
    "허용된 오프라인 이벤트와 조회 조건만 전달해 주세요.",
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
function exact(body: Record<string, unknown>, keys: string[]) {
  if (
    Object.keys(body).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(body, key))
  ) invalid();
}
function timestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/
      .test(value) ||
    !Number.isFinite(Date.parse(value))
  ) invalid();
  const day = value.slice(0, 10);
  if (value.startsWith("0000-")) invalid();
  if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) {
    invalid();
  }
  if (
    new Date(value).getUTCFullYear() < 1 ||
    new Date(value).getUTCFullYear() > 9999
  ) invalid();
  return new Date(value).toISOString();
}
function noQuery(request: Request) {
  if (new URL(request.url).search) invalid();
}
function adminOnly(actor: EdgeActor) {
  requirePasswordChanged(actor);
  requireBusinessAdmin(actor);
}
function failed(): never {
  throw new EdgeError(
    500,
    "OFFLINE_EVENT_FAILED",
    "오프라인 수행 정보를 처리하지 못했습니다.",
  );
}
function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) failed();
  return value as Record<string, unknown>;
}
function responseId(value: unknown): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) failed();
  return value;
}
function responseTime(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    failed();
  }
  return value;
}
function safeAttempt(value: unknown, actor: EdgeActor) {
  return projectAttempt(
    value,
    actor.role === "maid"
      ? actor
      : { ...actor, profileId: String(row(value).maidProfileId) },
  );
}
async function hash(actor: EdgeActor, action: string, input: unknown) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify({ actorProfileId: actor.profileId, action, input }),
    ),
  );
  return [...new Uint8Array(bytes)].map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
export function offlineDatabaseError(error: { message?: string } | null) {
  const codes: Record<string, number> = {
    INVALID_OFFLINE_EVENT: 400,
    INVALID_OFFLINE_QUERY: 400,
    INVALID_OFFLINE_RESOLUTION: 400,
    OFFLINE_EVENT_CONFLICT: 409,
    OFFLINE_EVENT_EXPIRED: 409,
    OFFLINE_LEASE_UNKNOWN: 403,
    OFFLINE_QUARANTINE_NOT_FOUND: 403,
    OFFLINE_EVENT_ALREADY_RESOLVED: 409,
    OFFLINE_LEASE_ISSUANCE_CLOSED: 409,
    OFFLINE_CLOCK_UNVERIFIABLE: 409,
  };
  const code = error?.message ?? "";
  if (Object.hasOwn(codes, code)) {
    return new EdgeError(
      codes[code],
      code,
      "이벤트 보존기간·권한·현재 수행 상태를 다시 확인해 주세요.",
    );
  }
  const known = lifecycleDatabaseError(error);
  return known.status < 500 ? known : new EdgeError(
    500,
    "OFFLINE_EVENT_FAILED",
    "오프라인 수행 정보를 처리하지 못했습니다.",
  );
}
export function startWithLeasePath(path: string): string | null {
  const match = /^\/v1\/attempts\/([^/]+)\/start-with-lease$/.exec(path);
  return match ? uuid(match[1]) : null;
}
export function quarantinePath(
  path: string,
): { id: string; resolve: boolean } | null {
  const match = /^\/v1\/offline-quarantines\/([^/]+)(\/resolve)?$/.exec(path);
  return match ? { id: uuid(match[1]), resolve: Boolean(match[2]) } : null;
}

export async function startWithLease(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  attemptId: string,
) {
  requirePasswordChanged(actor);
  if (actor.role !== "maid") {
    throw new EdgeError(
      403,
      "MAID_REQUIRED",
      "본인 담당 메이드만 온라인 시작할 수 있습니다.",
    );
  }
  noQuery(request);
  const body = await readJsonBody(request, 2048);
  exact(body, [
    "expectedExecutionVersion",
    "expectedAssignmentId",
    "expectedAssignmentRevision",
  ]);
  const input = {
    attemptId: uuid(attemptId),
    expectedExecutionVersion: version(body.expectedExecutionVersion),
    expectedAssignmentId: uuid(body.expectedAssignmentId),
    expectedAssignmentRevision: version(body.expectedAssignmentRevision),
  };
  const { data, error } = await clients.admin.rpc(
    "start_cleaning_attempt_with_lease",
    {
      p_actor_profile_id: actor.profileId,
      p_session_id: verifiedRequestSessionId(request),
      p_attempt_id: input.attemptId,
      p_expected_execution_version: input.expectedExecutionVersion,
      p_expected_assignment_id: input.expectedAssignmentId,
      p_expected_assignment_revision: input.expectedAssignmentRevision,
      p_idempotency_key: idempotencyKey(request),
      p_request_hash: await hash(actor, "start_with_lease", input),
    },
  );
  if (error) throw offlineDatabaseError(error);
  const result = row(data);
  const attempt = safeAttempt(result.attempt, actor);
  const lease = row(result.lease);
  if (
    attempt.attemptId !== input.attemptId ||
    attempt.assignmentId !== input.expectedAssignmentId ||
    attempt.assignmentRevision !== input.expectedAssignmentRevision ||
    attempt.executionVersion !== input.expectedExecutionVersion + 1 ||
    attempt.status !== "in_progress" || lease.version !== 1 ||
    lease.attemptId !== attempt.attemptId ||
    lease.assignmentId !== attempt.assignmentId ||
    lease.assignmentRevision !== attempt.assignmentRevision ||
    JSON.stringify(lease.allowedActions) !== '["complete_field_work"]'
  ) failed();
  return {
    attempt,
    lease: {
      leaseId: responseId(lease.leaseId),
      version: 1,
      attemptId: attempt.attemptId,
      assignmentId: attempt.assignmentId,
      assignmentRevision: attempt.assignmentRevision,
      issuedAt: responseTime(lease.issuedAt),
      expiresAt: responseTime(lease.expiresAt),
      metadataExpiresAt: responseTime(lease.metadataExpiresAt),
      allowedActions: ["complete_field_work"],
    },
    serverTime: responseTime(result.serverTime),
  };
}

export async function syncOfflineEvent(
  request: Request,
  clients: EdgeClients,
  identity: LimitedAttemptIdentity,
) {
  noQuery(request);
  const body = await readJsonBody(request, 2048);
  exact(body, [
    "leaseId",
    "eventId",
    "expectedExecutionVersion",
    "occurredAt",
    "serverOffsetMs",
  ]);
  if (
    typeof body.serverOffsetMs !== "number" ||
    !Number.isSafeInteger(body.serverOffsetMs) ||
    Math.abs(body.serverOffsetMs) > 86_400_000
  ) invalid();
  const occurredAt = timestamp(body.occurredAt);
  const normalizedYear = new Date(Date.parse(occurredAt) + body.serverOffsetMs)
    .getUTCFullYear();
  if (normalizedYear < 1 || normalizedYear > 9999) invalid();
  const eventId = uuid(body.eventId);
  // UUID와 client clock은 90일 저장소에만 전달한다. activity/영구 command receipt에 복제하지 않는다.
  const { data, error } = await clients.admin.rpc(
    "sync_cleaning_attempt_event",
    {
      p_actor_profile_id: identity.actor.profileId,
      p_session_id: identity.sessionId,
      p_lease_id: uuid(body.leaseId),
      p_event_id: eventId,
      p_expected_execution_version: version(body.expectedExecutionVersion),
      p_occurred_at: occurredAt,
      p_server_offset_ms: body.serverOffsetMs,
    },
  );
  if (error) throw offlineDatabaseError(error);
  const result = row(data);
  if (
    result.eventId !== eventId ||
    !["applied", "quarantined"].includes(String(result.outcome))
  ) failed();
  const base = {
    eventId,
    outcome: result.outcome as "applied" | "quarantined",
    receivedAt: responseTime(result.receivedAt),
    metadataExpiresAt: responseTime(result.metadataExpiresAt),
  };
  if (result.outcome === "applied") {
    const attempt = safeAttempt(result.attempt, identity.actor);
    if (
      attempt.status !== "field_completed" ||
      attempt.executionVersion !== Number(body.expectedExecutionVersion) + 1
    ) failed();
    return { ...base, attempt };
  }
  if (
    !quarantineReasons.includes(
      result.reasonCode as typeof quarantineReasons[number],
    )
  ) failed();
  return {
    ...base,
    reasonCode: result.reasonCode,
    quarantineId: responseId(result.quarantineId),
  };
}

function quarantine(value: unknown, actor: EdgeActor) {
  const result = row(value);
  if (
    typeof result.assignmentRevision !== "number" ||
    !Number.isSafeInteger(result.assignmentRevision) ||
    result.assignmentRevision < 1 ||
    !quarantineReasons.includes(
      result.reasonCode as typeof quarantineReasons[number],
    ) ||
    (result.resolution !== null &&
      !resolutions.includes(result.resolution as typeof resolutions[number]))
  ) failed();
  return {
    quarantineId: responseId(result.quarantineId),
    attemptId: responseId(result.attemptId),
    assignmentId: responseId(result.assignmentId),
    assignmentRevision: result.assignmentRevision,
    actorProfileId: responseId(result.actorProfileId),
    reasonCode: result.reasonCode,
    occurredAt: responseTime(result.occurredAt),
    receivedAt: responseTime(result.receivedAt),
    metadataExpiresAt: responseTime(result.metadataExpiresAt),
    resolution: result.resolution as typeof resolutions[number] | null,
    currentAttempt: result.currentAttempt === null
      ? null
      : safeAttempt(result.currentAttempt, actor),
  };
}
export async function getOfflineQuarantine(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  id: string,
) {
  adminOnly(actor);
  noQuery(request);
  const { data, error } = await clients.admin.rpc(
    "get_offline_event_quarantine",
    {
      p_actor_profile_id: actor.profileId,
      p_session_id: verifiedRequestSessionId(request),
      p_quarantine_id: uuid(id),
    },
  );
  if (error) throw offlineDatabaseError(error);
  const result = quarantine(data, actor);
  if (result.quarantineId !== id) failed();
  return result;
}
export async function listOfflineQuarantines(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
) {
  adminOnly(actor);
  const query = new URL(request.url).searchParams;
  if (
    [...query.keys()].some((key) =>
      !["from", "to", "limit", "cursor"].includes(key) ||
      query.getAll(key).length !== 1
    )
  ) invalid();
  const to = timestamp(query.get("to") ?? new Date().toISOString());
  const from = timestamp(
    query.get("from") ??
      new Date(Date.parse(to) - 7 * 86_400_000).toISOString(),
  );
  if (
    Date.parse(from) >= Date.parse(to) ||
    Date.parse(to) - Date.parse(from) > 31 * 86_400_000
  ) invalid();
  const rawLimit = query.get("limit") ?? "50";
  if (!/^[1-9]\d{0,2}$/.test(rawLimit) || Number(rawLimit) > 100) invalid();
  let before: { receivedAt: string; id: string } | null = null;
  const cursor = query.get("cursor");
  if (cursor === "") invalid();
  if (cursor) {
    if (cursor.length > 256) invalid();
    try {
      const decoded = JSON.parse(atob(cursor));
      if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
        invalid();
      }
      exact(decoded, ["receivedAt", "id"]);
      before = {
        receivedAt: timestamp(decoded.receivedAt),
        id: uuid(decoded.id),
      };
    } catch {
      invalid();
    }
  }
  const { data, error } = await clients.admin.rpc(
    "list_offline_event_quarantine",
    {
      p_actor_profile_id: actor.profileId,
      p_session_id: verifiedRequestSessionId(request),
      p_from: from,
      p_to: to,
      p_limit: Number(rawLimit),
      p_cursor_received_at: before?.receivedAt ?? null,
      p_cursor_id: before?.id ?? null,
    },
  );
  if (error) throw offlineDatabaseError(error);
  const result = row(data);
  if (!Array.isArray(result.items) || result.items.length > Number(rawLimit)) {
    failed();
  }
  const next = result.nextCursor === null ? null : row(result.nextCursor);
  return {
    items: result.items.map((item) => quarantine(item, actor)),
    nextCursor: next
      ? btoa(
        JSON.stringify({
          receivedAt: responseTime(next.receivedAt),
          id: responseId(next.id),
        }),
      )
      : null,
  };
}
export async function resolveOfflineQuarantine(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  id: string,
) {
  adminOnly(actor);
  noQuery(request);
  const body = await readJsonBody(request, 2048);
  exact(body, ["resolution", "expectedExecutionVersion", "reasonCode"]);
  if (!resolutions.includes(body.resolution as typeof resolutions[number])) {
    invalid();
  }
  const resolution = body.resolution as typeof resolutions[number];
  if (body.reasonCode !== resolutionReasons[resolution]) invalid();
  const expectedVersion = resolution === "correction_link"
    ? version(body.expectedExecutionVersion)
    : null;
  if (
    resolution !== "correction_link" && body.expectedExecutionVersion !== null
  ) invalid();
  const input = {
    quarantineId: uuid(id),
    resolution,
    expectedExecutionVersion: expectedVersion,
    reasonCode: resolutionReasons[resolution],
  };
  const { data, error } = await clients.admin.rpc(
    "resolve_offline_event_quarantine",
    {
      p_actor_profile_id: actor.profileId,
      p_session_id: verifiedRequestSessionId(request),
      p_quarantine_id: input.quarantineId,
      p_resolution: resolution,
      p_expected_execution_version: expectedVersion,
      p_reason_code: input.reasonCode,
      p_idempotency_key: idempotencyKey(request),
      p_request_hash: await hash(actor, "resolve_offline", input),
    },
  );
  if (error) throw offlineDatabaseError(error);
  const result = row(data);
  if (result.quarantineId !== id || result.resolution !== resolution) failed();
  const attempt = result.attempt === null
    ? null
    : safeAttempt(result.attempt, actor);
  if (
    resolution === "correction_link"
      ? attempt?.status !== "field_completed" ||
        attempt.executionVersion !== Number(expectedVersion) + 1
      : attempt !== null
  ) failed();
  return {
    quarantineId: id,
    resolution,
    attempt,
    effectiveAt: responseTime(result.effectiveAt),
    recordedAt: responseTime(result.recordedAt),
  };
}
