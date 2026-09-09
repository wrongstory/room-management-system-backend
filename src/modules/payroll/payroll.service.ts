import type { Actor } from '../../domain/actor.js';
import { AppError } from '../../lib/app-error.js';
import { requestHash } from '../../lib/command.js';
import type { SupabaseClients } from '../../lib/supabase.js';

export type PayrollStatus = 'open' | 'paying' | 'check' | 'paid';

export interface PayrollItem {
  earningId: string;
  earnedOn: string;
  amount: number;
  alreadyClaimed: boolean;
}

export interface PayrollLateEarning {
  earningId: string;
  earnedOn: string;
  amount: number;
}

export interface PayrollCycleProjection {
  cycleId: string | null;
  maidProfileId: string;
  weekStart: string;
  status: PayrollStatus;
  version: number;
  lockedAmount: number | null;
  paymentStartedAt: string | null;
  itemCount: number;
  totalAmount: number;
  items: PayrollItem[];
  lateEarningCount: number;
  lateEarningAmount: number;
  lateEarnings: PayrollLateEarning[];
}

export interface StartPayrollInput {
  maidProfileId: string;
  weekStart: string;
  expectedVersion: number;
  idempotencyKey: string;
}

export interface PayrollService {
  list(actor: Actor, weekStart: string, maidProfileId?: string): Promise<PayrollCycleProjection[]>;
  start(actor: Actor, input: StartPayrollInput): Promise<PayrollCycleProjection>;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function payrollReader(actor: Actor, maidProfileId?: string): void {
  if (actor.role !== 'admin' && actor.role !== 'maid') {
    throw new AppError(403, 'PAYROLL_ACCESS_REQUIRED', '주급 조회 권한이 필요합니다.');
  }
  if (actor.role === 'maid' && maidProfileId && maidProfileId !== actor.profileId) {
    throw new AppError(403, 'PAYROLL_ACCESS_REQUIRED', '본인의 주급만 조회할 수 있습니다.');
  }
}

function payrollAdmin(actor: Actor): void {
  if (actor.role !== 'admin') {
    throw new AppError(403, 'ADMIN_REQUIRED', '관리자만 주급 지급 처리를 시작할 수 있습니다.');
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw payrollDatabaseError(null);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw payrollDatabaseError(null);
  return value;
}

function nullableText(value: unknown): string | null {
  if (value === null) return null;
  return text(value);
}

function uuid(value: unknown): string {
  const parsed = text(value);
  if (!uuidPattern.test(parsed)) throw payrollDatabaseError(null);
  return parsed.toLowerCase();
}

function date(value: unknown): string {
  const parsed = text(value);
  const match = parsed.match(datePattern);
  const [year, month, day] = parsed.split('-').map(Number);
  const instant = new Date(Date.UTC(year ?? 0, (month ?? 0) - 1, day ?? 0));
  if (!match || instant.getUTCFullYear() !== year || instant.getUTCMonth() !== (month ?? 0) - 1 || instant.getUTCDate() !== day) throw payrollDatabaseError(null);
  return parsed;
}

function nullableTimestamp(value: unknown): string | null {
  const parsed = nullableText(value);
  if (
    parsed !== null
    && (!timestampPattern.test(parsed) || !Number.isFinite(Date.parse(parsed)))
  ) throw payrollDatabaseError(null);
  return parsed;
}

function integer(value: unknown): number {
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw payrollDatabaseError(null);
  }
  return parsed;
}

function item(value: unknown): PayrollItem {
  const row = object(value);
  if (typeof row.alreadyClaimed !== 'boolean') throw payrollDatabaseError(null);
  return {
    earningId: uuid(row.earningId),
    earnedOn: date(row.earnedOn),
    amount: integer(row.amount),
    alreadyClaimed: row.alreadyClaimed
  };
}

function lateEarning(value: unknown): PayrollLateEarning {
  const row = object(value);
  return {
    earningId: uuid(row.earningId),
    earnedOn: date(row.earnedOn),
    amount: integer(row.amount)
  };
}

export function toPayrollCycle(value: unknown): PayrollCycleProjection {
  const row = object(value);
  const status = text(row.status);
  if (!['open', 'paying', 'check', 'paid'].includes(status)) throw payrollDatabaseError(null);
  if (!Array.isArray(row.items) || !Array.isArray(row.lateEarnings)) {
    throw payrollDatabaseError(null);
  }
  return {
    cycleId: row.cycleId === null ? null : uuid(row.cycleId),
    maidProfileId: uuid(row.maidProfileId),
    weekStart: date(row.weekStart),
    status: status as PayrollStatus,
    version: integer(row.version),
    lockedAmount: row.lockedAmount === null ? null : integer(row.lockedAmount),
    paymentStartedAt: nullableTimestamp(row.paymentStartedAt),
    itemCount: integer(row.itemCount),
    totalAmount: integer(row.totalAmount),
    items: row.items.map(item),
    lateEarningCount: integer(row.lateEarningCount),
    lateEarningAmount: integer(row.lateEarningAmount),
    lateEarnings: row.lateEarnings.map(lateEarning)
  };
}

export function payrollDatabaseError(
  error: { message?: string } | null
): AppError {
  const message = error?.message ?? '';
  const mappings: Array<[string, number, string, string]> = [
    ['PAYROLL_ACCESS_REQUIRED', 403, 'PAYROLL_ACCESS_REQUIRED', '주급 조회 권한이 필요합니다.'],
    ['ADMIN_REQUIRED', 403, 'ADMIN_REQUIRED', '관리자만 주급 지급 처리를 시작할 수 있습니다.'],
    ['PAYROLL_MAID_NOT_FOUND', 404, 'PAYROLL_MAID_NOT_FOUND', '메이드 계정을 찾을 수 없습니다.'],
    ['PAYROLL_WEEK_MUST_START_MONDAY', 400, 'PAYROLL_WEEK_MUST_START_MONDAY', 'weekStart는 월요일이어야 합니다.'],
    ['INVALID_EXPECTED_VERSION', 400, 'INVALID_EXPECTED_VERSION', 'expectedVersion을 확인해 주세요.'],
    ['PAYROLL_WEEK_NOT_CLOSED', 409, 'PAYROLL_WEEK_NOT_CLOSED', '종료된 주차만 지급 처리를 시작할 수 있습니다.'],
    ['PAYROLL_CYCLE_NOT_OPEN', 409, 'PAYROLL_CYCLE_NOT_OPEN', 'OPEN 주급 주기만 지급 처리를 시작할 수 있습니다.'],
    ['STALE_VERSION', 409, 'STALE_VERSION', '주급 version이 변경되었습니다. 최신 상태를 다시 확인해 주세요.'],
    ['NO_PAYROLL_AMOUNT', 409, 'NO_PAYROLL_AMOUNT', '지급 처리할 확정 수익이 없습니다.'],
    ['IDEMPOTENCY_KEY_REUSED', 409, 'IDEMPOTENCY_KEY_REUSED', '이미 다른 요청에 사용한 Idempotency-Key입니다.']
  ];
  for (const [needle, statusCode, code, userMessage] of mappings) {
    if (message.includes(needle)) return new AppError(statusCode, code, userMessage);
  }
  return new AppError(500, 'PAYROLL_COMMAND_FAILED', '주급 정보를 처리하지 못했습니다.');
}

export class SupabasePayrollService implements PayrollService {
  constructor(private readonly clients: SupabaseClients) {}

  async list(
    actor: Actor,
    weekStart: string,
    maidProfileId?: string
  ): Promise<PayrollCycleProjection[]> {
    payrollReader(actor, maidProfileId);
    const { data, error } = await this.clients.admin.rpc('list_payroll_cycles', {
      p_actor_profile_id: actor.profileId,
      p_week_start: weekStart,
      p_maid_profile_id: maidProfileId ?? null
    });
    if (error || !Array.isArray(data)) throw payrollDatabaseError(error);
    return data.map(toPayrollCycle);
  }

  async start(actor: Actor, input: StartPayrollInput): Promise<PayrollCycleProjection> {
    payrollAdmin(actor);
    const fingerprint = {
      command: 'payroll.start',
      actorProfileId: actor.profileId,
      maidProfileId: input.maidProfileId,
      weekStart: input.weekStart,
      expectedVersion: input.expectedVersion
    };
    const { data, error } = await this.clients.admin.rpc('start_payroll_cycle', {
      p_actor_profile_id: actor.profileId,
      p_maid_profile_id: input.maidProfileId,
      p_week_start: input.weekStart,
      p_expected_version: input.expectedVersion,
      p_idempotency_key: input.idempotencyKey,
      p_request_hash: requestHash(fingerprint)
    });
    if (error || !data) throw payrollDatabaseError(error);
    return toPayrollCycle(data);
  }
}
