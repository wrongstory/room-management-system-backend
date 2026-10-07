import { z } from "npm:zod@4.4.3";
import type { Actor } from "./post-approval-report-actor.ts";
import { AppError } from "./post-approval-report-error.ts";
import type { PostApprovalRoomIssueService } from "./post-approval-report-service.ts";
import { postApprovalRoomIssueHttpErrorStatuses } from "./post-approval-report-http-errors.ts";

const prefix = "/v1/cleaning-history/submissions/";
const pattern =
  /^\/v1\/cleaning-history\/submissions\/([^/]+)\/supplemental-room-issues(?:\/(source|drafts|[^/]+)(?:\/(close|[^/]+))?)?$/;
const maximumBytes = 8192;
function fail(code = "VALIDATION_ERROR"): never {
  throw new AppError(400, code, "요청을 확인해 주세요.");
}
async function body(request: Request): Promise<Record<string, unknown>> {
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
      request.headers.get("content-type") ?? "",
    )
  ) fail("POST_APPROVAL_ROOM_ISSUE_MEDIA_TYPE_INVALID");
  const length = request.headers.get("content-length");
  if (
    length !== null && (!/^\d+$/.test(length) || Number(length) > maximumBytes)
  ) fail("POST_APPROVAL_ROOM_ISSUE_BODY_TOO_LARGE");
  if (!request.body) fail();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        fail("POST_APPROVAL_ROOM_ISSUE_BODY_TOO_LARGE");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (!value || typeof value !== "object" || Array.isArray(value)) fail();
    return value as Record<string, unknown>;
  } catch {
    fail();
  }
}
function uuid(value: unknown): string {
  const result = z.uuid().safeParse(value);
  if (!result.success) fail();
  return result.data.toLowerCase();
}
function response(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/** Unregistered Edge candidate. authenticate MUST verify token and current profile/session.
 * The service still rechecks authorization in DB; decoded client claims are not authentication.
 * Parent owns CORS and must pass the canonical API-relative path, not a client-supplied selector.
 */
export function createPostApprovalReportEdgeHandler(
  service: PostApprovalRoomIssueService,
  authenticate: (request: Request) => Promise<Actor>,
) {
  return async (
    request: Request,
    path = new URL(request.url).pathname,
  ): Promise<Response | null> => {
    if (
      !path.startsWith(prefix) || !path.includes("/supplemental-room-issues")
    ) return null;
    // Claim only report routes. Evidence/handover siblings belong to other
    // handlers and must not depend on composition order or consume their body.
    const match = pattern.exec(path);
    if (!match) return null;
    try {
      const source = uuid(match[1]), first = match[2], second = match[3];
      const method = request.method;
      const action = !first && method === "GET"
        ? "list"
        : !first && method === "POST"
        ? "finalize"
        : first === "source" && !second && method === "GET"
        ? "source"
        : first === "drafts" && !second && method === "POST"
        ? "saveDraft"
        : first === "drafts" && second && method === "GET"
        ? "draft"
        : first && first !== "source" && first !== "drafts" && !second &&
            method === "GET"
        ? "report"
        : first && first !== "source" && first !== "drafts" &&
            second === "close" && method === "POST"
        ? "close"
        : null;
      if (!action || new URL(request.url).searchParams.size !== 0) fail();
      const actor = await authenticate(request);
      if (actor.mustChangePassword) fail("PASSWORD_CHANGE_REQUIRED");
      if (actor.role !== "admin" && actor.role !== "maid") {
        fail("POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED");
      }
      if (method === "GET") {
        if (request.body !== null) fail();
        const result = action === "source"
          ? await service.source(actor, source)
          : action === "list"
          ? await service.list(actor, source)
          : action === "draft"
          ? await service.draft(actor, source, uuid(second))
          : await service.report(actor, source, uuid(first));
        return response(result, 200);
      }
      if (action === "close" && actor.role !== "admin") fail("ADMIN_REQUIRED");
      const key = request.headers.get("idempotency-key");
      if (!key || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) fail();
      const input = await body(request);
      if (Object.hasOwn(input, "sourceSubmissionId")) fail();
      if (action === "close") {
        if (
          Object.keys(input).length !== 1 || input.expectedClosureRevision !== 0
        ) fail();
        return response(
          await service.close(actor, {
            ...input,
            sourceSubmissionId: source,
            reportId: uuid(first),
          }, key),
          200,
        );
      }
      const value = { ...input, sourceSubmissionId: source };
      return action === "saveDraft"
        ? response(await service.saveDraft(actor, value, key), 200)
        : response(await service.finalize(actor, value, key), 201);
    } catch (error) {
      let code = "POST_APPROVAL_ROOM_ISSUE_COMMAND_FAILED";
      try {
        const candidate = error && typeof error === "object" && "code" in error
          ? error.code
          : null;
        if (
          typeof candidate === "string" &&
          Object.hasOwn(postApprovalRoomIssueHttpErrorStatuses, candidate)
        ) code = candidate;
      } catch { /* Never expose getter/provider/SQL errors. */ }
      return response({
        error: {
          code,
          message: "사후 특이사항 보고 요청을 처리하지 못했습니다.",
        },
        requestId: crypto.randomUUID(),
      }, postApprovalRoomIssueHttpErrorStatuses[code] ?? 500);
    }
  };
}
