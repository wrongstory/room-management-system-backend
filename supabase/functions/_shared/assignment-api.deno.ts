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
import { parseAssignmentScheduleReads } from "./assignment-schedule-core.ts";

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
        if (name === "cancel_unavailable_cleaning_assignment") {
          return {
            data: {
              cancellationId: "60000000-0000-4000-8000-000000000001",
              cleaningTargetId: targetId,
              assignmentId,
              attemptId: "70000000-0000-4000-8000-000000000001",
              maidProfileId: maid.profileId,
              reasonCode: "MAID_INJURED",
              replacementTargetId: null,
              status: "unassigned",
              targetAssignmentVersion: 3,
              effectiveAt: "2026-09-05T00:00:00Z",
              recordedAt: "2026-09-05T00:00:01Z",
              raw: "hidden",
            },
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

Deno.test("admin unavailable cancellation binds live session and nullable attempt CAS", async () => {
  const { clients, calls } = prestartClients();
  const sessionId = "80000000-0000-4000-8000-000000000001";
  const attemptId = "70000000-0000-4000-8000-000000000001";
  const result = await prestartCommand(
    request("/test", "POST", {
      expectedCurrentAssignmentId: assignmentId,
      expectedAssignmentVersion: 2,
      expectedAttemptId: attemptId,
      expectedExecutionVersion: 4,
      reasonCode: "MAID_INJURED",
    }),
    clients,
    admin,
    targetId,
    "unavailable-cancel",
    sessionId,
  );
  const safeResult = result as { status?: string };
  assert(
    safeResult.status === "unassigned" &&
      !JSON.stringify(result).includes("hidden"),
    "safe unavailable cancellation projection",
  );
  assert(
    calls.at(-1)?.name === "cancel_unavailable_cleaning_assignment",
    "unavailable cancellation RPC",
  );
  assert(calls.at(-1)?.args.p_session_id === sessionId, "live session binding");
  assert(
    calls.at(-1)?.args.p_expected_assignment_id === assignmentId,
    "assignment CAS",
  );
  assert(
    calls.at(-1)?.args.p_expected_attempt_id === attemptId,
    "attempt CAS",
  );
  assert(
    calls.at(-1)?.args.p_expected_execution_version === 4,
    "execution CAS",
  );

  await prestartCommand(
    request("/test", "POST", {
      expectedCurrentAssignmentId: assignmentId,
      expectedAssignmentVersion: 2,
      expectedAttemptId: null,
      expectedExecutionVersion: null,
      reasonCode: "MAID_UNAVAILABLE",
    }),
    clients,
    admin,
    targetId,
    "unavailable-cancel",
    sessionId,
  );
  assert(
    calls.at(-1)?.args.p_expected_attempt_id === null,
    "no-attempt identity",
  );
  assert(
    calls.at(-1)?.args.p_expected_execution_version === null,
    "no-attempt version",
  );
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
      authorization: "Bearer unit." +
        btoa(
          JSON.stringify({
            session_id: "90000000-0000-4000-8000-000000000001",
          }),
        ) + ".unit",
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function queryResult(data: unknown, countOverride?: number | null) {
  const filters: Array<[string, unknown]> = [];
  type Query = Promise<{ data: unknown; error: null; count: number | null }> & {
    select: (columns: string) => Query;
    eq: (column: string, value: unknown) => Query;
    not: (column: string, operator: string, value: unknown) => Query;
    in: (column: string, value: unknown[]) => Query;
    order: () => Query;
    lt: (column: string, value: unknown) => Query;
    limit: (value: number) => Query;
  };
  let query: Query;
  query = Object.assign(
    Promise.resolve({
      data,
      error: null,
      count: countOverride === undefined
        ? (Array.isArray(data) ? data.length : 0)
        : countOverride,
    }),
    {
      select: (columns: string) => {
        filters.push(["select", columns]);
        return query;
      },
      eq: (column: string, value: unknown) => {
        filters.push([column, value]);
        return query;
      },
      not: (column: string, operator: string, value: unknown) => {
        filters.push([`not.${column}.${operator}`, value]);
        return query;
      },
      in: (column: string, value: unknown[]) => {
        filters.push([column, value]);
        return query;
      },
      order: () => query,
      lt: (column: string, value: unknown) => {
        filters.push([`lt.${column}`, value]);
        return query;
      },
      limit: (value: number) => {
        filters.push(["limit", value]);
        return query;
      },
    },
  ) as Query;
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
    notified_at: "2026-09-03T12:00:00Z",
    notified_room_id_snapshot: roomId,
    notified_room_number_snapshot: "101",
    ended_at: null,
    created_at: "2026-09-03T10:00:00Z",
    ...overrides,
  };
}

function readClients(
  rows: unknown[],
  options: {
    target?: Record<string, unknown>;
    schedules?: Record<string, unknown>[];
    overdue?: unknown[];
    count?: number | null;
    attemptCount?: number | null;
    attempts?: Record<string, unknown>[];
    scheduleRead?: (
      args: Record<string, unknown>,
    ) => { data: unknown; error: { message: string } | null };
  } = {},
) {
  const access = queryResult(rows, options.count);
  const overdue = queryResult(options.overdue ?? []);
  let accessReads = 0;
  const targets = queryResult([
    {
      id: targetId,
      room_id: roomId,
      cleaning_kind: "checkout",
      source: "scheduled_checkout",
      original_service_date: "2026-09-03",
      effective_service_date: "2026-09-04",
      carryover_count: 4,
      status: "notified",
      assignment_version: 999,
      room_type_snapshot: {
        code: "standard",
        name: "스탠다드 더블 로프트",
        elevatorZone: "A",
      },
      fee_snapshot: 16000,
      template_snapshot: { durationMinutes: null },
      rooms: { room_number: "101" },
      ...options.target,
    },
  ]);
  const maids = queryResult([
    { id: maid.profileId, display_name: "메이드" },
  ]);
  const attempts = queryResult(
    options.attempts ?? [{
      id: "60000000-0000-4000-8000-000000000001",
      assignment_id: assignmentId,
      attempt_number: 1,
      status: "field_completed",
    }],
    options.attemptCount,
  );
  const submissions = queryResult([{
    cleaning_attempt_id: "60000000-0000-4000-8000-000000000001",
    version: 1,
    status: "submitted",
  }]);
  const schedules = queryResult(
    options.schedules ?? [{
      cleaning_target_id: targetId,
      revision: 2,
      effective_service_date: "2026-09-04",
      reason_code: "ROLLED_OVER_NOT_STARTED",
    }],
  );
  const clients = {
    forAccessToken: () => ({
      from: () =>
        ++accessReads > 1 && options.overdue !== undefined
          ? overdue.query
          : access.query,
    }),
    admin: {
      rpc: async (name: string, args: Record<string, unknown>) => {
        assert(name === "get_assignment_schedule_read", "exact read-only RPC");
        assert(
          args.p_expected_actor_role === "admin" ||
            args.p_expected_actor_role === "maid",
          "bind initial adapter role to latest DB role",
        );
        assert(
          args.p_session_id === "90000000-0000-4000-8000-000000000001",
          "verified live session",
        );
        return options.scheduleRead?.(args) ?? {
          data: (args.p_assignment_ids as string[]).map((assignmentId) => ({
            assignmentId,
            scheduleSnapshot: null,
            currentDeparture: null,
          })),
          error: null,
        };
      },
      from(table: string) {
        if (table === "cleaning_targets") return targets.query;
        if (table === "cleaning_attempts") return attempts.query;
        if (table === "cleaning_submissions") return submissions.query;
        if (table === "cleaning_target_schedule_revisions") {
          return schedules.query;
        }
        return maids.query;
      },
    },
  } as unknown as EdgeClients;
  return {
    clients,
    access,
    overdue,
    targets,
    maids,
    attempts,
    submissions,
    schedules,
  };
}

Deno.test("today current list includes old unfinished with immutable snapshots and scoped bounded queries", async () => {
  const pastId = "70000000-0000-4000-8000-000000000010";
  const { clients, access, overdue } = readClients([
    assignmentRow({ service_date: "2026-09-05" }),
  ], {
    overdue: [
      assignmentRow({ id: pastId }),
      assignmentRow({ maid_profile_id: otherMaid.profileId }),
      assignmentRow({ notified_at: null }),
    ],
  });
  let clockReads = 0;
  const result = await listAssignments(
    request("/v1/assignments?serviceDate=2026-09-05"),
    clients,
    maid,
    () => {
      clockReads++;
      return new Date("2026-09-04T15:00:00Z");
    },
  );
  assert(clockReads === 1, "single KST clock snapshot");
  assert(
    result.length === 2 && result[0].assignmentId === pastId &&
      result[0].serviceDate === "2026-09-04",
    "original day retained and own notified only",
  );
  assert(
    result[0].roomNumber === "101" && result[0].targetAssignmentVersion === 2,
    "maid immutable notification projection",
  );
  assert(
    overdue.filters.some(([key, value]) =>
      key === "lt.service_date" && value === "2026-09-05"
    ),
    "past date DB predicate",
  );
  assert(
    overdue.filters.some(([key, value]) =>
      key === "not.cleaning_targets.status.in" &&
      value === "(approved,cancelled)"
    ),
    "terminal past excluded in DB before max-row limit",
  );
  assert(
    overdue.filters.some(([key, value]) =>
      key === "select" &&
      String(value).includes("cleaning_targets!inner(status)")
    ),
    "user RLS inner target join",
  );
  for (const scoped of [access, overdue]) {
    assert(
      scoped.filters.some(([key, value]) =>
        key === "maid_profile_id" && value === maid.profileId
      ),
      "self DB scope on both reads",
    );
    assert(
      scoped.filters.some(([key]) => key === "not.notified_at.is"),
      "notified DB scope on both reads",
    );
    assert(
      scoped.filters.some(([key, value]) => key === "limit" && value === 1000),
      "technical cap",
    );
  }
});

Deno.test("tomorrow history and pre-KST-midnight reads never expand to past dates", async () => {
  for (
    const [path, instant] of [
      ["/v1/assignments?serviceDate=2026-09-05", "2026-09-04T14:59:59.999Z"],
      ["/v1/assignments?serviceDate=2026-09-06", "2026-09-04T15:00:00Z"],
      [
        "/v1/assignments?serviceDate=2026-09-05&includeHistory=true",
        "2026-09-04T15:00:00Z",
      ],
    ]
  ) {
    const { clients, overdue } = readClients([assignmentRow()], {
      overdue: [assignmentRow()],
    });
    assert(
      (await listAssignments(
        request(path),
        clients,
        admin,
        () => new Date(instant),
      )).length === 1,
      "exact date response only",
    );
    assert(
      overdue.filters.length === 0,
      "no overdue lookup for exact date/history",
    );
  }
});

Deno.test("assignment reads fail closed on unknown excessive truncated main and related counts", async () => {
  for (const count of [null, 1001, 2]) {
    const { clients, targets } = readClients([assignmentRow()], { count });
    const error = await captureEdgeError(() =>
      listAssignments(
        request("/v1/assignments?serviceDate=2026-09-04"),
        clients,
        admin,
      )
    );
    assert(
      error.status === 500 && error.code === "ASSIGNMENT_COMMAND_FAILED",
      "safe existing error contract",
    );
    assert(
      targets.filters.length === 0,
      "no hydration after incomplete assignment read",
    );
  }
  const { clients } = readClients([assignmentRow()], { attemptCount: 1001 });
  const error = await captureEdgeError(() =>
    listAssignments(
      request("/v1/assignments?serviceDate=2026-09-04"),
      clients,
      admin,
    )
  );
  assert(
    error.status === 500,
    "never guess latest attempt from capped related history",
  );
});

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
    assert(
      result[0].cleaningKind === "checkout" &&
        result[0].roomTypeCode === "standard" &&
        result[0].feeSnapshot === 16000 &&
        result[0].durationMinutes === null && result[0].rolloverCount === 1 &&
        result[0].rolloverReason === "ROLLED_OVER_NOT_STARTED" &&
        result[0].attemptStatus === "field_completed" &&
        result[0].submissionStatus === "submitted",
      "card snapshot and workflow summary",
    );
    if (actor.role === "maid") {
      assert(
        access.filters.some(([column, value]) =>
          column === "maid_profile_id" && value === maid.profileId
        ),
        "maid self filter",
      );
      assert(
        access.filters.some(([column, value]) =>
          column === "not.notified_at.is" && value === null
        ),
        "maid notified-only query",
      );
      assert(result[0].targetAssignmentVersion === 2, "revision snapshot");
    } else {
      assert(result[0].targetAssignmentVersion === 999, "admin current CAS");
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

Deno.test("maid list and history preserve own notified revisions only, without current target version hydration", async () => {
  const pastId = "70000000-0000-4000-8000-000000000010";
  const rows = [
    assignmentRow({ id: pastId, is_current: false, revision: 1 }),
    assignmentRow(),
    assignmentRow({ notified_at: null, revision: 3 }),
    assignmentRow({ maid_profile_id: otherMaid.profileId, revision: 4 }),
  ];
  for (const historyRoute of [true, false]) {
    const { clients, access } = readClients(rows);
    const result = historyRoute
      ? await assignmentHistory(
        request(`/v1/assignments/${targetId}/history`),
        clients,
        maid,
        targetId,
      )
      : await listAssignments(
        request("/v1/assignments?serviceDate=2026-09-04&includeHistory=true"),
        clients,
        maid,
      );
    assert(
      result.length === 2 && result[0].assignmentId === pastId,
      "own notified past retained",
    );
    assert(
      result.every((row) =>
        row.notifiedAt !== null && row.maidProfileId === maid.profileId
      ),
      "no never-notified or other maid",
    );
    assert(
      result[0].targetAssignmentVersion === 1,
      "past version not current target version",
    );
    assert(
      access.filters.some(([key]) => key === "not.notified_at.is"),
      "DB filter required",
    );
    assert(
      !access.filters.some(([key]) => key === "is_current"),
      "history not restricted to current",
    );
    assert(result[0].roomNumber === "101", "notified room snapshot preserved");
    assert(
      result[0].targetStatus === null,
      "past maid row hides current target status",
    );
  }
  const draftOnly = readClients([assignmentRow({ notified_at: null })]);
  const empty = await listAssignments(
    request("/v1/assignments?serviceDate=2026-09-04"),
    draftOnly.clients,
    maid,
  );
  assert(
    empty.length === 0 && draftOnly.targets.filters.length === 0,
    "draft list empty before service hydration",
  );
  const denied = await captureEdgeError(() =>
    assignmentHistory(
      request(`/v1/assignments/${targetId}/history`),
      draftOnly.clients,
      maid,
      targetId,
    )
  );
  assert(
    denied.code === "ASSIGNMENT_ACCESS_REQUIRED",
    "unpublished target history forbidden",
  );
});

Deno.test("assignment cards count only rollover evidence visible at that revision", async () => {
  for (const serviceDate of ["2026-09-02", "2026-09-06"]) {
    const { clients } = readClients([
      assignmentRow({ service_date: serviceDate, revision: 4 }),
    ], {
      target: {
        effective_service_date: "2026-09-08",
        carryover_count: 2,
        assignment_version: 6,
      },
      schedules: [{
        cleaning_target_id: targetId,
        revision: 4,
        effective_service_date: serviceDate,
        reason_code: "RESERVATION_CHANGED",
      }, {
        cleaning_target_id: targetId,
        revision: 5,
        effective_service_date: "2026-09-07",
        reason_code: "ROLLED_OVER_NOT_STARTED",
      }, {
        cleaning_target_id: targetId,
        revision: 6,
        effective_service_date: "2026-09-08",
        reason_code: "ROLLED_OVER_UNASSIGNED",
      }],
    });
    const result = await assignmentHistory(
      request(`/v1/assignments/${targetId}/history`),
      clients,
      admin,
      targetId,
    );
    assert(
      result[0].rolloverCount === 0 && result[0].rolloverReason === null,
      "reservation date changes never become rollover",
    );
  }
});

Deno.test("card cancellation is advisory admin/current only and checks all relevant started rows", async () => {
  const target = {
    source: "manual_room_request",
    cleaning_kind: "additional",
    status: "draft_assigned",
    assignment_version: 999,
    effective_service_date: "2026-09-09",
    room_type_snapshot: {},
    fee_snapshot: 0,
  };
  const scheduled = {
    id: "latest",
    assignment_id: assignmentId,
    attempt_number: 3,
    status: "scheduled",
    started_at: null,
  };
  const cases = [
    { attempts: [scheduled], allowed: true, reason: null },
    {
      attempts: [scheduled, {
        ...scheduled,
        id: "old",
        status: "superseded",
        started_at: "2026-09-01T01:00:00Z",
      }],
      allowed: true,
      reason: null,
    },
    {
      attempts: [scheduled, {
        ...scheduled,
        id: "started",
        status: "in_progress",
      }],
      allowed: false,
      reason: "CLEANING_REQUEST_CANCEL_CONFLICT",
    },
    {
      attempts: [scheduled, {
        id: "missing",
        assignment_id: assignmentId,
        status: "scheduled",
        attempt_number: 1,
      }],
      allowed: false,
      reason: "CAPABILITY_UNAVAILABLE",
    },
  ];
  for (const candidate of cases) {
    const { clients, attempts } = readClients([assignmentRow()], {
      target,
      attempts: candidate.attempts,
    });
    const result = await assignmentHistory(
      request(`/v1/assignments/${targetId}/history`),
      clients,
      admin,
      targetId,
    );
    assert(
      result[0].canCancel === candidate.allowed &&
        result[0].cancelReasonCode === candidate.reason,
      "exact-current full attempt guidance",
    );
    assert(
      result[0].effectiveServiceDate === "2026-09-04" &&
        result[0].feeSnapshot === 0 &&
        result[0].roomTypeSnapshot?.code === null &&
        result[0].sourceKind === "manual_room_request",
      "no future date or live catalog fallback",
    );
    assert(
      attempts.filters.some(([key, value]) =>
        key === "select" && String(value).includes("started_at")
      ),
      "start proof selected",
    );
  }
  for (const actor of [admin, maid]) {
    const { clients } = readClients([assignmentRow({ is_current: false })], {
      target,
      attempts: [],
    });
    const result = await assignmentHistory(
      request(`/v1/assignments/${targetId}/history`),
      clients,
      actor,
      targetId,
    );
    assert(
      !result[0].canCancel &&
        result[0].cancelReasonCode ===
          (actor.role === "maid" ? "ADMIN_REQUIRED" : "ASSIGNMENT_NOT_CURRENT"),
      "role/history deny guidance",
    );
  }
});

Deno.test("card raw snapshot optional attributes normalize like SQL without relaxing fresh canonical metadata", async () => {
  for (
    const raw of [
      {},
      { code: "", name: "", elevatorZone: "" },
      { code: 1234, name: false, elevatorZone: ["A"] },
      { code: null, name: {}, elevatorZone: null },
    ]
  ) {
    const { clients } = readClients([assignmentRow()], {
      target: { room_type_snapshot: raw },
    });
    const cards = await assignmentHistory(
      request(`/v1/assignments/${targetId}/history`),
      clients,
      admin,
      targetId,
    );
    assert(
      cards[0].roomTypeCode === null && cards[0].roomTypeName === null &&
        cards[0].elevatorZone === null &&
        JSON.stringify(cards[0].roomTypeSnapshot) ===
          JSON.stringify({ code: null, name: null, elevatorZone: null }),
      "raw optional metadata normalized without catalog fill",
    );
  }
  for (const length of [101, 1001]) {
    const name = "n".repeat(length);
    const { clients } = readClients([assignmentRow()], {
      target: { room_type_snapshot: { code: "a".repeat(101), name } },
    });
    const cards = await assignmentHistory(
      request(`/v1/assignments/${targetId}/history`),
      clients,
      admin,
      targetId,
    );
    assert(
      cards[0].roomTypeName === name &&
        cards[0].roomTypeSnapshot?.name === name &&
        cards[0].roomTypeCode === "a".repeat(101),
      "baseline valid historical display strings remain untruncated",
    );
  }
});

Deno.test("legacy notified assignment without a proven room snapshot remains null", async () => {
  const { clients, targets } = readClients([assignmentRow({
    notified_room_id_snapshot: null,
    notified_room_number_snapshot: null,
    is_current: false,
  })]);
  const result = await assignmentHistory(
    request(`/v1/assignments/${targetId}/history`),
    clients,
    maid,
    targetId,
  );
  assert(
    result.length === 1 && result[0].roomId === null &&
      result[0].roomNumber === null,
    "never invent a historical room from current state",
  );
  assert(targets.filters.length > 0, "immutable target snapshots are loaded");
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

const frozenSchedule = {
  capturedAt: "2026-10-01T00:00:00Z",
  scheduleRevision: 1,
  scheduleReasonCode: "CHECKOUT_PLANNED",
  sourceReservationVersion: 1,
  plannedCheckoutAt: "2026-10-02T03:00:00Z",
  actualCheckoutAt: null,
  plannedRoomDepartureAt: null,
  actualRoomDepartureAt: null,
  nextCheckInAt: "2026-10-02T06:30:00Z",
  nextRoomArrivalAt: "2026-10-02T06:30:00Z",
  nextArrivalKind: "check_in",
  isEarlyCheckIn: true,
  isLateCheckout: true,
  isScheduleUpdated: false,
};

Deno.test("schedule snapshot is frozen while current departure is explicit current-list only", async () => {
  const modes: unknown[] = [];
  const currentDeparture = {
    evaluatedAt: "2026-10-02T03:00:00Z",
    actualCheckoutAt: "2026-10-02T02:00:00Z",
    actualRoomDepartureAt: null,
  };
  const { clients } = readClients([assignmentRow()], {
    scheduleRead: (args) => {
      assert(
        args.p_actor_profile_id === maid.profileId,
        "actor-bound schedule read",
      );
      assert(args.p_expected_actor_role === "maid", "bind original role");
      assert(
        JSON.stringify(args.p_assignment_ids) ===
          JSON.stringify([assignmentId]),
        "exact assignment IDs",
      );
      modes.push(args.p_include_current);
      return {
        data: [{
          assignmentId,
          scheduleSnapshot: frozenSchedule,
          currentDeparture: args.p_include_current ? currentDeparture : null,
        }],
        error: null,
      };
    },
  });
  const current = await listAssignments(
    request("/v1/assignments?serviceDate=2026-09-04"),
    clients,
    maid,
  );
  assert(
    JSON.stringify(current[0].scheduleSnapshot) ===
      JSON.stringify(frozenSchedule),
    "original frozen plan",
  );
  assert(
    JSON.stringify(current[0].currentDeparture) ===
      JSON.stringify(currentDeparture),
    "separate actual fact",
  );
  const history = await assignmentHistory(
    request("/history"),
    clients,
    maid,
    targetId,
  );
  const included = await listAssignments(
    request("/v1/assignments?serviceDate=2026-09-04&includeHistory=true"),
    clients,
    maid,
  );
  assert(
    history[0].currentDeparture === null &&
      included[0].currentDeparture === null,
    "never live hydrate history",
  );
  assert(
    JSON.stringify(modes) === JSON.stringify([true, false, false]),
    "explicit mode on every path",
  );
});

Deno.test("schedule reads fail closed after latest DB authorization or malformed results", async () => {
  for (
    const [message, expected] of [
      ["ASSIGNMENT_ACCESS_REQUIRED", "ASSIGNMENT_ACCESS_REQUIRED"],
      ["SESSION_REVOKED", "SESSION_REVOKED"],
      ["PASSWORD_CHANGE_REQUIRED", "PASSWORD_CHANGE_REQUIRED"],
      ["unsafe SQL secret", "ASSIGNMENT_COMMAND_FAILED"],
    ]
  ) {
    const { clients } = readClients([assignmentRow()], {
      scheduleRead: () => ({ data: null, error: { message } }),
    });
    const error = await captureEdgeError(() =>
      assignmentHistory(request("/history"), clients, maid, targetId)
    );
    assert(
      error.code === expected && !error.message.includes("unsafe"),
      "redacted DB authorization failure",
    );
  }
  for (
    const data of [
      [],
      [{
        assignmentId: targetId,
        scheduleSnapshot: null,
        currentDeparture: null,
      }],
      [{
        assignmentId,
        scheduleSnapshot: { ...frozenSchedule, guestName: "private" },
        currentDeparture: null,
      }],
      [{
        assignmentId,
        scheduleSnapshot: frozenSchedule,
        currentDeparture: {
          evaluatedAt: "2026-10-02T03:00:00Z",
          actualCheckoutAt: null,
          actualRoomDepartureAt: null,
        },
      }],
    ]
  ) {
    const { clients } = readClients([assignmentRow()], {
      scheduleRead: () => ({ data, error: null }),
    });
    const error = await captureEdgeError(() =>
      assignmentHistory(request("/history"), clients, maid, targetId)
    );
    assert(
      error.code === "ASSIGNMENT_COMMAND_FAILED",
      "safe all-or-nothing history failure",
    );
  }
});

Deno.test("schedule reads reject adapter role changes during hydration", async () => {
  for (
    const [initialRole, latestRole] of [["admin", "maid"], [
      "maid",
      "admin",
    ]] as const
  ) {
    const { clients } = readClients([assignmentRow()], {
      scheduleRead: (args) => {
        assert(
          args.p_expected_actor_role === initialRole,
          "expected original role",
        );
        assert(
          args.p_expected_actor_role !== latestRole,
          "changed role fails closed in DB",
        );
        return { data: null, error: { message: "ASSIGNMENT_ACCESS_REQUIRED" } };
      },
    });
    const error = await captureEdgeError(() =>
      assignmentHistory(request("/history"), clients, {
        ...maid,
        role: initialRole,
      }, targetId)
    );
    assert(
      error.status === 403 && error.code === "ASSIGNMENT_ACCESS_REQUIRED",
      "never return partially hydrated elevated cards",
    );
  }
});

Deno.test("schedule pure boundary preserves legacy unknown and rejects partial/private/future facts", () => {
  const row = { assignmentId, scheduleSnapshot: null, currentDeparture: null };
  assert(
    parseAssignmentScheduleReads([row], [assignmentId], false).get(assignmentId)
      ?.scheduleSnapshot === null,
    "legacy null",
  );
  const invalid: unknown[] = [
    [],
    [row, row],
    [{ ...row, assignmentId: targetId }],
    [{ ...row, scheduleSnapshot: { ...frozenSchedule, pin: "private" } }],
    [{ ...row, scheduleSnapshot: { ...frozenSchedule, scheduleRevision: 0 } }],
    [{
      ...row,
      scheduleSnapshot: {
        ...frozenSchedule,
        nextCheckInAt: "2026-02-30T01:00:00Z",
      },
    }],
    [{
      ...row,
      currentDeparture: {
        evaluatedAt: "2026-10-02T03:00:00Z",
        actualCheckoutAt: "2026-10-02T04:00:00Z",
        actualRoomDepartureAt: null,
      },
    }],
  ];
  for (const key of Object.keys(frozenSchedule)) {
    const partial: Record<string, unknown> = { ...frozenSchedule };
    delete partial[key];
    invalid.push([{ ...row, scheduleSnapshot: partial }]);
  }
  for (const data of invalid) {
    let rejected = false;
    try {
      parseAssignmentScheduleReads(data, [assignmentId], true);
    } catch {
      rejected = true;
    }
    assert(rejected, "malformed and private schedule data rejected");
  }
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
const newReadMetadata = {
  cleaningKind: "additional",
  sourceKind: "manual_room_request",
  roomTypeCode: null,
  roomTypeName: null,
  elevatorZone: null,
  roomTypeSnapshot: { code: null, name: null, elevatorZone: null },
  feeSnapshot: 0,
  originalServiceDate: "2026-09-03",
  effectiveServiceDate: "2026-09-04",
  rolloverCount: 0,
  rolloverReason: null,
  canCancel: true,
  cancelReasonCode: null,
};

Deno.test("new commit snapshot metadata and replay preserve long valid names without live hydration", async () => {
  for (const length of [101, 1001]) {
    const name = "n".repeat(length);
    const payload = {
      serviceDate: "2026-09-04",
      impactFingerprint: fingerprint,
      notifiedAssignments: [
        commitCandidate({
          ...newReadMetadata,
          roomTypeName: name,
          roomTypeSnapshot: { code: null, name, elevatorZone: null },
          notifiedAt: "2026-09-03T12:00:00Z",
        }),
      ],
      remainingDrafts: [],
      blockedDrafts: [],
      unassignedTargets: [],
    };
    let reads = 0;
    const clients = {
      admin: {
        rpc: async () => {
          reads++;
          return { data: payload, error: null };
        },
      },
    } as unknown as EdgeClients;
    const body = {
      serviceDate: "2026-09-04",
      expectedImpactFingerprint: fingerprint,
      items: [{
        cleaningTargetId: targetId,
        expectedAssignmentVersion: 2,
        expectedAvailabilityVersion: 3,
      }],
    };
    const first = await commitAssignments(
      request("/v1/assignments/commit", "POST", body),
      clients,
      admin,
    );
    const replay = await commitAssignments(
      request("/v1/assignments/commit", "POST", body),
      clients,
      admin,
    );
    assert(
      reads === 2 && JSON.stringify(first) === JSON.stringify(replay),
      "same immutable receipt mapper without live-table lookup",
    );
    assert(
      first.notifiedAssignments[0].roomTypeName === name &&
        first.notifiedAssignments[0].roomTypeSnapshot?.name === name,
      "long canonical metadata retained",
    );
  }
});

Deno.test("commit projections whitelist new snapshot metadata on every collection and preserve legacy unknowns", async () => {
  let response: Record<string, unknown> = {
    serviceDate: "2026-09-04",
    impactFingerprint: fingerprint,
    committableDrafts: [
      commitCandidate({ ...newReadMetadata, sourceKey: "private" }),
    ],
    blockedDrafts: [
      commitCandidate({
        ...newReadMetadata,
        currentAvailabilityVersion: null,
        reasonCodes: ["ASSIGNMENT_DRAFT_STALE_SCHEDULE"],
      }),
    ],
    remainingUnassignedTargets: [{
      ...newReadMetadata,
      cleaningTargetId: targetId,
      roomId,
      roomNumber: "101",
      serviceDate: "2026-09-04",
      status: "unassigned",
      targetAssignmentVersion: 3,
      availableFrom: null,
      dueAt: null,
    }],
  };
  const clients = {
    admin: { rpc: async () => ({ data: response, error: null }) },
  } as unknown as EdgeClients;
  const impact = await assignmentCommitImpact(
    request("/v1/assignments/commit-impact?serviceDate=2026-09-04"),
    clients,
    admin,
  );
  for (
    const row of [
      impact.committableDrafts[0],
      impact.blockedDrafts[0],
      impact.remainingUnassignedTargets[0],
    ]
  ) {
    assert(
      row.feeSnapshot === 0 && row.rolloverCount === 0 && row.canCancel &&
        row.roomTypeSnapshot?.code === null,
      "new exact metadata",
    );
  }
  assert(!JSON.stringify(impact).includes("private"), "source key omitted");
  response = {
    ...response,
    committableDrafts: [commitCandidate()],
    blockedDrafts: [],
    remainingUnassignedTargets: [],
  };
  const legacy = await assignmentCommitImpact(
    request("/v1/assignments/commit-impact?serviceDate=2026-09-04"),
    clients,
    admin,
  );
  assert(
    legacy.committableDrafts[0].feeSnapshot === null &&
      legacy.committableDrafts[0].rolloverCount === null &&
      !legacy.committableDrafts[0].canCancel &&
      legacy.committableDrafts[0].cancelReasonCode === "CAPABILITY_UNAVAILABLE",
    "legacy remains unknown",
  );
  for (
    const malformed of [
      { canCancel: true },
      { ...newReadMetadata, feeSnapshot: -1 },
      {
        ...newReadMetadata,
        canCancel: true,
        cancelReasonCode: "ADMIN_REQUIRED",
      },
      { ...newReadMetadata, rolloverCount: 1, rolloverReason: null },
      { ...newReadMetadata, roomTypeSnapshot: {} },
      {
        ...newReadMetadata,
        roomTypeSnapshot: { code: "", name: null, elevatorZone: null },
      },
      {
        ...newReadMetadata,
        roomTypeSnapshot: { code: 1234, name: null, elevatorZone: null },
      },
      {
        ...newReadMetadata,
        roomTypeSnapshot: { code: null, name: false, elevatorZone: null },
      },
      {
        ...newReadMetadata,
        roomTypeSnapshot: { code: null, name: null, elevatorZone: ["A"] },
      },
    ]
  ) {
    response = { ...response, committableDrafts: [commitCandidate(malformed)] };
    const error = await captureEdgeError(() =>
      assignmentCommitImpact(
        request("/v1/assignments/commit-impact?serviceDate=2026-09-04"),
        clients,
        admin,
      )
    );
    assert(
      error.status === 500 && error.code === "ASSIGNMENT_COMMAND_FAILED",
      "malformed DB output is safe500",
    );
  }
});

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
