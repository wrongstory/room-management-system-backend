import {
  registerWebPushSubscription,
  retireWebPushSubscription,
  webPushRetirePath,
} from "./web-push-subscription-api.ts";

function assert(value: unknown): asserts value {
  if (!value) throw new Error("assertion failed");
}

const ids = {
  profile: "11000000-0000-4000-8000-000000000001",
  session: "11000000-0000-4000-8000-000000000901",
  subscription: "11000000-0000-4000-8000-000000001001",
};
const actor = {
  authUserId: "11000000-0000-4000-8000-000000000101",
  profileId: ids.profile,
  displayName: "push maid",
  role: "maid" as const,
  mustChangePassword: false,
};
function b64u(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(
    /\+/g,
    "-",
  ).replace(/\//g, "_");
}
function token(sessionId = ids.session) {
  const body = b64u(
    new TextEncoder().encode(JSON.stringify({ session_id: sessionId })),
  );
  return `e30.${body}.x`;
}
async function subscription() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const point = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  return {
    endpoint: "https://push.example.invalid/send/capability",
    expirationTime: null,
    keys: { p256dh: b64u(point), auth: b64u(new Uint8Array(16).fill(7)) },
  };
}
function request(
  path: string,
  body: unknown,
  key = "push-edge-0001",
  sessionId = ids.session,
) {
  return new Request(`http://localhost/functions/v1/api${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token(sessionId)}`,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify(body),
  });
}
function env() {
  Deno.env.set(
    "WEB_PUSH_SUBSCRIPTION_KEY_BASE64",
    btoa(String.fromCharCode(...new Uint8Array(32).fill(4))),
  );
  Deno.env.set("WEB_PUSH_SUBSCRIPTION_KEY_VERSION", "v1");
  Deno.env.set("WEB_PUSH_SUBSCRIPTION_KEYRING_JSON", "{}");
  Deno.env.set(
    "WEB_PUSH_BINDING_DIGEST_SECRET",
    "web-push-edge-binding-secret-123456789",
  );
}

Deno.test("Edge Web Push register encrypts before RPC and projects no raw material", async () => {
  env();
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const clients = {
    admin: {
      rpc: (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return Promise.resolve({
          data: {
            id: ids.subscription,
            version: 1,
            status: "active",
            createdAt: "2026-09-11T05:00:00Z",
            updatedAt: "2026-09-11T05:00:00Z",
            retiredAt: null,
          },
          error: null,
        });
      },
    },
  } as never;
  const input = await subscription();
  const result = await registerWebPushSubscription(
    request("/v1/push-subscriptions", { subscription: input }),
    clients,
    actor,
  );
  assert(
    (result as { subscription: { id: string } }).subscription.id ===
      ids.subscription,
  );
  assert(calls[0]?.name === "register_web_push_subscription");
  const serialized = JSON.stringify(calls[0]?.args);
  assert(!serialized.includes(input.endpoint));
  assert(!serialized.includes(input.keys.p256dh));
  assert(!serialized.includes(input.keys.auth));
  const rpcArgs = calls[0]?.args;
  assert(rpcArgs);
  assert((rpcArgs.p_nonce_base64 as string).length === 16);
  assert((rpcArgs.p_auth_tag_base64 as string).length === 24);
});

Deno.test("Edge Web Push matches the shared Node/Deno canonical identity and encryption vector", async () => {
  const vectorIds = {
    profile: "A1000000-0000-4000-8000-00000000000A",
    session: "B1000000-0000-4000-8000-00000000000B",
    subscription: "C1000000-0000-4000-8000-00000000000C",
  };
  const input = {
    endpoint: "https://PUSH.Example.Invalid:443/send/%2Fopaque?b=2&a=%2F",
    expirationTime: null,
    keys: {
      p256dh:
        "BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU",
      auth: "BwcHBwcHBwcHBwcHBwcHBw",
    },
  };
  const cfg = {
    key: new Uint8Array(32).fill(4),
    version: "v2",
    secret: "web-push-binding-test-secret-123456789",
    nonce: new Uint8Array([...Array(12).keys()]),
  };
  let rpcArgs: Record<string, unknown> | undefined;
  const clients = {
    admin: {
      rpc: (_name: string, args: Record<string, unknown>) => {
        rpcArgs = args;
        return Promise.resolve({
          data: {
            id: vectorIds.subscription.toLowerCase(),
            version: 2,
            status: "active",
            createdAt: "2026-09-11T05:00:00+09:00",
            updatedAt: "2026-09-11T05:01:00Z",
            retiredAt: null,
          },
          error: null,
        });
      },
    },
  } as never;
  await registerWebPushSubscription(
    request(
      "/v1/push-subscriptions",
      {
        subscription: input,
        expectedCurrent: {
          subscriptionId: vectorIds.subscription,
          version: 1,
        },
      },
      "push-vector-0001",
      vectorIds.session,
    ),
    clients,
    { ...actor, profileId: vectorIds.profile },
    cfg,
  );
  assert(rpcArgs);
  assert(rpcArgs.p_actor_profile_id === vectorIds.profile.toLowerCase());
  assert(rpcArgs.p_session_id === vectorIds.session.toLowerCase());
  assert(
    rpcArgs.p_expected_subscription_id === vectorIds.subscription.toLowerCase(),
  );
  assert(
    rpcArgs.p_proposed_subscription_id === vectorIds.subscription.toLowerCase(),
  );
  assert(
    rpcArgs.p_endpoint_digest ===
      "2fe510b0721dfd9416ab10f1796e4e6f0d80d9eb01a65ff94227ff030d42dd04",
  );
  assert(
    rpcArgs.p_session_digest ===
      "ad62c364ce8addd4bcf1907f41d66dc40f72310efd8174c5b63a9409a00a9a93",
  );
  assert(
    rpcArgs.p_material_digest ===
      "c08827336099b39bb92bd93ce466377eaa11712cc50f7539b7a8dfa5d4a58714",
  );
  assert(
    rpcArgs.p_request_hash ===
      "f16d690cfc7680c506117970f4534a9e5b5f74f96977bc8c203d6beb2e0072ed",
  );
  assert(
    rpcArgs.p_ciphertext_base64 ===
      "QKZyBOAIcKJ15U/1CBgEkJPN2MKesgrJzlZmAAMWi9XJTjdMQ3SgkdDR/Mk2zQtLGCKAFkaEp/vBj2cZ4AhLTmF8LBUfQ4KN4vI0IkeKmoqk2mKDmqEpLLAUH7UG9ostoBCSfaSGAWhqZyqnx9TQYJDuP+he1iQECM0k+M77Qxx6kW7UJRO7kNKj0LaAsCZkKCMRJGCo9GnSWlPMV7r92GJxcHjtzojdgCCZcFcKomlJ7qeOYDwvmX/q5Ld+D1WaMwoV8KmlhmilUfbUNki1tJOpHzyqKWI+zinuAJVtJFubhHrJ3p+4BfMnCjR+DON89cbf4Yqg1iADgkmK7oNwEX8jyIqjlDup0uOr4V8OdLA=",
  );
  assert(rpcArgs.p_auth_tag_base64 === "z2dR/v7MHCXYiNtRehTrOA==");
  const cipher = Uint8Array.from(
    atob(rpcArgs.p_ciphertext_base64 as string),
    (c) => c.charCodeAt(0),
  );
  const tag = Uint8Array.from(
    atob(rpcArgs.p_auth_tag_base64 as string),
    (c) => c.charCodeAt(0),
  );
  const aad = new TextEncoder().encode(
    `web-push-envelope:v1\0${vectorIds.profile.toLowerCase()}\0${rpcArgs.p_session_digest}\0${rpcArgs.p_endpoint_digest}\0${vectorIds.subscription.toLowerCase()}\0${2}`,
  );
  const key = await crypto.subtle.importKey("raw", cfg.key, "AES-GCM", false, [
    "decrypt",
  ]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: cfg.nonce, additionalData: aad, tagLength: 128 },
    key,
    new Uint8Array([...cipher, ...tag]),
  );
  const parsed = JSON.parse(new TextDecoder().decode(plaintext));
  assert(
    parsed.endpoint === "https://push.example.invalid/send/%2Fopaque?b=2&a=%2F",
  );
  assert(parsed.sessionId === vectorIds.session.toLowerCase());
});

Deno.test("Edge Web Push rejects credentials, fragments and raw/canonical endpoint overflow", async () => {
  env();
  const input = await subscription();
  let calls = 0;
  const clients = {
    admin: {
      rpc: () => {
        calls += 1;
        return Promise.resolve({ data: null, error: null });
      },
    },
  } as never;
  for (
    const endpoint of [
      "https://@push.example.invalid/send/capability",
      "https://push.example.invalid/send/capability#",
      `https://push.example.invalid/${"x".repeat(4096)}`,
      `https://push.example.invalid/${" ".repeat(4000)}x`,
    ]
  ) {
    let rejected = false;
    try {
      await registerWebPushSubscription(
        request("/v1/push-subscriptions", {
          subscription: { ...input, endpoint },
        }),
        clients,
        actor,
      );
    } catch {
      rejected = true;
    }
    assert(rejected);
  }
  assert(calls === 0);
});

Deno.test("Edge Web Push strict inputs reject query, past expiry, malformed keys and developer", async () => {
  env();
  const clients = {
    admin: { rpc: () => Promise.resolve({ data: null, error: null }) },
  } as never;
  const input = await subscription();
  for (
    const [req, who] of [[
      request("/v1/push-subscriptions?x=1", { subscription: input }),
      actor,
    ], [
      request("/v1/push-subscriptions", {
        subscription: { ...input, expirationTime: Date.now() - 1 },
      }),
      actor,
    ], [
      request("/v1/push-subscriptions", {
        subscription: {
          ...input,
          keys: { ...input.keys, auth: `${input.keys.auth}=` },
        },
      }),
      actor,
    ], [request("/v1/push-subscriptions", { subscription: input }), {
      ...actor,
      role: "developer" as const,
    }]] as const
  ) {
    let failed = false;
    try {
      await registerWebPushSubscription(req, clients, who);
    } catch {
      failed = true;
    }
    assert(failed);
  }
});

Deno.test("Edge Web Push retire uses exact path, CAS body, idempotency and session", async () => {
  env();
  const calls: Array<Record<string, unknown>> = [];
  const clients = {
    admin: {
      rpc: (_name: string, args: Record<string, unknown>) => {
        calls.push(args);
        return Promise.resolve({
          data: {
            id: ids.subscription,
            version: 2,
            status: "retired",
            createdAt: "2026-09-11T05:00:00Z",
            updatedAt: "2026-09-11T05:01:00Z",
            retiredAt: "2026-09-11T05:01:00Z",
          },
          error: null,
        });
      },
    },
  } as never;
  assert(
    webPushRetirePath(`/v1/push-subscriptions/${ids.subscription}/retire`) ===
      ids.subscription,
  );
  assert(
    webPushRetirePath(
      `/v1/push-subscriptions/${ids.subscription}/retire/extra`,
    ) === null,
  );
  const result = await retireWebPushSubscription(
    request(`/v1/push-subscriptions/${ids.subscription}/retire`, {
      expectedVersion: 1,
    }, "push-retire-0001"),
    clients,
    actor,
    ids.subscription,
  );
  assert(
    (result as { subscription: { status: string } }).subscription.status ===
      "retired",
  );
  assert(calls[0]?.p_session_id === ids.session);
  assert(calls[0]?.p_expected_version === 1);
});

Deno.test("Edge Web Push projection rejects invalid RFC3339 timestamps without raw detail", async () => {
  const input = await subscription();
  for (
    const data of [
      {
        id: ids.subscription,
        version: 1,
        status: "active",
        createdAt: "2026-02-30T05:00:00Z",
        updatedAt: "2026-09-11T05:00:00Z",
        retiredAt: null,
      },
      {
        id: ids.subscription,
        version: 1,
        status: "active",
        createdAt: "2026-09-11T05:00:00",
        updatedAt: "2026-09-11T05:00:00Z",
        retiredAt: null,
      },
      {
        id: ids.subscription,
        version: 1,
        status: "active",
        createdAt: "2026-09-11T05:00:00Z",
        updatedAt: "2026-09-11T05:00:60Z",
        retiredAt: null,
      },
      {
        id: ids.subscription,
        version: 1,
        status: "active",
        createdAt: "2026-09-11T05:00:00Z",
        updatedAt: "2026-09-11T05:00:00Z",
        retiredAt: null,
        raw: "forbidden",
      },
    ]
  ) {
    let caught:
      | { status?: number; code?: string; message?: string }
      | undefined;
    try {
      await registerWebPushSubscription(
        request("/v1/push-subscriptions", { subscription: input }),
        {
          admin: { rpc: () => Promise.resolve({ data, error: null }) },
        } as never,
        actor,
        {
          key: new Uint8Array(32).fill(4),
          version: "v1",
          secret: "web-push-edge-binding-secret-123456789",
        },
      );
    } catch (error) {
      caught = error as typeof caught;
    }
    assert(caught?.status === 500);
    assert(caught.code === "WEB_PUSH_COMMAND_FAILED");
    assert(caught.message === "Web Push 구독을 처리하지 못했습니다.");
  }
});

Deno.test("Edge Web Push config fails closed on short or reused secrets", async () => {
  env();
  const input = await subscription();
  const clients = {
    admin: { rpc: () => Promise.resolve({ data: null, error: null }) },
  } as never;
  Deno.env.set("WEB_PUSH_BINDING_DIGEST_SECRET", "short");
  let short = false;
  try {
    await registerWebPushSubscription(
      request("/v1/push-subscriptions", { subscription: input }),
      clients,
      actor,
    );
  } catch {
    short = true;
  }
  assert(short);
  env();
  Deno.env.set(
    "NOTIFICATION_CURSOR_HMAC_SECRET",
    Deno.env.get("WEB_PUSH_BINDING_DIGEST_SECRET") ?? "",
  );
  let reused = false;
  try {
    await registerWebPushSubscription(
      request("/v1/push-subscriptions", { subscription: input }),
      clients,
      actor,
    );
  } catch {
    reused = true;
  }
  assert(reused);
  Deno.env.delete("NOTIFICATION_CURSOR_HMAC_SECRET");
  env();
  Deno.env.set(
    "WEB_PUSH_BINDING_DIGEST_SECRET",
    Deno.env.get("WEB_PUSH_SUBSCRIPTION_KEY_BASE64") ?? "",
  );
  let sameCurrentSecrets = false;
  try {
    await registerWebPushSubscription(
      request("/v1/push-subscriptions", { subscription: input }),
      clients,
      actor,
    );
  } catch {
    sameCurrentSecrets = true;
  }
  assert(sameCurrentSecrets);
  env();
  Deno.env.set(
    "WEB_PUSH_SUBSCRIPTION_KEYRING_JSON",
    JSON.stringify({
      v1: btoa(String.fromCharCode(...new Uint8Array(32).fill(5))),
    }),
  );
  let duplicateVersion = false;
  try {
    await registerWebPushSubscription(
      request("/v1/push-subscriptions", { subscription: input }),
      clients,
      actor,
    );
  } catch {
    duplicateVersion = true;
  }
  assert(duplicateVersion);
});
