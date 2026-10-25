import { createPostApprovalReportEdgeHandler } from "./post-approval-report-api.ts";
import { SupabasePostApprovalRoomIssueService } from "./post-approval-report-service.ts";
import type { Actor } from "./post-approval-report-actor.ts";
const id = (n: number) =>
  `a3360000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const base = `/v1/cleaning-history/submissions/${
  id(3)
}/supplemental-room-issues`;
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
const draft = {
  sourceSubmissionId: id(3),
  clientReportId: id(4),
  draftRevision: 1,
  evidenceRevision: 1,
  evidenceCount: 1,
  memo: "synthetic",
};
const evidence = [{ evidenceId: id(6), revision: 1, displayOrder: 0 }];
const report = {
  sourceSubmissionId: id(3),
  clientReportId: id(4),
  reportId: id(5),
  originalPerformerProfileId: id(1),
  reportedByProfileId: id(1),
  reportedAt: "2026-10-06T00:00:00Z",
  memo: "synthetic",
  evidence,
};
function assert(value: unknown): asserts value {
  if (!value) throw new Error("Synthetic HTTP assertion failed");
}
function fixture(who = actor, denial?: unknown) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  let authCalls = 0;
  const service = new SupabasePostApprovalRoomIssueService({
    admin: {
      rpc(name, args) {
        calls.push({ name, args });
        const data = name === "close_post_approval_room_issue_report"
          ? {
            reportId: id(5),
            closureRevision: 1,
            closedAt: "2026-10-06T00:00:00Z",
          }
          : {
            source,
            draft,
            evidence,
            reportId: id(5),
            report: name === "get_post_approval_room_issue_report"
              ? {
                ...report,
                closureRevision: 1,
                closedAt: "2026-10-07T00:00:00Z",
                closedByProfileId: id(8),
              }
              : report,
            reports: [{
              ...report,
              closureRevision: 1,
              closedAt: "2026-10-07T00:00:00Z",
              closedByProfileId: id(8),
            }],
            secret: "not-public",
          };
        return Promise.resolve({ data, error: null });
      },
    },
  });
  const handler = createPostApprovalReportEdgeHandler(service, async () => {
    authCalls++;
    if (denial) throw denial;
    return who;
  });
  return { calls, handler, authenticated: () => authCalls };
}
function request(
  path: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return new Request(`https://synthetic.invalid${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "idempotency-key": "synthetic-key-001",
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
for (
  const [suffix, method, payload, rpc, status] of [
    ["/source", "GET", undefined, "get_post_approval_room_issue_source", 200],
    ["", "GET", undefined, "list_post_approval_room_issue_reports", 200],
    [
      `/drafts/${id(4)}`,
      "GET",
      undefined,
      "get_post_approval_room_issue_draft",
      200,
    ],
    [
      "/drafts",
      "POST",
      { clientReportId: id(4), expectedDraftRevision: 0, memo: "synthetic" },
      "save_post_approval_room_issue_draft",
      200,
    ],
    [
      "",
      "POST",
      {
        clientReportId: id(4),
        expectedDraftRevision: 1,
        expectedEvidenceRevision: 1,
        memo: "synthetic",
        evidence,
      },
      "finalize_post_approval_room_issue_report",
      201,
    ],
    [`/${id(5)}`, "GET", undefined, "get_post_approval_room_issue_report", 200],
    [
      `/${id(5)}/close`,
      "POST",
      { expectedClosureRevision: 0 },
      "close_post_approval_room_issue_report",
      200,
    ],
  ] as const
) {
  Deno.test(`report Edge HTTP ${rpc} binds path actor and session`, async () => {
    const f = fixture({ ...actor, role: "admin" });
    const response = await f.handler(request(base + suffix, method, payload));
    assert(
      response?.status === status &&
        response.headers.get("cache-control") === "no-store",
    );
    const body = await response.text();
    assert(!body.includes("not-public"));
    if (
      rpc === "get_post_approval_room_issue_report" ||
      rpc === "list_post_approval_room_issue_reports"
    ) {
      const data = JSON.parse(body);
      const current = rpc === "get_post_approval_room_issue_report"
        ? data.report
        : data.reports[0];
      assert(
        current.closureRevision === 1 &&
          current.closedAt === "2026-10-07T00:00:00Z" &&
          current.closedByProfileId === id(8),
      );
    }
    assert(
      f.calls.length === 1 && f.calls[0].name === rpc &&
        f.authenticated() === 1,
    );
    assert(
      f.calls[0].args.p_actor_profile_id === id(1) &&
        f.calls[0].args.p_session_id === id(2) &&
        f.calls[0].args.p_source_submission_id === id(3),
    );
  });
}
for (
  const [path, method, payload, headers, status] of [
    [base + "?extra=1", "GET", undefined, {}, 400],
    [base + "/source/extra", "GET", undefined, {}, 400],
    [base, "PATCH", {}, {}, 400],
    [base + "/drafts", "POST", { sourceSubmissionId: id(3) }, {}, 400],
    [base + "/drafts", "POST", {}, {
      "idempotency-key": "first-key,second-key",
    }, 400],
    [base + "/drafts", "POST", {}, { "content-type": "text/plain" }, 415],
    [base + "/drafts", "POST", { memo: "x".repeat(8193) }, {}, 413],
  ] as const
) {
  Deno.test(`report Edge rejects malformed transport ${path} ${method} ${status} ${JSON.stringify(headers)}`, async () => {
    const f = fixture();
    const response = await f.handler(request(path, method, payload, headers));
    assert(
      response?.status === status &&
        response.headers.get("cache-control") === "no-store",
    );
    assert(f.calls.length === 0);
  });
}
Deno.test("report Edge authentication failure reads no body and exposes no original error", async () => {
  const f = fixture(actor, {
    code: "SESSION_REVOKED",
    message: "secret-canary",
  });
  const req = request(base + "/drafts", "POST", { memo: "synthetic" });
  const response = await f.handler(req);
  assert(response?.status === 401 && !req.bodyUsed && f.calls.length === 0);
  assert(!(await response.text()).includes("secret-canary"));
});
Deno.test("report Edge rejects maid close and leaves unrelated routes to parent", async () => {
  const f = fixture();
  assert(
    await f.handler(request("/v1/rooms")) === null && f.authenticated() === 0,
  );
  assert(
    (await f.handler(
      request(base + `/${id(5)}/close`, "POST", { expectedClosureRevision: 0 }),
    ))?.status === 403,
  );
  assert(f.calls.length === 0);
});

for (const reportFirst of [true, false]) {
  Deno.test(`report Edge preserves evidence sibling in either composition order ${reportFirst}`, async () => {
    const f = fixture(actor, { code: "SESSION_REVOKED" });
    const path = base + `/drafts/${id(4)}/evidence/${id(6)}/upload`;
    const req = request(path, "POST", {
      synthetic: "binary handler owns body",
    });
    assert(await f.handler(req) === null);
    assert(!req.bodyUsed && f.authenticated() === 0 && f.calls.length === 0);
    const sibling = async (input: Request): Promise<Response | null> => {
      if (new URL(input.url).pathname !== path) return null;
      assert(!input.bodyUsed);
      await input.text();
      return new Response(null, { status: 202 });
    };
    const handlers = reportFirst ? [f.handler, sibling] : [sibling, f.handler];
    let result: Response | null = null;
    for (const handler of handlers) {
      result = await handler(req);
      if (result) break;
    }
    assert(result?.status === 202 && req.bodyUsed);
    assert(f.authenticated() === 0 && f.calls.length === 0);
  });
}
