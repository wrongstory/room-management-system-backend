/** #532: shared, dependency-free HTTP/RPC boundary for an explicit room-ready correction. */
export const ROOM_READY_TARGET = "READY" as const;
export const ROOM_READY_REASON = "ADMIN_ROOM_READY_CORRECTION" as const;
export const ROOM_READY_PREVIEW_TTL_MS = 300_000;
export const ROOM_READY_MAX_EFFECTS = 100;
export const ROOM_READY_BLOCKING_REASONS = [
  "ROOM_INACTIVE",
  "ROOM_TYPE_INACTIVE",
  "DATA_UNCONFIRMED",
  "OCCUPIED",
  "RESERVATION_CURRENT",
  "CHECKOUT_NOT_COMPLETED",
  "UNSUPPORTED_CLEANING_CHAIN",
  "PHOTO_UPLOAD_IN_PROGRESS",
  "ASSIGNMENT_CHANGE_PENDING",
  "LIMIT_EXCEEDED",
] as const;
export const ROOM_READY_WARNINGS = [
  "CANCEL_WITHOUT_NEW_EARNINGS",
  "APPROVE_BEFORE_CANCEL_TO_PRESERVE_EARNINGS",
  "PHYSICAL_CANDLE_REMOVAL_REQUIRED",
] as const;

export interface RoomReadyPreviewRequest {
  targetStatus: typeof ROOM_READY_TARGET;
  reasonCode: typeof ROOM_READY_REASON;
}
export interface RoomReadyCorrectionRequest extends RoomReadyPreviewRequest {
  expectedRoomVersion: number;
  impactFingerprint: string;
  evaluatedAt: string;
  expiresAt: string;
  confirmed: true;
  acknowledgeNoNewEarnings: boolean;
  confirmPhysicalCandleRemoval: boolean;
}
export interface RoomReadyCleaningEffect {
  cleaningTargetId: string;
  assignmentId: string | null;
  attemptId: string | null;
  attemptStatus: string | null;
  hasSubmission: boolean;
  fieldCompleted: boolean;
}
export interface RoomReadyPreview {
  roomId: string;
  targetStatus: typeof ROOM_READY_TARGET;
  roomStateVersion: number;
  canApply: boolean;
  blockingReasons: string[];
  requiresConfirmation: true;
  requiresEarningAcknowledgement: boolean;
  effects: {
    cleaningTargets: RoomReadyCleaningEffect[];
    operationBlockIds: string[];
    roomIssueIds: string[];
    candleCount: number;
    displayStatusOverride: string | null;
  };
  warnings: string[];
  impactFingerprint: string;
  evaluatedAt: string;
  expiresAt: string;
}
export interface RoomReadyCorrectionResult {
  roomId: string;
  targetStatus: typeof ROOM_READY_TARGET;
  roomStateVersion: number;
  recordedAt: string;
  cancelledCleaningTargetIds: string[];
  releasedOperationBlockIds: string[];
  resolvedRoomIssueIds: string[];
  candlesCleared: boolean;
}

export class RoomReadyContractError extends Error {
  constructor(public readonly response: boolean) {
    super(
      response
        ? "객실 상태 변경 응답을 확인하지 못했습니다."
        : "객실 상태 변경 입력이 올바르지 않습니다.",
    );
    this.name = "RoomReadyContractError";
  }
}
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const shaPattern = /^[0-9a-f]{64}$/;
export function roomReadyUuid(value: unknown, response = false): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new RoomReadyContractError(response);
  }
  return value.toLowerCase();
}
function object(value: unknown, response: boolean): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RoomReadyContractError(response);
  }
  return value as Record<string, unknown>;
}
function onlyKeys(row: Record<string, unknown>, keys: string[]): void {
  if (
    Object.keys(row).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(row, key))
  ) throw new RoomReadyContractError(false);
}
function positive(value: unknown, response: boolean): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new RoomReadyContractError(response);
  }
  return value;
}
function bool(value: unknown, response: boolean): boolean {
  if (typeof value !== "boolean") throw new RoomReadyContractError(response);
  return value;
}
export function roomReadyTimestamp(value: unknown, response = false): string {
  if (typeof value !== "string") throw new RoomReadyContractError(response);
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-](\d{2}):(\d{2}))$/
      .exec(value);
  if (!match) throw new RoomReadyContractError(response);
  const year = Number(match[1]),
    month = Number(match[2]),
    day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days =
    [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ??
      0;
  if (
    year < 1 || month < 1 || month > 12 || day < 1 || day > days ||
    Number(match[4]) > 23 ||
    Number(match[5]) > 59 || Number(match[6]) > 59 ||
    Number(match[9] ?? 0) > 23 ||
    Number(match[10] ?? 0) > 59 || !Number.isFinite(Date.parse(value))
  ) throw new RoomReadyContractError(response);
  return value;
}
function proof(row: Record<string, unknown>, response: boolean) {
  const evaluatedAt = roomReadyTimestamp(row.evaluatedAt, response);
  const expiresAt = roomReadyTimestamp(row.expiresAt, response);
  const microseconds = (value: string) =>
    (/\.(\d{1,6})/.exec(value)?.[1] ?? "").padEnd(6, "0").slice(3);
  if (
    typeof row.impactFingerprint !== "string" ||
    !shaPattern.test(row.impactFingerprint) ||
    Date.parse(expiresAt) - Date.parse(evaluatedAt) !==
      ROOM_READY_PREVIEW_TTL_MS ||
    microseconds(expiresAt) !== microseconds(evaluatedAt)
  ) throw new RoomReadyContractError(response);
  // Do not reject an old proof by client clock: the DB must replay a committed receipt before checking TTL.
  return { impactFingerprint: row.impactFingerprint, evaluatedAt, expiresAt };
}
export function parseRoomReadyPreviewRequest(
  value: unknown,
): RoomReadyPreviewRequest {
  const row = object(value, false);
  onlyKeys(row, ["targetStatus", "reasonCode"]);
  if (
    row.targetStatus !== ROOM_READY_TARGET ||
    row.reasonCode !== ROOM_READY_REASON
  ) throw new RoomReadyContractError(false);
  return { targetStatus: ROOM_READY_TARGET, reasonCode: ROOM_READY_REASON };
}
export function parseRoomReadyCorrectionRequest(
  value: unknown,
): RoomReadyCorrectionRequest {
  const row = object(value, false);
  onlyKeys(row, [
    "targetStatus",
    "reasonCode",
    "expectedRoomVersion",
    "impactFingerprint",
    "evaluatedAt",
    "expiresAt",
    "confirmed",
    "acknowledgeNoNewEarnings",
    "confirmPhysicalCandleRemoval",
  ]);
  const base = parseRoomReadyPreviewRequest({
    targetStatus: row.targetStatus,
    reasonCode: row.reasonCode,
  });
  if (row.confirmed !== true) throw new RoomReadyContractError(false);
  return {
    ...base,
    expectedRoomVersion: positive(row.expectedRoomVersion, false),
    ...proof(row, false),
    confirmed: true,
    acknowledgeNoNewEarnings: bool(row.acknowledgeNoNewEarnings, false),
    confirmPhysicalCandleRemoval: bool(row.confirmPhysicalCandleRemoval, false),
  };
}
function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > ROOM_READY_MAX_EFFECTS) {
    throw new RoomReadyContractError(true);
  }
  const result = value.map((id) => roomReadyUuid(id, true));
  if (new Set(result).size !== result.length) {
    throw new RoomReadyContractError(true);
  }
  return result;
}
function codes(value: unknown, allowed: readonly string[]): string[] {
  if (
    !Array.isArray(value) || value.length > allowed.length ||
    value.some((code) => typeof code !== "string" || !allowed.includes(code)) ||
    new Set(value).size !== value.length
  ) throw new RoomReadyContractError(true);
  return [...value] as string[];
}
function resultIdentity(row: Record<string, unknown>, expectedRoomId: string) {
  const roomId = roomReadyUuid(row.roomId, true);
  if (
    roomId !== roomReadyUuid(expectedRoomId, true) ||
    row.targetStatus !== ROOM_READY_TARGET
  ) throw new RoomReadyContractError(true);
  return {
    roomId,
    targetStatus: ROOM_READY_TARGET,
    roomStateVersion: positive(row.roomStateVersion, true),
  };
}
export function parseRoomReadyPreview(
  value: unknown,
  expectedRoomId: string,
): RoomReadyPreview {
  const row = object(value, true), effects = object(row.effects, true);
  const canApply = bool(row.canApply, true),
    blockingReasons = codes(row.blockingReasons, ROOM_READY_BLOCKING_REASONS);
  if (
    row.requiresConfirmation !== true ||
    canApply !== (blockingReasons.length === 0) ||
    !Array.isArray(effects.cleaningTargets) ||
    effects.cleaningTargets.length > ROOM_READY_MAX_EFFECTS
  ) throw new RoomReadyContractError(true);
  const cleaningTargets = effects.cleaningTargets.map((value) => {
    const target = object(value, true);
    const attemptId = target.attemptId === null
      ? null
      : roomReadyUuid(target.attemptId, true);
    if (
      target.attemptStatus !== null &&
      (typeof target.attemptStatus !== "string" ||
        ![
          "scheduled",
          "in_progress",
          "field_completed",
          "upload_pending",
          "submitted",
          "approved",
          "rejected",
          "interrupted",
          "superseded",
        ].includes(target.attemptStatus))
    ) throw new RoomReadyContractError(true);
    if ((attemptId === null) !== (target.attemptStatus === null)) {
      throw new RoomReadyContractError(true);
    }
    return {
      cleaningTargetId: roomReadyUuid(target.cleaningTargetId, true),
      assignmentId: target.assignmentId === null
        ? null
        : roomReadyUuid(target.assignmentId, true),
      attemptId,
      attemptStatus: target.attemptStatus as string | null,
      hasSubmission: bool(target.hasSubmission, true),
      fieldCompleted: bool(target.fieldCompleted, true),
    };
  });
  if (
    new Set(cleaningTargets.map((target) => target.cleaningTargetId)).size !==
      cleaningTargets.length ||
    typeof effects.candleCount !== "number" ||
    !Number.isSafeInteger(effects.candleCount) || effects.candleCount < 0 ||
    effects.candleCount > 2147483647 ||
    (effects.displayStatusOverride !== null &&
      ![
        "BLOCKED",
        "OCCUPIED",
        "ARRIVAL_PENDING",
        "RESERVATION_PRESENT",
        "CLEANING_REQUIRED",
        "READY",
      ].includes(String(effects.displayStatusOverride)))
  ) throw new RoomReadyContractError(true);
  const requiresEarningAcknowledgement = bool(
    row.requiresEarningAcknowledgement,
    true,
  );
  if (
    !requiresEarningAcknowledgement &&
    cleaningTargets.some((target) =>
      target.hasSubmission || target.fieldCompleted ||
      ["in_progress", "field_completed", "upload_pending", "submitted"]
        .includes(target.attemptStatus ?? "")
    )
  ) throw new RoomReadyContractError(true);
  return {
    ...resultIdentity(row, expectedRoomId),
    canApply,
    blockingReasons,
    requiresConfirmation: true,
    requiresEarningAcknowledgement,
    effects: {
      cleaningTargets,
      operationBlockIds: ids(effects.operationBlockIds),
      roomIssueIds: ids(effects.roomIssueIds),
      candleCount: effects.candleCount,
      displayStatusOverride: effects.displayStatusOverride as string | null,
    },
    warnings: codes(row.warnings, ROOM_READY_WARNINGS),
    ...proof(row, true),
  };
}
export function parseRoomReadyCorrectionResult(
  value: unknown,
  expectedRoomId: string,
): RoomReadyCorrectionResult {
  const row = object(value, true);
  return {
    ...resultIdentity(row, expectedRoomId),
    recordedAt: roomReadyTimestamp(row.recordedAt, true),
    cancelledCleaningTargetIds: ids(row.cancelledCleaningTargetIds),
    releasedOperationBlockIds: ids(row.releasedOperationBlockIds),
    resolvedRoomIssueIds: ids(row.resolvedRoomIssueIds),
    candlesCleared: bool(row.candlesCleared, true),
  };
}

export function parseRoomReadyEventSummary(
  value: unknown,
): Record<string, number | boolean> {
  const row = object(value, true);
  const count = (key: string) => {
    const value = row[key];
    if (
      typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 ||
      value > ROOM_READY_MAX_EFFECTS
    ) throw new RoomReadyContractError(true);
    return value;
  };
  return {
    roomStateVersion: positive(row.roomStateVersion, true),
    cancelledCleaningCount: count("cancelledCleaningCount"),
    releasedOperationBlockCount: count("releasedOperationBlockCount"),
    resolvedRoomIssueCount: count("resolvedRoomIssueCount"),
    candlesCleared: bool(row.candlesCleared, true),
  };
}

export const roomReadyErrors: ReadonlyArray<readonly [string, number, string]> =
  [
    [
      "ROOM_READY_CORRECTION_INVALID_INPUT",
      400,
      "객실 상태 변경 입력이 올바르지 않습니다.",
    ],
    [
      "ROOM_READY_CONFIRMATION_REQUIRED",
      409,
      "변경할 상태와 영향을 확인한 뒤 저장해 주세요.",
    ],
    [
      "ROOM_READY_EARNING_ACKNOWLEDGEMENT_REQUIRED",
      409,
      "취소한 작업에는 새 청소 수당이 적립되지 않습니다. 먼저 검수 승인하거나 수당 안내를 확인해 주세요.",
    ],
    [
      "ROOM_READY_CANDLE_CONFIRMATION_REQUIRED",
      409,
      "객실의 촛불을 실제로 회수한 뒤 확인해 주세요.",
    ],
    [
      "ROOM_READY_PREVIEW_STALE",
      409,
      "객실 상태 또는 변경 영향이 달라졌습니다. 미리보기를 다시 확인해 주세요.",
    ],
    [
      "ROOM_READY_CORRECTION_BLOCKED",
      409,
      "예약·실제 투숙 또는 별도 처리가 필요한 상태가 있습니다. 미리보기의 차단 사유를 확인해 주세요.",
    ],
    [
      "ROOM_READY_CORRECTION_LIMIT_EXCEEDED",
      409,
      "한 번에 변경할 수 있는 범위를 초과했습니다. 개별 업무를 먼저 정리해 주세요.",
    ],
    [
      "ROOM_READY_CORRECTION_REQUIRED",
      409,
      "준비 완료로 바꾸려면 객실 상태 변경 미리보기에서 실제 차단 상태를 확인하고 해제해 주세요.",
    ],
  ];
