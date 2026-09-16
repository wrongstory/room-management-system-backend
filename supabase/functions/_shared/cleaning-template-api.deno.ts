import {
  cleaningTemplates,
  templateDatabaseError,
} from "./cleaning-template-api.ts";
import { type EdgeActor, type EdgeClients, EdgeError } from "./runtime.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const sessionId = "51000000-0000-4000-8000-000000000001";
const payload = btoa(JSON.stringify({ session_id: sessionId }))
  .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const token = `e30.${payload}.signature`;
const admin: EdgeActor = {
  authUserId: "10000000-0000-4000-8000-000000000001",
  profileId: "20000000-0000-4000-8000-000000000001",
  role: "admin",
  displayName: "관리자",
  mustChangePassword: false,
};
function slots(count = 9) {
  return Array.from({ length: count }, (_, displayOrder) => ({
    slotKey: displayOrder === 0
      ? "tv-on"
      : displayOrder === 1
      ? "entry-storage"
      : displayOrder === count - 1
      ? "extra-proof"
      : `slot-${displayOrder}`,
    displayOrder,
    required: displayOrder < count - 1,
    label: ` 사진 ${displayOrder + 1} `,
    maxPhotos: displayOrder === count - 1 ? 10 : 1,
  }));
}
function legacyV7Slots() {
  return Array.from({ length: 10 }, (_, displayOrder) => ({
    slotKey: displayOrder === 0 ? "tv-on" : `legacy-${displayOrder}`,
    displayOrder,
    required: displayOrder < 9,
    label: `과거 사진 ${displayOrder + 1}`,
  }));
}
function request(method: string, body?: unknown, query = "") {
  return new Request(`http://localhost/v1/cleaning-templates${query}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": "template-publish-0001",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function clients(data: unknown = null, message: string | null = null) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    value: {
      admin: {
        rpc(name: string, args: Record<string, unknown>) {
          calls.push({ name, args });
          return Promise.resolve({ data, error: message ? { message } : null });
        },
      },
    } as unknown as EdgeClients,
  };
}
async function failure(run: () => Promise<unknown>, code: string) {
  try {
    await run();
  } catch (error) {
    assert(
      error instanceof EdgeError && error.code === code,
      `expected ${code}`,
    );
    return;
  }
  throw new Error(`expected ${code}`);
}

Deno.test("cleaning template GET returns four explicit configured states with live session binding", async () => {
  const roomTypes: Array<{
    roomTypeCode: string;
    roomTypeName: string;
    cleaningKind: string;
    configured: boolean;
    expectedVersion: number;
    currentPublished: Record<string, unknown> | null;
  }> = ["standard", "premium", "oceanPremium", "oceanFamily"].map((
    roomTypeCode,
  ) => ({
    roomTypeCode,
    roomTypeName: roomTypeCode,
    cleaningKind: "checkout",
    configured: false,
    expectedVersion: 0,
    currentPublished: null,
  }));
  roomTypes[0] = {
    ...roomTypes[0],
    configured: true,
    expectedVersion: 7,
    currentPublished: {
      id: "30000000-0000-4000-8000-000000000007",
      version: 7,
      status: "published",
      durationMinutes: 60,
      slots: legacyV7Slots(),
      publishedAt: "2030-01-01T00:00:00Z",
      createdAt: "2030-01-01T00:00:00Z",
    },
  };
  const mock = clients({ cleaningKind: "checkout", roomTypes });
  const result = await cleaningTemplates(
    request("GET", undefined, "?cleaningKind=checkout"),
    mock.value,
    admin,
  );
  assert(
    "roomTypes" in result && result.roomTypes.length === 4,
    "all room types are visible",
  );
  assert(
    result.roomTypes[0]?.currentPublished?.version === 7,
    "historical v7 projection remains readable",
  );
  assert(
    mock.calls[0]?.name === "list_checkout_cleaning_templates",
    "exact read RPC",
  );
  assert(
    mock.calls[0]?.args.p_session_id === sessionId,
    "JWT session is bound to the RPC",
  );
  for (
    const query of [
      "",
      "?cleaningKind=reclean",
      "?cleaningKind=checkout&extra=1",
    ]
  ) {
    await failure(
      () =>
        cleaningTemplates(request("GET", undefined, query), mock.value, admin),
      "INVALID_CLEANING_TEMPLATE",
    );
  }
  assert(mock.calls.length === 1, "bad query never reaches DB");
});

Deno.test("cleaning template publish normalizes slots and hashes canonical payload", async () => {
  const published = {
    id: "30000000-0000-4000-8000-000000000001",
    version: 8,
    status: "published",
    durationMinutes: 60,
    slots: slots().map((slot) => ({ ...slot, label: slot.label.trim() })),
    publishedAt: "2030-01-01T00:00:00Z",
    createdAt: "2030-01-01T00:00:00Z",
  };
  const mock = clients(published);
  const body = {
    roomTypeCode: "standard",
    cleaningKind: "checkout",
    expectedVersion: 0,
    durationMinutes: 60,
    slots: slots().reverse(),
  };
  const result = await cleaningTemplates(
    request("POST", body),
    mock.value,
    admin,
  );
  assert("version" in result && result.version === 8, "strict safe projection");
  assert(
    mock.calls[0]?.name === "publish_checkout_cleaning_template",
    "exact write RPC",
  );
  const sent = mock.calls[0]?.args.p_slots as Array<Record<string, unknown>>;
  assert(
    sent.every((slot, index) => slot.displayOrder === index),
    "slots sorted by display order",
  );
  assert(
    sent.every((slot) => !(slot.label as string).startsWith(" ")),
    "labels trimmed",
  );
  assert(
    mock.calls[0]?.args.p_session_id === sessionId,
    "write bound to live session",
  );
  assert(
    /^[a-f0-9]{64}$/.test(String(mock.calls[0]?.args.p_request_hash)),
    "canonical SHA-256",
  );
});

Deno.test("cleaning template publish preserves the exact v7 receipt replay envelope", async () => {
  const published = {
    id: "30000000-0000-4000-8000-000000000007",
    version: 7,
    status: "published",
    durationMinutes: 60,
    slots: legacyV7Slots(),
    publishedAt: "2030-01-01T00:00:00Z",
    createdAt: "2030-01-01T00:00:00Z",
  };
  const mock = clients(published);
  const result = await cleaningTemplates(
    request("POST", {
      roomTypeCode: "standard",
      cleaningKind: "checkout",
      expectedVersion: 0,
      durationMinutes: 60,
      slots: legacyV7Slots(),
    }),
    mock.value,
    admin,
  );
  assert("version" in result && result.version === 7, "v7 replay projection");
  const sent = mock.calls[0]?.args.p_slots as Array<Record<string, unknown>>;
  assert(
    sent.length === 10 &&
      sent.every((slot) => !Object.hasOwn(slot, "maxPhotos")),
    "historical payload reaches the database receipt boundary unchanged",
  );
});

Deno.test("cleaning template publish accepts omitted duration without inventing a value", async () => {
  const published = {
    id: "30000000-0000-4000-8000-000000000001",
    version: 8,
    status: "published",
    durationMinutes: null,
    slots: slots().map((slot) => ({ ...slot, label: slot.label.trim() })),
    publishedAt: "2030-01-01T00:00:00Z",
    createdAt: "2030-01-01T00:00:00Z",
  };
  const withoutDuration = clients(published);
  const withNull = clients(published);
  const base = {
    roomTypeCode: "standard",
    cleaningKind: "checkout",
    expectedVersion: 0,
    slots: slots(),
  };
  const result = await cleaningTemplates(
    request("POST", base),
    withoutDuration.value,
    admin,
  );
  await cleaningTemplates(
    request("POST", { ...base, durationMinutes: null }),
    withNull.value,
    admin,
  );
  assert(
    "durationMinutes" in result && result.durationMinutes === null,
    "projection preserves an explicit unconfigured duration",
  );
  assert(
    withoutDuration.calls[0]?.args.p_duration_minutes === null,
    "RPC receives NULL rather than an inferred duration",
  );
  assert(
    withoutDuration.calls[0]?.args.p_request_hash ===
      withNull.calls[0]?.args.p_request_hash,
    "omitted and explicit NULL normalize to one idempotency fingerprint",
  );
});

Deno.test("cleaning template validation rejects malformed duplicate missing and role boundaries", async () => {
  const mock = clients({});
  const base = {
    roomTypeCode: "standard",
    cleaningKind: "checkout",
    expectedVersion: 0,
    durationMinutes: 60,
    slots: slots(),
  };
  const duplicate = slots();
  duplicate[1] = { ...duplicate[1], slotKey: "tv-on" };
  const noTv = slots().map((slot) => ({
    ...slot,
    slotKey: slot.slotKey === "tv-on" ? "television" : slot.slotKey,
  }));
  const entryNumber = slots().map((slot, index) => ({
    ...slot,
    slotKey: index === 2 ? "entry-number" : slot.slotKey,
  }));
  const missingMaxPhotos = slots().map((slot, index) =>
    index === 0
      ? {
        slotKey: slot.slotKey,
        displayOrder: slot.displayOrder,
        required: slot.required,
        label: slot.label,
      }
      : slot
  );
  for (
    const [body, code] of [
      [{ ...base, slots: slots(8) }, "INVALID_CLEANING_TEMPLATE_SLOTS"],
      [{ ...base, slots: duplicate }, "INVALID_CLEANING_TEMPLATE_SLOTS"],
      [{ ...base, slots: noTv }, "INVALID_CLEANING_TEMPLATE_SLOTS"],
      [{ ...base, slots: entryNumber }, "INVALID_CLEANING_TEMPLATE_SLOTS"],
      [{ ...base, slots: missingMaxPhotos }, "INVALID_CLEANING_TEMPLATE_SLOTS"],
      [{
        ...base,
        slots: slots().map((slot, index) => ({
          ...slot,
          displayOrder: index + 1,
        })),
      }, "INVALID_CLEANING_TEMPLATE_SLOTS"],
      [{ ...base, durationMinutes: 10_081 }, "INVALID_CLEANING_TEMPLATE"],
      [{ ...base, extra: true }, "INVALID_CLEANING_TEMPLATE"],
    ] as const
  ) {
    await failure(
      () => cleaningTemplates(request("POST", body), mock.value, admin),
      code,
    );
  }
  for (const role of ["maid", "developer"] as const) {
    await failure(
      () =>
        cleaningTemplates(request("POST", base), mock.value, {
          ...admin,
          role,
        }),
      "ADMIN_REQUIRED",
    );
  }
  await failure(() =>
    cleaningTemplates(request("POST", base), mock.value, {
      ...admin,
      mustChangePassword: true,
    }), "PASSWORD_CHANGE_REQUIRED");
  assert(mock.calls.length === 0, "denied inputs never write");
});

Deno.test("cleaning template response parsing fails closed on malformed database projections", async () => {
  const published = {
    id: "30000000-0000-4000-8000-000000000001",
    version: 8,
    status: "published",
    durationMinutes: 60,
    slots: slots().map((slot) => ({ ...slot, label: slot.label.trim() })),
    publishedAt: "2030-01-01T00:00:00Z",
    createdAt: "2030-01-01T00:00:00Z",
    rawSecret: "hidden",
  };
  await failure(
    () =>
      cleaningTemplates(
        request("POST", {
          roomTypeCode: "standard",
          cleaningKind: "checkout",
          expectedVersion: 0,
          durationMinutes: 60,
          slots: slots(),
        }),
        clients(published).value,
        admin,
      ),
    "CLEANING_TEMPLATE_COMMAND_FAILED",
  );
});

Deno.test("cleaning template response timestamps reject impossible RFC 3339 values", async () => {
  const base = {
    id: "30000000-0000-4000-8000-000000000001",
    version: 8,
    status: "published",
    durationMinutes: 60,
    slots: slots().map((slot) => ({ ...slot, label: slot.label.trim() })),
    publishedAt: "2028-02-29T23:59:59.123456789+09:00",
    createdAt: "2028-02-29T23:59:59.123456789+09:00",
  };
  const body = {
    roomTypeCode: "standard",
    cleaningKind: "checkout",
    expectedVersion: 0,
    durationMinutes: 60,
    slots: slots(),
  };
  const valid = await cleaningTemplates(
    request("POST", body),
    clients(base).value,
    admin,
  );
  assert(
    "version" in valid && valid.version === 8,
    "valid leap timestamp accepted",
  );
  for (const field of ["publishedAt", "createdAt"] as const) {
    for (
      const value of [
        "2027-02-29T00:00:00Z",
        "2030-04-31T00:00:00Z",
        "2030-01-01T24:00:00Z",
        "2030-01-01T00:60:00Z",
        "2030-01-01T00:00:60Z",
        "2030-01-01T00:00:00+24:00",
      ]
    ) {
      await failure(
        () =>
          cleaningTemplates(
            request("POST", body),
            clients({ ...base, [field]: value }).value,
            admin,
          ),
        "CLEANING_TEMPLATE_COMMAND_FAILED",
      );
    }
  }
});

Deno.test("cleaning template errors preserve stable status and redact raw database failures", () => {
  assert(
    templateDatabaseError({ message: "CLEANING_TEMPLATE_VERSION_CONFLICT" })
      .status === 409,
    "stale CAS",
  );
  assert(
    templateDatabaseError({ message: "SESSION_REVOKED" }).status === 401,
    "revoked session",
  );
  const raw = templateDatabaseError({ message: "secret phone raw SQL" });
  assert(
    raw.status === 500 && raw.code === "CLEANING_TEMPLATE_COMMAND_FAILED" &&
      !raw.message.includes("secret"),
    "raw DB error redacted",
  );
});
