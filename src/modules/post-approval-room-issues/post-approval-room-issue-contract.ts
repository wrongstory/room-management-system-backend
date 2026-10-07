import { z } from 'zod';
import type { AppRole } from '../../domain/actor.js';
import { AppError } from '../../lib/app-error.js';
import { requestHash } from '../../lib/command.js';

export const POST_APPROVAL_ROOM_ISSUE_DRAFT_COMMAND = 'post_approval_room_issue.draft';
export const POST_APPROVAL_ROOM_ISSUE_FINALIZE_COMMAND = 'post_approval_room_issue.finalize';
export const POST_APPROVAL_ROOM_ISSUE_CLOSE_COMMAND = 'post_approval_room_issue.close';
export const POST_APPROVAL_ROOM_ISSUE_EVIDENCE_MAX = 10;
export const POST_APPROVAL_ROOM_ISSUE_MEMO_MAX = 500;

const id = z.uuid().transform((value) => value.toLowerCase());
// Stored/sealed revisions can reach MAX_SAFE; only draft mutation needs room to increment.
// These transport bounds do not prove a DB CAS match.
const revision = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveRevision = revision.min(1);
const memo = z.string().min(1).max(POST_APPROVAL_ROOM_ISSUE_MEMO_MAX)
  .refine((value) => value.trim().length > 0);
const actorSchema = z.object({ actorProfileId: id, sessionId: id }).strict();
const draftSchema = z.object({
  clientReportId: id,
  sourceSubmissionId: id,
  expectedDraftRevision: revision,
  memo
}).strict();
const evidenceShape = {
  evidenceId: id,
  revision: positiveRevision,
  displayOrder: z.int().min(0).max(POST_APPROVAL_ROOM_ISSUE_EVIDENCE_MAX - 1)
};
const exactEvidenceSchema = z.object(evidenceShape).strict();
function orderedEvidence<T extends z.ZodType<{ evidenceId: string; displayOrder: number }>>(schema: T, minimum = 1) {
  return z.array(schema).min(minimum).max(POST_APPROVAL_ROOM_ISSUE_EVIDENCE_MAX)
    .refine((items) => new Set(items.map((item) => item.evidenceId)).size === items.length)
    .refine((items) => items.every((item, index) => item.displayOrder === index));
}
const finalizeSchema = draftSchema.extend({
  expectedDraftRevision: positiveRevision,
  expectedEvidenceRevision: positiveRevision,
  evidence: orderedEvidence(exactEvidenceSchema)
}).strict();
const keySchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const closeSchema = z.object({ sourceSubmissionId: id, reportId: id, expectedClosureRevision: z.literal(0) }).strict();
const closureSchema = z.object({ reportId: id, closureRevision: z.literal(1), closedAt: z.iso.datetime({ offset: true }) });
const sourceSchema = z.object({
  sourceSubmissionId: id,
  originalPerformerProfileId: id,
  // Canonical historical execution phase, not a client assertion or an assumed submission table column.
  // Historical reads survive a later decision/replacement; commands enforce eligibility in DB.
  sourceStatus: z.enum(['submitted', 'approved', 'rejected', 'superseded'])
});
// Private RPC projection, never accepted from request body/query. It is only a
// consistency check: the DB must prove immutable notified assignment provenance.
const notifiedAccessSchema = z.object({
  actorProfileId: id, sessionId: id, sourceSubmissionId: id,
  assignmentId: id, assignmentRevision: positiveRevision,
  notifiedAt: z.iso.datetime({ offset: true })
}).strict();
const sourceAuthoritySchema = sourceSchema.extend({ notifiedAssignmentAccess: notifiedAccessSchema.optional() });
const draftProjectionSchema = z.object({
  clientReportId: id,
  sourceSubmissionId: id,
  draftRevision: positiveRevision,
  evidenceRevision: revision,
  evidenceCount: z.int().min(0).max(POST_APPROVAL_ROOM_ISSUE_EVIDENCE_MAX),
  memo
}).refine((value) => value.evidenceCount === 0 || value.evidenceRevision > 0);
const reportProjectionSchema = z.object({
  reportId: id,
  clientReportId: id,
  sourceSubmissionId: id,
  originalPerformerProfileId: id,
  reportedByProfileId: id,
  reportedAt: z.iso.datetime({ offset: true }),
  memo,
  evidence: orderedEvidence(z.object(evidenceShape))
});
// Immutable finalize receipts retain their original projection. GET/list read
// the current closure separately and fail closed on inconsistent metadata.
const reportReadProjectionSchema = reportProjectionSchema.extend({
  closureRevision: z.union([z.literal(0), z.literal(1)]),
  closedAt: z.iso.datetime({ offset: true }).nullable(),
  closedByProfileId: id.nullable()
}).refine(value => value.closureRevision === 0
  ? value.closedAt === null && value.closedByProfileId === null
  : value.closedAt !== null && value.closedByProfileId !== null);
const draftRecoverySchema = z.object({
  draft: draftProjectionSchema,
  evidence: orderedEvidence(z.object(evidenceShape), 0),
  reportId: id.nullable()
}).refine(value => value.evidence.length === value.draft.evidenceCount);

function parse<T>(schema: z.ZodType<T>, value: unknown, projection = false): T {
  try {
    const result = schema.safeParse(value);
    if (result.success) return result.data;
  } catch {
    // Never echo raw payload, getter errors, provider locators or validation issue values.
  }
  throw new AppError(
    projection ? 500 : 400,
    projection ? 'POST_APPROVAL_ROOM_ISSUE_PROJECTION_INVALID' : 'VALIDATION_ERROR',
    '사후 특이사항 보고 계약을 확인해 주세요.'
  );
}

/** Server-only IDs extracted from verified authentication, never from client JSON or query. */
export type PostApprovalRoomIssueActor = Readonly<z.infer<typeof actorSchema>>;
export type PostApprovalRoomIssueDraftInput = Readonly<z.infer<typeof draftSchema>>;
export type PostApprovalRoomIssueEvidence = Readonly<z.infer<typeof exactEvidenceSchema>>;
export type PostApprovalRoomIssueFinalizeInput = Readonly<
  Omit<z.infer<typeof finalizeSchema>, 'evidence'> & { evidence: readonly PostApprovalRoomIssueEvidence[] }
>;

export function validatePostApprovalRoomIssueDraft(input: unknown): PostApprovalRoomIssueDraftInput {
  const parsed = parse(draftSchema, input);
  if (parsed.expectedDraftRevision === Number.MAX_SAFE_INTEGER) {
    throw new AppError(409, 'POST_APPROVAL_ROOM_ISSUE_DRAFT_CONFLICT', '초안 revision을 더 증가시킬 수 없습니다.');
  }
  return Object.freeze(parsed);
}
export function validatePostApprovalRoomIssueFinalization(input: unknown): PostApprovalRoomIssueFinalizeInput {
  const parsed = parse(finalizeSchema, input);
  return Object.freeze({ ...parsed, evidence: Object.freeze(parsed.evidence.map((item) => Object.freeze(item))) });
}

type Command = typeof POST_APPROVAL_ROOM_ISSUE_DRAFT_COMMAND | typeof POST_APPROVAL_ROOM_ISSUE_FINALIZE_COMMAND;
export interface PreparedPostApprovalRoomIssueCommand<T> {
  readonly command: Command;
  /** Internal RPC context only: do not serialize or log the session, key digest or request hash. */
  readonly actor: PostApprovalRoomIssueActor;
  readonly input: T;
  readonly idempotencyKeyDigest: string;
  readonly requestHash: string;
}
function prepare<T extends PostApprovalRoomIssueDraftInput>(
  command: Command, actor: unknown, input: T, rawIdempotencyKey: unknown
): PreparedPostApprovalRoomIssueCommand<T> {
  const trustedActor = Object.freeze(parse(actorSchema, actor));
  const key = parse(keySchema, rawIdempotencyKey);
  const scope = {
    actorProfileId: trustedActor.actorProfileId,
    command
  };
  return Object.freeze({
    command,
    actor: trustedActor,
    input,
    // Client payload IDs cannot create a new receipt scope for the same actor/command/raw key.
    idempotencyKeyDigest: requestHash({ ...scope, idempotencyKey: key }),
    // Session refresh must not change logical retry identity; the future RPC must recheck the fresh session.
    requestHash: requestHash({ actorProfileId: trustedActor.actorProfileId, command, ...input })
  });
}
export function preparePostApprovalRoomIssueDraft(actor: unknown, input: unknown, key: unknown) {
  return prepare(POST_APPROVAL_ROOM_ISSUE_DRAFT_COMMAND, actor, validatePostApprovalRoomIssueDraft(input), key);
}
export function preparePostApprovalRoomIssueFinalization(actor: unknown, input: unknown, key: unknown) {
  return prepare(POST_APPROVAL_ROOM_ISSUE_FINALIZE_COMMAND, actor, validatePostApprovalRoomIssueFinalization(input), key);
}
export function preparePostApprovalRoomIssueClosure(actor: unknown, input: unknown, key: unknown) {
  const trusted = Object.freeze(parse(actorSchema, actor));
  const value = Object.freeze(parse(closeSchema, input));
  const rawKey = parse(keySchema, key), command = POST_APPROVAL_ROOM_ISSUE_CLOSE_COMMAND;
  return Object.freeze({ actor: trusted, input: value, command,
    idempotencyKeyDigest: requestHash({ actorProfileId: trusted.actorProfileId, command, idempotencyKey: rawKey }),
    requestHash: requestHash({ actorProfileId: trusted.actorProfileId, command, ...value }) });
}
export function projectPostApprovalRoomIssueClosure(value: unknown) { return Object.freeze(parse(closureSchema, value, true)); }

export type PostApprovalRoomIssueSourceProjection = Readonly<z.infer<typeof sourceSchema> & {
  ownership: 'original_performer' | 'notified_assignee' | 'admin';
}>;
/**
 * Pure allowlisted projection of a server-supplied source, not DB authorization. Callers must prove the
 * immutable source tuple, fresh active profile/session and unrestricted capability in the future RPC.
 * Current assignment/occupancy is deliberately not an authority or a mutation target here.
 */
export function projectPostApprovalRoomIssueSource(
  actor: unknown, serverActorRole: AppRole, value: unknown
): PostApprovalRoomIssueSourceProjection {
  const trustedActor = parse(actorSchema, actor);
  if (serverActorRole !== 'maid' && serverActorRole !== 'admin') {
    throw new AppError(403, 'POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED', '본인 수행 이력 또는 관리자 권한이 필요합니다.');
  }
  const authority = parse(sourceAuthoritySchema, value, true);
  const source = parse(sourceSchema, authority, true);
  const grant = authority.notifiedAssignmentAccess;
  if (grant && (grant.actorProfileId !== trustedActor.actorProfileId || grant.sessionId !== trustedActor.sessionId
    || grant.sourceSubmissionId !== source.sourceSubmissionId)) {
    throw new AppError(403, 'POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED', '배정 이력 접근 근거를 확인해 주세요.');
  }
  const original = source.originalPerformerProfileId === trustedActor.actorProfileId;
  if (serverActorRole === 'maid' && !original && !grant) {
    throw new AppError(403, 'POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED', '본인 수행 이력 또는 관리자 권한이 필요합니다.');
  }
  return Object.freeze({ ...source, ownership: serverActorRole === 'admin' ? 'admin' : original ? 'original_performer' : 'notified_assignee' });
}

export type PostApprovalRoomIssueDraftProjection = Readonly<z.infer<typeof draftProjectionSchema>>;
export type PostApprovalRoomIssueReportProjection = Readonly<
  Omit<z.infer<typeof reportProjectionSchema>, 'evidence'> & { evidence: readonly PostApprovalRoomIssueEvidence[] }
>;
export type PostApprovalRoomIssueReportReadProjection = PostApprovalRoomIssueReportProjection & Readonly<{
  closureRevision: 0 | 1; closedAt: string | null; closedByProfileId: string | null;
}>;
/** Response allowlists discard unknown fields recursively; they do not prove persisted state or retention. */
export function projectPostApprovalRoomIssueDraft(value: unknown): PostApprovalRoomIssueDraftProjection {
  return Object.freeze(parse(draftProjectionSchema, value, true));
}
export function projectPostApprovalRoomIssueDraftRecovery(value: unknown) {
  const parsed = parse(draftRecoverySchema, value, true);
  return Object.freeze({ draft: Object.freeze(parsed.draft), reportId: parsed.reportId,
    evidence: Object.freeze(parsed.evidence.map(item => Object.freeze(item))) });
}
export function projectPostApprovalRoomIssueReport(value: unknown): PostApprovalRoomIssueReportProjection {
  const parsed = parse(reportProjectionSchema, value, true);
  return Object.freeze({ ...parsed, evidence: Object.freeze(parsed.evidence.map((item) => Object.freeze(item))) });
}
export function projectPostApprovalRoomIssueReportRead(value: unknown): PostApprovalRoomIssueReportReadProjection {
  const parsed = parse(reportReadProjectionSchema, value, true);
  return Object.freeze({ ...parsed, evidence: Object.freeze(parsed.evidence.map(item => Object.freeze(item))) });
}
export function projectPostApprovalRoomIssueReportList(value: unknown): readonly PostApprovalRoomIssueReportReadProjection[] {
  const reports = parse(z.array(reportReadProjectionSchema).max(50)
    .refine(items => new Set(items.map(item => item.reportId)).size === items.length), value, true);
  return Object.freeze(reports.map(item => projectPostApprovalRoomIssueReportRead(item)));
}
