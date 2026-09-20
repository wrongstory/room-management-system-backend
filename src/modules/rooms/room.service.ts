import { randomInt, randomUUID } from 'node:crypto';
import type { Actor } from '../../domain/actor.js';
import { AppError } from '../../lib/app-error.js';
import { requestHash } from '../../lib/command.js';
import type { SupabaseClients } from '../../lib/supabase.js';
import {
  canonicalRoomPin,
  decryptRoomPin,
  encryptRoomPin,
  type RoomPinCryptoConfig,
  RoomPinCryptoError,
  type RoomPinEnvelope
} from './room-pin-crypto.js';

export type RoomReasonCode =
  | 'OCCUPIED'
  | 'RESERVATION_CURRENT'
  | 'CLEANING_REQUIRED'
  | 'CANDLE_PRESENT'
  | 'OPERATION_BLOCKED'
  | 'ROOM_ISSUE_BLOCKED'
  | 'DATA_UNCONFIRMED';

export type RoomReservationPhase = 'none' | 'upcoming' | 'current';

export type RoomOccupancyStatus = 'VACANT' | 'OCCUPIED';
export type RoomReservationLifecycle =
  | 'NONE'
  | 'FUTURE'
  | 'RESERVATION_PRESENT'
  | 'ARRIVAL_PENDING'
  | 'OCCUPIED';
export type RoomReadinessStatus = 'READY' | 'CLEANING_REQUIRED' | 'CHECKIN_BLOCKED';
export type RoomPrimaryDisplayStatus =
  | 'BLOCKED'
  | 'OCCUPIED'
  | 'ARRIVAL_PENDING'
  | 'RESERVATION_PRESENT'
  | 'CLEANING_REQUIRED'
  | 'READY';
export type RoomBlockingReasonCode =
  | 'CANDLE_PRESENT'
  | 'OPERATION_BLOCKED'
  | 'ROOM_ISSUE_BLOCKED'
  | 'DATA_UNCONFIRMED';
export type RoomReadinessReasonCode =
  | RoomBlockingReasonCode
  | 'CLEANING_REQUIRED'
  | 'PIN_MISMATCH'
  | 'PIN_UNCONFIGURED';

export interface RoomSummary {
  id: string;
  roomNumber: string;
  roomTypeCode: string;
  roomTypeName: string;
  elevatorZone: 'A' | 'B' | 'C' | null;
  dataStatus: 'verified' | 'verification_required';
  stateVersion: number;
  evaluatedAt: string;
  reservationPhase: RoomReservationPhase;
  serverTime: string;
  occupancyStatus: RoomOccupancyStatus;
  reservationLifecycle: RoomReservationLifecycle;
  readinessStatus: RoomReadinessStatus;
  primaryDisplayStatus: RoomPrimaryDisplayStatus;
  nextReservationId: string | null;
  nextCheckInAt: string | null;
  nextCheckOutAt: string | null;
  blockingReasonCodes: RoomBlockingReasonCode[];
  readinessReasonCodes: RoomReadinessReasonCode[];
  occupied: boolean;
  cleaningRequired: boolean;
  candleCount: number;
  pinSyncStatus: 'verified' | 'mismatch' | 'unconfigured';
  allocationBlocked: boolean;
  allocationReady: boolean;
  reasonCodes: RoomReasonCode[];
}

export interface ChangeRoomMasterDataInput {
  roomId: string;
  roomTypeId: string;
  elevatorZone: 'A' | 'B' | 'C' | null;
  dataStatus: 'verified' | 'verification_required';
  dataStatusReason?: string | null;
  expectedVersion: number;
  reasonCode: string;
  idempotencyKey: string;
}

export type RoomOperationAction =
  | 'create_block'
  | 'release_block'
  | 'set_candle_count'
  | 'report_issue'
  | 'resolve_issue'
  | 'record_pin_sync';

export interface RoomOperationInput {
  roomId: string;
  action: RoomOperationAction;
  expectedRoomVersion: number;
  reasonCode: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}

export interface RoomOperationResult {
  entityId: string;
  roomId: string;
  roomStateVersion: number;
  recordedAt: string;
}

export interface RoomPinWorkBinding {
  assignmentId?: string;
  attemptId?: string;
  accessLeaseId?: string;
}

export interface PrepareRoomPinChangeInput extends RoomPinWorkBinding {
  roomId: string;
  pinDigits: string;
  expectedPinVersion: number;
  reasonCode: 'ADMIN_INITIAL_PIN' | 'ADMIN_PHYSICAL_CHANGE' | 'MAID_CLEANING_CHANGE' | 'ACTUAL_PIN_REENTRY';
  idempotencyKey: string;
}

export interface RoomPinChangeResult {
  leaseId: string;
  roomId: string;
  currentPinVersion?: number;
  proposedPinVersion?: number;
  pinVersion?: number;
  accessLeaseId?: string;
  status: string;
  expiresAt?: string;
  confirmedAt?: string;
  resolvedAt?: string;
}

export interface ConfirmRoomPinChangeInput {
  roomId: string;
  leaseId: string;
  expectedPinVersion: number;
  idempotencyKey: string;
}

export interface RevealRoomPinInput extends RoomPinWorkBinding {
  roomId: string;
}

export interface RevealedRoomPin {
  roomId: string;
  credential: string;
  pinVersion: number;
  clearAfterSeconds: number;
  expiresAt: string;
}

export interface BootstrapRoomPinsInput {
  limit: number;
  idempotencyKey: string;
}

export interface RoomPinBootstrapResult {
  initializedRoomIds: string[];
  skippedRoomIds: string[];
  initializedCount: number;
  skippedCount: number;
  remainingCount: number;
  completedAt: string;
  generatedPins: RevealedRoomPin[];
}

export interface ConfirmGeneratedRoomPinInput {
  roomId: string;
  expectedPinVersion: number;
  idempotencyKey: string;
}

export interface GeneratedRoomPinConfirmation {
  roomId: string;
  pinVersion: number;
  status: 'verified';
  confirmedAt: string;
}

export interface RoomTypeCatalogItem {
  id: string;
  code: string;
  displayName: string;
  baseCleaningFee: number;
  baseOccupancy: number;
  maxOccupancy: number;
  active: boolean;
  version: number;
  roomCount: number;
}

export interface DeveloperRoomCatalogRoom {
  id: string;
  roomNumber: string;
  roomTypeId: string;
  roomTypeCode: string;
  active: boolean;
  version: number;
}

export type DeveloperRoomTypeCatalogItem = Omit<RoomTypeCatalogItem, 'baseCleaningFee'>;

export interface DeveloperRoomCatalog {
  generatedAt: string;
  summary: {
    total: number;
    active: number;
    inactive: number;
  };
  roomTypes: DeveloperRoomTypeCatalogItem[];
  rooms: DeveloperRoomCatalogRoom[];
}

export interface PreviewRoomTypeCapacityInput {
  roomTypeId: string;
  baseOccupancy: number;
  maxOccupancy: number;
  expectedVersion: number;
}

export interface RoomTypeCapacityPreview {
  roomTypeId: string;
  current: { baseOccupancy: number; maxOccupancy: number; version: number };
  proposed: { baseOccupancy: number; maxOccupancy: number };
  roomCount: number;
  activeReservationCount: number;
  exceedingActiveReservationCount: number;
  reasonCodes: string[];
  impactFingerprint: string;
  evaluatedAt: string;
  expiresAt: string;
}

export interface ChangeRoomTypeCapacityInput extends PreviewRoomTypeCapacityInput {
  impactFingerprint: string;
  reasonCode: 'CAPACITY_POLICY_CHANGE';
  idempotencyKey: string;
}

export interface CreateDeveloperRoomInput {
  roomNumber: string;
  roomTypeId: string;
  expectedRoomTypeVersion: number;
  reasonCode: 'ROOM_CATALOG_ADD';
  idempotencyKey: string;
}

export interface PreviewRoomDeactivationInput {
  roomId: string;
  expectedVersion: number;
}

export interface RoomDeactivationPreview {
  roomId: string;
  currentlyOccupied: boolean;
  activeFutureReservationCount: number;
  activeCleaningTargetCount: number;
  activeAssignmentCount: number;
  activeAttemptCount: number;
  activePinChangeLease: boolean;
  unresolvedOperationCount: number;
  canDeactivate: boolean;
  reasonCodes: string[];
  impactFingerprint: string;
  evaluatedAt: string;
  expiresAt: string;
}

export interface DeactivateDeveloperRoomInput extends PreviewRoomDeactivationInput {
  impactFingerprint: string;
  reasonCode: 'ROOM_CATALOG_REMOVE';
  idempotencyKey: string;
}

export interface DeveloperRoomMutationResult {
  room: DeveloperRoomCatalogRoom;
  summary: DeveloperRoomCatalog['summary'];
  roomType?: DeveloperRoomTypeCatalogItem;
  effectiveAt: string;
}

export interface RoomTypeCapacityChangeResult {
  roomType: DeveloperRoomTypeCatalogItem;
  effectiveAt: string;
}

export interface RoomOperationBlockItem {
  id: string;
  reasonCode: string;
  startsAt: string;
  endsAt: string | null;
  status: 'scheduled' | 'active' | 'expired';
  createdAt: string;
}

export interface RoomIssueItem {
  id: string;
  category: string;
  severity: 'info' | 'warning' | 'critical';
  blocksGuestAssignment: boolean;
  description: string | null;
  status: 'open';
  reportedAt: string;
}

export interface RoomOperationBlocksResult {
  roomId: string;
  roomStateVersion: number;
  evaluatedAt: string;
  items: RoomOperationBlockItem[];
}

export interface RoomIssuesResult {
  roomId: string;
  roomStateVersion: number;
  evaluatedAt: string;
  items: RoomIssueItem[];
}

export interface RoomEventItem {
  id: string;
  eventKey: string;
  source: 'room_command' | 'occupancy';
  category: 'room_configuration' | 'room_block' | 'room_issue' | 'room_candle' | 'room_pin' | 'occupancy';
  eventType: string;
  actorProfileId: string | null;
  actorDisplayName: string | null;
  entityId: string;
  reasonCode: string | null;
  effectiveAt: string;
  recordedAt: string;
  reservationId: string | null;
  summary: Record<string, unknown>;
}

export interface RoomEventsResult {
  roomId: string;
  roomStateVersion: number;
  evaluatedAt: string;
  items: RoomEventItem[];
}

export interface RoomService {
  listTypes(actor: Actor): Promise<RoomTypeCatalogItem[]>;
  listOperationBlocks(actor: Actor, roomId: string): Promise<RoomOperationBlocksResult>;
  listIssues(actor: Actor, roomId: string): Promise<RoomIssuesResult>;
  listEvents(actor: Actor, roomId: string, limit: number): Promise<RoomEventsResult>;
  list(actor: Actor): Promise<RoomSummary[]>;
  get(actor: Actor, roomId: string): Promise<RoomSummary>;
  changeMasterData(actor: Actor, input: ChangeRoomMasterDataInput): Promise<RoomSummary>;
  mutateOperation(actor: Actor, input: RoomOperationInput): Promise<RoomOperationResult>;
  preparePinChange(actor: Actor, input: PrepareRoomPinChangeInput): Promise<RoomPinChangeResult>;
  confirmPinChange(actor: Actor, input: ConfirmRoomPinChangeInput): Promise<RoomPinChangeResult>;
  rollbackPinChange(actor: Actor, input: ConfirmRoomPinChangeInput): Promise<RoomPinChangeResult>;
  revealPin(actor: Actor, input: RevealRoomPinInput): Promise<RevealedRoomPin>;
  bootstrapPins(actor: Actor, input: BootstrapRoomPinsInput): Promise<RoomPinBootstrapResult>;
  confirmGeneratedPin(actor: Actor, input: ConfirmGeneratedRoomPinInput): Promise<GeneratedRoomPinConfirmation>;
  getDeveloperCatalog(actor: Actor): Promise<DeveloperRoomCatalog>;
  previewRoomTypeCapacity(actor: Actor, input: PreviewRoomTypeCapacityInput): Promise<RoomTypeCapacityPreview>;
  changeRoomTypeCapacity(actor: Actor, input: ChangeRoomTypeCapacityInput): Promise<RoomTypeCapacityChangeResult>;
  createDeveloperRoom(actor: Actor, input: CreateDeveloperRoomInput): Promise<DeveloperRoomMutationResult>;
  previewRoomDeactivation(actor: Actor, input: PreviewRoomDeactivationInput): Promise<RoomDeactivationPreview>;
  deactivateDeveloperRoom(actor: Actor, input: DeactivateDeveloperRoomInput): Promise<DeveloperRoomMutationResult>;
}

interface RoomProjectionRow {
  id: string;
  room_number: string;
  room_type_code: string;
  room_type_name: string;
  elevator_zone: 'A' | 'B' | 'C' | null;
  data_status: 'verified' | 'verification_required';
  state_version: number;
  evaluated_at: string;
  reservation_phase: RoomReservationPhase;
  server_time: string;
  occupancy_status: RoomOccupancyStatus;
  reservation_lifecycle: RoomReservationLifecycle;
  readiness_status: RoomReadinessStatus;
  primary_display_status: RoomPrimaryDisplayStatus;
  next_reservation_id: string | null;
  next_check_in_at: string | null;
  next_check_out_at: string | null;
  blocking_reason_codes: RoomBlockingReasonCode[];
  readiness_reason_codes: RoomReadinessReasonCode[];
  occupied: boolean;
  cleaning_required: boolean;
  candle_count: number;
  pin_sync_status: 'verified' | 'mismatch' | 'unconfigured';
  allocation_blocked: boolean;
  allocation_ready: boolean;
  reason_codes: RoomReasonCode[];
}

interface RoomTypeCatalogRow {
  id: string;
  code: string;
  display_name: string;
  base_cleaning_fee: number;
  base_occupancy: number;
  max_occupancy: number;
  active: boolean;
  version: number;
  room_count: number;
}

function toRoomTypeCatalogItem(row: RoomTypeCatalogRow): RoomTypeCatalogItem {
  return {
    id: row.id,
    code: row.code,
    displayName: row.display_name,
    baseCleaningFee: row.base_cleaning_fee,
    baseOccupancy: row.base_occupancy,
    maxOccupancy: row.max_occupancy,
    active: row.active,
    version: row.version,
    roomCount: row.room_count
  };
}

function toRoom(row: RoomProjectionRow): RoomSummary {
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
    reasonCodes: row.reason_codes
  };
}

function ensureAdmin(actor: Actor): void {
  if (actor.role !== 'admin') {
    throw new AppError(403, 'ADMIN_REQUIRED', '관리자만 객실 운영 현황을 조회할 수 있습니다.');
  }
}

function ensureDeveloper(actor: Actor): void {
  if (actor.role !== 'developer') {
    throw new AppError(403, 'DEVELOPER_REQUIRED', '개발자 권한이 필요합니다.');
  }
}

export function generateUniqueFourDigitPins(
  count: number,
  draw: () => number = () => randomInt(10_000)
): string[] {
  if (!Number.isSafeInteger(count) || count < 0 || count > 25) {
    throw new RangeError('PIN generation count must be between 0 and 25');
  }
  const values = new Set<number>();
  while (values.size < count) {
    const value = draw();
    if (!Number.isSafeInteger(value) || value < 0 || value >= 10_000) {
      throw new RangeError('PIN generator returned a value outside 0000-9999');
    }
    values.add(value);
  }
  return [...values].map((value) => value.toString().padStart(4, '0'));
}

function roomError(error: { message?: string } | null): AppError {
  const message = error?.message ?? '';
  if (message.includes('ROOM_TYPE_CAPACITY_INVALID')) {
    return new AppError(400, 'ROOM_TYPE_CAPACITY_INVALID', '기본 인원은 1명 이상이고 최대 인원을 넘을 수 없습니다.');
  }
  if (message.includes('ROOM_TYPE_CAPACITY_ACTIVE_RESERVATION_CONFLICT')) {
    return new AppError(409, 'ROOM_TYPE_CAPACITY_ACTIVE_RESERVATION_CONFLICT', '새 최대 인원을 초과하는 활성 예약이 있습니다.');
  }
  if (message.includes('ROOM_TYPE_CAPACITY_PREVIEW_STALE')) {
    return new AppError(409, 'ROOM_TYPE_CAPACITY_PREVIEW_STALE', '정원 변경 미리보기가 만료되었거나 영향 범위가 달라졌습니다.');
  }
  if (message.includes('ROOM_DEACTIVATION_PREVIEW_STALE')) {
    return new AppError(409, 'ROOM_DEACTIVATION_PREVIEW_STALE', '객실 비활성화 미리보기가 만료되었거나 영향 범위가 달라졌습니다.');
  }
  if (message.includes('ROOM_DEACTIVATION_BLOCKED')) {
    return new AppError(409, 'ROOM_DEACTIVATION_BLOCKED', '활성 예약 또는 진행 중인 운영 업무가 있어 객실을 비활성화할 수 없습니다.');
  }
  if (message.includes('ROOM_TYPE_VERSION_CONFLICT')) {
    return new AppError(409, 'ROOM_TYPE_VERSION_CONFLICT', '다른 객실 유형 변경이 먼저 반영됐습니다.');
  }
  if (message.includes('ROOM_VERSION_CONFLICT')) {
    return new AppError(409, 'ROOM_VERSION_CONFLICT', '다른 객실 변경이 먼저 반영됐습니다.');
  }
  if (message.includes('ROOM_NUMBER_ALREADY_EXISTS')) {
    return new AppError(409, 'ROOM_NUMBER_ALREADY_EXISTS', '이미 사용 중인 객실 번호입니다.');
  }
  if (message.includes('ROOM_TYPE_INACTIVE')) {
    return new AppError(409, 'ROOM_TYPE_INACTIVE', '비활성 객실 유형에는 객실을 추가할 수 없습니다.');
  }
  if (message.includes('ROOM_ALREADY_INACTIVE')) {
    return new AppError(409, 'ROOM_ALREADY_INACTIVE', '이미 비활성화된 객실입니다.');
  }
  if (message.includes('ROOM_TYPE_NOT_FOUND')) {
    return new AppError(404, 'ROOM_TYPE_NOT_FOUND', '객실 유형을 찾을 수 없습니다.');
  }
  if (message.includes('INVALID_ROOM_NUMBER')) {
    return new AppError(400, 'INVALID_ROOM_NUMBER', '객실 번호는 1~20자리 숫자여야 합니다.');
  }
  if (message.includes('CHECKOUT_INCIDENT_OPEN')) {
    return new AppError(409, 'CHECKOUT_INCIDENT_OPEN', '퇴실 미진행 사건을 관리자가 처리한 뒤 PIN 작업을 진행해 주세요.');
  }
  if (message.includes('STALE_VERSION')) {
    return new AppError(409, 'STALE_VERSION', '다른 객실 변경이 먼저 반영됐습니다.');
  }
  if (message.includes('IDEMPOTENCY_KEY_REUSED')) {
    return new AppError(409, 'IDEMPOTENCY_KEY_REUSED', '이미 다른 요청에 사용한 Idempotency-Key입니다.');
  }
  if (message.includes('STALE_PIN_VERSION')) {
    return new AppError(409, 'STALE_PIN_VERSION', '다른 PIN 변경이 먼저 반영됐습니다.');
  }
  if (message.includes('ROOM_NUMBER_CHANGED')) {
    return new AppError(409, 'ROOM_NUMBER_CHANGED', '객실 번호가 변경되어 PIN 준비 요청을 다시 시작해야 합니다.');
  }
  if (message.includes('INVALID_PIN_BOOTSTRAP_LIMIT')) {
    return new AppError(400, 'INVALID_PIN_BOOTSTRAP_LIMIT', '초기화 batch 크기는 1~25여야 합니다.');
  }
  if (message.includes('INVALID_PIN_BOOTSTRAP')) {
    return new AppError(400, 'INVALID_PIN_BOOTSTRAP', '객실 초기 PIN 요청이 올바르지 않습니다.');
  }
  if (message.includes('ROOM_PIN_REISSUE_REQUIRED')) {
    return new AppError(409, 'ROOM_PIN_REISSUE_REQUIRED', '객실 번호 변경 전 PIN 재발급 절차가 필요합니다.');
  }
  if (message.includes('ROOM_PIN_MISMATCH_UNRESOLVED')) {
    return new AppError(409, 'ROOM_PIN_MISMATCH_UNRESOLVED', '물리 도어락과 저장 상태의 불일치를 먼저 해소해 주세요.');
  }
  if (message.includes('INVALID_PIN_CHANGE_REASON')) {
    return new AppError(409, 'INVALID_PIN_CHANGE_REASON', '현재 PIN 상태와 변경 사유가 일치하지 않습니다.');
  }
  if (message.includes('PIN_CHANGE_IN_PROGRESS_REQUIRED')) {
    return new AppError(403, 'PIN_CHANGE_IN_PROGRESS_REQUIRED', 'PIN 변경은 현재 청소가 진행 중일 때만 가능합니다.');
  }
  if (message.includes('PIN_CHANGE_IN_PROGRESS')) {
    return new AppError(409, 'PIN_CHANGE_IN_PROGRESS', '이 객실의 PIN 변경 절차가 이미 진행 중입니다.');
  }
  if (message.includes('PIN_CHANGE_LEASE_EXPIRED')) {
    return new AppError(409, 'PIN_CHANGE_LEASE_EXPIRED', 'PIN 변경 확인 시간이 만료되었습니다.');
  }
  if (message.includes('PIN_CHANGE_LEASE_NOT_PREPARED') || message.includes('PIN_CHANGE_LEASE_NOT_RESOLVABLE')) {
    return new AppError(409, 'PIN_CHANGE_LEASE_NOT_RESOLVABLE', '현재 PIN 변경 절차를 확인하거나 해소할 수 없습니다.');
  }
  if (message.includes('PIN_REVEAL_AUTHORIZATION_CHANGED')) {
    return new AppError(403, 'PIN_REVEAL_AUTHORIZATION_CHANGED', 'PIN 응답 전 권한 또는 업무 상태가 변경되었습니다.');
  }
  if (message.includes('PIN_ENTITLEMENT_REQUIRED')) {
    return new AppError(403, 'PIN_ENTITLEMENT_REQUIRED', '현재 통보된 배정의 PIN 열람 권한이 필요합니다.');
  }
  if (message.includes('GENERATED_PIN_REVEAL_NOT_ALLOWED')) {
    return new AppError(409, 'GENERATED_PIN_REVEAL_NOT_ALLOWED', '생성된 PIN의 초기 열람 가능 상태가 아닙니다.');
  }
  if (message.includes('GENERATED_PIN_CONFIRMATION_NOT_ALLOWED')) {
    return new AppError(409, 'GENERATED_PIN_CONFIRMATION_NOT_ALLOWED', '생성된 PIN을 물리 도어락에 확인할 수 있는 상태가 아닙니다.');
  }
  if (message.includes('ROOM_PIN_UNCONFIGURED')) {
    return new AppError(404, 'ROOM_PIN_UNCONFIGURED', '등록된 객실 PIN이 없습니다.');
  }
  if (message.includes('SESSION_REVOKED')) {
    return new AppError(401, 'SESSION_REVOKED', '로그인이 만료되었습니다.');
  }
  if (message.includes('PIN_ACCESS_LEASE_REQUIRED')) {
    return new AppError(403, 'PIN_ACCESS_LEASE_REQUIRED', '현재 업무의 유효한 PIN 접근 권한이 필요합니다.');
  }
  if (message.includes('PIN_ACCESS_REQUIRED')) {
    return new AppError(403, 'PIN_ACCESS_REQUIRED', '현재 업무 상태에서는 객실 PIN에 접근할 수 없습니다.');
  }
  if (message.includes('ROOM_NOT_FOUND')) {
    return new AppError(404, 'ROOM_NOT_FOUND', '객실을 찾을 수 없습니다.');
  }
  if (message.includes('NOT_FOUND')) {
    return new AppError(404, 'ROOM_OPERATION_NOT_FOUND', '객실 운영 기록을 찾을 수 없습니다.');
  }
  if (message.includes('ALREADY_') || message.includes('INVALID_')) {
    return new AppError(409, 'INVALID_TRANSITION', '현재 객실 운영 상태에서는 요청을 처리할 수 없습니다.');
  }
  if (message.includes('ADMIN_REQUIRED') || message.includes('ACTIVE_ACCOUNT_REQUIRED')) {
    return new AppError(403, 'FORBIDDEN', '현재 계정으로 객실을 변경할 수 없습니다.');
  }
  if (message.includes('DEVELOPER_REQUIRED') || message.includes('PASSWORD_CHANGE_REQUIRED')) {
    return new AppError(403, 'DEVELOPER_REQUIRED', '개발자 권한이 필요합니다.');
  }
  return new AppError(500, 'ROOM_COMMAND_FAILED', '객실 정보를 처리하지 못했습니다.');
}

function pinCryptoError(error: unknown): AppError {
  if (error instanceof RoomPinCryptoError) {
    if (error.code === 'INVALID_ROOM_PIN') {
      return new AppError(400, 'INVALID_ROOM_PIN', 'PIN은 4~8자리 숫자 문자열이어야 합니다.');
    }
    if (error.code === 'ROOM_PIN_KEY_UNAVAILABLE') {
      return new AppError(503, 'ROOM_PIN_KEY_UNAVAILABLE', '해당 PIN 암호화 키를 사용할 수 없습니다.');
    }
    return new AppError(503, error.code, '객실 PIN 암호화 설정을 확인해 주세요.');
  }
  return new AppError(500, 'ROOM_PIN_COMMAND_FAILED', '객실 PIN을 처리하지 못했습니다.');
}

function verifiedSessionId(accessToken: string): string {
  try {
    const encoded = accessToken.split('.')[1];
    if (!encoded) throw new Error();
    const claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as { session_id?: unknown };
    if (typeof claims.session_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(claims.session_id)) throw new Error();
    return claims.session_id;
  } catch {
    throw new AppError(401, 'INVALID_ACCESS_TOKEN', '로그인이 필요합니다.');
  }
}

function envelopeFromRow(row: Record<string, unknown>): RoomPinEnvelope {
  return {
    envelopeFormat: row.envelope_format as 1,
    keyVersion: String(row.key_version),
    ciphertextBase64: String(row.ciphertext_base64),
    nonceBase64: String(row.nonce_base64),
    authTagBase64: String(row.auth_tag_base64)
    ,aadEnvironment: String(row.aad_environment)
    ,aadProjectRef: String(row.aad_project_ref)
  };
}

export function assertNoContactInformation(value: string | undefined): void {
  if (!value) {
    return;
  }
  const containsEmail = /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/.test(value);
  const containsPhone = /(?:\+?82[-.\s]?)?0?1[016789][-.\s]?\d{3,4}[-.\s]?\d{4}/.test(value);
  if (containsEmail || containsPhone) {
    throw new AppError(400, 'SENSITIVE_TEXT_NOT_ALLOWED', '특이사항에는 전화번호나 이메일을 입력할 수 없습니다.');
  }
}

export class SupabaseRoomService implements RoomService {
  constructor(
    private readonly clients: SupabaseClients,
    private readonly pinConfig?: RoomPinCryptoConfig
  ) {}

  private cryptoConfig(): RoomPinCryptoConfig {
    if (!this.pinConfig) throw new AppError(503, 'ROOM_PIN_NOT_CONFIGURED', '객실 PIN 암호화 설정이 필요합니다.');
    return this.pinConfig;
  }

  private async revealGeneratedPin(
    actor: Actor,
    sessionId: string,
    roomId: string
  ): Promise<RevealedRoomPin> {
    const requestId = randomUUID();
    const { data, error } = await this.clients.admin.rpc('begin_generated_room_pin_reveal', {
      p_actor_profile_id: actor.profileId,
      p_session_id: sessionId,
      p_room_id: roomId,
      p_request_id: requestId
    });
    if (error || !data) throw roomError(error);
    const row = data as Record<string, unknown>;
    let credential: string;
    try {
      credential = await decryptRoomPin(
        envelopeFromRow(row),
        roomId,
        String(row.room_number),
        Number(row.pin_version),
        this.cryptoConfig()
      );
    } catch (cryptoError) {
      throw pinCryptoError(cryptoError);
    }
    const { error: finalError } = await this.clients.admin.rpc('finalize_generated_room_pin_reveal', {
      p_actor_profile_id: actor.profileId,
      p_session_id: sessionId,
      p_room_id: roomId,
      p_reveal_lease_id: row.lease_id,
      p_request_id: requestId
    });
    if (finalError) throw roomError(finalError);
    const expiresAt = String(row.expires_at);
    const clearAfterSeconds = Math.min(30, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
    if (!Number.isFinite(clearAfterSeconds) || clearAfterSeconds <= 0) {
      throw new AppError(403, 'PIN_REVEAL_AUTHORIZATION_CHANGED', 'PIN 열람 권한이 변경되었습니다.');
    }
    return { roomId, credential, pinVersion: Number(row.pin_version), clearAfterSeconds, expiresAt };
  }

  async listTypes(actor: Actor): Promise<RoomTypeCatalogItem[]> {
    ensureAdmin(actor);
    const { data, error } = await this.clients.admin.rpc('list_room_type_catalog', {
      p_actor_profile_id: actor.profileId,
      p_session_id: verifiedSessionId(actor.accessToken)
    });
    if (error) {
      throw roomError(error);
    }
    return ((data ?? []) as RoomTypeCatalogRow[]).map(toRoomTypeCatalogItem);
  }

  async getDeveloperCatalog(actor: Actor): Promise<DeveloperRoomCatalog> {
    ensureDeveloper(actor);
    const { data, error } = await this.clients.admin.rpc('get_developer_room_catalog', {
      p_actor_profile_id: actor.profileId
    });
    if (error || !data) throw roomError(error);
    return data as unknown as DeveloperRoomCatalog;
  }

  async previewRoomTypeCapacity(
    actor: Actor,
    input: PreviewRoomTypeCapacityInput
  ): Promise<RoomTypeCapacityPreview> {
    ensureDeveloper(actor);
    const { data, error } = await this.clients.admin.rpc('preview_developer_room_type_capacity', {
      p_actor_profile_id: actor.profileId,
      p_room_type_id: input.roomTypeId,
      p_base_occupancy: input.baseOccupancy,
      p_max_occupancy: input.maxOccupancy,
      p_expected_version: input.expectedVersion
    });
    if (error || !data) throw roomError(error);
    return data as unknown as RoomTypeCapacityPreview;
  }

  async changeRoomTypeCapacity(
    actor: Actor,
    input: ChangeRoomTypeCapacityInput
  ): Promise<RoomTypeCapacityChangeResult> {
    ensureDeveloper(actor);
    const fingerprint = {
      roomTypeId: input.roomTypeId,
      baseOccupancy: input.baseOccupancy,
      maxOccupancy: input.maxOccupancy,
      expectedVersion: input.expectedVersion,
      impactFingerprint: input.impactFingerprint,
      reasonCode: input.reasonCode
    };
    const { data, error } = await this.clients.admin.rpc('change_developer_room_type_capacity', {
      p_actor_profile_id: actor.profileId,
      p_room_type_id: input.roomTypeId,
      p_base_occupancy: input.baseOccupancy,
      p_max_occupancy: input.maxOccupancy,
      p_expected_version: input.expectedVersion,
      p_impact_fingerprint: input.impactFingerprint,
      p_reason_code: input.reasonCode,
      p_idempotency_key: input.idempotencyKey,
      p_request_hash: requestHash(fingerprint)
    });
    if (error || !data) throw roomError(error);
    return data as unknown as RoomTypeCapacityChangeResult;
  }

  async createDeveloperRoom(
    actor: Actor,
    input: CreateDeveloperRoomInput
  ): Promise<DeveloperRoomMutationResult> {
    ensureDeveloper(actor);
    const fingerprint = {
      roomNumber: input.roomNumber,
      roomTypeId: input.roomTypeId,
      expectedRoomTypeVersion: input.expectedRoomTypeVersion,
      reasonCode: input.reasonCode
    };
    const { data, error } = await this.clients.admin.rpc('create_developer_room', {
      p_actor_profile_id: actor.profileId,
      p_room_id: randomUUID(),
      p_room_number: input.roomNumber,
      p_room_type_id: input.roomTypeId,
      p_expected_room_type_version: input.expectedRoomTypeVersion,
      p_reason_code: input.reasonCode,
      p_idempotency_key: input.idempotencyKey,
      p_request_hash: requestHash(fingerprint)
    });
    if (error || !data) throw roomError(error);
    return data as unknown as DeveloperRoomMutationResult;
  }

  async previewRoomDeactivation(
    actor: Actor,
    input: PreviewRoomDeactivationInput
  ): Promise<RoomDeactivationPreview> {
    ensureDeveloper(actor);
    const { data, error } = await this.clients.admin.rpc('preview_developer_room_deactivation', {
      p_actor_profile_id: actor.profileId,
      p_room_id: input.roomId,
      p_expected_version: input.expectedVersion
    });
    if (error || !data) throw roomError(error);
    return data as unknown as RoomDeactivationPreview;
  }

  async deactivateDeveloperRoom(
    actor: Actor,
    input: DeactivateDeveloperRoomInput
  ): Promise<DeveloperRoomMutationResult> {
    ensureDeveloper(actor);
    const fingerprint = {
      roomId: input.roomId,
      expectedVersion: input.expectedVersion,
      impactFingerprint: input.impactFingerprint,
      reasonCode: input.reasonCode
    };
    const { data, error } = await this.clients.admin.rpc('deactivate_developer_room', {
      p_actor_profile_id: actor.profileId,
      p_room_id: input.roomId,
      p_expected_version: input.expectedVersion,
      p_impact_fingerprint: input.impactFingerprint,
      p_reason_code: input.reasonCode,
      p_idempotency_key: input.idempotencyKey,
      p_request_hash: requestHash(fingerprint)
    });
    if (error || !data) throw roomError(error);
    return data as unknown as DeveloperRoomMutationResult;
  }

  async listOperationBlocks(actor: Actor, roomId: string): Promise<RoomOperationBlocksResult> {
    ensureAdmin(actor);
    const { data, error } = await this.clients.admin.rpc('list_room_operation_blocks', {
      p_actor_profile_id: actor.profileId,
      p_session_id: verifiedSessionId(actor.accessToken),
      p_room_id: roomId,
      p_status: 'actionable'
    });
    if (error) throw roomError(error);
    return data as unknown as RoomOperationBlocksResult;
  }

  async listIssues(actor: Actor, roomId: string): Promise<RoomIssuesResult> {
    ensureAdmin(actor);
    const { data, error } = await this.clients.admin.rpc('list_room_issues', {
      p_actor_profile_id: actor.profileId,
      p_session_id: verifiedSessionId(actor.accessToken),
      p_room_id: roomId,
      p_status: 'open'
    });
    if (error) throw roomError(error);
    return data as unknown as RoomIssuesResult;
  }

  async listEvents(actor: Actor, roomId: string, limit: number): Promise<RoomEventsResult> {
    ensureAdmin(actor);
    const { data, error } = await this.clients.admin.rpc('list_room_events', {
      p_actor_profile_id: actor.profileId,
      p_session_id: verifiedSessionId(actor.accessToken),
      p_room_id: roomId,
      p_limit: limit
    });
    if (error) throw roomError(error);
    return data as unknown as RoomEventsResult;
  }

  async list(actor: Actor): Promise<RoomSummary[]> {
    ensureAdmin(actor);
    const { data, error } = await this.clients.admin.rpc('get_room_operational_projection', {
      p_actor_profile_id: actor.profileId,
      p_room_id: null
    });
    if (error) {
      throw roomError(error);
    }
    return ((data ?? []) as RoomProjectionRow[]).map(toRoom);
  }

  async get(actor: Actor, roomId: string): Promise<RoomSummary> {
    ensureAdmin(actor);
    const { data, error } = await this.clients.admin.rpc('get_room_operational_projection', {
      p_actor_profile_id: actor.profileId,
      p_room_id: roomId
    });
    if (error) {
      throw roomError(error);
    }
    const row = (data as RoomProjectionRow[] | null)?.[0];
    if (!row) {
      throw new AppError(404, 'ROOM_NOT_FOUND', '객실을 찾을 수 없습니다.');
    }
    return toRoom(row);
  }

  async changeMasterData(actor: Actor, input: ChangeRoomMasterDataInput): Promise<RoomSummary> {
    const fingerprint = {
      roomId: input.roomId,
      roomTypeId: input.roomTypeId,
      elevatorZone: input.elevatorZone,
      dataStatus: input.dataStatus,
      dataStatusReason: input.dataStatusReason ?? null,
      expectedVersion: input.expectedVersion,
      reasonCode: input.reasonCode
    };
    const { error } = await this.clients.admin.rpc('change_room_master_data', {
      p_actor_profile_id: actor.profileId,
      p_room_id: input.roomId,
      p_room_type_id: input.roomTypeId,
      p_elevator_zone: input.elevatorZone,
      p_data_status: input.dataStatus,
      p_data_status_reason: input.dataStatusReason ?? null,
      p_expected_version: input.expectedVersion,
      p_reason_code: input.reasonCode,
      p_idempotency_key: input.idempotencyKey,
      p_request_hash: requestHash(fingerprint)
    });
    if (error) {
      throw roomError(error);
    }
    return this.get(actor, input.roomId);
  }

  async mutateOperation(actor: Actor, input: RoomOperationInput): Promise<RoomOperationResult> {
    if (input.action === 'report_issue') {
      assertNoContactInformation(input.payload.description as string | undefined);
    }
    const payload = {
      ...input.payload,
      entityId: (input.payload.entityId as string | undefined) ?? randomUUID()
    };
    const fingerprint = {
      roomId: input.roomId,
      action: input.action,
      expectedRoomVersion: input.expectedRoomVersion,
      reasonCode: input.reasonCode,
      payload: input.payload
    };
    const { data, error } = await this.clients.admin.rpc('mutate_room_operation', {
      p_actor_profile_id: actor.profileId,
      p_room_id: input.roomId,
      p_action: input.action,
      p_expected_room_version: input.expectedRoomVersion,
      p_reason_code: input.reasonCode,
      p_payload: payload,
      p_idempotency_key: input.idempotencyKey,
      p_request_hash: requestHash(fingerprint)
    });
    if (error || !data) {
      throw roomError(error);
    }
    const row = data as {
      entity_id: string;
      room_id: string;
      room_state_version: number;
      recorded_at: string;
    };
    return {
      entityId: row.entity_id,
      roomId: row.room_id,
      roomStateVersion: row.room_state_version,
      recordedAt: row.recorded_at
    };
  }

  async preparePinChange(actor: Actor, input: PrepareRoomPinChangeInput): Promise<RoomPinChangeResult> {
    const sessionId = verifiedSessionId(actor.accessToken);
    const binding = {
      p_assignment_id: input.assignmentId ?? null,
      p_attempt_id: input.attemptId ?? null,
      p_access_lease_id: input.accessLeaseId ?? null
    };
    const { data: contextData, error: contextError } = await this.clients.admin.rpc('get_room_pin_change_context', {
      p_actor_profile_id: actor.profileId,
      p_session_id: sessionId,
      p_room_id: input.roomId,
      p_expected_pin_version: input.expectedPinVersion,
      ...binding
    });
    if (contextError || !contextData) throw roomError(contextError);
    const context = contextData as Record<string, unknown>;
    const roomNumber = String(context.room_number);
    const currentPinVersion = Number(context.current_pin_version);
    const proposedVersion = Number(context.proposed_pin_version);
    const effectiveReasonCode = currentPinVersion === 0 && input.reasonCode === 'ADMIN_PHYSICAL_CHANGE'
      ? 'ADMIN_INITIAL_PIN'
      : input.reasonCode;
    let canonical: string;
    let envelope: RoomPinEnvelope;
    try {
      canonical = canonicalRoomPin(roomNumber, input.pinDigits);
      envelope = await encryptRoomPin(canonical, input.roomId, proposedVersion, this.cryptoConfig());
    } catch (error) {
      throw pinCryptoError(error);
    }
    const fingerprint = {
      roomId: input.roomId,
      roomNumber,
      expectedPinVersion: input.expectedPinVersion,
      assignmentId: input.assignmentId ?? null,
      attemptId: input.attemptId ?? null,
      accessLeaseId: input.accessLeaseId ?? null,
      reasonCode: effectiveReasonCode
    };
    const { data, error } = await this.clients.admin.rpc('prepare_room_pin_change', {
      p_actor_profile_id: actor.profileId,
      p_session_id: sessionId,
      p_room_id: input.roomId,
      p_expected_pin_version: input.expectedPinVersion,
      p_room_number_snapshot: roomNumber,
      ...binding,
      p_reason_code: effectiveReasonCode,
      p_envelope_format: envelope.envelopeFormat,
      p_ciphertext_base64: envelope.ciphertextBase64,
      p_nonce_base64: envelope.nonceBase64,
      p_auth_tag_base64: envelope.authTagBase64,
      p_key_version: envelope.keyVersion,
      p_aad_environment: envelope.aadEnvironment,
      p_aad_project_ref: envelope.aadProjectRef,
      p_idempotency_key: input.idempotencyKey,
      p_request_hash: requestHash(fingerprint)
    });
    if (error || !data) throw roomError(error);
    const row = data as Record<string, unknown>;
    if (row.replay === true) {
      try {
        const replayed = await decryptRoomPin(envelopeFromRow(row), input.roomId, roomNumber,
          Number(row.proposed_pin_version), this.cryptoConfig());
        if (replayed !== canonical) throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', '이미 다른 요청에 사용한 Idempotency-Key입니다.');
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (error instanceof RoomPinCryptoError && error.code === 'ROOM_PIN_DECRYPT_FAILED') {
          throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', '이미 다른 요청에 사용한 Idempotency-Key입니다.');
        }
        throw pinCryptoError(error);
      }
    }
    return {
      leaseId: String(row.lease_id), roomId: String(row.room_id),
      currentPinVersion: Number(row.current_pin_version), proposedPinVersion: Number(row.proposed_pin_version),
      status: String(row.status), expiresAt: String(row.expires_at)
    };
  }

  async confirmPinChange(actor: Actor, input: ConfirmRoomPinChangeInput): Promise<RoomPinChangeResult> {
    const fingerprint = { roomId: input.roomId, leaseId: input.leaseId, expectedPinVersion: input.expectedPinVersion };
    const { data, error } = await this.clients.admin.rpc('confirm_room_pin_change', {
      p_actor_profile_id: actor.profileId, p_session_id: verifiedSessionId(actor.accessToken),
      p_room_id: input.roomId, p_lease_id: input.leaseId, p_expected_pin_version: input.expectedPinVersion,
      p_idempotency_key: input.idempotencyKey, p_request_hash: requestHash(fingerprint)
    });
    if (error || !data) throw roomError(error);
    const row = data as Record<string, unknown>;
    return {
      leaseId: String(row.lease_id), roomId: String(row.room_id), pinVersion: Number(row.pin_version),
      ...(row.access_lease_id === undefined ? {} : { accessLeaseId: String(row.access_lease_id) }),
      status: String(row.status), confirmedAt: String(row.confirmed_at)
    };
  }

  async rollbackPinChange(actor: Actor, input: ConfirmRoomPinChangeInput): Promise<RoomPinChangeResult> {
    const fingerprint = { roomId: input.roomId, leaseId: input.leaseId, expectedPinVersion: input.expectedPinVersion };
    const { data, error } = await this.clients.admin.rpc('rollback_room_pin_change', {
      p_actor_profile_id: actor.profileId, p_session_id: verifiedSessionId(actor.accessToken),
      p_room_id: input.roomId, p_lease_id: input.leaseId, p_expected_pin_version: input.expectedPinVersion,
      p_idempotency_key: input.idempotencyKey, p_request_hash: requestHash(fingerprint)
    });
    if (error || !data) throw roomError(error);
    const row = data as Record<string, unknown>;
    return {
      leaseId: String(row.lease_id), roomId: String(row.room_id), pinVersion: Number(row.pin_version),
      status: String(row.status), resolvedAt: String(row.resolved_at)
    };
  }

  async revealPin(actor: Actor, input: RevealRoomPinInput): Promise<RevealedRoomPin> {
    const sessionId = verifiedSessionId(actor.accessToken);
    const requestId = randomUUID();
    const { data, error } = await this.clients.admin.rpc('begin_room_pin_reveal', {
      p_actor_profile_id: actor.profileId, p_session_id: sessionId, p_room_id: input.roomId,
      p_assignment_id: input.assignmentId ?? null, p_attempt_id: input.attemptId ?? null,
      p_access_lease_id: input.accessLeaseId ?? null, p_request_id: requestId
    });
    if (error || !data) throw roomError(error);
    const row = data as Record<string, unknown>;
    let credential: string;
    try {
      credential = await decryptRoomPin(envelopeFromRow(row), input.roomId, String(row.room_number),
        Number(row.pin_version), this.cryptoConfig());
    } catch (cryptoError) {
      throw pinCryptoError(cryptoError);
    }
    const { error: finalError } = await this.clients.admin.rpc('finalize_room_pin_reveal', {
      p_actor_profile_id: actor.profileId, p_session_id: sessionId, p_room_id: input.roomId,
      p_reveal_lease_id: row.lease_id, p_request_id: requestId
    });
    if (finalError) throw roomError(finalError);
    const expiresAt = String(row.expires_at);
    const clearAfterSeconds = Math.min(30, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
    if (!Number.isFinite(clearAfterSeconds) || clearAfterSeconds <= 0) {
      throw new AppError(403, 'PIN_REVEAL_AUTHORIZATION_CHANGED', 'PIN 열람 권한이 변경되었습니다.');
    }
    return { roomId: input.roomId, credential, pinVersion: Number(row.pin_version), clearAfterSeconds, expiresAt };
  }

  async bootstrapPins(actor: Actor, input: BootstrapRoomPinsInput): Promise<RoomPinBootstrapResult> {
    ensureAdmin(actor);
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 25) {
      throw new AppError(400, 'INVALID_PIN_BOOTSTRAP_LIMIT', '초기화 batch 크기는 1~25여야 합니다.');
    }
    const sessionId = verifiedSessionId(actor.accessToken);
    const { data: contextData, error: contextError } = await this.clients.admin.rpc(
      'get_room_pin_bootstrap_context',
      {
        p_actor_profile_id: actor.profileId,
        p_session_id: sessionId,
        p_limit: input.limit
      }
    );
    if (contextError || !contextData) throw roomError(contextError);
    const context = contextData as Record<string, unknown>;
    if (!Array.isArray(context.candidates)) {
      throw new AppError(500, 'ROOM_PIN_BOOTSTRAP_FAILED', '객실 초기 PIN 대상을 확인하지 못했습니다.');
    }
    const digitsByCandidate = generateUniqueFourDigitPins(context.candidates.length);
    const candidates = await Promise.all(context.candidates.map(async (value, index) => {
      const candidate = value as Record<string, unknown>;
      const roomId = String(candidate.room_id ?? '');
      const roomNumber = String(candidate.room_number ?? '');
      const proposedPinVersion = Number(candidate.proposed_pin_version);
      const pinDigits = digitsByCandidate[index];
      if (!/^[0-9a-f-]{36}$/i.test(roomId) || !roomNumber || proposedPinVersion !== 1 || !pinDigits) {
        throw new AppError(500, 'ROOM_PIN_BOOTSTRAP_FAILED', '객실 초기 PIN 대상이 올바르지 않습니다.');
      }
      let envelope: RoomPinEnvelope;
      try {
        envelope = await encryptRoomPin(
          canonicalRoomPin(roomNumber, pinDigits),
          roomId,
          proposedPinVersion,
          this.cryptoConfig()
        );
      } catch (error) {
        throw pinCryptoError(error);
      }
      return {
        roomId,
        roomNumber,
        envelopeFormat: envelope.envelopeFormat,
        ciphertextBase64: envelope.ciphertextBase64,
        nonceBase64: envelope.nonceBase64,
        authTagBase64: envelope.authTagBase64,
        keyVersion: envelope.keyVersion,
        aadEnvironment: envelope.aadEnvironment,
        aadProjectRef: envelope.aadProjectRef
      };
    }));
    const { data, error } = await this.clients.admin.rpc('bootstrap_room_pins', {
      p_actor_profile_id: actor.profileId,
      p_session_id: sessionId,
      p_candidates: candidates,
      p_idempotency_key: input.idempotencyKey,
      p_request_hash: requestHash({ operation: 'room.pin.bootstrap', limit: input.limit })
    });
    if (error || !data) throw roomError(error);
    const result = data as Record<string, unknown>;
    const initializedRoomIds = result.initialized_room_ids as string[];
    const generatedPins = await Promise.all(
      initializedRoomIds.map((roomId) => this.revealGeneratedPin(actor, sessionId, roomId))
    );
    return {
      initializedRoomIds,
      skippedRoomIds: result.skipped_room_ids as string[],
      initializedCount: Number(result.initialized_count),
      skippedCount: Number(result.skipped_count),
      remainingCount: Number(result.remaining_count),
      completedAt: String(result.completed_at),
      generatedPins
    };
  }

  async confirmGeneratedPin(
    actor: Actor,
    input: ConfirmGeneratedRoomPinInput
  ): Promise<GeneratedRoomPinConfirmation> {
    ensureAdmin(actor);
    const fingerprint = {
      roomId: input.roomId,
      expectedPinVersion: input.expectedPinVersion
    };
    const { data, error } = await this.clients.admin.rpc('confirm_generated_room_pin', {
      p_actor_profile_id: actor.profileId,
      p_session_id: verifiedSessionId(actor.accessToken),
      p_room_id: input.roomId,
      p_expected_pin_version: input.expectedPinVersion,
      p_idempotency_key: input.idempotencyKey,
      p_request_hash: requestHash(fingerprint)
    });
    if (error || !data) throw roomError(error);
    const result = data as Record<string, unknown>;
    return {
      roomId: String(result.room_id),
      pinVersion: Number(result.pin_version),
      status: 'verified',
      confirmedAt: String(result.confirmed_at)
    };
  }
}
