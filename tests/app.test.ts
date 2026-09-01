import { describe, expect, it, vi } from 'vitest';
import { buildApp, type AppServices } from '../src/app.js';
import type { AppEnv } from '../src/config/env.js';

const env: AppEnv = {
  APP_ENV: 'local',
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: 3000,
  LOG_LEVEL: 'silent',
  CORS_ORIGINS: 'http://127.0.0.1:4173',
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_PUBLISHABLE_KEY: 'publishable-test',
  SUPABASE_SECRET_KEY: 'secret-test',
  ACCOUNT_PHONE_PEPPER: 'test-phone-pepper-at-least-32-characters',
  RESERVATION_PII_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'),
  RESERVATION_PII_KEY_VERSION: 'test-v1',
  RESERVATION_PII_KEYRING_JSON: '{}',
  RESERVATION_GUEST_NAME_PEPPER: 'reservation-guest-name-pepper-test-value',
  RESERVATION_SCHEDULER_INTERVAL_SECONDS: 60,
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
          role: 'admin' as const,
          mustChangePassword: false
        }
      })),
      changePassword: vi.fn(async () => undefined),
      authenticate: vi.fn(async (accessToken: string) => ({
        authUserId: 'auth-user-1',
        profileId: 'profile-1',
        displayName: '관리자 데모',
        role: 'admin' as const,
        mustChangePassword: false,
        accessToken
      }))
    },
    accounts: {
      list: vi.fn(async () => []),
      create: vi.fn(async (_actor, input) => ({
        account: {
          id: '11111111-1111-4111-8111-111111111111',
          displayName: input.displayName,
          loginId: input.displayName,
          role: input.role,
          status: 'active' as const,
          phoneLastFour: '5678',
          mustChangePassword: true,
          failedLoginCount: 0,
          lockedUntil: null,
          createdAt: '2026-08-26T00:00:00.000Z',
          updatedAt: '2026-08-26T00:00:00.000Z'
        },
        temporaryPassword: '5678'
      })),
      changeRole: vi.fn(),
      changeStatus: vi.fn(),
      unlock: vi.fn(),
      resetPassword: vi.fn()
    },
    availability: {
      listCurrent: vi.fn(async () => []),
      listChangeRequests: vi.fn(async () => []),
      submit: vi.fn(),
      requestChange: vi.fn(),
      decideChange: vi.fn(),
      listCandidates: vi.fn(async () => [])
    },
    rooms: {
      list: vi.fn(async () => [{
        id: 'room-1',
        roomNumber: '117',
        roomTypeCode: 'premium',
        roomTypeName: '프리미어',
        elevatorZone: 'A' as const,
        dataStatus: 'verified' as const,
        stateVersion: 1,
        occupied: false,
        cleaningRequired: false,
        candleCount: 0,
        pinSyncStatus: 'unconfigured' as const,
        allocationBlocked: true,
        allocationReady: false,
        reasonCodes: ['DATA_UNCONFIRMED' as const]
      }]),
      get: vi.fn(),
      changeMasterData: vi.fn(),
      mutateOperation: vi.fn()
    },
    reservations: {
      list: vi.fn(async () => []),
      get: vi.fn(),
      create: vi.fn(async (_actor, input) => ({
        id: '41000000-0000-4000-8000-000000000001',
        roomId: input.roomId,
        checkInAt: input.checkInAt,
        checkOutAt: input.checkOutAt,
        guestCount: input.guestCount,
        status: 'active' as const,
        preparationObligationId: '42000000-0000-4000-8000-000000000001',
        checkoutObligationId: '43000000-0000-4000-8000-000000000001',
        version: 1,
        roomStateVersion: 2,
        actualCheckInAt: null,
        actualCheckoutAt: null,
        cancelledAt: null,
        createdAt: '2026-08-28T00:00:00.000Z',
        updatedAt: '2026-08-28T00:00:00.000Z'
      })),
      change: vi.fn(),
      cancel: vi.fn(),
      manualCheckout: vi.fn(),
      processDue: vi.fn(),
      createManualCleaningRequest: vi.fn(),
      cancelManualCleaningRequest: vi.fn()
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

  it('returns rooms for an authenticated administrator', async () => {
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

  it('runs the reservation transition worker when an administrator profile is configured', async () => {
    const appServices = services();
    appServices.reservations.processDue = vi.fn(async () => ({
      asOf: '2026-08-29T00:00:00.000Z',
      checkedInCount: 0,
      checkedOutCount: 0,
      blockedCheckInCount: 0,
      purgedGuestNameCount: 0
    }));
    const app = await buildApp({
      env: {
        ...env,
        RESERVATION_SCHEDULER_ACTOR_PROFILE_ID: 'profile-1'
      },
      services: appServices,
      logger: false
    });

    await app.ready();

    expect(appServices.reservations.processDue).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: 'profile-1',
        role: 'admin'
      }),
      expect.stringMatching(/^reservation-scheduler-/)
    );
    const schedulerKey = String(
      (appServices.reservations.processDue as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]
    );
    const manualResponse = await app.inject({
      method: 'POST',
      url: '/v1/reservations/transitions/process',
      headers: {
        authorization: 'Bearer access-token',
        'idempotency-key': schedulerKey
      }
    });

    expect(manualResponse.statusCode).toBe(400);
    expect(manualResponse.json().error.code).toBe('RESERVED_IDEMPOTENCY_KEY');
    expect(appServices.reservations.processDue).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('rejects the scheduler idempotency namespace on the manual transition route', async () => {
    const appServices = services();
    const app = await buildApp({ env, services: appServices, logger: false });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/reservations/transitions/process',
      headers: {
        authorization: 'Bearer access-token',
        'idempotency-key': 'reservation-scheduler-202609010430'
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('RESERVED_IDEMPOTENCY_KEY');
    expect(appServices.reservations.processDue).not.toHaveBeenCalled();
    await app.close();
  });

  it('does not expose the global room projection to a maid', async () => {
    const appServices = services();
    appServices.auth.authenticate = vi.fn(async (accessToken: string) => ({
      authUserId: 'auth-maid-1',
      profileId: 'maid-1',
      displayName: '메이드',
      role: 'maid' as const,
      mustChangePassword: false,
      accessToken
    }));
    const app = await buildApp({ env, services: appServices, logger: false });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/rooms',
      headers: { authorization: 'Bearer access-token' }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('ADMIN_REQUIRED');
    expect(appServices.rooms.list).not.toHaveBeenCalled();
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

  it('creates an individual maid account without exposing internal auth fields', async () => {
    const app = await buildApp({ env, services: services(), logger: false });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: {
        authorization: 'Bearer access-token',
        'idempotency-key': 'account-create-0001'
      },
      payload: { displayName: '김민지', role: 'maid', phone: '010-1234-5678' }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      account: { displayName: '김민지', loginId: '김민지', role: 'maid' },
      temporaryPassword: '5678'
    });
    expect(JSON.stringify(response.json())).not.toContain('@auth.castletheart.invalid');
    expect(JSON.stringify(response.json())).not.toContain('authUserId');
    await app.close();
  });

  it('blocks business routes until the temporary password is changed', async () => {
    const appServices = services();
    appServices.auth.authenticate = vi.fn(async (accessToken: string) => ({
      authUserId: 'auth-user-1',
      profileId: 'profile-1',
      displayName: '관리자 데모',
      role: 'admin' as const,
      mustChangePassword: true,
      accessToken
    }));
    const app = await buildApp({ env, services: appServices, logger: false });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/rooms',
      headers: { authorization: 'Bearer access-token' }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    await app.close();
  });

  it('allows the four-digit temporary password but rejects five digits', async () => {
    const app = await buildApp({ env, services: services(), logger: false });
    const temporary = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { loginId: '김민지', password: '5678' }
    });
    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { loginId: '김민지', password: '12345' }
    });

    expect(temporary.statusCode).toBe(200);
    expect(invalid.statusCode).toBe(400);
    await app.close();
  });

  it('returns the shared login rate-limit error contract', async () => {
    const app = await buildApp({ env, services: services(), logger: false });
    const responses = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      responses.push(await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { loginId: '관리자', password: '123456' }
      }));
    }

    expect(responses.slice(0, 10).every((response) => response.statusCode === 200)).toBe(true);
    expect(responses[10]?.statusCode).toBe(429);
    expect(responses[10]?.json().error.code).toBe('LOGIN_RATE_LIMITED');
    expect(Number(responses[10]?.headers['retry-after'])).toBeGreaterThan(0);
    await app.close();
  });

  it('submits a maid weekly availability with an idempotency key', async () => {
    const appServices = services();
    appServices.auth.authenticate = vi.fn(async (accessToken: string) => ({
      authUserId: 'auth-maid-1',
      profileId: '11111111-1111-4111-8111-111111111111',
      displayName: '김민지',
      role: 'maid' as const,
      mustChangePassword: false,
      accessToken
    }));
    appServices.availability.submit = vi.fn(async (_actor, input) => ({
      id: '22222222-2222-4222-8222-222222222222',
      maidProfileId: '11111111-1111-4111-8111-111111111111',
      weekStart: input.weekStart,
      version: 1,
      status: 'submitted' as const,
      current: true,
      submittedAt: '2026-08-30T03:00:00.000Z',
      days: input.availableDates.map((workDate: string) => ({ workDate, available: true }))
    }));

    const app = await buildApp({ env, services: appServices, logger: false });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/availability/submissions',
      headers: {
        authorization: 'Bearer access-token',
        'idempotency-key': 'availability-submit-0001'
      },
      payload: {
        weekStart: '2026-08-31',
        availableDates: ['2026-08-31', '2026-09-02'],
        expectedVersion: 0
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().availability).toMatchObject({ version: 1, current: true });
    expect(appServices.availability.submit).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'maid' }),
      expect.objectContaining({ idempotencyKey: 'availability-submit-0001' })
    );
    await app.close();
  });

  it('requires an administrator for the availability candidate list', async () => {
    const appServices = services();
    appServices.auth.authenticate = vi.fn(async (accessToken: string) => ({
      authUserId: 'auth-maid-1',
      profileId: '11111111-1111-4111-8111-111111111111',
      displayName: '김민지',
      role: 'maid' as const,
      mustChangePassword: false,
      accessToken
    }));
    const app = await buildApp({ env, services: appServices, logger: false });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/availability/candidates?workDate=2026-08-31',
      headers: { authorization: 'Bearer access-token' }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('ADMIN_REQUIRED');
    expect(appServices.availability.listCandidates).not.toHaveBeenCalled();
    await app.close();
  });

  it('creates a reservation through an administrator command without returning encrypted PII', async () => {
    const app = await buildApp({ env, services: services(), logger: false });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/reservations',
      headers: {
        authorization: 'Bearer access-token',
        'idempotency-key': 'reservation-create-0001'
      },
      payload: {
        roomId: '51000000-0000-4000-8000-000000000001',
        checkInAt: '2026-09-01T16:00:00+09:00',
        checkOutAt: '2026-09-02T11:00:00+09:00',
        guestCount: 2,
        guestName: '홍길동',
        expectedRoomVersion: 1
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().reservation).toMatchObject({
      status: 'active',
      guestCount: 2,
      version: 1
    });
    expect(JSON.stringify(response.json())).not.toContain('guest_name_encrypted');
    expect(JSON.stringify(response.json())).not.toContain('홍길동');
    await app.close();
  });
});
