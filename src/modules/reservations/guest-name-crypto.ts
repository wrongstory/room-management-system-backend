import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AppError } from '../../lib/app-error.js';

interface GuestNameEnvelope {
  version: 1;
  keyVersion: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

function keyFromBase64(encoded: string): Buffer {
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encoded) {
    throw new AppError(500, 'RESERVATION_PII_KEY_INVALID', '예약 개인정보 암호키 설정이 올바르지 않습니다.');
  }
  return key;
}

export function normalizeGuestName(value: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 80) {
    throw new AppError(400, 'INVALID_GUEST_NAME', '고객 이름은 1자 이상 80자 이하로 입력해 주세요.');
  }
  const normalized = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (normalized.length < 1 || normalized.length > 80) {
    throw new AppError(400, 'INVALID_GUEST_NAME', '고객 이름은 1자 이상 80자 이하로 입력해 주세요.');
  }
  return normalized;
}

export function encryptGuestName(value: string, encodedKey: string, keyVersion: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFromBase64(encodedKey), iv);
  const ciphertext = Buffer.concat([cipher.update(normalizeGuestName(value), 'utf8'), cipher.final()]);
  const envelope: GuestNameEnvelope = {
    version: 1,
    keyVersion,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64')
  };
  return JSON.stringify(envelope);
}

export function decryptGuestName(
  value: string,
  encodedKey: string,
  expectedKeyVersion: string,
  previousKeys: Record<string, string> = {}
): string {
  try {
    const envelope = JSON.parse(value) as GuestNameEnvelope;
    const selectedKey = envelope.keyVersion === expectedKeyVersion
      ? encodedKey
      : previousKeys[envelope.keyVersion];
    if (envelope.version !== 1 || !selectedKey) {
      throw new Error('Unsupported envelope');
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      keyFromBase64(selectedKey),
      Buffer.from(envelope.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final()
    ]).toString('utf8');
  } catch {
    throw new AppError(500, 'RESERVATION_PII_DECRYPT_FAILED', '예약 개인정보를 복호화하지 못했습니다.');
  }
}
