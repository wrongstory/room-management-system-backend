import { createHmac, timingSafeEqual } from "node:crypto";
import type { Actor } from "../../domain/actor.js";
import { AppError } from "../../lib/app-error.js";

export const COMPLAINT_PAGE_DEFAULT = 50;
export const COMPLAINT_PAGE_MAX = 100;
export const COMPLAINT_CURSOR_MAX_LENGTH = 1024;
export const COMPLAINT_RESPONSE_MAX_BYTES = 128 * 1024;

export type ComplaintCursorScope = {
  actorProfileId: string;
  actorRole: "admin" | "maid";
  kind: "list" | "history";
  from: string | null;
  to: string | null;
  complaintId: string | null;
  sort: "receivedAt:desc,complaintId:desc" | "eventId:desc";
};
export type ComplaintCursorPosition =
  { receivedAt: string; complaintId: string } | { eventId: number };
type Payload = {
  v: 1;
  scope: ComplaintCursorScope;
  after: ComplaintCursorPosition;
};

function invalid(): AppError {
  return new AppError(
    400,
    "COMPLAINT_CURSOR_INVALID",
    "컴플레인 cursor가 올바르지 않습니다.",
  );
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid();
  return value as Record<string, unknown>;
}
function exact(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length &&
    [...keys].sort().every((key, index) => actual[index] === key)
  );
}
export function complaintCursorScope(
  actor: Actor,
  input:
    | { kind: "list"; from: string; to: string }
    | { kind: "history"; complaintId: string },
): ComplaintCursorScope {
  if (actor.role !== "admin" && actor.role !== "maid") throw invalid();
  return {
    actorProfileId: actor.profileId.toLowerCase(),
    actorRole: actor.role,
    kind: input.kind,
    from: input.kind === "list" ? input.from : null,
    to: input.kind === "list" ? input.to : null,
    complaintId:
      input.kind === "history" ? input.complaintId.toLowerCase() : null,
    sort:
      input.kind === "list"
        ? "receivedAt:desc,complaintId:desc"
        : "eventId:desc",
  };
}

export class ComplaintCursorCodec {
  private readonly secret: Buffer;
  constructor(secret: string) {
    this.secret = Buffer.from(secret, "utf8");
    if (this.secret.byteLength < 32)
      throw new AppError(
        503,
        "COMPLAINT_CURSOR_NOT_CONFIGURED",
        "컴플레인 cursor 서명 설정이 필요합니다.",
      );
  }
  encode(scope: ComplaintCursorScope, after: ComplaintCursorPosition): string {
    const payload = Buffer.from(
      JSON.stringify({ v: 1, scope, after }),
      "utf8",
    ).toString("base64url");
    const signature = createHmac("sha256", this.secret)
      .update(payload, "ascii")
      .digest("base64url");
    const cursor = `${payload}.${signature}`;
    if (cursor.length > COMPLAINT_CURSOR_MAX_LENGTH) throw invalid();
    return cursor;
  }
  decode(
    cursor: string,
    expectedScope: ComplaintCursorScope,
  ): ComplaintCursorPosition {
    if (!cursor || cursor.length > COMPLAINT_CURSOR_MAX_LENGTH) throw invalid();
    const parts = cursor.split(".");
    if (
      parts.length !== 2 ||
      parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
    )
      throw invalid();
    const [encoded = "", signatureEncoded = ""] = parts;
    let bytes: Buffer;
    let signature: Buffer;
    try {
      bytes = Buffer.from(encoded, "base64url");
      signature = Buffer.from(signatureEncoded, "base64url");
    } catch {
      throw invalid();
    }
    if (
      bytes.toString("base64url") !== encoded ||
      signature.toString("base64url") !== signatureEncoded ||
      signature.byteLength !== 32
    )
      throw invalid();
    const expected = createHmac("sha256", this.secret)
      .update(encoded, "ascii")
      .digest();
    if (!timingSafeEqual(signature, expected)) throw invalid();
    let payload: Payload;
    try {
      const parsed = object(JSON.parse(bytes.toString("utf8")));
      if (!exact(parsed, ["after", "scope", "v"]) || parsed.v !== 1)
        throw invalid();
      payload = parsed as unknown as Payload;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw invalid();
    }
    if (JSON.stringify(payload.scope) !== JSON.stringify(expectedScope))
      throw invalid();
    const after = object(payload.after);
    if (expectedScope.kind === "list") {
      if (
        !exact(after, ["complaintId", "receivedAt"]) ||
        typeof after.complaintId !== "string" ||
        typeof after.receivedAt !== "string"
      )
        throw invalid();
      return { complaintId: after.complaintId, receivedAt: after.receivedAt };
    }
    if (
      !exact(after, ["eventId"]) ||
      typeof after.eventId !== "number" ||
      !Number.isSafeInteger(after.eventId) ||
      after.eventId < 1
    )
      throw invalid();
    return { eventId: after.eventId };
  }
}

export function assertComplaintResponseSize(body: unknown): void {
  if (
    Buffer.byteLength(JSON.stringify(body), "utf8") >
    COMPLAINT_RESPONSE_MAX_BYTES
  ) {
    throw new AppError(
      500,
      "COMPLAINT_RESPONSE_TOO_LARGE",
      "컴플레인 응답 크기 상한을 초과했습니다.",
    );
  }
}
