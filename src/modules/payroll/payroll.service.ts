import type { Actor } from '../../domain/actor.js';
import { AppError } from '../../lib/app-error.js';
import { requestHash } from '../../lib/command.js';
import type { SupabaseClients } from '../../lib/supabase.js';
import {
  PAYROLL_CYCLE_PAGE_DEFAULT,
  PAYROLL_ENTRY_PAGE_DEFAULT,
  PAYROLL_NESTED_PREVIEW_MAX,
  PayrollCursorCodec,
  type PayrollCursorPosition,
  payrollCursorScope
} from './payroll-cursor.js';

export type PayrollStatus = 'open' | 'paying' | 'check' | 'paid';
export type PayrollEntryKind = 'items' | 'lateEarnings' | 'adjustments';

export interface PayrollItem { earningId: string; earnedOn: string; amount: number; alreadyClaimed: boolean }
export interface PayrollLateEarning { earningId: string; earnedOn: string; amount: number }
export type PayrollAdjustmentReason = 'earning_correction' | 'adjustment_correction' |
  'earning_reversal' | 'adjustment_reversal' | 'late_earning_carry';
export interface PayrollAdjustmentEntry {
  adjustmentId: string; availableWeekStart: string; amount: number;
  reasonCode: PayrollAdjustmentReason; alreadyClaimed: boolean;
}
export interface PayrollCycleProjection {
  cycleId: string | null; maidProfileId: string; weekStart: string; status: PayrollStatus;
  version: number; lockedAmount: number | null; paymentStartedAt: string | null;
  itemCount: number; totalAmount: number; items: PayrollItem[]; itemsNextCursor: string | null;
  lateEarningCount: number; lateEarningAmount: number; lateEarnings: PayrollLateEarning[];
  lateEarningsNextCursor: string | null;
  offsetSettled: boolean; adjustmentAmount: number; carryInAmount: number;
  carryOutAmount: number; payableAmount: number; adjustmentCount: number;
  paymentAttemptId: string | null; paymentAttemptNumber: number | null;
  paidAt: string | null; checkReasonCode: 'TRANSFER_RESULT_UNCERTAIN' | null;
  lastReopenReasonCode: 'NO_TRANSFER_CONFIRMED' | null;
}
export interface PayrollListInput {
  weekStart: string;
  maidProfileId?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}
export interface PayrollListPage { payroll: PayrollCycleProjection[]; nextCursor: string | null }
export interface PayrollEntriesInput {
  weekStart: string;
  maidProfileId: string;
  kind: PayrollEntryKind;
  limit?: number | undefined;
  cursor?: string | undefined;
}
export interface PayrollEntriesPage {
  kind: PayrollEntryKind; entries: Array<PayrollItem | PayrollLateEarning | PayrollAdjustmentEntry>; nextCursor: string | null;
}
export interface StartPayrollInput {
  maidProfileId: string; weekStart: string; expectedVersion: number; idempotencyKey: string;
}
export interface AdjustmentSourceInput { sourceEarningId?: string | undefined; sourceAdjustmentId?: string | undefined }
export interface PayrollAdjustmentInput extends AdjustmentSourceInput {
  amount: number; expectedVersion: number; idempotencyKey: string;
}
export interface PayrollReversalInput extends AdjustmentSourceInput {
  expectedVersion: number; idempotencyKey: string;
}
export interface CarryForwardInput extends StartPayrollInput {}
export interface LateEarningCarryInput { earningId: string; expectedVersion: number; idempotencyKey: string }
export type PayrollPaymentResultType = 'check' | 'paid' | 'reopened';
export interface PayrollPaymentResult {
  paymentResultId: string; paymentAttemptId: string; payrollCycleId: string;
  resultType: PayrollPaymentResultType; beforeStatus: 'paying' | 'check'; afterStatus: 'check' | 'paid' | 'open';
  cycleVersion: number; lockedAmount: number; paymentMethod?: 'bank_transfer' | undefined;
  providerReferenceId?: string | undefined;
  reasonCode?: 'TRANSFER_RESULT_UNCERTAIN' | 'NO_TRANSFER_CONFIRMED' | undefined;
  occurredAt: string;
}
export interface PaymentAttemptInput { paymentAttemptId: string; expectedVersion: number; idempotencyKey: string }
export interface PaymentCheckInput extends PaymentAttemptInput { reasonCode: 'TRANSFER_RESULT_UNCERTAIN' }
export interface PaymentPaidInput extends PaymentAttemptInput {
  paymentMethod: 'bank_transfer'; providerReferenceId: string;
}
export interface PaymentReopenInput extends PaymentAttemptInput { reasonCode: 'NO_TRANSFER_CONFIRMED' }
export interface PayrollAdjustmentProjection extends PayrollAdjustmentEntry {
  maidProfileId: string; bookVersion: number; currency: 'KRW'; rootEarningId: string;
  correctionOfEarningId?: string | undefined; correctionOfAdjustmentId?: string | undefined;
  reversalOfEarningId?: string | undefined; reversalOfAdjustmentId?: string | undefined;
  lateCarriedEarningId?: string | undefined; createdAt: string;
}
export interface PayrollService {
  list(actor: Actor, input: PayrollListInput): Promise<PayrollListPage>;
  listEntries(actor: Actor, input: PayrollEntriesInput): Promise<PayrollEntriesPage>;
  start(actor: Actor, input: StartPayrollInput): Promise<PayrollCycleProjection>;
  correct(actor: Actor, input: PayrollAdjustmentInput): Promise<PayrollAdjustmentProjection>;
  reverse(actor: Actor, input: PayrollReversalInput): Promise<PayrollAdjustmentProjection>;
  carryForward(actor: Actor, input: CarryForwardInput): Promise<PayrollCycleProjection>;
  carryLateEarning(actor: Actor, input: LateEarningCarryInput): Promise<PayrollAdjustmentProjection>;
  recordPaymentCheck(actor: Actor, input: PaymentCheckInput): Promise<PayrollPaymentResult>;
  recordPaymentPaid(actor: Actor, input: PaymentPaidInput): Promise<PayrollPaymentResult>;
  reopenPayment(actor: Actor, input: PaymentReopenInput): Promise<PayrollPaymentResult>;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function payrollReader(actor: Actor, maidProfileId?: string): void {
  if (actor.role !== 'admin' && actor.role !== 'maid') {
    throw new AppError(403, 'PAYROLL_ACCESS_REQUIRED', '주급 조회 권한이 필요합니다.');
  }
  if (
    actor.role === 'maid'
    && maidProfileId
    && maidProfileId.toLowerCase() !== actor.profileId.toLowerCase()
  ) {
    throw new AppError(403, 'PAYROLL_ACCESS_REQUIRED', '본인의 주급만 조회할 수 있습니다.');
  }
}
function payrollAdmin(actor: Actor): void {
  if (actor.role !== 'admin') throw new AppError(403, 'ADMIN_REQUIRED', '관리자만 주급 지급 처리를 시작할 수 있습니다.');
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw payrollDatabaseError(null);
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw payrollDatabaseError(null);
  return value;
}
function nullableText(value: unknown): string | null { return value === null ? null : text(value) }
function uuid(value: unknown): string {
  const parsed = text(value);
  if (!uuidPattern.test(parsed)) throw payrollDatabaseError(null);
  return parsed.toLowerCase();
}
function nullableUuid(value: unknown): string | null { return value === null ? null : uuid(value) }
function date(value: unknown): string {
  const parsed = text(value);
  const match = parsed.match(datePattern);
  const [year, month, day] = parsed.split('-').map(Number);
  const instant = new Date(Date.UTC(year ?? 0, (month ?? 0) - 1, day ?? 0));
  if (!match || instant.getUTCFullYear() !== year || instant.getUTCMonth() !== (month ?? 0) - 1 || instant.getUTCDate() !== day) throw payrollDatabaseError(null);
  return parsed;
}
function nullableDate(value: unknown): string | null { return value === null ? null : date(value) }
function nullableTimestamp(value: unknown): string | null {
  const parsed = nullableText(value);
  if (parsed !== null && (!timestampPattern.test(parsed) || !Number.isFinite(Date.parse(parsed)))) throw payrollDatabaseError(null);
  return parsed;
}
function integer(value: unknown): number {
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 0) throw payrollDatabaseError(null);
  return parsed;
}
function signedInteger(value: unknown): number {
  const parsed = typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed)) throw payrollDatabaseError(null);
  return parsed;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw payrollDatabaseError(null);
  return value;
}
function item(value: unknown): PayrollItem {
  const row = object(value);
  if (typeof row.alreadyClaimed !== 'boolean') throw payrollDatabaseError(null);
  return { earningId: uuid(row.earningId), earnedOn: date(row.earnedOn), amount: integer(row.amount), alreadyClaimed: row.alreadyClaimed };
}
function lateEarning(value: unknown): PayrollLateEarning {
  const row = object(value);
  return { earningId: uuid(row.earningId), earnedOn: date(row.earnedOn), amount: integer(row.amount) };
}
function adjustment(value: unknown): PayrollAdjustmentEntry {
  const row = object(value);
  const reasonCode = text(row.reasonCode);
  if (!['earning_correction', 'adjustment_correction', 'earning_reversal', 'adjustment_reversal', 'late_earning_carry'].includes(reasonCode)) throw payrollDatabaseError(null);
  return { adjustmentId: uuid(row.adjustmentId), availableWeekStart: date(row.availableWeekStart),
    amount: signedInteger(row.amount), reasonCode: reasonCode as PayrollAdjustmentReason,
    alreadyClaimed: boolean(row.alreadyClaimed) };
}
function adjustmentProjection(value: unknown): PayrollAdjustmentProjection {
  const row = object(value);
  const entry = adjustment({ ...row, alreadyClaimed: false });
  const optionalUuid = (key: string): string | undefined => row[key] === undefined ? undefined : uuid(row[key]);
  if (row.currency !== 'KRW') throw payrollDatabaseError(null);
  return { ...entry, maidProfileId: uuid(row.maidProfileId), bookVersion: integer(row.bookVersion),
    currency: 'KRW', rootEarningId: uuid(row.rootEarningId),
    correctionOfEarningId: optionalUuid('correctionOfEarningId'),
    correctionOfAdjustmentId: optionalUuid('correctionOfAdjustmentId'),
    reversalOfEarningId: optionalUuid('reversalOfEarningId'),
    reversalOfAdjustmentId: optionalUuid('reversalOfAdjustmentId'),
    lateCarriedEarningId: optionalUuid('lateCarriedEarningId'), createdAt: text(row.createdAt) };
}

const providerReferencePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$/;
export function canonicalPayrollProviderReference(value: string): string {
  if (value.length < 8 || value.length > 64 || !providerReferencePattern.test(value)
    || !/[A-Za-z]/.test(value) || !/[0-9]/.test(value) || /[0-9]{7}/.test(value)
    || value.toLowerCase().includes('http') || value.toLowerCase().startsWith('www.')) {
    throw new AppError(400, 'PAYROLL_PAYMENT_REFERENCE_INVALID', 'providerReferenceId 형식을 확인해 주세요.');
  }
  return value.toUpperCase();
}

function paymentResult(value: unknown): PayrollPaymentResult {
  const row = object(value);
  const resultType = text(row.resultType);
  const beforeStatus = text(row.beforeStatus);
  const afterStatus = text(row.afterStatus);
  if (!['check', 'paid', 'reopened'].includes(resultType)
    || !['paying', 'check'].includes(beforeStatus) || !['check', 'paid', 'open'].includes(afterStatus)) {
    throw payrollDatabaseError(null);
  }
  const method = row.paymentMethod === undefined ? undefined : text(row.paymentMethod);
  const reason = row.reasonCode === undefined ? undefined : text(row.reasonCode);
  if (method !== undefined && method !== 'bank_transfer') throw payrollDatabaseError(null);
  if (reason !== undefined && !['TRANSFER_RESULT_UNCERTAIN', 'NO_TRANSFER_CONFIRMED'].includes(reason)) throw payrollDatabaseError(null);
  return {
    paymentResultId: uuid(row.paymentResultId), paymentAttemptId: uuid(row.paymentAttemptId),
    payrollCycleId: uuid(row.payrollCycleId), resultType: resultType as PayrollPaymentResultType,
    beforeStatus: beforeStatus as 'paying' | 'check', afterStatus: afterStatus as 'check' | 'paid' | 'open',
    cycleVersion: integer(row.cycleVersion), lockedAmount: integer(row.lockedAmount),
    ...(method === undefined ? {} : { paymentMethod: method as 'bank_transfer' }),
    ...(row.providerReferenceId === undefined ? {} : { providerReferenceId: text(row.providerReferenceId) }),
    ...(reason === undefined ? {} : { reasonCode: reason as 'TRANSFER_RESULT_UNCERTAIN' | 'NO_TRANSFER_CONFIRMED' }),
    occurredAt: text(row.occurredAt)
  };
}

interface InternalPayrollCycle {
  cycle: PayrollCycleProjection;
  itemsHasMore: boolean; itemsLastEarnedOn: string | null; itemsLastEarningId: string | null;
  lateEarningsHasMore: boolean; lateEarningsLastEarnedOn: string | null; lateEarningsLastEarningId: string | null;
}
function internalCycle(value: unknown): InternalPayrollCycle {
  const row = object(value);
  const status = text(row.status);
  if (!['open', 'paying', 'check', 'paid'].includes(status) || !Array.isArray(row.items) || !Array.isArray(row.lateEarnings)) throw payrollDatabaseError(null);
  if (row.items.length > PAYROLL_NESTED_PREVIEW_MAX || row.lateEarnings.length > PAYROLL_NESTED_PREVIEW_MAX) throw payrollDatabaseError(null);
  const parsed: InternalPayrollCycle = {
    cycle: {
      cycleId: row.cycleId === null ? null : uuid(row.cycleId), maidProfileId: uuid(row.maidProfileId),
      weekStart: date(row.weekStart), status: status as PayrollStatus, version: integer(row.version),
      lockedAmount: row.lockedAmount === null ? null : integer(row.lockedAmount), paymentStartedAt: nullableTimestamp(row.paymentStartedAt),
      itemCount: integer(row.itemCount), totalAmount: integer(row.totalAmount), items: row.items.map(item), itemsNextCursor: null,
      lateEarningCount: integer(row.lateEarningCount), lateEarningAmount: integer(row.lateEarningAmount),
      lateEarnings: row.lateEarnings.map(lateEarning), lateEarningsNextCursor: null
      , offsetSettled: boolean(row.offsetSettled), adjustmentAmount: signedInteger(row.adjustmentAmount),
      carryInAmount: signedInteger(row.carryInAmount), carryOutAmount: signedInteger(row.carryOutAmount),
      payableAmount: signedInteger(row.payableAmount), adjustmentCount: integer(row.adjustmentCount),
      paymentAttemptId: row.paymentAttemptId === undefined || row.paymentAttemptId === null ? null : uuid(row.paymentAttemptId),
      paymentAttemptNumber: row.paymentAttemptNumber === undefined || row.paymentAttemptNumber === null ? null : integer(row.paymentAttemptNumber),
      paidAt: row.paidAt === undefined ? null : nullableTimestamp(row.paidAt),
      checkReasonCode: row.checkReasonCode === undefined || row.checkReasonCode === null ? null
        : text(row.checkReasonCode) === 'TRANSFER_RESULT_UNCERTAIN' ? 'TRANSFER_RESULT_UNCERTAIN' : (() => { throw payrollDatabaseError(null) })(),
      lastReopenReasonCode: row.lastReopenReasonCode === undefined || row.lastReopenReasonCode === null ? null
        : text(row.lastReopenReasonCode) === 'NO_TRANSFER_CONFIRMED' ? 'NO_TRANSFER_CONFIRMED' : (() => { throw payrollDatabaseError(null) })()
    },
    itemsHasMore: boolean(row.itemsHasMore), itemsLastEarnedOn: nullableDate(row.itemsLastEarnedOn), itemsLastEarningId: nullableUuid(row.itemsLastEarningId),
    lateEarningsHasMore: boolean(row.lateEarningsHasMore), lateEarningsLastEarnedOn: nullableDate(row.lateEarningsLastEarnedOn),
    lateEarningsLastEarningId: nullableUuid(row.lateEarningsLastEarningId)
  };
  cursorPosition(parsed.itemsHasMore, parsed.itemsLastEarnedOn, parsed.itemsLastEarningId);
  cursorPosition(parsed.lateEarningsHasMore, parsed.lateEarningsLastEarnedOn, parsed.lateEarningsLastEarningId);
  return parsed;
}
export function toPayrollCycle(value: unknown): PayrollCycleProjection { return internalCycle(value).cycle }
function cursorPosition(hasMore: boolean, earnedOn: string | null, earningId: string | null): PayrollCursorPosition | null {
  if (!hasMore) return null;
  if (!earnedOn || !earningId) throw payrollDatabaseError(null);
  return { earnedOn, earningId };
}

export function payrollDatabaseError(error: { message?: string } | null): AppError {
  const message = error?.message ?? '';
  const mappings: Array<[string, number, string, string]> = [
    ['PAYROLL_ACCESS_REQUIRED', 403, 'PAYROLL_ACCESS_REQUIRED', '주급 조회 권한이 필요합니다.'],
    ['ADMIN_REQUIRED', 403, 'ADMIN_REQUIRED', '관리자만 주급 지급 처리를 시작할 수 있습니다.'],
    ['PAYROLL_MAID_NOT_FOUND', 404, 'PAYROLL_MAID_NOT_FOUND', '메이드 계정을 찾을 수 없습니다.'],
    ['PAYROLL_WEEK_MUST_START_MONDAY', 400, 'PAYROLL_WEEK_MUST_START_MONDAY', 'weekStart는 월요일이어야 합니다.'],
    ['PAYROLL_PAGE_LIMIT_INVALID', 400, 'PAYROLL_PAGE_LIMIT_INVALID', '주급 page size가 허용 범위를 벗어났습니다.'],
    ['PAYROLL_PAGE_KIND_INVALID', 400, 'PAYROLL_PAGE_KIND_INVALID', '주급 상세 page 종류가 올바르지 않습니다.'],
    ['PAYROLL_CURSOR_INVALID', 400, 'PAYROLL_CURSOR_INVALID', '주급 cursor가 올바르지 않습니다.'],
    ['INVALID_EXPECTED_VERSION', 400, 'INVALID_EXPECTED_VERSION', 'expectedVersion을 확인해 주세요.'],
    ['PAYROLL_WEEK_NOT_CLOSED', 409, 'PAYROLL_WEEK_NOT_CLOSED', '종료된 주차만 지급 처리를 시작할 수 있습니다.'],
    ['PAYROLL_CYCLE_NOT_OPEN', 409, 'PAYROLL_CYCLE_NOT_OPEN', 'OPEN 주급 주기만 지급 처리를 시작할 수 있습니다.'],
    ['STALE_VERSION', 409, 'STALE_VERSION', '주급 version이 변경되었습니다. 최신 상태를 다시 확인해 주세요.'],
    ['NO_PAYROLL_AMOUNT', 409, 'NO_PAYROLL_AMOUNT', '지급 처리할 확정 수익이 없습니다.'],
    ['PAYROLL_NONPOSITIVE_REQUIRES_CARRY', 409, 'PAYROLL_NONPOSITIVE_REQUIRES_CARRY', '0원 이하 주급은 이월 상계가 필요합니다.'],
    ['PAYROLL_POSITIVE_REQUIRES_START', 409, 'PAYROLL_POSITIVE_REQUIRES_START', '양수 주급은 지급 시작으로 처리해야 합니다.'],
    ['PAYROLL_CYCLE_ECONOMICALLY_FROZEN', 409, 'PAYROLL_CYCLE_ECONOMICALLY_FROZEN', '상계 완료 주차는 경제적으로 동결되었습니다.'],
    ['PAYROLL_SOURCE_PAYMENT_UNCERTAIN', 409, 'PAYROLL_SOURCE_PAYMENT_UNCERTAIN', '지급 결과 확인 전에는 원장을 정정할 수 없습니다.'],
    ['PAYROLL_SOURCE_ALREADY_REVERSED', 409, 'PAYROLL_SOURCE_ALREADY_REVERSED', '이미 반전된 원장입니다.'],
    ['PAYROLL_ROOT_ENTITLEMENT_NEGATIVE', 409, 'PAYROLL_ROOT_ENTITLEMENT_NEGATIVE', '누적 지급 권리가 0원 미만이 될 수 없습니다.'],
    ['STALE_ADJUSTMENT_VERSION', 409, 'STALE_ADJUSTMENT_VERSION', '정정 원장 version이 변경되었습니다.'],
    ['PAYROLL_LATE_EARNING_ALREADY_CARRIED', 409, 'PAYROLL_LATE_EARNING_ALREADY_CARRIED', '이미 이월된 늦은 수익입니다.'],
    ['PAYROLL_EARNING_NOT_LATE', 409, 'PAYROLL_EARNING_NOT_LATE', '지급 완료 또는 상계 완료 주차의 늦은 수익만 이월할 수 있습니다.'],
    ['PAYROLL_LATE_CARRY_TARGET_FROZEN', 409, 'PAYROLL_LATE_CARRY_TARGET_FROZEN', '다음 주차가 이미 동결되어 이월할 수 없습니다.'],
    ['PAYROLL_EARLIER_CARRY_PENDING', 409, 'PAYROLL_EARLIER_CARRY_PENDING', '앞선 주차의 잔여 이월을 먼저 처리해야 합니다.'],
    ['PAYROLL_PRIOR_LATE_EARNING_PENDING', 409, 'PAYROLL_PRIOR_LATE_EARNING_PENDING', '직전 주차의 늦은 수익을 먼저 이월해야 합니다.'],
    ['PAYROLL_SOURCE_NOT_FOUND', 404, 'PAYROLL_SOURCE_NOT_FOUND', '정정할 원장 항목을 찾을 수 없습니다.'],
    ['PAYROLL_ADJUSTMENT_INVALID', 400, 'PAYROLL_ADJUSTMENT_INVALID', '정정 요청을 확인해 주세요.'],
    ['PAYROLL_PAYMENT_ATTEMPT_NOT_FOUND', 404, 'PAYROLL_PAYMENT_ATTEMPT_NOT_FOUND', '지급 시도를 찾을 수 없습니다.'],
    ['PAYROLL_PAYMENT_ATTEMPT_TERMINAL', 409, 'PAYROLL_PAYMENT_ATTEMPT_TERMINAL', '이미 종료된 지급 시도입니다.'],
    ['PAYROLL_PAYMENT_TRANSITION_INVALID', 409, 'PAYROLL_PAYMENT_TRANSITION_INVALID', '현재 상태에서 해당 지급 결과를 기록할 수 없습니다.'],
    ['PAYROLL_PAYMENT_REFERENCE_ALREADY_USED', 409, 'PAYROLL_PAYMENT_REFERENCE_ALREADY_USED', '이미 사용된 외부 송금 참조입니다.'],
    ['PAYROLL_PAYMENT_REFERENCE_INVALID', 400, 'PAYROLL_PAYMENT_REFERENCE_INVALID', 'providerReferenceId 형식을 확인해 주세요.'],
    ['PAYROLL_PAYMENT_METHOD_INVALID', 400, 'PAYROLL_PAYMENT_METHOD_INVALID', 'paymentMethod를 확인해 주세요.'],
    ['PAYROLL_PAYMENT_REOPEN_REASON_INVALID', 400, 'PAYROLL_PAYMENT_REOPEN_REASON_INVALID', '재개 사유 코드를 확인해 주세요.'],
    ['PAYROLL_PAYMENT_REASON_INVALID', 400, 'PAYROLL_PAYMENT_REASON_INVALID', '확인 사유 코드를 확인해 주세요.'],
    ['PAYROLL_PAYMENT_RESULT_AMOUNT_MISMATCH', 409, 'PAYROLL_PAYMENT_RESULT_AMOUNT_MISMATCH', '잠긴 전액 지급 스냅샷이 일치하지 않습니다.'],
    ['IDEMPOTENCY_KEY_REUSED', 409, 'IDEMPOTENCY_KEY_REUSED', '이미 다른 요청에 사용한 Idempotency-Key입니다.']
  ];
  for (const [needle, statusCode, code, userMessage] of mappings) if (message.includes(needle)) return new AppError(statusCode, code, userMessage);
  return new AppError(500, 'PAYROLL_COMMAND_FAILED', '주급 정보를 처리하지 못했습니다.');
}

function cursorError(): AppError { return new AppError(400, 'PAYROLL_CURSOR_INVALID', '주급 cursor가 올바르지 않습니다.') }
function afterCycle(position: PayrollCursorPosition | null): string | null {
  if (!position) return null;
  if (!('maidProfileId' in position) || !uuidPattern.test(position.maidProfileId)) throw cursorError();
  return position.maidProfileId.toLowerCase();
}
function afterEntry(position: PayrollCursorPosition | null): { earnedOn: string | null; earningId: string | null } {
  if (!position) return { earnedOn: null, earningId: null };
  if (!('earnedOn' in position)) throw cursorError();
  return { earnedOn: date(position.earnedOn), earningId: uuid(position.earningId) };
}

export class SupabasePayrollService implements PayrollService {
  private readonly cursors: PayrollCursorCodec;
  constructor(private readonly clients: SupabaseClients, cursorSecret: string) { this.cursors = new PayrollCursorCodec(cursorSecret) }

  private projectCycle(value: unknown, actor: Actor, weekStart: string): PayrollCycleProjection {
    const parsed = internalCycle(value);
    const itemAfter = cursorPosition(parsed.itemsHasMore, parsed.itemsLastEarnedOn, parsed.itemsLastEarningId);
    const lateAfter = cursorPosition(parsed.lateEarningsHasMore, parsed.lateEarningsLastEarnedOn, parsed.lateEarningsLastEarningId);
    return {
      ...parsed.cycle,
      itemsNextCursor: itemAfter ? this.cursors.encode(payrollCursorScope(actor, weekStart, parsed.cycle.maidProfileId, 'items'), itemAfter) : null,
      lateEarningsNextCursor: lateAfter ? this.cursors.encode(payrollCursorScope(actor, weekStart, parsed.cycle.maidProfileId, 'lateEarnings'), lateAfter) : null
    };
  }

  async list(actor: Actor, input: PayrollListInput): Promise<PayrollListPage> {
    payrollReader(actor, input.maidProfileId);
    const scope = payrollCursorScope(actor, input.weekStart, input.maidProfileId, 'cycles');
    const position = input.cursor ? this.cursors.decode(input.cursor, scope) : null;
    const { data, error } = await this.clients.admin.rpc('list_payroll_cycles_page', {
      p_actor_profile_id: actor.profileId, p_week_start: input.weekStart, p_maid_profile_id: input.maidProfileId ?? null,
      p_after_maid_profile_id: afterCycle(position), p_limit: input.limit ?? PAYROLL_CYCLE_PAGE_DEFAULT
    });
    if (error || !data) throw payrollDatabaseError(error);
    const page = object(data);
    if (!Array.isArray(page.payroll)) throw payrollDatabaseError(null);
    if (page.payroll.length > (input.limit ?? PAYROLL_CYCLE_PAGE_DEFAULT)) throw payrollDatabaseError(null);
    const payroll = page.payroll.map((row) => this.projectCycle(row, actor, input.weekStart));
    const hasMore = boolean(page.hasMore);
    const last = nullableUuid(page.lastMaidProfileId);
    if (hasMore && !last) throw payrollDatabaseError(null);
    return { payroll, nextCursor: hasMore && last ? this.cursors.encode(scope, { maidProfileId: last }) : null };
  }

  async listEntries(actor: Actor, input: PayrollEntriesInput): Promise<PayrollEntriesPage> {
    payrollReader(actor, input.maidProfileId);
    const scope = payrollCursorScope(actor, input.weekStart, input.maidProfileId, input.kind);
    const position = input.cursor ? this.cursors.decode(input.cursor, scope) : null;
    const after = afterEntry(position);
    const { data, error } = await this.clients.admin.rpc('list_payroll_entries_page', {
      p_actor_profile_id: actor.profileId, p_week_start: input.weekStart, p_maid_profile_id: input.maidProfileId,
      p_kind: input.kind, p_after_earned_on: after.earnedOn, p_after_earning_id: after.earningId,
      p_limit: input.limit ?? PAYROLL_ENTRY_PAGE_DEFAULT
    });
    if (error || !data) throw payrollDatabaseError(error);
    const page = object(data);
    if (!Array.isArray(page.entries)) throw payrollDatabaseError(null);
    if (page.entries.length > (input.limit ?? PAYROLL_ENTRY_PAGE_DEFAULT)) throw payrollDatabaseError(null);
    const entries = input.kind === 'items' ? page.entries.map(item)
      : input.kind === 'lateEarnings' ? page.entries.map(lateEarning) : page.entries.map(adjustment);
    const hasMore = boolean(page.hasMore);
    const lastDate = nullableDate(page.lastEarnedOn);
    const lastId = nullableUuid(page.lastEarningId);
    if (hasMore && (!lastDate || !lastId)) throw payrollDatabaseError(null);
    return {
      kind: input.kind, entries,
      nextCursor: hasMore && lastDate && lastId ? this.cursors.encode(scope, { earnedOn: lastDate, earningId: lastId }) : null
    };
  }

  async start(actor: Actor, input: StartPayrollInput): Promise<PayrollCycleProjection> {
    payrollAdmin(actor);
    const fingerprint = { command: 'payroll.start', actorProfileId: actor.profileId, maidProfileId: input.maidProfileId, weekStart: input.weekStart, expectedVersion: input.expectedVersion };
    const { data, error } = await this.clients.admin.rpc('start_payroll_cycle', {
      p_actor_profile_id: actor.profileId, p_maid_profile_id: input.maidProfileId, p_week_start: input.weekStart,
      p_expected_version: input.expectedVersion, p_idempotency_key: input.idempotencyKey, p_request_hash: requestHash(fingerprint)
    });
    if (error || !data) throw payrollDatabaseError(error);
    return this.projectCycle(data, actor, input.weekStart);
  }

  private async adjustmentCommand(actor: Actor, input: PayrollAdjustmentInput | PayrollReversalInput,
    rpcName: 'record_payroll_correction' | 'reverse_payroll_source'): Promise<PayrollAdjustmentProjection> {
    payrollAdmin(actor);
    const command = rpcName === 'record_payroll_correction' ? 'payroll.adjustment.correct' : 'payroll.adjustment.reverse';
    const fingerprint = { command, actorProfileId: actor.profileId, sourceEarningId: input.sourceEarningId ?? null,
      sourceAdjustmentId: input.sourceAdjustmentId ?? null, ...('amount' in input ? { amount: input.amount } : {}), expectedVersion: input.expectedVersion };
    const args: Record<string, unknown> = { p_actor_profile_id: actor.profileId,
      p_source_earning_id: input.sourceEarningId ?? null, p_source_adjustment_id: input.sourceAdjustmentId ?? null,
      p_expected_book_version: input.expectedVersion, p_idempotency_key: input.idempotencyKey,
      p_request_hash: requestHash(fingerprint) };
    if ('amount' in input) args.p_amount = input.amount;
    const { data, error } = await this.clients.admin.rpc(rpcName, args);
    if (error || !data) throw payrollDatabaseError(error);
    return adjustmentProjection(data);
  }
  async correct(actor: Actor, input: PayrollAdjustmentInput): Promise<PayrollAdjustmentProjection> {
    return this.adjustmentCommand(actor, input, 'record_payroll_correction');
  }
  async reverse(actor: Actor, input: PayrollReversalInput): Promise<PayrollAdjustmentProjection> {
    return this.adjustmentCommand(actor, input, 'reverse_payroll_source');
  }
  async carryForward(actor: Actor, input: CarryForwardInput): Promise<PayrollCycleProjection> {
    payrollAdmin(actor);
    const fingerprint = { command: 'payroll.carry_forward', actorProfileId: actor.profileId,
      maidProfileId: input.maidProfileId, weekStart: input.weekStart, expectedVersion: input.expectedVersion };
    const { data, error } = await this.clients.admin.rpc('carry_forward_payroll_cycle', {
      p_actor_profile_id: actor.profileId, p_maid_profile_id: input.maidProfileId, p_week_start: input.weekStart,
      p_expected_version: input.expectedVersion, p_idempotency_key: input.idempotencyKey,
      p_request_hash: requestHash(fingerprint) });
    if (error || !data) throw payrollDatabaseError(error);
    return this.projectCycle(data, actor, input.weekStart);
  }
  async carryLateEarning(actor: Actor, input: LateEarningCarryInput): Promise<PayrollAdjustmentProjection> {
    payrollAdmin(actor);
    const fingerprint = { command: 'payroll.late_earning.carry', actorProfileId: actor.profileId,
      earningId: input.earningId, expectedVersion: input.expectedVersion };
    const { data, error } = await this.clients.admin.rpc('carry_late_payroll_earning', {
      p_actor_profile_id: actor.profileId, p_earning_id: input.earningId,
      p_expected_book_version: input.expectedVersion, p_idempotency_key: input.idempotencyKey,
      p_request_hash: requestHash(fingerprint) });
    if (error || !data) throw payrollDatabaseError(error);
    return adjustmentProjection(data);
  }
  private async paymentCommand(actor: Actor, input: PaymentCheckInput | PaymentPaidInput | PaymentReopenInput,
    rpcName: 'record_payroll_payment_check' | 'record_payroll_payment_paid' | 'reopen_payroll_payment_attempt'): Promise<PayrollPaymentResult> {
    payrollAdmin(actor);
    const command = rpcName === 'record_payroll_payment_check' ? 'payroll.payment.check'
      : rpcName === 'record_payroll_payment_paid' ? 'payroll.payment.paid' : 'payroll.payment.reopen';
    const canonicalReference = 'providerReferenceId' in input
      ? canonicalPayrollProviderReference(input.providerReferenceId) : undefined;
    const fingerprint = { command, actorProfileId: actor.profileId, paymentAttemptId: input.paymentAttemptId,
      expectedVersion: input.expectedVersion,
      ...('reasonCode' in input ? { reasonCode: input.reasonCode } : {}),
      ...('paymentMethod' in input ? { paymentMethod: input.paymentMethod, providerReferenceId: canonicalReference } : {}) };
    const args: Record<string, unknown> = { p_actor_profile_id: actor.profileId,
      p_payment_attempt_id: input.paymentAttemptId, p_expected_version: input.expectedVersion,
      p_idempotency_key: input.idempotencyKey, p_request_hash: requestHash(fingerprint) };
    if ('reasonCode' in input) args.p_reason_code = input.reasonCode;
    if ('paymentMethod' in input) { args.p_payment_method = input.paymentMethod; args.p_canonical_reference = canonicalReference; }
    const { data, error } = await this.clients.admin.rpc(rpcName, args);
    if (error || !data) throw payrollDatabaseError(error);
    return paymentResult(data);
  }
  async recordPaymentCheck(actor: Actor, input: PaymentCheckInput): Promise<PayrollPaymentResult> {
    return this.paymentCommand(actor, input, 'record_payroll_payment_check');
  }
  async recordPaymentPaid(actor: Actor, input: PaymentPaidInput): Promise<PayrollPaymentResult> {
    return this.paymentCommand(actor, input, 'record_payroll_payment_paid');
  }
  async reopenPayment(actor: Actor, input: PaymentReopenInput): Promise<PayrollPaymentResult> {
    return this.paymentCommand(actor, input, 'reopen_payroll_payment_attempt');
  }
}
