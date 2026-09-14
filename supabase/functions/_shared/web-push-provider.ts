// Generated from src/modules/notifications/web-push-provider.ts. DO NOT EDIT.
/** RFC 8030/8291/8292 Web Push. Runtime-neutral: shared verbatim with Deno. */
export interface VapidKeyMaterial {
  publicKey: string;
  privateKey: string;
}
export interface WebPushProviderConfig {
  subject: string;
  currentVersion: string;
  current: VapidKeyMaterial;
  keyring: Record<string, VapidKeyMaterial>;
}
export interface WebPushSubscriptionMaterial {
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
}
export type WebPushProviderOutcome =
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
export interface WebPushEncryptionVector {
  salt: Uint8Array;
  senderPrivateKey: Uint8Array;
  senderPublicKey: Uint8Array;
}

const encoder = new TextEncoder();
const utf8 = (value: string) => encoder.encode(value);
const bytes = (value: Uint8Array) =>
  value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;
const concat = (...values: Uint8Array[]) => {
  const out = new Uint8Array(values.reduce((n, v) => n + v.length, 0));
  let at = 0;
  for (const value of values) {
    out.set(value, at);
    at += value.length;
  }
  return out;
};
const b64u = (value: Uint8Array) => {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
};
function fromB64u(value: string, expected: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.includes("=")) {
    throw new Error("WEB_PUSH_PROVIDER_CONFIGURATION");
  }
  let binary: string;
  try {
    binary = atob(
      value.replace(/-/g, "+").replace(/_/g, "/") +
        "=".repeat((4 - value.length % 4) % 4),
    );
  } catch {
    throw new Error("WEB_PUSH_PROVIDER_CONFIGURATION");
  }
  const out = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  if (out.length !== expected || b64u(out) !== value) {
    throw new Error("WEB_PUSH_PROVIDER_CONFIGURATION");
  }
  return out;
}
async function hmac(key: Uint8Array, value: Uint8Array): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey(
    "raw",
    bytes(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", imported, bytes(value)),
  );
}
async function expand(
  prk: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  return (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, length);
}
function jwk(point: Uint8Array, privateKey?: Uint8Array): JsonWebKey {
  if (point.length !== 65 || point[0] !== 4) {
    throw new Error("WEB_PUSH_PROVIDER_CONFIGURATION");
  }
  return {
    kty: "EC",
    crv: "P-256",
    x: b64u(point.slice(1, 33)),
    y: b64u(point.slice(33, 65)),
    ...(privateKey ? { d: b64u(privateKey) } : {}),
  };
}
async function deriveSecret(
  privateKey: Uint8Array,
  senderPublic: Uint8Array,
  receiverPublic: Uint8Array,
): Promise<Uint8Array> {
  const own = await crypto.subtle.importKey(
    "jwk",
    jwk(senderPublic, privateKey),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const peer = await crypto.subtle.importKey(
    "raw",
    bytes(receiverPublic),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, own, 256),
  );
}
async function generatedSender(): Promise<WebPushEncryptionVector> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey),
    publicRaw = new Uint8Array(
      await crypto.subtle.exportKey("raw", pair.publicKey),
    );
  return {
    salt: crypto.getRandomValues(new Uint8Array(16)),
    senderPrivateKey: fromB64u(String(privateJwk.d), 32),
    senderPublicKey: publicRaw,
  };
}
export async function encryptWebPushAes128Gcm(
  payload: string,
  p256dh: string,
  auth: string,
  vector?: WebPushEncryptionVector,
): Promise<Uint8Array> {
  const plain = utf8(payload);
  if (plain.length > 3072) throw new Error("WEB_PUSH_PAYLOAD_TOO_LARGE");
  const receiver = fromB64u(p256dh, 65),
    authSecret = fromB64u(auth, 16),
    sender = vector ?? await generatedSender();
  if (
    sender.salt.length !== 16 || sender.senderPrivateKey.length !== 32 ||
    sender.senderPublicKey.length !== 65
  ) throw new Error("WEB_PUSH_PROVIDER_CONFIGURATION");
  const shared = await deriveSecret(
    sender.senderPrivateKey,
    sender.senderPublicKey,
    receiver,
  );
  const prkKey = await hmac(authSecret, shared);
  const ikm = await expand(
    prkKey,
    concat(
      utf8("WebPush: info"),
      new Uint8Array([0]),
      receiver,
      sender.senderPublicKey,
    ),
    32,
  );
  const prk = await hmac(sender.salt, ikm);
  const cek = await expand(
    prk,
    concat(utf8("Content-Encoding: aes128gcm"), new Uint8Array([0])),
    16,
  );
  const nonce = await expand(
    prk,
    concat(utf8("Content-Encoding: nonce"), new Uint8Array([0])),
    12,
  );
  const key = await crypto.subtle.importKey(
    "raw",
    bytes(cek),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: bytes(nonce), tagLength: 128 },
      key,
      bytes(concat(plain, new Uint8Array([2]))),
    ),
  );
  const header = new Uint8Array(86);
  header.set(sender.salt);
  new DataView(header.buffer).setUint32(16, 4096, false);
  header[20] = 65;
  header.set(sender.senderPublicKey, 21);
  const body = concat(header, ciphertext);
  if (body.length > 4096) throw new Error("WEB_PUSH_PAYLOAD_TOO_LARGE");
  return body;
}
function allowedEndpoint(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const allowed = host === "fcm.googleapis.com" ||
    host === "updates.push.services.mozilla.com" ||
    host.endsWith(".push.apple.com") || host.endsWith(".notify.windows.com");
  const ip = /^\[.*\]$/.test(url.hostname) ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
  if (
    url.protocol !== "https:" || url.port || url.username || url.password ||
    url.hash || ip || !allowed
  ) return null;
  return url;
}
function validSubject(value: string): boolean {
  if (
    utf8(value).length > 2048 ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x20 || code === 0x7f;
    })
  ) {
    return false;
  }
  if (/^mailto:[^@/?#]+@[^@/?#]+$/i.test(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) &&
      !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}
export async function validateWebPushProviderConfig(
  config: WebPushProviderConfig,
): Promise<void> {
  if (
    !validSubject(config.subject) ||
    !/^[A-Za-z0-9._-]{1,32}$/.test(config.currentVersion) ||
    Object.hasOwn(config.keyring, config.currentVersion)
  ) throw new Error("WEB_PUSH_PROVIDER_CONFIGURATION");
  for (
    const [version, key] of [
      [config.currentVersion, config.current] as const,
      ...Object.entries(config.keyring),
    ]
  ) {
    if (!/^[A-Za-z0-9._-]{1,32}$/.test(version)) {
      throw new Error("WEB_PUSH_PROVIDER_CONFIGURATION");
    }
    const point = fromB64u(key.publicKey, 65),
      scalar = fromB64u(key.privateKey, 32);
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      jwk(point, scalar),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    const publicKey = await crypto.subtle.importKey(
      "raw",
      bytes(point),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const probe = utf8("web-push-vapid-key-validation:v1"),
      signature = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        privateKey,
        bytes(probe),
      );
    if (
      !await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey,
        signature,
        bytes(probe),
      )
    ) throw new Error("WEB_PUSH_PROVIDER_CONFIGURATION");
  }
}
async function vapidAuthorization(
  endpoint: URL,
  subject: string,
  key: VapidKeyMaterial,
  nowSeconds: number,
): Promise<string> {
  if (!validSubject(subject)) {
    throw new Error("WEB_PUSH_PROVIDER_CONFIGURATION");
  }
  const publicKey = fromB64u(key.publicKey, 65),
    privateKey = fromB64u(key.privateKey, 32);
  const signing = await crypto.subtle.importKey(
    "jwk",
    jwk(publicKey, privateKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const header = b64u(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(
    utf8(
      JSON.stringify({
        aud: endpoint.origin,
        exp: nowSeconds + 12 * 60 * 60,
        sub: subject,
      }),
    ),
  );
  const input = `${header}.${claims}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      signing,
      bytes(utf8(input)),
    ),
  );
  if (signature.length !== 64) {
    throw new Error("WEB_PUSH_PROVIDER_CONFIGURATION");
  }
  return `vapid t=${input}.${b64u(signature)}, k=${key.publicKey}`;
}
function safePayload(raw: string, notificationId: string): string {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("WEB_PUSH_PAYLOAD_REJECTED");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("WEB_PUSH_PAYLOAD_REJECTED");
  }
  const row = value as Record<string, unknown>, deep = row.deepLink;
  if (
    row.notificationId !== notificationId || !deep ||
    typeof deep !== "object" || Array.isArray(deep)
  ) throw new Error("WEB_PUSH_PAYLOAD_REJECTED");
  const link = deep as Record<string, unknown>;
  const kinds = new Set([
    "cleaningTarget",
    "assignmentRequest",
    "submission",
    "complaintCase",
    "payrollCycle",
    "payrollProfile",
  ]);
  if (
    typeof link.kind !== "string" || !kinds.has(link.kind) ||
    typeof link.entityId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(link.entityId)
  ) throw new Error("WEB_PUSH_PAYLOAD_REJECTED");
  const payload = JSON.stringify({
    payloadVersion: 1,
    notificationId,
    title: "새 업무 알림",
    body: "앱에서 확인해 주세요",
    deepLink: { kind: link.kind, entityId: link.entityId.toLowerCase() },
  });
  if (utf8(payload).length > 3072) throw new Error("WEB_PUSH_PAYLOAD_REJECTED");
  return payload;
}
async function topic(notificationId: string): Promise<string> {
  return b64u(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes(utf8(notificationId))),
    ),
  ).slice(0, 32);
}
export function parseRetryAfter(
  value: string | null,
  nowMs: number,
): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  let seconds: number;
  if (/^\d+$/.test(trimmed)) seconds = Number(trimmed);
  else {
    const at = Date.parse(trimmed);
    if (!Number.isFinite(at)) return undefined;
    seconds = Math.ceil((at - nowMs) / 1000);
  }
  if (!Number.isSafeInteger(seconds)) return undefined;
  return Math.min(3600, Math.max(1, seconds));
}
export class RfcWebPushProvider {
  constructor(
    private config: WebPushProviderConfig,
    private fetcher: typeof fetch = fetch,
    private clock: () => number = Date.now,
  ) {}
  async send(
    subscription: WebPushSubscriptionMaterial,
    rawPayload: string,
    notificationId: string,
    deadlineAt: number,
    vapidKeyVersion: string,
  ): Promise<WebPushProviderOutcome> {
    const endpoint = allowedEndpoint(subscription.endpoint),
      key = vapidKeyVersion === this.config.currentVersion
        ? this.config.current
        : this.config.keyring[vapidKeyVersion];
    if (!endpoint || !key) return { outcome: "provider_configuration_error" };
    let body: Uint8Array, authorization: string, payload: string;
    try {
      payload = safePayload(rawPayload, notificationId);
      body = await encryptWebPushAes128Gcm(
        payload,
        subscription.keys.p256dh,
        subscription.keys.auth,
      );
      authorization = await vapidAuthorization(
        endpoint,
        this.config.subject,
        key,
        Math.floor(this.clock() / 1000),
      );
    } catch (error) {
      return error instanceof Error &&
            error.message === "WEB_PUSH_PAYLOAD_REJECTED" ||
          error instanceof Error &&
            error.message === "WEB_PUSH_PAYLOAD_TOO_LARGE"
        ? { outcome: "payload_rejected" }
        : { outcome: "provider_configuration_error" };
    }
    const remaining = Math.floor(deadlineAt - this.clock());
    if (remaining <= 0) return { outcome: "retryable", reason: "TIMEOUT" };
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), remaining);
    try {
      const response = await this.fetcher(endpoint, {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Authorization: authorization,
          "Content-Encoding": "aes128gcm",
          "Content-Type": "application/octet-stream",
          TTL: "86400",
          Urgency: "normal",
          Topic: await topic(notificationId),
        },
        body: bytes(body),
      });
      if ([201, 202, 204].includes(response.status)) {
        return { outcome: "accepted" };
      }
      if (response.status === 404 || response.status === 410) {
        return { outcome: "endpoint_gone" };
      }
      if (response.status === 400 || response.status === 413) {
        return { outcome: "payload_rejected" };
      }
      if (response.status === 429) {
        const retryAfterSeconds = parseRetryAfter(
          response.headers.get("retry-after"),
          this.clock(),
        );
        return retryAfterSeconds === undefined
          ? { outcome: "retryable", reason: "RATE_LIMITED" }
          : { outcome: "retryable", reason: "RATE_LIMITED", retryAfterSeconds };
      }
      if (response.status === 408) {
        return { outcome: "retryable", reason: "TIMEOUT" };
      }
      if (response.status >= 500 && response.status <= 599) {
        return { outcome: "retryable", reason: "PROVIDER_ERROR" };
      }
      return { outcome: "provider_configuration_error" };
    } catch (error) {
      return controller.signal.aborted ||
          error instanceof DOMException && error.name === "AbortError"
        ? { outcome: "retryable", reason: "TIMEOUT" }
        : { outcome: "retryable", reason: "NETWORK_ERROR" };
    } finally {
      clearTimeout(timer);
    }
  }
}
