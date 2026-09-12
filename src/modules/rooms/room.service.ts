import { randomUUID } from 'node:crypto';
import type { Actor } from '../../domain/actor.js';
import { requestHash } from '../../lib/command.js';
import { AppError } from '../../lib/app-error.js';
import type { SupabaseClients } from '../../lib/supabase.js';
import {
  canonicalRoomPin,
  decryptRoomPin,
  encryptRoomPin,
  RoomPinCryptoError,
  type RoomPinCryptoConfig,
  type RoomPinEnvelope
} from './room-pin-crypto.js';

export type RoomReasonCode =
  | 'OCCUPIED'
  | 'CLEANING_REQUIRED'
  | 'CANDLE_PRESENT'
  | 'OPERATION_BLOCKED'
  | 'ROOM_ISSUE_BLOCKED'
  | 'PIN_MISMATCH'
  | 'DATA_UNCONFIRMED';

export interface RoomSummary {
  id: string;
  roomNumber: string;
  roomTypeCode: string;
  roomTypeName: string;
  elevatorZone: 'A' | 'B' | 'C' | null;
  dataStatus: 'verified' | 'verification_required';
  stateVersion: number;
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

export interface RoomService {
  list(actor: Actor): Promise<RoomSummary[]>;
  get(actor: Actor, roomId: string): Promise<RoomSummary>;
  changeMasterData(actor: Actor, input: ChangeRoomMasterDataInput): Promise<RoomSummary>;
  mutateOperation(actor: Actor, input: RoomOperationInput): Promise<RoomOperationResult>;
  preparePinChange(actor: Actor, input: PrepareRoomPinChangeInput): Promise<RoomPinChangeResult>;
  confirmPinChange(actor: Actor, input: ConfirmRoomPinChangeInput): Promise<RoomPinChangeResult>;
  rollbackPinChange(actor: Actor, input: ConfirmRoomPinChangeInput): Promise<RoomPinChangeResult>;
  revealPin(actor: Actor, input: RevealRoomPinInput): Promise<RevealedRoomPin>;
}

interface RoomProjectionRow {
  id: string;
  room_number: string;
  room_type_code: string;
  room_type_name: string;
  elevator_zone: 'A' | 'B' | 'C' | null;
  data_status: 'verified' | 'verification_required';
  state_version: number;
  occupied: boolean;
  cleaning_required: boolean;
  candle_count: number;
  pin_sync_status: 'verified' | 'mismatch' | 'unconfigured';
  allocation_blocked: boolean;
  allocation_ready: boolean;
  reason_codes: RoomReasonCode[];
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

function roomError(error: { message?: string } | null): AppError {
  const message = error?.message ?? '';
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
  if (message.includes('ROOM_PIN_REISSUE_REQUIRED')) {
    return new AppError(409, 'ROOM_PIN_REISSUE_REQUIRED', '객실 번호 변경 전 PIN 재발급 절차가 필요합니다.');
  }
  if (message.includes('ROOM_PIN_MISMATCH_UNRESOLVED')) {
    return new AppError(409, 'ROOM_PIN_MISMATCH_UNRESOLVED', '물리 도어락과 저장 상태의 불일치를 먼저 해소해 주세요.');
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
    const proposedVersion = Number(context.proposed_pin_version);
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
      reasonCode: input.reasonCode
    };
    const { data, error } = await this.clients.admin.rpc('prepare_room_pin_change', {
      p_actor_profile_id: actor.profileId,
      p_session_id: sessionId,
      p_room_id: input.roomId,
      p_expected_pin_version: input.expectedPinVersion,
      p_room_number_snapshot: roomNumber,
      ...binding,
      p_reason_code: input.reasonCode,
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
}
