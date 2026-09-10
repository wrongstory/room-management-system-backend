import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Actor } from '../../domain/actor.js';
import { AppError } from '../../lib/app-error.js';

export const PAYROLL_CYCLE_PAGE_DEFAULT = 10;
export const PAYROLL_CYCLE_PAGE_MAX = 10;
export const PAYROLL_ENTRY_PAGE_DEFAULT = 25;
export const PAYROLL_ENTRY_PAGE_MAX = 50;
export const PAYROLL_NESTED_PREVIEW_MAX = 10;
export const PAYROLL_RESPONSE_MAX_BYTES = 128 * 1024;
export const PAYROLL_CURSOR_MAX_LENGTH = 1024;

export type PayrollCursorKind = 'cycles' | 'items' | 'lateEarnings' | 'adjustments';

export interface PayrollCursorScope {
  actorProfileId: string;
  actorRole: 'admin' | 'maid';
  weekStart: string;
  maidProfileId: string | null;
  kind: PayrollCursorKind;
  sort: 'maidProfileId:asc' | 'earnedOn:asc,earningId:asc';
}

export type PayrollCursorPosition =
  | { maidProfileId: string }
  | { earnedOn: string; earningId: string };

interface PayrollCursorPayload {
  v: 1;
  scope: PayrollCursorScope;
  after: PayrollCursorPosition;
}

function cursorError(): AppError {
  return new AppError(400, 'PAYROLL_CURSOR_INVALID', '주급 cursor가 올바르지 않습니다.');
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length
    && keys.slice().sort().every((key, index) => actual[index] === key);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw cursorError();
  return value as Record<string, unknown>;
}

function sameScope(left: PayrollCursorScope, right: PayrollCursorScope): boolean {
  return left.actorProfileId === right.actorProfileId
    && left.actorRole === right.actorRole
    && left.weekStart === right.weekStart
    && left.maidProfileId === right.maidProfileId
    && left.kind === right.kind
    && left.sort === right.sort;
}

export function payrollCursorScope(
  actor: Actor,
  weekStart: string,
  requestedMaidProfileId: string | undefined,
  kind: PayrollCursorKind
): PayrollCursorScope {
  if (actor.role !== 'admin' && actor.role !== 'maid') throw cursorError();
  return {
    actorProfileId: actor.profileId.toLowerCase(),
    actorRole: actor.role,
    weekStart,
    maidProfileId: actor.role === 'maid'
      ? actor.profileId.toLowerCase()
      : requestedMaidProfileId?.toLowerCase() ?? null,
    kind,
    sort: kind === 'cycles' ? 'maidProfileId:asc' : 'earnedOn:asc,earningId:asc'
  };
}

export class PayrollCursorCodec {
  private readonly secret: Buffer;

  constructor(secret: string) {
    this.secret = Buffer.from(secret, 'utf8');
    if (this.secret.byteLength < 32) {
      throw new AppError(
        503,
        'PAYROLL_CURSOR_NOT_CONFIGURED',
        '주급 cursor 서명 설정이 필요합니다.'
      );
    }
  }

  encode(scope: PayrollCursorScope, after: PayrollCursorPosition): string {
    const payload = Buffer.from(JSON.stringify({ v: 1, scope, after }), 'utf8').toString('base64url');
    const signature = createHmac('sha256', this.secret).update(payload, 'ascii').digest('base64url');
    const cursor = `${payload}.${signature}`;
    if (cursor.length > PAYROLL_CURSOR_MAX_LENGTH) throw cursorError();
    return cursor;
  }

  decode(cursor: string, expectedScope: PayrollCursorScope): PayrollCursorPosition {
    if (!cursor || cursor.length > PAYROLL_CURSOR_MAX_LENGTH) throw cursorError();
    const parts = cursor.split('.');
    if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
      throw cursorError();
    }
    const [payloadEncoded = '', signatureEncoded = ''] = parts;
    let payloadBytes: Buffer;
    let signature: Buffer;
    try {
      payloadBytes = Buffer.from(payloadEncoded, 'base64url');
      signature = Buffer.from(signatureEncoded, 'base64url');
    } catch {
      throw cursorError();
    }
    if (
      payloadBytes.toString('base64url') !== payloadEncoded
      || signature.toString('base64url') !== signatureEncoded
      || signature.byteLength !== 32
    ) throw cursorError();
    const expected = createHmac('sha256', this.secret).update(payloadEncoded, 'ascii').digest();
    if (!timingSafeEqual(signature, expected)) throw cursorError();

    let payload: PayrollCursorPayload;
    try {
      const value = record(JSON.parse(payloadBytes.toString('utf8')));
      if (!exactKeys(value, ['after', 'scope', 'v']) || value.v !== 1) throw cursorError();
      const scope = record(value.scope);
      if (!exactKeys(scope, ['actorProfileId', 'actorRole', 'kind', 'maidProfileId', 'sort', 'weekStart'])) {
        throw cursorError();
      }
      payload = value as unknown as PayrollCursorPayload;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw cursorError();
    }
    if (!sameScope(payload.scope, expectedScope)) throw cursorError();
    const after = record(payload.after);
    if (expectedScope.kind === 'cycles') {
      if (!exactKeys(after, ['maidProfileId']) || typeof after.maidProfileId !== 'string') {
        throw cursorError();
      }
      return { maidProfileId: after.maidProfileId };
    }
    if (
      !exactKeys(after, ['earnedOn', 'earningId'])
      || typeof after.earnedOn !== 'string'
      || typeof after.earningId !== 'string'
    ) throw cursorError();
    return { earnedOn: after.earnedOn, earningId: after.earningId };
  }
}

export function assertPayrollResponseSize(body: unknown): void {
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > PAYROLL_RESPONSE_MAX_BYTES) {
    throw new AppError(
      500,
      'PAYROLL_RESPONSE_TOO_LARGE',
      '주급 응답 크기 상한을 초과했습니다.'
    );
  }
}
