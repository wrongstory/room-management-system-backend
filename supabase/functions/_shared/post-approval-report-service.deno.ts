import { SupabasePostApprovalRoomIssueService } from "./post-approval-report-service.ts";
import type { Actor } from "./post-approval-report-actor.ts";
import { AppError } from "./post-approval-report-error.ts";
import { requestHash } from "./post-approval-report-command.ts";

Deno.test("report Edge list recovery finalize report and admin closure preserve exact RPC identities", async () => {
  const evidence = [{ evidenceId: id(6), revision: 1, displayOrder: 0 }];
  const report = {
    reportId: id(5),
    sourceSubmissionId: id(3),
    clientReportId: id(4),
    originalPerformerProfileId: id(1),
    reportedByProfileId: id(1),
    reportedAt: "2026-10-06T00:00:00Z",
    memo: "synthetic",
    evidence,
  };
  const currentReport = {
    ...report,
    closureRevision: 1,
    closedAt: "2026-10-07T00:00:00Z",
    closedByProfileId: id(8),
  };
  const list = fixture({ source, reports: [currentReport] });
  assert((await list.service.list(actor, id(3))).reports.length === 1);
  assert(list.calls[0].name === "list_post_approval_room_issue_reports");
  const recovery = fixture({
    source,
    draft: {
      sourceSubmissionId: id(3),
      clientReportId: id(4),
      draftRevision: 1,
      evidenceRevision: 1,
      evidenceCount: 1,
      memo: "synthetic",
    },
    evidence,
    reportId: id(5),
  });
  assert(
    (await recovery.service.draft(actor, id(3), id(4))).reportId === id(5),
  );
  assert(recovery.calls[0].args.p_client_report_id === id(4));
  const final = fixture({ source, report });
  await final.service.finalize(actor, {
    sourceSubmissionId: id(3),
    clientReportId: id(4),
    expectedDraftRevision: 1,
    expectedEvidenceRevision: 1,
    memo: "synthetic",
    evidence,
  }, "synthetic-final-001");
  assert(final.calls[0].name === "finalize_post_approval_room_issue_report");
  assert(final.calls[0].args.p_expected_evidence_revision === 1);
  const read = fixture({ source, report: currentReport });
  const current = await read.service.report(actor, id(3), id(5));
  assert(
    current.report.closureRevision === 1 &&
      current.report.closedByProfileId === id(8),
  );
  assert(read.calls[0].args.p_report_id === id(5));
  const close = fixture({
    reportId: id(5),
    closureRevision: 1,
    closedAt: "2026-10-06T00:00:00Z",
  });
  const input = {
    sourceSubmissionId: id(3),
    reportId: id(5),
    expectedClosureRevision: 0,
  };
  await denied(
    () => close.service.close(actor, input, "synthetic-close-001"),
    "ADMIN_REQUIRED",
  );
  assert(close.calls.length === 0);
  await close.service.close(
    { ...actor, role: "admin" },
    input,
    "synthetic-close-001",
  );
  assert(close.calls[0].name === "close_post_approval_room_issue_report");
  assert(close.calls[0].args.p_expected_closure_revision === 0);
});

const id = (n: number) =>
  `a3360000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const actor: Actor = {
  profileId: id(1),
  authUserId: id(9),
  role: "maid",
  displayName: "synthetic",
  mustChangePassword: false,
  accessToken: `header.${
    btoa(JSON.stringify({ session_id: id(2) })).replace(/=/g, "")
  }.signature`,
};
const source = {
  sourceSubmissionId: id(3),
  originalPerformerProfileId: id(1),
  sourceStatus: "approved",
};
const grant = {
  actorProfileId: id(1),
  sessionId: id(2),
  sourceSubmissionId: id(3),
  assignmentId: id(7),
  assignmentRevision: 2,
  notifiedAt: "2026-10-01T00:00:00Z",
};
function assert(value: unknown): asserts value {
  if (!value) throw new Error("Synthetic report assertion failed");
}
function fixture(data: unknown, error: unknown = null) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const service = new SupabasePostApprovalRoomIssueService({
    admin: {
      rpc: (name, args) => {
        calls.push({ name, args });
        return Promise.resolve({ data, error });
      },
    },
  });
  return { calls, service };
}
async function denied(run: () => Promise<unknown>, code: string) {
  try {
    await run();
  } catch (error) {
    assert(error instanceof AppError && error.code === code);
    return;
  }
  throw new Error("Expected denial");
}
Deno.test("report Edge generated source binds verified actor session and strips private proof", async () => {
  const f = fixture({
    source: {
      ...source,
      originalPerformerProfileId: id(8),
      notifiedAssignmentAccess: grant,
    },
  });
  const result = await f.service.source(actor, id(3));
  assert(result.source.ownership === "notified_assignee");
  assert(!JSON.stringify(result).includes("sessionId"));
  assert(
    f.calls[0].args.p_session_id === id(2) &&
      f.calls[0].args.p_actor_profile_id === id(1),
  );
});
for (
  const bad of [undefined, { ...grant, sessionId: id(5) }, {
    ...grant,
    actorProfileId: id(5),
  }, { ...grant, sourceSubmissionId: id(5) }]
) {
  Deno.test(`report Edge rejects missing or mismatched notified proof ${JSON.stringify(bad)}`, async () => {
    const f = fixture({
      source: {
        ...source,
        originalPerformerProfileId: id(8),
        notifiedAssignmentAccess: bad,
      },
    });
    await denied(
      () => f.service.source(actor, id(3)),
      "POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED",
    );
  });
}
Deno.test("report Edge draft uses canonical receipt hashes and response projection", async () => {
  const input = {
    sourceSubmissionId: id(3),
    clientReportId: id(4),
    expectedDraftRevision: 0,
    memo: "synthetic memo",
  };
  const f = fixture({
    source,
    draft: {
      sourceSubmissionId: id(3),
      clientReportId: id(4),
      draftRevision: 1,
      evidenceRevision: 0,
      evidenceCount: 0,
      memo: input.memo,
      secret: "not-public",
    },
  });
  const result = await f.service.saveDraft(actor, input, "synthetic-key-001");
  assert(!JSON.stringify(result).includes("not-public"));
  assert(f.calls[0].name === "save_post_approval_room_issue_draft");
  assert(
    f.calls[0].args.p_request_hash ===
      requestHash({
        actorProfileId: id(1),
        command: "post_approval_room_issue.draft",
        ...input,
      }),
  );
});
Deno.test("report Edge rejects client authority before RPC", async () => {
  const f = fixture(null);
  await denied(
    () =>
      f.service.saveDraft(actor, {
        sourceSubmissionId: id(3),
        clientReportId: id(4),
        expectedDraftRevision: 0,
        memo: "synthetic",
        actorProfileId: id(5),
      }, "synthetic-key-001"),
    "VALIDATION_ERROR",
  );
  assert(f.calls.length === 0);
});
Deno.test("report Edge maps revoked session and sanitizes unknown database errors", async () => {
  const revoked = fixture(null, { message: "SESSION_REVOKED" });
  await denied(() => revoked.service.source(actor, id(3)), "SESSION_REVOKED");
  const unknown = fixture(null, { message: "synthetic-secret-canary" });
  await denied(
    () => unknown.service.source(actor, id(3)),
    "POST_APPROVAL_ROOM_ISSUE_COMMAND_FAILED",
  );
});
Deno.test("report Edge refuses developer and invalid token before RPC", async () => {
  const f = fixture(null);
  await denied(
    () => f.service.source({ ...actor, role: "developer" }, id(3)),
    "POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED",
  );
  await denied(
    () => f.service.source({ ...actor, accessToken: "invalid" }, id(3)),
    "INVALID_ACCESS_TOKEN",
  );
  assert(f.calls.length === 0);
});
