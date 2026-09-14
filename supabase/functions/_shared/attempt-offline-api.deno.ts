import { handleApiRequest } from "../api/index.ts";
import { offlineDatabaseError } from "./attempt-offline-api.ts";
import { authenticate, type EdgeActor, type EdgeClients } from "./runtime.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const maid: EdgeActor = {
  profileId: "10000000-0000-4000-8000-000000000001",
  authUserId: "20000000-0000-4000-8000-000000000001",
  displayName: "합성",
  role: "maid",
  mustChangePassword: false,
};
const admin: EdgeActor = { ...maid, role: "admin" };
const attemptId = "30000000-0000-4000-8000-000000000001";
const assignmentId = "40000000-0000-4000-8000-000000000001";
const sessionId = "50000000-0000-4000-8000-000000000001";
const leaseId = "60000000-0000-4000-8000-000000000001";
const eventId = "70000000-0000-4000-8000-000000000001";
const quarantineId = "80000000-0000-4000-8000-000000000001";
const token = `header.${
  btoa(
    JSON.stringify({ session_id: sessionId, user_metadata: { role: "admin" } }),
  )
}.not-a-real-signature`;
const command = {
  expectedExecutionVersion: 1,
  expectedAssignmentId: assignmentId,
  expectedAssignmentRevision: 1,
};
const completion = {
  leaseId,
  eventId,
  expectedExecutionVersion: 2,
  occurredAt: "2026-09-08T00:30:00Z",
  serverOffsetMs: 0,
};
const secretFixture = "raw-body-token-phone-01012345678";
function attempt(completed = false) {
  return {
    attemptId,
    cleaningTargetId: leaseId,
    assignmentId,
    maidProfileId: maid.profileId,
    assignmentRevision: 1,
    executionVersion: completed ? 3 : 2,
    status: completed ? "field_completed" : "in_progress",
    startedAt: "2026-09-08T00:00:00Z",
    fieldCompletedAt: completed ? "2026-09-08T00:30:00Z" : null,
    endedAt: completed ? "2026-09-08T00:30:00Z" : null,
    effectiveAt: completed ? "2026-09-08T00:30:00Z" : "2026-09-08T00:00:00Z",
    recordedAt: "2026-09-08T00:35:00Z",
    pin: secretFixture,
    rawBody: secretFixture,
  };
}
function started() {
  return {
    attempt: attempt(),
    lease: {
      leaseId,
      version: 1,
      attemptId,
      assignmentId,
      assignmentRevision: 1,
      issuedAt: "2026-09-08T00:00:00Z",
      expiresAt: "2026-09-08T02:00:00Z",
      metadataExpiresAt: "2026-12-07T00:00:00Z",
      allowedActions: ["complete_field_work"],
      token: secretFixture,
    },
    serverTime: "2026-09-08T00:00:00Z",
  };
}
function synced(quarantined = false) {
  return {
    eventId,
    outcome: quarantined ? "quarantined" : "applied",
    reasonCode: quarantined ? "LEASE_EXPIRED" : null,
    attempt: quarantined ? null : attempt(true),
    quarantineId: quarantined ? quarantineId : null,
    receivedAt: "2026-09-08T00:35:00Z",
    metadataExpiresAt: "2026-12-07T00:00:00Z",
    requestBody: secretFixture,
    requestHash: secretFixture,
  };
}
function quarantine() {
  return {
    quarantineId,
    attemptId,
    assignmentId,
    assignmentRevision: 1,
    actorProfileId: maid.profileId,
    reasonCode: "LEASE_EXPIRED",
    occurredAt: "2026-09-08T00:30:00Z",
    receivedAt: "2026-09-08T03:00:00Z",
    metadataExpiresAt: "2026-12-07T00:00:00Z",
    resolution: null,
    currentAttempt: attempt(),
    eventId,
    serverOffsetMs: 0,
    requestHash: secretFixture,
  };
}
function request(method: string, path: string, body?: unknown) {
  return new Request(`https://example.invalid/functions/v1/api${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "idempotency-key": "offline-test-retry",
      "content-type": "application/json",
      "x-request-id": secretFixture,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
interface Options {
  role?: string;
  status?: string;
  revoked?: boolean;
  password?: boolean;
  authFailed?: boolean;
  code?: string;
  data?: unknown;
}
function mock(options: Options = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    publicClient: {
      auth: {
        getUser: (bearer: string) => {
          assert(bearer === token, "actual Auth bearer validation");
          return Promise.resolve({
            data: { user: options.authFailed ? null : { id: maid.authUserId } },
            error: options.authFailed ? { message: secretFixture } : null,
          });
        },
      },
    },
    admin: {
      from: (table: string) => {
        assert(table === "profiles", "no raw offline table access");
        return {
          select: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({
                  data: {
                    id: maid.profileId,
                    auth_user_id: maid.authUserId,
                    display_name: maid.displayName,
                    role: options.role ?? "maid",
                    status: options.status ?? "active",
                    must_change_password: options.password ?? false,
                  },
                  error: null,
                }),
            }),
          }),
        };
      },
      rpc: (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        if (name === "is_active_auth_session") {
          return Promise.resolve({ data: !options.revoked, error: null });
        }
        if (name === "record_authorization_denial") {
          return Promise.resolve({ data: null, error: null });
        }
        return Promise.resolve({
          data: options.data ?? synced(),
          error: options.code ? { message: options.code } : null,
        });
      },
    },
  } as unknown as EdgeClients;
  return { client, calls };
}
async function route(
  method: string,
  path: string,
  body: unknown,
  options: Options = {},
  actor: EdgeActor | null = null,
) {
  const state = mock(options);
  const response = await handleApiRequest(request(method, path, body), {
    createClients: () => state.client,
    authenticateRequest: actor ? async () => actor : authenticate,
  });
  const json = await response.json();
  // 기존 오류 envelope의 requestId는 transient correlation이다. ledger RPC 비노출은 별도로 검사한다.
  const { requestId: _transientCorrelation, ...persistentContract } = json;
  assert(
    !JSON.stringify(persistentContract).includes(secretFixture),
    "raw input/RPC secrets not reflected",
  );
  return { ...state, response, json };
}
Deno.test("offline online-start route atomically returns safe lease and never changes old start contract", async () => {
  const result = await route(
    "POST",
    `/v1/attempts/${attemptId}/start-with-lease`,
    command,
    { data: started() },
  );
  assert(result.response.status === 200, "start accepted");
  assert(
    Object.keys(result.json).sort().join() === "attempt,lease,serverTime",
    "dedicated envelope",
  );
  const rpc = result.calls.find((c) =>
    c.name === "start_cleaning_attempt_with_lease"
  );
  assert(
    rpc?.args.p_session_id === sessionId,
    "verified session internal RPC only",
  );
  assert(
    !JSON.stringify(result.json).includes(sessionId),
    "no session projection",
  );
  assert(
    !JSON.stringify(rpc.args.p_request_hash).includes(sessionId),
    "session excluded from hash",
  );
  for (const role of ["admin", "developer"] as const) {
    const denied = await route(
      "POST",
      `/v1/attempts/${attemptId}/start-with-lease`,
      command,
      {},
      { ...maid, role },
    );
    assert(
      denied.response.status === 403 &&
        denied.json.error.code === "MAID_REQUIRED",
      "exact maid",
    );
    assert(
      !denied.calls.some((c) => c.name === "start_cleaning_attempt_with_lease"),
      "no start RPC",
    );
  }
});
Deno.test("offline ingest uses verified three-state identity but no generic API authorization relaxation", async () => {
  for (const status of ["active", "deactivation_pending", "upload_only"]) {
    const result = await route("POST", "/v1/offline-events", completion, {
      status,
    });
    assert(
      result.response.status === 200 && result.json.outcome === "applied",
      "own sync accepted",
    );
    const rpc = result.calls.find((c) =>
      c.name === "sync_cleaning_attempt_event"
    );
    assert(
      rpc?.args.p_event_id === eventId && rpc.args.p_session_id === sessionId,
      "strict typed metadata RPC",
    );
    assert(
      !Object.hasOwn(rpc.args, "p_idempotency_key") &&
        !Object.hasOwn(rpc.args, "p_request_id"),
      "no permanent receipt/header metadata",
    );
    assert(
      !result.calls.some((c) => c.name === "record_authorization_denial"),
      "success is not per-request activity",
    );
  }
  for (
    const options of [
      { status: "inactive" },
      { status: "departed" },
      { role: "admin" },
      { role: "developer" },
      { revoked: true },
      { password: true },
      { authFailed: true },
    ]
  ) {
    const result = await route(
      "POST",
      "/v1/offline-events",
      completion,
      options,
    );
    assert(
      result.response.status >= 400 && result.response.status < 500,
      "identity rejected",
    );
    assert(
      !result.calls.some((c) => c.name === "sync_cleaning_attempt_event"),
      "no metadata ingest after failed identity",
    );
  }
  for (
    const path of [
      `/v1/attempts/${attemptId}/start-with-lease`,
      "/v1/rooms",
      `/v1/offline-events/${eventId}`,
      "/v1/offline-events/replay",
    ]
  ) {
    const result = await route("POST", path, command, {
      status: "upload_only",
    });
    assert(
      result.response.status === 403,
      "dedicated sync cannot relax generic route",
    );
  }
});
Deno.test("offline known late event quarantine projection and stable denial do not expose raw metadata", async () => {
  const result = await route("POST", "/v1/offline-events", completion, {
    data: synced(true),
    status: "upload_only",
  });
  assert(
    result.response.status === 200 && result.json.outcome === "quarantined",
    "metadata acceptance is not success completion",
  );
  assert(
    !Object.hasOwn(result.json, "attempt"),
    "quarantine has no completed result",
  );
  for (
    const code of [
      "OFFLINE_LEASE_UNKNOWN",
      "CAPABILITY_ACCESS_REQUIRED",
      "SESSION_REVOKED",
      "OFFLINE_EVENT_CONFLICT",
      "OFFLINE_EVENT_EXPIRED",
    ]
  ) {
    const denied = await route("POST", "/v1/offline-events", completion, {
      code,
      status: "deactivation_pending",
    });
    assert(
      denied.response.status ===
        (code === "SESSION_REVOKED"
          ? 401
          : code.includes("CONFLICT") || code.includes("EXPIRED")
          ? 409
          : 403),
      "stable status",
    );
    if (code === "CAPABILITY_ACCESS_REQUIRED") {
      const activity = denied.calls.find((c) =>
        c.name === "record_authorization_denial"
      );
      assert(
        activity?.args.p_source === "edge.authorization.attempts",
        "bounded existing activity source",
      );
      assert(
        !JSON.stringify(activity.args).includes(eventId),
        "event UUID never in activity",
      );
      assert(
        !JSON.stringify(activity.args).includes(secretFixture),
        "request header never in activity",
      );
    }
  }
});
Deno.test("offline exact schema rejects batches, extra PII, forged expiry, dates, clock and oversized bodies before RPC", async () => {
  const invalid = [
    [completion],
    { ...completion, pin: "1234" },
    { ...completion, expiresAt: "2030-01-01T00:00:00Z" },
    { ...completion, sequence: 2 },
    { ...completion, action: "start" },
    { ...completion, occurredAt: "2026-02-30T00:00:00Z" },
    { ...completion, occurredAt: "2026-09-08T24:00:00Z" },
    { ...completion, serverOffsetMs: 0.5 },
    { ...completion, serverOffsetMs: Number.MAX_SAFE_INTEGER },
    { ...completion, eventId: "raw-token" },
    { ...completion, rawBody: "x".repeat(3000) },
  ];
  for (const body of invalid) {
    const result = await route("POST", "/v1/offline-events", body);
    assert([400, 413].includes(result.response.status), "strict body rejected");
    assert(
      !result.calls.some((c) => c.name === "sync_cleaning_attempt_event"),
      "no event row for malformed request",
    );
  }
  const offset = await route("POST", "/v1/offline-events", {
    ...completion,
    serverOffsetMs: 300001,
  }, { data: { ...synced(true), reasonCode: "CLOCK_CONFLICT" } });
  assert(
    offset.response.status === 200 &&
      offset.json.reasonCode === "CLOCK_CONFLICT",
    "large but bounded offset is quarantined by DB, never silently normalized",
  );
});
Deno.test("offline quarantine admin list/detail are bounded and safe, with exact route methods", async () => {
  const page = await route(
    "GET",
    "/v1/offline-quarantines?from=2026-09-01T00:00:00Z&to=2026-09-08T00:00:00Z&limit=100",
    undefined,
    { data: { items: [quarantine()], nextCursor: null } },
    admin,
  );
  assert(
    page.response.status === 200 && page.json.items.length === 1,
    "bounded admin page",
  );
  assert(
    !JSON.stringify(page.json).includes(eventId) &&
      !JSON.stringify(page.json).includes("serverOffsetMs"),
    "raw UUID and offset stripped",
  );
  const detail = await route(
    "GET",
    `/v1/offline-quarantines/${quarantineId}`,
    undefined,
    { data: quarantine() },
    admin,
  );
  assert(
    detail.response.status === 200 &&
      detail.json.currentAttempt.executionVersion === 2,
    "correction CAS lookup",
  );
  for (const role of ["maid", "developer"] as const) {
    const denied = await route(
      "GET",
      `/v1/offline-quarantines/${quarantineId}`,
      undefined,
      {},
      { ...maid, role },
    );
    assert(
      denied.response.status === 403 &&
        denied.json.error.code === "ADMIN_REQUIRED",
      "exact admin only",
    );
  }
  for (
    const query of [
      "limit=101",
      "limit=1&limit=2",
      "actorProfileId=x",
      "cursor=garbage",
      "from=2026-01-01T00:00:00Z&to=2026-02-02T00:00:00Z",
      "from=2026-02-30T00:00:00Z",
    ]
  ) {
    const bad = await route(
      "GET",
      `/v1/offline-quarantines?${query}`,
      undefined,
      {},
      admin,
    );
    assert(bad.response.status === 400, "bounded query rejected");
    assert(
      !bad.calls.some((c) => c.name === "list_offline_event_quarantine"),
      "no unbounded query",
    );
  }
  for (
    const [method, path] of [
      ["GET", `/v1/attempts/${attemptId}/start-with-lease`],
      ["GET", "/v1/offline-events"],
      ["POST", `/v1/offline-quarantines/${quarantineId}`],
      ["GET", `/v1/offline-quarantines/${quarantineId}/resolve`],
      ["POST", `/v1/offline-quarantines/${quarantineId}/resolve/extra`],
    ]
  ) {
    const bad = await route(method, path, undefined, {}, admin);
    assert(
      bad.response.status === 404 && bad.json.error.code === "ROUTE_NOT_FOUND",
      "no method/path alias",
    );
  }
});
Deno.test("offline admin resolution permits only fixed reason and existing correction CAS, never caller correctedAt", async () => {
  const reasons = {
    record_only: "OFFLINE_RECORD_ONLY",
    reject_effect: "OFFLINE_REJECT_EFFECT",
    correction_link: "OFFLINE_CORRECTION_APPROVED",
  };
  for (const [resolution, reasonCode] of Object.entries(reasons)) {
    const body = {
      resolution,
      reasonCode,
      expectedExecutionVersion: resolution === "correction_link" ? 2 : null,
    };
    const result = await route(
      "POST",
      `/v1/offline-quarantines/${quarantineId}/resolve`,
      body,
      {
        data: {
          quarantineId,
          resolution,
          attempt: resolution === "correction_link" ? attempt(true) : null,
          effectiveAt: "2026-09-08T03:00:00Z",
          recordedAt: "2026-09-08T03:00:00Z",
        },
      },
      admin,
    );
    assert(result.response.status === 200, "safe resolution accepted");
    const rpc = result.calls.find((c) =>
      c.name === "resolve_offline_event_quarantine"
    );
    assert(
      rpc?.args.p_session_id === sessionId &&
        !Object.hasOwn(rpc.args, "p_corrected_at"),
      "no free timestamp correction",
    );
    const bad = await route(
      "POST",
      `/v1/offline-quarantines/${quarantineId}/resolve`,
      { ...body, correctedAt: "2020-01-01T00:00:00Z" },
      {},
      admin,
    );
    assert(bad.response.status === 400, "new timestamp prohibited");
  }
  assert(
    offlineDatabaseError({ message: secretFixture }).code ===
      "OFFLINE_EVENT_FAILED",
    "unknown DB error redacted",
  );
});

Deno.test("unrepresentable client clocks cannot poison a later admin quarantine page", async () => {
  for (
    const clock of [
      { occurredAt: "0000-01-01T00:00:00Z", serverOffsetMs: 0 },
      { occurredAt: "9999-12-31T23:59:59Z", serverOffsetMs: 86400000 },
      { occurredAt: "0001-01-01T00:00:00Z", serverOffsetMs: -86400000 },
      { occurredAt: "9999-12-31T23:59:59-01:00", serverOffsetMs: 0 },
    ]
  ) {
    const result = await route("POST", "/v1/offline-events", {
      ...completion,
      ...clock,
    });
    assert(
      result.response.status === 400,
      "outside shared SQL/JSON calendar range rejected",
    );
    assert(
      !result.calls.some((c) => c.name === "sync_cleaning_attempt_event"),
      "no poisoning metadata persisted",
    );
  }
  const page = await route("GET", "/v1/offline-quarantines", undefined, {
    data: { items: [quarantine()], nextCursor: null },
  }, admin);
  assert(page.response.status === 200, "safe stored rows remain readable");
});

Deno.test("start lease replay keeps original attempt version and hard expiry while server clock is transient", async () => {
  const first = await route(
    "POST",
    `/v1/attempts/${attemptId}/start-with-lease`,
    command,
    { data: started() },
  );
  const retry = await route(
    "POST",
    `/v1/attempts/${attemptId}/start-with-lease`,
    command,
    { data: { ...started(), serverTime: "2026-09-08T00:01:00Z" } },
  );
  assert(
    first.response.status === 200 && retry.response.status === 200,
    "original CAS request accepts saved response",
  );
  assert(
    JSON.stringify(first.json.lease) === JSON.stringify(retry.json.lease),
    "no TTL extension",
  );
  assert(
    JSON.stringify(first.json.attempt) === JSON.stringify(retry.json.attempt),
    "no new attempt/version",
  );
});
