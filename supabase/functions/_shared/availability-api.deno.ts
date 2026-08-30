import {
  availabilityDatabaseError,
  availabilityDecisionRequestId,
  decideAvailabilityChange,
  listAvailability,
  listAvailabilityCandidates,
  listAvailabilityChangeRequests,
  requestAvailabilityChange,
  submitAvailability,
  toAvailabilityChangeRequest,
  toAvailabilityVersion,
} from "./availability-api.ts";
import type { EdgeActor, EdgeClients } from "./runtime.ts";
import { EdgeError } from "./runtime.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function captureEdgeError(
  run: () => Promise<unknown>,
): Promise<EdgeError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof EdgeError) {
      return error;
    }
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

const admin: EdgeActor = {
  ...maid,
  profileId: "20000000-0000-4000-8000-000000000002",
  displayName: "운영 관리자",
  role: "admin",
};

const developer: EdgeActor = {
  ...maid,
  profileId: "20000000-0000-4000-8000-000000000003",
  displayName: "developer",
  role: "developer",
};

function postRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/v1/availability/submissions", {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
      "idempotency-key": "availability-test-0001",
    },
    body: JSON.stringify(body),
  });
}

function commandRequest(
  path: string,
  body: Record<string, unknown>,
  key = "availability-test-0001",
): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify(body),
  });
}

function queryResult(data: unknown) {
  const filters: Array<[string, unknown]> = [];
  type QueryMock = Promise<{ data: unknown; error: null }> & {
    select: () => QueryMock;
    eq: (column: string, value: unknown) => QueryMock;
    order: () => QueryMock;
  };
  let query: QueryMock;
  query = Object.assign(Promise.resolve({ data, error: null }), {
    select: () => query,
    eq: (column: string, value: unknown) => {
      filters.push([column, value]);
      return query;
    },
    order: () => query,
  }) as QueryMock;
  return { query, filters };
}

Deno.test("availability projections expose the Fastify camelCase contract", () => {
  const version = toAvailabilityVersion({
    id: "30000000-0000-4000-8000-000000000001",
    maid_profile_id: maid.profileId,
    week_start: "2026-08-31",
    version: 2,
    status: "submitted",
    is_current: true,
    submitted_at: "2026-08-30T03:00:00.000Z",
    availability_days: [
      { work_date: "2026-09-01", available: false },
      { work_date: "2026-08-31", available: true },
    ],
  });
  const change = toAvailabilityChangeRequest({
    id: "40000000-0000-4000-8000-000000000001",
    availability_version_id: version.id,
    maid_profile_id: maid.profileId,
    week_start: "2026-08-31",
    source_version: 2,
    requested_available_dates: ["2026-09-02"],
    reason_code: "PERSONAL_SCHEDULE",
    status: "pending",
    requested_at: "2026-08-31T00:00:00.000Z",
    decided_by: null,
    decided_at: null,
    decision_reason_code: null,
    approved_version_id: null,
  });

  assert(version.maidProfileId === maid.profileId, "maidProfileId mapping");
  assert(version.days[0].workDate === "2026-08-31", "days must be sorted");
  assert(!("maid_profile_id" in version), "snake_case must not leak");
  assert(change.sourceVersion === 2, "sourceVersion mapping");
  assert(!("reason_code" in change), "raw DB names must not leak");
});

Deno.test("availability database errors keep the Fastify reason-code contract", () => {
  const stale = availabilityDatabaseError({ message: "STALE_VERSION" });
  const window = availabilityDatabaseError({
    message: "OUTSIDE_AVAILABILITY_WINDOW",
  });
  const unknown = availabilityDatabaseError({ message: "internal detail" });

  assert(stale.status === 409 && stale.code === "STALE_VERSION", "stale CAS");
  assert(
    window.status === 409 && window.code === "OUTSIDE_AVAILABILITY_WINDOW",
    "KST submission window",
  );
  assert(
    unknown.status === 500 && unknown.code === "AVAILABILITY_COMMAND_FAILED",
    "unknown DB detail must be redacted",
  );
});

Deno.test("availability role and password gates reject non-business actors", async () => {
  const clients = {} as EdgeClients;
  const body = {
    weekStart: "2026-08-31",
    availableDates: ["2026-08-31"],
    expectedVersion: 0,
  };

  for (const actor of [developer, admin]) {
    const error = await captureEdgeError(() =>
      submitAvailability(postRequest(body), clients, actor)
    );
    assert(error.code === "MAID_REQUIRED", `${actor.role} submit must fail`);
  }

  const temporary = await captureEdgeError(() =>
    submitAvailability(
      postRequest(body),
      clients,
      { ...maid, mustChangePassword: true },
    )
  );
  assert(
    temporary.code === "PASSWORD_CHANGE_REQUIRED",
    "temporary password must block availability",
  );

  const developerRead = await captureEdgeError(() =>
    listAvailability(
      new Request("http://localhost/v1/availability?weekStart=2026-08-31"),
      clients,
      developer,
    )
  );
  assert(
    developerRead.code === "AVAILABILITY_ACCESS_REQUIRED",
    "developer read must fail",
  );

  const maidCandidate = await captureEdgeError(() =>
    listAvailabilityCandidates(
      new Request(
        "http://localhost/v1/availability/candidates?workDate=2026-08-31",
      ),
      clients,
      maid,
    )
  );
  assert(
    maidCandidate.code === "ADMIN_REQUIRED",
    "candidate list is admin-only",
  );
});

Deno.test("maid availability reads are self-only before any RLS query", async () => {
  const error = await captureEdgeError(() =>
    listAvailability(
      new Request(
        `http://localhost/v1/availability?weekStart=2026-08-31&maidProfileId=${admin.profileId}`,
        { headers: { authorization: "Bearer test-token" } },
      ),
      {} as EdgeClients,
      maid,
    )
  );
  assert(
    error.status === 403 && error.code === "FORBIDDEN",
    "cross-read blocked",
  );
});

Deno.test("availability submission calls the existing actor-bound RPC", async () => {
  let rpcName = "";
  let rpcArguments: Record<string, unknown> = {};
  const versionRow = {
    id: "30000000-0000-4000-8000-000000000001",
    maid_profile_id: maid.profileId,
    week_start: "2026-08-31",
    version: 1,
    status: "submitted",
    is_current: true,
    submitted_at: "2026-08-30T03:00:00.000Z",
    availability_days: [{ work_date: "2026-08-31", available: true }],
  };
  const singleQuery = {
    select() {
      return this;
    },
    eq() {
      return this;
    },
    async single() {
      return { data: versionRow, error: null };
    },
  };
  const clients = {
    admin: {
      async rpc(name: string, args: Record<string, unknown>) {
        rpcName = name;
        rpcArguments = args;
        return { data: { id: versionRow.id }, error: null };
      },
      from() {
        return singleQuery;
      },
    },
  } as unknown as EdgeClients;

  const result = await submitAvailability(
    postRequest({
      weekStart: "2026-08-31",
      availableDates: ["2026-08-31"],
      expectedVersion: 0,
    }),
    clients,
    maid,
  );

  assert(
    rpcName === "submit_weekly_availability",
    "existing RPC must be reused",
  );
  assert(
    rpcArguments.p_actor_profile_id === maid.profileId,
    "actor profile must be passed for DB revalidation",
  );
  assert(result.current === true && result.version === 1, "result projection");
});

Deno.test("availability reads use bearer RLS and preserve maid self filters", async () => {
  const versionRow = {
    id: "30000000-0000-4000-8000-000000000001",
    maid_profile_id: maid.profileId,
    week_start: "2026-08-31",
    version: 1,
    status: "submitted",
    is_current: true,
    submitted_at: "2026-08-30T03:00:00.000Z",
    availability_days: [{ work_date: "2026-08-31", available: true }],
  };
  const versionQuery = queryResult([versionRow]);
  const changeQuery = queryResult([]);
  let token = "";
  const clients = {
    forAccessToken(accessToken: string) {
      token = accessToken;
      return {
        from(table: string) {
          return table === "availability_versions"
            ? versionQuery.query
            : changeQuery.query;
        },
      };
    },
  } as unknown as EdgeClients;
  const headers = { authorization: "Bearer user-access-token" };

  const versions = await listAvailability(
    new Request(
      "http://localhost/v1/availability?weekStart=2026-08-31",
      { headers },
    ),
    clients,
    maid,
  );
  await listAvailabilityChangeRequests(
    new Request(
      "http://localhost/v1/availability/change-requests?status=pending",
      { headers },
    ),
    clients,
    maid,
  );

  assert(token === "user-access-token", "bearer token must create RLS client");
  assert(versions[0].maidProfileId === maid.profileId, "version mapper");
  assert(
    versionQuery.filters.some(([column, value]) =>
      column === "maid_profile_id" && value === maid.profileId
    ),
    "maid availability query must filter self",
  );
  assert(
    changeQuery.filters.some(([column, value]) =>
      column === "maid_profile_id" && value === maid.profileId
    ),
    "maid change-request query must filter self",
  );
});

Deno.test("availability change and decision commands preserve actor, CAS and idempotency", async () => {
  const changeRow = {
    id: "40000000-0000-4000-8000-000000000001",
    availability_version_id: "30000000-0000-4000-8000-000000000001",
    maid_profile_id: maid.profileId,
    week_start: "2026-08-31",
    source_version: 1,
    requested_available_dates: ["2026-09-01"],
    reason_code: "PERSONAL_SCHEDULE",
    status: "pending",
    requested_at: "2026-08-31T00:00:00.000Z",
    decided_by: null,
    decided_at: null,
    decision_reason_code: null,
    approved_version_id: null,
  };
  const calls: Array<[string, Record<string, unknown>]> = [];
  const clients = {
    admin: {
      async rpc(name: string, args: Record<string, unknown>) {
        calls.push([name, args]);
        return {
          data: name === "decide_availability_change"
            ? { ...changeRow, status: "approved", decided_by: admin.profileId }
            : changeRow,
          error: null,
        };
      },
    },
  } as unknown as EdgeClients;

  await requestAvailabilityChange(
    commandRequest("/v1/availability/change-requests", {
      weekStart: "2026-08-31",
      requestedAvailableDates: ["2026-09-01"],
      reasonCode: "PERSONAL_SCHEDULE",
      expectedVersion: 1,
    }),
    clients,
    maid,
  );
  const decided = await decideAvailabilityChange(
    commandRequest(
      `/v1/availability/change-requests/${changeRow.id}/decision`,
      {
        decision: "approved",
        reasonCode: "STAFFING_CONFIRMED",
        expectedVersion: 1,
      },
      "availability-decision-0001",
    ),
    clients,
    admin,
    changeRow.id,
  );

  assert(calls[0][0] === "request_availability_change", "request RPC");
  assert(calls[0][1].p_actor_profile_id === maid.profileId, "maid actor");
  assert(calls[0][1].p_expected_version === 1, "request CAS");
  assert(calls[1][0] === "decide_availability_change", "decision RPC");
  assert(calls[1][1].p_actor_profile_id === admin.profileId, "admin actor");
  assert(
    calls[1][1].p_idempotency_key === "availability-decision-0001",
    "decision idempotency",
  );
  assert(decided.status === "approved", "decision projection");
});

Deno.test("availability candidates use an admin RLS query and camelCase projection", async () => {
  const candidateQuery = queryResult([{
    work_date: "2026-08-31",
    week_start: "2026-08-31",
    availability_version: 2,
    maid_profile_id: maid.profileId,
    display_name: "메이드",
  }]);
  const clients = {
    forAccessToken() {
      return { from: () => candidateQuery.query };
    },
  } as unknown as EdgeClients;

  const candidates = await listAvailabilityCandidates(
    new Request(
      "http://localhost/v1/availability/candidates?workDate=2026-08-31",
      { headers: { authorization: "Bearer admin-token" } },
    ),
    clients,
    admin,
  );

  assert(candidates[0].availabilityVersion === 2, "candidate version");
  assert(candidates[0].maidProfileId === maid.profileId, "candidate profile");
  assert(!("maid_profile_id" in candidates[0]), "candidate snake_case leak");
});

Deno.test("availability decision path requires the exact UUID route", () => {
  const id = "40000000-0000-4000-8000-000000000001";
  assert(
    availabilityDecisionRequestId(
      `/v1/availability/change-requests/${id}/decision`,
    ) === id,
    "valid path",
  );
  try {
    availabilityDecisionRequestId(
      "/v1/availability/change-requests/not-a-uuid/decision",
    );
    throw new Error("invalid UUID must fail");
  } catch (error) {
    assert(error instanceof EdgeError, "invalid path must return EdgeError");
    assert(error.code === "VALIDATION_ERROR", "stable validation code");
  }
});
