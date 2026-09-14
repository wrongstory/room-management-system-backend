import {
  createSubmission,
  decideBombRoom,
  decideSubmission,
  getSubmission,
  listSubmissions,
  reportBombRoom,
  submissionDatabaseError,
  submissionPath,
} from "./submission-api.ts";
import { type EdgeActor, type EdgeClients, EdgeError } from "./runtime.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const attemptId = "30000000-0000-4000-8000-000000000001";
const submissionId = "40000000-0000-4000-8000-000000000001";
const photoId = "50000000-0000-4000-8000-000000000001";
const maid: EdgeActor = {
  authUserId: "10000000-0000-4000-8000-000000000001",
  profileId: "20000000-0000-4000-8000-000000000001",
  displayName: "메이드",
  role: "maid",
  mustChangePassword: false,
};
const admin: EdgeActor = {
  ...maid,
  profileId: "20000000-0000-4000-8000-000000000002",
  role: "admin",
};

function request(path: string, body?: unknown, key = "submission-safe-key-01") {
  return new Request(`https://example.invalid${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined
      ? undefined
      : { "content-type": "application/json", "idempotency-key": key },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function clientsFor(data: unknown, errorCode?: string) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const clients = {
    admin: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return Promise.resolve({
          data,
          error: errorCode ? { message: errorCode } : null,
        });
      },
    },
  } as unknown as EdgeClients;
  return { clients, calls };
}

async function failure(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    if (error instanceof EdgeError) return error;
    throw error;
  }
  throw new Error("Expected EdgeError");
}

Deno.test("submission exact paths never alias inspection actions", () => {
  assert(
    submissionPath(`/v1/attempts/${attemptId}/submissions`)?.kind ===
        "submit" &&
      submissionPath(`/v1/attempts/${attemptId}/bomb-room-reports`)?.kind ===
        "report" &&
      submissionPath(`/v1/inspections/${submissionId}/approve`)?.kind ===
        "approve",
    "exact routes",
  );
  for (
    const path of [
      `/v1/attempts/${attemptId}/submissions/extra`,
      `/v1/inspections/${submissionId}/approve/extra`,
      `/v1/inspections/not-a-uuid`,
    ]
  ) {
    let rejected = false;
    try {
      rejected = submissionPath(path) === null;
    } catch {
      rejected = true;
    }
    assert(rejected, `reject ${path}`);
  }
});

Deno.test("maid submission commands preserve scoped actor hash and redact raw extras", async () => {
  const projection = {
    id: submissionId,
    attemptId,
    version: 1,
    status: "submitted",
    submittedBy: maid.profileId,
    submittedAt: "2026-09-09T03:00:00Z",
    currentRevision: 1,
    current: true,
    photoCount: 2,
    candleCount: 1,
    requestHash: "never-return",
    raw_state: { providerLocator: "never-return" },
  };
  const { clients, calls } = clientsFor(projection);
  const result = await createSubmission(
    request(`/v1/attempts/${attemptId}/submissions`, {
      clientSubmissionId: "60000000-0000-4000-8000-000000000001",
      expectedRevision: 0,
      candleCount: 1,
    }),
    clients,
    maid,
    attemptId,
  );
  assert(calls[0].name === "create_cleaning_submission", "exact RPC");
  assert(
    calls[0].args.p_actor_profile_id === maid.profileId &&
      /^[a-f0-9]{64}$/.test(String(calls[0].args.p_request_hash)),
    "server actor and canonical hash",
  );
  assert(
    !JSON.stringify(result).includes("never-return") &&
      !JSON.stringify(result).includes("providerLocator"),
    "safe projection",
  );
});

Deno.test("bomb report validates exact selected evidence and keeps memo out of projection extras", async () => {
  const { clients, calls } = clientsFor({
    id: submissionId,
    attemptId,
    evidenceCount: 1,
    reportedAt: "2026-09-09T03:00:00Z",
    providerLocator: "hidden",
  });
  const result = await reportBombRoom(
    request(`/v1/attempts/${attemptId}/bomb-room-reports`, {
      evidencePhotoIds: [photoId],
      memo: "검수용 폭탄방 신고",
    }),
    clients,
    maid,
    attemptId,
  );
  assert(
    calls[0].name === "report_bomb_room" &&
      (calls[0].args.p_evidence_photo_ids as string[])[0] === photoId,
    "selected evidence forwarded",
  );
  assert(
    !JSON.stringify(result).includes("hidden"),
    "unknown raw field removed",
  );

  const duplicate = clientsFor(null);
  const error = await failure(() =>
    reportBombRoom(
      request(`/v1/attempts/${attemptId}/bomb-room-reports`, {
        evidencePhotoIds: [photoId, photoId],
        memo: "중복",
      }),
      duplicate.clients,
      maid,
      attemptId,
    )
  );
  assert(
    error.status === 400 && duplicate.calls.length === 0,
    "reject duplicate",
  );
});

Deno.test("role matrix denies developer/admin maid commands and maid inspection commands before RPC", async () => {
  const developer = { ...maid, role: "developer" as const };
  for (
    const actor of [admin, developer, { ...maid, mustChangePassword: true }]
  ) {
    const context = clientsFor(null);
    const error = await failure(() =>
      createSubmission(
        request(`/v1/attempts/${attemptId}/submissions`, {
          clientSubmissionId: "60000000-0000-4000-8000-000000000001",
          expectedRevision: 0,
          candleCount: 0,
        }),
        context.clients,
        actor,
        attemptId,
      )
    );
    assert(error.status === 403 && context.calls.length === 0, "maid gate");
  }
  for (
    const action of [
      () =>
        getSubmission(
          request(`/v1/inspections/${submissionId}`),
          clientsFor(null).clients,
          maid,
          submissionId,
        ),
      () =>
        decideBombRoom(
          request(`/v1/inspections/${submissionId}/bomb-room-decision`, {
            decision: "approved",
            reasonCode: "VALID",
          }),
          clientsFor(null).clients,
          maid,
          submissionId,
        ),
      () =>
        decideSubmission(
          request(`/v1/inspections/${submissionId}/approve`, {
            reasonCode: "VALID",
          }),
          clientsFor(null).clients,
          maid,
          submissionId,
          "approve",
        ),
    ]
  ) {
    assert((await failure(action)).status === 403, "admin gate");
  }
});

Deno.test("admin detail preserves sealed evidence IDs only and DB failures stay stable", async () => {
  const detail = {
    id: submissionId,
    attemptId,
    version: 1,
    status: "submitted",
    submittedBy: maid.profileId,
    submittedAt: "2026-09-09T03:00:00Z",
    currentRevision: 1,
    current: true,
    photoCount: 2,
    candleCount: 0,
    bombReport: {
      id: "70000000-0000-4000-8000-000000000001",
      attemptId,
      memo: "관리자 검수 메모",
      evidenceCount: 1,
      evidencePhotoIds: [photoId],
      reportedAt: "2026-09-09T02:00:00Z",
      providerLocator: "hidden",
    },
    requestHash: "hidden",
  };
  const result = await getSubmission(
    request(`/v1/inspections/${submissionId}`),
    clientsFor(detail).clients,
    admin,
    submissionId,
  );
  assert(
    JSON.stringify(result).includes(photoId) &&
      !JSON.stringify(result).includes("providerLocator") &&
      !JSON.stringify(result).includes("requestHash"),
    "admin safe evidence detail",
  );
  assert(
    submissionDatabaseError({ message: "STALE_VERSION" }).code ===
        "STALE_VERSION" &&
      submissionDatabaseError({ message: "raw SQL password token" }).code ===
        "SUBMISSION_COMMAND_FAILED",
    "stable redaction",
  );
  const list = await listSubmissions(
    request(`/v1/attempts/${attemptId}/submissions`),
    clientsFor([detail]).clients,
    maid,
    attemptId,
  );
  assert(
    !JSON.stringify(list).includes("providerLocator") &&
      !JSON.stringify(list).includes("requestHash"),
    "list safe projection",
  );
});

Deno.test("admin inspection queue exposes only immutable safe review context", async () => {
  const queue = clientsFor([{
    id: submissionId,
    attemptId,
    status: "inspection_pending",
    submittedBy: maid.profileId,
    submittedAt: "2026-09-09T03:00:00Z",
    reviewContext: {
      cleaningTargetId: "70000000-0000-4000-8000-000000000001",
      cleaningKind: "stayover",
      roomNumber: "1201",
      serviceDate: "2026-09-09",
      maidProfileId: maid.profileId,
      pin: "never-return",
      providerLocator: "never-return",
    },
    requestHash: "never-return",
  }]);
  const result = await listSubmissions(
    request("/v1/inspections"),
    queue.clients,
    admin,
  );
  const serialized = JSON.stringify(result);
  assert(serialized.includes('"roomNumber":"1201"'), "safe review context");
  assert(
    serialized.includes('"cleaningKind":"stayover"'),
    "safe cleaning kind",
  );
  assert(!serialized.includes("never-return"), "nested raw data redacted");

  const history = clientsFor([{
    id: submissionId,
    attemptId,
    status: "inspection_pending",
    reviewContext: { roomNumber: "1201" },
  }]);
  const maidResult = await listSubmissions(
    request(`/v1/attempts/${attemptId}/submissions`),
    history.clients,
    maid,
    attemptId,
  );
  assert(
    !JSON.stringify(maidResult).includes("roomNumber"),
    "maid history strips context",
  );
});
