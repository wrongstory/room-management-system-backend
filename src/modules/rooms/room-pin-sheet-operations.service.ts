import { createHash } from 'node:crypto';
import type { Actor } from '../../domain/actor.js';
import { AppError } from '../../lib/app-error.js';
import type { SupabaseClients } from '../../lib/supabase.js';
import {
  assertApprovedRoomPinSheetTarget,
  type GoogleSheetsServiceAccount,
  type RoomPinSheetTarget,
  RoomPinSheetProviderError,
  roomPinSheetTargetDigest,
  validateGoogleSheetsServiceAccount
} from './google-sheets-pin.js';
import { validateRoomPinCryptoConfig, type RoomPinCryptoConfig, RoomPinCryptoError } from './room-pin-crypto.js';

export interface RoomPinSheetOperationsConfig {
  target: RoomPinSheetTarget;
  serviceAccount: GoogleSheetsServiceAccount;
  crypto: RoomPinCryptoConfig;
}
export interface RoomPinSheetStatus {
  pending: number;
  failed: number;
  operatorBlocked: boolean;
  oldestPendingAt: string | null;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  version: number;
  checkedAt: string;
}
export interface RoomPinSheetOperationsService {
  status(actor: Actor): Promise<RoomPinSheetStatus>;
  requestFullResync(actor: Actor, expectedVersion: number, idempotencyKey: string): Promise<{
    status: 'pending'; roomCount: 121; version: number;
  }>;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const errorCodePattern = /^[A-Z0-9_]{2,80}$/;

function sessionId(actor: Actor): string {
  try {
    const payload = JSON.parse(Buffer.from(actor.accessToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as { session_id?: unknown };
    if (typeof payload.session_id !== 'string' || !uuidPattern.test(payload.session_id)) throw new Error();
    return payload.session_id.toLowerCase();
  } catch {
    throw new AppError(401, 'INVALID_ACCESS_TOKEN', '로그인이 필요합니다.');
  }
}

function dbError(error: { message?: string } | null): AppError {
  const message = error?.message ?? '';
  const mappings: Array<[string, number, string, string]> = [
    ['SESSION_REVOKED', 401, 'SESSION_REVOKED', '로그인이 만료되었습니다. 다시 로그인해 주세요.'],
    ['ROOM_PIN_SHEET_OPERATOR_REQUIRED', 403, 'ROOM_PIN_SHEET_OPERATOR_REQUIRED', 'PIN Sheet 운영 권한이 필요합니다.'],
    ['PASSWORD_CHANGE_REQUIRED', 403, 'PASSWORD_CHANGE_REQUIRED', '계속하려면 먼저 임시 비밀번호를 변경해 주세요.'],
    ['ROOM_PIN_SHEET_FULL_RESYNC_STALE', 409, 'ROOM_PIN_SHEET_FULL_RESYNC_STALE', 'PIN Sheet 상태가 변경되었습니다. 새 상태를 조회해 주세요.'],
    ['ROOM_PIN_SHEET_WORKER_BUSY', 409, 'ROOM_PIN_SHEET_WORKER_BUSY', 'PIN Sheet worker가 실행 중입니다.'],
    ['ROOM_PIN_SHEET_FULL_RESYNC_PENDING', 409, 'ROOM_PIN_SHEET_FULL_RESYNC_PENDING', '이미 전체 동기화가 대기 중입니다.'],
    ['ROOM_PIN_SHEET_ROOM_MASTER_INVALID', 503, 'ROOM_PIN_SHEET_ROOM_MASTER_INVALID', '121실 객실 정본을 확인해 주세요.'],
    ['IDEMPOTENCY_KEY_REUSED', 409, 'IDEMPOTENCY_KEY_REUSED', '이미 다른 요청에 사용한 Idempotency-Key입니다.']
  ];
  for (const [needle, status, code, korean] of mappings) {
    if (message.includes(needle)) return new AppError(status, code, korean);
  }
  return new AppError(500, 'ROOM_PIN_SHEET_OPERATION_FAILED', 'PIN Sheet 운영 요청을 처리하지 못했습니다.');
}

function timestamp(value: unknown): value is string {
  return typeof value === 'string' && timestampPattern.test(value) && Number.isFinite(Date.parse(value));
}

function statusProjection(value: unknown): RoomPinSheetStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw dbError(null);
  const row = value as Record<string, unknown>;
  const expected = ['checkedAt', 'failed', 'lastErrorCode', 'lastSuccessAt', 'oldestPendingAt', 'operatorBlocked', 'pending', 'version'];
  if (Object.keys(row).sort().join(',') !== expected.join(',') ||
    !Number.isInteger(row.pending) || (row.pending as number) < 0 || (row.pending as number) > 1000 ||
    !Number.isInteger(row.failed) || (row.failed as number) < 0 || (row.failed as number) > 1000 ||
    typeof row.operatorBlocked !== 'boolean' || !Number.isSafeInteger(row.version) || (row.version as number) < 0 ||
    !timestamp(row.checkedAt) || (row.oldestPendingAt !== null && !timestamp(row.oldestPendingAt)) ||
    (row.lastSuccessAt !== null && !timestamp(row.lastSuccessAt)) ||
    (row.lastErrorCode !== null && (typeof row.lastErrorCode !== 'string' || !errorCodePattern.test(row.lastErrorCode)))) {
    throw dbError(null);
  }
  return row as unknown as RoomPinSheetStatus;
}

function pendingProjection(value: unknown): { status: 'pending'; roomCount: 121; version: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw dbError(null);
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'roomCount,status,version' || row.status !== 'pending' || row.roomCount !== 121 ||
    !Number.isSafeInteger(row.version) || (row.version as number) < 0) throw dbError(null);
  return row as unknown as { status: 'pending'; roomCount: 121; version: number };
}

function assertSize(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 128 * 1024) {
    throw new AppError(500, 'ROOM_PIN_SHEET_RESPONSE_TOO_LARGE', 'PIN Sheet 운영 응답 크기 제한을 초과했습니다.');
  }
}

export class SupabaseRoomPinSheetOperationsService implements RoomPinSheetOperationsService {
  constructor(private readonly clients: SupabaseClients, private readonly config: RoomPinSheetOperationsConfig) {}

  async #rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await this.clients.admin.rpc(name, args);
    if (error || data === null) throw dbError(error);
    return data;
  }

  async #validateConfiguration(): Promise<void> {
    try {
      assertApprovedRoomPinSheetTarget(this.config.target);
      validateRoomPinCryptoConfig(this.config.crypto);
      await validateGoogleSheetsServiceAccount(this.config.serviceAccount);
    } catch (error) {
      if (error instanceof RoomPinSheetProviderError || error instanceof RoomPinCryptoError) {
        throw new AppError(503, 'ROOM_PIN_SHEET_NOT_CONFIGURED', 'PIN Sheet 연결 설정을 확인해 주세요.');
      }
      throw error;
    }
  }

  async status(actor: Actor): Promise<RoomPinSheetStatus> {
    const result = statusProjection(await this.#rpc('get_room_pin_sheet_sync_status', {
      p_actor_profile_id: actor.profileId,
      p_session_id: sessionId(actor)
    }));
    try {
      await this.#validateConfiguration();
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'ROOM_PIN_SHEET_NOT_CONFIGURED') throw error;
      result.operatorBlocked = true;
      result.lastErrorCode = 'PROVIDER_CONFIGURATION_ERROR';
    }
    assertSize(result);
    return result;
  }

  async requestFullResync(actor: Actor, expectedVersion: number, idempotencyKey: string) {
    await this.#validateConfiguration();
    const targetIdentityDigest = await roomPinSheetTargetDigest(this.config.target);
    const requestHash = createHash('sha256').update(JSON.stringify({
      expectedVersion,
      targetIdentityDigest
    })).digest('hex');
    const result = pendingProjection(await this.#rpc('request_room_pin_sheet_full_resync', {
      p_actor_profile_id: actor.profileId,
      p_session_id: sessionId(actor),
      p_expected_fence: expectedVersion,
      p_expected_environment: this.config.target.environment,
      p_expected_project_ref: this.config.target.projectRef,
      p_expected_target_identity_digest: targetIdentityDigest,
      p_idempotency_key: idempotencyKey,
      p_request_hash: requestHash
    }));
    assertSize(result);
    return result;
  }
}
