import { type ApiHandlerDependencies, handleApiRequest } from "../api/index.ts";
import { payrollRemittanceMarker } from "./payroll-remittance-marker-api.ts";
import {
  normalizeRemittanceCommand,
  PayrollRemittanceCursor,
  remittanceErrorStatus,
  remittanceProjection,
  remittanceRequestFingerprint,
  remittanceRequestHash,
} from "./payroll-remittance-marker-core.ts";
import type { EdgeActor, EdgeClients } from "./runtime.ts";

const secret = "synthetic-payroll-cursor-secret-32bytes";
Deno.env.set("PAYROLL_CURSOR_HMAC_SECRET", secret);
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
const maid: EdgeActor = { ...admin, role: "maid", profileId: id(3) };
const input = { maidProfileId: maid.profileId, weekStart: "2026-09-21" };
const basis = {
  accrualAmount: 32000,
  totalAmount: 32000,
  adjustmentAmount: -2000,
  carryInAmount: -1000,
  carryOutAmount: 0,
  payableAmount: 29000,
  lateEarningAmount: 0,
  lockedAmount: null,
};
const marker = {
  ...input,
  marked: false,
  version: 0,
  lastChangedBy: null,
  lastChangedAt: null,
  confirmedBy: null,
  confirmedAt: null,
  needsReconfirmation: false,
  basis,
  confirmedBasis: null,
  basisFingerprint: "a".repeat(64),
  canSet: true,
  canClear: false,
  canReconfirm: false,
  setBlockedReason: null,
};
const on = {
  ...marker,
  marked: true,
  version: 1,
  lastChangedBy: admin.profileId,
  lastChangedAt: "2026-09-28T01:00:00+09:00",
  confirmedBy: admin.profileId,
  confirmedAt: "2026-09-28T01:00:00+09:00",
  confirmedBasis: basis,
  canClear: true,
};
const command = {
  ...input,
  marked: true,
  expectedVersion: 0,
  expectedBasisFingerprint: marker.basisFingerprint,
};
const revision = {
  revisionId: id(4),
  version: 1,
  eventType: "marked",
  marked: true,
  actorProfileId: admin.profileId,
  occurredAt: "2026-09-28T01:00:00+09:00",
  basis,
};
const history = { entries: [revision], hasMore: false, lastVersion: 1 };
const path = "/v1/payroll/remittance-marker";
const query = new URLSearchParams(input).toString();
const key = "marker-331-synthetic";
function assert(value: unknown, message = "assertion"): asserts value {
  if (!value) throw new Error(message);
}
function request(
  route = path,
  method = "GET",
  suffix = query,
  currentSession: unknown = session,
  body?: unknown,
  idempotencyKey: string | null = key,
): Request {
  const claims = btoa(JSON.stringify({ session_id: currentSession }))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return new Request(`http://localhost/functions/v1/api${route}?${suffix}`, {
    method,
    headers: {
      authorization: `Bearer e30.${claims}.signature`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(idempotencyKey === null ? {} : { "idempotency-key": idempotencyKey }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function dependencies(
  data: unknown = marker,
  failure: string | null = null,
  identity = admin,
) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  let authenticated = 0;
  const clients = {
    admin: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push([name, args]);
        return Promise.resolve({
          data: name === "record_authorization_denial" ? null : data,
          error: failure && name !== "record_authorization_denial"
            ? { message: failure }
            : null,
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
const common = {
  p_actor_profile_id: admin.profileId,
  p_session_id: session,
  p_expected_actor_role: "admin",
  p_maid_profile_id: input.maidProfileId,
  p_week_start: input.weekStart,
};
Deno.test("#331 Edge GET exact sixteen fields and role/session-bound RPC", async () => {
  const mock = dependencies(),
    response = await handleApiRequest(request(), mock.options);
  assert(
    response.status === 200 &&
      response.headers.get("cache-control") === "no-store",
  );
  assert(JSON.stringify(await response.json()) === JSON.stringify(marker));
  assert(
    JSON.stringify(mock.calls) ===
      JSON.stringify([["get_payroll_remittance_marker", common]]),
  );
});
Deno.test("#331 Edge set/reconfirm hash and SQL argument parity", async () => {
  for (const action of ["set", "reconfirm"] as const) {
    const mock = dependencies();
    const { marked: _marked, ...reconfirm } = command;
    const body = action === "set" ? command : reconfirm;
    const response = await handleApiRequest(
      request(
        action === "set" ? path : `${path}/reconfirm`,
        action === "set" ? "PUT" : "POST",
        "",
        session,
        body,
      ),
      mock.options,
    );
    assert(
      response.status === 200 &&
        response.headers.get("cache-control") === "no-store",
    );
    const parsed = normalizeRemittanceCommand(body, key, action === "set");
    const expected = {
      ...common,
      p_expected_version: 0,
      p_expected_basis_fingerprint: marker.basisFingerprint,
      p_idempotency_key: key,
      p_request_hash: await remittanceRequestHash(
        remittanceRequestFingerprint(admin.profileId, parsed, action === "set"),
      ),
      ...(action === "set" ? { p_marked: true } : {}),
    };
    assert(
      JSON.stringify(mock.calls) ===
        JSON.stringify([[
          (action === "set" ? "set" : "reconfirm") +
          "_payroll_remittance_marker",
          expected,
        ]]),
    );
    assert(!JSON.stringify(mock.calls).includes("provider_reference"));
  }
});
Deno.test("#331 Edge maid reads only immutable display, not actual payment state", async () => {
  const view = {
    ...on,
    canSet: false,
    canClear: false,
    canReconfirm: false,
    setBlockedReason: "ADMIN_REQUIRED",
  };
  const mock = dependencies(view, null, maid);
  const response = await payrollRemittanceMarker(
    request(),
    mock.clients,
    maid,
    session,
    "get",
  );
  assert("marked" in response && response.marked && !response.canClear);
  assert(mock.calls[0][1].p_expected_actor_role === "maid");
});
Deno.test("#331 Edge ignores lockedAmount metadata but notices seven financial changes", () => {
  assert(
    !remittanceProjection(
      { ...on, basis: { ...basis, lockedAmount: 29000 } },
      input,
      "admin",
    ).needsReconfirmation,
  );
  for (
    const field of Object.keys(basis).filter((field) =>
      field !== "lockedAmount"
    )
  ) {
    const changed = {
      ...basis,
      [field]: (basis[field as keyof typeof basis] ?? 0) +
        (field.startsWith("carry") ? -1 : 1),
    };
    assert(
      remittanceProjection(
        {
          ...on,
          basis: changed,
          needsReconfirmation: true,
          canReconfirm: true,
        },
        input,
        "admin",
      ).needsReconfirmation,
    );
  }
  const zero = {
    ...basis,
    accrualAmount: 0,
    totalAmount: 0,
    adjustmentAmount: 0,
    carryInAmount: 0,
    payableAmount: 0,
  };
  assert(
    remittanceProjection(
      {
        ...on,
        basis: zero,
        canSet: false,
        setBlockedReason: "NO_PAYROLL_AMOUNT",
        needsReconfirmation: true,
        canReconfirm: true,
      },
      input,
      "admin",
    ).marked,
  );
});
Deno.test("#331 Edge HMAC cursor independent Node golden vector and scope binding", async () => {
  const expected =
    "eyJmYW1pbHkiOiJwYXlyb2xsLXJlbWl0dGFuY2UtaGlzdG9yeSIsInYiOjEsInNjb3BlIjp7ImFjdG9yUHJvZmlsZUlkIjoiYzEwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAyIiwiYWN0b3JSb2xlIjoiYWRtaW4iLCJzZXNzaW9uQmluZGluZyI6InNoRHU5T0doZlZiMDVNTGwxYzBuemxNa2c3YUZNUng4dHFNU1lnUEpycDQiLCJtYWlkUHJvZmlsZUlkIjoiYzEwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAzIiwid2Vla1N0YXJ0IjoiMjAyNi0wOS0yMSIsInNvcnQiOiJ2ZXJzaW9uOmFzYyJ9LCJhZnRlclZlcnNpb24iOjF9.7sbSRlxL6NbCCpADbyMTcTi601-uwZQfv3nsBpOLYtM";
  const codec = new PayrollRemittanceCursor(secret),
    scope = await codec.scope(admin.profileId, "admin", session, input);
  assert(
    await codec.encode(scope, 1) === expected &&
      await codec.decode(expected, scope) === 1,
  );
  assert(
    await codec.encode(
      await codec.scope(
        admin.profileId.toUpperCase(),
        "admin",
        session.toUpperCase(),
        input,
      ),
      1,
    ) === expected,
  );
  assert(!atob(expected.split(".")[0]).includes(session));
  for (
    const other of [
      await codec.scope(id(99), "admin", session, input),
      await codec.scope(admin.profileId, "maid", session, input),
      await codec.scope(admin.profileId, "admin", id(99), input),
      await codec.scope(admin.profileId, "admin", session, {
        ...input,
        maidProfileId: id(99),
      }),
      await codec.scope(admin.profileId, "admin", session, {
        ...input,
        weekStart: "2026-09-14",
      }),
    ]
  ) {
    try {
      await codec.decode(expected, other);
      throw new Error("accepted cross-scope cursor");
    } catch (error) {
      assert((error as { code: string }).code === "PAYROLL_CURSOR_INVALID");
    }
  }
  for (const invalid of [`${expected}=`, "old.payload", "x".repeat(1025)]) {
    try {
      await codec.decode(invalid, scope);
      throw new Error("accepted invalid cursor");
    } catch (error) {
      assert((error as { code: string }).code === "PAYROLL_CURSOR_INVALID");
    }
  }
});
Deno.test("#331 Edge history uses ASC exclusive version, default twenty and HMAC continuation", async () => {
  const first = dependencies({ ...history, hasMore: true });
  const response = await handleApiRequest(
      request(`${path}/history`, "GET", `${query}&limit=1`),
      first.options,
    ),
    body = await response.json();
  assert(response.status === 200 && typeof body.nextCursor === "string");
  assert(
    Object.keys(body).sort().join() ===
      ["maidProfileId", "weekStart", "entries", "nextCursor"].sort().join(),
  );
  assert(
    JSON.stringify(first.calls) ===
      JSON.stringify([["list_payroll_remittance_marker_history", {
        ...common,
        p_after_version: null,
        p_limit: 1,
      }]]),
  );
  const next = dependencies({
    entries: [{
      ...revision,
      version: 2,
      revisionId: id(5),
      eventType: "cleared",
      marked: false,
    }],
    hasMore: false,
    lastVersion: 2,
  });
  const continuation = await handleApiRequest(
    request(`${path}/history`, "GET", `${query}&cursor=${body.nextCursor}`),
    next.options,
  );
  assert(
    continuation.status === 200 &&
      (await continuation.json()).nextCursor === null,
  );
  assert(
    next.calls[0][1].p_after_version === 1 && next.calls[0][1].p_limit === 20,
  );
  const invalid = dependencies(history);
  const mismatch = await handleApiRequest(
    request(
      `${path}/history`,
      "GET",
      `${query}&cursor=${body.nextCursor}`,
      id(99),
    ),
    invalid.options,
  );
  assert(mismatch.status === 400 && invalid.calls.length === 0);
});
for (
  const [method, suffix] of [
    ["HEAD", ""],
    ["POST", ""],
    ["PATCH", ""],
    ["DELETE", ""],
    ["PUT", "/history"],
    ["GET", "/reconfirm"],
    ["HEAD", "/history"],
  ]
) {
  Deno.test(`#331 Edge method ${method}${suffix} rejects before authentication`, async () => {
    const mock = dependencies(),
      response = await handleApiRequest(
        request(path + suffix, method),
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
  const route of [
    `${path}/`,
    "/v1//payroll/remittance-marker",
    "/v1/payroll/%72emittance-marker",
    "/v1/payroll/remittance%2Dmarker",
    `${path}/extra`,
    `${path}/history/`,
    "/v1/payroll%2fremittance-marker",
  ]
) {
  Deno.test(`#331 Edge exact path rejects alias ${route}`, async () => {
    const mock = dependencies(),
      response = await handleApiRequest(request(route), mock.options);
    assert(
      response.status === 404 &&
        response.headers.get("cache-control") === "no-store",
    );
    assert(mock.authenticated() === 0 && mock.calls.length === 0);
  });
}
for (
  const suffix of [
    "&limit=1",
    "&cursor=x",
    "&unknown=1",
    `&maidProfileId=${maid.profileId}`,
    "&weekStart=2026-09-21",
  ]
) {
  Deno.test(`#331 Edge GET query rejects ${suffix}`, async () => {
    const mock = dependencies(),
      response = await handleApiRequest(
        request(path, "GET", query + suffix),
        mock.options,
      );
    assert(
      response.status === 400 &&
        response.headers.get("cache-control") === "no-store" &&
        mock.calls.length === 0,
    );
  });
}
for (
  const suffix of [
    "&limit=0",
    "&limit=101",
    "&limit=01",
    "&limit=1.5",
    "&cursor=",
    `&cursor=${"x".repeat(1025)}`,
    "&afterVersion=1",
    "&limit=20&limit=20",
  ]
) {
  Deno.test(`#331 Edge history rejects malformed query ${suffix.slice(0, 24)}`, async () => {
    const mock = dependencies(history),
      response = await handleApiRequest(
        request(`${path}/history`, "GET", query + suffix),
        mock.options,
      );
    assert(
      response.status === 400 &&
        response.headers.get("cache-control") === "no-store" &&
        mock.calls.length === 0,
    );
  });
}
for (
  const change of [
    { marked: 1 },
    { marked: "true" },
    { expectedVersion: -1 },
    { expectedVersion: "0" },
    { expectedBasisFingerprint: "A".repeat(64) },
    { amount: 32000 },
    { note: "private" },
  ]
) {
  Deno.test(`#331 Edge set rejects command shape ${JSON.stringify(change)}`, async () => {
    const mock = dependencies(),
      response = await handleApiRequest(
        request(path, "PUT", "", session, { ...command, ...change }),
        mock.options,
      );
    assert(
      response.status === 400 &&
        response.headers.get("cache-control") === "no-store" &&
        mock.calls.length === 0,
    );
  });
}
for (const invalid of [null, "short", "x".repeat(129), "not allowed"]) {
  Deno.test(`#331 Edge set rejects idempotency header ${String(invalid).slice(0, 24)}`, async () => {
    const mock = dependencies(),
      response = await handleApiRequest(
        request(path, "PUT", "", session, command, invalid),
        mock.options,
      );
    assert(
      response.status === 400 && mock.calls.length === 0 &&
        response.headers.get("cache-control") === "no-store",
    );
  });
}
Deno.test("#331 Edge writes disallow query extras and marked on reconfirm", async () => {
  for (
    const candidate of [
      request(path, "PUT", "extra=1", session, command),
      request(`${path}/reconfirm`, "POST", "", session, command),
    ]
  ) {
    const mock = dependencies(),
      response = await handleApiRequest(candidate, mock.options);
    assert(response.status === 400 && mock.calls.length === 0);
  }
});
for (
  const identity of [{ ...admin, role: "developer" as const }, {
    ...maid,
    profileId: id(99),
  }, { ...admin, mustChangePassword: true }]
) {
  Deno.test(`#331 Edge denies actor ${identity.role}/${identity.profileId}/${identity.mustChangePassword}`, async () => {
    const mock = dependencies(marker, null, identity),
      response = await handleApiRequest(request(), mock.options);
    assert(
      response.status === 403 &&
        response.headers.get("cache-control") === "no-store",
    );
    assert(
      mock.calls.length === 1 &&
        mock.calls[0][0] === "record_authorization_denial",
    );
    assert(mock.calls[0][1].p_source === "edge.authorization.payroll");
  });
}
Deno.test("#331 Edge maid cannot set or reconfirm", async () => {
  for (const action of ["set", "reconfirm"] as const) {
    const { marked: _marked, ...reconfirm } = command;
    const mock = dependencies(marker, null, maid);
    const response = await handleApiRequest(
      request(
        action === "set" ? path : `${path}/reconfirm`,
        action === "set" ? "PUT" : "POST",
        "",
        session,
        action === "set" ? command : reconfirm,
      ),
      mock.options,
    );
    assert(
      response.status === 403 &&
        (await response.json()).error.code === "ADMIN_REQUIRED",
    );
    assert(
      mock.calls.length === 1 &&
        mock.calls[0][0] === "record_authorization_denial",
    );
  }
});
for (
  const code of [
    "SESSION_REVOKED",
    "ADMIN_REQUIRED",
    "PAYROLL_ACCESS_REQUIRED",
    "PASSWORD_CHANGE_REQUIRED",
    "PAYROLL_MAID_NOT_FOUND",
    "PAYROLL_WEEK_MUST_START_MONDAY",
    "PAYROLL_WEEK_NOT_CLOSED",
    "PAYROLL_REMITTANCE_MARKER_STALE_VERSION",
    "PAYROLL_REMITTANCE_BASIS_CHANGED",
    "NO_PAYROLL_AMOUNT",
    "PAYROLL_REMITTANCE_RECONFIRM_NOT_REQUIRED",
    "PAYROLL_REMITTANCE_MARKER_NOT_SET",
    "IDEMPOTENCY_KEY_REUSED",
    "private SESSION_REVOKED",
  ]
) {
  Deno.test(`#331 Edge exact safe DB error mapping ${code}`, async () => {
    const mock = dependencies(null, code),
      response = await handleApiRequest(request(), mock.options);
    assert(
      response.status === remittanceErrorStatus(code) &&
        response.headers.get("cache-control") === "no-store",
    );
    const body = await response.json();
    assert(
      body.error.code ===
        (code.startsWith("private") ? "PAYROLL_COMMAND_FAILED" : code),
    );
    assert(!JSON.stringify(body).includes("private"));
  });
}
for (
  const corruption of [
    { extra: "private" },
    { marked: 1 },
    { version: "0" },
    { version: Number.MAX_SAFE_INTEGER + 1 },
    { maidProfileId: id(99) },
    { basisFingerprint: "A".repeat(64) },
    { lastChangedBy: admin.profileId },
    { confirmedBasis: basis },
    { setBlockedReason: "UNKNOWN" },
    { basis: { ...basis, lockedAmount: 0 } },
    { basis: { ...basis, carryOutAmount: 1 } },
    { basis: { ...basis, hidden: true } },
  ]
) {
  Deno.test(`#331 Edge output whitelist corruption ${Object.keys(corruption).join()}${JSON.stringify(corruption).slice(0, 80)}`, async () => {
    const mock = dependencies({ ...marker, ...corruption }),
      response = await handleApiRequest(request(), mock.options);
    assert(
      response.status === 500 &&
        (await response.json()).error.code === "PAYROLL_COMMAND_FAILED",
    );
    assert(response.headers.get("cache-control") === "no-store");
  });
}
Deno.test("#331 Edge rejects corrupted cleared confirmation on get/set/reconfirm RPC replies", async () => {
  const cleared = { ...on, marked: false, version: 2, canClear: false };
  const { marked: _marked, ...reconfirm } = command;
  for (
    const candidate of [
      request(),
      request(path, "PUT", "", session, command),
      request(`${path}/reconfirm`, "POST", "", session, reconfirm),
    ]
  ) {
    const mock = dependencies(cleared);
    const response = await handleApiRequest(candidate, mock.options);
    assert(
      response.status === 500 &&
        response.headers.get("cache-control") === "no-store",
    );
    assert((await response.json()).error.code === "PAYROLL_COMMAND_FAILED");
    assert(
      mock.calls.length === 1 &&
        mock.calls[0][0].endsWith("_payroll_remittance_marker"),
    );
  }
  const valid = {
    ...cleared,
    confirmedBy: null,
    confirmedAt: null,
    confirmedBasis: null,
  };
  const mock = dependencies(valid),
    response = await handleApiRequest(request(), mock.options);
  assert(
    response.status === 200 &&
      JSON.stringify(await response.json()) === JSON.stringify(valid),
  );
});
Deno.test("#331 Edge raw response cap before whitelist and final envelope cap", async () => {
  const mock = dependencies({ ...marker, private: "x".repeat(140000) }),
    response = await handleApiRequest(request(), mock.options);
  assert(
    response.status === 500 &&
      (await response.json()).error.code === "PAYROLL_RESPONSE_TOO_LARGE",
  );
  assert(response.headers.get("cache-control") === "no-store");
});
Deno.test("#331 Edge session claim is mandatory before RPC", async () => {
  for (const invalid of [null, "not-uuid"]) {
    const mock = dependencies(),
      response = await handleApiRequest(
        request(path, "GET", query, invalid),
        mock.options,
      );
    assert(
      response.status === 401 && mock.calls.length === 0 &&
        response.headers.get("cache-control") === "no-store",
    );
  }
  const mock = dependencies();
  const response = await handleApiRequest(
    new Request(`http://localhost/functions/v1/api${path}?${query}`, {
      headers: { authorization: "Bearer e30.e30.synthetic" },
    }),
    mock.options,
  );
  assert(
    response.status === 401 && mock.calls.length === 0 &&
      response.headers.get("cache-control") === "no-store",
  );
});
Deno.test("#331 Edge history rejects invalid sort/event and secret configuration", async () => {
  for (
    const corrupt of [
      { ...history, hasMore: true },
      { ...history, lastVersion: 2 },
      { ...history, private: true },
      { ...history, entries: [revision, revision] },
      { ...history, entries: [{ ...revision, eventType: "paid" }] },
    ]
  ) {
    const mock = dependencies(corrupt),
      response = await handleApiRequest(
        request(`${path}/history`),
        mock.options,
      );
    assert(
      response.status === 500 &&
        (await response.json()).error.code === "PAYROLL_COMMAND_FAILED",
    );
  }
  Deno.env.set("PAYROLL_CURSOR_HMAC_SECRET", "short");
  try {
    const mock = dependencies(history),
      response = await handleApiRequest(
        request(`${path}/history`),
        mock.options,
      );
    assert(
      response.status === 503 && mock.calls.length === 0 &&
        (await response.json()).error.code === "PAYROLL_CURSOR_NOT_CONFIGURED",
    );
  } finally {
    Deno.env.set("PAYROLL_CURSOR_HMAC_SECRET", secret);
  }
});
