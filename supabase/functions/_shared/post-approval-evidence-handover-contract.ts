// Generated from src/modules/post-approval-room-issues/post-approval-room-issue-handover-contract.ts. DO NOT EDIT.
import { z } from "npm:zod@4.4.3";
import { AppError } from "./post-approval-report-error.ts";
import { requestHash } from "./post-approval-report-command.ts";

export const POST_APPROVAL_ROOM_ISSUE_HANDOVER_COMMAND =
  "post_approval_room_issue.evidence_handover";
const id = z.uuid().transform((value) => value.toLowerCase());
const actorSchema = z.object({ actorProfileId: id, sessionId: id }).strict();
const inputSchema = z.object({
  operationId: id,
  // Existing upload fence versions are bounded at eight. Handover must rotate
  // the version; it cannot reset the counter or bypass exhaustion.
  expectedLeaseVersion: z.int().min(0).max(7),
}).strict();
const keySchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  try {
    const result = schema.safeParse(input);
    if (result.success) return result.data;
  } catch { /* Never surface caller-provided fields in errors. */ }
  throw new AppError(
    400,
    "VALIDATION_ERROR",
    "증빙 인계 요청을 확인해 주세요.",
  );
}

export type PostApprovalRoomIssueHandoverInput = Readonly<
  z.infer<typeof inputSchema>
>;
export interface PreparedPostApprovalRoomIssueHandover {
  readonly actor: Readonly<z.infer<typeof actorSchema>>;
  readonly input: PostApprovalRoomIssueHandoverInput;
  /** Server-only receipt identity. Do not serialize into public responses. */
  readonly idempotencyKeyDigest: string;
  readonly requestHash: string;
}

export function validatePostApprovalRoomIssueHandover(
  input: unknown,
): PostApprovalRoomIssueHandoverInput {
  return Object.freeze(parse(inputSchema, input));
}

/** Pure request preparation only, NOT authorization or a completed transfer.
 * The adapter must derive actor/session from verified authentication; the DB
 * must check current admin/session, operation CAS, limits and immutable lineage.
 * Destination actor, original uploader, fence and provider identity are never
 * selected by client payload. A refreshed session keeps the receipt identity.
 */
export function preparePostApprovalRoomIssueHandover(
  authenticatedActor: unknown,
  input: unknown,
  rawKey: unknown,
): PreparedPostApprovalRoomIssueHandover {
  const actor = Object.freeze(parse(actorSchema, authenticatedActor));
  const value = validatePostApprovalRoomIssueHandover(input);
  const key = parse(keySchema, rawKey);
  const scope = {
    actorProfileId: actor.actorProfileId,
    command: POST_APPROVAL_ROOM_ISSUE_HANDOVER_COMMAND,
  };
  return Object.freeze({
    actor,
    input: value,
    idempotencyKeyDigest: requestHash({ ...scope, idempotencyKey: key }),
    requestHash: requestHash({ ...scope, ...value }),
  });
}
