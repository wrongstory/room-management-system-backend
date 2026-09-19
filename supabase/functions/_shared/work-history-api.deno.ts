import { listWorkHistory } from "./work-history-api.ts";
import { type EdgeActor, type EdgeClients, EdgeError } from "./runtime.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const sessionId = "e2060000-0000-4000-8000-000000000201";
const profileId = "e2060000-0000-4000-8000-000000000002";
const jwtPayload = btoa(JSON.stringify({ session_id: sessionId })).replaceAll(
  "+",
  "-",
).replaceAll("/", "_").replaceAll("=", "");
const actor: EdgeActor = {
  authUserId: "e2060000-0000-4000-8000-000000000102",
  profileId,
  displayName: "기록 메이드",
  role: "maid",
  mustChangePassword: false,
};

function request(query: string): Request {
  return new Request(`http://localhost/v1/work-history${query}`, {
    headers: { authorization: `Bearer e30.${jwtPayload}.x` },
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

function page(nextCursor: Record<string, unknown> | null = null) {
  return {
    weekStart: "2026-09-14",
    weekEnd: "2026-09-20",
    timezone: "Asia/Seoul",
    summary: {
      maidCount: 1,
      availabilityMaidCount: 1,
      availabilityDayCount: 1,
      notifiedMaidCount: 1,
      notifiedDayCount: 1,
      fieldCompletedMaidCount: 1,
      fieldCompletedDayCount: 1,
    },
    items: [{
      maidProfileId: profileId,
      maidDisplayName: "현재 표시명",
      maidDisplayNameSource: "current_profile",
      availabilitySubmittedAt: "2026-09-13T04:00:00Z",
      availabilityCurrentVersion: 2,
      availabilityVersionCount: 2,
      days: Array.from({ length: 7 }, (_, index) => ({
        date: `2026-09-${String(14 + index).padStart(2, "0")}`,
        availableSubmitted: index === 0,
        assignmentNotified: index === 0,
        fieldCompleted: index === 0,
      })),
    }],
    nextCursor,
  };
}

Deno.test("work history Edge adapter keeps the three axes and binds the live session", async () => {
  const mock = clients(page({ maidProfileId: profileId }));
  const result = await listWorkHistory(
    request("?weekStart=2026-09-14&limit=1"),
    mock.value,
    actor,
  );
  const item = (result.items as Record<string, unknown>[])[0];
  const firstDay = (item.days as Record<string, unknown>[])[0];
  assert(firstDay.availableSubmitted === true, "availability axis");
  assert(firstDay.assignmentNotified === true, "notified axis");
  assert(firstDay.fieldCompleted === true, "completion axis");
  assert(item.maidDisplayNameSource === "current_profile", "current label");
  assert(typeof result.nextCursor === "string", "opaque cursor");
  assert(JSON.stringify(mock.calls).includes(sessionId), "session bound");
});

Deno.test("work history Edge adapter rejects non-Monday and cross-maid scope", async () => {
  const mock = clients(null, "WORK_HISTORY_MAID_SCOPE_REQUIRED");
  try {
    await listWorkHistory(
      request("?weekStart=2026-09-15"),
      mock.value,
      actor,
    );
    throw new Error("expected date validation");
  } catch (error) {
    assert(
      error instanceof EdgeError &&
        error.code === "INVALID_WORK_HISTORY_QUERY",
      "non-Monday rejected",
    );
  }
  try {
    await listWorkHistory(
      request(
        "?weekStart=2026-09-14&maidProfileId=e2060000-0000-4000-8000-000000000003",
      ),
      mock.value,
      actor,
    );
    throw new Error("expected scope denial");
  } catch (error) {
    assert(
      error instanceof EdgeError &&
        error.code === "WORK_HISTORY_MAID_SCOPE_REQUIRED",
      "cross-maid scope rejected",
    );
  }
});
