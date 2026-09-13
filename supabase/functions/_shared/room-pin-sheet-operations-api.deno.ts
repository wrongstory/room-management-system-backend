import {
  requestRoomPinSheetFullResync,
  roomPinSheetSyncStatus,
} from "./room-pin-sheet-operations-api.ts";
import type { EdgeActor, EdgeClients } from "./runtime.ts";
import { EdgeError } from "./runtime.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const sessionId = "30000000-0000-4000-8000-000000000001";
const token = `header.${
  btoa(JSON.stringify({ session_id: sessionId })).replaceAll("=", "")
    .replaceAll("+", "-").replaceAll("/", "_")
}.signature`;
const actor: EdgeActor = {
  authUserId: "10000000-0000-4000-8000-000000000001",
  profileId: "20000000-0000-4000-8000-000000000001",
  displayName: "운영 관리자",
  role: "admin",
  mustChangePassword: false,
};

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://example.invalid/functions/v1/api${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
}

Deno.test("operator status authenticates in DB before locally degrading malformed configuration", async () => {
  let calls = 0;
  const clients = {
    admin: {
      rpc: (name: string, args: Record<string, unknown>) => {
        calls += 1;
        assert(
          name === "get_room_pin_sheet_sync_status",
          "safe status RPC only",
        );
        assert(
          args.p_session_id === sessionId,
          "verified live session forwarded",
        );
        return Promise.resolve({
          data: {
            pending: 0,
            failed: 0,
            operatorBlocked: false,
            oldestPendingAt: null,
            lastSuccessAt: null,
            lastErrorCode: null,
            version: 4,
            checkedAt: "2026-09-13T00:00:00.000Z",
          },
          error: null,
        });
      },
    },
  } as unknown as EdgeClients;
  const result = await roomPinSheetSyncStatus(
    request("/v1/room-pin-sheet-sync/status"),
    clients,
    actor,
  );
  assert(calls === 1, "DB authorization precedes configuration projection");
  assert(
    result.operatorBlocked,
    "invalid current configuration cannot be false green",
  );
  assert(
    result.lastErrorCode === "PROVIDER_CONFIGURATION_ERROR",
    "stable safe configuration code",
  );
  assert(
    !JSON.stringify(result).match(/credential|privateKey|spreadsheet|token/i),
    "no provider material",
  );
});

Deno.test("full resync command binds exact approved target digest and strict body", async () => {
  const names = [
    "RUNTIME_ENVIRONMENT",
    "SUPABASE_PROJECT_REF",
    "GOOGLE_SHEETS_SPREADSHEET_ID",
    "GOOGLE_SHEETS_ROOM_PIN_TAB",
    "GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL",
    "GOOGLE_SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY",
    "ROOM_PIN_KEY_BASE64",
    "ROOM_PIN_KEY_VERSION",
    "ROOM_PIN_KEYRING_JSON",
  ];
  const prior = new Map(names.map((name) => [name, Deno.env.get(name)]));
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  const encoded = btoa(String.fromCharCode(...pkcs8));
  const pem = `-----BEGIN PRIVATE${" KEY-----"}\n${
    encoded.match(/.{1,64}/g)?.join("\n")
  }\n-----END PRIVATE${" KEY-----"}\n`;
  try {
    Deno.env.set("RUNTIME_ENVIRONMENT", "local");
    Deno.env.set("SUPABASE_PROJECT_REF", "local");
    Deno.env.set(
      "GOOGLE_SHEETS_SPREADSHEET_ID",
      "test-room-pin-sheet-projection-00001",
    );
    Deno.env.set("GOOGLE_SHEETS_ROOM_PIN_TAB", "객실_PIN_현황");
    Deno.env.set(
      "GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL",
      "room-pin@test.iam.gserviceaccount.com",
    );
    Deno.env.set("GOOGLE_SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY", pem);
    Deno.env.set(
      "ROOM_PIN_KEY_BASE64",
      btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
    );
    Deno.env.set("ROOM_PIN_KEY_VERSION", "pin-v1");
    Deno.env.set("ROOM_PIN_KEYRING_JSON", "{}");
    let rpcArgs: Record<string, unknown> = {};
    const clients = {
      admin: {
        rpc: (name: string, args: Record<string, unknown>) => {
          assert(
            name === "request_room_pin_sheet_full_resync",
            "command RPC only",
          );
          rpcArgs = args;
          return Promise.resolve({
            data: { status: "pending", roomCount: 121, version: 9 },
            error: null,
          });
        },
      },
    } as unknown as EdgeClients;
    const result = await requestRoomPinSheetFullResync(
      request("/v1/room-pin-sheet-sync/full-resync", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "full-resync-test-0001",
        },
        body: JSON.stringify({ expectedVersion: 9 }),
      }),
      clients,
      actor,
    );
    assert(
      result.status === "pending" && result.roomCount === 121,
      "bounded accepted projection",
    );
    assert(
      /^[0-9a-f]{64}$/.test(String(rpcArgs.p_expected_target_identity_digest)),
      "target marker is SHA-256",
    );
    assert(
      rpcArgs.p_expected_environment === "local" &&
        rpcArgs.p_expected_project_ref === "local",
      "exact binding",
    );
    assert(
      /^[0-9a-f]{64}$/.test(String(rpcArgs.p_request_hash)),
      "idempotency hash is safe",
    );
  } finally {
    for (const name of names) {
      const value = prior.get(name);
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
});

Deno.test("maid is rejected before PIN Sheet operator RPC", async () => {
  let called = false;
  const clients = {
    admin: {
      rpc: () => {
        called = true;
        return Promise.resolve({ data: null, error: null });
      },
    },
  } as unknown as EdgeClients;
  try {
    await roomPinSheetSyncStatus(
      request("/v1/room-pin-sheet-sync/status"),
      clients,
      { ...actor, role: "maid" },
    );
    throw new Error("maid must fail");
  } catch (error) {
    assert(
      error instanceof EdgeError && error.status === 403,
      "stable role failure",
    );
  }
  assert(!called, "unauthorized role never reaches DB command");
});
