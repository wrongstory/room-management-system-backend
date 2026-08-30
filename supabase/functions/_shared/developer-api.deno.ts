import {
  expectedMigrationName,
  toDeveloperAuditEvent,
} from "./developer-api.ts";
import { EdgeError, requireDeveloper } from "./runtime.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

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
    expectedMigrationName === "developer_operations_projections",
    "expected migration must not depend on a remote execution timestamp",
  );
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
