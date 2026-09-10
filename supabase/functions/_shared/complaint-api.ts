import { idempotencyKey, readJsonBody } from "./account-api.ts";
import {
  COMPLAINT_CURSOR_MAX_LENGTH,
  COMPLAINT_PAGE_DEFAULT,
  COMPLAINT_PAGE_MAX,
  complaintCursorScope,
  decodeComplaintCursor,
  encodeComplaintCursor,
} from "./complaint-cursor.ts";
import {
  type EdgeActor,
  type EdgeClients,
  EdgeError,
  requireBusinessAdmin,
  requirePasswordChanged,
} from "./runtime.ts";
const uuidRe =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  timestampRe =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const categories = [
  "cleanliness_general",
  "bathroom_cleanliness",
  "bedding_quality",
  "trash_not_removed",
  "amenity_missing",
  "damage_or_loss",
  "odor_or_smoke",
  "access_or_handover",
];
const findings = ["confirmed", "unverifiable", "false"],
  appeals = [
    "work_completed_as_required",
    "evidence_misinterpreted",
    "not_responsible",
    "timeline_mismatch",
  ];
function invalid(message = "컴플레인 요청 값을 확인해 주세요."): never {
  throw new EdgeError(400, "VALIDATION_ERROR", message);
}
function uuid(v: unknown, name = "complaintId") {
  if (typeof v !== "string" || !uuidRe.test(v)) {
    invalid(`${name}에 UUID가 필요합니다.`);
  }
  return v.toLowerCase();
}
function time(v: unknown) {
  if (
    typeof v !== "string" || !timestampRe.test(v) ||
    !Number.isFinite(Date.parse(v))
  ) invalid("RFC 3339 시각이 필요합니다.");
  return v;
}
function int(v: unknown, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(v) || (v as number) < 0 || (v as number) > max) {
    invalid("정수 범위를 확인해 주세요.");
  }
  return v as number;
}
function version(v: unknown) {
  const value = int(v);
  if (value < 1) invalid("expectedVersion은 1 이상이어야 합니다.");
  return value;
}
function exact(body: Record<string, unknown>, fields: readonly string[]) {
  if (
    Object.keys(body).length !== fields.length ||
    fields.some((k) => !Object.hasOwn(body, k)) ||
    Object.keys(body).some((k) => !fields.includes(k))
  ) invalid();
}
function noQuery(r: Request) {
  if ([...new URL(r.url).searchParams.keys()].length) {
    invalid("query 항목을 사용할 수 없습니다.");
  }
}
function reader(actor: EdgeActor) {
  requirePasswordChanged(actor);
  if (actor.role !== "admin" && actor.role !== "maid") {
    throw new EdgeError(
      403,
      "COMPLAINT_ACCESS_REQUIRED",
      "컴플레인 조회 권한이 필요합니다.",
    );
  }
}
function admin(actor: EdgeActor) {
  requirePasswordChanged(actor);
  requireBusinessAdmin(actor);
}
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw dbError(null);
  return v as Record<string, unknown>;
}
function bool(v: unknown) {
  if (typeof v !== "boolean") throw dbError(null);
  return v;
}
function text(v: unknown) {
  if (typeof v !== "string") throw dbError(null);
  return v;
}
function nullableUuid(v: unknown) {
  return v === null ? null : uuid(v);
}
function nullableTime(v: unknown) {
  return v === null ? null : time(v);
}
function decisionProjection(v: unknown): Record<string, unknown> | null {
  if (v === null) return null;
  const r = object(v), finding = text(r.finding), kind = text(r.decisionKind);
  if (
    !findings.includes(finding) || !["initial", "correction"].includes(kind)
  ) {
    throw dbError(null);
  }
  return {
    id: uuid(r.id),
    complaintId: uuid(r.complaintId),
    decisionVersion: int(r.decisionVersion),
    decisionKind: kind,
    priorDecisionId: nullableUuid(r.priorDecisionId),
    finding,
    penaltyScore: int(r.penaltyScore, 10),
    reworkRequired: bool(r.reworkRequired),
    decidedAt: time(r.decidedAt),
  };
}
function responseProjection(v: unknown): Record<string, unknown> | null {
  if (v === null) return null;
  const r = object(v), responseType = text(r.responseType);
  if (!["acknowledged", "appealed"].includes(responseType)) throw dbError(null);
  const appealReasonCode = r.appealReasonCode === null
    ? null
    : text(r.appealReasonCode);
  if (appealReasonCode !== null && !appeals.includes(appealReasonCode)) {
    throw dbError(null);
  }
  return {
    id: uuid(r.id),
    complaintId: uuid(r.complaintId),
    decisionId: uuid(r.decisionId),
    maidProfileId: uuid(r.maidProfileId),
    responseType,
    appealReasonCode,
    respondedAt: time(r.respondedAt),
  };
}
function projection(v: unknown) {
  const r = object(v);
  if (
    !categories.includes(String(r.category)) ||
    ![
      "received",
      "under_review",
      "decided",
      "acknowledged",
      "appealed",
      "closed",
    ].includes(String(r.status))
  ) throw dbError(null);
  return {
    id: uuid(r.id),
    roomId: uuid(r.roomId),
    cleaningTargetId: uuid(r.cleaningTargetId),
    cleaningAttemptId: uuid(r.cleaningAttemptId),
    submissionId: uuid(r.submissionId),
    inspectionDecisionId: uuid(r.inspectionDecisionId),
    originalEarningId: uuid(r.originalEarningId),
    maidProfileId: uuid(r.maidProfileId),
    category: text(r.category),
    status: text(r.status),
    version: int(r.version),
    currentDecisionId: nullableUuid(r.currentDecisionId),
    firstDecidedAt: nullableTime(r.firstDecidedAt),
    responseDeadline: nullableTime(r.responseDeadline),
    receivedAt: time(r.receivedAt),
    updatedAt: time(r.updatedAt),
    currentDecision: decisionProjection(r.currentDecision),
    maidResponse: responseProjection(r.maidResponse),
  };
}
function historyProjection(v: unknown) {
  const r = object(v),
    eventType = text(r.eventType),
    toStatus = text(r.toStatus);
  if (
    ![
      "received",
      "review_started",
      "decided",
      "acknowledged",
      "appealed",
      "closed",
      "corrected",
    ].includes(eventType) ||
    ![
      "received",
      "under_review",
      "decided",
      "acknowledged",
      "appealed",
      "closed",
    ].includes(toStatus)
  ) throw dbError(null);
  const event: Record<string, unknown> = {
    eventId: int(r.eventId),
    eventType,
    toStatus,
    caseVersion: int(r.caseVersion),
    occurredAt: time(r.occurredAt),
  };
  if (r.fromStatus !== undefined) event.fromStatus = text(r.fromStatus);
  if (r.decision !== undefined) {
    event.decision = decisionProjection(r.decision);
  }
  if (r.maidResponse !== undefined) {
    event.maidResponse = responseProjection(r.maidResponse);
  }
  return event;
}
export function dbError(error: { message?: string } | null) {
  const message = error?.message ?? "";
  const mappings: Array<[string, number, string]> = [
    ["ADMIN_REQUIRED", 403, "관리자 권한이 필요합니다."],
    ["COMPLAINT_ACCESS_REQUIRED", 403, "컴플레인 조회 권한이 필요합니다."],
    ["MAID_REQUIRED", 403, "메이드만 응답할 수 있습니다."],
    [
      "COMPLAINT_MAID_MISMATCH",
      403,
      "본인 청소의 컴플레인만 처리할 수 있습니다.",
    ],
    ["COMPLAINT_NOT_FOUND", 404, "컴플레인을 찾을 수 없습니다."],
    ["INVALID_COMPLAINT_CATEGORY", 400, "컴플레인 분류가 올바르지 않습니다."],
    ["INVALID_COMPLAINT_FINDING", 400, "컴플레인 판정이 올바르지 않습니다."],
    [
      "INVALID_COMPLAINT_PENALTY",
      400,
      "벌점은 0부터 10까지의 정수여야 합니다.",
    ],
    ["COMPLAINT_PERIOD_INVALID", 400, "조회 기간은 31일 이내여야 합니다."],
    ["COMPLAINT_PAGE_LIMIT_INVALID", 400, "page size가 올바르지 않습니다."],
    ["COMPLAINT_CURSOR_INVALID", 400, "컴플레인 cursor가 올바르지 않습니다."],
    [
      "COMPLAINT_INTAKE_WINDOW_CLOSED",
      409,
      "청소 승인 후 30일 접수 기간이 지났습니다.",
    ],
    [
      "COMPLAINT_SOURCE_NOT_APPROVED",
      409,
      "승인된 원 청소 수익만 연결할 수 있습니다.",
    ],
    ["COMPLAINT_RESPONSE_WINDOW_CLOSED", 409, "7일 응답 기간이 지났습니다."],
    ["COMPLAINT_RESPONSE_WINDOW_OPEN", 409, "응답 기간이 아직 열려 있습니다."],
    [
      "COMPLAINT_APPEAL_UNRESOLVED",
      409,
      "이의 제기를 정정 판정으로 처리해 주세요.",
    ],
    [
      "COMPLAINT_RESPONSE_ALREADY_RECORDED",
      409,
      "메이드 응답은 한 번만 가능합니다.",
    ],
    ["COMPLAINT_DECISION_REQUIRED", 409, "정정할 현재 판정이 없습니다."],
    [
      "COMPLAINT_INVALID_TRANSITION",
      409,
      "현재 상태에서 요청한 전이를 수행할 수 없습니다.",
    ],
    ["STALE_VERSION", 409, "컴플레인 version이 변경되었습니다."],
    [
      "IDEMPOTENCY_KEY_REUSED",
      409,
      "이미 다른 요청에 사용한 Idempotency-Key입니다.",
    ],
  ];
  for (const [code, status, user] of mappings) {
    if (message.includes(code)) return new EdgeError(status, code, user);
  }
  return new EdgeError(
    500,
    "COMPLAINT_COMMAND_FAILED",
    "컴플레인 정보를 처리하지 못했습니다.",
  );
}
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
        a.localeCompare(b)
      ).map(([k, n]) => [k, canonical(n)]),
    );
  }
  return v;
}
async function hash(v: unknown) {
  const d = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(canonical(v))),
  );
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
async function rpc(
  clients: EdgeClients,
  name: string,
  args: Record<string, unknown>,
) {
  const { data, error } = await clients.admin.rpc(name, args);
  if (error || data === null) throw dbError(error);
  return data;
}
function bodyArgs(body: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(body).map(([k, v]) => [
      `p_${k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)}`,
      v,
    ]),
  );
}
async function command(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  name: string,
  type: string,
  body: Record<string, unknown>,
) {
  const key = idempotencyKey(request);
  return projection(
    await rpc(clients, name, {
      p_actor_profile_id: actor.profileId,
      ...bodyArgs(body),
      p_idempotency_key: key,
      p_request_hash: await hash({
        command: type,
        actorProfileId: actor.profileId,
        ...body,
      }),
    }),
  );
}
export function complaintPath(
  path: string,
): {
  complaintId: string;
  kind:
    | "detail"
    | "history"
    | "review"
    | "decision"
    | "response"
    | "close"
    | "corrections";
} | null {
  const m = path.match(
    /^\/v1\/complaints\/([^/]+)(?:\/(history|review|decision|response|close|corrections))?$/,
  );
  if (!m) return null;
  return { complaintId: uuid(m[1]), kind: (m[2] ?? "detail") as "detail" };
}
export async function listComplaints(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
) {
  reader(actor);
  const q = new URL(request.url).searchParams;
  for (const k of q.keys()) {
    if (
      !["from", "to", "limit", "cursor"].includes(k) || q.getAll(k).length !== 1
    ) invalid("허용되지 않거나 중복된 query 항목입니다.");
  }
  const from = time(q.get("from")), to = time(q.get("to"));
  if (
    Date.parse(to) <= Date.parse(from) ||
    Date.parse(to) - Date.parse(from) > 31 * 86400000
  ) invalid("조회 기간은 31일 이내여야 합니다.");
  const raw = q.get("limit"),
    limit = raw === null
      ? COMPLAINT_PAGE_DEFAULT
      : /^[1-9]\d*$/.test(raw)
      ? Number(raw)
      : 0;
  if (limit < 1 || limit > COMPLAINT_PAGE_MAX) {
    invalid("limit을 확인해 주세요.");
  }
  const cursor = q.get("cursor");
  if (cursor && cursor.length > COMPLAINT_CURSOR_MAX_LENGTH) {
    invalid("cursor를 확인해 주세요.");
  }
  const scope = complaintCursorScope(actor, { kind: "list", from, to });
  const pos = cursor ? await decodeComplaintCursor(cursor, scope) : null;
  if (pos && "eventId" in pos) invalid();
  const page = object(
    await rpc(clients, "list_complaint_cases_page", {
      p_actor_profile_id: actor.profileId,
      p_from: from,
      p_to: to,
      p_after_received_at: pos?.receivedAt ?? null,
      p_after_id: pos?.complaintId ?? null,
      p_limit: limit,
    }),
  );
  if (!Array.isArray(page.complaints)) throw dbError(null);
  const more = bool(page.hasMore),
    lastAt = nullableTime(page.lastReceivedAt),
    lastId = nullableUuid(page.lastId);
  return {
    complaints: page.complaints.map(projection),
    nextCursor: more
      ? await encodeComplaintCursor(scope, {
        receivedAt: time(lastAt),
        complaintId: uuid(lastId),
      })
      : null,
  };
}
export async function complaintDetail(
  clients: EdgeClients,
  actor: EdgeActor,
  id: string,
) {
  reader(actor);
  return projection(
    await rpc(clients, "get_complaint_case", {
      p_actor_profile_id: actor.profileId,
      p_complaint_id: id,
    }),
  );
}
export async function complaintHistory(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  id: string,
) {
  reader(actor);
  const q = new URL(request.url).searchParams;
  for (const k of q.keys()) {
    if (!["limit", "cursor"].includes(k) || q.getAll(k).length !== 1) invalid();
  }
  const raw = q.get("limit"),
    limit = raw === null
      ? COMPLAINT_PAGE_DEFAULT
      : /^[1-9]\d*$/.test(raw)
      ? Number(raw)
      : 0;
  if (limit < 1 || limit > 100) invalid();
  const scope = complaintCursorScope(actor, {
    kind: "history",
    complaintId: id,
  });
  const cursor = q.get("cursor");
  const pos = cursor ? await decodeComplaintCursor(cursor, scope) : null;
  if (pos && "receivedAt" in pos) invalid();
  const page = object(
    await rpc(clients, "list_complaint_history_page", {
      p_actor_profile_id: actor.profileId,
      p_complaint_id: id,
      p_after_event_id: pos?.eventId ?? null,
      p_limit: limit,
    }),
  );
  if (!Array.isArray(page.events)) throw dbError(null);
  const more = bool(page.hasMore),
    last = page.lastEventId === null ? null : int(page.lastEventId);
  if (more && last === null) throw dbError(null);
  return {
    events: page.events.map(historyProjection),
    nextCursor: more
      ? await encodeComplaintCursor(scope, { eventId: last as number })
      : null,
  };
}
export async function createComplaint(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
) {
  admin(actor);
  noQuery(request);
  const body = await readJsonBody(request);
  exact(body, ["originalEarningId", "category", "expectedVersion"]);
  const parsed = {
    originalEarningId: uuid(body.originalEarningId, "originalEarningId"),
    category: String(body.category),
    expectedVersion: int(body.expectedVersion),
  };
  if (!categories.includes(parsed.category)) {
    invalid("category를 확인해 주세요.");
  }
  if (parsed.expectedVersion !== 0) {
    invalid("최초 expectedVersion은 0이어야 합니다.");
  }
  return command(
    request,
    clients,
    actor,
    "create_complaint_case",
    "complaint.create",
    parsed,
  );
}
export async function mutateComplaint(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  id: string,
  kind: "review" | "decision" | "response" | "close" | "corrections",
) {
  noQuery(request);
  const body = await readJsonBody(request);
  if (kind === "response") {
    reader(actor);
    if (actor.role !== "maid") {
      throw new EdgeError(403, "MAID_REQUIRED", "메이드만 응답할 수 있습니다.");
    }
    const type = body.responseType;
    if (type === "acknowledged") {
      exact(body, ["expectedVersion", "responseType"]);
      return command(
        request,
        clients,
        actor,
        "respond_to_complaint",
        "complaint.respond",
        {
          complaintId: id,
          expectedVersion: version(body.expectedVersion),
          responseType: type,
          appealReasonCode: null,
        },
      );
    }
    exact(body, ["appealReasonCode", "expectedVersion", "responseType"]);
    if (
      type !== "appealed" || !appeals.includes(String(body.appealReasonCode))
    ) invalid("response를 확인해 주세요.");
    return command(
      request,
      clients,
      actor,
      "respond_to_complaint",
      "complaint.respond",
      {
        complaintId: id,
        expectedVersion: version(body.expectedVersion),
        responseType: type,
        appealReasonCode: String(body.appealReasonCode),
      },
    );
  }
  admin(actor);
  if (kind === "decision" || kind === "corrections") {
    exact(body, [
      "expectedVersion",
      "finding",
      "penaltyScore",
      "reworkRequired",
    ]);
    if (
      !findings.includes(String(body.finding)) ||
      typeof body.reworkRequired !== "boolean"
    ) invalid();
    const parsed = {
      complaintId: id,
      expectedVersion: version(body.expectedVersion),
      finding: String(body.finding),
      penaltyScore: int(body.penaltyScore, 10),
      reworkRequired: body.reworkRequired,
    };
    return command(
      request,
      clients,
      actor,
      kind === "decision"
        ? "decide_complaint_case"
        : "correct_complaint_decision",
      kind === "decision" ? "complaint.decide" : "complaint.correct",
      parsed,
    );
  }
  exact(body, ["expectedVersion"]);
  return command(
    request,
    clients,
    actor,
    kind === "review" ? "start_complaint_review" : "close_complaint_case",
    kind === "review" ? "complaint.review" : "complaint.close",
    { complaintId: id, expectedVersion: version(body.expectedVersion) },
  );
}
