// Generated from src/modules/post-approval-room-issues/post-approval-room-issue.service.ts. DO NOT EDIT.
import { z } from "npm:zod@4.4.3";
import type { Actor } from "./post-approval-report-actor.ts";
import { AppError } from "./post-approval-report-error.ts";
import { Buffer } from "node:buffer";
interface SupabaseClients {
  admin: {
    rpc(
      name: string,
      args: Record<string, unknown>,
    ): PromiseLike<{ data: unknown; error: unknown }>;
  };
}
import {
  type PostApprovalRoomIssueActor,
  type PostApprovalRoomIssueDraftProjection,
  type PostApprovalRoomIssueReportProjection,
  type PostApprovalRoomIssueReportReadProjection,
  type PostApprovalRoomIssueSourceProjection,
  preparePostApprovalRoomIssueClosure,
  preparePostApprovalRoomIssueDraft,
  preparePostApprovalRoomIssueFinalization,
  projectPostApprovalRoomIssueClosure,
  projectPostApprovalRoomIssueDraft,
  projectPostApprovalRoomIssueDraftRecovery,
  projectPostApprovalRoomIssueReport,
  projectPostApprovalRoomIssueReportList,
  projectPostApprovalRoomIssueReportRead,
  projectPostApprovalRoomIssueSource,
} from "./post-approval-report-contract.ts";

export interface PostApprovalRoomIssueSourceEnvelope {
  readonly source: PostApprovalRoomIssueSourceProjection;
}
export interface PostApprovalRoomIssueDraftEnvelope
  extends PostApprovalRoomIssueSourceEnvelope {
  readonly draft: PostApprovalRoomIssueDraftProjection;
}
export interface PostApprovalRoomIssueReportEnvelope
  extends PostApprovalRoomIssueSourceEnvelope {
  readonly report: PostApprovalRoomIssueReportProjection;
}
export interface PostApprovalRoomIssueReportReadEnvelope
  extends PostApprovalRoomIssueSourceEnvelope {
  readonly report: PostApprovalRoomIssueReportReadProjection;
}
export interface PostApprovalRoomIssueService {
  source(
    actor: Actor,
    sourceSubmissionId: string,
  ): Promise<PostApprovalRoomIssueSourceEnvelope>;
  list(
    actor: Actor,
    sourceSubmissionId: string,
  ): Promise<
    PostApprovalRoomIssueSourceEnvelope & {
      reports: readonly PostApprovalRoomIssueReportReadProjection[];
    }
  >;
  draft(
    actor: Actor,
    sourceSubmissionId: string,
    clientReportId: string,
  ): Promise<
    & PostApprovalRoomIssueSourceEnvelope
    & ReturnType<typeof projectPostApprovalRoomIssueDraftRecovery>
  >;
  saveDraft(
    actor: Actor,
    input: unknown,
    key: unknown,
  ): Promise<PostApprovalRoomIssueDraftEnvelope>;
  finalize(
    actor: Actor,
    input: unknown,
    key: unknown,
  ): Promise<PostApprovalRoomIssueReportEnvelope>;
  report(
    actor: Actor,
    sourceSubmissionId: string,
    reportId: string,
  ): Promise<PostApprovalRoomIssueReportReadEnvelope>;
  close(
    actor: Actor,
    input: unknown,
    key: unknown,
  ): Promise<ReturnType<typeof projectPostApprovalRoomIssueClosure>>;
}

export function postApprovalRoomIssueDatabaseError(error: unknown): AppError {
  const code = error && typeof error === "object" && "message" in error
    ? error.message
    : null;
  const statuses: Readonly<Record<string, number>> = {
    SESSION_REVOKED: 401,
    ADMIN_REQUIRED: 403,
    PASSWORD_CHANGE_REQUIRED: 403,
    CAPABILITY_ACCESS_REQUIRED: 403,
    POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED: 403,
    POST_APPROVAL_ROOM_ISSUE_SOURCE_UNAVAILABLE: 409,
    POST_APPROVAL_ROOM_ISSUE_DRAFT_CONFLICT: 409,
    POST_APPROVAL_ROOM_ISSUE_REPORT_SEALED: 409,
    POST_APPROVAL_ROOM_ISSUE_EVIDENCE_INVALID: 409,
    IDEMPOTENCY_KEY_REUSED: 409,
    INVALID_POST_APPROVAL_ROOM_ISSUE: 400,
  };
  return typeof code === "string" && Object.hasOwn(statuses, code)
    ? new AppError(
      statuses[code] ?? 500,
      code,
      "사후 특이사항 보고 조건을 확인해 주세요.",
    )
    : new AppError(
      500,
      "POST_APPROVAL_ROOM_ISSUE_COMMAND_FAILED",
      "사후 특이사항 보고를 처리하지 못했습니다.",
    );
}

function context(actor: Actor): PostApprovalRoomIssueActor {
  if (actor.mustChangePassword) {
    throw new AppError(
      403,
      "PASSWORD_CHANGE_REQUIRED",
      "비밀번호 변경이 필요합니다.",
    );
  }
  if (actor.role !== "admin" && actor.role !== "maid") {
    throw new AppError(
      403,
      "POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED",
      "본인 수행 이력 또는 관리자 권한이 필요합니다.",
    );
  }
  try {
    // The enclosing app must authenticate this token first. Decoding is not JWT verification.
    const parts = actor.accessToken.split(".");
    if (parts.length !== 3) throw new Error();
    const claims: unknown = JSON.parse(
      Buffer.from(parts[1] ?? "", "base64url").toString("utf8"),
    );
    const session = z.object({ session_id: z.uuid() }).parse(claims).session_id
      .toLowerCase();
    return Object.freeze({
      actorProfileId: z.uuid().parse(actor.profileId).toLowerCase(),
      sessionId: session,
    });
  } catch {
    throw new AppError(401, "INVALID_ACCESS_TOKEN", "로그인이 필요합니다.");
  }
}
function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw postApprovalRoomIssueDatabaseError(null);
  }
  return value as Record<string, unknown>;
}

/** Typed RPC source candidate; NOT wired into buildApp/Edge before actual DB gates. */
export class SupabasePostApprovalRoomIssueService
  implements PostApprovalRoomIssueService {
  constructor(private readonly clients: SupabaseClients) {}
  private async rpc(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    try {
      const { data, error } = await this.clients.admin.rpc(name, args);
      if (error) throw postApprovalRoomIssueDatabaseError(error);
      return row(data);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw postApprovalRoomIssueDatabaseError(null);
    }
  }
  private projectSource(
    actor: Actor,
    trusted: PostApprovalRoomIssueActor,
    value: unknown,
    expectedId: string,
  ) {
    const source = projectPostApprovalRoomIssueSource(
      trusted,
      actor.role,
      value,
    );
    if (source.sourceSubmissionId !== expectedId) {
      throw postApprovalRoomIssueDatabaseError(null);
    }
    return source;
  }
  async source(
    actor: Actor,
    sourceSubmissionId: string,
  ): Promise<PostApprovalRoomIssueSourceEnvelope> {
    const trusted = context(actor);
    const parsed = z.uuid().safeParse(sourceSubmissionId);
    if (!parsed.success) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "제출 identity를 확인해 주세요.",
      );
    }
    const expected = parsed.data.toLowerCase();
    const result = await this.rpc("get_post_approval_room_issue_source", {
      p_actor_profile_id: trusted.actorProfileId,
      p_session_id: trusted.sessionId,
      p_source_submission_id: expected,
    });
    return {
      source: this.projectSource(actor, trusted, result.source, expected),
    };
  }
  async list(actor: Actor, sourceSubmissionId: string) {
    const trusted = context(actor),
      parsed = z.uuid().safeParse(sourceSubmissionId);
    if (!parsed.success) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "제출 identity를 확인해 주세요.",
      );
    }
    const expected = parsed.data.toLowerCase();
    const result = await this.rpc("list_post_approval_room_issue_reports", {
      p_actor_profile_id: trusted.actorProfileId,
      p_session_id: trusted.sessionId,
      p_source_submission_id: expected,
    });
    const source = this.projectSource(actor, trusted, result.source, expected),
      reports = projectPostApprovalRoomIssueReportList(result.reports);
    if (
      reports.some((report) =>
        report.sourceSubmissionId !== expected ||
        report.originalPerformerProfileId !== source.originalPerformerProfileId
      )
    ) throw postApprovalRoomIssueDatabaseError(null);
    return { source, reports };
  }
  async saveDraft(
    actor: Actor,
    input: unknown,
    key: unknown,
  ): Promise<PostApprovalRoomIssueDraftEnvelope> {
    const command = preparePostApprovalRoomIssueDraft(
        context(actor),
        input,
        key,
      ),
      value = command.input;
    const result = await this.rpc("save_post_approval_room_issue_draft", {
      p_actor_profile_id: command.actor.actorProfileId,
      p_session_id: command.actor.sessionId,
      p_source_submission_id: value.sourceSubmissionId,
      p_client_report_id: value.clientReportId,
      p_expected_draft_revision: value.expectedDraftRevision,
      p_memo: value.memo,
      p_idempotency_key_digest: command.idempotencyKeyDigest,
      p_request_hash: command.requestHash,
    });
    const source = this.projectSource(
      actor,
      command.actor,
      result.source,
      value.sourceSubmissionId,
    );
    const draft = projectPostApprovalRoomIssueDraft(result.draft);
    if (
      draft.sourceSubmissionId !== value.sourceSubmissionId ||
      draft.clientReportId !== value.clientReportId ||
      draft.memo !== value.memo ||
      draft.draftRevision !== value.expectedDraftRevision + 1
    ) {
      throw postApprovalRoomIssueDatabaseError(null);
    }
    return { source, draft };
  }
  async draft(
    actor: Actor,
    sourceSubmissionId: string,
    clientReportId: string,
  ) {
    const trusted = context(actor),
      ids = z.object({ sourceSubmissionId: z.uuid(), clientReportId: z.uuid() })
        .safeParse({ sourceSubmissionId, clientReportId });
    if (!ids.success) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "초안 identity를 확인해 주세요.",
      );
    }
    const expectedSource = ids.data.sourceSubmissionId.toLowerCase(),
      expectedClient = ids.data.clientReportId.toLowerCase();
    const result = await this.rpc("get_post_approval_room_issue_draft", {
      p_actor_profile_id: trusted.actorProfileId,
      p_session_id: trusted.sessionId,
      p_source_submission_id: expectedSource,
      p_client_report_id: expectedClient,
    });
    const source = this.projectSource(
        actor,
        trusted,
        result.source,
        expectedSource,
      ),
      recovery = projectPostApprovalRoomIssueDraftRecovery(result);
    if (
      recovery.draft.sourceSubmissionId !== expectedSource ||
      recovery.draft.clientReportId !== expectedClient
    ) throw postApprovalRoomIssueDatabaseError(null);
    return { source, ...recovery };
  }
  async finalize(
    actor: Actor,
    input: unknown,
    key: unknown,
  ): Promise<PostApprovalRoomIssueReportEnvelope> {
    const command = preparePostApprovalRoomIssueFinalization(
        context(actor),
        input,
        key,
      ),
      value = command.input;
    const result = await this.rpc("finalize_post_approval_room_issue_report", {
      p_actor_profile_id: command.actor.actorProfileId,
      p_session_id: command.actor.sessionId,
      p_source_submission_id: value.sourceSubmissionId,
      p_client_report_id: value.clientReportId,
      p_expected_draft_revision: value.expectedDraftRevision,
      p_expected_evidence_revision: value.expectedEvidenceRevision,
      p_memo: value.memo,
      p_evidence: value.evidence,
      p_idempotency_key_digest: command.idempotencyKeyDigest,
      p_request_hash: command.requestHash,
    });
    const source = this.projectSource(
      actor,
      command.actor,
      result.source,
      value.sourceSubmissionId,
    );
    const report = projectPostApprovalRoomIssueReport(result.report);
    if (
      report.sourceSubmissionId !== value.sourceSubmissionId ||
      report.clientReportId !== value.clientReportId ||
      report.originalPerformerProfileId !== source.originalPerformerProfileId ||
      report.reportedByProfileId !== command.actor.actorProfileId ||
      report.memo !== value.memo ||
      JSON.stringify(report.evidence) !== JSON.stringify(value.evidence)
    ) {
      throw postApprovalRoomIssueDatabaseError(null);
    }
    return { source, report };
  }
  async report(
    actor: Actor,
    sourceSubmissionId: string,
    reportId: string,
  ): Promise<PostApprovalRoomIssueReportReadEnvelope> {
    const trusted = context(actor),
      parsed = z.object({ sourceSubmissionId: z.uuid(), reportId: z.uuid() })
        .safeParse({ sourceSubmissionId, reportId });
    if (!parsed.success) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "신고 identity를 확인해 주세요.",
      );
    }
    const expectedSource = parsed.data.sourceSubmissionId.toLowerCase(),
      expectedReport = parsed.data.reportId.toLowerCase();
    const result = await this.rpc("get_post_approval_room_issue_report", {
      p_actor_profile_id: trusted.actorProfileId,
      p_session_id: trusted.sessionId,
      p_source_submission_id: expectedSource,
      p_report_id: expectedReport,
    });
    const source = this.projectSource(
        actor,
        trusted,
        result.source,
        expectedSource,
      ),
      report = projectPostApprovalRoomIssueReportRead(result.report);
    if (
      report.sourceSubmissionId !== expectedSource ||
      report.reportId !== expectedReport ||
      report.originalPerformerProfileId !== source.originalPerformerProfileId
    ) throw postApprovalRoomIssueDatabaseError(null);
    return { source, report };
  }
  async close(actor: Actor, input: unknown, key: unknown) {
    const command = preparePostApprovalRoomIssueClosure(
      context(actor),
      input,
      key,
    );
    if (actor.role !== "admin") {
      throw new AppError(403, "ADMIN_REQUIRED", "관리자 권한이 필요합니다.");
    }
    const result = projectPostApprovalRoomIssueClosure(
      await this.rpc("close_post_approval_room_issue_report", {
        p_actor_profile_id: command.actor.actorProfileId,
        p_session_id: command.actor.sessionId,
        p_source_submission_id: command.input.sourceSubmissionId,
        p_report_id: command.input.reportId,
        p_expected_closure_revision: command.input.expectedClosureRevision,
        p_idempotency_key_digest: command.idempotencyKeyDigest,
        p_request_hash: command.requestHash,
      }),
    );
    if (result.reportId !== command.input.reportId) {
      throw postApprovalRoomIssueDatabaseError(null);
    }
    return result;
  }
}
