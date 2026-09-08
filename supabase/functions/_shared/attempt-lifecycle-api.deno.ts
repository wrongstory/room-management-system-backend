import { handleApiRequest } from "../api/index.ts";
import {
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
      "expire_scheduled",
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
      : action === "expire_scheduled"
      ? "SCHEDULE_EXPIRED"
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

Deno.test("admin expiry preserves inactive or departed owners without granting limited access", async () => {
  for (const profileStatus of ["inactive", "departed"]) {
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
      response.status === 200 && data.profileStatus === profileStatus &&
        data.capability === null && data.nextAttempt === null &&
        data.attempt.status === "superseded",
      "admin preserves disabled owner and superseded history with no new grant",
    );
    assert(
      calls.at(-1)?.name === "manage_cleaning_attempt_lifecycle",
      "only trusted lifecycle command",
    );
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
      calls.every((call) => call.name === "is_active_auth_session"),
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
