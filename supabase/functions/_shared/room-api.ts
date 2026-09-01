import { idempotencyKey, readJsonBody } from "./account-api.ts";
import type { EdgeActor, EdgeClients } from "./runtime.ts";
import {
  EdgeError,
  requireBusinessAdmin,
  requirePasswordChanged,
} from "./runtime.ts";

export type RoomReasonCode =
  | "OCCUPIED"
  | "CLEANING_REQUIRED"
  | "CANDLE_PRESENT"
  | "OPERATION_BLOCKED"
  | "ROOM_ISSUE_BLOCKED"
  | "PIN_MISMATCH"
  | "DATA_UNCONFIRMED";

interface RoomProjectionRow {
  id: string;
  room_number: string;
  room_type_code: string;
  room_type_name: string;
  elevator_zone: "A" | "B" | "C" | null;
  data_status: "verified" | "verification_required";
  state_version: number;
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
      "STALE_VERSION",
      409,
      "STALE_VERSION",
      "다른 객실 변경이 먼저 반영됐습니다.",
    ],
    [
      "IDEMPOTENCY_KEY_REUSED",
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "이미 다른 요청에 사용한 Idempotency-Key입니다.",
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
    /^\/v1\/rooms\/([^/]+)\/(?:master-data|operation-blocks|candles|issues|pin-sync-events)$/,
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
