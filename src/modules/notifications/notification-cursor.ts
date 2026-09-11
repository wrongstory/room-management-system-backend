import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Actor } from '../../domain/actor.js';
import { AppError } from '../../lib/app-error.js';

export const NOTIFICATION_PAGE_DEFAULT = 50;
export const NOTIFICATION_PAGE_MAX = 100;
export const NOTIFICATION_CURSOR_MAX_LENGTH = 1024;
export const NOTIFICATION_RESPONSE_MAX_BYTES = 128 * 1024;

export interface NotificationCursorScope {
  actorProfileId: string;
  actorRole: 'admin' | 'maid';
  stream: 'own-notifications';
  sort: 'occurredAt:desc,id:desc';
}

export interface NotificationCursorPosition {
  occurredAt: string;
  id: string;
}

interface NotificationCursorPayload {
  v: 1;
  scope: NotificationCursorScope;
  after: NotificationCursorPosition;
}

function invalidCursor(): AppError {
  return new AppError(400, 'INVALID_NOTIFICATION_CURSOR', '알림 cursor가 올바르지 않습니다.');
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

export function notificationCursorScope(actor: Actor): NotificationCursorScope {
  if (actor.role !== 'admin' && actor.role !== 'maid') throw invalidCursor();
  return {
    actorProfileId: actor.profileId.toLowerCase(),
    actorRole: actor.role,
    stream: 'own-notifications',
    sort: 'occurredAt:desc,id:desc'
  };
}

export class NotificationCursorCodec {
  private readonly secret: Buffer;

  constructor(secret: string) {
    this.secret = Buffer.from(secret, 'utf8');
    if (this.secret.byteLength < 32) {
      throw new AppError(
        503,
        'NOTIFICATION_CURSOR_NOT_CONFIGURED',
        '알림 cursor 서명 설정이 필요합니다.'
      );
    }
  }

  encode(scope: NotificationCursorScope, after: NotificationCursorPosition): string {
    const payload = Buffer.from(JSON.stringify({ v: 1, scope, after }), 'utf8').toString('base64url');
    const signature = createHmac('sha256', this.secret).update(payload, 'ascii').digest('base64url');
    const cursor = `${payload}.${signature}`;
    if (cursor.length > NOTIFICATION_CURSOR_MAX_LENGTH) throw invalidCursor();
    return cursor;
  }

  decode(cursor: string, expectedScope: NotificationCursorScope): NotificationCursorPosition {
    if (!cursor || cursor.length > NOTIFICATION_CURSOR_MAX_LENGTH) throw invalidCursor();
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

    let payload: NotificationCursorPayload;
    try {
      const parsed = record(JSON.parse(payloadBytes.toString('utf8')));
      if (!exactKeys(parsed, ['after', 'scope', 'v']) || parsed.v !== 1) throw invalidCursor();
      const scope = record(parsed.scope);
      if (!exactKeys(scope, ['actorProfileId', 'actorRole', 'sort', 'stream'])) throw invalidCursor();
      payload = parsed as unknown as NotificationCursorPayload;
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
    ) throw invalidCursor();
    return { id: after.id, occurredAt: after.occurredAt };
  }
}

export function assertNotificationResponseSize(body: unknown): void {
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > NOTIFICATION_RESPONSE_MAX_BYTES) {
    throw new AppError(
      500,
      'NOTIFICATION_RESPONSE_TOO_LARGE',
      '알림 응답 크기 상한을 초과했습니다.'
    );
  }
}
