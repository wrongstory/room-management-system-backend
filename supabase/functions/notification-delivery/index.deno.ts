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
Deno.test("notification delivery signed mode rejects replay expiry, cross purpose and downgrade before worker", async () => {
  const now = 1792890000000;
  let runs = 0, loads = 0;
  const deps = {
    loadInvokeSecret: () => secret,
    loadInvokeMode: () => "signed-v1",
    nowMs: () => now,
    loadConfig: () => {
      loads++;
      return config;
    },
    validateConfig: () => Promise.resolve(),
    run: async () => {
      runs++;
      return { claimed: 0 };
    },
  };
  const signed = async (
    audience = "notification-delivery:aodikrxcczbogjpsjwjt",
    ageSeconds = 0,
  ) => {
    const at = String(Math.floor(now / 1000) - ageSeconds),
      nonce = "ab".repeat(16);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(
          `rms-scheduled-invocation-v1\n${audience}\n${at}\n${nonce}\nPOST`,
        ),
      ),
    );
    return new Headers({
      "x-rms-invoke-at": at,
      "x-rms-invoke-nonce": nonce,
      "x-rms-invoke-signature": [...signature].map((value) =>
        value.toString(16).padStart(2, "0")
      ).join(""),
    });
  };
  const invoke = (headers: Headers, body?: string) =>
    handleNotificationDelivery(
      new Request(
        "https://example.test/functions/v1/notification-delivery",
        { method: "POST", headers, body },
      ),
      deps,
    );
  assert((await invoke(await signed())).status === 200);
  for (
    const headers of [
      await signed(undefined, 60),
      await signed(undefined, -6),
      await signed("reservation-backup-monitor:matalcofimnhuzslfhdd"),
      new Headers(),
    ]
  ) {
    assert((await invoke(headers)).status === 401);
  }
  const downgraded = await signed();
  downgraded.set("x-notification-delivery-invoke-secret", secret);
  assert((await invoke(downgraded)).status === 401);
  assert((await handleNotificationDelivery(request(), deps)).status === 401);
  assert((await invoke(await signed(), "{}")).status === 400);
  assert(
    (await handleNotificationDelivery(request(), {
      ...deps,
      loadInvokeMode: () => "typo",
    })).status === 503,
  );
  assert(runs === 1 && loads === 1);
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
      new Request("http://localhost/notification-delivery/", {
        method: "POST",
        headers: { "x-notification-delivery-invoke-secret": secret },
      }),
      dependencies,
    )).status === 404,
  );
  for (
    const url of [
      "http://localhost/notification-delivery/extra",
      "http://localhost/notification-delivery?alias=1",
    ]
  ) {
    assert(
      (await handleNotificationDelivery(
        new Request(url, {
          method: "POST",
          headers: { "x-notification-delivery-invoke-secret": secret },
        }),
        dependencies,
      )).status === 404,
      "runtime path aliases must remain unavailable",
    );
  }
  assert(
    (await handleNotificationDelivery(request("POST", "", "{}"), dependencies))
      .status === 400,
  );
  const declaredEmpty = new Request(
    "http://localhost/functions/v1/notification-delivery",
    {
      method: "POST",
      headers: {
        "x-notification-delivery-invoke-secret": secret,
        "content-length": "0",
      },
      body: "",
    },
  );
  assert(
    (await handleNotificationDelivery(declaredEmpty, dependencies)).status ===
      200,
    "hosted-style zero-byte streams must remain valid empty requests",
  );
  assert(runs === 1, "hosted-style empty request must invoke the worker once");
  assert(
    (await handleNotificationDelivery(
      new Request("http://localhost/functions/v1/notification-delivery", {
        method: "POST",
        headers: {
          "x-notification-delivery-invoke-secret": secret,
          "content-length": "0",
        },
        body: "{}",
      }),
      dependencies,
    )).status === 400,
    "Content-Length: 0 cannot hide actual body bytes",
  );
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
    oversizedResponse.status === 400 && pulled <= pullsBeforeHandler + 1,
    "chunked request must be rejected after at most one non-empty chunk",
  );
  await oversizedChunked.body?.cancel();
  assert(!(await oversizedResponse.text()).includes(secret));
  assert(runs === 1);
});
Deno.test("notification delivery authenticates before bounded body inspection", async () => {
  let configLoads = 0;
  let runs = 0;
  const neverEndingBody = () =>
    new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
    });
  const invalidRequest = new Request(
    "http://localhost/functions/v1/notification-delivery",
    {
      method: "POST",
      headers: {
        "x-notification-delivery-invoke-secret":
          "wrong-secret-that-is-long-enough-000",
      },
      body: neverEndingBody(),
    },
  );
  let invalidTimeoutId: number | undefined;
  const invalidSecretResponse = await Promise.race([
    handleNotificationDelivery(invalidRequest, {
      loadInvokeSecret: () => secret,
      loadConfig: () => {
        configLoads++;
        return config;
      },
      run: async () => {
        runs++;
        return {};
      },
    }),
    new Promise<null>((resolve) => {
      invalidTimeoutId = setTimeout(() => resolve(null), 100);
    }),
  ]).finally(() => {
    if (invalidTimeoutId !== undefined) clearTimeout(invalidTimeoutId);
  });
  await invalidRequest.body?.cancel();
  assert(
    invalidSecretResponse?.status === 401,
    "unauthenticated streams must not be read before secret rejection",
  );

  const timedOutBodyResponse = await handleNotificationDelivery(
    new Request("http://localhost/functions/v1/notification-delivery", {
      method: "POST",
      headers: { "x-notification-delivery-invoke-secret": secret },
      body: neverEndingBody(),
    }),
    {
      loadInvokeSecret: () => secret,
      bodyReadDeadlineMs: 20,
      loadConfig: () => {
        configLoads++;
        return config;
      },
      run: async () => {
        runs++;
        return {};
      },
    },
  );
  assert(
    timedOutBodyResponse.status === 400,
    "authenticated non-terminating streams must fail closed at the body deadline",
  );
  assert(configLoads === 0 && runs === 0);
});
Deno.test("notification delivery Edge accepts the distinct invoke secret and returns bounded aggregate only", async () => {
  for (
    const url of [
      "http://localhost/functions/v1/notification-delivery",
      "http://localhost/notification-delivery",
    ]
  ) {
    const response = await handleNotificationDelivery(
      new Request(url, {
        method: "POST",
        headers: { "x-notification-delivery-invoke-secret": secret },
      }),
      {
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
      },
    );
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
  }
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
