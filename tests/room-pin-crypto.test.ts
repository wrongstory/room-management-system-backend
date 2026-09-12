import { describe, expect, it } from 'vitest';
import {
  canonicalRoomPin,
  decryptRoomPin,
  encryptRoomPin,
  type RoomPinCryptoConfig
} from '../src/modules/rooms/room-pin-crypto.js';
import {
  decryptRoomPin as decryptEdgeRoomPin,
  encryptRoomPin as encryptEdgeRoomPin
} from '../supabase/functions/_shared/room-pin-crypto.js';

const roomId = '11111111-1111-4111-8111-111111111111';
const otherRoomId = '22222222-2222-4222-8222-222222222222';
const zeroKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const oneKey = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';

function baseConfig(overrides: Partial<RoomPinCryptoConfig> = {}): RoomPinCryptoConfig {
  return {
    key: zeroKey,
    keyVersion: 'v1',
    keyring: {},
    environment: 'dev',
    projectRef: 'local',
    ...overrides
  };
}

function flipFirstByte(value: string): string {
  const bytes = Buffer.from(value, 'base64');
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  return bytes.toString('base64');
}

describe('room PIN AES-256-GCM envelope', () => {
  it('preserves leading zero digits and never accepts a client prefix', () => {
    expect(canonicalRoomPin('101', '0123')).toBe('101-0123');
    expect(() => canonicalRoomPin('101', '101-0123')).toThrowError('INVALID_ROOM_PIN');
    expect(() => canonicalRoomPin('101', '123')).toThrowError('INVALID_ROOM_PIN');
    expect(() => canonicalRoomPin('101', '123456789')).toThrowError('INVALID_ROOM_PIN');
  });

  it('matches the Node and Edge golden vector byte-for-byte', async () => {
    const nonce = Uint8Array.from({ length: 12 }, (_, index) => index);
    const config = baseConfig({ nonce });
    const nodeEnvelope = await encryptRoomPin('101-0123', roomId, 1, config);
    const edgeEnvelope = await encryptEdgeRoomPin('101-0123', roomId, 1, config);

    expect(nodeEnvelope).toEqual(edgeEnvelope);
    expect(nodeEnvelope).toEqual({
      envelopeFormat: 1,
      keyVersion: 'v1',
      ciphertextBase64: 'ufsCfzDMvco=',
      nonceBase64: 'AAECAwQFBgcICQoL',
      authTagBase64: 'bNE3Hx5KWPRk0v6/q9/TJg==',
      aadEnvironment: 'dev',
      aadProjectRef: 'local'
    });
    expect(await decryptEdgeRoomPin(nodeEnvelope, roomId, '101', 1, config)).toBe('101-0123');
    expect(await decryptRoomPin(edgeEnvelope, roomId, '101', 1, config)).toBe('101-0123');
  });

  it('uses a fresh 12-byte random nonce for every envelope', async () => {
    const config = baseConfig();
    const envelopes = await Promise.all(Array.from({ length: 64 }, () => encryptRoomPin('101-0123', roomId, 1, config)));
    expect(new Set(envelopes.map(({ nonceBase64 }) => nonceBase64)).size).toBe(64);
    expect(envelopes.every(({ nonceBase64 }) => Buffer.from(nonceBase64, 'base64').length === 12)).toBe(true);
  });

  it.each(['ciphertextBase64', 'nonceBase64', 'authTagBase64'] as const)(
    'fails closed when %s is tampered',
    async (field) => {
      const envelope = await encryptRoomPin('101-0123', roomId, 1, baseConfig());
      await expect(decryptRoomPin({ ...envelope, [field]: flipFirstByte(envelope[field]) }, roomId, '101', 1, baseConfig()))
        .rejects.toMatchObject({ code: 'ROOM_PIN_DECRYPT_FAILED' });
    }
  );

  it('supports a bounded prior-key read and rejects a missing key version', async () => {
    const oldEnvelope = await encryptRoomPin('101-0123', roomId, 1, baseConfig());
    const rotated = baseConfig({ key: oneKey, keyVersion: 'v2', keyring: { v1: zeroKey } });
    expect(await decryptRoomPin(oldEnvelope, roomId, '101', 1, rotated)).toBe('101-0123');
    await expect(decryptRoomPin(oldEnvelope, roomId, '101', 1, baseConfig({ key: oneKey, keyVersion: 'v2' })))
      .rejects.toMatchObject({ code: 'ROOM_PIN_KEY_UNAVAILABLE' });
  });

  it('binds the envelope to the exact room and PIN version', async () => {
    const envelope = await encryptRoomPin('101-0123', roomId, 1, baseConfig());
    await expect(decryptRoomPin(envelope, otherRoomId, '101', 1, baseConfig()))
      .rejects.toMatchObject({ code: 'ROOM_PIN_DECRYPT_FAILED' });
    await expect(decryptRoomPin(envelope, roomId, '101', 2, baseConfig()))
      .rejects.toMatchObject({ code: 'ROOM_PIN_DECRYPT_FAILED' });
  });

  it('decrypts a restored production envelope from its stored AAD context', async () => {
    const production = baseConfig({ environment: 'production', projectRef: 'prod-ref' });
    const restoredRuntime = baseConfig({ environment: 'recovery', projectRef: 'recovery-ref' });
    const envelope = await encryptRoomPin('101-0123', roomId, 1, production);

    expect(await decryptRoomPin(envelope, roomId, '101', 1, restoredRuntime)).toBe('101-0123');
    await expect(decryptRoomPin({ ...envelope, aadEnvironment: 'recovery' }, roomId, '101', 1, restoredRuntime))
      .rejects.toMatchObject({ code: 'ROOM_PIN_DECRYPT_FAILED' });
    await expect(decryptRoomPin({ ...envelope, aadProjectRef: 'other-ref' }, roomId, '101', 1, restoredRuntime))
      .rejects.toMatchObject({ code: 'ROOM_PIN_DECRYPT_FAILED' });
  });

  it('rejects invalid keyring shape before cryptographic work', async () => {
    const tooManyKeys = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`old-${index}`, Buffer.alloc(32, index + 2).toString('base64')]));
    await expect(encryptRoomPin('101-0123', roomId, 1, baseConfig({ keyring: tooManyKeys })))
      .rejects.toMatchObject({ code: 'ROOM_PIN_CRYPTO_CONFIG_INVALID' });
  });
});
