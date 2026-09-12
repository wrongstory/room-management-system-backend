export interface RoomPinCryptoConfig {
  key: string;
  keyVersion: string;
  keyring: Record<string, string>;
  environment: string;
  projectRef: string;
  /** Golden-vector input only. Production callers must leave this unset. */
  nonce?: Uint8Array;
}

export interface RoomPinEnvelope {
  envelopeFormat: 1;
  keyVersion: string;
  ciphertextBase64: string;
  nonceBase64: string;
  authTagBase64: string;
  aadEnvironment: string;
  aadProjectRef: string;
}

export class RoomPinCryptoError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "RoomPinCryptoError";
  }
}

const versionPattern = /^[A-Za-z0-9._-]{1,32}$/;
const bindingPattern = /^[A-Za-z0-9._:-]{1,80}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const pinPattern = /^[0-9]{4,8}$/;

function fail(code: string): never {
  throw new RoomPinCryptoError(code);
}

function bytesToBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bufferSource(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer;
}

function base64ToBytes(value: string, expectedLength?: number): Uint8Array {
  try {
    if (!value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
      fail("ROOM_PIN_ENVELOPE_INVALID");
    }
    const binary = atob(value);
    const result = Uint8Array.from(
      binary,
      (character) => character.charCodeAt(0),
    );
    if (
      bytesToBase64(result) !== value ||
      (expectedLength !== undefined && result.length !== expectedLength)
    ) {
      fail("ROOM_PIN_ENVELOPE_INVALID");
    }
    return result;
  } catch (error) {
    if (error instanceof RoomPinCryptoError) throw error;
    fail("ROOM_PIN_ENVELOPE_INVALID");
  }
}

function validateBinding(
  config: RoomPinCryptoConfig,
  roomId: string,
  pinVersion: number,
): void {
  if (
    !versionPattern.test(config.keyVersion) ||
    !bindingPattern.test(config.environment) ||
    !bindingPattern.test(config.projectRef) || !uuidPattern.test(roomId) ||
    !Number.isSafeInteger(pinVersion) || pinVersion < 1
  ) {
    fail("ROOM_PIN_CRYPTO_CONFIG_INVALID");
  }
  const entries = Object.entries(config.keyring);
  if (entries.length > 5 || Object.hasOwn(config.keyring, config.keyVersion)) {
    fail("ROOM_PIN_CRYPTO_CONFIG_INVALID");
  }
  const keyIdentities = new Set<string>([config.key]);
  base64ToBytes(config.key, 32);
  for (const [version, key] of entries) {
    if (!versionPattern.test(version) || keyIdentities.has(key)) {
      fail("ROOM_PIN_CRYPTO_CONFIG_INVALID");
    }
    base64ToBytes(key, 32);
    keyIdentities.add(key);
  }
}

function aad(
  environment: string,
  projectRef: string,
  roomId: string,
  pinVersion: number,
): Uint8Array {
  if (!bindingPattern.test(environment) || !bindingPattern.test(projectRef)) {
    fail("ROOM_PIN_ENVELOPE_INVALID");
  }
  return new TextEncoder().encode(
    `room-pin-envelope:v1\0${environment}\0${projectRef}\0${roomId.toLowerCase()}\0${pinVersion}`,
  );
}

export function canonicalRoomPin(
  roomNumber: string,
  pinDigits: string,
): string {
  if (
    typeof roomNumber !== "string" || !/^[A-Za-z0-9]{1,32}$/.test(roomNumber) ||
    typeof pinDigits !== "string" || !pinPattern.test(pinDigits)
  ) {
    fail("INVALID_ROOM_PIN");
  }
  return `${roomNumber}-${pinDigits}`;
}

export async function encryptRoomPin(
  canonicalCredential: string,
  roomId: string,
  pinVersion: number,
  config: RoomPinCryptoConfig,
): Promise<RoomPinEnvelope> {
  validateBinding(config, roomId, pinVersion);
  if (!/^[A-Za-z0-9]{1,32}-[0-9]{4,8}$/.test(canonicalCredential)) {
    fail("INVALID_ROOM_PIN");
  }
  const nonce = config.nonce === undefined
    ? crypto.getRandomValues(new Uint8Array(12))
    : new Uint8Array(config.nonce);
  if (nonce.length !== 12) fail("ROOM_PIN_ENVELOPE_INVALID");
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      bufferSource(base64ToBytes(config.key, 32)),
      "AES-GCM",
      false,
      ["encrypt"],
    );
    const combined = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: bufferSource(nonce),
          additionalData: bufferSource(
            aad(config.environment, config.projectRef, roomId, pinVersion),
          ),
          tagLength: 128,
        },
        key,
        bufferSource(new TextEncoder().encode(canonicalCredential)),
      ),
    );
    return {
      envelopeFormat: 1,
      keyVersion: config.keyVersion,
      ciphertextBase64: bytesToBase64(combined.slice(0, -16)),
      nonceBase64: bytesToBase64(nonce),
      authTagBase64: bytesToBase64(combined.slice(-16)),
      aadEnvironment: config.environment,
      aadProjectRef: config.projectRef,
    };
  } catch (error) {
    if (error instanceof RoomPinCryptoError) throw error;
    fail("ROOM_PIN_ENCRYPT_FAILED");
  }
}

export async function decryptRoomPin(
  envelope: RoomPinEnvelope,
  roomId: string,
  roomNumber: string,
  pinVersion: number,
  config: RoomPinCryptoConfig,
): Promise<string> {
  validateBinding(config, roomId, pinVersion);
  const encodedKey = envelope.keyVersion === config.keyVersion
    ? config.key
    : config.keyring[envelope.keyVersion];
  if (!encodedKey) fail("ROOM_PIN_KEY_UNAVAILABLE");
  if (
    envelope.envelopeFormat !== 1 || !versionPattern.test(envelope.keyVersion)
  ) fail("ROOM_PIN_ENVELOPE_INVALID");
  try {
    const ciphertext = base64ToBytes(envelope.ciphertextBase64);
    const tag = base64ToBytes(envelope.authTagBase64, 16);
    const combined = new Uint8Array(ciphertext.length + tag.length);
    combined.set(ciphertext);
    combined.set(tag, ciphertext.length);
    const key = await crypto.subtle.importKey(
      "raw",
      bufferSource(base64ToBytes(encodedKey, 32)),
      "AES-GCM",
      false,
      ["decrypt"],
    );
    const plaintext = new TextDecoder("utf-8", { fatal: true }).decode(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: bufferSource(base64ToBytes(envelope.nonceBase64, 12)),
          additionalData: bufferSource(
            aad(
              envelope.aadEnvironment,
              envelope.aadProjectRef,
              roomId,
              pinVersion,
            ),
          ),
          tagLength: 128,
        },
        key,
        bufferSource(combined),
      ),
    );
    if (
      !/^[A-Za-z0-9]{1,32}-[0-9]{4,8}$/.test(plaintext) ||
      !plaintext.startsWith(`${roomNumber}-`)
    ) {
      fail("ROOM_PIN_DECRYPT_FAILED");
    }
    return plaintext;
  } catch (error) {
    if (
      error instanceof RoomPinCryptoError &&
      error.code === "ROOM_PIN_KEY_UNAVAILABLE"
    ) throw error;
    fail("ROOM_PIN_DECRYPT_FAILED");
  }
}
