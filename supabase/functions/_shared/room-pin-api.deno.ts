import {
  finishRoomPinChange,
  prepareRoomPinChange,
  revealRoomPin,
  roomPinPath,
} from "./room-pin-api.ts";
import { encryptRoomPin } from "./room-pin-crypto.ts";
import { roomDatabaseError } from "./room-api.ts";
import type { EdgeActor, EdgeClients } from "./runtime.ts";
import { EdgeError } from "./runtime.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const actor: EdgeActor = {
  authUserId: "10000000-0000-4000-8000-000000000001",
  profileId: "20000000-0000-4000-8000-000000000001",
  displayName: "운영 관리자",
  role: "admin",
  mustChangePassword: false,
};
const roomId = "30000000-0000-4000-8000-000000000001";
const leaseId = "40000000-0000-4000-8000-000000000001";
const sessionId = "50000000-0000-4000-8000-000000000001";
const assignmentId = "60000000-0000-4000-8000-000000000001";
const attemptId = "70000000-0000-4000-8000-000000000001";
const accessLeaseId = "80000000-0000-4000-8000-000000000001";
const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const reservationKey = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";
const webPushKey = "BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ=";

function configure(): void {
  Deno.env.set("ROOM_PIN_KEY_BASE64", key);
  Deno.env.set("ROOM_PIN_KEY_VERSION", "key-v1");
  Deno.env.set("ROOM_PIN_KEYRING_JSON", "{}");
  Deno.env.set("RESERVATION_PII_KEY_BASE64", reservationKey);
  Deno.env.set("RESERVATION_PII_KEYRING_JSON", "{}");
  Deno.env.set("WEB_PUSH_SUBSCRIPTION_KEY_BASE64", webPushKey);
  Deno.env.set("WEB_PUSH_SUBSCRIPTION_KEYRING_JSON", "{}");
  Deno.env.set("RUNTIME_ENVIRONMENT", "test");
  Deno.env.set("SUPABASE_PROJECT_REF", "local-ref");
}

Deno.test("room PIN crypto config rejects cross-purpose key reuse safely", async () => {
  configure();
  Deno.env.set("ROOM_PIN_KEY_BASE64", reservationKey);
  const clients = {
    admin: {
      rpc(name: string) {
        assert(
          name === "get_room_pin_change_context",
          "only context precedes crypto",
        );
        return Promise.resolve({
          data: { room_number: "101", proposed_pin_version: 1 },
          error: null,
        });
      },
    },
  } as unknown as EdgeClients;
  try {
    await prepareRoomPinChange(
      command(`/v1/rooms/${roomId}/pin-changes/prepare`, {
        expectedPinVersion: 0,
        pinDigits: "0012",
        reasonCode: "ADMIN_INITIAL_PIN",
      }),
      clients,
      actor,
      sessionId,
      roomId,
    );
    throw new Error("expected crypto config failure");
  } catch (error) {
    assert(error instanceof EdgeError, "safe edge error");
    assert(error.status === 503, "stable config status");
    assert(
      error.code === "ROOM_PIN_CRYPTO_CONFIG_INVALID",
      "stable config code",
    );
    assert(!error.message.includes(reservationKey), "secret is redacted");
  } finally {
    configure();
  }
});

function command(
  path: string,
  body: Record<string, unknown>,
  idempotency = "pin-edge-test-0001",
): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotency,
    },
    body: JSON.stringify(body),
  });
}

Deno.test("room PIN paths are exact and reject aliases", () => {
  assert(
    roomPinPath(`/v1/rooms/${roomId}/pin-changes/prepare`)?.kind === "prepare",
    "prepare path",
  );
  assert(
    roomPinPath(`/v1/rooms/${roomId}/pin-changes/${leaseId}/confirm`)?.kind ===
      "confirm",
    "confirm path",
  );
  assert(
    roomPinPath(`/v1/rooms/${roomId}/pin-changes/${leaseId}/rollback`)?.kind ===
      "rollback",
    "rollback path",
  );
  assert(
    roomPinPath(`/v1/rooms/${roomId}/pin/reveal`)?.kind === "reveal",
    "reveal path",
  );
  assert(roomPinPath(`/v1/rooms/${roomId}/pin`) === null, "no reveal alias");
});

Deno.test("prepare binds room snapshot and maid access authority without hashing PIN material", async () => {
  configure();
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const clients = {
    admin: {
      async rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        if (name === "get_room_pin_change_context") {
          return {
            data: {
              room_number: "0101",
              current_pin_version: 1,
              proposed_pin_version: 2,
            },
            error: null,
          };
        }
        return {
          data: {
            lease_id: leaseId,
            room_id: roomId,
            current_pin_version: 1,
            proposed_pin_version: 2,
            status: "prepared",
            expires_at: new Date(Date.now() + 300_000).toISOString(),
            replay: false,
          },
          error: null,
        };
      },
    },
  } as unknown as EdgeClients;
  const result = await prepareRoomPinChange(
    command(`/v1/rooms/${roomId}/pin-changes/prepare`, {
      pinDigits: "0012",
      expectedPinVersion: 1,
      reasonCode: "MAID_CLEANING_CHANGE",
      assignmentId,
      attemptId,
      accessLeaseId,
    }),
    clients,
    { ...actor, role: "maid" },
    sessionId,
    roomId,
  );
  const prepare = calls[1].args;
  assert(prepare.p_room_number_snapshot === "0101", "room snapshot bound");
  assert(
    prepare.p_access_lease_id === accessLeaseId,
    "authoritative access lease bound",
  );
  assert(
    typeof prepare.p_request_hash === "string" &&
      !String(prepare.p_request_hash).includes("0012"),
    "request hash excludes PIN",
  );
  const response = JSON.stringify(result);
  assert(
    !response.includes("0012") && !response.includes("ciphertext") &&
      !response.includes("nonce"),
    "safe prepare response",
  );
});

Deno.test("confirm and rollback map database fields to exact camelCase contracts", async () => {
  const clients = {
    admin: {
      rpc(name: string) {
        return Promise.resolve({
          data: name === "confirm_room_pin_change"
            ? {
              lease_id: leaseId,
              room_id: roomId,
              pin_version: 2,
              access_lease_id: accessLeaseId,
              status: "confirmed",
              confirmed_at: "2026-09-13T00:00:00Z",
            }
            : {
              lease_id: leaseId,
              room_id: roomId,
              pin_version: 1,
              status: "rolled_back",
              resolved_at: "2026-09-13T00:00:00Z",
            },
          error: null,
        });
      },
    },
  } as unknown as EdgeClients;
  const confirm = await finishRoomPinChange(
    command("/confirm", { expectedPinVersion: 1 }),
    clients,
    actor,
    sessionId,
    { kind: "confirm", roomId, leaseId },
  );
  const rollback = await finishRoomPinChange(
    command("/rollback", { expectedPinVersion: 1 }, "pin-edge-test-0002"),
    clients,
    actor,
    sessionId,
    { kind: "rollback", roomId, leaseId },
  );
  assert(
    "confirmedAt" in confirm && !("confirmed_at" in confirm),
    "confirm camelCase",
  );
  assert(
    "accessLeaseId" in confirm && !("access_lease_id" in confirm),
    "maid confirm returns camelCase reissued access authority",
  );
  assert(
    "resolvedAt" in rollback && !("resolved_at" in rollback),
    "rollback camelCase",
  );
});

Deno.test("reveal uses stored AAD, finalizes first, and returns only remaining TTL", async () => {
  configure();
  const encrypted = await encryptRoomPin("0101-0012", roomId, 2, {
    key,
    keyVersion: "key-v1",
    keyring: {},
    environment: "production",
    projectRef: "prod-ref",
  });
  const calls: string[] = [];
  const expiresAt = new Date(Date.now() + 5_500).toISOString();
  const clients = {
    admin: {
      rpc(name: string) {
        calls.push(name);
        if (name === "begin_room_pin_reveal") {
          return Promise.resolve({
            data: {
              lease_id: leaseId,
              room_id: roomId,
              room_number: "0101",
              pin_version: 2,
              expires_at: expiresAt,
              envelope_format: encrypted.envelopeFormat,
              ciphertext_base64: encrypted.ciphertextBase64,
              nonce_base64: encrypted.nonceBase64,
              auth_tag_base64: encrypted.authTagBase64,
              key_version: encrypted.keyVersion,
              aad_environment: encrypted.aadEnvironment,
              aad_project_ref: encrypted.aadProjectRef,
            },
            error: null,
          });
        }
        return Promise.resolve({ data: {}, error: null });
      },
    },
  } as unknown as EdgeClients;
  const result = await revealRoomPin(
    command("/reveal", {}),
    clients,
    actor,
    sessionId,
    roomId,
  );
  assert(
    result.credential === "0101-0012",
    "stored production AAD decrypts under recovery runtime",
  );
  assert(
    result.clearAfterSeconds >= 1 && result.clearAfterSeconds <= 5,
    "remaining TTL returned",
  );
  assert(
    calls.join(",") === "begin_room_pin_reveal,finalize_room_pin_reveal",
    "final authorization succeeds first",
  );
});

Deno.test("expired reveal plaintext is never returned after finalization", async () => {
  configure();
  const encrypted = await encryptRoomPin("0101-0012", roomId, 1, {
    key,
    keyVersion: "key-v1",
    keyring: {},
    environment: "test",
    projectRef: "local-ref",
  });
  const clients = {
    admin: {
      rpc(name: string) {
        return Promise.resolve({
          data: name === "begin_room_pin_reveal"
            ? {
              lease_id: leaseId,
              room_number: "0101",
              pin_version: 1,
              expires_at: new Date(Date.now() - 1_000).toISOString(),
              envelope_format: encrypted.envelopeFormat,
              ciphertext_base64: encrypted.ciphertextBase64,
              nonce_base64: encrypted.nonceBase64,
              auth_tag_base64: encrypted.authTagBase64,
              key_version: encrypted.keyVersion,
              aad_environment: encrypted.aadEnvironment,
              aad_project_ref: encrypted.aadProjectRef,
            }
            : {},
          error: null,
        });
      },
    },
  } as unknown as EdgeClients;
  let failure: unknown;
  try {
    await revealRoomPin(
      command("/reveal", {}),
      clients,
      actor,
      sessionId,
      roomId,
    );
  } catch (error) {
    failure = error;
  }
  assert(
    failure instanceof EdgeError &&
      failure.code === "PIN_REVEAL_AUTHORIZATION_CHANGED",
    "expired response denied",
  );
  assert(!JSON.stringify(failure).includes("0101-0012"), "plaintext absent");
});

Deno.test("PIN database errors remain stable and never expose raw details", () => {
  const cases: Array<[string, number, string]> = [
    ["STALE_PIN_VERSION", 409, "STALE_PIN_VERSION"],
    ["ROOM_NUMBER_CHANGED", 409, "ROOM_NUMBER_CHANGED"],
    ["ROOM_PIN_MISMATCH_UNRESOLVED", 409, "ROOM_PIN_MISMATCH_UNRESOLVED"],
    ["PIN_CHANGE_IN_PROGRESS_REQUIRED", 403, "PIN_CHANGE_IN_PROGRESS_REQUIRED"],
    ["PIN_ACCESS_LEASE_REQUIRED", 403, "PIN_ACCESS_LEASE_REQUIRED"],
    [
      "PIN_REVEAL_AUTHORIZATION_CHANGED",
      403,
      "PIN_REVEAL_AUTHORIZATION_CHANGED",
    ],
    ["ROOM_PIN_UNCONFIGURED", 404, "ROOM_PIN_UNCONFIGURED"],
  ];
  for (const [database, status, code] of cases) {
    const error = roomDatabaseError({
      message: `${database}: ciphertext=secret`,
    });
    assert(
      error.status === status && error.code === code,
      `${database} mapping`,
    );
    assert(
      !error.message.includes("ciphertext") &&
        !error.message.includes("secret"),
      `${database} safe message`,
    );
  }
});
