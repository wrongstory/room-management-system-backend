import { describe, expect, it, vi } from 'vitest';
import { type AppServices, buildApp } from '../src/app.js';
import type { AppEnv } from '../src/config/env.js';
import { AppError } from '../src/lib/app-error.js';

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
  ROOM_PIN_KEY_BASE64: Buffer.alloc(32, 8).toString('base64'),
  ROOM_PIN_KEY_VERSION: 'pin-v1',
  ROOM_PIN_KEYRING_JSON: '{}',
  RESERVATION_PII_KEY_VERSION: 'test-v1',
  RESERVATION_PII_KEYRING_JSON: '{}',
  RESERVATION_GUEST_NAME_PEPPER: 'reservation-guest-name-pepper-test-value',
  PAYROLL_CURSOR_HMAC_SECRET: 'payroll-cursor-secret-for-tests-123456',
  NOTIFICATION_CURSOR_HMAC_SECRET: 'notification-cursor-secret-tests-123456',
  WEB_PUSH_SUBSCRIPTION_KEY_BASE64: Buffer.alloc(32, 4).toString('base64'),
  WEB_PUSH_SUBSCRIPTION_KEY_VERSION: 'v1',
  WEB_PUSH_SUBSCRIPTION_KEYRING_JSON: '{}',
  WEB_PUSH_BINDING_DIGEST_SECRET: 'web-push-binding-secret-tests-123456789',
  VAPID_CURRENT_KEY_VERSION: 'vapid-v1',
  VAPID_PUBLIC_KEY: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  VAPID_PUBLIC_KEYRING_JSON: '{}',
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
      listTypes: vi.fn(async () => [
        { id: '10000000-0000-4000-8000-000000000001', code: 'oceanFamily', displayName: '파셜 오션뷰 패밀리 투룸 로프트', baseCleaningFee: 30000, baseOccupancy: 4, maxOccupancy: 6, active: true, version: 1, roomCount: 35 },
        { id: '10000000-0000-4000-8000-000000000002', code: 'oceanPremium', displayName: '파셜 오션뷰 프리미어 더블 로프트', baseCleaningFee: 20000, baseOccupancy: 2, maxOccupancy: 4, active: true, version: 1, roomCount: 13 },
        { id: '10000000-0000-4000-8000-000000000003', code: 'premium', displayName: '프리미어 더블 로프트', baseCleaningFee: 20000, baseOccupancy: 2, maxOccupancy: 3, active: true, version: 1, roomCount: 51 },
        { id: '10000000-0000-4000-8000-000000000004', code: 'standard', displayName: '스탠다드 더블 로프트', baseCleaningFee: 16000, baseOccupancy: 2, maxOccupancy: 2, active: true, version: 1, roomCount: 22 }
      ]),
      listOperationBlocks: vi.fn(async () => ({
        roomId: '11111111-1111-4111-8111-111111111111', roomStateVersion: 4, evaluatedAt: '2026-09-20T00:00:00.000Z',
        items: [{ id: '50000000-0000-4000-8000-000000000001', reasonCode: 'MAINTENANCE', startsAt: '2026-09-20T00:00:00.000Z', endsAt: null, status: 'active' as const, createdAt: '2026-09-19T00:00:00.000Z' }]
      })),
      listIssues: vi.fn(async () => ({
        roomId: '11111111-1111-4111-8111-111111111111', roomStateVersion: 5, evaluatedAt: '2026-09-20T00:00:00.000Z',
        items: [{ id: '60000000-0000-4000-8000-000000000001', category: 'FACILITY', severity: 'warning' as const, blocksGuestAssignment: true, description: '창문 점검', status: 'open' as const, reportedAt: '2026-09-19T00:00:00.000Z' }]
      })),
      listEvents: vi.fn(async () => ({
        roomId: '11111111-1111-4111-8111-111111111111', roomStateVersion: 6, evaluatedAt: '2026-09-20T00:00:00.000Z',
        items: [{ id: '70000000-0000-4000-8000-000000000001', eventKey: 'occupancy:70000000-0000-4000-8000-000000000001', source: 'occupancy' as const, category: 'occupancy' as const, eventType: 'scheduled_check_in', actorProfileId: '10000000-0000-4000-8000-000000000001', actorDisplayName: null, entityId: '80000000-0000-4000-8000-000000000001', reasonCode: 'SCHEDULED_TRANSITION', effectiveAt: '2026-09-20T00:00:00.000Z', recordedAt: '2026-09-20T00:00:01.000Z', reservationId: '80000000-0000-4000-8000-000000000001', summary: { occupiedBefore: false, occupiedAfter: true } }]
      })),
      list: vi.fn(async () => [{
        id: 'room-1',
        roomNumber: '117',
        roomTypeCode: 'premium',
        roomTypeName: '프리미어',
        elevatorZone: 'A' as const,
        dataStatus: 'verified' as const,
        stateVersion: 1,
        evaluatedAt: '2026-09-16T08:00:00.000Z',
        reservationPhase: 'upcoming' as const,
        serverTime: '2026-09-16T08:00:00.000Z',
        occupancyStatus: 'VACANT' as const,
        reservationLifecycle: 'FUTURE' as const,
        readinessStatus: 'READY' as const,
        primaryDisplayStatus: 'READY' as const,
        canonicalPrimaryDisplayStatus: 'READY' as const,
        displayStatusOverride: null,
        nextReservationId: '40000000-0000-4000-8000-000000000001',
        nextCheckInAt: '2026-09-18T07:00:00.000Z',
        nextCheckOutAt: '2026-09-19T02:00:00.000Z',
        blockingReasonCodes: [],
        readinessReasonCodes: [],
        occupied: false,
        cleaningRequired: false,
        candleCount: 0,
        pinSyncStatus: 'unconfigured' as const,
        allocationBlocked: false,
        allocationReady: true,
        reasonCodes: []
      }]),
      get: vi.fn(),
      changeMasterData: vi.fn(),
      mutateOperation: vi.fn(),
      correctOccupancy: vi.fn(async (_actor, input) => ({
        correctionId: '71000000-0000-4000-8000-000000000001',
        roomId: input.roomId,
        reservationId: input.reservationId,
        occupied: input.occupied,
        effectiveAt: input.effectiveAt,
        roomStateVersion: input.expectedRoomVersion + 1,
        recordedAt: '2026-09-20T00:00:01.000Z'
      })),
      overrideDisplayStatus: vi.fn(async (_actor, input) => ({
        overrideId: '72000000-0000-4000-8000-000000000001',
        roomId: input.roomId,
        targetStatus: input.targetStatus,
        roomStateVersion: input.expectedRoomVersion + 1,
        recordedAt: '2026-09-20T00:00:01.000Z'
      })),
      preparePinChange: vi.fn(),
      confirmPinChange: vi.fn(),
      rollbackPinChange: vi.fn(),
      revealPin: vi.fn(),
      bootstrapPins: vi.fn(async () => ({
        initializedRoomIds: ['11111111-1111-4111-8111-111111111111'],
        skippedRoomIds: [],
        initializedCount: 1,
        skippedCount: 0,
        remainingCount: 120,
        completedAt: '2026-09-13T00:00:00.000Z',
        generatedPins: [{
          roomId: '11111111-1111-4111-8111-111111111111',
          credential: '117-0042',
          pinVersion: 1,
          clearAfterSeconds: 30,
          expiresAt: '2026-09-13T00:00:30.000Z'
        }]
      })),
      confirmGeneratedPin: vi.fn(async () => ({
        roomId: '11111111-1111-4111-8111-111111111111',
        pinVersion: 1,
        status: 'verified' as const,
        confirmedAt: '2026-09-13T00:01:00.000Z'
      })),
      getDeveloperCatalog: vi.fn(async () => ({
        generatedAt: '2026-09-20T00:00:00.000Z',
        summary: { total: 121, active: 121, inactive: 0 },
        roomTypes: [], rooms: []
      })),
      previewRoomTypeCapacity: vi.fn(),
      changeRoomTypeCapacity: vi.fn(),
      createDeveloperRoom: vi.fn(),
      previewRoomDeactivation: vi.fn(),
      deactivateDeveloperRoom: vi.fn()
    },
    reservations: {
      list: vi.fn(async () => []),
      listPage: vi.fn(async () => ({
        reservations: [],
        nextCursor: null,
        serverTime: '2026-09-16T08:00:00.000Z'
      })),
      previewBookability: vi.fn(async (_actor, input) => ({
        reservationType: input.reservationType,
        checkInAt: input.checkInAt,
        checkOutAt: input.checkOutAt,
        guestCount: input.guestCount,
        excludeReservationId: input.excludeReservationId ?? null,
        evaluatedAt: '2026-09-16T08:00:00.000Z',
        candidates: [],
        commitAuthority: 'CREATE_OR_CHANGE_REVALIDATES' as const
      })),
      get: vi.fn(),
      create: vi.fn(async (_actor, input) => ({
        id: '41000000-0000-4000-8000-000000000001',
        roomId: input.roomId,
        reservationType: input.reservationType,
        checkInAt: input.checkInAt,
        checkOutAt: input.checkOutAt,
        guestCount: input.guestCount,
        status: 'active' as const,
        preparationObligationId: '42000000-0000-4000-8000-000000000001',
        checkoutObligationId: input.checkOutAt === null
          ? null
          : '43000000-0000-4000-8000-000000000001',
        version: 1,
        roomStateVersion: 2,
        actualCheckInAt: null,
        actualCheckoutAt: null,
        cancelledAt: null,
        createdAt: '2026-08-28T00:00:00.000Z',
        updatedAt: '2026-08-28T00:00:00.000Z'
      })),
      change: vi.fn(),
      previewRoomMove: vi.fn(),
      commitRoomMove: vi.fn(),
      cancel: vi.fn(),
      manualCheckout: vi.fn(),
      processDue: vi.fn(),
      createManualCleaningRequest: vi.fn(),
      cancelManualCleaningRequest: vi.fn()
    },
    cleaningTemplates: {
      listCheckout: vi.fn(async () => ({
        cleaningKind: 'checkout' as const,
        roomTypes: ['standard', 'premium', 'oceanPremium', 'oceanFamily'].map((roomTypeCode) => ({
          roomTypeCode: roomTypeCode as 'standard' | 'premium' | 'oceanPremium' | 'oceanFamily',
          roomTypeName: roomTypeCode,
          cleaningKind: 'checkout' as const,
          configured: false,
          expectedVersion: 0,
          currentPublished: null
        }))
      })),
      publishCheckout: vi.fn(async (_actor, input) => ({
        id: '54000000-0000-4000-8000-000000000001',
        version: 8,
        status: 'published' as const,
        durationMinutes: input.durationMinutes ?? null,
        slots: input.slots,
        publishedAt: '2026-09-14T00:00:00.000Z',
        createdAt: '2026-09-14T00:00:00.000Z'
      }))
    },
    payroll: {
      list: vi.fn(async () => ({ payroll: [], nextCursor: null })),
      get: vi.fn(),
      listEntries: vi.fn(async () => ({
        kind: 'items' as const,
        entries: [],
        nextCursor: null
      })),
      start: vi.fn()
      , correct: vi.fn(), reverse: vi.fn(), carryForward: vi.fn(), carryLateEarning: vi.fn(),
      recordPaymentCheck: vi.fn(), recordPaymentPaid: vi.fn(), reopenPayment: vi.fn()
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

  it('serializes only explicit room-move conflict metadata', async () => {
    const appServices = services();
    const conflict = {
      reloadResources: ['reservation', 'sourceRoom', 'targetRoom', 'roomMovePreview'] as const,
      latestVersions: {
        reservationVersion: 5,
        sourceRoomVersion: 8,
        targetRoomVersion: 13
      }
    };
    appServices.reservations.previewRoomMove = vi.fn(async () => {
      throw new AppError(
        409,
        'TARGET_ROOM_VERSION_CONFLICT',
        '도착 객실 상태가 변경됐습니다. 다시 확인해 주세요.',
        undefined,
        { ...conflict, reloadResources: [...conflict.reloadResources] }
      );
    });
    const app = await buildApp({ env, services: appServices, logger: false });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/reservations/11000000-0000-4000-8000-000000000001/room-change/preview',
      headers: { authorization: 'Bearer access-token' },
      payload: {
        targetRoomId: '12000000-0000-4000-8000-000000000001',
        reasonCode: 'GUEST_REQUEST',
        expectedReservationVersion: 4,
        expectedSourceRoomVersion: 8,
        expectedTargetRoomVersion: 12
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: 'TARGET_ROOM_VERSION_CONFLICT',
        message: '도착 객실 상태가 변경됐습니다. 다시 확인해 주세요.',
        conflict
      },
      requestId: response.json().requestId
    });
    expect(Object.keys(response.json().error).sort()).toEqual(['code', 'conflict', 'message']);
    await app.close();
  });

  it('serializes room-move idempotency reuse with the exact conflict envelope', async () => {
    const appServices = services();
    const conflict = {
      reloadResources: ['reservation', 'sourceRoom', 'targetRoom', 'roomMovePreview'] as const,
      latestVersions: {
        reservationVersion: 5,
        sourceRoomVersion: 8,
        targetRoomVersion: 13
      }
    };
    appServices.reservations.commitRoomMove = vi.fn(async () => {
      throw new AppError(
        409,
        'IDEMPOTENCY_KEY_REUSED',
        '이미 다른 요청에 사용한 Idempotency-Key입니다.',
        undefined,
        { ...conflict, reloadResources: [...conflict.reloadResources] }
      );
    });
    const app = await buildApp({ env, services: appServices, logger: false });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/reservations/11000000-0000-4000-8000-000000000001/room-change',
      headers: {
        authorization: 'Bearer access-token',
        'idempotency-key': 'room-move-reused-0001'
      },
      payload: {
        targetRoomId: '12000000-0000-4000-8000-000000000001',
        expectedReservationVersion: 4,
        expectedSourceRoomVersion: 8,
        expectedTargetRoomVersion: 12,
        evaluatedAt: '2026-09-16T08:00:00Z',
        expiresAt: '2026-09-16T08:05:00Z',
        effectiveAt: '2026-09-17T07:00:00Z',
        impactFingerprint: 'a'.repeat(64),
        reasonCode: 'GUEST_REQUEST'
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: '이미 다른 요청에 사용한 Idempotency-Key입니다.',
        conflict
      },
      requestId: response.json().requestId
    });
    await app.close();
  });

  it('returns Retry-After for durable password-verification limits', async () => {
    const appServices = services();
    appServices.auth.changePassword = vi.fn(async () => {
      throw new AppError(
        429,
        'PASSWORD_VERIFICATION_RATE_LIMITED',
        '비밀번호 확인 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.',
        { 'Retry-After': '37' }
      );
    });
    const app = await buildApp({ env, services: appServices, logger: false });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/password',
      headers: {
        authorization: 'Bearer access-token',
        'idempotency-key': 'password-retry-after-0001'
      },
      payload: { currentPassword: '1234', newPassword: '654321' }
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('37');
    expect(response.json().error.code).toBe('PASSWORD_VERIFICATION_RATE_LIMITED');
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
    expect(response.json().rooms[0]).toMatchObject({
      roomNumber: '117',
      evaluatedAt: '2026-09-16T08:00:00.000Z',
      reservationPhase: 'upcoming',
      serverTime: '2026-09-16T08:00:00.000Z',
      occupancyStatus: 'VACANT',
      reservationLifecycle: 'FUTURE',
      readinessStatus: 'READY',
      primaryDisplayStatus: 'READY',
      occupied: false,
      cleaningRequired: false,
      allocationReady: true
    });
    await app.close();
  });

  it('returns actionable operation blocks with the current room version', async () => {
    const appServices = services();
    const app = await buildApp({ env, services: appServices, logger: false });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/rooms/11111111-1111-4111-8111-111111111111/operation-blocks?status=actionable',
      headers: { authorization: 'Bearer access-token' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({
      roomId: '11111111-1111-4111-8111-111111111111',
      roomStateVersion: 4,
      items: [{
        id: '50000000-0000-4000-8000-000000000001',
        status: 'active'
      }]
    });
    expect(appServices.rooms.listOperationBlocks).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'admin' }),
      '11111111-1111-4111-8111-111111111111'
    );
    await app.close();
  });

  it('records an admin occupancy correction with CAS, effective time, and idempotency', async () => {
    const appServices = services();
    const app = await buildApp({ env, services: appServices, logger: false });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/rooms/11111111-1111-4111-8111-111111111111/occupancy-corrections',
      headers: {
        authorization: 'Bearer access-token',
        'idempotency-key': 'occupancy-correction-0001'
      },
      payload: {
        reservationId: '80000000-0000-4000-8000-000000000001',
        occupied: false,
        effectiveAt: '2026-09-20T00:00:00.000Z',
        expectedRoomVersion: 6,
        reasonCode: 'FRONT_DESK_VERIFIED'
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().correction).toMatchObject({
      correctionId: '71000000-0000-4000-8000-000000000001',
      occupied: false,
      roomStateVersion: 7
    });
    expect(appServices.rooms.correctOccupancy).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'admin' }),
      expect.objectContaining({
        roomId: '11111111-1111-4111-8111-111111111111',
        reservationId: '80000000-0000-4000-8000-000000000001',
        idempotencyKey: 'occupancy-correction-0001'
      })
    );
    await app.close();
  });

  it.each(['maid', 'developer'] as const)('denies occupancy correction to %s', async (role) => {
    const appServices = services();
    appServices.auth.authenticate = vi.fn(async (accessToken: string) => ({
      authUserId: `auth-${role}`, profileId: `${role}-1`, displayName: role,
      role, mustChangePassword: false, accessToken
    }));
    const app = await buildApp({ env, services: appServices, logger: false });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/rooms/11111111-1111-4111-8111-111111111111/occupancy-corrections',
      headers: {
        authorization: 'Bearer access-token',
        'idempotency-key': 'occupancy-correction-denied-0001'
      },
      payload: {
        reservationId: '80000000-0000-4000-8000-000000000001',
        occupied: false,
        effectiveAt: '2026-09-20T00:00:00.000Z',
        expectedRoomVersion: 6,
        reasonCode: 'FRONT_DESK_VERIFIED'
      }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('ADMIN_REQUIRED');
    expect(appServices.rooms.correctOccupancy).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    'BLOCKED',
    'OCCUPIED',
    'ARRIVAL_PENDING',
    'RESERVATION_PRESENT',
    'CLEANING_REQUIRED',
    'READY',
    null
  ] as const)('records the %s display classification override without changing source axes', async (targetStatus) => {
    const appServices = services();
    const app = await buildApp({ env, services: appServices, logger: false });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/rooms/11111111-1111-4111-8111-111111111111/display-status-overrides',
      headers: {
        authorization: 'Bearer access-token',
        'idempotency-key': `display-status-${targetStatus ?? 'clear'}`
      },
      payload: {
        targetStatus,
        expectedRoomVersion: 7,
        reasonCode: 'FRONT_DESK_VERIFIED'
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().statusOverride).toMatchObject({
      overrideId: '72000000-0000-4000-8000-000000000001',
      targetStatus,
      roomStateVersion: 8
    });
    expect(appServices.rooms.overrideDisplayStatus).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'admin' }),
      expect.objectContaining({
        roomId: '11111111-1111-4111-8111-111111111111',
        targetStatus,
        expectedRoomVersion: 7
      })
    );
    await app.close();
  });

  it('returns open issues and rejects unsupported room-operation filters', async () => {
    const appServices = services();
    const app = await buildApp({ env, services: appServices, logger: false });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/rooms/11111111-1111-4111-8111-111111111111/issues?status=open',
      headers: { authorization: 'Bearer access-token' }
    });
    const invalid = await app.inject({
      method: 'GET',
      url: '/v1/rooms/11111111-1111-4111-8111-111111111111/operation-blocks?status=active',
      headers: { authorization: 'Bearer access-token' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({
      roomId: '11111111-1111-4111-8111-111111111111',
      roomStateVersion: 5,
      items: [{
        id: '60000000-0000-4000-8000-000000000001',
        status: 'open'
      }]
    });
    expect(invalid.statusCode).toBe(400);
    expect(appServices.rooms.listOperationBlocks).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns the bounded room event timeline and rejects an invalid limit', async () => {
    const appServices = services();
    const app = await buildApp({ env, services: appServices, logger: false });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/rooms/11111111-1111-4111-8111-111111111111/events?limit=12',
      headers: { authorization: 'Bearer access-token' }
    });
    const invalidResponses = await Promise.all(
      ['51', '01', '1.0', '%2B1'].map((limit) => app.inject({
        method: 'GET',
        url: `/v1/rooms/11111111-1111-4111-8111-111111111111/events?limit=${limit}`,
        headers: { authorization: 'Bearer access-token' }
      }))
    );

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({
      roomId: '11111111-1111-4111-8111-111111111111',
      roomStateVersion: 6,
      items: [{
        eventKey: 'occupancy:70000000-0000-4000-8000-000000000001',
        source: 'occupancy', category: 'occupancy', eventType: 'scheduled_check_in',
        actorDisplayName: null,
        entityId: '80000000-0000-4000-8000-000000000001'
      }]
    });
    expect(appServices.rooms.listEvents).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'admin' }),
      '11111111-1111-4111-8111-111111111111',
      12
    );
    expect(invalidResponses.map((item) => item.statusCode)).toEqual([400, 400, 400, 400]);
    expect(appServices.rooms.listEvents).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('does not expose room operation reads to a maid', async () => {
    const appServices = services();
    appServices.auth.authenticate = vi.fn(async (accessToken: string) => ({
      authUserId: 'auth-maid-1', profileId: 'maid-1', displayName: '메이드',
      role: 'maid' as const, mustChangePassword: false, accessToken
    }));
    const app = await buildApp({ env, services: appServices, logger: false });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/rooms/11111111-1111-4111-8111-111111111111/issues?status=open',
      headers: { authorization: 'Bearer access-token' }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('ADMIN_REQUIRED');
    expect(appServices.rooms.listIssues).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns the four room types with room counts for an administrator', async () => {
    const app = await buildApp({ env, services: services(), logger: false });
    const response = await app.inject({
      method: 'GET', url: '/v1/room-types',
      headers: { authorization: 'Bearer access-token' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json().items).toHaveLength(4);
    expect(response.json().items).toContainEqual(expect.objectContaining({
      code: 'standard', displayName: '스탠다드 더블 로프트',
      baseCleaningFee: 16000, baseOccupancy: 2, maxOccupancy: 2,
      active: true, version: 1, roomCount: 22
    }));
    await app.close();
  });

  it('does not expose room types to a maid', async () => {
    const appServices = services();
    appServices.auth.authenticate = vi.fn(async (accessToken: string) => ({
      authUserId: 'auth-maid-1', profileId: 'maid-1', displayName: '메이드',
      role: 'maid' as const, mustChangePassword: false, accessToken
    }));
    const app = await buildApp({ env, services: appServices, logger: false });
    const response = await app.inject({
      method: 'GET', url: '/v1/room-types',
      headers: { authorization: 'Bearer access-token' }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('ADMIN_REQUIRED');
    expect(appServices.rooms.listTypes).not.toHaveBeenCalled();
    await app.close();
  });

  it('exposes only the dedicated room catalog commands to a developer', async () => {
    const appServices = services();
    appServices.auth.authenticate = vi.fn(async (accessToken: string) => ({
      authUserId: 'auth-developer-1', profileId: 'developer-1', displayName: '개발자',
      role: 'developer' as const, mustChangePassword: false, accessToken
    }));
    appServices.rooms.previewRoomTypeCapacity = vi.fn(async (_actor, input) => ({
      roomTypeId: input.roomTypeId,
      current: { baseOccupancy: 2, maxOccupancy: 2, version: 1 },
      proposed: { baseOccupancy: input.baseOccupancy, maxOccupancy: input.maxOccupancy },
      roomCount: 22,
      activeReservationCount: 0,
      exceedingActiveReservationCount: 0,
      reasonCodes: [],
      impactFingerprint: 'a'.repeat(64),
      evaluatedAt: '2026-09-21T00:00:00.000Z',
      expiresAt: '2026-09-21T00:05:00.000Z'
    }));
    const app = await buildApp({ env, services: appServices, logger: false });
    const headers = { authorization: 'Bearer access-token' };
    const catalog = await app.inject({ method: 'GET', url: '/v1/developer/room-catalog', headers });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.headers['cache-control']).toBe('no-store');
    expect(catalog.json().catalog.summary).toEqual({ total: 121, active: 121, inactive: 0 });

    const preview = await app.inject({
      method: 'POST',
      url: '/v1/developer/room-types/10000000-0000-4000-8000-000000000004/capacity/preview',
      headers,
      payload: { baseOccupancy: 2, maxOccupancy: 3, expectedVersion: 1 }
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().preview.maxOccupancy).toBeUndefined();
    expect(appServices.rooms.previewRoomTypeCapacity).toHaveBeenCalledOnce();

    const operational = await app.inject({ method: 'GET', url: '/v1/rooms', headers });
    expect(operational.statusCode).toBe(403);
    expect(operational.json().error.code).toBe('ADMIN_REQUIRED');
    await app.close();
  });

  it('rejects admin access and invalid capacity values on developer catalog routes', async () => {
    const appServices = services();
    const app = await buildApp({ env, services: appServices, logger: false });
    const headers = { authorization: 'Bearer access-token' };
    const denied = await app.inject({ method: 'GET', url: '/v1/developer/room-catalog', headers });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('DEVELOPER_REQUIRED');
    expect(appServices.rooms.getDeveloperCatalog).not.toHaveBeenCalled();
    await app.close();

    const developerServices = services();
    developerServices.auth.authenticate = vi.fn(async (accessToken: string) => ({
      authUserId: 'auth-developer-1', profileId: 'developer-1', displayName: '개발자',
      role: 'developer' as const, mustChangePassword: false, accessToken
    }));
    const developerApp = await buildApp({ env, services: developerServices, logger: false });
    for (const payload of [
      { baseOccupancy: 0, maxOccupancy: 2, expectedVersion: 1 },
      { baseOccupancy: 2, maxOccupancy: 0, expectedVersion: 1 },
      { baseOccupancy: 2.5, maxOccupancy: 3, expectedVersion: 1 },
      { baseOccupancy: 4, maxOccupancy: 3, expectedVersion: 1 }
    ]) {
      const response = await developerApp.inject({
        method: 'POST',
        url: '/v1/developer/room-types/10000000-0000-4000-8000-000000000004/capacity/preview',
        headers,
        payload
      });
      expect(response.statusCode).toBe(400);
    }
    expect(developerServices.rooms.previewRoomTypeCapacity).not.toHaveBeenCalled();
    await developerApp.close();
  });

  it('accepts a version-zero PIN edit through the no-store prepare route', async () => {
    const appServices = services();
    appServices.rooms.preparePinChange = vi.fn(async () => ({
      leaseId: '40000000-0000-4000-8000-000000000001',
      roomId: '11111111-1111-4111-8111-111111111111',
      currentPinVersion: 0,
      proposedPinVersion: 1,
      status: 'prepared',
      expiresAt: '2026-09-21T00:05:00.000Z'
    }));
    const app = await buildApp({ env, services: appServices, logger: false });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/rooms/11111111-1111-4111-8111-111111111111/pin-changes/prepare',
      headers: {
        authorization: 'Bearer access-token',
        'idempotency-key': 'room-pin-initial-test-0001'
      },
      payload: {
        pinDigits: '0012',
        expectedPinVersion: 0,
        reasonCode: 'ADMIN_PHYSICAL_CHANGE'
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json().change).toMatchObject({
      currentPinVersion: 0,
      proposedPinVersion: 1,
      status: 'prepared'
    });
    expect(JSON.stringify(response.json())).not.toContain('0012');
    expect(appServices.rooms.preparePinChange).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'admin' }),
      {
        roomId: '11111111-1111-4111-8111-111111111111',
        pinDigits: '0012',
        expectedPinVersion: 0,
        reasonCode: 'ADMIN_PHYSICAL_CHANGE',
        idempotencyKey: 'room-pin-initial-test-0001'
      }
    );
    await app.close();
  });

  it('returns generated PIN material only in a no-store bootstrap response', async () => {
    const appServices = services();
    const app = await buildApp({ env, services: appServices, logger: false });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/rooms/pins/bootstrap',
      headers: {
        authorization: 'Bearer access-token',
        'idempotency-key': 'room-pin-bootstrap-test-0001'
      },
      payload: { limit: 1 }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      bootstrap: {
        initializedRoomIds: ['11111111-1111-4111-8111-111111111111'],
        skippedRoomIds: [],
        initializedCount: 1,
        skippedCount: 0,
        remainingCount: 120,
        completedAt: '2026-09-13T00:00:00.000Z',
        generatedPins: [{
          roomId: '11111111-1111-4111-8111-111111111111',
          credential: '117-0042',
          pinVersion: 1,
          clearAfterSeconds: 30,
          expiresAt: '2026-09-13T00:00:30.000Z'
        }]
      }
    });
    expect(response.json().bootstrap.generatedPins[0].credential).toBe('117-0042');
    expect(JSON.stringify(response.json())).not.toMatch(/ciphertext|nonce|authTag/i);
    expect(appServices.rooms.bootstrapPins).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'admin' }),
      { limit: 1, idempotencyKey: 'room-pin-bootstrap-test-0001' }
    );
    await app.close();
  });

  it('confirms a generated PIN only through the admin no-store route', async () => {
    const appServices = services();
    const app = await buildApp({ env, services: appServices, logger: false });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/rooms/11111111-1111-4111-8111-111111111111/pin/generated/confirm',
      headers: {
        authorization: 'Bearer access-token',
        'idempotency-key': 'generated-pin-confirm-test-0001'
      },
      payload: { expectedPinVersion: 1 }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json().confirmation).toMatchObject({ pinVersion: 1, status: 'verified' });
    expect(appServices.rooms.confirmGeneratedPin).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'admin' }),
      {
        roomId: '11111111-1111-4111-8111-111111111111',
        expectedPinVersion: 1,
        idempotencyKey: 'generated-pin-confirm-test-0001'
      }
    );
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
        reservationType: 'standard',
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

  it('creates an open-ended long-stay and rejects a standard reservation without checkout', async () => {
    const appServices = services();
    const app = await buildApp({ env, services: appServices, logger: false });
    const payload = {
      roomId: '51000000-0000-4000-8000-000000000001',
      reservationType: 'long_stay',
      checkInAt: '2026-09-01T16:00:00+09:00',
      checkOutAt: null,
      guestCount: 1,
      expectedRoomVersion: 1
    };
    const response = await app.inject({
      method: 'POST',
      url: '/v1/reservations',
      headers: {
        authorization: 'Bearer access-token',
        'idempotency-key': 'reservation-open-ended-create-0001'
      },
      payload
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().reservation).toMatchObject({
      reservationType: 'long_stay',
      checkOutAt: null,
      checkoutObligationId: null
    });
    expect(appServices.reservations.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reservationType: 'long_stay', checkOutAt: null })
    );

    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/reservations',
      headers: {
        authorization: 'Bearer access-token',
        'idempotency-key': 'reservation-standard-without-end-0001'
      },
      payload: { ...payload, reservationType: 'standard' }
    });
    expect(invalid.statusCode).toBe(400);
    expect(appServices.reservations.create).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('keeps the legacy reservation list envelope and adds bounded range mode', async () => {
    const appServices = services();
    const app = await buildApp({ env, services: appServices, logger: false });
    const legacy = await app.inject({
      method: 'GET',
      url: '/v1/reservations',
      headers: { authorization: 'Bearer access-token' }
    });
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json()).toEqual({ reservations: [] });
    expect(appServices.reservations.list).toHaveBeenCalledTimes(1);
    expect(appServices.reservations.listPage).not.toHaveBeenCalled();

    const ranged = await app.inject({
      method: 'GET',
      url: '/v1/reservations?from=2026-09-01T00%3A00%3A00Z&to=2026-09-30T00%3A00%3A00Z',
      headers: { authorization: 'Bearer access-token' }
    });
    expect(ranged.statusCode).toBe(200);
    expect(ranged.json()).toEqual({
      reservations: [],
      nextCursor: null,
      serverTime: '2026-09-16T08:00:00.000Z'
    });
    expect(appServices.reservations.listPage).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'admin' }),
      {
        from: '2026-09-01T00:00:00Z',
        to: '2026-09-30T00:00:00Z'
      }
    );
    await app.close();
  });

  it('dispatches the static reservation bookability preview before detail routes', async () => {
    const appServices = services();
    const app = await buildApp({ env, services: appServices, logger: false });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/reservations/bookability/preview',
      headers: { authorization: 'Bearer access-token' },
      payload: {
        reservationType: 'standard',
        checkInAt: '2026-10-01T16:00:00+09:00',
        checkOutAt: '2026-10-02T11:00:00+09:00',
        guestCount: 2,
        roomTypeIds: [],
        excludeReservationId: null
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().preview).toMatchObject({
      candidates: [],
      commitAuthority: 'CREATE_OR_CHANGE_REVALIDATES'
    });
    expect(appServices.reservations.previewBookability).toHaveBeenCalledTimes(1);
    expect(appServices.reservations.previewBookability).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'admin' }),
      expect.objectContaining({
        reservationType: 'standard', roomTypeIds: [], excludeReservationId: null
      })
    );
    expect(appServices.reservations.get).not.toHaveBeenCalled();
    const openEnded = await app.inject({
      method: 'POST',
      url: '/v1/reservations/bookability/preview',
      headers: { authorization: 'Bearer access-token' },
      payload: {
        reservationType: 'long_stay',
        checkInAt: '2026-10-01T16:00:00+09:00',
        checkOutAt: null,
        guestCount: 2
      }
    });
    expect(openEnded.statusCode).toBe(200);
    expect(openEnded.json().preview).toMatchObject({
      reservationType: 'long_stay',
      checkOutAt: null
    });
    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/reservations/bookability/preview',
      headers: { authorization: 'Bearer access-token' },
      payload: {
        reservationType: 'standard',
        checkInAt: '2026-10-01T16:00:00+09:00',
        checkOutAt: null,
        guestCount: 2
      }
    });
    expect(invalid.statusCode).toBe(400);
    expect(appServices.reservations.previewBookability).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it('previews and commits a strict before-check-in room move', async () => {
    const appServices = services();
    const reservationId = '41000000-0000-4000-8000-000000000001';
    const targetRoomId = '51000000-0000-4000-8000-000000000002';
    const evaluatedAt = '2026-09-16T08:00:00.000Z';
    const expiresAt = '2026-09-16T08:05:00.000Z';
    const impactFingerprint = 'a'.repeat(64);
    const preview = {
      mode: 'BEFORE_CHECKIN' as const,
      reservationType: 'standard' as const,
      eligible: true,
      rejectionReasonCodes: [],
      blockingReasonCodes: [],
      warnings: [],
      targetBlockReasonCodes: [],
      sourceOutcome: { occupancyStatus: 'VACANT' as const, readinessStatus: 'READY' as const, stateVersion: 1 },
      targetOutcome: { occupancyStatus: 'VACANT' as const, readinessStatus: 'READY' as const, stateVersion: 1 },
      impactFingerprint,
      evaluatedAt,
      expiresAt,
      effectiveAt: '2026-09-17T07:00:00.000Z',
      reservationId,
      reservationVersion: 1,
      stayId: '45000000-0000-4000-8000-000000000001',
      stayVersion: 1,
      sourceSegmentId: '46000000-0000-4000-8000-000000000001',
      sourceSegmentVersion: 1,
      sourceRoomId: '51000000-0000-4000-8000-000000000001',
      sourceRoomVersion: 1,
      targetRoomId,
      targetRoomVersion: 1,
      checkInAt: '2026-09-17T07:00:00.000Z',
      checkOutAt: '2026-09-18T02:00:00.000Z',
      guestCount: 2,
      preparationObligationId: '42000000-0000-4000-8000-000000000001',
      checkoutObligationId: '43000000-0000-4000-8000-000000000001',
      checkoutObligationVersion: 1,
      plannedCheckoutTargetId: '44000000-0000-4000-8000-000000000001',
      plannedCheckoutTargetVersion: 1
    };
    appServices.reservations.previewRoomMove = vi.fn(async () => preview);
    appServices.reservations.commitRoomMove = vi.fn(async () => ({
      reservation: {
        id: reservationId,
        roomId: targetRoomId,
        reservationType: 'standard' as const,
        checkInAt: preview.checkInAt,
        checkOutAt: preview.checkOutAt,
        guestCount: 2,
        status: 'active' as const,
        preparationObligationId: preview.preparationObligationId,
        checkoutObligationId: preview.checkoutObligationId,
        version: 2,
        actualCheckInAt: null,
        actualCheckoutAt: null,
        cancelledAt: null,
        createdAt: evaluatedAt,
        updatedAt: evaluatedAt
      },
      mode: 'BEFORE_CHECKIN' as const,
      evaluatedAt,
      expiresAt,
      effectiveAt: preview.effectiveAt,
      movedAt: '2026-09-16T08:01:00.000Z',
      sourceRoomId: preview.sourceRoomId,
      targetRoomId,
      sourceRoomVersion: 2,
      targetRoomVersion: 2,
      plannedCheckoutTargetId: preview.plannedCheckoutTargetId,
      plannedCheckoutTargetVersion: 2,
      sourceOutcome: { ...preview.sourceOutcome, stateVersion: 2 },
      targetOutcome: { ...preview.targetOutcome, stateVersion: 2 }
    }));
    const app = await buildApp({ env, services: appServices, logger: false });
    const previewResponse = await app.inject({
      method: 'POST',
      url: `/v1/reservations/${reservationId}/room-change/preview`,
      headers: { authorization: 'Bearer access-token' },
      payload: {
        targetRoomId,
        reasonCode: 'GUEST_REQUEST',
        expectedReservationVersion: 1,
        expectedSourceRoomVersion: 1,
        expectedTargetRoomVersion: 1
      }
    });
    const commitResponse = await app.inject({
      method: 'POST',
      url: `/v1/reservations/${reservationId}/room-change`,
      headers: {
        authorization: 'Bearer access-token',
        'idempotency-key': 'reservation-room-move-0001'
      },
      payload: {
        targetRoomId,
        expectedReservationVersion: 1,
        expectedSourceRoomVersion: 1,
        expectedTargetRoomVersion: 1,
        evaluatedAt,
        expiresAt,
        effectiveAt: preview.effectiveAt,
        impactFingerprint,
        reasonCode: 'GUEST_REQUEST'
      }
    });
    const legacyCommitResponse = await app.inject({
      method: 'POST',
      url: `/v1/reservations/${reservationId}/room-change/commit`,
      headers: {
        authorization: 'Bearer access-token',
        'idempotency-key': 'reservation-room-move-legacy'
      },
      payload: {
        targetRoomId,
        expectedReservationVersion: 1,
        expectedSourceRoomVersion: 1,
        expectedTargetRoomVersion: 1,
        evaluatedAt,
        expiresAt,
        effectiveAt: preview.effectiveAt,
        impactFingerprint,
        reasonCode: 'GUEST_REQUEST'
      }
    });

    expect(previewResponse.statusCode).toBe(200);
    expect(previewResponse.json().preview).toEqual(preview);
    expect(commitResponse.statusCode).toBe(200);
    expect(legacyCommitResponse.statusCode).toBe(404);
    expect(commitResponse.json().result).toMatchObject({
      evaluatedAt,
      expiresAt,
      effectiveAt: preview.effectiveAt,
      targetRoomId
    });
    expect(appServices.reservations.commitRoomMove).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'admin' }),
      expect.objectContaining({
        reservationId,
        reasonCode: 'GUEST_REQUEST',
        idempotencyKey: 'reservation-room-move-0001'
      })
    );
    for (const [caseName, historicalSegmentId] of [
      ['same-instant checked-out', '46000000-0000-4000-8000-000000000001'],
      ['cancelled retired', '46000000-0000-4000-8000-000000000009']
    ] as const) {
      appServices.reservations.previewRoomMove = vi.fn(async () => ({
        ...preview,
        mode: 'DURING_STAY' as const,
        sourceSegmentId: historicalSegmentId,
        eligible: false,
        rejectionReasonCodes: ['RESERVATION_NOT_ACTIVE' as const]
      }));
      const inactivePreviewResponse = await app.inject({
        method: 'POST',
        url: `/v1/reservations/${reservationId}/room-change/preview`,
        headers: { authorization: 'Bearer access-token' },
        payload: {
          targetRoomId,
          reasonCode: 'GUEST_REQUEST',
          expectedReservationVersion: 1,
          expectedSourceRoomVersion: 1,
          expectedTargetRoomVersion: 1
        }
      });
      expect(inactivePreviewResponse.statusCode, caseName).toBe(200);
      expect(inactivePreviewResponse.json().preview, caseName).toMatchObject({
        eligible: false,
        sourceSegmentId: historicalSegmentId,
        rejectionReasonCodes: ['RESERVATION_NOT_ACTIVE']
      });
    }
    await app.close();
  });

  it('passes through the during-stay room-move contract on the existing routes', async () => {
    const appServices = services();
    const reservationId = '41000000-0000-4000-8000-000000000001';
    const sourceRoomId = '51000000-0000-4000-8000-000000000001';
    const targetRoomId = '51000000-0000-4000-8000-000000000002';
    const effectiveAt = '2026-09-17T09:20:00.000Z';
    const evaluatedAt = '2026-09-17T09:19:00.000Z';
    const expiresAt = '2026-09-17T09:24:00.000Z';
    const sourceSegmentId = '46000000-0000-4000-8000-000000000001';
    const targetSegmentId = '46000000-0000-4000-8000-000000000002';
    const stayId = '45000000-0000-4000-8000-000000000001';
    const sourceCleaningTargetId = '44000000-0000-4000-8000-000000000002';
    appServices.reservations.previewRoomMove = vi.fn(async () => ({
      mode: 'DURING_STAY' as const,
      reservationType: 'standard' as const,
      eligible: true,
      rejectionReasonCodes: [],
      blockingReasonCodes: [],
      warnings: [],
      targetBlockReasonCodes: [],
      sourceOutcome: { occupancyStatus: 'OCCUPIED' as const, readinessStatus: 'READY' as const, stateVersion: 3 },
      targetOutcome: { occupancyStatus: 'VACANT' as const, readinessStatus: 'READY' as const, stateVersion: 4 },
      impactFingerprint: 'b'.repeat(64),
      evaluatedAt,
      expiresAt,
      effectiveAt,
      reservationId,
      reservationVersion: 2,
      stayId,
      stayVersion: 2,
      sourceSegmentId,
      sourceSegmentVersion: 1,
      sourceRoomId,
      sourceRoomVersion: 3,
      targetRoomId,
      targetRoomVersion: 4,
      checkInAt: '2026-09-16T07:00:00.000Z',
      checkOutAt: '2026-09-18T02:00:00.000Z',
      guestCount: 2,
      preparationObligationId: '42000000-0000-4000-8000-000000000001',
      checkoutObligationId: '43000000-0000-4000-8000-000000000001',
      checkoutObligationVersion: 1,
      plannedCheckoutTargetId: '44000000-0000-4000-8000-000000000001',
      plannedCheckoutTargetVersion: 1
    }));
    appServices.reservations.commitRoomMove = vi.fn(async () => ({
      reservation: {
        id: reservationId, roomId: sourceRoomId,
        reservationType: 'standard' as const,
        checkInAt: '2026-09-16T07:00:00.000Z', checkOutAt: '2026-09-18T02:00:00.000Z',
        guestCount: 2, status: 'active' as const,
        preparationObligationId: '42000000-0000-4000-8000-000000000001',
        checkoutObligationId: '43000000-0000-4000-8000-000000000001', version: 3,
        actualCheckInAt: '2026-09-16T07:00:00.000Z', actualCheckoutAt: null,
        cancelledAt: null, createdAt: evaluatedAt, updatedAt: effectiveAt
      },
      mode: 'DURING_STAY' as const,
      evaluatedAt, expiresAt, effectiveAt, movedAt: effectiveAt,
      sourceRoomId, targetRoomId, sourceRoomVersion: 4, targetRoomVersion: 5,
      plannedCheckoutTargetId: '44000000-0000-4000-8000-000000000001',
      plannedCheckoutTargetVersion: 2,
      sourceOutcome: { occupancyStatus: 'VACANT' as const, readinessStatus: 'CLEANING_REQUIRED' as const, stateVersion: 4 },
      targetOutcome: { occupancyStatus: 'OCCUPIED' as const, readinessStatus: 'READY' as const, stateVersion: 5 },
      stay: { id: stayId, version: 3, currentRoomId: sourceRoomId },
      segments: [
        { id: sourceSegmentId, roomId: sourceRoomId, startsAt: '2026-09-16T07:00:00.000Z', endsAt: effectiveAt },
        { id: targetSegmentId, roomId: targetRoomId, startsAt: effectiveAt, endsAt: '2026-09-18T02:00:00.000Z' }
      ],
      sourceCleaningTargetId,
      pinAccessEndsAt: effectiveAt
    }));
    const app = await buildApp({ env, services: appServices, logger: false });

    const previewResponse = await app.inject({
      method: 'POST',
      url: `/v1/reservations/${reservationId}/room-change/preview`,
      headers: { authorization: 'Bearer access-token' },
      payload: {
        targetRoomId, effectiveAt, reasonCode: 'GUEST_REQUEST',
        expectedReservationVersion: 2, expectedSourceRoomVersion: 3,
        expectedTargetRoomVersion: 4
      }
    });
    const commitResponse = await app.inject({
      method: 'POST',
      url: `/v1/reservations/${reservationId}/room-change`,
      headers: { authorization: 'Bearer access-token', 'idempotency-key': 'during-stay-move-0001' },
      payload: {
        targetRoomId, effectiveAt, evaluatedAt, expiresAt,
        impactFingerprint: 'b'.repeat(64), reasonCode: 'GUEST_REQUEST',
        expectedReservationVersion: 2, expectedSourceRoomVersion: 3,
        expectedTargetRoomVersion: 4
      }
    });

    expect(previewResponse.statusCode).toBe(200);
    expect(previewResponse.json().preview).toMatchObject({ mode: 'DURING_STAY', stayId, sourceSegmentId });
    expect(commitResponse.statusCode).toBe(200);
    expect(commitResponse.json().result).toMatchObject({
      mode: 'DURING_STAY', stay: { id: stayId, currentRoomId: sourceRoomId },
      sourceCleaningTargetId, pinAccessEndsAt: effectiveAt
    });
    expect(appServices.reservations.previewRoomMove).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'admin' }),
      expect.objectContaining({ reservationId, targetRoomId, effectiveAt })
    );
    await app.close();
  });

  it('lists and publishes strict checkout templates for active business admins', async () => {
    const appServices = services();
    const app = await buildApp({ env, services: appServices, logger: false });
    const listed = await app.inject({
      method: 'GET',
      url: '/v1/cleaning-templates?cleaningKind=checkout',
      headers: { authorization: 'Bearer access-token' }
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.headers['cache-control']).toBe('no-store');
    expect(listed.json().templates.roomTypes).toHaveLength(4);

    const slots = Array.from({ length: 9 }, (_, displayOrder) => ({
      slotKey: displayOrder === 0 ? 'tv-on' : displayOrder === 1 ? 'entry-storage' :
        displayOrder === 8 ? 'extra-proof' : `slot-${displayOrder}`,
      displayOrder,
      required: displayOrder < 8,
      label: `사진 ${displayOrder + 1}`,
      maxPhotos: displayOrder === 8 ? 10 : 1
    }));
    const published = await app.inject({
      method: 'POST',
      url: '/v1/cleaning-templates',
      headers: {
        authorization: 'Bearer access-token',
        'idempotency-key': 'cleaning-template-publish-0001'
      },
      payload: {
        roomTypeCode: 'standard', cleaningKind: 'checkout', expectedVersion: 0, slots
      }
    });
    expect(published.statusCode).toBe(201);
    expect(published.headers['cache-control']).toBe('no-store');
    expect(published.json().template).toMatchObject({ version: 8, status: 'published' });
    expect(appServices.cleaningTemplates?.publishCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'admin' }),
      expect.objectContaining({
        roomTypeCode: 'standard',
        durationMinutes: null,
        idempotencyKey: 'cleaning-template-publish-0001'
      })
    );

    const legacyReplaySlots = Array.from({ length: 10 }, (_, displayOrder) => ({
      slotKey: displayOrder === 0 ? 'tv-on' : `legacy-${displayOrder}`,
      displayOrder,
      required: displayOrder < 9,
      label: `과거 사진 ${displayOrder + 1}`
    }));
    const legacyReplay = await app.inject({
      method: 'POST', url: '/v1/cleaning-templates',
      headers: { authorization: 'Bearer access-token', 'idempotency-key': 'template-v7-replay' },
      payload: {
        roomTypeCode: 'standard', cleaningKind: 'checkout', expectedVersion: 0,
        durationMinutes: 60, slots: legacyReplaySlots
      }
    });
    expect(legacyReplay.statusCode).toBe(201);

    const firstSlot = slots[0];
    if (!firstSlot) throw new Error('slot fixture is empty');
    const invalidRows: typeof slots = [
      { ...firstSlot, displayOrder: 1 },
      { ...firstSlot, slotKey: 'TV_ON' },
      { ...firstSlot, label: '' }
    ];
    for (const invalid of invalidRows) {
      const badSlots = [...slots]; badSlots[0] = invalid;
      const response = await app.inject({
        method: 'POST', url: '/v1/cleaning-templates',
        headers: { authorization: 'Bearer access-token', 'idempotency-key': `template-invalid-${invalid.slotKey}` },
        payload: { roomTypeCode: 'standard', cleaningKind: 'checkout', expectedVersion: 0, durationMinutes: 60, slots: badSlots }
      });
      expect(response.statusCode).toBe(400);
    }
    for (const [name, invalidSlots] of [
      ['entry-number', slots.map((slot, index) => index === 2 ? { ...slot, slotKey: 'entry-number' } : slot)],
      ['former-v7-count', [...slots, { ...firstSlot, slotKey: 'slot-9', displayOrder: 9 }]],
      ['bad-extra-limit', slots.map((slot) => slot.slotKey === 'extra-proof' ? { ...slot, maxPhotos: 9 } : slot)]
    ] as const) {
      const response = await app.inject({
        method: 'POST', url: '/v1/cleaning-templates',
        headers: { authorization: 'Bearer access-token', 'idempotency-key': `template-invalid-${name}` },
        payload: { roomTypeCode: 'standard', cleaningKind: 'checkout', expectedVersion: 0, slots: invalidSlots }
      });
      expect(response.statusCode).toBe(400);
    }
    expect(appServices.cleaningTemplates?.publishCheckout).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it('lists payroll projections for an authenticated reader without side effects', async () => {
    const appServices = services();
    appServices.payroll.list = vi.fn(async () => ({ payroll: [], nextCursor: null }));
    const app = await buildApp({ env, services: appServices, logger: false });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/payroll?weekStart=2026-08-24',
      headers: { authorization: 'Bearer access-token' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ payroll: [], nextCursor: null });
    expect(appServices.payroll.list).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'admin' }),
      expect.objectContaining({ weekStart: '2026-08-24' })
    );

    for (const url of [
      '/v1/payroll/?weekStart=2026-08-24',
      '/v1/payroll/extra?weekStart=2026-08-24'
    ]) {
      const alias = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: 'Bearer access-token' }
      });
      expect(alias.statusCode).toBe(404);
    }
    await app.close();
  });

  it('keeps Fastify payroll query parsing identical to the strict Edge contract', async () => {
    const appServices = services();
    const app = await buildApp({ env, services: appServices, logger: false });
    for (const url of [
      '/v1/payroll?weekStart=2026-08-24&limit=1e1',
      '/v1/payroll?weekStart=2026-08-24&limit=1.0',
      '/v1/payroll?weekStart=2026-08-24&limit=%2010%20',
      '/v1/payroll?weekStart=2026-08-24&limit=10&limit=9',
      '/v1/payroll?weekStart=2026-08-24&unknown=1',
      '/v1/payroll/entries?weekStart=2026-08-24&maidProfileId=62000000-0000-4000-8000-000000000001&kind=items&limit=25&kind=lateEarnings'
    ]) {
      const response = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: 'Bearer access-token' }
      });
      expect(response.statusCode, url).toBe(400);
      expect(response.json().error.code, url).toBe('VALIDATION_ERROR');
    }
    expect(appServices.payroll.list).not.toHaveBeenCalled();
    expect(appServices.payroll.listEntries).not.toHaveBeenCalled();
    await app.close();
  });

  it('resolves one materialized payroll cycle by stable ID without side effects', async () => {
    const appServices = services();
    const cycleId = '76000000-0000-4000-8000-000000000001';
    appServices.payroll.get = vi.fn(async () => ({ cycleId, status: 'check' } as never));
    const app = await buildApp({ env, services: appServices, logger: false });
    const response = await app.inject({
      method: 'GET',
      url: `/v1/payroll/${cycleId}`,
      headers: { authorization: 'Bearer access-token' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ payroll: { cycleId, status: 'check' } });
    expect(appServices.payroll.get).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'admin' }),
      cycleId
    );

    for (const [url, expected] of [
      [`/v1/payroll/${cycleId}?extra=1`, 400],
      ['/v1/payroll/not-a-uuid', 404]
    ] as const) {
      const invalid = await app.inject({
        method: 'GET', url, headers: { authorization: 'Bearer access-token' }
      });
      expect(invalid.statusCode).toBe(expected);
    }
    await app.close();
  });

  it('pages payroll entries through the authenticated reader contract', async () => {
    const appServices = services();
    const app = await buildApp({ env, services: appServices, logger: false });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/payroll/entries?weekStart=2026-08-24&maidProfileId=62000000-0000-4000-8000-000000000001&kind=items&limit=25',
      headers: { authorization: 'Bearer access-token' }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ kind: 'items', entries: [], nextCursor: null });
    expect(appServices.payroll.listEntries).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'admin' }),
      expect.objectContaining({ kind: 'items', limit: 25 })
    );
    await app.close();
  });

  it('fails closed when any payroll HTTP envelope exceeds 128 KiB', async () => {
    const huge = '가'.repeat(128 * 1024);
    const appServices = services();
    appServices.payroll.list = vi.fn(async () => ({ payroll: [{ huge }] as never, nextCursor: null }));
    appServices.payroll.listEntries = vi.fn(async () => ({
      kind: 'items' as const,
      entries: [{ huge }] as never,
      nextCursor: null
    }));
    appServices.payroll.get = vi.fn(async () => ({ huge } as never));
    appServices.payroll.start = vi.fn(async () => ({ huge } as never));
    const app = await buildApp({ env, services: appServices, logger: false });
    const requests = [
      app.inject({
        method: 'GET',
        url: '/v1/payroll?weekStart=2026-08-24',
        headers: { authorization: 'Bearer access-token' }
      }),
      app.inject({
        method: 'GET',
        url: '/v1/payroll/entries?weekStart=2026-08-24&maidProfileId=62000000-0000-4000-8000-000000000001&kind=items',
        headers: { authorization: 'Bearer access-token' }
      }),
      app.inject({
        method: 'GET',
        url: '/v1/payroll/76000000-0000-4000-8000-000000000001',
        headers: { authorization: 'Bearer access-token' }
      }),
      app.inject({
        method: 'POST',
        url: '/v1/payroll/start',
        headers: {
          authorization: 'Bearer access-token',
          'idempotency-key': 'payroll-start-size-cap'
        },
        payload: {
          maidProfileId: '62000000-0000-4000-8000-000000000001',
          weekStart: '2026-08-24',
          expectedVersion: 0
        }
      })
    ];
    for (const request of requests) {
      const response = await request;
      expect(response.statusCode).toBe(500);
      expect(response.json().error.code).toBe('PAYROLL_RESPONSE_TOO_LARGE');
    }
    await app.close();
  });

  it('starts payroll with an exact body and Idempotency-Key', async () => {
    const appServices = services();
    appServices.payroll.start = vi.fn(async (_actor, input) => ({
      cycleId: '61000000-0000-4000-8000-000000000001',
      maidProfileId: input.maidProfileId,
      weekStart: input.weekStart,
      status: 'paying' as const,
      version: 1,
      lockedAmount: 30000,
      paymentStartedAt: '2026-09-10T00:00:00Z',
      itemCount: 1,
      totalAmount: 30000,
      items: [],
      itemsNextCursor: null,
      lateEarningCount: 0,
      lateEarningAmount: 0,
      lateEarnings: [],
      lateEarningsNextCursor: null
      , offsetSettled: false, adjustmentAmount: 0, carryInAmount: 0,
      carryOutAmount: 0, payableAmount: 30000, adjustmentCount: 0
      , paymentAttemptId: '61500000-0000-4000-8000-000000000001', paymentAttemptNumber: 1,
      paidAt: null, checkReasonCode: null, lastReopenReasonCode: null
    }));
    const app = await buildApp({ env, services: appServices, logger: false });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/payroll/start',
      headers: {
        authorization: 'Bearer access-token',
        'idempotency-key': 'payroll-start-0001'
      },
      payload: {
        maidProfileId: '62000000-0000-4000-8000-000000000001',
        weekStart: '2026-08-24',
        expectedVersion: 0
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().payroll.status).toBe('paying');
    expect(appServices.payroll.start).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'admin' }),
      expect.objectContaining({ idempotencyKey: 'payroll-start-0001' })
    );

    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/payroll/start',
      headers: {
        authorization: 'Bearer access-token',
        'idempotency-key': 'payroll-start-0002'
      },
      payload: {
        maidProfileId: '62000000-0000-4000-8000-000000000001',
        weekStart: '2026-08-24',
        expectedVersion: 0,
        amount: 30000
      }
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('VALIDATION_ERROR');
    const queryAlias = await app.inject({
      method: 'POST',
      url: '/v1/payroll/start?amount=30000',
      headers: {
        authorization: 'Bearer access-token',
        'idempotency-key': 'payroll-start-0004'
      },
      payload: {
        maidProfileId: '62000000-0000-4000-8000-000000000001',
        weekStart: '2026-08-24',
        expectedVersion: 0
      }
    });
    expect(queryAlias.statusCode).toBe(400);
    await app.close();
  });

  it('ports signed correction, reversal, carry-forward and late earning carry with no-store', async () => {
    const appServices = services();
    const adjustment = {
      adjustmentId: '71000000-0000-4000-8000-000000000001', maidProfileId: '62000000-0000-4000-8000-000000000001',
      bookVersion: 1, amount: -1000, currency: 'KRW' as const, reasonCode: 'earning_correction' as const,
      rootEarningId: '72000000-0000-4000-8000-000000000001', correctionOfEarningId: '72000000-0000-4000-8000-000000000001',
      availableWeekStart: '2026-08-24', createdAt: '2026-09-10T00:00:00Z', alreadyClaimed: false
    };
    appServices.payroll.correct = vi.fn(async () => adjustment);
    appServices.payroll.reverse = vi.fn(async () => ({ ...adjustment, bookVersion: 2, amount: 1000,
      reasonCode: 'adjustment_reversal' as const, correctionOfEarningId: undefined,
      reversalOfAdjustmentId: adjustment.adjustmentId }));
    appServices.payroll.carryLateEarning = vi.fn(async () => ({ ...adjustment, amount: 1000,
      reasonCode: 'late_earning_carry' as const, correctionOfEarningId: undefined,
      lateCarriedEarningId: adjustment.rootEarningId }));
    appServices.payroll.carryForward = vi.fn(async () => ({
      cycleId: '73000000-0000-4000-8000-000000000001', maidProfileId: adjustment.maidProfileId,
      weekStart: '2026-08-24', status: 'open' as const, version: 1, lockedAmount: null,
      paymentStartedAt: null, itemCount: 0, totalAmount: 0, items: [], itemsNextCursor: null,
      lateEarningCount: 0, lateEarningAmount: 0, lateEarnings: [], lateEarningsNextCursor: null,
      offsetSettled: true, adjustmentAmount: -1000, carryInAmount: 0, carryOutAmount: -1000,
      payableAmount: -1000, adjustmentCount: 1
      , paymentAttemptId: null, paymentAttemptNumber: null, paidAt: null,
      checkReasonCode: null, lastReopenReasonCode: null
    }));
    const app = await buildApp({ env, services: appServices, logger: false });
    const requests = [
      ['POST', '/v1/payroll/adjustments/corrections', { sourceEarningId: adjustment.rootEarningId, amount: -1000, expectedVersion: 0 }, 201],
      ['POST', '/v1/payroll/adjustments/reversals', { sourceAdjustmentId: adjustment.adjustmentId, expectedVersion: 1 }, 201],
      ['POST', '/v1/payroll/carry-forward', { maidProfileId: adjustment.maidProfileId, weekStart: '2026-08-24', expectedVersion: 0 }, 200],
      ['POST', `/v1/payroll/late-earnings/${adjustment.rootEarningId}/carry`, { expectedVersion: 1 }, 201]
    ] as const;
    for (const [method, url, payload, status] of requests) {
      const response = await app.inject({ method, url, payload, headers: {
        authorization: 'Bearer access-token', 'idempotency-key': `payroll-${status}-${url.length}`
      } });
      expect(response.statusCode, url).toBe(status);
      expect(response.headers['cache-control'], url).toBe('no-store');
    }
    const unauthorized = await app.inject({
      method: 'POST',
      url: '/v1/payroll/carry-forward',
      headers: { 'idempotency-key': 'payroll-no-store-error' },
      payload: { maidProfileId: adjustment.maidProfileId, weekStart: '2026-08-24', expectedVersion: 0 }
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.headers['cache-control']).toBe('no-store');
    await app.close();
  });

  it('records only exact external payment result bodies with no-store', async () => {
    const appServices = services();
    const paymentResult = {
      paymentResultId: '74000000-0000-4000-8000-000000000001',
      paymentAttemptId: '75000000-0000-4000-8000-000000000001',
      payrollCycleId: '76000000-0000-4000-8000-000000000001', resultType: 'paid' as const,
      beforeStatus: 'paying' as const, afterStatus: 'paid' as const, cycleVersion: 2,
      lockedAmount: 30000, paymentMethod: 'bank_transfer' as const,
      providerReferenceId: 'BANK.AB12', occurredAt: '2026-09-10T00:00:00Z'
    };
    appServices.payroll.recordPaymentPaid = vi.fn(async () => paymentResult);
    appServices.payroll.recordPaymentCheck = vi.fn(async () => ({ ...paymentResult, resultType: 'check' as const,
      afterStatus: 'check' as const, paymentMethod: undefined, providerReferenceId: undefined,
      reasonCode: 'TRANSFER_RESULT_UNCERTAIN' as const }));
    appServices.payroll.reopenPayment = vi.fn(async () => ({ ...paymentResult, resultType: 'reopened' as const,
      afterStatus: 'open' as const, paymentMethod: undefined, providerReferenceId: undefined,
      reasonCode: 'NO_TRANSFER_CONFIRMED' as const }));
    const app = await buildApp({ env, services: appServices, logger: false });
    for (const [suffix, payload] of [
      ['check', { expectedVersion: 1, reasonCode: 'TRANSFER_RESULT_UNCERTAIN' }],
      ['paid', { expectedVersion: 1, paymentMethod: 'bank_transfer', providerReferenceId: 'bank.ab12' }],
      ['reopen', { expectedVersion: 1, reasonCode: 'NO_TRANSFER_CONFIRMED' }]
    ] as const) {
      const response = await app.inject({ method: 'POST',
        url: `/v1/payroll/payment-attempts/${paymentResult.paymentAttemptId}/${suffix}`,
        headers: { authorization: 'Bearer access-token', 'idempotency-key': `payment-${suffix}-result` }, payload });
      expect(response.statusCode, suffix).toBe(200);
      expect(response.headers['cache-control'], suffix).toBe('no-store');
    }
    for (const extra of [{ amount: 1 }, { paidAt: '2026-09-10T00:00:00Z' },
      { receipt: 'secret' }, { payeeAccount: 'private' }]) {
      const response = await app.inject({ method: 'POST',
        url: `/v1/payroll/payment-attempts/${paymentResult.paymentAttemptId}/paid`,
        headers: { authorization: 'Bearer access-token', 'idempotency-key': `payment-reject-${Object.keys(extra)[0]}` },
        payload: { expectedVersion: 1, paymentMethod: 'bank_transfer', providerReferenceId: 'BANK.AB12', ...extra } });
      expect(response.statusCode).toBe(400);
      expect(response.headers['cache-control']).toBe('no-store');
    }
    const zeroVersion = await app.inject({ method: 'POST',
      url: `/v1/payroll/payment-attempts/${paymentResult.paymentAttemptId}/check`,
      headers: { authorization: 'Bearer access-token', 'idempotency-key': 'payment-zero-version' },
      payload: { expectedVersion: 0, reasonCode: 'TRANSFER_RESULT_UNCERTAIN' } });
    expect(zeroVersion.statusCode).toBe(400);
    expect(zeroVersion.headers['cache-control']).toBe('no-store');
    expect(appServices.payroll.recordPaymentCheck).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('requires exact business admin role for payroll start', async () => {
    const appServices = services();
    appServices.auth.authenticate = vi.fn(async (accessToken: string) => ({
      authUserId: 'auth-maid-1',
      profileId: '62000000-0000-4000-8000-000000000001',
      displayName: '메이드',
      role: 'maid' as const,
      mustChangePassword: false,
      accessToken
    }));
    const app = await buildApp({ env, services: appServices, logger: false });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/payroll/start',
      headers: {
        authorization: 'Bearer access-token',
        'idempotency-key': 'payroll-start-0003'
      },
      payload: {
        maidProfileId: '62000000-0000-4000-8000-000000000001',
        weekStart: '2026-08-24',
        expectedVersion: 0
      }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('ADMIN_REQUIRED');
    expect(appServices.payroll.start).not.toHaveBeenCalled();
    await app.close();
  });

  it('exposes bounded developer/admin PIN Sheet status and fenced full-resync routes', async () => {
    const appServices = services();
    appServices.roomPinSheetOperations = {
      status: vi.fn(async () => ({
        pending: 0, failed: 0, operatorBlocked: false, oldestPendingAt: null,
        lastSuccessAt: null, lastErrorCode: null, version: 4,
        checkedAt: '2026-09-13T00:00:00.000Z'
      })),
      requestFullResync: vi.fn(async () => ({ status: 'pending' as const, roomCount: 121 as const, version: 4 }))
    };
    const app = await buildApp({ env, services: appServices, logger: false });
    const status = await app.inject({ method: 'GET', url: '/v1/room-pin-sheet-sync/status',
      headers: { authorization: 'Bearer access-token' } });
    expect(status.statusCode).toBe(200);
    expect(status.headers['cache-control']).toBe('no-store');
    expect(Object.keys(status.json().sync).sort()).toEqual([
      'checkedAt', 'failed', 'lastErrorCode', 'lastSuccessAt', 'oldestPendingAt',
      'operatorBlocked', 'pending', 'version'
    ]);
    const accepted = await app.inject({ method: 'POST', url: '/v1/room-pin-sheet-sync/full-resync',
      headers: { authorization: 'Bearer access-token', 'idempotency-key': 'full-resync-route-0001' },
      payload: { expectedVersion: 4 } });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.headers['cache-control']).toBe('no-store');
    expect(accepted.json()).toEqual({ sync: { status: 'pending', roomCount: 121, version: 4 } });
    expect(appServices.roomPinSheetOperations.requestFullResync).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'admin' }), 4, 'full-resync-route-0001'
    );
    const extra = await app.inject({ method: 'POST', url: '/v1/room-pin-sheet-sync/full-resync',
      headers: { authorization: 'Bearer access-token', 'idempotency-key': 'full-resync-route-0002' },
      payload: { expectedVersion: 4, spreadsheetId: 'forbidden' } });
    expect(extra.statusCode).toBe(400);
    await app.close();
  });
});
