import type { EdgeActor, EdgeClients } from "./runtime.ts";
import {
  bearerToken,
  EdgeError,
  requireBusinessAdmin,
  requirePasswordChanged,
} from "./runtime.ts";
import { idempotencyKey, readJsonBody } from "./account-api.ts";

interface AssignmentRow {
  id: string;
  cleaning_target_id: string;
  maid_profile_id: string;
  service_date: string;
  sequence_number: number;
  revision: number;
  is_current: boolean;
  available_from_snapshot: string | null;
  due_at_snapshot: string | null;
  notified_at: string | null;
  ended_at: string | null;
  created_at: string;
}

interface TargetRow {
  id: string;
  room_id: string;
  assignment_version: number;
  rooms?: { room_number: string } | Array<{ room_number: string }> | null;
}

interface MaidRow {
  id: string;
  display_name: string;
}

export interface AssignmentProjection {
  assignmentId: string;
  cleaningTargetId: string;
  roomId: string;
  roomNumber: string;
  maidProfileId: string;
  maidDisplayName: string;
  serviceDate: string;
  sequenceNumber: number;
  revision: number;
  isCurrent: boolean;
  targetAssignmentVersion: number;
  availableFrom: string | null;
  dueAt: string | null;
  notifiedAt: string | null;
  endedAt: string | null;
  createdAt: string;
}

// 사용자가 입력한 상세 사유는 감사·알림으로 복제하지 않는다.
export const prestartReasonCodes = [
  "MAID_UNAVAILABLE",
  "SCHEDULE_CHANGED",
  "SEQUENCE_CHANGED",
  "OPERATIONAL_CHANGE",
] as const;
export const cancellationReasonCodes = [
  "PERSONAL_REASON",
  "HEALTH_REASON",
  "MAID_UNAVAILABLE",
  "OPERATIONAL_CHANGE",
] as const;
export const decisionReasonCodes = [
  "APPROVED",
  "REJECTED",
  "OPERATIONAL_CHANGE",
  "MAID_UNAVAILABLE",
] as const;
export type PrestartAction =
  | "change"
  | "unassign"
  | "cancellation-requests"
  | "decision";

export function prestartPath(
  path: string,
): { id: string; action: PrestartAction } | null {
  const match =
    /^\/v1\/assignments\/([^/]+)\/(change|unassign|cancellation-requests)$/
      .exec(path);
  if (match) {
    return {
      id: uuidValue(match[1], "cleaningTargetId"),
      action: match[2] as PrestartAction,
    };
  }
  const decision = /^\/v1\/assignment-change-requests\/([^/]+)\/decision$/.exec(
    path,
  );
  return decision
    ? { id: uuidValue(decision[1], "requestId"), action: "decision" }
    : null;
}

function timestampValue(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(
      value,
    ) || !Number.isFinite(Date.parse(value))
  ) {
    validationError(`${name}에 offset이 있는 날짜와 시간이 필요합니다.`);
  }
  return new Date(value).toISOString();
}

function requestProjection(value: unknown) {
  const row = objectValue(value);
  return {
    requestId: uuidValue(row.requestId, "requestId"),
    cleaningTargetId: uuidValue(row.cleaningTargetId, "cleaningTargetId"),
    assignmentId: uuidValue(row.assignmentId, "assignmentId"),
    maidProfileId: uuidValue(row.maidProfileId, "maidProfileId"),
    requestType: row.requestType,
    reasonCode: row.reasonCode,
    reasonDetail: row.reasonDetail ?? null,
    status: row.status,
    sourceAssignmentRevision: row.sourceAssignmentRevision,
    sourceTargetAssignmentVersion: row.sourceTargetAssignmentVersion,
    requestedAt: row.requestedAt,
    decision: row.decision ?? null,
    decisionReasonCode: row.decisionReasonCode ?? null,
    decidedAt: row.decidedAt ?? null,
  };
}

export async function prestartCommand(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  id: string,
  action: PrestartAction,
) {
  requirePasswordChanged(actor);
  if (action === "cancellation-requests") {
    if (actor.role !== "maid") {
      throw new EdgeError(
        403,
        "MAID_REQUIRED",
        "메이드만 본인 담당 취소를 요청할 수 있습니다.",
      );
    }
  } else requireBusinessAdmin(actor);
  const body = await readJsonBody(request);
  const required = [
    "expectedCurrentAssignmentId",
    "expectedAssignmentVersion",
    "reasonCode",
    ...(action === "change" ? ["maidProfileId", "sequenceNumber"] : []),
    ...(action === "decision" ? ["decision"] : []),
  ];
  const optional = action === "change"
    ? ["availableFrom", "dueAt"]
    : action === "cancellation-requests"
    ? ["reasonDetail"]
    : [];
  if (
    Object.keys(body).some((k) =>
      !required.includes(k) && !optional.includes(k)
    ) || required.some((k) => !Object.hasOwn(body, k))
  ) validationError("필수 필드 또는 허용 필드를 확인해 주세요.");
  const reasons: readonly string[] = action === "cancellation-requests"
    ? cancellationReasonCodes
    : action === "decision"
    ? decisionReasonCodes
    : prestartReasonCodes;
  if (
    typeof body.reasonCode !== "string" || !reasons.includes(body.reasonCode)
  ) validationError("유효한 reasonCode가 필요합니다.");
  const payload: Record<string, unknown> = {
    p_actor_profile_id: actor.profileId,
    p_expected_current_assignment_id: uuidValue(
      body.expectedCurrentAssignmentId,
      "expectedCurrentAssignmentId",
    ),
    p_expected_assignment_version: integerValue(
      body.expectedAssignmentVersion,
      "expectedAssignmentVersion",
      1,
    ),
    p_reason_code: body.reasonCode,
  };
  if (action === "decision") {
    if (body.decision !== "approved" && body.decision !== "rejected") {
      validationError("decision은 approved 또는 rejected여야 합니다.");
    }
    payload.p_request_id = uuidValue(id, "requestId");
    payload.p_decision = body.decision;
  } else payload.p_cleaning_target_id = uuidValue(id, "cleaningTargetId");
  if (action === "change") {
    payload.p_maid_profile_id = uuidValue(body.maidProfileId, "maidProfileId");
    payload.p_sequence_number = integerValue(
      body.sequenceNumber,
      "sequenceNumber",
      1,
    );
    payload.p_available_from = body.availableFrom === undefined
      ? null
      : timestampValue(body.availableFrom, "availableFrom");
    payload.p_due_at = body.dueAt === undefined
      ? null
      : timestampValue(body.dueAt, "dueAt");
  }
  if (action === "cancellation-requests") {
    if (
      body.reasonDetail !== undefined &&
      (typeof body.reasonDetail !== "string" ||
        body.reasonDetail.trim().length < 1 || body.reasonDetail.length > 200 ||
        /[0-9@:/]/.test(body.reasonDetail))
    ) {
      validationError(
        "상세 사유는 200자 이하이며 숫자·연락처·PIN·URL·인증정보를 포함할 수 없습니다.",
      );
    }
    payload.p_reason_detail = body.reasonDetail ?? null;
  }
  const rpc = {
    change: "change_cleaning_assignment_prestart",
    unassign: "unassign_cleaning_assignment_prestart",
    "cancellation-requests": "request_assignment_cancellation",
    decision: "decide_assignment_cancellation_request",
  }[action];
  const hash = await requestHash({ command: rpc, ...payload });
  const { data, error } = await clients.admin.rpc(rpc, {
    ...payload,
    p_idempotency_key: idempotencyKey(request),
    p_request_hash: hash,
  });
  if (error || !data) throw prestartDatabaseError(error);
  return action === "change" || action === "unassign"
    ? toAssignmentProjection(data)
    : requestProjection(data);
}

export function prestartDatabaseError(error: { message?: string } | null) {
  const code = error?.message;
  const allowed = [
    "ASSIGNMENT_NOT_FOUND",
    "ASSIGNMENT_VERSION_CONFLICT",
    "ASSIGNMENT_PRESTART_REQUIRED",
    "ASSIGNMENT_ALREADY_STARTED",
    "ASSIGNMENT_MAID_UNAVAILABLE",
    "ASSIGNMENT_SEQUENCE_CONFLICT",
    "RECLEAN_MAID_IMMUTABLE",
    "ASSIGNMENT_CHANGE_REQUEST_EXISTS",
    "ASSIGNMENT_CHANGE_REQUEST_NOT_FOUND",
    "ASSIGNMENT_CHANGE_REQUEST_STALE",
    "ASSIGNMENT_CHANGE_REQUEST_ALREADY_DECIDED",
    "ASSIGNMENT_CHANGE_REQUEST_ACCESS_REQUIRED",
    "ASSIGNMENT_ACCESS_REQUIRED",
    "IDEMPOTENCY_KEY_REUSED",
    "ASSIGNMENT_SCHEDULE_INVALID",
    "ASSIGNMENT_QUERY_INVALID",
    "ASSIGNMENT_INPUT_INVALID",
    "ASSIGNMENT_REASON_INVALID",
    "ADMIN_REQUIRED",
    "MAID_REQUIRED",
  ];
  if (code && allowed.includes(code)) {
    return new EdgeError(
      code === "ADMIN_REQUIRED" || code === "MAID_REQUIRED" ||
        code.endsWith("ACCESS_REQUIRED")
        ? 403
        : code.endsWith("NOT_FOUND")
        ? 404
        : code.endsWith("INVALID")
        ? 400
        : 409,
      code,
      "청소 배정의 권한·현재 상태·입력값을 다시 확인해 주세요.",
    );
  }
  return new EdgeError(
    500,
    "ASSIGNMENT_COMMAND_FAILED",
    "청소 배정 요청을 처리하지 못했습니다.",
  );
}

export async function listAssignmentChangeRequests(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
) {
  requireAssignmentReader(actor);
  const search = queryValues(request, [
    "maidProfileId",
    "status",
    "from",
    "to",
    "cursor",
    "limit",
  ]);
  const maidId = search.has("maidProfileId")
    ? uuidValue(search.get("maidProfileId"), "maidProfileId")
    : null;
  if (actor.role === "maid" && maidId && maidId !== actor.profileId) {
    throw new EdgeError(
      403,
      "ASSIGNMENT_CHANGE_REQUEST_ACCESS_REQUIRED",
      "본인 요청만 조회할 수 있습니다.",
    );
  }
  const status = search.get("status");
  if (
    status &&
    !["pending", "approved", "rejected", "superseded"].includes(status)
  ) validationError("유효하지 않은 요청 상태입니다.");
  const limit = search.has("limit")
    ? integerValue(Number(search.get("limit")), "limit", 1)
    : 50;
  if (limit > 100) validationError("한 번에 100건까지만 조회할 수 있습니다.");
  const to = search.has("to")
    ? timestampValue(search.get("to"), "to")
    : new Date().toISOString();
  const from = search.has("from")
    ? timestampValue(search.get("from"), "from")
    : new Date(Date.parse(to) - 7 * 86400000).toISOString();
  if (
    Date.parse(to) < Date.parse(from) ||
    Date.parse(to) - Date.parse(from) > 31 * 86400000
  ) validationError("조회 기간은 최대 31일입니다.");
  let beforeAt: string | null = null;
  let beforeId: string | null = null;
  if (search.has("cursor")) {
    try {
      const raw = search.get("cursor") ?? "";
      if (raw.length > 256) throw new Error();
      const value = JSON.parse(atob(raw));
      timestampValue(value.at, "cursor");
      // PostgreSQL의 microsecond 정밀도를 보존한다. Date 변환은 같은 millisecond의 행을 건너뛸 수 있다.
      beforeAt = value.at;
      beforeId = uuidValue(value.id, "cursor");
    } catch {
      validationError("유효하지 않은 cursor입니다.");
    }
  }
  const { data, error } = await clients.admin.rpc(
    "list_assignment_change_requests",
    {
      p_actor_profile_id: actor.profileId,
      p_maid_profile_id: actor.role === "maid" ? actor.profileId : maidId,
      p_status: status,
      p_from: from,
      p_to: to,
      p_before_at: beforeAt,
      p_before_id: beforeId,
      p_limit: limit,
    },
  );
  if (error || !Array.isArray(data)) throw prestartDatabaseError(error);
  const requests = data.map(requestProjection);
  const last = requests.at(-1);
  return {
    requests,
    nextCursor: requests.length === limit && last
      ? btoa(JSON.stringify({ at: last.requestedAt, id: last.requestId }))
      : null,
  };
}

export interface AssignmentCommitCandidate {
  assignmentId: string;
  cleaningTargetId: string;
  roomId: string;
  roomNumber: string;
  maidProfileId: string;
  maidDisplayName: string;
  serviceDate: string;
  sequenceNumber: number;
  revision: number;
  targetAssignmentVersion: number;
  expectedAvailabilityVersion: number;
  availableFrom: string | null;
  dueAt: string | null;
}

export interface AssignmentCommitBlockedCandidate {
  assignmentId: string;
  cleaningTargetId: string;
  roomId: string;
  roomNumber: string;
  maidProfileId: string;
  maidDisplayName: string;
  serviceDate: string;
  sequenceNumber: number;
  revision: number;
  targetAssignmentVersion: number;
  currentAvailabilityVersion: number | null;
  reasonCodes: string[];
  availableFrom: string | null;
  dueAt: string | null;
}

export interface AssignmentCommitUnassignedTarget {
  cleaningTargetId: string;
  roomId: string;
  roomNumber: string;
  serviceDate: string;
  status: "unassigned";
  targetAssignmentVersion: number;
  availableFrom: string | null;
  dueAt: string | null;
}

export interface AssignmentCommitImpact {
  serviceDate: string;
  impactFingerprint: string;
  committableDrafts: AssignmentCommitCandidate[];
  blockedDrafts: AssignmentCommitBlockedCandidate[];
  remainingUnassignedTargets: AssignmentCommitUnassignedTarget[];
}

export interface AssignmentCommitResult {
  serviceDate: string;
  impactFingerprint: string;
  notifiedAssignments: Array<
    AssignmentCommitCandidate & {
      notifiedAt: string;
    }
  >;
  remainingDrafts: AssignmentCommitCandidate[];
  blockedDrafts: AssignmentCommitBlockedCandidate[];
  unassignedTargets: AssignmentCommitUnassignedTarget[];
}

const assignmentColumns = [
  "id",
  "cleaning_target_id",
  "maid_profile_id",
  "service_date",
  "sequence_number",
  "revision",
  "is_current",
  "available_from_snapshot",
  "due_at_snapshot",
  "notified_at",
  "ended_at",
  "created_at",
].join(",");

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;

function validationError(message: string): never {
  throw new EdgeError(400, "VALIDATION_ERROR", message);
}

function uuidValue(value: unknown, name: string): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    validationError(`${name}에 UUID가 필요합니다.`);
  }
  return value;
}

function dateValue(value: unknown, name: string): string {
  if (typeof value !== "string" || !datePattern.test(value)) {
    validationError(`${name}은 YYYY-MM-DD 형식이어야 합니다.`);
  }
  const [yearText, monthText, dayText] = value.split("-");
  const parsed = new Date(
    Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText)),
  );
  if (
    parsed.getUTCFullYear() !== Number(yearText) ||
    parsed.getUTCMonth() !== Number(monthText) - 1 ||
    parsed.getUTCDate() !== Number(dayText)
  ) {
    validationError(`${name}에 유효한 날짜가 필요합니다.`);
  }
  return value;
}

function integerValue(value: unknown, name: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    validationError(`${name}은 ${minimum} 이상의 정수여야 합니다.`);
  }
  return value as number;
}

function booleanValue(value: string | null, name: string): boolean {
  if (value === null || value === "false") return false;
  if (value === "true") return true;
  validationError(`${name}은 true 또는 false여야 합니다.`);
}

function assertOnlyFields(
  body: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const unexpected = Object.keys(body).find((key) => !allowed.includes(key));
  if (unexpected) {
    validationError(`허용되지 않은 요청 필드입니다: ${unexpected}`);
  }
  const missing = allowed.find((key) => !Object.hasOwn(body, key));
  if (missing) {
    validationError(`필수 요청 필드가 없습니다: ${missing}`);
  }
}

function queryValues(request: Request, allowed: readonly string[]) {
  const search = new URL(request.url).searchParams;
  for (const key of search.keys()) {
    if (!allowed.includes(key)) {
      validationError(`허용되지 않은 query 항목입니다: ${key}`);
    }
    if (search.getAll(key).length > 1) {
      validationError(`query 항목은 한 번만 전달해야 합니다: ${key}`);
    }
  }
  return search;
}

function requireAssignmentReader(actor: EdgeActor): void {
  requirePasswordChanged(actor);
  if (actor.role !== "admin" && actor.role !== "maid") {
    throw new EdgeError(
      403,
      "ASSIGNMENT_ACCESS_REQUIRED",
      "관리자 또는 배정된 메이드만 청소 배정을 조회할 수 있습니다.",
    );
  }
}

function requireAssignmentAdmin(actor: EdgeActor): void {
  requirePasswordChanged(actor);
  requireBusinessAdmin(actor);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

async function requestHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function assignmentTargetIdFromPath(path: string): string | null {
  const match = path.match(/^\/v1\/assignments\/([^/]+)\/history$/);
  if (!match?.[1]) return null;
  return uuidValue(match[1], "cleaningTargetId");
}

export function assignmentDatabaseError(
  error: { message?: string } | null,
): EdgeError {
  const message = error?.message ?? "";
  const mappings: Array<[string, number, string, string]> = [
    [
      "ADMIN_REQUIRED",
      403,
      "ADMIN_REQUIRED",
      "관리자만 배정을 저장할 수 있습니다.",
    ],
    [
      "CLEANING_TARGET_NOT_FOUND",
      404,
      "CLEANING_TARGET_NOT_FOUND",
      "청소 대상을 찾을 수 없습니다.",
    ],
    [
      "ASSIGNMENT_VERSION_CONFLICT",
      409,
      "ASSIGNMENT_VERSION_CONFLICT",
      "배정 version이 변경되었습니다. 최신 상태를 다시 확인해 주세요.",
    ],
    [
      "ASSIGNMENT_IMPACT_CHANGED",
      409,
      "ASSIGNMENT_IMPACT_CHANGED",
      "배정 영향도가 변경되었습니다. preflight를 다시 실행해 주세요.",
    ],
    [
      "ASSIGNMENT_DRAFT_STALE_SCHEDULE",
      409,
      "ASSIGNMENT_DRAFT_STALE_SCHEDULE",
      "배정 이후 청소 일정이 변경되었습니다. draft를 다시 저장해 주세요.",
    ],
    [
      "ASSIGNMENT_AVAILABILITY_REQUIRED",
      409,
      "ASSIGNMENT_AVAILABILITY_REQUIRED",
      "메이드가 해당 주의 가능일을 아직 제출하지 않았습니다.",
    ],
    [
      "ASSIGNMENT_AVAILABILITY_STALE",
      409,
      "ASSIGNMENT_AVAILABILITY_STALE",
      "메이드 가능일이 변경되었습니다. preflight를 다시 실행해 주세요.",
    ],
    [
      "ASSIGNMENT_MAID_UNAVAILABLE",
      409,
      "ASSIGNMENT_MAID_UNAVAILABLE",
      "현재 활성 상태이며 가능한 메이드에게만 알릴 수 있습니다.",
    ],
    [
      "ASSIGNMENT_WINDOW_EXPIRED",
      409,
      "ASSIGNMENT_WINDOW_EXPIRED",
      "청소 완료 기한이 지나 알림을 확정할 수 없습니다.",
    ],
    [
      "ASSIGNMENT_COMMIT_NOT_ALLOWED",
      409,
      "ASSIGNMENT_COMMIT_NOT_ALLOWED",
      "현재 배정 상태 또는 날짜에는 알림을 확정할 수 없습니다.",
    ],
    [
      "ASSIGNMENT_TARGET_STATE_INVALID",
      409,
      "ASSIGNMENT_TARGET_STATE_INVALID",
      "현재 청소 대상 상태에서는 draft 배정을 저장할 수 없습니다.",
    ],
    [
      "ACTIVE_MAID_REQUIRED",
      409,
      "ACTIVE_MAID_REQUIRED",
      "활성 메이드 계정이 필요합니다.",
    ],
    [
      "cleaning_assignments_current_maid_date_sequence",
      409,
      "ASSIGNMENT_SEQUENCE_CONFLICT",
      "해당 메이드의 같은 날짜 순서가 이미 사용 중입니다.",
    ],
    [
      "IDEMPOTENCY_KEY_REUSED",
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "이미 다른 요청에 사용한 Idempotency-Key입니다.",
    ],
  ];
  for (const [needle, status, code, userMessage] of mappings) {
    if (message.includes(needle)) {
      return new EdgeError(status, code, userMessage);
    }
  }
  return new EdgeError(
    500,
    "ASSIGNMENT_COMMAND_FAILED",
    "청소 배정 정보를 처리하지 못했습니다.",
  );
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw assignmentDatabaseError(null);
  }
  return value as Record<string, unknown>;
}

function nullablePositiveInteger(value: unknown, name: string): number | null {
  return value === null ? null : integerValue(value, name, 1);
}

function stringArray(value: unknown): string[] {
  if (
    !Array.isArray(value) || value.length === 0 ||
    value.some((item) => typeof item !== "string")
  ) {
    throw assignmentDatabaseError(null);
  }
  return value as string[];
}

function toCommitCandidate(value: unknown): AssignmentCommitCandidate {
  const row = objectValue(value);
  return {
    assignmentId: uuidValue(row.assignmentId, "assignmentId"),
    cleaningTargetId: uuidValue(row.cleaningTargetId, "cleaningTargetId"),
    roomId: uuidValue(row.roomId, "roomId"),
    roomNumber: String(row.roomNumber),
    maidProfileId: uuidValue(row.maidProfileId, "maidProfileId"),
    maidDisplayName: String(row.maidDisplayName),
    serviceDate: dateValue(row.serviceDate, "serviceDate"),
    sequenceNumber: integerValue(row.sequenceNumber, "sequenceNumber", 1),
    revision: integerValue(row.revision, "revision", 1),
    targetAssignmentVersion: integerValue(
      row.targetAssignmentVersion,
      "targetAssignmentVersion",
      1,
    ),
    expectedAvailabilityVersion: integerValue(
      row.expectedAvailabilityVersion,
      "expectedAvailabilityVersion",
      1,
    ),
    availableFrom: typeof row.availableFrom === "string"
      ? row.availableFrom
      : null,
    dueAt: typeof row.dueAt === "string" ? row.dueAt : null,
  };
}

function toBlockedCandidate(
  value: unknown,
): AssignmentCommitBlockedCandidate {
  const row = objectValue(value);
  return {
    assignmentId: uuidValue(row.assignmentId, "assignmentId"),
    cleaningTargetId: uuidValue(row.cleaningTargetId, "cleaningTargetId"),
    roomId: uuidValue(row.roomId, "roomId"),
    roomNumber: String(row.roomNumber),
    maidProfileId: uuidValue(row.maidProfileId, "maidProfileId"),
    maidDisplayName: String(row.maidDisplayName),
    serviceDate: dateValue(row.serviceDate, "serviceDate"),
    sequenceNumber: integerValue(row.sequenceNumber, "sequenceNumber", 1),
    revision: integerValue(row.revision, "revision", 1),
    targetAssignmentVersion: integerValue(
      row.targetAssignmentVersion,
      "targetAssignmentVersion",
      1,
    ),
    currentAvailabilityVersion: nullablePositiveInteger(
      row.currentAvailabilityVersion,
      "currentAvailabilityVersion",
    ),
    reasonCodes: stringArray(row.reasonCodes),
    availableFrom: typeof row.availableFrom === "string"
      ? row.availableFrom
      : null,
    dueAt: typeof row.dueAt === "string" ? row.dueAt : null,
  };
}

function toUnassignedTarget(
  value: unknown,
): AssignmentCommitUnassignedTarget {
  const row = objectValue(value);
  if (row.status !== "unassigned") throw assignmentDatabaseError(null);
  return {
    cleaningTargetId: uuidValue(row.cleaningTargetId, "cleaningTargetId"),
    roomId: uuidValue(row.roomId, "roomId"),
    roomNumber: String(row.roomNumber),
    serviceDate: dateValue(row.serviceDate, "serviceDate"),
    status: "unassigned",
    targetAssignmentVersion: integerValue(
      row.targetAssignmentVersion,
      "targetAssignmentVersion",
      1,
    ),
    availableFrom: typeof row.availableFrom === "string"
      ? row.availableFrom
      : null,
    dueAt: typeof row.dueAt === "string" ? row.dueAt : null,
  };
}

function arrayValue(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw assignmentDatabaseError(null);
  return value;
}

function impactFingerprint(value: unknown): string {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    throw assignmentDatabaseError(null);
  }
  return value;
}

function toAssignmentCommitImpact(value: unknown): AssignmentCommitImpact {
  const row = objectValue(value);
  return {
    serviceDate: dateValue(row.serviceDate, "serviceDate"),
    impactFingerprint: impactFingerprint(row.impactFingerprint),
    committableDrafts: arrayValue(row.committableDrafts).map(
      toCommitCandidate,
    ),
    blockedDrafts: arrayValue(row.blockedDrafts).map(toBlockedCandidate),
    remainingUnassignedTargets: arrayValue(row.remainingUnassignedTargets).map(
      toUnassignedTarget,
    ),
  };
}

function toAssignmentCommitResult(value: unknown): AssignmentCommitResult {
  const row = objectValue(value);
  const notifiedAssignments = arrayValue(row.notifiedAssignments).map(
    (value) => {
      const assignment = objectValue(value);
      const projected = toCommitCandidate(assignment);
      if (typeof assignment.notifiedAt !== "string") {
        throw assignmentDatabaseError(null);
      }
      return { ...projected, notifiedAt: assignment.notifiedAt };
    },
  );
  return {
    serviceDate: dateValue(row.serviceDate, "serviceDate"),
    impactFingerprint: impactFingerprint(row.impactFingerprint),
    notifiedAssignments,
    remainingDrafts: arrayValue(row.remainingDrafts).map(toCommitCandidate),
    blockedDrafts: arrayValue(row.blockedDrafts).map(toBlockedCandidate),
    unassignedTargets: arrayValue(row.unassignedTargets).map(
      toUnassignedTarget,
    ),
  };
}

function accessTokenClient(request: Request, clients: EdgeClients) {
  return clients.forAccessToken(bearerToken(request));
}

function roomNumber(target: TargetRow): string {
  const rooms = target.rooms;
  const room = Array.isArray(rooms) ? rooms[0] : rooms;
  if (!room?.room_number) {
    throw new EdgeError(
      500,
      "ASSIGNMENT_COMMAND_FAILED",
      "청소 배정 정보를 처리하지 못했습니다.",
    );
  }
  return room.room_number;
}

async function hydrateAssignments(
  clients: EdgeClients,
  rows: AssignmentRow[],
): Promise<AssignmentProjection[]> {
  if (rows.length === 0) return [];
  const targetIds = [...new Set(rows.map((row) => row.cleaning_target_id))];
  const maidIds = [...new Set(rows.map((row) => row.maid_profile_id))];
  const [targetResult, maidResult] = await Promise.all([
    clients.admin
      .from("cleaning_targets")
      .select("id,room_id,assignment_version,rooms!inner(room_number)")
      .in("id", targetIds),
    clients.admin
      .from("profiles")
      .select("id,display_name")
      .in("id", maidIds),
  ]);
  if (targetResult.error || maidResult.error) {
    throw assignmentDatabaseError(targetResult.error ?? maidResult.error);
  }
  const targets = new Map(
    ((targetResult.data ?? []) as unknown as TargetRow[]).map((row) => [
      row.id,
      row,
    ]),
  );
  const maids = new Map(
    ((maidResult.data ?? []) as MaidRow[]).map((row) => [row.id, row]),
  );

  return rows.map((row) => {
    const target = targets.get(row.cleaning_target_id);
    const maid = maids.get(row.maid_profile_id);
    if (!target || !maid) {
      throw new EdgeError(
        500,
        "ASSIGNMENT_COMMAND_FAILED",
        "청소 배정 정보를 처리하지 못했습니다.",
      );
    }
    return {
      assignmentId: row.id,
      cleaningTargetId: row.cleaning_target_id,
      roomId: target.room_id,
      roomNumber: roomNumber(target),
      maidProfileId: row.maid_profile_id,
      maidDisplayName: maid.display_name,
      serviceDate: row.service_date,
      sequenceNumber: row.sequence_number,
      revision: row.revision,
      isCurrent: row.is_current,
      targetAssignmentVersion: target.assignment_version,
      availableFrom: row.available_from_snapshot,
      dueAt: row.due_at_snapshot,
      notifiedAt: row.notified_at,
      endedAt: row.ended_at,
      createdAt: row.created_at,
    };
  });
}

export async function listAssignments(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
) {
  requireAssignmentReader(actor);
  const search = queryValues(request, [
    "serviceDate",
    "maidProfileId",
    "includeHistory",
  ]);
  const serviceDate = dateValue(search.get("serviceDate"), "serviceDate");
  const maidProfileId = search.get("maidProfileId") === null
    ? undefined
    : uuidValue(search.get("maidProfileId"), "maidProfileId");
  const includeHistory = booleanValue(
    search.get("includeHistory"),
    "includeHistory",
  );
  if (
    actor.role === "maid" && maidProfileId && maidProfileId !== actor.profileId
  ) {
    throw new EdgeError(
      403,
      "ASSIGNMENT_ACCESS_REQUIRED",
      "다른 메이드의 청소 배정은 조회할 수 없습니다.",
    );
  }

  let query = accessTokenClient(request, clients)
    .from("cleaning_assignments")
    .select(assignmentColumns)
    .eq("service_date", serviceDate)
    .order("sequence_number")
    .order("revision");
  if (!includeHistory) query = query.eq("is_current", true);
  if (actor.role === "maid") {
    query = query.eq("maid_profile_id", actor.profileId);
  } else if (maidProfileId) {
    query = query.eq("maid_profile_id", maidProfileId);
  }
  const { data, error } = await query;
  if (error) throw assignmentDatabaseError(error);
  return hydrateAssignments(
    clients,
    (data ?? []) as unknown as AssignmentRow[],
  );
}

export async function assignmentHistory(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  cleaningTargetId: string,
) {
  requireAssignmentReader(actor);
  let query = accessTokenClient(request, clients)
    .from("cleaning_assignments")
    .select(assignmentColumns)
    .eq("cleaning_target_id", uuidValue(cleaningTargetId, "cleaningTargetId"))
    .order("revision");
  if (actor.role === "maid") {
    query = query.eq("maid_profile_id", actor.profileId);
  }
  const { data, error } = await query;
  if (error) throw assignmentDatabaseError(error);
  const rows = (data ?? []) as unknown as AssignmentRow[];
  if (rows.length === 0) {
    throw actor.role === "maid"
      ? new EdgeError(
        403,
        "ASSIGNMENT_ACCESS_REQUIRED",
        "이 청소 대상의 배정 이력을 조회할 수 없습니다.",
      )
      : new EdgeError(
        404,
        "ASSIGNMENT_NOT_FOUND",
        "청소 배정 이력을 찾을 수 없습니다.",
      );
  }
  return hydrateAssignments(clients, rows);
}

function toAssignmentProjection(value: unknown): AssignmentProjection {
  if (!value || typeof value !== "object") {
    throw assignmentDatabaseError(null);
  }
  const row = value as Record<string, unknown>;
  return {
    assignmentId: uuidValue(row.assignmentId, "assignmentId"),
    cleaningTargetId: uuidValue(row.cleaningTargetId, "cleaningTargetId"),
    roomId: uuidValue(row.roomId, "roomId"),
    roomNumber: String(row.roomNumber),
    maidProfileId: uuidValue(row.maidProfileId, "maidProfileId"),
    maidDisplayName: String(row.maidDisplayName),
    serviceDate: dateValue(row.serviceDate, "serviceDate"),
    sequenceNumber: integerValue(row.sequenceNumber, "sequenceNumber", 1),
    revision: integerValue(row.revision, "revision", 1),
    isCurrent: row.isCurrent === true,
    targetAssignmentVersion: integerValue(
      row.targetAssignmentVersion,
      "targetAssignmentVersion",
      1,
    ),
    availableFrom: typeof row.availableFrom === "string"
      ? row.availableFrom
      : null,
    dueAt: typeof row.dueAt === "string" ? row.dueAt : null,
    notifiedAt: typeof row.notifiedAt === "string" ? row.notifiedAt : null,
    endedAt: typeof row.endedAt === "string" ? row.endedAt : null,
    createdAt: String(row.createdAt),
  };
}

export async function saveAssignmentDraft(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
) {
  requireAssignmentAdmin(actor);
  const body = await readJsonBody(request);
  assertOnlyFields(body, [
    "cleaningTargetId",
    "maidProfileId",
    "sequenceNumber",
    "expectedAssignmentVersion",
  ]);
  const command = {
    cleaningTargetId: uuidValue(body.cleaningTargetId, "cleaningTargetId"),
    maidProfileId: uuidValue(body.maidProfileId, "maidProfileId"),
    sequenceNumber: integerValue(body.sequenceNumber, "sequenceNumber", 1),
    expectedAssignmentVersion: integerValue(
      body.expectedAssignmentVersion,
      "expectedAssignmentVersion",
      1,
    ),
  };
  const commandKey = idempotencyKey(request);
  const commandRequestHash = await requestHash({
    command: "assignment.save_draft",
    actorProfileId: actor.profileId,
    ...command,
  });
  const { data, error } = await clients.admin.rpc(
    "save_cleaning_assignment_draft",
    {
      p_actor_profile_id: actor.profileId,
      p_cleaning_target_id: command.cleaningTargetId,
      p_maid_profile_id: command.maidProfileId,
      p_sequence_number: command.sequenceNumber,
      p_expected_assignment_version: command.expectedAssignmentVersion,
      p_idempotency_key: commandKey,
      p_request_hash: commandRequestHash,
    },
  );
  if (error || !data) throw assignmentDatabaseError(error);
  return toAssignmentProjection(data);
}

export async function assignmentCommitImpact(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
): Promise<AssignmentCommitImpact> {
  requireAssignmentAdmin(actor);
  const search = queryValues(request, ["serviceDate"]);
  const serviceDate = dateValue(search.get("serviceDate"), "serviceDate");
  const { data, error } = await clients.admin.rpc(
    "get_assignment_commit_impact",
    {
      p_actor_profile_id: actor.profileId,
      p_service_date: serviceDate,
    },
  );
  if (error || !data) throw assignmentDatabaseError(error);
  return toAssignmentCommitImpact(data);
}

export async function commitAssignments(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
): Promise<AssignmentCommitResult> {
  requireAssignmentAdmin(actor);
  const body = await readJsonBody(request);
  assertOnlyFields(body, ["serviceDate", "expectedImpactFingerprint", "items"]);
  const serviceDate = dateValue(body.serviceDate, "serviceDate");
  if (
    typeof body.expectedImpactFingerprint !== "string" ||
    !sha256Pattern.test(body.expectedImpactFingerprint)
  ) {
    validationError(
      "expectedImpactFingerprint는 소문자 SHA-256 값이어야 합니다.",
    );
  }
  if (
    !Array.isArray(body.items) || body.items.length < 1 ||
    body.items.length > 121
  ) {
    validationError("items는 1~121개의 항목이어야 합니다.");
  }
  const items = body.items.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      validationError(`items[${index}]는 객체여야 합니다.`);
    }
    const item = value as Record<string, unknown>;
    assertOnlyFields(item, [
      "cleaningTargetId",
      "expectedAssignmentVersion",
      "expectedAvailabilityVersion",
    ]);
    return {
      cleaningTargetId: uuidValue(
        item.cleaningTargetId,
        `items[${index}].cleaningTargetId`,
      ),
      expectedAssignmentVersion: integerValue(
        item.expectedAssignmentVersion,
        `items[${index}].expectedAssignmentVersion`,
        1,
      ),
      expectedAvailabilityVersion: integerValue(
        item.expectedAvailabilityVersion,
        `items[${index}].expectedAvailabilityVersion`,
        1,
      ),
    };
  });
  if (
    new Set(items.map((item) => item.cleaningTargetId)).size !== items.length
  ) {
    validationError("items의 cleaningTargetId는 중복될 수 없습니다.");
  }
  const commandKey = idempotencyKey(request);
  const commandRequestHash = await requestHash({
    command: "assignment.commit_notify",
    actorProfileId: actor.profileId,
    serviceDate,
    expectedImpactFingerprint: body.expectedImpactFingerprint,
    items,
  });
  const { data, error } = await clients.admin.rpc(
    "commit_and_notify_assignments",
    {
      p_actor_profile_id: actor.profileId,
      p_service_date: serviceDate,
      p_expected_impact_fingerprint: body.expectedImpactFingerprint,
      p_items: items,
      p_idempotency_key: commandKey,
      p_request_hash: commandRequestHash,
    },
  );
  if (error || !data) throw assignmentDatabaseError(error);
  return toAssignmentCommitResult(data);
}
