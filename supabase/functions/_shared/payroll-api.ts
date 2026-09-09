import { idempotencyKey, readJsonBody } from "./account-api.ts";
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

function query(
  request: Request,
): { weekStart: string; maidProfileId: string | null } {
  const search = new URL(request.url).searchParams;
  for (const key of search.keys()) {
    if (
      !["weekStart", "maidProfileId"].includes(key) ||
      search.getAll(key).length !== 1
    ) {
      invalid("허용되지 않거나 중복된 query 항목입니다.");
    }
  }
  const weekStart = date(search.get("weekStart"));
  const maidValue = search.get("maidProfileId");
  return {
    weekStart,
    maidProfileId: maidValue === null ? null : uuid(maidValue, "maidProfileId"),
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

function projection(value: unknown): Record<string, unknown> {
  const row = object(value);
  const status = text(row.status);
  if (!["open", "paying", "check", "paid"].includes(status)) {
    throw payrollDatabaseError(null);
  }
  if (!Array.isArray(row.items) || !Array.isArray(row.lateEarnings)) {
    throw payrollDatabaseError(null);
  }
  return {
    cycleId: row.cycleId === null ? null : projectedUuid(row.cycleId),
    maidProfileId: projectedUuid(row.maidProfileId),
    weekStart: projectedDate(row.weekStart),
    status,
    version: integer(row.version),
    lockedAmount: row.lockedAmount === null ? null : integer(row.lockedAmount),
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
  };
}

export async function listPayroll(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
): Promise<Record<string, unknown>[]> {
  const input = query(request);
  reader(actor, input.maidProfileId);
  const { data, error } = await clients.admin.rpc("list_payroll_cycles", {
    p_actor_profile_id: actor.profileId,
    p_week_start: input.weekStart,
    p_maid_profile_id: input.maidProfileId,
  });
  if (error || !Array.isArray(data)) throw payrollDatabaseError(error);
  return data.map(projection);
}

export async function startPayroll(
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
  return projection(data);
}
