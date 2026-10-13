import { Buffer } from 'node:buffer';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  BACKUP_ARTIFACT_MAX_PAYLOAD_BYTES,
  type BackupArtifactMetadata,
  decryptBackupArtifact,
  encryptBackupArtifact,
  generateBackupArtifactKey,
} from '../scripts/lib/backup-artifact-crypto.mjs';

const randomControl = vi.hoisted(() => ({ fixedNonce: false }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomBytes: (bytes: number) => randomControl.fixedNonce && bytes === 12
      ? Buffer.alloc(12, 71)
      : actual.randomBytes(bytes),
  };
});

const metadata: BackupArtifactMetadata = {
  projectRef: 'abcdefghijklmnopqrst',
  runId: 'b7ac1dcb-c7ec-4e20-a8f5-3460f752181b',
  artifactKind: 'database-dump',
  sourceCommit: '0123456789abcdef0123456789abcdef01234567',
};

function intrinsicBufferCopy(value: Buffer) {
  const prototype = Object.getPrototypeOf(Uint8Array.prototype);
  const arrayBuffer = Reflect.apply(Object.getOwnPropertyDescriptor(prototype, 'buffer')?.get as () => ArrayBuffer, value, []);
  const byteOffset = Reflect.apply(Object.getOwnPropertyDescriptor(prototype, 'byteOffset')?.get as () => number, value, []);
  const byteLength = Reflect.apply(Object.getOwnPropertyDescriptor(prototype, 'byteLength')?.get as () => number, value, []);
  return Buffer.from(new Uint8Array(arrayBuffer, byteOffset, byteLength));
}

function headerOf(artifact: Buffer) {
  const length = artifact.readUInt32BE(8);
  return { length, value: JSON.parse(artifact.subarray(12, 12 + length).toString('utf8')) };
}

function replaceHeader(artifact: Buffer, transform: (header: Record<string, unknown>) => unknown) {
  const header = headerOf(artifact);
  const bytes = Buffer.from(JSON.stringify(transform(header.value)));
  const prefix = Buffer.from(artifact.subarray(0, 12));
  prefix.writeUInt32BE(bytes.length, 8);
  return Buffer.concat([prefix, bytes, artifact.subarray(12 + header.length)]);
}

describe('inactive backup artifact authenticated crypto', () => {
  it.each([Buffer.alloc(0), Buffer.from([0, 255, 1, 0, 42]), Buffer.from('synthetic dump\n')])(
    'round trips an empty or binary payload without mutating caller key/payload',
    (payload) => {
      const key = generateBackupArtifactKey();
      const beforeKey = Buffer.from(key);
      const beforePayload = Buffer.from(payload);
      const artifact = encryptBackupArtifact(payload, key, metadata);
      const restored = decryptBackupArtifact(artifact, key, metadata);
      expect(restored.plaintext).toEqual(payload);
      expect(restored.metadata).toEqual(metadata);
      expect(Object.isFrozen(restored.metadata)).toBe(true);
      expect(key).toEqual(beforeKey);
      expect(payload).toEqual(beforePayload);
    },
  );

  it('uses fresh 32-byte keys and internally randomized 12-byte nonce/tag serialization', () => {
    const key = generateBackupArtifactKey();
    expect(key.length).toBe(32);
    expect(generateBackupArtifactKey()).not.toEqual(key);
    const first = encryptBackupArtifact(Buffer.from('synthetic'), key, metadata);
    const second = encryptBackupArtifact(Buffer.from('synthetic'), key, metadata);
    expect(first.subarray(0, 8).toString('ascii')).toBe('RMSBKUP1');
    expect(headerOf(first).value.nonce).not.toBe(headerOf(second).value.nonce);
    expect(Buffer.from(headerOf(first).value.nonce, 'base64url').length).toBe(12);
    expect(first).not.toEqual(second);
    expect(decryptBackupArtifact(second, key, metadata).plaintext.toString()).toBe('synthetic');
  });

  it('binds the exact allowlisted context and optional full artifact hash', () => {
    const key = generateBackupArtifactKey();
    const payload = Buffer.from('synthetic');
    const hashed = { ...metadata, payloadSha256: createHash('sha256').update(payload).digest('hex') };
    const artifact = encryptBackupArtifact(payload, key, hashed);
    expect(decryptBackupArtifact(artifact, key, hashed).plaintext).toEqual(payload);
    for (const expected of [
      metadata,
      { ...hashed, projectRef: 'zyxwvutsrqponmlkjihg' },
      { ...hashed, runId: 'b7ac1dcb-c7ec-4e20-b8f5-3460f752181b' },
      { ...hashed, artifactKind: 'schema-dump' as const },
      { ...hashed, sourceCommit: 'a'.repeat(40) },
      { ...hashed, payloadSha256: 'b'.repeat(64) },
    ]) expect(() => decryptBackupArtifact(artifact, key, expected)).toThrow('BACKUP_ARTIFACT_CONTEXT_MISMATCH');
    expect(() => encryptBackupArtifact(payload, key, { ...metadata, payloadSha256: 'a'.repeat(64) }))
      .toThrow('BACKUP_ARTIFACT_PAYLOAD_HASH_MISMATCH');
  });

  it('rejects same-key nonce collision even when the key is a different Buffer instance', () => {
    const key = generateBackupArtifactKey();
    randomControl.fixedNonce = true;
    try {
      const first = encryptBackupArtifact(Buffer.from('first'), key, metadata);
      expect(() => encryptBackupArtifact(Buffer.from('second'), Buffer.from(key), metadata))
        .toThrow('BACKUP_ARTIFACT_NONCE_UNAVAILABLE');
      expect(() => encryptBackupArtifact(Buffer.from('separate key'), generateBackupArtifactKey(), metadata))
        .not.toThrow();
      expect(decryptBackupArtifact(first, key, metadata).plaintext.toString()).toBe('first');
    } finally { randomControl.fixedNonce = false; }
  });

  it.each(['password', 'connectionString', 'token', 'pin', 'phone', 'email', 'name', 'path']) (
    'rejects unknown/secret/PII metadata field %s without including its value in errors',
    (field) => {
      const marker = 'sensitive-test-marker';
      const input = { ...metadata, [field]: marker };
      try {
        encryptBackupArtifact(Buffer.alloc(0), generateBackupArtifactKey(), input);
        expect.unreachable();
      } catch (error) {
        expect((error as Error).message).toBe('BACKUP_ARTIFACT_METADATA_INVALID');
        expect(String(error)).not.toContain(marker);
      }
    },
  );

  it('rejects malformed context, accessors, inherited fields, symbols and hidden properties', () => {
    const invalid: unknown[] = [
      null, [], 'metadata', {},
      { ...metadata, projectRef: 'https://example.test' },
      { ...metadata, runId: metadata.runId.toUpperCase() },
      { ...metadata, artifactKind: 'arbitrary' },
      { ...metadata, sourceCommit: 'not a commit' },
      { ...metadata, payloadSha256: undefined },
      { ...metadata, [Symbol('secret')]: 'hidden' },
      Object.create(metadata),
      Object.defineProperty({ ...metadata }, 'projectRef', { get: () => { throw new Error('must not run'); } }),
      Object.defineProperty({ ...metadata }, 'password', { value: 'hidden', enumerable: false }),
      new Proxy({ ...metadata }, { get: () => { throw new Error('must not run'); } }),
    ];
    for (const value of invalid) {
      expect(() => encryptBackupArtifact(Buffer.alloc(0), generateBackupArtifactKey(), value as BackupArtifactMetadata))
        .toThrow('BACKUP_ARTIFACT_METADATA_INVALID');
    }
  });

  it('rejects revoked metadata/options proxies with fixed codes on encryption and decryption', () => {
    const key = generateBackupArtifactKey();
    const payload = Buffer.from('test');
    const artifact = encryptBackupArtifact(payload, key, metadata);
    const revokedMetadata = Proxy.revocable({ ...metadata }, {});
    const revokedOptions = Proxy.revocable({ maxPayloadBytes: 4 }, {});
    revokedMetadata.revoke();
    revokedOptions.revoke();
    const cases = [
      [() => encryptBackupArtifact(payload, key, revokedMetadata.proxy), 'BACKUP_ARTIFACT_METADATA_INVALID'],
      [() => decryptBackupArtifact(artifact, key, revokedMetadata.proxy), 'BACKUP_ARTIFACT_METADATA_INVALID'],
      [() => encryptBackupArtifact(payload, key, metadata, revokedOptions.proxy), 'BACKUP_ARTIFACT_LIMIT_INVALID'],
      [() => decryptBackupArtifact(artifact, key, metadata, revokedOptions.proxy), 'BACKUP_ARTIFACT_LIMIT_INVALID'],
    ] as const;
    for (const [operation, code] of cases) {
      try {
        operation();
        expect.unreachable();
      } catch (error) {
        expect(error).toMatchObject({ name: 'BackupArtifactCryptoError', message: code, code });
        expect(error).not.toBeInstanceOf(TypeError);
      }
    }
  });

  it.each(['projectRef', 'runId', 'artifactKind', 'sourceCommit'] as const)(
    'requires metadata field %s as an own data property',
    (field) => {
      const value: Partial<BackupArtifactMetadata> = { ...metadata };
      delete value[field];
      expect(() => encryptBackupArtifact(Buffer.alloc(0), generateBackupArtifactKey(), value as BackupArtifactMetadata))
        .toThrow('BACKUP_ARTIFACT_METADATA_INVALID');
    },
  );

  it('requires key/payload byte Buffers and rejects shared-memory bytes', () => {
    const foreignShared = runInNewContext('new SharedArrayBuffer(32)') as SharedArrayBuffer;
    for (const key of [Buffer.alloc(0), Buffer.alloc(31), Buffer.alloc(33), 'a'.repeat(32), new Uint8Array(32),
      Buffer.from(new SharedArrayBuffer(32)), Buffer.from(foreignShared)]) {
      expect(() => encryptBackupArtifact(Buffer.alloc(0), key as Buffer, metadata)).toThrow('BACKUP_ARTIFACT_KEY_INVALID');
    }
    const key = generateBackupArtifactKey();
    for (const payload of ['plaintext', new Uint8Array(0), Buffer.from(new SharedArrayBuffer(0))]) {
      expect(() => encryptBackupArtifact(payload as Buffer, key, metadata)).toThrow('BACKUP_ARTIFACT_PAYLOAD_INVALID');
    }
    const valid = encryptBackupArtifact(Buffer.alloc(0), key, metadata);
    const shared = Buffer.from(new SharedArrayBuffer(valid.length));
    valid.copy(shared);
    expect(() => decryptBackupArtifact(shared, key, metadata)).toThrow('BACKUP_ARTIFACT_FORMAT_INVALID');
  });

  it('rejects Buffer proxies before length/buffer/copy traps and preserves caller bytes', () => {
    const key = generateBackupArtifactKey();
    const payload = Buffer.from('synthetic');
    const artifact = encryptBackupArtifact(payload, key, metadata);
    const before = [Buffer.from(key), Buffer.from(payload), Buffer.from(artifact)];
    const trap = vi.fn(() => { throw new Error('sensitive raw exception must not escape'); });
    const proxiedKey = new Proxy(key, { get: trap });
    const proxiedPayload = new Proxy(payload, { get: trap });
    const proxiedArtifact = new Proxy(artifact, { get: trap });
    expect(() => encryptBackupArtifact(payload, proxiedKey, metadata)).toThrow('BACKUP_ARTIFACT_KEY_INVALID');
    expect(() => decryptBackupArtifact(artifact, proxiedKey, metadata)).toThrow('BACKUP_ARTIFACT_KEY_INVALID');
    expect(() => encryptBackupArtifact(proxiedPayload, key, metadata)).toThrow('BACKUP_ARTIFACT_PAYLOAD_INVALID');
    expect(() => decryptBackupArtifact(proxiedArtifact, key, metadata)).toThrow('BACKUP_ARTIFACT_FORMAT_INVALID');
    expect(trap).not.toHaveBeenCalled();
    expect([key, payload, artifact]).toEqual(before);
  });

  it.each(['length', 'buffer', 'byteLength', 'byteOffset', 'subarray', 'readUInt32BE',
    'toString', 'equals', 'copy', 'slice', 'constructor', Symbol.iterator])(
    'rejects shadow Buffer accessor %s without calling it or exposing a foreign error',
    (field) => {
      const key = generateBackupArtifactKey();
      const payload = Buffer.from('synthetic');
      const artifact = encryptBackupArtifact(payload, key, metadata);
      const accessor = vi.fn(() => { throw new Error('sensitive getter error must not escape'); });
      const shadow = (value: Buffer) => Object.defineProperty(Buffer.from(value), field, { get: accessor });
      const shadowKey = shadow(key);
      const shadowPayload = shadow(payload);
      const shadowArtifact = shadow(artifact);
      expect(() => encryptBackupArtifact(payload, shadowKey, metadata)).toThrow('BACKUP_ARTIFACT_KEY_INVALID');
      expect(() => decryptBackupArtifact(artifact, shadowKey, metadata)).toThrow('BACKUP_ARTIFACT_KEY_INVALID');
      expect(() => encryptBackupArtifact(shadowPayload, key, metadata)).toThrow('BACKUP_ARTIFACT_PAYLOAD_INVALID');
      expect(() => decryptBackupArtifact(shadowArtifact, key, metadata)).toThrow('BACKUP_ARTIFACT_FORMAT_INVALID');
      expect(accessor).not.toHaveBeenCalled();
      for (const [value, original] of [[shadowKey, key], [shadowPayload, payload], [shadowArtifact, artifact]] as const) {
        expect(intrinsicBufferCopy(value)).toEqual(original);
      }
      expect(accessor).not.toHaveBeenCalled();
    },
  );

  it('rejects a forged/custom Buffer prototype and shadow method before invoking either', () => {
    const key = generateBackupArtifactKey();
    const payload = Buffer.from('synthetic');
    const forged = Object.create(Buffer.prototype) as Buffer;
    const accessor = vi.fn(() => { throw new Error('must not run'); });
    const customPrototype = Object.create(Buffer.prototype, { length: { get: accessor } });
    const customPayload = Object.setPrototypeOf(Buffer.from(payload), customPrototype);
    const shadowMethod = Object.defineProperty(Buffer.from(payload), 'copy', { value: accessor });
    for (const value of [forged, customPayload, shadowMethod]) {
      expect(() => encryptBackupArtifact(value, key, metadata)).toThrow('BACKUP_ARTIFACT_PAYLOAD_INVALID');
    }
    expect(accessor).not.toHaveBeenCalled();
  });

  it('enforces both custom payload bounds and the hard limit before copying payloads', () => {
    const key = generateBackupArtifactKey();
    const artifact = encryptBackupArtifact(Buffer.alloc(4), key, metadata, { maxPayloadBytes: 4 });
    expect(decryptBackupArtifact(artifact, key, metadata, { maxPayloadBytes: 4 }).plaintext.length).toBe(4);
    expect(() => encryptBackupArtifact(Buffer.alloc(5), key, metadata, { maxPayloadBytes: 4 }))
      .toThrow('BACKUP_ARTIFACT_PAYLOAD_LIMIT_EXCEEDED');
    expect(() => decryptBackupArtifact(artifact, key, metadata, { maxPayloadBytes: 3 }))
      .toThrow('BACKUP_ARTIFACT_PAYLOAD_LIMIT_EXCEEDED');
    expect(() => encryptBackupArtifact(Buffer.alloc(BACKUP_ARTIFACT_MAX_PAYLOAD_BYTES + 1), key, metadata))
      .toThrow('BACKUP_ARTIFACT_PAYLOAD_LIMIT_EXCEEDED');
    for (const maxPayloadBytes of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, BACKUP_ARTIFACT_MAX_PAYLOAD_BYTES + 1]) {
      expect(() => encryptBackupArtifact(Buffer.alloc(0), key, metadata, { maxPayloadBytes }))
        .toThrow('BACKUP_ARTIFACT_LIMIT_INVALID');
    }
    expect(decryptBackupArtifact(encryptBackupArtifact(Buffer.alloc(0), key, metadata, { maxPayloadBytes: 0 }),
      key, metadata, { maxPayloadBytes: 0 }).plaintext.length).toBe(0);
    expect(() => encryptBackupArtifact(Buffer.alloc(0), key, metadata, { maxPayloadBytes: 0, nonce: 'caller' } as never))
      .toThrow('BACKUP_ARTIFACT_LIMIT_INVALID');
  });

  it('fails authentication for a wrong key, ciphertext, tag, or structurally valid nonce/header tampering', () => {
    const key = generateBackupArtifactKey();
    const artifact = encryptBackupArtifact(Buffer.from('synthetic dump'), key, metadata);
    expect(() => decryptBackupArtifact(artifact, generateBackupArtifactKey(), metadata))
      .toThrow('BACKUP_ARTIFACT_AUTHENTICATION_FAILED');
    const body = Buffer.from(artifact);
    const bodyOffset = 12 + headerOf(body).length;
    body.writeUInt8(body.readUInt8(bodyOffset) ^ 1, bodyOffset);
    const tag = Buffer.from(artifact);
    tag.writeUInt8(tag.readUInt8(tag.length - 1) ^ 1, tag.length - 1);
    const nonce = replaceHeader(artifact, (header) => ({ ...header, nonce: 'AAAAAAAAAAAAAAAA' }));
    const commit = replaceHeader(artifact, (header) => ({ ...header, sourceCommit: 'b'.repeat(40) }));
    for (const tampered of [body, tag, nonce]) {
      expect(() => decryptBackupArtifact(tampered, key, metadata)).toThrow('BACKUP_ARTIFACT_AUTHENTICATION_FAILED');
    }
    expect(() => decryptBackupArtifact(commit, key, { ...metadata, sourceCommit: 'b'.repeat(40) }))
      .toThrow('BACKUP_ARTIFACT_AUTHENTICATION_FAILED');
  });

  it('rejects missing/truncated/appended tag or payload without returning any plaintext', () => {
    const key = generateBackupArtifactKey();
    const artifact = encryptBackupArtifact(Buffer.from('never returned on failure'), key, metadata);
    for (const truncated of [artifact.subarray(0, -1), artifact.subarray(0, -16), Buffer.concat([artifact, Buffer.from([0])])]) {
      expect(() => decryptBackupArtifact(truncated, key, metadata)).toThrow('BACKUP_ARTIFACT_AUTHENTICATION_FAILED');
    }
    expect(() => decryptBackupArtifact(artifact.subarray(0, 12 + headerOf(artifact).length + 15), key, metadata))
      .toThrow('BACKUP_ARTIFACT_FORMAT_INVALID');
    expect(() => decryptBackupArtifact(Buffer.alloc(0), key, metadata)).toThrow('BACKUP_ARTIFACT_FORMAT_INVALID');
  });

  it('accepts only canonical framing/version/algorithm/header syntax and rejects oversized headers', () => {
    const key = generateBackupArtifactKey();
    const artifact = encryptBackupArtifact(Buffer.alloc(0), key, metadata);
    const badMagic = Buffer.from(artifact);
    badMagic.writeUInt8(badMagic.readUInt8(0) ^ 1, 0);
    const zeroLength = Buffer.from(artifact);
    zeroLength.writeUInt32BE(0, 8);
    const hugeLength = Buffer.from(artifact);
    hugeLength.writeUInt32BE(0xffffffff, 8);
    const invalid = [badMagic, zeroLength, hugeLength,
      replaceHeader(artifact, (header) => ({ ...header, version: 2 })),
      replaceHeader(artifact, (header) => ({ ...header, algorithm: 'aes-256-cbc' })),
      replaceHeader(artifact, (header) => ({ ...header, nonce: 'AAAAAAAAAAAAAAA=' })),
      replaceHeader(artifact, (header) => ({ ...header, password: 'must not leak' })),
      replaceHeader(artifact, (header) => Object.fromEntries(Object.entries(header).reverse())),
    ];
    for (const value of invalid) expect(() => decryptBackupArtifact(value, key, metadata))
      .toThrow('BACKUP_ARTIFACT_FORMAT_INVALID');
    const original = headerOf(artifact);
    const noncanonical = Buffer.from(` ${JSON.stringify(original.value)}`);
    const prefix = Buffer.from(artifact.subarray(0, 12));
    prefix.writeUInt32BE(noncanonical.length, 8);
    expect(() => decryptBackupArtifact(Buffer.concat([prefix, noncanonical, artifact.subarray(12 + original.length)]),
      key, metadata)).toThrow('BACKUP_ARTIFACT_FORMAT_INVALID');
    const duplicate = Buffer.from(JSON.stringify(original.value).replace('{', '{"version":1,'));
    const duplicatePrefix = Buffer.from(artifact.subarray(0, 12));
    duplicatePrefix.writeUInt32BE(duplicate.length, 8);
    expect(() => decryptBackupArtifact(Buffer.concat([duplicatePrefix, duplicate, artifact.subarray(12 + original.length)]),
      key, metadata)).toThrow('BACKUP_ARTIFACT_FORMAT_INVALID');
    const invalidUtf8 = Buffer.from(artifact);
    invalidUtf8[12] = 0xff;
    expect(() => decryptBackupArtifact(invalidUtf8, key, metadata)).toThrow('BACKUP_ARTIFACT_FORMAT_INVALID');
  });

  it('checks the optional full plaintext hash after successful GCM authentication', () => {
    const key = generateBackupArtifactKey();
    const base = encryptBackupArtifact(Buffer.from('synthetic'), key, metadata);
    const context = { ...metadata, payloadSha256: 'a'.repeat(64) };
    const withHash = replaceHeader(base, (header) => {
      const rest = { ...header };
      delete rest.nonce;
      return { ...rest, payloadSha256: context.payloadSha256, nonce: randomBytes(12).toString('base64url') };
    });
    const header = headerOf(withHash);
    const aad = withHash.subarray(0, 12 + header.length);
    const cipher = createCipheriv('aes-256-gcm', key, Buffer.from(header.value.nonce, 'base64url'), { authTagLength: 16 });
    cipher.setAAD(aad);
    const authenticatedWrongHash = Buffer.concat([aad, cipher.update(Buffer.from('synthetic')), cipher.final(), cipher.getAuthTag()]);
    expect(() => decryptBackupArtifact(authenticatedWrongHash, key, context)).toThrow('BACKUP_ARTIFACT_PAYLOAD_HASH_MISMATCH');
  });
});
