import { handleNotificationDelivery } from "./index.ts";
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
Deno.test("notification delivery Edge fails closed when Function Secrets are missing", async () => {
  const response = await handleNotificationDelivery(request(), {
    loadInvokeSecret: () => {
      throw new Error("missing raw secret");
    },
  });
  assert(response.status === 503);
  assert(!(await response.text()).includes("missing raw secret"));
});
