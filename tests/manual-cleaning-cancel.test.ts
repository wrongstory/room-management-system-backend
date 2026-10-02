import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '../src/domain/actor.js';
import { AppError } from '../src/lib/app-error.js';
import { requestHash } from '../src/lib/command.js';
import type { SupabaseClients } from '../src/lib/supabase.js';
import { SupabaseAuthService } from '../src/modules/auth/auth.service.js';
import { createReservationRoutes } from '../src/modules/reservations/reservation.routes.js';
import { SupabaseReservationService } from '../src/modules/reservations/reservation.service.js';

const sessionId = '30000000-0000-4000-8000-000000000001';
const otherSessionId = '30000000-0000-4000-8000-000000000002';
const rawSentinel = 'synthetic-private-source-must-not-leak';

// This unsigned synthetic token is accepted only by the mocked Auth verifier below.
function syntheticJwt(claims: unknown): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(claims)}.test`;
}

const admin: Actor = {
  authUserId: '10000000-0000-4000-8000-000000000001',
  profileId: '20000000-0000-4000-8000-000000000001',
  displayName: '합성 관리자',
  role: 'admin',
  mustChangePassword: false,
  accessToken: syntheticJwt({ session_id: sessionId })
};
const row = {
  id: '80000000-0000-4000-8000-000000000001',
  room_id: '50000000-0000-4000-8000-000000000001',
  reservation_id: '40000000-0000-4000-8000-000000000001',
  cleaning_kind: 'stayover',
  status: 'cancelled',
  service_date: '2026-10-02',
  available_from: '2026-10-02T08:00:00Z',
  due_at: null,
  version: 2,
  pin: rawSentinel,
  source_key: rawSentinel,
  session_id: sessionId
};
const expectedDto = {
  id: row.id,
  roomId: row.room_id,
  reservationId: row.reservation_id,
  cleaningKind: row.cleaning_kind,
  status: row.status,
  serviceDate: row.service_date,
  availableFrom: row.available_from,
  dueAt: row.due_at,
  version: row.version
};
const input = {
  targetId: row.id,
  expectedVersion: 1,
  reasonCode: 'REQUEST_WITHDRAWN',
  idempotencyKey: 'manual-cancel-synthetic-0001'
};
const fingerprint = {
  targetId: input.targetId,
  expectedVersion: input.expectedVersion,
  reasonCode: input.reasonCode
};

function cancellationFixture(error: { message: string; details?: string; hint?: string } | null = null) {
  const rpc = vi.fn(async (name: string, _args: Record<string, unknown>) => {
    if (name === 'is_active_auth_session') return { data: true, error: null };
    return { data: error ? null : row, error };
  });
  const getUser = vi.fn(async (_token: string) => ({
    data: { user: { id: admin.authUserId } }, error: null
  }));
  const profile = {
    id: admin.profileId, auth_user_id: admin.authUserId,
    display_name: admin.displayName, role: admin.role,
    status: 'active', must_change_password: false, locked_until: null
  };
  const builder = {
    select: () => builder,
    eq: () => builder,
    single: async () => ({ data: profile, error: null })
  };
  const clients = {
    admin: { rpc, from: vi.fn(() => builder) },
    publicClient: { auth: { getUser } }
  } as unknown as SupabaseClients;
  return {
    rpc, getUser,
    auth: new SupabaseAuthService(clients, 'synthetic-verification-pepper-at-least-32-characters'),
    service: new SupabaseReservationService(
      clients, Buffer.alloc(32, 7).toString('base64'), 'test-v1',
      'reservation-guest-name-pepper-test-value'
    )
  };
}

describe('manual cleaning cancellation session adapter', () => {
  it('passes the Auth-verified bearer session to the exact internal RPC and retains the public DTO', async () => {
    const fixture = cancellationFixture();
    const actor = await fixture.auth.authenticate(admin.accessToken);
    fixture.rpc.mockClear();

    const result = await fixture.service.cancelManualCleaningRequest(actor, input);

    expect(fixture.getUser).toHaveBeenCalledWith(admin.accessToken);
    expect(fixture.rpc).toHaveBeenCalledExactlyOnceWith('cancel_manual_cleaning_request_with_session', {
      p_actor_profile_id: admin.profileId,
      p_session_id: sessionId,
      p_target_id: input.targetId,
      p_expected_version: 1,
      p_reason_code: input.reasonCode,
      p_idempotency_key: input.idempotencyKey,
      p_request_hash: requestHash(fingerprint)
    });
    expect(result).toEqual(expectedDto);
    expect(JSON.stringify(result)).not.toContain(rawSentinel);
    expect(JSON.stringify(result)).not.toContain(sessionId);
  });

  it('hashes business inputs deterministically without the session or idempotency key', async () => {
    const fixture = cancellationFixture();
    await fixture.service.cancelManualCleaningRequest(admin, input);
    await fixture.service.cancelManualCleaningRequest({
      ...admin, accessToken: syntheticJwt({ session_id: otherSessionId })
    }, { ...input, idempotencyKey: 'manual-cancel-synthetic-0002' });
    await fixture.service.cancelManualCleaningRequest(admin, { ...input, expectedVersion: 2 });
    await fixture.service.cancelManualCleaningRequest(admin, { ...input, reasonCode: 'SCHEDULE_CHANGED' });

    const args = fixture.rpc.mock.calls.map(([, value]) => value);
    expect(args[0]?.p_request_hash).toBe(requestHash(fingerprint));
    expect(args[1]?.p_request_hash).toBe(args[0]?.p_request_hash);
    expect(args[1]?.p_session_id).toBe(otherSessionId);
    expect(args[2]?.p_request_hash).not.toBe(args[0]?.p_request_hash);
    expect(args[3]?.p_request_hash).not.toBe(args[0]?.p_request_hash);
  });

  it.each([
    ['opaque token', 'test-token'],
    ['missing session claim', syntheticJwt({})],
    ['null session', syntheticJwt({ session_id: null })],
    ['numeric session', syntheticJwt({ session_id: 1 })],
    ['array session', syntheticJwt({ session_id: [sessionId] })],
    ['malformed UUID', syntheticJwt({ session_id: rawSentinel })],
    ['invalid UUID version', syntheticJwt({ session_id: '30000000-0000-0000-8000-000000000001' })],
    ['invalid UUID variant', syntheticJwt({ session_id: '30000000-0000-4000-0000-000000000001' })],
    ['malformed payload', 'test.not-json.test']
  ])('rejects %s before any command RPC', async (_label, accessToken) => {
    const fixture = cancellationFixture();
    await expect(fixture.service.cancelManualCleaningRequest({ ...admin, accessToken }, input))
      .rejects.toMatchObject({ statusCode: 401, code: 'INVALID_ACCESS_TOKEN', message: '로그인이 필요합니다.' });
    expect(fixture.rpc).not.toHaveBeenCalled();
  });

  it.each(['maid', 'developer'] as const)('keeps the %s admin-only denial before RPC', async (role) => {
    const fixture = cancellationFixture();
    await expect(fixture.service.cancelManualCleaningRequest({ ...admin, role }, input))
      .rejects.toMatchObject({ statusCode: 403, code: 'ADMIN_REQUIRED' });
    expect(fixture.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['SESSION_REVOKED', 401],
    ['PASSWORD_CHANGE_REQUIRED', 403],
    ['STALE_VERSION', 409],
    ['IDEMPOTENCY_KEY_REUSED', 409],
    ['VALIDATION_ERROR', 400],
    ['CLEANING_REQUEST_NOT_FOUND', 404],
    ['UNKNOWN_DATABASE_ERROR', 500]
  ] as const)('maps %s without exposing database details', async (code, statusCode) => {
    const fixture = cancellationFixture({
      message: `${code}: ${rawSentinel}`, details: rawSentinel, hint: rawSentinel
    });
    let caught: unknown;
    try {
      await fixture.service.cancelManualCleaningRequest(admin, input);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect(caught).toMatchObject({
      statusCode, code: code === 'UNKNOWN_DATABASE_ERROR' ? 'RESERVATION_COMMAND_FAILED' : code
    });
    expect(JSON.stringify(caught)).not.toContain(rawSentinel);
    expect((caught as AppError).message).not.toContain(rawSentinel);
    expect(fixture.rpc).toHaveBeenCalledOnce();
  });

  it('keeps the existing POST path and response envelope without accepting a body session override', async () => {
    const fixture = cancellationFixture();
    const app = Fastify();
    app.decorateRequest('actor');
    app.decorate('authenticate', async (request) => {
      request.actor = await fixture.auth.authenticate(request.headers.authorization?.slice(7) ?? '');
    });
    app.decorate('requirePasswordChanged', async () => {});
    app.decorate('requireAdmin', async () => {});
    await app.register(createReservationRoutes(fixture.service), { prefix: '/v1/reservations' });
    try {
      const response = await app.inject({
        method: 'POST', url: `/v1/reservations/cleaning-requests/${row.id}/cancel`,
        headers: { authorization: `Bearer ${admin.accessToken}`, 'idempotency-key': input.idempotencyKey },
        payload: {
          expectedVersion: 1, reasonCode: input.reasonCode,
          sessionId: otherSessionId, pin: rawSentinel, sourceKey: rawSentinel
        }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ cleaningRequest: expectedDto });
      expect(fixture.rpc.mock.calls.at(-1)).toEqual(['cancel_manual_cleaning_request_with_session', {
        p_actor_profile_id: admin.profileId, p_session_id: sessionId,
        p_target_id: row.id, p_expected_version: 1, p_reason_code: input.reasonCode,
        p_idempotency_key: input.idempotencyKey, p_request_hash: requestHash(fingerprint)
      }]);
    } finally {
      await app.close();
    }
  });
});
