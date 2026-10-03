import {
  assertCheckoutIncidentCursorConfigured,
  checkoutIncidentCursorScope,
  checkoutIncidentListQuery,
  decodeCheckoutIncidentCursor,
  encodeCheckoutIncidentCursor,
  isCheckoutIncidentTimestamp,
  projectCheckoutIncidentListItems,
} from "./checkout-incident-cursor.ts";
import { type EdgeActor, EdgeError } from "./runtime.ts";

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
const secret = "checkout-incident-cursor-parity-secret-123456789";
const ids = {
  incident: "30000000-0000-4000-8000-000000000001",
  room: "40000000-0000-4000-8000-000000000001",
  target: "50000000-0000-4000-8000-000000000001",
  assignment: "60000000-0000-4000-8000-000000000001",
  attempt: "70000000-0000-4000-8000-000000000001",
};
function item(extra: Record<string, unknown> = {}) {
  return {
    incidentId: ids.incident,
    status: "open",
    roomId: ids.room,
    roomNumber: "350",
    cleaningTargetId: ids.target,
    assignmentId: ids.assignment,
    attemptId: ids.attempt,
    reportedAt: "2026-10-03T00:00:00.123456Z",
    serviceDate: "2026-10-02",
    allowedDecisions: ["EXTEND_CHECKOUT", "CONFIRM_DEPARTED", "FALSE_REPORT"],
    ...extra,
  };
}
async function failure(
  action: () => unknown | Promise<unknown>,
): Promise<EdgeError> {
  try {
    await action();
  } catch (error) {
    if (error instanceof EdgeError) return error;
    throw error;
  }
  throw new Error("Expected failure");
}
async function environment(
  values: Record<string, string | undefined>,
  action: () => Promise<void>,
) {
  const previous = Object.fromEntries(
    Object.keys(values).map((name) => [name, Deno.env.get(name)]),
  );
  try {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
    await action();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
}

Deno.test("checkout list query preserves exact calendar filters and canonical bounds", async () => {
  const query = checkoutIncidentListQuery(
    new URLSearchParams(
      `roomId=${ids.room.toUpperCase()}&cleaningTargetId=${ids.target}&serviceDate=2028-02-29&limit=100`,
    ),
  );
  assert(
    query.roomId === ids.room && query.serviceDate === "2028-02-29" &&
      query.limit === 100 && query.cursor === null,
    "normalized query",
  );
  const defaults = checkoutIncidentListQuery(new URLSearchParams());
  assert(
    defaults.limit === 50 && defaults.roomId === null &&
      defaults.serviceDate === null,
    "bounded defaults without invented date",
  );
  for (
    const query of [
      "status=open",
      "roomId=",
      `roomId=${ids.room}&roomId=${ids.room}`,
      "serviceDate=2026-02-29",
      "serviceDate=0000-01-01",
      "serviceDate=2026-04-31",
      "serviceDate=2026-10-03&serviceDate=2026-10-03",
      "limit=0",
      "limit=101",
      "limit=01",
      "limit=1.0",
      "limit=%2B1",
      "limit=1&limit=2",
      "cursor=",
      `cursor=${"a".repeat(1025)}`,
      "unknown=x",
    ]
  ) {
    assert(
      (await failure(() =>
        checkoutIncidentListQuery(new URLSearchParams(query))
      )).code === "VALIDATION_ERROR",
      `reject ${query.slice(0, 80)}`,
    );
  }
});

Deno.test("checkout cursor signs exact actor/filter/stream scope and retains microseconds", async () => {
  await environment({ INSPECTION_CURSOR_HMAC_SECRET: secret }, async () => {
    const query = checkoutIncidentListQuery(new URLSearchParams());
    const scope = checkoutIncidentCursorScope(actor, query);
    const after = {
      reportedAt: "2026-10-03T00:00:00.123456Z",
      id: ids.incident,
    };
    const cursor = await encodeCheckoutIncidentCursor(scope, after);
    assert(
      JSON.stringify(await decodeCheckoutIncidentCursor(cursor, scope)) ===
        JSON.stringify(after),
      "lossless key",
    );
    const text = atob(
      cursor.split(".")[0].replace(/-/g, "+").replace(/_/g, "/"),
    );
    assert(
      !text.includes(actor.authUserId) && !text.includes(secret) &&
        !text.includes("limit") && text.includes('"roomId":null'),
      "safe complete scope without session/token/limit",
    );
    for (
      const other of [
        { ...scope, actorProfileId: ids.room },
        { ...scope, roomId: ids.room },
        { ...scope, cleaningTargetId: ids.target },
        { ...scope, serviceDate: "2026-10-03" },
        { ...scope, stream: "pending-inspections" },
        { ...scope, actorRole: "maid" },
        { ...scope, sort: "reported_at_asc_id_asc" },
      ]
    ) {
      assert(
        (await failure(() =>
          decodeCheckoutIncidentCursor(cursor, other as typeof scope)
        )).status === 400,
        "cross scope denied",
      );
    }
    for (
      const malformed of [
        "",
        "bad",
        `${cursor}=`,
        `${cursor}.x`,
        `${cursor.split(".")[0]}.AAAA`,
        `x${cursor}`,
      ]
    ) {
      assert(
        (await failure(() => decodeCheckoutIncidentCursor(malformed, scope)))
          .code === "VALIDATION_ERROR",
        "bad encoding/signature denied",
      );
    }
    const signature = cursor.split(".")[1];
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = alphabet.indexOf(signature.at(-1) ?? "");
    const noncanonical = `${cursor.split(".")[0]}.${signature.slice(0, -1)}${
      alphabet[last + 1]
    }`;
    assert(
      (await failure(() => decodeCheckoutIncidentCursor(noncanonical, scope)))
        .status === 400,
      "noncanonical trailing base64 bits denied",
    );
    const signedMalformed = async (
      after: unknown,
      extra: Record<string, unknown> = {},
    ) => {
      const raw = btoa(JSON.stringify({ v: 1, scope, after, ...extra }))
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const sig = btoa(
        String.fromCharCode(
          ...new Uint8Array(
            await crypto.subtle.sign(
              "HMAC",
              key,
              new TextEncoder().encode(raw),
            ),
          ),
        ),
      ).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
      return `${raw}.${sig}`;
    };
    for (
      const invalidAfter of [
        { ...after, reportedAt: "2026-10-03T00:00:00.123Z" },
        { ...after, reportedAt: "2026-02-29T00:00:00.123456Z" },
        { ...after, id: "ABC00000-0000-4000-8000-000000000001" },
        { ...after, id: null },
        { ...after, guestName: "hidden" },
      ]
    ) {
      const malformed = await signedMalformed(invalidAfter);
      assert(
        (await failure(() => decodeCheckoutIncidentCursor(malformed, scope)))
          .status === 400,
        "signed malformed after denied",
      );
    }
    assert(
      (await failure(async () =>
        decodeCheckoutIncidentCursor(
          await signedMalformed(after, { private: "hidden" }),
          scope,
        )
      )).status === 400,
      "signed extra payload denied",
    );
  });
});

Deno.test("checkout cursor shared Node/Edge frozen wire vector roundtrips byte-identically", async () => {
  await environment({
    INSPECTION_CURSOR_HMAC_SECRET: "inspection-cursor-secret-tests-1234567",
  }, async () => {
    const scope = checkoutIncidentCursorScope({
      ...actor,
      profileId: "f3270000-0000-4000-8000-000000000001",
    }, checkoutIncidentListQuery(new URLSearchParams()));
    const after = {
      reportedAt: "2026-10-02T06:00:00.000001Z",
      id: "f3270000-0000-4000-8000-000000000002",
    };
    const vector =
      "eyJ2IjoxLCJzY29wZSI6eyJhY3RvclByb2ZpbGVJZCI6ImYzMjcwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMSIsImFjdG9yUm9sZSI6ImFkbWluIiwic3RyZWFtIjoiY2hlY2tvdXRfcHJlc2VuY2Vfb3BlbiIsInN0YXR1cyI6Im9wZW4iLCJzb3J0IjoicmVwb3J0ZWRfYXRfZGVzY19pZF9kZXNjIiwicm9vbUlkIjpudWxsLCJjbGVhbmluZ1RhcmdldElkIjpudWxsLCJzZXJ2aWNlRGF0ZSI6bnVsbH0sImFmdGVyIjp7InJlcG9ydGVkQXQiOiIyMDI2LTEwLTAyVDA2OjAwOjAwLjAwMDAwMVoiLCJpZCI6ImYzMjcwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMiJ9fQ.JL4cnbiTvuPs7bx-KBCZm-ydwjXNX4aOdaYOgObkHrY";
    assert(
      await encodeCheckoutIncidentCursor(scope, after) === vector,
      "Node encoded vector equals Edge encode",
    );
    assert(
      JSON.stringify(await decodeCheckoutIncidentCursor(vector, scope)) ===
        JSON.stringify(after),
      "Node vector decodes with exact microsecond anchor",
    );
  });
});

Deno.test("checkout cursor rejects missing short and cross-feature reused secrets safely", async () => {
  for (const value of [undefined, "", "short"]) {
    await environment({ INSPECTION_CURSOR_HMAC_SECRET: value }, async () => {
      const error = await failure(() =>
        assertCheckoutIncidentCursorConfigured()
      );
      assert(
        error.status === 500 &&
          error.code === "CHECKOUT_INCIDENT_COMMAND_FAILED" &&
          !error.message.includes("SECRET"),
        "safe configuration failure",
      );
    });
  }
  for (
    const name of [
      "ACCOUNT_PHONE_PEPPER",
      "PAYROLL_CURSOR_HMAC_SECRET",
      "SUPABASE_SECRET_KEY",
    ]
  ) {
    await environment(
      { INSPECTION_CURSOR_HMAC_SECRET: secret, [name]: secret },
      async () => {
        assert(
          (await failure(() => assertCheckoutIncidentCursorConfigured()))
            .status === 500,
          "direct reuse denied",
        );
      },
    );
  }
  await environment({
    INSPECTION_CURSOR_HMAC_SECRET: secret,
    ROOM_PIN_KEYRING_JSON: JSON.stringify({ v1: secret }),
  }, async () => {
    assert(
      (await failure(() => assertCheckoutIncidentCursorConfigured())).status ===
        500,
      "keyring reuse denied",
    );
  });
});

Deno.test("checkout list pack validates every lookahead row, filters, order and anchors", async () => {
  const query = checkoutIncidentListQuery(new URLSearchParams("limit=1"));
  const first = item();
  const lowerMicrosecond = item({
    incidentId: "30000000-0000-4000-8000-000000000002",
    reportedAt: "2026-10-03T00:00:00.123455Z",
  });
  assert(
    projectCheckoutIncidentListItems(
      { items: [first, lowerMicrosecond] },
      query,
      null,
    ).length === 2,
    "microsecond order retained independent of ID",
  );
  const tied = item({ incidentId: "30000000-0000-4000-8000-000000000000" });
  assert(
    projectCheckoutIncidentListItems({ items: [first, tied] }, query, null)
      .length === 2,
    "tie UUID descending",
  );
  const after = { reportedAt: first.reportedAt, id: first.incidentId };
  assert(
    projectCheckoutIncidentListItems({ items: [tied] }, query, after).length ===
      1,
    "strict below anchor",
  );
  assert(
    projectCheckoutIncidentListItems({ items: [] }, query, after).length === 0,
    "empty page",
  );
  const packs: unknown[] = [
    null,
    [],
    { items: [], raw: "hidden" },
    { items: "bad" },
    { items: [first, tied, lowerMicrosecond] },
    { items: [first, first] },
    { items: [lowerMicrosecond, first] },
    { items: [tied, first] },
  ];
  for (
    const extra of [
      { rawPin: "hidden" },
      { status: "resolved" },
      { reportedAt: "2026-10-03T00:00:00.123Z" },
      { reportedAt: "2026-02-29T00:00:00.123456Z" },
      { serviceDate: "2026-04-31" },
      { roomNumber: "" },
      {
        allowedDecisions: [
          "FALSE_REPORT",
          "CONFIRM_DEPARTED",
          "EXTEND_CHECKOUT",
        ],
      },
      { attemptId: null },
    ]
  ) {
    packs.push({
      items: [first, item({ ...extra, incidentId: tied.incidentId })],
    });
  }
  for (const pack of packs) {
    assert(
      (await failure(() => projectCheckoutIncidentListItems(pack, query, null)))
        .code === "CHECKOUT_INCIDENT_COMMAND_FAILED",
      "malformed DB response rejected wholesale",
    );
  }
  for (
    const filters of [{ ...query, roomId: ids.target }, {
      ...query,
      cleaningTargetId: ids.room,
    }, { ...query, serviceDate: "2026-10-03" }]
  ) {
    assert(
      (await failure(() =>
        projectCheckoutIncidentListItems({ items: [first] }, filters, null)
      )).status === 500,
      "filter mismatch rejected",
    );
  }
  assert(
    (await failure(() =>
      projectCheckoutIncidentListItems({ items: [first] }, query, after)
    )).status === 500,
    "equal anchor rejected",
  );
  assert(
    (await failure(() =>
      projectCheckoutIncidentListItems(
        { items: [item({ roomNumber: "가".repeat(44000) })] },
        query,
        null,
      )
    )).status === 500,
    "UTF-8 byte bound enforced without arbitrary label length policy",
  );
  assert(
    projectCheckoutIncidentListItems(
      { items: [item({ roomNumber: "가".repeat(1001) })] },
      query,
      null,
    )[0].roomNumber.length === 1001,
    "existing text labels remain valid below response bound",
  );
  for (
    const timestamp of [
      "2026-10-03T24:00:00.000000Z",
      "2026-10-03T00:60:00.000000Z",
      "2026-10-03T00:00:60.000000Z",
      "0000-01-01T00:00:00.000000Z",
      "2026-10-03T00:00:00.000000+00:00",
    ]
  ) {
    assert(
      !isCheckoutIncidentTimestamp(timestamp),
      "strict canonical timestamp",
    );
  }
});
