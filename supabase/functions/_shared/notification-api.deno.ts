import {
  assertNotificationResponseSize,
  decodeNotificationCursor,
  encodeNotificationCursor,
  notificationCursorScope,
} from "./notification-cursor.ts";
import {
  listNotifications,
  markNotificationRead,
  notificationReadPath,
} from "./notification-api.ts";
import type { EdgeActor, EdgeClients } from "./runtime.ts";
import { EdgeError } from "./runtime.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const actor = {
  authUserId: "10800000-0000-4000-8000-000000000101",
  profileId: "10800000-0000-4000-8000-000000000001",
  displayName: "알림 메이드",
  role: "maid",
  mustChangePassword: false,
} satisfies EdgeActor;
const sessionId = "10800000-0000-4000-8000-000000000901";
function token() {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `${encode({ alg: "none" })}.${encode({ session_id: sessionId })}.x`;
}
function request(method: string, path: string, body?: unknown) {
  return new Request(`http://local/functions/v1/api${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token()}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const notice = {
  id: "10800000-0000-4000-8000-000000001001",
  category: "assignment_changed",
  title: "배정이 변경되었습니다",
  body: "업무 앱에서 최신 배정을 확인해 주세요.",
  roomId: null,
  cleaningTargetId: null,
  deepLink: null,
  groupId: null,
  requiresAction: true,
  readAt: null,
  resolvedAt: null,
  occurredAt: "2026-09-11T01:00:00Z",
};

Deno.test("notification cursor is dedicated, signed, and actor-role-stream-sort bound", async () => {
  Deno.env.set(
    "PAYROLL_CURSOR_HMAC_SECRET",
    "payroll-secret-distinct-from-notice-123456",
  );
  Deno.env.set(
    "NOTIFICATION_CURSOR_HMAC_SECRET",
    "notification-cursor-edge-test-secret-123456",
  );
  const scope = notificationCursorScope(actor);
  const cursor = await encodeNotificationCursor(scope, {
    occurredAt: notice.occurredAt,
    id: notice.id,
  });
  const decoded = await decodeNotificationCursor(cursor, scope);
  assert(decoded.id === notice.id, "signed cursor round trips");
  for (
    const [label, value, changedScope] of [
      ["tamper", `${cursor.slice(0, -1)}A`, scope],
      ["actor", cursor, {
        ...scope,
        actorProfileId: "10800000-0000-4000-8000-000000000002",
      }],
      ["role", cursor, { ...scope, actorRole: "admin" as const }],
      ["stream", cursor, { ...scope, stream: "another-stream" as never }],
      ["sort", cursor, { ...scope, sort: "id:asc" as never }],
    ] as const
  ) {
    let rejected = false;
    try {
      await decodeNotificationCursor(value, changedScope);
    } catch (error) {
      rejected = error instanceof EdgeError &&
        error.code === "INVALID_NOTIFICATION_CURSOR";
    }
    assert(rejected, `${label} scope/tamper rejected`);
  }
  Deno.env.set(
    "NOTIFICATION_CURSOR_HMAC_SECRET",
    "payroll-secret-distinct-from-notice-123456",
  );
  let reused = false;
  try {
    await encodeNotificationCursor(scope, {
      occurredAt: notice.occurredAt,
      id: notice.id,
    });
  } catch (error) {
    reused = error instanceof EdgeError &&
      error.code === "NOTIFICATION_CURSOR_NOT_CONFIGURED";
  }
  assert(reused, "notification secret cannot reuse payroll secret");
});

Deno.test("notification list and markRead expose only safe fields and exact request contract", async () => {
  Deno.env.set(
    "PAYROLL_CURSOR_HMAC_SECRET",
    "payroll-secret-distinct-from-notice-123456",
  );
  Deno.env.set(
    "NOTIFICATION_CURSOR_HMAC_SECRET",
    "notification-cursor-edge-test-secret-123456",
  );
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const clients = {
    admin: {
      rpc: (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return Promise.resolve({
          error: null,
          data: name === "list_notifications_page"
            ? {
              notifications: [notice],
              hasMore: false,
              lastOccurredAt: null,
              lastId: null,
            }
            : { ...notice, readAt: "2026-09-11T02:00:00Z" },
        });
      },
    },
  } as unknown as EdgeClients;
  const list = await listNotifications(
    request("GET", "/v1/notifications?limit=50"),
    clients,
    actor,
  ) as {
    notifications: Array<Record<string, unknown>>;
    nextCursor: string | null;
  };
  assert(
    list.notifications.length === 1 && list.nextCursor === null,
    "safe list response",
  );
  assert(
    !("dedupeKey" in list.notifications[0]) &&
      !("groupKey" in list.notifications[0]) &&
      !("recipientProfileId" in list.notifications[0]) &&
      !("eventFamily" in list.notifications[0]) &&
      !("sourceEntityId" in list.notifications[0]),
    "internal fields absent",
  );
  assert(
    calls[0].args.p_session_id === sessionId,
    "live JWT session id reaches DB RPC",
  );

  const marked = await markNotificationRead(
    request("POST", `/v1/notifications/${notice.id}/read`, {}),
    clients,
    actor,
    notice.id,
  ) as { notification: Record<string, unknown> };
  assert(
    marked.notification.readAt === "2026-09-11T02:00:00Z",
    "server readAt returned",
  );
  for (
    const body of [{ readAt: "2099-01-01T00:00:00Z" }, { resolvedAt: null }, {
      title: "변조",
    }]
  ) {
    let rejected = false;
    try {
      await markNotificationRead(
        request("POST", `/v1/notifications/${notice.id}/read`, body),
        clients,
        actor,
        notice.id,
      );
    } catch (error) {
      rejected = error instanceof EdgeError &&
        error.code === "VALIDATION_ERROR";
    }
    assert(rejected, "markRead accepts no client-controlled fields");
  }
  assert(
    notificationReadPath(`/v1/notifications/${notice.id}/read`) === notice.id,
    "exact route accepted",
  );
  assert(
    notificationReadPath(`/v1/notifications/${notice.id}/read/extra`) === null,
    "route alias denied",
  );
});

Deno.test("notification responses fail closed above 128 KiB", () => {
  let rejected = false;
  try {
    assertNotificationResponseSize({
      notifications: [{ ...notice, body: "가".repeat(50000) }],
      nextCursor: null,
    });
  } catch (error) {
    rejected = error instanceof EdgeError &&
      error.code === "NOTIFICATION_RESPONSE_TOO_LARGE";
  }
  assert(rejected, "legacy unbounded text cannot exceed response cap");
});
