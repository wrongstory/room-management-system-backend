import { randomUUID } from 'node:crypto';
import type { Actor } from '../../domain/actor.js';
import { requestHash } from '../../lib/command.js';
import { AppError } from '../../lib/app-error.js';
import type { SupabaseClients } from '../../lib/supabase.js';

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

export interface RoomService {
  list(actor: Actor): Promise<RoomSummary[]>;
  get(actor: Actor, roomId: string): Promise<RoomSummary>;
  changeMasterData(actor: Actor, input: ChangeRoomMasterDataInput): Promise<RoomSummary>;
  mutateOperation(actor: Actor, input: RoomOperationInput): Promise<RoomOperationResult>;
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

function roomError(error: { message?: string } | null): AppError {
  const message = error?.message ?? '';
  if (message.includes('STALE_VERSION')) {
    return new AppError(409, 'STALE_VERSION', '다른 객실 변경이 먼저 반영됐습니다.');
  }
  if (message.includes('IDEMPOTENCY_KEY_REUSED')) {
    return new AppError(409, 'IDEMPOTENCY_KEY_REUSED', '이미 다른 요청에 사용한 Idempotency-Key입니다.');
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
  constructor(private readonly clients: SupabaseClients) {}

  async list(actor: Actor): Promise<RoomSummary[]> {
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
}
