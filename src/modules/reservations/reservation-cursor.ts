import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Actor } from '../../domain/actor.js';
import { AppError } from '../../lib/app-error.js';

export const RESERVATION_PAGE_SIZE = 50;
export const RESERVATION_RANGE_MAX_DAYS = 31;
export const RESERVATION_CURSOR_MAX_LENGTH = 1024;

export interface ReservationCursorScope {
  actorProfileId: string;
  actorRole: 'admin';
  from: string;
  to: string;
  roomId: string | null;
  sort: 'checkInAt:asc,id:asc';
}

export interface ReservationCursorPosition {
  checkInAt: string;
  id: string;
}

interface ReservationCursorPayload {
  v: 1;
  scope: ReservationCursorScope;
  after: ReservationCursorPosition;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const timestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/;

function invalidCursor(): AppError {
  return new AppError(400, 'INVALID_RESERVATION_CURSOR', '예약 cursor가 올바르지 않습니다.');
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidCursor();
  return value as Record<string, unknown>;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length
    && [...keys].sort().every((key, index) => actual[index] === key);
}

function strictTimestamp(value: string): boolean {
  const match = value.match(timestampPattern);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1
    && day <= (days[month - 1] ?? 0)
    && Number(match[4]) <= 23 && Number(match[5]) <= 59 && Number(match[6]) <= 59
    && Number(match[8] ?? 0) <= 23 && Number(match[9] ?? 0) <= 59
    && Number.isFinite(Date.parse(value));
}

export function reservationCursorScope(
  actor: Actor,
  input: { from: string; to: string; roomId?: string }
): ReservationCursorScope {
  if (actor.role !== 'admin') throw invalidCursor();
  return {
    actorProfileId: actor.profileId.toLowerCase(),
    actorRole: 'admin',
    from: input.from,
    to: input.to,
    roomId: input.roomId?.toLowerCase() ?? null,
    sort: 'checkInAt:asc,id:asc'
  };
}

export class ReservationCursorCodec {
  private readonly secret: Buffer;

  constructor(reservationGuestNamePepper: string) {
    const root = Buffer.from(reservationGuestNamePepper, 'utf8');
    if (root.byteLength < 32) {
      throw new AppError(
        503,
        'RESERVATION_CURSOR_NOT_CONFIGURED',
        '예약 cursor 서명 설정이 필요합니다.'
      );
    }
    this.secret = createHmac('sha256', root)
      .update('room-management:reservation-range-cursor:v1', 'utf8')
      .digest();
  }

  encode(scope: ReservationCursorScope, after: ReservationCursorPosition): string {
    const payload = Buffer.from(JSON.stringify({ v: 1, scope, after }), 'utf8').toString('base64url');
    const signature = createHmac('sha256', this.secret).update(payload, 'ascii').digest('base64url');
    const cursor = `${payload}.${signature}`;
    if (cursor.length > RESERVATION_CURSOR_MAX_LENGTH) throw invalidCursor();
    return cursor;
  }

  decode(cursor: string, expectedScope: ReservationCursorScope): ReservationCursorPosition {
    if (!cursor || cursor.length > RESERVATION_CURSOR_MAX_LENGTH) throw invalidCursor();
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

    let payload: ReservationCursorPayload;
    try {
      const parsed = record(JSON.parse(payloadBytes.toString('utf8')));
      if (!hasExactKeys(parsed, ['after', 'scope', 'v']) || parsed.v !== 1) throw invalidCursor();
      const scope = record(parsed.scope);
      if (!hasExactKeys(scope, ['actorProfileId', 'actorRole', 'from', 'roomId', 'sort', 'to'])) {
        throw invalidCursor();
      }
      payload = parsed as unknown as ReservationCursorPayload;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw invalidCursor();
    }
    if (JSON.stringify(payload.scope) !== JSON.stringify(expectedScope)) throw invalidCursor();
    const after = record(payload.after);
    if (
      !hasExactKeys(after, ['checkInAt', 'id'])
      || typeof after.checkInAt !== 'string'
      || typeof after.id !== 'string'
      || !strictTimestamp(after.checkInAt)
      || !uuidPattern.test(after.id)
    ) throw invalidCursor();
    return { checkInAt: after.checkInAt, id: after.id.toLowerCase() };
  }
}
