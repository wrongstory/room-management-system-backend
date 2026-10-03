/** Display-only remittance contract. Never changes actual payment or earning state. */
export class PayrollRemittanceError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export interface RemittanceInput {
  maidProfileId: string;
  weekStart: string;
}
export interface RemittanceCommand extends RemittanceInput {
  expectedVersion: number;
  expectedBasisFingerprint: string;
  idempotencyKey: string;
}
export interface RemittanceSetInput extends RemittanceCommand {
  marked: boolean;
}
export interface RemittanceHistoryInput extends RemittanceInput {
  limit: number;
  cursor?: string;
}
export interface RemittanceBasis {
  accrualAmount: number;
  totalAmount: number;
  adjustmentAmount: number;
  carryInAmount: number;
  carryOutAmount: number;
  payableAmount: number;
  lateEarningAmount: number;
  lockedAmount: number | null;
}
export type RemittanceBlockedReason =
  | "ADMIN_REQUIRED"
  | "PAYROLL_WEEK_NOT_CLOSED"
  | "NO_PAYROLL_AMOUNT"
  | null;
export interface RemittanceProjection extends RemittanceInput {
  marked: boolean;
  version: number;
  lastChangedBy: string | null;
  lastChangedAt: string | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  needsReconfirmation: boolean;
  basis: RemittanceBasis;
  confirmedBasis: RemittanceBasis | null;
  basisFingerprint: string;
  canSet: boolean;
  canClear: boolean;
  canReconfirm: boolean;
  setBlockedReason: RemittanceBlockedReason;
}
export interface RemittanceRevision {
  revisionId: string;
  version: number;
  eventType: "marked" | "cleared" | "reconfirmed";
  marked: boolean;
  actorProfileId: string;
  occurredAt: string;
  basis: RemittanceBasis;
}
export interface RemittanceHistoryPage extends RemittanceInput {
  entries: RemittanceRevision[];
  nextCursor: string | null;
}
export const REMITTANCE_CURSOR_MAX = 1024;
export const REMITTANCE_HISTORY_MAX = 100;
const basisKeys = [
  "accrualAmount",
  "totalAmount",
  "adjustmentAmount",
  "carryInAmount",
  "carryOutAmount",
  "payableAmount",
  "lateEarningAmount",
  "lockedAmount",
] as const;
// Actual payment locking is explanatory metadata, not a financial change.
const financialBasisKeys = basisKeys.filter((key) => key !== "lockedAmount");
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fingerprintPattern = /^[0-9a-f]{64}$/;
function fail(code = "PAYROLL_COMMAND_FAILED"): never {
  throw new PayrollRemittanceError(code);
}
function record(
  value: unknown,
  keys: readonly string[],
  code = "PAYROLL_COMMAND_FAILED",
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== [...keys].sort().join(",")) {
    fail(code);
  }
  return row;
}
function uuid(value: unknown, code = "PAYROLL_COMMAND_FAILED"): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) fail(code);
  return value.toLowerCase();
}
function safeInteger(
  value: unknown,
  minimum = Number.MIN_SAFE_INTEGER,
  code = "PAYROLL_COMMAND_FAILED",
): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum
  ) fail(code);
  return value;
}
export function remittanceDate(value: unknown): value is string {
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
function timestamp(value: unknown): string {
  if (
    typeof value !== "string" || !remittanceDate(value.slice(0, 10)) ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/
      .test(value) ||
    !Number.isFinite(Date.parse(value))
  ) fail();
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean") fail();
  return value;
}
function fingerprint(value: unknown, code = "PAYROLL_COMMAND_FAILED"): string {
  if (typeof value !== "string" || !fingerprintPattern.test(value)) fail(code);
  return value;
}
export function normalizeRemittanceInput(value: unknown): RemittanceInput {
  const row = record(value, ["maidProfileId", "weekStart"], "VALIDATION_ERROR");
  if (!remittanceDate(row.weekStart)) fail("VALIDATION_ERROR");
  return {
    maidProfileId: uuid(row.maidProfileId, "VALIDATION_ERROR"),
    weekStart: row.weekStart,
  };
}
export function remittanceQuery(
  search: URLSearchParams,
  history = false,
): RemittanceInput | RemittanceHistoryInput {
  const allowed = history
    ? ["maidProfileId", "weekStart", "limit", "cursor"]
    : ["maidProfileId", "weekStart"];
  for (const key of search.keys()) {
    if (!allowed.includes(key) || search.getAll(key).length !== 1) {
      fail("VALIDATION_ERROR");
    }
  }
  const input = normalizeRemittanceInput({
    maidProfileId: search.get("maidProfileId"),
    weekStart: search.get("weekStart"),
  });
  if (!history) return input;
  const limit = search.get("limit");
  if (
    limit !== null &&
    (!/^[1-9]\d*$/.test(limit) || Number(limit) > REMITTANCE_HISTORY_MAX)
  ) fail("VALIDATION_ERROR");
  const cursor = search.get("cursor");
  if (cursor !== null && (!cursor || cursor.length > REMITTANCE_CURSOR_MAX)) {
    fail("VALIDATION_ERROR");
  }
  return {
    ...input,
    limit: limit === null ? 20 : Number(limit),
    ...(cursor === null ? {} : { cursor }),
  };
}
export function remittanceIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(value)) {
    fail("VALIDATION_ERROR");
  }
  return value;
}
export function normalizeRemittanceHistoryInput(
  value: RemittanceHistoryInput,
): RemittanceHistoryInput {
  const row = record(value, [
    "maidProfileId",
    "weekStart",
    "limit",
    ...(value.cursor === undefined ? [] : ["cursor"]),
  ], "VALIDATION_ERROR");
  const input = normalizeRemittanceInput({
    maidProfileId: row.maidProfileId,
    weekStart: row.weekStart,
  });
  const limit = safeInteger(row.limit, 1, "VALIDATION_ERROR");
  if (
    limit > REMITTANCE_HISTORY_MAX ||
    (row.cursor !== undefined &&
      (typeof row.cursor !== "string" || !row.cursor ||
        row.cursor.length > REMITTANCE_CURSOR_MAX))
  ) fail("VALIDATION_ERROR");
  return {
    ...input,
    limit,
    ...(row.cursor === undefined ? {} : { cursor: row.cursor as string }),
  };
}
export function normalizeRemittanceCommand(
  value: unknown,
  key: unknown,
  set: boolean,
): RemittanceCommand | RemittanceSetInput {
  const row = record(value, [
    "maidProfileId",
    "weekStart",
    "expectedVersion",
    "expectedBasisFingerprint",
    ...(set ? ["marked"] : []),
  ], "VALIDATION_ERROR");
  const input = normalizeRemittanceInput({
    maidProfileId: row.maidProfileId,
    weekStart: row.weekStart,
  });
  const common = {
    ...input,
    expectedVersion: safeInteger(row.expectedVersion, 0, "VALIDATION_ERROR"),
    expectedBasisFingerprint: fingerprint(
      row.expectedBasisFingerprint,
      "VALIDATION_ERROR",
    ),
    idempotencyKey: remittanceIdempotencyKey(key),
  };
  if (set) {
    if (typeof row.marked !== "boolean") fail("VALIDATION_ERROR");
    return { ...common, marked: row.marked };
  }
  return common;
}
export function remittanceBasis(value: unknown): RemittanceBasis {
  const row = record(value, basisKeys);
  if (
    safeInteger(row.carryInAmount) > 0 || safeInteger(row.carryOutAmount) > 0
  ) fail();
  return {
    accrualAmount: safeInteger(row.accrualAmount, 0),
    totalAmount: safeInteger(row.totalAmount, 0),
    adjustmentAmount: safeInteger(row.adjustmentAmount),
    carryInAmount: safeInteger(row.carryInAmount),
    carryOutAmount: safeInteger(row.carryOutAmount),
    payableAmount: safeInteger(row.payableAmount),
    lateEarningAmount: safeInteger(row.lateEarningAmount, 0),
    lockedAmount: row.lockedAmount === null
      ? null
      : safeInteger(row.lockedAmount, 1),
  };
}
export function remittanceProjection(
  value: unknown,
  input: RemittanceInput,
  role: "admin" | "maid",
): RemittanceProjection {
  const row = record(value, [
    "maidProfileId",
    "weekStart",
    "marked",
    "version",
    "lastChangedBy",
    "lastChangedAt",
    "confirmedBy",
    "confirmedAt",
    "needsReconfirmation",
    "basis",
    "confirmedBasis",
    "basisFingerprint",
    "canSet",
    "canClear",
    "canReconfirm",
    "setBlockedReason",
  ]);
  if (
    uuid(row.maidProfileId) !== input.maidProfileId ||
    row.weekStart !== input.weekStart
  ) fail();
  const marked = bool(row.marked), version = safeInteger(row.version, 0);
  const basis = remittanceBasis(row.basis),
    confirmedBasis = row.confirmedBasis === null
      ? null
      : remittanceBasis(row.confirmedBasis);
  const lastChangedBy = row.lastChangedBy === null
    ? null
    : uuid(row.lastChangedBy);
  const lastChangedAt = row.lastChangedAt === null
    ? null
    : timestamp(row.lastChangedAt);
  const confirmedBy = row.confirmedBy === null ? null : uuid(row.confirmedBy);
  const confirmedAt = row.confirmedAt === null
    ? null
    : timestamp(row.confirmedAt);
  const needsReconfirmation = bool(row.needsReconfirmation);
  const canSet = bool(row.canSet),
    canClear = bool(row.canClear),
    canReconfirm = bool(row.canReconfirm);
  if (
    ![null, "ADMIN_REQUIRED", "PAYROLL_WEEK_NOT_CLOSED", "NO_PAYROLL_AMOUNT"]
      .includes(row.setBlockedReason as null | string)
  ) fail();
  const reason = row.setBlockedReason as RemittanceBlockedReason;
  if (
    (lastChangedBy === null) !== (lastChangedAt === null) ||
    (confirmedBy === null) !== (confirmedAt === null) ||
    (confirmedBy === null) !== (confirmedBasis === null) ||
    (version === 0 &&
      (marked || lastChangedBy !== null || confirmedBy !== null)) ||
    (version > 0 && lastChangedBy === null) ||
    (marked && confirmedBasis === null) ||
    (!marked && confirmedBasis !== null) ||
    needsReconfirmation !==
      (marked && confirmedBasis !== null &&
        financialBasisKeys.some((key) => basis[key] !== confirmedBasis[key])) ||
    (canReconfirm && (!marked || !needsReconfirmation)) ||
    (canClear && !marked) ||
    (role === "maid" &&
      (canSet || canClear || canReconfirm || reason !== "ADMIN_REQUIRED")) ||
    (canSet && reason !== null)
  ) fail();
  return {
    ...input,
    marked,
    version,
    lastChangedBy,
    lastChangedAt,
    confirmedBy,
    confirmedAt,
    needsReconfirmation,
    basis,
    confirmedBasis,
    basisFingerprint: fingerprint(row.basisFingerprint),
    canSet,
    canClear,
    canReconfirm,
    setBlockedReason: reason,
  };
}
export function remittanceHistoryProjection(
  value: unknown,
  input: RemittanceHistoryInput,
  afterVersion: number | null,
): {
  entries: RemittanceRevision[];
  hasMore: boolean;
  lastVersion: number | null;
} {
  const row = record(value, ["entries", "hasMore", "lastVersion"]);
  if (
    !Array.isArray(row.entries) || row.entries.length > input.limit ||
    !Number.isSafeInteger(input.limit) || input.limit < 1 ||
    input.limit > REMITTANCE_HISTORY_MAX
  ) fail();
  const ids = new Set<string>();
  let previous = afterVersion ?? 0;
  const entries = row.entries.map((value): RemittanceRevision => {
    const entry = record(value, [
      "revisionId",
      "version",
      "eventType",
      "marked",
      "actorProfileId",
      "occurredAt",
      "basis",
    ]);
    const revisionId = uuid(entry.revisionId),
      version = safeInteger(entry.version, 1),
      marked = bool(entry.marked);
    if (
      ids.has(revisionId) || version <= previous ||
      !["marked", "cleared", "reconfirmed"].includes(
        entry.eventType as string,
      ) ||
      marked !== (entry.eventType !== "cleared")
    ) fail();
    ids.add(revisionId);
    previous = version;
    return {
      revisionId,
      version,
      eventType: entry.eventType as RemittanceRevision["eventType"],
      marked,
      actorProfileId: uuid(entry.actorProfileId),
      occurredAt: timestamp(entry.occurredAt),
      basis: remittanceBasis(entry.basis),
    };
  });
  const hasMore = bool(row.hasMore),
    lastVersion = row.lastVersion === null
      ? null
      : safeInteger(row.lastVersion, 1);
  if (
    lastVersion !== (entries.at(-1)?.version ?? null) ||
    (hasMore && (entries.length !== input.limit || lastVersion === null))
  ) fail();
  return { entries, hasMore, lastVersion };
}
const statuses: Record<string, number> = {
  VALIDATION_ERROR: 400,
  INVALID_EXPECTED_VERSION: 400,
  PAYROLL_WEEK_MUST_START_MONDAY: 400,
  PAYROLL_REMITTANCE_BASIS_FINGERPRINT_INVALID: 400,
  PAYROLL_REMITTANCE_MARKED_INVALID: 400,
  PAYROLL_REMITTANCE_HISTORY_LIMIT_INVALID: 400,
  PAYROLL_REMITTANCE_HISTORY_CURSOR_INVALID: 400,
  INVALID_IDEMPOTENCY_KEY: 400,
  INVALID_REQUEST_HASH: 400,
  PAYROLL_PAGE_LIMIT_INVALID: 400,
  PAYROLL_CURSOR_INVALID: 400,
  SESSION_REVOKED: 401,
  INVALID_ACCESS_TOKEN: 401,
  ADMIN_REQUIRED: 403,
  PAYROLL_ACCESS_REQUIRED: 403,
  PASSWORD_CHANGE_REQUIRED: 403,
  PAYROLL_MAID_NOT_FOUND: 404,
  ROUTE_NOT_FOUND: 404,
  PAYROLL_WEEK_NOT_CLOSED: 409,
  PAYROLL_REMITTANCE_MARKER_STALE_VERSION: 409,
  PAYROLL_REMITTANCE_BASIS_CHANGED: 409,
  NO_PAYROLL_AMOUNT: 409,
  PAYROLL_REMITTANCE_RECONFIRM_NOT_REQUIRED: 409,
  PAYROLL_REMITTANCE_MARKER_NOT_SET: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  PAYROLL_RESPONSE_TOO_LARGE: 500,
  PAYROLL_CURSOR_NOT_CONFIGURED: 503,
};
export function remittanceErrorStatus(code: string): number {
  return statuses[code] ?? 500;
}
export function remittanceDatabaseError(
  error: { message?: string } | null,
): PayrollRemittanceError {
  const code = error?.message ?? "";
  return new PayrollRemittanceError(
    Object.hasOwn(statuses, code) ? code : "PAYROLL_COMMAND_FAILED",
  );
}
export function remittanceRequestFingerprint(
  actorProfileId: string,
  input: RemittanceCommand | RemittanceSetInput,
  set: boolean,
): Record<string, unknown> {
  return {
    command: set ? "payroll.remittance.set" : "payroll.remittance.reconfirm",
    actorProfileId: actorProfileId.toLowerCase(),
    maidProfileId: input.maidProfileId,
    weekStart: input.weekStart,
    expectedVersion: input.expectedVersion,
    expectedBasisFingerprint: input.expectedBasisFingerprint,
    ...(set ? { marked: (input as RemittanceSetInput).marked } : {}),
  };
}
export interface RemittanceScope {
  actorProfileId: string;
  actorRole: "admin" | "maid";
  sessionBinding: string;
  maidProfileId: string;
  weekStart: string;
  sort: "version:asc";
}
const domain = "payroll-remittance-history:v1:";
function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll(
    "/",
    "_",
  ).replaceAll("=", "");
}
function bytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) fail("PAYROLL_CURSOR_INVALID");
  try {
    const result = Uint8Array.from(
      atob(
        value.replaceAll("-", "+").replaceAll("_", "/") +
          "=".repeat((4 - value.length % 4) % 4),
      ),
      (c) => c.charCodeAt(0),
    );
    if (base64(result) !== value) fail("PAYROLL_CURSOR_INVALID");
    return result;
  } catch {
    fail("PAYROLL_CURSOR_INVALID");
  }
}
export class PayrollRemittanceCursor {
  private readonly material: ArrayBuffer;
  constructor(secret: string) {
    this.material = new TextEncoder().encode(secret).buffer as ArrayBuffer;
    if (this.material.byteLength < 32) fail("PAYROLL_CURSOR_NOT_CONFIGURED");
  }
  private key(): Promise<CryptoKey> {
    return crypto.subtle.importKey(
      "raw",
      this.material,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
  }
  private async sign(value: string): Promise<string> {
    return base64(
      new Uint8Array(
        await crypto.subtle.sign(
          "HMAC",
          await this.key(),
          new TextEncoder().encode(value),
        ),
      ),
    );
  }
  async scope(
    profileId: string,
    role: "admin" | "maid",
    sessionId: string,
    input: RemittanceInput,
  ): Promise<RemittanceScope> {
    return {
      actorProfileId: uuid(profileId),
      actorRole: role,
      sessionBinding: await this.sign(`${domain}session:${uuid(sessionId)}`),
      maidProfileId: input.maidProfileId,
      weekStart: input.weekStart,
      sort: "version:asc",
    };
  }
  async encode(scope: RemittanceScope, afterVersion: number): Promise<string> {
    safeInteger(afterVersion, 1, "PAYROLL_CURSOR_INVALID");
    const payload = base64(
      new TextEncoder().encode(
        JSON.stringify({
          family: "payroll-remittance-history",
          v: 1,
          scope,
          afterVersion,
        }),
      ),
    );
    const cursor = `${payload}.${await this.sign(domain + payload)}`;
    if (cursor.length > REMITTANCE_CURSOR_MAX) fail("PAYROLL_CURSOR_INVALID");
    return cursor;
  }
  async decode(cursor: string, scope: RemittanceScope): Promise<number> {
    if (!cursor || cursor.length > REMITTANCE_CURSOR_MAX) {
      fail("PAYROLL_CURSOR_INVALID");
    }
    const parts = cursor.split(".");
    if (parts.length !== 2) fail("PAYROLL_CURSOR_INVALID");
    const payload = parts[0] ?? "",
      signature = bytes(parts[1] ?? ""),
      data = bytes(payload);
    if (
      signature.length !== 32 ||
      !await crypto.subtle.verify(
        "HMAC",
        await this.key(),
        signature.buffer as ArrayBuffer,
        new TextEncoder().encode(domain + payload),
      )
    ) fail("PAYROLL_CURSOR_INVALID");
    try {
      const row = record(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)),
        ["family", "v", "scope", "afterVersion"],
        "PAYROLL_CURSOR_INVALID",
      );
      if (
        row.family !== "payroll-remittance-history" || row.v !== 1 ||
        JSON.stringify(row.scope) !== JSON.stringify(scope)
      ) fail("PAYROLL_CURSOR_INVALID");
      return safeInteger(row.afterVersion, 1, "PAYROLL_CURSOR_INVALID");
    } catch {
      fail("PAYROLL_CURSOR_INVALID");
    }
  }
}
export async function remittanceRequestHash(
  value: Record<string, unknown>,
): Promise<string> {
  const canonical = Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
  );
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(canonical)),
  );
  return [...new Uint8Array(digest)].map((value) =>
    value.toString(16).padStart(2, "0")
  ).join("");
}
