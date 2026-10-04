/** Pure read contract shared by Fastify and Edge. No workflow or money writes. */
export class PayrollWorkDetailsError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export type PayrollWorkKind = "earnings" | "workflow";
export interface PayrollWorkInput {
  weekStart: string;
  maidProfileId: string;
  kind: PayrollWorkKind;
  limit: number;
  cursor?: string;
}
export interface PayrollWorkPosition {
  entryDate: string;
  entryId: string;
}
export interface PayrollWorkSummary {
  cycleId: string | null;
  cycleStatus: "open" | "paying" | "check" | "paid";
  cycleVersion: number;
  accrualAmount: number;
  expectedAmount: number;
  pendingAmount: number;
  pendingCount: number;
  totalAmount: number;
  lateEarningAmount: number;
  adjustmentAmount: number;
  carryInAmount: number;
  carryOutAmount: number;
  payableAmount: number;
  offsetSettled: boolean;
  lockedAmount: number | null;
}
export interface PayrollWorkCommon extends PayrollWorkPosition {
  cleaningTargetId: string;
  assignmentId: string;
  attemptId: string;
  submissionId: string | null;
  inspectionDecisionId: string | null;
  roomNumber: string | null;
  roomTypeCode: string | null;
  roomTypeName: string | null;
  cleaningKind: "checkout" | "stayover" | "additional" | "reclean";
  sourceKind:
    | "scheduled_checkout"
    | "manual_checkout"
    | "stayover_request"
    | "manual_room_request"
    | "inspection_reclean"
    | "post_approval_complaint_reclean";
  fieldCompletedAt: string | null;
  feeSnapshot: number;
  attemptStatus:
    | "scheduled"
    | "in_progress"
    | "field_completed"
    | "upload_pending"
    | "submitted"
    | "approved"
    | "rejected"
    | "interrupted"
    | "superseded";
  submissionStatus: "submitted" | "superseded" | "approved" | "rejected" | null;
  inspectionDecision: "approved" | "rejected" | null;
}
export interface PayrollWorkEarning extends PayrollWorkCommon {
  earningId: string;
  earnedOn: string;
  earningSource: "cleaning" | "compensation";
  baseAmount: number;
  bombRoomBonus: number;
  totalAmount: number;
  itemContributionAmount: number;
  lateContributionAmount: number;
  alreadyClaimed: boolean;
  lateCarried: boolean;
}
export interface PayrollWorkWorkflow extends PayrollWorkCommon {
  earningId: null;
  baseAmount: null;
  bombRoomBonus: null;
  totalAmount: null;
  expectedContributionAmount: number;
  pendingContributionAmount: number;
  includedInPendingCount: boolean;
  expectedBaseContributionAmount: number;
  expectedBombContributionAmount: number;
}
export interface PayrollWorkPage {
  weekStart: string;
  maidProfileId: string;
  kind: PayrollWorkKind;
  summary: PayrollWorkSummary;
  entries: Array<PayrollWorkEarning | PayrollWorkWorkflow>;
  nextCursor: string | null;
}
export interface PayrollWorkRawPage
  extends Omit<PayrollWorkPage, "nextCursor"> {
  hasMore: boolean;
  lastEntryDate: string | null;
  lastEntryId: string | null;
}
export const PAYROLL_WORK_LIMIT_DEFAULT = 25;
export const PAYROLL_WORK_LIMIT_MAX = 50;
export const PAYROLL_WORK_CURSOR_MAX = 1024;
export const PAYROLL_WORK_RESPONSE_MAX = 128 * 1024;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function isPayrollWorkUuid(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}
export function isPayrollWorkDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [y = 0, m = 0, d = 0] = value.split("-").map(Number);
  const days = [
    31,
    y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return m >= 1 && m <= 12 && d >= 1 && d <= (days[m - 1] ?? 0);
}
function fail(code = "PAYROLL_COMMAND_FAILED"): never {
  throw new PayrollWorkDetailsError(code);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
function exact(row: Record<string, unknown>, fields: readonly string[]): void {
  if (
    Object.keys(row).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(row, field))
  ) fail();
}
function integer(value: unknown, signed = false): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) ||
    (!signed && value < 0)
  ) fail();
  return value;
}
function uuid(value: unknown): string {
  if (!isPayrollWorkUuid(value)) fail();
  return value;
}
function date(value: unknown): string {
  if (!isPayrollWorkDate(value)) fail();
  return value;
}
function nullableUuid(value: unknown): string | null {
  return value === null ? null : uuid(value);
}
function nullableText(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") fail();
  return value.trim().length === 0 ? null : value;
}
function enumValue<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) fail();
  return value as T;
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean") fail();
  return value;
}
function timestamp(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") fail();
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/
      .exec(value);
  if (
    !match || !isPayrollWorkDate(match[1]) || Number(match[2]) > 23 ||
    Number(match[3]) > 59 || Number(match[4]) > 59 ||
    Number(match[6] ?? 0) > 23 || Number(match[7] ?? 0) > 59 ||
    !Number.isFinite(Date.parse(value))
  ) fail();
  return value;
}
export function payrollWorkQuery(search: URLSearchParams): PayrollWorkInput {
  const allowed = ["weekStart", "maidProfileId", "kind", "limit", "cursor"];
  for (const key of search.keys()) {
    if (!allowed.includes(key) || search.getAll(key).length !== 1) {
      fail("VALIDATION_ERROR");
    }
  }
  const weekStart = search.get("weekStart");
  const maidProfileId = search.get("maidProfileId")?.toLowerCase();
  const kind = search.get("kind");
  const rawLimit = search.get("limit");
  const cursor = search.get("cursor");
  const limit = rawLimit === null
    ? PAYROLL_WORK_LIMIT_DEFAULT
    : Number(rawLimit);
  if (
    !isPayrollWorkDate(weekStart) || !isPayrollWorkUuid(maidProfileId) ||
    (kind !== "earnings" && kind !== "workflow") ||
    (rawLimit !== null && !/^[1-9]\d*$/.test(rawLimit)) ||
    !Number.isSafeInteger(limit) || limit < 1 ||
    limit > PAYROLL_WORK_LIMIT_MAX ||
    (cursor !== null &&
      (cursor.length < 1 || cursor.length > PAYROLL_WORK_CURSOR_MAX))
  ) fail("VALIDATION_ERROR");
  return {
    weekStart,
    maidProfileId,
    kind,
    limit,
    ...(cursor === null ? {} : { cursor }),
  };
}
export function normalizePayrollWorkInput(value: unknown): PayrollWorkInput {
  const row = object(value);
  const search = new URLSearchParams();
  for (const [key, item] of Object.entries(row)) {
    if (item === undefined && (key === "limit" || key === "cursor")) continue;
    if (
      typeof item !== "string" && !(key === "limit" && typeof item === "number")
    ) fail("VALIDATION_ERROR");
    search.append(key, String(item));
  }
  return payrollWorkQuery(search);
}
const commonFields = [
  "entryId",
  "entryDate",
  "cleaningTargetId",
  "assignmentId",
  "attemptId",
  "submissionId",
  "inspectionDecisionId",
  "roomNumber",
  "roomTypeCode",
  "roomTypeName",
  "cleaningKind",
  "sourceKind",
  "fieldCompletedAt",
  "feeSnapshot",
  "attemptStatus",
  "submissionStatus",
  "inspectionDecision",
] as const;
function common(row: Record<string, unknown>): PayrollWorkCommon {
  const result: PayrollWorkCommon = {
    entryId: uuid(row.entryId),
    entryDate: date(row.entryDate),
    cleaningTargetId: uuid(row.cleaningTargetId),
    assignmentId: uuid(row.assignmentId),
    attemptId: uuid(row.attemptId),
    submissionId: nullableUuid(row.submissionId),
    inspectionDecisionId: nullableUuid(row.inspectionDecisionId),
    roomNumber: nullableText(row.roomNumber),
    roomTypeCode: nullableText(row.roomTypeCode),
    roomTypeName: nullableText(row.roomTypeName),
    cleaningKind: enumValue(row.cleaningKind, [
      "checkout",
      "stayover",
      "additional",
      "reclean",
    ]),
    sourceKind: enumValue(row.sourceKind, [
      "scheduled_checkout",
      "manual_checkout",
      "stayover_request",
      "manual_room_request",
      "inspection_reclean",
      "post_approval_complaint_reclean",
    ]),
    fieldCompletedAt: timestamp(row.fieldCompletedAt),
    feeSnapshot: integer(row.feeSnapshot),
    attemptStatus: enumValue(row.attemptStatus, [
      "scheduled",
      "in_progress",
      "field_completed",
      "upload_pending",
      "submitted",
      "approved",
      "rejected",
      "interrupted",
      "superseded",
    ]),
    submissionStatus: row.submissionStatus === null ? null : enumValue(
      row.submissionStatus,
      ["submitted", "superseded", "approved", "rejected"] as const,
    ),
    inspectionDecision: row.inspectionDecision === null
      ? null
      : enumValue(row.inspectionDecision, ["approved", "rejected"] as const),
  };
  if (
    (result.submissionId === null) !== (result.submissionStatus === null) ||
    (result.inspectionDecisionId === null) !==
      (result.inspectionDecision === null) ||
    (result.inspectionDecision !== null && result.submissionId === null)
  ) fail();
  return result;
}
function parseEntry(
  value: unknown,
  kind: PayrollWorkKind,
): PayrollWorkEarning | PayrollWorkWorkflow {
  const row = object(value);
  const base = common(row);
  if (kind === "earnings") {
    exact(row, [
      ...commonFields,
      "earningId",
      "earnedOn",
      "earningSource",
      "baseAmount",
      "bombRoomBonus",
      "totalAmount",
      "itemContributionAmount",
      "lateContributionAmount",
      "alreadyClaimed",
      "lateCarried",
    ]);
    const result: PayrollWorkEarning = {
      ...base,
      earningId: uuid(row.earningId),
      earnedOn: date(row.earnedOn),
      earningSource: enumValue(row.earningSource, ["cleaning", "compensation"]),
      baseAmount: integer(row.baseAmount),
      bombRoomBonus: integer(row.bombRoomBonus),
      totalAmount: integer(row.totalAmount),
      itemContributionAmount: integer(row.itemContributionAmount),
      lateContributionAmount: integer(row.lateContributionAmount),
      alreadyClaimed: bool(row.alreadyClaimed),
      lateCarried: bool(row.lateCarried),
    };
    if (
      result.entryId !== result.earningId ||
      result.entryDate !== result.earnedOn ||
      result.fieldCompletedAt === null ||
      result.submissionId === null ||
      result.inspectionDecision !== "approved" ||
      result.submissionStatus !== "approved" ||
      result.baseAmount + result.bombRoomBonus !== result.totalAmount ||
      (result.bombRoomBonus !== 0 &&
        result.bombRoomBonus !== result.baseAmount) ||
      (result.earningSource === "compensation" && result.bombRoomBonus !== 0) ||
      (result.itemContributionAmount !== 0 &&
        result.itemContributionAmount !== result.totalAmount) ||
      (result.lateContributionAmount !== 0 &&
        result.lateContributionAmount !== result.totalAmount) ||
      (result.itemContributionAmount > 0 &&
        result.lateContributionAmount > 0) ||
      (result.lateCarried &&
        (result.itemContributionAmount > 0 ||
          result.lateContributionAmount > 0))
    ) fail();
    return result;
  }
  exact(row, [
    ...commonFields,
    "earningId",
    "baseAmount",
    "bombRoomBonus",
    "totalAmount",
    "expectedContributionAmount",
    "pendingContributionAmount",
    "includedInPendingCount",
    "expectedBaseContributionAmount",
    "expectedBombContributionAmount",
  ]);
  if (
    row.earningId !== null || row.baseAmount !== null ||
    row.bombRoomBonus !== null || row.totalAmount !== null ||
    base.entryId !== base.attemptId
  ) fail();
  const result: PayrollWorkWorkflow = {
    ...base,
    earningId: null,
    baseAmount: null,
    bombRoomBonus: null,
    totalAmount: null,
    expectedContributionAmount: integer(row.expectedContributionAmount),
    pendingContributionAmount: integer(row.pendingContributionAmount),
    expectedBaseContributionAmount: integer(row.expectedBaseContributionAmount),
    expectedBombContributionAmount: integer(row.expectedBombContributionAmount),
    includedInPendingCount: bool(row.includedInPendingCount),
  };
  if (
    result.pendingContributionAmount > result.expectedContributionAmount ||
    result.expectedBaseContributionAmount +
          result.expectedBombContributionAmount !==
      result.expectedContributionAmount ||
    (result.pendingContributionAmount > 0 && !result.includedInPendingCount)
  ) fail();
  return result;
}
export function payrollWorkProjection(
  value: unknown,
  input: PayrollWorkInput,
  after: PayrollWorkPosition | null,
): PayrollWorkRawPage {
  const page = object(value);
  exact(page, [
    "weekStart",
    "maidProfileId",
    "kind",
    "summary",
    "entries",
    "hasMore",
    "lastEntryDate",
    "lastEntryId",
  ]);
  if (
    page.weekStart !== input.weekStart ||
    page.maidProfileId !== input.maidProfileId || page.kind !== input.kind ||
    !Array.isArray(page.entries) || page.entries.length > input.limit
  ) fail();
  const rawSummary = object(page.summary);
  exact(rawSummary, [
    "cycleId",
    "cycleStatus",
    "cycleVersion",
    "accrualAmount",
    "expectedAmount",
    "pendingAmount",
    "pendingCount",
    "totalAmount",
    "lateEarningAmount",
    "adjustmentAmount",
    "carryInAmount",
    "carryOutAmount",
    "payableAmount",
    "offsetSettled",
    "lockedAmount",
  ]);
  const summary: PayrollWorkSummary = {
    cycleId: nullableUuid(rawSummary.cycleId),
    cycleStatus: enumValue(rawSummary.cycleStatus, [
      "open",
      "paying",
      "check",
      "paid",
    ]),
    cycleVersion: integer(rawSummary.cycleVersion),
    accrualAmount: integer(rawSummary.accrualAmount),
    expectedAmount: integer(rawSummary.expectedAmount),
    pendingAmount: integer(rawSummary.pendingAmount),
    pendingCount: integer(rawSummary.pendingCount),
    totalAmount: integer(rawSummary.totalAmount),
    lateEarningAmount: integer(rawSummary.lateEarningAmount),
    adjustmentAmount: integer(rawSummary.adjustmentAmount, true),
    carryInAmount: integer(rawSummary.carryInAmount, true),
    carryOutAmount: integer(rawSummary.carryOutAmount, true),
    payableAmount: integer(rawSummary.payableAmount, true),
    offsetSettled: bool(rawSummary.offsetSettled),
    lockedAmount: rawSummary.lockedAmount === null
      ? null
      : integer(rawSummary.lockedAmount),
  };
  if (
    summary.cycleId === null &&
    (summary.cycleVersion !== 0 || summary.cycleStatus !== "open")
  ) fail();
  const entries = page.entries.map((entry) => parseEntry(entry, input.kind));
  const weekBeginEpoch = Date.parse(`${input.weekStart}T00:00:00.000Z`);
  const weekEndEpoch = weekBeginEpoch + 7 * 86400000;
  let previous = after;
  for (const entry of entries) {
    const entryEpoch = Date.parse(`${entry.entryDate}T00:00:00.000Z`);
    if (
      entryEpoch < weekBeginEpoch || entryEpoch >= weekEndEpoch ||
      (previous !== null && (entry.entryDate < previous.entryDate ||
        (entry.entryDate === previous.entryDate &&
          entry.entryId <= previous.entryId)))
    ) fail();
    if (entry.fieldCompletedAt !== null) {
      const completedKstDay = new Date(
        Date.parse(entry.fieldCompletedAt) + 9 * 3600000,
      ).toISOString().slice(0, 10);
      if (entry.entryDate !== completedKstDay) fail();
    }
    previous = entry;
  }
  const hasMore = bool(page.hasMore);
  const lastEntryDate = page.lastEntryDate === null
    ? null
    : date(page.lastEntryDate);
  const lastEntryId = nullableUuid(page.lastEntryId);
  const last = entries.at(-1);
  if (
    (lastEntryDate === null) !== (lastEntryId === null) ||
    (hasMore && (entries.length !== input.limit || !last)) ||
    (last
      ? lastEntryDate !== last.entryDate || lastEntryId !== last.entryId
      : lastEntryDate !== null)
  ) fail();
  const sums = {
    accrual: 0,
    items: 0,
    late: 0,
    expected: 0,
    pending: 0,
    count: 0,
  };
  for (const entry of entries) {
    if (entry.earningId !== null) {
      sums.accrual = integer(sums.accrual + entry.totalAmount);
      sums.items = integer(sums.items + entry.itemContributionAmount);
      sums.late = integer(sums.late + entry.lateContributionAmount);
    } else {
      sums.expected = integer(sums.expected + entry.expectedContributionAmount);
      sums.pending = integer(sums.pending + entry.pendingContributionAmount);
      sums.count = integer(sums.count + Number(entry.includedInPendingCount));
    }
  }
  if (input.kind === "earnings") {
    if (
      sums.accrual > summary.accrualAmount ||
      sums.items > summary.totalAmount ||
      sums.late > summary.lateEarningAmount ||
      (after === null && !hasMore &&
        (sums.accrual !== summary.accrualAmount ||
          sums.items !== summary.totalAmount ||
          sums.late !== summary.lateEarningAmount))
    ) fail();
  } else {
    const expectedWorkflow = integer(
      summary.expectedAmount - summary.accrualAmount,
    );
    if (
      sums.expected > expectedWorkflow ||
      sums.pending > summary.pendingAmount ||
      sums.count > summary.pendingCount ||
      (after === null && !hasMore &&
        (sums.expected !== expectedWorkflow ||
          sums.pending !== summary.pendingAmount ||
          sums.count !== summary.pendingCount))
    ) fail();
  }
  return {
    weekStart: input.weekStart,
    maidProfileId: input.maidProfileId,
    kind: input.kind,
    summary,
    entries,
    hasMore,
    lastEntryDate,
    lastEntryId,
  };
}
export function payrollWorkErrorStatus(code: string): number {
  if (["SESSION_REVOKED", "INVALID_ACCESS_TOKEN"].includes(code)) return 401;
  if (["PAYROLL_ACCESS_REQUIRED", "PASSWORD_CHANGE_REQUIRED"].includes(code)) {
    return 403;
  }
  if (code === "PAYROLL_MAID_NOT_FOUND") return 404;
  if (code === "PAYROLL_WEEK_NOT_CLOSED") return 409;
  if (
    [
      "VALIDATION_ERROR",
      "PAYROLL_CURSOR_INVALID",
      "PAYROLL_WEEK_MUST_START_MONDAY",
      "PAYROLL_PAGE_LIMIT_INVALID",
      "PAYROLL_PAGE_KIND_INVALID",
    ].includes(code)
  ) return 400;
  if (code === "PAYROLL_CURSOR_NOT_CONFIGURED") return 503;
  return 500;
}
export function payrollWorkDatabaseErrorCode(
  error: { message?: string } | null,
): string {
  const code = error?.message ?? "";
  return payrollWorkErrorStatus(code) === 500 ? "PAYROLL_COMMAND_FAILED" : code;
}
