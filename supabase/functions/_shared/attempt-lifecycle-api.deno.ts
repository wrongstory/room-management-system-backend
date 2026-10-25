import { handleApiRequest } from "../api/index.ts";
import {
  completeLimitedAttempt,
  getLimitedAttempt,
  lifecycleDatabaseError,
  manageAttemptLifecycle,
} from "./attempt-lifecycle-api.ts";
import {
  authenticate,
  authenticateLimitedAttempt,
  type EdgeActor,
  type EdgeClients,
  EdgeError,
} from "./runtime.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const maid: EdgeActor = {
  profileId: "10000000-0000-4000-8000-000000000001",
  authUserId: "20000000-0000-4000-8000-000000000001",
  displayName: "테스트",
  role: "maid",
  mustChangePassword: false,
};
const admin: EdgeActor = { ...maid, role: "admin" };
const attemptId = "30000000-0000-4000-8000-000000000001";
const assignmentId = "40000000-0000-4000-8000-000000000001";
const sessionId = "50000000-0000-4000-8000-000000000001";
const token = `header.${
  btoa(
    JSON.stringify({
      session_id: sessionId,
      role: "service_role",
      user_metadata: { role: "admin" },
    }),
  )
}.untrusted-signature`;
const command = {
  expectedExecutionVersion: 2,
  expectedAssignmentId: assignmentId,
  expectedAssignmentRevision: 3,
};
function attempt(overrides: Record<string, unknown> = {}) {
  return {
    attemptId,
    assignmentId,
    cleaningTargetId: "60000000-0000-4000-8000-000000000001",
    maidProfileId: maid.profileId,
    assignmentRevision: 3,
    executionVersion: 2,
    status: "in_progress",
    startedAt: "2026-09-08T00:00:00Z",
    fieldCompletedAt: null,
    endedAt: null,
    effectiveAt: "2026-09-08T00:00:00Z",
    recordedAt: "2026-09-08T00:00:00Z",
    ...overrides,
  };
}
function cap(kind = "finish_current") {
  return {
    capabilityId: "70000000-0000-4000-8000-000000000001",
    attemptId,
    assignmentId,
    assignmentRevision: 3,
    kind,
    allowedActions: kind === "finish_current"
      ? ["complete_field_work"]
      : kind === "upload_submit"
      ? ["upload_evidence", "validate_evidence", "submit"]
      : ["upload_evidence", "validate_evidence"],
    issuedAt: "2026-09-08T00:00:00Z",
    expiresAt: "2026-09-08T02:00:00Z",
    revokedAt: null,
  };
}
function readResult() {
  return {
    attempt: attempt(),
    capability: cap(),
    profileStatus: "deactivation_pending",
    profileVersion: 1,
    targetAssignmentVersion: 3,
  };
}
function mutationResult() {
  return {
    ...readResult(),
    nextAttempt: null,
    effectiveAt: "2026-09-08T00:00:00Z",
    recordedAt: "2026-09-08T00:00:00Z",
  };
}
function req(method: string, path: string, body?: unknown) {
  return new Request(`https://example.invalid/functions/v1/api${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "idempotency-key": "lifecycle-test-retry",
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
interface MockOptions {
  status?: string;
  role?: string;
  password?: boolean;
  revoked?: boolean;
  authFailed?: boolean;
  code?: string;
  data?: unknown;
}
function mock(options: MockOptions = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const order: string[] = [];
  const client = {
    publicClient: {
      auth: {
        getUser: (value: string) => {
          order.push("getUser");
          assert(value === token, "original bearer verified by Auth");
          return Promise.resolve({
            data: { user: options.authFailed ? null : { id: maid.authUserId } },
            error: options.authFailed
              ? { message: "private auth failure" }
              : null,
          });
        },
      },
    },
    admin: {
      from: (table: string) => {
        order.push("profile");
        assert(table === "profiles", "no arbitrary data lookup");
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
                    status: options.status ?? "deactivation_pending",
                    must_change_password: options.password ?? false,
                  },
                  error: null,
                }),
            }),
          }),
        };
      },
      rpc: (name: string, args: Record<string, unknown>) => {
        order.push(name);
        calls.push({ name, args });
        if (name === "get_active_auth_context") {
          return Promise.resolve({
            error: null,
            data: (options.status ?? "deactivation_pending") !== "active"
              ? { code: "ACCOUNT_INACTIVE" }
              : options.revoked
              ? { code: "SESSION_REVOKED" }
              : {
                code: "OK",
                profile: {
                  id: maid.profileId,
                  auth_user_id: maid.authUserId,
                  display_name: maid.displayName,
                  role: options.role ?? "maid",
                  must_change_password: options.password ?? false,
                },
              },
          });
        }
        if (name === "is_active_auth_session") {
          return Promise.resolve({
            data: !options.revoked,
            error: null,
          });
        }
        if (name === "record_authorization_denial") {
          return Promise.resolve({
            data: null,
            error: null,
          });
        }
        return Promise.resolve({
          data: options.data ?? readResult(),
          error: options.code ? { message: options.code } : null,
        });
      },
    },
  } as unknown as EdgeClients;
  return { client, calls, order };
}
async function failed(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    if (error instanceof EdgeError) return error;
    throw error;
  }
  throw new Error("expected denial");
}

Deno.test("admin lifecycle exact routes expose bounded impact and each action without calling Auth mutation APIs", async () => {
  const path = `/v1/attempts/${attemptId}/lifecycle`;
  for (
    const profileStatus of [
      "active",
      "deactivation_pending",
      "upload_only",
      "inactive",
      "departed",
    ]
  ) {
    const { client, calls } = mock({
      role: "admin",
      status: "active",
      data: { ...readResult(), profileStatus },
    });
    const response = await handleApiRequest(
      req("GET", `/v1/attempts/lifecycle-impact?assignmentId=${assignmentId}`),
      { createClients: () => client, authenticateRequest: authenticate },
    );
    const data = await response.json();
    assert(
      response.status === 200 && data.profileStatus === profileStatus &&
        data.profileVersion === 1,
      "all target account states readable for impact",
    );
    assert(
      calls.at(-1)?.name === "get_cleaning_attempt_lifecycle_impact" &&
        calls.at(-1)?.args.p_session_id === sessionId,
      "impact is one scoped server read",
    );
  }
  for (
    const action of [
      "allow_finish",
      "allow_upload",
      "interrupt_handover",
    ]
  ) {
    const payload = action === "interrupt_handover"
      ? {
        maidProfileId: "10000000-0000-4000-8000-000000000002",
        sequenceNumber: 1,
        serviceDate: "2026-09-08",
        availableFrom: "2026-09-08T10:00:00+09:00",
        dueAt: "2026-09-08T12:00:00+09:00",
        deactivateOld: true,
      }
      : {};
    const reasonCode = action === "allow_finish"
      ? "DEACTIVATION_FINISH_CURRENT"
      : action === "allow_upload"
      ? "DEACTIVATION_UPLOAD_ONLY"
      : "DEACTIVATION_HANDOVER";
    const { client, calls } = mock({
      role: "admin",
      status: "active",
      data: mutationResult(),
    });
    const response = await handleApiRequest(
      req("POST", path, {
        ...command,
        expectedProfileVersion: 1,
        action,
        payload,
        reasonCode,
      }),
      { createClients: () => client, authenticateRequest: authenticate },
    );
    assert(
      response.status === 200 &&
        calls.at(-1)?.name === "manage_cleaning_attempt_lifecycle",
      "all actions use trusted lifecycle RPC, not account Auth mutation",
    );
    assert(
      calls.at(-1)?.args.p_action === action &&
        calls.at(-1)?.args.p_reason_code === reasonCode,
      "finite action/reason forwarded",
    );
    if (action === "interrupt_handover") {
      const lastCall = calls.at(-1);
      assert(lastCall, "handover RPC recorded");
      assert(
        (lastCall.args.p_payload as Record<string, unknown>)
          .availableFrom === "2026-09-08T01:00:00.000Z",
        "handover schedule canonicalized independently of effectiveAt",
      );
    }
  }
  for (const role of ["maid", "developer"]) {
    const { client, calls } = mock({ role, status: "active" });
    const response = await handleApiRequest(
      req("POST", path, {
        ...command,
        expectedProfileVersion: 1,
        action: "allow_finish",
        payload: {},
        reasonCode: "DEACTIVATION_FINISH_CURRENT",
      }),
      { createClients: () => client, authenticateRequest: authenticate },
    );
    assert(
      response.status === 403 &&
        (await response.json()).error.code === "ADMIN_REQUIRED",
      "non-admin denied in real router",
    );
    assert(
      !calls.some((call) => call.name === "manage_cleaning_attempt_lifecycle"),
      "no lifecycle side effect",
    );
  }
});

Deno.test("retired scheduled expiry is rejected before mutation and disabled owners remain denied", async () => {
  for (const profileStatus of ["active", "inactive", "departed"]) {
    const { client, calls } = mock({
      role: "admin",
      status: "active",
      data: {
        ...mutationResult(),
        attempt: attempt({
          status: "superseded",
          startedAt: null,
          endedAt: "2026-09-08T01:00:00Z",
        }),
        profileStatus,
        capability: null,
      },
    });
    const response = await handleApiRequest(
      req("POST", `/v1/attempts/${attemptId}/lifecycle`, {
        ...command,
        expectedProfileVersion: 1,
        action: "expire_scheduled",
        payload: {},
        reasonCode: "SCHEDULE_EXPIRED",
      }),
      { createClients: () => client, authenticateRequest: authenticate },
    );
    const data = await response.json();
    assert(
      response.status === 400 && data.error.code === "VALIDATION_ERROR",
      "elapsed schedule cannot authorize superseding a task",
    );
    assert(
      !calls.some((call) => call.name === "manage_cleaning_attempt_lifecycle"),
      "retired action never reaches a mutation RPC",
    );
    if (profileStatus === "active") continue;
    for (const method of ["GET", "POST"]) {
      const disabled = mock({ status: profileStatus });
      const limitedResponse = await handleApiRequest(
        req(
          method,
          method === "GET"
            ? `/v1/limited/attempts/${attemptId}?assignmentRevision=3`
            : `/v1/limited/attempts/${attemptId}/complete-field-work`,
          method === "POST" ? command : undefined,
        ),
        {
          createClients: () => disabled.client,
          authenticateRequest: authenticate,
        },
      );
      assert(
        limitedResponse.status === 403,
        "disabled owner cannot use limited routes",
      );
      assert(
        !disabled.calls.some((call) =>
          call.name === "get_limited_cleaning_attempt" ||
          call.name === "complete_limited_cleaning_attempt_field_work"
        ),
        "no limited RPC for disabled actor",
      );
    }
  }
});

Deno.test("handover timestamps reject invalid raw calendars and normalized-day clock aliases before RPC", async () => {
  const payload = {
    maidProfileId: "10000000-0000-4000-8000-000000000002",
    sequenceNumber: 1,
    serviceDate: "2026-09-08",
    availableFrom: "2026-09-08T10:00:00+09:00",
    dueAt: "2026-09-08T12:00:00+09:00",
    deactivateOld: false,
  };
  for (
    const value of [
      "2026-02-30T10:00:00Z",
      "2026-09-08T24:00:00Z",
      "2026-09-08T10:00:00+25:00",
      "2026-09-08T10:60:00Z",
    ]
  ) {
    for (const key of ["availableFrom", "dueAt"]) {
      const { client, calls } = mock();
      const error = await failed(() =>
        manageAttemptLifecycle(
          req("POST", "/", {
            ...command,
            expectedProfileVersion: 1,
            action: "interrupt_handover",
            payload: { ...payload, [key]: value },
            reasonCode: "ADMIN_HANDOVER",
          }),
          client,
          admin,
          attemptId,
        )
      );
      assert(
        error.status === 400 && calls.length === 0,
        "invalid calendar/clock does not normalize into valid schedule",
      );
    }
  }
});

Deno.test("lifecycle database errors remain finite and raw SQL or sensitive values are redacted", () => {
  for (
    const code of [
      "ACCOUNT_VERSION_CONFLICT",
      "ASSIGNMENT_SCHEDULE_INVALID",
      "ASSIGNMENT_SEQUENCE_CONFLICT",
      "CLEANING_WINDOW_NOT_EXPIRED",
      "ROLLOVER_NOT_ALLOWED",
      "RECLEAN_MAID_IMMUTABLE",
      "ASSIGNMENT_MAID_UNAVAILABLE",
      "ASSIGNMENT_VERSION_CONFLICT",
      "ATTEMPT_VERSION_CONFLICT",
      "IDEMPOTENCY_KEY_REUSED",
    ]
  ) {
    const error = lifecycleDatabaseError({ message: code });
    assert(
      error.status === 409 && error.code === code,
      "known concurrency/lifecycle conflict preserved",
    );
  }
  assert(
    lifecycleDatabaseError({ message: "INVALID_ATTEMPT_COMMAND" }).status ===
      400,
    "DB input contract",
  );
  for (
    const message of [
      "raw SQL with PIN",
      `session ${sessionId}`,
      "service-role secret",
      "ATTEMPT_CAPABILITY_IMMUTABLE",
    ]
  ) {
    const error = lifecycleDatabaseError({ message });
    assert(
      error.status === 500 && error.code === "ATTEMPT_COMMAND_FAILED" &&
        !error.message.includes(message),
      "server invariant and raw details are not exposed",
    );
  }
});

Deno.test("limited identity preserves Auth/profile/session and never opens the ordinary active-only guard", async () => {
  for (const status of ["active", "deactivation_pending", "upload_only"]) {
    const { client, order } = mock({ status });
    const identity = await authenticateLimitedAttempt(req("GET", "/"), client);
    assert(
      identity.sessionId === sessionId && identity.actor.role === "maid",
      "DB role not JWT metadata",
    );
    assert(
      order.join(",") === "getUser,profile,is_active_auth_session",
      "verify before capability RPC",
    );
    assert(
      !JSON.stringify(identity.actor).includes(sessionId),
      "public actor contains no session identity",
    );
    if (status !== "active") {
      assert(
        (await failed(() => authenticate(req("GET", "/"), client))).code ===
          "ACCOUNT_INACTIVE",
        "ordinary routes remain closed",
      );
    }
  }
  for (
    const options of [
      { status: "inactive" },
      { status: "departed" },
      { role: "admin" },
      { role: "developer" },
      { password: true },
      { revoked: true },
      { authFailed: true },
    ]
  ) {
    const { client, calls } = mock(options);
    const error = await failed(() =>
      authenticateLimitedAttempt(req("GET", "/"), client)
    );
    assert([401, 403].includes(error.status), "invalid identity denied");
    assert(
      !calls.some((call) => call.name.includes("limited_cleaning")),
      "no capability command before identity verification",
    );
  }
});

Deno.test("false Auth session decisions stop ordinary and limited HTTP paths before business RPC or replay", async () => {
  const routes = [
    {
      role: "admin",
      status: "active",
      method: "GET",
      path: `/v1/attempts/lifecycle-impact?assignmentId=${assignmentId}`,
    },
    {
      role: "maid",
      status: "deactivation_pending",
      method: "GET",
      path: `/v1/limited/attempts/${attemptId}?assignmentRevision=3`,
    },
    {
      role: "maid",
      status: "deactivation_pending",
      method: "POST",
      path: `/v1/limited/attempts/${attemptId}/complete-field-work`,
      body: command,
    },
    {
      role: "maid",
      status: "upload_only",
      method: "POST",
      path: `/v1/attempts/${attemptId}/submissions`,
      body: {
        clientSubmissionId: "35200000-0000-4000-8000-000000000001",
        expectedRevision: 0,
        candleCount: 0,
      },
    },
  ];
  for (const route of routes) {
    const { client, calls } = mock({
      role: route.role,
      status: route.status,
      revoked: true,
    });
    const response = await handleApiRequest(
      req(route.method, route.path, route.body),
      { createClients: () => client, authenticateRequest: authenticate },
    );
    assert(response.status === 401, "expired/revoked session has stable 401");
    const body = await response.text();
    assert(
      JSON.parse(body).error.code === "SESSION_REVOKED",
      "Auth session helper failure remains fail-closed",
    );
    assert(
      calls.length === 1 && calls[0].name ===
          (route.status === "active"
            ? "get_active_auth_context"
            : "is_active_auth_session") &&
        calls[0].args.p_auth_user_id === maid.authUserId &&
        calls[0].args.p_session_id === sessionId,
      "no business RPC, new capability, or saved receipt replay after false",
    );
    assert(
      !body.includes(token) && !body.includes(sessionId),
      "public error excludes bearer and session identity",
    );
  }
});

Deno.test("admin lifecycle has strict action/reason/payload, profile CAS and internal session-bound RPC", async () => {
  const body = {
    ...command,
    expectedProfileVersion: 1,
    action: "allow_finish",
    payload: {},
    reasonCode: "DEACTIVATION_FINISH_CURRENT",
  };
  const { client, calls } = mock({
    data: { ...mutationResult(), sessionId, requestHash: "do-not-expose" },
  });
  const result = await manageAttemptLifecycle(
    req("POST", "/", body),
    client,
    admin,
    attemptId,
  );
  assert(
    calls[0].args.p_session_id === sessionId &&
      calls[0].args.p_expected_profile_version === 1,
    "session and profile CAS forwarded",
  );
  assert(
    !JSON.stringify(result).includes(sessionId) &&
      !JSON.stringify(result).includes("do-not-expose"),
    "internal values excluded",
  );
  const firstHash = calls[0].args.p_request_hash;
  await manageAttemptLifecycle(
    req("POST", "/", {
      reasonCode: body.reasonCode,
      payload: {},
      action: body.action,
      expectedProfileVersion: 1,
      ...command,
    }),
    client,
    admin,
    attemptId,
  );
  assert(firstHash === calls[1].args.p_request_hash, "canonical replay hash");
  for (
    const bad of [
      { ...body, payload: { token: "private" } },
      { ...body, reasonCode: "raw text" },
      { ...body, expectedProfileVersion: 0 },
      { ...body, allowedActions: ["start"] },
      { ...body, action: "create_token" },
    ]
  ) {
    const before = calls.length;
    assert(
      (await failed(() =>
            manageAttemptLifecycle(
              req("POST", "/", bad),
              client,
              admin,
              attemptId,
            )
          )).status === 400 && calls.length === before,
      "bad command rejected before RPC",
    );
  }
  for (const actor of [maid, { ...admin, role: "developer" as const }]) {
    assert(
      (await failed(() =>
        manageAttemptLifecycle(req("POST", "/", body), client, actor, attemptId)
      )).code === "ADMIN_REQUIRED",
      "business admin exact",
    );
  }
});

Deno.test("limited actual routes verify identities, drop raw fields, reject IDOR and preserve completion replay", async () => {
  const path = `/v1/limited/attempts/${attemptId}`;
  const { client, calls, order } = mock({
    data: { ...readResult(), requestHash: "private", token: "private" },
  });
  const deps = {
    createClients: () => client,
    authenticateRequest: authenticate,
  };
  const read = await handleApiRequest(
    req("GET", `${path}?assignmentRevision=3`),
    deps,
  );
  assert(
    read.status === 200 &&
      !JSON.stringify(await read.json()).includes("private"),
    "safe read",
  );
  assert(
    order.join(",") ===
      "getUser,profile,is_active_auth_session,get_limited_cleaning_attempt",
    "real routing dedicated identity before capability",
  );
  assert(
    calls[1].args.p_session_id === sessionId &&
      calls[1].args.p_assignment_revision === 3,
    "final RPC revalidates session and revision",
  );
  const completion = {
    ...mutationResult(),
    attempt: attempt({
      status: "field_completed",
      executionVersion: 3,
      fieldCompletedAt: "2026-09-08T01:00:00Z",
      endedAt: "2026-09-08T01:00:00Z",
    }),
    capability: cap("upload_submit"),
    profileStatus: "upload_only",
  };
  for (const status of ["deactivation_pending", "upload_only"]) {
    const { client: completionClient } = mock({ status, data: completion });
    const response = await handleApiRequest(
      req("POST", `${path}/complete-field-work`, command),
      {
        createClients: () => completionClient,
        authenticateRequest: authenticate,
      },
    );
    assert(
      response.status === 200 &&
        (await response.json()).attempt.executionVersion === 3,
      "lost-response retry may replay the existing receipt after state transition",
    );
  }
  for (
    const code of [
      "CAPABILITY_ACCESS_REQUIRED",
      "SESSION_REVOKED",
      "private SQL secret",
    ]
  ) {
    const { client: deniedClient, calls: deniedCalls } = mock({ code });
    const response = await handleApiRequest(
      req("POST", `${path}/complete-field-work`, command),
      { createClients: () => deniedClient, authenticateRequest: authenticate },
    );
    assert(
      response.status ===
        (code === "CAPABILITY_ACCESS_REQUIRED"
          ? 403
          : code === "SESSION_REVOKED"
          ? 401
          : 500),
      "transaction revalidation denies expired/cross/revoked",
    );
    const text = await response.text();
    assert(!text.includes("private SQL"), "no DB error leak");
    if (code === "CAPABILITY_ACCESS_REQUIRED") {
      assert(
        deniedCalls.at(-1)?.name === "record_authorization_denial",
        "bounded authorization denial logged",
      );
    }
  }
  const other = mock({
    data: {
      ...readResult(),
      attempt: attempt({
        maidProfileId: "10000000-0000-4000-8000-000000000099",
      }),
    },
  });
  const identity = await authenticateLimitedAttempt(
    req("GET", path),
    other.client,
  );
  assert(
    (await failed(() =>
      getLimitedAttempt(
        req("GET", `${path}?assignmentRevision=3`),
        other.client,
        identity,
        attemptId,
      )
    )).status === 500,
    "unexpected cross-actor response fail closed",
  );
});

Deno.test("limited unknown methods, fake photo/start routes and extra query/body cannot alias execution", async () => {
  const path = `/v1/limited/attempts/${attemptId}`;
  for (
    const [method, url, body] of [
      ["POST", path, command],
      ["GET", `${path}/complete-field-work`, undefined],
      ["POST", `${path}/start`, command],
      ["POST", `${path}/photos`, {}],
      ["POST", `${path}/submit`, {}],
      ["GET", `${path}/history`, undefined],
    ] as const
  ) {
    const { client, calls } = mock({ status: "active" });
    const response = await handleApiRequest(req(method, url, body), {
      createClients: () => client,
      authenticateRequest: authenticate,
    });
    assert(
      response.status === 404 &&
        (await response.json()).error.code === "ROUTE_NOT_FOUND",
      "no invented/aliased limited endpoint",
    );
    assert(
      calls.every((call) => call.name === "get_active_auth_context"),
      "no domain RPC",
    );
  }
  for (
    const url of [
      `${path}?assignmentRevision=3&token=secret`,
      `${path}?assignmentRevision=3&assignmentRevision=3`,
    ]
  ) {
    const { client, calls } = mock();
    const response = await handleApiRequest(req("GET", url), {
      createClients: () => client,
      authenticateRequest: authenticate,
    });
    assert(
      response.status === 400 &&
        !calls.some((call) => call.name === "get_limited_cleaning_attempt"),
      "strict read query",
    );
  }
  for (
    const extra of [
      { sessionId },
      { capabilityToken: "secret" },
      { clientTime: "2026-09-08" },
      { PIN: "1234" },
      { action: "start" },
    ]
  ) {
    const { client, calls } = mock();
    const response = await handleApiRequest(
      req("POST", `${path}/complete-field-work`, { ...command, ...extra }),
      { createClients: () => client, authenticateRequest: authenticate },
    );
    assert(
      response.status === 400 &&
        !calls.some((call) =>
          call.name === "complete_limited_cleaning_attempt_field_work"
        ),
      "server-owned sensitive claims cannot enter RPC/hash",
    );
  }
});

function discovery() {
  return {
    profileStatus: "deactivation_pending",
    evaluatedAt: "2026-09-08T01:00:00.000001Z",
    items: [{
      attemptId,
      assignmentId,
      assignmentRevision: 3,
      executionVersion: 2,
      status: "in_progress",
      kind: "finish_current",
      allowedActions: ["complete_field_work"],
      issuedAt: "2026-09-08T00:00:00Z",
      expiresAt: "2026-09-08T02:00:00Z",
    }],
  };
}

Deno.test("limited discovery real router verifies the existing session, uses exact RPC args and redacts all private fields", async () => {
  const expected = discovery();
  const { client, calls, order } = mock({
    data: {
      ...expected,
      sessionId,
      roomNumber: "private",
      items: [{
        ...expected.items[0],
        pin: "private",
        capabilityId: "private",
        guestName: "private",
        sessionDigest: "private",
      }],
    },
  });
  const response = await handleApiRequest(req("GET", "/v1/limited/attempts"), {
    createClients: () => client,
    authenticateRequest: () => {
      throw new Error("ordinary active guard must not run");
    },
  });
  const body = await response.json();
  assert(
    response.status === 200 &&
      response.headers.get("cache-control") === "no-store",
    "safe non-cacheable success",
  );
  assert(
    JSON.stringify(body) === JSON.stringify(expected) &&
      Object.keys(body.items[0]).length === 9,
    "exact bounded public fields",
  );
  assert(
    order.join(",") ===
      "getUser,profile,is_active_auth_session,list_limited_cleaning_attempts",
    "Auth and DB profile before discovery",
  );
  assert(
    JSON.stringify(calls[1]) ===
      JSON.stringify({
        name: "list_limited_cleaning_attempts",
        args: { p_actor_profile_id: maid.profileId, p_session_id: sessionId },
      }),
    "only verified actor and original session",
  );
  const empty = mock({ data: { ...expected, items: [] } });
  const result = await handleApiRequest(req("GET", "/v1/limited/attempts"), {
    createClients: () => empty.client,
    authenticateRequest: authenticate,
  });
  assert(
    result.status === 200 && (await result.json()).items.length === 0,
    "eligible without a live grant is empty, not a new grant",
  );
});

Deno.test("limited discovery denies invalid identities before business RPC and preserves late SQL status decisions", async () => {
  for (
    const options of [
      { role: "admin" },
      { role: "developer" },
      { status: "inactive" },
      { status: "departed" },
      { password: true },
      { revoked: true },
      { authFailed: true },
    ]
  ) {
    const { client, calls } = mock(options);
    const response = await handleApiRequest(
      req("GET", "/v1/limited/attempts"),
      { createClients: () => client, authenticateRequest: authenticate },
    );
    assert(
      [401, 403].includes(response.status) &&
        response.headers.get("cache-control") === "no-store",
      "identity denial is stable and not cacheable",
    );
    assert(
      !calls.some((call) => call.name === "list_limited_cleaning_attempts"),
      "no discovery before verified existing session",
    );
  }
  for (
    const [code, status] of [
      ["CAPABILITY_ACCESS_REQUIRED", 403],
      ["SESSION_REVOKED", 401],
      ["PASSWORD_CHANGE_REQUIRED", 403],
      ["LIMITED_DISCOVERY_LIMIT_EXCEEDED", 500],
      ["LIMITED_SESSION_LIMIT_EXCEEDED", 500],
    ] as const
  ) {
    const { client } = mock({ code });
    const response = await handleApiRequest(
      req("GET", "/v1/limited/attempts"),
      { createClients: () => client, authenticateRequest: authenticate },
    );
    const body = await response.text();
    assert(
      response.status === status && JSON.parse(body).error.code === code &&
        response.headers.get("cache-control") === "no-store",
      "transaction decision kept finite",
    );
    assert(
      !body.includes(token) && !body.includes(sessionId),
      "identity secrets redacted from denial",
    );
  }
});

Deno.test("limited discovery missing bearer and canonical aliases fail before Auth, never enabling unbound fallback", async () => {
  for (
    const path of [
      "/v1/%6cimited/attempts",
      "/v1/limited/%61ttempts",
      "/v1/limited/attempts/",
      "/v1//limited/attempts",
    ]
  ) {
    const { client, order } = mock();
    const response = await handleApiRequest(
      new Request(`https://example.invalid/functions/v1/api${path}`),
      { createClients: () => client, authenticateRequest: authenticate },
    );
    assert(
      response.status === 404 &&
        response.headers.get("cache-control") === "no-store" &&
        order.length === 0,
      "canonical limited paths reject aliases without auth",
    );
  }
  const { client, order } = mock();
  const missing = await handleApiRequest(
    new Request("https://example.invalid/functions/v1/api/v1/limited/attempts"),
    { createClients: () => client, authenticateRequest: authenticate },
  );
  assert(
    missing.status === 401 && order.length === 0 &&
      missing.headers.get("cache-control") === "no-store",
    "missing bearer no business or Auth lookup",
  );
});

Deno.test("limited discovery rejects query and malformed, duplicated, oversized or non-live DB projections without partial data", async () => {
  for (const query of ["?limit=1", "?cursor=private", "?sessionId=private"]) {
    const { client, calls } = mock({ data: discovery() });
    const response = await handleApiRequest(
      req("GET", `/v1/limited/attempts${query}`),
      { createClients: () => client, authenticateRequest: authenticate },
    );
    assert(
      response.status === 400 &&
        !calls.some((call) => call.name === "list_limited_cleaning_attempts"),
      "fixed server bound, no client scope",
    );
  }
  const first = discovery().items[0];
  for (
    const data of [
      { ...discovery(), profileStatus: "upload_only", items: [] },
      { ...discovery(), profileStatus: ["deactivation_pending"] },
      { ...discovery(), profileStatus: {} },
      { ...discovery(), items: [first, first] },
      { ...discovery(), items: [{ ...first, executionVersion: "2" }] },
      {
        ...discovery(),
        profileStatus: "upload_only",
        items: [{
          ...first,
          status: ["upload_pending"],
          kind: "upload_submit",
          allowedActions: ["upload_evidence", "validate_evidence", "submit"],
        }],
      },
      { ...discovery(), items: [{ ...first, status: {} }] },
      {
        ...discovery(),
        items: [{ ...first, expiresAt: discovery().evaluatedAt }],
      },
      { ...discovery(), items: Array.from({ length: 1001 }, () => first) },
    ]
  ) {
    const { client } = mock({ data });
    const response = await handleApiRequest(
      req("GET", "/v1/limited/attempts"),
      { createClients: () => client, authenticateRequest: authenticate },
    );
    const text = await response.text();
    assert(
      response.status === 500 && !text.includes(attemptId) &&
        response.headers.get("cache-control") === "no-store",
      "bad projection fails closed without partial list",
    );
  }
});

Deno.test("limited completion executes the Node shared receipt hash vector and preserves receipt replay after profile transition", async () => {
  const id = (n: number) =>
    `69000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const actor = { ...maid, profileId: id(90) };
  const data = {
    ...mutationResult(),
    attempt: attempt({
      attemptId: id(1),
      assignmentId: id(2),
      maidProfileId: id(90),
      status: "field_completed",
      executionVersion: 3,
      fieldCompletedAt: "2026-09-08T01:00:00Z",
      endedAt: "2026-09-08T01:00:00Z",
    }),
    capability: {
      ...cap("upload_submit"),
      attemptId: id(1),
      assignmentId: id(2),
    },
    profileStatus: "upload_only",
    profileVersion: 2,
  };
  const { client, calls } = mock({ data });
  for (
    const profileStatus of ["deactivation_pending", "upload_only"] as const
  ) {
    await completeLimitedAttempt(
      req("POST", "/", {
        expectedAssignmentRevision: 3,
        expectedAssignmentId: id(2),
        expectedExecutionVersion: 2,
      }),
      client,
      { actor, profileStatus, sessionId: id(91) },
      id(1),
    );
  }
  assert(
    calls.length === 2 &&
      calls.every((call) =>
        call.name === "complete_limited_cleaning_attempt_field_work" &&
        call.args.p_actor_profile_id === id(90) &&
        call.args.p_session_id === id(91) &&
        call.args.p_request_hash ===
          "49248f20339b56cca0f12f12f3d26afe64f48194996bc92d2e0716e7531644e3"
      ),
    "actual Edge and actual Node hash vector are identical despite JSON property order/profile transition",
  );
});

Deno.test("limited single DTO keeps strict string parity for profile status and capability kind without coercion", async () => {
  for (
    const data of [
      { ...readResult(), profileStatus: ["deactivation_pending"] },
      { ...readResult(), profileStatus: {} },
      { ...readResult(), capability: { ...cap(), kind: ["finish_current"] } },
      { ...readResult(), capability: { ...cap(), kind: {} } },
      { ...readResult(), attempt: attempt({ status: ["in_progress"] }) },
      { ...readResult(), attempt: attempt({ status: {} }) },
    ]
  ) {
    const { client } = mock({ data });
    const response = await handleApiRequest(
      req("GET", `/v1/limited/attempts/${attemptId}?assignmentRevision=3`),
      { createClients: () => client, authenticateRequest: authenticate },
    );
    const text = await response.text();
    assert(
      response.status === 500 && !text.includes(attemptId) &&
        response.headers.get("cache-control") === "no-store",
      "malformed field types fail closed instead of returning array/object DTOs",
    );
  }
});
