import { RoomPinTransferError } from "./room-pin-transfer.js";
import { RoomPinSheetProviderError } from "./google-sheets-pin.js";

/** Only allowlisted codes cross the HTTP boundary; provider/DB messages may contain secrets. */
export function roomPinTransferFailure(
  error: unknown,
): { status: number; code: string; message: string } {
  const codes: Record<string, number> = {
    SESSION_REVOKED: 401,
    ADMIN_REQUIRED: 403,
    PIN_ACCESS_REQUIRED: 403,
    PASSWORD_CHANGE_REQUIRED: 403,
    ROOM_PIN_TRANSFER_STALE: 409,
    ROOM_PIN_TRANSFER_BUSY: 409,
    IDEMPOTENCY_KEY_REUSED: 409,
    INVALID_PIN_TRANSFER_REQUEST: 400,
    ROOM_PIN_TRANSFER_NOT_CONFIGURED: 503,
  };
  const code =
    error instanceof RoomPinTransferError && Object.hasOwn(codes, error.code)
      ? error.code
      : error instanceof RoomPinSheetProviderError
      ? "ROOM_PIN_IMPORT_SOURCE_UNAVAILABLE"
      : "ROOM_PIN_TRANSFER_FAILED";
  return {
    status: codes[code] ??
      (error instanceof RoomPinSheetProviderError ? 503 : 500),
    code,
    message:
      "객실 비밀번호 처리에 실패했습니다. 연결 설정과 최신 객실 정보를 확인해 주세요.",
  };
}
export function roomPinTransferDatabaseError(
  message: string,
): RoomPinTransferError {
  const allowed = [
    "SESSION_REVOKED",
    "ADMIN_REQUIRED",
    "PIN_ACCESS_REQUIRED",
    "PASSWORD_CHANGE_REQUIRED",
    "ROOM_PIN_TRANSFER_STALE",
    "ROOM_PIN_TRANSFER_BUSY",
    "IDEMPOTENCY_KEY_REUSED",
    "INVALID_PIN_TRANSFER_REQUEST",
  ];
  return new RoomPinTransferError(
    allowed.find((code) => message === code) ?? "ROOM_PIN_TRANSFER_FAILED",
  );
}
