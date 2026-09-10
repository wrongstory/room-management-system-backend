import type { Actor } from "../../domain/actor.js";
import { AppError } from "../../lib/app-error.js";
import { requestHash } from "../../lib/command.js";
import type { SupabaseClients } from "../../lib/supabase.js";
import {
  COMPLAINT_PAGE_DEFAULT,
  ComplaintCursorCodec,
  complaintCursorScope,
} from "./complaint-cursor.js";

export const COMPLAINT_CATEGORIES = [
  "cleanliness_general",
  "bathroom_cleanliness",
  "bedding_quality",
  "trash_not_removed",
  "amenity_missing",
  "damage_or_loss",
  "odor_or_smoke",
  "access_or_handover",
] as const;
export const COMPLAINT_FINDINGS = [
  "confirmed",
  "unverifiable",
  "false",
] as const;
export const COMPLAINT_APPEAL_REASONS = [
  "work_completed_as_required",
  "evidence_misinterpreted",
  "not_responsible",
  "timeline_mismatch",
] as const;
export type ComplaintCategory = (typeof COMPLAINT_CATEGORIES)[number];
export type ComplaintFinding = (typeof COMPLAINT_FINDINGS)[number];
export type ComplaintAppealReason = (typeof COMPLAINT_APPEAL_REASONS)[number];
export type ComplaintResponseType = "acknowledged" | "appealed";
export interface ComplaintListInput {
  from: string;
  to: string;
  limit?: number | undefined;
  cursor?: string | undefined;
}
export interface ComplaintHistoryInput {
  complaintId: string;
  limit?: number | undefined;
  cursor?: string | undefined;
}
export interface ComplaintCommand {
  complaintId: string;
  expectedVersion: number;
  idempotencyKey: string;
}
export interface ComplaintDecisionCommand extends ComplaintCommand {
  finding: ComplaintFinding;
  penaltyScore: number;
  reworkRequired: boolean;
}
export interface ComplaintService {
  list(actor: Actor, input: ComplaintListInput): Promise<unknown>;
  detail(actor: Actor, complaintId: string): Promise<unknown>;
  history(actor: Actor, input: ComplaintHistoryInput): Promise<unknown>;
  create(
    actor: Actor,
    input: {
      originalEarningId: string;
      category: ComplaintCategory;
      expectedVersion: number;
      idempotencyKey: string;
    },
  ): Promise<unknown>;
  review(actor: Actor, input: ComplaintCommand): Promise<unknown>;
  decide(actor: Actor, input: ComplaintDecisionCommand): Promise<unknown>;
  respond(
    actor: Actor,
    input: ComplaintCommand & {
      responseType: ComplaintResponseType;
      appealReasonCode?: ComplaintAppealReason;
    },
  ): Promise<unknown>;
  correct(actor: Actor, input: ComplaintDecisionCommand): Promise<unknown>;
  close(actor: Actor, input: ComplaintCommand): Promise<unknown>;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const timestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw complaintDatabaseError(null);
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw complaintDatabaseError(null);
  return value;
}
function uuid(value: unknown): string {
  const v = text(value);
  if (!uuidPattern.test(v)) throw complaintDatabaseError(null);
  return v.toLowerCase();
}
function nullableUuid(value: unknown): string | null {
  return value === null ? null : uuid(value);
}
function timestamp(value: unknown): string {
  const v = text(value);
  if (!timestampPattern.test(v) || !Number.isFinite(Date.parse(v)))
    throw complaintDatabaseError(null);
  return v;
}
function nullableTimestamp(value: unknown): string | null {
  return value === null ? null : timestamp(value);
}
function integer(value: unknown): number {
  const v =
    typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0)
    throw complaintDatabaseError(null);
  return v;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw complaintDatabaseError(null);
  return value;
}
function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}
function decision(value: unknown): Record<string, unknown> | null {
  if (value === null) return null;
  const r = object(value);
  const finding = text(r.finding);
  if (!COMPLAINT_FINDINGS.includes(finding as ComplaintFinding))
    throw complaintDatabaseError(null);
  return {
    id: uuid(r.id),
    complaintId: uuid(r.complaintId),
    decisionVersion: integer(r.decisionVersion),
    decisionKind: text(r.decisionKind),
    priorDecisionId: nullableUuid(r.priorDecisionId),
    finding,
    penaltyScore: integer(r.penaltyScore),
    reworkRequired: boolean(r.reworkRequired),
    decidedAt: timestamp(r.decidedAt),
  };
}
function response(value: unknown): Record<string, unknown> | null {
  if (value === null) return null;
  const r = object(value);
  return {
    id: uuid(r.id),
    complaintId: uuid(r.complaintId),
    decisionId: uuid(r.decisionId),
    maidProfileId: uuid(r.maidProfileId),
    responseType: text(r.responseType),
    appealReasonCode:
      r.appealReasonCode === undefined
        ? null
        : nullableText(r.appealReasonCode),
    respondedAt: timestamp(r.respondedAt),
  };
}
export function complaintProjection(value: unknown): Record<string, unknown> {
  const r = object(value);
  const status = text(r.status);
  const category = text(r.category);
  if (
    ![
      "received",
      "under_review",
      "decided",
      "acknowledged",
      "appealed",
      "closed",
    ].includes(status) ||
    !COMPLAINT_CATEGORIES.includes(category as ComplaintCategory)
  )
    throw complaintDatabaseError(null);
  return {
    id: uuid(r.id),
    roomId: uuid(r.roomId),
    cleaningTargetId: uuid(r.cleaningTargetId),
    cleaningAttemptId: uuid(r.cleaningAttemptId),
    submissionId: uuid(r.submissionId),
    inspectionDecisionId: uuid(r.inspectionDecisionId),
    originalEarningId: uuid(r.originalEarningId),
    maidProfileId: uuid(r.maidProfileId),
    category,
    status,
    version: integer(r.version),
    currentDecisionId: nullableUuid(r.currentDecisionId),
    firstDecidedAt: nullableTimestamp(r.firstDecidedAt),
    responseDeadline: nullableTimestamp(r.responseDeadline),
    receivedAt: timestamp(r.receivedAt),
    updatedAt: timestamp(r.updatedAt),
    currentDecision: decision(r.currentDecision),
    maidResponse: response(r.maidResponse),
  };
}
function historyProjection(value: unknown): Record<string, unknown> {
  const r = object(value);
  const eventType = text(r.eventType);
  const toStatus = text(r.toStatus);
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
  )
    throw complaintDatabaseError(null);
  const event: Record<string, unknown> = {
    eventId: integer(r.eventId),
    eventType,
    toStatus,
    caseVersion: integer(r.caseVersion),
    occurredAt: timestamp(r.occurredAt),
  };
  if (r.fromStatus !== undefined) event.fromStatus = text(r.fromStatus);
  if (r.decision !== undefined) event.decision = decision(r.decision);
  if (r.maidResponse !== undefined)
    event.maidResponse = response(r.maidResponse);
  return event;
}

export function complaintDatabaseError(
  error: { message?: string } | null,
): AppError {
  const message = error?.message ?? "";
  const mappings: Array<[string, number, string]> = [
    ["ADMIN_REQUIRED", 403, "관리자 권한이 필요합니다."],
    ["COMPLAINT_ACCESS_REQUIRED", 403, "컴플레인 조회 권한이 필요합니다."],
    ["MAID_REQUIRED", 403, "메이드만 응답할 수 있습니다."],
    [
      "COMPLAINT_MAID_MISMATCH",
      403,
      "본인 청소의 컴플레인만 조회하거나 응답할 수 있습니다.",
    ],
    ["COMPLAINT_NOT_FOUND", 404, "컴플레인을 찾을 수 없습니다."],
    ["INVALID_COMPLAINT_CATEGORY", 400, "컴플레인 분류가 올바르지 않습니다."],
    ["INVALID_COMPLAINT_FINDING", 400, "컴플레인 판정이 올바르지 않습니다."],
    [
      "INVALID_COMPLAINT_PENALTY",
      400,
      "벌점은 0부터 10까지의 정수여야 합니다.",
    ],
    ["INVALID_REWORK_DECISION", 400, "재작업 판정이 필요합니다."],
    ["INVALID_COMPLAINT_RESPONSE", 400, "메이드 응답이 올바르지 않습니다."],
    [
      "COMPLAINT_APPEAL_REASON_REQUIRED",
      400,
      "이의 사유 코드를 선택해 주세요.",
    ],
    [
      "COMPLAINT_APPEAL_REASON_FORBIDDEN",
      400,
      "확인 응답에는 이의 사유를 넣을 수 없습니다.",
    ],
    ["COMPLAINT_PERIOD_INVALID", 400, "조회 기간은 31일 이내여야 합니다."],
    [
      "COMPLAINT_PAGE_LIMIT_INVALID",
      400,
      "page size가 허용 범위를 벗어났습니다.",
    ],
    ["INVALID_COMPLAINT_CURSOR", 400, "컴플레인 cursor가 올바르지 않습니다."],
    [
      "COMPLAINT_INTAKE_WINDOW_CLOSED",
      409,
      "청소 승인 후 30일 접수 기간이 지났습니다.",
    ],
    [
      "COMPLAINT_SOURCE_NOT_APPROVED",
      409,
      "승인된 원 청소 수익만 컴플레인에 연결할 수 있습니다.",
    ],
    ["COMPLAINT_RESPONSE_WINDOW_CLOSED", 409, "7일 응답 기간이 지났습니다."],
    [
      "COMPLAINT_RESPONSE_WINDOW_OPEN",
      409,
      "메이드 응답 기간이 아직 열려 있습니다.",
    ],
    [
      "COMPLAINT_APPEAL_UNRESOLVED",
      409,
      "이의 제기를 정정 판정으로 처리한 뒤 종결해 주세요.",
    ],
    [
      "COMPLAINT_RESPONSE_ALREADY_RECORDED",
      409,
      "메이드 응답은 한 번만 등록할 수 있습니다.",
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
  for (const [needle, status, user] of mappings)
    if (message.includes(needle)) return new AppError(status, needle, user);
  return new AppError(
    500,
    "COMPLAINT_COMMAND_FAILED",
    "컴플레인 정보를 처리하지 못했습니다.",
  );
}
function reader(actor: Actor) {
  if (actor.role !== "admin" && actor.role !== "maid")
    throw new AppError(
      403,
      "COMPLAINT_ACCESS_REQUIRED",
      "컴플레인 조회 권한이 필요합니다.",
    );
}
function admin(actor: Actor) {
  if (actor.role !== "admin")
    throw new AppError(403, "ADMIN_REQUIRED", "관리자 권한이 필요합니다.");
}

export class SupabaseComplaintService implements ComplaintService {
  private readonly cursor: ComplaintCursorCodec;
  constructor(
    private readonly clients: SupabaseClients,
    cursorSecret: string,
  ) {
    this.cursor = new ComplaintCursorCodec(cursorSecret);
  }
  private async rpc(name: string, args: Record<string, unknown>) {
    const { data, error } = await this.clients.admin.rpc(name, args);
    if (error || data === null) throw complaintDatabaseError(error);
    return data;
  }
  async list(actor: Actor, input: ComplaintListInput) {
    reader(actor);
    const scope = complaintCursorScope(actor, {
      kind: "list",
      from: input.from,
      to: input.to,
    });
    const pos = input.cursor ? this.cursor.decode(input.cursor, scope) : null;
    if (pos && "eventId" in pos)
      throw complaintDatabaseError({ message: "INVALID_COMPLAINT_CURSOR" });
    const page = object(
      await this.rpc("list_complaint_cases_page", {
        p_actor_profile_id: actor.profileId,
        p_from: input.from,
        p_to: input.to,
        p_after_received_at: pos?.receivedAt ?? null,
        p_after_id: pos?.complaintId ?? null,
        p_limit: input.limit ?? COMPLAINT_PAGE_DEFAULT,
      }),
    );
    if (!Array.isArray(page.complaints)) throw complaintDatabaseError(null);
    const complaints = page.complaints.map(complaintProjection);
    const more = boolean(page.hasMore);
    const lastAt = nullableTimestamp(page.lastReceivedAt);
    const lastId = nullableUuid(page.lastId);
    if (more && (!lastAt || !lastId)) throw complaintDatabaseError(null);
    return {
      complaints,
      nextCursor: more
        ? this.cursor.encode(scope, {
            receivedAt: lastAt as string,
            complaintId: lastId as string,
          })
        : null,
    };
  }
  async detail(actor: Actor, id: string) {
    reader(actor);
    return complaintProjection(
      await this.rpc("get_complaint_case", {
        p_actor_profile_id: actor.profileId,
        p_complaint_id: id,
      }),
    );
  }
  async history(actor: Actor, input: ComplaintHistoryInput) {
    reader(actor);
    const scope = complaintCursorScope(actor, {
      kind: "history",
      complaintId: input.complaintId,
    });
    const pos = input.cursor ? this.cursor.decode(input.cursor, scope) : null;
    if (pos && "receivedAt" in pos)
      throw complaintDatabaseError({ message: "INVALID_COMPLAINT_CURSOR" });
    const page = object(
      await this.rpc("list_complaint_history_page", {
        p_actor_profile_id: actor.profileId,
        p_complaint_id: input.complaintId,
        p_after_event_id: pos?.eventId ?? null,
        p_limit: input.limit ?? COMPLAINT_PAGE_DEFAULT,
      }),
    );
    if (!Array.isArray(page.events)) throw complaintDatabaseError(null);
    const more = boolean(page.hasMore);
    const last = page.lastEventId === null ? null : integer(page.lastEventId);
    if (more && !last) throw complaintDatabaseError(null);
    return {
      events: page.events.map(historyProjection),
      nextCursor: more
        ? this.cursor.encode(scope, { eventId: last as number })
        : null,
    };
  }
  private async command(
    actor: Actor,
    name: string,
    type: string,
    input: Record<string, unknown>,
  ) {
    const { idempotencyKey, ...payload } = input;
    const fingerprint = {
      command: type,
      actorProfileId: actor.profileId,
      ...payload,
    };
    return complaintProjection(
      await this.rpc(name, {
        p_actor_profile_id: actor.profileId,
        ...Object.fromEntries(
          Object.entries(payload).map(([k, v]) => [
            `p_${k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)}`,
            v,
          ]),
        ),
        p_idempotency_key: idempotencyKey,
        p_request_hash: requestHash(fingerprint),
      }),
    );
  }
  async create(
    actor: Actor,
    input: {
      originalEarningId: string;
      category: ComplaintCategory;
      expectedVersion: number;
      idempotencyKey: string;
    },
  ) {
    admin(actor);
    return this.command(
      actor,
      "create_complaint_case",
      "complaint.create",
      input,
    );
  }
  async review(actor: Actor, input: ComplaintCommand) {
    admin(actor);
    return this.command(actor, "start_complaint_review", "complaint.review", {
      ...input,
    });
  }
  async decide(actor: Actor, input: ComplaintDecisionCommand) {
    admin(actor);
    return this.command(actor, "decide_complaint_case", "complaint.decide", {
      ...input,
    });
  }
  async respond(
    actor: Actor,
    input: ComplaintCommand & {
      responseType: ComplaintResponseType;
      appealReasonCode?: ComplaintAppealReason;
    },
  ) {
    if (actor.role !== "maid")
      throw new AppError(403, "MAID_REQUIRED", "메이드만 응답할 수 있습니다.");
    return this.command(actor, "respond_to_complaint", "complaint.respond", {
      ...input,
      appealReasonCode: input.appealReasonCode ?? null,
    });
  }
  async correct(actor: Actor, input: ComplaintDecisionCommand) {
    admin(actor);
    return this.command(
      actor,
      "correct_complaint_decision",
      "complaint.correct",
      { ...input },
    );
  }
  async close(actor: Actor, input: ComplaintCommand) {
    admin(actor);
    return this.command(actor, "close_complaint_case", "complaint.close", {
      ...input,
    });
  }
}
