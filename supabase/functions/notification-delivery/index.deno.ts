import {
  handleNotificationDelivery,
  notificationDeliveryConfig,
} from "./index.ts";
const assert = (value: boolean, message = "assertion failed") => {
  if (!value) throw new Error(message);
};
const secret = "notification-delivery-invoke-test-secret-123456";
const config = {
  invokeSecret: secret,
  envelope: {
    currentVersion: "v1",
    currentKey: new Uint8Array(32),
    keyring: {},
  },
  vapid: {
    subject: "mailto:push@example.com",
    currentVersion: "v1",
    current: { publicKey: "x", privateKey: "y" },
    keyring: {},
  },
};
const request = (method = "POST", suffix = "", body?: string, given = secret) =>
  new Request(`http://localhost/functions/v1/notification-delivery${suffix}`, {
    method,
    headers: {
      "x-notification-delivery-invoke-secret": given,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body,
  });
Deno.test("notification delivery Edge rejects method, query, body and bad secret before worker", async () => {
  let runs = 0;
  const dependencies = {
    loadInvokeSecret: () => secret,
    loadConfig: () => config,
    validateConfig: () => Promise.resolve(),
    run: async () => {
      runs++;
      return {
        claimed: 0,
        delivered: 0,
        retrying: 0,
        suppressed: 0,
        deadLetter: 0,
        blocked: 0,
        deferred: 0,
      };
    },
  };
  assert(
    (await handleNotificationDelivery(request("GET"), dependencies)).status ===
      404,
  );
  assert(
    (await handleNotificationDelivery(request("POST", "?x=1"), dependencies))
      .status === 404,
  );
  assert(
    (await handleNotificationDelivery(
      new Request("http://localhost/notification-delivery", {
        method: "POST",
        headers: { "x-notification-delivery-invoke-secret": secret },
      }),
      dependencies,
    )).status === 404,
  );
  assert(
    (await handleNotificationDelivery(request("POST", "", "{}"), dependencies))
      .status === 400,
  );
  let declaredEmptyPulls = 0;
  const declaredEmpty = new Request(
    "http://localhost/functions/v1/notification-delivery",
    {
      method: "POST",
      headers: {
        "x-notification-delivery-invoke-secret": secret,
        "content-length": "0",
      },
      body: new ReadableStream({
        pull() {
          declaredEmptyPulls++;
        },
      }),
    },
  );
  await Promise.resolve();
  const declaredEmptyPullsBeforeHandler = declaredEmptyPulls;
  assert(
    (await handleNotificationDelivery(declaredEmpty, dependencies)).status ===
        400 && declaredEmptyPulls === declaredEmptyPullsBeforeHandler,
    "Content-Length: 0 cannot hide a non-null body and body is not read",
  );
  await declaredEmpty.body?.cancel();
  assert(
    (await handleNotificationDelivery(
      request("POST", "", undefined, "wrong-secret-that-is-long-enough-000"),
      dependencies,
    )).status === 401,
  );
  let pulled = 0;
  const oversizedChunked = new Request(
    "http://localhost/functions/v1/notification-delivery",
    {
      method: "POST",
      headers: { "x-notification-delivery-invoke-secret": secret },
      body: new ReadableStream({
        pull(controller) {
          pulled++;
          controller.enqueue(new Uint8Array(1024 * 1024));
        },
      }),
    },
  );
  await Promise.resolve();
  const pullsBeforeHandler = pulled;
  const oversizedResponse = await handleNotificationDelivery(
    oversizedChunked,
    dependencies,
  );
  assert(
    oversizedResponse.status === 400 && pulled === pullsBeforeHandler,
    "chunked request must be rejected without reading more body bytes",
  );
  await oversizedChunked.body?.cancel();
  assert(!(await oversizedResponse.text()).includes(secret));
  assert(runs === 0);
});
Deno.test("notification delivery Edge accepts the distinct invoke secret and returns bounded aggregate only", async () => {
  const response = await handleNotificationDelivery(request(), {
    loadInvokeSecret: () => secret,
    loadConfig: () => config,
    validateConfig: () => Promise.resolve(),
    run: async () => ({
      claimed: 1,
      delivered: 1,
      retrying: 0,
      suppressed: 0,
      deadLetter: 0,
      blocked: 0,
      deferred: 0,
    }),
  });
  const body = await response.json();
  assert(
    response.status === 200 &&
      response.headers.get("cache-control") === "no-store",
  );
  assert(
    body.claimed === 1 && body.delivered === 1 &&
      typeof body.requestId === "string",
  );
  assert(!JSON.stringify(body).includes(secret));
});
Deno.test("notification delivery Edge durably degrades invalid provider config without leaking detail", async () => {
  let recorded = 0, runs = 0;
  const raw = "private-key endpoint raw-provider-error";
  const response = await handleNotificationDelivery(request(), {
    loadInvokeSecret: () => secret,
    loadConfig: () => config,
    validateConfig: () => Promise.reject(new Error(raw)),
    recordConfigurationFailure: () => {
      recorded++;
      return Promise.resolve();
    },
    run: async () => {
      runs++;
      return {};
    },
  });
  const body = await response.text();
  assert(response.status === 503 && recorded === 1 && runs === 0);
  assert(!body.includes(raw) && !body.includes(secret));
});
Deno.test("notification delivery Edge fails closed when Function Secrets are missing", async () => {
  const response = await handleNotificationDelivery(request(), {
    loadInvokeSecret: () => {
      throw new Error("missing raw secret");
    },
  });
  assert(response.status === 503);
  assert(!(await response.text()).includes("missing raw secret"));
});

Deno.test("notification delivery config requires exact bounded public/private VAPID keyring identity", async () => {
  const pair = async () => {
    const value = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const jwk = await crypto.subtle.exportKey("jwk", value.privateKey);
    const raw = new Uint8Array(
      await crypto.subtle.exportKey("raw", value.publicKey),
    );
    return {
      publicKey: btoa(String.fromCharCode(...raw)).replace(/=/g, "").replace(
        /\+/g,
        "-",
      ).replace(/\//g, "_"),
      privateKey: String(jwk.d),
    };
  };
  const current = await pair(), prior = await pair();
  Deno.env.set(
    "NOTIFICATION_DELIVERY_INVOKE_SECRET",
    "invoke-secret-for-config-ring-test-123456",
  );
  Deno.env.set(
    "SUPABASE_SERVICE_ROLE_KEY",
    "service-role-for-config-ring-test-123456",
  );
  Deno.env.set(
    "WEB_PUSH_BINDING_DIGEST_SECRET",
    "binding-digest-for-config-ring-test-123456",
  );
  Deno.env.set(
    "WEB_PUSH_SUBSCRIPTION_KEY_BASE64",
    btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
  );
  Deno.env.set("WEB_PUSH_SUBSCRIPTION_KEY_VERSION", "envelope-v1");
  Deno.env.set("WEB_PUSH_SUBSCRIPTION_KEYRING_JSON", "{}");
  Deno.env.set("VAPID_SUBJECT", "mailto:push@example.com");
  Deno.env.set("VAPID_CURRENT_KEY_VERSION", "vapid-v2");
  Deno.env.set("VAPID_PUBLIC_KEY", current.publicKey);
  Deno.env.set("VAPID_PRIVATE_KEY", current.privateKey);
  Deno.env.set("VAPID_KEYRING_JSON", JSON.stringify({ "vapid-v1": prior }));
  Deno.env.set(
    "VAPID_PUBLIC_KEYRING_JSON",
    JSON.stringify({ "vapid-v1": prior.publicKey }),
  );
  assert(
    notificationDeliveryConfig().vapid.keyring["vapid-v1"]?.publicKey ===
      prior.publicKey,
  );
  for (
    const invalidPublicRing of [
      {},
      { "vapid-v1": current.publicKey },
      { "vapid-v1": prior.publicKey, extra: prior.publicKey },
    ]
  ) {
    Deno.env.set(
      "VAPID_PUBLIC_KEYRING_JSON",
      JSON.stringify(invalidPublicRing),
    );
    let rejected = false;
    try {
      notificationDeliveryConfig();
    } catch {
      rejected = true;
    }
    assert(rejected, "public/private ring drift must fail closed");
  }
  Deno.env.set(
    "VAPID_PUBLIC_KEYRING_JSON",
    JSON.stringify({
      "vapid-v1": prior.publicKey,
    }),
  );
  const malformedPriorKey = btoa(
    String.fromCharCode(...new Uint8Array(31).fill(9)),
  );
  Deno.env.set(
    "WEB_PUSH_SUBSCRIPTION_KEYRING_JSON",
    JSON.stringify({ "envelope-v0": malformedPriorKey }),
  );
  let rejected = false;
  try {
    notificationDeliveryConfig();
  } catch {
    rejected = true;
  }
  assert(rejected, "prior envelope keys must decode to exactly 32 bytes");

  let recorded = 0;
  const response = await handleNotificationDelivery(request(), {
    loadInvokeSecret: () => secret,
    loadConfig: notificationDeliveryConfig,
    recordConfigurationFailure: () => {
      recorded++;
      return Promise.resolve();
    },
  });
  const body = await response.text();
  assert(response.status === 503 && recorded === 1);
  assert(!body.includes(malformedPriorKey) && !body.includes(secret));
});
