import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';

const localEnv = {
  APP_ENV: 'local',
  NODE_ENV: 'test',
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_PUBLISHABLE_KEY: 'local-publishable',
  SUPABASE_SECRET_KEY: 'local-secret',
  ACCOUNT_PHONE_PEPPER: 'test-phone-pepper-at-least-32-characters',
  RESERVATION_PII_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'),
  RESERVATION_PII_KEY_VERSION: 'test-v1',
  RESERVATION_PII_KEYRING_JSON: '{}',
  RESERVATION_GUEST_NAME_PEPPER: 'reservation-guest-name-pepper-test-value'
};

describe('environment contract', () => {
  it('accepts the local Supabase environment', () => {
    const env = loadEnv(localEnv);

    expect(env.APP_ENV).toBe('local');
    expect(env.corsOrigins).toContain('http://127.0.0.1:4173');
  });

  it('rejects a remote project in the local environment', () => {
    expect(() => loadEnv({
      ...localEnv,
      SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co'
    })).toThrow();
  });

  it('requires the production project ref and HTTPS origins', () => {
    expect(() => loadEnv({
      ...localEnv,
      APP_ENV: 'production',
      NODE_ENV: 'production',
      SUPABASE_URL: 'https://aodikrxcczbogjpsjwjt.supabase.co',
      CORS_ORIGINS: 'http://localhost:4173'
    })).toThrow();
  });

  it('accepts the matching production project contract', () => {
    const env = loadEnv({
      ...localEnv,
      APP_ENV: 'production',
      NODE_ENV: 'production',
      SUPABASE_URL: 'https://aodikrxcczbogjpsjwjt.supabase.co',
      SUPABASE_PROJECT_REF: 'aodikrxcczbogjpsjwjt',
      CORS_ORIGINS: 'https://rooms.example.com',
      RESERVATION_SCHEDULER_ACTOR_PROFILE_ID: '72000000-0000-4000-8000-000000000001'
    });

    expect(env.SUPABASE_PROJECT_REF).toBe('aodikrxcczbogjpsjwjt');
  });

  it('requires a reservation scheduler actor in production', () => {
    expect(() => loadEnv({
      ...localEnv,
      APP_ENV: 'production',
      NODE_ENV: 'production',
      SUPABASE_URL: 'https://aodikrxcczbogjpsjwjt.supabase.co',
      SUPABASE_PROJECT_REF: 'aodikrxcczbogjpsjwjt',
      CORS_ORIGINS: 'https://rooms.example.com'
    })).toThrow();
  });

  it('rejects a project ref that does not match the Supabase URL', () => {
    expect(() => loadEnv({
      ...localEnv,
      APP_ENV: 'production',
      NODE_ENV: 'production',
      SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
      SUPABASE_PROJECT_REF: 'aodikrxcczbogjpsjwjt',
      CORS_ORIGINS: 'https://rooms.example.com'
    })).toThrow();
  });

  it('rejects a reservation PII key that is not 32 bytes', () => {
    expect(() => loadEnv({
      ...localEnv,
      RESERVATION_PII_KEY_BASE64: Buffer.alloc(16, 7).toString('base64')
    })).toThrow();
  });

  it('rejects a non-canonical reservation PII Base64 value', () => {
    expect(() => loadEnv({
      ...localEnv,
      RESERVATION_PII_KEY_BASE64: `${localEnv.RESERVATION_PII_KEY_BASE64}!!`
    })).toThrow();
  });
});
