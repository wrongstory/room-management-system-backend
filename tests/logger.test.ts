import { describe, expect, it } from 'vitest';
import { loggerOptions } from '../src/config/logger.js';

describe('logger redaction contract', () => {
  it('redacts authentication, password, PIN, reservation PII, phone and server secrets', () => {
    const options = loggerOptions('info');

    expect(options.redact.censor).toBe('[REDACTED]');
    expect(options.redact.paths).toEqual(expect.arrayContaining([
      'req.headers.authorization',
      '*.password',
      '*.currentPassword',
      '*.temporaryPassword',
      '*.accessToken',
      '*.refreshToken',
      '*.pin',
      '*.guestName',
      '*.guest_name_encrypted',
      '*.phone',
      '*.SUPABASE_SECRET_KEY',
      '*.RESERVATION_PII_KEY_BASE64',
      '*.RESERVATION_PII_KEYRING_JSON',
      '*.RESERVATION_GUEST_NAME_PEPPER'
    ]));
  });
});
