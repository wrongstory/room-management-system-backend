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
function token() {
  const body = b64u(
    new TextEncoder().encode(JSON.stringify({ session_id: ids.session })),
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
function request(path: string, body: unknown, key = "push-edge-0001") {
  return new Request(`http://localhost/functions/v1/api${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token()}`,
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

Deno.test("Edge Web Push rejects syntactically empty credentials and fragments", async () => {
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
