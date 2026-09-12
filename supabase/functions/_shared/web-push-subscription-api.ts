import { idempotencyKey } from "./account-api.ts";
import {
  type EdgeActor,
  type EdgeClients,
  EdgeError,
  requirePasswordChanged,
  verifiedRequestSessionId,
} from "./runtime.ts";
import {
  issueWebPushBindingProof,
  verifyWebPushBindingProof,
  WebPushBindingProofError,
} from "./web-push-binding-proof.ts";

interface SubscriptionInput {
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
}
interface ExpectedCurrent {
  subscriptionId: string;
  version: number;
}
export interface WebPushCryptoConfig {
  key: Uint8Array;
  version: string;
  secret: string;
  vapidKeyVersion: string;
  vapidPublicKey: string;
  vapidPublicKeyring: Record<string, string>;
  /** Deterministic vector input only; production callers leave this undefined. */
  nonce?: Uint8Array;
}
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const b64uPattern = /^[A-Za-z0-9_-]+$/;
const responseLimit = 128 * 1024;

function invalid(message = "Web Push 구독 값이 올바르지 않습니다."): never {
  throw new EdgeError(400, "INVALID_WEB_PUSH_SUBSCRIPTION", message);
}
function canonicalUuid(value: string): string {
  if (!uuidPattern.test(value)) invalid();
  return value.toLowerCase();
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
    invalid();
  }
}
function b64u(value: unknown, length: number): Uint8Array {
  if (
    typeof value !== "string" || !b64uPattern.test(value) || value.includes("=")
  ) invalid();
  const standard = value.replace(/-/g, "+").replace(/_/g, "/");
  let binary: string;
  try {
    binary = atob(standard + "=".repeat((4 - standard.length % 4) % 4));
  } catch {
    invalid();
  }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (bytes.length !== length || base64url(bytes) !== value) invalid();
  return bytes;
}
function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(
    /\+/g,
    "-",
  ).replace(/\//g, "_");
}
function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
async function hmac(
  secret: string,
  domain: string,
  value: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    utf8(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(
    await crypto.subtle.sign("HMAC", key, utf8(`${domain}\0${value}`)),
  );
}
function required(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) {
    throw new EdgeError(
      503,
      "WEB_PUSH_NOT_CONFIGURED",
      "Web Push 구독 암호화 설정이 필요합니다.",
    );
  }
  return value;
}
function decodeBase64(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new EdgeError(
      503,
      "WEB_PUSH_NOT_CONFIGURED",
      "Web Push 구독 암호화 설정이 필요합니다.",
    );
  }
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
function config(): WebPushCryptoConfig {
  const encodedKey = required("WEB_PUSH_SUBSCRIPTION_KEY_BASE64");
  const key = decodeBase64(encodedKey);
  const version = required("WEB_PUSH_SUBSCRIPTION_KEY_VERSION");
  const secret = required("WEB_PUSH_BINDING_DIGEST_SECRET");
  const vapidKeyVersion = required("VAPID_CURRENT_KEY_VERSION");
  const vapidPublicKey = required("VAPID_PUBLIC_KEY");
  let vapidPublicKeyring: Record<string, string>;
  try {
    const raw = JSON.parse(
      Deno.env.get("VAPID_PUBLIC_KEYRING_JSON")?.trim() || "{}",
    ) as unknown;
    if (
      !raw || typeof raw !== "object" || Array.isArray(raw) ||
      Object.hasOwn(raw, vapidKeyVersion) || Object.keys(raw).length > 5
    ) throw new Error();
    vapidPublicKeyring = {};
    for (const [entryVersion, value] of Object.entries(raw)) {
      if (
        !/^[A-Za-z0-9._-]{1,32}$/.test(entryVersion) ||
        typeof value !== "string"
      ) throw new Error();
      vapidPublicKeyring[entryVersion] = value;
    }
  } catch {
    throw new EdgeError(
      503,
      "WEB_PUSH_NOT_CONFIGURED",
      "Web Push 구독 암호화 설정이 필요합니다.",
    );
  }
  let vapidPoint: Uint8Array;
  try {
    vapidPoint = b64u(vapidPublicKey, 65);
  } catch {
    throw new EdgeError(
      503,
      "WEB_PUSH_NOT_CONFIGURED",
      "Web Push 구독 암호화 설정이 필요합니다.",
    );
  }
  const forbidden = [
    "SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "ACCOUNT_PHONE_PEPPER",
    "RESERVATION_PII_KEY_BASE64",
    "RESERVATION_GUEST_NAME_PEPPER",
    "PAYROLL_CURSOR_HMAC_SECRET",
    "NOTIFICATION_CURSOR_HMAC_SECRET",
  ].map((n) => Deno.env.get(n)?.trim()).filter(Boolean);
  let keyring: Record<string, unknown>;
  try {
    keyring = JSON.parse(
      Deno.env.get("WEB_PUSH_SUBSCRIPTION_KEYRING_JSON")?.trim() || "{}",
    );
    if (!keyring || Array.isArray(keyring) || typeof keyring !== "object") {
      throw new Error();
    }
  } catch {
    throw new EdgeError(
      503,
      "WEB_PUSH_NOT_CONFIGURED",
      "Web Push 구독 암호화 설정이 필요합니다.",
    );
  }
  const prior: string[] = [];
  if (Object.hasOwn(keyring, version)) {
    throw new EdgeError(
      503,
      "WEB_PUSH_NOT_CONFIGURED",
      "Web Push 구독 암호화 설정이 필요합니다.",
    );
  }
  for (const [entryVersion, value] of Object.entries(keyring)) {
    if (
      !/^[A-Za-z0-9._-]{1,32}$/.test(entryVersion) || typeof value !== "string"
    ) {
      throw new EdgeError(
        503,
        "WEB_PUSH_NOT_CONFIGURED",
        "Web Push 구독 암호화 설정이 필요합니다.",
      );
    }
    const priorKey = decodeBase64(value);
    if (priorKey.length !== 32 || base64(priorKey) !== value) {
      throw new EdgeError(
        503,
        "WEB_PUSH_NOT_CONFIGURED",
        "Web Push 구독 암호화 설정이 필요합니다.",
      );
    }
    prior.push(value);
  }
  if (
    key.length !== 32 || base64(key) !== encodedKey ||
    !/^[A-Za-z0-9._-]{1,32}$/.test(version) || utf8(secret).length < 32 ||
    !/^[A-Za-z0-9._-]{1,32}$/.test(vapidKeyVersion) ||
    vapidPoint[0] !== 4 ||
    forbidden.includes(encodedKey) || forbidden.includes(secret) ||
    encodedKey === secret ||
    prior.includes(encodedKey) || prior.includes(secret) ||
    prior.some((value) => forbidden.includes(value)) ||
    new Set(prior).size !== prior.length
  ) {
    throw new EdgeError(
      503,
      "WEB_PUSH_NOT_CONFIGURED",
      "Web Push 구독 암호화 설정이 필요합니다.",
    );
  }
  return {
    key,
    version,
    secret,
    vapidKeyVersion,
    vapidPublicKey,
    vapidPublicKeyring,
  };
}

function proofError(error: unknown): EdgeError {
  return error instanceof WebPushBindingProofError &&
      error.reason === "INVALID_CONFIGURATION"
    ? new EdgeError(
      503,
      "WEB_PUSH_NOT_CONFIGURED",
      "Web Push 공개키 설정이 올바르지 않습니다.",
    )
    : new EdgeError(
      400,
      "WEB_PUSH_BINDING_PROOF_INVALID",
      "Web Push 구독 키 증명이 만료되었거나 올바르지 않습니다.",
    );
}
function proofActor(actor: EdgeActor, sessionId: string) {
  return {
    authUserId: canonicalUuid(actor.authUserId),
    profileId: canonicalUuid(actor.profileId),
    sessionId: canonicalUuid(sessionId),
  };
}
function proofKeys(config: WebPushCryptoConfig) {
  return {
    currentVersion: config.vapidKeyVersion,
    currentPublicKey: config.vapidPublicKey,
    publicKeyring: config.vapidPublicKeyring,
  };
}

export async function webPushPublicConfig(
  request: Request,
  actor: EdgeActor,
  cryptoConfig: WebPushCryptoConfig = config(),
): Promise<Record<string, string>> {
  webPushActor(actor);
  const proof = await issueWebPushBindingProof(
    proofActor(actor, verifiedRequestSessionId(request)),
    proofKeys(cryptoConfig),
    cryptoConfig.secret,
  ).catch((error: unknown) => {
    throw proofError(error);
  });
  return {
    keyVersion: cryptoConfig.vapidKeyVersion,
    publicKey: cryptoConfig.vapidPublicKey,
    ...proof,
  };
}
async function parseBody(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (utf8(raw).length > 8192) invalid();
  try {
    return object(JSON.parse(raw));
  } catch {
    invalid();
  }
}
function queryless(request: Request): void {
  if ([...new URL(request.url).searchParams.keys()].length) {
    invalid("query 항목은 허용되지 않습니다.");
  }
}
async function parseSubscription(value: unknown): Promise<SubscriptionInput> {
  const input = object(value);
  exactKeys(input, ["endpoint", "expirationTime", "keys"]);
  if (
    typeof input.endpoint !== "string" || !input.endpoint ||
    utf8(input.endpoint).length > 4096
  ) invalid();
  let url: URL;
  try {
    url = new URL(input.endpoint);
  } catch {
    invalid();
  }
  if (
    url.protocol !== "https:" || url.username || url.password || url.hash ||
    input.endpoint.includes("#") || /^https:\/\/[^/?#]*@/i.test(input.endpoint)
  ) {
    invalid();
  }
  if (
    input.expirationTime !== null &&
    (!Number.isSafeInteger(input.expirationTime) ||
      Number(input.expirationTime) <= Date.now())
  ) invalid();
  const keys = object(input.keys);
  exactKeys(keys, ["p256dh", "auth"]);
  const point = b64u(keys.p256dh, 65);
  b64u(keys.auth, 16);
  if (point[0] !== 4) invalid();
  try {
    await crypto.subtle.importKey(
      "raw",
      point,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
  } catch {
    invalid();
  }
  const canonicalEndpoint = `https://${url.host}${url.pathname}${url.search}`;
  if (utf8(canonicalEndpoint).length > 4096) invalid();
  return {
    endpoint: canonicalEndpoint,
    expirationTime: input.expirationTime as number | null,
    keys: { p256dh: keys.p256dh as string, auth: keys.auth as string },
  };
}
function webPushActor(actor: EdgeActor): void {
  requirePasswordChanged(actor);
  if (actor.role !== "admin" && actor.role !== "maid") {
    throw new EdgeError(
      403,
      "WEB_PUSH_ACCESS_REQUIRED",
      "Web Push 구독 권한이 필요합니다.",
    );
  }
}
function dbError(error: { message?: string } | null): EdgeError {
  const mappings: Array<[string, number, string, string]> = [
    [
      "WEB_PUSH_SESSION_REVOKED",
      401,
      "SESSION_REVOKED",
      "로그인이 만료되었습니다. 다시 로그인해 주세요.",
    ],
    [
      "WEB_PUSH_ACCESS_REQUIRED",
      403,
      "WEB_PUSH_ACCESS_REQUIRED",
      "Web Push 구독 권한이 필요합니다.",
    ],
    [
      "WEB_PUSH_SUBSCRIPTION_NOT_FOUND",
      404,
      "WEB_PUSH_SUBSCRIPTION_NOT_FOUND",
      "Web Push 구독을 찾을 수 없습니다.",
    ],
    [
      "WEB_PUSH_RATE_LIMITED",
      429,
      "WEB_PUSH_RATE_LIMITED",
      "Web Push 구독 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
    ],
    [
      "WEB_PUSH_PROFILE_LIMIT",
      409,
      "WEB_PUSH_PROFILE_LIMIT",
      "등록 가능한 Web Push 기기 수를 초과했습니다.",
    ],
    [
      "WEB_PUSH_ENDPOINT_CONFLICT",
      409,
      "WEB_PUSH_ENDPOINT_CONFLICT",
      "이 Web Push 구독을 사용할 수 없습니다.",
    ],
    [
      "WEB_PUSH_SUBSCRIPTION_CONFLICT",
      409,
      "WEB_PUSH_SUBSCRIPTION_CONFLICT",
      "Web Push 구독 상태가 변경되었습니다.",
    ],
    [
      "WEB_PUSH_CAS_REQUIRED",
      409,
      "WEB_PUSH_CAS_REQUIRED",
      "현재 구독 ID와 version이 필요합니다.",
    ],
    [
      "WEB_PUSH_STALE_VERSION",
      409,
      "WEB_PUSH_STALE_VERSION",
      "Web Push 구독 version이 변경되었습니다.",
    ],
    [
      "IDEMPOTENCY_KEY_REUSED",
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "이미 다른 요청에 사용한 Idempotency-Key입니다.",
    ],
    [
      "INVALID_WEB_PUSH",
      400,
      "INVALID_WEB_PUSH_SUBSCRIPTION",
      "Web Push 구독 값이 올바르지 않습니다.",
    ],
  ];
  const message = error?.message ?? "";
  for (const [needle, status, code, text] of mappings) {
    if (message.includes(needle)) return new EdgeError(status, code, text);
  }
  return new EdgeError(
    500,
    "WEB_PUSH_COMMAND_FAILED",
    "Web Push 구독을 처리하지 못했습니다.",
  );
}
async function rpc(
  clients: EdgeClients,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const { data, error } = await clients.admin.rpc(name, args);
  if (error || data === null) throw dbError(error);
  return data;
}
function projection(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw dbError(null);
  }
  const row = value as Record<string, unknown>;
  const expected = [
    "createdAt",
    "id",
    "retiredAt",
    "status",
    "updatedAt",
    "version",
  ];
  if (
    Object.keys(row).sort().join(",") !== expected.join(",") ||
    typeof row.id !== "string" || !uuidPattern.test(row.id) ||
    !Number.isInteger(row.version) ||
    !["active", "retired"].includes(String(row.status)) ||
    !strictRfc3339(row.createdAt) || !strictRfc3339(row.updatedAt) ||
    (row.retiredAt !== null && !strictRfc3339(row.retiredAt))
  ) throw dbError(null);
  return { ...row, id: row.id.toLowerCase() };
}
const timestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;
function strictRfc3339(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = timestampPattern.exec(value);
  if (!match) return false;
  const year = Number(match[1]),
    month = Number(match[2]),
    day = Number(match[3]);
  const hour = Number(match[4]),
    minute = Number(match[5]),
    second = Number(match[6]);
  const offsetHour = match[8] === "Z" ? 0 : Number(match[10]);
  const offsetMinute = match[8] === "Z" ? 0 : Number(match[11]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 &&
    day <= (days[month - 1] ?? 0) && hour <= 23 && minute <= 59 &&
    second <= 59 && offsetHour <= 23 && offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value));
}
function sized(value: unknown): unknown {
  if (utf8(JSON.stringify(value)).length > responseLimit) {
    throw new EdgeError(
      500,
      "WEB_PUSH_RESPONSE_TOO_LARGE",
      "Web Push 구독 응답 크기 제한을 초과했습니다.",
    );
  }
  return value;
}

export function webPushRetirePath(path: string): string | null {
  const match = path.match(/^\/v1\/push-subscriptions\/([^/]+)\/retire$/);
  if (!match) return null;
  if (!uuidPattern.test(match[1] ?? "")) {
    invalid("subscriptionId에 UUID가 필요합니다.");
  }
  return (match[1] ?? "").toLowerCase();
}

export async function registerWebPushSubscription(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  cryptoConfig: WebPushCryptoConfig = config(),
): Promise<unknown> {
  webPushActor(actor);
  queryless(request);
  const body = await parseBody(request);
  exactKeys(body, [
    "bindingProof",
    "subscription",
    ...(Object.hasOwn(body, "expectedCurrent") ? ["expectedCurrent"] : []),
  ]);
  if (
    typeof body.bindingProof !== "string" ||
    utf8(body.bindingProof).length > 2048
  ) invalid();
  const subscription = await parseSubscription(body.subscription);
  let expected: ExpectedCurrent | undefined;
  if (Object.hasOwn(body, "expectedCurrent")) {
    const value = object(body.expectedCurrent);
    exactKeys(value, ["subscriptionId", "version"]);
    if (
      typeof value.subscriptionId !== "string" ||
      !uuidPattern.test(value.subscriptionId) ||
      !Number.isInteger(value.version) || Number(value.version) < 1
    ) invalid();
    expected = {
      subscriptionId: value.subscriptionId.toLowerCase(),
      version: Number(value.version),
    };
  }
  const actorProfileId = canonicalUuid(actor.profileId);
  const sessionId = canonicalUuid(verifiedRequestSessionId(request));
  const proposed = canonicalUuid(
    expected?.subscriptionId ?? crypto.randomUUID(),
  );
  const revision = (expected?.version ?? 0) + 1;
  const cfg = cryptoConfig;
  const binding = await verifyWebPushBindingProof(
    body.bindingProof,
    proofActor(actor, sessionId),
    proofKeys(cfg),
    cfg.secret,
  ).catch((error: unknown) => {
    throw proofError(error);
  });
  const canonical = JSON.stringify({
    auth: subscription.keys.auth,
    endpoint: subscription.endpoint,
    expirationTime: subscription.expirationTime,
    p256dh: subscription.keys.p256dh,
    sessionId,
  });
  const [endpointDigest, sessionDigest, materialDigest] = await Promise.all([
    hmac(cfg.secret, "web-push-endpoint:v1", subscription.endpoint),
    hmac(cfg.secret, "web-push-session:v1", sessionId),
    hmac(cfg.secret, "web-push-material:v1", canonical),
  ]);
  const aad = utf8(
    `web-push-envelope:v1\0${actorProfileId}\0${sessionDigest}\0${endpointDigest}\0${proposed}\0${revision}`,
  );
  const nonce = cfg.nonce === undefined
    ? crypto.getRandomValues(new Uint8Array(12))
    : new Uint8Array(cfg.nonce);
  if (nonce.length !== 12) invalid();
  const key = await crypto.subtle.importKey(
    "raw",
    cfg.key,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 },
      key,
      utf8(canonical),
    ),
  );
  const cipher = sealed.slice(0, -16), tag = sealed.slice(-16);
  const requestHash = hex(
    await crypto.subtle.digest(
      "SHA-256",
      utf8(
        JSON.stringify({
          endpointDigest,
          expirationTime: subscription.expirationTime,
          materialDigest,
          sessionDigest,
          subscriptionId: expected?.subscriptionId ?? null,
          revisionNo: revision,
          vapidKeyVersion: binding.keyVersion,
          bindingProofDigest: hex(
            await crypto.subtle.digest("SHA-256", utf8(body.bindingProof)),
          ),
        }),
      ),
    ),
  );
  return sized({
    subscription: projection(
      await rpc(clients, "register_web_push_subscription", {
        p_actor_profile_id: actorProfileId,
        p_session_id: sessionId,
        p_proposed_subscription_id: proposed,
        p_expected_subscription_id: expected?.subscriptionId ?? null,
        p_expected_version: expected?.version ?? null,
        p_endpoint_digest: endpointDigest,
        p_session_digest: sessionDigest,
        p_material_digest: materialDigest,
        p_expiration_at: subscription.expirationTime === null
          ? null
          : new Date(subscription.expirationTime).toISOString(),
        p_key_version: cfg.version,
        p_ciphertext_base64: base64(cipher),
        p_nonce_base64: base64(nonce),
        p_auth_tag_base64: base64(tag),
        p_idempotency_key: idempotencyKey(request),
        p_request_hash: requestHash,
        p_vapid_key_version: binding.keyVersion,
      }),
    ),
  });
}

export async function retireWebPushSubscription(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  subscriptionId: string,
): Promise<unknown> {
  webPushActor(actor);
  queryless(request);
  const body = await parseBody(request);
  exactKeys(body, ["expectedVersion"]);
  if (
    !Number.isInteger(body.expectedVersion) || Number(body.expectedVersion) < 1
  ) invalid();
  const actorProfileId = canonicalUuid(actor.profileId);
  const canonicalSessionId = canonicalUuid(verifiedRequestSessionId(request));
  const canonicalSubscriptionId = canonicalUuid(subscriptionId);
  const requestHash = hex(
    await crypto.subtle.digest(
      "SHA-256",
      utf8(
        JSON.stringify({
          subscriptionId: canonicalSubscriptionId,
          expectedVersion: Number(body.expectedVersion),
        }),
      ),
    ),
  );
  return sized({
    subscription: projection(
      await rpc(clients, "retire_web_push_subscription", {
        p_actor_profile_id: actorProfileId,
        p_session_id: canonicalSessionId,
        p_subscription_id: canonicalSubscriptionId,
        p_expected_version: Number(body.expectedVersion),
        p_idempotency_key: idempotencyKey(request),
        p_request_hash: requestHash,
      }),
    ),
  });
}
