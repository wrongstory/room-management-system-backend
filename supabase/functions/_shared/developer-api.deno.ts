import {
  assertEmptyDiagnosticRequestBody,
  developerAuditEvents,
  developerDatabaseStatus,
  developerRuntimeStatus,
  expectedMigrationName,
  toDeveloperActivityEvent,
  toDeveloperAuditEvent,
} from "./developer-api.ts";
import { type EdgeClients, EdgeError, requireDeveloper } from "./runtime.ts";
import { openApiDocument } from "./openapi.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

Deno.test("developer runtime reports Google and purge configuration booleans only without environment enumeration", () => {
  const get = Deno.env.get;
  const keys = [
    "GOOGLE_DRIVE_CLIENT_ID",
    "GOOGLE_DRIVE_CLIENT_SECRET",
    "GOOGLE_DRIVE_REFRESH_TOKEN",
    "GOOGLE_DRIVE_ROOT_FOLDER_ID",
    "PHOTO_PURGE_INVOKE_SECRET",
  ];
  const configured = new Set<string>();
  const allowed: readonly string[] =
    openApiDocument.components.schemas.DeveloperRuntimeStatus.properties
      .configuration.required;
  try {
    Deno.env.get = (key: string) => {
      assert(
        allowed.includes(key) ||
          ["RUNTIME_ENVIRONMENT", "SUPABASE_URL"].includes(key),
        "only fixed environment names are read",
      );
      return configured.has(key) ? "synthetic-private-value" : undefined;
    };
    for (const present of [false, true]) {
      if (present) {
        keys.forEach((key) => {
          configured.add(key);
        });
      }
      const result = developerRuntimeStatus();
      const configuration = result.configuration as Record<
        string,
        { configured: boolean }
      >;
      assert(
        Object.keys(configuration).sort().join() === [...allowed].sort().join(),
        "OpenAPI exact configuration keys",
      );
      for (const key of keys) {
        assert(
          JSON.stringify(configuration[key]) ===
            JSON.stringify({ configured: present }),
          "only configured boolean for Google field",
        );
      }
      assert(
        !JSON.stringify(result).includes("synthetic-private-value"),
        "no raw configured value",
      );
    }
  } finally {
    Deno.env.get = get;
  }
});

Deno.test("developer audit query accepts all 58 approved event types and rejects 59 before RPC", async () => {
  let calls = 0;
  const clients = {
    admin: {
      rpc: (_name: string, args: Record<string, unknown>) => {
        calls += 1;
        assert(
          (args.p_event_types as unknown[]).length === 58,
          "full current inventory passed",
        );
        return Promise.resolve({ data: [], error: null });
      },
    },
  } as unknown as EdgeClients;
  const actor = {
    authUserId: "10000000-0000-4000-8000-000000000001",
    profileId: "20000000-0000-4000-8000-000000000001",
    displayName: "개발자",
    role: "developer" as const,
    mustChangePassword: false,
  };
  const query = new URLSearchParams();
  for (
    const event of openApiDocument.components.schemas.DeveloperAuditEventType
      .enum
  ) query.append("eventType", event);
  assert(query.size === 58, "actual source enum inventory");
  await developerAuditEvents(
    new Request(
      `https://example.invalid/functions/v1/api/v1/developer/audit-events?${query}`,
    ),
    clients,
    actor,
  );
  assert(calls === 1, "all 58 accepted");
  query.append("eventType", "cleaning.offline_event_resolved");
  try {
    await developerAuditEvents(
      new Request(
        `https://example.invalid/functions/v1/api/v1/developer/audit-events?${query}`,
      ),
      clients,
      actor,
    );
    throw new Error("56 must fail");
  } catch (error) {
    assert(
      error instanceof EdgeError && error.status === 400,
      "56 rejected with stable validation",
    );
  }
  assert(calls === 1, "over-limit query never reaches DB");
});

Deno.test("developer audit mapper exposes only the bounded camelCase projection", () => {
  const event = toDeveloperAuditEvent({
    id: "00000000-0000-4000-8000-000000000001",
    event_type: "account.created",
    entity_type: "profile",
    entity_id: "00000000-0000-4000-8000-000000000002",
    actor_profile_id: "00000000-0000-4000-8000-000000000003",
    actor_display_name: "개발자",
    effective_at: "2026-08-30T00:00:00.000Z",
    recorded_at: "2026-08-30T00:00:01.000Z",
    reason_code: null,
    summary: { role: "admin", status: "active" },
  });

  assert(event.eventType === "account.created", "eventType must be mapped");
  assert(event.actorProfileId !== null, "actorProfileId must be mapped");
  assert(!("before_state" in event), "raw before_state must never leak");
  assert(!("after_state" in event), "raw after_state must never leak");
});

Deno.test("developer source migration head uses a stable migration name", () => {
  assert(
    expectedMigrationName === "web_push_vapid_binding",
    "expected migration must not depend on a remote execution timestamp",
  );
});

Deno.test("developer database status degrades a fresh healthy heartbeat for a malformed prior envelope key", async () => {
  const names: string[] = [];
  const get = Deno.env.get;
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicRaw = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  const base64 = (value: Uint8Array) => btoa(String.fromCharCode(...value));
  const base64url = (value: Uint8Array) =>
    base64(value).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const malformedPriorKey = base64(new Uint8Array(31).fill(9));
  const environment: Record<string, string> = {
    RUNTIME_ENVIRONMENT: "local",
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-status-test-secret-123456",
    WEB_PUSH_BINDING_DIGEST_SECRET: "binding-status-test-secret-1234567890",
    WEB_PUSH_SUBSCRIPTION_KEY_BASE64: base64(new Uint8Array(32).fill(7)),
    WEB_PUSH_SUBSCRIPTION_KEY_VERSION: "envelope-v2",
    WEB_PUSH_SUBSCRIPTION_KEYRING_JSON: JSON.stringify({
      "envelope-v1": malformedPriorKey,
    }),
    VAPID_SUBJECT: "mailto:push@example.com",
    VAPID_CURRENT_KEY_VERSION: "vapid-v1",
    VAPID_PUBLIC_KEY: base64url(publicRaw),
    VAPID_PUBLIC_KEYRING_JSON: "{}",
    VAPID_PRIVATE_KEY: String(privateJwk.d),
    VAPID_KEYRING_JSON: "{}",
    NOTIFICATION_DELIVERY_INVOKE_SECRET:
      "notification-delivery-status-test-123456",
  };
  const clients = {
    admin: {
      rpc: (name: string) => {
        names.push(name);
        if (name === "get_developer_notification_delivery_status") {
          return Promise.resolve({
            data: {
              status: "healthy",
              lastHeartbeat: "2026-09-11T00:00:30.000Z",
              backlog: {
                due: 1,
                retrying: 0,
                deadLetter: 0,
                jobOnlyDeadLetter: 1,
                blocked: 0,
                expiredLeases: 0,
                oldestDueAt: "2026-09-11T00:00:00.000Z",
              },
              activation: { cronConfigured: true, cronActive: true },
              checkedAt: "2026-09-11T00:01:00.000Z",
            },
            error: null,
          });
        }
        return Promise.resolve({ data: {}, error: null });
      },
    },
  } as unknown as EdgeClients;
  let result: Record<string, unknown>;
  try {
    Deno.env.get = (key: string) => environment[key] ?? "configured";
    result = await developerDatabaseStatus(clients, {
      authUserId: "10000000-0000-4000-8000-000000000001",
      profileId: "20000000-0000-4000-8000-000000000001",
      displayName: "개발자",
      role: "developer",
      mustChangePassword: false,
    });
  } finally {
    Deno.env.get = get;
  }
  assert(
    names.length === 3,
    "database status uses three app-owned projections",
  );
  assert(
    "notificationDelivery" in result,
    "bounded delivery health is present",
  );
  const delivery = result.notificationDelivery as Record<string, unknown>;
  assert(
    delivery.status === "degraded",
    "malformed prior envelope key overrides a fresh healthy heartbeat",
  );
  assert(
    (delivery.activation as Record<string, unknown>)
      .functionSecretsConfigured === true,
    "Function Secrets expose only an aggregate configured boolean",
  );
  assert(
    (delivery.activation as Record<string, unknown>)
      .providerConfigurationValid === false,
    "current config validity exposes only a safe boolean",
  );
  const serialized = JSON.stringify(result).toLowerCase();
  for (
    const forbidden of [
      "endpoint",
      "sessiondigest",
      "claimdigest",
      "ciphertext",
      "providererror",
      malformedPriorKey.toLowerCase(),
    ]
  ) {
    assert(!serialized.includes(forbidden), `${forbidden} must not leak`);
  }
});

Deno.test("developer activity mapper exposes only the safe projection", () => {
  const event = toDeveloperActivityEvent({
    id: "00000000-0000-4000-8000-000000000001",
    category: "auth",
    event_type: "auth.login_failed",
    outcome: "failed",
    actor_profile_id: "00000000-0000-4000-8000-000000000002",
    actor_role: "admin",
    source: "edge.auth.login",
    resource_type: null,
    resource_id: null,
    reason_code: "INVALID_CREDENTIALS",
    request_id: "request-01",
    occurred_at: "2026-08-31T00:00:00.000Z",
    recorded_at: "2026-08-31T00:00:01.000Z",
    summary: {},
  });

  assert(event.eventType === "auth.login_failed", "event type mapped");
  assert(event.actorRole === "admin", "role snapshot mapped");
  const serialized = JSON.stringify(event).toLowerCase();
  assert(!serialized.includes("password"), "password must not leak");
  assert(!serialized.includes("token"), "token must not leak");
  assert(!serialized.includes("clientip"), "raw IP must not leak");
});

Deno.test("developer operations reject business admin and maid roles", () => {
  const actor = {
    authUserId: "00000000-0000-4000-8000-000000000001",
    profileId: "00000000-0000-4000-8000-000000000002",
    displayName: "운영자",
    role: "developer" as const,
    mustChangePassword: false,
  };
  requireDeveloper(actor);

  for (const role of ["admin", "maid"] as const) {
    try {
      requireDeveloper({ ...actor, role });
      throw new Error(`${role} must be rejected`);
    } catch (error) {
      assert(error instanceof EdgeError, `${role} must return an EdgeError`);
      assert(error.code === "DEVELOPER_REQUIRED", `${role} error code`);
    }
  }
});

Deno.test("developer diagnostics accepts hosted-style empty POST bodies", async () => {
  await assertEmptyDiagnosticRequestBody(
    new Request("https://example.test/v1/developer/diagnostics", {
      method: "POST",
    }),
  );
  await assertEmptyDiagnosticRequestBody(
    new Request("https://example.test/v1/developer/diagnostics", {
      method: "POST",
      headers: { "content-length": "0" },
      body: "",
    }),
  );
});

Deno.test("developer diagnostics rejects every non-empty request body", async () => {
  for (const body of ["{}", " ", "null", '{"check":true}']) {
    try {
      await assertEmptyDiagnosticRequestBody(
        new Request("https://example.test/v1/developer/diagnostics", {
          method: "POST",
          body,
        }),
      );
      throw new Error("non-empty diagnostics body must be rejected");
    } catch (error) {
      assert(error instanceof EdgeError, "body rejection must be EdgeError");
      assert(error.code === "VALIDATION_ERROR", "body rejection error code");
    }
  }

  try {
    await assertEmptyDiagnosticRequestBody(
      new Request("https://example.test/v1/developer/diagnostics", {
        method: "POST",
        headers: { "content-length": "0" },
        body: "{}",
      }),
    );
    throw new Error("content-length zero must not hide actual body bytes");
  } catch (error) {
    assert(error instanceof EdgeError, "actual body bytes must be rejected");
    assert(error.code === "VALIDATION_ERROR", "actual body error code");
  }
});

Deno.test("developer diagnostics rejects positive or malformed content lengths", async () => {
  for (const contentLength of ["1", "2", "invalid", "-1"]) {
    try {
      await assertEmptyDiagnosticRequestBody(
        new Request("https://example.test/v1/developer/diagnostics", {
          method: "POST",
          headers: { "content-length": contentLength },
        }),
      );
      throw new Error("invalid diagnostics content length must be rejected");
    } catch (error) {
      assert(
        error instanceof EdgeError,
        "content length rejection must be EdgeError",
      );
      assert(
        error.code === "VALIDATION_ERROR",
        "content length rejection error code",
      );
    }
  }
});
