import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';

const localEnv = {
  APP_ENV: 'local',
  NODE_ENV: 'test',
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_PUBLISHABLE_KEY: 'local-publishable',
  SUPABASE_SECRET_KEY: 'local-secret'
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
      CORS_ORIGINS: 'https://rooms.example.com'
    });

    expect(env.SUPABASE_PROJECT_REF).toBe('aodikrxcczbogjpsjwjt');
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
});
