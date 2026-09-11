import type { EdgeActor } from "./runtime.ts";
import { EdgeError } from "./runtime.ts";

export const NOTIFICATION_PAGE_DEFAULT = 50;
export const NOTIFICATION_PAGE_MAX = 100;
export const NOTIFICATION_CURSOR_MAX_LENGTH = 1024;
export const NOTIFICATION_RESPONSE_MAX_BYTES = 128 * 1024;

type Scope = {
  actorProfileId: string;
  actorRole: "admin" | "maid";
  stream: "own-notifications";
  sort: "occurredAt:desc,id:desc";
};
export type NotificationCursorPosition = { occurredAt: string; id: string };

function invalid(): never {
  throw new EdgeError(
    400,
    "INVALID_NOTIFICATION_CURSOR",
    "알림 cursor가 올바르지 않습니다.",
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
  const value = Deno.env.get("NOTIFICATION_CURSOR_HMAC_SECRET")?.trim() ?? "";
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
    "SCHEDULER_INVOKE_SECRET",
    "GOOGLE_DRIVE_CLIENT_ID",
    "GOOGLE_DRIVE_CLIENT_SECRET",
    "GOOGLE_DRIVE_REFRESH_TOKEN",
    "GOOGLE_DRIVE_ROOT_FOLDER_ID",
    "PHOTO_PURGE_INVOKE_SECRET",
  ].some((name) => {
    const existing = Deno.env.get(name)?.trim();
    return existing !== undefined && existing !== "" && existing === value;
  });
  let reusedKeyringSecret = false;
  try {
    const keyring = JSON.parse(
      Deno.env.get("RESERVATION_PII_KEYRING_JSON")?.trim() || "{}",
    ) as unknown;
    reusedKeyringSecret = Boolean(
      keyring && !Array.isArray(keyring) && typeof keyring === "object" &&
        Object.values(keyring).some((item) => item === value),
    );
  } catch {
    // Reservation startup validation owns malformed keyring reporting.
  }
  if (bytes.byteLength < 32 || reused || reusedKeyringSecret) {
    throw new EdgeError(
      503,
      "NOTIFICATION_CURSOR_NOT_CONFIGURED",
      "알림 cursor 서명 설정이 필요합니다.",
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
export function notificationCursorScope(actor: EdgeActor): Scope {
  if (actor.role !== "admin" && actor.role !== "maid") invalid();
  return {
    actorProfileId: actor.profileId.toLowerCase(),
    actorRole: actor.role,
    stream: "own-notifications",
    sort: "occurredAt:desc,id:desc",
  };
}
export async function encodeNotificationCursor(
  scope: Scope,
  after: NotificationCursorPosition,
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
  if (cursor.length > NOTIFICATION_CURSOR_MAX_LENGTH) invalid();
  return cursor;
}
export async function decodeNotificationCursor(
  cursor: string,
  expectedScope: Scope,
): Promise<NotificationCursorPosition> {
  if (!cursor || cursor.length > NOTIFICATION_CURSOR_MAX_LENGTH) invalid();
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
    !exact(scope, ["actorProfileId", "actorRole", "sort", "stream"]) ||
    JSON.stringify(scope) !== JSON.stringify(expectedScope)
  ) invalid();
  const after = object(payload.after);
  if (
    !exact(after, ["id", "occurredAt"]) ||
    typeof after.id !== "string" || typeof after.occurredAt !== "string"
  ) invalid();
  return { id: after.id, occurredAt: after.occurredAt };
}
export function assertNotificationResponseSize(body: unknown): void {
  if (
    new TextEncoder().encode(JSON.stringify(body)).byteLength >
      NOTIFICATION_RESPONSE_MAX_BYTES
  ) {
    throw new EdgeError(
      500,
      "NOTIFICATION_RESPONSE_TOO_LARGE",
      "알림 응답 크기 상한을 초과했습니다.",
    );
  }
}
