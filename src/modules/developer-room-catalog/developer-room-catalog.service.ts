import type { Actor } from "../../domain/actor.js";
import { AppError } from "../../lib/app-error.js";
import { requestHash } from "../../lib/command.js";
import type { SupabaseClients } from "../../lib/supabase.js";

export type RoomCatalogStatus = "active" | "retired";
export interface DeveloperRoomCatalogItem {
  id: string;
  roomNumber: string;
  status: RoomCatalogStatus;
  version: number;
  roomTypeId: string;
  roomTypeCode: string;
  roomTypeName: string;
  roomTypeVersion: number;
  elevatorZone: "A" | "B" | "C" | null;
  createdAt: string;
  retiredAt: string | null;
  retirementReasonCode?: string | null;
}
export interface DeveloperRoomCatalogPage {
  counts: { active: number; retired: number; total: number };
  items: DeveloperRoomCatalogItem[];
  nextCursor: string | null;
}
export interface CreateDeveloperRoomInput {
  roomNumber: string;
  roomTypeId: string;
  expectedRoomTypeVersion: number;
  elevatorZone: "A" | "B" | "C" | null;
  idempotencyKey: string;
}
export interface RetireDeveloperRoomInput {
  roomId: string;
  expectedVersion: number;
  reasonCode: string;
  idempotencyKey: string;
}
export interface DeveloperRoomCatalogService {
  list(
    actor: Actor,
    status: "all" | RoomCatalogStatus,
    cursor: string | null,
    limit: number,
  ): Promise<DeveloperRoomCatalogPage>;
  create(
    actor: Actor,
    input: CreateDeveloperRoomInput,
  ): Promise<DeveloperRoomCatalogItem>;
  retire(
    actor: Actor,
    input: RetireDeveloperRoomInput,
  ): Promise<DeveloperRoomCatalogItem>;
}

interface CatalogCursor {
  roomNumber: string;
  id: string;
}
function encodeCursor(value: CatalogCursor): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
function decodeCursor(value: string | null): CatalogCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      Object.keys(parsed).sort().join(",") !== "id,roomNumber" ||
      typeof parsed.roomNumber !== "string" ||
      !/^[0-9]{1,8}$/.test(parsed.roomNumber) ||
      typeof parsed.id !== "string" || !/^[0-9a-f-]{36}$/i.test(parsed.id)
    ) throw new Error();
    return parsed as unknown as CatalogCursor;
  } catch {
    throw new AppError(
      400,
      "INVALID_ROOM_CATALOG_CURSOR",
      "객실 목록 cursor가 올바르지 않습니다.",
    );
  }
}
function sessionId(token: string): string {
  try {
    const value = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as { session_id?: unknown };
    if (
      typeof value.session_id !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(value.session_id)
    ) throw new Error();
    return value.session_id;
  } catch {
    throw new AppError(401, "INVALID_ACCESS_TOKEN", "로그인이 필요합니다.");
  }
}
function catalogError(error: { message?: string } | null): AppError {
  const code = error?.message ?? "";
  const badRequest = [
    "INVALID_ROOM_CATALOG_STATUS",
    "INVALID_ROOM_CATALOG_PAGE_SIZE",
    "INVALID_ROOM_CATALOG_CURSOR",
    "INVALID_ROOM_CATALOG_ENTRY",
    "INVALID_ROOM_RETIREMENT_REASON",
  ];
  if (badRequest.some((value) => code.includes(value))) {
    return new AppError(400, code, "객실 카탈로그 요청이 올바르지 않습니다.");
  }
  if (code.includes("ROOM_NOT_FOUND")) {
    return new AppError(404, "ROOM_NOT_FOUND", "객실을 찾을 수 없습니다.");
  }
  if (
    code.includes("DEVELOPER_REQUIRED") ||
    code.includes("ACTIVE_ACCOUNT_REQUIRED")
  ) {
    return new AppError(
      403,
      "DEVELOPER_REQUIRED",
      "개발자만 객실 카탈로그를 관리할 수 있습니다.",
    );
  }
  if (code.includes("PASSWORD_CHANGE_REQUIRED")) {
    return new AppError(
      403,
      "PASSWORD_CHANGE_REQUIRED",
      "먼저 임시 비밀번호를 변경해 주세요.",
    );
  }
  if (code.includes("SESSION_REVOKED")) {
    return new AppError(401, "SESSION_REVOKED", "로그인이 만료되었습니다.");
  }
  const conflict = [
    "STALE_VERSION",
    "STALE_ROOM_TYPE_VERSION",
    "IDEMPOTENCY_KEY_REUSED",
    "ROOM_NUMBER_ALREADY_USED",
    "ROOM_TYPE_NOT_PUBLISHED",
    "ROOM_ALREADY_RETIRED",
    "ROOM_RETIRE_RESERVATION_CONFLICT",
    "ROOM_RETIRE_CLEANING_CONFLICT",
    "ROOM_RETIRE_ISSUE_CONFLICT",
    "ROOM_RETIRE_OPERATION_BLOCK_CONFLICT",
    "ROOM_RETIRE_PIN_WORKFLOW_CONFLICT",
    "ROOM_CATALOG_ACTIVE_LIMIT_EXCEEDED",
  ];
  const found = conflict.find((value) => code.includes(value));
  if (found) {
    return new AppError(
      409,
      found,
      "현재 객실 카탈로그 상태와 요청이 충돌합니다.",
    );
  }
  return new AppError(
    500,
    "ROOM_CATALOG_COMMAND_FAILED",
    "객실 카탈로그를 처리하지 못했습니다.",
  );
}
function ensureDeveloper(actor: Actor): void {
  if (actor.role !== "developer") {
    throw new AppError(
      403,
      "DEVELOPER_REQUIRED",
      "개발자만 객실 카탈로그를 관리할 수 있습니다.",
    );
  }
}

export class SupabaseDeveloperRoomCatalogService
  implements DeveloperRoomCatalogService {
  constructor(private readonly clients: SupabaseClients) {}
  async list(
    actor: Actor,
    status: "all" | RoomCatalogStatus,
    rawCursor: string | null,
    limit: number,
  ): Promise<DeveloperRoomCatalogPage> {
    ensureDeveloper(actor);
    const cursor = decodeCursor(rawCursor);
    const { data, error } = await this.clients.admin.rpc(
      "list_developer_room_catalog",
      {
        p_actor_profile_id: actor.profileId,
        p_session_id: sessionId(actor.accessToken),
        p_status: status,
        p_after_room_number: cursor?.roomNumber ?? null,
        p_after_id: cursor?.id ?? null,
        p_limit: limit,
      },
    );
    if (error || !data || typeof data !== "object") throw catalogError(error);
    const row = data as Record<string, unknown>;
    const nextCursor =
      row.hasMore === true && typeof row.nextRoomNumber === "string" &&
        typeof row.nextId === "string"
        ? encodeCursor({ roomNumber: row.nextRoomNumber, id: row.nextId })
        : null;
    return {
      counts: row.counts as DeveloperRoomCatalogPage["counts"],
      items: row.items as DeveloperRoomCatalogItem[],
      nextCursor,
    };
  }
  async create(
    actor: Actor,
    input: CreateDeveloperRoomInput,
  ): Promise<DeveloperRoomCatalogItem> {
    ensureDeveloper(actor);
    const payload = {
      roomNumber: input.roomNumber,
      roomTypeId: input.roomTypeId,
      expectedRoomTypeVersion: input.expectedRoomTypeVersion,
      elevatorZone: input.elevatorZone,
    };
    const { data, error } = await this.clients.admin.rpc(
      "create_room_catalog_entry",
      {
        p_actor_profile_id: actor.profileId,
        p_session_id: sessionId(actor.accessToken),
        p_room_number: input.roomNumber,
        p_room_type_id: input.roomTypeId,
        p_expected_room_type_version: input.expectedRoomTypeVersion,
        p_elevator_zone: input.elevatorZone,
        p_idempotency_key: input.idempotencyKey,
        p_request_hash: requestHash(payload),
      },
    );
    if (error || !data) throw catalogError(error);
    return data as DeveloperRoomCatalogItem;
  }
  async retire(
    actor: Actor,
    input: RetireDeveloperRoomInput,
  ): Promise<DeveloperRoomCatalogItem> {
    ensureDeveloper(actor);
    const payload = {
      roomId: input.roomId,
      expectedVersion: input.expectedVersion,
      reasonCode: input.reasonCode,
    };
    const { data, error } = await this.clients.admin.rpc(
      "retire_room_catalog_entry",
      {
        p_actor_profile_id: actor.profileId,
        p_session_id: sessionId(actor.accessToken),
        p_room_id: input.roomId,
        p_expected_version: input.expectedVersion,
        p_reason_code: input.reasonCode,
        p_idempotency_key: input.idempotencyKey,
        p_request_hash: requestHash(payload),
      },
    );
    if (error || !data) throw catalogError(error);
    return data as DeveloperRoomCatalogItem;
  }
}
