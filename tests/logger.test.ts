import { describe, expect, it } from 'vitest';
import { loggerOptions } from '../src/config/logger.js';

describe('logger redaction contract', () => {
  it('redacts authentication, password, PIN, phone and server secret fields', () => {
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
      '*.phone',
      '*.SUPABASE_SECRET_KEY'
    ]));
  });
});
