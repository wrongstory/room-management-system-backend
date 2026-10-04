import type { EdgeActor } from "./runtime.ts";
import { EdgeError } from "./runtime.ts";

export const CHECKOUT_INCIDENT_PAGE_DEFAULT = 50;
export const CHECKOUT_INCIDENT_PAGE_MAX = 100;
export const CHECKOUT_INCIDENT_CURSOR_MAX_LENGTH = 1024;
export const CHECKOUT_INCIDENT_RESPONSE_MAX_BYTES = 128 * 1024;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const decisions = [
  "EXTEND_CHECKOUT",
  "CONFIRM_DEPARTED",
  "FALSE_REPORT",
] as const;
export type CheckoutIncidentListFilters = {
  roomId: string | null;
  cleaningTargetId: string | null;
  serviceDate: string | null;
};
export type CheckoutIncidentListQuery = CheckoutIncidentListFilters & {
  limit: number;
  cursor: string | null;
};
export type CheckoutIncidentCursorScope = CheckoutIncidentListFilters & {
  actorProfileId: string;
  actorRole: "admin";
  stream: "checkout_presence_open";
  status: "open";
  sort: "reported_at_desc_id_desc";
};
export type CheckoutIncidentCursorPosition = { reportedAt: string; id: string };
export type CheckoutIncidentListItem = {
  incidentId: string;
  status: "open";
  roomId: string;
  roomNumber: string;
  cleaningTargetId: string;
  assignmentId: string;
  attemptId: string;
  reportedAt: string;
  serviceDate: string;
  allowedDecisions: typeof decisions;
};

function invalid(): never {
  throw new EdgeError(
    400,
    "VALIDATION_ERROR",
    "퇴실 미진행 목록의 조회 조건을 확인해 주세요.",
  );
}
export function checkoutIncidentListFailure(): EdgeError {
  return new EdgeError(
    500,
    "CHECKOUT_INCIDENT_COMMAND_FAILED",
    "퇴실 미진행 사건을 처리하지 못했습니다.",
  );
}
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
function exact(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}
function normalizedUuid(value: unknown): string | null {
  return typeof value === "string" && uuidPattern.test(value)
    ? value.toLowerCase()
    : null;
}
export function isCheckoutIncidentDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 &&
    day <= (days[month - 1] ?? 0);
}
// Preserve the exact PostgreSQL microsecond key. Never round it through Date.
export function isCheckoutIncidentTimestamp(value: unknown): value is string {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value) &&
    isCheckoutIncidentDate(value.slice(0, 10)) &&
    Number(value.slice(11, 13)) <= 23 && Number(value.slice(14, 16)) <= 59 &&
    Number(value.slice(17, 19)) <= 59;
}
export function checkoutIncidentListQuery(
  params: URLSearchParams,
): CheckoutIncidentListQuery {
  const allowed = [
    "roomId",
    "cleaningTargetId",
    "serviceDate",
    "limit",
    "cursor",
  ];
  for (const [name, value] of params) {
    if (!allowed.includes(name) || params.getAll(name).length !== 1 || !value) {
      invalid();
    }
  }
  const optionalUuid = (name: string): string | null => {
    const value = params.get(name);
    return value === null ? null : normalizedUuid(value) ?? invalid();
  };
  const serviceDate = params.get("serviceDate");
  if (serviceDate !== null && !isCheckoutIncidentDate(serviceDate)) invalid();
  const rawLimit = params.get("limit");
  if (rawLimit !== null && !/^[1-9]\d{0,2}$/.test(rawLimit)) invalid();
  const limit = rawLimit === null
    ? CHECKOUT_INCIDENT_PAGE_DEFAULT
    : Number(rawLimit);
  if (limit > CHECKOUT_INCIDENT_PAGE_MAX) invalid();
  const cursor = params.get("cursor");
  if (cursor !== null && cursor.length > CHECKOUT_INCIDENT_CURSOR_MAX_LENGTH) {
    invalid();
  }
  return {
    roomId: optionalUuid("roomId"),
    cleaningTargetId: optionalUuid("cleaningTargetId"),
    serviceDate,
    limit,
    cursor,
  };
}
export function checkoutIncidentCursorScope(
  actor: EdgeActor,
  filters: CheckoutIncidentListFilters,
): CheckoutIncidentCursorScope {
  const actorProfileId = normalizedUuid(actor.profileId);
  if (actor.role !== "admin" || !actorProfileId) invalid();
  return {
    actorProfileId,
    actorRole: "admin",
    stream: "checkout_presence_open",
    status: "open",
    sort: "reported_at_desc_id_desc",
    roomId: filters.roomId,
    cleaningTargetId: filters.cleaningTargetId,
    serviceDate: filters.serviceDate,
  };
}
function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/g,
    "",
  );
}
function decodeBase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) invalid();
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  let binary: string;
  try {
    binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  } catch {
    invalid();
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (base64url(bytes) !== value) invalid();
  return bytes;
}
function jsonStringValues(name: string): string[] {
  const raw = Deno.env.get(name)?.trim();
  if (!raw) return [];
  try {
    const values: string[] = [];
    const collect = (candidate: unknown): void => {
      if (typeof candidate === "string") {
        const trimmed = candidate.trim();
        if (trimmed) values.push(trimmed);
      } else if (Array.isArray(candidate)) candidate.forEach(collect);
      else if (candidate && typeof candidate === "object") {
        Object.values(candidate).forEach(collect);
      }
    };
    collect(JSON.parse(raw));
    return values;
  } catch {
    return [];
  }
}
export function assertCheckoutIncidentCursorConfigured(): void {
  cursorSecret();
}
function cursorSecret(): Uint8Array {
  const value = Deno.env.get("INSPECTION_CURSOR_HMAC_SECRET")?.trim() ?? "";
  const bytes = new TextEncoder().encode(value);
  const reused = [
    "SUPABASE_ANON_KEY",
    "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_SECRET_KEY",
    "ACCOUNT_PHONE_PEPPER",
    "RESERVATION_PII_KEY_BASE64",
    "RESERVATION_GUEST_NAME_PEPPER",
    "PAYROLL_CURSOR_HMAC_SECRET",
    "NOTIFICATION_CURSOR_HMAC_SECRET",
    "ROOM_PIN_KEY_BASE64",
    "WEB_PUSH_SUBSCRIPTION_KEY_BASE64",
    "WEB_PUSH_BINDING_DIGEST_SECRET",
    "VAPID_PRIVATE_KEY",
    "NOTIFICATION_DELIVERY_INVOKE_SECRET",
    "SCHEDULER_INVOKE_SECRET",
    "GOOGLE_DRIVE_CLIENT_ID",
    "GOOGLE_DRIVE_CLIENT_SECRET",
    "GOOGLE_DRIVE_REFRESH_TOKEN",
    "GOOGLE_DRIVE_ROOT_FOLDER_ID",
    "PHOTO_PURGE_INVOKE_SECRET",
    "ROOM_PIN_SHEET_SYNC_INVOKE_SECRET",
    "GOOGLE_SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY",
  ].some((name) => {
    const existing = Deno.env.get(name)?.trim();
    return existing !== undefined && existing !== "" && existing === value;
  });
  const reusedKeyring = [
    "RESERVATION_PII_KEYRING_JSON",
    "ROOM_PIN_KEYRING_JSON",
    "WEB_PUSH_SUBSCRIPTION_KEYRING_JSON",
    "VAPID_KEYRING_JSON",
  ].some((name) => jsonStringValues(name).includes(value));
  if (bytes.byteLength < 32 || reused || reusedKeyring) {
    throw checkoutIncidentListFailure();
  }
  return bytes;
}
async function key(): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    cursorSecret(),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
export async function encodeCheckoutIncidentCursor(
  scope: CheckoutIncidentCursorScope,
  after: CheckoutIncidentCursorPosition,
): Promise<string> {
  if (
    !isCheckoutIncidentTimestamp(after.reportedAt) ||
    typeof after.id !== "string" || normalizedUuid(after.id) !== after.id
  ) {
    throw checkoutIncidentListFailure();
  }
  const payload = base64url(
    new TextEncoder().encode(JSON.stringify({ v: 1, scope, after })),
  );
  const signature = base64url(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        await key(),
        new TextEncoder().encode(payload),
      ),
    ),
  );
  const cursor = `${payload}.${signature}`;
  if (cursor.length > CHECKOUT_INCIDENT_CURSOR_MAX_LENGTH) {
    throw checkoutIncidentListFailure();
  }
  return cursor;
}
export async function decodeCheckoutIncidentCursor(
  cursor: string,
  expectedScope: CheckoutIncidentCursorScope,
): Promise<CheckoutIncidentCursorPosition> {
  if (!cursor || cursor.length > CHECKOUT_INCIDENT_CURSOR_MAX_LENGTH) invalid();
  const parts = cursor.split(".");
  if (parts.length !== 2) invalid();
  const encoded = parts[0] ?? "";
  const signature = decodeBase64url(parts[1] ?? "");
  if (
    signature.byteLength !== 32 || !await crypto.subtle.verify(
      "HMAC",
      await key(),
      signature,
      new TextEncoder().encode(encoded),
    )
  ) invalid();
  let payload: Record<string, unknown> | null;
  try {
    payload = object(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          decodeBase64url(encoded),
        ),
      ),
    );
  } catch (error) {
    if (error instanceof EdgeError) throw error;
    invalid();
  }
  if (!payload || !exact(payload, ["v", "scope", "after"]) || payload.v !== 1) {
    invalid();
  }
  const scope = object(payload.scope);
  if (
    !scope || !exact(scope, Object.keys(expectedScope)) ||
    Object.entries(expectedScope).some(([name, value]) => scope[name] !== value)
  ) invalid();
  const after = object(payload.after);
  if (
    !after || !exact(after, ["reportedAt", "id"]) ||
    !isCheckoutIncidentTimestamp(after.reportedAt) ||
    typeof after.id !== "string" || normalizedUuid(after.id) !== after.id
  ) invalid();
  return { reportedAt: after.reportedAt, id: after.id as string };
}
export function assertCheckoutIncidentResponseSize(body: unknown): void {
  if (
    new TextEncoder().encode(JSON.stringify(body)).byteLength >
      CHECKOUT_INCIDENT_RESPONSE_MAX_BYTES
  ) {
    throw checkoutIncidentListFailure();
  }
}
export function projectCheckoutIncidentListItems(
  data: unknown,
  query: CheckoutIncidentListQuery,
  after: CheckoutIncidentCursorPosition | null,
): CheckoutIncidentListItem[] {
  const pack = object(data);
  if (
    !pack || !exact(pack, ["items"]) || !Array.isArray(pack.items) ||
    pack.items.length > query.limit + 1
  ) throw checkoutIncidentListFailure();
  assertCheckoutIncidentResponseSize(data);
  const seen = new Set<string>();
  let previous = after;
  return pack.items.map((value) => {
    const row = object(value);
    const keys = [
      "incidentId",
      "status",
      "roomId",
      "roomNumber",
      "cleaningTargetId",
      "assignmentId",
      "attemptId",
      "reportedAt",
      "serviceDate",
      "allowedDecisions",
    ];
    if (
      !row || !exact(row, keys) || row.status !== "open" ||
      ["incidentId", "roomId", "cleaningTargetId", "assignmentId", "attemptId"]
        .some((name) => !normalizedUuid(row[name])) ||
      typeof row.roomNumber !== "string" || !row.roomNumber.trim() ||
      !isCheckoutIncidentTimestamp(row.reportedAt) ||
      !isCheckoutIncidentDate(row.serviceDate) ||
      !Array.isArray(row.allowedDecisions) ||
      row.allowedDecisions.length !== decisions.length ||
      decisions.some((decision, index) =>
        (row.allowedDecisions as unknown[])[index] !== decision
      )
    ) throw checkoutIncidentListFailure();
    const incidentId = normalizedUuid(row.incidentId) as string;
    const roomId = normalizedUuid(row.roomId) as string;
    const cleaningTargetId = normalizedUuid(row.cleaningTargetId) as string;
    if (
      seen.has(incidentId) ||
      (query.roomId !== null && query.roomId !== roomId) ||
      (query.cleaningTargetId !== null &&
        query.cleaningTargetId !== cleaningTargetId) ||
      (query.serviceDate !== null && query.serviceDate !== row.serviceDate) ||
      (previous !== null && (row.reportedAt > previous.reportedAt ||
        (row.reportedAt === previous.reportedAt && incidentId >= previous.id)))
    ) throw checkoutIncidentListFailure();
    seen.add(incidentId);
    previous = { reportedAt: row.reportedAt, id: incidentId };
    return {
      incidentId,
      status: "open",
      roomId,
      roomNumber: row.roomNumber,
      cleaningTargetId,
      assignmentId: normalizedUuid(row.assignmentId) as string,
      attemptId: normalizedUuid(row.attemptId) as string,
      reportedAt: row.reportedAt,
      serviceDate: row.serviceDate,
      allowedDecisions: decisions,
    };
  });
}
