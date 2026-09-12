/** #111 provider-neutral Edge orchestration. Actual Web Push HTTP and activation belong to #112. */
export const NOTIFICATION_DELIVERY_BATCH_LIMIT = 10;
export const NOTIFICATION_DELIVERY_RUN_BUDGET_MS = 45_000;
export const NOTIFICATION_DELIVERY_PROVIDER_DEADLINE_MS = 33_000;
export const NOTIFICATION_DELIVERY_SETTLE_DEADLINE_MS = 39_000;
export const NOTIFICATION_DELIVERY_MIN_PROVIDER_START_MS = 250;

export type EdgeDeliveryOutcome =
  | {
    outcome:
      | "accepted"
      | "endpoint_gone"
      | "payload_rejected"
      | "provider_configuration_error";
  }
  | {
    outcome: "retryable";
    reason: "RATE_LIMITED" | "PROVIDER_ERROR" | "NETWORK_ERROR" | "TIMEOUT";
    retryAfterSeconds?: number;
  };
export interface EdgeDeliveryProvider {
  send(
    subscription: {
      endpoint: string;
      expirationTime: number | null;
      keys: { p256dh: string; auth: string };
    },
    payload: string,
    notificationId: string,
    deadlineAt: number,
    vapidKeyVersion: string,
  ): Promise<EdgeDeliveryOutcome>;
}
interface RpcCall extends PromiseLike<{ data: unknown; error: unknown }> {
  abortSignal?(
    signal: AbortSignal,
  ): PromiseLike<{ data: unknown; error: unknown }>;
}
export interface EdgeDeliveryRpc {
  rpc(name: string, args: Record<string, unknown>): RpcCall;
}
export interface EdgeDeliveryCryptoConfig {
  currentVersion: string;
  currentKey: Uint8Array;
  keyring: Record<string, Uint8Array>;
}
export interface EdgeDeliveryRunResult {
  claimed: number;
  delivered: number;
  retrying: number;
  suppressed: number;
  deadLetter: number;
  blocked: number;
  deferred: number;
}

class DeliveryFailure extends Error {
  readonly code = "NOTIFICATION_DELIVERY_FAILED";
}
class DeadlineFailure extends Error {}
const fail = (): never => {
  throw new DeliveryFailure("NOTIFICATION_DELIVERY_FAILED");
};
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : fail();
const uuid = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value)
  ) fail();
  return (value as string).toLowerCase();
};
const integer = (value: unknown, max = Number.MAX_SAFE_INTEGER): number => {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 ||
    value > max
  ) fail();
  return value as number;
};
const boundedCount = (value: unknown): number => {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 ||
    value > NOTIFICATION_DELIVERY_BATCH_LIMIT
  ) fail();
  return value as number;
};
const hex = (value: unknown): string => {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) fail();
  return value as string;
};
const keyVersion = (value: unknown): string => {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,32}$/.test(value)) {
    fail();
  }
  return value as string;
};
function bytes(value: unknown): Uint8Array {
  if (
    typeof value !== "string" || value.length < 1 || value.length > 24_000 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) fail();
  try {
    return Uint8Array.from(
      atob(value as string),
      (character) => character.charCodeAt(0),
    );
  } catch {
    return fail();
  }
}
const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
const arrayBuffer = (value: Uint8Array): ArrayBuffer =>
  value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;
export async function newEdgeDeliveryClaim(): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      arrayBuffer(utf8(`notification.delivery:${crypto.randomUUID()}`)),
    ),
  );
  return Array.from(digest, (value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function decryptEnvelope(
  row: Record<string, unknown>,
  config: EdgeDeliveryCryptoConfig,
) {
  const version = String(row.keyVersion);
  const keyBytes = version === config.currentVersion
    ? config.currentKey
    : config.keyring[version];
  if (keyBytes?.length !== 32) fail();
  const nonce = bytes(row.nonceBase64),
    ciphertext = bytes(row.ciphertextBase64),
    tag = bytes(row.authTagBase64);
  if (nonce.length !== 12 || tag.length !== 16) fail();
  const actorProfileId = uuid(row.actorProfileId),
    subscriptionId = uuid(row.subscriptionId);
  const revisionNo = integer(row.revisionNo),
    sessionDigest = hex(row.sessionDigest),
    endpointDigest = hex(row.endpointDigest);
  const aad = utf8(
    `web-push-envelope:v1\0${actorProfileId}\0${sessionDigest}\0${endpointDigest}\0${subscriptionId}\0${revisionNo}`,
  );
  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext);
  combined.set(tag, ciphertext.length);
  let plaintext: Uint8Array;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      arrayBuffer(keyBytes),
      "AES-GCM",
      false,
      ["decrypt"],
    );
    plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: arrayBuffer(nonce),
          additionalData: arrayBuffer(aad),
          tagLength: 128,
        },
        key,
        arrayBuffer(combined),
      ),
    );
  } catch {
    return fail();
  }
  const parsed = object(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)),
  );
  const endpoint = String(parsed.endpoint), endpointUrl = new URL(endpoint);
  const keys = object(parsed);
  const keyObject = object(
    keys.p256dh === undefined
      ? parsed.keys
      : { p256dh: parsed.p256dh, auth: parsed.auth },
  );
  if (
    endpointUrl.protocol !== "https:" || endpointUrl.username ||
    endpointUrl.password || endpointUrl.hash || utf8(endpoint).length > 4096 ||
    typeof keyObject.p256dh !== "string" || typeof keyObject.auth !== "string"
  ) fail();
  const p256dh = keyObject.p256dh as string;
  const auth = keyObject.auth as string;
  return {
    subscription: {
      endpoint,
      expirationTime: parsed.expirationTime as number | null,
      keys: { p256dh, auth },
    },
    sessionId: uuid(parsed.sessionId),
  };
}

export class EdgeNotificationDeliveryWorker {
  constructor(
    private db: EdgeDeliveryRpc,
    private provider: EdgeDeliveryProvider,
    private config: EdgeDeliveryCryptoConfig,
    private clock: () => number = Date.now,
  ) {}
  #remaining(deadline: number) {
    return Math.floor(deadline - this.clock());
  }
  async #rpc(
    name: string,
    args: Record<string, unknown>,
    deadline: number,
  ): Promise<unknown> {
    const remaining = this.#remaining(deadline);
    if (remaining <= 0) return fail();
    const controller = new AbortController();
    let timer: number | undefined;
    try {
      const raw = this.db.rpc(name, args),
        request = raw.abortSignal ? raw.abortSignal(controller.signal) : raw;
      const response = await Promise.race([
        Promise.resolve(request),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new DeadlineFailure());
          }, Math.min(5_000, remaining));
        }),
      ]);
      if (response.error) return fail();
      return response.data;
    } catch {
      return fail();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  async #send<T>(promise: PromiseLike<T>, deadline: number): Promise<T> {
    const remaining = this.#remaining(deadline);
    if (remaining <= 0) throw new DeadlineFailure();
    let timer: number | undefined;
    try {
      return await Promise.race([
        Promise.resolve(promise),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new DeadlineFailure()), remaining);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  async run(): Promise<EdgeDeliveryRunResult> {
    const started = this.clock(),
      providerDeadline = started + NOTIFICATION_DELIVERY_PROVIDER_DEADLINE_MS;
    const settleDeadline = started + NOTIFICATION_DELIVERY_SETTLE_DEADLINE_MS,
      runDeadline = started + NOTIFICATION_DELIVERY_RUN_BUDGET_MS;
    const claimDigest = await newEdgeDeliveryClaim();
    const result: EdgeDeliveryRunResult = {
      claimed: 0,
      delivered: 0,
      retrying: 0,
      suppressed: 0,
      deadLetter: 0,
      blocked: 0,
      deferred: 0,
    };
    let configurationError = false;
    try {
      const claim = object(
        await this.#rpc("claim_notification_deliveries", {
          p_claim_digest: claimDigest,
          p_limit: 10,
        }, providerDeadline),
      );
      if (!Array.isArray(claim.items) || claim.items.length > 10) fail();
      const items = claim.items as unknown[];
      const claimSuppressed = boundedCount(claim.suppressed);
      const claimBlocked = boundedCount(claim.blocked);
      if (items.length + claimSuppressed + claimBlocked > 10) fail();
      result.claimed = items.length;
      result.suppressed += claimSuppressed;
      result.blocked += claimBlocked;
      for (const raw of items) {
        if (
          this.#remaining(providerDeadline) <
            NOTIFICATION_DELIVERY_MIN_PROVIDER_START_MS
        ) {
          result.deferred++;
          continue;
        }
        const item = object(raw),
          targetId = uuid(item.targetId),
          leaseVersion = integer(item.leaseVersion, 8);
        const fence = {
          p_target_id: targetId,
          p_lease_version: leaseVersion,
          p_claim_digest: claimDigest,
        };
        const envelope = object(
          await this.#rpc(
            "get_notification_delivery_envelope",
            fence,
            providerDeadline,
          ),
        );
        if (envelope.sendAllowed !== true) {
          envelope.reasonCode === "ENVELOPE_UNAVAILABLE" ||
            envelope.reasonCode === "VAPID_KEY_UNBOUND" ||
            envelope.reasonCode === "PAYLOAD_TOO_LARGE"
            ? result.deadLetter++
            : result.suppressed++;
          continue;
        }
        const decrypted = await decryptEnvelope(envelope, this.config);
        const permit = object(
          await this.#rpc("permit_notification_delivery", {
            ...fence,
            p_session_id: decrypted.sessionId,
          }, providerDeadline),
        );
        if (permit.sendAllowed !== true) {
          result.suppressed++;
          continue;
        }
        const payload = object(permit.payload),
          notificationId = uuid(payload.notificationId),
          encoded = JSON.stringify(payload);
        if (utf8(encoded).length > 3072) fail();
        if (
          this.#remaining(providerDeadline) <
            NOTIFICATION_DELIVERY_MIN_PROVIDER_START_MS
        ) {
          result.deferred++;
          continue;
        }
        let outcome: EdgeDeliveryOutcome;
        try {
          outcome = await this.#send(
            this.provider.send(
              decrypted.subscription,
              encoded,
              notificationId,
              providerDeadline,
              keyVersion(envelope.vapidKeyVersion),
            ),
            providerDeadline,
          );
        } catch {
          outcome = { outcome: "retryable", reason: "NETWORK_ERROR" };
        }
        const args: Record<string, unknown> = {
          ...fence,
          p_outcome: outcome.outcome,
          p_reason_code: null,
          p_retry_after_seconds: null,
        };
        if (outcome.outcome === "retryable") {
          args.p_reason_code = outcome.reason;
          args.p_retry_after_seconds = outcome.retryAfterSeconds ?? null;
        } else if (outcome.outcome === "payload_rejected") {
          args.p_reason_code = "PAYLOAD_REJECTED";
        } else if (outcome.outcome === "provider_configuration_error") {
          args.p_reason_code = "PROVIDER_CONFIGURATION_ERROR";
        }
        const settled = object(
          await this.#rpc("settle_notification_delivery", args, settleDeadline),
        );
        if (settled.status === "delivered") result.delivered++;
        else if (settled.status === "retry") result.retrying++;
        else if (settled.status === "suppressed") result.suppressed++;
        else if (settled.status === "dead_letter") result.deadLetter++;
        else if (settled.status === "operator_blocked") {
          result.blocked++;
          configurationError = true;
          break;
        } else fail();
      }
      await this.#rpc("record_notification_delivery_heartbeat", {
        p_status: configurationError ||
            result.retrying + result.deadLetter + result.blocked +
                  result.deferred > 0
          ? "degraded"
          : "succeeded",
        p_claimed: result.claimed,
        p_delivered: result.delivered,
        p_retrying: result.retrying,
        p_suppressed: result.suppressed,
        p_dead_letter: result.deadLetter,
        p_blocked: result.blocked,
        p_deferred: result.deferred,
        p_error_code: configurationError
          ? "PROVIDER_CONFIGURATION_ERROR"
          : null,
      }, runDeadline);
      return result;
    } catch {
      try {
        await this.#rpc("record_notification_delivery_heartbeat", {
          p_status: "failed",
          p_claimed: result.claimed,
          p_delivered: result.delivered,
          p_retrying: result.retrying,
          p_suppressed: result.suppressed,
          p_dead_letter: result.deadLetter,
          p_blocked: result.blocked,
          p_deferred: result.deferred,
          p_error_code: "NOTIFICATION_DELIVERY_FAILED",
        }, runDeadline);
      } catch { /* redacted original remains authoritative */ }
      throw new DeliveryFailure("NOTIFICATION_DELIVERY_FAILED");
    }
  }
}
