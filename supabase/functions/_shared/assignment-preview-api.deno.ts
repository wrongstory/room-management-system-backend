import {
  assignmentDurationPolicy,
  previewAssignments,
  previewDatabaseError,
  previewServiceDate,
} from "./assignment-preview-api.ts";
import { type EdgeActor, type EdgeClients, EdgeError } from "./runtime.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const admin: EdgeActor = {
  authUserId: "10000000-0000-4000-8000-000000000001",
  profileId: "20000000-0000-4000-8000-000000000001",
  role: "admin",
  displayName: "관리자",
  mustChangePassword: false,
};
const today = () =>
  new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
function request(body: unknown, method = "POST") {
  return new Request(
    "http://localhost/functions/v1/api/v1/assignments/preview",
    {
      method,
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "preview-config-001",
      },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    },
  );
}
async function failure(run: () => Promise<unknown>, code: string) {
  try {
    await run();
  } catch (e) {
    assert(e instanceof EdgeError && e.code === code, `expected ${code}`);
    return;
  }
  throw new Error(`expected ${code}`);
}
function clients(error: string | null = null, data: unknown = null) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    client: {
      admin: {
        rpc: (name: string, args: Record<string, unknown>) => {
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

Deno.test("preview rejects malformed input before readonly RPC", async () => {
  const mock = clients();
  for (
    const body of [
      {},
      { serviceDate: "2026-02-30" },
      { serviceDate: "2000-01-01" },
      { serviceDate: today(), extra: true },
      ...["", "bad seed", "x".repeat(129), 4, null].map((previewSeed) => ({
        serviceDate: today(),
        previewSeed,
      })),
    ]
  ) {
    await failure(
      () => previewAssignments(request(body), mock.client, admin),
      "serviceDate" in body && body.serviceDate === today()
        ? "VALIDATION_ERROR"
        : "ASSIGNMENT_PREVIEW_DATE_NOT_ALLOWED",
    );
  }
  assert(mock.calls.length === 0, "invalid input must not query DB");
  assert(
    previewServiceDate("2030-01-01", new Date("2029-12-31T15:01:00Z")) ===
      "2030-01-01",
    "KST date",
  );
  assert(
    previewServiceDate("2030-01-02", new Date("2029-12-31T15:01:00Z")) ===
      "2030-01-02",
    "KST tomorrow",
  );
});

Deno.test("preview enforces business admin and password gate", async () => {
  const mock = clients();
  for (const role of ["maid", "developer"] as const) {
    await failure(
      () =>
        previewAssignments(request({ serviceDate: today() }), mock.client, {
          ...admin,
          role,
        }),
      "ADMIN_REQUIRED",
    );
  }
  await failure(
    () =>
      previewAssignments(request({ serviceDate: today() }), mock.client, {
        ...admin,
        mustChangePassword: true,
      }),
    "PASSWORD_CHANGE_REQUIRED",
  );
  assert(mock.calls.length === 0, "role denied before RPC");
});

Deno.test("preview unconfirmed/limit failures are stable and raw DB failures redact", async () => {
  const absent = clients("ASSIGNMENT_PREVIEW_DURATION_POLICY_UNCONFIRMED");
  const result = await previewAssignments(
    request({ serviceDate: today() }),
    absent.client,
    admin,
  );
  assert(
    result.decisionReady === false && result.proposedAssignments.length === 0 &&
      result.error.code === "ASSIGNMENT_PREVIEW_DURATION_POLICY_UNCONFIRMED",
    "unconfirmed never decision ready",
  );
  for (
    const code of [
      "ASSIGNMENT_PREVIEW_LIMIT_EXCEEDED",
      "PROFILE_INACTIVE",
      "ACTIVE_ACCOUNT_REQUIRED",
    ]
  ) {
    const mock = clients(code);
    await failure(
      () =>
        previewAssignments(
          request({ serviceDate: today() }),
          mock.client,
          admin,
        ),
      code,
    );
    assert(
      mock.calls.length === 1 &&
        mock.calls[0].name === "get_assignment_preview_snapshot",
      "only read snapshot invoked",
    );
    assert(!("p_idempotency_key" in mock.calls[0].args), "no preview receipt");
  }
  const error = previewDatabaseError({
    message: "database contains token secret phone raw query",
  });
  assert(
    error.status === 500 && error.code === "ASSIGNMENT_PREVIEW_FAILED" &&
      !error.message.includes("token"),
    "redacted failure",
  );
});

Deno.test("duration config requires complete positive integer values and CAS, canonical replay hash", async () => {
  const data = {
    id: admin.profileId,
    version: 1,
    status: "confirmed",
    standardMinutes: 30,
    premiumMinutes: 40,
    oceanPremiumMinutes: 50,
    oceanFamilyMinutes: 60,
    createdAt: "2030-01-01T00:00:00Z",
    confirmedAt: "2030-01-01T00:00:00Z",
    rawSecret: "hidden",
  };
  const mock = clients(null, data);
  const body = {
    expectedVersion: 0,
    standardMinutes: 30,
    premiumMinutes: 40,
    oceanPremiumMinutes: 50,
    oceanFamilyMinutes: 60,
  };
  const result = await assignmentDurationPolicy(
    request(body),
    mock.client,
    admin,
  );
  await assignmentDurationPolicy(
    request({
      oceanFamilyMinutes: 60,
      oceanPremiumMinutes: 50,
      premiumMinutes: 40,
      standardMinutes: 30,
      expectedVersion: 0,
    }),
    mock.client,
    admin,
  );
  assert(
    mock.calls[0].args.p_request_hash === mock.calls[1].args.p_request_hash,
    "key order independent request hash",
  );
  assert(
    !JSON.stringify(result).includes("hidden"),
    "config projection safe fields only",
  );
  for (
    const invalid of [
      { ...body, standardMinutes: 0 },
      { ...body, premiumMinutes: 1.5 },
      { ...body, expectedVersion: -1 },
      { ...body, extra: true },
      { standardMinutes: 30 },
    ]
  ) {
    await failure(
      () => assignmentDurationPolicy(request(invalid), mock.client, admin),
      "INVALID_ASSIGNMENT_DURATION_POLICY",
    );
  }
  assert(mock.calls.length === 2, "bad config never writes");
  const reused = clients("IDEMPOTENCY_KEY_REUSED");
  await failure(
    () => assignmentDurationPolicy(request(body), reused.client, admin),
    "IDEMPOTENCY_KEY_REUSED",
  );
  assert(
    previewDatabaseError({ message: "IDEMPOTENCY_KEY_REUSED" }).status === 409,
    "same key different payload conflicts",
  );
  const absent = clients(null, null);
  assert(
    await assignmentDurationPolicy(
      request(null, "GET"),
      absent.client,
      admin,
    ) === null,
    "unconfirmed GET returns null not seed",
  );
});
