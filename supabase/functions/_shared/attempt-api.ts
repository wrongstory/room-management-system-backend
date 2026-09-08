import { idempotencyKey, readJsonBody } from "./account-api.ts";
import {
  type EdgeActor,
  type EdgeClients,
  EdgeError,
  requirePasswordChanged,
} from "./runtime.ts";

export type AttemptAction = "start" | "complete-field-work";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const statuses = [
  "scheduled",
  "in_progress",
  "field_completed",
  "upload_pending",
  "submitted",
  "approved",
  "rejected",
  "interrupted",
  "superseded",
] as const;

export interface AttemptProjection {
  attemptId: string;
  cleaningTargetId: string;
  assignmentId: string;
  maidProfileId: string;
  assignmentRevision: number;
  executionVersion: number;
  status: typeof statuses[number];
  startedAt: string | null;
  fieldCompletedAt: string | null;
  endedAt: string | null;
  effectiveAt: string;
  recordedAt: string;
}

function invalid(): never {
  // 요청 필드명/원문을 오류에 반사하지 않는다.
  throw new EdgeError(
    400,
    "VALIDATION_ERROR",
    "허용된 수행 ID와 version만 전달해 주세요.",
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

function maidOnly(actor: EdgeActor) {
  requirePasswordChanged(actor);
  if (actor.role !== "maid") {
    throw new EdgeError(
      403,
      "MAID_REQUIRED",
      "본인 담당 메이드만 수행 명령을 사용할 수 있습니다.",
    );
  }
}

export function attemptCommandPath(
  path: string,
): { attemptId: string; action: AttemptAction } | null {
  const match = /^\/v1\/attempts\/([^/]+)\/(start|complete-field-work)$/.exec(
    path,
  );
  return match
    ? { attemptId: uuid(match[1]), action: match[2] as AttemptAction }
    : null;
}

export function attemptDatabaseError(
  error: { message?: string } | null,
): EdgeError {
  const statusByCode: Record<string, number> = {
    MAID_REQUIRED: 403,
    PASSWORD_CHANGE_REQUIRED: 403,
    ATTEMPT_ACCESS_REQUIRED: 403,
    ATTEMPT_NOT_FOUND: 404,
    ATTEMPT_VERSION_CONFLICT: 409,
    ASSIGNMENT_VERSION_CONFLICT: 409,
    ATTEMPT_INVALID_TRANSITION: 409,
    MAID_ALREADY_IN_PROGRESS: 409,
    ASSIGNMENT_NOT_NOTIFIED: 409,
    CLEANING_SERVICE_DATE_NOT_DUE: 409,
    CLEANING_SERVICE_DATE_EXPIRED: 409,
    CLEANING_WINDOW_NOT_OPEN: 409,
    CLEANING_WINDOW_EXPIRED: 409,
    ASSIGNMENT_MAID_UNAVAILABLE: 409,
    ATTEMPT_ACTIVATION_NOT_ALLOWED: 409,
    RECLEAN_MAID_IMMUTABLE: 409,
    CHECKOUT_NOT_MATERIALIZED: 409,
    PREVIOUS_ROOM_WORKFLOW_ACTIVE: 409,
    IDEMPOTENCY_KEY_REUSED: 409,
    INVALID_ATTEMPT_COMMAND: 400,
  };
  const code = error?.message ?? "";
  if (Object.hasOwn(statusByCode, code)) {
    return new EdgeError(
      statusByCode[code],
      code,
      "수행 권한·상태·version을 다시 확인해 주세요.",
    );
  }
  return new EdgeError(
    500,
    "ATTEMPT_COMMAND_FAILED",
    "수행 정보를 처리하지 못했습니다.",
  );
}

export function projectAttempt(
  value: unknown,
  actor: EdgeActor,
): AttemptProjection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw attemptDatabaseError(null);
  }
  const row = value as Record<string, unknown>;
  const ids = [
    "attemptId",
    "cleaningTargetId",
    "assignmentId",
    "maidProfileId",
  ] as const;
  const times = ["startedAt", "fieldCompletedAt", "endedAt"] as const;
  const validTime = (time: unknown) =>
    typeof time === "string" && Number.isFinite(Date.parse(time));
  if (
    ids.some((key) =>
      typeof row[key] !== "string" || !uuidPattern.test(row[key] as string)
    ) ||
    ["assignmentRevision", "executionVersion"].some((key) =>
      typeof row[key] !== "number" || !Number.isSafeInteger(row[key]) ||
      (row[key] as number) < 1
    ) ||
    !statuses.includes(row.status as typeof statuses[number]) ||
    times.some((key) => row[key] !== null && !validTime(row[key])) ||
    !validTime(row.effectiveAt) || !validTime(row.recordedAt) ||
    row.maidProfileId !== actor.profileId
  ) throw attemptDatabaseError(null);
  // DB raw snapshot/template/PII가 추가되더라도 명시한 공개 필드만 반환한다.
  return {
    attemptId: row.attemptId as string,
    cleaningTargetId: row.cleaningTargetId as string,
    assignmentId: row.assignmentId as string,
    maidProfileId: row.maidProfileId as string,
    assignmentRevision: row.assignmentRevision as number,
    executionVersion: row.executionVersion as number,
    status: row.status as typeof statuses[number],
    startedAt: row.startedAt as string | null,
    fieldCompletedAt: row.fieldCompletedAt as string | null,
    endedAt: row.endedAt as string | null,
    effectiveAt: row.effectiveAt as string,
    recordedAt: row.recordedAt as string,
  };
}

export async function currentAttempt(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
): Promise<AttemptProjection | null> {
  maidOnly(actor);
  const query = new URL(request.url).searchParams;
  if (query.size !== 1 || query.getAll("assignmentId").length !== 1) invalid();
  const assignmentId = uuid(query.get("assignmentId"));
  const { data, error } = await clients.admin.rpc(
    "get_current_cleaning_attempt",
    {
      p_actor_profile_id: actor.profileId,
      p_assignment_id: assignmentId,
    },
  );
  if (error) throw attemptDatabaseError(error);
  if (data === null) return null;
  const projected = projectAttempt(data, actor);
  if (projected.assignmentId !== assignmentId) throw attemptDatabaseError(null);
  return projected;
}

export async function executeAttempt(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  attemptId: string,
  action: AttemptAction,
): Promise<AttemptProjection> {
  maidOnly(actor);
  if (new URL(request.url).search) invalid();
  const body = await readJsonBody(request);
  const keys = [
    "expectedExecutionVersion",
    "expectedAssignmentId",
    "expectedAssignmentRevision",
  ];
  if (
    Object.keys(body).some((key) => !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(body, key))
  ) invalid();
  const input = {
    attemptId: uuid(attemptId),
    expectedAssignmentId: uuid(body.expectedAssignmentId),
    expectedAssignmentRevision: version(body.expectedAssignmentRevision),
    expectedExecutionVersion: version(body.expectedExecutionVersion),
  };
  const key = idempotencyKey(request);
  // 생성 시각·응답 시각·비밀값은 hash 입력에 포함하지 않는다.
  const canonical = JSON.stringify({
    actorProfileId: actor.profileId,
    action,
    ...input,
  });
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  const hash = [...new Uint8Array(bytes)].map((value) =>
    value.toString(16).padStart(2, "0")
  ).join("");
  const { data, error } = await clients.admin.rpc(
    action === "start"
      ? "start_cleaning_attempt"
      : "complete_cleaning_attempt_field_work",
    {
      p_actor_profile_id: actor.profileId,
      p_attempt_id: input.attemptId,
      p_expected_execution_version: input.expectedExecutionVersion,
      p_expected_assignment_id: input.expectedAssignmentId,
      p_expected_assignment_revision: input.expectedAssignmentRevision,
      p_idempotency_key: key,
      p_request_hash: hash,
    },
  );
  if (error) throw attemptDatabaseError(error);
  const projected = projectAttempt(data, actor);
  if (
    projected.attemptId !== input.attemptId ||
    projected.assignmentId !== input.expectedAssignmentId ||
    projected.assignmentRevision !== input.expectedAssignmentRevision ||
    projected.executionVersion !== input.expectedExecutionVersion + 1 ||
    projected.status !==
      (action === "start" ? "in_progress" : "field_completed")
  ) throw attemptDatabaseError(null);
  return projected;
}
