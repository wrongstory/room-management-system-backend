import {
  assertEmptyDiagnosticRequestBody,
  developerAuditEvents,
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

Deno.test("developer audit query accepts all 44 approved event types and rejects 45 before RPC", async () => {
  let calls = 0;
  const clients = {
    admin: {
      rpc: (_name: string, args: Record<string, unknown>) => {
        calls += 1;
        assert(
          (args.p_event_types as unknown[]).length === 44,
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
  assert(query.size === 44, "actual source enum inventory");
  await developerAuditEvents(
    new Request(
      `https://example.invalid/functions/v1/api/v1/developer/audit-events?${query}`,
    ),
    clients,
    actor,
  );
  assert(calls === 1, "all 44 accepted");
  query.append("eventType", "cleaning.offline_event_resolved");
  try {
    await developerAuditEvents(
      new Request(
        `https://example.invalid/functions/v1/api/v1/developer/audit-events?${query}`,
      ),
      clients,
      actor,
    );
    throw new Error("45 must fail");
  } catch (error) {
    assert(
      error instanceof EdgeError && error.status === 400,
      "45 rejected with stable validation",
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
    expectedMigrationName === "photo_purge_reconciliation",
    "expected migration must not depend on a remote execution timestamp",
  );
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
