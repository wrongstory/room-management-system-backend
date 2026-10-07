// Generated from src/modules/post-approval-room-issues/post-approval-room-issue-upload-contract.ts. DO NOT EDIT.
import { z } from "npm:zod@4.4.3";
import { AppError } from "./post-approval-report-error.ts";
import { requestHash } from "./post-approval-report-command.ts";

export const POST_APPROVAL_ROOM_ISSUE_UPLOAD_COMMAND =
  "post_approval_room_issue.evidence_upload";
export const POST_APPROVAL_ROOM_ISSUE_UPLOAD_MAX_BYTES = 307200;
export const postApprovalRoomIssueUploadStatuses = [
  "reserved",
  "provider_succeeded",
  "accepted",
  "reconciliation_pending",
  "compensation_pending",
  "compensated",
] as const;
const id = z.uuid().transform((value) => value.toLowerCase());
const revision = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
const actorSchema = z.object({ actorProfileId: id, sessionId: id }).strict();
const inputSchema = z.object({
  sourceSubmissionId: id,
  clientReportId: id,
  evidenceId: id,
  expectedDraftRevision: revision.min(1),
  expectedEvidenceRevision: revision,
  expectedItemRevision: revision,
}).strict();
const keySchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const metadataSchema = z.object({
  mimeType: z.enum(["image/jpeg", "image/webp"]),
  sizeBytes: z.int().min(1).max(POST_APPROVAL_ROOM_ISSUE_UPLOAD_MAX_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
const operationSchema = z.object({
  operationId: id,
  status: z.enum(postApprovalRoomIssueUploadStatuses),
  leaseVersion: z.int().min(0).max(8),
  evidenceId: id,
  itemRevision: revision,
  evidenceRevision: revision,
  ...metadataSchema.shape,
}).refine((value) =>
  value.status !== "accepted" ||
  (value.itemRevision > 0 && value.evidenceRevision > 0)
);
function parse<T>(schema: z.ZodType<T>, value: unknown, projection = false): T {
  try {
    const result = schema.safeParse(value);
    if (result.success) return result.data;
  } catch { /* No raw values. */ }
  throw new AppError(
    projection ? 500 : 400,
    projection
      ? "POST_APPROVAL_ROOM_ISSUE_EVIDENCE_PROJECTION_INVALID"
      : "VALIDATION_ERROR",
    "사후 특이사항 증빙 계약을 확인해 주세요.",
  );
}
export type PostApprovalRoomIssueUploadActor = Readonly<
  z.infer<typeof actorSchema>
>;
export type PostApprovalRoomIssueUploadInput = Readonly<
  z.infer<typeof inputSchema>
>;
export type PostApprovalRoomIssueUploadMetadata = Readonly<
  z.infer<typeof metadataSchema>
>;
export type PostApprovalRoomIssueUploadOperation = Readonly<
  z.infer<typeof operationSchema>
>;
export interface PreparedPostApprovalRoomIssueUploadKey {
  readonly actor: PostApprovalRoomIssueUploadActor;
  readonly input: PostApprovalRoomIssueUploadInput;
  /** Server RPC context only. Never serialize or log these fields. */
  readonly idempotencyKeyDigest: string;
}
export interface PreparedPostApprovalRoomIssueUpload
  extends PreparedPostApprovalRoomIssueUploadKey {
  readonly metadata: PostApprovalRoomIssueUploadMetadata;
  readonly requestHash: string;
}
export function validatePostApprovalRoomIssueUpload(
  input: unknown,
): PostApprovalRoomIssueUploadInput {
  const value = parse(inputSchema, input);
  if (
    value.expectedEvidenceRevision === Number.MAX_SAFE_INTEGER ||
    value.expectedItemRevision === Number.MAX_SAFE_INTEGER
  ) {
    throw new AppError(
      409,
      "POST_APPROVAL_ROOM_ISSUE_EVIDENCE_CONFLICT",
      "증빙 revision을 더 증가시킬 수 없습니다.",
    );
  }
  return Object.freeze(value);
}
/** Admission identity excludes bytes; the CPU/quota gate must run before the body is read or decoded. */
export function preparePostApprovalRoomIssueUploadKey(
  actor: unknown,
  input: unknown,
  rawKey: unknown,
): PreparedPostApprovalRoomIssueUploadKey {
  const trusted = Object.freeze(parse(actorSchema, actor)),
    value = validatePostApprovalRoomIssueUpload(input);
  const key = parse(keySchema, rawKey);
  return Object.freeze({
    actor: trusted,
    input: value,
    idempotencyKeyDigest: requestHash({
      actorProfileId: trusted.actorProfileId,
      command: POST_APPROVAL_ROOM_ISSUE_UPLOAD_COMMAND,
      idempotencyKey: key,
    }),
  });
}
/** Bind normalized bytes after admission. A session refresh cannot create a new logical command. */
export function preparePostApprovalRoomIssueUpload(
  prepared: PreparedPostApprovalRoomIssueUploadKey,
  normalizedMetadata: unknown,
): PreparedPostApprovalRoomIssueUpload {
  const actor = Object.freeze(parse(actorSchema, prepared.actor)),
    input = validatePostApprovalRoomIssueUpload(prepared.input);
  const metadata = Object.freeze(parse(metadataSchema, normalizedMetadata));
  if (!/^[0-9a-f]{64}$/.test(prepared.idempotencyKeyDigest)) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "증빙 요청 identity를 확인해 주세요.",
    );
  }
  return Object.freeze({
    actor,
    input,
    metadata,
    idempotencyKeyDigest: prepared.idempotencyKeyDigest,
    requestHash: requestHash({
      actorProfileId: actor.actorProfileId,
      command: POST_APPROVAL_ROOM_ISSUE_UPLOAD_COMMAND,
      ...input,
      ...metadata,
    }),
  });
}
/** Exact safe projection; unknown provider/session/fence fields are discarded, not forwarded. */
export function projectPostApprovalRoomIssueUpload(
  value: unknown,
): PostApprovalRoomIssueUploadOperation {
  return Object.freeze(parse(operationSchema, value, true));
}
