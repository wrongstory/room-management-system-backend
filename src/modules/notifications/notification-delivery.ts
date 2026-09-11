import { createHash, randomUUID } from "node:crypto";
import {
  decryptWebPushEnvelope,
  type DecryptedWebPushEnvelope,
  type WebPushCryptoConfig,
} from "../push-subscriptions/web-push-crypto.js";

export const NOTIFICATION_DELIVERY_BATCH_LIMIT = 10;
export const NOTIFICATION_DELIVERY_RUN_BUDGET_MS = 45_000;
export const NOTIFICATION_DELIVERY_PROVIDER_DEADLINE_MS = 33_000;
export const NOTIFICATION_DELIVERY_SETTLE_DEADLINE_MS = 39_000;
export const NOTIFICATION_DELIVERY_MIN_PROVIDER_START_MS = 250;

export type NotificationRetryReason =
  "RATE_LIMITED" | "PROVIDER_ERROR" | "NETWORK_ERROR" | "TIMEOUT";
export type NotificationProviderOutcome =
  | {
      outcome:
        | "accepted"
        | "endpoint_gone"
        | "payload_rejected"
        | "provider_configuration_error";
    }
  | {
      outcome: "retryable";
      reason: NotificationRetryReason;
      retryAfterSeconds?: number;
    };

export interface NotificationDeliveryProvider {
  send(
    subscription: DecryptedWebPushEnvelope["subscription"],
    payload: string,
    notificationId: string,
    deadlineAt: number,
  ): Promise<NotificationProviderOutcome>;
}

interface DeliveryRpcCall extends PromiseLike<{
  data: unknown;
  error: unknown;
}> {
  abortSignal?(
    signal: AbortSignal,
  ): PromiseLike<{ data: unknown; error: unknown }>;
}
export interface NotificationDeliveryRpc {
  rpc(name: string, args: Record<string, unknown>): DeliveryRpcCall;
}

export interface NotificationDeliveryRunResult {
  claimed: number;
  delivered: number;
  retrying: number;
  suppressed: number;
  deadLetter: number;
  blocked: number;
  deferred: number;
}

export class NotificationDeliveryError extends Error {
  readonly code = "NOTIFICATION_DELIVERY_FAILED";
  constructor() {
    super("NOTIFICATION_DELIVERY_FAILED");
    this.name = "NotificationDeliveryError";
  }
}

class NotificationDeliveryDeadlineError extends Error {}
const failed = (): never => {
  throw new NotificationDeliveryError();
};
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : failed();
const uuid = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    failed();
  return (value as string).toLowerCase();
};
const positiveVersion = (value: unknown): number => {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 8
  )
    failed();
  return value as number;
};
const boundedCount = (value: unknown): number => {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > NOTIFICATION_DELIVERY_BATCH_LIMIT
  )
    failed();
  return value as number;
};
const revisionNumber = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    failed();
  return value as number;
};
const digest = (value: unknown): string => {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) failed();
  return value as string;
};
const base64 = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 24_000 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  )
    failed();
  return value as string;
};

export function newNotificationDeliveryClaim(): string {
  return createHash("sha256")
    .update(`notification.delivery:${randomUUID()}`, "utf8")
    .digest("hex");
}

export class NotificationDeliveryWorker {
  constructor(
    private readonly db: NotificationDeliveryRpc,
    private readonly provider: NotificationDeliveryProvider,
    private readonly cryptoConfig: Pick<
      WebPushCryptoConfig,
      "key" | "keyVersion" | "keyring"
    >,
    private readonly clock: () => number = Date.now,
  ) {}

  #remaining(deadlineAt: number): number {
    return Math.floor(deadlineAt - this.clock());
  }
  #canStart(deadlineAt: number, reserve = 1): boolean {
    return this.#remaining(deadlineAt) >= reserve;
  }

  async #bounded<T>(promise: PromiseLike<T>, deadlineAt: number): Promise<T> {
    const remaining = this.#remaining(deadlineAt);
    if (remaining <= 0) throw new NotificationDeliveryDeadlineError();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve(promise),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new NotificationDeliveryDeadlineError()),
            remaining,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async #rpc(
    name: string,
    args: Record<string, unknown>,
    deadlineAt: number,
  ): Promise<unknown> {
    const remaining = this.#remaining(deadlineAt);
    if (remaining <= 0) return failed();
    const controller = new AbortController();
    const timeoutMs = Math.max(1, Math.min(5_000, remaining));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = this.db.rpc(name, args);
      const request = raw.abortSignal
        ? raw.abortSignal(controller.signal)
        : raw;
      const response = await Promise.race([
        Promise.resolve(request),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new NotificationDeliveryDeadlineError());
          }, timeoutMs);
        }),
      ]);
      if (response.error) return failed();
      return response.data;
    } catch {
      return failed();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  #countNoSend(
    result: Record<string, unknown>,
    totals: NotificationDeliveryRunResult,
  ): void {
    const reason = result.reasonCode;
    if (reason === "ENVELOPE_UNAVAILABLE" || reason === "PAYLOAD_TOO_LARGE")
      totals.deadLetter++;
    else totals.suppressed++;
  }

  async run(): Promise<NotificationDeliveryRunResult> {
    const startedAt = this.clock();
    const providerDeadline =
      startedAt + NOTIFICATION_DELIVERY_PROVIDER_DEADLINE_MS;
    const settleDeadline = startedAt + NOTIFICATION_DELIVERY_SETTLE_DEADLINE_MS;
    const runDeadline = startedAt + NOTIFICATION_DELIVERY_RUN_BUDGET_MS;
    const claimDigest = newNotificationDeliveryClaim();
    const totals: NotificationDeliveryRunResult = {
      claimed: 0,
      delivered: 0,
      retrying: 0,
      suppressed: 0,
      deadLetter: 0,
      blocked: 0,
      deferred: 0,
    };
    let heartbeatError: "PROVIDER_CONFIGURATION_ERROR" | null = null;
    try {
      const claim = record(
        await this.#rpc(
          "claim_notification_deliveries",
          {
            p_claim_digest: claimDigest,
            p_limit: NOTIFICATION_DELIVERY_BATCH_LIMIT,
          },
          providerDeadline,
        ),
      );
      if (
        !Array.isArray(claim.items) ||
        claim.items.length > NOTIFICATION_DELIVERY_BATCH_LIMIT
      )
        failed();
      const claimedItems = claim.items as unknown[];
      const claimSuppressed = boundedCount(claim.suppressed);
      const claimBlocked = boundedCount(claim.blocked);
      if (
        claimedItems.length + claimSuppressed + claimBlocked >
        NOTIFICATION_DELIVERY_BATCH_LIMIT
      )
        failed();
      totals.claimed = claimedItems.length;
      totals.suppressed += claimSuppressed;
      totals.blocked += claimBlocked;

      for (const rawItem of claimedItems) {
        if (
          !this.#canStart(
            providerDeadline,
            NOTIFICATION_DELIVERY_MIN_PROVIDER_START_MS,
          )
        ) {
          totals.deferred++;
          continue;
        }
        const item = record(rawItem);
        const targetId = uuid(item.targetId);
        const leaseVersion = positiveVersion(item.leaseVersion);
        const fence = {
          p_target_id: targetId,
          p_lease_version: leaseVersion,
          p_claim_digest: claimDigest,
        };
        const envelope = record(
          await this.#rpc(
            "get_notification_delivery_envelope",
            fence,
            providerDeadline,
          ),
        );
        if (envelope.sendAllowed !== true) {
          this.#countNoSend(envelope, totals);
          continue;
        }

        const decrypted = decryptWebPushEnvelope(
          {
            keyVersion: String(envelope.keyVersion),
            ciphertextBase64: base64(envelope.ciphertextBase64),
            nonceBase64: base64(envelope.nonceBase64),
            authTagBase64: base64(envelope.authTagBase64),
          },
          {
            actorProfileId: uuid(envelope.actorProfileId),
            sessionDigest: digest(envelope.sessionDigest),
            endpointDigest: digest(envelope.endpointDigest),
            subscriptionId: uuid(envelope.subscriptionId),
            revisionNo: revisionNumber(envelope.revisionNo),
          },
          this.cryptoConfig,
        );

        const permit = record(
          await this.#rpc(
            "permit_notification_delivery",
            {
              ...fence,
              p_session_id: decrypted.sessionId,
            },
            providerDeadline,
          ),
        );
        if (permit.sendAllowed !== true) {
          this.#countNoSend(permit, totals);
          continue;
        }
        const payload = record(permit.payload);
        const notificationId = uuid(payload.notificationId);
        const encodedPayload = JSON.stringify(payload);
        if (Buffer.byteLength(encodedPayload, "utf8") > 3_072) failed();
        if (
          !this.#canStart(
            providerDeadline,
            NOTIFICATION_DELIVERY_MIN_PROVIDER_START_MS,
          )
        ) {
          totals.deferred++;
          continue;
        }

        let outcome: NotificationProviderOutcome;
        try {
          outcome = await this.#bounded(
            this.provider.send(
              decrypted.subscription,
              encodedPayload,
              notificationId,
              providerDeadline,
            ),
            providerDeadline,
          );
        } catch {
          outcome = { outcome: "retryable", reason: "NETWORK_ERROR" };
        }
        const settleArgs: Record<string, unknown> = {
          ...fence,
          p_outcome: outcome.outcome,
          p_reason_code: null,
          p_retry_after_seconds: null,
        };
        if (outcome.outcome === "retryable") {
          settleArgs.p_reason_code = outcome.reason;
          settleArgs.p_retry_after_seconds = outcome.retryAfterSeconds ?? null;
        } else if (outcome.outcome === "payload_rejected")
          settleArgs.p_reason_code = "PAYLOAD_REJECTED";
        else if (outcome.outcome === "provider_configuration_error")
          settleArgs.p_reason_code = "PROVIDER_CONFIGURATION_ERROR";
        const settled = record(
          await this.#rpc(
            "settle_notification_delivery",
            settleArgs,
            settleDeadline,
          ),
        );
        if (settled.status === "delivered") totals.delivered++;
        else if (settled.status === "retry") totals.retrying++;
        else if (settled.status === "suppressed") totals.suppressed++;
        else if (settled.status === "dead_letter") totals.deadLetter++;
        else if (settled.status === "operator_blocked") {
          totals.blocked++;
          heartbeatError = "PROVIDER_CONFIGURATION_ERROR";
          break;
        } else failed();
      }

      await this.#rpc(
        "record_notification_delivery_heartbeat",
        {
          p_status:
            heartbeatError ||
            totals.retrying +
              totals.deadLetter +
              totals.blocked +
              totals.deferred >
              0
              ? "degraded"
              : "succeeded",
          p_claimed: totals.claimed,
          p_delivered: totals.delivered,
          p_retrying: totals.retrying,
          p_suppressed: totals.suppressed,
          p_dead_letter: totals.deadLetter,
          p_blocked: totals.blocked,
          p_deferred: totals.deferred,
          p_error_code: heartbeatError,
        },
        runDeadline,
      );
      return totals;
    } catch {
      try {
        await this.#rpc(
          "record_notification_delivery_heartbeat",
          {
            p_status: "failed",
            p_claimed: totals.claimed,
            p_delivered: totals.delivered,
            p_retrying: totals.retrying,
            p_suppressed: totals.suppressed,
            p_dead_letter: totals.deadLetter,
            p_blocked: totals.blocked,
            p_deferred: totals.deferred,
            p_error_code: "NOTIFICATION_DELIVERY_FAILED",
          },
          runDeadline,
        );
      } catch {
        /* The original redacted worker failure remains authoritative. */
      }
      throw new NotificationDeliveryError();
    }
  }
}
