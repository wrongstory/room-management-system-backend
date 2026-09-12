import { createCipheriv, createDecipheriv, createHash, createHmac, createPublicKey, randomBytes } from 'node:crypto';
import { AppError } from '../../lib/app-error.js';

export interface WebPushSubscriptionInput {
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
}

export interface WebPushCryptoConfig {
  key: string;
  keyVersion: string;
  keyring: Record<string, string>;
  bindingSecret: string;
  vapidKeyVersion: string;
  vapidPublicKey: string;
  vapidPublicKeyring: Record<string,string>;
  /** Deterministic vector input only; production callers leave this undefined. */
  nonce?: Uint8Array;
}

export interface WebPushEnvelope {
  endpointDigest: string;
  sessionDigest: string;
  materialDigest: string;
  expirationAt: string | null;
  keyVersion: string;
  ciphertextBase64: string;
  nonceBase64: string;
  authTagBase64: string;
  requestHash: string;
}

export interface DecryptedWebPushEnvelope {
  subscription: WebPushSubscriptionInput;
  sessionId: string;
}

const base64UrlPattern = /^[A-Za-z0-9_-]+$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalid(): never {
  throw new AppError(400, 'INVALID_WEB_PUSH_SUBSCRIPTION', 'Web Push 구독 값이 올바르지 않습니다.');
}

function canonicalBase64Url(value: string, expectedBytes: number): Buffer {
  if (!base64UrlPattern.test(value) || value.includes('=')) invalid();
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== expectedBytes || decoded.toString('base64url') !== value) invalid();
  return decoded;
}

export function canonicalWebPushUuid(value: string): string {
  if (!uuidPattern.test(value)) invalid();
  return value.toLowerCase();
}

export function validateWebPushSubscription(value: WebPushSubscriptionInput): WebPushSubscriptionInput {
  if (!value.endpoint || Buffer.byteLength(value.endpoint, 'utf8') > 4096) invalid();
  let endpoint: URL;
  try { endpoint = new URL(value.endpoint); } catch { invalid(); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash
    || value.endpoint.includes('#') || /^https:\/\/[^/?#]*@/i.test(value.endpoint)) invalid();
  if (value.expirationTime !== null && (!Number.isSafeInteger(value.expirationTime) || value.expirationTime <= Date.now())) invalid();
  const point = canonicalBase64Url(value.keys.p256dh, 65);
  if (point[0] !== 4) invalid();
  try {
    createPublicKey({
      key: Buffer.concat([Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'), point]),
      format: 'der',
      type: 'spki'
    });
  } catch { invalid(); }
  canonicalBase64Url(value.keys.auth, 16);
  const canonicalEndpoint = `https://${endpoint.host}${endpoint.pathname}${endpoint.search}`;
  if (Buffer.byteLength(canonicalEndpoint, 'utf8') > 4096) invalid();
  return { ...value, endpoint: canonicalEndpoint };
}

function canonical(value: WebPushSubscriptionInput, sessionId: string): string {
  return JSON.stringify({
    auth: value.keys.auth,
    endpoint: value.endpoint,
    expirationTime: value.expirationTime,
    p256dh: value.keys.p256dh,
    sessionId
  });
}

function hmac(secret: string, domain: string, value: string): string {
  return createHmac('sha256', secret).update(`${domain}\0`, 'utf8').update(value, 'utf8').digest('hex');
}

function decodeKey(encoded: string): Buffer {
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encoded) {
    throw new AppError(503, 'WEB_PUSH_NOT_CONFIGURED', 'Web Push 구독 암호화 설정이 필요합니다.');
  }
  return key;
}

export function createWebPushEnvelope(
  input: WebPushSubscriptionInput,
  actorProfileId: string,
  sessionId: string,
  subscriptionId: string,
  revisionNo: number,
  config: WebPushCryptoConfig,
  requestSubscriptionId: string | null = subscriptionId,
  bindingProof?: string,
): WebPushEnvelope {
  const subscription = validateWebPushSubscription(input);
  const canonicalActorProfileId = canonicalWebPushUuid(actorProfileId);
  const canonicalSessionId = canonicalWebPushUuid(sessionId);
  const canonicalSubscriptionId = canonicalWebPushUuid(subscriptionId);
  const canonicalRequestSubscriptionId = requestSubscriptionId === null ? null : canonicalWebPushUuid(requestSubscriptionId);
  if (!Number.isInteger(revisionNo) || revisionNo < 1) invalid();
  const plaintext = canonical(subscription, canonicalSessionId);
  const endpointDigest = hmac(config.bindingSecret, 'web-push-endpoint:v1', subscription.endpoint);
  const sessionDigest = hmac(config.bindingSecret, 'web-push-session:v1', canonicalSessionId);
  const materialDigest = hmac(config.bindingSecret, 'web-push-material:v1', plaintext);
  const aad = Buffer.from(
    `web-push-envelope:v1\0${canonicalActorProfileId}\0${sessionDigest}\0${endpointDigest}\0${canonicalSubscriptionId}\0${revisionNo}`,
    'utf8'
  );
  const nonce = config.nonce === undefined ? randomBytes(12) : Buffer.from(config.nonce);
  if (nonce.length !== 12) invalid();
  const cipher = createCipheriv('aes-256-gcm', decodeKey(config.key), nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const requestHash = createHash('sha256').update(JSON.stringify({
    endpointDigest,
    expirationTime: subscription.expirationTime,
    materialDigest,
    sessionDigest,
    subscriptionId: canonicalRequestSubscriptionId,
    revisionNo,
    vapidKeyVersion: config.vapidKeyVersion,
    ...(bindingProof===undefined?{}:{bindingProofDigest:createHash('sha256').update(bindingProof,'utf8').digest('hex')})
  }), 'utf8').digest('hex');
  return {
    endpointDigest,
    sessionDigest,
    materialDigest,
    expirationAt: subscription.expirationTime === null ? null : new Date(subscription.expirationTime).toISOString(),
    keyVersion: config.keyVersion,
    ciphertextBase64: ciphertext.toString('base64'),
    nonceBase64: nonce.toString('base64'),
    authTagBase64: authTag.toString('base64'),
    requestHash
  };
}

export function decryptWebPushEnvelope(
  envelope: Pick<WebPushEnvelope, 'keyVersion' | 'ciphertextBase64' | 'nonceBase64' | 'authTagBase64'>,
  binding: { actorProfileId: string; sessionDigest: string; endpointDigest: string; subscriptionId: string; revisionNo: number },
  config: Pick<WebPushCryptoConfig, 'key' | 'keyVersion' | 'keyring'>
): DecryptedWebPushEnvelope {
  const encodedKey = envelope.keyVersion === config.keyVersion ? config.key : config.keyring[envelope.keyVersion];
  if (!encodedKey) throw new AppError(503, 'WEB_PUSH_KEY_UNAVAILABLE', 'Web Push 구독 복호화 키를 찾을 수 없습니다.');
  const decipher = createDecipheriv('aes-256-gcm', decodeKey(encodedKey), Buffer.from(envelope.nonceBase64, 'base64'));
  const actorProfileId = canonicalWebPushUuid(binding.actorProfileId);
  const subscriptionId = canonicalWebPushUuid(binding.subscriptionId);
  decipher.setAAD(Buffer.from(
    `web-push-envelope:v1\0${actorProfileId}\0${binding.sessionDigest}\0${binding.endpointDigest}\0${subscriptionId}\0${binding.revisionNo}`,
    'utf8'
  ));
  decipher.setAuthTag(Buffer.from(envelope.authTagBase64, 'base64'));
  const parsed = JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertextBase64, 'base64')),
    decipher.final()
  ]).toString('utf8')) as { auth:string; endpoint:string; expirationTime:number|null; p256dh:string; sessionId:string };
  if (!uuidPattern.test(parsed.sessionId)) invalid();
  return {
    subscription: validateWebPushSubscription({endpoint:parsed.endpoint,expirationTime:parsed.expirationTime,keys:{p256dh:parsed.p256dh,auth:parsed.auth}}),
    sessionId: parsed.sessionId.toLowerCase()
  };
}
