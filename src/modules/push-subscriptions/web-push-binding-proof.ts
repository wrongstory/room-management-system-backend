export const WEB_PUSH_BINDING_PROOF_TTL_SECONDS = 10 * 60;
export const WEB_PUSH_BINDING_KEYRING_MAX_ENTRIES = 5;

export interface WebPushBindingActor {
  authUserId: string;
  profileId: string;
  sessionId: string;
}

export interface WebPushBindingKeySet {
  currentVersion: string;
  currentPublicKey: string;
  publicKeyring: Record<string, string>;
}

export interface WebPushBindingProofResult {
  bindingProof: string;
  proofExpiresAt: string;
}

export class WebPushBindingProofError extends Error {
  constructor(
    public readonly reason: "INVALID_PROOF" | "INVALID_CONFIGURATION",
  ) {
    super(reason);
    this.name = "WebPushBindingProofError";
  }
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const keyVersionPattern = /^[A-Za-z0-9._-]{1,32}$/;
const encoder = new TextEncoder();
const p256Prime = BigInt(
  "0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff",
);
const p256B = BigInt(
  "0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b",
);

function bytes(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;
}
function utf8(value: string): Uint8Array {
  return encoder.encode(value);
}
function b64u(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value)).replace(/=/g, "").replace(
    /\+/g,
    "-",
  ).replace(/\//g, "_");
}
function fromB64u(value: string, expectedLength?: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.includes("=")) {
    throw new WebPushBindingProofError("INVALID_PROOF");
  }
  let raw: string;
  try {
    const standard = value.replace(/-/g, "+").replace(/_/g, "/");
    raw = atob(standard + "=".repeat((4 - standard.length % 4) % 4));
  } catch {
    throw new WebPushBindingProofError("INVALID_PROOF");
  }
  const result = Uint8Array.from(raw, (character) => character.charCodeAt(0));
  if (
    (expectedLength !== undefined && result.length !== expectedLength) ||
    b64u(result) !== value
  ) {
    throw new WebPushBindingProofError("INVALID_PROOF");
  }
  return result;
}
function canonicalUuid(value: string): string {
  if (!uuidPattern.test(value)) {
    throw new WebPushBindingProofError("INVALID_PROOF");
  }
  return value.toLowerCase();
}
function bigEndianInteger(value: Uint8Array): bigint {
  let result = 0n;
  for (const byte of value) result = (result << 8n) | BigInt(byte);
  return result;
}
function isP256Point(point: Uint8Array): boolean {
  if (point.length !== 65 || point[0] !== 4) return false;
  const x = bigEndianInteger(point.subarray(1, 33));
  const y = bigEndianInteger(point.subarray(33, 65));
  if (x >= p256Prime || y >= p256Prime) return false;
  const left = y * y % p256Prime;
  const right = (x * x % p256Prime * x - 3n * x + p256B) % p256Prime;
  return left === (right + p256Prime) % p256Prime;
}
async function sha256(value: Uint8Array): Promise<string> {
  return b64u(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(value))),
  );
}
async function hmac(secret: string, value: string): Promise<Uint8Array> {
  if (utf8(secret).length < 32) {
    throw new WebPushBindingProofError("INVALID_CONFIGURATION");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    bytes(utf8(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, bytes(utf8(value))),
  );
}
function proofInput(payload: string, actor: WebPushBindingActor): string {
  return `web-push-binding-proof:v1\0${payload}\0${
    canonicalUuid(actor.authUserId)
  }\0${canonicalUuid(actor.profileId)}\0${canonicalUuid(actor.sessionId)}`;
}

export async function validateVapidPublicKey(publicKey: string): Promise<void> {
  try {
    const point = fromB64u(publicKey, 65);
    if (!isP256Point(point)) throw new Error();
    await crypto.subtle.importKey(
      "raw",
      bytes(point),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
  } catch {
    throw new WebPushBindingProofError("INVALID_CONFIGURATION");
  }
}

export async function validateWebPushBindingKeySet(
  keys: WebPushBindingKeySet,
): Promise<void> {
  if (
    !keyVersionPattern.test(keys.currentVersion) ||
    Object.hasOwn(keys.publicKeyring, keys.currentVersion) ||
    Object.keys(keys.publicKeyring).length >
      WEB_PUSH_BINDING_KEYRING_MAX_ENTRIES
  ) {
    throw new WebPushBindingProofError("INVALID_CONFIGURATION");
  }
  const rows: Array<[string, string]> = [
    [keys.currentVersion, keys.currentPublicKey],
    ...Object.entries(keys.publicKeyring),
  ];
  const identities = new Set<string>();
  for (const [version, publicKey] of rows) {
    if (!keyVersionPattern.test(version) || typeof publicKey !== "string") {
      throw new WebPushBindingProofError("INVALID_CONFIGURATION");
    }
    await validateVapidPublicKey(publicKey);
    const identity = await sha256(fromB64u(publicKey, 65));
    if (identities.has(identity)) {
      throw new WebPushBindingProofError("INVALID_CONFIGURATION");
    }
    identities.add(identity);
  }
}

export async function issueWebPushBindingProof(
  actor: WebPushBindingActor,
  keys: WebPushBindingKeySet,
  secret: string,
  nowMs = Date.now(),
): Promise<WebPushBindingProofResult> {
  await validateWebPushBindingKeySet(keys);
  const issuedAt = Math.floor(nowMs / 1000),
    expiresAt = issuedAt + WEB_PUSH_BINDING_PROOF_TTL_SECONDS;
  const payload = b64u(utf8(JSON.stringify({
    v: 1,
    k: keys.currentVersion,
    p: await sha256(fromB64u(keys.currentPublicKey, 65)),
    i: issuedAt,
    e: expiresAt,
  })));
  const tag = await hmac(secret, proofInput(payload, actor));
  return {
    bindingProof: `${payload}.${b64u(tag)}`,
    proofExpiresAt: new Date(expiresAt * 1000).toISOString(),
  };
}

export async function verifyWebPushBindingProof(
  proof: string,
  actor: WebPushBindingActor,
  keys: WebPushBindingKeySet,
  secret: string,
  nowMs = Date.now(),
): Promise<{ keyVersion: string; publicKey: string }> {
  if (typeof proof !== "string" || utf8(proof).length > 2048) {
    throw new WebPushBindingProofError("INVALID_PROOF");
  }
  await validateWebPushBindingKeySet(keys);
  const parts = proof.split(".");
  if (parts.length !== 2) throw new WebPushBindingProofError("INVALID_PROOF");
  const payloadPart = parts[0] ?? "", tagPart = parts[1] ?? "";
  let payload: unknown;
  try {
    payload = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(fromB64u(payloadPart)),
    );
  } catch {
    throw new WebPushBindingProofError("INVALID_PROOF");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new WebPushBindingProofError("INVALID_PROOF");
  }
  const row = payload as Record<string, unknown>;
  if (
    Object.keys(row).sort().join(",") !== "e,i,k,p,v" || row.v !== 1 ||
    typeof row.k !== "string" || !keyVersionPattern.test(row.k) ||
    typeof row.p !== "string" || !Number.isSafeInteger(row.i) ||
    !Number.isSafeInteger(row.e)
  ) {
    throw new WebPushBindingProofError("INVALID_PROOF");
  }
  const issuedAt = Number(row.i),
    expiresAt = Number(row.e),
    now = Math.floor(nowMs / 1000);
  if (
    expiresAt - issuedAt !== WEB_PUSH_BINDING_PROOF_TTL_SECONDS ||
    issuedAt > now + 30 || expiresAt <= now
  ) {
    throw new WebPushBindingProofError("INVALID_PROOF");
  }
  const publicKey = row.k === keys.currentVersion
    ? keys.currentPublicKey
    : keys.publicKeyring[row.k];
  if (!publicKey || await sha256(fromB64u(publicKey, 65)) !== row.p) {
    throw new WebPushBindingProofError("INVALID_PROOF");
  }
  const [provided, expected] = await Promise.all([
    Promise.resolve(fromB64u(tagPart, 32)),
    hmac(secret, proofInput(payloadPart, actor)),
  ]);
  let mismatch = 0;
  for (let index = 0; index < expected.length; index++) {
    mismatch |= (provided[index] ?? 0) ^ (expected[index] ?? 0);
  }
  if (mismatch !== 0) throw new WebPushBindingProofError("INVALID_PROOF");
  return { keyVersion: row.k, publicKey };
}
