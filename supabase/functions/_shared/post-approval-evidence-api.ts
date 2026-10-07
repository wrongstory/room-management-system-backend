import { z } from "npm:zod@4.4.3";
import type { Actor } from "./post-approval-report-actor.ts";
import { AppError } from "./post-approval-report-error.ts";
import {
  POST_APPROVAL_ROOM_ISSUE_UPLOAD_MAX_BYTES,
  projectPostApprovalRoomIssueUpload,
  validatePostApprovalRoomIssueUpload,
} from "./post-approval-evidence-contract.ts";
import { validatePostApprovalRoomIssueHandover } from "./post-approval-evidence-handover-contract.ts";
import { postApprovalRoomIssueEvidenceHttpErrorStatuses } from "./post-approval-evidence-http-errors.ts";

export interface PostApprovalEvidenceBody {
  stream: ReadableStream<Uint8Array> | null;
  contentLength: string | null;
  contentType: string | null;
}
/** The service must admit the upload before invoking readBody. It owns the
 * 5 MiB input limit, timeout, binary decoding and all fresh DB/provider guards. */
export interface PostApprovalEvidenceHttpPort {
  upload(
    actor: Actor,
    input: unknown,
    key: string,
    readBody: () => Promise<PostApprovalEvidenceBody>,
  ): Promise<unknown>;
  status(actor: Actor, operationId: string): Promise<unknown>;
  content(
    actor: Actor,
    evidenceId: string,
    revision: number,
  ): Promise<{ bytes: Uint8Array; mimeType: string }>;
}
export interface PostApprovalEvidenceHandoverHttpPort {
  recover(actor: Actor, input: unknown, key: string): Promise<unknown>;
}

const uploadPattern =
  /^\/v1\/cleaning-history\/submissions\/([^/]+)\/supplemental-room-issues\/drafts\/([^/]+)\/evidence\/([^/]+)\/upload$/;
const statusPattern =
  /^\/v1\/post-approval-room-issue-evidence-uploads\/([^/]+)$/;
const contentPattern =
  /^\/v1\/post-approval-room-issue-evidence\/([^/]+)\/versions\/([^/]+)\/content$/;
const handoverPattern =
  /^\/v1\/post-approval-room-issue-evidence-uploads\/([^/]+)\/handover$/;

function invalid(): never {
  throw new AppError(400, "VALIDATION_ERROR", "증빙 요청을 확인해 주세요.");
}
function projectionFailure(): never {
  throw new AppError(
    500,
    "POST_APPROVAL_ROOM_ISSUE_EVIDENCE_PROJECTION_INVALID",
    "증빙 응답을 확인하지 못했습니다.",
  );
}
function uuid(value: unknown): string {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) invalid();
  return parsed.data.toLowerCase();
}
function decimal(value: string | null | undefined, minimum: number): number {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) invalid();
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) invalid();
  return number;
}
function header(
  request: Request,
  name: string,
  required = true,
): string | null {
  const value = request.headers.get(name);
  // Fetch Headers joins repeated field values with commas. No header used by
  // these commands permits a comma, so joined duplicates fail closed.
  if ((required && value === null) || value?.includes(",")) invalid();
  return value;
}
function key(request: Request): string {
  const value = header(request, "idempotency-key");
  if (value === null || !/^[A-Za-z0-9._:-]{8,128}$/.test(value)) invalid();
  return value;
}
function noBody(request: Request): void {
  const length = header(request, "content-length", false);
  if (
    request.body !== null || request.headers.has("transfer-encoding") ||
    (length !== null && decimal(length, 0) !== 0)
  ) invalid();
}
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
async function handoverBody(
  request: Request,
): Promise<Record<string, unknown>> {
  const type = header(request, "content-type");
  if (!type || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type)) {
    throw new AppError(
      415,
      "PHOTO_MEDIA_TYPE_UNSUPPORTED",
      "JSON 요청이 필요합니다.",
    );
  }
  const length = header(request, "content-length", false);
  const declared = length === null ? null : decimal(length, 0);
  const tooLarge = () => {
    throw new AppError(
      413,
      "PHOTO_TOO_LARGE",
      "인계 요청 크기를 확인해 주세요.",
    );
  };
  if (declared !== null && declared > 1024) tooLarge();
  if (!request.body) invalid();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) invalid();
      size += part.value.byteLength;
      if (size > 1024) {
        await reader.cancel().catch(() => undefined);
        tooLarge();
      }
      chunks.push(part.value);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    invalid();
  } finally {
    reader.releaseLock();
  }
  if (!size || (declared !== null && declared !== size)) invalid();
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
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
    return value as Record<string, unknown>;
  } catch {
    invalid();
  }
}

/** Unregistered candidate. authenticate verifies the token and current active
 * profile/session before any request body is consumed. The injected services
 * retain DB ownership/CAS/retention checks; this factory never chooses an actor,
 * fence, provider locator or destination from the request. Parent owns CORS. */
export function createPostApprovalEvidenceEdgeHandler(
  service: PostApprovalEvidenceHttpPort,
  handover: PostApprovalEvidenceHandoverHttpPort,
  authenticate: (request: Request) => Promise<Actor>,
) {
  return async (
    request: Request,
    path = new URL(request.url).pathname,
  ): Promise<Response | null> => {
    const upload = uploadPattern.exec(path);
    const status = statusPattern.exec(path);
    const content = contentPattern.exec(path);
    const transfer = handoverPattern.exec(path);
    const action = upload && request.method === "POST"
      ? "upload"
      : status && request.method === "GET"
      ? "status"
      : content && request.method === "GET"
      ? "content"
      : transfer && request.method === "POST"
      ? "handover"
      : null;
    // Report routes, implicit HEAD and other siblings belong to the parent.
    if (!action) return null;
    try {
      const actor = await authenticate(request);
      if (actor.mustChangePassword) {
        throw new AppError(
          403,
          "PASSWORD_CHANGE_REQUIRED",
          "비밀번호 변경이 필요합니다.",
        );
      }
      if (action === "handover" && actor.role !== "admin") {
        throw new AppError(403, "ADMIN_REQUIRED", "관리자 권한이 필요합니다.");
      }
      if (actor.role !== "admin" && actor.role !== "maid") {
        throw new AppError(
          403,
          "POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED",
          "업무 권한이 필요합니다.",
        );
      }
      if (request.url.includes("?")) invalid();
      if (action === "upload" && upload) {
        const sourceSubmissionId = uuid(upload[1]);
        const clientReportId = uuid(upload[2]);
        const evidenceId = uuid(upload[3]);
        const input = validatePostApprovalRoomIssueUpload({
          sourceSubmissionId,
          clientReportId,
          evidenceId,
          expectedDraftRevision: decimal(
            header(request, "if-draft-revision"),
            1,
          ),
          expectedEvidenceRevision: decimal(
            header(request, "if-evidence-revision"),
            0,
          ),
          expectedItemRevision: decimal(header(request, "if-item-revision"), 0),
        });
        const requestKey = key(request);
        const contentLength = header(request, "content-length", false);
        const contentType = header(request, "content-type", false);
        const result = projectPostApprovalRoomIssueUpload(
          await service.upload(actor, input, requestKey, async () => {
            if (!request.body) invalid();
            return { stream: request.body, contentLength, contentType };
          }),
        );
        if (result.evidenceId !== evidenceId) projectionFailure();
        return json(result);
      }
      if (action === "handover" && transfer) {
        const operationId = uuid(transfer[1]);
        const requestKey = key(request);
        const body = await handoverBody(request);
        // Path identity is authoritative; validation must reject caller fields
        // BEFORE adding it, otherwise operationId could silently overwrite one.
        if (
          Object.keys(body).length !== 1 ||
          !Object.hasOwn(body, "expectedLeaseVersion")
        ) invalid();
        const input = validatePostApprovalRoomIssueHandover({
          operationId,
          ...body,
        });
        const result = projectPostApprovalRoomIssueUpload(
          await handover.recover(actor, input, requestKey),
        );
        if (
          result.operationId !== operationId ||
          result.leaseVersion <= input.expectedLeaseVersion
        ) projectionFailure();
        return json(result);
      }
      noBody(request);
      if (action === "status" && status) {
        const operationId = uuid(status[1]);
        const result = projectPostApprovalRoomIssueUpload(
          await service.status(actor, operationId),
        );
        if (result.operationId !== operationId) projectionFailure();
        return json(result);
      }
      if (action === "content" && content) {
        const result = await service.content(
          actor,
          uuid(content[1]),
          decimal(content[2], 1),
        );
        if (
          !(result.bytes instanceof Uint8Array) ||
          result.bytes.byteLength < 1 ||
          result.bytes.byteLength > POST_APPROVAL_ROOM_ISSUE_UPLOAD_MAX_BYTES ||
          (result.mimeType !== "image/jpeg" && result.mimeType !== "image/webp")
        ) projectionFailure();
        return new Response(result.bytes, {
          status: 200,
          headers: {
            "content-type": result.mimeType,
            "cache-control": "no-store",
          },
        });
      }
      invalid();
    } catch (error) {
      let code = "POST_APPROVAL_ROOM_ISSUE_EVIDENCE_COMMAND_FAILED";
      try {
        // Existing authentication raises EdgeError; generated business services
        // raise AppError. Only the shared safe code is read from either class.
        const candidate = error && typeof error === "object" && "code" in error
          ? error.code
          : null;
        if (
          typeof candidate === "string" &&
          Object.hasOwn(
            postApprovalRoomIssueEvidenceHttpErrorStatuses,
            candidate,
          )
        ) {
          code = candidate;
        }
      } catch {
        /* Never expose private error/getter/provider values or headers. */
      }
      return json({
        error: {
          code,
          message: "사후 특이사항 증빙 요청을 처리하지 못했습니다.",
        },
        requestId: crypto.randomUUID(),
      }, postApprovalRoomIssueEvidenceHttpErrorStatuses[code] ?? 500);
    }
  };
}
