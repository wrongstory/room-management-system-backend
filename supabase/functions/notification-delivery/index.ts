import { createEdgeClients, requestId } from "../_shared/runtime.ts";
import {
  type EdgeDeliveryCryptoConfig,
  EdgeNotificationDeliveryWorker,
} from "../_shared/notification-delivery-worker.ts";
import {
  RfcWebPushProvider,
  validateWebPushProviderConfig,
  type VapidKeyMaterial,
  type WebPushProviderConfig,
} from "../_shared/web-push-provider.ts";

const utf8 = (value: string) => new TextEncoder().encode(value);
const VAPID_KEYRING_MAX_ENTRIES = 5;
const bytes = (value: Uint8Array) =>
  value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;
function required(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error("NOTIFICATION_DELIVERY_NOT_CONFIGURED");
  return value;
}
function base64(value: string): Uint8Array {
  let raw: string;
  try {
    raw = atob(value);
  } catch {
    throw new Error("NOTIFICATION_DELIVERY_NOT_CONFIGURED");
  }
  const out = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  if (btoa(String.fromCharCode(...out)) !== value) {
    throw new Error("NOTIFICATION_DELIVERY_NOT_CONFIGURED");
  }
  return out;
}
function keyMaterial(
  publicKey: unknown,
  privateKey: unknown,
): VapidKeyMaterial {
  if (
    typeof publicKey !== "string" || typeof privateKey !== "string" ||
    !/^[A-Za-z0-9_-]{87}$/.test(publicKey) ||
    !/^[A-Za-z0-9_-]{43}$/.test(privateKey)
  ) throw new Error("NOTIFICATION_DELIVERY_NOT_CONFIGURED");
  return { publicKey, privateKey };
}
export function notificationDeliveryConfig(): {
  invokeSecret: string;
  envelope: EdgeDeliveryCryptoConfig;
  vapid: WebPushProviderConfig;
} {
  const invokeSecret = required("NOTIFICATION_DELIVERY_INVOKE_SECRET");
  const envelopeKey = base64(required("WEB_PUSH_SUBSCRIPTION_KEY_BASE64"));
  const envelopeVersion = required("WEB_PUSH_SUBSCRIPTION_KEY_VERSION");
  const vapidVersion = required("VAPID_CURRENT_KEY_VERSION");
  const current = keyMaterial(
    required("VAPID_PUBLIC_KEY"),
    required("VAPID_PRIVATE_KEY"),
  );
  const subject = required("VAPID_SUBJECT");
  let envelopeRaw: unknown, vapidRaw: unknown, vapidPublicRaw: unknown;
  try {
    envelopeRaw = JSON.parse(
      Deno.env.get("WEB_PUSH_SUBSCRIPTION_KEYRING_JSON")?.trim() || "{}",
    );
    vapidRaw = JSON.parse(Deno.env.get("VAPID_KEYRING_JSON")?.trim() || "{}");
    vapidPublicRaw = JSON.parse(
      Deno.env.get("VAPID_PUBLIC_KEYRING_JSON")?.trim() || "{}",
    );
  } catch {
    throw new Error("NOTIFICATION_DELIVERY_NOT_CONFIGURED");
  }
  if (
    !envelopeRaw || typeof envelopeRaw !== "object" ||
    Array.isArray(envelopeRaw) || !vapidRaw || typeof vapidRaw !== "object" ||
    Array.isArray(vapidRaw) || !vapidPublicRaw ||
    typeof vapidPublicRaw !== "object" || Array.isArray(vapidPublicRaw) ||
    Object.keys(vapidRaw).length > VAPID_KEYRING_MAX_ENTRIES ||
    Object.keys(vapidPublicRaw).length > VAPID_KEYRING_MAX_ENTRIES
  ) throw new Error("NOTIFICATION_DELIVERY_NOT_CONFIGURED");
  const envelopeKeyring: Record<string, Uint8Array> = {},
    vapidKeyring: Record<string, VapidKeyMaterial> = {};
  for (const [version, value] of Object.entries(envelopeRaw)) {
    if (!/^[A-Za-z0-9._-]{1,32}$/.test(version) || typeof value !== "string") {
      throw new Error("NOTIFICATION_DELIVERY_NOT_CONFIGURED");
    }
    envelopeKeyring[version] = base64(value);
  }
  for (const [version, value] of Object.entries(vapidRaw)) {
    if (
      !/^[A-Za-z0-9._-]{1,32}$/.test(version) || !value ||
      typeof value !== "object" || Array.isArray(value)
    ) throw new Error("NOTIFICATION_DELIVERY_NOT_CONFIGURED");
    const row = value as Record<string, unknown>;
    vapidKeyring[version] = keyMaterial(row.publicKey, row.privateKey);
  }
  const privateVersions = Object.keys(vapidKeyring).sort();
  const publicVersions = Object.keys(vapidPublicRaw).sort();
  if (privateVersions.join("\0") !== publicVersions.join("\0")) {
    throw new Error("NOTIFICATION_DELIVERY_NOT_CONFIGURED");
  }
  for (const version of privateVersions) {
    if (
      typeof (vapidPublicRaw as Record<string, unknown>)[version] !==
        "string" ||
      (vapidPublicRaw as Record<string, unknown>)[version] !==
        vapidKeyring[version]?.publicKey
    ) throw new Error("NOTIFICATION_DELIVERY_NOT_CONFIGURED");
  }
  const secretValues = [
    invokeSecret,
    required("SUPABASE_SERVICE_ROLE_KEY"),
    required("WEB_PUSH_BINDING_DIGEST_SECRET"),
    required("WEB_PUSH_SUBSCRIPTION_KEY_BASE64"),
    current.privateKey,
    ...Object.values(envelopeRaw).map(String),
    ...Object.values(vapidKeyring).map((v) => v.privateKey),
  ];
  if (
    utf8(invokeSecret).length < 32 || envelopeKey.length !== 32 ||
    !/^[A-Za-z0-9._-]{1,32}$/.test(envelopeVersion) ||
    !/^[A-Za-z0-9._-]{1,32}$/.test(vapidVersion) ||
    Object.hasOwn(envelopeKeyring, envelopeVersion) ||
    Object.hasOwn(vapidKeyring, vapidVersion) ||
    new Set(secretValues).size !== secretValues.length
  ) throw new Error("NOTIFICATION_DELIVERY_NOT_CONFIGURED");
  return {
    invokeSecret,
    envelope: {
      currentVersion: envelopeVersion,
      currentKey: envelopeKey,
      keyring: envelopeKeyring,
    },
    vapid: {
      subject,
      currentVersion: vapidVersion,
      current,
      keyring: vapidKeyring,
    },
  };
}
async function authorized(
  provided: string | null,
  expected: string,
): Promise<boolean> {
  const providedBytes = provided === null ? null : utf8(provided);
  const expectedBytes = utf8(expected);
  if (
    providedBytes === null || providedBytes.length < 32 ||
    providedBytes.length > 4096 || expectedBytes.length < 32 ||
    expectedBytes.length > 4096
  ) return false;
  const tag = async (keyBytes: Uint8Array) => {
    const key = await crypto.subtle.importKey(
      "raw",
      bytes(keyBytes),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        bytes(utf8("notification-delivery:invoke:v1")),
      ),
    );
  };
  const [left, right] = await Promise.all([
    tag(providedBytes),
    tag(expectedBytes),
  ]);
  let mismatch = 0;
  for (let i = 0; i < left.length; i++) {
    mismatch |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return mismatch === 0;
}
const response = (status: number, id: string, result: unknown) =>
  new Response(
    JSON.stringify({
      requestId: id,
      ...(result && typeof result === "object" ? result : {}),
    }),
    {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
export interface NotificationDeliveryHandlerDependencies {
  loadInvokeSecret?: () => string;
  loadConfig?: typeof notificationDeliveryConfig;
  run?: (
    config: ReturnType<typeof notificationDeliveryConfig>,
  ) => Promise<Record<string, number>>;
  validateConfig?: (
    config: ReturnType<typeof notificationDeliveryConfig>,
  ) => Promise<void>;
  recordConfigurationFailure?: () => Promise<void>;
}
async function recordConfigurationFailure(): Promise<void> {
  const { error } = await createEdgeClients().admin.rpc(
    "record_notification_delivery_heartbeat",
    {
      p_status: "degraded",
      p_claimed: 0,
      p_delivered: 0,
      p_retrying: 0,
      p_suppressed: 0,
      p_dead_letter: 0,
      p_blocked: 0,
      p_deferred: 0,
      p_error_code: "PROVIDER_CONFIGURATION_ERROR",
    },
  );
  if (error) throw new Error("NOTIFICATION_DELIVERY_HEARTBEAT_FAILED");
}
export async function handleNotificationDelivery(
  request: Request,
  dependencies: NotificationDeliveryHandlerDependencies = {},
): Promise<Response> {
  const id = requestId(request);
  try {
    if (
      request.method !== "POST" ||
      new URL(request.url).pathname !==
        "/functions/v1/notification-delivery" ||
      [...new URL(request.url).searchParams.keys()].length
    ) {
      return response(404, id, {
        error: {
          code: "NOT_FOUND",
          message: "요청한 경로를 찾을 수 없습니다.",
        },
      });
    }
    const contentLength = request.headers.get("content-length")?.trim();
    if (
      request.body !== null ||
      (contentLength !== undefined && contentLength !== "0")
    ) {
      return response(400, id, {
        error: {
          code: "VALIDATION_ERROR",
          message: "요청 본문은 허용되지 않습니다.",
        },
      });
    }
    const invokeSecret = (dependencies.loadInvokeSecret ?? (() =>
      required("NOTIFICATION_DELIVERY_INVOKE_SECRET")))();
    if (utf8(invokeSecret).length < 32) {
      throw new Error("NOTIFICATION_DELIVERY_NOT_CONFIGURED");
    }
    if (
      !await authorized(
        request.headers.get("x-notification-delivery-invoke-secret"),
        invokeSecret,
      )
    ) {
      return response(401, id, {
        error: {
          code: "INVALID_INVOKE_SECRET",
          message: "호출 인증에 실패했습니다.",
        },
      });
    }
    let config: ReturnType<typeof notificationDeliveryConfig>;
    try {
      config = (dependencies.loadConfig ?? notificationDeliveryConfig)();
      await (dependencies.validateConfig ?? ((value) =>
        validateWebPushProviderConfig(value.vapid)))(config);
    } catch {
      try {
        await (dependencies.recordConfigurationFailure ??
          recordConfigurationFailure)();
      } catch {
        /* configuration failure remains authoritative */
      }
      return response(503, id, {
        error: {
          code: "NOTIFICATION_DELIVERY_UNAVAILABLE",
          message: "알림 전송을 실행하지 못했습니다.",
        },
      });
    }
    const result = dependencies.run
      ? await dependencies.run(config)
      : await new EdgeNotificationDeliveryWorker(
        createEdgeClients().admin,
        new RfcWebPushProvider(config.vapid),
        config.envelope,
      ).run();
    return response(200, id, result);
  } catch {
    return response(503, id, {
      error: {
        code: "NOTIFICATION_DELIVERY_UNAVAILABLE",
        message: "알림 전송을 실행하지 못했습니다.",
      },
    });
  }
}

if (import.meta.main) {
  Deno.serve((request) => handleNotificationDelivery(request));
}
