import { createSupabasePostApprovalModuleEdgeHandler } from "./post-approval-module-runtime.ts";
import {
  configuredPostApprovalHandoverKey,
  handleApiRequest,
} from "../api/index.ts";
import type { EdgeClients } from "./runtime.ts";

const id = (n: number) =>
  `a3360000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const token = `header.${
  btoa(JSON.stringify({ session_id: id(2) })).replace(/=/g, "")
}.signature`;
const base = `/v1/cleaning-history/submissions/${
  id(3)
}/supplemental-room-issues`;
function assert(value: unknown): asserts value {
  if (!value) throw new Error("Synthetic module assertion failed");
}
function fixture(revoked = false, options: {
  role?: string;
  status?: string;
  mustChangePassword?: boolean;
  handoverFenceKey?: Uint8Array | (() => Uint8Array | undefined);
} = {}) {
  const calls: string[] = [];
  const clients = {
    publicClient: {
      auth: {
        getUser: () => {
          calls.push("auth");
          return Promise.resolve({
            data: { user: { id: id(9) } },
            error: null,
          });
        },
      },
    },
    admin: {
      from: () => ({
        select: () => ({
          eq: () => ({
            single: () => {
              calls.push("profile");
              return Promise.resolve({
                data: {
                  id: id(1),
                  auth_user_id: id(9),
                  display_name: "synthetic",
                  role: options.role ?? "admin",
                  status: options.status ?? "active",
                  must_change_password: options.mustChangePassword ?? false,
                },
                error: null,
              });
            },
          }),
        }),
      }),
      rpc: (name: string, args: Record<string, unknown>) => {
        calls.push(name);
        assert(args.p_session_id === id(2));
        if (name === "is_active_auth_session") {
          return Promise.resolve({ data: !revoked, error: null });
        }
        if (name === "get_post_approval_room_issue_source") {
          return Promise.resolve({
            data: {
              source: {
                sourceSubmissionId: id(3),
                originalPerformerProfileId: id(1),
                sourceStatus: "approved",
              },
            },
            error: null,
          });
        }
        assert(name === "admit_post_approval_room_issue_evidence_upload");
        return Promise.resolve({
          data: null,
          error: { message: "POST_APPROVAL_ROOM_ISSUE_DRAFT_CONFLICT" },
        });
      },
    },
  } as unknown as EdgeClients;
  const handler = createSupabasePostApprovalModuleEdgeHandler({
    clients,
    provider: () => {
      throw new Error("Provider must not be contacted");
    },
    initializeDecoder: () => {
      throw new Error("Decoder must not start");
    },
    handoverFenceKey: options.handoverFenceKey ?? new Uint8Array(32).fill(7),
  });
  const dependencies = {
    createClients: () => clients,
    authenticateRequest: () => {
      throw new Error("No second authentication");
    },
    supplementalRoomIssueHandler: handler,
  };
  return { calls, clients, handler, dependencies };
}
const headers = {
  authorization: `Bearer ${token}`,
  "idempotency-key": "synthetic-key-001",
};
Deno.test("module factory joins report/evidence with actual auth and admission before body", async () => {
  const f = fixture();
  assert(f.calls.length === 0);
  const report = await handleApiRequest(
    new Request(`https://synthetic.invalid/functions/v1/api${base}/source`, {
      headers,
    }),
    f.dependencies,
  );
  assert(
    report.status === 200 && report.headers.get("cache-control") === "no-store",
  );
  const upload = new Request(
    `https://synthetic.invalid/functions/v1/api${base}/drafts/${
      id(4)
    }/evidence/${id(5)}/upload`,
    {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "image/jpeg",
        "if-draft-revision": "1",
        "if-evidence-revision": "0",
        "if-item-revision": "0",
      },
      body: new Uint8Array([1, 2, 3]),
    },
  );
  const denied = await handleApiRequest(upload, f.dependencies);
  assert(denied.status === 409 && !upload.bodyUsed);
  assert(f.calls.at(-1) === "admit_post_approval_room_issue_evidence_upload");
});
Deno.test("module revoked auth denies handover before JSON or domain RPC", async () => {
  const f = fixture(true);
  const request = new Request(
    `https://synthetic.invalid/functions/v1/api/v1/post-approval-room-issue-evidence-uploads/${
      id(5)
    }/handover`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: '{"expectedLeaseVersion":0}',
    },
  );
  const response = await handleApiRequest(request, f.dependencies);
  assert(response.status === 401 && !request.bodyUsed && f.calls.length === 3);
});
Deno.test("parent preflight and CORS cover evidence CAS headers and safe report errors", async () => {
  const previous = Deno.env.get("CORS_ORIGINS");
  const origin = "https://synthetic.invalid";
  Deno.env.set("CORS_ORIGINS", origin);
  try {
    const f = fixture(true);
    const preflight = await handleApiRequest(
      new Request(`https://synthetic.invalid/functions/v1/api${base}`, {
        method: "OPTIONS",
        headers: { origin },
      }),
      f.dependencies,
    );
    assert(preflight.status === 204 && f.calls.length === 0);
    const allowed = preflight.headers.get("access-control-allow-headers") ?? "";
    assert(
      ["if-draft-revision", "if-evidence-revision", "if-item-revision"].every(
        (name) => allowed.split(",").includes(name),
      ),
    );
    const response = await handleApiRequest(
      new Request(`https://synthetic.invalid/functions/v1/api${base}/source`, {
        headers: { ...headers, origin },
      }),
      f.dependencies,
    );
    assert(
      response.status === 401 &&
        response.headers.get("access-control-allow-origin") === origin &&
        response.headers.get("cache-control") === "no-store",
    );
  } finally {
    if (previous === undefined) Deno.env.delete("CORS_ORIGINS");
    else Deno.env.set("CORS_ORIGINS", previous);
  }
});

Deno.test("formal default uses generated module with latest active admin auth, not original maid photo auth", async () => {
  for (const role of ["admin", "maid"]) {
    const f = fixture(false, { role });
    const response = await handleApiRequest(
      new Request(
        `https://synthetic.invalid/functions/v1/api${base}/source`,
        { headers },
      ),
      {
        createClients: () => f.clients,
        authenticateRequest: () => {
          throw new Error("Original parent authentication must not be reused");
        },
      },
    );
    assert(response.status === 200);
    assert(
      f.calls.join(",") ===
        "auth,profile,is_active_auth_session,get_post_approval_room_issue_source",
    );
  }
});

Deno.test("formal #336 aliases and methods stop before auth, body and module construction", async () => {
  const upload = `${base}/drafts/${id(4)}/evidence/${id(5)}/upload`;
  const operations = `/v1/post-approval-room-issue-evidence-uploads/${id(5)}`;
  const content = `/v1/post-approval-room-issue-evidence/${
    id(5)
  }/versions/1/content`;
  const cases: Array<[string, string]> = [
    ["GET", `${base}/source/`],
    ["GET", `${base}//source`],
    ["GET", `${base.replace("supplemental", "%73upplemental")}/source`],
    ["GET", `${base}/%73ource`],
    ["HEAD", `${base}/source`],
    ["PUT", base],
    ["DELETE", base],
    ["GET", `${base}/drafts`],
    ["GET", `${base}/source/extra`],
    ["POST", `${base}/drafts/close`],
    ["GET", upload],
    ["HEAD", content],
    ["POST", content],
    ["GET", `${content}/`],
    ["GET", content.replace("/versions/", "//versions/")],
    ["GET", operations.replace("evidence-uploads", "%65vidence-uploads")],
    ["GET", `${operations}/`],
    ["POST", operations],
    ["GET", `${operations}/handover`],
    ["HEAD", operations],
  ];
  for (const [method, path] of cases) {
    const f = fixture();
    const request = new Request(
      `https://synthetic.invalid/functions/v1/api${path}`,
      {
        method,
        headers,
        ...(method === "POST" || method === "PUT" || method === "DELETE"
          ? { body: "{}" }
          : {}),
      },
    );
    const response = await handleApiRequest(request, f.dependencies);
    assert(
      response.status === 404 &&
        response.headers.get("cache-control") === "no-store",
    );
    assert((await response.json()).error.code === "ROUTE_NOT_FOUND");
    assert(!request.bodyUsed && f.calls.length === 0);
  }
  const encodedMount = new Request(
    `https://synthetic.invalid/functions/v1/%61pi${base}/source`,
    { headers },
  );
  const f = fixture();
  const denied = await handleApiRequest(encodedMount, f.dependencies);
  assert(
    denied.status === 404 && denied.headers.get("cache-control") === "no-store",
  );
  assert(f.calls.length === 0);
});

Deno.test("missing or invalid recovery key is lazy 503 after auth and valid body, never domain RPC/provider", async () => {
  for (
    const handoverFenceKey of [() => undefined, new Uint8Array(31), () => {
      throw new Error("private config");
    }]
  ) {
    const f = fixture(false, { handoverFenceKey });
    const source = await handleApiRequest(
      new Request(
        `https://synthetic.invalid/functions/v1/api${base}/source`,
        { headers },
      ),
      f.dependencies,
    );
    assert(source.status === 200);
    f.calls.length = 0;
    const request = new Request(
      `https://synthetic.invalid/functions/v1/api/v1/post-approval-room-issue-evidence-uploads/${
        id(5)
      }/handover`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ expectedLeaseVersion: 0 }),
      },
    );
    const response = await handleApiRequest(request, f.dependencies);
    const body = await response.json();
    assert(
      response.status === 503 &&
        body.error.code === "POST_APPROVAL_ROOM_ISSUE_EVIDENCE_RETRY_REQUIRED",
    );
    assert(f.calls.join(",") === "auth,profile,is_active_auth_session");
    assert(!JSON.stringify(body).includes("private config"));
  }
  const env = "POST_APPROVAL_ROOM_ISSUE_HANDOVER_KEY_BASE64";
  const previous = Deno.env.get(env);
  try {
    for (const encoded of [undefined, "invalid-synthetic-configuration"]) {
      if (encoded === undefined) Deno.env.delete(env);
      else Deno.env.set(env, encoded);
      const f = fixture();
      const request = new Request(
        `https://synthetic.invalid/functions/v1/api/v1/post-approval-room-issue-evidence-uploads/${
          id(5)
        }/handover`,
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ expectedLeaseVersion: 0 }),
        },
      );
      const response = await handleApiRequest(request, {
        createClients: () => f.clients,
        authenticateRequest: () => {
          throw new Error("No parent auth");
        },
      });
      assert(
        response.status === 503 &&
          (await response.json()).error.code ===
            "POST_APPROVAL_ROOM_ISSUE_EVIDENCE_RETRY_REQUIRED",
      );
      assert(f.calls.join(",") === "auth,profile,is_active_auth_session");
    }
  } finally {
    if (previous === undefined) Deno.env.delete(env);
    else Deno.env.set(env, previous);
  }
});

Deno.test("recovery authentication, role and input errors precede the lazy key check", async () => {
  for (
    const options of [
      { revoked: true, role: "admin", body: "{}", status: 401 },
      { revoked: false, role: "maid", body: "{}", status: 403 },
      { revoked: false, role: "admin", body: "{}", status: 400 },
    ]
  ) {
    let keyReads = 0;
    const f = fixture(options.revoked, {
      role: options.role,
      handoverFenceKey: () => {
        keyReads++;
        return undefined;
      },
    });
    const request = new Request(
      `https://synthetic.invalid/functions/v1/api/v1/post-approval-room-issue-evidence-uploads/${
        id(5)
      }/handover`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: options.body,
      },
    );
    const response = await handleApiRequest(request, f.dependencies);
    assert(response.status === options.status && keyReads === 0);
    assert(!f.calls.some((name) => name.startsWith("handover_")));
    if (options.status !== 400) assert(!request.bodyUsed);
  }
});

Deno.test("health docs and preflight do not create clients or inspect recovery keys/providers", async () => {
  for (
    const [method, path] of [["GET", "/health"], ["GET", "/docs"], [
      "GET",
      "/openapi.json",
    ], ["OPTIONS", `${base}/source`]]
  ) {
    const response = await handleApiRequest(
      new Request(`https://synthetic.invalid/functions/v1/api${path}`, {
        method,
      }),
      {
        createClients: () => {
          throw new Error("No clients on public routes");
        },
        authenticateRequest: () => {
          throw new Error("No auth on public routes");
        },
        supplementalRoomIssueHandler: () => {
          throw new Error("No module on public routes");
        },
      },
    );
    assert(response.status === (method === "OPTIONS" ? 204 : 200));
  }
});

Deno.test("dedicated recovery env key accepts canonical32 only and rejects reused current/prior material", () => {
  const env = "POST_APPROVAL_ROOM_ISSUE_HANDOVER_KEY_BASE64";
  const encoded = btoa(String.fromCharCode(...new Uint8Array(32).fill(173)));
  const names = [env, "ROOM_PIN_KEY_BASE64", "ROOM_PIN_KEYRING_JSON"];
  const previous = names.map((name) => Deno.env.get(name));
  try {
    for (
      const value of [
        undefined,
        "",
        "bad",
        encoded.slice(0, -1),
        `${encoded}\n`,
        btoa("short"),
      ]
    ) {
      if (value === undefined) Deno.env.delete(env);
      else Deno.env.set(env, value);
      assert(configuredPostApprovalHandoverKey() === undefined);
    }
    Deno.env.set(env, encoded);
    Deno.env.delete("ROOM_PIN_KEY_BASE64");
    Deno.env.set("ROOM_PIN_KEYRING_JSON", "{}");
    assert(configuredPostApprovalHandoverKey()?.byteLength === 32);
    Deno.env.set("ROOM_PIN_KEY_BASE64", encoded);
    assert(configuredPostApprovalHandoverKey() === undefined);
    Deno.env.delete("ROOM_PIN_KEY_BASE64");
    Deno.env.set(
      "ROOM_PIN_KEYRING_JSON",
      JSON.stringify({ previous: encoded }),
    );
    assert(configuredPostApprovalHandoverKey() === undefined);
  } finally {
    names.forEach((name, index) => {
      const value = previous[index];
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    });
  }
});
