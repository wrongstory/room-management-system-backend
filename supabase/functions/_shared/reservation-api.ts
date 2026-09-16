import { idempotencyKey, readJsonBody } from "./account-api.ts";
import { recordSensitiveReservationRead } from "./activity-api.ts";
import type {
  EdgeActor,
  EdgeClients,
  RoomMoveConflict,
  RoomMoveReloadResource,
} from "./runtime.ts";
import {
  EdgeError,
  requireBusinessAdmin,
  requiredEnv,
  requirePasswordChanged,
} from "./runtime.ts";

type ReservationStatus = "active" | "cancelled" | "checked_out";
type CleaningKind = "stayover" | "additional";

export interface ReservationRow {
  id: string;
  room_id: string;
  check_in_at: string;
  check_out_at: string;
  guest_count: number;
  guest_name_encrypted?: string | null;
  status: ReservationStatus;
  preparation_obligation_id: string;
  checkout_obligation_id: string;
  version: number;
  actual_check_in_at: string | null;
  actual_checkout_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
  room_state_version?: number;
}

export interface ManualCleaningRequestRow {
  id: string;
  room_id: string;
  reservation_id: string | null;
  cleaning_kind: CleaningKind;
  status: string;
  service_date: string;
  available_from: string;
  due_at: string | null;
  version: number;
}

interface GuestNameEnvelope {
  version: 1;
  keyVersion: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

interface PiiConfiguration {
  currentKey: string;
  currentKeyVersion: string;
  previousKeys: Record<string, string>;
  guestNamePepper: string;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const reasonCodePattern = /^[A-Z0-9_]{2,80}$/;
const impactFingerprintPattern = /^[0-9a-f]{64}$/;
const roomMoveReasonCodes = new Set([
  "GUEST_REQUEST",
  "ROOM_UNAVAILABLE",
  "OPERATIONAL_ADJUSTMENT",
]);
const roomMoveModes = new Set(["BEFORE_CHECKIN", "DURING_STAY"]);
const roomMoveRejections = new Set([
  "RESERVATION_NOT_ACTIVE",
  "SAME_ROOM",
  "INVALID_MOVE_EFFECTIVE_AT",
  "OPEN_ENDED_STAY_REQUIRES_END",
  "CLEANING_WORKFLOW_PUBLIC",
  "PLANNED_CHECKOUT_NOT_PRIVATE",
  "CLEANING_WORKFLOW_ASSIGNED",
  "CLEANING_WORKFLOW_NOTIFIED",
  "CLEANING_WORKFLOW_STARTED",
  "ACTIVE_PIN_ACCESS_EXISTS",
  "TARGET_ROOM_BLOCKED",
  "TARGET_ROOM_NOT_READY",
  "RESERVATION_OVERLAP",
]);
const roomMoveBlockingReasons = new Set([
  "RESERVATION_VERSION_CONFLICT",
  "SOURCE_ROOM_VERSION_CONFLICT",
  "TARGET_ROOM_VERSION_CONFLICT",
  "TARGET_ROOM_OVERLAP",
  "ROOM_CHANGE_PREVIEW_STALE",
  "CLEANING_ASSIGNMENT_LOCKED",
  "PIN_LEASE_ACTIVE",
  "TARGET_ROOM_BLOCKED",
  "TARGET_ROOM_NOT_READY",
]);
const roomMoveTargetBlockReasons = new Set([
  "OCCUPIED",
  "RESERVATION_CURRENT",
  "CLEANING_REQUIRED",
  "CANDLE_PRESENT",
  "OPERATION_BLOCKED",
  "ROOM_ISSUE_BLOCKED",
  "DATA_UNCONFIRMED",
]);

function validationError(message: string): never {
  throw new EdgeError(400, "VALIDATION_ERROR", message);
}

function requireReservationAdmin(actor: EdgeActor): void {
  requirePasswordChanged(actor);
  requireBusinessAdmin(actor);
}

function uuidValue(value: unknown, name: string): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    validationError(`${name}에 UUID가 필요합니다.`);
  }
  return value;
}

function timestampValue(value: unknown, name: string): string {
  if (typeof value !== "string" || !strictTimestamp(value)) {
    validationError(`${name}은 offset이 포함된 RFC 3339 시각이어야 합니다.`);
  }
  return value;
}

function dateValue(value: unknown, name: string): string {
  if (typeof value !== "string" || !datePattern.test(value)) {
    validationError(`${name}은 YYYY-MM-DD 형식이어야 합니다.`);
  }
  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    validationError(`${name}에 유효한 날짜가 필요합니다.`);
  }
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    validationError(`${name}은 1 이상의 정수여야 합니다.`);
  }
  return value as number;
}

function reasonCodeValue(value: unknown): string {
  if (typeof value !== "string") {
    validationError("reasonCode 문자열이 필요합니다.");
  }
  const normalized = value.trim();
  if (!reasonCodePattern.test(normalized)) {
    validationError(
      "reasonCode는 2~80자의 영문 대문자, 숫자, 밑줄만 사용할 수 있습니다.",
    );
  }
  return normalized;
}

function normalizeGuestName(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 80) {
    throw new EdgeError(
      400,
      "INVALID_GUEST_NAME",
      "고객 이름은 1자 이상 80자 이하로 입력해 주세요.",
    );
  }
  const normalized = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (normalized.length < 1 || normalized.length > 80) {
    throw new EdgeError(
      400,
      "INVALID_GUEST_NAME",
      "고객 이름은 1자 이상 80자 이하로 입력해 주세요.",
    );
  }
  return normalized;
}

function manualTransitionIdempotencyKey(request: Request): string {
  const key = idempotencyKey(request);
  if (key.startsWith("reservation-scheduler-")) {
    throw new EdgeError(
      400,
      "RESERVED_IDEMPOTENCY_KEY",
      "reservation-scheduler- 접두사는 예약 scheduler 전용입니다.",
    );
  }
  return key;
}

function assertOnlyFields(
  body: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const unexpected = Object.keys(body).find((key) => !allowed.includes(key));
  if (unexpected) {
    validationError(`허용되지 않은 요청 필드입니다: ${unexpected}`);
  }
}

function queryValues(
  request: Request,
  allowed: readonly string[],
): URLSearchParams {
  const search = new URL(request.url).searchParams;
  for (const key of search.keys()) {
    if (!allowed.includes(key)) {
      validationError(`허용되지 않은 query 항목입니다: ${key}`);
    }
    if (search.getAll(key).length > 1) {
      validationError(`query 항목은 한 번만 전달해야 합니다: ${key}`);
    }
  }
  return search;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

async function requestHash(value: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(
      binary,
      (character) => character.charCodeAt(0),
    );
    if (base64FromBytes(bytes) !== value) throw new Error("non-canonical");
    return bytes;
  } catch {
    throw new Error("INVALID_BASE64");
  }
}

async function aesKey(encoded: string): Promise<CryptoKey> {
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(encoded);
  } catch {
    throw new EdgeError(
      503,
      "RESERVATION_PII_KEY_INVALID",
      "예약 개인정보 보호 설정이 올바르지 않습니다.",
    );
  }
  if (bytes.byteLength !== 32) {
    throw new EdgeError(
      503,
      "RESERVATION_PII_KEY_INVALID",
      "예약 개인정보 보호 설정이 올바르지 않습니다.",
    );
  }
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

function piiConfiguration(): PiiConfiguration {
  const currentKey = requiredEnv("RESERVATION_PII_KEY_BASE64");
  const currentKeyVersion = requiredEnv("RESERVATION_PII_KEY_VERSION");
  const guestNamePepper = requiredEnv("RESERVATION_GUEST_NAME_PEPPER");
  const rawKeyring = requiredEnv("RESERVATION_PII_KEYRING_JSON");
  let previousKeys: Record<string, string>;
  try {
    const parsed = JSON.parse(rawKeyring) as unknown;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("invalid keyring");
    }
    previousKeys = Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(
        ([version, key]) => {
          if (!version || typeof key !== "string" || !key) {
            throw new Error("invalid keyring entry");
          }
          return [version, key];
        },
      ),
    );
  } catch {
    throw new EdgeError(
      503,
      "RESERVATION_PII_KEYRING_INVALID",
      "예약 개인정보 키링 설정이 올바르지 않습니다.",
    );
  }
  return { currentKey, currentKeyVersion, previousKeys, guestNamePepper };
}

async function encryptGuestName(
  value: string,
  configuration: PiiConfiguration,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, tagLength: 128 },
      await aesKey(configuration.currentKey),
      new TextEncoder().encode(value),
    ),
  );
  const tagOffset = encrypted.byteLength - 16;
  const envelope: GuestNameEnvelope = {
    version: 1,
    keyVersion: configuration.currentKeyVersion,
    iv: base64FromBytes(iv),
    tag: base64FromBytes(encrypted.slice(tagOffset)),
    ciphertext: base64FromBytes(encrypted.slice(0, tagOffset)),
  };
  return JSON.stringify(envelope);
}

async function decryptGuestName(
  value: string,
  configuration: PiiConfiguration,
): Promise<string> {
  try {
    const envelope = JSON.parse(value) as GuestNameEnvelope;
    const selectedKey = envelope.keyVersion === configuration.currentKeyVersion
      ? configuration.currentKey
      : configuration.previousKeys[envelope.keyVersion];
    if (
      envelope.version !== 1 || !selectedKey ||
      typeof envelope.iv !== "string" || typeof envelope.tag !== "string" ||
      typeof envelope.ciphertext !== "string"
    ) {
      throw new Error("unsupported envelope");
    }
    const ciphertext = decodeBase64(envelope.ciphertext);
    const tag = decodeBase64(envelope.tag);
    if (tag.byteLength !== 16) throw new Error("invalid tag");
    const combined = new Uint8Array(ciphertext.byteLength + tag.byteLength);
    combined.set(ciphertext);
    combined.set(tag, ciphertext.byteLength);
    const decrypted = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: decodeBase64(envelope.iv),
        tagLength: 128,
      },
      await aesKey(selectedKey),
      combined,
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(decrypted);
  } catch (error) {
    if (error instanceof EdgeError) throw error;
    throw new EdgeError(
      500,
      "RESERVATION_PII_DECRYPT_FAILED",
      "예약 개인정보를 복호화하지 못했습니다.",
    );
  }
}

async function guestNameFingerprint(
  value: string | null,
  pepper: string,
): Promise<string | null> {
  if (value === null) return null;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const roomMoveConflictCodes = new Set([
  "RESERVATION_VERSION_CONFLICT",
  "SOURCE_ROOM_VERSION_CONFLICT",
  "TARGET_ROOM_VERSION_CONFLICT",
  "TARGET_ROOM_OVERLAP",
  "ROOM_CHANGE_PREVIEW_STALE",
  "CLEANING_ASSIGNMENT_LOCKED",
  "PIN_LEASE_ACTIVE",
  "TARGET_ROOM_BLOCKED",
  "TARGET_ROOM_NOT_READY",
  "OPEN_ENDED_STAY_REQUIRES_END",
  "DURING_STAY_NOT_SUPPORTED",
  "MOVE_ALREADY_APPLIED",
  "RESERVATION_ROOM_CHANGE_DEDICATED_COMMAND_REQUIRED",
]);

const roomMoveReloadResources = new Set<RoomMoveReloadResource>([
  "reservation",
  "sourceRoom",
  "targetRoom",
  "roomMovePreview",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function conflictVersion(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function roomMoveConflict(
  details: string | undefined,
): RoomMoveConflict | undefined {
  if (!details) return undefined;
  try {
    const value: unknown = JSON.parse(details);
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ["latestVersions", "reloadResources"])
    ) {
      return undefined;
    }
    const reloadResources = value.reloadResources;
    const latestVersions = value.latestVersions;
    if (
      !Array.isArray(reloadResources) ||
      reloadResources.length < 1 ||
      reloadResources.length > roomMoveReloadResources.size ||
      !reloadResources.every(
        (item): item is RoomMoveReloadResource =>
          typeof item === "string" &&
          roomMoveReloadResources.has(item as RoomMoveReloadResource),
      ) ||
      new Set(reloadResources).size !== reloadResources.length ||
      !isRecord(latestVersions) ||
      !hasExactKeys(latestVersions, [
        "reservationVersion",
        "sourceRoomVersion",
        "targetRoomVersion",
      ])
    ) {
      return undefined;
    }
    const reservationVersion = conflictVersion(
      latestVersions.reservationVersion,
    );
    const sourceRoomVersion = conflictVersion(latestVersions.sourceRoomVersion);
    const targetRoomVersion = conflictVersion(latestVersions.targetRoomVersion);
    if (
      reservationVersion === undefined ||
      sourceRoomVersion === undefined ||
      targetRoomVersion === undefined
    ) {
      return undefined;
    }
    return {
      reloadResources: [...reloadResources],
      latestVersions: {
        reservationVersion,
        sourceRoomVersion,
        targetRoomVersion,
      },
    };
  } catch {
    return undefined;
  }
}

function unknownRoomMoveConflict(): RoomMoveConflict {
  return {
    reloadResources: [
      "reservation",
      "sourceRoom",
      "targetRoom",
      "roomMovePreview",
    ],
    latestVersions: {
      reservationVersion: null,
      sourceRoomVersion: null,
      targetRoomVersion: null,
    },
  };
}

export function reservationDatabaseError(
  error: { code?: string; message?: string; details?: string } | null,
  roomMoveCommand = false,
): EdgeError {
  const message = error?.message ?? "";
  const mappings: Array<[string, number, string, string]> = [
    [
      "RESERVATION_VERSION_CONFLICT",
      409,
      "RESERVATION_VERSION_CONFLICT",
      "예약이 변경됐습니다. 다시 확인해 주세요.",
    ],
    [
      "SOURCE_ROOM_VERSION_CONFLICT",
      409,
      "SOURCE_ROOM_VERSION_CONFLICT",
      "출발 객실 상태가 변경됐습니다. 다시 확인해 주세요.",
    ],
    [
      "TARGET_ROOM_VERSION_CONFLICT",
      409,
      "TARGET_ROOM_VERSION_CONFLICT",
      "도착 객실 상태가 변경됐습니다. 다시 확인해 주세요.",
    ],
    [
      "TARGET_ROOM_OVERLAP",
      409,
      "TARGET_ROOM_OVERLAP",
      "도착 객실에 겹치는 예약이 있습니다.",
    ],
    [
      "DURING_STAY_NOT_SUPPORTED",
      409,
      "DURING_STAY_NOT_SUPPORTED",
      "투숙 중 객실 변경은 아직 지원하지 않습니다.",
    ],
    [
      "MOVE_ALREADY_APPLIED",
      409,
      "MOVE_ALREADY_APPLIED",
      "예약이 이미 해당 객실로 이동되었습니다.",
    ],
    [
      "ROOM_CHANGE_PREVIEW_STALE",
      409,
      "ROOM_CHANGE_PREVIEW_STALE",
      "객실 변경 미리보기가 만료되었거나 상태가 변경됐습니다.",
    ],
    [
      "CLEANING_ASSIGNMENT_LOCKED",
      409,
      "CLEANING_ASSIGNMENT_LOCKED",
      "청소 작업이 공개·배정·시작되어 객실을 변경할 수 없습니다.",
    ],
    [
      "PIN_LEASE_ACTIVE",
      409,
      "PIN_LEASE_ACTIVE",
      "활성 PIN 접근 권한이 있어 객실을 변경할 수 없습니다.",
    ],
    [
      "TARGET_ROOM_BLOCKED",
      409,
      "TARGET_ROOM_BLOCKED",
      "도착 객실이 운영상 차단되어 있습니다.",
    ],
    [
      "TARGET_ROOM_NOT_READY",
      409,
      "TARGET_ROOM_NOT_READY",
      "도착 객실이 아직 입실 가능한 상태가 아닙니다.",
    ],
    [
      "OPEN_ENDED_STAY_REQUIRES_END",
      409,
      "OPEN_ENDED_STAY_REQUIRES_END",
      "투숙 중 객실 이동에는 확정된 퇴실 시각이 필요합니다.",
    ],
    [
      "RESERVATION_ROOM_CHANGE_DEDICATED_COMMAND_REQUIRED",
      409,
      "RESERVATION_ROOM_CHANGE_DEDICATED_COMMAND_REQUIRED",
      "객실 변경 전용 미리보기와 확정 API를 사용해 주세요.",
    ],
    [
      "INVALID_ROOM_MOVE_REASON",
      400,
      "INVALID_ROOM_MOVE_REASON",
      "객실 변경 사유가 올바르지 않습니다.",
    ],
    [
      "INVALID_MOVE_EFFECTIVE_AT",
      400,
      "INVALID_MOVE_EFFECTIVE_AT",
      "객실 변경 적용 시각이 올바르지 않습니다.",
    ],
    [
      "ROOM_MOVE_PREVIEW_INVALID",
      400,
      "ROOM_MOVE_PREVIEW_INVALID",
      "객실 변경 미리보기 시각이 올바르지 않습니다.",
    ],
    [
      "STALE_VERSION",
      409,
      "STALE_VERSION",
      "다른 변경이 먼저 반영됐습니다. 최신 정보를 다시 확인해 주세요.",
    ],
    [
      "RESERVATION_OVERLAP",
      409,
      "RESERVATION_OVERLAP",
      "같은 객실의 활성 예약 시간이 겹칩니다.",
    ],
    [
      "ROOM_ALLOCATION_BLOCKED",
      409,
      "ROOM_ALLOCATION_BLOCKED",
      "현재 객실 차단 사유를 해소한 뒤 예약해 주세요.",
    ],
    [
      "IDEMPOTENCY_KEY_REUSED",
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "이미 다른 요청에 사용한 Idempotency-Key입니다.",
    ],
    ["ROOM_NOT_FOUND", 404, "ROOM_NOT_FOUND", "객실을 찾을 수 없습니다."],
    [
      "RESERVATION_NOT_FOUND",
      404,
      "RESERVATION_NOT_FOUND",
      "예약을 찾을 수 없습니다.",
    ],
    [
      "CLEANING_REQUEST_NOT_FOUND",
      404,
      "CLEANING_REQUEST_NOT_FOUND",
      "청소 요청을 찾을 수 없습니다.",
    ],
    [
      "CLEANING_TEMPLATE_NOT_CONFIGURED",
      409,
      "CLEANING_TEMPLATE_NOT_CONFIGURED",
      "해당 객실 유형의 청소 템플릿이 아직 없습니다.",
    ],
    [
      "INVALID_RESERVATION_SCHEDULE",
      400,
      "INVALID_RESERVATION_SCHEDULE",
      "예약은 분 단위이며 최소 1박이어야 합니다.",
    ],
    [
      "INVALID_GUEST_COUNT",
      400,
      "INVALID_GUEST_COUNT",
      "guestCount는 1 이상이어야 합니다.",
    ],
    [
      "INVALID_MANUAL_CLEANING_REQUEST",
      400,
      "INVALID_MANUAL_CLEANING_REQUEST",
      "수동 청소 요청의 종류와 시간 값을 확인해 주세요.",
    ],
    [
      "ACTIVE_STAY_RESERVATION_REQUIRED",
      409,
      "ACTIVE_STAY_RESERVATION_REQUIRED",
      "현재 투숙 중인 예약이 필요합니다.",
    ],
    [
      "STAYOVER_ACCESS_WINDOW_INVALID",
      409,
      "STAYOVER_ACCESS_WINDOW_INVALID",
      "연박 청소 접근 시간이 투숙 구간과 맞지 않습니다.",
    ],
    [
      "VACANT_ROOM_REQUIRED",
      409,
      "VACANT_ROOM_REQUIRED",
      "추가 청소는 공실에만 요청할 수 있습니다.",
    ],
    [
      "RESERVATION_ROOM_MISMATCH",
      409,
      "RESERVATION_ROOM_MISMATCH",
      "예약과 객실이 일치하지 않습니다.",
    ],
    [
      "NOT_MANUAL_CLEANING_REQUEST",
      409,
      "NOT_MANUAL_CLEANING_REQUEST",
      "수동 청소 요청만 취소할 수 있습니다.",
    ],
    [
      "REPLAN_REQUIRED",
      409,
      "REPLAN_REQUIRED",
      "기존 배정을 먼저 재계획해야 합니다.",
    ],
    [
      "SCHEDULE_LOCKED",
      409,
      "SCHEDULE_LOCKED",
      "이미 고정된 일정이 있어 변경할 수 없습니다.",
    ],
    [
      "INVALID_TRANSITION",
      409,
      "INVALID_TRANSITION",
      "현재 예약 상태에서는 요청한 변경을 할 수 없습니다.",
    ],
    [
      "NOT_ALLOWED",
      409,
      "INVALID_TRANSITION",
      "현재 예약 상태에서는 요청한 변경을 할 수 없습니다.",
    ],
    ["CONFLICT", 409, "CONFLICT", "현재 상태와 충돌하는 요청입니다."],
    [
      "ADMIN_REQUIRED",
      403,
      "FORBIDDEN",
      "현재 계정으로 예약 명령을 실행할 수 없습니다.",
    ],
    [
      "ACTIVE_ACCOUNT_REQUIRED",
      403,
      "FORBIDDEN",
      "현재 계정으로 예약 명령을 실행할 수 없습니다.",
    ],
  ];
  for (const [needle, status, code, userMessage] of mappings) {
    if (message.includes(needle)) {
      return new EdgeError(
        status,
        code,
        userMessage,
        {},
        status === 409 &&
          (roomMoveConflictCodes.has(code) ||
            (roomMoveCommand && code === "IDEMPOTENCY_KEY_REUSED"))
          ? roomMoveConflict(error?.details) ?? unknownRoomMoveConflict()
          : undefined,
      );
    }
  }
  if (error?.code === "23P01") {
    return new EdgeError(
      409,
      "RESERVATION_OVERLAP",
      "같은 객실의 활성 예약 시간이 겹칩니다.",
    );
  }
  return new EdgeError(
    500,
    "RESERVATION_COMMAND_FAILED",
    "예약 명령을 완료하지 못했습니다.",
  );
}

export function toReservation(row: ReservationRow) {
  return {
    id: row.id,
    roomId: row.room_id,
    checkInAt: row.check_in_at,
    checkOutAt: row.check_out_at,
    guestCount: row.guest_count,
    status: row.status,
    preparationObligationId: row.preparation_obligation_id,
    checkoutObligationId: row.checkout_obligation_id,
    version: row.version,
    actualCheckInAt: row.actual_check_in_at,
    actualCheckoutAt: row.actual_checkout_at,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.room_state_version !== undefined
      ? { roomStateVersion: row.room_state_version }
      : {}),
  };
}

export function toManualCleaningRequest(row: ManualCleaningRequestRow) {
  return {
    id: row.id,
    roomId: row.room_id,
    reservationId: row.reservation_id,
    cleaningKind: row.cleaning_kind,
    status: row.status,
    serviceDate: row.service_date,
    availableFrom: row.available_from,
    dueAt: row.due_at,
    version: row.version,
  };
}

export function reservationIdFromPath(
  path: string,
  action?: "cancel" | "manual-checkout",
): string {
  const suffix = action ? `/${action}` : "";
  const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = path.match(new RegExp(`^/v1/reservations/([^/]+)${escaped}$`));
  if (!match?.[1]) validationError("예약 경로가 올바르지 않습니다.");
  return uuidValue(match[1], "reservationId");
}

function strictTimestamp(value: string): boolean {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/,
  );
  if (!match) return false;
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    ,
    offsetHourText,
    offsetMinuteText,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined
    ? 0
    : Number(offsetMinuteText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 &&
    day <= days[month - 1] &&
    hour <= 23 && minute <= 59 && second <= 59 && offsetHour <= 23 &&
    offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value));
}

function roomMoveProjectionError(): never {
  throw new EdgeError(
    500,
    "RESERVATION_PROJECTION_INVALID",
    "예약 응답을 안전하게 확인하지 못했습니다.",
  );
}

function projectionRecord(value: unknown): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    roomMoveProjectionError();
  }
  return value as Record<string, unknown>;
}

function projectionString(value: unknown, pattern?: RegExp): string {
  if (typeof value !== "string" || (pattern && !pattern.test(value))) {
    roomMoveProjectionError();
  }
  return value;
}

function projectionTimestamp(value: unknown): string {
  const result = projectionString(value, timestampPattern);
  if (!strictTimestamp(result)) roomMoveProjectionError();
  return result;
}

function projectionPositiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    roomMoveProjectionError();
  }
  return value as number;
}

function projectionEnum(value: unknown, allowed: ReadonlySet<string>): string {
  if (typeof value !== "string" || !allowed.has(value)) {
    roomMoveProjectionError();
  }
  return value;
}

function projectionArray(
  value: unknown,
  allowed: ReadonlySet<string>,
): string[] {
  if (!Array.isArray(value)) roomMoveProjectionError();
  return value.map((item) => projectionEnum(item, allowed));
}

function roomMoveOutcome(value: unknown) {
  const row = projectionRecord(value);
  return {
    occupancyStatus: projectionEnum(
      row.occupancyStatus,
      new Set(["VACANT", "OCCUPIED"]),
    ),
    readinessStatus: projectionEnum(
      row.readinessStatus,
      new Set(["READY", "CLEANING_REQUIRED", "CHECKIN_BLOCKED"]),
    ),
    stateVersion: projectionPositiveInteger(row.stateVersion),
  };
}

function roomMovePreviewProjection(value: unknown) {
  const row = projectionRecord(value);
  if (
    typeof row.eligible !== "boolean" || !Array.isArray(row.warnings) ||
    row.warnings.length
  ) {
    roomMoveProjectionError();
  }
  return {
    mode: projectionEnum(row.mode, roomMoveModes),
    eligible: row.eligible,
    rejectionReasonCodes: projectionArray(
      row.rejectionReasonCodes,
      roomMoveRejections,
    ),
    blockingReasonCodes: projectionArray(
      row.blockingReasonCodes,
      roomMoveBlockingReasons,
    ),
    warnings: [],
    targetBlockReasonCodes: projectionArray(
      row.targetBlockReasonCodes,
      roomMoveTargetBlockReasons,
    ),
    sourceOutcome: roomMoveOutcome(row.sourceOutcome),
    targetOutcome: roomMoveOutcome(row.targetOutcome),
    impactFingerprint: projectionString(
      row.impactFingerprint,
      impactFingerprintPattern,
    ),
    evaluatedAt: projectionTimestamp(row.evaluatedAt),
    expiresAt: projectionTimestamp(row.expiresAt),
    effectiveAt: projectionTimestamp(row.effectiveAt),
    reservationId: projectionString(row.reservationId, uuidPattern),
    reservationVersion: projectionPositiveInteger(row.reservationVersion),
    stayId: projectionString(row.stayId, uuidPattern),
    stayVersion: projectionPositiveInteger(row.stayVersion),
    sourceSegmentId: projectionString(row.sourceSegmentId, uuidPattern),
    sourceSegmentVersion: projectionPositiveInteger(row.sourceSegmentVersion),
    sourceRoomId: projectionString(row.sourceRoomId, uuidPattern),
    sourceRoomVersion: projectionPositiveInteger(row.sourceRoomVersion),
    targetRoomId: projectionString(row.targetRoomId, uuidPattern),
    targetRoomVersion: projectionPositiveInteger(row.targetRoomVersion),
    checkInAt: projectionTimestamp(row.checkInAt),
    checkOutAt: projectionTimestamp(row.checkOutAt),
    guestCount: projectionPositiveInteger(row.guestCount),
    preparationObligationId: projectionString(
      row.preparationObligationId,
      uuidPattern,
    ),
    checkoutObligationId: projectionString(
      row.checkoutObligationId,
      uuidPattern,
    ),
    checkoutObligationVersion: projectionPositiveInteger(
      row.checkoutObligationVersion,
    ),
    plannedCheckoutTargetId: row.plannedCheckoutTargetId === null
      ? null
      : projectionString(row.plannedCheckoutTargetId, uuidPattern),
    plannedCheckoutTargetVersion: row.plannedCheckoutTargetVersion === null
      ? null
      : projectionPositiveInteger(row.plannedCheckoutTargetVersion),
  };
}

function roomMoveCommitProjection(value: unknown) {
  const row = projectionRecord(value);
  const reservation = projectionRecord(row.reservation);
  const nullableTimestamp = (item: unknown) =>
    item === null ? null : projectionTimestamp(item);
  const mode = projectionEnum(row.mode, roomMoveModes);
  const duringStayFields = [
    row.stay,
    row.segments,
    row.sourceCleaningTargetId,
    row.pinAccessEndsAt,
  ];
  if (
    mode === "BEFORE_CHECKIN" &&
    duringStayFields.some((item) => item !== undefined)
  ) {
    roomMoveProjectionError();
  }
  let duringStay: {
    stay?: { id: string; version: number; currentRoomId: string };
    segments?: Array<{
      id: string;
      roomId: string;
      startsAt: string;
      endsAt: string;
    }>;
    sourceCleaningTargetId?: string;
    pinAccessEndsAt?: string;
  } = {};
  if (mode === "DURING_STAY") {
    const stay = projectionRecord(row.stay);
    if (!Array.isArray(row.segments) || row.segments.length !== 2) {
      roomMoveProjectionError();
    }
    duringStay = {
      stay: {
        id: projectionString(stay.id, uuidPattern),
        version: projectionPositiveInteger(stay.version),
        currentRoomId: projectionString(stay.currentRoomId, uuidPattern),
      },
      segments: row.segments.map((item) => {
        const segment = projectionRecord(item);
        return {
          id: projectionString(segment.id, uuidPattern),
          roomId: projectionString(segment.roomId, uuidPattern),
          startsAt: projectionTimestamp(segment.startsAt),
          endsAt: projectionTimestamp(segment.endsAt),
        };
      }),
      sourceCleaningTargetId: projectionString(
        row.sourceCleaningTargetId,
        uuidPattern,
      ),
      pinAccessEndsAt: projectionTimestamp(row.pinAccessEndsAt),
    };
  }
  return {
    reservation: toReservation({
      id: projectionString(reservation.id, uuidPattern),
      room_id: projectionString(reservation.room_id, uuidPattern),
      check_in_at: projectionTimestamp(reservation.check_in_at),
      check_out_at: projectionTimestamp(reservation.check_out_at),
      guest_count: projectionPositiveInteger(reservation.guest_count),
      status: projectionEnum(
        reservation.status,
        new Set(["active", "cancelled", "checked_out"]),
      ) as ReservationStatus,
      preparation_obligation_id: projectionString(
        reservation.preparation_obligation_id,
        uuidPattern,
      ),
      checkout_obligation_id: projectionString(
        reservation.checkout_obligation_id,
        uuidPattern,
      ),
      version: projectionPositiveInteger(reservation.version),
      actual_check_in_at: nullableTimestamp(reservation.actual_check_in_at),
      actual_checkout_at: nullableTimestamp(reservation.actual_checkout_at),
      cancelled_at: nullableTimestamp(reservation.cancelled_at),
      created_at: projectionTimestamp(reservation.created_at),
      updated_at: projectionTimestamp(reservation.updated_at),
    }),
    mode,
    evaluatedAt: projectionTimestamp(row.evaluatedAt),
    expiresAt: projectionTimestamp(row.expiresAt),
    effectiveAt: projectionTimestamp(row.effectiveAt),
    movedAt: projectionTimestamp(row.movedAt),
    sourceRoomId: projectionString(row.sourceRoomId, uuidPattern),
    targetRoomId: projectionString(row.targetRoomId, uuidPattern),
    sourceRoomVersion: projectionPositiveInteger(row.sourceRoomVersion),
    targetRoomVersion: projectionPositiveInteger(row.targetRoomVersion),
    plannedCheckoutTargetId: projectionString(
      row.plannedCheckoutTargetId,
      uuidPattern,
    ),
    plannedCheckoutTargetVersion: projectionPositiveInteger(
      row.plannedCheckoutTargetVersion,
    ),
    sourceOutcome: roomMoveOutcome(row.sourceOutcome),
    targetOutcome: roomMoveOutcome(row.targetOutcome),
    ...duringStay,
  };
}

export function reservationRoomMoveIdFromPath(
  path: string,
  action: "preview" | "commit",
): string {
  const suffix = action === "preview" ? "/preview" : "";
  const match = path.match(
    new RegExp(`^/v1/reservations/([^/]+)/room-change${suffix}$`),
  );
  if (!match?.[1]) validationError("객실 변경 경로가 올바르지 않습니다.");
  return uuidValue(match[1], "reservationId");
}

export function cleaningTargetIdFromPath(path: string): string {
  const match = path.match(
    /^\/v1\/reservations\/cleaning-requests\/([^/]+)\/cancel$/,
  );
  if (!match?.[1]) validationError("청소 요청 경로가 올바르지 않습니다.");
  return uuidValue(match[1], "targetId");
}

export async function listReservations(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
) {
  requireReservationAdmin(actor);
  const search = queryValues(request, ["roomId"]);
  const roomId = search.get("roomId");
  const { data, error } = await clients.admin.rpc("list_reservations", {
    p_actor_profile_id: actor.profileId,
    p_room_id: roomId === null ? null : uuidValue(roomId, "roomId"),
  });
  if (error) throw reservationDatabaseError(error);
  return ((data ?? []) as ReservationRow[]).map(toReservation);
}

export async function getReservation(
  clients: EdgeClients,
  actor: EdgeActor,
  reservationId: string,
) {
  requireReservationAdmin(actor);
  const { data, error } = await clients.admin.rpc("get_reservation_detail", {
    p_actor_profile_id: actor.profileId,
    p_reservation_id: uuidValue(reservationId, "reservationId"),
  });
  if (error) throw reservationDatabaseError(error);
  const row = (data as ReservationRow[] | null)?.[0];
  if (!row) {
    throw new EdgeError(
      404,
      "RESERVATION_NOT_FOUND",
      "예약을 찾을 수 없습니다.",
    );
  }
  let guestName: string | null = null;
  if (row.guest_name_encrypted) {
    guestName = await decryptGuestName(
      row.guest_name_encrypted,
      piiConfiguration(),
    );
    await recordSensitiveReservationRead(clients, actor, row.id);
  }
  return { ...toReservation(row), guestName };
}

export async function createReservation(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
) {
  requireReservationAdmin(actor);
  const body = await readJsonBody(request);
  assertOnlyFields(body, [
    "roomId",
    "checkInAt",
    "checkOutAt",
    "guestCount",
    "guestName",
    "expectedRoomVersion",
  ]);
  const roomId = uuidValue(body.roomId, "roomId");
  const checkInAt = timestampValue(body.checkInAt, "checkInAt");
  const checkOutAt = timestampValue(body.checkOutAt, "checkOutAt");
  const guestCount = positiveInteger(body.guestCount, "guestCount");
  const expectedRoomVersion = positiveInteger(
    body.expectedRoomVersion,
    "expectedRoomVersion",
  );
  const guestName = body.guestName === undefined || body.guestName === null
    ? null
    : normalizeGuestName(body.guestName);
  const configuration = piiConfiguration();
  const { data, error } = await clients.admin.rpc("create_reservation", {
    p_actor_profile_id: actor.profileId,
    p_reservation_id: crypto.randomUUID(),
    p_room_id: roomId,
    p_check_in_at: checkInAt,
    p_check_out_at: checkOutAt,
    p_guest_count: guestCount,
    p_guest_name_encrypted: guestName
      ? await encryptGuestName(guestName, configuration)
      : null,
    p_expected_room_version: expectedRoomVersion,
    p_idempotency_key: idempotencyKey(request),
    p_request_hash: await requestHash({
      roomId,
      checkInAt,
      checkOutAt,
      guestCount,
      guestNameFingerprint: await guestNameFingerprint(
        guestName,
        configuration.guestNamePepper,
      ),
      expectedRoomVersion,
    }),
  });
  if (error || !data) throw reservationDatabaseError(error);
  return toReservation(data as ReservationRow);
}

export async function changeReservation(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  reservationId: string,
) {
  requireReservationAdmin(actor);
  const body = await readJsonBody(request);
  assertOnlyFields(body, [
    "roomId",
    "checkInAt",
    "checkOutAt",
    "guestCount",
    "guestName",
    "expectedVersion",
    "reasonCode",
  ]);
  const normalizedReservationId = uuidValue(reservationId, "reservationId");
  const roomId = uuidValue(body.roomId, "roomId");
  const checkInAt = timestampValue(body.checkInAt, "checkInAt");
  const checkOutAt = timestampValue(body.checkOutAt, "checkOutAt");
  const guestCount = positiveInteger(body.guestCount, "guestCount");
  const expectedVersion = positiveInteger(
    body.expectedVersion,
    "expectedVersion",
  );
  const reasonCode = reasonCodeValue(body.reasonCode);
  const hasGuestName = Object.hasOwn(body, "guestName");
  const guestName = !hasGuestName || body.guestName === null
    ? null
    : normalizeGuestName(body.guestName);
  const guestNameMode = !hasGuestName
    ? "keep"
    : guestName === null
    ? "clear"
    : "set";
  const configuration = piiConfiguration();
  const { data, error } = await clients.admin.rpc("change_reservation", {
    p_actor_profile_id: actor.profileId,
    p_reservation_id: normalizedReservationId,
    p_room_id: roomId,
    p_check_in_at: checkInAt,
    p_check_out_at: checkOutAt,
    p_guest_count: guestCount,
    p_guest_name_mode: guestNameMode,
    p_guest_name_encrypted: guestNameMode === "set" && guestName
      ? await encryptGuestName(guestName, configuration)
      : null,
    p_expected_version: expectedVersion,
    p_reason_code: reasonCode,
    p_idempotency_key: idempotencyKey(request),
    p_request_hash: await requestHash({
      reservationId: normalizedReservationId,
      roomId,
      checkInAt,
      checkOutAt,
      guestCount,
      guestNameMode,
      guestNameFingerprint: await guestNameFingerprint(
        guestName,
        configuration.guestNamePepper,
      ),
      expectedVersion,
      reasonCode,
    }),
  });
  if (error || !data) throw reservationDatabaseError(error);
  return toReservation(data as ReservationRow);
}

async function roomMovePreviewInput(request: Request) {
  const body = await readJsonBody(request);
  assertOnlyFields(body, [
    "targetRoomId",
    "effectiveAt",
    "reasonCode",
    "expectedReservationVersion",
    "expectedSourceRoomVersion",
    "expectedTargetRoomVersion",
  ]);
  return {
    targetRoomId: uuidValue(body.targetRoomId, "targetRoomId"),
    effectiveAt: body.effectiveAt === undefined
      ? null
      : timestampValue(body.effectiveAt, "effectiveAt"),
    reasonCode: typeof body.reasonCode === "string" &&
        roomMoveReasonCodes.has(body.reasonCode)
      ? body.reasonCode
      : validationError("reasonCode가 허용된 객실 변경 사유가 아닙니다."),
    expectedReservationVersion: positiveInteger(
      body.expectedReservationVersion,
      "expectedReservationVersion",
    ),
    expectedSourceRoomVersion: positiveInteger(
      body.expectedSourceRoomVersion,
      "expectedSourceRoomVersion",
    ),
    expectedTargetRoomVersion: positiveInteger(
      body.expectedTargetRoomVersion,
      "expectedTargetRoomVersion",
    ),
  };
}

export async function previewReservationRoomMove(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  reservationId: string,
) {
  requireReservationAdmin(actor);
  const normalizedReservationId = uuidValue(reservationId, "reservationId");
  const input = await roomMovePreviewInput(request);
  const { data, error } = await clients.admin.rpc(
    "preview_reservation_room_move",
    {
      p_actor_profile_id: actor.profileId,
      p_reservation_id: normalizedReservationId,
      p_target_room_id: input.targetRoomId,
      p_expected_reservation_version: input.expectedReservationVersion,
      p_expected_source_room_version: input.expectedSourceRoomVersion,
      p_expected_target_room_version: input.expectedTargetRoomVersion,
      p_effective_at: input.effectiveAt,
      p_reason_code: input.reasonCode,
    },
  );
  if (error || !data) throw reservationDatabaseError(error, true);
  return roomMovePreviewProjection(data);
}

export async function commitReservationRoomMove(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  reservationId: string,
) {
  requireReservationAdmin(actor);
  const normalizedReservationId = uuidValue(reservationId, "reservationId");
  const body = await readJsonBody(request);
  assertOnlyFields(body, [
    "targetRoomId",
    "expectedReservationVersion",
    "expectedSourceRoomVersion",
    "expectedTargetRoomVersion",
    "evaluatedAt",
    "expiresAt",
    "effectiveAt",
    "impactFingerprint",
    "reasonCode",
  ]);
  const targetRoomId = uuidValue(body.targetRoomId, "targetRoomId");
  const expectedReservationVersion = positiveInteger(
    body.expectedReservationVersion,
    "expectedReservationVersion",
  );
  const expectedSourceRoomVersion = positiveInteger(
    body.expectedSourceRoomVersion,
    "expectedSourceRoomVersion",
  );
  const expectedTargetRoomVersion = positiveInteger(
    body.expectedTargetRoomVersion,
    "expectedTargetRoomVersion",
  );
  const evaluatedAt = timestampValue(body.evaluatedAt, "evaluatedAt");
  const expiresAt = timestampValue(body.expiresAt, "expiresAt");
  const effectiveAt = timestampValue(body.effectiveAt, "effectiveAt");
  if (
    typeof body.impactFingerprint !== "string" ||
    !impactFingerprintPattern.test(body.impactFingerprint)
  ) {
    validationError("impactFingerprint가 올바르지 않습니다.");
  }
  if (
    typeof body.reasonCode !== "string" ||
    !roomMoveReasonCodes.has(body.reasonCode)
  ) {
    validationError("reasonCode가 허용된 객실 변경 사유가 아닙니다.");
  }
  const impactFingerprint = body.impactFingerprint;
  const reasonCode = body.reasonCode;
  const fingerprint = {
    reservationId: normalizedReservationId,
    targetRoomId,
    expectedReservationVersion,
    expectedSourceRoomVersion,
    expectedTargetRoomVersion,
    evaluatedAt,
    expiresAt,
    effectiveAt,
    impactFingerprint,
    reasonCode,
  };
  const { data, error } = await clients.admin.rpc(
    "commit_reservation_room_move",
    {
      p_actor_profile_id: actor.profileId,
      p_reservation_id: normalizedReservationId,
      p_target_room_id: targetRoomId,
      p_expected_reservation_version: expectedReservationVersion,
      p_expected_source_room_version: expectedSourceRoomVersion,
      p_expected_target_room_version: expectedTargetRoomVersion,
      p_preview_evaluated_at: evaluatedAt,
      p_preview_expires_at: expiresAt,
      p_effective_at: effectiveAt,
      p_impact_fingerprint: impactFingerprint,
      p_reason_code: reasonCode,
      p_idempotency_key: idempotencyKey(request),
      p_request_hash: await requestHash(fingerprint),
    },
  );
  if (error || !data) throw reservationDatabaseError(error, true);
  return roomMoveCommitProjection(data);
}

async function reservationMutationInput(request: Request) {
  const body = await readJsonBody(request);
  assertOnlyFields(body, ["expectedVersion", "reasonCode"]);
  return {
    expectedVersion: positiveInteger(body.expectedVersion, "expectedVersion"),
    reasonCode: reasonCodeValue(body.reasonCode),
  };
}

export async function cancelReservation(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  reservationId: string,
) {
  requireReservationAdmin(actor);
  const normalizedReservationId = uuidValue(reservationId, "reservationId");
  const input = await reservationMutationInput(request);
  const { data, error } = await clients.admin.rpc("cancel_reservation", {
    p_actor_profile_id: actor.profileId,
    p_reservation_id: normalizedReservationId,
    p_expected_version: input.expectedVersion,
    p_reason_code: input.reasonCode,
    p_idempotency_key: idempotencyKey(request),
    p_request_hash: await requestHash({
      command: "reservation.cancel",
      reservationId: normalizedReservationId,
      ...input,
    }),
  });
  if (error || !data) throw reservationDatabaseError(error);
  return toReservation(data as ReservationRow);
}

export async function manualCheckoutReservation(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  reservationId: string,
) {
  requireReservationAdmin(actor);
  const normalizedReservationId = uuidValue(reservationId, "reservationId");
  const input = await reservationMutationInput(request);
  const { data, error } = await clients.admin.rpc(
    "manual_checkout_reservation",
    {
      p_actor_profile_id: actor.profileId,
      p_reservation_id: normalizedReservationId,
      p_expected_version: input.expectedVersion,
      p_reason_code: input.reasonCode,
      p_effective_at: new Date().toISOString(),
      p_idempotency_key: idempotencyKey(request),
      p_request_hash: await requestHash({
        reservationId: normalizedReservationId,
        ...input,
      }),
    },
  );
  if (error || !data) throw reservationDatabaseError(error);
  return toReservation(data as ReservationRow);
}

export async function createManualCleaningRequest(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
) {
  requireReservationAdmin(actor);
  const body = await readJsonBody(request);
  assertOnlyFields(body, [
    "roomId",
    "reservationId",
    "cleaningKind",
    "serviceDate",
    "availableFrom",
    "dueAt",
    "expectedRoomVersion",
    "reasonCode",
  ]);
  if (body.cleaningKind !== "stayover" && body.cleaningKind !== "additional") {
    validationError("cleaningKind는 stayover 또는 additional이어야 합니다.");
  }
  const cleaningKind = body.cleaningKind as CleaningKind;
  const reservationId =
    body.reservationId === undefined || body.reservationId === null
      ? null
      : uuidValue(body.reservationId, "reservationId");
  if (cleaningKind === "stayover" && reservationId === null) {
    validationError("연박 청소 요청에는 reservationId가 필요합니다.");
  }
  const roomId = uuidValue(body.roomId, "roomId");
  const serviceDate = dateValue(body.serviceDate, "serviceDate");
  const availableFrom = timestampValue(body.availableFrom, "availableFrom");
  const dueAt = body.dueAt === undefined || body.dueAt === null
    ? null
    : timestampValue(body.dueAt, "dueAt");
  const expectedRoomVersion = positiveInteger(
    body.expectedRoomVersion,
    "expectedRoomVersion",
  );
  const reasonCode = reasonCodeValue(body.reasonCode);
  const { data, error } = await clients.admin.rpc(
    "create_manual_cleaning_request",
    {
      p_actor_profile_id: actor.profileId,
      p_target_id: crypto.randomUUID(),
      p_room_id: roomId,
      p_reservation_id: reservationId,
      p_cleaning_kind: cleaningKind,
      p_service_date: serviceDate,
      p_available_from: availableFrom,
      p_due_at: dueAt,
      p_expected_room_version: expectedRoomVersion,
      p_reason_code: reasonCode,
      p_idempotency_key: idempotencyKey(request),
      p_request_hash: await requestHash({
        roomId,
        reservationId,
        cleaningKind,
        serviceDate,
        availableFrom,
        dueAt,
        expectedRoomVersion,
        reasonCode,
      }),
    },
  );
  if (error || !data) throw reservationDatabaseError(error);
  return toManualCleaningRequest(data as ManualCleaningRequestRow);
}

export async function cancelManualCleaningRequest(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  targetId: string,
) {
  requireReservationAdmin(actor);
  const normalizedTargetId = uuidValue(targetId, "targetId");
  const input = await reservationMutationInput(request);
  const { data, error } = await clients.admin.rpc(
    "cancel_manual_cleaning_request",
    {
      p_actor_profile_id: actor.profileId,
      p_target_id: normalizedTargetId,
      p_expected_version: input.expectedVersion,
      p_reason_code: input.reasonCode,
      p_idempotency_key: idempotencyKey(request),
      p_request_hash: await requestHash({
        targetId: normalizedTargetId,
        ...input,
      }),
    },
  );
  if (error || !data) throw reservationDatabaseError(error);
  return toManualCleaningRequest(data as ManualCleaningRequestRow);
}

export async function processReservationTransitions(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
) {
  requireReservationAdmin(actor);
  const { data, error } = await clients.admin.rpc(
    "process_due_reservation_transitions",
    {
      p_actor_profile_id: actor.profileId,
      p_as_of: new Date().toISOString(),
      p_idempotency_key: manualTransitionIdempotencyKey(request),
      p_request_hash: await requestHash({
        command: "reservation.process_due_transitions",
      }),
    },
  );
  if (error || !data) throw reservationDatabaseError(error);
  const row = data as {
    as_of: string;
    checked_in_count: number;
    checked_out_count: number;
    blocked_check_in_count: number;
    purged_guest_name_count: number;
  };
  return {
    asOf: row.as_of,
    checkedInCount: row.checked_in_count,
    checkedOutCount: row.checked_out_count,
    blockedCheckInCount: row.blocked_check_in_count,
    purgedGuestNameCount: row.purged_guest_name_count,
  };
}
