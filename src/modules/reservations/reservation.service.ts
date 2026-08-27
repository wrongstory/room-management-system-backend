import { randomUUID } from 'node:crypto';
import type { Actor } from '../../domain/actor.js';
import { requestHash } from '../../lib/command.js';
import { AppError } from '../../lib/app-error.js';
import type { SupabaseClients } from '../../lib/supabase.js';
import { decryptGuestName, encryptGuestName, normalizeGuestName } from './guest-name-crypto.js';

export type ReservationStatus = 'active' | 'cancelled' | 'checked_out';

export interface Reservation {
  id: string;
  roomId: string;
  checkInAt: string;
  checkOutAt: string;
  guestCount: number;
  guestName: string | null;
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

export type ReservationCommandResult = Omit<Reservation, 'guestName'> & {
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

export interface ReservationMutationInput {
  reservationId: string;
  expectedVersion: number;
  reasonCode: string;
  idempotencyKey: string;
}

export interface TransitionResult {
  asOf: string;
  checkedInCount: number;
  checkedOutCount: number;
  blockedCheckInCount: number;
}

export interface ReservationService {
  list(actor: Actor, roomId?: string): Promise<Reservation[]>;
  create(actor: Actor, input: CreateReservationInput): Promise<ReservationCommandResult>;
  change(actor: Actor, input: ChangeReservationInput): Promise<ReservationCommandResult>;
  cancel(actor: Actor, input: ReservationMutationInput): Promise<ReservationCommandResult>;
  manualCheckout(actor: Actor, input: ReservationMutationInput): Promise<ReservationCommandResult>;
  processDue(actor: Actor, idempotencyKey: string): Promise<TransitionResult>;
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

function ensureAdmin(actor: Actor): void {
  if (actor.role !== 'admin') {
    throw new AppError(403, 'ADMIN_REQUIRED', '관리자만 예약을 관리할 수 있습니다.');
  }
}

function reservationError(error: { code?: string; message?: string; details?: string } | null): AppError {
  const message = error?.message ?? '';
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
    return new AppError(409, 'IDEMPOTENCY_KEY_REUSED', '이미 다른 요청에 사용한 Idempotency-Key입니다.');
  }
  if (message.includes('ROOM_NOT_FOUND')) {
    return new AppError(404, 'ROOM_NOT_FOUND', '객실을 찾을 수 없습니다.');
  }
  if (message.includes('RESERVATION_NOT_FOUND')) {
    return new AppError(404, 'RESERVATION_NOT_FOUND', '예약을 찾을 수 없습니다.');
  }
  if (message.includes('INVALID_RESERVATION_SCHEDULE')) {
    return new AppError(400, 'INVALID_RESERVATION_SCHEDULE', '예약은 분 단위이며 최소 1박이어야 합니다.');
  }
  if (
    message.includes('INVALID_TRANSITION') ||
    message.includes('NOT_ALLOWED') ||
    message.includes('IMMUTABLE') ||
    message.includes('CONFLICT') ||
    message.includes('REPLAN_REQUIRED') ||
    message.includes('SCHEDULE_LOCKED')
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

export class SupabaseReservationService implements ReservationService {
  constructor(
    private readonly clients: SupabaseClients,
    private readonly piiKey: string,
    private readonly piiKeyVersion: string
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
      guestName: row.guest_name_encrypted
        ? decryptGuestName(row.guest_name_encrypted, this.piiKey, this.piiKeyVersion)
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
    }));
  }

  async create(actor: Actor, input: CreateReservationInput): Promise<ReservationCommandResult> {
    ensureAdmin(actor);
    const guestName = input.guestName == null ? null : normalizeGuestName(input.guestName);
    const fingerprint = {
      roomId: input.roomId,
      checkInAt: input.checkInAt,
      checkOutAt: input.checkOutAt,
      guestCount: input.guestCount,
      guestName,
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
      guestName,
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
    };
    return {
      asOf: row.as_of,
      checkedInCount: row.checked_in_count,
      checkedOutCount: row.checked_out_count,
      blockedCheckInCount: row.blocked_check_in_count
    };
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
