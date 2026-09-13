import { idempotencyKey, readJsonBody } from "./account-api.ts";
import {
  RoomPinSheetProviderError,
  roomPinSheetTargetDigest,
  validateGoogleSheetsServiceAccount,
} from "./google-sheets-pin.ts";
import {
  RoomPinCryptoError,
  validateRoomPinCryptoConfig,
} from "./room-pin-crypto.ts";
import {
  loadRoomPinSheetRuntimeConfig,
  RoomPinSheetSyncError,
} from "./room-pin-sheet-sync.ts";
import {
  type EdgeActor,
  type EdgeClients,
  EdgeError,
  requirePasswordChanged,
  verifiedRequestSessionId,
} from "./runtime.ts";

const timestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const errorCodePattern = /^[A-Z0-9_]{2,80}$/;

function operator(actor: EdgeActor): void {
  requirePasswordChanged(actor);
  if (actor.role !== "developer" && actor.role !== "admin") {
    throw new EdgeError(
      403,
      "ROOM_PIN_SHEET_OPERATOR_REQUIRED",
      "PIN Sheet 운영 권한이 필요합니다.",
    );
  }
}

function dbError(error: { message?: string } | null): EdgeError {
  const message = error?.message ?? "";
  const mappings: Array<[string, number, string, string]> = [
    [
      "SESSION_REVOKED",
      401,
      "SESSION_REVOKED",
      "로그인이 만료되었습니다. 다시 로그인해 주세요.",
    ],
    [
      "ROOM_PIN_SHEET_OPERATOR_REQUIRED",
      403,
      "ROOM_PIN_SHEET_OPERATOR_REQUIRED",
      "PIN Sheet 운영 권한이 필요합니다.",
    ],
    [
      "PASSWORD_CHANGE_REQUIRED",
      403,
      "PASSWORD_CHANGE_REQUIRED",
      "계속하려면 먼저 임시 비밀번호를 변경해 주세요.",
    ],
    [
      "ROOM_PIN_SHEET_FULL_RESYNC_STALE",
      409,
      "ROOM_PIN_SHEET_FULL_RESYNC_STALE",
      "PIN Sheet 상태가 변경되었습니다. 새 상태를 조회해 주세요.",
    ],
    [
      "ROOM_PIN_SHEET_WORKER_BUSY",
      409,
      "ROOM_PIN_SHEET_WORKER_BUSY",
      "PIN Sheet worker가 실행 중입니다.",
    ],
    [
      "ROOM_PIN_SHEET_FULL_RESYNC_PENDING",
      409,
      "ROOM_PIN_SHEET_FULL_RESYNC_PENDING",
      "이미 전체 동기화가 대기 중입니다.",
    ],
    [
      "ROOM_PIN_SHEET_ROOM_MASTER_INVALID",
      503,
      "ROOM_PIN_SHEET_ROOM_MASTER_INVALID",
      "121실 객실 정본을 확인해 주세요.",
    ],
    [
      "IDEMPOTENCY_KEY_REUSED",
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "이미 다른 요청에 사용한 Idempotency-Key입니다.",
    ],
  ];
  for (const [needle, status, code, korean] of mappings) {
    if (message.includes(needle)) return new EdgeError(status, code, korean);
  }
  return new EdgeError(
    500,
    "ROOM_PIN_SHEET_OPERATION_FAILED",
    "PIN Sheet 운영 요청을 처리하지 못했습니다.",
  );
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && timestampPattern.test(value) &&
    Number.isFinite(Date.parse(value));
}

export interface RoomPinSheetStatusProjection {
  pending: number;
  failed: number;
  operatorBlocked: boolean;
  oldestPendingAt: string | null;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  version: number;
  checkedAt: string;
}

function statusProjection(value: unknown): RoomPinSheetStatusProjection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw dbError(null);
  }
  const row = value as Record<string, unknown>;
  const expected = [
    "checkedAt",
    "failed",
    "lastErrorCode",
    "lastSuccessAt",
    "oldestPendingAt",
    "operatorBlocked",
    "pending",
    "version",
  ];
  if (
    Object.keys(row).sort().join(",") !== expected.join(",") ||
    !Number.isInteger(row.pending) || (row.pending as number) < 0 ||
    (row.pending as number) > 1000 ||
    !Number.isInteger(row.failed) || (row.failed as number) < 0 ||
    (row.failed as number) > 1000 ||
    typeof row.operatorBlocked !== "boolean" ||
    !Number.isSafeInteger(row.version) || (row.version as number) < 0 ||
    !timestamp(row.checkedAt) ||
    (row.oldestPendingAt !== null && !timestamp(row.oldestPendingAt)) ||
    (row.lastSuccessAt !== null && !timestamp(row.lastSuccessAt)) ||
    (row.lastErrorCode !== null &&
      (typeof row.lastErrorCode !== "string" ||
        !errorCodePattern.test(row.lastErrorCode)))
  ) {
    throw dbError(null);
  }
  return row as unknown as RoomPinSheetStatusProjection;
}

async function config() {
  try {
    const loaded = loadRoomPinSheetRuntimeConfig((name) => Deno.env.get(name));
    validateRoomPinCryptoConfig(loaded.crypto);
    await validateGoogleSheetsServiceAccount(loaded.serviceAccount);
    return loaded;
  } catch (error) {
    if (
      error instanceof RoomPinSheetProviderError ||
      error instanceof RoomPinCryptoError ||
      error instanceof RoomPinSheetSyncError
    ) {
      throw new EdgeError(
        503,
        "ROOM_PIN_SHEET_NOT_CONFIGURED",
        "PIN Sheet 연결 설정을 확인해 주세요.",
      );
    }
    throw error;
  }
}

async function hash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function assertSize(value: unknown): void {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 128 * 1024) {
    throw new EdgeError(
      500,
      "ROOM_PIN_SHEET_RESPONSE_TOO_LARGE",
      "PIN Sheet 운영 응답 크기 제한을 초과했습니다.",
    );
  }
}

export async function roomPinSheetSyncStatus(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
) {
  operator(actor);
  if (new URL(request.url).search !== "") {
    throw new EdgeError(
      400,
      "VALIDATION_ERROR",
      "query 항목은 허용되지 않습니다.",
    );
  }
  const { data, error } = await clients.admin.rpc(
    "get_room_pin_sheet_sync_status",
    {
      p_actor_profile_id: actor.profileId,
      p_session_id: verifiedRequestSessionId(request),
    },
  );
  if (error || data === null) throw dbError(error);
  const result = statusProjection(data);
  try {
    await config();
  } catch (configError) {
    if (
      !(configError instanceof EdgeError) ||
      configError.code !== "ROOM_PIN_SHEET_NOT_CONFIGURED"
    ) throw configError;
    result.operatorBlocked = true;
    result.lastErrorCode = "PROVIDER_CONFIGURATION_ERROR";
  }
  assertSize(result);
  return result;
}

export async function requestRoomPinSheetFullResync(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
) {
  operator(actor);
  if (new URL(request.url).search !== "") {
    throw new EdgeError(
      400,
      "VALIDATION_ERROR",
      "query 항목은 허용되지 않습니다.",
    );
  }
  const body = await readJsonBody(request);
  if (
    Object.keys(body).sort().join(",") !== "expectedVersion" ||
    !Number.isSafeInteger(body.expectedVersion) ||
    (body.expectedVersion as number) < 0
  ) {
    throw new EdgeError(
      400,
      "VALIDATION_ERROR",
      "expectedVersion이 올바르지 않습니다.",
    );
  }
  const loaded = await config();
  const targetIdentityDigest = await roomPinSheetTargetDigest(loaded.target);
  const requestHash = await hash({
    expectedVersion: body.expectedVersion,
    targetIdentityDigest,
  });
  const { data, error } = await clients.admin.rpc(
    "request_room_pin_sheet_full_resync",
    {
      p_actor_profile_id: actor.profileId,
      p_session_id: verifiedRequestSessionId(request),
      p_expected_fence: body.expectedVersion,
      p_expected_environment: loaded.target.environment,
      p_expected_project_ref: loaded.target.projectRef,
      p_expected_target_identity_digest: targetIdentityDigest,
      p_idempotency_key: idempotencyKey(request),
      p_request_hash: requestHash,
    },
  );
  if (error || data === null) throw dbError(error);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw dbError(null);
  }
  const row = data as Record<string, unknown>;
  if (
    Object.keys(row).sort().join(",") !== "roomCount,status,version" ||
    row.status !== "pending" || row.roomCount !== 121 ||
    !Number.isSafeInteger(row.version) || (row.version as number) < 0
  ) throw dbError(null);
  assertSize(row);
  return row;
}
