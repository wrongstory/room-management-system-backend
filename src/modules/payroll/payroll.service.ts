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
export type PayrollEntryKind = 'items' | 'lateEarnings';

export interface PayrollItem { earningId: string; earnedOn: string; amount: number; alreadyClaimed: boolean }
export interface PayrollLateEarning { earningId: string; earnedOn: string; amount: number }
export interface PayrollCycleProjection {
  cycleId: string | null; maidProfileId: string; weekStart: string; status: PayrollStatus;
  version: number; lockedAmount: number | null; paymentStartedAt: string | null;
  itemCount: number; totalAmount: number; items: PayrollItem[]; itemsNextCursor: string | null;
  lateEarningCount: number; lateEarningAmount: number; lateEarnings: PayrollLateEarning[];
  lateEarningsNextCursor: string | null;
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
  kind: PayrollEntryKind; entries: Array<PayrollItem | PayrollLateEarning>; nextCursor: string | null;
}
export interface StartPayrollInput {
  maidProfileId: string; weekStart: string; expectedVersion: number; idempotencyKey: string;
}
export interface PayrollService {
  list(actor: Actor, input: PayrollListInput): Promise<PayrollListPage>;
  listEntries(actor: Actor, input: PayrollEntriesInput): Promise<PayrollEntriesPage>;
  start(actor: Actor, input: StartPayrollInput): Promise<PayrollCycleProjection>;
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
    const entries = input.kind === 'items' ? page.entries.map(item) : page.entries.map(lateEarning);
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
}
