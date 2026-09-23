import type { EdgeActor } from "./runtime.ts";
import { EdgeError } from "./runtime.ts";

export const ROOM_OPERATION_PAGE_DEFAULT = 50;
export const ROOM_OPERATION_PAGE_MAX = 100;
export const ROOM_OPERATION_CURSOR_MAX_LENGTH = 1024;
export const ROOM_OPERATION_RESPONSE_MAX_BYTES = 128 * 1024;

type Stream = "operation-blocks" | "issues";
type Scope = {
  actorProfileId: string;
  actorRole: "admin";
  roomId: string;
  stream: Stream;
  status: "actionable" | "open";
  sort: "occurredAt:desc,id:desc";
};
export type RoomOperationCursorPosition = { occurredAt: string; id: string };

function invalid(): never {
  throw new EdgeError(
    400,
    "INVALID_ROOM_OPERATION_CURSOR",
    "객실 운영 cursor가 올바르지 않습니다.",
  );
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function exact(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length &&
    [...keys].sort().every((key, index) => actual[index] === key);
}
function validUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);
}
function validTimestamp(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/
      .exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return month >= 1 && month <= 12 && day >= 1 && day <= maxDay &&
    Number(match[4]) <= 23 && Number(match[5]) <= 59 &&
    Number(match[6]) <= 59 &&
    (match[8] === undefined ||
      (Number(match[8]) <= 23 && Number(match[9]) <= 59));
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
function secret(): Uint8Array {
  const value = Deno.env.get("INSPECTION_CURSOR_HMAC_SECRET")?.trim() ?? "";
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength < 32) {
    throw new EdgeError(
      503,
      "ROOM_OPERATION_CURSOR_NOT_CONFIGURED",
      "객실 운영 cursor 서명 설정이 필요합니다.",
    );
  }
  return bytes;
}
async function key(): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    secret(),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
export function roomOperationCursorScope(
  actor: EdgeActor,
  roomId: string,
  stream: Stream,
): Scope {
  if (actor.role !== "admin") invalid();
  return {
    actorProfileId: actor.profileId.toLowerCase(),
    actorRole: "admin",
    roomId: roomId.toLowerCase(),
    stream,
    status: stream === "operation-blocks" ? "actionable" : "open",
    sort: "occurredAt:desc,id:desc",
  };
}
export async function encodeRoomOperationCursor(
  scope: Scope,
  after: RoomOperationCursorPosition,
): Promise<string> {
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
  if (cursor.length > ROOM_OPERATION_CURSOR_MAX_LENGTH) invalid();
  return cursor;
}
export async function decodeRoomOperationCursor(
  cursor: string,
  expectedScope: Scope,
): Promise<RoomOperationCursorPosition> {
  if (!cursor || cursor.length > ROOM_OPERATION_CURSOR_MAX_LENGTH) invalid();
  const parts = cursor.split(".");
  if (parts.length !== 2) invalid();
  const encoded = parts[0] ?? "";
  const signature = decodeBase64url(parts[1] ?? "");
  if (
    signature.byteLength !== 32 ||
    !await crypto.subtle.verify(
      "HMAC",
      await key(),
      signature,
      new TextEncoder().encode(encoded),
    )
  ) invalid();
  let payload: Record<string, unknown>;
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
  if (!exact(payload, ["after", "scope", "v"]) || payload.v !== 1) invalid();
  const scope = object(payload.scope);
  if (
    !exact(scope, [
      "actorProfileId",
      "actorRole",
      "roomId",
      "sort",
      "status",
      "stream",
    ]) ||
    JSON.stringify(scope) !== JSON.stringify(expectedScope)
  ) invalid();
  const after = object(payload.after);
  if (
    !exact(after, ["id", "occurredAt"]) ||
    typeof after.id !== "string" ||
    typeof after.occurredAt !== "string" ||
    !validUuid(after.id) ||
    !validTimestamp(after.occurredAt)
  ) invalid();
  return { id: after.id, occurredAt: after.occurredAt };
}
export function assertRoomOperationResponseSize(body: unknown): void {
  if (
    new TextEncoder().encode(JSON.stringify(body)).byteLength >
      ROOM_OPERATION_RESPONSE_MAX_BYTES
  ) {
    throw new EdgeError(
      500,
      "ROOM_OPERATION_RESPONSE_TOO_LARGE",
      "객실 운영 응답 크기 상한을 초과했습니다.",
    );
  }
}
