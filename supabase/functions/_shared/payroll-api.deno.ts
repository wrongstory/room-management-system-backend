import {
  carryForwardPayroll,
  carryLatePayrollEarning,
  correctPayrollAdjustment,
  listPayroll,
  listPayrollEntries,
  payrollDatabaseError,
  reversePayrollSource,
  startPayroll,
} from "./payroll-api.ts";
import {
  assertPayrollResponseSize,
  PAYROLL_RESPONSE_MAX_BYTES,
} from "./payroll-cursor.ts";
import type { EdgeActor, EdgeClients } from "./runtime.ts";

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
};

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
