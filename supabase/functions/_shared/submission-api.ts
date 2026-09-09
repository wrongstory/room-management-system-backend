import { idempotencyKey, readJsonBody } from "./account-api.ts";
import {
  type EdgeActor,
  type EdgeClients,
  EdgeError,
  requireBusinessAdmin,
  requirePasswordChanged,
} from "./runtime.ts";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const reasonPattern = /^[A-Z0-9_]{2,80}$/;
const bombReasons = {
  approved: ["BOMB_CONFIRMED"],
  rejected: ["BOMB_NOT_CONFIRMED", "BOMB_EVIDENCE_INSUFFICIENT"],
} as const;
const inspectionReasons = {
  approve: ["QUALITY_OK"],
  reject: ["QUALITY_REWORK", "EVIDENCE_INCOMPLETE", "CLEANING_INCOMPLETE"],
} as const;

function invalid(): never {
  throw new EdgeError(
    400,
    "VALIDATION_ERROR",
    "제출·검수 요청 값을 확인해 주세요.",
  );
}
function uuid(value: unknown): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) invalid();
  return value.toLowerCase();
}
function integer(value: unknown, minimum = 0): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum
  ) invalid();
  return value;
}
function reason(value: unknown): string {
  if (typeof value !== "string" || !reasonPattern.test(value)) invalid();
  return value;
}
function fields(
  body: Record<string, unknown>,
  expected: readonly string[],
): void {
  if (
    Object.keys(body).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(body, key)) ||
    Object.keys(body).some((key) => !expected.includes(key))
  ) invalid();
}
function maid(actor: EdgeActor): void {
  requirePasswordChanged(actor);
  if (actor.role !== "maid") {
    throw new EdgeError(
      403,
      "MAID_REQUIRED",
      "담당 메이드만 제출할 수 있습니다.",
    );
  }
}
function admin(actor: EdgeActor): void {
  requirePasswordChanged(actor);
  requireBusinessAdmin(actor);
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
        a.localeCompare(b)
      ).map(([key, nested]) => [key, canonical(nested)]),
    );
  }
  return value;
}
async function hash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(canonical(value))),
  );
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

export function submissionDatabaseError(
  error: { message?: string } | null,
): EdgeError {
  const code = error?.message ?? "";
  const status: Record<string, number> = {
    MAID_REQUIRED: 403,
    ADMIN_REQUIRED: 403,
    CAPABILITY_ACCESS_REQUIRED: 403,
    SUBMISSION_ACCESS_REQUIRED: 403,
    BOMB_REPORT_ACCESS_REQUIRED: 403,
    PHOTO_EVIDENCE_INCOMPLETE: 409,
    BOMB_EVIDENCE_INVALID: 409,
    BOMB_REPORT_NOT_ALLOWED: 409,
    BOMB_REPORT_SEALED: 409,
    SUBMISSION_VERSION_CONFLICT: 409,
    STALE_VERSION: 409,
    SUBMISSION_INVALID_TRANSITION: 409,
    BOMB_DECISION_REQUIRED: 409,
    BOMB_DECISION_ALREADY_RECORDED: 409,
    BOMB_REPORT_NOT_FOUND: 404,
    INSPECTION_INVALID_TRANSITION: 409,
    RECLEAN_ORIGINAL_MAID_UNAVAILABLE: 409,
    RECLEAN_TEMPLATE_NOT_CONFIGURED: 409,
    RECLEAN_WINDOW_NOT_AVAILABLE: 409,
    IDEMPOTENCY_KEY_REUSED: 409,
    INVALID_BOMB_REPORT: 400,
    INVALID_BOMB_DECISION: 400,
    SUBMISSION_NOT_FOUND: 404,
  };
  if (Object.hasOwn(status, code)) {
    return new EdgeError(
      status[code] ?? 500,
      code,
      "제출·검수 상태와 version을 다시 확인해 주세요.",
    );
  }
  return new EdgeError(
    500,
    "SUBMISSION_COMMAND_FAILED",
    "제출·검수 정보를 처리하지 못했습니다.",
  );
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw submissionDatabaseError(null);
  }
  return value as Record<string, unknown>;
}
function publicProjection(
  value: unknown,
  includeBombDetail = false,
): Record<string, unknown> {
  const row = object(value);
  const allowed = [
    "id",
    "attemptId",
    "version",
    "status",
    "submittedBy",
    "submittedAt",
    "currentRevision",
    "current",
    "photoCount",
    "candleCount",
    "bombReportId",
    "bombDecision",
    "inspectionDecision",
    "inspectionReasonCode",
    "decidedAt",
  ];
  const result: Record<string, unknown> = {};
  for (const key of allowed) {
    if (Object.hasOwn(row, key)) result[key] = row[key];
  }
  if (includeBombDetail && Object.hasOwn(row, "bombReport")) {
    const report = object(row.bombReport);
    result.bombReport = Object.fromEntries(
      [
        "id",
        "attemptId",
        "memo",
        "evidenceCount",
        "evidencePhotoIds",
        "reportedAt",
      ]
        .filter((key) => Object.hasOwn(report, key))
        .map((key) => [key, report[key]]),
    );
  }
  if (includeBombDetail && Object.hasOwn(row, "photos")) {
    if (!Array.isArray(row.photos)) throw submissionDatabaseError(null);
    result.photos = row.photos.map((value) => {
      const photo = object(value);
      return Object.fromEntries(
        [
          "photoId",
          "targetPhotoSlotId",
          "slotKey",
          "label",
          "displayOrder",
          "required",
          "photoVersion",
        ].filter((key) => Object.hasOwn(photo, key)).map((key) => [
          key,
          photo[key],
        ]),
      );
    });
  }
  if (includeBombDetail && Object.hasOwn(row, "reviewContext")) {
    const context = object(row.reviewContext);
    result.reviewContext = Object.fromEntries(
      [
        "cleaningTargetId",
        "cleaningKind",
        "roomNumber",
        "serviceDate",
        "maidProfileId",
      ].filter((key) => Object.hasOwn(context, key)).map((key) => [
        key,
        context[key],
      ]),
    );
  }
  return result;
}
function commandProjection(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  const row = object(value);
  return Object.fromEntries(
    allowed.filter((key) => Object.hasOwn(row, key)).map((
      key,
    ) => [key, row[key]]),
  );
}
async function rpc(
  clients: EdgeClients,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const { data, error } = await clients.admin.rpc(name, args);
  if (error) throw submissionDatabaseError(error);
  return data;
}

export function submissionPath(path: string):
  | { kind: "report" | "submit" | "history"; attemptId: string }
  | {
    kind: "detail" | "bomb-decision" | "approve" | "reject";
    submissionId: string;
  }
  | null {
  let match = /^\/v1\/attempts\/([^/]+)\/(bomb-room-reports|submissions)$/.exec(
    path,
  );
  if (match) {
    return {
      kind: match[2] === "bomb-room-reports" ? "report" : "submit",
      attemptId: uuid(match[1]),
    };
  }
  match =
    /^\/v1\/inspections\/([^/]+)(?:\/(bomb-room-decision|approve|reject))?$/
      .exec(path);
  if (!match) return null;
  const suffix = match[2];
  return {
    kind: suffix === "bomb-room-decision"
      ? "bomb-decision"
      : suffix === "approve"
      ? "approve"
      : suffix === "reject"
      ? "reject"
      : "detail",
    submissionId: uuid(match[1]),
  };
}

export async function reportBombRoom(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  attemptId: string,
) {
  maid(actor);
  if (new URL(request.url).search) invalid();
  const body = await readJsonBody(request);
  fields(body, ["evidencePhotoIds", "memo"]);
  if (
    !Array.isArray(body.evidencePhotoIds) || body.evidencePhotoIds.length < 1 ||
    body.evidencePhotoIds.length > 20
  ) invalid();
  const evidencePhotoIds = body.evidencePhotoIds.map(uuid);
  if (
    new Set(evidencePhotoIds).size !== evidencePhotoIds.length ||
    typeof body.memo !== "string" || body.memo.trim().length < 1 ||
    body.memo.length > 500
  ) invalid();
  const key = idempotencyKey(request);
  const input = {
    actorProfileId: actor.profileId,
    attemptId,
    evidencePhotoIds,
    memo: body.memo,
  };
  return commandProjection(
    await rpc(clients, "report_bomb_room", {
      p_actor_profile_id: actor.profileId,
      p_attempt_id: attemptId,
      p_evidence_photo_ids: evidencePhotoIds,
      p_memo: body.memo,
      p_idempotency_key: key,
      p_request_hash: await hash(input),
    }),
    ["id", "attemptId", "evidenceCount", "reportedAt"],
  );
}

export async function createSubmission(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  attemptId: string,
) {
  maid(actor);
  if (new URL(request.url).search) invalid();
  const body = await readJsonBody(request);
  fields(body, ["clientSubmissionId", "expectedRevision", "candleCount"]);
  const input = {
    actorProfileId: actor.profileId,
    attemptId,
    clientSubmissionId: uuid(body.clientSubmissionId),
    expectedRevision: integer(body.expectedRevision),
    candleCount: integer(body.candleCount),
  };
  const key = idempotencyKey(request);
  return publicProjection(
    await rpc(clients, "create_cleaning_submission", {
      p_actor_profile_id: actor.profileId,
      p_attempt_id: attemptId,
      p_client_submission_id: input.clientSubmissionId,
      p_expected_revision: input.expectedRevision,
      p_candle_count: input.candleCount,
      p_idempotency_key: key,
      p_request_hash: await hash(input),
    }),
  );
}

export async function listSubmissions(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  attemptId?: string,
) {
  requirePasswordChanged(actor);
  if (actor.role !== "admin" && actor.role !== "maid") {
    throw new EdgeError(
      403,
      "SUBMISSION_ACCESS_REQUIRED",
      "제출 조회 권한이 필요합니다.",
    );
  }
  if (new URL(request.url).search) invalid();
  const value = await rpc(clients, "list_cleaning_submissions", {
    p_actor_profile_id: actor.profileId,
    p_attempt_id: attemptId ?? null,
    p_pending_only: attemptId === undefined,
  });
  if (!Array.isArray(value)) throw submissionDatabaseError(null);
  const includeAdminReviewContext = attemptId === undefined;
  return value.map((item) => publicProjection(item, includeAdminReviewContext));
}

export async function getSubmission(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  submissionId: string,
) {
  admin(actor);
  if (new URL(request.url).search) invalid();
  return publicProjection(
    await rpc(clients, "get_cleaning_submission", {
      p_actor_profile_id: actor.profileId,
      p_submission_id: submissionId,
    }),
    true,
  );
}

export async function decideBombRoom(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  submissionId: string,
) {
  admin(actor);
  if (new URL(request.url).search) invalid();
  const body = await readJsonBody(request);
  fields(body, ["decision", "reasonCode"]);
  if (body.decision !== "approved" && body.decision !== "rejected") invalid();
  const decision: "approved" | "rejected" = body.decision;
  const input = {
    actorProfileId: actor.profileId,
    submissionId,
    decision,
    reasonCode: reason(body.reasonCode),
  };
  if (
    !(bombReasons[input.decision] as readonly string[]).includes(
      input.reasonCode,
    )
  ) invalid();
  const key = idempotencyKey(request);
  return commandProjection(
    await rpc(clients, "decide_bomb_room", {
      p_actor_profile_id: actor.profileId,
      p_submission_id: submissionId,
      p_decision: input.decision,
      p_reason_code: input.reasonCode,
      p_idempotency_key: key,
      p_request_hash: await hash(input),
    }),
    ["id", "submissionId", "decision", "reasonCode", "decidedAt"],
  );
}

export async function decideSubmission(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  submissionId: string,
  decision: "approve" | "reject",
) {
  admin(actor);
  if (new URL(request.url).search) invalid();
  const body = await readJsonBody(request);
  fields(body, ["reasonCode"]);
  const input = {
    actorProfileId: actor.profileId,
    submissionId,
    decision,
    reasonCode: reason(body.reasonCode),
  };
  if (
    !(inspectionReasons[decision] as readonly string[]).includes(
      input.reasonCode,
    )
  ) invalid();
  const key = idempotencyKey(request);
  return commandProjection(
    await rpc(
      clients,
      decision === "approve"
        ? "approve_cleaning_submission"
        : "reject_cleaning_submission",
      {
        p_actor_profile_id: actor.profileId,
        p_submission_id: submissionId,
        p_reason_code: input.reasonCode,
        p_idempotency_key: key,
        p_request_hash: await hash(input),
      },
    ),
    [
      "submissionId",
      "decisionId",
      "decision",
      "reasonCode",
      "decidedAt",
      "earningId",
      "recleanTargetId",
      "recleanAssignmentId",
    ],
  );
}
