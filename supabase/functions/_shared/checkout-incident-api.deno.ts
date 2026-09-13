import {
  checkoutIncidentDatabaseError,
  checkoutIncidentPath,
  decideCheckoutIncident,
  getCheckoutIncident,
  reportCheckoutIncident,
} from "./checkout-incident-api.ts";
import { type EdgeActor, type EdgeClients, EdgeError } from "./runtime.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const ids = {
  actor: "10000000-0000-4000-8000-000000000001",
  incident: "20000000-0000-4000-8000-000000000001",
  reservation: "30000000-0000-4000-8000-000000000001",
  room: "40000000-0000-4000-8000-000000000001",
  target: "50000000-0000-4000-8000-000000000001",
  assignment: "60000000-0000-4000-8000-000000000001",
  attempt: "70000000-0000-4000-8000-000000000001",
  decision: "80000000-0000-4000-8000-000000000001",
  nextAssignment: "90000000-0000-4000-8000-000000000001",
  session: "a0000000-0000-4000-8000-000000000001",
};
const maid: EdgeActor = {
  authUserId: "b0000000-0000-4000-8000-000000000001",
  profileId: ids.actor,
  displayName: "테스트 메이드",
  role: "maid",
  mustChangePassword: false,
};
function token() {
  const payload = btoa(JSON.stringify({ session_id: ids.session }))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return `e30.${payload}.signature`;
}
function request(
  path: string,
  body?: unknown,
  key = "checkout-incident-key-1",
) {
  return new Request(`https://example.invalid${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token()}`,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
function incident(extra: Record<string, unknown> = {}) {
  return {
    incidentId: ids.incident,
    reservationId: ids.reservation,
    roomId: ids.room,
    cleaningTargetId: ids.target,
    assignmentId: ids.assignment,
    attemptId: ids.attempt,
    reportedBy: ids.actor,
    reasonCode: "GUEST_STILL_PRESENT",
    status: "open",
    version: 1,
    impactFingerprint: "a".repeat(64),
    reportedAt: "2026-09-13T06:00:00Z",
    ...extra,
  };
}
function clientsFor(data: unknown, errorCode?: string) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const clients = {
    admin: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return Promise.resolve({
          data: errorCode ? null : data,
          error: errorCode ? { message: errorCode } : null,
        });
      },
    },
  } as unknown as EdgeClients;
  return { clients, calls };
}
async function failure(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    if (error instanceof EdgeError) return error;
    throw error;
  }
  throw new Error("Expected failure");
}

Deno.test("checkout incident exact routes and report bind maid session CAS and idempotency", async () => {
  assert(
    checkoutIncidentPath(`/v1/attempts/${ids.attempt}/checkout-not-completed`)
      ?.kind === "report",
    "report route",
  );
  assert(
    checkoutIncidentPath(`/v1/checkout-incidents/${ids.incident}`)?.kind ===
        "detail" &&
      checkoutIncidentPath(`/v1/checkout-incidents/${ids.incident}/decision`)
          ?.kind === "decision",
    "detail and decision routes",
  );
  for (
    const path of [
      `/v1/attempts/${ids.attempt}/checkout-not-completed/extra`,
      `/v1/checkout-incidents/${ids.incident}/decision/extra`,
      `/v1/checkout-incidents/${ids.incident}/resolve`,
    ]
  ) assert(checkoutIncidentPath(path) === null, "aliases rejected");

  const { clients, calls } = clientsFor(
    incident({ rawPin: "1234", guestName: "비공개" }),
  );
  const result = await reportCheckoutIncident(
    request(`/v1/attempts/${ids.attempt}/checkout-not-completed`, {
      expectedExecutionVersion: 2,
      expectedAssignmentId: ids.assignment,
      expectedAssignmentRevision: 3,
    }),
    clients,
    maid,
    ids.attempt,
  );
  assert(
    calls.length === 1 && calls[0].name === "report_checkout_presence_incident",
    "report RPC",
  );
  assert(
    calls[0].args.p_session_id === ids.session &&
      calls[0].args.p_expected_execution_version === 2 &&
      /^[a-f0-9]{64}$/.test(String(calls[0].args.p_request_hash)),
    "session CAS and request hash",
  );
  assert(
    !JSON.stringify(result).includes("1234") &&
      !JSON.stringify(result).includes("비공개"),
    "safe projection",
  );
});

Deno.test("checkout incident decision is exact admin-only and nested projection is allowlisted", async () => {
  const admin = { ...maid, role: "admin" as const };
  const decided = incident({
    status: "resolved",
    version: 2,
    resolvedAt: "2026-09-13T06:10:00Z",
    currentDecisionId: ids.decision,
    decision: {
      decisionId: ids.decision,
      incidentId: ids.incident,
      incidentVersion: 1,
      decision: "CONFIRM_DEPARTED",
      reasonCode: "GUEST_DEPARTURE_CONFIRMED",
      decidedBy: ids.actor,
      decidedAt: "2026-09-13T06:10:00Z",
      nextAssignmentId: ids.nextAssignment,
      requestHash: "private",
    },
  });
  const { clients, calls } = clientsFor(decided);
  const body = {
    expectedVersion: 1,
    expectedImpactFingerprint: "a".repeat(64),
    decision: "CONFIRM_DEPARTED",
    reasonCode: "GUEST_DEPARTURE_CONFIRMED",
    newCheckoutAt: null,
    reassignment: {
      maidProfileId: ids.actor,
      sequenceNumber: 1,
      serviceDate: "2026-09-13",
      availableFrom: "2026-09-13T06:10:00Z",
      dueAt: "2026-09-13T07:10:00Z",
    },
  };
  const result = await decideCheckoutIncident(
    request(`/v1/checkout-incidents/${ids.incident}/decision`, body),
    clients,
    admin,
    ids.incident,
  );
  assert(
    calls[0].name === "decide_checkout_presence_incident" &&
      calls[0].args.p_session_id === ids.session &&
      calls[0].args.p_expected_impact_fingerprint === "a".repeat(64),
    "decision RPC",
  );
  assert(
    !JSON.stringify(result).includes("requestHash"),
    "nested extras redacted",
  );
  assert(
    (await failure(() =>
      decideCheckoutIncident(
        request(`/v1/checkout-incidents/${ids.incident}/decision`, body),
        clients,
        maid,
        ids.incident,
      )
    )).code === "ADMIN_REQUIRED",
    "maid cannot decide",
  );
  const malformedDecision = (decided as Record<string, unknown>)
    .decision as Record<string, unknown>;
  const malformed = clientsFor(
    incident({ decision: { ...malformedDecision, decidedAt: "bad" } }),
  );
  assert(
    (await failure(() =>
      getCheckoutIncident(
        request(`/v1/checkout-incidents/${ids.incident}`),
        malformed.clients,
        admin,
        ids.incident,
      )
    )).code === "CHECKOUT_INCIDENT_COMMAND_FAILED",
    "malformed nested projection fails closed",
  );
});

Deno.test("checkout incident request timestamps match Fastify offset ISO datetime validation", async () => {
  const admin = { ...maid, role: "admin" as const };
  const base = {
    expectedVersion: 1,
    expectedImpactFingerprint: "a".repeat(64),
    decision: "CONFIRM_DEPARTED",
    reasonCode: "GUEST_DEPARTURE_CONFIRMED",
    newCheckoutAt: null,
    reassignment: {
      maidProfileId: ids.actor,
      sequenceNumber: 1,
      serviceDate: "2028-02-29",
      availableFrom: "2028-02-29T06:10Z",
      dueAt: "2028-02-29T07:10:00.123456789+09:00",
    },
  };
  const valid = clientsFor(incident());
  await decideCheckoutIncident(
    request(`/v1/checkout-incidents/${ids.incident}/decision`, base),
    valid.clients,
    admin,
    ids.incident,
  );
  assert(
    valid.calls[0].args.p_reassignment !== undefined,
    "minute precision, leap date, fractional seconds, UTC and offset are accepted",
  );

  for (
    const invalidTimestamp of [
      "2026-02-29T06:10:00Z",
      "2026-04-31T06:10:00Z",
      "2026-09-13T06:10:00",
      "2026-09-13T06:10:00z",
      "2026-09-13T06:10:00+24:00",
      "2026-09-13T06:10:60Z",
      "2026-09-13T06:10:00.Z",
    ]
  ) {
    const invalidClients = clientsFor(incident());
    const body = {
      ...base,
      reassignment: { ...base.reassignment, dueAt: invalidTimestamp },
    };
    assert(
      (await failure(() =>
            decideCheckoutIncident(
              request(`/v1/checkout-incidents/${ids.incident}/decision`, body),
              invalidClients.clients,
              admin,
              ids.incident,
            )
          )).code === "VALIDATION_ERROR" && invalidClients.calls.length === 0,
      `invalid request timestamp is rejected before RPC: ${invalidTimestamp}`,
    );
  }
});

Deno.test("checkout incident database timestamps stay strict and fail closed", async () => {
  const admin = { ...maid, role: "admin" as const };
  for (
    const reportedAt of [
      "2026-02-29T06:10:00Z",
      "2026-04-31T06:10:00Z",
      "2026-09-13T06:10Z",
      "2026-09-13T06:10:00z",
      "2026-09-13T06:10:00+24:00",
    ]
  ) {
    const malformed = clientsFor(incident({ reportedAt }));
    assert(
      (await failure(() =>
        getCheckoutIncident(
          request(`/v1/checkout-incidents/${ids.incident}`),
          malformed.clients,
          admin,
          ids.incident,
        )
      )).code === "CHECKOUT_INCIDENT_COMMAND_FAILED",
      `invalid database timestamp fails closed: ${reportedAt}`,
    );
  }
});

Deno.test("checkout incident validation and database errors fail closed without raw detail", async () => {
  const { clients, calls } = clientsFor(incident());
  const path = `/v1/attempts/${ids.attempt}/checkout-not-completed`;
  for (
    const body of [
      {},
      {
        expectedExecutionVersion: 0,
        expectedAssignmentId: ids.assignment,
        expectedAssignmentRevision: 1,
      },
      {
        expectedExecutionVersion: 1,
        expectedAssignmentId: ids.assignment,
        expectedAssignmentRevision: 1,
        guestName: "비공개",
      },
    ]
  ) {
    assert(
      (await failure(() =>
        reportCheckoutIncident(request(path, body), clients, maid, ids.attempt)
      )).status === 400,
      "invalid report",
    );
  }
  assert(calls.length === 0, "invalid request never reaches DB");
  assert(
    checkoutIncidentDatabaseError({ message: "CHECKOUT_INCIDENT_OPEN" })
      .status === 409,
    "stable conflict",
  );
  const hidden = checkoutIncidentDatabaseError({
    message: "raw SQL PIN token phone",
  });
  assert(
    hidden.status === 500 && !hidden.message.includes("raw SQL"),
    "unknown details redacted",
  );
});
