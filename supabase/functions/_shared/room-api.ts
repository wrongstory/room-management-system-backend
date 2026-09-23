import { idempotencyKey, readJsonBody } from "./account-api.ts";
import {
  assertRoomOperationResponseSize,
  decodeRoomOperationCursor,
  encodeRoomOperationCursor,
  ROOM_OPERATION_CURSOR_MAX_LENGTH,
  ROOM_OPERATION_PAGE_DEFAULT,
  ROOM_OPERATION_PAGE_MAX,
  roomOperationCursorScope,
} from "./room-operation-cursor.ts";
import type { EdgeActor, EdgeClients } from "./runtime.ts";
import {
  EdgeError,
  requireBusinessAdmin,
  requirePasswordChanged,
  verifiedRequestSessionId,
} from "./runtime.ts";

export type RoomReasonCode =
  | "OCCUPIED"
  | "RESERVATION_CURRENT"
  | "CLEANING_REQUIRED"
  | "CANDLE_PRESENT"
  | "OPERATION_BLOCKED"
  | "ROOM_ISSUE_BLOCKED"
  | "DATA_UNCONFIRMED";

export type RoomReservationPhase = "none" | "upcoming" | "current";
export type RoomOccupancyStatus = "VACANT" | "OCCUPIED";
export type RoomReservationLifecycle =
  | "NONE"
  | "FUTURE"
  | "RESERVATION_PRESENT"
  | "ARRIVAL_PENDING"
  | "OCCUPIED";
export type RoomReadinessStatus =
  | "READY"
  | "CLEANING_REQUIRED"
  | "CHECKIN_BLOCKED";
export type RoomPrimaryDisplayStatus =
  | "BLOCKED"
  | "OCCUPIED"
  | "ARRIVAL_PENDING"
  | "RESERVATION_PRESENT"
  | "CLEANING_REQUIRED"
  | "READY";
export type RoomBlockingReasonCode =
  | "CANDLE_PRESENT"
  | "OPERATION_BLOCKED"
  | "ROOM_ISSUE_BLOCKED"
  | "DATA_UNCONFIRMED";
export type RoomReadinessReasonCode =
  | RoomBlockingReasonCode
  | "CLEANING_REQUIRED"
  | "PIN_MISMATCH"
  | "PIN_UNCONFIGURED";

interface RoomProjectionRow {
  id: string;
  room_number: string;
  room_type_code: string;
  room_type_name: string;
  elevator_zone: "A" | "B" | "C" | null;
  data_status: "verified" | "verification_required";
  state_version: number;
  evaluated_at: string;
  reservation_phase: RoomReservationPhase;
  server_time: string;
  occupancy_status: RoomOccupancyStatus;
  reservation_lifecycle: RoomReservationLifecycle;
  readiness_status: RoomReadinessStatus;
  primary_display_status: RoomPrimaryDisplayStatus;
  canonical_primary_display_status: RoomPrimaryDisplayStatus;
  display_status_override: RoomPrimaryDisplayStatus | null;
  next_reservation_id: string | null;
  next_check_in_at: string | null;
  next_check_out_at: string | null;
  blocking_reason_codes: RoomBlockingReasonCode[];
  readiness_reason_codes: RoomReadinessReasonCode[];
  occupied: boolean;
  cleaning_required: boolean;
  candle_count: number;
  pin_sync_status: "verified" | "mismatch" | "unconfigured";
  allocation_blocked: boolean;
  allocation_ready: boolean;
  reason_codes: RoomReasonCode[];
}

export interface RoomProjection {
  id: string;
  roomNumber: string;
  roomTypeCode: string;
  roomTypeName: string;
  elevatorZone: "A" | "B" | "C" | null;
  dataStatus: "verified" | "verification_required";
  stateVersion: number;
  evaluatedAt: string;
  reservationPhase: RoomReservationPhase;
  serverTime: string;
  occupancyStatus: RoomOccupancyStatus;
  reservationLifecycle: RoomReservationLifecycle;
  readinessStatus: RoomReadinessStatus;
  primaryDisplayStatus: RoomPrimaryDisplayStatus;
  canonicalPrimaryDisplayStatus: RoomPrimaryDisplayStatus;
  displayStatusOverride: RoomPrimaryDisplayStatus | null;
  nextReservationId: string | null;
  nextCheckInAt: string | null;
  nextCheckOutAt: string | null;
  blockingReasonCodes: RoomBlockingReasonCode[];
  readinessReasonCodes: RoomReadinessReasonCode[];
  occupied: boolean;
  cleaningRequired: boolean;
  candleCount: number;
  pinSyncStatus: "verified" | "mismatch" | "unconfigured";
  allocationBlocked: boolean;
  allocationReady: boolean;
  reasonCodes: RoomReasonCode[];
}

/** DB RPC의 snake_case row를 Fastify와 동일한 프론트 공개 계약으로 변환한다. */
export function toRoomProjection(row: RoomProjectionRow): RoomProjection {
  return {
    id: row.id,
    roomNumber: row.room_number,
    roomTypeCode: row.room_type_code,
    roomTypeName: row.room_type_name,
    elevatorZone: row.elevator_zone,
    dataStatus: row.data_status,
    stateVersion: row.state_version,
    evaluatedAt: row.evaluated_at,
    reservationPhase: row.reservation_phase,
    serverTime: row.server_time,
    occupancyStatus: row.occupancy_status,
    reservationLifecycle: row.reservation_lifecycle,
    readinessStatus: row.readiness_status,
    primaryDisplayStatus: row.primary_display_status,
    canonicalPrimaryDisplayStatus: row.canonical_primary_display_status,
    displayStatusOverride: row.display_status_override,
    nextReservationId: row.next_reservation_id,
    nextCheckInAt: row.next_check_in_at,
    nextCheckOutAt: row.next_check_out_at,
    blockingReasonCodes: row.blocking_reason_codes,
    readinessReasonCodes: row.readiness_reason_codes,
    occupied: row.occupied,
    cleaningRequired: row.cleaning_required,
    candleCount: row.candle_count,
    pinSyncStatus: row.pin_sync_status,
    allocationBlocked: row.allocation_blocked,
    allocationReady: row.allocation_ready,
    reasonCodes: row.reason_codes,
  };
}

export function toRoomProjections(value: unknown): RoomProjection[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return (value as RoomProjectionRow[]).map(toRoomProjection);
}

export type RoomOperationAction =
  | "create_block"
  | "release_block"
  | "set_candle_count"
  | "report_issue"
  | "resolve_issue"
  | "record_pin_sync";

interface RoomOperationRow {
  entity_id: string;
  room_id: string;
  room_state_version: number;
  recorded_at: string;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const reasonCodePattern = /^[A-Z0-9_]{2,80}$/;
const timestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const forbiddenPinFields = new Set([
  "pin",
  "rawPin",
  "pinCode",
  "doorCode",
  "credential",
  "providerSecret",
]);

function validationError(message: string): never {
  throw new EdgeError(400, "VALIDATION_ERROR", message);
}

function requireRoomAdmin(actor: EdgeActor): void {
  requirePasswordChanged(actor);
  requireBusinessAdmin(actor);
}

function assertOnlyFields(
  body: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const keys = Object.keys(body);
  if (keys.some((key) => forbiddenPinFields.has(key))) {
    throw new EdgeError(
      400,
      "PIN_MATERIAL_NOT_ALLOWED",
      "객실 PIN 원문이나 인증정보는 이 API로 전달할 수 없습니다.",
    );
  }
  if (keys.some((key) => !allowed.includes(key))) {
    validationError("허용되지 않은 요청 필드가 있습니다.");
  }
}

function uuidValue(value: unknown, name: string): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    validationError(`${name}에 UUID가 필요합니다.`);
  }
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    validationError(`${name}은 1 이상의 정수여야 합니다.`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    validationError(`${name}은 0 이상의 정수여야 합니다.`);
  }
  return value as number;
}

function responseTimestamp(value: unknown, name: string): string {
  if (
    typeof value !== "string" || !timestampPattern.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new EdgeError(
      500,
      "ROOM_PROJECTION_INVALID",
      `객실 운영 조회 결과의 ${name} 형식이 올바르지 않습니다.`,
    );
  }
  return value;
}

function responseText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new EdgeError(
      500,
      "ROOM_PROJECTION_INVALID",
      `객실 운영 조회 결과의 ${name} 형식이 올바르지 않습니다.`,
    );
  }
  return value;
}

function reasonCodeValue(value: unknown): string {
  if (typeof value !== "string") validationError("reasonCode가 필요합니다.");
  const normalized = value.trim();
  if (!reasonCodePattern.test(normalized)) {
    validationError(
      "reasonCode는 2~80자의 영문 대문자, 숫자, 밑줄만 사용할 수 있습니다.",
    );
  }
  return normalized;
}

function nullableText(
  body: Record<string, unknown>,
  name: string,
  minimum: number,
  maximum: number,
): string | null | undefined {
  if (!Object.hasOwn(body, name)) return undefined;
  const value = body[name];
  if (value === null) return null;
  if (typeof value !== "string") {
    validationError(`${name} 형식이 올바르지 않습니다.`);
  }
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    validationError(`${name} 길이가 허용 범위를 벗어났습니다.`);
  }
  return normalized;
}

function optionalTimestamp(
  body: Record<string, unknown>,
  name: string,
  nullable: boolean,
): string | null | undefined {
  if (!Object.hasOwn(body, name)) return undefined;
  const value = body[name];
  if (nullable && value === null) return null;
  if (
    typeof value !== "string" || !timestampPattern.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    validationError(`${name}은 offset이 포함된 RFC 3339 시각이어야 합니다.`);
  }
  return value;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
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
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function roomDatabaseError(
  error: { message?: string } | null,
): EdgeError {
  const message = error?.message ?? "";
  const mappings: Array<[string, number, string, string]> = [
    [
      "ROOM_OPERATION_PAGE_LIMIT_INVALID",
      400,
      "ROOM_OPERATION_PAGE_LIMIT_INVALID",
      "객실 운영 page 크기가 올바르지 않습니다.",
    ],
    [
      "INVALID_ROOM_OPERATION_CURSOR",
      400,
      "INVALID_ROOM_OPERATION_CURSOR",
      "객실 운영 cursor가 올바르지 않습니다.",
    ],
    [
      "CHECKOUT_INCIDENT_OPEN",
      409,
      "CHECKOUT_INCIDENT_OPEN",
      "퇴실 미진행 사건을 관리자가 처리한 뒤 PIN 작업을 진행해 주세요.",
    ],
    [
      "STALE_VERSION",
      409,
      "STALE_VERSION",
      "다른 객실 변경이 먼저 반영됐습니다.",
    ],
    [
      "OCCUPANCY_CORRECTION_ALREADY_APPLIED",
      409,
      "OCCUPANCY_CORRECTION_ALREADY_APPLIED",
      "이미 요청한 점유 상태가 반영되어 있습니다.",
    ],
    [
      "OCCUPANCY_CORRECTION_ROOM_MISMATCH",
      409,
      "OCCUPANCY_CORRECTION_ROOM_MISMATCH",
      "해당 시각의 투숙 객실과 요청 객실이 일치하지 않습니다.",
    ],
    [
      "ROOM_OCCUPANCY_CONFLICT",
      409,
      "ROOM_OCCUPANCY_CONFLICT",
      "해당 시간에는 다른 예약이 객실을 점유하고 있습니다.",
    ],
    [
      "OCCUPANCY_CORRECTION_NOT_ALLOWED",
      409,
      "OCCUPANCY_CORRECTION_NOT_ALLOWED",
      "현재 예약 상태에서는 점유 상태를 보정할 수 없습니다.",
    ],
    [
      "INVALID_OCCUPANCY_CORRECTION",
      400,
      "INVALID_OCCUPANCY_CORRECTION",
      "점유 보정 요청이 올바르지 않습니다.",
    ],
    [
      "DISPLAY_STATUS_OVERRIDE_ALREADY_APPLIED",
      409,
      "DISPLAY_STATUS_OVERRIDE_ALREADY_APPLIED",
      "이미 요청한 표시 상태가 적용되어 있습니다.",
    ],
    [
      "INVALID_DISPLAY_STATUS_OVERRIDE",
      400,
      "INVALID_DISPLAY_STATUS_OVERRIDE",
      "표시 상태 보정 요청이 올바르지 않습니다.",
    ],
    [
      "RESERVATION_NOT_FOUND",
      404,
      "RESERVATION_NOT_FOUND",
      "예약을 찾을 수 없습니다.",
    ],
    [
      "STAY_SEGMENT_CONTRACT_MISMATCH",
      409,
      "STAY_SEGMENT_CONTRACT_MISMATCH",
      "예약의 투숙 구간 정보가 현재 상태와 일치하지 않습니다.",
    ],
    [
      "IDEMPOTENCY_KEY_REUSED",
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "이미 다른 요청에 사용한 Idempotency-Key입니다.",
    ],
    [
      "STALE_PIN_VERSION",
      409,
      "STALE_PIN_VERSION",
      "다른 PIN 변경이 먼저 반영됐습니다.",
    ],
    [
      "ROOM_NUMBER_CHANGED",
      409,
      "ROOM_NUMBER_CHANGED",
      "객실 번호가 변경되어 PIN 준비 요청을 다시 시작해야 합니다.",
    ],
    [
      "INVALID_PIN_BOOTSTRAP_LIMIT",
      400,
      "INVALID_PIN_BOOTSTRAP_LIMIT",
      "초기화 batch 크기는 1~25여야 합니다.",
    ],
    [
      "INVALID_PIN_BOOTSTRAP",
      400,
      "INVALID_PIN_BOOTSTRAP",
      "객실 초기 PIN 요청이 올바르지 않습니다.",
    ],
    [
      "ROOM_PIN_REISSUE_REQUIRED",
      409,
      "ROOM_PIN_REISSUE_REQUIRED",
      "객실 번호 변경 전 PIN 재발급 절차가 필요합니다.",
    ],
    [
      "ROOM_PIN_MISMATCH_UNRESOLVED",
      409,
      "ROOM_PIN_MISMATCH_UNRESOLVED",
      "물리 도어락과 저장 상태의 불일치를 먼저 해소해 주세요.",
    ],
    [
      "INVALID_PIN_CHANGE_REASON",
      409,
      "INVALID_PIN_CHANGE_REASON",
      "현재 PIN 상태와 변경 사유가 일치하지 않습니다.",
    ],
    [
      "PIN_CHANGE_IN_PROGRESS_REQUIRED",
      403,
      "PIN_CHANGE_IN_PROGRESS_REQUIRED",
      "PIN 변경은 현재 청소가 진행 중일 때만 가능합니다.",
    ],
    [
      "PIN_CHANGE_IN_PROGRESS",
      409,
      "PIN_CHANGE_IN_PROGRESS",
      "이 객실의 PIN 변경 절차가 이미 진행 중입니다.",
    ],
    [
      "PIN_CHANGE_LEASE_EXPIRED",
      409,
      "PIN_CHANGE_LEASE_EXPIRED",
      "PIN 변경 확인 시간이 만료되었습니다.",
    ],
    [
      "PIN_CHANGE_LEASE_NOT_PREPARED",
      409,
      "PIN_CHANGE_LEASE_NOT_RESOLVABLE",
      "현재 PIN 변경 절차를 확인하거나 해소할 수 없습니다.",
    ],
    [
      "PIN_CHANGE_LEASE_NOT_RESOLVABLE",
      409,
      "PIN_CHANGE_LEASE_NOT_RESOLVABLE",
      "현재 PIN 변경 절차를 확인하거나 해소할 수 없습니다.",
    ],
    [
      "PIN_REVEAL_AUTHORIZATION_CHANGED",
      403,
      "PIN_REVEAL_AUTHORIZATION_CHANGED",
      "PIN 응답 전 권한 또는 업무 상태가 변경되었습니다.",
    ],
    [
      "PIN_ENTITLEMENT_REQUIRED",
      403,
      "PIN_ENTITLEMENT_REQUIRED",
      "현재 통보된 배정의 PIN 열람 권한이 필요합니다.",
    ],
    [
      "GENERATED_PIN_REVEAL_NOT_ALLOWED",
      409,
      "GENERATED_PIN_REVEAL_NOT_ALLOWED",
      "생성된 PIN의 초기 열람 가능 상태가 아닙니다.",
    ],
    [
      "GENERATED_PIN_CONFIRMATION_NOT_ALLOWED",
      409,
      "GENERATED_PIN_CONFIRMATION_NOT_ALLOWED",
      "생성된 PIN을 물리 도어락에 확인할 수 있는 상태가 아닙니다.",
    ],
    [
      "PIN_ACCESS_LEASE_REQUIRED",
      403,
      "PIN_ACCESS_LEASE_REQUIRED",
      "현재 업무의 유효한 PIN 접근 권한이 필요합니다.",
    ],
    [
      "PIN_ACCESS_REQUIRED",
      403,
      "PIN_ACCESS_REQUIRED",
      "현재 업무 상태에서는 객실 PIN에 접근할 수 없습니다.",
    ],
    ["SESSION_REVOKED", 401, "SESSION_REVOKED", "로그인이 만료되었습니다."],
    [
      "ROOM_PIN_UNCONFIGURED",
      404,
      "ROOM_PIN_UNCONFIGURED",
      "등록된 객실 PIN이 없습니다.",
    ],
    ["ROOM_NOT_FOUND", 404, "ROOM_NOT_FOUND", "객실을 찾을 수 없습니다."],
    [
      "ROOM_BLOCK_NOT_FOUND",
      404,
      "ROOM_OPERATION_NOT_FOUND",
      "객실 운영 기록을 찾을 수 없습니다.",
    ],
    [
      "ROOM_ISSUE_NOT_FOUND",
      404,
      "ROOM_OPERATION_NOT_FOUND",
      "객실 운영 기록을 찾을 수 없습니다.",
    ],
    [
      "ADMIN_REQUIRED",
      403,
      "FORBIDDEN",
      "현재 계정으로 객실을 변경할 수 없습니다.",
    ],
    [
      "ACTIVE_ACCOUNT_REQUIRED",
      403,
      "FORBIDDEN",
      "현재 계정으로 객실을 변경할 수 없습니다.",
    ],
  ];
  for (const [needle, status, code, userMessage] of mappings) {
    if (message.includes(needle)) {
      return new EdgeError(status, code, userMessage);
    }
  }
  if (
    message.includes("ALREADY_") || message.includes("INVALID_") ||
    message.includes("ACTIVE_ROOM_TYPE_REQUIRED") ||
    message.includes("DATA_STATUS_REASON_REQUIRED") ||
    message.includes("UNKNOWN_ROOM_OPERATION")
  ) {
    return new EdgeError(
      409,
      "INVALID_TRANSITION",
      "현재 객실 운영 상태에서는 요청을 처리할 수 없습니다.",
    );
  }
  return new EdgeError(
    500,
    "ROOM_COMMAND_FAILED",
    "객실 정보를 처리하지 못했습니다.",
  );
}

function operationResult(value: unknown) {
  const row = value as RoomOperationRow | null;
  if (!row?.entity_id || !row.room_id || !row.recorded_at) {
    throw new EdgeError(
      500,
      "ROOM_COMMAND_FAILED",
      "객실 정보를 처리하지 못했습니다.",
    );
  }
  return {
    entityId: row.entity_id,
    roomId: row.room_id,
    roomStateVersion: row.room_state_version,
    recordedAt: row.recorded_at,
  };
}

export function roomPathIds(path: string): {
  roomId: string;
  blockId?: string;
  issueId?: string;
} {
  const patterns = [
    /^\/v1\/rooms\/([^/]+)\/operation-blocks\/([^/]+)\/release$/,
    /^\/v1\/rooms\/([^/]+)\/issues\/([^/]+)\/resolve$/,
    /^\/v1\/rooms\/([^/]+)\/(?:master-data|operation-blocks|occupancy-corrections|display-status-overrides|candles|issues|pin-sync-events)$/,
  ];
  const match = patterns[0].exec(path);
  if (match) {
    return {
      roomId: uuidValue(match[1], "roomId"),
      blockId: uuidValue(match[2], "blockId"),
    };
  }
  const issueMatch = patterns[1].exec(path);
  if (issueMatch) {
    return {
      roomId: uuidValue(issueMatch[1], "roomId"),
      issueId: uuidValue(issueMatch[2], "issueId"),
    };
  }
  const roomMatch = patterns[2].exec(path);
  if (roomMatch) return { roomId: uuidValue(roomMatch[1], "roomId") };
  validationError("객실 경로가 올바르지 않습니다.");
}

/** GET 객실 상세는 하위 mutation 경로를 alias로 수용하지 않는다. */
export function roomDetailIdFromPath(path: string): string | null {
  const match = /^\/v1\/rooms\/([^/]+)$/.exec(path);
  return match ? uuidValue(match[1], "roomId") : null;
}

export async function listRooms(clients: EdgeClients, actor: EdgeActor) {
  requireRoomAdmin(actor);
  const { data, error } = await clients.admin.rpc(
    "get_room_operational_projection",
    {
      p_actor_profile_id: actor.profileId,
      p_room_id: null,
    },
  );
  if (error) throw roomDatabaseError(error);
  return toRoomProjections(data);
}

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    validationError(`${name}은 boolean이어야 합니다.`);
  }
  return value;
}

export async function listRoomTypes(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
) {
  requireRoomAdmin(actor);
  const { data, error } = await clients.admin.rpc(
    "list_room_type_catalog",
    {
      p_actor_profile_id: actor.profileId,
      p_session_id: verifiedRequestSessionId(request),
    },
  );
  if (error) throw roomDatabaseError(error);
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: uuidValue(row.id, "id"),
    code: String(row.code),
    displayName: String(row.display_name),
    baseCleaningFee: nonNegativeInteger(
      row.base_cleaning_fee,
      "baseCleaningFee",
    ),
    baseOccupancy: positiveInteger(row.base_occupancy, "baseOccupancy"),
    maxOccupancy: positiveInteger(row.max_occupancy, "maxOccupancy"),
    active: booleanValue(row.active, "active"),
    version: positiveInteger(row.version, "version"),
    roomCount: nonNegativeInteger(row.room_count, "roomCount"),
  }));
}

async function roomOperationPageInput(
  request: Request,
  scope: ReturnType<typeof roomOperationCursorScope>,
  expectedStatus: "actionable" | "open",
) {
  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) {
    if (
      !["status", "limit", "cursor"].includes(key) ||
      params.getAll(key).length !== 1
    ) {
      throw new EdgeError(
        400,
        "INVALID_ROOM_OPERATION_QUERY",
        "객실 운영 조회 조건이 올바르지 않습니다.",
      );
    }
  }
  const status = params.get("status") ?? expectedStatus;
  if (status !== expectedStatus) {
    throw new EdgeError(
      400,
      "INVALID_ROOM_OPERATION_QUERY",
      "객실 운영 조회 조건이 올바르지 않습니다.",
    );
  }
  const rawLimit = params.get("limit") ?? String(ROOM_OPERATION_PAGE_DEFAULT);
  if (!/^[1-9]\d*$/.test(rawLimit)) {
    throw new EdgeError(
      400,
      "ROOM_OPERATION_PAGE_LIMIT_INVALID",
      "객실 운영 page 크기가 올바르지 않습니다.",
    );
  }
  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit > ROOM_OPERATION_PAGE_MAX) {
    throw new EdgeError(
      400,
      "ROOM_OPERATION_PAGE_LIMIT_INVALID",
      "객실 운영 page 크기가 올바르지 않습니다.",
    );
  }
  const rawCursor = params.get("cursor");
  if (
    rawCursor !== null &&
    (rawCursor.length < 1 ||
      rawCursor.length > ROOM_OPERATION_CURSOR_MAX_LENGTH)
  ) {
    throw new EdgeError(
      400,
      "INVALID_ROOM_OPERATION_CURSOR",
      "객실 운영 cursor가 올바르지 않습니다.",
    );
  }
  return {
    limit,
    cursor: rawCursor === null
      ? null
      : await decodeRoomOperationCursor(rawCursor, scope),
  };
}

function roomOperationNextCursor(value: unknown, hasMore: unknown) {
  if (typeof hasMore !== "boolean") {
    throw new EdgeError(
      500,
      "ROOM_PROJECTION_INVALID",
      "객실 운영 조회 결과가 올바르지 않습니다.",
    );
  }
  if (!hasMore) {
    if (value !== null) {
      throw new EdgeError(
        500,
        "ROOM_PROJECTION_INVALID",
        "객실 운영 cursor 결과가 올바르지 않습니다.",
      );
    }
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new EdgeError(
      500,
      "ROOM_PROJECTION_INVALID",
      "객실 운영 cursor 결과가 올바르지 않습니다.",
    );
  }
  const row = value as Record<string, unknown>;
  return {
    occurredAt: responseTimestamp(row.occurredAt, "occurredAt"),
    id: uuidValue(row.id, "id"),
  };
}

export async function listRoomOperationBlocks(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  roomId: string,
) {
  requireRoomAdmin(actor);
  const normalizedRoomId = uuidValue(roomId, "roomId");
  const scope = roomOperationCursorScope(
    actor,
    normalizedRoomId,
    "operation-blocks",
  );
  const input = await roomOperationPageInput(request, scope, "actionable");
  const { data, error } = await clients.admin.rpc(
    "list_room_operation_blocks_page",
    {
      p_actor_profile_id: actor.profileId,
      p_session_id: verifiedRequestSessionId(request),
      p_room_id: normalizedRoomId,
      p_status: "actionable",
      p_limit: input.limit,
      p_cursor_at: input.cursor?.occurredAt ?? null,
      p_cursor_id: input.cursor?.id ?? null,
    },
  );
  if (error) throw roomDatabaseError(error);
  const value = data as Record<string, unknown>;
  if (!value || !Array.isArray(value.items)) {
    throw new EdgeError(
      500,
      "ROOM_PROJECTION_INVALID",
      "객실 운영 차단 조회 결과가 올바르지 않습니다.",
    );
  }
  const next = roomOperationNextCursor(value.nextCursor, value.hasMore);
  const result = {
    roomId: uuidValue(value.roomId, "roomId"),
    roomStateVersion: positiveInteger(
      value.roomStateVersion,
      "roomStateVersion",
    ),
    evaluatedAt: responseTimestamp(value.evaluatedAt, "evaluatedAt"),
    items: value.items.map((item) => {
      const row = item as Record<string, unknown>;
      const status = responseText(row.status, "status");
      if (!["scheduled", "active", "expired"].includes(status)) {
        throw new EdgeError(
          500,
          "ROOM_PROJECTION_INVALID",
          "객실 운영 차단 상태가 올바르지 않습니다.",
        );
      }
      return {
        id: uuidValue(row.id, "id"),
        reasonCode: responseText(row.reasonCode, "reasonCode"),
        startsAt: responseTimestamp(row.startsAt, "startsAt"),
        endsAt: row.endsAt === null
          ? null
          : responseTimestamp(row.endsAt, "endsAt"),
        status,
        createdAt: responseTimestamp(row.createdAt, "createdAt"),
      };
    }),
    hasMore: value.hasMore,
    nextCursor: next === null
      ? null
      : await encodeRoomOperationCursor(scope, next),
  };
  assertRoomOperationResponseSize(result);
  return result;
}

export async function listRoomIssues(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  roomId: string,
) {
  requireRoomAdmin(actor);
  const normalizedRoomId = uuidValue(roomId, "roomId");
  const scope = roomOperationCursorScope(actor, normalizedRoomId, "issues");
  const input = await roomOperationPageInput(request, scope, "open");
  const { data, error } = await clients.admin.rpc("list_room_issues_page", {
    p_actor_profile_id: actor.profileId,
    p_session_id: verifiedRequestSessionId(request),
    p_room_id: normalizedRoomId,
    p_status: "open",
    p_limit: input.limit,
    p_cursor_at: input.cursor?.occurredAt ?? null,
    p_cursor_id: input.cursor?.id ?? null,
  });
  if (error) throw roomDatabaseError(error);
  const value = data as Record<string, unknown>;
  if (!value || !Array.isArray(value.items)) {
    throw new EdgeError(
      500,
      "ROOM_PROJECTION_INVALID",
      "객실 이슈 조회 결과가 올바르지 않습니다.",
    );
  }
  const next = roomOperationNextCursor(value.nextCursor, value.hasMore);
  const result = {
    roomId: uuidValue(value.roomId, "roomId"),
    roomStateVersion: positiveInteger(
      value.roomStateVersion,
      "roomStateVersion",
    ),
    evaluatedAt: responseTimestamp(value.evaluatedAt, "evaluatedAt"),
    items: value.items.map((item) => {
      const row = item as Record<string, unknown>;
      const severity = responseText(row.severity, "severity");
      if (!["info", "warning", "critical"].includes(severity)) {
        throw new EdgeError(
          500,
          "ROOM_PROJECTION_INVALID",
          "객실 이슈 중요도가 올바르지 않습니다.",
        );
      }
      if (
        row.status !== "open" || typeof row.blocksGuestAssignment !== "boolean"
      ) {
        throw new EdgeError(
          500,
          "ROOM_PROJECTION_INVALID",
          "객실 이슈 상태가 올바르지 않습니다.",
        );
      }
      return {
        id: uuidValue(row.id, "id"),
        category: responseText(row.category, "category"),
        severity,
        blocksGuestAssignment: row.blocksGuestAssignment,
        description: row.description === null
          ? null
          : responseText(row.description, "description"),
        status: "open",
        reportedAt: responseTimestamp(row.reportedAt, "reportedAt"),
      };
    }),
    hasMore: value.hasMore,
    nextCursor: next === null
      ? null
      : await encodeRoomOperationCursor(scope, next),
  };
  assertRoomOperationResponseSize(result);
  return result;
}

const roomCommandSummaryFields = new Set([
  "roomTypeId",
  "elevatorZone",
  "dataStatus",
  "stateVersion",
  "blockId",
  "startsAt",
  "endsAt",
  "active",
  "candleEventId",
  "count",
  "issueId",
  "category",
  "severity",
  "blocksGuestAssignment",
  "status",
  "pinSyncEventId",
  "syncStatus",
  "pinVersion",
]);
const occupancySummaryFields = new Set(["occupiedBefore", "occupiedAfter"]);
const roomEventCategoryByType = new Map<string, string>([
  ["room.master_data_changed", "room_configuration"],
  ["room.create_block", "room_block"],
  ["room.release_block", "room_block"],
  ["room.set_candle_count", "room_candle"],
  ["room.report_issue", "room_issue"],
  ["room.resolve_issue", "room_issue"],
  ["room.record_pin_sync", "room_pin"],
  ["room.pin_change_prepared", "room_pin"],
  ["room.pin_change_confirmed", "room_pin"],
  ["room.pin_mismatch_resolved", "room_pin"],
  ["scheduled_check_in", "occupancy"],
  ["manual_checkout", "occupancy"],
  ["scheduled_checkout", "occupancy"],
  ["occupancy_resumed", "occupancy"],
  ["occupancy_correction", "occupancy"],
]);

function safeRoomEventSummary(
  value: unknown,
  source: "room_command" | "occupancy",
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new EdgeError(
      500,
      "ROOM_PROJECTION_INVALID",
      "객실 이벤트 요약 형식이 올바르지 않습니다.",
    );
  }
  const allowed = source === "room_command"
    ? roomCommandSummaryFields
    : occupancySummaryFields;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([key]) =>
      allowed.has(key)
    ),
  );
}

export async function listRoomEvents(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  roomId: string,
  limit: number,
) {
  requireRoomAdmin(actor);
  const normalizedRoomId = uuidValue(roomId, "roomId");
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    validationError("limit은 1~50의 정수여야 합니다.");
  }
  const { data, error } = await clients.admin.rpc("list_room_events", {
    p_actor_profile_id: actor.profileId,
    p_session_id: verifiedRequestSessionId(request),
    p_room_id: normalizedRoomId,
    p_limit: limit,
  });
  if (error) throw roomDatabaseError(error);
  const value = data as Record<string, unknown>;
  if (!value || !Array.isArray(value.items)) {
    throw new EdgeError(
      500,
      "ROOM_PROJECTION_INVALID",
      "객실 이벤트 조회 결과가 올바르지 않습니다.",
    );
  }
  return {
    roomId: uuidValue(value.roomId, "roomId"),
    roomStateVersion: positiveInteger(
      value.roomStateVersion,
      "roomStateVersion",
    ),
    evaluatedAt: responseTimestamp(value.evaluatedAt, "evaluatedAt"),
    items: value.items.map((item) => {
      const row = item as Record<string, unknown>;
      const source = responseText(row.source, "source");
      if (source !== "room_command" && source !== "occupancy") {
        throw new EdgeError(
          500,
          "ROOM_PROJECTION_INVALID",
          "객실 이벤트 source가 올바르지 않습니다.",
        );
      }
      const id = uuidValue(row.id, "id");
      const eventType = responseText(row.eventType, "eventType");
      const category = responseText(row.category, "category");
      if (
        roomEventCategoryByType.get(eventType) !== category ||
        row.eventKey !== `${source}:${id}`
      ) {
        throw new EdgeError(
          500,
          "ROOM_PROJECTION_INVALID",
          "객실 이벤트 식별자 또는 분류가 올바르지 않습니다.",
        );
      }
      return {
        id,
        eventKey: responseText(row.eventKey, "eventKey"),
        source,
        category,
        eventType,
        actorProfileId: row.actorProfileId === null
          ? null
          : uuidValue(row.actorProfileId, "actorProfileId"),
        actorDisplayName: row.actorDisplayName === null
          ? null
          : responseText(row.actorDisplayName, "actorDisplayName"),
        entityId: uuidValue(row.entityId, "entityId"),
        reasonCode: row.reasonCode === null
          ? null
          : responseText(row.reasonCode, "reasonCode"),
        effectiveAt: responseTimestamp(row.effectiveAt, "effectiveAt"),
        recordedAt: responseTimestamp(row.recordedAt, "recordedAt"),
        reservationId: row.reservationId === null
          ? null
          : uuidValue(row.reservationId, "reservationId"),
        summary: safeRoomEventSummary(row.summary, source),
      };
    }),
  };
}

export async function getRoom(
  clients: EdgeClients,
  actor: EdgeActor,
  roomId: string,
) {
  requireRoomAdmin(actor);
  const normalizedRoomId = uuidValue(roomId, "roomId");
  const { data, error } = await clients.admin.rpc(
    "get_room_operational_projection",
    {
      p_actor_profile_id: actor.profileId,
      p_room_id: normalizedRoomId,
    },
  );
  if (error) throw roomDatabaseError(error);
  const room = toRoomProjections(data)[0];
  if (!room) {
    throw new EdgeError(404, "ROOM_NOT_FOUND", "객실을 찾을 수 없습니다.");
  }
  return room;
}

export async function changeRoomMasterData(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  roomId: string,
) {
  requireRoomAdmin(actor);
  const normalizedRoomId = uuidValue(roomId, "roomId");
  const body = await readJsonBody(request);
  assertOnlyFields(body, [
    "roomTypeId",
    "elevatorZone",
    "dataStatus",
    "dataStatusReason",
    "expectedVersion",
    "reasonCode",
  ]);
  const roomTypeId = uuidValue(body.roomTypeId, "roomTypeId");
  if (
    body.elevatorZone !== null &&
    !["A", "B", "C"].includes(body.elevatorZone as string)
  ) {
    validationError("elevatorZone은 A, B, C 또는 null이어야 합니다.");
  }
  if (
    body.dataStatus !== "verified" &&
    body.dataStatus !== "verification_required"
  ) {
    validationError("dataStatus가 올바르지 않습니다.");
  }
  const dataStatusReason = nullableText(body, "dataStatusReason", 2, 200);
  const expectedVersion = positiveInteger(
    body.expectedVersion,
    "expectedVersion",
  );
  const reasonCode = reasonCodeValue(body.reasonCode);
  const fingerprint = {
    roomId: normalizedRoomId,
    roomTypeId,
    elevatorZone: body.elevatorZone as "A" | "B" | "C" | null,
    dataStatus: body.dataStatus,
    dataStatusReason: dataStatusReason ?? null,
    expectedVersion,
    reasonCode,
  };
  const { error } = await clients.admin.rpc("change_room_master_data", {
    p_actor_profile_id: actor.profileId,
    p_room_id: normalizedRoomId,
    p_room_type_id: roomTypeId,
    p_elevator_zone: body.elevatorZone,
    p_data_status: body.dataStatus,
    p_data_status_reason: dataStatusReason ?? null,
    p_expected_version: expectedVersion,
    p_reason_code: reasonCode,
    p_idempotency_key: idempotencyKey(request),
    p_request_hash: await requestHash(fingerprint),
  });
  if (error) throw roomDatabaseError(error);
  return getRoom(clients, actor, normalizedRoomId);
}

export async function correctRoomOccupancy(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  roomId: string,
) {
  requireRoomAdmin(actor);
  const normalizedRoomId = uuidValue(roomId, "roomId");
  const body = await readJsonBody(request);
  assertOnlyFields(body, [
    "reservationId",
    "occupied",
    "effectiveAt",
    "expectedRoomVersion",
    "reasonCode",
  ]);
  const reservationId = uuidValue(body.reservationId, "reservationId");
  const occupied = booleanValue(body.occupied, "occupied");
  const effectiveAt = optionalTimestamp(body, "effectiveAt", false);
  if (!effectiveAt) validationError("effectiveAt이 필요합니다.");
  const expectedRoomVersion = positiveInteger(
    body.expectedRoomVersion,
    "expectedRoomVersion",
  );
  const reasonCode = reasonCodeValue(body.reasonCode);
  const fingerprint = {
    roomId: normalizedRoomId,
    reservationId,
    occupied,
    effectiveAt,
    expectedRoomVersion,
    reasonCode,
  };
  const { data, error } = await clients.admin.rpc("correct_room_occupancy", {
    p_actor_profile_id: actor.profileId,
    p_session_id: verifiedRequestSessionId(request),
    p_room_id: normalizedRoomId,
    p_reservation_id: reservationId,
    p_occupied: occupied,
    p_effective_at: effectiveAt,
    p_expected_room_version: expectedRoomVersion,
    p_reason_code: reasonCode,
    p_idempotency_key: idempotencyKey(request),
    p_request_hash: await requestHash(fingerprint),
  });
  if (error || !data) throw roomDatabaseError(error);
  const row = data as Record<string, unknown>;
  return {
    correctionId: uuidValue(row.correction_id, "correctionId"),
    roomId: uuidValue(row.room_id, "roomId"),
    reservationId: uuidValue(row.reservation_id, "reservationId"),
    occupied: booleanValue(row.occupied, "occupied"),
    effectiveAt: responseTimestamp(row.effective_at, "effectiveAt"),
    roomStateVersion: positiveInteger(
      row.room_state_version,
      "roomStateVersion",
    ),
    recordedAt: responseTimestamp(row.recorded_at, "recordedAt"),
  };
}

export async function overrideRoomDisplayStatus(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  roomId: string,
) {
  requireRoomAdmin(actor);
  const normalizedRoomId = uuidValue(roomId, "roomId");
  const body = await readJsonBody(request);
  assertOnlyFields(body, [
    "targetStatus",
    "expectedRoomVersion",
    "reasonCode",
  ]);
  const allowedStatuses = new Set<RoomPrimaryDisplayStatus>([
    "BLOCKED",
    "OCCUPIED",
    "ARRIVAL_PENDING",
    "RESERVATION_PRESENT",
    "CLEANING_REQUIRED",
    "READY",
  ]);
  if (
    body.targetStatus !== null &&
    (typeof body.targetStatus !== "string" ||
      !allowedStatuses.has(body.targetStatus as RoomPrimaryDisplayStatus))
  ) {
    validationError("targetStatus가 올바르지 않습니다.");
  }
  const targetStatus = body.targetStatus as RoomPrimaryDisplayStatus | null;
  const expectedRoomVersion = positiveInteger(
    body.expectedRoomVersion,
    "expectedRoomVersion",
  );
  const reasonCode = reasonCodeValue(body.reasonCode);
  const fingerprint = {
    roomId: normalizedRoomId,
    targetStatus,
    expectedRoomVersion,
    reasonCode,
  };
  const { data, error } = await clients.admin.rpc(
    "override_room_display_status",
    {
      p_actor_profile_id: actor.profileId,
      p_session_id: verifiedRequestSessionId(request),
      p_room_id: normalizedRoomId,
      p_target_status: targetStatus,
      p_expected_room_version: expectedRoomVersion,
      p_reason_code: reasonCode,
      p_idempotency_key: idempotencyKey(request),
      p_request_hash: await requestHash(fingerprint),
    },
  );
  if (error || !data) throw roomDatabaseError(error);
  const row = data as Record<string, unknown>;
  return {
    overrideId: uuidValue(row.override_id, "overrideId"),
    roomId: uuidValue(row.room_id, "roomId"),
    targetStatus: row.target_status as RoomPrimaryDisplayStatus | null,
    roomStateVersion: positiveInteger(
      row.room_state_version,
      "roomStateVersion",
    ),
    recordedAt: responseTimestamp(row.recorded_at, "recordedAt"),
  };
}

async function mutateRoomOperation(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  roomId: string,
  action: RoomOperationAction,
  input: {
    expectedRoomVersion: number;
    reasonCode: string;
    payload: Record<string, unknown>;
  },
) {
  const normalizedRoomId = uuidValue(roomId, "roomId");
  const payload = {
    ...input.payload,
    entityId: (input.payload.entityId as string | undefined) ??
      crypto.randomUUID(),
  };
  const { data, error } = await clients.admin.rpc("mutate_room_operation", {
    p_actor_profile_id: actor.profileId,
    p_room_id: normalizedRoomId,
    p_action: action,
    p_expected_room_version: input.expectedRoomVersion,
    p_reason_code: input.reasonCode,
    p_payload: payload,
    p_idempotency_key: idempotencyKey(request),
    p_request_hash: await requestHash({
      roomId: normalizedRoomId,
      action,
      expectedRoomVersion: input.expectedRoomVersion,
      reasonCode: input.reasonCode,
      payload: input.payload,
    }),
  });
  if (error || !data) throw roomDatabaseError(error);
  return operationResult(data);
}

async function operationDecisionBody(request: Request) {
  const body = await readJsonBody(request);
  assertOnlyFields(body, ["expectedRoomVersion", "reasonCode"]);
  return {
    expectedRoomVersion: positiveInteger(
      body.expectedRoomVersion,
      "expectedRoomVersion",
    ),
    reasonCode: reasonCodeValue(body.reasonCode),
  };
}

export async function createRoomOperationBlock(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  roomId: string,
) {
  requireRoomAdmin(actor);
  const body = await readJsonBody(request);
  assertOnlyFields(body, [
    "expectedRoomVersion",
    "reasonCode",
    "startsAt",
    "endsAt",
  ]);
  return mutateRoomOperation(request, clients, actor, roomId, "create_block", {
    expectedRoomVersion: positiveInteger(
      body.expectedRoomVersion,
      "expectedRoomVersion",
    ),
    reasonCode: reasonCodeValue(body.reasonCode),
    payload: {
      startsAt: optionalTimestamp(body, "startsAt", false),
      endsAt: optionalTimestamp(body, "endsAt", true),
    },
  });
}

export async function releaseRoomOperationBlock(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  roomId: string,
  blockId: string,
) {
  requireRoomAdmin(actor);
  const input = await operationDecisionBody(request);
  return mutateRoomOperation(request, clients, actor, roomId, "release_block", {
    ...input,
    payload: { entityId: uuidValue(blockId, "blockId") },
  });
}

export async function setRoomCandleCount(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  roomId: string,
) {
  requireRoomAdmin(actor);
  const body = await readJsonBody(request);
  assertOnlyFields(body, [
    "expectedRoomVersion",
    "reasonCode",
    "count",
    "physicallyVerified",
  ]);
  if (
    body.physicallyVerified !== undefined &&
    typeof body.physicallyVerified !== "boolean"
  ) {
    validationError("physicallyVerified는 boolean이어야 합니다.");
  }
  return mutateRoomOperation(
    request,
    clients,
    actor,
    roomId,
    "set_candle_count",
    {
      expectedRoomVersion: positiveInteger(
        body.expectedRoomVersion,
        "expectedRoomVersion",
      ),
      reasonCode: reasonCodeValue(body.reasonCode),
      payload: {
        count: nonNegativeInteger(body.count, "count"),
        physicallyVerified: body.physicallyVerified ?? false,
      },
    },
  );
}

export function assertNoContactInformation(value: string | undefined): void {
  if (!value) return;
  const containsEmail = /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/.test(value);
  const containsPhone = /(?:\+?82[-.\s]?)?0?1[016789][-.\s]?\d{3,4}[-.\s]?\d{4}/
    .test(value);
  if (containsEmail || containsPhone) {
    throw new EdgeError(
      400,
      "SENSITIVE_TEXT_NOT_ALLOWED",
      "특이사항에는 전화번호나 이메일을 입력할 수 없습니다.",
    );
  }
}

export async function reportRoomIssue(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  roomId: string,
) {
  requireRoomAdmin(actor);
  const body = await readJsonBody(request);
  assertOnlyFields(body, [
    "expectedRoomVersion",
    "reasonCode",
    "category",
    "severity",
    "blocksGuestAssignment",
    "description",
  ]);
  const category = reasonCodeValue(body.category);
  if (!["info", "warning", "critical"].includes(body.severity as string)) {
    validationError("severity가 올바르지 않습니다.");
  }
  if (typeof body.blocksGuestAssignment !== "boolean") {
    validationError("blocksGuestAssignment는 boolean이어야 합니다.");
  }
  const description = nullableText(body, "description", 0, 500);
  if (description === null) {
    validationError("description은 null일 수 없습니다.");
  }
  assertNoContactInformation(description);
  return mutateRoomOperation(request, clients, actor, roomId, "report_issue", {
    expectedRoomVersion: positiveInteger(
      body.expectedRoomVersion,
      "expectedRoomVersion",
    ),
    reasonCode: reasonCodeValue(body.reasonCode),
    payload: {
      category,
      severity: body.severity,
      blocksGuestAssignment: body.blocksGuestAssignment,
      description,
    },
  });
}

export async function resolveRoomIssue(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  roomId: string,
  issueId: string,
) {
  requireRoomAdmin(actor);
  const input = await operationDecisionBody(request);
  return mutateRoomOperation(request, clients, actor, roomId, "resolve_issue", {
    ...input,
    payload: { entityId: uuidValue(issueId, "issueId") },
  });
}

export async function recordRoomPinSync(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  roomId: string,
) {
  requireRoomAdmin(actor);
  const body = await readJsonBody(request);
  assertOnlyFields(body, [
    "expectedRoomVersion",
    "reasonCode",
    "syncStatus",
    "pinVersion",
  ]);
  if (
    !["verified", "mismatch", "unconfigured"].includes(
      body.syncStatus as string,
    )
  ) validationError("syncStatus가 올바르지 않습니다.");
  const pinVersion =
    !Object.hasOwn(body, "pinVersion") || body.pinVersion === null
      ? body.pinVersion as null | undefined
      : positiveInteger(body.pinVersion, "pinVersion");
  return mutateRoomOperation(
    request,
    clients,
    actor,
    roomId,
    "record_pin_sync",
    {
      expectedRoomVersion: positiveInteger(
        body.expectedRoomVersion,
        "expectedRoomVersion",
      ),
      reasonCode: reasonCodeValue(body.reasonCode),
      payload: { syncStatus: body.syncStatus, pinVersion },
    },
  );
}
