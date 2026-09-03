import {
  assignmentDatabaseError,
  assignmentHistory,
  assignmentTargetIdFromPath,
  listAssignments,
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
