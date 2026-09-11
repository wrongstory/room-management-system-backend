import { describe, expect, it, vi } from "vitest";
import {
  NOTIFICATION_DELIVERY_PROVIDER_DEADLINE_MS,
  NOTIFICATION_DELIVERY_RUN_BUDGET_MS,
  NOTIFICATION_DELIVERY_SETTLE_DEADLINE_MS,
  NotificationDeliveryWorker,
  type NotificationDeliveryProvider,
  type NotificationDeliveryRpc,
} from "../src/modules/notifications/notification-delivery.js";
import { createWebPushEnvelope } from "../src/modules/push-subscriptions/web-push-crypto.js";

const profileId = "10000000-0000-4000-8000-000000000001";
const sessionId = "20000000-0000-4000-8000-000000000002";
const subscriptionId = "30000000-0000-4000-8000-000000000003";
const revisionId = "40000000-0000-4000-8000-000000000004";
const targetId = "50000000-0000-4000-8000-000000000005";
const notificationId = "60000000-0000-4000-8000-000000000006";
const key = Buffer.alloc(32, 7).toString("base64");
const config = {
  key,
  keyVersion: "v1",
  keyring: {},
  bindingSecret: "b".repeat(32),
  nonce: new Uint8Array(12).fill(9),
};
const input = {
  endpoint: "https://push.example.invalid/capability",
  expirationTime: null,
  keys: {
    p256dh:
      "BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU",
    auth: "BwcHBwcHBwcHBwcHBwcHBw",
  },
};
const envelope = createWebPushEnvelope(
  input,
  profileId,
  sessionId,
  subscriptionId,
  1,
  config,
);

function mockDb(
  settleStatus = "delivered",
  options: { noSend?: string; blocked?: boolean } = {},
) {
  const calls: string[] = [];
  const args: Record<string, unknown>[] = [];
  const db: NotificationDeliveryRpc = {
    rpc: async (name, value) => {
      calls.push(name);
      args.push(value);
      if (name === "claim_notification_deliveries")
        return {
          data: {
            items: [
              {
                targetId,
                notificationId,
                leaseVersion: 1,
                subscriptionRevisionId: revisionId,
              },
            ],
            suppressed: 0,
            blocked: 0,
          },
          error: null,
        };
      if (name === "get_notification_delivery_envelope") {
        if (options.noSend)
          return {
            data: { sendAllowed: false, reasonCode: options.noSend },
            error: null,
          };
        return {
          data: {
            sendAllowed: true,
            attemptId: revisionId,
            targetId,
            actorProfileId: profileId,
            subscriptionId,
            revisionNo: 1,
            subscriptionRevisionId: revisionId,
            sessionDigest: envelope.sessionDigest,
            endpointDigest: envelope.endpointDigest,
            keyVersion: envelope.keyVersion,
            ciphertextBase64: envelope.ciphertextBase64,
            nonceBase64: envelope.nonceBase64,
            authTagBase64: envelope.authTagBase64,
          },
          error: null,
        };
      }
      if (name === "permit_notification_delivery")
        return {
          data: {
            sendAllowed: true,
            attemptId: revisionId,
            payload: {
              notificationId,
              category: "cleaning_assignment_notified",
              title: "청소 배정",
              body: "새 청소 배정이 등록되었습니다.",
              deepLink: { kind: "cleaningTarget", entityId: targetId },
              groupId: revisionId,
              occurredAt: "2026-09-11T00:00:00Z",
            },
          },
          error: null,
        };
      if (name === "settle_notification_delivery")
        return {
          data: {
            status: options.blocked ? "operator_blocked" : settleStatus,
            stopBatch: options.blocked || undefined,
          },
          error: null,
        };
      return { data: { status: "succeeded" }, error: null };
    },
  };
  return { db, calls, args };
}

describe("provider-neutral notification delivery worker", () => {
  it("decrypts only in worker memory, obtains exact permit and sends stable notificationId", async () => {
    const setup = mockDb();
    const sent: string[] = [];
    const provider: NotificationDeliveryProvider = {
      send: async (subscription, payload, stableId, deadlineAt) => {
        expect(subscription).toEqual(input);
        expect(JSON.parse(payload).notificationId).toBe(notificationId);
        expect(stableId).toBe(notificationId);
        expect(deadlineAt).toBe(NOTIFICATION_DELIVERY_PROVIDER_DEADLINE_MS);
        sent.push(subscription.endpoint);
        return { outcome: "accepted" };
      },
    };
    await expect(
      new NotificationDeliveryWorker(setup.db, provider, config, () => 0).run(),
    ).resolves.toMatchObject({ claimed: 1, delivered: 1 });
    expect(sent).toHaveLength(1);
    expect(setup.calls).toEqual([
      "claim_notification_deliveries",
      "get_notification_delivery_envelope",
      "permit_notification_delivery",
      "settle_notification_delivery",
      "record_notification_delivery_heartbeat",
    ]);
    expect(setup.args.at(-1)).toMatchObject({
      p_status: "succeeded",
      p_delivered: 1,
    });
    expect(JSON.stringify(setup.args)).not.toContain(input.endpoint);
    expect(JSON.stringify(setup.args)).not.toContain(input.keys.auth);
  });

  it.each([
    ["STALE_NOTIFICATION", "suppressed"],
    ["NO_ACTIVE_SUBSCRIPTION", "suppressed"],
    ["SESSION_REVOKED", "suppressed"],
    ["ENVELOPE_UNAVAILABLE", "deadLetter"],
  ] as const)("does not call provider for %s", async (reason, counter) => {
    const setup = mockDb("delivered", { noSend: reason });
    let sends = 0;
    const provider: NotificationDeliveryProvider = {
      send: async () => {
        sends++;
        return { outcome: "accepted" };
      },
    };
    const result = await new NotificationDeliveryWorker(
      setup.db,
      provider,
      config,
      () => 0,
    ).run();
    expect(result[counter]).toBe(1);
    expect(sends).toBe(0);
    expect(setup.calls).not.toContain("permit_notification_delivery");
  });

  it("maps retryable provider outcome without persisting raw provider errors", async () => {
    const setup = mockDb("retry");
    const provider: NotificationDeliveryProvider = {
      send: async () => ({
        outcome: "retryable",
        reason: "RATE_LIMITED",
        retryAfterSeconds: 90,
      }),
    };
    await expect(
      new NotificationDeliveryWorker(setup.db, provider, config, () => 0).run(),
    ).resolves.toMatchObject({ retrying: 1 });
    expect(
      setup.args.find((value) => value.p_outcome === "retryable"),
    ).toMatchObject({
      p_reason_code: "RATE_LIMITED",
      p_retry_after_seconds: 90,
    });
  });

  it("stops the batch and records degraded heartbeat for provider configuration failure", async () => {
    const setup = mockDb("operator_blocked", { blocked: true });
    const provider: NotificationDeliveryProvider = {
      send: async () => ({ outcome: "provider_configuration_error" }),
    };
    await expect(
      new NotificationDeliveryWorker(setup.db, provider, config, () => 0).run(),
    ).resolves.toMatchObject({ blocked: 1 });
    expect(setup.args.at(-1)).toMatchObject({
      p_status: "degraded",
      p_error_code: "PROVIDER_CONFIGURATION_ERROR",
    });
  });

  it("converts provider throw to bounded network retry and never exposes the error", async () => {
    const setup = mockDb("retry");
    const provider: NotificationDeliveryProvider = {
      send: async () => {
        throw new Error("raw endpoint token credential");
      },
    };
    await expect(
      new NotificationDeliveryWorker(setup.db, provider, config, () => 0).run(),
    ).resolves.toMatchObject({ retrying: 1 });
    expect(
      setup.args.find((value) => value.p_outcome === "retryable"),
    ).toMatchObject({ p_reason_code: "NETWORK_ERROR" });
    expect(JSON.stringify(setup.args)).not.toMatch(/token|credential/);
  });

  it("documents crash-after-send takeover as at-least-once with stable client dedupe id", async () => {
    let run = 0;
    let sends = 0;
    const db: NotificationDeliveryRpc = {
      rpc: async (name) => {
        if (name === "claim_notification_deliveries") {
          run++;
          return {
            data: {
              items: [{ targetId, notificationId, leaseVersion: run }],
              suppressed: 0,
              blocked: 0,
            },
            error: null,
          };
        }
        if (name === "get_notification_delivery_envelope")
          return {
            data: {
              sendAllowed: true,
              actorProfileId: profileId,
              subscriptionId,
              revisionNo: 1,
              sessionDigest: envelope.sessionDigest,
              endpointDigest: envelope.endpointDigest,
              keyVersion: envelope.keyVersion,
              ciphertextBase64: envelope.ciphertextBase64,
              nonceBase64: envelope.nonceBase64,
              authTagBase64: envelope.authTagBase64,
            },
            error: null,
          };
        if (name === "permit_notification_delivery")
          return {
            data: {
              sendAllowed: true,
              payload: { notificationId, title: "청소 배정", body: "새 배정" },
            },
            error: null,
          };
        if (name === "settle_notification_delivery")
          return run === 1
            ? {
                data: null,
                error: new Error("connection lost after provider accepted"),
              }
            : { data: { status: "delivered" }, error: null };
        return { data: {}, error: null };
      },
    };
    const provider: NotificationDeliveryProvider = {
      send: async (_subscription, _payload, stableId) => {
        expect(stableId).toBe(notificationId);
        sends++;
        return { outcome: "accepted" };
      },
    };
    await expect(
      new NotificationDeliveryWorker(db, provider, config, () => 0).run(),
    ).rejects.toMatchObject({ code: "NOTIFICATION_DELIVERY_FAILED" });
    await expect(
      new NotificationDeliveryWorker(db, provider, config, () => 0).run(),
    ).resolves.toMatchObject({ delivered: 1 });
    expect(sends).toBe(2);
  });

  it("never starts provider work after the absolute 33-second provider deadline", async () => {
    const setup = mockDb();
    let now = 0;
    let sends = 0;
    const original = setup.db.rpc;
    setup.db.rpc = (name, args) => {
      const result = original(name, args);
      if (name === "permit_notification_delivery")
        now = NOTIFICATION_DELIVERY_PROVIDER_DEADLINE_MS;
      return result;
    };
    const provider: NotificationDeliveryProvider = {
      send: async () => {
        sends++;
        return { outcome: "accepted" };
      },
    };
    await expect(
      new NotificationDeliveryWorker(
        setup.db,
        provider,
        config,
        () => now,
      ).run(),
    ).resolves.toMatchObject({ deferred: 1, delivered: 0 });
    expect(sends).toBe(0);
  });

  it("keeps a worst-case ten-item batch inside provider, settle and heartbeat deadlines", async () => {
    const fixtures = Array.from({ length: 10 }, (_, index) => {
      const suffix = String(index + 101).padStart(12, "0");
      const itemTargetId = `50000000-0000-4000-8000-${suffix}`;
      const itemNotificationId = `60000000-0000-4000-8000-${suffix}`;
      const itemSubscriptionId = `30000000-0000-4000-8000-${suffix}`;
      const itemRevisionId = `40000000-0000-4000-8000-${suffix}`;
      const itemEnvelope = createWebPushEnvelope(
        input,
        profileId,
        sessionId,
        itemSubscriptionId,
        1,
        {
          ...config,
          nonce: new Uint8Array(12).fill(index + 1),
        },
      );
      return {
        itemTargetId,
        itemNotificationId,
        itemSubscriptionId,
        itemRevisionId,
        itemEnvelope,
      };
    });
    const byTarget = new Map(fixtures.map((fixture) => [fixture.itemTargetId, fixture]));
    let now = 0;
    let heartbeatAt = -1;
    const providerStarts: number[] = [];
    const db: NotificationDeliveryRpc = {
      rpc: async (name, args) => {
        if (name === "claim_notification_deliveries")
          return {
            data: {
              items: fixtures.map((fixture) => ({
                targetId: fixture.itemTargetId,
                notificationId: fixture.itemNotificationId,
                leaseVersion: 1,
                subscriptionRevisionId: fixture.itemRevisionId,
              })),
              suppressed: 0,
              blocked: 0,
            },
            error: null,
          };
        const fixture = byTarget.get(String(args.p_target_id));
        if (name === "get_notification_delivery_envelope" && fixture)
          return {
            data: {
              sendAllowed: true,
              actorProfileId: profileId,
              subscriptionId: fixture.itemSubscriptionId,
              revisionNo: 1,
              sessionDigest: fixture.itemEnvelope.sessionDigest,
              endpointDigest: fixture.itemEnvelope.endpointDigest,
              keyVersion: fixture.itemEnvelope.keyVersion,
              ciphertextBase64: fixture.itemEnvelope.ciphertextBase64,
              nonceBase64: fixture.itemEnvelope.nonceBase64,
              authTagBase64: fixture.itemEnvelope.authTagBase64,
            },
            error: null,
          };
        if (name === "permit_notification_delivery" && fixture)
          return {
            data: {
              sendAllowed: true,
              payload: {
                notificationId: fixture.itemNotificationId,
                title: "청소 배정",
                body: "새 배정",
              },
            },
            error: null,
          };
        if (name === "settle_notification_delivery") {
          expect(now).toBeLessThan(NOTIFICATION_DELIVERY_SETTLE_DEADLINE_MS);
          return { data: { status: "delivered" }, error: null };
        }
        if (name === "record_notification_delivery_heartbeat") {
          heartbeatAt = now;
          return { data: { status: "degraded" }, error: null };
        }
        return { data: null, error: new Error("unexpected RPC") };
      },
    };
    const provider: NotificationDeliveryProvider = {
      send: async () => {
        providerStarts.push(now);
        now += 3_700;
        return { outcome: "accepted" };
      },
    };
    await expect(
      new NotificationDeliveryWorker(db, provider, config, () => now).run(),
    ).resolves.toMatchObject({ claimed: 10, delivered: 9, deferred: 1 });
    expect(providerStarts).toHaveLength(9);
    expect(Math.max(...providerStarts)).toBeLessThan(
      NOTIFICATION_DELIVERY_PROVIDER_DEADLINE_MS,
    );
    expect(heartbeatAt).toBeLessThan(NOTIFICATION_DELIVERY_RUN_BUDGET_MS);
  });

  it("aborts a hung RPC within five seconds and reports only stable failure", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    let aborted = false;
    const pending = new Promise<{ data: unknown; error: unknown }>(
      () => {},
    ) as Promise<{ data: unknown; error: unknown }> & {
      abortSignal(
        signal: AbortSignal,
      ): PromiseLike<{ data: unknown; error: unknown }>;
    };
    pending.abortSignal = (signal) => {
      signal.addEventListener(
        "abort",
        () => {
          aborted = true;
        },
        { once: true },
      );
      return pending;
    };
    const db: NotificationDeliveryRpc = {
      rpc: (name) =>
        name === "claim_notification_deliveries"
          ? pending
          : Promise.resolve({ data: {}, error: null }),
    };
    const provider: NotificationDeliveryProvider = {
      send: async () => ({ outcome: "accepted" }),
    };
    const run = new NotificationDeliveryWorker(db, provider, config).run();
    const rejected = expect(run).rejects.toMatchObject({
      code: "NOTIFICATION_DELIVERY_FAILED",
    });
    await vi.advanceTimersByTimeAsync(5_001);
    await rejected;
    expect(aborted).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(
      NOTIFICATION_DELIVERY_RUN_BUDGET_MS,
    );
  });
});
