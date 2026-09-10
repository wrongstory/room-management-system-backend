import type { EdgeActor } from "./runtime.ts";
import { EdgeError } from "./runtime.ts";

export const PAYROLL_CYCLE_PAGE_DEFAULT = 10;
export const PAYROLL_CYCLE_PAGE_MAX = 10;
export const PAYROLL_ENTRY_PAGE_DEFAULT = 25;
export const PAYROLL_ENTRY_PAGE_MAX = 50;
export const PAYROLL_NESTED_PREVIEW_MAX = 10;
export const PAYROLL_RESPONSE_MAX_BYTES = 128 * 1024;
export const PAYROLL_CURSOR_MAX_LENGTH = 1024;

export type PayrollCursorKind =
  | "cycles"
  | "items"
  | "lateEarnings"
  | "adjustments";
interface CursorScope {
  actorProfileId: string;
  actorRole: "admin" | "maid";
  weekStart: string;
  maidProfileId: string | null;
  kind: PayrollCursorKind;
  sort: "maidProfileId:asc" | "earnedOn:asc,earningId:asc";
}
export type CursorPosition =
  | { maidProfileId: string }
  | { earnedOn: string; earningId: string };

function invalidCursor(): never {
  throw new EdgeError(
    400,
    "PAYROLL_CURSOR_INVALID",
    "주급 cursor가 올바르지 않습니다.",
  );
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalidCursor();
  }
  return value as Record<string, unknown>;
}
function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length &&
    keys.slice().sort().every((key, index) => actual[index] === key);
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
  if (!/^[A-Za-z0-9_-]+$/.test(value)) invalidCursor();
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    invalidCursor();
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (base64url(bytes) !== value) invalidCursor();
  return bytes;
}
function secret(): Uint8Array {
  const value = Deno.env.get("PAYROLL_CURSOR_HMAC_SECRET")?.trim() ?? "";
  const bytes = new TextEncoder().encode(value);
  const reused = [
    "SUPABASE_ANON_KEY",
    "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_SECRET_KEY",
    "ACCOUNT_PHONE_PEPPER",
    "RESERVATION_PII_KEY_BASE64",
    "RESERVATION_GUEST_NAME_PEPPER",
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
      "PAYROLL_CURSOR_NOT_CONFIGURED",
      "주급 cursor 서명 설정이 필요합니다.",
    );
  }
  return bytes;
}

export function assertPayrollCursorConfigured(): void {
  secret();
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
export function payrollCursorScope(
  actor: EdgeActor,
  weekStart: string,
  requestedMaidProfileId: string | null,
  kind: PayrollCursorKind,
): CursorScope {
  if (actor.role !== "admin" && actor.role !== "maid") invalidCursor();
  return {
    actorProfileId: actor.profileId.toLowerCase(),
    actorRole: actor.role,
    weekStart,
    maidProfileId: actor.role === "maid"
      ? actor.profileId.toLowerCase()
      : requestedMaidProfileId?.toLowerCase() ?? null,
    kind,
    sort: kind === "cycles"
      ? "maidProfileId:asc"
      : "earnedOn:asc,earningId:asc",
  };
}
export async function encodePayrollCursor(
  scope: CursorScope,
  after: CursorPosition,
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
  if (cursor.length > PAYROLL_CURSOR_MAX_LENGTH) invalidCursor();
  return cursor;
}
export async function decodePayrollCursor(
  cursor: string,
  expectedScope: CursorScope,
): Promise<CursorPosition> {
  if (!cursor || cursor.length > PAYROLL_CURSOR_MAX_LENGTH) invalidCursor();
  const parts = cursor.split(".");
  if (parts.length !== 2) invalidCursor();
  const payloadEncoded = parts[0] ?? "";
  const signature = decodeBase64url(parts[1] ?? "");
  if (
    signature.byteLength !== 32 ||
    !await crypto.subtle.verify(
      "HMAC",
      await key(),
      signature,
      new TextEncoder().encode(payloadEncoded),
    )
  ) invalidCursor();
  let payload: Record<string, unknown>;
  try {
    payload = object(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          decodeBase64url(payloadEncoded),
        ),
      ),
    );
  } catch (error) {
    if (error instanceof EdgeError) throw error;
    invalidCursor();
  }
  if (!exactKeys(payload, ["after", "scope", "v"]) || payload.v !== 1) {
    invalidCursor();
  }
  const scope = object(payload.scope);
  if (
    !exactKeys(scope, [
      "actorProfileId",
      "actorRole",
      "kind",
      "maidProfileId",
      "sort",
      "weekStart",
    ]) || JSON.stringify(scope) !== JSON.stringify(expectedScope)
  ) invalidCursor();
  const after = object(payload.after);
  if (expectedScope.kind === "cycles") {
    if (
      !exactKeys(after, ["maidProfileId"]) ||
      typeof after.maidProfileId !== "string"
    ) invalidCursor();
    return { maidProfileId: after.maidProfileId };
  }
  if (
    !exactKeys(after, ["earnedOn", "earningId"]) ||
    typeof after.earnedOn !== "string" || typeof after.earningId !== "string"
  ) invalidCursor();
  return { earnedOn: after.earnedOn, earningId: after.earningId };
}
export function assertPayrollResponseSize(body: unknown): void {
  if (
    new TextEncoder().encode(JSON.stringify(body)).byteLength >
      PAYROLL_RESPONSE_MAX_BYTES
  ) {
    throw new EdgeError(
      500,
      "PAYROLL_RESPONSE_TOO_LARGE",
      "주급 응답 크기 상한을 초과했습니다.",
    );
  }
}
