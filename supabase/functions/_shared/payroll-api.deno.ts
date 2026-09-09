import {
  listPayroll,
  payrollDatabaseError,
  startPayroll,
} from "./payroll-api.ts";
import type { EdgeActor, EdgeClients } from "./runtime.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

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
  lateEarningCount: 0,
  lateEarningAmount: 0,
  lateEarnings: [],
};

function clients(
  calls: Array<[string, Record<string, unknown>]>,
  value: unknown = [projection],
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
  assert(result.length === 1 && result[0]?.cycleId === null, "conceptual OPEN");
  assert(
    calls.length === 1 && calls[0]?.[0] === "list_payroll_cycles",
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
    ]
  ) {
    try {
      await listPayroll(
        new Request("http://localhost/v1/payroll?weekStart=2026-08-24"),
        clients([], [malformed]),
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
