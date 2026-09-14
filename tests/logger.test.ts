import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';
import { loggerOptions } from '../src/config/logger.js';

describe('logger redaction contract', () => {
  it('redacts authentication, password, PIN, reservation PII, phone and server secrets', () => {
    const options = loggerOptions('info');

    expect(options.redact.censor).toBe('[REDACTED]');
    expect(options.redact.paths).toEqual(expect.arrayContaining([
      'req.headers.authorization',
      'req.body.bindingProof',
      '*.password',
      '*.currentPassword',
      '*.temporaryPassword',
      '*.accessToken',
      '*.refreshToken',
      '*.bindingProof',
      '*.pin',
      '*.guestName',
      '*.guest_name_encrypted',
      '*.phone',
      '*.SUPABASE_SECRET_KEY',
      '*.RESERVATION_PII_KEY_BASE64',
      '*.RESERVATION_PII_KEYRING_JSON',
      '*.RESERVATION_GUEST_NAME_PEPPER',
      '*.endpoint',
      '*.p256dh',
      '*.auth',
      '*.ciphertextBase64',
      '*.nonceBase64',
      '*.authTagBase64',
      '*.endpointDigest',
      '*.sessionDigest',
      '*.materialDigest',
      '*.WEB_PUSH_SUBSCRIPTION_KEY_BASE64',
      '*.WEB_PUSH_SUBSCRIPTION_KEYRING_JSON',
      '*.WEB_PUSH_BINDING_DIGEST_SECRET'
    ]));
  });

  it('redacts binding proofs from request bodies and structured command logs', () => {
    const proof = 'raw-actor-session-bound-binding-proof';
    const records: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        records.push(String(chunk));
        callback();
      }
    });
    const logger = pino(loggerOptions('info'), stream);

    logger.info({
      req: { body: { bindingProof: proof } },
      command: { bindingProof: proof }
    });

    const serialized = records.join('');
    expect(serialized).not.toContain(proof);
    expect(serialized.match(/\[REDACTED\]/g)).toHaveLength(2);
  });
});
