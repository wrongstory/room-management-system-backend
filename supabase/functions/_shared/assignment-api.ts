import type { EdgeActor, EdgeClients } from "./runtime.ts";
import {
  bearerToken,
  EdgeError,
  requireBusinessAdmin,
  requirePasswordChanged,
} from "./runtime.ts";
import { idempotencyKey, readJsonBody } from "./account-api.ts";

interface AssignmentRow {
  id: string;
  cleaning_target_id: string;
  maid_profile_id: string;
  service_date: string;
  sequence_number: number;
  revision: number;
  is_current: boolean;
  available_from_snapshot: string | null;
  due_at_snapshot: string | null;
  notified_at: string | null;
  ended_at: string | null;
  created_at: string;
}

interface TargetRow {
  id: string;
  room_id: string;
  assignment_version: number;
  rooms?: { room_number: string } | Array<{ room_number: string }> | null;
}

interface MaidRow {
  id: string;
  display_name: string;
}

export interface AssignmentProjection {
  assignmentId: string;
  cleaningTargetId: string;
  roomId: string;
  roomNumber: string;
  maidProfileId: string;
  maidDisplayName: string;
  serviceDate: string;
  sequenceNumber: number;
  revision: number;
  isCurrent: boolean;
  targetAssignmentVersion: number;
  availableFrom: string | null;
  dueAt: string | null;
  notifiedAt: string | null;
  endedAt: string | null;
  createdAt: string;
}

const assignmentColumns = [
  "id",
  "cleaning_target_id",
  "maid_profile_id",
  "service_date",
  "sequence_number",
  "revision",
  "is_current",
  "available_from_snapshot",
  "due_at_snapshot",
  "notified_at",
  "ended_at",
  "created_at",
].join(",");

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

function validationError(message: string): never {
  throw new EdgeError(400, "VALIDATION_ERROR", message);
}

function uuidValue(value: unknown, name: string): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    validationError(`${name}에 UUID가 필요합니다.`);
  }
  return value;
}

function dateValue(value: unknown, name: string): string {
  if (typeof value !== "string" || !datePattern.test(value)) {
    validationError(`${name}은 YYYY-MM-DD 형식이어야 합니다.`);
  }
  const [yearText, monthText, dayText] = value.split("-");
  const parsed = new Date(
    Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText)),
  );
  if (
    parsed.getUTCFullYear() !== Number(yearText) ||
    parsed.getUTCMonth() !== Number(monthText) - 1 ||
    parsed.getUTCDate() !== Number(dayText)
  ) {
    validationError(`${name}에 유효한 날짜가 필요합니다.`);
  }
  return value;
}

function integerValue(value: unknown, name: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    validationError(`${name}은 ${minimum} 이상의 정수여야 합니다.`);
  }
  return value as number;
}

function booleanValue(value: string | null, name: string): boolean {
  if (value === null || value === "false") return false;
  if (value === "true") return true;
  validationError(`${name}은 true 또는 false여야 합니다.`);
}

function assertOnlyFields(
  body: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const unexpected = Object.keys(body).find((key) => !allowed.includes(key));
  if (unexpected) {
    validationError(`허용되지 않은 요청 필드입니다: ${unexpected}`);
  }
  const missing = allowed.find((key) => !Object.hasOwn(body, key));
  if (missing) {
    validationError(`필수 요청 필드가 없습니다: ${missing}`);
  }
}

function queryValues(request: Request, allowed: readonly string[]) {
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

function requireAssignmentReader(actor: EdgeActor): void {
  requirePasswordChanged(actor);
  if (actor.role !== "admin" && actor.role !== "maid") {
    throw new EdgeError(
      403,
      "ASSIGNMENT_ACCESS_REQUIRED",
      "관리자 또는 배정된 메이드만 청소 배정을 조회할 수 있습니다.",
    );
  }
}

function requireAssignmentAdmin(actor: EdgeActor): void {
  requirePasswordChanged(actor);
  requireBusinessAdmin(actor);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

async function requestHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function assignmentTargetIdFromPath(path: string): string | null {
  const match = path.match(/^\/v1\/assignments\/([^/]+)\/history$/);
  if (!match?.[1]) return null;
  return uuidValue(match[1], "cleaningTargetId");
}

export function assignmentDatabaseError(
  error: { message?: string } | null,
): EdgeError {
  const message = error?.message ?? "";
  const mappings: Array<[string, number, string, string]> = [
    [
      "ADMIN_REQUIRED",
      403,
      "ADMIN_REQUIRED",
      "관리자만 배정을 저장할 수 있습니다.",
    ],
    [
      "CLEANING_TARGET_NOT_FOUND",
      404,
      "CLEANING_TARGET_NOT_FOUND",
      "청소 대상을 찾을 수 없습니다.",
    ],
    [
      "ASSIGNMENT_VERSION_CONFLICT",
      409,
      "ASSIGNMENT_VERSION_CONFLICT",
      "배정 version이 변경되었습니다. 최신 상태를 다시 확인해 주세요.",
    ],
    [
      "ASSIGNMENT_TARGET_STATE_INVALID",
      409,
      "ASSIGNMENT_TARGET_STATE_INVALID",
      "현재 청소 대상 상태에서는 draft 배정을 저장할 수 없습니다.",
    ],
    [
      "ACTIVE_MAID_REQUIRED",
      409,
      "ACTIVE_MAID_REQUIRED",
      "활성 메이드 계정이 필요합니다.",
    ],
    [
      "cleaning_assignments_current_maid_date_sequence",
      409,
      "ASSIGNMENT_SEQUENCE_CONFLICT",
      "해당 메이드의 같은 날짜 순서가 이미 사용 중입니다.",
    ],
    [
      "IDEMPOTENCY_KEY_REUSED",
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "이미 다른 요청에 사용한 Idempotency-Key입니다.",
    ],
  ];
  for (const [needle, status, code, userMessage] of mappings) {
    if (message.includes(needle)) {
      return new EdgeError(status, code, userMessage);
    }
  }
  return new EdgeError(
    500,
    "ASSIGNMENT_COMMAND_FAILED",
    "청소 배정 정보를 처리하지 못했습니다.",
  );
}

function accessTokenClient(request: Request, clients: EdgeClients) {
  return clients.forAccessToken(bearerToken(request));
}

function roomNumber(target: TargetRow): string {
  const rooms = target.rooms;
  const room = Array.isArray(rooms) ? rooms[0] : rooms;
  if (!room?.room_number) {
    throw new EdgeError(
      500,
      "ASSIGNMENT_COMMAND_FAILED",
      "청소 배정 정보를 처리하지 못했습니다.",
    );
  }
  return room.room_number;
}

async function hydrateAssignments(
  clients: EdgeClients,
  rows: AssignmentRow[],
): Promise<AssignmentProjection[]> {
  if (rows.length === 0) return [];
  const targetIds = [...new Set(rows.map((row) => row.cleaning_target_id))];
  const maidIds = [...new Set(rows.map((row) => row.maid_profile_id))];
  const [targetResult, maidResult] = await Promise.all([
    clients.admin
      .from("cleaning_targets")
      .select("id,room_id,assignment_version,rooms!inner(room_number)")
      .in("id", targetIds),
    clients.admin
      .from("profiles")
      .select("id,display_name")
      .in("id", maidIds),
  ]);
  if (targetResult.error || maidResult.error) {
    throw assignmentDatabaseError(targetResult.error ?? maidResult.error);
  }
  const targets = new Map(
    ((targetResult.data ?? []) as unknown as TargetRow[]).map((row) => [
      row.id,
      row,
    ]),
  );
  const maids = new Map(
    ((maidResult.data ?? []) as MaidRow[]).map((row) => [row.id, row]),
  );

  return rows.map((row) => {
    const target = targets.get(row.cleaning_target_id);
    const maid = maids.get(row.maid_profile_id);
    if (!target || !maid) {
      throw new EdgeError(
        500,
        "ASSIGNMENT_COMMAND_FAILED",
        "청소 배정 정보를 처리하지 못했습니다.",
      );
    }
    return {
      assignmentId: row.id,
      cleaningTargetId: row.cleaning_target_id,
      roomId: target.room_id,
      roomNumber: roomNumber(target),
      maidProfileId: row.maid_profile_id,
      maidDisplayName: maid.display_name,
      serviceDate: row.service_date,
      sequenceNumber: row.sequence_number,
      revision: row.revision,
      isCurrent: row.is_current,
      targetAssignmentVersion: target.assignment_version,
      availableFrom: row.available_from_snapshot,
      dueAt: row.due_at_snapshot,
      notifiedAt: row.notified_at,
      endedAt: row.ended_at,
      createdAt: row.created_at,
    };
  });
}

export async function listAssignments(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
) {
  requireAssignmentReader(actor);
  const search = queryValues(request, [
    "serviceDate",
    "maidProfileId",
    "includeHistory",
  ]);
  const serviceDate = dateValue(search.get("serviceDate"), "serviceDate");
  const maidProfileId = search.get("maidProfileId") === null
    ? undefined
    : uuidValue(search.get("maidProfileId"), "maidProfileId");
  const includeHistory = booleanValue(
    search.get("includeHistory"),
    "includeHistory",
  );
  if (
    actor.role === "maid" && maidProfileId && maidProfileId !== actor.profileId
  ) {
    throw new EdgeError(
      403,
      "ASSIGNMENT_ACCESS_REQUIRED",
      "다른 메이드의 청소 배정은 조회할 수 없습니다.",
    );
  }

  let query = accessTokenClient(request, clients)
    .from("cleaning_assignments")
    .select(assignmentColumns)
    .eq("service_date", serviceDate)
    .order("sequence_number")
    .order("revision");
  if (!includeHistory) query = query.eq("is_current", true);
  if (actor.role === "maid") {
    query = query.eq("maid_profile_id", actor.profileId);
  } else if (maidProfileId) {
    query = query.eq("maid_profile_id", maidProfileId);
  }
  const { data, error } = await query;
  if (error) throw assignmentDatabaseError(error);
  return hydrateAssignments(
    clients,
    (data ?? []) as unknown as AssignmentRow[],
  );
}

export async function assignmentHistory(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  cleaningTargetId: string,
) {
  requireAssignmentReader(actor);
  let query = accessTokenClient(request, clients)
    .from("cleaning_assignments")
    .select(assignmentColumns)
    .eq("cleaning_target_id", uuidValue(cleaningTargetId, "cleaningTargetId"))
    .order("revision");
  if (actor.role === "maid") {
    query = query.eq("maid_profile_id", actor.profileId);
  }
  const { data, error } = await query;
  if (error) throw assignmentDatabaseError(error);
  const rows = (data ?? []) as unknown as AssignmentRow[];
  if (rows.length === 0) {
    throw actor.role === "maid"
      ? new EdgeError(
        403,
        "ASSIGNMENT_ACCESS_REQUIRED",
        "이 청소 대상의 배정 이력을 조회할 수 없습니다.",
      )
      : new EdgeError(
        404,
        "ASSIGNMENT_NOT_FOUND",
        "청소 배정 이력을 찾을 수 없습니다.",
      );
  }
  return hydrateAssignments(clients, rows);
}

function toAssignmentProjection(value: unknown): AssignmentProjection {
  if (!value || typeof value !== "object") {
    throw assignmentDatabaseError(null);
  }
  const row = value as Record<string, unknown>;
  return {
    assignmentId: uuidValue(row.assignmentId, "assignmentId"),
    cleaningTargetId: uuidValue(row.cleaningTargetId, "cleaningTargetId"),
    roomId: uuidValue(row.roomId, "roomId"),
    roomNumber: String(row.roomNumber),
    maidProfileId: uuidValue(row.maidProfileId, "maidProfileId"),
    maidDisplayName: String(row.maidDisplayName),
    serviceDate: dateValue(row.serviceDate, "serviceDate"),
    sequenceNumber: integerValue(row.sequenceNumber, "sequenceNumber", 1),
    revision: integerValue(row.revision, "revision", 1),
    isCurrent: row.isCurrent === true,
    targetAssignmentVersion: integerValue(
      row.targetAssignmentVersion,
      "targetAssignmentVersion",
      1,
    ),
    availableFrom: typeof row.availableFrom === "string"
      ? row.availableFrom
      : null,
    dueAt: typeof row.dueAt === "string" ? row.dueAt : null,
    notifiedAt: typeof row.notifiedAt === "string" ? row.notifiedAt : null,
    endedAt: typeof row.endedAt === "string" ? row.endedAt : null,
    createdAt: String(row.createdAt),
  };
}

export async function saveAssignmentDraft(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
) {
  requireAssignmentAdmin(actor);
  const body = await readJsonBody(request);
  assertOnlyFields(body, [
    "cleaningTargetId",
    "maidProfileId",
    "sequenceNumber",
    "expectedAssignmentVersion",
  ]);
  const command = {
    cleaningTargetId: uuidValue(body.cleaningTargetId, "cleaningTargetId"),
    maidProfileId: uuidValue(body.maidProfileId, "maidProfileId"),
    sequenceNumber: integerValue(body.sequenceNumber, "sequenceNumber", 1),
    expectedAssignmentVersion: integerValue(
      body.expectedAssignmentVersion,
      "expectedAssignmentVersion",
      1,
    ),
  };
  const commandKey = idempotencyKey(request);
  const commandRequestHash = await requestHash({
    command: "assignment.save_draft",
    actorProfileId: actor.profileId,
    ...command,
  });
  const { data, error } = await clients.admin.rpc(
    "save_cleaning_assignment_draft",
    {
      p_actor_profile_id: actor.profileId,
      p_cleaning_target_id: command.cleaningTargetId,
      p_maid_profile_id: command.maidProfileId,
      p_sequence_number: command.sequenceNumber,
      p_expected_assignment_version: command.expectedAssignmentVersion,
      p_idempotency_key: commandKey,
      p_request_hash: commandRequestHash,
    },
  );
  if (error || !data) throw assignmentDatabaseError(error);
  return toAssignmentProjection(data);
}
