import { idempotencyKey, readJsonBody } from "./account-api.ts";
import {
  canonicalRoomPin,
  decryptRoomPin,
  encryptRoomPin,
  type RoomPinCryptoConfig,
  RoomPinCryptoError,
  type RoomPinEnvelope,
} from "./room-pin-crypto.ts";
import { roomDatabaseError } from "./room-api.ts";
import {
  type EdgeActor,
  type EdgeClients,
  EdgeError,
  requiredEnv,
  requirePasswordChanged,
} from "./runtime.ts";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const reasons = new Set([
  "ADMIN_INITIAL_PIN",
  "ADMIN_PHYSICAL_CHANGE",
  "MAID_CLEANING_CHANGE",
  "ACTUAL_PIN_REENTRY",
]);

function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new EdgeError(
      400,
      "VALIDATION_ERROR",
      `${field} 형식이 올바르지 않습니다.`,
    );
  }
  return value.toLowerCase();
}

function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new EdgeError(
      400,
      "VALIDATION_ERROR",
      "expectedPinVersion이 올바르지 않습니다.",
    );
  }
  return value as number;
}

function optionalUuid(value: unknown, field: string): string | null {
  return value === undefined || value === null ? null : uuid(value, field);
}

function only(body: Record<string, unknown>, fields: string[]): void {
  if (Object.keys(body).some((field) => !fields.includes(field))) {
    throw new EdgeError(
      400,
      "VALIDATION_ERROR",
      "허용되지 않은 요청 필드가 있습니다.",
    );
  }
}

async function hash(value: unknown): Promise<string> {
  function canonical(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right)).map((
            [key, nested],
          ) => [key, canonical(nested)]),
      );
    }
    return input;
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(canonical(value))),
  );
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function config(): RoomPinCryptoConfig {
  try {
    const keyring = JSON.parse(requiredEnv("ROOM_PIN_KEYRING_JSON")) as Record<
      string,
      string
    >;
    const reservationKeyring = JSON.parse(
      requiredEnv("RESERVATION_PII_KEYRING_JSON"),
    ) as Record<string, unknown>;
    const webPushKeyring = JSON.parse(
      requiredEnv("WEB_PUSH_SUBSCRIPTION_KEYRING_JSON"),
    ) as Record<string, unknown>;
    const currentKey = requiredEnv("ROOM_PIN_KEY_BASE64");
    const roomPinKeys = [
      currentKey,
      ...Object.values(keyring),
    ];
    const otherPurposeKeys = [
      requiredEnv("RESERVATION_PII_KEY_BASE64"),
      requiredEnv("WEB_PUSH_SUBSCRIPTION_KEY_BASE64"),
      ...Object.values(reservationKeyring),
      ...Object.values(webPushKeyring),
    ];
    if (
      !reservationKeyring || Array.isArray(reservationKeyring) ||
      !webPushKeyring || Array.isArray(webPushKeyring) ||
      roomPinKeys.some((key) => otherPurposeKeys.includes(key))
    ) {
      throw new Error("purpose-specific key required");
    }
    return {
      key: currentKey,
      keyVersion: requiredEnv("ROOM_PIN_KEY_VERSION"),
      keyring,
      environment: requiredEnv("RUNTIME_ENVIRONMENT"),
      projectRef: requiredEnv("SUPABASE_PROJECT_REF"),
    };
  } catch {
    throw new EdgeError(
      503,
      "ROOM_PIN_CRYPTO_CONFIG_INVALID",
      "객실 PIN 암호화 설정을 확인해 주세요.",
    );
  }
}

function envelope(row: Record<string, unknown>): RoomPinEnvelope {
  return {
    envelopeFormat: row.envelope_format as 1,
    keyVersion: String(row.key_version),
    ciphertextBase64: String(row.ciphertext_base64),
    nonceBase64: String(row.nonce_base64),
    authTagBase64: String(row.auth_tag_base64),
    aadEnvironment: String(row.aad_environment),
    aadProjectRef: String(row.aad_project_ref),
  };
}

function cryptoError(error: unknown): EdgeError {
  if (error instanceof EdgeError) return error;
  if (error instanceof RoomPinCryptoError) {
    if (error.code === "INVALID_ROOM_PIN") {
      return new EdgeError(
        400,
        "INVALID_ROOM_PIN",
        "PIN은 4~8자리 숫자 문자열이어야 합니다.",
      );
    }
    if (error.code === "ROOM_PIN_KEY_UNAVAILABLE") {
      return new EdgeError(
        503,
        error.code,
        "해당 PIN 암호화 키를 사용할 수 없습니다.",
      );
    }
    return new EdgeError(
      503,
      error.code,
      "객실 PIN 암호화 설정을 확인해 주세요.",
    );
  }
  return new EdgeError(
    500,
    "ROOM_PIN_COMMAND_FAILED",
    "객실 PIN을 처리하지 못했습니다.",
  );
}

export type RoomPinRoute = {
  kind: "prepare" | "confirm" | "rollback" | "reveal";
  roomId: string;
  leaseId?: string;
};
export function roomPinPath(path: string): RoomPinRoute | null {
  let match = /^\/v1\/rooms\/([^/]+)\/pin-changes\/prepare$/.exec(path);
  if (match) return { kind: "prepare", roomId: uuid(match[1], "roomId") };
  match = /^\/v1\/rooms\/([^/]+)\/pin-changes\/([^/]+)\/(confirm|rollback)$/
    .exec(path);
  if (match) {
    return {
      kind: match[3] as "confirm" | "rollback",
      roomId: uuid(match[1], "roomId"),
      leaseId: uuid(match[2], "leaseId"),
    };
  }
  match = /^\/v1\/rooms\/([^/]+)\/pin\/reveal$/.exec(path);
  return match ? { kind: "reveal", roomId: uuid(match[1], "roomId") } : null;
}

export async function prepareRoomPinChange(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  sessionId: string,
  roomId: string,
) {
  requirePasswordChanged(actor);
  const body = await readJsonBody(request);
  only(body, [
    "pinDigits",
    "expectedPinVersion",
    "reasonCode",
    "assignmentId",
    "attemptId",
    "accessLeaseId",
  ]);
  if (
    typeof body.pinDigits !== "string" || !/^[0-9]{4,8}$/.test(body.pinDigits)
  ) {
    throw new EdgeError(
      400,
      "INVALID_ROOM_PIN",
      "PIN은 4~8자리 숫자 문자열이어야 합니다.",
    );
  }
  if (typeof body.reasonCode !== "string" || !reasons.has(body.reasonCode)) {
    throw new EdgeError(
      400,
      "VALIDATION_ERROR",
      "reasonCode가 올바르지 않습니다.",
    );
  }
  const expected = version(body.expectedPinVersion);
  const assignmentId = optionalUuid(body.assignmentId, "assignmentId");
  const attemptId = optionalUuid(body.attemptId, "attemptId");
  const accessLeaseId = optionalUuid(body.accessLeaseId, "accessLeaseId");
  const args = {
    p_actor_profile_id: actor.profileId,
    p_session_id: sessionId,
    p_room_id: roomId,
    p_expected_pin_version: expected,
    p_assignment_id: assignmentId,
    p_attempt_id: attemptId,
    p_access_lease_id: accessLeaseId,
  };
  const { data: contextData, error: contextError } = await clients.admin.rpc(
    "get_room_pin_change_context",
    args,
  );
  if (contextError || !contextData) throw roomDatabaseError(contextError);
  const context = contextData as Record<string, unknown>;
  const roomNumber = String(context.room_number);
  const canonical = canonicalRoomPin(roomNumber, body.pinDigits);
  let encrypted: RoomPinEnvelope;
  try {
    encrypted = await encryptRoomPin(
      canonical,
      roomId,
      Number(context.proposed_pin_version),
      config(),
    );
  } catch (error) {
    throw cryptoError(error);
  }
  const requestHash = await hash({
    roomId,
    roomNumber,
    expectedPinVersion: expected,
    assignmentId,
    attemptId,
    accessLeaseId,
    reasonCode: body.reasonCode,
  });
  const { data, error } = await clients.admin.rpc("prepare_room_pin_change", {
    ...args,
    p_reason_code: body.reasonCode,
    p_room_number_snapshot: roomNumber,
    p_envelope_format: encrypted.envelopeFormat,
    p_ciphertext_base64: encrypted.ciphertextBase64,
    p_nonce_base64: encrypted.nonceBase64,
    p_auth_tag_base64: encrypted.authTagBase64,
    p_key_version: encrypted.keyVersion,
    p_aad_environment: encrypted.aadEnvironment,
    p_aad_project_ref: encrypted.aadProjectRef,
    p_idempotency_key: idempotencyKey(request),
    p_request_hash: requestHash,
  });
  if (error || !data) throw roomDatabaseError(error);
  const row = data as Record<string, unknown>;
  if (row.replay === true) {
    try {
      const saved = await decryptRoomPin(
        envelope(row),
        roomId,
        roomNumber,
        Number(row.proposed_pin_version),
        config(),
      );
      if (saved !== canonical) {
        throw new EdgeError(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "이미 다른 요청에 사용한 Idempotency-Key입니다.",
        );
      }
    } catch (error) {
      if (error instanceof EdgeError) throw error;
      if (
        error instanceof RoomPinCryptoError &&
        error.code === "ROOM_PIN_DECRYPT_FAILED"
      ) {
        throw new EdgeError(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "이미 다른 요청에 사용한 Idempotency-Key입니다.",
        );
      }
      throw cryptoError(error);
    }
  }
  return {
    leaseId: row.lease_id,
    roomId: row.room_id,
    currentPinVersion: row.current_pin_version,
    proposedPinVersion: row.proposed_pin_version,
    status: row.status,
    expiresAt: row.expires_at,
  };
}

export async function finishRoomPinChange(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  sessionId: string,
  route: RoomPinRoute,
) {
  requirePasswordChanged(actor);
  const body = await readJsonBody(request);
  only(body, ["expectedPinVersion"]);
  const expected = version(body.expectedPinVersion);
  const fingerprint = {
    roomId: route.roomId,
    leaseId: route.leaseId,
    expectedPinVersion: expected,
  };
  const { data, error } = await clients.admin.rpc(
    route.kind === "confirm"
      ? "confirm_room_pin_change"
      : "rollback_room_pin_change",
    {
      p_actor_profile_id: actor.profileId,
      p_session_id: sessionId,
      p_room_id: route.roomId,
      p_lease_id: route.leaseId,
      p_expected_pin_version: expected,
      p_idempotency_key: idempotencyKey(request),
      p_request_hash: await hash(fingerprint),
    },
  );
  if (error || !data) throw roomDatabaseError(error);
  const row = data as Record<string, unknown>;
  return route.kind === "confirm"
    ? {
      leaseId: row.lease_id,
      roomId: row.room_id,
      pinVersion: row.pin_version,
      ...(row.access_lease_id === undefined
        ? {}
        : { accessLeaseId: row.access_lease_id }),
      status: row.status,
      confirmedAt: row.confirmed_at,
    }
    : {
      leaseId: row.lease_id,
      roomId: row.room_id,
      pinVersion: row.pin_version,
      status: row.status,
      resolvedAt: row.resolved_at,
    };
}

export async function revealRoomPin(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  sessionId: string,
  roomId: string,
) {
  requirePasswordChanged(actor);
  const body = await readJsonBody(request);
  only(body, ["assignmentId", "attemptId", "accessLeaseId"]);
  const requestId = crypto.randomUUID();
  const { data, error } = await clients.admin.rpc("begin_room_pin_reveal", {
    p_actor_profile_id: actor.profileId,
    p_session_id: sessionId,
    p_room_id: roomId,
    p_assignment_id: optionalUuid(body.assignmentId, "assignmentId"),
    p_attempt_id: optionalUuid(body.attemptId, "attemptId"),
    p_access_lease_id: optionalUuid(body.accessLeaseId, "accessLeaseId"),
    p_request_id: requestId,
  });
  if (error || !data) throw roomDatabaseError(error);
  const row = data as Record<string, unknown>;
  let credential: string;
  try {
    credential = await decryptRoomPin(
      envelope(row),
      roomId,
      String(row.room_number),
      Number(row.pin_version),
      config(),
    );
  } catch (cryptoFailure) {
    throw cryptoError(cryptoFailure);
  }
  const { error: finalError } = await clients.admin.rpc(
    "finalize_room_pin_reveal",
    {
      p_actor_profile_id: actor.profileId,
      p_session_id: sessionId,
      p_room_id: roomId,
      p_reveal_lease_id: row.lease_id,
      p_request_id: requestId,
    },
  );
  if (finalError) throw roomDatabaseError(finalError);
  const expiresAt = String(row.expires_at);
  const clearAfterSeconds = Math.min(
    30,
    Math.floor((Date.parse(expiresAt) - Date.now()) / 1000),
  );
  if (!Number.isFinite(clearAfterSeconds) || clearAfterSeconds <= 0) {
    throw new EdgeError(
      403,
      "PIN_REVEAL_AUTHORIZATION_CHANGED",
      "PIN 열람 권한이 변경되었습니다.",
    );
  }
  return {
    roomId,
    credential,
    pinVersion: row.pin_version,
    clearAfterSeconds,
    expiresAt,
  };
}
