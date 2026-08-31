import {
  authorizationSourceForPath,
  isAuthorizationDeniedCode,
} from "./activity-contract.ts";
import {
  recordAuthorizationDenied,
  recordKnownLoginFailed,
  recordLoginSucceeded,
  recordUnknownLoginFailed,
} from "./activity-api.ts";
import type { EdgeActor, EdgeClients } from "./runtime.ts";
import { requestId } from "./runtime.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const actor: EdgeActor = {
  authUserId: "10000000-0000-4000-8000-000000000001",
  profileId: "20000000-0000-4000-8000-000000000001",
  displayName: "개발자",
  role: "developer",
  mustChangePassword: false,
};

Deno.test("activity adapter sends only source-controlled safe fields", async () => {
  const calls: Array<{ name: string; parameters: Record<string, unknown> }> =
    [];
  const clients = {
    admin: {
      rpc: (name: string, parameters: Record<string, unknown>) => {
        calls.push({ name, parameters });
        return Promise.resolve({ data: null, error: null });
      },
    },
  } as unknown as EdgeClients;

  await recordLoginSucceeded(clients, actor, "request.login.success");
  await recordKnownLoginFailed(
    clients,
    actor,
    "request.login.failure",
    "INVALID_CREDENTIALS",
  );
  await recordAuthorizationDenied(
    clients,
    actor,
    "edge.authorization.developer",
    "request.denied",
    "DEVELOPER_REQUIRED",
  );
  await recordUnknownLoginFailed(clients);

  assert(calls.length === 4, "four activity writes expected");
  assert(
    calls.at(-1)?.name === "record_unknown_login_failure",
    "unknown login must use bounded aggregate RPC",
  );
  const serialized = JSON.stringify(calls);
  for (
    const prohibited of [
      "password",
      "access_token",
      "refresh_token",
      "phone",
      "guest_name",
      "client_ip",
      "request_body",
    ]
  ) {
    assert(
      !serialized.toLowerCase().includes(prohibited),
      `${prohibited} must not be sent`,
    );
  }
});

Deno.test("authorization activity maps routes to fixed capability sources", () => {
  assert(
    authorizationSourceForPath("/v1/developer/overview") ===
      "edge.authorization.developer",
    "developer route category",
  );
  assert(
    authorizationSourceForPath("/v1/availability") ===
      "edge.authorization.availability",
    "availability route category",
  );
  assert(
    authorizationSourceForPath("/v1/unknown") === null,
    "unknown routes must not be persisted",
  );
  assert(isAuthorizationDeniedCode("ADMIN_REQUIRED"), "approved denial code");
  assert(
    !isAuthorizationDeniedCode("DB raw error"),
    "free-form denial rejected",
  );
});

Deno.test("request ID accepts only the safe correlation format", () => {
  const accepted = requestId(
    new Request("http://localhost", {
      headers: { "x-request-id": "front:request-01" },
    }),
  );
  assert(accepted === "front:request-01", "safe request ID must be preserved");
  const rejected = requestId(
    new Request("http://localhost", {
      headers: { "x-request-id": "Authorization: Bearer secret token" },
    }),
  );
  assert(
    rejected !== "Authorization: Bearer secret token",
    "unsafe request ID replaced",
  );
  assert(/^[0-9a-f-]{36}$/.test(rejected), "replacement must be UUID-shaped");
});
