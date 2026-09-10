import { idempotencyKey, readJsonBody } from "./account-api.ts";
import {
  assertPayrollCursorConfigured,
  type CursorPosition,
  decodePayrollCursor,
  encodePayrollCursor,
  PAYROLL_CURSOR_MAX_LENGTH,
  PAYROLL_CYCLE_PAGE_DEFAULT,
  PAYROLL_CYCLE_PAGE_MAX,
  PAYROLL_ENTRY_PAGE_DEFAULT,
  PAYROLL_ENTRY_PAGE_MAX,
  PAYROLL_NESTED_PREVIEW_MAX,
  payrollCursorScope,
} from "./payroll-cursor.ts";
import {
  type EdgeActor,
  type EdgeClients,
  EdgeError,
  requireBusinessAdmin,
  requirePasswordChanged,
} from "./runtime.ts";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function invalid(message = "주급 요청 값을 확인해 주세요."): never {
  throw new EdgeError(400, "VALIDATION_ERROR", message);
}

function uuid(value: unknown, name: string): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    invalid(`${name}에 UUID가 필요합니다.`);
  }
  return value.toLowerCase();
}

function date(value: unknown): string {
  if (typeof value !== "string" || !datePattern.test(value)) {
    invalid("weekStart는 YYYY-MM-DD 형식이어야 합니다.");
  }
  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    invalid("weekStart에 유효한 날짜가 필요합니다.");
  }
  return value;
}

function noQuery(request: Request): void {
  if ([...new URL(request.url).searchParams.keys()].length > 0) {
    invalid("이 요청에는 query 항목을 사용할 수 없습니다.");
  }
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    invalid("expectedVersion은 0 이상의 정수여야 합니다.");
  }
  return value as number;
}

function positiveExpectedVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    invalid("expectedVersion은 1 이상의 정수여야 합니다.");
  }
  return value as number;
}

function providerReference(value: unknown): string {
  if (
    typeof value !== "string" || value.length < 8 || value.length > 64 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$/.test(value) ||
    !/[A-Za-z]/.test(value) || !/[0-9]/.test(value) || /[0-9]{7}/.test(value) ||
    value.toLowerCase().includes("http") ||
    value.toLowerCase().startsWith("www.")
  ) {
    throw new EdgeError(
      400,
      "PAYROLL_PAYMENT_REFERENCE_INVALID",
      "providerReferenceId 형식을 확인해 주세요.",
    );
  }
  return value.toUpperCase();
}

function exactFields(
  body: Record<string, unknown>,
  expected: readonly string[],
): void {
  if (
    Object.keys(body).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(body, key)) ||
    Object.keys(body).some((key) => !expected.includes(key))
  ) invalid();
}

function pageInteger(
  value: string | null,
  maximum: number,
  fallback: number,
): number {
  if (value === null) return fallback;
  if (!/^[1-9]\d*$/.test(value)) {
    invalid("limit은 허용 범위의 정수여야 합니다.");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    invalid("limit은 허용 범위의 정수여야 합니다.");
  }
  return parsed;
}

function query(
  request: Request,
): {
  weekStart: string;
  maidProfileId: string | null;
  limit: number;
  cursor: string | null;
} {
  const search = new URL(request.url).searchParams;
  for (const key of search.keys()) {
    if (
      !["weekStart", "maidProfileId", "limit", "cursor"].includes(key) ||
      search.getAll(key).length !== 1
    ) {
      invalid("허용되지 않거나 중복된 query 항목입니다.");
    }
  }
  const weekStart = date(search.get("weekStart"));
  const maidValue = search.get("maidProfileId");
  const cursor = search.get("cursor");
  if (
    cursor !== null &&
    (cursor.length < 1 || cursor.length > PAYROLL_CURSOR_MAX_LENGTH)
  ) invalid("cursor 길이가 올바르지 않습니다.");
  return {
    weekStart,
    maidProfileId: maidValue === null ? null : uuid(maidValue, "maidProfileId"),
    limit: pageInteger(
      search.get("limit"),
      PAYROLL_CYCLE_PAGE_MAX,
      PAYROLL_CYCLE_PAGE_DEFAULT,
    ),
    cursor,
  };
}

function entriesQuery(
  request: Request,
): {
  weekStart: string;
  maidProfileId: string;
  kind: "items" | "lateEarnings" | "adjustments";
  limit: number;
  cursor: string | null;
} {
  const search = new URL(request.url).searchParams;
  for (const key of search.keys()) {
    if (
      !["weekStart", "maidProfileId", "kind", "limit", "cursor"].includes(
        key,
      ) || search.getAll(key).length !== 1
    ) invalid("허용되지 않거나 중복된 query 항목입니다.");
  }
  const kind = search.get("kind");
  if (kind !== "items" && kind !== "lateEarnings" && kind !== "adjustments") {
    invalid("kind는 items, lateEarnings 또는 adjustments여야 합니다.");
  }
  const cursor = search.get("cursor");
  if (
    cursor !== null &&
    (cursor.length < 1 || cursor.length > PAYROLL_CURSOR_MAX_LENGTH)
  ) invalid("cursor 길이가 올바르지 않습니다.");
  return {
    weekStart: date(search.get("weekStart")),
    maidProfileId: uuid(search.get("maidProfileId"), "maidProfileId"),
    kind,
    limit: pageInteger(
      search.get("limit"),
      PAYROLL_ENTRY_PAGE_MAX,
      PAYROLL_ENTRY_PAGE_DEFAULT,
    ),
    cursor,
  };
}

function reader(actor: EdgeActor, maidProfileId: string | null): void {
  requirePasswordChanged(actor);
  if (actor.role !== "admin" && actor.role !== "maid") {
    throw new EdgeError(
      403,
      "PAYROLL_ACCESS_REQUIRED",
      "주급 조회 권한이 필요합니다.",
    );
  }
  if (
    actor.role === "maid" && maidProfileId && maidProfileId !== actor.profileId
  ) {
    throw new EdgeError(
      403,
      "PAYROLL_ACCESS_REQUIRED",
      "본인의 주급만 조회할 수 있습니다.",
    );
  }
}

function admin(actor: EdgeActor): void {
  requirePasswordChanged(actor);
  requireBusinessAdmin(actor);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonical(nested)]),
    );
  }
  return value;
}

async function requestHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(canonical(value))),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function payrollDatabaseError(
  error: { message?: string } | null,
): EdgeError {
  const message = error?.message ?? "";
  const mappings: Array<[string, number, string]> = [
    ["PAYROLL_ACCESS_REQUIRED", 403, "주급 조회 권한이 필요합니다."],
    ["ADMIN_REQUIRED", 403, "관리자만 주급 지급 처리를 시작할 수 있습니다."],
    ["PAYROLL_MAID_NOT_FOUND", 404, "메이드 계정을 찾을 수 없습니다."],
    ["PAYROLL_WEEK_MUST_START_MONDAY", 400, "weekStart는 월요일이어야 합니다."],
    [
      "PAYROLL_PAGE_LIMIT_INVALID",
      400,
      "주급 page size가 허용 범위를 벗어났습니다.",
    ],
    [
      "PAYROLL_PAGE_KIND_INVALID",
      400,
      "주급 상세 page 종류가 올바르지 않습니다.",
    ],
    ["PAYROLL_CURSOR_INVALID", 400, "주급 cursor가 올바르지 않습니다."],
    ["INVALID_EXPECTED_VERSION", 400, "expectedVersion을 확인해 주세요."],
    [
      "PAYROLL_WEEK_NOT_CLOSED",
      409,
      "종료된 주차만 지급 처리를 시작할 수 있습니다.",
    ],
    [
      "PAYROLL_CYCLE_NOT_OPEN",
      409,
      "OPEN 주급 주기만 지급 처리를 시작할 수 있습니다.",
    ],
    ["STALE_VERSION", 409, "주급 version이 변경되었습니다."],
    ["NO_PAYROLL_AMOUNT", 409, "지급 처리할 확정 수익이 없습니다."],
    [
      "PAYROLL_NONPOSITIVE_REQUIRES_CARRY",
      409,
      "0원 이하 주급은 이월 상계가 필요합니다.",
    ],
    [
      "PAYROLL_POSITIVE_REQUIRES_START",
      409,
      "양수 주급은 지급 시작으로 처리해야 합니다.",
    ],
    [
      "PAYROLL_CYCLE_ECONOMICALLY_FROZEN",
      409,
      "상계 완료 주차는 경제적으로 동결되었습니다.",
    ],
    [
      "PAYROLL_SOURCE_PAYMENT_UNCERTAIN",
      409,
      "지급 결과 확인 전에는 원장을 정정할 수 없습니다.",
    ],
    ["PAYROLL_SOURCE_ALREADY_REVERSED", 409, "이미 반전된 원장입니다."],
    [
      "PAYROLL_ROOT_ENTITLEMENT_NEGATIVE",
      409,
      "누적 지급 권리가 0원 미만이 될 수 없습니다.",
    ],
    ["STALE_ADJUSTMENT_VERSION", 409, "정정 원장 version이 변경되었습니다."],
    [
      "PAYROLL_LATE_EARNING_ALREADY_CARRIED",
      409,
      "이미 이월된 늦은 수익입니다.",
    ],
    [
      "PAYROLL_EARNING_NOT_LATE",
      409,
      "지급 완료 또는 상계 완료 주차의 늦은 수익만 이월할 수 있습니다.",
    ],
    [
      "PAYROLL_LATE_CARRY_TARGET_FROZEN",
      409,
      "다음 주차가 이미 동결되어 이월할 수 없습니다.",
    ],
    [
      "PAYROLL_EARLIER_CARRY_PENDING",
      409,
      "앞선 주차의 잔여 이월을 먼저 처리해야 합니다.",
    ],
    [
      "PAYROLL_PRIOR_LATE_EARNING_PENDING",
      409,
      "직전 주차의 늦은 수익을 먼저 이월해야 합니다.",
    ],
    ["PAYROLL_SOURCE_NOT_FOUND", 404, "정정할 원장 항목을 찾을 수 없습니다."],
    ["PAYROLL_ADJUSTMENT_INVALID", 400, "정정 요청을 확인해 주세요."],
    ["PAYROLL_PAYMENT_ATTEMPT_NOT_FOUND", 404, "지급 시도를 찾을 수 없습니다."],
    ["PAYROLL_PAYMENT_ATTEMPT_TERMINAL", 409, "이미 종료된 지급 시도입니다."],
    [
      "PAYROLL_PAYMENT_TRANSITION_INVALID",
      409,
      "현재 상태에서 해당 지급 결과를 기록할 수 없습니다.",
    ],
    [
      "PAYROLL_PAYMENT_REFERENCE_ALREADY_USED",
      409,
      "이미 사용된 외부 송금 참조입니다.",
    ],
    [
      "PAYROLL_PAYMENT_REFERENCE_INVALID",
      400,
      "providerReferenceId 형식을 확인해 주세요.",
    ],
    ["PAYROLL_PAYMENT_METHOD_INVALID", 400, "paymentMethod를 확인해 주세요."],
    [
      "PAYROLL_PAYMENT_REOPEN_REASON_INVALID",
      400,
      "재개 사유 코드를 확인해 주세요.",
    ],
    ["PAYROLL_PAYMENT_REASON_INVALID", 400, "확인 사유 코드를 확인해 주세요."],
    [
      "PAYROLL_PAYMENT_RESULT_AMOUNT_MISMATCH",
      409,
      "잠긴 전액 지급 스냅샷이 일치하지 않습니다.",
    ],
    [
      "IDEMPOTENCY_KEY_REUSED",
      409,
      "이미 다른 요청에 사용한 Idempotency-Key입니다.",
    ],
  ];
  for (const [code, status, userMessage] of mappings) {
    if (message.includes(code)) return new EdgeError(status, code, userMessage);
  }
  return new EdgeError(
    500,
    "PAYROLL_COMMAND_FAILED",
    "주급 정보를 처리하지 못했습니다.",
  );
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw payrollDatabaseError(null);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string") throw payrollDatabaseError(null);
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}

function projectedUuid(value: unknown): string {
  const parsed = text(value);
  if (!uuidPattern.test(parsed)) throw payrollDatabaseError(null);
  return parsed.toLowerCase();
}

function nullableUuid(value: unknown): string | null {
  return value === null ? null : projectedUuid(value);
}

function projectedDate(value: unknown): string {
  const parsed = text(value);
  const [year, month, day] = parsed.split("-").map(Number);
  const instant = new Date(Date.UTC(year ?? 0, (month ?? 0) - 1, day ?? 0));
  if (
    !datePattern.test(parsed) || instant.getUTCFullYear() !== year ||
    instant.getUTCMonth() !== (month ?? 0) - 1 || instant.getUTCDate() !== day
  ) {
    throw payrollDatabaseError(null);
  }
  return parsed;
}

function nullableDate(value: unknown): string | null {
  return value === null ? null : projectedDate(value);
}

function nullableTimestamp(value: unknown): string | null {
  const parsed = nullableText(value);
  if (
    parsed !== null &&
    (!timestampPattern.test(parsed) || !Number.isFinite(Date.parse(parsed)))
  ) {
    throw payrollDatabaseError(null);
  }
  return parsed;
}

function integer(value: unknown): number {
  const parsed = typeof value === "string" && /^\d+$/.test(value)
    ? Number(value)
    : value;
  if (
    typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0
  ) {
    throw payrollDatabaseError(null);
  }
  return parsed;
}

function signedInteger(value: unknown): number {
  const parsed = typeof value === "string" && /^-?\d+$/.test(value)
    ? Number(value)
    : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed)) {
    throw payrollDatabaseError(null);
  }
  return parsed;
}
function krw(value: unknown): "KRW" {
  if (value !== "KRW") throw payrollDatabaseError(null);
  return "KRW";
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw payrollDatabaseError(null);
  return value;
}

interface InternalProjection {
  cycle: Record<string, unknown>;
  itemsAfter: CursorPosition | null;
  lateEarningsAfter: CursorPosition | null;
}

function projection(value: unknown): InternalProjection {
  const row = object(value);
  const status = text(row.status);
  if (!["open", "paying", "check", "paid"].includes(status)) {
    throw payrollDatabaseError(null);
  }
  if (!Array.isArray(row.items) || !Array.isArray(row.lateEarnings)) {
    throw payrollDatabaseError(null);
  }
  if (
    row.items.length > PAYROLL_NESTED_PREVIEW_MAX ||
    row.lateEarnings.length > PAYROLL_NESTED_PREVIEW_MAX
  ) throw payrollDatabaseError(null);
  const itemsHasMore = boolean(row.itemsHasMore);
  const itemsLastEarnedOn = nullableDate(row.itemsLastEarnedOn);
  const itemsLastEarningId = nullableUuid(row.itemsLastEarningId);
  const lateEarningsHasMore = boolean(row.lateEarningsHasMore);
  const lateEarningsLastEarnedOn = nullableDate(row.lateEarningsLastEarnedOn);
  const lateEarningsLastEarningId = nullableUuid(
    row.lateEarningsLastEarningId,
  );
  if (
    (itemsHasMore && (!itemsLastEarnedOn || !itemsLastEarningId)) ||
    (lateEarningsHasMore &&
      (!lateEarningsLastEarnedOn || !lateEarningsLastEarningId))
  ) throw payrollDatabaseError(null);
  return {
    cycle: {
      cycleId: row.cycleId === null ? null : projectedUuid(row.cycleId),
      maidProfileId: projectedUuid(row.maidProfileId),
      weekStart: projectedDate(row.weekStart),
      status,
      version: integer(row.version),
      lockedAmount: row.lockedAmount === null
        ? null
        : integer(row.lockedAmount),
      paymentStartedAt: nullableTimestamp(row.paymentStartedAt),
      itemCount: integer(row.itemCount),
      totalAmount: integer(row.totalAmount),
      items: row.items.map((value) => {
        const item = object(value);
        if (typeof item.alreadyClaimed !== "boolean") {
          throw payrollDatabaseError(null);
        }
        return {
          earningId: projectedUuid(item.earningId),
          earnedOn: projectedDate(item.earnedOn),
          amount: integer(item.amount),
          alreadyClaimed: item.alreadyClaimed,
        };
      }),
      itemsNextCursor: null,
      lateEarningCount: integer(row.lateEarningCount),
      lateEarningAmount: integer(row.lateEarningAmount),
      lateEarnings: row.lateEarnings.map((value) => {
        const item = object(value);
        return {
          earningId: projectedUuid(item.earningId),
          earnedOn: projectedDate(item.earnedOn),
          amount: integer(item.amount),
        };
      }),
      lateEarningsNextCursor: null,
      offsetSettled: boolean(row.offsetSettled),
      adjustmentAmount: signedInteger(row.adjustmentAmount),
      carryInAmount: signedInteger(row.carryInAmount),
      carryOutAmount: signedInteger(row.carryOutAmount),
      payableAmount: signedInteger(row.payableAmount),
      adjustmentCount: integer(row.adjustmentCount),
      paymentAttemptId:
        row.paymentAttemptId === undefined || row.paymentAttemptId === null
          ? null
          : projectedUuid(row.paymentAttemptId),
      paymentAttemptNumber: row.paymentAttemptNumber === undefined ||
          row.paymentAttemptNumber === null
        ? null
        : integer(row.paymentAttemptNumber),
      paidAt: row.paidAt === undefined ? null : nullableTimestamp(row.paidAt),
      checkReasonCode:
        row.checkReasonCode === undefined || row.checkReasonCode === null
          ? null
          : text(row.checkReasonCode),
      lastReopenReasonCode: row.lastReopenReasonCode === undefined ||
          row.lastReopenReasonCode === null
        ? null
        : text(row.lastReopenReasonCode),
    },
    itemsAfter: itemsHasMore
      ? {
        earnedOn: itemsLastEarnedOn as string,
        earningId: itemsLastEarningId as string,
      }
      : null,
    lateEarningsAfter: lateEarningsHasMore
      ? {
        earnedOn: lateEarningsLastEarnedOn as string,
        earningId: lateEarningsLastEarningId as string,
      }
      : null,
  };
}

async function publicProjection(
  value: unknown,
  actor: EdgeActor,
  weekStart: string,
): Promise<Record<string, unknown>> {
  const projected = projection(value);
  const maidProfileId = projected.cycle.maidProfileId as string;
  return {
    ...projected.cycle,
    itemsNextCursor: projected.itemsAfter
      ? await encodePayrollCursor(
        payrollCursorScope(actor, weekStart, maidProfileId, "items"),
        projected.itemsAfter,
      )
      : null,
    lateEarningsNextCursor: projected.lateEarningsAfter
      ? await encodePayrollCursor(
        payrollCursorScope(actor, weekStart, maidProfileId, "lateEarnings"),
        projected.lateEarningsAfter,
      )
      : null,
  };
}

function afterCycle(position: CursorPosition | null): string | null {
  if (!position) return null;
  if (!("maidProfileId" in position)) {
    throw new EdgeError(
      400,
      "PAYROLL_CURSOR_INVALID",
      "주급 cursor가 올바르지 않습니다.",
    );
  }
  return uuid(position.maidProfileId, "cursor");
}

function afterEntry(position: CursorPosition | null): {
  earnedOn: string | null;
  earningId: string | null;
} {
  if (!position) return { earnedOn: null, earningId: null };
  if (!("earnedOn" in position)) {
    throw new EdgeError(
      400,
      "PAYROLL_CURSOR_INVALID",
      "주급 cursor가 올바르지 않습니다.",
    );
  }
  return {
    earnedOn: date(position.earnedOn),
    earningId: uuid(position.earningId, "cursor"),
  };
}

function itemProjection(value: unknown): Record<string, unknown> {
  const item = object(value);
  if (typeof item.alreadyClaimed !== "boolean") {
    throw payrollDatabaseError(null);
  }
  return {
    earningId: projectedUuid(item.earningId),
    earnedOn: projectedDate(item.earnedOn),
    amount: integer(item.amount),
    alreadyClaimed: item.alreadyClaimed,
  };
}

function lateEarningProjection(value: unknown): Record<string, unknown> {
  const item = object(value);
  return {
    earningId: projectedUuid(item.earningId),
    earnedOn: projectedDate(item.earnedOn),
    amount: integer(item.amount),
  };
}

function adjustmentProjection(value: unknown): Record<string, unknown> {
  const item = object(value);
  const reasonCode = text(item.reasonCode);
  if (
    ![
      "earning_correction",
      "adjustment_correction",
      "earning_reversal",
      "adjustment_reversal",
      "late_earning_carry",
    ].includes(reasonCode)
  ) throw payrollDatabaseError(null);
  return {
    adjustmentId: projectedUuid(item.adjustmentId),
    availableWeekStart: projectedDate(item.availableWeekStart),
    amount: signedInteger(item.amount),
    reasonCode,
    alreadyClaimed: item.alreadyClaimed === undefined
      ? false
      : boolean(item.alreadyClaimed),
    ...(item.maidProfileId === undefined
      ? {}
      : { maidProfileId: projectedUuid(item.maidProfileId) }),
    ...(item.bookVersion === undefined
      ? {}
      : { bookVersion: integer(item.bookVersion) }),
    ...(item.currency === undefined ? {} : { currency: krw(item.currency) }),
    ...(item.rootEarningId === undefined
      ? {}
      : { rootEarningId: projectedUuid(item.rootEarningId) }),
    ...(item.correctionOfEarningId === undefined
      ? {}
      : { correctionOfEarningId: projectedUuid(item.correctionOfEarningId) }),
    ...(item.correctionOfAdjustmentId === undefined ? {} : {
      correctionOfAdjustmentId: projectedUuid(item.correctionOfAdjustmentId),
    }),
    ...(item.reversalOfEarningId === undefined
      ? {}
      : { reversalOfEarningId: projectedUuid(item.reversalOfEarningId) }),
    ...(item.reversalOfAdjustmentId === undefined
      ? {}
      : { reversalOfAdjustmentId: projectedUuid(item.reversalOfAdjustmentId) }),
    ...(item.lateCarriedEarningId === undefined
      ? {}
      : { lateCarriedEarningId: projectedUuid(item.lateCarriedEarningId) }),
    ...(item.createdAt === undefined
      ? {}
      : { createdAt: text(item.createdAt) }),
  };
}

export async function listPayroll(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
): Promise<Record<string, unknown>> {
  const input = query(request);
  reader(actor, input.maidProfileId);
  assertPayrollCursorConfigured();
  const scope = payrollCursorScope(
    actor,
    input.weekStart,
    input.maidProfileId,
    "cycles",
  );
  const position = input.cursor
    ? await decodePayrollCursor(input.cursor, scope)
    : null;
  const { data, error } = await clients.admin.rpc("list_payroll_cycles_page", {
    p_actor_profile_id: actor.profileId,
    p_week_start: input.weekStart,
    p_maid_profile_id: input.maidProfileId,
    p_after_maid_profile_id: afterCycle(position),
    p_limit: input.limit,
  });
  if (error || !data) throw payrollDatabaseError(error);
  const page = object(data);
  if (!Array.isArray(page.payroll)) throw payrollDatabaseError(null);
  if (page.payroll.length > input.limit) throw payrollDatabaseError(null);
  const payroll = await Promise.all(
    page.payroll.map((item) => publicProjection(item, actor, input.weekStart)),
  );
  const hasMore = boolean(page.hasMore);
  const lastMaidProfileId = nullableUuid(page.lastMaidProfileId);
  if (hasMore && !lastMaidProfileId) throw payrollDatabaseError(null);
  return {
    payroll,
    nextCursor: hasMore && lastMaidProfileId
      ? await encodePayrollCursor(scope, {
        maidProfileId: lastMaidProfileId,
      })
      : null,
  };
}

export async function listPayrollEntries(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
): Promise<Record<string, unknown>> {
  const input = entriesQuery(request);
  reader(actor, input.maidProfileId);
  assertPayrollCursorConfigured();
  const scope = payrollCursorScope(
    actor,
    input.weekStart,
    input.maidProfileId,
    input.kind,
  );
  const position = input.cursor
    ? await decodePayrollCursor(input.cursor, scope)
    : null;
  const after = afterEntry(position);
  const { data, error } = await clients.admin.rpc(
    "list_payroll_entries_page",
    {
      p_actor_profile_id: actor.profileId,
      p_week_start: input.weekStart,
      p_maid_profile_id: input.maidProfileId,
      p_kind: input.kind,
      p_after_earned_on: after.earnedOn,
      p_after_earning_id: after.earningId,
      p_limit: input.limit,
    },
  );
  if (error || !data) throw payrollDatabaseError(error);
  const page = object(data);
  if (!Array.isArray(page.entries)) throw payrollDatabaseError(null);
  if (page.entries.length > input.limit) throw payrollDatabaseError(null);
  const entries = page.entries.map(
    input.kind === "items"
      ? itemProjection
      : input.kind === "lateEarnings"
      ? lateEarningProjection
      : adjustmentProjection,
  );
  const hasMore = boolean(page.hasMore);
  const lastEarnedOn = nullableDate(page.lastEarnedOn);
  const lastEarningId = nullableUuid(page.lastEarningId);
  if (hasMore && (!lastEarnedOn || !lastEarningId)) {
    throw payrollDatabaseError(null);
  }
  return {
    kind: input.kind,
    entries,
    nextCursor: hasMore
      ? await encodePayrollCursor(scope, {
        earnedOn: lastEarnedOn as string,
        earningId: lastEarningId as string,
      })
      : null,
  };
}

export async function startPayroll(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
): Promise<Record<string, unknown>> {
  admin(actor);
  assertPayrollCursorConfigured();
  noQuery(request);
  const body = await readJsonBody(request);
  exactFields(body, ["maidProfileId", "weekStart", "expectedVersion"]);
  const input = {
    maidProfileId: uuid(body.maidProfileId, "maidProfileId"),
    weekStart: date(body.weekStart),
    expectedVersion: nonNegativeInteger(body.expectedVersion),
  };
  const key = idempotencyKey(request);
  const fingerprint = {
    command: "payroll.start",
    actorProfileId: actor.profileId,
    ...input,
  };
  const { data, error } = await clients.admin.rpc("start_payroll_cycle", {
    p_actor_profile_id: actor.profileId,
    p_maid_profile_id: input.maidProfileId,
    p_week_start: input.weekStart,
    p_expected_version: input.expectedVersion,
    p_idempotency_key: key,
    p_request_hash: await requestHash(fingerprint),
  });
  if (error || !data) throw payrollDatabaseError(error);
  return await publicProjection(data, actor, input.weekStart);
}

function adjustmentSource(body: Record<string, unknown>): {
  sourceEarningId: string | null;
  sourceAdjustmentId: string | null;
  expectedVersion: number;
} {
  const allowed = ["sourceEarningId", "sourceAdjustmentId", "expectedVersion"];
  if (
    Object.keys(body).some((key) => !allowed.includes(key)) ||
    Number(Object.hasOwn(body, "sourceEarningId")) +
          Number(Object.hasOwn(body, "sourceAdjustmentId")) !== 1 ||
    !Object.hasOwn(body, "expectedVersion")
  ) invalid();
  return {
    sourceEarningId: Object.hasOwn(body, "sourceEarningId")
      ? uuid(body.sourceEarningId, "sourceEarningId")
      : null,
    sourceAdjustmentId: Object.hasOwn(body, "sourceAdjustmentId")
      ? uuid(body.sourceAdjustmentId, "sourceAdjustmentId")
      : null,
    expectedVersion: nonNegativeInteger(body.expectedVersion),
  };
}

export async function correctPayrollAdjustment(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
): Promise<Record<string, unknown>> {
  admin(actor);
  noQuery(request);
  const body = await readJsonBody(request);
  const source = adjustmentSource(
    Object.fromEntries(
      Object.entries(body).filter(([key]) => key !== "amount"),
    ),
  );
  if (
    !Object.hasOwn(body, "amount") ||
    Object.keys(body).length !== 4 && Object.keys(body).length !== 3
  ) invalid();
  const amount = signedInteger(body.amount);
  if (amount === 0) invalid("amount는 0이 아닌 정수여야 합니다.");
  const key = idempotencyKey(request);
  const fingerprint = {
    command: "payroll.adjustment.correct",
    actorProfileId: actor.profileId,
    ...source,
    amount,
  };
  const { data, error } = await clients.admin.rpc("record_payroll_correction", {
    p_actor_profile_id: actor.profileId,
    p_source_earning_id: source.sourceEarningId,
    p_source_adjustment_id: source.sourceAdjustmentId,
    p_amount: amount,
    p_expected_book_version: source.expectedVersion,
    p_idempotency_key: key,
    p_request_hash: await requestHash(fingerprint),
  });
  if (error || !data) throw payrollDatabaseError(error);
  return adjustmentProjection(data);
}

export async function reversePayrollSource(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
): Promise<Record<string, unknown>> {
  admin(actor);
  noQuery(request);
  const source = adjustmentSource(await readJsonBody(request));
  const key = idempotencyKey(request);
  const fingerprint = {
    command: "payroll.adjustment.reverse",
    actorProfileId: actor.profileId,
    ...source,
  };
  const { data, error } = await clients.admin.rpc("reverse_payroll_source", {
    p_actor_profile_id: actor.profileId,
    p_source_earning_id: source.sourceEarningId,
    p_source_adjustment_id: source.sourceAdjustmentId,
    p_expected_book_version: source.expectedVersion,
    p_idempotency_key: key,
    p_request_hash: await requestHash(fingerprint),
  });
  if (error || !data) throw payrollDatabaseError(error);
  return adjustmentProjection(data);
}

export async function carryForwardPayroll(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
): Promise<Record<string, unknown>> {
  admin(actor);
  noQuery(request);
  const body = await readJsonBody(request);
  exactFields(body, ["maidProfileId", "weekStart", "expectedVersion"]);
  const input = {
    maidProfileId: uuid(body.maidProfileId, "maidProfileId"),
    weekStart: date(body.weekStart),
    expectedVersion: nonNegativeInteger(body.expectedVersion),
  };
  const key = idempotencyKey(request);
  const fingerprint = {
    command: "payroll.carry_forward",
    actorProfileId: actor.profileId,
    ...input,
  };
  const { data, error } = await clients.admin.rpc(
    "carry_forward_payroll_cycle",
    {
      p_actor_profile_id: actor.profileId,
      p_maid_profile_id: input.maidProfileId,
      p_week_start: input.weekStart,
      p_expected_version: input.expectedVersion,
      p_idempotency_key: key,
      p_request_hash: await requestHash(fingerprint),
    },
  );
  if (error || !data) throw payrollDatabaseError(error);
  return await publicProjection(data, actor, input.weekStart);
}

export async function carryLatePayrollEarning(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  earningId: string,
): Promise<Record<string, unknown>> {
  admin(actor);
  noQuery(request);
  const body = await readJsonBody(request);
  exactFields(body, ["expectedVersion"]);
  const input = {
    earningId: uuid(earningId, "earningId"),
    expectedVersion: nonNegativeInteger(body.expectedVersion),
  };
  const key = idempotencyKey(request);
  const fingerprint = {
    command: "payroll.late_earning.carry",
    actorProfileId: actor.profileId,
    ...input,
  };
  const { data, error } = await clients.admin.rpc(
    "carry_late_payroll_earning",
    {
      p_actor_profile_id: actor.profileId,
      p_earning_id: input.earningId,
      p_expected_book_version: input.expectedVersion,
      p_idempotency_key: key,
      p_request_hash: await requestHash(fingerprint),
    },
  );
  if (error || !data) throw payrollDatabaseError(error);
  return adjustmentProjection(data);
}

function paymentResultProjection(value: unknown): Record<string, unknown> {
  const row = object(value);
  const resultType = text(row.resultType);
  const beforeStatus = text(row.beforeStatus);
  const afterStatus = text(row.afterStatus);
  if (
    !["check", "paid", "reopened"].includes(resultType) ||
    !["paying", "check"].includes(beforeStatus) ||
    !["check", "paid", "open"].includes(afterStatus)
  ) {
    throw payrollDatabaseError(null);
  }
  const result: Record<string, unknown> = {
    paymentResultId: projectedUuid(row.paymentResultId),
    paymentAttemptId: projectedUuid(row.paymentAttemptId),
    payrollCycleId: projectedUuid(row.payrollCycleId),
    resultType,
    beforeStatus,
    afterStatus,
    cycleVersion: integer(row.cycleVersion),
    lockedAmount: integer(row.lockedAmount),
    occurredAt: text(row.occurredAt),
  };
  if (row.paymentMethod !== undefined) {
    if (row.paymentMethod !== "bank_transfer") throw payrollDatabaseError(null);
    result.paymentMethod = "bank_transfer";
  }
  if (row.providerReferenceId !== undefined) {
    result.providerReferenceId = text(row.providerReferenceId);
  }
  if (row.reasonCode !== undefined) {
    if (
      !["TRANSFER_RESULT_UNCERTAIN", "NO_TRANSFER_CONFIRMED"].includes(
        text(row.reasonCode),
      )
    ) throw payrollDatabaseError(null);
    result.reasonCode = text(row.reasonCode);
  }
  return result;
}

async function paymentCommand(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  attemptId: string,
  kind: "check" | "paid" | "reopen",
): Promise<Record<string, unknown>> {
  admin(actor);
  noQuery(request);
  const paymentAttemptId = uuid(attemptId, "attemptId");
  const body = await readJsonBody(request);
  const key = idempotencyKey(request);
  let rpcName: string;
  let command: string;
  let input: Record<string, unknown>;
  let args: Record<string, unknown>;
  if (kind === "check") {
    exactFields(body, ["expectedVersion", "reasonCode"]);
    if (body.reasonCode !== "TRANSFER_RESULT_UNCERTAIN") {
      invalid("reasonCode를 확인해 주세요.");
    }
    rpcName = "record_payroll_payment_check";
    command = "payroll.payment.check";
    input = {
      paymentAttemptId,
      expectedVersion: positiveExpectedVersion(body.expectedVersion),
      reasonCode: body.reasonCode,
    };
    args = { p_reason_code: body.reasonCode };
  } else if (kind === "reopen") {
    exactFields(body, ["expectedVersion", "reasonCode"]);
    if (body.reasonCode !== "NO_TRANSFER_CONFIRMED") {
      invalid("reasonCode를 확인해 주세요.");
    }
    rpcName = "reopen_payroll_payment_attempt";
    command = "payroll.payment.reopen";
    input = {
      paymentAttemptId,
      expectedVersion: positiveExpectedVersion(body.expectedVersion),
      reasonCode: body.reasonCode,
    };
    args = { p_reason_code: body.reasonCode };
  } else {
    exactFields(body, [
      "expectedVersion",
      "paymentMethod",
      "providerReferenceId",
    ]);
    if (body.paymentMethod !== "bank_transfer") {
      invalid("paymentMethod를 확인해 주세요.");
    }
    const canonicalReference = providerReference(body.providerReferenceId);
    rpcName = "record_payroll_payment_paid";
    command = "payroll.payment.paid";
    input = {
      paymentAttemptId,
      expectedVersion: positiveExpectedVersion(body.expectedVersion),
      paymentMethod: "bank_transfer",
      providerReferenceId: canonicalReference,
    };
    args = {
      p_payment_method: "bank_transfer",
      p_canonical_reference: canonicalReference,
    };
  }
  const fingerprint = { command, actorProfileId: actor.profileId, ...input };
  const { data, error } = await clients.admin.rpc(rpcName, {
    p_actor_profile_id: actor.profileId,
    p_payment_attempt_id: paymentAttemptId,
    p_expected_version: input.expectedVersion,
    ...args,
    p_idempotency_key: key,
    p_request_hash: await requestHash(fingerprint),
  });
  if (error || !data) throw payrollDatabaseError(error);
  return paymentResultProjection(data);
}

export function recordPayrollPaymentCheck(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  attemptId: string,
) {
  return paymentCommand(request, clients, actor, attemptId, "check");
}
export function recordPayrollPaymentPaid(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  attemptId: string,
) {
  return paymentCommand(request, clients, actor, attemptId, "paid");
}
export function reopenPayrollPayment(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  attemptId: string,
) {
  return paymentCommand(request, clients, actor, attemptId, "reopen");
}
