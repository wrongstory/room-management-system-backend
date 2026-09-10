import type { EdgeActor } from "./runtime.ts";
import { EdgeError } from "./runtime.ts";
export const COMPLAINT_PAGE_DEFAULT = 50,
  COMPLAINT_PAGE_MAX = 100,
  COMPLAINT_CURSOR_MAX_LENGTH = 1024,
  COMPLAINT_RESPONSE_MAX_BYTES = 128 * 1024;
type Scope = {
  actorProfileId: string;
  actorRole: "admin" | "maid";
  kind: "list" | "history";
  from: string | null;
  to: string | null;
  complaintId: string | null;
  sort: "receivedAt:desc,complaintId:desc" | "eventId:desc";
};
export type ComplaintCursorPosition = {
  receivedAt: string;
  complaintId: string;
} | { eventId: number };
function invalid(): never {
  throw new EdgeError(
    400,
    "COMPLAINT_CURSOR_INVALID",
    "컴플레인 cursor가 올바르지 않습니다.",
  );
}
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) invalid();
  return v as Record<string, unknown>;
}
function exact(v: Record<string, unknown>, keys: readonly string[]) {
  const a = Object.keys(v).sort();
  return a.length === keys.length &&
    [...keys].sort().every((k, i) => a[i] === k);
}
function b64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/g,
    "",
  );
}
function unb64(v: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(v)) invalid();
  const n = v.replace(/-/g, "+").replace(/_/g, "/");
  let binary: string;
  try {
    binary = atob(n + "=".repeat((4 - n.length % 4) % 4));
  } catch {
    invalid();
  }
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  if (b64(bytes) !== v) invalid();
  return bytes;
}
function secret() {
  const v = Deno.env.get("PAYROLL_CURSOR_HMAC_SECRET")?.trim() ?? "";
  const bytes = new TextEncoder().encode(v);
  if (bytes.byteLength < 32) {
    throw new EdgeError(
      503,
      "COMPLAINT_CURSOR_NOT_CONFIGURED",
      "컴플레인 cursor 서명 설정이 필요합니다.",
    );
  }
  return bytes;
}
async function key() {
  return await crypto.subtle.importKey(
    "raw",
    secret(),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
export function complaintCursorScope(
  actor: EdgeActor,
  input: { kind: "list"; from: string; to: string } | {
    kind: "history";
    complaintId: string;
  },
): Scope {
  if (actor.role !== "admin" && actor.role !== "maid") invalid();
  return {
    actorProfileId: actor.profileId.toLowerCase(),
    actorRole: actor.role,
    kind: input.kind,
    from: input.kind === "list" ? input.from : null,
    to: input.kind === "list" ? input.to : null,
    complaintId: input.kind === "history"
      ? input.complaintId.toLowerCase()
      : null,
    sort: input.kind === "list"
      ? "receivedAt:desc,complaintId:desc"
      : "eventId:desc",
  };
}
export async function encodeComplaintCursor(
  scope: Scope,
  after: ComplaintCursorPosition,
) {
  const payload = b64(
    new TextEncoder().encode(JSON.stringify({ v: 1, scope, after })),
  );
  const signature = b64(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        await key(),
        new TextEncoder().encode(payload),
      ),
    ),
  );
  const cursor = `${payload}.${signature}`;
  if (cursor.length > COMPLAINT_CURSOR_MAX_LENGTH) invalid();
  return cursor;
}
export async function decodeComplaintCursor(
  cursor: string,
  scope: Scope,
): Promise<ComplaintCursorPosition> {
  if (!cursor || cursor.length > COMPLAINT_CURSOR_MAX_LENGTH) invalid();
  const parts = cursor.split(".");
  if (parts.length !== 2) invalid();
  const encoded = parts[0] ?? "", signature = unb64(parts[1] ?? "");
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
        new TextDecoder("utf-8", { fatal: true }).decode(unb64(encoded)),
      ),
    );
  } catch (e) {
    if (e instanceof EdgeError) throw e;
    invalid();
  }
  if (
    !exact(payload, ["after", "scope", "v"]) || payload.v !== 1 ||
    JSON.stringify(payload.scope) !== JSON.stringify(scope)
  ) invalid();
  const after = object(payload.after);
  if (scope.kind === "list") {
    if (
      !exact(after, ["complaintId", "receivedAt"]) ||
      typeof after.complaintId !== "string" ||
      typeof after.receivedAt !== "string"
    ) invalid();
    return { complaintId: after.complaintId, receivedAt: after.receivedAt };
  }
  if (
    !exact(after, ["eventId"]) || typeof after.eventId !== "number" ||
    !Number.isSafeInteger(after.eventId) || after.eventId < 1
  ) invalid();
  return { eventId: after.eventId };
}
export function assertComplaintResponseSize(body: unknown) {
  if (
    new TextEncoder().encode(JSON.stringify(body)).byteLength >
      COMPLAINT_RESPONSE_MAX_BYTES
  ) {
    throw new EdgeError(
      500,
      "COMPLAINT_RESPONSE_TOO_LARGE",
      "컴플레인 응답 크기 상한을 초과했습니다.",
    );
  }
}
