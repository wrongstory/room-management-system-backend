import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { TextDecoder, types } from 'node:util';

// Inactive, bounded in-memory primitive only: no credentials, files, DB, or logging.
// Large dump execution and authenticated plaintext staging are separate release gates.
export const BACKUP_ARTIFACT_MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
const MAGIC = Buffer.from('RMSBKUP1', 'ascii');
const PREFIX_BYTES = MAGIC.length + 4;
const MAX_HEADER_BYTES = 1024;
const TAG_BYTES = 16;
const NONCE_BYTES = 12;
const MAX_NONCE_RESERVATIONS = 65536;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROJECT_REF = /^[a-z]{20}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const PAYLOAD_SHA = /^[0-9a-f]{64}$/;
const ARTIFACT_KINDS = new Set([
  'database-dump',
  'schema-dump',
  'data-dump',
  'roles-dump',
  'migration-history',
  'verification-manifest',
]);
const METADATA_FIELDS = ['projectRef', 'runId', 'artifactKind', 'sourceCommit', 'payloadSha256'];
const HEADER_FIELDS = ['format', 'version', 'algorithm', ...METADATA_FIELDS, 'nonce'];
const utf8 = new TextDecoder('utf-8', { fatal: true });
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const getArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get;
const getByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset').get;
const getByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get;
const setArrayBytes = Uint8Array.prototype.set;
const SHADOWED_BUFFER_FIELDS = [
  'length', 'buffer', 'byteLength', 'byteOffset', 'subarray', 'readUInt32BE',
  'toString', 'equals', 'copy', 'slice', 'constructor', Symbol.iterator,
];

// No eviction: exhausting this finite process-local guard fails closed. It cannot
// guarantee uniqueness across processes; the executor must use fresh one-time keys.
// The private salted key identity is never returned, serialized, or logged.
const nonceIdentityKey = randomBytes(32);
const nonceReservations = new Set();

function fail(code) {
  const error = new Error(code);
  error.name = 'BackupArtifactCryptoError';
  error.code = code;
  throw error;
}

function plainRecord(value, fields, code) {
  if (value === null || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  const keys = Reflect.ownKeys(value);
  const record = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      !fields.includes(key) ||
      !descriptor ||
      !Object.hasOwn(descriptor, 'value') ||
      !descriptor.enumerable
    ) fail(code);
    record[key] = descriptor.value;
  }
  return record;
}

function metadataValue(value) {
  value = plainRecord(value, METADATA_FIELDS, 'BACKUP_ARTIFACT_METADATA_INVALID');
  if (
    !METADATA_FIELDS.slice(0, 4).every((field) => Object.hasOwn(value, field)) ||
    typeof value.projectRef !== 'string' || !PROJECT_REF.test(value.projectRef) ||
    typeof value.runId !== 'string' || !UUID_V4.test(value.runId) ||
    typeof value.artifactKind !== 'string' || !ARTIFACT_KINDS.has(value.artifactKind) ||
    typeof value.sourceCommit !== 'string' || !COMMIT_SHA.test(value.sourceCommit) ||
    (Object.hasOwn(value, 'payloadSha256') &&
      (typeof value.payloadSha256 !== 'string' || !PAYLOAD_SHA.test(value.payloadSha256)))
  ) fail('BACKUP_ARTIFACT_METADATA_INVALID');
  const metadata = {
    projectRef: value.projectRef,
    runId: value.runId,
    artifactKind: value.artifactKind,
    sourceCommit: value.sourceCommit,
  };
  if (Object.hasOwn(value, 'payloadSha256')) metadata.payloadSha256 = value.payloadSha256;
  return metadata;
}

function payloadLimit(options) {
  if (options === undefined) return BACKUP_ARTIFACT_MAX_PAYLOAD_BYTES;
  options = plainRecord(options, ['maxPayloadBytes'], 'BACKUP_ARTIFACT_LIMIT_INVALID');
  if (
    !Number.isSafeInteger(options.maxPayloadBytes) ||
    options.maxPayloadBytes < 0 ||
    options.maxPayloadBytes > BACKUP_ARTIFACT_MAX_PAYLOAD_BYTES
  ) fail('BACKUP_ARTIFACT_LIMIT_INVALID');
  return options.maxPayloadBytes;
}

function bufferInfo(value, code) {
  if (value === null || typeof value !== 'object' || types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Buffer.prototype || !Buffer.isBuffer(value)
  ) fail(code);
  // Fixed descriptor checks avoid getters and avoid enumerating up to 64 MiB of indices.
  for (const field of SHADOWED_BUFFER_FIELDS) {
    if (Object.getOwnPropertyDescriptor(value, field)) fail(code);
  }
  try {
    const arrayBuffer = Reflect.apply(getArrayBuffer, value, []);
    if (!types.isArrayBuffer(arrayBuffer) || types.isSharedArrayBuffer(arrayBuffer)) fail(code);
    return {
      arrayBuffer,
      byteOffset: Reflect.apply(getByteOffset, value, []),
      byteLength: Reflect.apply(getByteLength, value, []),
    };
  } catch { fail(code); }
}

function copyBuffer(info) {
  const owned = Buffer.alloc(info.byteLength);
  Reflect.apply(setArrayBytes, owned, [new Uint8Array(info.arrayBuffer, info.byteOffset, info.byteLength)]);
  return owned;
}

function keyCopy(key) {
  const info = bufferInfo(key, 'BACKUP_ARTIFACT_KEY_INVALID');
  if (info.byteLength !== 32) fail('BACKUP_ARTIFACT_KEY_INVALID');
  return copyBuffer(info);
}

function headerValue(metadata, nonce) {
  return {
    format: 'rms-backup-artifact',
    version: 1,
    algorithm: 'AES-256-GCM',
    ...metadata,
    nonce: nonce.toString('base64url'),
  };
}

function headerBytes(metadata, nonce) {
  const header = Buffer.from(JSON.stringify(headerValue(metadata, nonce)), 'utf8');
  if (header.length > MAX_HEADER_BYTES) fail('BACKUP_ARTIFACT_FORMAT_INVALID');
  return header;
}

function prefixBytes(headerLength) {
  const prefix = Buffer.alloc(PREFIX_BYTES);
  MAGIC.copy(prefix);
  prefix.writeUInt32BE(headerLength, MAGIC.length);
  return prefix;
}

function reserveNonce(key) {
  if (nonceReservations.size >= MAX_NONCE_RESERVATIONS) fail('BACKUP_ARTIFACT_NONCE_UNAVAILABLE');
  const keyIdentity = createHmac('sha256', nonceIdentityKey).update(key).digest('hex');
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let nonce;
    try { nonce = randomBytes(NONCE_BYTES); } catch { fail('BACKUP_ARTIFACT_NONCE_UNAVAILABLE'); }
    if (!Buffer.isBuffer(nonce) || nonce.length !== NONCE_BYTES) fail('BACKUP_ARTIFACT_NONCE_UNAVAILABLE');
    const identity = `${keyIdentity}:${nonce.toString('hex')}`;
    if (!nonceReservations.has(identity)) {
      nonceReservations.add(identity);
      return nonce;
    }
  }
  fail('BACKUP_ARTIFACT_NONCE_UNAVAILABLE');
}

function assertPayloadHash(payload, metadata) {
  if (metadata.payloadSha256 !== undefined &&
    createHash('sha256').update(payload).digest('hex') !== metadata.payloadSha256
  ) fail('BACKUP_ARTIFACT_PAYLOAD_HASH_MISMATCH');
}

/** Generate a fresh one-time artifact key. Caller owns safe wrapping and disposal. */
export function generateBackupArtifactKey() {
  try { return randomBytes(32); } catch { fail('BACKUP_ARTIFACT_KEY_GENERATION_FAILED'); }
}

/** Return binary prefix + canonical authenticated JSON header + ciphertext + 16-byte tag. */
export function encryptBackupArtifact(plaintext, key, metadata, options) {
  const limit = payloadLimit(options);
  const context = metadataValue(metadata);
  const payloadInfo = bufferInfo(plaintext, 'BACKUP_ARTIFACT_PAYLOAD_INVALID');
  if (payloadInfo.byteLength > limit) fail('BACKUP_ARTIFACT_PAYLOAD_LIMIT_EXCEEDED');
  const ownedKey = keyCopy(key);
  let ownedPlaintext;
  try {
    ownedPlaintext = copyBuffer(payloadInfo);
    assertPayloadHash(ownedPlaintext, context);
    const nonce = reserveNonce(ownedKey);
    const header = headerBytes(context, nonce);
    const prefix = prefixBytes(header.length);
    const aad = Buffer.concat([prefix, header]);
    const cipher = createCipheriv('aes-256-gcm', ownedKey, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(ownedPlaintext), cipher.final()]);
    return Buffer.concat([aad, ciphertext, cipher.getAuthTag()]);
  } finally {
    ownedKey.fill(0);
    ownedPlaintext?.fill(0);
  }
}

function parseArtifact(artifact, expectedMetadata, limit) {
  const info = bufferInfo(artifact, 'BACKUP_ARTIFACT_FORMAT_INVALID');
  if (info.byteLength > PREFIX_BYTES + MAX_HEADER_BYTES + limit + TAG_BYTES) {
    fail('BACKUP_ARTIFACT_PAYLOAD_LIMIT_EXCEEDED');
  }
  if (info.byteLength < PREFIX_BYTES + 1 + TAG_BYTES) fail('BACKUP_ARTIFACT_FORMAT_INVALID');
  const ownedArtifact = copyBuffer(info);
  if (!ownedArtifact.subarray(0, MAGIC.length).equals(MAGIC)) {
    fail('BACKUP_ARTIFACT_FORMAT_INVALID');
  }
  const headerLength = ownedArtifact.readUInt32BE(MAGIC.length);
  if (headerLength < 1 || headerLength > MAX_HEADER_BYTES ||
    info.byteLength < PREFIX_BYTES + headerLength + TAG_BYTES) fail('BACKUP_ARTIFACT_FORMAT_INVALID');
  const payloadLength = info.byteLength - PREFIX_BYTES - headerLength - TAG_BYTES;
  if (payloadLength > limit) fail('BACKUP_ARTIFACT_PAYLOAD_LIMIT_EXCEEDED');
  const header = ownedArtifact.subarray(PREFIX_BYTES, PREFIX_BYTES + headerLength);
  let parsed;
  try { parsed = JSON.parse(utf8.decode(header)); } catch { fail('BACKUP_ARTIFACT_FORMAT_INVALID'); }
  parsed = plainRecord(parsed, HEADER_FIELDS, 'BACKUP_ARTIFACT_FORMAT_INVALID');
  if (parsed.format !== 'rms-backup-artifact' || parsed.version !== 1 ||
    parsed.algorithm !== 'AES-256-GCM' || typeof parsed.nonce !== 'string' ||
    !/^[A-Za-z0-9_-]{16}$/.test(parsed.nonce)) fail('BACKUP_ARTIFACT_FORMAT_INVALID');
  const context = {};
  for (const field of METADATA_FIELDS) {
    if (Object.hasOwn(parsed, field)) context[field] = parsed[field];
  }
  const metadata = metadataValue(context);
  const nonce = Buffer.from(parsed.nonce, 'base64url');
  if (nonce.length !== NONCE_BYTES || nonce.toString('base64url') !== parsed.nonce ||
    !header.equals(headerBytes(metadata, nonce))) fail('BACKUP_ARTIFACT_FORMAT_INVALID');
  if (JSON.stringify(metadata) !== JSON.stringify(expectedMetadata)) {
    fail('BACKUP_ARTIFACT_CONTEXT_MISMATCH');
  }
  return {
    metadata,
    nonce,
    aad: ownedArtifact.subarray(0, PREFIX_BYTES + headerLength),
    ciphertext: ownedArtifact.subarray(PREFIX_BYTES + headerLength, -TAG_BYTES),
    tag: ownedArtifact.subarray(-TAG_BYTES),
  };
}

/** No streams/callbacks: return plaintext only after final authentication and optional hash check. */
export function decryptBackupArtifact(artifact, key, expectedMetadata, options) {
  const limit = payloadLimit(options);
  const expected = metadataValue(expectedMetadata);
  const parsed = parseArtifact(artifact, expected, limit);
  const ownedKey = keyCopy(key);
  let provisional;
  let final;
  let plaintext;
  let authenticated = false;
  try {
    const decipher = createDecipheriv('aes-256-gcm', ownedKey, parsed.nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(parsed.aad);
    decipher.setAuthTag(parsed.tag);
    try {
      provisional = decipher.update(parsed.ciphertext);
      final = decipher.final();
    } catch { fail('BACKUP_ARTIFACT_AUTHENTICATION_FAILED'); }
    plaintext = Buffer.concat([provisional, final]);
    assertPayloadHash(plaintext, parsed.metadata);
    authenticated = true;
    return { plaintext, metadata: Object.freeze(parsed.metadata) };
  } finally {
    ownedKey.fill(0);
    provisional?.fill(0);
    final?.fill(0);
    if (!authenticated) plaintext?.fill(0);
  }
}
