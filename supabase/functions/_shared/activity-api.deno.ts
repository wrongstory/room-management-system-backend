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

  await recordLoginSucceeded(clients, actor);
  await recordKnownLoginFailed(
    clients,
    actor,
    "INVALID_CREDENTIALS",
  );
  await recordAuthorizationDenied(
    clients,
    actor,
    "edge.authorization.developer",
    "DEVELOPER_REQUIRED",
  );
  await recordUnknownLoginFailed(clients);

  assert(calls.length === 4, "four activity writes expected");
  assert(
    calls.at(-1)?.name === "record_unknown_login_failure",
    "unknown login must use bounded aggregate RPC",
  );
  const serialized = JSON.stringify(calls);
  const eventCalls = calls.filter((call) =>
    call.name === "record_actor_activity_event"
  );
  assert(eventCalls.length === 2, "known login events use immutable rows");
  for (const call of eventCalls) {
    assert(
      typeof call.parameters.p_request_id === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
          .test(
            call.parameters.p_request_id,
          ),
      "persisted request ID must be a server-generated UUID v4",
    );
  }
  const denialCall = calls.find((call) =>
    call.name === "record_authorization_denial"
  );
  assert(
    denialCall && !("p_request_id" in denialCall.parameters),
    "authorization aggregate must not persist a request ID",
  );
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
    authorizationSourceForPath("/v1/reservations/fixture/cancel") ===
      "edge.authorization.reservations",
    "reservation route category",
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

Deno.test("caller request IDs stay transient and never enter activity RPCs", async () => {
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
  const callerValues = [
    "01012345678",
    "9d0fc2c7-40a7-4bfd-9003-7d52ea7ad3ce",
    "short-token",
    "refresh-token.example.secret",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature",
  ];

  for (const callerValue of callerValues) {
    requestId(
      new Request("http://localhost", {
        headers: { "x-request-id": callerValue },
      }),
    );
    await recordLoginSucceeded(clients, actor);
  }

  const serialized = JSON.stringify(calls);
  for (const callerValue of callerValues) {
    assert(
      !serialized.includes(callerValue),
      "caller-controlled request ID must not enter activity writes",
    );
  }
  for (const call of calls) {
    assert(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        .test(
          String(call.parameters.p_request_id),
        ),
      "each persisted ID must be server-generated UUID v4",
    );
  }
});
