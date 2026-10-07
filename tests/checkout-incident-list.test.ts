import { createHmac } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AppEnv } from '../src/config/env.js';
import type { Actor } from '../src/domain/actor.js';
import { AppError } from '../src/lib/app-error.js';
import {
  assertCheckoutIncidentListResponseSize,
  CHECKOUT_INCIDENT_RESPONSE_MAX_BYTES,
  CheckoutIncidentCursorCodec,
  checkoutIncidentCursorScope,
  checkoutIncidentListQuery,
  isCheckoutIncidentListTimestamp,
  normalizeCheckoutIncidentListInput
} from '../src/modules/checkout-incidents/checkout-incident-cursor.js';
import { checkoutIncidentCollectionGuard, createCheckoutIncidentRoutes } from '../src/modules/checkout-incidents/checkout-incident.routes.js';
import {
  checkoutIncidentDatabaseError,
  type CheckoutIncidentService,
  SupabaseCheckoutIncidentService
} from '../src/modules/checkout-incidents/checkout-incident.service.js';

const secret = 'inspection-cursor-secret-tests-1234567';
const id = (n: number) => `f3270000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sessionId = id(900);
const actor: Actor = {
  authUserId: id(800), profileId: id(1), role: 'admin', displayName: '관리자', mustChangePassword: false,
  accessToken: `e30.${Buffer.from(JSON.stringify({ session_id: sessionId })).toString('base64url')}.signature`
};
const item = (n: number, reportedAt = '2026-10-02T06:00:00.123456Z') => ({
  incidentId: id(n), status: 'open', roomId: id(100), roomNumber: '350', cleaningTargetId: id(101),
  assignmentId: id(102), attemptId: id(200 + n), reportedAt, serviceDate: '2026-09-30',
  allowedDecisions: ['EXTEND_CHECKOUT', 'CONFIRM_DEPARTED', 'FALSE_REPORT']
});
const query = normalizeCheckoutIncidentListInput({});
const scope = checkoutIncidentCursorScope(actor, query);
function signed(value: unknown) {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload, 'ascii').digest('base64url')}`;
}
function serviceFor(data: unknown, error: { message: string } | null = null, signingSecret: string | undefined = secret) {
  const rpc = vi.fn(async () => ({ data, error }));
  return { rpc, service: new SupabaseCheckoutIncidentService({ admin: { rpc } } as never, signingSecret) };
}

describe('checkout incident list cursor and query', () => {
  it('matches the frozen Node and Edge HMAC interoperability vector', () => {
    const codec = new CheckoutIncidentCursorCodec(secret);
    const after = { reportedAt: '2026-10-02T06:00:00.000001Z', id: id(2) };
    const expected = 'eyJ2IjoxLCJzY29wZSI6eyJhY3RvclByb2ZpbGVJZCI6ImYzMjcwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMSIsImFjdG9yUm9sZSI6ImFkbWluIiwic3RyZWFtIjoiY2hlY2tvdXRfcHJlc2VuY2Vfb3BlbiIsInN0YXR1cyI6Im9wZW4iLCJzb3J0IjoicmVwb3J0ZWRfYXRfZGVzY19pZF9kZXNjIiwicm9vbUlkIjpudWxsLCJjbGVhbmluZ1RhcmdldElkIjpudWxsLCJzZXJ2aWNlRGF0ZSI6bnVsbH0sImFmdGVyIjp7InJlcG9ydGVkQXQiOiIyMDI2LTEwLTAyVDA2OjAwOjAwLjAwMDAwMVoiLCJpZCI6ImYzMjcwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMiJ9fQ.JL4cnbiTvuPs7bx-KBCZm-ydwjXNX4aOdaYOgObkHrY';
    expect(codec.encode(scope, after)).toBe(expected);
    expect(codec.decode(expected, scope)).toEqual(after);
  });

  it('binds canonical actor, open stream and every nullable filter without binding page size', () => {
    const codec = new CheckoutIncidentCursorCodec(secret);
    const filtered = checkoutIncidentListQuery(new URLSearchParams({
      roomId: id(100).toUpperCase(), cleaningTargetId: id(101).toUpperCase(), serviceDate: '2028-02-29', limit: '100'
    }));
    expect(filtered).toEqual({ roomId: id(100), cleaningTargetId: id(101), serviceDate: '2028-02-29', limit: 100, cursor: null });
    const scoped = checkoutIncidentCursorScope({ ...actor, profileId: actor.profileId.toUpperCase() }, filtered);
    const after = { reportedAt: '2026-10-02T06:00:00.123456Z', id: id(2) };
    const cursor = codec.encode(scoped, after);
    expect(codec.decode(cursor, scoped)).toEqual(after);
    expect(Buffer.from(cursor.split('.')[0] as string, 'base64url').toString('utf8')).toBe(JSON.stringify({
      v: 1, scope: scoped, after
    }));
    const changedLimit = { ...filtered, limit: 1 };
    expect(codec.decode(cursor, checkoutIncidentCursorScope(actor, changedLimit))).toEqual(after);
    for (const changed of [
      { ...scoped, actorProfileId: id(2) }, { ...scoped, roomId: null },
      { ...scoped, cleaningTargetId: null }, { ...scoped, serviceDate: null },
      { ...scoped, actorRole: 'maid' }, { ...scoped, stream: 'pending-inspections' },
      { ...scoped, sort: 'reportedAt:asc,id:asc' }, { ...scoped, status: 'resolved' }
    ]) expect(() => codec.decode(cursor, changed as typeof scoped)).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(cursor).not.toContain(sessionId);
    expect(cursor).not.toContain(secret);
  });

  it.each([
    'unknown=1', 'status=open', 'roomId=', `roomId=${id(100)}&roomId=${id(100)}`,
    `roomId=${id(100)}&%72oomId=${id(100)}`, `cleaningTargetId=${id(101)}&cleaningTargetId=${id(101)}`,
    'serviceDate=2026-02-29', 'serviceDate=2026-04-31', 'serviceDate=0000-01-01', 'serviceDate=2026-1-01',
    'serviceDate=2026-10-02&serviceDate=2026-10-02', 'roomId=invalid', 'cleaningTargetId=invalid',
    'limit=', 'limit=0', 'limit=101', 'limit=-1', 'limit=01', 'limit=1.0', 'limit=1e2',
    'limit=1&limit=2', 'cursor=', `cursor=${'a'.repeat(1025)}`, 'cursor=a&cursor=b'
  ])('rejects noncanonical or repeated query %s', (value) => {
    expect(() => checkoutIncidentListQuery(new URLSearchParams(value)))
      .toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR', statusCode: 400 }));
  });

  it('rejects tampering, noncanonical encoding and signed malformed cursor payloads', () => {
    const codec = new CheckoutIncidentCursorCodec(secret);
    const after = { reportedAt: '2026-10-02T06:00:00.000001Z', id: id(2) };
    const cursor = codec.encode(scope, after);
    const [payload, signature = ''] = cursor.split('.');
    const lastAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const noncanonicalSignature = signature.slice(0, -1) + lastAlphabet[lastAlphabet.indexOf(signature.at(-1) as string) + 1];
    const invalid = [
      cursor.slice(0, -1) + (cursor.endsWith('A') ? 'B' : 'A'), `${payload}.${noncanonicalSignature}`,
      `${payload}=.${signature}`, `${cursor}.extra`, 'unsigned', 'a'.repeat(1025),
      signed({ v: 2, scope, after }), signed({ v: 1, scope: { ...scope, secret }, after }),
      signed({ v: 1, scope: { ...scope, stream: 'pending-inspections' }, after }),
      signed({ v: 1, scope, after: { ...after, id: 'invalid' } }),
      signed({ v: 1, scope, after: { ...after, id: after.id.toUpperCase() } }),
      signed({ v: 1, scope, after: { ...after, reportedAt: '2026-02-29T06:00:00.000001Z' } }),
      signed({ v: 1, scope, after: { ...after, reportedAt: '2026-10-02T06:00:00.001Z' } }),
      signed({ v: 1, scope, after: { ...after, reportedAt: '2026-10-02T06:00:00.000001+00:00' } }),
      signed({ v: 1, scope, after: { ...after, extra: true } }), signed({ v: 1, scope, after, extra: true })
    ];
    for (const value of invalid) expect(() => codec.decode(value, scope))
      .toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR', statusCode: 400 }));
    expect(isCheckoutIncidentListTimestamp('2028-02-29T23:59:59.999999Z')).toBe(true);
    expect(isCheckoutIncidentListTimestamp('2026-10-02T24:00:00.000000Z')).toBe(false);
  });

  it.each([undefined, '', 'short', ' '.repeat(32), ` ${secret}`, `${secret} `])('fails safely on unconfigured signing material', (value) => {
    expect(() => new CheckoutIncidentCursorCodec(value))
      .toThrowError(expect.objectContaining({ code: 'CHECKOUT_INCIDENT_COMMAND_FAILED', statusCode: 500 }));
  });
});

describe('checkout incident list service', () => {
  it('rechecks exact actor/session even for an empty page and never invokes legacy detail hydration', async () => {
    const { service, rpc } = serviceFor({ items: [] });
    expect(await service.list({ ...actor, profileId: actor.profileId.toUpperCase() }, {})).toEqual({ items: [], nextCursor: null });
    expect(rpc).toHaveBeenCalledExactlyOnceWith('list_checkout_presence_incidents_page', {
      p_actor_profile_id: id(1), p_session_id: sessionId, p_room_id: null, p_cleaning_target_id: null,
      p_service_date: null, p_after_reported_at: null, p_after_incident_id: null, p_limit: 50
    });
  });

  it('preserves PostgreSQL microseconds and anchors at the last returned row rather than lookahead', async () => {
    const data = [
      { items: [item(5, '2026-10-02T06:00:00.123457Z'), item(4), item(3)] },
      { items: [item(3), item(2, '2026-10-02T06:00:00.123455Z')] }
    ];
    const rpc = vi.fn(async () => ({ data: data.shift(), error: null }));
    const service = new SupabaseCheckoutIncidentService({ admin: { rpc } } as never, secret);
    const first = await service.list(actor, { limit: 2 });
    expect(first.items.map((row) => row.incidentId)).toEqual([id(5), id(4)]);
    expect(first.items.map((row) => row.reportedAt)).toEqual(['2026-10-02T06:00:00.123457Z', '2026-10-02T06:00:00.123456Z']);
    const second = await service.list(actor, { limit: 100, cursor: first.nextCursor as string });
    expect(second.items.map((row) => row.incidentId)).toEqual([id(3), id(2)]);
    expect(second.nextCursor).toBeNull();
    expect(rpc.mock.calls[1]).toEqual(['list_checkout_presence_incidents_page', expect.objectContaining({
      p_after_reported_at: '2026-10-02T06:00:00.123456Z', p_after_incident_id: id(4), p_limit: 100
    })]);
    expect(first.items[0]).not.toHaveProperty('impactFingerprint');
    expect(first.items[0]).not.toHaveProperty('reservationId');
    expect(first.items[0]).not.toHaveProperty('version');
  });

  it('binds normalized filters to the RPC and rejects cross-actor/filter cursors before querying', async () => {
    const { service, rpc } = serviceFor({ items: [item(3), item(2)] });
    const filter = { roomId: id(100).toUpperCase(), cleaningTargetId: id(101).toUpperCase(), serviceDate: '2026-09-30', limit: 1 };
    const page = await service.list(actor, filter);
    expect(rpc.mock.calls[0]).toEqual(['list_checkout_presence_incidents_page', expect.objectContaining({
      p_room_id: id(100), p_cleaning_target_id: id(101), p_service_date: '2026-09-30'
    })]);
    rpc.mockClear();
    await expect(service.list({ ...actor, profileId: id(2) }, { ...filter, cursor: page.nextCursor as string }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(service.list(actor, { ...filter, roomId: null, cursor: page.nextCursor as string }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each(['maid', 'developer'] as const)('does not grant admin collection visibility to %s', async (role) => {
    const { service, rpc } = serviceFor({ items: [] });
    await expect(service.list({ ...actor, role }, {})).rejects.toMatchObject({ code: 'ADMIN_REQUIRED', statusCode: 403 });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('requires changed passwords and valid session claims before querying', async () => {
    const { service, rpc } = serviceFor({ items: [] });
    await expect(service.list({ ...actor, mustChangePassword: true }, {})).rejects.toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED' });
    await expect(service.list({ ...actor, accessToken: 'invalid' }, {})).rejects.toMatchObject({ code: 'INVALID_ACCESS_TOKEN' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['ADMIN_REQUIRED', 403], ['PASSWORD_CHANGE_REQUIRED', 403], ['SESSION_REVOKED', 401],
    ['INVALID_CHECKOUT_INCIDENT_LIST', 400], ['private SQL PIN token', 500]
  ])('maps last-instant DB rejection %s without exposing raw detail', async (message, statusCode) => {
    const { service } = serviceFor({ items: [] }, { message: String(message) });
    await expect(service.list(actor, {})).rejects.toMatchObject({ statusCode });
    expect(checkoutIncidentDatabaseError({ message: String(message) }).message).not.toContain(String(message));
  });

  it('fails closed on oversized DB and public pages, including cursor overhead', async () => {
    const oversized = serviceFor({ items: [{ ...item(2), roomNumber: '가'.repeat(50_000) }] });
    await expect(oversized.service.list(actor, {})).rejects.toMatchObject({ code: 'CHECKOUT_INCIDENT_COMMAND_FAILED' });
    const exactItems = [item(2), item(1)];
    const overhead = Buffer.byteLength(JSON.stringify({ items: exactItems }));
    exactItems[0] = { ...item(2), roomNumber: 'a'.repeat(CHECKOUT_INCIDENT_RESPONSE_MAX_BYTES - overhead + 3) };
    expect(Buffer.byteLength(JSON.stringify({ items: exactItems }))).toBe(CHECKOUT_INCIDENT_RESPONSE_MAX_BYTES);
    const exact = serviceFor({ items: exactItems });
    await expect(exact.service.list(actor, { limit: 1 })).rejects.toMatchObject({ code: 'CHECKOUT_INCIDENT_COMMAND_FAILED' });
    expect(() => assertCheckoutIncidentListResponseSize({ value: 'a'.repeat(128 * 1024) }))
      .toThrowError(expect.objectContaining({ statusCode: 500 }));
    const normal = serviceFor({ items: [{ ...item(2), roomNumber: 'a'.repeat(1001) }] });
    expect((await normal.service.list(actor, {})).items[0]?.roomNumber).toHaveLength(1001);
  });

  it('rejects partial, duplicated, out-of-order, extra-key and inconsistent database projections', async () => {
    const malformed = [
      null, [], {}, { items: null }, { items: [], count: 0 }, { items: [item(3), item(2), item(1)] },
      { items: [{ ...item(2), guestName: 'private' }] }, { items: [{ ...item(2), status: 'resolved' }] },
      { items: [{ ...item(2), allowedDecisions: ['FALSE_REPORT', 'CONFIRM_DEPARTED', 'EXTEND_CHECKOUT'] }] },
      { items: [{ ...item(2), roomNumber: '' }] }, { items: [{ ...item(2), assignmentId: null }] },
      { items: [{ ...item(2), reportedAt: '2026-10-02T06:00:00.123Z' }] },
      { items: [{ ...item(2), reportedAt: '2026-02-29T06:00:00.123456Z' }] },
      { items: [{ ...item(2), serviceDate: '2026-04-31' }] },
      { items: [item(2), item(2)] }, { items: [item(1), item(2)] },
      { items: [item(2, '2026-10-02T06:00:00.123456Z'), item(1, '2026-10-02T06:00:00.123457Z')] }
    ];
    for (const data of malformed) {
      await expect(serviceFor(data).service.list(actor, { limit: 1 }))
        .rejects.toMatchObject({ code: 'CHECKOUT_INCIDENT_COMMAND_FAILED', statusCode: 500 });
    }
    for (const filter of [{ roomId: id(999) }, { cleaningTargetId: id(999) }, { serviceDate: '2026-10-02' }]) {
      await expect(serviceFor({ items: [item(2)] }).service.list(actor, filter)).rejects.toMatchObject({ statusCode: 500 });
    }
    const cursor = new CheckoutIncidentCursorCodec(secret).encode(scope, { reportedAt: item(2).reportedAt, id: id(2) });
    await expect(serviceFor({ items: [item(2)] }).service.list(actor, { cursor })).rejects.toMatchObject({ statusCode: 500 });
  });
});

async function appFor(role: Actor['role'] = 'admin', authError?: AppError, passwordError?: AppError) {
  const list = vi.fn(async () => ({ items: [], nextCursor: null }));
  const service: CheckoutIncidentService = {
    list, get: vi.fn(), report: vi.fn(), decide: vi.fn()
  };
  const app = Fastify();
  app.addHook('onRequest', checkoutIncidentCollectionGuard);
  app.decorateRequest('actor');
  app.decorate('authenticate', async (request) => {
    if (authError) throw authError;
    request.actor = { ...actor, role };
  });
  app.decorate('requirePasswordChanged', async () => { if (passwordError) throw passwordError; });
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof AppError ? error.statusCode : 400)
    .send({ error: { code: error instanceof AppError ? error.code : 'VALIDATION_ERROR' } }));
  await app.register(createCheckoutIncidentRoutes(service));
  return { app, list };
}

describe('checkout incident collection Fastify contract', () => {
  it('rejects implicit HEAD, wrong methods and collection slash aliases with no-store before executing a service', async () => {
    const { app, list } = await appFor();
    for (const request of [
      { method: 'HEAD' as const, url: '/v1/checkout-incidents' },
      { method: 'POST' as const, url: '/v1/checkout-incidents' },
      { method: 'PATCH' as const, url: '/v1/checkout-incidents?limit=1' },
      { method: 'PUT' as const, url: '/v1/checkout-incidents' },
      { method: 'DELETE' as const, url: '/v1/checkout-incidents' },
      { method: 'GET' as const, url: '/v1/checkout-incidents/' },
      { method: 'GET' as const, url: '/v1/checkout-incidents///?limit=1' },
      { method: 'GET' as const, url: '/v1//checkout-incidents' },
      { method: 'GET' as const, url: '//v1/checkout-incidents' },
      { method: 'GET' as const, url: '/v1/checkout-incidents/extra/path' }
    ]) {
      const response = await app.inject(request);
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(404);
      expect(response.headers['cache-control']).toBe('no-store');
    }
    expect(list).not.toHaveBeenCalled();
    await app.close();
  });

  it('installs the narrow guard before CORS in buildApp without changing unrelated routes or detail access', async () => {
    const list = vi.fn(async () => ({ items: [], nextCursor: null }));
    const get = vi.fn(async () => ({ incidentId: id(2) }));
    const authenticate = vi.fn(async () => actor);
    const origin = 'http://127.0.0.1:4173';
    const app = await buildApp({
      // Other services are inert so this exercises the production wiring without providers.
      env: { LOG_LEVEL: 'silent', corsOrigins: [origin] } as AppEnv,
      logger: false,
      services: {
        auth: { authenticate } as never, accounts: {} as never, availability: {} as never,
        rooms: {} as never, reservations: {} as never, payroll: {} as never,
        checkoutIncidents: { list, get, report: vi.fn(), decide: vi.fn() } as never
      },
      photoServices: {} as never
    });
    try {
      for (const request of [
        { method: 'HEAD' as const, url: '/v1/checkout-incidents' },
        { method: 'POST' as const, url: '/v1/checkout-incidents' },
        { method: 'GET' as const, url: '/v1/checkout-incidents/' },
        { method: 'GET' as const, url: '/v1//checkout-incidents' },
        { method: 'GET' as const, url: '/v1/checkout-incidents/extra/path' }
      ]) {
        const response = await app.inject(request);
        expect(response.statusCode).toBe(404);
        expect(response.headers['cache-control']).toBe('no-store');
      }
      expect(authenticate).not.toHaveBeenCalled();
      expect(list).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
      const preflight = await app.inject({ method: 'OPTIONS', url: '/v1/checkout-incidents',
        headers: { origin, 'access-control-request-method': 'GET' } });
      expect(preflight.statusCode).toBe(204);
      expect(preflight.headers['cache-control']).toBe('no-store');
      expect(preflight.headers['access-control-allow-origin']).toBe(origin);
      const originDenied = await app.inject({ method: 'GET', url: '/v1/checkout-incidents',
        headers: { origin: 'http://denied.invalid' } });
      expect(originDenied.statusCode).toBe(500);
      expect(originDenied.headers['cache-control']).toBe('no-store');
      const authDenied = await app.inject({ method: 'GET', url: '/v1/checkout-incidents' });
      expect(authDenied.statusCode).toBe(401);
      expect(authDenied.headers['cache-control']).toBe('no-store');
      const detail = await app.inject({ method: 'GET', url: `/v1/checkout-incidents/${id(2)}`,
        headers: { authorization: 'Bearer synthetic' } });
      expect(detail.statusCode).toBe(200);
      expect(get).toHaveBeenCalledExactlyOnceWith(actor, id(2));
      const health = await app.inject({ method: 'HEAD', url: '/health' });
      expect(health.statusCode).toBe(200);
      expect(health.headers['cache-control']).toBeUndefined();
      const unrelated = await app.inject({ method: 'POST', url: '/unrelated' });
      expect(unrelated.statusCode).toBe(404);
      expect(unrelated.headers['cache-control']).toBeUndefined();
    } finally { await app.close(); }
  });

  it('exposes the exact admin collection route with normalized query and no-store', async () => {
    const { app, list } = await appFor();
    const response = await app.inject({ method: 'GET', url: `/v1/checkout-incidents?roomId=${id(100).toUpperCase()}&limit=100` });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ items: [], nextCursor: null });
    expect(list).toHaveBeenCalledWith(actor, { roomId: id(100), cleaningTargetId: null, serviceDate: null, limit: 100, cursor: null });
    await app.close();
  });

  it('never caches authentication, password, role or query failures', async () => {
    const cases = [
      { role: 'admin' as const, auth: new AppError(401, 'INVALID_ACCESS_TOKEN', '로그인'), expected: 401 },
      { role: 'admin' as const, password: new AppError(403, 'PASSWORD_CHANGE_REQUIRED', '비밀번호'), expected: 403 },
      { role: 'maid' as const, expected: 403 }, { role: 'developer' as const, expected: 403 },
      { role: 'admin' as const, url: '/v1/checkout-incidents?status=open', expected: 400 }
    ];
    for (const test of cases) {
      const { app, list } = await appFor(test.role, test.auth, test.password);
      const response = await app.inject({ method: 'GET', url: test.url ?? '/v1/checkout-incidents' });
      expect(response.statusCode).toBe(test.expected);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(list).not.toHaveBeenCalled();
      await app.close();
    }
  });

  it('keeps no-store when the DB rejects a role, password or session changed after authentication', async () => {
    for (const [code, statusCode] of [['ADMIN_REQUIRED', 403], ['PASSWORD_CHANGE_REQUIRED', 403], ['SESSION_REVOKED', 401]] as const) {
      const { service, rpc } = serviceFor({ items: [] }, { message: code });
      const app = Fastify();
      app.decorateRequest('actor');
      app.decorate('authenticate', async (request) => { request.actor = actor; });
      app.decorate('requirePasswordChanged', async () => {});
      app.setErrorHandler((error, _request, reply) => reply.code(error instanceof AppError ? error.statusCode : 500)
        .send({ error: { code: error instanceof AppError ? error.code : 'INTERNAL_ERROR' } }));
      await app.register(createCheckoutIncidentRoutes(service));
      const response = await app.inject({ method: 'GET', url: '/v1/checkout-incidents' });
      expect(response.statusCode).toBe(statusCode);
      expect(response.json().error.code).toBe(code);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(rpc).toHaveBeenCalledOnce();
      await app.close();
    }
  });

  it('retains detail/report/decision no-query policy after adding the collection filters', async () => {
    const { app } = await appFor();
    for (const request of [
      { method: 'GET' as const, url: `/v1/checkout-incidents/${id(2)}?roomId=${id(100)}` },
      { method: 'POST' as const, url: `/v1/checkout-incidents/${id(2)}/decision?limit=1` },
      { method: 'POST' as const, url: `/v1/attempts/${id(2)}/checkout-not-completed?serviceDate=2026-10-02` }
    ]) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
    }
    await app.close();
  });
});
