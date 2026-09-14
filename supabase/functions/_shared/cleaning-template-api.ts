import { idempotencyKey, readJsonBody } from "./account-api.ts";
import {
  type EdgeActor,
  type EdgeClients,
  EdgeError,
  requireBusinessAdmin,
  requirePasswordChanged,
  verifiedRequestSessionId,
} from "./runtime.ts";

const roomTypeCodes = [
  "standard",
  "premium",
  "oceanPremium",
  "oceanFamily",
] as const;
type RoomTypeCode = typeof roomTypeCodes[number];
const expectedSlotCounts: Record<RoomTypeCode, number> = {
  standard: 10,
  premium: 11,
  oceanPremium: 13,
  oceanFamily: 15,
};
const slotKeys = [
  "slotKey",
  "displayOrder",
  "required",
  "label",
  "description",
  "section",
  "instanceKey",
];
const publishedKeys = [
  "id",
  "version",
  "status",
  "durationMinutes",
  "slots",
  "publishedAt",
  "createdAt",
];
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const timestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;

function isStrictRfc3339(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = timestampPattern.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
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
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 &&
    day <= (daysInMonth[month - 1] ?? 0) && hour <= 23 && minute <= 59 &&
    second <= 59 && offsetHour <= 23 && offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value));
}

function invalid(code = "INVALID_CLEANING_TEMPLATE"): never {
  throw new EdgeError(
    400,
    code,
    "청소 템플릿 입력값과 사진 슬롯을 확인해 주세요.",
  );
}

function adminOnly(actor: EdgeActor): void {
  requirePasswordChanged(actor);
  requireBusinessAdmin(actor);
}

function boundedText(value: unknown, maximum: number): string {
  if (typeof value !== "string") invalid("INVALID_CLEANING_TEMPLATE_SLOTS");
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maximum) {
    invalid("INVALID_CLEANING_TEMPLATE_SLOTS");
  }
  return normalized;
}

function hasExactKeys(
  row: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return Object.keys(row).length === expected.length &&
    expected.every((key) => Object.hasOwn(row, key));
}

function normalizeSlots(value: unknown, roomTypeCode: RoomTypeCode) {
  if (
    !Array.isArray(value) || value.length !== expectedSlotCounts[roomTypeCode]
  ) {
    invalid("INVALID_CLEANING_TEMPLATE_SLOTS");
  }
  const keys = new Set<string>();
  const orders = new Set<number>();
  const slots = value.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      invalid("INVALID_CLEANING_TEMPLATE_SLOTS");
    }
    const row = raw as Record<string, unknown>;
    if (
      Object.keys(row).some((key) => !slotKeys.includes(key)) ||
      !["slotKey", "displayOrder", "required", "label"].every((key) =>
        Object.hasOwn(row, key)
      ) ||
      typeof row.slotKey !== "string" ||
      !/^[a-z][a-z0-9-]{0,79}$/.test(row.slotKey) ||
      !Number.isSafeInteger(row.displayOrder) ||
      (row.displayOrder as number) < 0 ||
      (row.displayOrder as number) > 99 || typeof row.required !== "boolean" ||
      (row.instanceKey !== undefined && (
        typeof row.instanceKey !== "string" ||
        !/^[a-z][a-z0-9-]{0,79}$/.test(row.instanceKey)
      ))
    ) invalid("INVALID_CLEANING_TEMPLATE_SLOTS");
    if (keys.has(row.slotKey) || orders.has(row.displayOrder as number)) {
      invalid("INVALID_CLEANING_TEMPLATE_SLOTS");
    }
    keys.add(row.slotKey);
    orders.add(row.displayOrder as number);
    return {
      slotKey: row.slotKey,
      displayOrder: row.displayOrder as number,
      required: row.required,
      label: boundedText(row.label, 80),
      ...(row.description !== undefined
        ? { description: boundedText(row.description, 200) }
        : {}),
      ...(row.section !== undefined
        ? { section: boundedText(row.section, 80) }
        : {}),
      ...(row.instanceKey !== undefined
        ? { instanceKey: row.instanceKey }
        : {}),
    };
  }).sort((left, right) =>
    left.displayOrder - right.displayOrder ||
    left.slotKey.localeCompare(right.slotKey)
  );
  if (slots.some((slot, index) => slot.displayOrder !== index)) {
    invalid("INVALID_CLEANING_TEMPLATE_SLOTS");
  }
  if (
    slots.filter((slot) => slot.required).length !== slots.length - 1 ||
    slots.filter((slot) => slot.slotKey === "tv-on" && slot.required).length !==
      1
  ) {
    invalid("INVALID_CLEANING_TEMPLATE_SLOTS");
  }
  return slots;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

async function requestHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(canonicalize(value))),
  );
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function publishedProjection(value: unknown, roomTypeCode: RoomTypeCode) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw templateDatabaseError(null);
  }
  const row = value as Record<string, unknown>;
  if (
    !hasExactKeys(row, publishedKeys) || typeof row.id !== "string" ||
    !uuidPattern.test(row.id) ||
    !Number.isSafeInteger(row.version) || (row.version as number) < 7 ||
    (row.version as number) > 2_147_483_647 ||
    row.status !== "published" ||
    !Number.isSafeInteger(row.durationMinutes) ||
    (row.durationMinutes as number) < 1 ||
    (row.durationMinutes as number) > 10_080 ||
    !isStrictRfc3339(row.publishedAt) ||
    !isStrictRfc3339(row.createdAt)
  ) {
    throw templateDatabaseError(null);
  }
  let slots: ReturnType<typeof normalizeSlots>;
  try {
    slots = normalizeSlots(row.slots, roomTypeCode);
  } catch {
    throw templateDatabaseError(null);
  }
  const rawSlots = row.slots as Array<Record<string, unknown>>;
  if (
    rawSlots.some((slot, index) =>
      slot.displayOrder !== index ||
      ["label", "description", "section"].some((key) =>
        slot[key] !== undefined && (slot[key] as string).trim() !== slot[key]
      )
    )
  ) {
    throw templateDatabaseError(null);
  }
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    durationMinutes: row.durationMinutes,
    slots,
    publishedAt: row.publishedAt,
    createdAt: row.createdAt,
  };
}

function catalogProjection(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw templateDatabaseError(null);
  }
  const row = value as Record<string, unknown>;
  if (
    !hasExactKeys(row, ["cleaningKind", "roomTypes"]) ||
    row.cleaningKind !== "checkout" ||
    !Array.isArray(row.roomTypes) || row.roomTypes.length !== 4
  ) {
    throw templateDatabaseError(null);
  }
  return {
    cleaningKind: row.cleaningKind,
    roomTypes: row.roomTypes.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw templateDatabaseError(null);
      }
      const room = item as Record<string, unknown>;
      const roomTypeCode = roomTypeCodes[index];
      if (
        !roomTypeCode || !hasExactKeys(room, [
          "roomTypeCode",
          "roomTypeName",
          "cleaningKind",
          "configured",
          "expectedVersion",
          "currentPublished",
        ]) || room.roomTypeCode !== roomTypeCode ||
        typeof room.roomTypeName !== "string" ||
        room.roomTypeName.length < 1 || room.cleaningKind !== "checkout" ||
        typeof room.configured !== "boolean" ||
        !Number.isSafeInteger(room.expectedVersion) ||
        (room.expectedVersion as number) < 0 ||
        (room.expectedVersion as number) > 2_147_483_647
      ) throw templateDatabaseError(null);
      const currentPublished = room.currentPublished === null
        ? null
        : publishedProjection(room.currentPublished, roomTypeCode);
      if (
        room.configured !== (currentPublished !== null) ||
        room.expectedVersion !== (currentPublished?.version ?? 0)
      ) throw templateDatabaseError(null);
      return {
        roomTypeCode,
        roomTypeName: room.roomTypeName,
        cleaningKind: room.cleaningKind,
        configured: room.configured,
        expectedVersion: room.expectedVersion,
        currentPublished,
      };
    }),
  };
}

export async function cleaningTemplates(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
) {
  adminOnly(actor);
  const url = new URL(request.url);
  if (request.method === "GET") {
    const entries = [...url.searchParams.entries()];
    if (
      entries.length !== 1 || entries[0]?.[0] !== "cleaningKind" ||
      entries[0]?.[1] !== "checkout"
    ) {
      invalid();
    }
    const { data, error } = await clients.admin.rpc(
      "list_checkout_cleaning_templates",
      {
        p_actor_profile_id: actor.profileId,
        p_session_id: verifiedRequestSessionId(request),
      },
    );
    if (error || !data) throw templateDatabaseError(error);
    return catalogProjection(data);
  }
  if (url.search) invalid();
  const body = await readJsonBody(request);
  const expectedKeys = [
    "roomTypeCode",
    "cleaningKind",
    "expectedVersion",
    "durationMinutes",
    "slots",
  ];
  if (
    Object.keys(body).some((key) => !expectedKeys.includes(key)) ||
    expectedKeys.some((key) => !Object.hasOwn(body, key)) ||
    typeof body.roomTypeCode !== "string" ||
    !roomTypeCodes.includes(body.roomTypeCode as RoomTypeCode) ||
    body.cleaningKind !== "checkout" ||
    !Number.isSafeInteger(body.expectedVersion) ||
    (body.expectedVersion as number) < 0 ||
    (body.expectedVersion as number) > 2_147_483_647 ||
    !Number.isSafeInteger(body.durationMinutes) ||
    (body.durationMinutes as number) < 1 ||
    (body.durationMinutes as number) > 10_080
  ) {
    invalid();
  }
  const roomTypeCode = body.roomTypeCode as RoomTypeCode;
  const slots = normalizeSlots(body.slots, roomTypeCode);
  const fingerprint = {
    command: "cleaning_template.publish_checkout",
    roomTypeCode,
    cleaningKind: "checkout",
    expectedVersion: body.expectedVersion,
    durationMinutes: body.durationMinutes,
    slots,
  };
  const { data, error } = await clients.admin.rpc(
    "publish_checkout_cleaning_template",
    {
      p_actor_profile_id: actor.profileId,
      p_session_id: verifiedRequestSessionId(request),
      p_room_type_code: roomTypeCode,
      p_expected_version: body.expectedVersion,
      p_duration_minutes: body.durationMinutes,
      p_slots: slots,
      p_idempotency_key: idempotencyKey(request),
      p_request_hash: await requestHash(fingerprint),
    },
  );
  if (error || !data) throw templateDatabaseError(error);
  return publishedProjection(data, roomTypeCode);
}

export function templateDatabaseError(
  error: { message?: string } | null,
): EdgeError {
  const code = error?.message;
  const statuses: Record<string, number> = {
    SESSION_REVOKED: 401,
    ADMIN_REQUIRED: 403,
    ACTIVE_ACCOUNT_REQUIRED: 403,
    PASSWORD_CHANGE_REQUIRED: 403,
    INVALID_CLEANING_TEMPLATE: 400,
    INVALID_CLEANING_TEMPLATE_SLOTS: 400,
    CLEANING_TEMPLATE_VERSION_CONFLICT: 409,
    IDEMPOTENCY_KEY_REUSED: 409,
    IDEMPOTENCY_KEY_CONFLICT: 409,
    IDEMPOTENCY_CONFLICT: 409,
  };
  return code && Object.hasOwn(statuses, code)
    ? new EdgeError(statuses[code], code, "청소 템플릿 설정을 확인해 주세요.")
    : new EdgeError(
      500,
      "CLEANING_TEMPLATE_COMMAND_FAILED",
      "청소 템플릿 요청을 완료하지 못했습니다.",
    );
}
