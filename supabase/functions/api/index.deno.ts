import { type ApiHandlerDependencies, handleApiRequest } from "./index.ts";
import type { EdgeActor, EdgeClients } from "../_shared/runtime.ts";
import { EdgeError } from "../_shared/runtime.ts";

Deno.test("preview exact routes: admin success is read-only, other roles denied and inactive/revoked authentication fails", async () => {
  const calls: string[] = [];
  const serviceDate = new Date(Date.now() + 9 * 3600000).toISOString().slice(
    0,
    10,
  );
  const clients = {
    admin: {
      rpc: (name: string) => {
        calls.push(name);
        return Promise.resolve({
          error: null,
          data: name === "get_assignment_preview_snapshot"
            ? {
              serviceDate,
              planningAt: new Date().toISOString(),
              durationPolicy: {
                version: 1,
                status: "confirmed",
                standardMinutes: 30,
                premiumMinutes: 40,
                oceanPremiumMinutes: 50,
                oceanFamilyMinutes: 60,
              },
              maids: [],
              targets: [],
            }
            : null,
        });
      },
    },
  } as unknown as EdgeClients;
  const dependencies: ApiHandlerDependencies = {
    createClients: () => clients,
    authenticateRequest: () => Promise.resolve(actor),
  };
  const path = "/v1/assignments/preview";
  const success = await handleApiRequest(
    request("POST", path, { serviceDate }),
    dependencies,
  );
  const data = await success.json();
  assert(
    success.status === 200 && data.decisionReady === true &&
      data.proposedAssignments.length === 0,
    "admin preview successful",
  );
  assert(/^[a-f0-9-]{36}$/.test(data.previewSeed), "server UUID default seed");
  assert(
    calls.join(",") === "get_assignment_preview_snapshot",
    "successful preview no ledger write RPC",
  );
  const unavailable = await handleApiRequest(
    request("POST", path, { serviceDate }),
    {
      ...dependencies,
      createClients: () => ({
        admin: {
          rpc: () =>
            Promise.resolve({
              data: null,
              error: {
                message: "ASSIGNMENT_PREVIEW_DURATION_POLICY_UNCONFIRMED",
              },
            }),
        },
      } as unknown as EdgeClients),
    },
  );
  const unavailableBody = await unavailable.json();
  assert(
    unavailable.status === 409 && unavailableBody.decisionReady === false &&
      unavailableBody.proposedAssignments.length === 0 &&
      unavailableBody.error.code ===
        "ASSIGNMENT_PREVIEW_DURATION_POLICY_UNCONFIRMED",
    "HTTP unconfirmed fails closed without success proposals",
  );
  for (const role of ["maid", "developer"] as const) {
    const res = await handleApiRequest(request("POST", path, { serviceDate }), {
      ...dependencies,
      authenticateRequest: () => Promise.resolve({ ...actor, role }),
    });
    assert(
      res.status === 403 && (await res.json()).error.code === "ADMIN_REQUIRED",
      "business roles enforced",
    );
  }
  assert(
    calls.filter((x) => x === "record_authorization_denial").length === 2,
    "denials preserve bounded security recording",
  );
  for (const code of ["PROFILE_INACTIVE", "SESSION_REVOKED"]) {
    const res = await handleApiRequest(request("POST", path, { serviceDate }), {
      ...dependencies,
      authenticateRequest: () =>
        Promise.reject(new EdgeError(403, code, "접근 불가")),
    });
    assert(res.status === 403, "inactive/revoked rejected before route");
  }
  for (
    const [method, url] of [["GET", path], ["POST", `${path}/extra`], [
      "PUT",
      "/v1/assignment-preview/duration-policy",
    ]]
  ) {
    const res = await handleApiRequest(
      request(method, url, method === "GET" ? undefined : { serviceDate }),
      dependencies,
    );
    assert(res.status === 404, "no method/path alias");
  }
  const config = await handleApiRequest(
    request("GET", "/v1/assignment-preview/duration-policy"),
    dependencies,
  );
  assert(
    config.status === 200 && (await config.json()).durationPolicy === null,
    "unconfirmed config remains null",
  );
});

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const actor: EdgeActor = {
  authUserId: "10000000-0000-4000-8000-000000000001",
  profileId: "20000000-0000-4000-8000-000000000001",
  displayName: "운영 관리자",
  role: "admin",
  mustChangePassword: false,
};
const roomId = "30000000-0000-4000-8000-000000000001";
const roomTypeId = "40000000-0000-4000-8000-000000000001";
const blockId = "50000000-0000-4000-8000-000000000001";
const issueId = "60000000-0000-4000-8000-000000000001";
const assignmentId = "70000000-0000-4000-8000-000000000001";
const cleaningTargetId = "80000000-0000-4000-8000-000000000001";
const impactFingerprint = "a".repeat(64);

Deno.test("attempt exact HTTP routes preserve maid-only CAS, denial logging and physical completion boundary", async () => {
  const attemptId = "90000000-0000-4000-8000-000000000001";
  const maid: EdgeActor = { ...actor, role: "maid" };
  const body = {
    expectedAssignmentId: assignmentId,
    expectedAssignmentRevision: 2,
    expectedExecutionVersion: 1,
  };
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let dbError: string | null = null;
  const clients = {
    admin: {
      rpc: (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        if (name === "record_authorization_denial") {
          return Promise.resolve({
            data: null,
            error: null,
          });
        }
        if (dbError) {
          return Promise.resolve({
            data: null,
            error: { message: dbError },
          });
        }
        const status = name === "get_current_cleaning_attempt"
          ? "scheduled"
          : name === "start_cleaning_attempt"
          ? "in_progress"
          : "field_completed";
        return Promise.resolve({
          error: null,
          data: {
            attemptId,
            cleaningTargetId,
            assignmentId,
            maidProfileId: maid.profileId,
            assignmentRevision: 2,
            executionVersion: status === "scheduled" ? 1 : 2,
            status,
            startedAt: status === "scheduled" ? null : "2026-09-08T06:00:00Z",
            fieldCompletedAt: status === "field_completed"
              ? "2026-09-09T00:00:00Z"
              : null,
            endedAt: null,
            effectiveAt: "2026-09-09T00:00:00Z",
            recordedAt: "2026-09-09T00:00:00Z",
            rawPhotoSnapshot: { secret: "not-public" },
          },
        });
      },
    },
  } as unknown as EdgeClients;
  const dependencies: ApiHandlerDependencies = {
    createClients: () => clients,
    authenticateRequest: () => Promise.resolve(maid),
  };
  const routes = [
    {
      method: "GET",
      path: `/v1/attempts/current?assignmentId=${assignmentId}`,
      status: "scheduled",
      body: undefined,
    },
    {
      method: "POST",
      path: `/v1/attempts/${attemptId}/start`,
      status: "in_progress",
      body,
    },
    {
      method: "POST",
      path: `/v1/attempts/${attemptId}/complete-field-work`,
      status: "field_completed",
      body,
    },
  ];
  for (const route of routes) {
    const response = await handleApiRequest(
      request(route.method, route.path, route.body),
      dependencies,
    );
    const json = await response.json();
    assert(
      response.status === 200 && json.attempt.status === route.status,
      "exact route dispatch",
    );
    assert(
      !JSON.stringify(json).includes("not-public") &&
        !JSON.stringify(json).includes("roomReady"),
      "no photo/raw state or room-ready projection",
    );
  }
  assert(
    calls.length === 3 &&
      calls.every((call) => call.args.p_actor_profile_id === maid.profileId),
    "only own business RPC, no fake submission/lease",
  );
  for (const role of ["admin", "developer"] as const) {
    for (const route of routes) {
      const before: number = calls.length;
      const response = await handleApiRequest(
        request(route.method, route.path, route.body),
        {
          ...dependencies,
          authenticateRequest: () => Promise.resolve({ ...maid, role }),
        },
      );
      assert(
        response.status === 403 &&
          (await response.json()).error.code === "MAID_REQUIRED",
        "no operator bypass",
      );
      assert(
        calls.length === before + 1 &&
          calls.at(-1)?.name === "record_authorization_denial" &&
          calls.at(-1)?.args.p_source === "edge.authorization.attempts",
        "bounded capability denial source",
      );
    }
  }
  for (const code of ["ACCOUNT_INACTIVE", "SESSION_REVOKED"]) {
    const before: number = calls.length;
    const response = await handleApiRequest(
      request("POST", routes[1].path, body),
      {
        ...dependencies,
        authenticateRequest: () =>
          Promise.reject(new EdgeError(403, code, "차단")),
      },
    );
    assert(
      response.status === 403 && calls.length === before,
      "inactive/limited/revoked auth never enters business RPC",
    );
  }
  dbError = "ATTEMPT_ACCESS_REQUIRED";
  const denied = await handleApiRequest(
    request("POST", routes[1].path, body),
    dependencies,
  );
  assert(
    denied.status === 403 &&
      calls.at(-1)?.args.p_reason_code === "ATTEMPT_ACCESS_REQUIRED",
    "other maid denial recorded without request payload",
  );
  const before = calls.length;
  for (
    const [method, path] of [
      ["GET", routes[1].path],
      ["POST", "/v1/attempts/current"],
      ["PUT", routes[2].path],
      ["POST", `${routes[1].path}/extra`],
      ["GET", "/v1/attempts"],
      ["POST", `/v1/attempts/${attemptId}/claim`],
    ]
  ) {
    const response = await handleApiRequest(
      request(method, path, method === "GET" ? undefined : body),
      dependencies,
    );
    assert(
      response.status === 404 &&
        (await response.json()).error.code === "ROUTE_NOT_FOUND",
      "wrong method/path has no alias",
    );
  }
  assert(calls.length === before, "unknown routes never mutate");
});

Deno.test("assignment GET routes expose only own notified revisions and preserve superseded history", async () => {
  function readRequest(path: string) {
    const result = request("GET", path);
    result.headers.set("authorization", "Bearer synthetic-assignment-test");
    return result;
  }
  const maid = { ...actor, role: "maid" as const };
  const ownPast = "70000000-0000-4000-8000-000000000010";
  const otherId = "20000000-0000-4000-8000-000000000002";
  const base = {
    cleaning_target_id: cleaningTargetId,
    maid_profile_id: maid.profileId,
    service_date: "2026-09-04",
    sequence_number: 1,
    revision: 2,
    is_current: true,
    available_from_snapshot: "2026-09-04T01:00:00Z",
    due_at_snapshot: "2026-09-04T06:00:00Z",
    notified_at: "2026-09-03T12:00:00Z",
    notified_room_id_snapshot: "30000000-0000-4000-8000-000000000009" as
      | string
      | null,
    notified_room_number_snapshot: "109" as string | null,
    ended_at: null,
    created_at: "2026-09-03T10:00:00Z",
  };
  const rows = [
    { ...base, id: ownPast, is_current: false, revision: 1 },
    { ...base, id: assignmentId },
    { ...base, id: "70000000-0000-4000-8000-000000000011", notified_at: null },
    {
      ...base,
      id: "70000000-0000-4000-8000-000000000012",
      maid_profile_id: otherId,
    },
  ];
  const queries: Array<Array<string>> = [];
  function query(data: Array<Record<string, unknown>>) {
    const conditions: Array<(row: Record<string, unknown>) => boolean> = [];
    const filters: string[] = [];
    queries.push(filters);
    const builder = {
      select: (_columns: string) => builder,
      eq: (key: string, value: unknown) => {
        filters.push(`eq:${key}`);
        conditions.push((row) => row[key] === value);
        return builder;
      },
      not: (key: string, operator: string, value: unknown) => {
        assert(
          operator === "is" && value === null,
          "exact PostgREST non-null filter",
        );
        filters.push(`not:${key}`);
        conditions.push((row) => row[key] !== null);
        return builder;
      },
      in: (_key: string, _values: unknown[]) => builder,
      order: (_key: string) => builder,
      // biome-ignore lint/suspicious/noThenProperty: PostgREST의 lazy thenable을 재현하여 await 시점에 누적된 RLS 대체 필터를 검사한다.
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve({
          data: data.filter((row) =>
            conditions.every((condition) => condition(row))
          ),
          error: null,
        }).then(resolve),
    };
    return builder;
  }
  const clients = {
    forAccessToken: () => ({ from: () => query(rows) }),
    admin: {
      from: (table: string) =>
        query(
          table === "cleaning_targets"
            ? [{
              id: cleaningTargetId,
              room_id: roomId,
              assignment_version: 999,
              rooms: { room_number: "101" },
            }]
            : [{ id: maid.profileId, display_name: "메이드" }],
        ),
      rpc: () => Promise.resolve({ data: null, error: null }),
    },
  } as unknown as EdgeClients;
  const dependencies: ApiHandlerDependencies = {
    createClients: () => clients,
    authenticateRequest: () => Promise.resolve(maid),
  };
  for (
    const [path, count] of [
      ["/v1/assignments?serviceDate=2026-09-04", 1],
      ["/v1/assignments?serviceDate=2026-09-04&includeHistory=true", 2],
      [`/v1/assignments/${cleaningTargetId}/history`, 2],
    ] as const
  ) {
    const offset = queries.length;
    const response = await handleApiRequest(readRequest(path), dependencies);
    const body = await response.json();
    assert(
      response.status === 200 && body.assignments.length === count,
      "HTTP visible row count",
    );
    assert(
      queries[offset].includes("eq:maid_profile_id") &&
        queries[offset].includes("not:notified_at"),
      "route sends self and notified filters",
    );
    assert(
      body.assignments.every((row: Record<string, unknown>) =>
        row.notifiedAt !== null && row.maidProfileId === maid.profileId &&
        row.targetAssignmentVersion !== 999 &&
        row.roomId === base.notified_room_id_snapshot &&
        row.roomNumber === "109"
      ),
      "no unpublished, other owner, or current target version",
    );
    if (count === 2) {
      assert(
        body.assignments[0].assignmentId === ownPast,
        "past notified revision remains readable",
      );
    }
  }
  rows[0].notified_room_id_snapshot = null;
  rows[0].notified_room_number_snapshot = null;
  const legacy = await handleApiRequest(
    readRequest(`/v1/assignments/${cleaningTargetId}/history`),
    dependencies,
  );
  const legacyBody = await legacy.json();
  assert(
    legacy.status === 200 && legacyBody.assignments[0].roomId === null &&
      legacyBody.assignments[0].roomNumber === null,
    "legacy notified history never falls back to a new unpublished room",
  );
  rows.splice(0, 2);
  const denied = await handleApiRequest(
    readRequest(`/v1/assignments/${cleaningTargetId}/history`),
    dependencies,
  );
  assert(
    denied.status === 403 &&
      (await denied.json()).error.code === "ASSIGNMENT_ACCESS_REQUIRED",
    "never-notified-only history denied",
  );
  const adminResponse = await handleApiRequest(
    readRequest(
      "/v1/assignments?serviceDate=2026-09-04&includeHistory=true",
    ),
    {
      ...dependencies,
      authenticateRequest: () => Promise.resolve(actor),
      createClients: () => ({
        ...clients,
        admin: {
          ...clients.admin,
          from: (table: string) =>
            query(
              table === "cleaning_targets"
                ? [{
                  id: cleaningTargetId,
                  room_id: roomId,
                  assignment_version: 999,
                  rooms: { room_number: "101" },
                }]
                : [{ id: maid.profileId, display_name: "메이드" }, {
                  id: otherId,
                  display_name: "다른 메이드",
                }],
            ),
        },
      } as unknown as EdgeClients),
    },
  );
  assert(
    adminResponse.status === 200 &&
      (await adminResponse.json()).assignments.length === 2,
    "admin draft and other maid visibility preserved",
  );
});

Deno.test("prestart routes dispatch only exact methods and reject developer capability", async () => {
  const paths = [
    `/v1/assignments/${cleaningTargetId}/change`,
    `/v1/assignments/${cleaningTargetId}/unassign`,
    `/v1/assignments/${cleaningTargetId}/cancellation-requests`,
    `/v1/assignment-change-requests/${assignmentId}/decision`,
  ];
  const calls: string[] = [];
  const clients = {
    admin: {
      rpc: async (name: string) => {
        calls.push(name);
        if (name === "record_authorization_denial") {
          return { data: null, error: null };
        }
        return { data: null, error: { message: "ASSIGNMENT_ALREADY_STARTED" } };
      },
    },
  } as unknown as EdgeClients;
  for (const path of paths) {
    const role = path.endsWith("/cancellation-requests") ? "maid" : "admin";
    const deps = {
      createClients: () => clients,
      authenticateRequest: () =>
        Promise.resolve({ ...actor, role } as EdgeActor),
    };
    const body = {
      expectedCurrentAssignmentId: assignmentId,
      expectedAssignmentVersion: 2,
      reasonCode: "OPERATIONAL_CHANGE",
      ...(path.endsWith("/change")
        ? { maidProfileId: actor.profileId, sequenceNumber: 1 }
        : {}),
      ...(path.endsWith("/decision") ? { decision: "approved" } : {}),
    };
    const response = await handleApiRequest(request("POST", path, body), deps);
    assert(
      response.status === 409 &&
        (await response.json()).error.code === "ASSIGNMENT_ALREADY_STARTED",
      "exact route calls guarded RPC",
    );
    for (const [method, route] of [["GET", path], ["POST", `${path}/extra`]]) {
      const res = await handleApiRequest(
        request(method, route, method === "POST" ? body : undefined),
        deps,
      );
      assert(res.status === 404, "method/suffix mismatch not an alias");
    }
    const forbidden = await handleApiRequest(request("POST", path, body), {
      ...deps,
      authenticateRequest: () =>
        Promise.resolve({ ...actor, role: "developer" }),
    });
    assert(forbidden.status === 403, "developer forbidden");
  }
  assert(
    calls.filter((name) => name !== "record_authorization_denial").length === 4,
    "only four exact mutations invoked",
  );
});
const roomRow = {
  id: roomId,
  room_number: "101",
  room_type_code: "standard",
  room_type_name: "스탠다드 더블 로프트",
  elevator_zone: "A",
  data_status: "verified",
  state_version: 3,
  occupied: false,
  cleaning_required: false,
  candle_count: 0,
  pin_sync_status: "verified",
  allocation_blocked: false,
  allocation_ready: true,
  reason_codes: [],
};

function routeDependencies(calls: string[]): ApiHandlerDependencies {
  const clients = {
    admin: {
      async rpc(name: string, args: Record<string, unknown>) {
        calls.push(name);
        if (name === "get_room_operational_projection") {
          return { data: [roomRow], error: null };
        }
        if (name === "change_room_master_data") {
          return { data: null, error: null };
        }
        if (name === "get_assignment_commit_impact") {
          return {
            data: {
              serviceDate: "2026-09-04",
              impactFingerprint,
              committableDrafts: [],
              blockedDrafts: [],
              remainingUnassignedTargets: [],
            },
            error: null,
          };
        }
        if (name === "commit_and_notify_assignments") {
          return {
            data: {
              serviceDate: "2026-09-04",
              impactFingerprint,
              notifiedAssignments: [],
              remainingDrafts: [],
              blockedDrafts: [],
              unassignedTargets: [],
            },
            error: null,
          };
        }
        const payload = args.p_payload as Record<string, unknown>;
        return {
          data: {
            entity_id: payload.entityId,
            room_id: args.p_room_id,
            room_state_version: Number(args.p_expected_room_version) + 1,
            recorded_at: "2026-09-01T00:00:00Z",
          },
          error: null,
        };
      },
    },
  } as unknown as EdgeClients;
  return {
    createClients: () => clients,
    authenticateRequest: () => Promise.resolve(actor),
  };
}

function request(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Request {
  return new Request(`http://localhost/functions/v1/api${path}`, {
    method,
    headers: body
      ? {
        "content-type": "application/json",
        "idempotency-key": "room-route-regression-0001",
      }
      : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function errorCode(response: Response): Promise<string | undefined> {
  const payload = await response.json() as { error?: { code?: string } };
  return payload.error?.code;
}

Deno.test("limited upload_only submission route uses capability auth and preserves stable denial responses", async () => {
  const attemptId = "93000000-0000-4000-8000-000000000001";
  const submissionId = "93000000-0000-4000-8000-000000000002";
  const maid: EdgeActor = { ...actor, role: "maid" };
  const body = {
    clientSubmissionId: submissionId,
    expectedRevision: 0,
    candleCount: 0,
  };
  const route = `/v1/attempts/${attemptId}/submissions`;
  const successCalls: string[] = [];
  const successClients = {
    admin: {
      rpc(name: string) {
        successCalls.push(name);
        return Promise.resolve({
          data: name === "create_cleaning_submission"
            ? {
              id: submissionId,
              attemptId,
              version: 1,
              status: "submitted",
              currentRevision: 1,
              current: true,
            }
            : null,
          error: null,
        });
      },
    },
  } as unknown as EdgeClients;
  const success = await handleApiRequest(request("POST", route, body), {
    createClients: () => successClients,
    authenticateRequest: () => {
      throw new Error("active-only authentication must not run for submit");
    },
    authenticateLimitedRequest: () =>
      Promise.resolve({
        actor: maid,
        sessionId: "93000000-0000-4000-8000-000000000003",
        profileStatus: "upload_only",
      }),
  });
  assert(success.status === 201, "live upload_submit route succeeds");
  assert(
    successCalls.join(",") === "create_cleaning_submission",
    "limited route delegates exact capability decision to submission RPC",
  );

  for (
    const fixture of [
      "missing",
      "expired",
      "revoked",
      "evidence-only",
      "deactivation-pending",
    ]
  ) {
    const calls: string[] = [];
    const denialCode = fixture === "deactivation-pending"
      ? "SUBMISSION_ACCESS_REQUIRED"
      : "CAPABILITY_ACCESS_REQUIRED";
    const deniedClients = {
      admin: {
        rpc(name: string) {
          calls.push(name);
          return Promise.resolve(
            name === "record_authorization_denial"
              ? { data: null, error: null }
              : {
                data: null,
                error: { message: denialCode },
              },
          );
        },
      },
    } as unknown as EdgeClients;
    const denied = await handleApiRequest(request("POST", route, body), {
      createClients: () => deniedClients,
      authenticateRequest: () => Promise.resolve(actor),
      authenticateLimitedRequest: () =>
        Promise.resolve({
          actor: maid,
          sessionId: "93000000-0000-4000-8000-000000000003",
          profileStatus: fixture === "deactivation-pending"
            ? "deactivation_pending"
            : "upload_only",
        }),
    });
    assert(denied.status === 403, `${fixture} capability returns 403`);
    assert(
      await errorCode(denied) === denialCode,
      `${fixture} capability keeps the stable code`,
    );
    assert(
      calls.join(",") ===
        "create_cleaning_submission,record_authorization_denial",
      `${fixture} denial is bounded without replacing the intended response`,
    );
  }
});

Deno.test("payroll exact routes preserve reader/admin roles, IDOR and denial activity", async () => {
  const maidProfileId = "95000000-0000-4000-8000-000000000001";
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const payroll = {
    cycleId: null,
    maidProfileId,
    weekStart: "2026-08-24",
    status: "open",
    version: 0,
    lockedAmount: null,
    paymentStartedAt: null,
    itemCount: 0,
    totalAmount: 0,
    items: [],
    itemsHasMore: false,
    itemsLastEarnedOn: null,
    itemsLastEarningId: null,
    lateEarningCount: 0,
    lateEarningAmount: 0,
    lateEarnings: [],
    lateEarningsHasMore: false,
    lateEarningsLastEarnedOn: null,
    lateEarningsLastEarningId: null,
    offsetSettled: false,
    adjustmentAmount: 0,
    carryInAmount: 0,
    carryOutAmount: 0,
    payableAmount: 30000,
    adjustmentCount: 0,
    paymentAttemptId: null,
    paymentAttemptNumber: null,
    paidAt: null,
    checkReasonCode: null,
    lastReopenReasonCode: null,
  };
  const clients = {
    admin: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return Promise.resolve({
          data: name === "list_payroll_cycles_page"
            ? {
              payroll: [payroll],
              hasMore: false,
              lastMaidProfileId: maidProfileId,
            }
            : name.startsWith("record_payroll_payment_") ||
                name === "reopen_payroll_payment_attempt"
            ? {
              paymentResultId: "96000000-0000-4000-8000-000000000003",
              paymentAttemptId: "96000000-0000-4000-8000-000000000002",
              payrollCycleId: "96000000-0000-4000-8000-000000000001",
              resultType: "paid",
              beforeStatus: "paying",
              afterStatus: "paid",
              cycleVersion: 2,
              lockedAmount: 30000,
              paymentMethod: "bank_transfer",
              providerReferenceId: "BANK.AB12",
              occurredAt: "2026-09-10T00:00:00Z",
            }
            : {
              ...payroll,
              cycleId: "96000000-0000-4000-8000-000000000001",
              status: "paying",
              version: 1,
              lockedAmount: 30000,
              paymentStartedAt: "2026-09-10T00:00:00Z",
            },
          error: null,
        });
      },
    },
  } as unknown as EdgeClients;
  const dependencies: ApiHandlerDependencies = {
    createClients: () => clients,
    authenticateRequest: () => Promise.resolve(actor),
  };

  const listed = await handleApiRequest(
    request("GET", "/v1/payroll?weekStart=2026-08-24"),
    dependencies,
  );
  assert(
    listed.status === 200 && (await listed.json()).payroll.length === 1,
    "admin list",
  );

  const started = await handleApiRequest(
    request("POST", "/v1/payroll/start", {
      maidProfileId,
      weekStart: "2026-08-24",
      expectedVersion: 0,
    }),
    dependencies,
  );
  assert(
    started.status === 200 &&
      (await started.json()).payroll.status === "paying",
    "admin start",
  );
  const paid = await handleApiRequest(
    request(
      "POST",
      "/v1/payroll/payment-attempts/96000000-0000-4000-8000-000000000002/paid",
      {
        expectedVersion: 1,
        paymentMethod: "bank_transfer",
        providerReferenceId: "bank.ab12",
      },
    ),
    dependencies,
  );
  assert(
    paid.status === 200 &&
      (await paid.json()).paymentResult.providerReferenceId === "BANK.AB12" &&
      calls.at(-1)?.args.p_canonical_reference === "BANK.AB12",
    "admin external full payment route canonicalizes before RPC",
  );

  const maidActor: EdgeActor = {
    ...actor,
    profileId: maidProfileId,
    role: "maid",
  };
  const maidList = await handleApiRequest(
    request("GET", "/v1/payroll?weekStart=2026-08-24"),
    { ...dependencies, authenticateRequest: () => Promise.resolve(maidActor) },
  );
  assert(maidList.status === 200, "maid self list");
  const deniedStart = await handleApiRequest(
    request("POST", "/v1/payroll/start", {
      maidProfileId,
      weekStart: "2026-08-24",
      expectedVersion: 0,
    }),
    { ...dependencies, authenticateRequest: () => Promise.resolve(maidActor) },
  );
  assert(
    deniedStart.status === 403 &&
      (await deniedStart.json()).error.code === "ADMIN_REQUIRED",
    "maid start denied",
  );
  assert(
    calls.at(-1)?.name === "record_authorization_denial" &&
      calls.at(-1)?.args.p_source === "edge.authorization.payroll",
    "payroll denial uses bounded source",
  );

  const developerList = await handleApiRequest(
    request("GET", "/v1/payroll?weekStart=2026-08-24"),
    {
      ...dependencies,
      authenticateRequest: () =>
        Promise.resolve({ ...actor, role: "developer" }),
    },
  );
  assert(
    developerList.status === 403 &&
      (await developerList.json()).error.code === "PAYROLL_ACCESS_REQUIRED",
    "developer list denied",
  );

  for (
    const [method, path, body] of [
      ["GET", "/v1/payroll/start", undefined],
      ["POST", "/v1/payroll", {
        maidProfileId,
        weekStart: "2026-08-24",
        expectedVersion: 0,
      }],
      ["GET", "/v1/payroll/extra?weekStart=2026-08-24", undefined],
    ] as const
  ) {
    const response = await handleApiRequest(
      request(method, path, body),
      dependencies,
    );
    assert(response.status === 404, `${method} ${path} no alias`);
  }
});

Deno.test("complaint exact routes preserve admin commands, maid response, and bounded denial activity", async () => {
  const complaintId = "97000000-0000-4000-8000-000000000001";
  const maidProfileId = "97000000-0000-4000-8000-000000000002";
  const baseComplaint = {
    id: complaintId,
    roomId,
    cleaningTargetId,
    cleaningAttemptId: "97000000-0000-4000-8000-000000000003",
    submissionId: "97000000-0000-4000-8000-000000000004",
    inspectionDecisionId: "97000000-0000-4000-8000-000000000005",
    originalEarningId: "97000000-0000-4000-8000-000000000006",
    maidProfileId,
    category: "cleanliness_general",
    status: "received",
    version: 1,
    currentDecisionId: null,
    firstDecidedAt: null,
    responseDeadline: null,
    receivedAt: "2026-09-10T00:00:00Z",
    updatedAt: "2026-09-10T00:00:00Z",
    currentDecision: null,
    maidResponse: null,
    reworkDecision: null,
  };
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let currentComplaint = baseComplaint;
  const clients = {
    admin: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        if (name === "record_authorization_denial") {
          return Promise.resolve({ data: null, error: null });
        }
        if (name === "list_complaint_cases_page") {
          return Promise.resolve({
            data: {
              complaints: [baseComplaint],
              hasMore: false,
              lastReceivedAt: null,
              lastId: null,
            },
            error: null,
          });
        }
        if (name === "materialize_complaint_rework") {
          const decisionId = "97000000-0000-4000-8000-000000000007";
          const targetId = "97000000-0000-4000-8000-000000000008";
          return Promise.resolve({
            data: {
              complaint: { ...currentComplaint, version: 3 },
              reworkDecision: {
                id: decisionId,
                complaintId,
                sourceComplaintDecisionId:
                  "97000000-0000-4000-8000-000000000009",
                currentComplaintDecisionId:
                  "97000000-0000-4000-8000-000000000009",
                sourceDecisionIsCurrent: true,
                originalCleaningTargetId: cleaningTargetId,
                reworkCleaningTargetId: targetId,
                originalMaidProfileId: maidProfileId,
                assigneeMaidProfileId: maidProfileId,
                sameMaid: true,
                originalBaseFeeSnapshot: 15000,
                compensationAmount: 0,
                currency: "KRW",
                sourceCaseVersion: 2,
                decisionVersion: 1,
                decidedAt: "2026-09-10T01:00:00Z",
              },
              assignment: {
                id: "97000000-0000-4000-8000-000000000010",
                cleaningTargetId: targetId,
                maidProfileId,
                sequenceNumber: 1,
                revision: 1,
                serviceDate: "2026-09-10",
                availableFrom: "2026-09-10T01:00:00Z",
                dueAt: "2026-09-10T02:00:00Z",
              },
            },
            error: null,
          });
        }
        if (name === "start_complaint_review") {
          currentComplaint = {
            ...baseComplaint,
            status: "under_review",
            version: 2,
          };
        } else if (name === "respond_to_complaint") {
          currentComplaint = {
            ...baseComplaint,
            status: "acknowledged",
            version: 4,
          };
        }
        return Promise.resolve({ data: currentComplaint, error: null });
      },
    },
  } as unknown as EdgeClients;
  const dependencies: ApiHandlerDependencies = {
    createClients: () => clients,
    authenticateRequest: () => Promise.resolve(actor),
  };

  const listed = await handleApiRequest(
    request(
      "GET",
      "/v1/complaints?from=2026-09-01T00:00:00Z&to=2026-09-11T00:00:00Z",
    ),
    dependencies,
  );
  assert(
    listed.status === 200 && listed.headers.get("cache-control") === "no-store",
    "admin complaint list is non-cacheable",
  );

  for (
    const path of [
      "/v1/complaints?from=2026-09-01T00:00:00Z&to=2026-09-11T00:00:00Z&cursor=",
      `/v1/complaints/${complaintId}/history?cursor=`,
    ]
  ) {
    const emptyCursor = await handleApiRequest(
      request("GET", path),
      dependencies,
    );
    assert(
      emptyCursor.status === 400 &&
        await errorCode(emptyCursor) === "INVALID_COMPLAINT_CURSOR" &&
        emptyCursor.headers.get("cache-control") === "no-store",
      `${path} rejects an empty cursor without caching`,
    );
  }

  const created = await handleApiRequest(
    request("POST", "/v1/complaints", {
      originalEarningId: baseComplaint.originalEarningId,
      category: "cleanliness_general",
      expectedVersion: 0,
    }),
    dependencies,
  );
  assert(created.status === 201, "admin complaint create");

  const zeroVersion = await handleApiRequest(
    request("POST", `/v1/complaints/${complaintId}/review`, {
      expectedVersion: 0,
    }),
    dependencies,
  );
  assert(zeroVersion.status === 400, "existing complaint CAS starts at one");

  const reviewed = await handleApiRequest(
    request("POST", `/v1/complaints/${complaintId}/review`, {
      expectedVersion: 1,
    }),
    dependencies,
  );
  assert(
    reviewed.status === 200 && (await reviewed.json()).complaint.version === 2,
    "admin complaint review CAS",
  );

  const reworked = await handleApiRequest(
    request("POST", `/v1/complaints/${complaintId}/rework`, {
      expectedVersion: 2,
      complaintDecisionId: "97000000-0000-4000-8000-000000000009",
      assigneeMaidProfileId: maidProfileId,
      compensationAmount: 0,
    }),
    dependencies,
  );
  assert(
    reworked.status === 201 &&
      (await reworked.json()).reworkDecision.compensationAmount === 0 &&
      reworked.headers.get("cache-control") === "no-store",
    "admin complaint rework exact zero-amount contract",
  );

  const maidActor: EdgeActor = {
    ...actor,
    profileId: maidProfileId,
    role: "maid",
  };
  const responded = await handleApiRequest(
    request("POST", `/v1/complaints/${complaintId}/response`, {
      expectedVersion: 3,
      responseType: "acknowledged",
    }),
    { ...dependencies, authenticateRequest: () => Promise.resolve(maidActor) },
  );
  assert(responded.status === 200, "maid complaint response");

  const developerList = await handleApiRequest(
    request(
      "GET",
      "/v1/complaints?from=2026-09-01T00:00:00Z&to=2026-09-11T00:00:00Z",
    ),
    {
      ...dependencies,
      authenticateRequest: () =>
        Promise.resolve({ ...actor, role: "developer" }),
    },
  );
  assert(
    developerList.status === 403 &&
      await errorCode(developerList) === "COMPLAINT_ACCESS_REQUIRED",
    "developer complaint list denied",
  );
  assert(
    calls.at(-1)?.name === "record_authorization_denial" &&
      calls.at(-1)?.args.p_source === "edge.authorization.complaints",
    "complaint denial uses bounded source",
  );
  for (
    const [method, path] of [
      ["GET", `/v1/complaints/${complaintId}/review`],
      ["POST", `/v1/complaints/${complaintId}/history`],
      ["POST", `/v1/complaints/${complaintId}/reopen`],
    ]
  ) {
    const response = await handleApiRequest(
      request(method, path),
      dependencies,
    );
    assert(response.status === 404, `${method} ${path} no alias`);
  }
});

Deno.test("Room GET detail route rejects every mutation-shaped alias", async () => {
  const forbiddenGetPaths = [
    `/v1/rooms/${roomId}/master-data`,
    `/v1/rooms/${roomId}/operation-blocks`,
    `/v1/rooms/${roomId}/candles`,
    `/v1/rooms/${roomId}/issues`,
    `/v1/rooms/${roomId}/pin-sync-events`,
    `/v1/rooms/${roomId}/operation-blocks/${blockId}/release`,
    `/v1/rooms/${roomId}/issues/${issueId}/resolve`,
  ];

  for (const path of forbiddenGetPaths) {
    const calls: string[] = [];
    const response = await handleApiRequest(
      request("GET", path),
      routeDependencies(calls),
    );
    assert(response.status === 404, `${path} must return 404`);
    assert(
      await errorCode(response) === "ROUTE_NOT_FOUND",
      `${path} must use the unknown route contract`,
    );
    assert(calls.length === 0, `${path} must not call a Room RPC`);
  }
});

Deno.test("Assignment commit preflight and mutation use exact routes", async () => {
  const routes: Array<{
    method: string;
    path: string;
    body?: Record<string, unknown>;
    rpc: string;
  }> = [
    {
      method: "GET",
      path: "/v1/assignments/commit-impact?serviceDate=2026-09-04",
      rpc: "get_assignment_commit_impact",
    },
    {
      method: "POST",
      path: "/v1/assignments/commit",
      body: {
        serviceDate: "2026-09-04",
        expectedImpactFingerprint: impactFingerprint,
        items: [{
          cleaningTargetId,
          expectedAssignmentVersion: 2,
          expectedAvailabilityVersion: 1,
        }],
      },
      rpc: "commit_and_notify_assignments",
    },
  ];
  for (const route of routes) {
    const calls: string[] = [];
    const response = await handleApiRequest(
      request(route.method, route.path, route.body),
      routeDependencies(calls),
    );
    assert(response.status === 200, `${route.method} ${route.path} must work`);
    assert(calls.includes(route.rpc), `${route.rpc} must be called`);
  }

  for (
    const path of [
      "/v1/assignments/commit-impact/extra?serviceDate=2026-09-04",
      `/v1/assignments/${assignmentId}/commit`,
    ]
  ) {
    const response = await handleApiRequest(
      request("GET", path),
      routeDependencies([]),
    );
    assert(response.status === 404, `${path} must stay unknown`);
    assert(await errorCode(response) === "ROUTE_NOT_FOUND", "stable 404");
  }
});

Deno.test("Room list, exact detail, and mutation routes remain reachable", async () => {
  const routes: Array<{
    method: string;
    path: string;
    status: number;
    body?: Record<string, unknown>;
  }> = [
    { method: "GET", path: "/v1/rooms", status: 200 },
    { method: "GET", path: `/v1/rooms/${roomId}`, status: 200 },
    {
      method: "PATCH",
      path: `/v1/rooms/${roomId}/master-data`,
      status: 200,
      body: {
        roomTypeId,
        elevatorZone: "A",
        dataStatus: "verified",
        dataStatusReason: null,
        expectedVersion: 3,
        reasonCode: "MASTER_DATA_CHANGED",
      },
    },
    {
      method: "POST",
      path: `/v1/rooms/${roomId}/operation-blocks`,
      status: 201,
      body: {
        expectedRoomVersion: 3,
        reasonCode: "MAINTENANCE",
        startsAt: "2026-09-01T00:00:00Z",
        endsAt: null,
      },
    },
    {
      method: "POST",
      path: `/v1/rooms/${roomId}/operation-blocks/${blockId}/release`,
      status: 200,
      body: { expectedRoomVersion: 3, reasonCode: "MAINTENANCE_DONE" },
    },
    {
      method: "POST",
      path: `/v1/rooms/${roomId}/candles`,
      status: 201,
      body: {
        expectedRoomVersion: 3,
        reasonCode: "PHYSICAL_CHECK",
        count: 0,
        physicallyVerified: true,
      },
    },
    {
      method: "POST",
      path: `/v1/rooms/${roomId}/issues`,
      status: 201,
      body: {
        expectedRoomVersion: 3,
        reasonCode: "ISSUE_REPORTED",
        category: "FACILITY",
        severity: "warning",
        blocksGuestAssignment: true,
        description: "시설 확인 필요",
      },
    },
    {
      method: "POST",
      path: `/v1/rooms/${roomId}/issues/${issueId}/resolve`,
      status: 200,
      body: { expectedRoomVersion: 3, reasonCode: "ISSUE_RESOLVED" },
    },
    {
      method: "POST",
      path: `/v1/rooms/${roomId}/pin-sync-events`,
      status: 201,
      body: {
        expectedRoomVersion: 3,
        reasonCode: "SYNC_VERIFIED",
        syncStatus: "verified",
        pinVersion: 2,
      },
    },
  ];

  for (const route of routes) {
    const calls: string[] = [];
    const response = await handleApiRequest(
      request(route.method, route.path, route.body),
      routeDependencies(calls),
    );
    assert(
      response.status === route.status,
      `${route.method} ${route.path} expected ${route.status}, got ${response.status}`,
    );
    assert(
      calls.length > 0,
      `${route.method} ${route.path} must call a Room RPC`,
    );
  }
});

Deno.test("notification router keeps exact GET/list and POST/read contracts", async () => {
  Deno.env.set(
    "NOTIFICATION_CURSOR_HMAC_SECRET",
    "notification-router-test-secret-distinct-123456",
  );
  Deno.env.set(
    "PAYROLL_CURSOR_HMAC_SECRET",
    "payroll-router-test-secret-distinct-123456789",
  );
  const notificationId = "10800000-0000-4000-8000-000000001001";
  const sessionId = "10800000-0000-4000-8000-000000000901";
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_")
      .replace(/=+$/g, "");
  const accessToken = `${encode({ alg: "none" })}.${
    encode({ session_id: sessionId })
  }.x`;
  const notice = {
    id: notificationId,
    category: "assignment_changed",
    title: "배정 변경",
    body: "최신 배정을 확인해 주세요.",
    roomId: null,
    cleaningTargetId: null,
    requiresAction: true,
    readAt: null,
    resolvedAt: null,
    occurredAt: "2026-09-11T01:00:00Z",
  };
  const notificationRequest = (
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ) =>
    new Request(`http://localhost/functions/v1/api${path}`, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const dependencies = (crossRecipient = false): ApiHandlerDependencies => ({
    authenticateRequest: () => Promise.resolve({ ...actor, role: "maid" }),
    createClients: () => ({
      admin: {
        rpc(name: string) {
          if (crossRecipient && name === "mark_notification_read") {
            return Promise.resolve({
              data: null,
              error: { message: "NOTIFICATION_NOT_FOUND" },
            });
          }
          return Promise.resolve({
            error: null,
            data: name === "list_notifications_page"
              ? {
                notifications: [notice],
                hasMore: false,
                lastOccurredAt: null,
                lastId: null,
              }
              : { ...notice, readAt: "2026-09-11T02:00:00Z" },
          });
        },
      },
    } as unknown as EdgeClients),
  });

  const list = await handleApiRequest(
    notificationRequest("GET", "/v1/notifications?limit=50"),
    dependencies(),
  );
  assert(list.status === 200, "notification list route works");
  assert(list.headers.get("cache-control") === "no-store", "list is no-store");
  const listBody = await list.json();
  assert(
    !JSON.stringify(listBody).includes("dedupeKey") &&
      !JSON.stringify(listBody).includes("groupKey") &&
      !JSON.stringify(listBody).includes("recipientProfileId"),
    "router keeps private notification fields out",
  );

  const read = await handleApiRequest(
    notificationRequest("POST", `/v1/notifications/${notificationId}/read`, {}),
    dependencies(),
  );
  assert(read.status === 200, "notification read route works");
  assert(read.headers.get("cache-control") === "no-store", "read is no-store");

  for (
    const path of [
      `/v1/notifications/${notificationId}/read/extra`,
      `/v1/notification/${notificationId}/read`,
    ]
  ) {
    const response = await handleApiRequest(
      notificationRequest("POST", path, {}),
      dependencies(),
    );
    assert(response.status === 404, "unknown notification alias is rejected");
  }
  for (
    const path of [
      "/v1/notifications?cursor=",
      "/v1/notifications?limit=1&limit=2",
    ]
  ) {
    const response = await handleApiRequest(
      notificationRequest("GET", path),
      dependencies(),
    );
    assert(
      response.status === 400,
      "empty cursor or duplicate query is rejected",
    );
  }
  const cross = await handleApiRequest(
    notificationRequest("POST", `/v1/notifications/${notificationId}/read`, {}),
    dependencies(true),
  );
  assert(cross.status === 404, "cross-recipient read remains stable not-found");
  assert(
    cross.headers.get("cache-control") === "no-store",
    "cross-recipient error remains no-store",
  );
  assert(
    await errorCode(cross) === "NOTIFICATION_NOT_FOUND",
    "stable cross-recipient code",
  );
});
