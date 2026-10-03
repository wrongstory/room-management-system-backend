import {
  carryForwardPayroll,
  carryLatePayrollEarning,
  correctPayrollAdjustment,
  getPayrollAdjustmentBook,
  getPayrollCycle,
  listPayroll,
  listPayrollEntries,
  payrollDatabaseError,
  recordPayrollPaymentCheck,
  recordPayrollPaymentPaid,
  reopenPayrollPayment,
  reversePayrollSource,
  startPayroll,
} from "./payroll-api.ts";
import {
  assertPayrollResponseSize,
  PAYROLL_RESPONSE_MAX_BYTES,
} from "./payroll-cursor.ts";
import type { EdgeActor, EdgeClients } from "./runtime.ts";
import { EdgeError } from "./runtime.ts";
import { type ApiHandlerDependencies, handleApiRequest } from "../api/index.ts";

Deno.env.set(
  "PAYROLL_CURSOR_HMAC_SECRET",
  "payroll-cursor-secret-for-edge-tests-123456",
);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("payroll UTF-8 HTTP envelope cap fails closed", () => {
  try {
    assertPayrollResponseSize({
      value: "가".repeat(PAYROLL_RESPONSE_MAX_BYTES),
    });
    throw new Error("oversized response accepted");
  } catch (error) {
    assert(
      (error as { code?: string }).code === "PAYROLL_RESPONSE_TOO_LARGE",
      "stable response size error",
    );
  }
});

const admin: EdgeActor = {
  authUserId: "10000000-0000-4000-8000-000000000001",
  profileId: "20000000-0000-4000-8000-000000000001",
  displayName: "관리자",
  role: "admin",
  mustChangePassword: false,
};
const maid: EdgeActor = {
  ...admin,
  authUserId: "10000000-0000-4000-8000-000000000002",
  profileId: "20000000-0000-4000-8000-000000000002",
  displayName: "메이드",
  role: "maid",
};

const bookSessionId = "30000000-0000-4000-8000-000000000001";
const bookQuery = `maidProfileId=${maid.profileId}&weekStart=2026-09-28`;
const bookDto = {
  maidProfileId: maid.profileId,
  weekStart: "2026-09-28",
  currentBookVersion: 3,
};
function bookRequest(
  query = bookQuery,
  method = "GET",
  path = "/v1/payroll/adjustment-book",
  session: unknown = bookSessionId,
): Request {
  const payload = btoa(JSON.stringify({ session_id: session })).replaceAll(
    "+",
    "-",
  )
    .replaceAll("/", "_").replaceAll("=", "");
  return new Request(`http://localhost/functions/v1/api${path}?${query}`, {
    method,
    headers: { authorization: `Bearer e30.${payload}.signature` },
  });
}
function bookDependencies(
  data: unknown = bookDto,
  failure: string | null = null,
  identity = admin,
) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const options: ApiHandlerDependencies = {
    authenticateRequest: () => Promise.resolve(identity),
    createClients: () => ({
      admin: {
        rpc(name: string, args: Record<string, unknown>) {
          calls.push([name, args]);
          if (name === "record_authorization_denial") {
            return Promise.resolve({ data: null, error: null });
          }
          return Promise.resolve({
            data,
            error: failure ? { message: failure } : null,
          });
        },
      },
    } as unknown as EdgeClients),
  };
  return { calls, options };
}

Deno.test("adjustment book GET returns exact current global CAS with verified session and no cursor dependency", async () => {
  for (const currentBookVersion of [0, 3, Number.MAX_SAFE_INTEGER]) {
    const fixture = bookDependencies({ ...bookDto, currentBookVersion });
    const response = await handleApiRequest(bookRequest(), fixture.options);
    const body = await response.json();
    assert(
      response.status === 200 &&
        response.headers.get("cache-control") === "no-store",
      "safe read response",
    );
    assert(Object.keys(body).join() === "adjustmentBook", "exact envelope");
    assert(
      JSON.stringify(body.adjustmentBook) ===
        JSON.stringify({ ...bookDto, currentBookVersion }),
      "three fields exact",
    );
    assert(
      fixture.calls.length === 1 &&
        fixture.calls[0][0] === "get_payroll_adjustment_book",
      "single read RPC",
    );
    assert(
      JSON.stringify(fixture.calls[0][1]) === JSON.stringify({
        p_actor_profile_id: admin.profileId,
        p_session_id: bookSessionId,
        p_maid_profile_id: maid.profileId,
        p_week_start: bookDto.weekStart,
      }),
      "exact actor session maid and context binding",
    );
  }
  const lower = "a0000000-0000-4000-8000-000000000001";
  const upper = lower.toUpperCase();
  const fixture = bookDependencies({ ...bookDto, maidProfileId: lower });
  const response = await handleApiRequest(
    bookRequest(`maidProfileId=${upper}&weekStart=2026-09-28`),
    fixture.options,
  );
  assert(response.status === 200, "UUID case normalized");
});

Deno.test("adjustment book query rejects unknown duplicate empty malformed calendar and UUID before read", async () => {
  for (
    const query of [
      "",
      `maidProfileId=${maid.profileId}`,
      "weekStart=2026-09-28",
      `maidProfileId=&weekStart=2026-09-28`,
      `${bookQuery}&bookId=123`,
      `${bookQuery}&maidProfileId=${maid.profileId}`,
      `${bookQuery}&weekStart=2026-09-28`,
      "maidProfileId=bad&weekStart=2026-09-28",
      `maidProfileId=${maid.profileId}&weekStart=`,
      ...[
        "0000-01-01",
        "2026-02-29",
        "1900-02-29",
        "2026-04-31",
        "2026-00-01",
        "2026-13-01",
        "2026-01-00",
        "10000-01-01",
        "2026-1-01",
        "2026-09-28T00:00:00Z",
      ].map((value) => `maidProfileId=${maid.profileId}&weekStart=${value}`),
    ]
  ) {
    const fixture = bookDependencies();
    const response = await handleApiRequest(
      bookRequest(query),
      fixture.options,
    );
    assert(
      response.status === 400 &&
        (await response.json()).error.code === "VALIDATION_ERROR",
      "strict query denied",
    );
    assert(
      response.headers.get("cache-control") === "no-store" &&
        fixture.calls.length === 0,
      "no lookup for invalid query",
    );
  }
});

Deno.test("adjustment book accepts real Gregorian dates including years below 100 and leap years", async () => {
  for (
    const weekStart of [
      "0001-01-01",
      "0099-01-01",
      "2000-02-29",
      "2024-02-29",
      "9999-12-31",
      "2026-09-21",
    ]
  ) {
    const fixture = bookDependencies({ ...bookDto, weekStart });
    const response = await handleApiRequest(
      bookRequest(`maidProfileId=${maid.profileId}&weekStart=${weekStart}`),
      fixture.options,
    );
    assert(
      response.status === 200 && fixture.calls[0][1].p_week_start === weekStart,
      "calendar sent to DB Monday/current-week authority",
    );
  }
});

Deno.test("adjustment book HTTP methods aliases remain 404 no-store and OPTIONS preserves CORS", async () => {
  for (
    const [method, path] of [
      ["HEAD", "/v1/payroll/adjustment-book"],
      ["POST", "/v1/payroll/adjustment-book"],
      ["PUT", "/v1/payroll/adjustment-book"],
      ["PATCH", "/v1/payroll/adjustment-book"],
      ["DELETE", "/v1/payroll/adjustment-book"],
      ["GET", "/v1/payroll/adjustment-book/"],
      ["GET", "/v1//payroll/adjustment-book"],
      ["GET", "//v1/payroll/adjustment-book"],
      ["GET", "/v1/payroll/adjustment-book/extra"],
    ]
  ) {
    const fixture = bookDependencies();
    let authenticated = false;
    fixture.options.authenticateRequest = () => {
      authenticated = true;
      return Promise.reject(
        new EdgeError(401, "MISSING_ACCESS_TOKEN", "missing"),
      );
    };
    const request = bookRequest(bookQuery, method, path);
    request.headers.delete("authorization");
    const response = await handleApiRequest(
      request,
      fixture.options,
    );
    assert(
      response.status === 404 &&
        response.headers.get("cache-control") === "no-store" &&
        fixture.calls.length === 0 && !authenticated,
      "unsupported unauthenticated route rejected before auth/read",
    );
  }
  const fixture = bookDependencies();
  const preflight = await handleApiRequest(
    bookRequest(bookQuery, "OPTIONS"),
    fixture.options,
  );
  assert(
    preflight.status === 204 &&
      preflight.headers.get("cache-control") === "no-store" &&
      fixture.calls.length === 0,
    "preflight untouched and no-store",
  );
});

Deno.test("adjustment book latest DB denials map exact scoped errors and redact raw details", async () => {
  for (
    const [code, status] of [
      ["SESSION_REVOKED", 401],
      ["PASSWORD_CHANGE_REQUIRED", 403],
      ["ADMIN_REQUIRED", 403],
      ["PAYROLL_WEEK_MUST_START_MONDAY", 400],
      ["PAYROLL_WEEK_NOT_CLOSED", 409],
      ["PAYROLL_MAID_NOT_FOUND", 404],
      ["VALIDATION_ERROR", 500],
      ["PAYROLL_ADJUSTMENT_BOOK_INVARIANT_VIOLATION", 500],
      ["postgres raw secret ADMIN_REQUIRED", 500],
      ["STALE_ADJUSTMENT_VERSION", 500],
    ] as const
  ) {
    const fixture = bookDependencies(null, code);
    const response = await handleApiRequest(bookRequest(), fixture.options);
    const body = await response.json();
    assert(
      response.status === status &&
        body.error.code === (status === 500 ? "PAYROLL_COMMAND_FAILED" : code),
      "exact safe code mapping",
    );
    assert(
      response.headers.get("cache-control") === "no-store" &&
        !JSON.stringify(body).includes("secret"),
      "safe errors",
    );
  }
});

Deno.test("adjustment book actor password and session metadata are checked before RPC", async () => {
  for (
    const identity of [maid, { ...admin, role: "developer" } as EdgeActor, {
      ...admin,
      mustChangePassword: true,
    }]
  ) {
    const fixture = bookDependencies(bookDto, null, identity);
    const response = await handleApiRequest(bookRequest(), fixture.options);
    assert(
      response.status === 403 &&
        !fixture.calls.some(([name]) => name === "get_payroll_adjustment_book"),
      "admin/password gate",
    );
  }
  for (const session of [null, "", "invalid", 1]) {
    const fixture = bookDependencies();
    const response = await handleApiRequest(
      bookRequest(bookQuery, "GET", "/v1/payroll/adjustment-book", session),
      fixture.options,
    );
    assert(
      response.status === 401 &&
        (await response.json()).error.code === "INVALID_ACCESS_TOKEN" &&
        fixture.calls.length === 0,
      "verified session only",
    );
  }
  const fixture = bookDependencies();
  fixture.options.authenticateRequest = () =>
    Promise.reject(new EdgeError(401, "SESSION_REVOKED", "revoked"));
  const response = await handleApiRequest(bookRequest(), fixture.options);
  assert(
    response.status === 401 &&
      response.headers.get("cache-control") === "no-store" &&
      fixture.calls.length === 0,
    "auth failure no read",
  );
});

Deno.test("adjustment book malformed or cross-bound DTO fails closed without guessing latest version", async () => {
  for (
    const data of [
      null,
      [],
      { ...bookDto, maidProfileId: admin.profileId },
      { ...bookDto, weekStart: "2026-09-21" },
      { ...bookDto, currentBookVersion: undefined },
      { ...bookDto, currentBookVersion: null },
      { ...bookDto, currentBookVersion: "3" },
      { ...bookDto, currentBookVersion: -1 },
      { ...bookDto, currentBookVersion: 1.5 },
      { ...bookDto, currentBookVersion: Number.MAX_SAFE_INTEGER + 1 },
      { ...bookDto, bookVersion: 1 },
      { ...bookDto, pin: "must-not-leak" },
    ]
  ) {
    const fixture = bookDependencies(data);
    const response = await handleApiRequest(bookRequest(), fixture.options);
    const body = await response.json();
    assert(
      response.status === 500 && body.error.code === "PAYROLL_COMMAND_FAILED" &&
        !JSON.stringify(body).includes("must-not-leak"),
      "malformed DTO safe500",
    );
  }
  const fixture = bookDependencies({
    ...bookDto,
    raw: "가".repeat(PAYROLL_RESPONSE_MAX_BYTES),
  });
  const response = await handleApiRequest(bookRequest(), fixture.options);
  assert(
    response.status === 500 &&
      (await response.json()).error.code === "PAYROLL_RESPONSE_TOO_LARGE",
    "raw bounded before DTO parse",
  );
});

Deno.test("adjustment book direct read does not use legacy cursor or command RPC", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const result = await getPayrollAdjustmentBook(
    bookRequest(),
    clients(calls, bookDto),
    admin,
    bookSessionId,
  );
  assert(
    result.currentBookVersion === 3 && calls.length === 1 &&
      calls[0][0] === "get_payroll_adjustment_book",
    "read only RPC",
  );
});
const projection = {
  cycleId: null,
  maidProfileId: maid.profileId,
  weekStart: "2026-08-24",
  status: "open",
  version: 0,
  lockedAmount: null,
  paymentStartedAt: null,
  itemCount: 1,
  totalAmount: 30000,
  items: [{
    earningId: "30000000-0000-4000-8000-000000000001",
    earnedOn: "2026-08-25",
    amount: 30000,
    alreadyClaimed: false,
  }],
  itemsHasMore: false,
  itemsLastEarnedOn: "2026-08-25",
  itemsLastEarningId: "30000000-0000-4000-8000-000000000001",
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

Deno.test("payroll payment results canonicalize references and reject client evidence", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const attemptId = "71000000-0000-4000-8000-000000000001";
  const result = {
    paymentResultId: "72000000-0000-4000-8000-000000000001",
    paymentAttemptId: attemptId,
    payrollCycleId: "73000000-0000-4000-8000-000000000001",
    resultType: "paid",
    beforeStatus: "check",
    afterStatus: "paid",
    cycleVersion: 3,
    lockedAmount: 30000,
    paymentMethod: "bank_transfer",
    providerReferenceId: "BANK.AB12",
    occurredAt: "2026-09-10T00:00:00Z",
  };
  const request = (action: string, body: Record<string, unknown>) =>
    new Request(
      `http://localhost/v1/payroll/payment-attempts/${attemptId}/${action}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `payment-${action}-edge`,
        },
        body: JSON.stringify(body),
      },
    );
  await recordPayrollPaymentPaid(
    request("paid", {
      expectedVersion: 2,
      paymentMethod: "bank_transfer",
      providerReferenceId: "bank.ab12",
    }),
    clients(calls, result),
    admin,
    attemptId,
  );
  assert(calls[0]?.[0] === "record_payroll_payment_paid", "paid RPC selected");
  assert(
    calls[0]?.[1].p_canonical_reference === "BANK.AB12",
    "reference canonicalized before RPC",
  );
  const firstHash = calls[0]?.[1].p_request_hash;
  await recordPayrollPaymentPaid(
    request("paid", {
      expectedVersion: 2,
      paymentMethod: "bank_transfer",
      providerReferenceId: "BANK.AB12",
    }),
    clients(calls, result),
    admin,
    attemptId,
  );
  assert(
    firstHash === calls[1]?.[1].p_request_hash,
    "raw case does not change canonical replay hash",
  );
  await recordPayrollPaymentCheck(
    request("check", {
      expectedVersion: 1,
      reasonCode: "TRANSFER_RESULT_UNCERTAIN",
    }),
    clients(calls, {
      ...result,
      resultType: "check",
      beforeStatus: "paying",
      afterStatus: "check",
      paymentMethod: undefined,
      providerReferenceId: undefined,
      reasonCode: "TRANSFER_RESULT_UNCERTAIN",
    }),
    admin,
    attemptId,
  );
  await reopenPayrollPayment(
    request("reopen", {
      expectedVersion: 2,
      reasonCode: "NO_TRANSFER_CONFIRMED",
    }),
    clients(calls, {
      ...result,
      resultType: "reopened",
      afterStatus: "open",
      paymentMethod: undefined,
      providerReferenceId: undefined,
      reasonCode: "NO_TRANSFER_CONFIRMED",
    }),
    admin,
    attemptId,
  );
  for (
    const body of [
      {
        expectedVersion: 0,
        paymentMethod: "bank_transfer",
        providerReferenceId: "BANK.AB12",
      },
      {
        expectedVersion: 2,
        paymentMethod: "bank_transfer",
        providerReferenceId: "www.ab12",
      },
      {
        expectedVersion: 2,
        paymentMethod: "bank_transfer",
        providerReferenceId: "AB1234567",
      },
      {
        expectedVersion: 2,
        paymentMethod: "bank_transfer",
        providerReferenceId: "BANK.AB12",
        amount: 1,
      },
      {
        expectedVersion: 2,
        paymentMethod: "bank_transfer",
        providerReferenceId: "BANK.AB12",
        paidAt: result.occurredAt,
      },
    ]
  ) {
    try {
      await recordPayrollPaymentPaid(
        request("paid", body),
        clients([], result),
        admin,
        attemptId,
      );
      throw new Error("invalid payment evidence accepted");
    } catch (error) {
      assert(
        ["VALIDATION_ERROR", "PAYROLL_PAYMENT_REFERENCE_INVALID"].includes(
          (error as { code?: string }).code ?? "",
        ),
        "invalid client evidence rejected",
      );
    }
  }
});

Deno.test("payroll adjustment commands keep typed source and fixed command hashes", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const adjustment = {
    adjustmentId: "70000000-0000-4000-8000-000000000001",
    maidProfileId: maid.profileId,
    bookVersion: 1,
    amount: -1000,
    currency: "KRW",
    reasonCode: "earning_correction",
    rootEarningId: "30000000-0000-4000-8000-000000000001",
    correctionOfEarningId: "30000000-0000-4000-8000-000000000001",
    availableWeekStart: "2026-08-24",
    createdAt: "2026-09-10T00:00:00Z",
  };
  const request = (path: string, body: unknown) =>
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "payroll-adjust-edge",
      },
      body: JSON.stringify(body),
    });
  await correctPayrollAdjustment(
    request("/v1/payroll/adjustments/corrections", {
      sourceEarningId: adjustment.rootEarningId,
      amount: -1000,
      expectedVersion: 0,
    }),
    clients(calls, adjustment),
    admin,
  );
  await reversePayrollSource(
    request("/v1/payroll/adjustments/reversals", {
      sourceAdjustmentId: adjustment.adjustmentId,
      expectedVersion: 1,
    }),
    clients(calls, {
      ...adjustment,
      amount: 1000,
      reasonCode: "adjustment_reversal",
      correctionOfEarningId: undefined,
      reversalOfAdjustmentId: adjustment.adjustmentId,
    }),
    admin,
  );
  await carryForwardPayroll(
    request("/v1/payroll/carry-forward", {
      maidProfileId: maid.profileId,
      weekStart: "2026-08-24",
      expectedVersion: 0,
    }),
    clients(calls, projection),
    admin,
  );
  await carryLatePayrollEarning(
    request(`/v1/payroll/late-earnings/${adjustment.rootEarningId}/carry`, {
      expectedVersion: 2,
    }),
    clients(calls, {
      ...adjustment,
      amount: 1000,
      reasonCode: "late_earning_carry",
      correctionOfEarningId: undefined,
      lateCarriedEarningId: adjustment.rootEarningId,
    }),
    admin,
    adjustment.rootEarningId,
  );
  assert(
    calls.map(([name]) => name).join(",") ===
      "record_payroll_correction,reverse_payroll_source,carry_forward_payroll_cycle,carry_late_payroll_earning",
    "four exact RPCs",
  );
});

function clients(
  calls: Array<[string, Record<string, unknown>]>,
  value: unknown = {
    payroll: [projection],
    hasMore: false,
    lastMaidProfileId: maid.profileId,
  },
): EdgeClients {
  return {
    admin: {
      rpc: (name: string, args: Record<string, unknown>) => {
        calls.push([name, args]);
        return Promise.resolve({ data: value, error: null });
      },
    },
  } as unknown as EdgeClients;
}

Deno.test("payroll list is side-effect free and maid access is self-only", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const result = await listPayroll(
    new Request("http://localhost/v1/payroll?weekStart=2026-08-24"),
    clients(calls),
    maid,
  );
  const payroll = result.payroll as Array<Record<string, unknown>>;
  assert(
    payroll.length === 1 && payroll[0]?.cycleId === null,
    "conceptual OPEN",
  );
  assert(
    calls.length === 1 && calls[0]?.[0] === "list_payroll_cycles_page",
    "read RPC only",
  );
  assert(
    calls[0]?.[1].p_maid_profile_id === null,
    "DB enforces maid self scope",
  );

  for (const actor of [{ ...admin, role: "developer" as const }]) {
    try {
      await listPayroll(
        new Request("http://localhost/v1/payroll?weekStart=2026-08-24"),
        clients([]),
        actor,
      );
      throw new Error("developer accepted");
    } catch (error) {
      assert(
        (error as { code?: string }).code === "PAYROLL_ACCESS_REQUIRED",
        "developer denied",
      );
    }
  }
  try {
    await listPayroll(
      new Request(
        `http://localhost/v1/payroll?weekStart=2026-08-24&maidProfileId=${admin.profileId}`,
      ),
      clients([]),
      maid,
    );
    throw new Error("IDOR accepted");
  } catch (error) {
    assert(
      (error as { code?: string }).code === "PAYROLL_ACCESS_REQUIRED",
      "maid IDOR denied",
    );
  }
});

Deno.test("payroll cycle resolver uses the exact bounded read RPC", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const cycleId = "40000000-0000-4000-8000-000000000001";
  const result = await getPayrollCycle(
    new Request(`http://localhost/v1/payroll/${cycleId}`),
    clients(calls, { ...projection, cycleId, status: "paid", version: 3 }),
    admin,
    cycleId,
  );
  assert(
    result.cycleId === cycleId && result.status === "paid",
    "cycle projected",
  );
  assert(
    calls.length === 1 && calls[0]?.[0] === "get_payroll_cycle",
    "read RPC only",
  );
  assert(calls[0]?.[1].p_cycle_id === cycleId, "stable cycle ID forwarded");
});

Deno.test("payroll list rejects unknown, duplicate and invalid query values", async () => {
  for (
    const query of [
      "weekStart=2026-08-24&amount=1",
      "weekStart=2026-08-24&weekStart=2026-08-31",
      "weekStart=2026-02-30",
      "weekStart=2026-08-24&limit=0",
      "weekStart=2026-08-24&limit=11",
      "weekStart=2026-08-24&cursor=a&cursor=b",
    ]
  ) {
    try {
      await listPayroll(
        new Request(`http://localhost/v1/payroll?${query}`),
        clients([]),
        admin,
      );
      throw new Error("invalid query accepted");
    } catch (error) {
      assert(
        (error as { code?: string }).code === "VALIDATION_ERROR",
        "query rejected",
      );
    }
  }
});

Deno.test("payroll cursors bind actor, role, week, filter, kind and reject tampering", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const first = await listPayroll(
    new Request("http://localhost/v1/payroll?weekStart=2026-08-24&limit=10"),
    clients(calls, {
      payroll: [projection],
      hasMore: true,
      lastMaidProfileId: maid.profileId,
    }),
    admin,
  );
  const cursor = first.nextCursor as string;
  assert(typeof cursor === "string" && cursor.includes("."), "signed cursor");

  await listPayroll(
    new Request(
      `http://localhost/v1/payroll?weekStart=2026-08-24&cursor=${cursor}`,
    ),
    clients(calls, {
      payroll: [],
      hasMore: false,
      lastMaidProfileId: null,
    }),
    admin,
  );
  assert(
    calls[1]?.[1].p_after_maid_profile_id === maid.profileId,
    "keyset position forwarded",
  );

  const altered = cursor.slice(0, -1) + (cursor.endsWith("A") ? "B" : "A");
  for (
    const [actor, queryValue] of [
      [admin, `weekStart=2026-08-17&cursor=${cursor}`],
      [
        admin,
        `weekStart=2026-08-24&maidProfileId=${maid.profileId}&cursor=${cursor}`,
      ],
      [
        { ...admin, profileId: maid.profileId },
        `weekStart=2026-08-24&cursor=${cursor}`,
      ],
      [
        { ...admin, role: "maid" as const },
        `weekStart=2026-08-24&cursor=${cursor}`,
      ],
      [admin, `weekStart=2026-08-24&cursor=${altered}`],
    ] as const
  ) {
    try {
      await listPayroll(
        new Request(`http://localhost/v1/payroll?${queryValue}`),
        clients([]),
        actor,
      );
      throw new Error("cross-scope cursor accepted");
    } catch (error) {
      assert(
        (error as { code?: string }).code === "PAYROLL_CURSOR_INVALID",
        "cursor scope rejected",
      );
    }
  }
});

Deno.test("payroll entries use bounded keyset pages and preserve maid self scope", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const first = await listPayroll(
    new Request("http://localhost/v1/payroll?weekStart=2026-08-24"),
    clients(calls, {
      payroll: [{ ...projection, itemCount: 2, itemsHasMore: true }],
      hasMore: false,
      lastMaidProfileId: maid.profileId,
    }),
    admin,
  );
  const itemCursor = (first.payroll as Array<Record<string, unknown>>)[0]
    ?.itemsNextCursor;
  assert(typeof itemCursor === "string", "nested cursor emitted");
  const next = {
    earningId: "30000000-0000-4000-8000-000000000002",
    earnedOn: "2026-08-25",
    amount: 20000,
    alreadyClaimed: false,
  };
  const page = await listPayrollEntries(
    new Request(
      `http://localhost/v1/payroll/entries?weekStart=2026-08-24&maidProfileId=${maid.profileId}&kind=items&limit=25&cursor=${itemCursor}`,
    ),
    clients(calls, {
      entries: [next],
      hasMore: false,
      lastEarnedOn: next.earnedOn,
      lastEarningId: next.earningId,
    }),
    admin,
  );
  assert((page.entries as unknown[]).length === 1, "entry returned");
  assert(page.nextCursor === null, "final page");
  assert(calls[1]?.[0] === "list_payroll_entries_page", "entry RPC");
  assert(
    calls[1]?.[1].p_after_earning_id === projection.itemsLastEarningId,
    "entry keyset",
  );

  try {
    await listPayrollEntries(
      new Request(
        `http://localhost/v1/payroll/entries?weekStart=2026-08-24&maidProfileId=${maid.profileId}&kind=lateEarnings&cursor=${itemCursor}`,
      ),
      clients([]),
      admin,
    );
    throw new Error("cross-kind cursor accepted");
  } catch (error) {
    assert(
      (error as { code?: string }).code === "PAYROLL_CURSOR_INVALID",
      "cross-kind cursor denied",
    );
  }

  try {
    await listPayrollEntries(
      new Request(
        `http://localhost/v1/payroll/entries?weekStart=2026-08-24&maidProfileId=${admin.profileId}&kind=items`,
      ),
      clients([]),
      maid,
    );
    throw new Error("cross-maid entries accepted");
  } catch (error) {
    assert(
      (error as { code?: string }).code === "PAYROLL_ACCESS_REQUIRED",
      "cross-maid entries denied",
    );
  }
});

Deno.test("payroll cursor secret is required and at least 32 UTF-8 bytes", async () => {
  const previous = Deno.env.get("PAYROLL_CURSOR_HMAC_SECRET");
  const previousPhonePepper = Deno.env.get("ACCOUNT_PHONE_PEPPER");
  try {
    const signed = await listPayroll(
      new Request("http://localhost/v1/payroll?weekStart=2026-08-24"),
      clients([], {
        payroll: [projection],
        hasMore: true,
        lastMaidProfileId: maid.profileId,
      }),
      admin,
    );
    Deno.env.set(
      "PAYROLL_CURSOR_HMAC_SECRET",
      "different-payroll-cursor-secret-for-tests-123456",
    );
    try {
      await listPayroll(
        new Request(
          `http://localhost/v1/payroll?weekStart=2026-08-24&cursor=${signed.nextCursor}`,
        ),
        clients([]),
        admin,
      );
      throw new Error("wrong-secret cursor accepted");
    } catch (error) {
      assert(
        (error as { code?: string }).code === "PAYROLL_CURSOR_INVALID",
        "wrong-secret cursor rejected",
      );
    }
    const reused = "shared-secret-that-must-not-be-reused-123456";
    Deno.env.set("ACCOUNT_PHONE_PEPPER", reused);
    for (const secret of [undefined, "short", reused]) {
      if (secret === undefined) Deno.env.delete("PAYROLL_CURSOR_HMAC_SECRET");
      else Deno.env.set("PAYROLL_CURSOR_HMAC_SECRET", secret);
      try {
        await listPayroll(
          new Request("http://localhost/v1/payroll?weekStart=2026-08-24"),
          clients([]),
          admin,
        );
        throw new Error("invalid secret accepted");
      } catch (error) {
        assert(
          (error as { code?: string }).code ===
            "PAYROLL_CURSOR_NOT_CONFIGURED",
          "cursor secret rejected",
        );
      }
    }
  } finally {
    if (previous === undefined) Deno.env.delete("PAYROLL_CURSOR_HMAC_SECRET");
    else Deno.env.set("PAYROLL_CURSOR_HMAC_SECRET", previous);
    if (previousPhonePepper === undefined) {
      Deno.env.delete("ACCOUNT_PHONE_PEPPER");
    } else Deno.env.set("ACCOUNT_PHONE_PEPPER", previousPhonePepper);
  }
});

Deno.test("payroll start sends exact actor-scoped idempotent command and strict projection", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const paying = {
    ...projection,
    cycleId: "40000000-0000-4000-8000-000000000001",
    status: "paying",
    version: 1,
    lockedAmount: 30000,
    paymentStartedAt: "2026-09-10T00:00:00Z",
    rawRequestBody: "must-not-leak",
    lateEarningCount: 1,
    lateEarningAmount: 10000,
    lateEarnings: [{
      earningId: "30000000-0000-4000-8000-000000000002",
      earnedOn: "2026-08-26",
      amount: "10000",
      secret: "must-not-leak",
    }],
  };
  const request = () =>
    new Request("http://localhost/v1/payroll/start", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "payroll-start-0001",
      },
      body: JSON.stringify({
        maidProfileId: maid.profileId,
        weekStart: "2026-08-24",
        expectedVersion: 0,
      }),
    });
  const first = await startPayroll(request(), clients(calls, paying), admin);
  const replay = await startPayroll(request(), clients(calls, paying), admin);
  assert(
    first.status === "paying" && first.lateEarningAmount === 10000,
    "PAYING projection",
  );
  assert(!JSON.stringify(first).includes("must-not-leak"), "strict projection");
  assert(replay.cycleId === first.cycleId, "same logical replay projection");
  assert(
    calls.every(([name]) => name === "start_payroll_cycle"),
    "single command RPC",
  );
  assert(
    calls[0]?.[1].p_request_hash === calls[1]?.[1].p_request_hash,
    "stable replay hash",
  );
  assert(
    typeof calls[0]?.[1].p_request_hash === "string",
    "request hash supplied",
  );
});

Deno.test("payroll start rejects non-admin, query aliases and client-controlled amount", async () => {
  const body = {
    maidProfileId: maid.profileId,
    weekStart: "2026-08-24",
    expectedVersion: 0,
  };
  const request = (url: string, value: Record<string, unknown>) =>
    new Request(url, {
      method: "POST",
      headers: { "idempotency-key": "payroll-start-0002" },
      body: JSON.stringify(value),
    });
  for (
    const [actor, url, value, code] of [
      [maid, "http://localhost/v1/payroll/start", body, "ADMIN_REQUIRED"],
      [
        admin,
        "http://localhost/v1/payroll/start?amount=1",
        body,
        "VALIDATION_ERROR",
      ],
      [
        admin,
        "http://localhost/v1/payroll/start",
        { ...body, amount: 30000 },
        "VALIDATION_ERROR",
      ],
    ] as const
  ) {
    try {
      await startPayroll(request(url, value), clients([]), actor);
      throw new Error("invalid start accepted");
    } catch (error) {
      assert((error as { code?: string }).code === code, `${code} expected`);
    }
  }
});

Deno.test("payroll database errors keep stable codes and redact unknown details", () => {
  const conflict = payrollDatabaseError({ message: "NO_PAYROLL_AMOUNT raw" });
  assert(
    conflict.status === 409 && conflict.code === "NO_PAYROLL_AMOUNT",
    "stable conflict",
  );
  const invalidPage = payrollDatabaseError({
    message: "PAYROLL_PAGE_LIMIT_INVALID private SQL",
  });
  assert(
    invalidPage.status === 400 &&
      invalidPage.code === "PAYROLL_PAGE_LIMIT_INVALID" &&
      !invalidPage.message.includes("SQL"),
    "stable redacted page error",
  );
  const priorLate = payrollDatabaseError({
    message: "PAYROLL_PRIOR_LATE_EARNING_PENDING private SQL",
  });
  assert(
    priorLate.status === 409 &&
      priorLate.code === "PAYROLL_PRIOR_LATE_EARNING_PENDING" &&
      !priorLate.message.includes("SQL"),
    "prior late earning has a stable redacted conflict",
  );
  const unknown = payrollDatabaseError({
    message: "postgres credential detail",
  });
  assert(
    unknown.status === 500 && unknown.code === "PAYROLL_COMMAND_FAILED",
    "safe fallback",
  );
  assert(!unknown.message.includes("postgres"), "raw database detail redacted");
});

Deno.test("payroll projection fails closed on malformed UUID, date and ISO timestamp", async () => {
  for (
    const malformed of [
      { ...projection, maidProfileId: "not-a-uuid" },
      { ...projection, weekStart: "2026-02-30" },
      { ...projection, paymentStartedAt: "2026" },
      { ...projection, checkReasonCode: "LEGACY_BANK_STATUS_PENDING" },
      {
        ...projection,
        lastReopenReasonCode: "LEGACY_OPERATOR_CONFIRMED_NO_TRANSFER",
      },
      {
        ...projection,
        items: Array.from({ length: 11 }, () => projection.items[0]),
      },
    ]
  ) {
    try {
      await listPayroll(
        new Request("http://localhost/v1/payroll?weekStart=2026-08-24"),
        clients([], {
          payroll: [malformed],
          hasMore: false,
          lastMaidProfileId: null,
        }),
        admin,
      );
      throw new Error("malformed projection accepted");
    } catch (error) {
      assert(
        (error as { code?: string }).code === "PAYROLL_COMMAND_FAILED",
        "malformed projection rejected",
      );
    }
  }
});
