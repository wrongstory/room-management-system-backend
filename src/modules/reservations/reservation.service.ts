import { createHmac, randomUUID } from 'node:crypto';
import type { Actor } from '../../domain/actor.js';
import { AppError, type RoomMoveConflict, type RoomMoveReloadResource } from '../../lib/app-error.js';
import { requestHash } from '../../lib/command.js';
import type { SupabaseClients } from '../../lib/supabase.js';
import { decryptGuestName, encryptGuestName, normalizeGuestName } from './guest-name-crypto.js';

export type ReservationStatus = 'active' | 'cancelled' | 'checked_out';

export interface Reservation {
  id: string;
  roomId: string;
  checkInAt: string;
  checkOutAt: string;
  guestCount: number;
  status: ReservationStatus;
  preparationObligationId: string;
  checkoutObligationId: string;
  version: number;
  actualCheckInAt: string | null;
  actualCheckoutAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReservationDetail extends Reservation {
  guestName: string | null;
}

export type ReservationCommandResult = Reservation & {
  roomStateVersion?: number;
};

export interface CreateReservationInput {
  roomId: string;
  checkInAt: string;
  checkOutAt: string;
  guestCount: number;
  guestName?: string | null;
  expectedRoomVersion: number;
  idempotencyKey: string;
}

export interface ChangeReservationInput {
  reservationId: string;
  roomId: string;
  checkInAt: string;
  checkOutAt: string;
  guestCount: number;
  guestName?: string | null;
  expectedVersion: number;
  reasonCode: string;
  idempotencyKey: string;
}

export type ReservationRoomMoveMode = 'BEFORE_CHECKIN' | 'DURING_STAY';

export type ReservationRoomMoveRejectionReason =
  | 'RESERVATION_NOT_ACTIVE'
  | 'SAME_ROOM'
  | 'INVALID_MOVE_EFFECTIVE_AT'
  | 'OPEN_ENDED_STAY_REQUIRES_END'
  | 'CLEANING_WORKFLOW_PUBLIC'
  | 'PLANNED_CHECKOUT_NOT_PRIVATE'
  | 'CLEANING_WORKFLOW_ASSIGNED'
  | 'CLEANING_WORKFLOW_NOTIFIED'
  | 'CLEANING_WORKFLOW_STARTED'
  | 'ACTIVE_PIN_ACCESS_EXISTS'
  | 'TARGET_ROOM_BLOCKED'
  | 'TARGET_ROOM_NOT_READY'
  | 'RESERVATION_OVERLAP';

export type ReservationRoomMoveReason =
  | 'GUEST_REQUEST'
  | 'ROOM_UNAVAILABLE'
  | 'OPERATIONAL_ADJUSTMENT';

export type ReservationRoomMoveBlockingReason =
  | 'RESERVATION_VERSION_CONFLICT'
  | 'SOURCE_ROOM_VERSION_CONFLICT'
  | 'TARGET_ROOM_VERSION_CONFLICT'
  | 'TARGET_ROOM_OVERLAP'
  | 'ROOM_CHANGE_PREVIEW_STALE'
  | 'CLEANING_ASSIGNMENT_LOCKED'
  | 'PIN_LEASE_ACTIVE'
  | 'TARGET_ROOM_BLOCKED'
  | 'TARGET_ROOM_NOT_READY';

export interface ReservationRoomMoveOutcome {
  occupancyStatus: 'VACANT' | 'OCCUPIED';
  readinessStatus: 'READY' | 'CLEANING_REQUIRED' | 'CHECKIN_BLOCKED';
  stateVersion: number;
}

export interface ReservationRoomMovePreview {
  mode: ReservationRoomMoveMode;
  eligible: boolean;
  rejectionReasonCodes: ReservationRoomMoveRejectionReason[];
  blockingReasonCodes: ReservationRoomMoveBlockingReason[];
  warnings: string[];
  targetBlockReasonCodes: string[];
  sourceOutcome: ReservationRoomMoveOutcome;
  targetOutcome: ReservationRoomMoveOutcome;
  impactFingerprint: string;
  evaluatedAt: string;
  expiresAt: string;
  effectiveAt: string;
  reservationId: string;
  reservationVersion: number;
  stayId: string;
  stayVersion: number;
  sourceSegmentId: string;
  sourceSegmentVersion: number;
  sourceRoomId: string;
  sourceRoomVersion: number;
  targetRoomId: string;
  targetRoomVersion: number;
  checkInAt: string;
  checkOutAt: string;
  guestCount: number;
  preparationObligationId: string;
  checkoutObligationId: string;
  checkoutObligationVersion: number;
  plannedCheckoutTargetId: string | null;
  plannedCheckoutTargetVersion: number | null;
}

export interface PreviewReservationRoomMoveInput {
  reservationId: string;
  targetRoomId: string;
  effectiveAt?: string | undefined;
  reasonCode: ReservationRoomMoveReason;
  expectedReservationVersion: number;
  expectedSourceRoomVersion: number;
  expectedTargetRoomVersion: number;
}

export interface CommitReservationRoomMoveInput extends PreviewReservationRoomMoveInput {
  evaluatedAt: string;
  expiresAt: string;
  effectiveAt: string;
  impactFingerprint: string;
  reasonCode: ReservationRoomMoveReason;
  idempotencyKey: string;
}

export interface ReservationRoomMoveCommitResult {
  reservation: ReservationCommandResult;
  mode: ReservationRoomMoveMode;
  evaluatedAt: string;
  expiresAt: string;
  effectiveAt: string;
  movedAt: string;
  sourceRoomId: string;
  targetRoomId: string;
  sourceRoomVersion: number;
  targetRoomVersion: number;
  plannedCheckoutTargetId: string;
  plannedCheckoutTargetVersion: number;
  sourceOutcome: ReservationRoomMoveOutcome;
  targetOutcome: ReservationRoomMoveOutcome;
  stay?: {
    id: string;
    version: number;
    currentRoomId: string;
  };
  segments?: Array<{
    id: string;
    roomId: string;
    startsAt: string;
    endsAt: string;
  }>;
  sourceCleaningTargetId?: string;
  pinAccessEndsAt?: string;
}

export interface ReservationMutationInput {
  reservationId: string;
  expectedVersion: number;
  reasonCode: string;
  idempotencyKey: string;
}

export interface CreateManualCleaningRequestInput {
  roomId: string;
  reservationId?: string | null;
  cleaningKind: 'stayover' | 'additional';
  serviceDate: string;
  availableFrom: string;
  dueAt?: string | null;
  expectedRoomVersion: number;
  reasonCode: string;
  idempotencyKey: string;
}

export interface CancelManualCleaningRequestInput {
  targetId: string;
  expectedVersion: number;
  reasonCode: string;
  idempotencyKey: string;
}

export interface ManualCleaningRequestResult {
  id: string;
  roomId: string;
  reservationId: string | null;
  cleaningKind: 'stayover' | 'additional';
  status: string;
  serviceDate: string;
  availableFrom: string;
  dueAt: string | null;
  version: number;
}

export interface TransitionResult {
  asOf: string;
  checkedInCount: number;
  checkedOutCount: number;
  blockedCheckInCount: number;
  purgedGuestNameCount: number;
}

export interface ReservationService {
  list(actor: Actor, roomId?: string): Promise<Reservation[]>;
  get(actor: Actor, reservationId: string): Promise<ReservationDetail>;
  create(actor: Actor, input: CreateReservationInput): Promise<ReservationCommandResult>;
  change(actor: Actor, input: ChangeReservationInput): Promise<ReservationCommandResult>;
  previewRoomMove(
    actor: Actor,
    input: PreviewReservationRoomMoveInput
  ): Promise<ReservationRoomMovePreview>;
  commitRoomMove(
    actor: Actor,
    input: CommitReservationRoomMoveInput
  ): Promise<ReservationRoomMoveCommitResult>;
  cancel(actor: Actor, input: ReservationMutationInput): Promise<ReservationCommandResult>;
  manualCheckout(actor: Actor, input: ReservationMutationInput): Promise<ReservationCommandResult>;
  processDue(actor: Actor, idempotencyKey: string): Promise<TransitionResult>;
  createManualCleaningRequest(
    actor: Actor,
    input: CreateManualCleaningRequestInput
  ): Promise<ManualCleaningRequestResult>;
  cancelManualCleaningRequest(
    actor: Actor,
    input: CancelManualCleaningRequestInput
  ): Promise<ManualCleaningRequestResult>;
}

interface ReservationRow {
  id: string;
  room_id: string;
  check_in_at: string;
  check_out_at: string;
  guest_count: number;
  guest_name_encrypted: string | null;
  status: ReservationStatus;
  preparation_obligation_id: string;
  checkout_obligation_id: string;
  version: number;
  actual_check_in_at: string | null;
  actual_checkout_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

function guestNameFingerprint(value: string | null, pepper: string): string | null {
  if (value === null) {
    return null;
  }
  return createHmac('sha256', pepper).update(value, 'utf8').digest('hex');
}

interface ReservationCommandRow {
  id: string;
  room_id: string;
  check_in_at: string;
  check_out_at: string;
  guest_count: number;
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

interface ManualCleaningRequestRow {
  id: string;
  room_id: string;
  reservation_id: string | null;
  cleaning_kind: 'stayover' | 'additional';
  status: string;
  service_date: string;
  available_from: string;
  due_at: string | null;
  version: number;
}

function ensureAdmin(actor: Actor): void {
  if (actor.role !== 'admin') {
    throw new AppError(403, 'ADMIN_REQUIRED', '관리자만 예약을 관리할 수 있습니다.');
  }
}

const roomMoveReloadResources = new Set<RoomMoveReloadResource>([
  'reservation',
  'sourceRoom',
  'targetRoom',
  'roomMovePreview'
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function conflictVersion(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function roomMoveConflict(details: string | undefined): RoomMoveConflict | undefined {
  if (!details) return undefined;
  try {
    const value: unknown = JSON.parse(details);
    if (!isRecord(value) || !hasExactKeys(value, ['latestVersions', 'reloadResources'])) return undefined;
    const reloadResources = value.reloadResources;
    const latestVersions = value.latestVersions;
    if (
      !Array.isArray(reloadResources) ||
      reloadResources.length < 1 ||
      reloadResources.length > roomMoveReloadResources.size ||
      !reloadResources.every(
        (item): item is RoomMoveReloadResource =>
          typeof item === 'string' && roomMoveReloadResources.has(item as RoomMoveReloadResource)
      ) ||
      new Set(reloadResources).size !== reloadResources.length ||
      !isRecord(latestVersions) ||
      !hasExactKeys(latestVersions, [
        'reservationVersion',
        'sourceRoomVersion',
        'targetRoomVersion'
      ])
    ) {
      return undefined;
    }
    const reservationVersion = conflictVersion(latestVersions.reservationVersion);
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
      latestVersions: { reservationVersion, sourceRoomVersion, targetRoomVersion }
    };
  } catch {
    return undefined;
  }
}

function unknownRoomMoveConflict(): RoomMoveConflict {
  return {
    reloadResources: ['reservation', 'sourceRoom', 'targetRoom', 'roomMovePreview'],
    latestVersions: {
      reservationVersion: null,
      sourceRoomVersion: null,
      targetRoomVersion: null
    }
  };
}

function reservationError(
  error: { code?: string; message?: string; details?: string } | null,
  roomMoveCommand = false
): AppError {
  const message = error?.message ?? '';
  const roomMoveErrors: Array<[string, string]> = [
    ['RESERVATION_VERSION_CONFLICT', '예약이 변경됐습니다. 다시 확인해 주세요.'],
    ['SOURCE_ROOM_VERSION_CONFLICT', '출발 객실 상태가 변경됐습니다. 다시 확인해 주세요.'],
    ['TARGET_ROOM_VERSION_CONFLICT', '도착 객실 상태가 변경됐습니다. 다시 확인해 주세요.'],
    ['TARGET_ROOM_OVERLAP', '도착 객실에 겹치는 예약이 있습니다.'],
    ['ROOM_CHANGE_PREVIEW_STALE', '객실 변경 미리보기가 만료되었거나 상태가 변경됐습니다.'],
    ['CLEANING_ASSIGNMENT_LOCKED', '청소 작업이 공개·배정·시작되어 객실을 변경할 수 없습니다.'],
    ['PIN_LEASE_ACTIVE', '활성 PIN 접근 권한이 있어 객실을 변경할 수 없습니다.'],
    ['TARGET_ROOM_BLOCKED', '도착 객실이 운영상 차단되어 있습니다.'],
    ['TARGET_ROOM_NOT_READY', '도착 객실이 아직 입실 가능한 상태가 아닙니다.'],
    ['OPEN_ENDED_STAY_REQUIRES_END', '투숙 중 객실 이동에는 확정된 퇴실 시각이 필요합니다.'],
    ['DURING_STAY_NOT_SUPPORTED', '투숙 중 객실 변경은 아직 지원하지 않습니다.'],
    ['MOVE_ALREADY_APPLIED', '예약이 이미 해당 객실로 이동되었습니다.'],
    ['RESERVATION_ROOM_CHANGE_DEDICATED_COMMAND_REQUIRED', '객실 변경 전용 API를 사용해 주세요.']
  ];
  const roomMoveError = roomMoveErrors.find(([code]) => message.includes(code));
  if (roomMoveError) {
    return new AppError(
      409,
      roomMoveError[0],
      roomMoveError[1],
      undefined,
      roomMoveConflict(error?.details) ?? unknownRoomMoveConflict()
    );
  }
  if (message.includes('INVALID_ROOM_MOVE_REASON') || message.includes('ROOM_MOVE_PREVIEW_INVALID')) {
    const code = message.includes('INVALID_ROOM_MOVE_REASON')
      ? 'INVALID_ROOM_MOVE_REASON'
      : 'ROOM_MOVE_PREVIEW_INVALID';
    return new AppError(400, code, '객실 변경 요청 값이 올바르지 않습니다.');
  }
  if (message.includes('INVALID_MOVE_EFFECTIVE_AT')) {
    return new AppError(400, 'INVALID_MOVE_EFFECTIVE_AT', '객실 변경 적용 시각이 올바르지 않습니다.');
  }
  if (message.includes('STALE_VERSION')) {
    return new AppError(409, 'STALE_VERSION', '다른 변경이 먼저 반영됐습니다. 최신 정보를 다시 확인해 주세요.');
  }
  if (message.includes('RESERVATION_OVERLAP') || error?.code === '23P01') {
    return new AppError(409, 'RESERVATION_OVERLAP', '같은 객실의 활성 예약 시간이 겹칩니다.');
  }
  if (message.includes('ROOM_ALLOCATION_BLOCKED')) {
    return new AppError(409, 'ROOM_ALLOCATION_BLOCKED', '현재 객실 차단 사유를 해소한 뒤 예약해 주세요.');
  }
  if (message.includes('IDEMPOTENCY_KEY_REUSED')) {
    return new AppError(
      409,
      'IDEMPOTENCY_KEY_REUSED',
      '이미 다른 요청에 사용한 Idempotency-Key입니다.',
      undefined,
      roomMoveCommand ? roomMoveConflict(error?.details) ?? unknownRoomMoveConflict() : undefined
    );
  }
  if (message.includes('ROOM_NOT_FOUND')) {
    return new AppError(404, 'ROOM_NOT_FOUND', '객실을 찾을 수 없습니다.');
  }
  if (message.includes('RESERVATION_NOT_FOUND')) {
    return new AppError(404, 'RESERVATION_NOT_FOUND', '예약을 찾을 수 없습니다.');
  }
  if (message.includes('CLEANING_REQUEST_NOT_FOUND')) {
    return new AppError(404, 'CLEANING_REQUEST_NOT_FOUND', '청소 요청을 찾을 수 없습니다.');
  }
  if (message.includes('CLEANING_TEMPLATE_NOT_CONFIGURED')) {
    return new AppError(409, 'CLEANING_TEMPLATE_NOT_CONFIGURED', '해당 객실 유형의 청소 템플릿이 아직 없습니다.');
  }
  if (message.includes('INVALID_RESERVATION_SCHEDULE')) {
    return new AppError(400, 'INVALID_RESERVATION_SCHEDULE', '예약은 분 단위이며 최소 1박이어야 합니다.');
  }
  if (message.includes('INVALID_MANUAL_CLEANING_REQUEST')) {
    return new AppError(400, 'INVALID_MANUAL_CLEANING_REQUEST', '수동 청소 요청의 종류와 시간 값을 확인해 주세요.');
  }
  if (
    message.includes('INVALID_TRANSITION') ||
    message.includes('NOT_ALLOWED') ||
    message.includes('IMMUTABLE') ||
    message.includes('CONFLICT') ||
    message.includes('REPLAN_REQUIRED') ||
    message.includes('SCHEDULE_LOCKED') ||
    message.includes('MANUAL_CLEANING_REQUEST') ||
    message.includes('ACTIVE_STAY_RESERVATION_REQUIRED') ||
    message.includes('STAYOVER_ACCESS_WINDOW_INVALID') ||
    message.includes('VACANT_ROOM_REQUIRED') ||
    message.includes('RESERVATION_ROOM_MISMATCH') ||
    message.includes('NOT_MANUAL_CLEANING_REQUEST')
  ) {
    return new AppError(409, message || 'INVALID_TRANSITION', '현재 예약 상태에서는 요청한 변경을 할 수 없습니다.');
  }
  if (message.includes('ADMIN_REQUIRED') || message.includes('ACTIVE_ACCOUNT_REQUIRED')) {
    return new AppError(403, 'FORBIDDEN', '현재 계정으로 예약 명령을 실행할 수 없습니다.');
  }
  return new AppError(500, 'RESERVATION_COMMAND_FAILED', '예약 명령을 완료하지 못했습니다.');
}

function toCommandResult(row: ReservationCommandRow): ReservationCommandResult {
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
    ...(row.room_state_version ? { roomStateVersion: row.room_state_version } : {})
  };
}

const projectionUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const projectionTimestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const roomMoveModes = new Set(['BEFORE_CHECKIN', 'DURING_STAY']);
const roomMoveRejections = new Set<ReservationRoomMoveRejectionReason>([
  'RESERVATION_NOT_ACTIVE', 'SAME_ROOM', 'INVALID_MOVE_EFFECTIVE_AT',
  'OPEN_ENDED_STAY_REQUIRES_END',
  'CLEANING_WORKFLOW_PUBLIC', 'PLANNED_CHECKOUT_NOT_PRIVATE',
  'CLEANING_WORKFLOW_ASSIGNED', 'CLEANING_WORKFLOW_NOTIFIED',
  'CLEANING_WORKFLOW_STARTED', 'ACTIVE_PIN_ACCESS_EXISTS',
  'TARGET_ROOM_BLOCKED', 'TARGET_ROOM_NOT_READY', 'RESERVATION_OVERLAP'
]);
const roomMoveBlockingReasons = new Set<ReservationRoomMoveBlockingReason>([
  'RESERVATION_VERSION_CONFLICT',
  'SOURCE_ROOM_VERSION_CONFLICT', 'TARGET_ROOM_VERSION_CONFLICT',
  'TARGET_ROOM_OVERLAP', 'ROOM_CHANGE_PREVIEW_STALE',
  'CLEANING_ASSIGNMENT_LOCKED', 'PIN_LEASE_ACTIVE', 'TARGET_ROOM_BLOCKED',
  'TARGET_ROOM_NOT_READY'
]);

function roomMoveProjectionError(): never {
  throw new AppError(500, 'RESERVATION_PROJECTION_INVALID', '예약 응답을 안전하게 확인하지 못했습니다.');
}

function projectionRecord(value: unknown): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== 'object') roomMoveProjectionError();
  return value as Record<string, unknown>;
}

function projectionString(value: unknown, pattern?: RegExp): string {
  if (typeof value !== 'string' || (pattern && !pattern.test(value))) roomMoveProjectionError();
  return value;
}

function projectionTimestamp(value: unknown): string {
  const result = projectionString(value, projectionTimestampPattern);
  const match = result.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/
  );
  if (!match) roomMoveProjectionError();
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const daysInMonth = days[month - 1] ?? 0;
  if (
    year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth ||
    Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59 ||
    Number(match[8] ?? 0) > 23 || Number(match[9] ?? 0) > 59 ||
    !Number.isFinite(Date.parse(result))
  ) roomMoveProjectionError();
  return result;
}

function projectionPositiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) roomMoveProjectionError();
  return value as number;
}

function projectionEnum<T extends string>(value: unknown, allowed: ReadonlySet<T>): T {
  if (typeof value !== 'string' || !allowed.has(value as T)) roomMoveProjectionError();
  return value as T;
}

function projectionArray<T extends string>(value: unknown, allowed: ReadonlySet<T>): T[] {
  if (!Array.isArray(value)) roomMoveProjectionError();
  return value.map((item) => projectionEnum(item, allowed));
}

function roomMoveOutcome(value: unknown): ReservationRoomMoveOutcome {
  const row = projectionRecord(value);
  return {
    occupancyStatus: projectionEnum(row.occupancyStatus, new Set(['VACANT', 'OCCUPIED'])),
    readinessStatus: projectionEnum(
      row.readinessStatus,
      new Set(['READY', 'CLEANING_REQUIRED', 'CHECKIN_BLOCKED'])
    ),
    stateVersion: projectionPositiveInteger(row.stateVersion)
  };
}

function roomMovePreviewProjection(value: unknown): ReservationRoomMovePreview {
  const row = projectionRecord(value);
  if (typeof row.eligible !== 'boolean' || !Array.isArray(row.warnings) || row.warnings.length > 0) {
    roomMoveProjectionError();
  }
  return {
    mode: projectionEnum(row.mode, roomMoveModes) as ReservationRoomMoveMode,
    eligible: row.eligible,
    rejectionReasonCodes: projectionArray(row.rejectionReasonCodes, roomMoveRejections),
    blockingReasonCodes: projectionArray(row.blockingReasonCodes, roomMoveBlockingReasons),
    warnings: [],
    targetBlockReasonCodes: projectionArray(row.targetBlockReasonCodes, new Set([
      'OCCUPIED', 'RESERVATION_CURRENT', 'CLEANING_REQUIRED', 'CANDLE_PRESENT',
      'OPERATION_BLOCKED', 'ROOM_ISSUE_BLOCKED', 'DATA_UNCONFIRMED'
    ])),
    sourceOutcome: roomMoveOutcome(row.sourceOutcome),
    targetOutcome: roomMoveOutcome(row.targetOutcome),
    impactFingerprint: projectionString(row.impactFingerprint, /^[0-9a-f]{64}$/),
    evaluatedAt: projectionTimestamp(row.evaluatedAt),
    expiresAt: projectionTimestamp(row.expiresAt),
    effectiveAt: projectionTimestamp(row.effectiveAt),
    reservationId: projectionString(row.reservationId, projectionUuidPattern),
    reservationVersion: projectionPositiveInteger(row.reservationVersion),
    stayId: projectionString(row.stayId, projectionUuidPattern),
    stayVersion: projectionPositiveInteger(row.stayVersion),
    sourceSegmentId: projectionString(row.sourceSegmentId, projectionUuidPattern),
    sourceSegmentVersion: projectionPositiveInteger(row.sourceSegmentVersion),
    sourceRoomId: projectionString(row.sourceRoomId, projectionUuidPattern),
    sourceRoomVersion: projectionPositiveInteger(row.sourceRoomVersion),
    targetRoomId: projectionString(row.targetRoomId, projectionUuidPattern),
    targetRoomVersion: projectionPositiveInteger(row.targetRoomVersion),
    checkInAt: projectionTimestamp(row.checkInAt),
    checkOutAt: projectionTimestamp(row.checkOutAt),
    guestCount: projectionPositiveInteger(row.guestCount),
    preparationObligationId: projectionString(row.preparationObligationId, projectionUuidPattern),
    checkoutObligationId: projectionString(row.checkoutObligationId, projectionUuidPattern),
    checkoutObligationVersion: projectionPositiveInteger(row.checkoutObligationVersion),
    plannedCheckoutTargetId: row.plannedCheckoutTargetId === null
      ? null
      : projectionString(row.plannedCheckoutTargetId, projectionUuidPattern),
    plannedCheckoutTargetVersion: row.plannedCheckoutTargetVersion === null
      ? null
      : projectionPositiveInteger(row.plannedCheckoutTargetVersion)
  };
}

function roomMoveCommitProjection(value: unknown): ReservationRoomMoveCommitResult {
  const row = projectionRecord(value);
  const reservation = projectionRecord(row.reservation);
  const mode = projectionEnum(row.mode, roomMoveModes) as ReservationRoomMoveMode;
  const duringStayFields = [
    row.stay,
    row.segments,
    row.sourceCleaningTargetId,
    row.pinAccessEndsAt
  ];
  if (mode === 'BEFORE_CHECKIN' && duringStayFields.some((item) => item !== undefined)) {
    roomMoveProjectionError();
  }
  let duringStay: Pick<
    ReservationRoomMoveCommitResult,
    'stay' | 'segments' | 'sourceCleaningTargetId' | 'pinAccessEndsAt'
  > = {};
  if (mode === 'DURING_STAY') {
    const stay = projectionRecord(row.stay);
    if (!Array.isArray(row.segments) || row.segments.length !== 2) roomMoveProjectionError();
    duringStay = {
      stay: {
        id: projectionString(stay.id, projectionUuidPattern),
        version: projectionPositiveInteger(stay.version),
        currentRoomId: projectionString(stay.currentRoomId, projectionUuidPattern)
      },
      segments: row.segments.map((item) => {
        const segment = projectionRecord(item);
        return {
          id: projectionString(segment.id, projectionUuidPattern),
          roomId: projectionString(segment.roomId, projectionUuidPattern),
          startsAt: projectionTimestamp(segment.startsAt),
          endsAt: projectionTimestamp(segment.endsAt)
        };
      }),
      sourceCleaningTargetId: projectionString(row.sourceCleaningTargetId, projectionUuidPattern),
      pinAccessEndsAt: projectionTimestamp(row.pinAccessEndsAt)
    };
  }
  return {
    reservation: toCommandResult({
      id: projectionString(reservation.id, projectionUuidPattern),
      room_id: projectionString(reservation.room_id, projectionUuidPattern),
      check_in_at: projectionTimestamp(reservation.check_in_at),
      check_out_at: projectionTimestamp(reservation.check_out_at),
      guest_count: projectionPositiveInteger(reservation.guest_count),
      status: projectionEnum(reservation.status, new Set(['active', 'cancelled', 'checked_out'])),
      preparation_obligation_id: projectionString(reservation.preparation_obligation_id, projectionUuidPattern),
      checkout_obligation_id: projectionString(reservation.checkout_obligation_id, projectionUuidPattern),
      version: projectionPositiveInteger(reservation.version),
      actual_check_in_at: reservation.actual_check_in_at === null ? null : projectionTimestamp(reservation.actual_check_in_at),
      actual_checkout_at: reservation.actual_checkout_at === null ? null : projectionTimestamp(reservation.actual_checkout_at),
      cancelled_at: reservation.cancelled_at === null ? null : projectionTimestamp(reservation.cancelled_at),
      created_at: projectionTimestamp(reservation.created_at),
      updated_at: projectionTimestamp(reservation.updated_at)
    }),
    mode,
    evaluatedAt: projectionTimestamp(row.evaluatedAt),
    expiresAt: projectionTimestamp(row.expiresAt),
    effectiveAt: projectionTimestamp(row.effectiveAt),
    movedAt: projectionTimestamp(row.movedAt),
    sourceRoomId: projectionString(row.sourceRoomId, projectionUuidPattern),
    targetRoomId: projectionString(row.targetRoomId, projectionUuidPattern),
    sourceRoomVersion: projectionPositiveInteger(row.sourceRoomVersion),
    targetRoomVersion: projectionPositiveInteger(row.targetRoomVersion),
    plannedCheckoutTargetId: projectionString(row.plannedCheckoutTargetId, projectionUuidPattern),
    plannedCheckoutTargetVersion: projectionPositiveInteger(row.plannedCheckoutTargetVersion),
    sourceOutcome: roomMoveOutcome(row.sourceOutcome),
    targetOutcome: roomMoveOutcome(row.targetOutcome),
    ...duringStay
  };
}

function toManualCleaningRequest(row: ManualCleaningRequestRow): ManualCleaningRequestResult {
  return {
    id: row.id,
    roomId: row.room_id,
    reservationId: row.reservation_id,
    cleaningKind: row.cleaning_kind,
    status: row.status,
    serviceDate: row.service_date,
    availableFrom: row.available_from,
    dueAt: row.due_at,
    version: row.version
  };
}

export class SupabaseReservationService implements ReservationService {
  constructor(
    private readonly clients: SupabaseClients,
    private readonly piiKey: string,
    private readonly piiKeyVersion: string,
    private readonly guestNamePepper: string,
    private readonly previousPiiKeys: Record<string, string> = {}
  ) {}

  async list(actor: Actor, roomId?: string): Promise<Reservation[]> {
    ensureAdmin(actor);
    const { data, error } = await this.clients.admin.rpc('list_reservations', {
      p_actor_profile_id: actor.profileId,
      p_room_id: roomId ?? null
    });
    if (error) {
      throw reservationError(error);
    }
    return ((data ?? []) as ReservationRow[]).map((row) => ({
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
      updatedAt: row.updated_at
    }));
  }

  async get(actor: Actor, reservationId: string): Promise<ReservationDetail> {
    ensureAdmin(actor);
    const { data, error } = await this.clients.admin.rpc('get_reservation_detail', {
      p_actor_profile_id: actor.profileId,
      p_reservation_id: reservationId
    });
    if (error) {
      throw reservationError(error);
    }
    const row = (data as ReservationRow[] | null)?.[0];
    if (!row) {
      throw new AppError(404, 'RESERVATION_NOT_FOUND', '예약을 찾을 수 없습니다.');
    }
    return {
      id: row.id,
      roomId: row.room_id,
      checkInAt: row.check_in_at,
      checkOutAt: row.check_out_at,
      guestCount: row.guest_count,
      guestName: row.guest_name_encrypted
        ? decryptGuestName(
          row.guest_name_encrypted,
          this.piiKey,
          this.piiKeyVersion,
          this.previousPiiKeys
        )
        : null,
      status: row.status,
      preparationObligationId: row.preparation_obligation_id,
      checkoutObligationId: row.checkout_obligation_id,
      version: row.version,
      actualCheckInAt: row.actual_check_in_at,
      actualCheckoutAt: row.actual_checkout_at,
      cancelledAt: row.cancelled_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  async create(actor: Actor, input: CreateReservationInput): Promise<ReservationCommandResult> {
    ensureAdmin(actor);
    const guestName = input.guestName == null ? null : normalizeGuestName(input.guestName);
    const fingerprint = {
      roomId: input.roomId,
      checkInAt: input.checkInAt,
      checkOutAt: input.checkOutAt,
      guestCount: input.guestCount,
      guestNameFingerprint: guestNameFingerprint(guestName, this.guestNamePepper),
      expectedRoomVersion: input.expectedRoomVersion
    };
    const { data, error } = await this.clients.admin.rpc('create_reservation', {
      p_actor_profile_id: actor.profileId,
      p_reservation_id: randomUUID(),
      p_room_id: input.roomId,
      p_check_in_at: input.checkInAt,
      p_check_out_at: input.checkOutAt,
      p_guest_count: input.guestCount,
      p_guest_name_encrypted: guestName
        ? encryptGuestName(guestName, this.piiKey, this.piiKeyVersion)
        : null,
      p_expected_room_version: input.expectedRoomVersion,
      p_idempotency_key: input.idempotencyKey,
      p_request_hash: requestHash(fingerprint)
    });
    if (error || !data) {
      throw reservationError(error);
    }
    return toCommandResult(data as ReservationCommandRow);
  }

  async change(actor: Actor, input: ChangeReservationInput): Promise<ReservationCommandResult> {
    ensureAdmin(actor);
    const hasGuestName = Object.hasOwn(input, 'guestName');
    const guestName = hasGuestName && input.guestName != null
      ? normalizeGuestName(input.guestName)
      : input.guestName;
    const guestNameMode = !hasGuestName ? 'keep' : guestName === null ? 'clear' : 'set';
    const fingerprint = {
      reservationId: input.reservationId,
      roomId: input.roomId,
      checkInAt: input.checkInAt,
      checkOutAt: input.checkOutAt,
      guestCount: input.guestCount,
      guestNameMode,
      guestNameFingerprint: guestNameFingerprint(guestName ?? null, this.guestNamePepper),
      expectedVersion: input.expectedVersion,
      reasonCode: input.reasonCode
    };
    const { data, error } = await this.clients.admin.rpc('change_reservation', {
      p_actor_profile_id: actor.profileId,
      p_reservation_id: input.reservationId,
      p_room_id: input.roomId,
      p_check_in_at: input.checkInAt,
      p_check_out_at: input.checkOutAt,
      p_guest_count: input.guestCount,
      p_guest_name_mode: guestNameMode,
      p_guest_name_encrypted: guestNameMode === 'set' && guestName
        ? encryptGuestName(guestName, this.piiKey, this.piiKeyVersion)
        : null,
      p_expected_version: input.expectedVersion,
      p_reason_code: input.reasonCode,
      p_idempotency_key: input.idempotencyKey,
      p_request_hash: requestHash(fingerprint)
    });
    if (error || !data) {
      throw reservationError(error);
    }
    return toCommandResult(data as ReservationCommandRow);
  }

  async previewRoomMove(
    actor: Actor,
    input: PreviewReservationRoomMoveInput
  ): Promise<ReservationRoomMovePreview> {
    ensureAdmin(actor);
    const { data, error } = await this.clients.admin.rpc('preview_reservation_room_move', {
      p_actor_profile_id: actor.profileId,
      p_reservation_id: input.reservationId,
      p_target_room_id: input.targetRoomId,
      p_expected_reservation_version: input.expectedReservationVersion,
      p_expected_source_room_version: input.expectedSourceRoomVersion,
      p_expected_target_room_version: input.expectedTargetRoomVersion,
      p_effective_at: input.effectiveAt ?? null,
      p_reason_code: input.reasonCode
    });
    if (error || !data) {
      throw reservationError(error, true);
    }
    return roomMovePreviewProjection(data);
  }

  async commitRoomMove(
    actor: Actor,
    input: CommitReservationRoomMoveInput
  ): Promise<ReservationRoomMoveCommitResult> {
    ensureAdmin(actor);
    const fingerprint = {
      reservationId: input.reservationId,
      targetRoomId: input.targetRoomId,
      expectedReservationVersion: input.expectedReservationVersion,
      expectedSourceRoomVersion: input.expectedSourceRoomVersion,
      expectedTargetRoomVersion: input.expectedTargetRoomVersion,
      evaluatedAt: input.evaluatedAt,
      expiresAt: input.expiresAt,
      effectiveAt: input.effectiveAt,
      impactFingerprint: input.impactFingerprint,
      reasonCode: input.reasonCode
    };
    const { data, error } = await this.clients.admin.rpc('commit_reservation_room_move', {
      p_actor_profile_id: actor.profileId,
      p_reservation_id: input.reservationId,
      p_target_room_id: input.targetRoomId,
      p_expected_reservation_version: input.expectedReservationVersion,
      p_expected_source_room_version: input.expectedSourceRoomVersion,
      p_expected_target_room_version: input.expectedTargetRoomVersion,
      p_preview_evaluated_at: input.evaluatedAt,
      p_preview_expires_at: input.expiresAt,
      p_effective_at: input.effectiveAt,
      p_impact_fingerprint: input.impactFingerprint,
      p_reason_code: input.reasonCode,
      p_idempotency_key: input.idempotencyKey,
      p_request_hash: requestHash(fingerprint)
    });
    if (error || !data) {
      throw reservationError(error, true);
    }
    return roomMoveCommitProjection(data);
  }

  async cancel(actor: Actor, input: ReservationMutationInput): Promise<ReservationCommandResult> {
    return this.runMutation(actor, 'cancel_reservation', 'reservation.cancel', input);
  }

  async manualCheckout(
    actor: Actor,
    input: ReservationMutationInput
  ): Promise<ReservationCommandResult> {
    ensureAdmin(actor);
    const effectiveAt = new Date().toISOString();
    const fingerprint = {
      reservationId: input.reservationId,
      expectedVersion: input.expectedVersion,
      reasonCode: input.reasonCode
    };
    const { data, error } = await this.clients.admin.rpc('manual_checkout_reservation', {
      p_actor_profile_id: actor.profileId,
      p_reservation_id: input.reservationId,
      p_expected_version: input.expectedVersion,
      p_reason_code: input.reasonCode,
      p_effective_at: effectiveAt,
      p_idempotency_key: input.idempotencyKey,
      p_request_hash: requestHash(fingerprint)
    });
    if (error || !data) {
      throw reservationError(error);
    }
    return toCommandResult(data as ReservationCommandRow);
  }

  async processDue(
    actor: Actor,
    idempotencyKey: string
  ): Promise<TransitionResult> {
    ensureAdmin(actor);
    const asOf = new Date().toISOString();
    const { data, error } = await this.clients.admin.rpc('process_due_reservation_transitions', {
      p_actor_profile_id: actor.profileId,
      p_as_of: asOf,
      p_idempotency_key: idempotencyKey,
      p_request_hash: requestHash({ command: 'reservation.process_due_transitions' })
    });
    if (error || !data) {
      throw reservationError(error);
    }
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
      purgedGuestNameCount: row.purged_guest_name_count
    };
  }

  async createManualCleaningRequest(
    actor: Actor,
    input: CreateManualCleaningRequestInput
  ): Promise<ManualCleaningRequestResult> {
    ensureAdmin(actor);
    const fingerprint = {
      roomId: input.roomId,
      reservationId: input.reservationId ?? null,
      cleaningKind: input.cleaningKind,
      serviceDate: input.serviceDate,
      availableFrom: input.availableFrom,
      dueAt: input.dueAt ?? null,
      expectedRoomVersion: input.expectedRoomVersion,
      reasonCode: input.reasonCode
    };
    const { data, error } = await this.clients.admin.rpc('create_manual_cleaning_request', {
      p_actor_profile_id: actor.profileId,
      p_target_id: randomUUID(),
      p_room_id: input.roomId,
      p_reservation_id: input.reservationId ?? null,
      p_cleaning_kind: input.cleaningKind,
      p_service_date: input.serviceDate,
      p_available_from: input.availableFrom,
      p_due_at: input.dueAt ?? null,
      p_expected_room_version: input.expectedRoomVersion,
      p_reason_code: input.reasonCode,
      p_idempotency_key: input.idempotencyKey,
      p_request_hash: requestHash(fingerprint)
    });
    if (error || !data) {
      throw reservationError(error);
    }
    return toManualCleaningRequest(data as ManualCleaningRequestRow);
  }

  async cancelManualCleaningRequest(
    actor: Actor,
    input: CancelManualCleaningRequestInput
  ): Promise<ManualCleaningRequestResult> {
    ensureAdmin(actor);
    const fingerprint = {
      targetId: input.targetId,
      expectedVersion: input.expectedVersion,
      reasonCode: input.reasonCode
    };
    const { data, error } = await this.clients.admin.rpc('cancel_manual_cleaning_request', {
      p_actor_profile_id: actor.profileId,
      p_target_id: input.targetId,
      p_expected_version: input.expectedVersion,
      p_reason_code: input.reasonCode,
      p_idempotency_key: input.idempotencyKey,
      p_request_hash: requestHash(fingerprint)
    });
    if (error || !data) {
      throw reservationError(error);
    }
    return toManualCleaningRequest(data as ManualCleaningRequestRow);
  }

  private async runMutation(
    actor: Actor,
    rpc: string,
    command: string,
    input: ReservationMutationInput
  ): Promise<ReservationCommandResult> {
    ensureAdmin(actor);
    const fingerprint = {
      reservationId: input.reservationId,
      expectedVersion: input.expectedVersion,
      reasonCode: input.reasonCode
    };
    const { data, error } = await this.clients.admin.rpc(rpc, {
      p_actor_profile_id: actor.profileId,
      p_reservation_id: input.reservationId,
      p_expected_version: input.expectedVersion,
      p_reason_code: input.reasonCode,
      p_idempotency_key: input.idempotencyKey,
      p_request_hash: requestHash({ command, ...fingerprint })
    });
    if (error || !data) {
      throw reservationError(error);
    }
    return toCommandResult(data as ReservationCommandRow);
  }
}
