import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '../../lib/app-error.js';
import { isPayrollWorkDate, isPayrollWorkUuid, PAYROLL_WORK_CURSOR_MAX, type PayrollWorkInput, type PayrollWorkPosition } from './payroll-work-details.js';

export interface PayrollWorkScope {
  actorProfileId: string; actorRole: 'admin' | 'maid'; sessionBinding: string;
  weekStart: string; maidProfileId: string; kind: 'earnings' | 'workflow'; sort: 'entryDate:asc,entryId:asc';
}
const domain = 'payroll-work-details:v1:';
function invalid(): never { throw new AppError(400, 'PAYROLL_CURSOR_INVALID', '주급 상세 cursor를 다시 조회해 주세요.'); }
export class PayrollWorkCursorCodec {
  private readonly secret: Buffer;
  constructor(secret: string) {
    this.secret = Buffer.from(secret, 'utf8');
    if (this.secret.length < 32) throw new AppError(503, 'PAYROLL_CURSOR_NOT_CONFIGURED', '주급 조회 설정이 필요합니다.');
  }
  scope(profileId: string, role: 'admin' | 'maid', sessionId: string, input: PayrollWorkInput): PayrollWorkScope {
    return { actorProfileId: profileId.toLowerCase(), actorRole: role,
      sessionBinding: createHmac('sha256', this.secret).update(`${domain}session:${sessionId.toLowerCase()}`).digest('base64url'),
      weekStart: input.weekStart, maidProfileId: input.maidProfileId, kind: input.kind, sort: 'entryDate:asc,entryId:asc' };
  }
  encode(scope: PayrollWorkScope, after: PayrollWorkPosition): string {
    const payload = Buffer.from(JSON.stringify({ family: 'payroll-work-details', v: 1, scope, after }), 'utf8').toString('base64url');
    const signature = createHmac('sha256', this.secret).update(`${domain}${payload}`).digest('base64url');
    const cursor = `${payload}.${signature}`;
    if (cursor.length > PAYROLL_WORK_CURSOR_MAX) invalid();
    return cursor;
  }
  decode(cursor: string, scope: PayrollWorkScope): PayrollWorkPosition {
    if (!cursor || cursor.length > PAYROLL_WORK_CURSOR_MAX) invalid();
    const parts = cursor.split('.');
    if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) invalid();
    const payload = parts[0] ?? '', signature = Buffer.from(parts[1] ?? '', 'base64url');
    const bytes = Buffer.from(payload, 'base64url');
    if (signature.length !== 32 || signature.toString('base64url') !== parts[1] || bytes.toString('base64url') !== payload) invalid();
    const expected = createHmac('sha256', this.secret).update(`${domain}${payload}`).digest();
    if (!timingSafeEqual(signature, expected)) invalid();
    try {
      const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).sort().join(',') !== 'after,family,scope,v'
        || parsed.family !== 'payroll-work-details' || parsed.v !== 1 || JSON.stringify(parsed.scope) !== JSON.stringify(scope)) invalid();
      const after = parsed.after as Record<string, unknown>;
      if (!after || typeof after !== 'object' || Array.isArray(after) || Object.keys(after).sort().join(',') !== 'entryDate,entryId'
        || !isPayrollWorkDate(after.entryDate) || !isPayrollWorkUuid(after.entryId)) invalid();
      return { entryDate: after.entryDate, entryId: after.entryId };
    } catch { invalid(); }
  }
}
