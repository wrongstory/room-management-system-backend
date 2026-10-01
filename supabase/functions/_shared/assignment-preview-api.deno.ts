import {
  assignmentDurationPolicy,
  previewAssignments,
  previewDatabaseError,
  previewServiceDate,
} from "./assignment-preview-api.ts";
import { type EdgeActor, type EdgeClients, EdgeError } from "./runtime.ts";
import { jsonResponse } from "./runtime.ts";
import {
  mixedDatePreviewSnapshot,
  zeroPreviewSnapshot,
} from "../../../tests/fixtures/assignment-preview.ts";
import { optimizeAssignmentPreview } from "./assignment-preview-core.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const admin: EdgeActor = {
  authUserId: "10000000-0000-4000-8000-000000000001",
  profileId: "20000000-0000-4000-8000-000000000001",
  role: "admin",
  displayName: "관리자",
  mustChangePassword: false,
};
const today = () =>
  new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
function request(body: unknown, method = "POST") {
  return new Request(
    "http://localhost/functions/v1/api/v1/assignments/preview",
    {
      method,
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "preview-config-001",
      },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    },
  );
}
async function failure(run: () => Promise<unknown>, code: string) {
  try {
    await run();
  } catch (e) {
    assert(e instanceof EdgeError && e.code === code, `expected ${code}`);
    return;
  }
  throw new Error(`expected ${code}`);
}
function clients(error: string | null = null, data: unknown = null) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    client: {
      admin: {
        rpc: (name: string, args: Record<string, unknown>) => {
          calls.push({ name, args });
          return Promise.resolve({
            data,
            error: error ? { message: error } : null,
          });
        },
      },
    } as unknown as EdgeClients,
  };
}

Deno.test("preview diagnostics match shared core and Fastify fixture without extra RPC", async () => {
  const serviceDate = today(), data = zeroPreviewSnapshot(serviceDate);
  const mock = clients(null, data);
  const actual = await previewAssignments(
    request({ serviceDate, previewSeed: "diagnostic-parity" }),
    mock.client,
    admin,
  );
  const expected = await optimizeAssignmentPreview(data, "diagnostic-parity");
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    "full response parity",
  );
  assert(actual.remainingUnassignedTargets.length === 12, "12 remaining");
  assert(
    actual.diagnostics.activeMaidCount === 1,
    "same-snapshot active count",
  );
  assert(actual.diagnostics.eligibleMaidCount === 0, "no eligible maid");
  assert(
    mock.calls.length === 1 &&
      mock.calls[0]?.name === "get_assignment_preview_snapshot",
    "readonly RPC only",
  );
  assert(
    jsonResponse(actual).headers.get("Cache-Control") === "no-store",
    "no-store",
  );
});

Deno.test("mixed-date overdue preview preserves diagnostics, reserved slots and readonly parity", async () => {
  const serviceDate = today(), data = mixedDatePreviewSnapshot(serviceDate);
  const before = JSON.stringify(data), mock = clients(null, data);
  const actual = await previewAssignments(
    request({ serviceDate, previewSeed: "mixed-date" }),
    mock.client,
    admin,
  );
  assert(
    JSON.stringify(actual) ===
      JSON.stringify(await optimizeAssignmentPreview(data, "mixed-date")),
    "full shared-core parity",
  );
  assert(
    actual.fixedAssignments.length === 2 &&
      actual.fixedAssignments.every((a) => a.proposedSequenceNumber === 1),
    "different-date sequence1 is preserved",
  );
  assert(
    actual.diagnostics.eligibleMaidCount === 1 &&
      actual.diagnostics.fixedExclusions.length === 0,
    "past work is not a fixed-date conflict",
  );
  assert(
    actual.proposedAssignments.length === 10 &&
      actual.remainingUnassignedTargets.length === 0 &&
      actual.blockedTargets.length === 0,
    "elapsed deadline is not exclusion",
  );
  assert(
    actual.proposedAssignments.filter((a) => a.serviceDate < serviceDate).every(
      (a) => a.proposedSequenceNumber > 10,
    ),
    "historical occupied slots preserved",
  );
  assert(
    actual.proposedAssignments.filter((a) => a.serviceDate === serviceDate)
      .every((a) => a.proposedSequenceNumber > 20),
    "today occupied slots preserved",
  );
  assert(
    JSON.stringify(data) === before &&
      !JSON.stringify(actual).includes("private-source-not-for-response") &&
      !JSON.stringify(actual).includes("sequenceReservations"),
    "immutable input/private metadata",
  );
  assert(
    mock.calls.length === 1 &&
      mock.calls[0]?.name === "get_assignment_preview_snapshot",
    "one readonly RPC/no mutation",
  );
  assert(
    jsonResponse(actual).headers.get("Cache-Control") === "no-store",
    "no-store",
  );
});

Deno.test("preview rejects malformed input before readonly RPC", async () => {
  const mock = clients();
  for (
    const body of [
      {},
      { serviceDate: "2026-02-30" },
      { serviceDate: "2000-01-01" },
      { serviceDate: today(), extra: true },
      ...["", "bad seed", "x".repeat(129), 4, null].map((previewSeed) => ({
        serviceDate: today(),
        previewSeed,
      })),
    ]
  ) {
    await failure(
      () => previewAssignments(request(body), mock.client, admin),
      "serviceDate" in body && body.serviceDate === today()
        ? "VALIDATION_ERROR"
        : "ASSIGNMENT_PREVIEW_DATE_NOT_ALLOWED",
    );
  }
  assert(mock.calls.length === 0, "invalid input must not query DB");
  assert(
    previewServiceDate("2030-01-01", new Date("2029-12-31T15:01:00Z")) ===
      "2030-01-01",
    "KST date",
  );
  assert(
    previewServiceDate("2030-01-02", new Date("2029-12-31T15:01:00Z")) ===
      "2030-01-02",
    "KST tomorrow",
  );
});

Deno.test("preview proposes an overdue target without rescheduling or persisting it", async () => {
  const serviceDate = today();
  const availableFrom = `${serviceDate}T10:00:00+09:00`;
  const dueAt = `${serviceDate}T11:00:00+09:00`;
  const mock = clients(null, {
    serviceDate,
    planningAt: `${serviceDate}T12:00:00+09:00`,
    maids: [{
      maidProfileId: "maid-one",
      maidDisplayName: "메이드",
      role: "maid",
      status: "active",
      availabilityVersion: 1,
      available: true,
    }],
    targets: [{
      cleaningTargetId: "overdue",
      roomId: "room-one",
      roomNumber: "101",
      roomTypeCode: "standard",
      elevatorZone: "A",
      feeSnapshot: 16000,
      availableFrom,
      dueAt,
      serviceDate,
      status: "unassigned",
      assignmentVersion: 1,
      source: "manual_room_request",
      cleaningKind: "additional",
      domainIdentity: { sourceId: "overdue", roomReservations: [] },
      blockedReason: null,
      recleanMaidProfileId: null,
      currentAssignment: null,
      activeAttempt: null,
    }],
  });
  const result = await previewAssignments(
    request({ serviceDate, previewSeed: "overdue" }),
    mock.client,
    admin,
  );
  assert(
    result.proposedAssignments.length === 1 &&
      result.proposedAssignments[0].cleaningTargetId === "overdue" &&
      result.proposedAssignments[0].dueAt === dueAt &&
      result.proposedAssignments[0].availableFrom === availableFrom &&
      result.blockedTargets.length === 0,
    "elapsed deadline is not a scheduling rejection",
  );
  assert(
    mock.calls.length === 1 &&
      mock.calls[0].name === "get_assignment_preview_snapshot",
    "only the readonly snapshot RPC is called",
  );
});

Deno.test("preview enforces business admin and password gate", async () => {
  const mock = clients();
  for (const role of ["maid", "developer"] as const) {
    await failure(
      () =>
        previewAssignments(request({ serviceDate: today() }), mock.client, {
          ...admin,
          role,
        }),
      "ADMIN_REQUIRED",
    );
  }
  await failure(
    () =>
      previewAssignments(request({ serviceDate: today() }), mock.client, {
        ...admin,
        mustChangePassword: true,
      }),
    "PASSWORD_CHANGE_REQUIRED",
  );
  assert(mock.calls.length === 0, "role denied before RPC");
});

Deno.test("preview needs no duration policy; limits are stable and raw failures redact", async () => {
  const absent = clients(null, {
    serviceDate: today(),
    planningAt: new Date().toISOString(),
    durationPolicy: null,
    durationPolicyStatus: "retired",
    durationPolicyRequired: false,
    maids: [],
    targets: [],
  });
  const result = await previewAssignments(
    request({ serviceDate: today() }),
    absent.client,
    admin,
  );
  assert(
    result.decisionReady && result.durationPolicy === null &&
      result.durationPolicyStatus === "retired",
    "retired policy must not block preview",
  );
  for (
    const code of [
      "ASSIGNMENT_PREVIEW_LIMIT_EXCEEDED",
      "PROFILE_INACTIVE",
      "ACTIVE_ACCOUNT_REQUIRED",
    ]
  ) {
    const mock = clients(code);
    await failure(
      () =>
        previewAssignments(
          request({ serviceDate: today() }),
          mock.client,
          admin,
        ),
      code,
    );
    assert(
      mock.calls.length === 1 &&
        mock.calls[0].name === "get_assignment_preview_snapshot",
      "only read snapshot invoked",
    );
    assert(!("p_idempotency_key" in mock.calls[0].args), "no preview receipt");
  }
  const error = previewDatabaseError({
    message: "database contains token secret phone raw query",
  });
  assert(
    error.status === 500 && error.code === "ASSIGNMENT_PREVIEW_FAILED" &&
      !error.message.includes("token"),
    "redacted failure",
  );
});

Deno.test("historical duration config is read-only and confirmation is retired", async () => {
  const data = {
    id: admin.profileId,
    version: 1,
    status: "confirmed",
    standardMinutes: 30,
    premiumMinutes: 40,
    oceanPremiumMinutes: 50,
    oceanFamilyMinutes: 60,
    createdAt: "2030-01-01T00:00:00Z",
    confirmedAt: "2030-01-01T00:00:00Z",
    rawSecret: "hidden",
  };
  const mock = clients(null, data);
  const body = {
    expectedVersion: 0,
    standardMinutes: 30,
    premiumMinutes: 40,
    oceanPremiumMinutes: 50,
    oceanFamilyMinutes: 60,
  };
  await failure(
    () => assignmentDurationPolicy(request(body), mock.client, admin),
    "ASSIGNMENT_DURATION_POLICY_RETIRED",
  );
  assert(mock.calls.length === 0, "retired mutation must not call RPC");
  const readMock = clients(null, data);
  assert(
    await assignmentDurationPolicy(
      request(null, "GET"),
      readMock.client,
      admin,
    ) !== null,
    "historical GET remains available",
  );
  assert(
    readMock.calls.length === 1 &&
      readMock.calls[0].name === "get_assignment_duration_policy",
    "historical GET is read-only",
  );
});
