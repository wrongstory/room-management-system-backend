import {
  type EdgeActor,
  type EdgeClients,
  EdgeError,
  requirePasswordChanged,
  verifiedRequestSessionId,
} from "./runtime.ts";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalid(code = "INVALID_WORK_HISTORY_QUERY"): never {
  throw new EdgeError(400, code, "업무 기록 조회 조건이 올바르지 않습니다.");
}
function validMonday(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) &&
    parsed.toISOString().slice(0, 10) === value && parsed.getUTCDay() === 1;
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
      "INVALID_WORK_HISTORY_CURSOR",
      "업무 기록 cursor가 올바르지 않습니다.",
    );
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw dbError(null);
  }
  return value as Record<string, unknown>;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw dbError(null);
  }
  return value;
}
function nullableInteger(value: unknown): number | null {
  return value === null ? null : integer(value);
}
function nullableText(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw dbError(null);
  return value;
}
function day(value: unknown): Record<string, unknown> {
  const row = object(value);
  if (
    typeof row.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) ||
    typeof row.availableSubmitted !== "boolean" ||
    typeof row.assignmentNotified !== "boolean" ||
    typeof row.fieldCompleted !== "boolean"
  ) throw dbError(null);
  return {
    date: row.date,
    availableSubmitted: row.availableSubmitted,
    assignmentNotified: row.assignmentNotified,
    fieldCompleted: row.fieldCompleted,
  };
}
function item(value: unknown): Record<string, unknown> {
  const row = object(value);
  if (
    typeof row.maidProfileId !== "string" ||
    !uuidPattern.test(row.maidProfileId) ||
    typeof row.maidDisplayName !== "string" ||
    row.maidDisplayNameSource !== "current_profile" ||
    !Array.isArray(row.days) || row.days.length !== 7
  ) throw dbError(null);
  return {
    maidProfileId: row.maidProfileId.toLowerCase(),
    maidDisplayName: row.maidDisplayName,
    maidDisplayNameSource: "current_profile",
    availabilitySubmittedAt: nullableText(row.availabilitySubmittedAt),
    availabilityCurrentVersion: nullableInteger(row.availabilityCurrentVersion),
    availabilityVersionCount: integer(row.availabilityVersionCount),
    days: row.days.map(day),
  };
}
function summary(value: unknown): Record<string, number> {
  const row = object(value);
  return {
    maidCount: integer(row.maidCount),
    availabilityMaidCount: integer(row.availabilityMaidCount),
    availabilityDayCount: integer(row.availabilityDayCount),
    notifiedMaidCount: integer(row.notifiedMaidCount),
    notifiedDayCount: integer(row.notifiedDayCount),
    fieldCompletedMaidCount: integer(row.fieldCompletedMaidCount),
    fieldCompletedDayCount: integer(row.fieldCompletedDayCount),
  };
}
function dbError(error: { message?: string } | null): EdgeError {
  if (error?.message === "WORK_HISTORY_MAID_SCOPE_REQUIRED") {
    return new EdgeError(
      403,
      error.message,
      "메이드는 본인 업무 기록만 조회할 수 있습니다.",
    );
  }
  if (
    error?.message === "WORK_HISTORY_ACCESS_REQUIRED" ||
    error?.message === "ACTIVE_SESSION_REQUIRED"
  ) {
    return new EdgeError(
      403,
      error.message,
      "업무 기록 조회 권한이 필요합니다.",
    );
  }
  if (
    error?.message === "INVALID_WORK_HISTORY_QUERY" ||
    error?.message === "WORK_HISTORY_MAID_NOT_FOUND"
  ) {
    return new EdgeError(
      400,
      error.message,
      "업무 기록 조회 조건이 올바르지 않습니다.",
    );
  }
  return new EdgeError(
    500,
    "WORK_HISTORY_QUERY_FAILED",
    "업무 기록을 조회하지 못했습니다.",
  );
}

export async function listWorkHistory(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
): Promise<Record<string, unknown>> {
  requirePasswordChanged(actor);
  if (actor.role !== "admin" && actor.role !== "maid") {
    throw new EdgeError(
      403,
      "WORK_HISTORY_ACCESS_REQUIRED",
      "업무 기록 조회 권한이 필요합니다.",
    );
  }
  const params = new URL(request.url).searchParams;
  const allowed = ["weekStart", "maidProfileId", "limit", "cursor"];
  for (const key of params.keys()) {
    if (!allowed.includes(key) || params.getAll(key).length !== 1) invalid();
  }
  const weekStart = params.get("weekStart") ?? "";
  if (!validMonday(weekStart)) invalid();
  const maid = params.get("maidProfileId");
  if (maid !== null && !uuidPattern.test(maid)) invalid();
  const rawLimit = params.get("limit") ?? "50", limit = Number(rawLimit);
  if (
    !/^[1-9]\d*$/.test(rawLimit) || !Number.isSafeInteger(limit) || limit > 100
  ) invalid();
  const scope = [
    actor.profileId.toLowerCase(),
    weekStart,
    maid?.toLowerCase() ?? "",
  ].join("|");
  const rawCursor = params.get("cursor");
  let cursor: Record<string, unknown> | null = null;
  if (rawCursor !== null) {
    if (rawCursor.length < 1 || rawCursor.length > 1024) {
      invalid("INVALID_WORK_HISTORY_CURSOR");
    }
    cursor = decode(rawCursor);
    if (
      cursor.scope !== scope || typeof cursor.maidProfileId !== "string" ||
      !uuidPattern.test(cursor.maidProfileId)
    ) {
      invalid("INVALID_WORK_HISTORY_CURSOR");
    }
  }
  const { data, error } = await clients.admin.rpc("list_work_history", {
    p_actor_profile_id: actor.profileId,
    p_session_id: verifiedRequestSessionId(request),
    p_week_start: weekStart,
    p_maid_profile_id: maid?.toLowerCase() ?? null,
    p_limit: limit,
    p_cursor_maid_profile_id: typeof cursor?.maidProfileId === "string"
      ? cursor.maidProfileId.toLowerCase()
      : null,
  });
  if (error || !data) throw dbError(error);
  const page = object(data);
  if (!Array.isArray(page.items)) throw dbError(null);
  const next = page.nextCursor === null ? null : object(page.nextCursor);
  const nextMaid = next === null ? null : next.maidProfileId;
  if (
    nextMaid !== null &&
    (typeof nextMaid !== "string" || !uuidPattern.test(nextMaid))
  ) throw dbError(null);
  return {
    weekStart: nullableText(page.weekStart),
    weekEnd: nullableText(page.weekEnd),
    timezone: nullableText(page.timezone),
    summary: summary(page.summary),
    items: page.items.map(item),
    nextCursor: nextMaid === null
      ? null
      : encode({ maidProfileId: nextMaid, scope }),
  };
}
