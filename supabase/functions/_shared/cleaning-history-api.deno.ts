import { listCleaningHistory } from "./cleaning-history-api.ts";
import { type EdgeActor, type EdgeClients, EdgeError } from "./runtime.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const session = "20400000-0000-4000-8000-000000000001";
const payload = btoa(JSON.stringify({ session_id: session })).replaceAll(
  "+",
  "-",
).replaceAll("/", "_").replaceAll("=", "");
const token = `e30.${payload}.x`;
const maid: EdgeActor = {
  authUserId: "20400000-0000-4000-8000-000000000002",
  profileId: "20400000-0000-4000-8000-000000000003",
  displayName: "이력 메이드",
  role: "maid",
  mustChangePassword: false,
};
function request(query: string) {
  return new Request(`http://localhost/v1/cleaning-history${query}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}
function clients(data: unknown, error: string | null = null) {
  const calls: unknown[] = [];
  return {
    calls,
    value: {
      admin: {
        rpc(name: string, args: Record<string, unknown>) {
          calls.push({ name, args });
          return Promise.resolve({
            data,
            error: error ? { message: error } : null,
          });
        },
      },
    } as unknown as EdgeClients,
  };
}

Deno.test("cleaning history Edge adapter binds KST date, session, projection and cursor", async () => {
  const mock = clients({
    date: "2026-09-19",
    fromDate: "2026-09-13",
    toDate: "2026-09-19",
    items: [{
      submissionId: null,
      attemptId: "20400000-0000-4000-8000-000000000004",
      cleaningTargetId: "20400000-0000-4000-8000-000000000005",
      roomId: "20400000-0000-4000-8000-000000000006",
      roomNumber: "101",
      roomTypeCode: "standard",
      roomTypeName: "스탠다드",
      performerProfileId: maid.profileId,
      performerDisplayName: maid.displayName,
      cleaningKind: "checkout",
      originalServiceDate: "2026-09-19",
      serviceDate: "2026-09-19",
      startedAt: "2026-09-19T00:00:00Z",
      fieldCompletedAt: "2026-09-19T01:00:00Z",
      submittedAt: null,
      inspectionStatus: "not_submitted",
      decidedAt: null,
      photoCount: 0,
      mediaAvailability: "not_submitted",
      expiresAt: null,
      baseFeeSnapshot: 16000,
      earningTotalAmount: null,
    }],
    nextCursor: {
      fieldCompletedAt: "2026-09-19T01:00:00Z",
      attemptId: "20400000-0000-4000-8000-000000000004",
    },
  });
  const result = await listCleaningHistory(
    request("?date=2026-09-19&limit=1"),
    mock.value,
    maid,
  );
  assert(
    Array.isArray(result.items) && result.items.length === 1,
    "one safe item",
  );
  assert(typeof result.nextCursor === "string", "opaque cursor");
  assert(
    JSON.stringify(result).includes("스탠다드") &&
      !JSON.stringify(result).includes("locator"),
    "safe labels only",
  );
  assert(JSON.stringify(mock.calls).includes(session), "session bound");
});

Deno.test("cleaning history rejects malformed dates and other-maid denial is stable", async () => {
  const mock = clients(null, "CLEANING_HISTORY_MAID_SCOPE_REQUIRED");
  try {
    await listCleaningHistory(request("?date=2026-02-30"), mock.value, maid);
    throw new Error("expected validation error");
  } catch (error) {
    assert(
      error instanceof EdgeError &&
        error.code === "INVALID_CLEANING_HISTORY_QUERY",
      "invalid date",
    );
  }
  try {
    await listCleaningHistory(
      request(
        "?date=2026-09-19&maidProfileId=20400000-0000-4000-8000-000000000099",
      ),
      mock.value,
      maid,
    );
    throw new Error("expected scope error");
  } catch (error) {
    assert(
      error instanceof EdgeError &&
        error.code === "CLEANING_HISTORY_MAID_SCOPE_REQUIRED",
      "other maid denied",
    );
  }
});
