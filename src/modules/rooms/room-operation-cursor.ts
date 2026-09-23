import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Actor } from '../../domain/actor.js';
import { AppError } from '../../lib/app-error.js';

export const ROOM_OPERATION_PAGE_DEFAULT = 50;
export const ROOM_OPERATION_PAGE_MAX = 100;
export const ROOM_OPERATION_CURSOR_MAX_LENGTH = 1024;
export const ROOM_OPERATION_RESPONSE_MAX_BYTES = 128 * 1024;

export type RoomOperationStream = 'operation-blocks' | 'issues';
export interface RoomOperationCursorScope {
  actorProfileId: string;
  actorRole: 'admin';
  roomId: string;
  stream: RoomOperationStream;
  status: 'actionable' | 'open';
  sort: 'occurredAt:desc,id:desc';
}
export interface RoomOperationCursorPosition {
  occurredAt: string;
  id: string;
}

interface RoomOperationCursorPayload {
  v: 1;
  scope: RoomOperationCursorScope;
  after: RoomOperationCursorPosition;
}

function invalidCursor(): AppError {
  return new AppError(400, 'INVALID_ROOM_OPERATION_CURSOR', '객실 운영 cursor가 올바르지 않습니다.');
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidCursor();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length
    && [...keys].sort().every((key, index) => actual[index] === key);
}

function validUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return month >= 1 && month <= 12 && day >= 1 && day <= maxDay
    && Number(match[4]) <= 23 && Number(match[5]) <= 59 && Number(match[6]) <= 59
    && (match[8] === undefined || (Number(match[8]) <= 23 && Number(match[9]) <= 59));
}

export function roomOperationCursorScope(
  actor: Pick<Actor, 'profileId' | 'role'>,
  roomId: string,
  stream: RoomOperationStream
): RoomOperationCursorScope {
  if (actor.role !== 'admin') throw invalidCursor();
  return {
    actorProfileId: actor.profileId.toLowerCase(),
    actorRole: 'admin',
    roomId: roomId.toLowerCase(),
    stream,
    status: stream === 'operation-blocks' ? 'actionable' : 'open',
    sort: 'occurredAt:desc,id:desc'
  };
}

export class RoomOperationCursorCodec {
  private readonly secret: Buffer;

  constructor(secret: string) {
    this.secret = Buffer.from(secret, 'utf8');
    if (this.secret.byteLength < 32) {
      throw new AppError(
        503,
        'ROOM_OPERATION_CURSOR_NOT_CONFIGURED',
        '객실 운영 cursor 서명 설정이 필요합니다.'
      );
    }
  }

  encode(scope: RoomOperationCursorScope, after: RoomOperationCursorPosition): string {
    const payload = Buffer.from(JSON.stringify({ v: 1, scope, after }), 'utf8').toString('base64url');
    const signature = createHmac('sha256', this.secret).update(payload, 'ascii').digest('base64url');
    const cursor = `${payload}.${signature}`;
    if (cursor.length > ROOM_OPERATION_CURSOR_MAX_LENGTH) throw invalidCursor();
    return cursor;
  }

  decode(cursor: string, expectedScope: RoomOperationCursorScope): RoomOperationCursorPosition {
    if (!cursor || cursor.length > ROOM_OPERATION_CURSOR_MAX_LENGTH) throw invalidCursor();
    const parts = cursor.split('.');
    if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
      throw invalidCursor();
    }
    const [payloadEncoded = '', signatureEncoded = ''] = parts;
    let payloadBytes: Buffer;
    let signature: Buffer;
    try {
      payloadBytes = Buffer.from(payloadEncoded, 'base64url');
      signature = Buffer.from(signatureEncoded, 'base64url');
    } catch {
      throw invalidCursor();
    }
    if (
      payloadBytes.toString('base64url') !== payloadEncoded
      || signature.toString('base64url') !== signatureEncoded
      || signature.byteLength !== 32
    ) throw invalidCursor();
    const expected = createHmac('sha256', this.secret).update(payloadEncoded, 'ascii').digest();
    if (!timingSafeEqual(signature, expected)) throw invalidCursor();

    let payload: RoomOperationCursorPayload;
    try {
      const parsed = record(JSON.parse(payloadBytes.toString('utf8')));
      if (!exactKeys(parsed, ['after', 'scope', 'v']) || parsed.v !== 1) throw invalidCursor();
      const scope = record(parsed.scope);
      if (!exactKeys(scope, ['actorProfileId', 'actorRole', 'roomId', 'sort', 'status', 'stream'])) {
        throw invalidCursor();
      }
      payload = parsed as unknown as RoomOperationCursorPayload;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw invalidCursor();
    }
    if (JSON.stringify(payload.scope) !== JSON.stringify(expectedScope)) throw invalidCursor();
    const after = record(payload.after);
    if (
      !exactKeys(after, ['id', 'occurredAt'])
      || typeof after.id !== 'string'
      || typeof after.occurredAt !== 'string'
      || !validUuid(after.id)
      || !validTimestamp(after.occurredAt)
    ) throw invalidCursor();
    return { id: after.id, occurredAt: after.occurredAt };
  }
}

export function assertRoomOperationResponseSize(body: unknown): void {
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > ROOM_OPERATION_RESPONSE_MAX_BYTES) {
    throw new AppError(
      500,
      'ROOM_OPERATION_RESPONSE_TOO_LARGE',
      '객실 운영 응답 크기 상한을 초과했습니다.'
    );
  }
}
