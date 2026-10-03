import { type ApiHandlerDependencies, handleApiRequest } from "../api/index.ts";
import { listPayrollWorkDetails } from "./payroll-work-details-api.ts";
import {
  decodePayrollWorkCursor,
  encodePayrollWorkCursor,
  payrollWorkScope,
} from "./payroll-work-details-cursor.ts";
import {
  type PayrollWorkInput,
  payrollWorkProjection,
  payrollWorkQuery,
} from "./payroll-work-details-core.ts";
import { encodePayrollCursor, payrollCursorScope } from "./payroll-cursor.ts";
import type { EdgeActor, EdgeClients } from "./runtime.ts";

Deno.env.set(
  "PAYROLL_CURSOR_HMAC_SECRET",
  "synthetic-payroll-cursor-secret-32bytes",
);
const id = (n: number) =>
  `c1000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const session = "f1000000-0000-4000-8000-000000000001";
const admin: EdgeActor = {
  authUserId: id(1),
  profileId: id(2),
  displayName: "합성 관리자",
  role: "admin",
  mustChangePassword: false,
};
const maid: EdgeActor = { ...admin, profileId: id(3), role: "maid" };
const input: PayrollWorkInput = {
  maidProfileId: maid.profileId,
  weekStart: "2026-09-28",
  kind: "earnings",
  limit: 25,
};
const summary = {
  cycleId: null,
  cycleStatus: "open",
  cycleVersion: 0,
  accrualAmount: 32000,
  expectedAmount: 0,
  pendingAmount: 0,
  pendingCount: 0,
  totalAmount: 32000,
  lateEarningAmount: 0,
  adjustmentAmount: -2000,
  carryInAmount: -1000,
  carryOutAmount: 0,
  payableAmount: 29000,
  offsetSettled: false,
  lockedAmount: null,
};
const common = {
  entryId: id(10),
  entryDate: "2026-09-29",
  cleaningTargetId: id(4),
  assignmentId: id(5),
  attemptId: id(6),
  submissionId: id(7),
  inspectionDecisionId: id(8),
  roomNumber: "350",
  roomTypeCode: "standard",
  roomTypeName: "고정된 타입",
  cleaningKind: "checkout",
  sourceKind: "scheduled_checkout",
  fieldCompletedAt: "2026-09-29T01:00:00+09:00",
  feeSnapshot: 16000,
  attemptStatus: "approved",
  submissionStatus: "approved",
  inspectionDecision: "approved",
};
const earning = {
  ...common,
  earningId: id(10),
  earnedOn: common.entryDate,
  earningSource: "cleaning",
  baseAmount: 16000,
  bombRoomBonus: 16000,
  totalAmount: 32000,
  itemContributionAmount: 32000,
  lateContributionAmount: 0,
  alreadyClaimed: false,
  lateCarried: false,
};
const workflow = {
  ...common,
  entryId: common.attemptId,
  attemptStatus: "submitted",
  inspectionDecision: null,
  inspectionDecisionId: null,
  submissionStatus: "submitted",
  earningId: null,
  baseAmount: null,
  bombRoomBonus: null,
  totalAmount: null,
  expectedContributionAmount: 16000,
  pendingContributionAmount: 16000,
  includedInPendingCount: true,
  expectedBaseContributionAmount: 16000,
  expectedBombContributionAmount: 0,
};
function assert(value: unknown, message = "assertion"): asserts value {
  if (!value) throw new Error(message);
}
const query = (candidate = input) =>
  new URLSearchParams({
    weekStart: candidate.weekStart,
    maidProfileId: candidate.maidProfileId,
    kind: candidate.kind,
  }).toString();
function request(
  path = "/v1/payroll/work-details",
  method = "GET",
  suffix = query(),
  currentSession: unknown = session,
): Request {
  const claims = btoa(JSON.stringify({ session_id: currentSession }))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return new Request(`http://localhost/functions/v1/api${path}?${suffix}`, {
    method,
    headers: { authorization: `Bearer e30.${claims}.signature` },
  });
}
function page(
  entries: unknown[] = [earning],
  candidate = input,
  hasMore = false,
) {
  const last = entries.at(-1) as
    | { entryDate?: string; entryId?: string }
    | undefined;
  return {
    weekStart: candidate.weekStart,
    maidProfileId: candidate.maidProfileId,
    kind: candidate.kind,
    summary: candidate.kind === "workflow"
      ? {
        ...summary,
        expectedAmount: 48000,
        pendingAmount: 16000,
        pendingCount: 1,
      }
      : summary,
    entries,
    hasMore,
    lastEntryDate: last?.entryDate ?? null,
    lastEntryId: last?.entryId ?? null,
  };
}
function dependencies(
  data: unknown = page(),
  failure: string | null = null,
  identity = admin,
  denyFailure = false,
) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  let authenticated = 0;
  const clients = {
    admin: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push([name, args]);
        if (name === "record_authorization_denial") {
          return Promise.resolve({
            data: null,
            error: denyFailure
              ? { message: "synthetic-private-failure" }
              : null,
          });
        }
        return Promise.resolve({
          data,
          error: failure ? { message: failure } : null,
        });
      },
    },
  } as unknown as EdgeClients;
  const options: ApiHandlerDependencies = {
    createClients: () => clients,
    authenticateRequest: () => {
      authenticated++;
      return Promise.resolve(identity);
    },
  };
  return { clients, options, calls, authenticated: () => authenticated };
}
Deno.test("#324 Edge uses exact role-bound SQL arguments and safe envelope", async () => {
  const mock = dependencies();
  const response = await handleApiRequest(request(), mock.options);
  assert(
    response.status === 200 &&
      response.headers.get("cache-control") === "no-store",
  );
  const body = await response.json();
  assert(
    body.entries[0].totalAmount === 32000 &&
      body.summary.accrualAmount === 32000 && body.nextCursor === null,
  );
  assert(
    mock.calls.length === 1 &&
      mock.calls[0][0] === "list_payroll_work_details_page",
  );
  assert(
    JSON.stringify(mock.calls[0][1]) ===
      JSON.stringify({
        p_actor_profile_id: admin.profileId,
        p_session_id: session,
        p_expected_actor_role: "admin",
        p_week_start: input.weekStart,
        p_maid_profile_id: maid.profileId,
        p_kind: "earnings",
        p_after_entry_date: null,
        p_after_entry_id: null,
        p_limit: 25,
      }),
  );
});
Deno.test("#324 Edge preserves zero compensation and nullable workflow money", async () => {
  const zero = {
    ...earning,
    baseAmount: 0,
    bombRoomBonus: 0,
    totalAmount: 0,
    itemContributionAmount: 0,
    earningSource: "compensation",
  };
  assert(
    payrollWorkProjection(
      {
        ...page([zero]),
        summary: { ...summary, accrualAmount: 0, totalAmount: 0 },
      },
      input,
      null,
    ).entries[0].totalAmount ===
      0,
  );
  const wf = { ...input, kind: "workflow" as const };
  const mock = dependencies(page([workflow], wf));
  const response = await listPayrollWorkDetails(
    request(undefined, "GET", query(wf)),
    mock.clients,
    maid,
    session,
  );
  assert(
    response.entries[0].totalAmount === null &&
      response.entries[0].earningId === null,
  );
});
Deno.test("#324 new cursor interop signature/session binding known vector", async () => {
  const expected =
    "eyJmYW1pbHkiOiJwYXlyb2xsLXdvcmstZGV0YWlscyIsInYiOjEsInNjb3BlIjp7ImFjdG9yUHJvZmlsZUlkIjoiYzEwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAyIiwiYWN0b3JSb2xlIjoiYWRtaW4iLCJzZXNzaW9uQmluZGluZyI6IlBveUE2MmQyazV5LU1YdlQ5aWZrYnFRT0ZJaTgxTElPVzhKSHZ3T1k1djgiLCJ3ZWVrU3RhcnQiOiIyMDI2LTA5LTI4IiwibWFpZFByb2ZpbGVJZCI6ImMxMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMyIsImtpbmQiOiJlYXJuaW5ncyIsInNvcnQiOiJlbnRyeURhdGU6YXNjLGVudHJ5SWQ6YXNjIn0sImFmdGVyIjp7ImVudHJ5RGF0ZSI6IjIwMjYtMDktMjkiLCJlbnRyeUlkIjoiYzEwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDEwIn19.tqU-nQ64ObG7gSQt6P2J_ZACyWynGjlFCj-yHyQOCog";
  const scope = await payrollWorkScope(
    admin.profileId,
    "admin",
    session,
    input,
  );
  const cursor = await encodePayrollWorkCursor(scope, {
    entryDate: earning.entryDate,
    entryId: earning.entryId,
  });
  assert(
    scope.sessionBinding === "PoyA62d2k5y-MXvT9ifkbqQOFIi81LIOW8JHvwOY5v8",
  );
  assert(cursor === expected);
  assert(
    await encodePayrollWorkCursor(
      await payrollWorkScope(
        admin.profileId,
        "admin",
        session.toUpperCase(),
        input,
      ),
      { entryDate: earning.entryDate, entryId: earning.entryId },
    ) === expected,
  );
  assert(
    (await decodePayrollWorkCursor(expected, scope)).entryId ===
      earning.entryId,
  );
  const parts = cursor.split(".");
  const decoded = atob(
    parts[0].replaceAll("-", "+").replaceAll("_", "/") +
      "=".repeat((4 - parts[0].length % 4) % 4),
  );
  assert(!decoded.includes(session));
  assert(
    (await decodePayrollWorkCursor(cursor, scope)).entryId === earning.entryId,
  );
  for (
    const changed of [
      await payrollWorkScope(admin.profileId, "admin", id(90), input),
      await payrollWorkScope(admin.profileId, "maid", session, input),
      await payrollWorkScope(admin.profileId, "admin", session, {
        ...input,
        kind: "workflow",
      }),
      await payrollWorkScope(admin.profileId, "admin", session, {
        ...input,
        weekStart: "2026-09-21",
      }),
    ]
  ) {
    try {
      await decodePayrollWorkCursor(cursor, changed);
      throw new Error("cross-scope cursor accepted");
    } catch (error) {
      assert((error as { code: string }).code === "PAYROLL_CURSOR_INVALID");
    }
  }
  const old = await encodePayrollCursor(
    payrollCursorScope(admin, input.weekStart, input.maidProfileId, "items"),
    { earnedOn: earning.earnedOn, earningId: earning.earningId },
  );
  try {
    await decodePayrollWorkCursor(old, scope);
    throw new Error("legacy cursor accepted");
  } catch (error) {
    assert((error as { code: string }).code === "PAYROLL_CURSOR_INVALID");
  }
});
for (const method of ["HEAD", "POST", "PUT", "PATCH", "DELETE"]) {
  Deno.test(`#324 Edge ${method} rejects before authentication`, async () => {
    const mock = dependencies();
    const response = await handleApiRequest(
      request(undefined, method),
      mock.options,
    );
    assert(
      response.status === 404 &&
        response.headers.get("cache-control") === "no-store",
    );
    assert(mock.authenticated() === 0 && mock.calls.length === 0);
  });
}
for (
  const path of [
    "/v1/payroll/work-details/",
    "/v1//payroll/work-details",
    "/v1/payroll/work-details/extra",
    "/v1/payroll/%77ork-details",
    "/v1/payroll/work%2Ddetails",
  ]
) {
  Deno.test(`#324 Edge rejects path alias ${path}`, async () => {
    const mock = dependencies();
    const response = await handleApiRequest(request(path), mock.options);
    assert(
      response.status === 404 &&
        response.headers.get("cache-control") === "no-store",
    );
    assert(mock.authenticated() === 0 && mock.calls.length === 0);
  });
}
for (
  const suffix of [
    "&limit=0",
    "&limit=51",
    "&limit=01",
    "&cursor=",
    "&extra=1",
    "&kind=workflow",
    "&weekStart=2026-09-28",
  ]
) {
  Deno.test(`#324 Edge rejects malformed query ${suffix}`, async () => {
    const mock = dependencies();
    const response = await handleApiRequest(
      request(undefined, "GET", query() + suffix),
      mock.options,
    );
    assert(
      response.status === 400 &&
        response.headers.get("cache-control") === "no-store",
    );
    assert(mock.calls.length === 0);
  });
}
for (
  const identity of [{ ...admin, role: "developer" as const }, {
    ...maid,
    profileId: id(99),
  }, { ...admin, mustChangePassword: true }]
) {
  Deno.test(`#324 Edge denies forbidden actor ${identity.role}/${identity.profileId}/${identity.mustChangePassword}`, async () => {
    const mock = dependencies(page(), null, identity);
    const response = await handleApiRequest(request(), mock.options);
    assert(
      response.status === 403 &&
        response.headers.get("cache-control") === "no-store",
    );
    assert(
      mock.calls.every(([name]) => name === "record_authorization_denial"),
    );
    assert(mock.calls.length === 1);
    assert(mock.calls[0][1].p_source === "edge.authorization.payroll");
  });
}
for (
  const [failure, status] of [
    ["SESSION_REVOKED", 401],
    ["PAYROLL_ACCESS_REQUIRED", 403],
    ["PASSWORD_CHANGE_REQUIRED", 403],
    ["PAYROLL_WEEK_MUST_START_MONDAY", 400],
    ["PAYROLL_MAID_NOT_FOUND", 404],
    ["PAYROLL_WEEK_NOT_CLOSED", 409],
    ["private SESSION_REVOKED", 500],
  ] as const
) {
  Deno.test(`#324 Edge maps exact DB error ${failure}`, async () => {
    const mock = dependencies(null, failure);
    const response = await handleApiRequest(request(), mock.options);
    assert(
      response.status === status &&
        response.headers.get("cache-control") === "no-store",
    );
    const body = await response.json();
    assert(
      body.error.code === (status === 500 ? "PAYROLL_COMMAND_FAILED" : failure),
    );
    assert(!JSON.stringify(body).includes("private"));
  });
}
for (
  const change of [
    { private: "hidden" },
    { totalAmount: 1 },
    { bombRoomBonus: -1 },
    { attemptStatus: "cancelled" },
    { inspectionDecision: "rejected" },
    { roomTypeName: 0 },
  ]
) {
  Deno.test(`#324 Edge rejects malformed projection ${JSON.stringify(change)}`, async () => {
    const mock = dependencies(page([{ ...earning, ...change }]));
    const response = await handleApiRequest(request(), mock.options);
    assert(
      response.status === 500 &&
        response.headers.get("cache-control") === "no-store",
    );
    assert((await response.json()).error.code === "PAYROLL_COMMAND_FAILED");
  });
}
Deno.test("#324 Edge missing session and oversized UTF-8 projections fail closed", async () => {
  const missing = dependencies();
  const missingResponse = await handleApiRequest(
    request(undefined, "GET", query(), null),
    missing.options,
  );
  assert(missingResponse.status === 401 && missing.calls.length === 0);
  const large = dependencies({ ...page(), private: "가".repeat(128 * 1024) });
  const response = await handleApiRequest(request(), large.options);
  assert(
    response.status === 500 &&
      (await response.json()).error.code === "PAYROLL_RESPONSE_TOO_LARGE",
  );
});
Deno.test("#324 Edge shared Gregorian calendar input validation", () => {
  for (
    const weekStart of ["0001-01-01", "0099-12-31", "2000-02-29", "9999-12-31"]
  ) {
    assert(
      payrollWorkQuery(new URLSearchParams(query({ ...input, weekStart })))
        .weekStart === weekStart,
    );
  }
});
for (const blank of ["", "\t", "\n", "\u00a0", " \t\r\n\u00a0 "]) {
  Deno.test(`#324 Edge normalizes SQL-raw legacy blank snapshot ${JSON.stringify(blank)}`, async () => {
    const mock = dependencies(
      page([{
        ...earning,
        roomNumber: blank,
        roomTypeCode: blank,
        roomTypeName: blank,
      }]),
    );
    const response = await handleApiRequest(request(), mock.options);
    assert(
      response.status === 200 &&
        response.headers.get("cache-control") === "no-store",
    );
    const entry = (await response.json()).entries[0];
    assert(
      entry.roomNumber === null && entry.roomTypeCode === null &&
        entry.roomTypeName === null,
    );
  });
}
Deno.test("#324 Edge denial audit failure preserves mandatory fail-closed 503", async () => {
  const mock = dependencies(
    page(),
    null,
    { ...admin, role: "developer" },
    true,
  );
  const response = await handleApiRequest(request(), mock.options);
  assert(
    response.status === 503 &&
      response.headers.get("cache-control") === "no-store",
  );
  const body = await response.json();
  assert(
    body.error.code === "ACTIVITY_LOG_UNAVAILABLE" &&
      !JSON.stringify(body).includes("synthetic-private-failure"),
  );
  assert(
    mock.calls.length === 1 &&
      mock.calls[0][0] === "record_authorization_denial",
  );
});
Deno.test("#324 Edge mixed confirmed/pending terminal workflow page compares expected minus accrual", async () => {
  const wf = { ...input, kind: "workflow" as const };
  const mock = dependencies(page([workflow], wf));
  const response = await handleApiRequest(
    request(undefined, "GET", query(wf)),
    mock.options,
  );
  assert(response.status === 200);
  const body = await response.json();
  assert(
    body.summary.accrualAmount === 32000 &&
      body.summary.expectedAmount === 48000,
  );
  assert(
    body.entries[0].expectedContributionAmount ===
      body.summary.expectedAmount - body.summary.accrualAmount,
  );
  for (
    const raw of [{
      ...page([workflow], wf),
      summary: {
        ...summary,
        expectedAmount: 47999,
        pendingAmount: 16000,
        pendingCount: 1,
      },
    }, {
      ...page([workflow], wf),
      summary: {
        ...summary,
        expectedAmount: 48001,
        pendingAmount: 16000,
        pendingCount: 1,
      },
    }]
  ) {
    const bad = dependencies(raw);
    const rejected = await handleApiRequest(
      request(undefined, "GET", query(wf)),
      bad.options,
    );
    assert(
      rejected.status === 500 &&
        (await rejected.json()).error.code === "PAYROLL_COMMAND_FAILED",
    );
  }
});
