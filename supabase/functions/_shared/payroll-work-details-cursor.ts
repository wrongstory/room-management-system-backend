import { assertPayrollCursorConfigured } from "./payroll-cursor.ts";
import { EdgeError } from "./runtime.ts";
import {
  isPayrollWorkDate,
  isPayrollWorkUuid,
  PAYROLL_WORK_CURSOR_MAX,
  type PayrollWorkInput,
  type PayrollWorkPosition,
} from "./payroll-work-details-core.ts";

interface Scope {
  actorProfileId: string;
  actorRole: "admin" | "maid";
  sessionBinding: string;
  weekStart: string;
  maidProfileId: string;
  kind: "earnings" | "workflow";
  sort: "entryDate:asc,entryId:asc";
}
const domain = "payroll-work-details:v1:";
function invalid(): never {
  throw new EdgeError(
    400,
    "PAYROLL_CURSOR_INVALID",
    "주급 상세 cursor를 다시 조회해 주세요.",
  );
}
function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll(
    "/",
    "_",
  ).replaceAll("=", "");
}
function bytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) invalid();
  try {
    const result = Uint8Array.from(
      atob(
        value.replaceAll("-", "+").replaceAll("_", "/") +
          "=".repeat((4 - value.length % 4) % 4),
      ),
      (c) => c.charCodeAt(0),
    );
    if (base64(result) !== value) invalid();
    return result;
  } catch {
    invalid();
  }
}
async function key(): Promise<CryptoKey> {
  assertPayrollCursorConfigured();
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(
      Deno.env.get("PAYROLL_CURSOR_HMAC_SECRET")?.trim() ?? "",
    ),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
async function sign(value: string): Promise<string> {
  return base64(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        await key(),
        new TextEncoder().encode(value),
      ),
    ),
  );
}
export async function payrollWorkScope(
  profileId: string,
  role: "admin" | "maid",
  sessionId: string,
  input: PayrollWorkInput,
): Promise<Scope> {
  return {
    actorProfileId: profileId.toLowerCase(),
    actorRole: role,
    sessionBinding: await sign(`${domain}session:${sessionId.toLowerCase()}`),
    weekStart: input.weekStart,
    maidProfileId: input.maidProfileId,
    kind: input.kind,
    sort: "entryDate:asc,entryId:asc",
  };
}
export async function encodePayrollWorkCursor(
  scope: Scope,
  after: PayrollWorkPosition,
): Promise<string> {
  const payload = base64(
    new TextEncoder().encode(
      JSON.stringify({ family: "payroll-work-details", v: 1, scope, after }),
    ),
  );
  const cursor = `${payload}.${await sign(`${domain}${payload}`)}`;
  if (cursor.length > PAYROLL_WORK_CURSOR_MAX) invalid();
  return cursor;
}
export async function decodePayrollWorkCursor(
  cursor: string,
  scope: Scope,
): Promise<PayrollWorkPosition> {
  if (!cursor || cursor.length > PAYROLL_WORK_CURSOR_MAX) invalid();
  const parts = cursor.split(".");
  if (parts.length !== 2) invalid();
  const payload = parts[0] ?? "";
  const signature = bytes(parts[1] ?? "");
  const data = bytes(payload);
  if (
    signature.length !== 32 ||
    !await crypto.subtle.verify(
      "HMAC",
      await key(),
      signature,
      new TextEncoder().encode(`${domain}${payload}`),
    )
  ) invalid();
  try {
    const parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(data),
    ) as Record<string, unknown>;
    if (
      !parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(",") !== "after,family,scope,v" ||
      parsed.family !== "payroll-work-details" || parsed.v !== 1 ||
      JSON.stringify(parsed.scope) !== JSON.stringify(scope)
    ) invalid();
    const after = parsed.after as Record<string, unknown>;
    if (
      !after || typeof after !== "object" || Array.isArray(after) ||
      Object.keys(after).sort().join(",") !== "entryDate,entryId" ||
      !isPayrollWorkDate(after.entryDate) || !isPayrollWorkUuid(after.entryId)
    ) invalid();
    return { entryDate: after.entryDate, entryId: after.entryId };
  } catch {
    invalid();
  }
}
