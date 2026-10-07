import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { buildApp, type AppServices } from '../src/app.js';
import type { AppEnv } from '../src/config/env.js';

const require = createRequire(import.meta.url);
const env: AppEnv = {
  APP_ENV: 'local', NODE_ENV: 'test', HOST: '127.0.0.1', PORT: 3000, LOG_LEVEL: 'silent',
  CORS_ORIGINS: 'http://127.0.0.1:4173', corsOrigins: ['http://127.0.0.1:4173'],
  SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable',
  SUPABASE_SECRET_KEY: 'synthetic-server-secret', ACCOUNT_PHONE_PEPPER: 'synthetic-phone-pepper-minimum-32bytes',
  RESERVATION_PII_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'), RESERVATION_PII_KEY_VERSION: 'test-v1',
  RESERVATION_PII_KEYRING_JSON: '{}', RESERVATION_GUEST_NAME_PEPPER: 'synthetic-guest-pepper-minimum-32bytes',
  ROOM_PIN_KEY_BASE64: Buffer.alloc(32, 8).toString('base64'), ROOM_PIN_KEY_VERSION: 'pin-v1', ROOM_PIN_KEYRING_JSON: '{}',
  PAYROLL_CURSOR_HMAC_SECRET: 'synthetic-payroll-cursor-secret-32bytes',
  NOTIFICATION_CURSOR_HMAC_SECRET: 'synthetic-notification-cursor-32bytes',
  INSPECTION_CURSOR_HMAC_SECRET: 'synthetic-inspection-cursor-secret-32bytes',
  WEB_PUSH_SUBSCRIPTION_KEY_BASE64: Buffer.alloc(32, 4).toString('base64'), WEB_PUSH_SUBSCRIPTION_KEY_VERSION: 'v1',
  WEB_PUSH_SUBSCRIPTION_KEYRING_JSON: '{}', WEB_PUSH_BINDING_DIGEST_SECRET: 'synthetic-web-push-binding-secret-32bytes',
  VAPID_CURRENT_KEY_VERSION: 'vapid-v1',
  VAPID_PUBLIC_KEY: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  VAPID_PUBLIC_KEYRING_JSON: '{}', RESERVATION_SCHEDULER_INTERVAL_SECONDS: 60
};

async function fixture() {
  const login = vi.fn(async () => ({ accepted: true }));
  const authenticate = vi.fn(async () => {
    throw new Error('synthetic-db-detail-not-for-client');
  });
  const listRooms = vi.fn();
  // Only local injection targets are invoked; unused service methods never query a DB.
  const services = {
    auth: { login, authenticate }, accounts: {}, availability: {},
    rooms: { list: listRooms }, reservations: {}, payroll: {}
  } as unknown as AppServices;
  return { app: await buildApp({ env, services, logger: false }), login, authenticate, listRooms };
}

describe('#334 dependency security patch', () => {
  it('pins every lockfile copy while preserving the Ajv fast-uri major', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8')) as {
      packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
    };
    expect(manifest.dependencies.fastify).toBe('5.12.5');
    expect(manifest.overrides).toEqual({
      'fast-uri@^3.0.0': '3.1.8', 'fast-uri@^4.0.0': '4.1.5', 'ip-address': '10.7.1',
      'source-map-js': '1.2.2'
    });
    expect(lock.packages['']?.dependencies?.fastify).toBe('5.12.5');
    // Overrides can move copies underneath consumers; do not assume root hoisting.
    const versions = (name: string) => Object.entries(lock.packages)
      .filter(([path]) => path.endsWith(`/node_modules/${name}`) || path === `node_modules/${name}`)
      .map(([, metadata]) => metadata.version);
    expect(versions('fastify')).toEqual(['5.12.5']);
    expect(new Set(versions('fast-uri'))).toEqual(new Set(['3.1.8', '4.1.5']));
    expect(versions('ip-address').length).toBeGreaterThan(0);
    expect(versions('ip-address').every(version => version === '10.7.1')).toBe(true);
    expect(versions('source-map-js').length).toBeGreaterThan(0);
    expect(versions('source-map-js').every(version => version === '1.2.2')).toBe(true);
    expect(lock.packages['node_modules/ajv']?.dependencies?.['fast-uri']).toBe('^3.0.1');
  });

  it('resolves patched installed packages through their real consumers', async () => {
    for (const [consumer, dependency, version] of [
      ['ajv', 'fast-uri', '3.1.8'],
      ['@fastify/ajv-compiler', 'fast-uri', '4.1.5'],
      ['fast-json-stringify', 'fast-uri', '4.1.5'],
      ['@fastify/rate-limit', 'ip-address', '10.7.1'],
      ['postcss', 'source-map-js', '1.2.2']
    ] as const) {
      const consumerRequire = createRequire(require.resolve(`${consumer}/package.json`));
      const installed = JSON.parse(await readFile(consumerRequire.resolve(`${dependency}/package.json`), 'utf8'));
      expect(installed.version, `${consumer} -> ${dependency}`).toBe(version);
    }
    const { app } = await fixture();
    try {
      expect(app.version).toBe('5.12.5');
      const health = await app.inject({ method: 'GET', url: '/health', headers: { origin: env.corsOrigins[0] } });
      expect(health.statusCode).toBe(200);
      expect(health.json().status).toBe('ok');
      expect(health.headers['x-content-type-options']).toBe('nosniff');
      expect(health.headers['access-control-allow-origin']).toBe(env.corsOrigins[0]);
    } finally { await app.close(); }
  });

  it.each([
    ['IPv6 /64', '2001:db8:1234:1::1', '2001:0db8:1234:0001:abcd::2', '2001:db8:1234:2::1'],
    ['IPv4-mapped IPv6', '::ffff:192.0.2.50', '192.0.2.50', '192.0.2.51']
  ])('keeps login rate limits shared across equivalent %s keys', async (_label, initial, equivalent, independent) => {
    const { app, login } = await fixture();
    const attempt = (ip: string) => app.inject({
      method: 'POST', url: '/v1/auth/login',
      headers: { 'x-forwarded-for': ip, authorization: 'Bearer synthetic-dependency-token', cookie: 'synthetic-cookie' },
      payload: { loginId: 'synthetic-admin', password: '123456' }
    });
    try {
      for (let index = 0; index < 10; index += 1) {
        expect((await attempt(initial)).statusCode).toBe(200);
      }
      const limited = await attempt(equivalent);
      expect(limited.statusCode).toBe(429);
      expect(limited.json().error).toEqual({
        code: 'LOGIN_RATE_LIMITED', message: '로그인 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.'
      });
      expect(limited.json().requestId).toEqual(expect.any(String));
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      expect(limited.headers['x-ratelimit-remaining']).toBe('0');
      for (const canary of ['synthetic-dependency-token', 'synthetic-cookie', 'synthetic-admin', '123456']) {
        expect(limited.body).not.toContain(canary);
      }
      expect(login).toHaveBeenCalledTimes(10);
      expect((await attempt(independent)).statusCode).toBe(200);
      expect(login).toHaveBeenCalledTimes(11);
    } finally { await app.close(); }
  });

  it('keeps authentication and generic error responses from exposing service failures or bearer values', async () => {
    const { app, authenticate, listRooms } = await fixture();
    try {
      const missing = await app.inject({ method: 'GET', url: '/v1/rooms' });
      expect(missing.statusCode).toBe(401);
      expect(missing.json().error.code).toBe('MISSING_ACCESS_TOKEN');
      expect(authenticate).not.toHaveBeenCalled();
      const failed = await app.inject({
        method: 'GET', url: '/v1/rooms', headers: { authorization: 'Bearer synthetic-dependency-token' }
      });
      expect(failed.statusCode).toBe(500);
      expect(failed.json()).toEqual({
        error: { code: 'INTERNAL_SERVER_ERROR', message: '서버 오류가 발생했습니다.' }, requestId: expect.any(String)
      });
      for (const canary of ['synthetic-db-detail-not-for-client', 'synthetic-dependency-token', 'stack', 'synthetic-server-secret']) {
        expect(failed.body).not.toContain(canary);
      }
      expect(authenticate).toHaveBeenCalledTimes(1);
      expect(listRooms).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
