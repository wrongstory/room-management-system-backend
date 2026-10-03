import { describe, expect, it, vi } from 'vitest';
import { type AppServices, buildApp } from '../src/app.js';
import type { AppEnv } from '../src/config/env.js';
import type { Actor } from '../src/domain/actor.js';
import type { SupabaseClients } from '../src/lib/supabase.js';
import { normalizePayrollAdjustmentBookInput } from '../src/modules/payroll/payroll-adjustment-book.js';
import { SupabasePayrollService } from '../src/modules/payroll/payroll.service.js';

const sessionId = 'f1000000-0000-4000-8000-000000000001';
function token(claims: unknown): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
}
const admin: Actor = {
  authUserId: 'a1000000-0000-4000-8000-000000000001',
  profileId: 'b1000000-0000-4000-8000-000000000001',
  displayName: '합성 관리자', role: 'admin', mustChangePassword: false,
  accessToken: token({ session_id: sessionId })
};
const input = { maidProfileId: 'c1000000-0000-4000-8000-000000000001', weekStart: '2026-09-28' };
const book = { ...input, currentBookVersion: 3 };
function payroll(rpc: ReturnType<typeof vi.fn>): SupabasePayrollService {
  return new SupabasePayrollService({ admin: { rpc } } as unknown as SupabaseClients, 'synthetic-payroll-cursor-secret-32bytes');
}

const env: AppEnv = {
  APP_ENV: 'local', NODE_ENV: 'test', HOST: '127.0.0.1', PORT: 3000, LOG_LEVEL: 'silent',
  CORS_ORIGINS: 'http://127.0.0.1:4173', corsOrigins: ['http://127.0.0.1:4173'],
  SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_PUBLISHABLE_KEY: 'publishable-test', SUPABASE_SECRET_KEY: 'secret-test',
  ACCOUNT_PHONE_PEPPER: 'synthetic-phone-pepper-minimum-32bytes',
  RESERVATION_PII_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'),
  RESERVATION_PII_KEY_VERSION: 'test-v1', RESERVATION_PII_KEYRING_JSON: '{}',
  RESERVATION_GUEST_NAME_PEPPER: 'synthetic-guest-pepper-minimum-32bytes',
  ROOM_PIN_KEY_BASE64: Buffer.alloc(32, 8).toString('base64'), ROOM_PIN_KEY_VERSION: 'pin-v1', ROOM_PIN_KEYRING_JSON: '{}',
  PAYROLL_CURSOR_HMAC_SECRET: 'synthetic-payroll-cursor-secret-32bytes',
  NOTIFICATION_CURSOR_HMAC_SECRET: 'synthetic-notification-cursor-32bytes',
  INSPECTION_CURSOR_HMAC_SECRET: 'synthetic-inspection-cursor-secret-32bytes',
  WEB_PUSH_SUBSCRIPTION_KEY_BASE64: Buffer.alloc(32, 4).toString('base64'),
  WEB_PUSH_SUBSCRIPTION_KEY_VERSION: 'v1', WEB_PUSH_SUBSCRIPTION_KEYRING_JSON: '{}',
  WEB_PUSH_BINDING_DIGEST_SECRET: 'synthetic-web-push-binding-secret-32bytes',
  VAPID_CURRENT_KEY_VERSION: 'vapid-v1',
  VAPID_PUBLIC_KEY: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  VAPID_PUBLIC_KEYRING_JSON: '{}', RESERVATION_SCHEDULER_INTERVAL_SECONDS: 60
};

async function httpApp(actor: Actor = admin, read = vi.fn(async () => book)) {
  const authenticate = vi.fn(async () => actor);
  const service = {
    auth: { authenticate }, accounts: {}, availability: {}, rooms: {}, reservations: {},
    payroll: { getAdjustmentBook: read }
  } as unknown as AppServices;
  return { app: await buildApp({ env, services: service, logger: false }), read, authenticate };
}
const url = `/v1/payroll/adjustment-book?maidProfileId=${input.maidProfileId}&weekStart=${input.weekStart}`;
const headers = { authorization: 'Bearer synthetic-token' };

describe('payroll current adjustment book service', () => {
  it.each([0, 1, 3, Number.MAX_SAFE_INTEGER])('returns server book version %i without reconstructing row versions', async (version) => {
    const rpc = vi.fn(async () => ({ data: { ...book, currentBookVersion: version }, error: null }));
    expect(await payroll(rpc).getAdjustmentBook(admin, input)).toEqual({ ...book, currentBookVersion: version });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('get_payroll_adjustment_book', {
      p_actor_profile_id: admin.profileId, p_session_id: sessionId,
      p_maid_profile_id: input.maidProfileId, p_week_start: input.weekStart
    });
  });

  it('canonicalizes UUID identity but does not turn week context into a separate book', async () => {
    const rpc = vi.fn(async (_name: string, args: { p_week_start: string }) => ({
      data: { ...book, weekStart: args.p_week_start }, error: null
    }));
    for (const weekStart of ['2026-09-28', '2026-09-21', '0001-01-01']) {
      expect(await payroll(rpc).getAdjustmentBook(admin, { maidProfileId: input.maidProfileId.toUpperCase(), weekStart }))
        .toEqual({ ...book, weekStart });
    }
    expect(rpc.mock.calls.map((call) => call[1].p_week_start)).toEqual(['2026-09-28', '2026-09-21', '0001-01-01']);
  });

  it('uses each authenticated browser session rather than retaining a previous read session', async () => {
    const newSession = 'f1000000-0000-4000-8000-000000000002';
    const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({ data: book, error: null }));
    const service = payroll(rpc);
    await service.getAdjustmentBook(admin, input);
    await service.getAdjustmentBook({ ...admin, accessToken: token({ session_id: newSession }) }, input);
    expect(rpc.mock.calls[1]?.[1]).toMatchObject({ p_session_id: newSession });
  });

  it.each(['maid', 'developer'] as const)('rejects %s before any RPC', async (role) => {
    const rpc = vi.fn();
    await expect(payroll(rpc).getAdjustmentBook({ ...admin, role }, input)).rejects.toMatchObject({ statusCode: 403, code: 'ADMIN_REQUIRED' });
    expect(rpc).not.toHaveBeenCalled();
  });
  it('rejects temporary-password actors before any RPC', async () => {
    const rpc = vi.fn();
    await expect(payroll(rpc).getAdjustmentBook({ ...admin, mustChangePassword: true }, input))
      .rejects.toMatchObject({ statusCode: 403, code: 'PASSWORD_CHANGE_REQUIRED' });
    expect(rpc).not.toHaveBeenCalled();
  });
  it.each(['plain-token', 'header.invalid.signature', token({}), token({ session_id: null }), token({ session_id: 1 }),
    token({ session_id: 'invalid' }), token({ session_id: '00000000-0000-0000-0000-000000000000' })])
    ('fails closed on missing or invalid authenticated session claim %s', async (accessToken) => {
      const rpc = vi.fn();
      await expect(payroll(rpc).getAdjustmentBook({ ...admin, accessToken }, input))
        .rejects.toMatchObject({ statusCode: 401, code: 'INVALID_ACCESS_TOKEN' });
      expect(rpc).not.toHaveBeenCalled();
    });

  it.each([
    ['SESSION_REVOKED', 401], ['PASSWORD_CHANGE_REQUIRED', 403], ['ADMIN_REQUIRED', 403],
    ['PAYROLL_WEEK_MUST_START_MONDAY', 400], ['PAYROLL_WEEK_NOT_CLOSED', 409], ['PAYROLL_MAID_NOT_FOUND', 404]
  ] as const)('maps latest-DB guard %s without exposing private detail', async (code, statusCode) => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: code } }));
    const pending = payroll(rpc).getAdjustmentBook(admin, input);
    await expect(pending).rejects.toMatchObject({ statusCode, code });
    await expect(pending).rejects.not.toMatchObject({ message: expect.stringContaining('raw-secret-detail') });
  });
  it.each(['raw query contains SESSION_REVOKED private-secret', 'ADMIN_REQUIRED: raw-secret-detail', ' ADMIN_REQUIRED '])
    ('redacts unknown database failure %s rather than interpreting embedded known error names', async (message) => {
    const rpc = vi.fn(async () => ({ data: null, error: { message } }));
    await expect(payroll(rpc).getAdjustmentBook(admin, input)).rejects.toMatchObject({ statusCode: 500, code: 'PAYROLL_COMMAND_FAILED' });
  });

  it.each([
    null, [], {}, { ...book, currentBookVersion: undefined }, { ...book, currentBookVersion: null },
    { ...book, currentBookVersion: '3' }, { ...book, currentBookVersion: -1 }, { ...book, currentBookVersion: 1.5 },
    { ...book, currentBookVersion: Number.MAX_SAFE_INTEGER + 1 }, { ...book, currentBookVersion: Number.NaN },
    { ...book, currentBookVersion: Number.POSITIVE_INFINITY }, { ...book, maidProfileId: 'invalid' },
    { ...book, maidProfileId: input.maidProfileId.toUpperCase() },
    { ...book, maidProfileId: 'c1000000-0000-4000-8000-000000000002' }, { ...book, weekStart: '2026-09-21' },
    { ...book, weekStart: '2026-02-30' }, { ...book, weekStart: null }, { ...book, extra: 'private-detail' },
    { ...book, pin: 'redacted-synthetic-value' }
  ])('rejects malformed, stale-bound or private RPC projection %#', async (data) => {
    const rpc = vi.fn(async () => ({ data, error: null }));
    await expect(payroll(rpc).getAdjustmentBook(admin, input)).rejects.toMatchObject({ statusCode: 500, code: 'PAYROLL_COMMAND_FAILED' });
  });

  it('rejects an oversized raw RPC projection before parsing with the same bounded Edge error', async () => {
    const rpc = vi.fn(async () => ({ data: { ...book, ledger: '가'.repeat(128 * 1024) }, error: null }));
    await expect(payroll(rpc).getAdjustmentBook(admin, input)).rejects.toMatchObject({
      statusCode: 500, code: 'PAYROLL_RESPONSE_TOO_LARGE'
    });
  });

  it.each(['0001-01-01', '0099-12-31', '2000-02-29', '2024-02-29', '9999-12-31'])
    ('accepts real calendar input %s, leaving Monday/current-week validation to authoritative DB', (weekStart) => {
      expect(normalizePayrollAdjustmentBookInput({ ...input, weekStart })).toEqual({ ...input, weekStart });
    });
  it.each(['0000-01-01', '10000-01-01', '1900-02-29', '2026-02-29', '2026-04-31', '2026-13-01',
    '2026-00-01', '2026-09-00', '2026-9-28', ' 2026-09-28', '2026-09-28T00:00:00Z'])
    ('rejects invalid calendar input %s without any RPC', async (weekStart) => {
      const rpc = vi.fn();
      await expect(payroll(rpc).getAdjustmentBook(admin, { ...input, weekStart })).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
      expect(rpc).not.toHaveBeenCalled();
    });
});

describe('payroll adjustment-book exact Fastify endpoint', () => {
  it('returns only the new envelope and normalized query through an authenticated admin read', async () => {
    const { app, read } = await httpApp();
    try {
      const response = await app.inject({ method: 'GET', url: url.replace(input.maidProfileId, input.maidProfileId.toUpperCase()), headers });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toEqual({ adjustmentBook: book });
      expect(read).toHaveBeenCalledWith(admin, input);
    } finally { await app.close(); }
  });

  it.each([
    '', `?maidProfileId=${input.maidProfileId}`, `?weekStart=${input.weekStart}`,
    `?maidProfileId=&weekStart=${input.weekStart}`, `?maidProfileId=${input.maidProfileId}&weekStart=`,
    `?maidProfileId=invalid&weekStart=${input.weekStart}`, `?maidProfileId=00000000-0000-0000-0000-000000000000&weekStart=${input.weekStart}`,
    `?maidProfileId=ffffffff-ffff-ffff-ffff-ffffffffffff&weekStart=${input.weekStart}`, `?maidProfileId=${input.maidProfileId}&weekStart=2026-02-30`,
    `?maidProfileId=${input.maidProfileId}&weekStart=${input.weekStart}&extra=1`,
    `?maidProfileId=${input.maidProfileId}&weekStart=${input.weekStart}&weekStart=${input.weekStart}`,
    `?maidProfileId=${input.maidProfileId}&weekStart=${input.weekStart}&maidProfileId=${input.maidProfileId}`,
    `?maidProfileId=${input.maidProfileId}&weekStart=${input.weekStart}&weekStart%5B%5D=${input.weekStart}`
  ])('rejects missing, malformed or non-exact query %# before service read', async (query) => {
    const { app, read } = await httpApp();
    try {
      const response = await app.inject({ method: 'GET', url: `/v1/payroll/adjustment-book${query}`, headers });
      expect(response.statusCode).toBe(400);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
      expect(read).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const)('rejects %s without authentication or read, with no-store', async (method) => {
    const { app, read, authenticate } = await httpApp();
    try {
      const response = await app.inject({ method, url });
      expect(response.statusCode).toBe(404);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(authenticate).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it.each(['/v1/payroll/adjustment-book/', '/v1/payroll//adjustment-book', '//v1/payroll/adjustment-book',
    '/v1/payroll/adjustment-book/extra'])('rejects slash/path alias %s with no-store', async (path) => {
    const { app, read } = await httpApp();
    try {
      const response = await app.inject({ method: 'GET', url: `${path}?maidProfileId=${input.maidProfileId}&weekStart=${input.weekStart}`, headers });
      expect(response.statusCode).toBe(404);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(read).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('preserves CORS preflight without an additional domain read', async () => {
    const { app, read, authenticate } = await httpApp();
    try {
      const response = await app.inject({ method: 'OPTIONS', url, headers: {
        origin: env.corsOrigins[0] as string, 'access-control-request-method': 'GET'
      } });
      expect(response.statusCode).toBe(204);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(read).not.toHaveBeenCalled();
      expect(authenticate).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('keeps missing authentication failures no-store', async () => {
    const { app, read } = await httpApp();
    try {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('MISSING_ACCESS_TOKEN');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(read).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it.each(['maid', 'developer'] as const)('denies %s route authorization without invoking the read', async (role) => {
    const { app, read } = await httpApp({ ...admin, role });
    try {
      const response = await app.inject({ method: 'GET', url, headers });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('ADMIN_REQUIRED');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(read).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('keeps temporary-password denial no-store', async () => {
    const { app, read } = await httpApp({ ...admin, mustChangePassword: true });
    try {
      const response = await app.inject({ method: 'GET', url, headers });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('PASSWORD_CHANGE_REQUIRED');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(read).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('measures the final HTTP envelope against the existing UTF-8 128 KiB payroll bound', async () => {
    const read = vi.fn(async () => ({ ...book, extra: '가'.repeat(128 * 1024) }));
    const { app } = await httpApp(admin, read);
    try {
      const response = await app.inject({ method: 'GET', url, headers });
      expect(response.statusCode).toBe(500);
      expect(response.json().error.code).toBe('PAYROLL_RESPONSE_TOO_LARGE');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).not.toContain('가');
    } finally { await app.close(); }
  });
});
