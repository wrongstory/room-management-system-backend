import {
  attemptCommandPath,
  attemptDatabaseError,
  currentAttempt,
  executeAttempt,
} from "./attempt-api.ts";
import { type EdgeActor, type EdgeClients, EdgeError } from "./runtime.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const maid: EdgeActor = {
  authUserId: "10000000-0000-4000-8000-000000000001",
  profileId: "20000000-0000-4000-8000-000000000001",
  displayName: "테스트 메이드",
  role: "maid",
  mustChangePassword: false,
};
const attemptId = "30000000-0000-4000-8000-000000000001";
const assignmentId = "40000000-0000-4000-8000-000000000001";
const targetId = "50000000-0000-4000-8000-000000000001";
const body = {
  expectedExecutionVersion: 1,
  expectedAssignmentId: assignmentId,
  expectedAssignmentRevision: 3,
};
function request(input: unknown = body, query = "") {
  return new Request(
    `https://example.invalid/functions/v1/api/v1/attempts/${attemptId}/start${query}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "attempt-safe-command-1",
      },
      body: JSON.stringify(input),
    },
  );
}
function projection(overrides: Record<string, unknown> = {}) {
  return {
    attemptId,
    cleaningTargetId: targetId,
    assignmentId,
    maidProfileId: maid.profileId,
    assignmentRevision: 3,
    executionVersion: 2,
    status: "in_progress",
    startedAt: "2026-09-08T06:00:00Z",
    fieldCompletedAt: null,
    endedAt: null,
    effectiveAt: "2026-09-08T06:00:00Z",
    recordedAt: "2026-09-08T06:00:00Z",
    ...overrides,
  };
}
async function failure(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    if (error instanceof EdgeError) return error;
    throw error;
  }
  throw new Error("Expected rejection");
}
function clientsFor(data: unknown, code?: string) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const clients = {
    admin: {
      rpc: (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return Promise.resolve({
          data,
          error: code ? { message: code } : null,
        });
      },
    },
  } as unknown as EdgeClients;
  return { clients, calls };
}

Deno.test("attempt commands send server actor plus exact CAS and deterministic scoped request hash", async () => {
  for (const action of ["start", "complete-field-work"] as const) {
    const { clients, calls } = clientsFor(
      projection(
        action === "start" ? {} : {
          status: "field_completed",
          fieldCompletedAt: "2026-09-08T07:00:00Z",
          raw_state: { PIN: "do-not-expose" },
          requestHash: "secret",
        },
      ),
    );
    const first = await executeAttempt(
      request(),
      clients,
      maid,
      attemptId,
      action,
    );
    const replay = await executeAttempt(
      request({
        expectedAssignmentRevision: 3,
        expectedAssignmentId: assignmentId,
        expectedExecutionVersion: 1,
      }),
      clients,
      maid,
      attemptId,
      action,
    );
    assert(JSON.stringify(first) === JSON.stringify(replay), "same result");
    assert(
      calls[0].args.p_request_hash === calls[1].args.p_request_hash &&
        /^[a-f0-9]{64}$/.test(String(calls[0].args.p_request_hash)),
      "hash independent of JSON property order",
    );
    assert(
      calls[0].name ===
        (action === "start"
          ? "start_cleaning_attempt"
          : "complete_cleaning_attempt_field_work"),
      "explicit RPC",
    );
    assert(
      calls[0].args.p_actor_profile_id === maid.profileId &&
        calls[0].args.p_expected_execution_version === 1 &&
        calls[0].args.p_expected_assignment_revision === 3,
      "actor and CAS forwarded",
    );
    assert(
      Object.keys(calls[0].args).length === 7 &&
        !JSON.stringify(first).includes("secret") &&
        !JSON.stringify(first).includes("raw_state"),
      "no time/user payload or DB raw extras",
    );
  }
  const { clients, calls } = clientsFor(projection());
  await executeAttempt(request(), clients, maid, attemptId, "start");
  await failure(() =>
    executeAttempt(
      request({ ...body, expectedExecutionVersion: 2 }),
      clients,
      maid,
      attemptId,
      "start",
    )
  );
  assert(
    calls[0].args.p_request_hash !== calls[1].args.p_request_hash,
    "different canonical payload has different hash",
  );
});

Deno.test("attempt role, password, query and body failures occur before RPC", async () => {
  for (
    const actor of [{ ...maid, role: "admin" as const }, {
      ...maid,
      role: "developer" as const,
    }, { ...maid, mustChangePassword: true }]
  ) {
    const { clients, calls } = clientsFor(null);
    const error = await failure(() =>
      executeAttempt(request(), clients, actor, attemptId, "start")
    );
    assert(
      error.status === 403 && calls.length === 0,
      "no mutation for forbidden actor",
    );
    const readError = await failure(() =>
      currentAttempt(
        new Request(
          `https://example.invalid/v1/attempts/current?assignmentId=${assignmentId}`,
        ),
        clients,
        actor,
      )
    );
    assert(
      readError.status === 403 && calls.length === 0,
      "read same role gate",
    );
  }
  for (
    const input of [
      null,
      [],
      {},
      { ...body, expectedExecutionVersion: 0 },
      { ...body, expectedExecutionVersion: 1.5 },
      { ...body, expectedExecutionVersion: 9007199254740992 },
      { ...body, expectedAssignmentId: "bad" },
      { ...body, expectedAssignmentRevision: "3" },
      { ...body, clientOccurredAt: "2026-09-08" },
      { ...body, PIN: "secret" },
      { ...body, guestName: "private" },
      { ...body, lease: "forbidden" },
    ]
  ) {
    const { clients, calls } = clientsFor(null);
    assert(
      (await failure(() =>
            executeAttempt(request(input), clients, maid, attemptId, "start")
          )).status === 400 && calls.length === 0,
      "invalid input cannot reach RPC",
    );
  }
  const { clients, calls } = clientsFor(null);
  await failure(() =>
    executeAttempt(
      request(body, "?at=unsafe"),
      clients,
      maid,
      attemptId,
      "start",
    )
  );
  assert(calls.length === 0, "client query time forbidden");
});

Deno.test("attempt current query is a bounded single assignment lookup with safe null and no hydration", async () => {
  const url =
    `https://example.invalid/v1/attempts/current?assignmentId=${assignmentId}`;
  for (
    const data of [
      null,
      projection({ status: "scheduled", executionVersion: 1, startedAt: null }),
    ]
  ) {
    const { clients, calls } = clientsFor(data);
    const result = await currentAttempt(new Request(url), clients, maid);
    assert(
      data === null ? result === null : result?.executionVersion === 1,
      "nullable safe projection",
    );
    assert(
      calls.length === 1 && calls[0].name === "get_current_cleaning_attempt" &&
        calls[0].args.p_assignment_id === assignmentId,
      "exact single read RPC",
    );
  }
  for (
    const query of [
      "",
      "?assignmentId=bad",
      `?assignmentId=${assignmentId}&extra=x`,
      `?assignmentId=${assignmentId}&assignmentId=${assignmentId}`,
    ]
  ) {
    const { clients, calls } = clientsFor(null);
    assert(
      (await failure(() =>
            currentAttempt(
              new Request(
                `https://example.invalid/v1/attempts/current${query}`,
              ),
              clients,
              maid,
            )
          )).status === 400 && calls.length === 0,
      "query fail closed",
    );
  }
  const denied = clientsFor(null, "ATTEMPT_ACCESS_REQUIRED");
  assert(
    (await failure(() =>
      currentAttempt(new Request(url), denied.clients, maid)
    )).status === 403,
    "hidden assignment denied, not null",
  );
});

Deno.test("attempt response and DB error allowlists reject unexpected identity and redact raw SQL", async () => {
  for (
    const data of [
      projection({ maidProfileId: targetId }),
      projection({ assignmentId: targetId }),
      projection({ executionVersion: 9 }),
      projection({ status: "approved" }),
      projection({ startedAt: "invalid" }),
      { invalid: "raw" },
    ]
  ) {
    const { clients } = clientsFor(data);
    assert(
      (await failure(() =>
        executeAttempt(request(), clients, maid, attemptId, "start")
      )).code === "ATTEMPT_COMMAND_FAILED",
      "unexpected response fail closed",
    );
  }
  for (
    const [code, status] of [
      ["ATTEMPT_ACCESS_REQUIRED", 403],
      ["ATTEMPT_VERSION_CONFLICT", 409],
      ["ATTEMPT_INVALID_TRANSITION", 409],
      ["MAID_ALREADY_IN_PROGRESS", 409],
      ["IDEMPOTENCY_KEY_REUSED", 409],
      ["raw SQL phone PIN token", 500],
    ] as const
  ) {
    assert(
      attemptDatabaseError({ message: code }).status === status,
      "stable DB mapping",
    );
  }
  assert(
    !attemptDatabaseError({ message: "raw SQL phone PIN token" }).message
      .includes("raw SQL"),
    "redacted error",
  );
  assert(
    attemptCommandPath(`/v1/attempts/${attemptId}/start`)?.action === "start",
    "exact start",
  );
  assert(
    attemptCommandPath(`/v1/attempts/${attemptId}/complete-field-work`)
      ?.action === "complete-field-work",
    "exact completion",
  );
  for (
    const path of [
      `/v1/attempts/${attemptId}`,
      `/v1/attempts/${attemptId}/start/extra`,
      `/v1/attempts/${attemptId}/claim`,
      "/v1/attempts/current",
    ]
  ) assert(attemptCommandPath(path) === null, "not an action alias");
});
