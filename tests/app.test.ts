import { describe, expect, it, vi } from 'vitest';
import { buildApp, type AppServices } from '../src/app.js';
import type { AppEnv } from '../src/config/env.js';

const env: AppEnv = {
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: 3000,
  LOG_LEVEL: 'silent',
  CORS_ORIGINS: 'http://127.0.0.1:4173',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'publishable-test',
  SUPABASE_SECRET_KEY: 'secret-test',
  corsOrigins: ['http://127.0.0.1:4173']
};

function services(): AppServices {
  return {
    auth: {
      login: vi.fn(async () => ({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresIn: 3600,
        user: {
          authUserId: 'auth-user-1',
          profileId: 'profile-1',
          displayName: '관리자 데모',
          role: 'admin' as const
        }
      })),
      authenticate: vi.fn(async (accessToken: string) => ({
        authUserId: 'auth-user-1',
        profileId: 'profile-1',
        displayName: '관리자 데모',
        role: 'admin' as const,
        accessToken
      }))
    },
    rooms: {
      list: vi.fn(async () => [{
        id: 'room-1',
        roomNumber: '117',
        roomTypeCode: 'premium',
        roomTypeName: '프리미어',
        elevatorZone: 'A' as const,
        dataStatus: 'verified' as const
      }])
    }
  };
}

describe('application', () => {
  it('returns health status', async () => {
    const app = await buildApp({ env, services: services(), logger: false });
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok' });
    await app.close();
  });

  it('rejects protected routes without a bearer token', async () => {
    const app = await buildApp({ env, services: services(), logger: false });
    const response = await app.inject({ method: 'GET', url: '/v1/rooms' });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('MISSING_ACCESS_TOKEN');
    await app.close();
  });

  it('returns rooms for an authenticated actor', async () => {
    const app = await buildApp({ env, services: services(), logger: false });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/rooms',
      headers: { authorization: 'Bearer access-token' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().rooms).toHaveLength(1);
    expect(response.json().rooms[0].roomNumber).toBe('117');
    await app.close();
  });

  it('validates numeric login passwords', async () => {
    const app = await buildApp({ env, services: services(), logger: false });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { loginId: '관리자', password: 'abc' }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
    await app.close();
  });
});
