import { type ApiHandlerDependencies, handleApiRequest } from "./index.ts";
import {
  type EdgeActor,
  type EdgeClients,
  EdgeError,
} from "../_shared/runtime.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const actor: EdgeActor = {
  authUserId: "10000000-0000-4000-8000-000000000001",
  profileId: "20000000-0000-4000-8000-000000000001",
  role: "admin",
  displayName: "synthetic",
  mustChangePassword: false,
};
const sessionId = "30000000-0000-4000-8000-000000000001";
const roomId = "40000000-0000-4000-8000-000000000001";
const incidentId = "50000000-0000-4000-8000-000000000001";
const targetId = "60000000-0000-4000-8000-000000000001";
const assignmentId = "70000000-0000-4000-8000-000000000001";
const attemptId = "80000000-0000-4000-8000-000000000001";
function request(method = "GET", path = "/v1/checkout-incidents") {
  const payload = btoa(JSON.stringify({ session_id: sessionId })).replaceAll(
    "+",
    "-",
  ).replaceAll("/", "_").replaceAll("=", "");
  return new Request(`http://localhost/functions/v1/api${path}`, {
    method,
    headers: { authorization: `Bearer e30.${payload}.signature` },
  });
}
function item(extra: Record<string, unknown> = {}) {
  return {
    incidentId,
    status: "open",
    roomId,
    roomNumber: "350",
    cleaningTargetId: targetId,
    assignmentId,
    attemptId,
    reportedAt: "2026-10-03T00:00:00.123456Z",
    serviceDate: "2026-10-02",
    allowedDecisions: ["EXTEND_CHECKOUT", "CONFIRM_DEPARTED", "FALSE_REPORT"],
    ...extra,
  };
}
function dependencies(data: unknown, failure: string | null = null) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const options: ApiHandlerDependencies = {
    authenticateRequest: () => Promise.resolve(actor),
    createClients: () => ({
      admin: {
        rpc(name: string, args: Record<string, unknown>) {
          calls.push({ name, args });
          return Promise.resolve({
            data: failure ? null : data,
            error: failure ? { message: failure } : null,
          });
        },
      },
    } as unknown as EdgeClients),
  };
  return { options, calls };
}
async function configured(action: () => Promise<void>) {
  const original = Deno.env.get("INSPECTION_CURSOR_HMAC_SECRET");
  Deno.env.set(
    "INSPECTION_CURSOR_HMAC_SECRET",
    "checkout-incident-router-test-distinct-secret-123456789",
  );
  try {
    await action();
  } finally {
    if (original === undefined) {
      Deno.env.delete("INSPECTION_CURSOR_HMAC_SECRET");
    } else Deno.env.set("INSPECTION_CURSOR_HMAC_SECRET", original);
  }
}
async function errorCode(response: Response): Promise<string> {
  return (await response.json()).error.code;
}

Deno.test("checkout collection exact HTTP route uses minimal no-store page and last-returned anchor", async () => {
  await configured(async () => {
    const lower = item({
      incidentId: "50000000-0000-4000-8000-000000000002",
      reportedAt: "2026-10-03T00:00:00.123455Z",
    });
    const fixture = dependencies({ items: [item(), lower] });
    const response = await handleApiRequest(
      request("GET", "/v1/checkout-incidents?limit=1"),
      fixture.options,
    );
    const body = await response.json();
    assert(
      response.status === 200 &&
        response.headers.get("cache-control") === "no-store" &&
        Object.keys(body).sort().join(",") === "items,nextCursor",
      "collection public shape",
    );
    assert(
      body.items.length === 1 &&
        body.items[0].reportedAt === "2026-10-03T00:00:00.123456Z" &&
        typeof body.nextCursor === "string",
      "lossless timestamp and lookahead excluded",
    );
    assert(
      fixture.calls.length === 1 &&
        fixture.calls[0].name === "list_checkout_presence_incidents_page" &&
        fixture.calls[0].args.p_session_id === sessionId,
      "exact latest session RPC only",
    );
    const nextFixture = dependencies({ items: [lower] });
    const next = await handleApiRequest(
      request(
        "GET",
        `/v1/checkout-incidents?cursor=${body.nextCursor}&limit=100`,
      ),
      nextFixture.options,
    );
    assert(
      next.status === 200 && (await next.json()).nextCursor === null &&
        nextFixture.calls[0].args.p_after_reported_at ===
          "2026-10-03T00:00:00.123456Z" &&
        nextFixture.calls[0].args.p_after_incident_id === incidentId,
      "anchor is returned row and limit may change",
    );
    const emptyFixture = dependencies({ items: [] });
    const empty = await handleApiRequest(request(), emptyFixture.options);
    assert(
      empty.status === 200 && (await empty.json()).items.length === 0 &&
        emptyFixture.calls.length === 1,
      "empty route still validates latest DB identity",
    );
  });
});

Deno.test("checkout collection HTTP aliases methods and raw malformed queries fail closed no-store", async () => {
  await configured(async () => {
    for (
      const [method, path] of [
        ["POST", "/v1/checkout-incidents"],
        ["PATCH", "/v1/checkout-incidents"],
        ["GET", "/v1/checkout-incidents/"],
        ["GET", "/v1//checkout-incidents"],
        ["GET", "/v1/checkout-incidents/extra/path"],
      ]
    ) {
      const fixture = dependencies({ items: [] });
      const response = await handleApiRequest(
        request(method, path),
        fixture.options,
      );
      assert(
        response.status === 404 &&
          await errorCode(response) === "ROUTE_NOT_FOUND" &&
          response.headers.get("cache-control") === "no-store" &&
          fixture.calls.length === 0,
        `exact route ${path}`,
      );
    }
    for (
      const query of [
        "status=open",
        "roomId=",
        `roomId=${roomId}&roomId=${roomId}`,
        "cursor=",
        "limit=101",
        "limit=1.0",
        "serviceDate=2026-02-29",
      ]
    ) {
      const fixture = dependencies({ items: [] });
      const response = await handleApiRequest(
        request("GET", `/v1/checkout-incidents?${query}`),
        fixture.options,
      );
      assert(
        response.status === 400 &&
          await errorCode(response) === "VALIDATION_ERROR" &&
          response.headers.get("cache-control") === "no-store" &&
          fixture.calls.length === 0,
        "query failure before read RPC",
      );
    }
    const malformed = dependencies({
      items: [item({ reservationId: "private" })],
    });
    const fail = await handleApiRequest(request(), malformed.options);
    assert(
      fail.status === 500 &&
        await errorCode(fail) === "CHECKOUT_INCIDENT_COMMAND_FAILED" &&
        fail.headers.get("cache-control") === "no-store",
      "raw extra database fields never leak",
    );
    const oversized = dependencies({
      items: [item({ roomNumber: "가".repeat(44000) })],
    });
    const large = await handleApiRequest(request(), oversized.options);
    assert(
      large.status === 500 &&
        await errorCode(large) === "CHECKOUT_INCIDENT_COMMAND_FAILED" &&
        large.headers.get("cache-control") === "no-store",
      "UTF-8 response byte cap",
    );
  });
});

Deno.test("checkout collection HTTP latest role password and session denials retain no-store", async () => {
  await configured(async () => {
    for (const role of ["maid", "developer"] as const) {
      const fixture = dependencies({ items: [] });
      const response = await handleApiRequest(request(), {
        ...fixture.options,
        authenticateRequest: () => Promise.resolve({ ...actor, role }),
      });
      assert(
        response.status === 403 &&
          await errorCode(response) === "ADMIN_REQUIRED" &&
          fixture.calls.length === 0 &&
          response.headers.get("cache-control") === "no-store",
        "role gate before DB",
      );
    }
    const initialPassword = dependencies({ items: [] });
    const password = await handleApiRequest(request(), {
      ...initialPassword.options,
      authenticateRequest: () =>
        Promise.resolve({ ...actor, mustChangePassword: true }),
    });
    assert(
      password.status === 403 &&
        await errorCode(password) === "PASSWORD_CHANGE_REQUIRED" &&
        initialPassword.calls.length === 0 &&
        password.headers.get("cache-control") === "no-store",
      "initial password gate",
    );
    for (
      const [code, status] of [["SESSION_REVOKED", 401], [
        "PASSWORD_CHANGE_REQUIRED",
        403,
      ], ["ADMIN_REQUIRED", 403]] as const
    ) {
      const fixture = dependencies({ items: [] }, code);
      const response = await handleApiRequest(request(), fixture.options);
      assert(
        response.status === status && await errorCode(response) === code &&
          response.headers.get("cache-control") === "no-store" &&
          fixture.calls.length === 1,
        "RPC latest authority race gate",
      );
    }
    for (
      const [code, status] of [["SESSION_REVOKED", 401], [
        "ACCOUNT_INACTIVE",
        403,
      ], ["MISSING_ACCESS_TOKEN", 401]] as const
    ) {
      const fixture = dependencies({ items: [] });
      const response = await handleApiRequest(request(), {
        ...fixture.options,
        authenticateRequest: () =>
          Promise.reject(new EdgeError(status, code, "synthetic denied")),
      });
      assert(
        response.status === status && await errorCode(response) === code &&
          response.headers.get("cache-control") === "no-store" &&
          fixture.calls.length === 0,
        "auth errors retain no-store",
      );
    }
  });
});

Deno.test("checkout detail retains maid access and rejects collection filters on singular route", async () => {
  const fixture = dependencies({
    incidentId,
    reservationId: "90000000-0000-4000-8000-000000000001",
    roomId,
    cleaningTargetId: targetId,
    assignmentId,
    attemptId,
    reportedBy: actor.profileId,
    reasonCode: "GUEST_STILL_PRESENT",
    status: "open",
    version: 1,
    impactFingerprint: "a".repeat(64),
    reportedAt: "2026-10-03T00:00:00Z",
  });
  const options = {
    ...fixture.options,
    authenticateRequest: () =>
      Promise.resolve({ ...actor, role: "maid" as const }),
  };
  const detail = await handleApiRequest(
    request("GET", `/v1/checkout-incidents/${incidentId}`),
    options,
  );
  assert(
    detail.status === 200 &&
      (await detail.json()).incident.incidentId === incidentId &&
      fixture.calls[0].name === "get_checkout_presence_incident",
    "existing maid singular route maintained",
  );
  const rejected = await handleApiRequest(
    request("GET", `/v1/checkout-incidents/${incidentId}?roomId=${roomId}`),
    options,
  );
  assert(
    rejected.status === 400 &&
      await errorCode(rejected) === "VALIDATION_ERROR" &&
      fixture.calls.length === 1,
    "singular query policy unchanged",
  );
});
