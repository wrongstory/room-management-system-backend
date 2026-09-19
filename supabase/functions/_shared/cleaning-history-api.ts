import {
  type EdgeActor,
  type EdgeClients,
  EdgeError,
  requirePasswordChanged,
  verifiedRequestSessionId,
} from "./runtime.ts";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const timePattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function invalid(code = "INVALID_CLEANING_HISTORY_QUERY"): never {
  throw new EdgeError(400, code, "청소 이력 조회 조건이 올바르지 않습니다.");
}
function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) &&
    parsed.toISOString().slice(0, 10) === value;
}
function encode(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/g,
    "",
  );
}
function decode(value: string): Record<string, unknown> {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(
      normalized + "=".repeat((4 - normalized.length % 4) % 4),
    );
    const parsed = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error();
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new EdgeError(
      400,
      "INVALID_CLEANING_HISTORY_CURSOR",
      "청소 이력 cursor가 올바르지 않습니다.",
    );
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw dbError(null);
  }
  return value as Record<string, unknown>;
}
function text(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw dbError(null);
  return value;
}
function number(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw dbError(null);
  }
  return value;
}
function item(value: unknown): Record<string, unknown> {
  const row = object(value);
  const attemptId = text(row.attemptId), targetId = text(row.cleaningTargetId);
  const performerId = text(row.performerProfileId),
    completed = text(row.fieldCompletedAt);
  if (
    !attemptId || !uuidPattern.test(attemptId) || !targetId ||
    !uuidPattern.test(targetId) ||
    !performerId || !uuidPattern.test(performerId) || !completed ||
    !timePattern.test(completed)
  ) throw dbError(null);
  return {
    submissionId: text(row.submissionId),
    attemptId: attemptId.toLowerCase(),
    cleaningTargetId: targetId.toLowerCase(),
    roomId: text(row.roomId),
    roomNumber: text(row.roomNumber),
    roomTypeCode: text(row.roomTypeCode),
    roomTypeName: text(row.roomTypeName),
    performerProfileId: performerId.toLowerCase(),
    performerDisplayName: text(row.performerDisplayName),
    cleaningKind: text(row.cleaningKind),
    originalServiceDate: text(row.originalServiceDate),
    serviceDate: text(row.serviceDate),
    startedAt: text(row.startedAt),
    fieldCompletedAt: completed,
    submittedAt: text(row.submittedAt),
    inspectionStatus: text(row.inspectionStatus),
    decidedAt: text(row.decidedAt),
    photoCount: number(row.photoCount),
    mediaAvailability: text(row.mediaAvailability),
    expiresAt: text(row.expiresAt),
    baseFeeSnapshot: number(row.baseFeeSnapshot),
    earningTotalAmount: number(row.earningTotalAmount),
  };
}
function dbError(error: { message?: string } | null): EdgeError {
  if (error?.message === "CLEANING_HISTORY_MAID_SCOPE_REQUIRED") {
    return new EdgeError(
      403,
      error.message,
      "메이드는 본인 청소 이력만 조회할 수 있습니다.",
    );
  }
  if (
    error?.message === "CLEANING_HISTORY_ACCESS_REQUIRED" ||
    error?.message === "ACTIVE_SESSION_REQUIRED"
  ) {
    return new EdgeError(
      403,
      error.message,
      "청소 이력 조회 권한이 필요합니다.",
    );
  }
  if (error?.message === "INVALID_CLEANING_HISTORY_QUERY") {
    return new EdgeError(
      400,
      error.message,
      "청소 이력 조회 조건이 올바르지 않습니다.",
    );
  }
  return new EdgeError(
    500,
    "CLEANING_HISTORY_QUERY_FAILED",
    "청소 이력을 조회하지 못했습니다.",
  );
}

export async function listCleaningHistory(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
): Promise<Record<string, unknown>> {
  requirePasswordChanged(actor);
  if (actor.role !== "admin" && actor.role !== "maid") {
    throw new EdgeError(
      403,
      "CLEANING_HISTORY_ACCESS_REQUIRED",
      "청소 이력 조회 권한이 필요합니다.",
    );
  }
  const params = new URL(request.url).searchParams;
  const allowed = ["date", "maidProfileId", "query", "limit", "cursor"];
  for (const key of params.keys()) {
    if (!allowed.includes(key) || params.getAll(key).length !== 1) invalid();
  }
  const date = params.get("date") ?? "";
  if (!validDate(date)) invalid();
  const maid = params.get("maidProfileId");
  if (maid !== null && !uuidPattern.test(maid)) invalid();
  const rawQuery = params.get("query"),
    query = rawQuery === null ? null : rawQuery.trim();
  if (query !== null && (query.length < 1 || query.length > 80)) invalid();
  const rawLimit = params.get("limit") ?? "50", limit = Number(rawLimit);
  if (
    !/^[1-9]\d*$/.test(rawLimit) || !Number.isSafeInteger(limit) || limit > 100
  ) invalid();
  const cursorScope = [
    actor.profileId.toLowerCase(),
    date,
    maid?.toLowerCase() ?? "",
    query ?? "",
  ].join("|");
  const rawCursor = params.get("cursor");
  let cursor: Record<string, unknown> | null = null;
  if (rawCursor !== null) {
    if (rawCursor.length < 1 || rawCursor.length > 1024) {
      invalid("INVALID_CLEANING_HISTORY_CURSOR");
    }
    cursor = decode(rawCursor);
    if (
      cursor.scope !== cursorScope ||
      typeof cursor.fieldCompletedAt !== "string" ||
      !timePattern.test(cursor.fieldCompletedAt) ||
      typeof cursor.attemptId !== "string" ||
      !uuidPattern.test(cursor.attemptId)
    ) invalid("INVALID_CLEANING_HISTORY_CURSOR");
  }
  const { data, error } = await clients.admin.rpc("list_cleaning_history", {
    p_actor_profile_id: actor.profileId,
    p_session_id: verifiedRequestSessionId(request),
    p_date: date,
    p_maid_profile_id: maid?.toLowerCase() ?? null,
    p_query: query,
    p_limit: limit,
    p_cursor_field_completed_at: cursor?.fieldCompletedAt ?? null,
    p_cursor_attempt_id: typeof cursor?.attemptId === "string"
      ? cursor.attemptId.toLowerCase()
      : null,
  });
  if (error || !data) throw dbError(error);
  const page = object(data);
  if (!Array.isArray(page.items)) throw dbError(null);
  const next = page.nextCursor === null ? null : object(page.nextCursor);
  return {
    date: text(page.date),
    fromDate: text(page.fromDate),
    toDate: text(page.toDate),
    items: page.items.map(item),
    nextCursor: next === null ? null : encode({
      fieldCompletedAt: next.fieldCompletedAt,
      attemptId: next.attemptId,
      scope: cursorScope,
    }),
  };
}
