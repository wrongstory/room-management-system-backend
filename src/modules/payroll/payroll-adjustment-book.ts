import type { onRequestAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import type { Actor } from '../../domain/actor.js';
import { AppError } from '../../lib/app-error.js';

export interface PayrollAdjustmentBookInput { maidProfileId: string; weekStart: string }
export interface PayrollAdjustmentBookProjection extends PayrollAdjustmentBookInput { currentBookVersion: number }

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && year <= 9999 && month >= 1 && month <= 12
    && day >= 1 && day <= (days[month - 1] ?? 0);
}

const uuidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const bookInputSchema = z.object({
  maidProfileId: uuidSchema.transform((value) => value.toLowerCase()),
  weekStart: z.string().refine(isCalendarDate)
}).strict();
const bookProjectionSchema = z.object({
  maidProfileId: uuidSchema,
  weekStart: z.string().refine(isCalendarDate),
  currentBookVersion: z.number().refine((value) => Number.isSafeInteger(value) && value >= 0)
}).strict();

function validationError(): AppError {
  return new AppError(400, 'VALIDATION_ERROR', '메이드와 주차를 확인해 주세요.');
}
export function normalizePayrollAdjustmentBookInput(value: unknown): PayrollAdjustmentBookInput {
  const parsed = bookInputSchema.safeParse(value);
  if (!parsed.success) throw validationError();
  return parsed.data;
}
export function payrollAdjustmentBookQuery(search: URLSearchParams): PayrollAdjustmentBookInput {
  for (const key of search.keys()) {
    if (!['maidProfileId', 'weekStart'].includes(key) || search.getAll(key).length !== 1) throw validationError();
  }
  return normalizePayrollAdjustmentBookInput({
    maidProfileId: search.get('maidProfileId'), weekStart: search.get('weekStart')
  });
}

// This read has stricter session semantics than legacy payroll commands. Keep
// its error contract scoped rather than changing unrelated command behavior.
export function payrollAdjustmentBookDatabaseError(error: { message?: string } | null): AppError {
  const code = error?.message;
  switch (code) {
    case 'ADMIN_REQUIRED': return new AppError(403, code, '관리자만 조정 원장 version을 조회할 수 있습니다.');
    case 'PASSWORD_CHANGE_REQUIRED': return new AppError(403, code, '먼저 임시 비밀번호를 변경해 주세요.');
    case 'SESSION_REVOKED': return new AppError(401, code, '다시 로그인해 주세요.');
    case 'PAYROLL_WEEK_MUST_START_MONDAY': return new AppError(400, code, 'weekStart는 월요일이어야 합니다.');
    case 'PAYROLL_WEEK_NOT_CLOSED': return new AppError(409, code, '미래 주차는 조회할 수 없습니다.');
    case 'PAYROLL_MAID_NOT_FOUND': return new AppError(404, code, '메이드 계정을 찾을 수 없습니다.');
    default: return new AppError(500, 'PAYROLL_COMMAND_FAILED', '주급 정보를 처리하지 못했습니다.');
  }
}

export function payrollAdjustmentBookProjection(value: unknown, input: PayrollAdjustmentBookInput): PayrollAdjustmentBookProjection {
  const parsed = bookProjectionSchema.safeParse(value);
  if (!parsed.success || parsed.data.maidProfileId !== input.maidProfileId
    || parsed.data.weekStart !== input.weekStart) throw payrollAdjustmentBookDatabaseError(null);
  return parsed.data;
}

export function payrollAdjustmentBookSessionId(actor: Actor): string {
  try {
    const payload = actor.accessToken.split('.')[1];
    if (!payload) throw new Error();
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { session_id?: unknown };
    const parsed = uuidSchema.safeParse(claims.session_id);
    if (!parsed.success) throw new Error();
    return parsed.data.toLowerCase();
  } catch { throw new AppError(401, 'INVALID_ACCESS_TOKEN', '로그인이 필요합니다.'); }
}

// Root registration also covers unmatched method/path aliases, before CORS.
// OPTIONS remains transport preflight, not an additional read operation.
export const payrollAdjustmentBookGuard: onRequestAsyncHookHandler = async (request, reply) => {
  const path = request.url.split('?')[0] ?? '';
  // Fastify decodes unreserved static-path bytes before route matching. Detect
  // the family after decoding, but allow only the original canonical path.
  const familyPath = path.split('/').map((segment) => {
    try { return decodeURIComponent(segment); } catch { return segment; }
  }).join('/');
  const normalized = familyPath.replace(/\/+/g, '/').replace(/\/+$/, '');
  const bookPath = '/v1/payroll/adjustment-book';
  if (normalized !== bookPath && !normalized.startsWith(`${bookPath}/`)) return;
  reply.header('Cache-Control', 'no-store');
  if (request.method !== 'OPTIONS' && (request.method !== 'GET' || path !== bookPath)) {
    throw new AppError(404, 'ROUTE_NOT_FOUND', '요청한 API 경로를 찾을 수 없습니다.');
  }
};
