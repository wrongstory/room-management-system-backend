import {
  type EdgeDeliveryProvider,
  type EdgeDeliveryRpc,
  EdgeNotificationDeliveryWorker,
  newEdgeDeliveryClaim,
  NOTIFICATION_DELIVERY_BATCH_LIMIT,
  NOTIFICATION_DELIVERY_PROVIDER_DEADLINE_MS,
  NOTIFICATION_DELIVERY_RUN_BUDGET_MS,
  NOTIFICATION_DELIVERY_SETTLE_DEADLINE_MS,
} from "./notification-delivery-worker.ts";

const arrayBuffer = (value: Uint8Array): ArrayBuffer =>
  value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;

Deno.test("notification delivery Edge constants preserve the 45/33/39 second bounded contract", () => {
  if (NOTIFICATION_DELIVERY_BATCH_LIMIT !== 10) throw new Error("batch drift");
  if (NOTIFICATION_DELIVERY_RUN_BUDGET_MS !== 45_000) {
    throw new Error("run deadline drift");
  }
  if (NOTIFICATION_DELIVERY_PROVIDER_DEADLINE_MS !== 33_000) {
    throw new Error("provider deadline drift");
  }
  if (NOTIFICATION_DELIVERY_SETTLE_DEADLINE_MS !== 39_000) {
    throw new Error("settle deadline drift");
  }
});

Deno.test("notification delivery claim is a fresh non-secret SHA-256 digest", async () => {
  const first = await newEdgeDeliveryClaim(),
    second = await newEdgeDeliveryClaim();
  if (!/^[0-9a-f]{64}$/.test(first) || first === second) {
    throw new Error("claim digest invalid");
  }
});

Deno.test("Edge worker decrypts, permits, sends and settles the same stable notification id", async () => {
  const profileId = "10000000-0000-4000-8000-000000000001";
  const sessionId = "20000000-0000-4000-8000-000000000002";
  const subscriptionId = "30000000-0000-4000-8000-000000000003";
  const revisionId = "40000000-0000-4000-8000-000000000004";
  const targetId = "50000000-0000-4000-8000-000000000005";
  const notificationId = "60000000-0000-4000-8000-000000000006";
  const sessionDigest = "a".repeat(64), endpointDigest = "b".repeat(64);
  const keyBytes = new Uint8Array(32).fill(7),
    nonce = new Uint8Array(12).fill(9);
  const plaintext = JSON.stringify({
    auth: "BwcHBwcHBwcHBwcHBwcHBw",
    endpoint: "https://push.example.invalid/capability",
    expirationTime: null,
    p256dh: "synthetic-p256dh",
    sessionId,
  });
  const aad = new TextEncoder().encode(
    `web-push-envelope:v1\0${profileId}\0${sessionDigest}\0${endpointDigest}\0${subscriptionId}\0${1}`,
  );
  const key = await crypto.subtle.importKey(
    "raw",
    arrayBuffer(keyBytes),
    "AES-GCM",
    false,
    [
      "encrypt",
    ],
  );
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: arrayBuffer(nonce),
        additionalData: arrayBuffer(aad),
        tagLength: 128,
      },
      key,
      arrayBuffer(new TextEncoder().encode(plaintext)),
    ),
  );
  const base64 = (value: Uint8Array) => btoa(String.fromCharCode(...value));
  const ciphertext = sealed.slice(0, -16), tag = sealed.slice(-16);
  const calls: string[] = [];
  let claimDigest = "";
  const rpc: EdgeDeliveryRpc = {
    rpc: (name, args) => {
      calls.push(name);
      if (name === "claim_notification_deliveries") {
        claimDigest = String(args.p_claim_digest);
        return Promise.resolve({
          data: {
            items: [{ targetId, notificationId, leaseVersion: 1 }],
            suppressed: 0,
            blocked: 0,
          },
          error: null,
        });
      }
      if (name === "get_notification_delivery_envelope") {
        return Promise.resolve({
          data: {
            sendAllowed: true,
            targetId,
            actorProfileId: profileId,
            subscriptionId,
            revisionNo: 1,
            subscriptionRevisionId: revisionId,
            sessionDigest,
            endpointDigest,
            keyVersion: "v1",
            ciphertextBase64: base64(ciphertext),
            nonceBase64: base64(nonce),
            authTagBase64: base64(tag),
          },
          error: null,
        });
      }
      if (name === "permit_notification_delivery") {
        if (
          args.p_session_id !== sessionId || args.p_claim_digest !== claimDigest
        ) throw new Error("permit binding drift");
        return Promise.resolve({
          data: {
            sendAllowed: true,
            payload: { notificationId, title: "청소 배정", body: "새 배정" },
          },
          error: null,
        });
      }
      if (name === "settle_notification_delivery") {
        return Promise.resolve({
          data: { status: "delivered" },
          error: null,
        });
      }
      return Promise.resolve({ data: { status: "succeeded" }, error: null });
    },
  };
  const provider: EdgeDeliveryProvider = {
    send: (subscription, payload, stableId, deadlineAt) => {
      if (
        subscription.endpoint !== "https://push.example.invalid/capability" ||
        JSON.parse(payload).notificationId !== notificationId ||
        stableId !== notificationId || deadlineAt !== 33_000
      ) throw new Error("provider projection drift");
      return Promise.resolve({ outcome: "accepted" });
    },
  };
  const result = await new EdgeNotificationDeliveryWorker(rpc, provider, {
    currentVersion: "v1",
    currentKey: keyBytes,
    keyring: {},
  }, () => 0).run();
  if (result.delivered !== 1 || result.claimed !== 1) {
    throw new Error("delivery result drift");
  }
  if (
    calls.join(",") !==
      "claim_notification_deliveries,get_notification_delivery_envelope,permit_notification_delivery,settle_notification_delivery,record_notification_delivery_heartbeat"
  ) throw new Error("RPC sequence drift");
});
