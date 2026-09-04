import {
  assignmentCommitImpact,
  assignmentDatabaseError,
  assignmentHistory,
  assignmentTargetIdFromPath,
  commitAssignments,
  listAssignmentChangeRequests,
  listAssignments,
  prestartCommand,
  prestartDatabaseError,
  prestartPath,
  saveAssignmentDraft,
} from "./assignment-api.ts";
import type { EdgeActor, EdgeClients } from "./runtime.ts";
import { EdgeError } from "./runtime.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function captureEdgeError(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    if (error instanceof EdgeError) return error;
    throw error;
  }
  throw new Error("Expected EdgeError");
}

const maid: EdgeActor = {
  authUserId: "10000000-0000-4000-8000-000000000001",
  profileId: "20000000-0000-4000-8000-000000000001",
  displayName: "메이드",
  role: "maid",
  mustChangePassword: false,
};
const otherMaid: EdgeActor = {
  ...maid,
  profileId: "20000000-0000-4000-8000-000000000002",
};
const admin: EdgeActor = {
  ...maid,
  profileId: "20000000-0000-4000-8000-000000000003",
  role: "admin",
};
const developer: EdgeActor = {
  ...maid,
  profileId: "20000000-0000-4000-8000-000000000004",
  role: "developer",
};
const targetId = "30000000-0000-4000-8000-000000000001";
const assignmentId = "40000000-0000-4000-8000-000000000001";
const roomId = "50000000-0000-4000-8000-000000000001";

function prestartClients(errorMessage?: string) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const clients = {
    admin: {
      rpc: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        if (errorMessage) {
          return {
            data: null,
            error: { message: errorMessage },
          };
        }
        const requestRow = {
          requestId: assignmentId,
          cleaningTargetId: targetId,
          assignmentId,
          maidProfileId: maid.profileId,
          requestType: "cancel_assignment",
          reasonCode: "PERSONAL_REASON",
          reasonDetail: null,
          status: "pending",
          sourceAssignmentRevision: 2,
          sourceTargetAssignmentVersion: 2,
          requestedAt: "2026-09-05T00:00:00Z",
          decision: null,
          decisionReasonCode: null,
          decidedAt: null,
          requestHash: "hidden",
          after_state: { secret: "hidden" },
        };
        if (name === "list_assignment_change_requests") {
          return {
            data: [requestRow],
            error: null,
          };
        }
        if (name.includes("cancellation")) {
          return {
            data: requestRow,
            error: null,
          };
        }
        return {
          data: {
            assignmentId,
            cleaningTargetId: targetId,
            roomId,
            roomNumber: "101",
            maidProfileId: maid.profileId,
            maidDisplayName: "메이드",
            serviceDate: "2026-09-05",
            sequenceNumber: 3,
            revision: 3,
            isCurrent: name.includes("change_"),
            targetAssignmentVersion: 3,
            availableFrom: null,
            dueAt: null,
            notifiedAt: null,
            endedAt: null,
            createdAt: "2026-09-05T00:00:00Z",
            raw: "hidden",
          },
          error: null,
        };
      },
    },
  } as unknown as EdgeClients;
  return { clients, calls };
}
const prestartBody = {
  expectedCurrentAssignmentId: assignmentId,
  expectedAssignmentVersion: 2,
  reasonCode: "OPERATIONAL_CHANGE",
};

Deno.test("prestart commands preserve actor CAS canonical retry and safe projections", async () => {
  const { clients, calls } = prestartClients();
  for (
    const action of [
      "change",
      "unassign",
      "cancellation-requests",
      "decision",
    ] as const
  ) {
    const body = {
      ...prestartBody,
      ...(action === "change"
        ? { maidProfileId: maid.profileId, sequenceNumber: 3 }
        : {}),
      ...(action === "decision" ? { decision: "approved" } : {}),
    };
    const result = await prestartCommand(
      request("/test", "POST", body),
      clients,
      action === "cancellation-requests" ? maid : admin,
      targetId,
      action,
    );
    assert(
      !JSON.stringify(result).includes("hidden"),
      "projection excludes extra raw fields",
    );
    assert(
      calls.at(-1)?.args.p_actor_profile_id ===
        (action === "cancellation-requests" ? maid.profileId : admin.profileId),
      "verified actor",
    );
    assert(calls.at(-1)?.args.p_expected_assignment_version === 2, "CAS");
    await prestartCommand(
      request("/test", "POST", body),
      clients,
      action === "cancellation-requests" ? maid : admin,
      targetId,
      action,
    );
    assert(
      calls.at(-1)?.args.p_request_hash === calls.at(-2)?.args.p_request_hash,
      "canonical retry",
    );
  }
});

Deno.test("prestart admin and maid capabilities fail closed before RPC", async () => {
  const { clients, calls } = prestartClients();
  for (const action of ["change", "unassign", "decision"] as const) {
    for (const actor of [maid, developer]) {
      const error = await captureEdgeError(() =>
        prestartCommand(
          request("/test", "POST", prestartBody),
          clients,
          actor,
          targetId,
          action,
        )
      );
      assert(error.code === "ADMIN_REQUIRED", "business admin only");
    }
  }
  for (const actor of [admin, developer]) {
    const error = await captureEdgeError(() =>
      prestartCommand(
        request("/test", "POST", prestartBody),
        clients,
        actor,
        targetId,
        "cancellation-requests",
      )
    );
    assert(error.code === "MAID_REQUIRED", "maid only");
  }
  const error = await captureEdgeError(() =>
    prestartCommand(
      request("/test", "POST", prestartBody),
      clients,
      { ...admin, mustChangePassword: true },
      targetId,
      "unassign",
    )
  );
  assert(
    error.code === "PASSWORD_CHANGE_REQUIRED" && calls.length === 0,
    "no mutation before authorization",
  );
});

Deno.test("prestart input and idempotency validation rejects malformed or extra data", async () => {
  const { clients, calls } = prestartClients();
  const body = {
    ...prestartBody,
    maidProfileId: maid.profileId,
    sequenceNumber: 1,
  };
  for (
    const extra of [
      { expectedCurrentAssignmentId: "invalid" },
      { expectedAssignmentVersion: 0 },
      { sequenceNumber: 0 },
      { reasonCode: "raw reason" },
      { secret: "raw" },
      { availableFrom: "invalid" },
    ]
  ) {
    const error = await captureEdgeError(() =>
      prestartCommand(
        request("/test", "POST", { ...body, ...extra }),
        clients,
        admin,
        targetId,
        "change",
      )
    );
    assert(error.status === 400, "invalid input");
  }
  for (const key of ["", "short", "not a valid key"]) {
    const error = await captureEdgeError(() =>
      prestartCommand(
        request("/test", "POST", body, key),
        clients,
        admin,
        targetId,
        "change",
      )
    );
    assert(error.status === 400, "invalid idempotency key");
  }
  const decision = await captureEdgeError(() =>
    prestartCommand(
      request("/test", "POST", { ...prestartBody, decision: "maybe" }),
      clients,
      admin,
      targetId,
      "decision",
    )
  );
  assert(
    decision.status === 400 && calls.length === 0,
    "decision invalid before RPC",
  );
});

Deno.test("cancellation detail rejects overlong and sensitive-shaped text", async () => {
  const { clients, calls } = prestartClients();
  for (
    const reasonDetail of [
      " ",
      "가".repeat(201),
      "01012345678",
      "PIN 1234",
      "test@example.invalid",
      "https://secret.invalid",
    ]
  ) {
    const error = await captureEdgeError(() =>
      prestartCommand(
        request("/test", "POST", { ...prestartBody, reasonDetail }),
        clients,
        maid,
        targetId,
        "cancellation-requests",
      )
    );
    assert(error.status === 400, "unsafe detail rejected");
  }
  assert(calls.length === 0, "no RPC for unsafe input");
});

Deno.test("prestart list enforces maid self scope pagination and bounds", async () => {
  const { clients, calls } = prestartClients();
  const page = await listAssignmentChangeRequests(
    request("/v1/assignment-change-requests?limit=1"),
    clients,
    maid,
  );
  assert(page.requests.length === 1 && !!page.nextCursor, "cursor returned");
  assert(
    calls[0].args.p_maid_profile_id === maid.profileId,
    "server self filter",
  );
  await listAssignmentChangeRequests(
    request(
      `/v1/assignment-change-requests?cursor=${
        encodeURIComponent(page.nextCursor ?? "")
      }`,
    ),
    clients,
    admin,
  );
  assert(calls[1].args.p_before_id === assignmentId, "cursor identity");
  const microseconds = "2026-09-05T01:00:00.123456+00:00";
  await listAssignmentChangeRequests(
    request(
      "/v1/assignment-change-requests?cursor=" +
        encodeURIComponent(
          btoa(JSON.stringify({ at: microseconds, id: assignmentId })),
        ),
    ),
    clients,
    admin,
  );
  assert(
    calls[2].args.p_before_at === microseconds,
    "cursor preserves DB microseconds",
  );
  for (
    const query of [
      "limit=101",
      "limit=0",
      "status=raw",
      "from=2026-01-01T00:00:00Z&to=2026-03-01T00:00:00Z",
      "cursor=raw",
      "extra=raw",
    ]
  ) {
    const error = await captureEdgeError(() =>
      listAssignmentChangeRequests(
        request(`/v1/assignment-change-requests?${query}`),
        clients,
        admin,
      )
    );
    assert(error.status === 400, "bounded query validation");
  }
  const denied = await captureEdgeError(() =>
    listAssignmentChangeRequests(
      request(
        `/v1/assignment-change-requests?maidProfileId=${otherMaid.profileId}`,
      ),
      clients,
      maid,
    )
  );
  assert(denied.status === 403, "other maid filter denied");
  const dev = await captureEdgeError(() =>
    listAssignmentChangeRequests(
      request("/v1/assignment-change-requests"),
      clients,
      developer,
    )
  );
  assert(dev.status === 403, "developer list denied");
});

Deno.test("prestart exact routes and stable DB errors", async () => {
  assert(
    prestartPath(`/v1/assignments/${targetId}/change`)?.action === "change",
    "exact route",
  );
  assert(
    prestartPath(`/v1/assignments/${targetId}/change/extra`) === null,
    "no suffix alias",
  );
  assert(
    prestartPath(`/v1/assignment-change-requests/${assignmentId}/decision`)
      ?.id === assignmentId,
    "decision identity",
  );
  const { clients } = prestartClients(
    "ASSIGNMENT_CHANGE_REQUEST_ACCESS_REQUIRED",
  );
  const error = await captureEdgeError(() =>
    prestartCommand(
      request("/test", "POST", prestartBody),
      clients,
      maid,
      targetId,
      "cancellation-requests",
    )
  );
  assert(error.status === 403, "DB ownership denial");
  const unknown = prestartDatabaseError({ message: "raw SQL phone secret" });
  assert(
    unknown.status === 500 && !unknown.message.includes("raw SQL"),
    "raw SQL redacted",
  );
});

function request(
  path: string,
  method = "GET",
  body?: Record<string, unknown>,
  key = "assignment-test-0001",
) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function queryResult(data: unknown) {
  const filters: Array<[string, unknown]> = [];
  type Query = Promise<{ data: unknown; error: null }> & {
    select: () => Query;
    eq: (column: string, value: unknown) => Query;
    in: (column: string, value: unknown[]) => Query;
    order: () => Query;
  };
  let query: Query;
  query = Object.assign(Promise.resolve({ data, error: null }), {
    select: () => query,
    eq: (column: string, value: unknown) => {
      filters.push([column, value]);
      return query;
    },
    in: (column: string, value: unknown[]) => {
      filters.push([column, value]);
      return query;
    },
    order: () => query,
  }) as Query;
  return { query, filters };
}

function assignmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: assignmentId,
    cleaning_target_id: targetId,
    maid_profile_id: maid.profileId,
    service_date: "2026-09-04",
    sequence_number: 1,
    revision: 2,
    is_current: true,
    available_from_snapshot: "2026-09-04T01:00:00Z",
    due_at_snapshot: "2026-09-04T06:00:00Z",
    notified_at: null,
    ended_at: null,
    created_at: "2026-09-03T10:00:00Z",
    ...overrides,
  };
}

function readClients(rows: unknown[]) {
  const access = queryResult(rows);
  const targets = queryResult([
    {
      id: targetId,
      room_id: roomId,
      assignment_version: 2,
      rooms: { room_number: "101" },
    },
  ]);
  const maids = queryResult([
    { id: maid.profileId, display_name: "메이드" },
  ]);
  const clients = {
    forAccessToken: () => ({ from: () => access.query }),
    admin: {
      from(table: string) {
        return table === "cleaning_targets" ? targets.query : maids.query;
      },
    },
  } as unknown as EdgeClients;
  return { clients, access };
}

Deno.test("assignment path accepts only exact UUID history route", () => {
  assert(
    assignmentTargetIdFromPath(`/v1/assignments/${targetId}/history`) ===
      targetId,
    "exact history route",
  );
  assert(
    assignmentTargetIdFromPath(`/v1/assignments/${targetId}`) === null,
    "detail alias forbidden",
  );
});

Deno.test("assignment database errors are stable and redact unknown SQL", () => {
  assert(
    assignmentDatabaseError({ message: "ASSIGNMENT_VERSION_CONFLICT" }).code ===
      "ASSIGNMENT_VERSION_CONFLICT",
    "CAS mapping",
  );
  assert(
    assignmentDatabaseError({
      message: "cleaning_assignments_current_maid_date_sequence",
    }).code === "ASSIGNMENT_SEQUENCE_CONFLICT",
    "sequence mapping",
  );
  assert(
    assignmentDatabaseError({ message: "raw database detail" }).code ===
      "ASSIGNMENT_COMMAND_FAILED",
    "unknown SQL must be redacted",
  );
});

Deno.test("admin and maid read assignment lists through scoped RLS", async () => {
  for (const actor of [admin, maid]) {
    const { clients, access } = readClients([assignmentRow()]);
    const result = await listAssignments(
      request("/v1/assignments?serviceDate=2026-09-04"),
      clients,
      actor,
    );
    assert(result.length === 1 && result[0].roomNumber === "101", "projection");
    if (actor.role === "maid") {
      assert(
        access.filters.some(([column, value]) =>
          column === "maid_profile_id" && value === maid.profileId
        ),
        "maid self filter",
      );
    }
  }
});

Deno.test("maid history is self-only and cross-maid reads fail before query", async () => {
  const { clients, access } = readClients([assignmentRow()]);
  const history = await assignmentHistory(
    request(`/v1/assignments/${targetId}/history`),
    clients,
    maid,
    targetId,
  );
  assert(history.length === 1, "own history");
  assert(
    access.filters.some(([column, value]) =>
      column === "maid_profile_id" && value === maid.profileId
    ),
    "history self filter",
  );

  const cross = await captureEdgeError(() =>
    listAssignments(
      request(
        `/v1/assignments?serviceDate=2026-09-04&maidProfileId=${otherMaid.profileId}`,
      ),
      {} as EdgeClients,
      maid,
    )
  );
  assert(cross.code === "ASSIGNMENT_ACCESS_REQUIRED", "cross-maid blocked");
});

Deno.test("developer assignment reads and non-admin draft writes are denied", async () => {
  const developerRead = await captureEdgeError(() =>
    listAssignments(
      request("/v1/assignments?serviceDate=2026-09-04"),
      {} as EdgeClients,
      developer,
    )
  );
  assert(developerRead.code === "ASSIGNMENT_ACCESS_REQUIRED", "developer read");

  for (const actor of [maid, developer]) {
    const denied = await captureEdgeError(() =>
      saveAssignmentDraft(
        request("/v1/assignments/drafts", "POST", {
          cleaningTargetId: targetId,
          maidProfileId: maid.profileId,
          sequenceNumber: 1,
          expectedAssignmentVersion: 1,
        }),
        {} as EdgeClients,
        actor,
      )
    );
    assert(denied.code === "ADMIN_REQUIRED", `${actor.role} write denied`);
  }
});

Deno.test("admin draft save sends actor-bound CAS and request hash", async () => {
  let rpcName = "";
  let args: Record<string, unknown> = {};
  const result = assignmentRow({
    assignmentId,
    cleaningTargetId: targetId,
    roomId,
    roomNumber: "101",
    maidProfileId: maid.profileId,
    maidDisplayName: "메이드",
    serviceDate: "2026-09-04",
    sequenceNumber: 1,
    revision: 2,
    isCurrent: true,
    targetAssignmentVersion: 2,
    availableFrom: "2026-09-04T01:00:00Z",
    dueAt: "2026-09-04T06:00:00Z",
    notifiedAt: null,
    endedAt: null,
    createdAt: "2026-09-03T10:00:00Z",
  });
  const clients = {
    admin: {
      async rpc(name: string, value: Record<string, unknown>) {
        rpcName = name;
        args = value;
        return { data: result, error: null };
      },
    },
  } as unknown as EdgeClients;
  const saved = await saveAssignmentDraft(
    request("/v1/assignments/drafts", "POST", {
      cleaningTargetId: targetId,
      maidProfileId: maid.profileId,
      sequenceNumber: 1,
      expectedAssignmentVersion: 1,
    }),
    clients,
    admin,
  );
  assert(rpcName === "save_cleaning_assignment_draft", "RPC name");
  assert(args.p_actor_profile_id === admin.profileId, "actor-bound RPC");
  assert(args.p_expected_assignment_version === 1, "CAS forwarded");
  assert(/^[0-9a-f]{64}$/.test(String(args.p_request_hash)), "request hash");
  assert(saved.assignmentId === assignmentId, "response allowlist");
});

Deno.test("assignment validation rejects malformed query and draft input", async () => {
  const cases = [
    request("/v1/assignments?serviceDate=2026-02-30"),
    request("/v1/assignments?serviceDate=2026-09-04&includeHistory=yes"),
    request("/v1/assignments?serviceDate=2026-09-04&maidProfileId=bad"),
  ];
  for (const candidate of cases) {
    const error = await captureEdgeError(() =>
      listAssignments(candidate, {} as EdgeClients, admin)
    );
    assert(error.code === "VALIDATION_ERROR", "invalid query");
  }

  const bodies = [
    {
      cleaningTargetId: "bad",
      maidProfileId: maid.profileId,
      sequenceNumber: 1,
      expectedAssignmentVersion: 1,
    },
    {
      cleaningTargetId: targetId,
      maidProfileId: maid.profileId,
      sequenceNumber: 0,
      expectedAssignmentVersion: 1,
    },
    {
      cleaningTargetId: targetId,
      maidProfileId: maid.profileId,
      sequenceNumber: 1,
      expectedAssignmentVersion: 0,
    },
    {
      cleaningTargetId: targetId,
      maidProfileId: maid.profileId,
      sequenceNumber: 1,
      expectedAssignmentVersion: 1,
      extra: true,
    },
  ];
  for (const body of bodies) {
    const error = await captureEdgeError(() =>
      saveAssignmentDraft(
        request("/v1/assignments/drafts", "POST", body),
        {} as EdgeClients,
        admin,
      )
    );
    assert(error.code === "VALIDATION_ERROR", "invalid draft body");
  }
  for (const key of ["", "short key"]) {
    const error = await captureEdgeError(() =>
      saveAssignmentDraft(
        request(
          "/v1/assignments/drafts",
          "POST",
          {
            cleaningTargetId: targetId,
            maidProfileId: maid.profileId,
            sequenceNumber: 1,
            expectedAssignmentVersion: 1,
          },
          key,
        ),
        {} as EdgeClients,
        admin,
      )
    );
    assert(error.code === "VALIDATION_ERROR", "invalid idempotency key");
  }
});

function commitCandidate(overrides: Record<string, unknown> = {}) {
  return {
    assignmentId,
    cleaningTargetId: targetId,
    roomId,
    roomNumber: "101",
    maidProfileId: maid.profileId,
    maidDisplayName: "메이드",
    serviceDate: "2026-09-04",
    sequenceNumber: 1,
    revision: 2,
    targetAssignmentVersion: 2,
    expectedAvailabilityVersion: 3,
    availableFrom: "2026-09-04T01:00:00Z",
    dueAt: "2026-09-04T06:00:00Z",
    ...overrides,
  };
}

const fingerprint = "a".repeat(64);

Deno.test("assignment commit preflight is admin-only and projects safe impact", async () => {
  for (const actor of [maid, developer]) {
    const denied = await captureEdgeError(() =>
      assignmentCommitImpact(
        request("/v1/assignments/commit-impact?serviceDate=2026-09-04"),
        {} as EdgeClients,
        actor,
      )
    );
    assert(denied.code === "ADMIN_REQUIRED", `${actor.role} preflight denied`);
  }

  let args: Record<string, unknown> = {};
  const clients = {
    admin: {
      async rpc(name: string, value: Record<string, unknown>) {
        assert(name === "get_assignment_commit_impact", "preflight RPC");
        args = value;
        return {
          data: {
            serviceDate: "2026-09-04",
            impactFingerprint: fingerprint,
            committableDrafts: [commitCandidate()],
            blockedDrafts: [],
            remainingUnassignedTargets: [],
            requestHash: "must-not-leak",
          },
          error: null,
        };
      },
    },
  } as unknown as EdgeClients;
  const impact = await assignmentCommitImpact(
    request("/v1/assignments/commit-impact?serviceDate=2026-09-04"),
    clients,
    admin,
  );
  assert(args.p_actor_profile_id === admin.profileId, "actor bound");
  assert(impact.committableDrafts.length === 1, "candidate projected");
  assert(!("requestHash" in impact), "unknown fields omitted");
});

Deno.test("assignment partial commit forwards scoped idempotency and allowlists response", async () => {
  let rpcName = "";
  let args: Record<string, unknown> = {};
  const clients = {
    admin: {
      async rpc(name: string, value: Record<string, unknown>) {
        rpcName = name;
        args = value;
        return {
          data: {
            serviceDate: "2026-09-04",
            impactFingerprint: fingerprint,
            notifiedAssignments: [
              commitCandidate({
                notifiedAt: "2026-09-03T12:00:00Z",
              }),
            ],
            remainingDrafts: [
              commitCandidate({
                assignmentId: "40000000-0000-4000-8000-000000000002",
              }),
            ],
            blockedDrafts: [],
            unassignedTargets: [],
            requestHash: "must-not-leak",
          },
          error: null,
        };
      },
    },
  } as unknown as EdgeClients;
  const result = await commitAssignments(
    request("/v1/assignments/commit", "POST", {
      serviceDate: "2026-09-04",
      expectedImpactFingerprint: fingerprint,
      items: [{
        cleaningTargetId: targetId,
        expectedAssignmentVersion: 2,
        expectedAvailabilityVersion: 3,
      }],
    }),
    clients,
    admin,
  );
  assert(rpcName === "commit_and_notify_assignments", "commit RPC");
  assert(args.p_actor_profile_id === admin.profileId, "actor bound");
  assert(args.p_expected_impact_fingerprint === fingerprint, "fingerprint");
  assert(/^[0-9a-f]{64}$/.test(String(args.p_request_hash)), "request hash");
  assert(result.notifiedAssignments.length === 1, "notified projection");
  assert(result.remainingDrafts.length === 1, "partial remainder");
  assert(!("requestHash" in result), "unknown fields omitted");
});

Deno.test("assignment commit rejects non-admin and malformed payloads before RPC", async () => {
  const validBody = {
    serviceDate: "2026-09-04",
    expectedImpactFingerprint: fingerprint,
    items: [{
      cleaningTargetId: targetId,
      expectedAssignmentVersion: 2,
      expectedAvailabilityVersion: 3,
    }],
  };
  for (const actor of [maid, developer]) {
    const denied = await captureEdgeError(() =>
      commitAssignments(
        request("/v1/assignments/commit", "POST", validBody),
        {} as EdgeClients,
        actor,
      )
    );
    assert(denied.code === "ADMIN_REQUIRED", `${actor.role} commit denied`);
  }
  const invalidBodies = [
    { ...validBody, expectedImpactFingerprint: "bad" },
    { ...validBody, items: [] },
    { ...validBody, items: [...validBody.items, ...validBody.items] },
    { ...validBody, extra: true },
    {
      ...validBody,
      items: [{ ...validBody.items[0], expectedAvailabilityVersion: 0 }],
    },
  ];
  for (const body of invalidBodies) {
    const denied = await captureEdgeError(() =>
      commitAssignments(
        request("/v1/assignments/commit", "POST", body),
        {} as EdgeClients,
        admin,
      )
    );
    assert(denied.code === "VALIDATION_ERROR", "malformed commit denied");
  }
});

Deno.test("assignment commit database failures use stable redacted codes", () => {
  for (
    const code of [
      "ASSIGNMENT_IMPACT_CHANGED",
      "ASSIGNMENT_DRAFT_STALE_SCHEDULE",
      "ASSIGNMENT_AVAILABILITY_REQUIRED",
      "ASSIGNMENT_AVAILABILITY_STALE",
      "ASSIGNMENT_MAID_UNAVAILABLE",
      "ASSIGNMENT_WINDOW_EXPIRED",
      "ASSIGNMENT_COMMIT_NOT_ALLOWED",
    ]
  ) {
    assert(assignmentDatabaseError({ message: code }).code === code, code);
  }
});
