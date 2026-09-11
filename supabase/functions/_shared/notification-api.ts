import {
  assertNotificationResponseSize,
  decodeNotificationCursor,
  encodeNotificationCursor,
  NOTIFICATION_CURSOR_MAX_LENGTH,
  NOTIFICATION_PAGE_DEFAULT,
  NOTIFICATION_PAGE_MAX,
  notificationCursorScope,
} from "./notification-cursor.ts";
import {
  type EdgeActor,
  type EdgeClients,
  EdgeError,
  requirePasswordChanged,
  verifiedRequestSessionId,
} from "./runtime.ts";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const timestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function invalid(message = "알림 요청 값을 확인해 주세요."): never {
  throw new EdgeError(400, "VALIDATION_ERROR", message);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw databaseError(null);
  }
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw databaseError(null);
  return value;
}
function uuid(value: unknown, name = "notificationId"): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    invalid(`${name}에 UUID가 필요합니다.`);
  }
  return value.toLowerCase();
}
function nullableUuid(value: unknown): string | null {
  return value === null ? null : uuid(value);
}
function timestamp(value: unknown): string {
  const parsed = text(value);
  if (!timestampPattern.test(parsed) || !Number.isFinite(Date.parse(parsed))) {
    throw databaseError(null);
  }
  return parsed;
}
function nullableTimestamp(value: unknown): string | null {
  return value === null ? null : timestamp(value);
}
function deepLink(value: unknown): { kind: string; entityId: string } | null {
  if (value === null) return null;
  const parsed = object(value);
  if (Object.keys(parsed).sort().join(",") !== "entityId,kind") {
    throw databaseError(null);
  }
  const kind = text(parsed.kind);
  if (
    ![
      "cleaningTarget",
      "assignmentRequest",
      "submission",
      "complaintCase",
      "payrollCycle",
      "payrollProfile",
    ].includes(kind)
  ) throw databaseError(null);
  return { kind, entityId: uuid(parsed.entityId) };
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean") throw databaseError(null);
  return value;
}
function reader(actor: EdgeActor): void {
  requirePasswordChanged(actor);
  if (actor.role !== "admin" && actor.role !== "maid") {
    throw new EdgeError(
      403,
      "NOTIFICATION_ACCESS_REQUIRED",
      "알림함 접근 권한이 필요합니다.",
    );
  }
}
function projection(value: unknown): Record<string, unknown> {
  const row = object(value);
  return {
    id: uuid(row.id),
    category: text(row.category),
    title: text(row.title),
    body: text(row.body),
    roomId: nullableUuid(row.roomId),
    cleaningTargetId: nullableUuid(row.cleaningTargetId),
    deepLink: deepLink(row.deepLink),
    groupId: nullableUuid(row.groupId),
    requiresAction: bool(row.requiresAction),
    readAt: nullableTimestamp(row.readAt),
    resolvedAt: nullableTimestamp(row.resolvedAt),
    occurredAt: timestamp(row.occurredAt),
  };
}
function databaseError(error: { message?: string } | null): EdgeError {
  const message = error?.message ?? "";
  const mappings: Array<[string, number, string, string]> = [
    [
      "NOTIFICATION_NOT_FOUND",
      404,
      "NOTIFICATION_NOT_FOUND",
      "알림을 찾을 수 없습니다.",
    ],
    [
      "NOTIFICATION_ACCESS_REQUIRED",
      403,
      "NOTIFICATION_ACCESS_REQUIRED",
      "알림함 접근 권한이 필요합니다.",
    ],
    [
      "NOTIFICATION_PAGE_LIMIT_INVALID",
      400,
      "VALIDATION_ERROR",
      "limit을 확인해 주세요.",
    ],
    [
      "INVALID_NOTIFICATION_CURSOR",
      400,
      "INVALID_NOTIFICATION_CURSOR",
      "알림 cursor가 올바르지 않습니다.",
    ],
  ];
  for (const [needle, status, code, korean] of mappings) {
    if (message.includes(needle)) return new EdgeError(status, code, korean);
  }
  return new EdgeError(
    500,
    "NOTIFICATION_QUERY_FAILED",
    "알림 정보를 처리하지 못했습니다.",
  );
}
async function rpc(
  clients: EdgeClients,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const { data, error } = await clients.admin.rpc(name, args);
  if (error || data === null) throw databaseError(error);
  return data;
}
function exactQuery(
  request: Request,
  allowed: readonly string[],
): URLSearchParams {
  const query = new URL(request.url).searchParams;
  for (const key of query.keys()) {
    if (!allowed.includes(key) || query.getAll(key).length !== 1) {
      invalid("허용되지 않거나 중복된 query 항목입니다.");
    }
  }
  return query;
}
async function requireEmptyBody(request: Request): Promise<void> {
  const raw = await request.text();
  if (!raw.trim()) return;
  if (new TextEncoder().encode(raw).byteLength > 1024) invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    invalid();
  }
  if (
    !parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
    Object.keys(parsed).length !== 0
  ) invalid();
}

export function notificationReadPath(path: string): string | null {
  const match = path.match(/^\/v1\/notifications\/([^/]+)\/read$/);
  return match ? uuid(match[1]) : null;
}

export async function listNotifications(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
): Promise<unknown> {
  reader(actor);
  const query = exactQuery(request, ["limit", "cursor"]);
  const rawLimit = query.get("limit");
  const limit = rawLimit === null
    ? NOTIFICATION_PAGE_DEFAULT
    : /^[1-9]\d*$/.test(rawLimit)
    ? Number(rawLimit)
    : 0;
  if (limit < 1 || limit > NOTIFICATION_PAGE_MAX) {
    invalid("limit을 확인해 주세요.");
  }
  const cursor = query.get("cursor");
  if (
    cursor !== null &&
    (cursor.length === 0 || cursor.length > NOTIFICATION_CURSOR_MAX_LENGTH)
  ) {
    throw new EdgeError(
      400,
      "INVALID_NOTIFICATION_CURSOR",
      "알림 cursor가 올바르지 않습니다.",
    );
  }
  const scope = notificationCursorScope(actor);
  const after = cursor ? await decodeNotificationCursor(cursor, scope) : null;
  const page = object(
    await rpc(clients, "list_notifications_page", {
      p_actor_profile_id: actor.profileId,
      p_session_id: verifiedRequestSessionId(request),
      p_after_occurred_at: after?.occurredAt ?? null,
      p_after_id: after?.id ?? null,
      p_limit: limit,
    }),
  );
  if (!Array.isArray(page.notifications)) throw databaseError(null);
  const notifications = page.notifications.map(projection);
  const hasMore = bool(page.hasMore);
  const lastOccurredAt = nullableTimestamp(page.lastOccurredAt);
  const lastId = nullableUuid(page.lastId);
  if (hasMore && (!lastOccurredAt || !lastId)) throw databaseError(null);
  const response = {
    notifications,
    nextCursor: hasMore
      ? await encodeNotificationCursor(scope, {
        occurredAt: lastOccurredAt as string,
        id: lastId as string,
      })
      : null,
  };
  assertNotificationResponseSize(response);
  return response;
}

export async function markNotificationRead(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  notificationId: string,
): Promise<unknown> {
  reader(actor);
  exactQuery(request, []);
  await requireEmptyBody(request);
  const response = {
    notification: projection(
      await rpc(clients, "mark_notification_read", {
        p_actor_profile_id: actor.profileId,
        p_session_id: verifiedRequestSessionId(request),
        p_notification_id: notificationId,
      }),
    ),
  };
  assertNotificationResponseSize(response);
  return response;
}
