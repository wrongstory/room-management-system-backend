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
  RESERVATION_GUEST_NAME_PEPPER: 'reservation-guest-name-pepper-test-value',
  PAYROLL_CURSOR_HMAC_SECRET: 'payroll-cursor-secret-for-tests-123456',
  NOTIFICATION_CURSOR_HMAC_SECRET: 'notification-cursor-secret-tests-123456'
  ,WEB_PUSH_SUBSCRIPTION_KEY_BASE64: Buffer.alloc(32, 4).toString('base64')
  ,WEB_PUSH_SUBSCRIPTION_KEY_VERSION: 'v1'
  ,WEB_PUSH_SUBSCRIPTION_KEYRING_JSON: '{}'
  ,WEB_PUSH_BINDING_DIGEST_SECRET: 'web-push-binding-secret-tests-123456789'
  ,VAPID_CURRENT_KEY_VERSION: 'vapid-v1'
  ,VAPID_PUBLIC_KEY: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'
  ,VAPID_PUBLIC_KEYRING_JSON: '{}'
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

  it('requires a purpose-specific payroll cursor secret of at least 32 UTF-8 bytes', () => {
    for (const value of [
      undefined,
      'short',
      ' '.repeat(32),
      localEnv.ACCOUNT_PHONE_PEPPER,
      localEnv.RESERVATION_GUEST_NAME_PEPPER,
      localEnv.RESERVATION_PII_KEY_BASE64,
      localEnv.SUPABASE_SECRET_KEY,
      localEnv.SUPABASE_PUBLISHABLE_KEY
    ]) {
      expect(() => loadEnv({
        ...localEnv,
        PAYROLL_CURSOR_HMAC_SECRET: value
      })).toThrow();
    }
  });

  it('requires a distinct notification cursor secret of at least 32 UTF-8 bytes', () => {
    for (const value of [
      undefined,
      'short',
      ' '.repeat(32),
      localEnv.PAYROLL_CURSOR_HMAC_SECRET,
      localEnv.ACCOUNT_PHONE_PEPPER,
      localEnv.RESERVATION_GUEST_NAME_PEPPER,
      localEnv.RESERVATION_PII_KEY_BASE64,
      localEnv.SUPABASE_SECRET_KEY,
      localEnv.SUPABASE_PUBLISHABLE_KEY
    ]) {
      expect(() => loadEnv({
        ...localEnv,
        NOTIFICATION_CURSOR_HMAC_SECRET: value
      })).toThrow();
    }
  });

  it('requires canonical distinct Web Push keys and a separate current key version', () => {
    expect(loadEnv({ ...localEnv, WEB_PUSH_SUBSCRIPTION_KEYRING_JSON: '' }).WEB_PUSH_SUBSCRIPTION_KEYRING_JSON).toBe('{}');
    for (const override of [
      { WEB_PUSH_SUBSCRIPTION_KEY_BASE64: Buffer.alloc(16, 4).toString('base64') },
      { WEB_PUSH_SUBSCRIPTION_KEY_BASE64: localEnv.RESERVATION_PII_KEY_BASE64 },
      { WEB_PUSH_BINDING_DIGEST_SECRET: 'short' },
      { WEB_PUSH_BINDING_DIGEST_SECRET: localEnv.NOTIFICATION_CURSOR_HMAC_SECRET },
      {
        WEB_PUSH_SUBSCRIPTION_KEYRING_JSON: JSON.stringify({
          v1: Buffer.alloc(32, 5).toString('base64')
        })
      },
      { WEB_PUSH_SUBSCRIPTION_KEYRING_JSON: '{"old":"not-base64"}' },
      { VAPID_PUBLIC_KEYRING_JSON: JSON.stringify(Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`old-${index}`, localEnv.VAPID_PUBLIC_KEY]))) }
    ]) {
      expect(() => loadEnv({ ...localEnv, ...override })).toThrow();
    }
  });
});
