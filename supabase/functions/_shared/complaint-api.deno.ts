import {
  complaintPath,
  complaintReworkDecisionProjection,
  dbError,
} from "./complaint-api.ts";
import {
  complaintCursorScope,
  decodeComplaintCursor,
  encodeComplaintCursor,
} from "./complaint-cursor.ts";
import { EdgeError } from "./runtime.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

Deno.test("complaint path parser accepts only the bounded public contract", () => {
  const id = "10000000-0000-4000-8000-000000000001";
  assert(complaintPath(`/v1/complaints/${id}`)?.kind === "detail", "detail");
  assert(
    complaintPath(`/v1/complaints/${id}/corrections`)?.kind === "corrections",
    "correction",
  );
  assert(
    complaintPath(`/v1/complaints/${id}/rework`)?.kind === "rework",
    "rework",
  );
  assert(
    complaintPath(`/v1/complaints/${id}/reopen`) === null,
    "no reopen route",
  );
});

Deno.test("complaint rework projection isolates maid identities and compensation", () => {
  const original = complaintReworkDecisionProjection({
    view: "originalMaid",
    sameMaid: false,
    sourceDecisionIsCurrent: true,
  });
  assert(original !== null, "original maid projection exists");
  assert(
    !("compensationAmount" in original),
    "original maid has no other-maid pay",
  );
  assert(
    !("assigneeMaidProfileId" in original),
    "original maid has no assignee id",
  );
  const assignee = complaintReworkDecisionProjection({
    view: "assigneeMaid",
    id: "10000000-0000-4000-8000-000000000010",
    reworkCleaningTargetId: "10000000-0000-4000-8000-000000000011",
    compensationAmount: 0,
    currency: "KRW",
    sourceDecisionIsCurrent: false,
  });
  assert(assignee !== null, "assignee projection exists");
  assert(
    !("originalMaidProfileId" in assignee),
    "assignee has no original maid id",
  );
});

Deno.test("complaint cursor is signed and bound to actor, range, and stream", async () => {
  Deno.env.set(
    "PAYROLL_CURSOR_HMAC_SECRET",
    "complaint-cursor-test-secret-at-least-32-bytes",
  );
  const actor = {
    profileId: "10000000-0000-4000-8000-000000000001",
    role: "admin",
  } as never;
  const scope = complaintCursorScope(actor, {
    kind: "list",
    from: "2026-09-01T00:00:00Z",
    to: "2026-09-10T00:00:00Z",
  });
  const cursor = await encodeComplaintCursor(scope, {
    receivedAt: "2026-09-09T00:00:00Z",
    complaintId: "10000000-0000-4000-8000-000000000002",
  });
  assert(
    "receivedAt" in await decodeComplaintCursor(cursor, scope),
    "round trip",
  );
  const changed = complaintCursorScope(actor, {
    kind: "list",
    from: "2026-09-02T00:00:00Z",
    to: "2026-09-10T00:00:00Z",
  });
  let denied = false;
  try {
    await decodeComplaintCursor(cursor, changed);
  } catch (error) {
    denied = error instanceof EdgeError &&
      error.code === "INVALID_COMPLAINT_CURSOR";
  }
  assert(denied, "scope tampering denied");
});

Deno.test("complaint database errors expose stable safe codes", () => {
  assert(
    dbError({ message: "STALE_VERSION: private detail" }).code ===
      "STALE_VERSION",
    "stable code",
  );
  assert(
    dbError({ message: "secret internal detail" }).code ===
      "COMPLAINT_COMMAND_FAILED",
    "redacted fallback",
  );
});
