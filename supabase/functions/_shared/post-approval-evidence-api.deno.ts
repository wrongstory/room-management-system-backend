import type { Actor } from "./post-approval-report-actor.ts";
import { AppError } from "./post-approval-report-error.ts";
import { EdgeError } from "./runtime.ts";
import {
  createPostApprovalEvidenceEdgeHandler,
  type PostApprovalEvidenceHandoverHttpPort,
  type PostApprovalEvidenceHttpPort,
} from "./post-approval-evidence-api.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
function equal(actual: unknown, expected: unknown): void {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
          .map(([name, item]) => [name, stable(item)]),
      );
    }
    return value;
  };
  assert(
    JSON.stringify(stable(actual)) === JSON.stringify(stable(expected)),
    "unexpected synthetic result",
  );
}
const id = (n: number) =>
  `b3600000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const actor: Actor = {
  profileId: id(1),
  authUserId: id(2),
  role: "maid",
  displayName: "synthetic",
  mustChangePassword: false,
  accessToken: "verified.server.token",
};
const operation = {
  operationId: id(6),
  evidenceId: id(5),
  status: "accepted",
  leaseVersion: 2,
  itemRevision: 1,
  evidenceRevision: 1,
  mimeType: "image/jpeg",
  sizeBytes: 3,
  sha256: "a".repeat(64),
};
const uploadPath = `/v1/cleaning-history/submissions/${
  id(3)
}/supplemental-room-issues/drafts/${id(4)}/evidence/${id(5)}/upload`;
const statusPath = `/v1/post-approval-room-issue-evidence-uploads/${id(6)}`;
const contentPath = `/v1/post-approval-room-issue-evidence/${
  id(5)
}/versions/1/content`;
const handoverPath = `${statusPath}/handover`;
const uploadHeaders = {
  "if-draft-revision": "1",
  "if-evidence-revision": "0",
  "if-item-revision": "0",
  "idempotency-key": "synthetic-evidence-key",
  "content-type": "image/jpeg",
};
const handoverHeaders = {
  "idempotency-key": "synthetic-handover-key",
  "content-type": "application/json",
};
interface Options {
  who?: Actor;
  authDenial?: unknown;
  serviceDenial?: unknown;
  output?: unknown;
  content?: { bytes: Uint8Array; mimeType: string };
}
function fixture(options: Options = {}) {
  const events: string[] = [];
  const calls: unknown[][] = [];
  const received: Uint8Array[] = [];
  const service: PostApprovalEvidenceHttpPort = {
    async upload(who, input, key, readBody) {
      events.push("admission");
      calls.push(["upload", who, input, key]);
      if (options.serviceDenial !== undefined) throw options.serviceDenial;
      const body = await readBody();
      events.push("body-callback");
      assert(body.stream instanceof ReadableStream);
      calls.push(["headers", body.contentType, body.contentLength]);
      received.push(
        new Uint8Array(await new Response(body.stream).arrayBuffer()),
      );
      return options.output ??
        {
          ...operation,
          providerFileId: "private_provider_123",
          fence: "private_fence",
          sessionId: id(9),
        };
    },
    async status(who, operationId) {
      calls.push(["status", who, operationId]);
      if (options.serviceDenial !== undefined) throw options.serviceDenial;
      return options.output ??
        { ...operation, providerFileId: "private_provider_123" };
    },
    async content(who, evidenceId, revision) {
      calls.push(["content", who, evidenceId, revision]);
      if (options.serviceDenial !== undefined) throw options.serviceDenial;
      return options.content ??
        { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/jpeg" };
    },
  };
  const handover: PostApprovalEvidenceHandoverHttpPort = {
    async recover(who, input, key) {
      calls.push(["recover", who, input, key]);
      if (options.serviceDenial !== undefined) throw options.serviceDenial;
      return options.output ??
        {
          ...operation,
          fence: "private_fence",
          providerFileId: "private_provider_123",
        };
    },
  };
  const handle = createPostApprovalEvidenceEdgeHandler(
    service,
    handover,
    async () => {
      events.push("authenticate");
      if (options.authDenial !== undefined) throw options.authDenial;
      return options.who ?? actor;
    },
  );
  return { handle, events, calls, received };
}
function uploadRequest(
  headers: HeadersInit = uploadHeaders,
  body: BodyInit = new Uint8Array([1, 2, 3]),
  path = uploadPath,
) {
  return new Request(`https://synthetic.invalid${path}`, {
    method: "POST",
    headers,
    body,
  });
}
function handoverRequest(
  body: string = JSON.stringify({ expectedLeaseVersion: 1 }),
  headers: HeadersInit = handoverHeaders,
  path = handoverPath,
) {
  return new Request(`https://synthetic.invalid${path}`, {
    method: "POST",
    headers,
    body,
  });
}
async function checked(
  result: Response | null,
  status: number,
): Promise<Response> {
  assert(result instanceof Response);
  equal(result.status, status);
  equal(result.headers.get("cache-control"), "no-store");
  return result;
}

Deno.test("supplemental evidence upload passes canonical path/CAS and deferred raw reader after auth", async () => {
  const f = fixture(), request = uploadRequest();
  const response = await checked(await f.handle(request), 200);
  equal(await response.json(), operation);
  equal(f.events, ["authenticate", "admission", "body-callback"]);
  equal(f.calls[0], ["upload", actor, {
    sourceSubmissionId: id(3),
    clientReportId: id(4),
    evidenceId: id(5),
    expectedDraftRevision: 1,
    expectedEvidenceRevision: 0,
    expectedItemRevision: 0,
  }, "synthetic-evidence-key"]);
  equal([...f.received[0]], [1, 2, 3]);
  assert(request.bodyUsed);
});
Deno.test("upload admission rejection leaves raw body unread", async () => {
  const f = fixture({
    serviceDenial: new AppError(
      429,
      "PHOTO_UPLOAD_RATE_LIMITED",
      "private SQL token",
    ),
  });
  const request = uploadRequest(),
    response = await checked(await f.handle(request), 429);
  equal(f.events, ["authenticate", "admission"]);
  assert(!request.bodyUsed);
  equal(f.received, []);
  assert(!(await response.text()).includes("private"));
});
Deno.test("raw upload does not use the report JSON limit and forwards all four smartphone MIME types", async () => {
  for (const mime of ["image/jpeg", "image/webp", "image/heic", "image/heif"]) {
    const f = fixture(), bytes = new Uint8Array(8193);
    await checked(
      await f.handle(
        uploadRequest({
          ...uploadHeaders,
          "content-type": mime,
          "content-length": "8193",
        }, bytes),
      ),
      200,
    );
    equal(f.received[0]?.byteLength, 8193);
    equal(f.calls[1], ["headers", mime, "8193"]);
  }
});
Deno.test("upload rejects missing and comma-joined duplicate command headers before admission", async () => {
  for (
    const name of [
      "if-draft-revision",
      "if-evidence-revision",
      "if-item-revision",
      "idempotency-key",
    ]
  ) {
    for (const duplicate of [false, true]) {
      const f = fixture(), headers = new Headers(uploadHeaders);
      if (duplicate) headers.append(name, headers.get(name) ?? "");
      else headers.delete(name);
      const request = uploadRequest(headers);
      await checked(await f.handle(request), 400);
      equal(f.calls, []);
      assert(!request.bodyUsed);
    }
  }
});
Deno.test("upload rejects malformed safe CAS and exhausted incrementable revisions", async () => {
  for (
    const value of [
      "-1",
      "1.5",
      "1e2",
      "+1",
      "NaN",
      "Infinity",
      "9007199254740992",
      "",
    ]
  ) {
    const f = fixture();
    await checked(
      await f.handle(
        uploadRequest({ ...uploadHeaders, "if-evidence-revision": value }),
      ),
      400,
    );
    equal(f.calls, []);
  }
  for (const name of ["if-evidence-revision", "if-item-revision"]) {
    const f = fixture();
    await checked(
      await f.handle(
        uploadRequest({
          ...uploadHeaders,
          [name]: String(Number.MAX_SAFE_INTEGER),
        }),
      ),
      409,
    );
    equal(f.calls, []);
  }
});
Deno.test("upload accepts final incrementable CAS and uppercase path UUIDs", async () => {
  const f = fixture();
  const path = uploadPath.replace(id(3), id(3).toUpperCase())
    .replace(id(4), id(4).toUpperCase()).replace(id(5), id(5).toUpperCase());
  await checked(
    await f.handle(
      uploadRequest(
        {
          ...uploadHeaders,
          "if-draft-revision": String(Number.MAX_SAFE_INTEGER),
          "if-evidence-revision": String(Number.MAX_SAFE_INTEGER - 1),
          "if-item-revision": "00",
        },
        new Uint8Array([1]),
        path,
      ),
    ),
    200,
  );
  equal(f.calls[0], ["upload", actor, {
    sourceSubmissionId: id(3),
    clientReportId: id(4),
    evidenceId: id(5),
    expectedDraftRevision: Number.MAX_SAFE_INTEGER,
    expectedEvidenceRevision: Number.MAX_SAFE_INTEGER - 1,
    expectedItemRevision: 0,
  }, "synthetic-evidence-key"]);
});
Deno.test("upload path UUIDs and query markers cannot select source or actor", async () => {
  for (
    const path of [
      uploadPath.replace(id(3), "invalid"),
      uploadPath.replace(id(4), "invalid"),
      uploadPath.replace(id(5), "invalid"),
      `${uploadPath}?actorProfileId=${id(9)}`,
      `${uploadPath}?`,
    ]
  ) {
    const f = fixture();
    await checked(
      await f.handle(uploadRequest(uploadHeaders, new Uint8Array([1]), path)),
      400,
    );
    equal(f.calls, []);
  }
});
Deno.test("all evidence routes deny auth/password/developer before consuming body or calling service", async () => {
  const denied = [
    {
      authDenial: new AppError(401, "SESSION_REVOKED", "private token"),
      status: 401,
    },
    { who: { ...actor, mustChangePassword: true }, status: 403 },
    { who: { ...actor, role: "developer" as const }, status: 403 },
  ];
  for (const options of denied) {
    for (
      const request of [
        uploadRequest(),
        handoverRequest(),
        new Request(`https://synthetic.invalid${statusPath}`),
        new Request(`https://synthetic.invalid${contentPath}`),
      ]
    ) {
      const f = fixture(options),
        response = await checked(await f.handle(request), options.status);
      equal(f.calls, []);
      assert(!request.bodyUsed);
      assert(!(await response.text()).includes("private"));
    }
  }
});
Deno.test("status binds operation path, strips private fields and accepts only safe projections", async () => {
  const f = fixture(),
    response = await checked(
      await f.handle(new Request(`https://synthetic.invalid${statusPath}`)),
      200,
    );
  equal(await response.json(), operation);
  equal(f.calls, [["status", actor, id(6)]]);
  for (
    const output of [{ ...operation, operationId: id(99) }, {
      ...operation,
      sizeBytes: 307201,
    }, { ...operation, status: "private_state" }]
  ) {
    const bad = fixture({ output });
    const denied = await checked(
      await bad.handle(new Request(`https://synthetic.invalid${statusPath}`)),
      500,
    );
    assert(!(await denied.text()).includes(id(99)));
  }
});
Deno.test("upload refuses evidence identity or accepted revision mismatches without leaking values", async () => {
  for (
    const output of [{ ...operation, evidenceId: id(99) }, {
      ...operation,
      itemRevision: 0,
    }, { ...operation, mimeType: "text/plain" }]
  ) {
    const f = fixture({ output }),
      response = await checked(await f.handle(uploadRequest()), 500);
    equal(
      (await response.json()).error.code,
      "POST_APPROVAL_ROOM_ISSUE_EVIDENCE_PROJECTION_INVALID",
    );
  }
});
Deno.test("binary content preserves exact bytes and MIME without private headers", async () => {
  for (const mimeType of ["image/jpeg", "image/webp"]) {
    const f = fixture({
      content: { bytes: new Uint8Array([1, 2, 3]), mimeType },
    });
    const response = await checked(
      await f.handle(new Request(`https://synthetic.invalid${contentPath}`)),
      200,
    );
    equal([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
    equal(response.headers.get("content-type"), mimeType);
    equal(f.calls, [["content", actor, id(5), 1]]);
    for (
      const header of [
        "provider-file-id",
        "x-sha256",
        "etag",
        "content-disposition",
        "x-room-pin",
      ]
    ) equal(response.headers.get(header), null);
  }
});
Deno.test("binary content rejects unsafe revision and invalid output byte/MIME limits", async () => {
  for (const revision of ["0", "-1", "1.5", "1e2", "9007199254740992"]) {
    const f = fixture();
    await checked(
      await f.handle(
        new Request(
          `https://synthetic.invalid${
            contentPath.replace("/versions/1/", `/versions/${revision}/`)
          }`,
        ),
      ),
      400,
    );
    equal(f.calls, []);
  }
  for (
    const content of [{ bytes: new Uint8Array(0), mimeType: "image/jpeg" }, {
      bytes: new Uint8Array(307201),
      mimeType: "image/jpeg",
    }, { bytes: new Uint8Array([1]), mimeType: "image/heic" }]
  ) {
    const f = fixture({ content });
    await checked(
      await f.handle(new Request(`https://synthetic.invalid${contentPath}`)),
      500,
    );
  }
  const f = fixture();
  await checked(
    await f.handle(
      new Request(
        `https://synthetic.invalid${
          contentPath.replace(
            "/versions/1/",
            `/versions/${Number.MAX_SAFE_INTEGER}/`,
          )
        }`,
      ),
    ),
    200,
  );
  equal(f.calls, [["content", actor, id(5), Number.MAX_SAFE_INTEGER]]);
});
Deno.test("GET evidence routes reject body framing and query before domain calls", async () => {
  const framedHeaders: HeadersInit[] = [{ "content-length": "1" }, {
    "transfer-encoding": "chunked",
  }, { "content-length": "0, 0" }];
  for (const path of [statusPath, contentPath]) {
    for (const headers of framedHeaders) {
      const f = fixture();
      await checked(
        await f.handle(
          new Request(`https://synthetic.invalid${path}`, { headers }),
        ),
        400,
      );
      equal(f.calls, []);
    }
    const f = fixture();
    await checked(
      await f.handle(new Request(`https://synthetic.invalid${path}?x=1`)),
      400,
    );
    equal(f.calls, []);
  }
});
Deno.test("handover is admin-only and never consumes rejected maid body", async () => {
  const f = fixture(), request = handoverRequest();
  const response = await checked(await f.handle(request), 403);
  equal((await response.json()).error.code, "ADMIN_REQUIRED");
  equal(f.calls, []);
  assert(!request.bodyUsed);
});
Deno.test("handover binds admin/operation, preserves key and strips provider/fence output", async () => {
  const admin = { ...actor, role: "admin" as const },
    f = fixture({ who: admin });
  const response = await checked(await f.handle(handoverRequest()), 200);
  equal(await response.json(), operation);
  equal(f.calls, [["recover", admin, {
    operationId: id(6),
    expectedLeaseVersion: 1,
  }, "synthetic-handover-key"]]);
});
Deno.test("handover rejects caller authority and invalid bounded lease before recover", async () => {
  const admin = { ...actor, role: "admin" as const };
  for (
    const body of [
      {},
      { expectedLeaseVersion: 8 },
      { expectedLeaseVersion: -1 },
      { expectedLeaseVersion: "1" },
      { expectedLeaseVersion: 1, operationId: id(9) },
      { expectedLeaseVersion: 1, actorProfileId: id(9) },
      { expectedLeaseVersion: 1, fence: "private" },
    ]
  ) {
    const f = fixture({ who: admin });
    await checked(await f.handle(handoverRequest(JSON.stringify(body))), 400);
    equal(f.calls, []);
  }
});
Deno.test("handover enforces 1024-byte JSON bound, malformed JSON/MIME and content length", async () => {
  const who = { ...actor, role: "admin" as const },
    valid = JSON.stringify({ expectedLeaseVersion: 1 });
  const f = fixture({ who });
  await checked(await f.handle(handoverRequest(valid.padEnd(1024))), 200);
  for (
    const [body, headers, status] of [
      [valid.padEnd(1025), handoverHeaders, 413],
      [valid, { ...handoverHeaders, "content-length": "1025" }, 413],
      [valid, { ...handoverHeaders, "content-length": "1" }, 400],
      ["{broken private token", handoverHeaders, 400],
      [valid, { ...handoverHeaders, "content-type": "text/plain" }, 415],
    ] as const
  ) {
    const bad = fixture({ who }),
      response = await checked(
        await bad.handle(handoverRequest(body, headers)),
        status,
      );
    equal(bad.calls, []);
    assert(!(await response.text()).includes("private"));
  }
});
Deno.test("handover rejects repeated/missing keys and query without consuming JSON", async () => {
  const who = { ...actor, role: "admin" as const };
  const missing = new Headers(handoverHeaders);
  missing.delete("idempotency-key");
  const duplicate = new Headers(handoverHeaders);
  duplicate.append("idempotency-key", "synthetic-handover-key");
  for (
    const request of [
      handoverRequest(undefined, missing),
      handoverRequest(undefined, duplicate),
      handoverRequest(undefined, handoverHeaders, `${handoverPath}?force=true`),
    ]
  ) {
    const f = fixture({ who });
    await checked(await f.handle(request), 400);
    equal(f.calls, []);
    assert(!request.bodyUsed);
  }
});
Deno.test("handover verifies result operation and increased bounded lease", async () => {
  const who = { ...actor, role: "admin" as const };
  for (
    const output of [{ ...operation, operationId: id(9) }, {
      ...operation,
      leaseVersion: 1,
    }, { ...operation, leaseVersion: 9 }]
  ) {
    const f = fixture({ who, output }),
      response = await checked(await f.handle(handoverRequest()), 500);
    equal(
      (await response.json()).error.code,
      "POST_APPROVAL_ROOM_ISSUE_EVIDENCE_PROJECTION_INVALID",
    );
  }
});
Deno.test("known evidence errors preserve safe code/status and redact exception details", async () => {
  for (
    const [code, status] of [
      ["SESSION_REVOKED", 401],
      ["POST_APPROVAL_ROOM_ISSUE_MEDIA_PURGED", 410],
      ["PHOTO_STORAGE_QUOTA_UNAVAILABLE", 503],
      ["PHOTO_UPLOAD_FENCE_CONFLICT", 409],
    ] as const
  ) {
    const f = fixture({
      serviceDenial: new AppError(500, code, "private SQL locator token PIN", {
        "x-private": "secret",
      }),
    });
    const response = await checked(await f.handle(uploadRequest()), status),
      body = await response.text();
    equal(JSON.parse(body).error.code, code);
    assert(!/private SQL|locator|token|PIN|secret/.test(body));
    equal(response.headers.get("x-private"), null);
  }
});
Deno.test("unknown and throwing getter errors cannot disclose values or client request id", async () => {
  const throwing = Object.defineProperty({}, "code", {
    get() {
      throw new Error("private getter secret");
    },
  });
  for (
    const serviceDenial of [
      new Error("private token secret"),
      new AppError(409, "RAW_PROVIDER_SECRET", "private"),
      { code: "UNKNOWN_PRIVATE_ERROR", message: "private" },
      throwing,
    ]
  ) {
    const f = fixture({ serviceDenial }),
      response = await checked(
        await f.handle(
          uploadRequest({
            ...uploadHeaders,
            "x-request-id": "private-token-id",
          }),
        ),
        500,
      );
    const body = await response.text();
    assert(!/private|RAW_PROVIDER|secret/.test(body));
    assert(zeroSecretRequestId(JSON.parse(body).requestId));
  }
});
function zeroSecretRequestId(value: unknown): boolean {
  return typeof value === "string" && /^[0-9a-f-]{36}$/.test(value);
}
Deno.test("actual Edge authentication errors retain status and safe code before body", async () => {
  for (
    const [code, status] of [
      ["MISSING_ACCESS_TOKEN", 401],
      ["INVALID_ACCESS_TOKEN", 401],
      ["ACCOUNT_INACTIVE", 403],
      ["SESSION_REVOKED", 401],
    ] as const
  ) {
    const f = fixture({
      authDenial: new EdgeError(status, code, "private token canary"),
    });
    const request = uploadRequest(),
      response = await checked(await f.handle(request), status);
    const body = await response.text();
    equal(JSON.parse(body).error.code, code);
    assert(!body.includes("private"));
    assert(!request.bodyUsed);
    equal(f.calls, []);
  }
});
Deno.test("evidence handler leaves report siblings, unknown paths and HEAD to parent without authentication", async () => {
  for (
    const [path, method] of [
      [
        `/v1/cleaning-history/submissions/${
          id(3)
        }/supplemental-room-issues/source`,
        "GET",
      ],
      [uploadPath + "/unknown", "POST"],
      [statusPath, "HEAD"],
      [contentPath, "HEAD"],
      [handoverPath, "GET"],
      ["/health", "GET"],
    ]
  ) {
    const f = fixture();
    equal(
      await f.handle(
        new Request(`https://synthetic.invalid${path}`, { method }),
      ),
      null,
    );
    equal(f.events, []);
    equal(f.calls, []);
  }
});
