import type { EdgeActor, EdgeClients } from "./runtime.ts";
import {
  bearerToken,
  EdgeError,
  requireBusinessAdmin,
  requirePasswordChanged,
} from "./runtime.ts";
import { idempotencyKey, readJsonBody } from "./account-api.ts";

type AvailabilityStatus = "submitted" | "superseded";
type ChangeRequestStatus = "pending" | "approved" | "rejected";

interface AvailabilityDayRow {
  work_date: string;
  available: boolean;
}

interface AvailabilityVersionRow {
  id: string;
  maid_profile_id: string;
  week_start: string;
  version: number;
  status: AvailabilityStatus;
  is_current: boolean;
  submitted_at: string;
  availability_days?: AvailabilityDayRow[] | null;
}

interface AvailabilityChangeRequestRow {
  id: string;
  availability_version_id: string;
  maid_profile_id: string;
  week_start: string;
  source_version: number;
  requested_available_dates: string[];
  reason_code: string;
  status: ChangeRequestStatus;
  requested_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_reason_code: string | null;
  approved_version_id: string | null;
}

interface AvailabilityCandidateRow {
  work_date: string;
  week_start: string;
  availability_version: number;
  maid_profile_id: string;
  display_name: string;
}

const availabilityVersionColumns = [
  "id",
  "maid_profile_id",
  "week_start",
  "version",
  "status",
  "is_current",
  "submitted_at",
  "availability_days(work_date,available)",
].join(",");

const changeRequestColumns = [
  "id",
  "availability_version_id",
  "maid_profile_id",
  "week_start",
  "source_version",
  "requested_available_dates",
  "reason_code",
  "status",
  "requested_at",
  "decided_by",
  "decided_at",
  "decision_reason_code",
  "approved_version_id",
].join(",");

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const reasonCodePattern = /^[A-Z0-9_]{2,80}$/;

function validationError(message: string): never {
  throw new EdgeError(400, "VALIDATION_ERROR", message);
}

function requireAvailabilityReader(actor: EdgeActor): void {
  requirePasswordChanged(actor);
  if (actor.role !== "maid" && actor.role !== "admin") {
    throw new EdgeError(
      403,
      "AVAILABILITY_ACCESS_REQUIRED",
      "메이드 또는 관리자만 가능일을 조회할 수 있습니다.",
    );
  }
}

function requireMaid(actor: EdgeActor): void {
  requirePasswordChanged(actor);
  if (actor.role !== "maid") {
    throw new EdgeError(
      403,
      "MAID_REQUIRED",
      "메이드 계정만 가능일을 제출하거나 변경 요청할 수 있습니다.",
    );
  }
}

function requireAvailabilityAdmin(actor: EdgeActor): void {
  requirePasswordChanged(actor);
  requireBusinessAdmin(actor);
}

function dateValue(value: unknown, name: string): string {
  if (typeof value !== "string" || !datePattern.test(value)) {
    validationError(`${name}은 YYYY-MM-DD 형식이어야 합니다.`);
  }
  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    validationError(`${name}에 유효한 날짜가 필요합니다.`);
  }
  return value;
}

function uuidValue(value: unknown, name: string): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    validationError(`${name}에 UUID가 필요합니다.`);
  }
  return value;
}

function integerValue(value: unknown, name: string, minimum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum) {
    validationError(`${name}은 ${minimum} 이상의 정수여야 합니다.`);
  }
  return value as number;
}

function reasonCodeValue(value: unknown): string {
  if (typeof value !== "string") {
    validationError("reasonCode 문자열이 필요합니다.");
  }
  const normalized = value.trim();
  if (!reasonCodePattern.test(normalized)) {
    validationError(
      "reasonCode는 2~80자의 영문 대문자, 숫자, 밑줄만 사용할 수 있습니다.",
    );
  }
  return normalized;
}

function dateArrayValue(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length > 7) {
    validationError(`${name}은 최대 7개의 날짜 배열이어야 합니다.`);
  }
  const dates = value.map((item) => dateValue(item, name));
  if (new Set(dates).size !== dates.length) {
    validationError(`${name}은 중복 없이 입력해야 합니다.`);
  }
  return dates;
}

function assertOnlyFields(
  body: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const unexpected = Object.keys(body).find((key) => !allowed.includes(key));
  if (unexpected) {
    validationError(`허용되지 않은 요청 필드입니다: ${unexpected}`);
  }
}

function queryValues(
  request: Request,
  allowed: readonly string[],
): URLSearchParams {
  const search = new URL(request.url).searchParams;
  for (const key of search.keys()) {
    if (!allowed.includes(key)) {
      validationError(`허용되지 않은 query 항목입니다: ${key}`);
    }
    if (search.getAll(key).length > 1) {
      validationError(`query 항목은 한 번만 전달해야 합니다: ${key}`);
    }
  }
  return search;
}

function optionalUuid(
  search: URLSearchParams,
  name: string,
): string | undefined {
  const value = search.get(name);
  return value === null ? undefined : uuidValue(value, name);
}

function optionalDate(
  search: URLSearchParams,
  name: string,
): string | undefined {
  const value = search.get(name);
  return value === null ? undefined : dateValue(value, name);
}

export function toAvailabilityVersion(row: AvailabilityVersionRow) {
  return {
    id: row.id,
    maidProfileId: row.maid_profile_id,
    weekStart: row.week_start,
    version: row.version,
    status: row.status,
    current: row.is_current,
    submittedAt: row.submitted_at,
    days: [...(row.availability_days ?? [])]
      .sort((left, right) => left.work_date.localeCompare(right.work_date))
      .map((day) => ({
        workDate: day.work_date,
        available: day.available,
      })),
  };
}

export function toAvailabilityChangeRequest(
  row: AvailabilityChangeRequestRow,
) {
  return {
    id: row.id,
    availabilityVersionId: row.availability_version_id,
    maidProfileId: row.maid_profile_id,
    weekStart: row.week_start,
    sourceVersion: row.source_version,
    requestedAvailableDates: row.requested_available_dates,
    reasonCode: row.reason_code,
    status: row.status,
    requestedAt: row.requested_at,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    decisionReasonCode: row.decision_reason_code,
    approvedVersionId: row.approved_version_id,
  };
}

export function availabilityDatabaseError(
  error: { message?: string } | null,
): EdgeError {
  const message = error?.message ?? "";
  const mappings: Array<[string, number, string, string]> = [
    [
      "ACTIVE_MAID_REQUIRED",
      403,
      "ACTIVE_MAID_REQUIRED",
      "활성 메이드 계정만 가능일을 제출할 수 있습니다.",
    ],
    [
      "ACTIVE_ADMIN_REQUIRED",
      403,
      "ACTIVE_ADMIN_REQUIRED",
      "활성 관리자만 변경 요청을 처리할 수 있습니다.",
    ],
    [
      "OUTSIDE_AVAILABILITY_WINDOW",
      409,
      "OUTSIDE_AVAILABILITY_WINDOW",
      "가능일은 일요일 12:00–23:59 KST에 제출할 수 있습니다.",
    ],
    [
      "CHANGE_REQUEST_BEFORE_DEADLINE",
      409,
      "CHANGE_REQUEST_BEFORE_DEADLINE",
      "제출 마감 전에는 새 version으로 다시 제출해 주세요.",
    ],
    [
      "STALE_VERSION",
      409,
      "STALE_VERSION",
      "가능일 version이 변경되었습니다. 최신 상태를 다시 확인해 주세요.",
    ],
    [
      "IDEMPOTENCY_KEY_REUSED",
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "이미 다른 요청에 사용한 Idempotency-Key입니다.",
    ],
    [
      "PENDING_CHANGE_REQUEST_EXISTS",
      409,
      "PENDING_CHANGE_REQUEST_EXISTS",
      "처리 중인 가능일 변경 요청이 이미 있습니다.",
    ],
    [
      "INVALID_TRANSITION",
      409,
      "INVALID_TRANSITION",
      "이미 처리된 변경 요청입니다.",
    ],
    [
      "AVAILABILITY_NOT_FOUND",
      404,
      "AVAILABILITY_NOT_FOUND",
      "제출된 가능일을 찾을 수 없습니다.",
    ],
    [
      "CHANGE_REQUEST_NOT_FOUND",
      404,
      "CHANGE_REQUEST_NOT_FOUND",
      "가능일 변경 요청을 찾을 수 없습니다.",
    ],
    [
      "WEEK_START_MUST_BE_MONDAY",
      400,
      "WEEK_START_MUST_BE_MONDAY",
      "weekStart는 월요일이어야 합니다.",
    ],
    [
      "AVAILABILITY_DATES_MUST_BE_UNIQUE",
      400,
      "AVAILABILITY_DATES_MUST_BE_UNIQUE",
      "가능일은 중복 없이 입력해 주세요.",
    ],
    [
      "AVAILABILITY_DATE_OUTSIDE_WEEK",
      400,
      "AVAILABILITY_DATE_OUTSIDE_WEEK",
      "가능일은 대상 주차의 월요일–일요일 범위여야 합니다.",
    ],
  ];
  for (const [needle, status, code, userMessage] of mappings) {
    if (message.includes(needle)) {
      return new EdgeError(status, code, userMessage);
    }
  }
  return new EdgeError(
    500,
    "AVAILABILITY_COMMAND_FAILED",
    "가능일 정보를 처리하지 못했습니다.",
  );
}

function accessTokenClient(request: Request, clients: EdgeClients) {
  return clients.forAccessToken(bearerToken(request));
}

async function versionById(clients: EdgeClients, versionId: string) {
  const { data, error } = await clients.admin
    .from("availability_versions")
    .select(availabilityVersionColumns)
    .eq("id", versionId)
    .single();
  if (error || !data) {
    throw availabilityDatabaseError(error);
  }
  return toAvailabilityVersion(data as unknown as AvailabilityVersionRow);
}

export async function listAvailability(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
) {
  requireAvailabilityReader(actor);
  const search = queryValues(request, ["weekStart", "maidProfileId"]);
  const weekStart = dateValue(search.get("weekStart"), "weekStart");
  const maidProfileId = optionalUuid(search, "maidProfileId");
  if (
    actor.role === "maid" && maidProfileId && maidProfileId !== actor.profileId
  ) {
    throw new EdgeError(
      403,
      "FORBIDDEN",
      "다른 메이드의 가능일은 조회할 수 없습니다.",
    );
  }

  let query = accessTokenClient(request, clients)
    .from("availability_versions")
    .select(availabilityVersionColumns)
    .eq("week_start", weekStart)
    .eq("is_current", true)
    .order("maid_profile_id");
  if (actor.role === "maid") {
    query = query.eq("maid_profile_id", actor.profileId);
  } else if (maidProfileId) {
    query = query.eq("maid_profile_id", maidProfileId);
  }
  const { data, error } = await query;
  if (error) {
    throw availabilityDatabaseError(error);
  }
  return (data as unknown as AvailabilityVersionRow[]).map(
    toAvailabilityVersion,
  );
}

export async function submitAvailability(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
) {
  requireMaid(actor);
  const body = await readJsonBody(request);
  assertOnlyFields(body, ["weekStart", "availableDates", "expectedVersion"]);
  const { data, error } = await clients.admin.rpc(
    "submit_weekly_availability",
    {
      p_actor_profile_id: actor.profileId,
      p_week_start: dateValue(body.weekStart, "weekStart"),
      p_available_dates: dateArrayValue(body.availableDates, "availableDates"),
      p_expected_version: integerValue(
        body.expectedVersion,
        "expectedVersion",
        0,
      ),
      p_idempotency_key: idempotencyKey(request),
    },
  );
  if (error || !data) {
    throw availabilityDatabaseError(error);
  }
  return versionById(clients, (data as AvailabilityVersionRow).id);
}

export async function listAvailabilityChangeRequests(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
) {
  requireAvailabilityReader(actor);
  const search = queryValues(request, ["status", "weekStart", "maidProfileId"]);
  const status = search.get("status") ?? undefined;
  if (
    status !== undefined &&
    status !== "pending" &&
    status !== "approved" &&
    status !== "rejected"
  ) {
    validationError("status는 pending, approved, rejected 중 하나여야 합니다.");
  }
  const weekStart = optionalDate(search, "weekStart");
  const maidProfileId = optionalUuid(search, "maidProfileId");
  if (
    actor.role === "maid" && maidProfileId && maidProfileId !== actor.profileId
  ) {
    throw new EdgeError(
      403,
      "FORBIDDEN",
      "다른 메이드의 가능일 변경 요청은 조회할 수 없습니다.",
    );
  }

  let query = accessTokenClient(request, clients)
    .from("availability_change_requests")
    .select(changeRequestColumns)
    .order("requested_at", { ascending: false });
  if (actor.role === "maid") {
    query = query.eq("maid_profile_id", actor.profileId);
  } else if (maidProfileId) {
    query = query.eq("maid_profile_id", maidProfileId);
  }
  if (status) {
    query = query.eq("status", status);
  }
  if (weekStart) {
    query = query.eq("week_start", weekStart);
  }
  const { data, error } = await query;
  if (error) {
    throw availabilityDatabaseError(error);
  }
  return (data as unknown as AvailabilityChangeRequestRow[]).map(
    toAvailabilityChangeRequest,
  );
}

export async function requestAvailabilityChange(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
) {
  requireMaid(actor);
  const body = await readJsonBody(request);
  assertOnlyFields(body, [
    "weekStart",
    "requestedAvailableDates",
    "reasonCode",
    "expectedVersion",
  ]);
  const { data, error } = await clients.admin.rpc(
    "request_availability_change",
    {
      p_actor_profile_id: actor.profileId,
      p_week_start: dateValue(body.weekStart, "weekStart"),
      p_requested_available_dates: dateArrayValue(
        body.requestedAvailableDates,
        "requestedAvailableDates",
      ),
      p_reason_code: reasonCodeValue(body.reasonCode),
      p_expected_version: integerValue(
        body.expectedVersion,
        "expectedVersion",
        1,
      ),
      p_idempotency_key: idempotencyKey(request),
    },
  );
  if (error || !data) {
    throw availabilityDatabaseError(error);
  }
  return toAvailabilityChangeRequest(
    data as AvailabilityChangeRequestRow,
  );
}

export function availabilityDecisionRequestId(path: string): string {
  const match = path.match(
    /^\/v1\/availability\/change-requests\/([^/]+)\/decision$/,
  );
  if (!match?.[1]) {
    validationError("가능일 변경 요청 경로가 올바르지 않습니다.");
  }
  return uuidValue(match[1], "requestId");
}

export async function decideAvailabilityChange(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  requestId: string,
) {
  requireAvailabilityAdmin(actor);
  const body = await readJsonBody(request);
  assertOnlyFields(body, ["decision", "reasonCode", "expectedVersion"]);
  if (body.decision !== "approved" && body.decision !== "rejected") {
    validationError("decision은 approved 또는 rejected여야 합니다.");
  }
  const { data, error } = await clients.admin.rpc(
    "decide_availability_change",
    {
      p_actor_profile_id: actor.profileId,
      p_change_request_id: uuidValue(requestId, "requestId"),
      p_decision: body.decision,
      p_reason_code: reasonCodeValue(body.reasonCode),
      p_expected_version: integerValue(
        body.expectedVersion,
        "expectedVersion",
        1,
      ),
      p_idempotency_key: idempotencyKey(request),
    },
  );
  if (error || !data) {
    throw availabilityDatabaseError(error);
  }
  return toAvailabilityChangeRequest(
    data as AvailabilityChangeRequestRow,
  );
}

export async function listAvailabilityCandidates(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
) {
  requireAvailabilityAdmin(actor);
  const search = queryValues(request, ["workDate"]);
  const workDate = dateValue(search.get("workDate"), "workDate");
  const { data, error } = await accessTokenClient(request, clients)
    .from("availability_candidates")
    .select(
      "work_date,week_start,availability_version,maid_profile_id,display_name",
    )
    .eq("work_date", workDate)
    .order("display_name");
  if (error) {
    throw availabilityDatabaseError(error);
  }
  return ((data ?? []) as AvailabilityCandidateRow[]).map((row) => ({
    workDate: row.work_date,
    weekStart: row.week_start,
    availabilityVersion: row.availability_version,
    maidProfileId: row.maid_profile_id,
    displayName: row.display_name,
  }));
}
