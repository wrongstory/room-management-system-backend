import { describe, expect, it } from 'vitest';
import { projectLimitedAttempt, projectLimitedDiscovery } from '../src/modules/limited-attempts/limited-attempt-contract.js';
import Fastify from 'fastify';
import { AppError } from '../src/lib/app-error.js';
import { createLimitedAttemptRoutes, limitedAttemptPathGuard } from '../src/modules/limited-attempts/limited-attempt.routes.js';
import { LimitedAttemptService, limitedDatabaseError } from '../src/modules/limited-attempts/limited-attempt.service.js';
import { PhotoError } from '../src/modules/photos/photo-binary.js';
import type { PhotoIdentity, PhotoRpc } from '../src/modules/photos/photo-service.js';
import { openApiDocument } from '../supabase/functions/_shared/openapi.js';

const id = (n: number) => `69000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const item = () => ({ attemptId: id(1), assignmentId: id(2), assignmentRevision: 3,
  executionVersion: 2, status: 'in_progress', kind: 'finish_current',
  allowedActions: ['complete_field_work'], issuedAt: '2026-10-03T00:00:00Z', expiresAt: '2026-10-03T02:00:00Z' });
const page = () => ({ profileStatus: 'deactivation_pending', evaluatedAt: '2026-10-03T01:00:00Z', items: [item()] });

describe('limited discovery public contract', () => {
  it('publishes exact bounded DTOs and authenticated no-store routes without caller session/query', () => {
    const schemas = openApiDocument.components.schemas;
    expect(schemas.LimitedAttemptDiscoveryItem.required).toEqual(Object.keys(item()));
    expect(Object.keys(schemas.LimitedAttemptDiscoveryItem.properties)).toEqual(Object.keys(item()));
    expect(schemas.LimitedAttemptDiscoveryItem.additionalProperties).toBe(false);
    expect(schemas.LimitedAttemptDiscovery.required).toEqual(['profileStatus', 'evaluatedAt', 'items']);
    expect(schemas.LimitedAttemptDiscovery.properties.items.maxItems).toBe(1000);
    const route = openApiDocument.paths['/v1/limited/attempts'].get;
    expect(route.operationId).toBe('listLimitedAttempts'); expect(route['x-required-roles']).toEqual(['maid']);
    expect(route.security).toEqual([{ bearerAuth: [] }]); expect(route).not.toHaveProperty('parameters');
    expect(route.responses['200'].headers['Cache-Control'].schema.const).toBe('no-store');
    expect(schemas.ErrorCode.enum).toEqual(expect.arrayContaining(['LIMITED_DISCOVERY_LIMIT_EXCEEDED', 'LIMITED_SESSION_LIMIT_EXCEEDED']));
  });
  it('projects exactly the bounded public metadata without private fields', () => {
    const raw = page();
    const result = projectLimitedDiscovery({ ...raw, sessionId: id(9), roomNumber: 'private',
      items: [{ ...item(), capabilityId: id(9), pin: 'private', sessionDigest: 'private', guestName: 'private' }] });
    expect(result).toEqual(raw);
    expect(Object.keys(result.items[0] ?? {})).toHaveLength(9);
  });
  it.each([
    { profileStatus: 'inactive' }, { profileStatus: ['deactivation_pending'] }, { profileStatus: {} }, { evaluatedAt: '2026-02-30T01:00:00Z' },
    { items: Array.from({ length: 1001 }, item) }, { items: [{ ...item(), executionVersion: 0 }] },
    { items: [{ ...item(), kind: 'finish_current', allowedActions: ['submit'] }] },
    { items: [{ ...item(), expiresAt: '2026-10-03T01:00:00Z' }] },
    { items: [{ ...item(), issuedAt: '2026-10-03T01:30:00Z' }] },
    { items: [{ ...item(), status: 'approved' }] },
    { profileStatus: 'upload_only', items: [{ ...item(), status: ['upload_pending'], kind: 'upload_submit', allowedActions: ['upload_evidence', 'validate_evidence', 'submit'] }] },
    { items: [{ ...item(), status: {} }] },
  ])('rejects malformed or non-live projections %#', (override) => {
    expect(() => projectLimitedDiscovery({ ...page(), ...override })).toThrow();
  });
  it('returns an eligible empty list without inventing a grant', () => {
    expect(projectLimitedDiscovery({ ...page(), items: [] }).items).toEqual([]);
  });
  it('preserves PostgreSQL sub-millisecond inclusive/exclusive boundaries', () => {
    const raw = page();
    raw.evaluatedAt = '2026-10-03T01:00:00.000001Z';
    raw.items[0] = { ...item(), issuedAt: '2026-10-03T01:00:00.000001Z', expiresAt: '2026-10-03T01:00:00.000002Z' };
    expect(projectLimitedDiscovery(raw).items).toHaveLength(1);
    expect(() => projectLimitedDiscovery({ ...raw, evaluatedAt: '2026-10-03T01:00:00.000002Z' })).toThrow();
  });
  it('rejects duplicate and unsorted attempt identities instead of partial success', () => {
    expect(() => projectLimitedDiscovery({ ...page(), items: [item(), item()] })).toThrow();
    expect(() => projectLimitedDiscovery({ ...page(), items: [{ ...item(), attemptId: id(2) }, item()] })).toThrow();
  });
});

const identity: PhotoIdentity = { profileId: id(90), sessionId: id(91), role: 'maid', profileStatus: 'deactivation_pending' };
const attempt = () => ({ attemptId: id(1), cleaningTargetId: id(5), assignmentId: id(2), maidProfileId: id(90),
  assignmentRevision: 3, executionVersion: 2, status: 'in_progress', startedAt: '2026-10-03T00:00:00Z',
  fieldCompletedAt: null, endedAt: null, effectiveAt: '2026-10-03T00:00:00Z', recordedAt: '2026-10-03T00:00:00Z' });
const single = () => ({ attempt: attempt(), capability: { attemptId: id(1), assignmentId: id(2), assignmentRevision: 3,
  kind: 'finish_current', allowedActions: ['complete_field_work'], issuedAt: '2026-10-03T00:00:00Z', expiresAt: '2026-10-03T02:00:00Z',
  capabilityId: id(7), revokedAt: null }, profileStatus: 'deactivation_pending' });
async function appFor(data: unknown = page(), options: { identity?: PhotoIdentity; authCode?: string; rpcCode?: string } = {}) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const db: PhotoRpc = { rpc: async (name, args) => { calls.push({ name, args }); return { data, error: options.rpcCode ? { message: options.rpcCode } : null }; } };
  const app = Fastify({ logger: false });
  app.addHook('onRequest', limitedAttemptPathGuard);
  app.setErrorHandler((error, _request, reply) => error instanceof AppError
    ? reply.code(error.statusCode).send({ error: { code: error.code } })
    : reply.code(error && typeof error === 'object' && 'issues' in error ? 400 : 500).send({ error: { code: 'VALIDATION_ERROR' } }));
  await app.register(createLimitedAttemptRoutes(new LimitedAttemptService(db), async () => {
    if (options.authCode) throw new PhotoError(options.authCode === 'PASSWORD_CHANGE_REQUIRED' ? 403 : 401, options.authCode);
    return options.identity ?? identity;
  }));
  return { app, calls };
}
describe('Fastify existing-session limited routes', () => {
  it('registers discovery and passes only verified actor/session; no-store strips private data', async () => {
    const { app, calls } = await appFor({ ...page(), pin: 'private', items: [{ ...item(), sessionId: 'private' }] });
    const response = await app.inject({ method: 'GET', url: '/v1/limited/attempts' });
    expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual(page());
    expect(calls).toEqual([{ name: 'list_limited_cleaning_attempts', args: { p_actor_profile_id: id(90), p_session_id: id(91) } }]);
    await app.close();
  });
  it.each(['MISSING_ACCESS_TOKEN', 'INVALID_ACCESS_TOKEN', 'SESSION_REVOKED', 'PASSWORD_CHANGE_REQUIRED'])('stops %s before business RPC', async (authCode) => {
    const { app, calls } = await appFor(page(), { authCode });
    const response = await app.inject({ method: 'GET', url: '/v1/limited/attempts' });
    expect(response.statusCode).toBe(authCode === 'PASSWORD_CHANGE_REQUIRED' ? 403 : 401);
    expect(response.headers['cache-control']).toBe('no-store'); expect(calls).toEqual([]); await app.close();
  });
  it.each(['admin', 'developer', 'inactive', 'departed'])('denies disallowed persona %s before business RPC', async (value) => {
    const denied = ['admin', 'developer'].includes(value) ? { ...identity, role: value as 'admin' | 'developer' } : { ...identity, profileStatus: value };
    const { app, calls } = await appFor(page(), { identity: denied });
    expect((await app.inject({ method: 'GET', url: '/v1/limited/attempts' })).statusCode).toBe(403);
    expect(calls).toEqual([]); await app.close();
  });
  it.each(['CAPABILITY_ACCESS_REQUIRED', 'SESSION_REVOKED', 'PASSWORD_CHANGE_REQUIRED', 'LIMITED_DISCOVERY_LIMIT_EXCEEDED', 'LIMITED_SESSION_LIMIT_EXCEEDED'])('maps the late SQL decision %s without raw leakage', async (rpcCode) => {
    const { app } = await appFor(page(), { rpcCode });
    const response = await app.inject({ method: 'GET', url: '/v1/limited/attempts' });
    expect(response.statusCode).toBe(limitedDatabaseError({ message: rpcCode }).statusCode);
    expect(response.json()).toEqual({ error: { code: rpcCode } }); expect(response.headers['cache-control']).toBe('no-store'); await app.close();
  });
  it('rejects query/encoded aliases and different latest profile before returning data', async () => {
    for (const url of ['/v1/limited/attempts?limit=1', '/v1/limited/attempts?actor=private', `/v1/limited/attempts/%36${id(1).slice(1)}?assignmentRevision=3`]) {
      const { app, calls } = await appFor();
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(url.includes('%') ? 404 : 400);
      expect(calls).toEqual([]); await app.close();
    }
    const { app } = await appFor({ ...page(), profileStatus: 'upload_only', items: [] });
    expect((await app.inject({ method: 'GET', url: '/v1/limited/attempts' })).statusCode).toBe(500); await app.close();
  });
  it('rejects encoded collection aliases and unknown limited paths before authentication with no-store', async () => {
    for (const url of ['/v1/%6cimited/attempts', '/v1/limited/%61ttempts', '/v1/limited/attempts/', '/v1//limited/attempts', '//v1/limited/attempts', `/v1/limited/attempts/${id(1)}/start`]) {
      const { app, calls } = await appFor(page(), { authCode: 'MISSING_ACCESS_TOKEN' });
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(404); expect(response.headers['cache-control']).toBe('no-store');
      expect(calls).toEqual([]); await app.close();
    }
  });
  it('rejects implicit HEAD and wrong method aliases without auth or RPC', async () => {
    for (const [method, url] of [['HEAD', '/v1/limited/attempts'], ['POST', '/v1/limited/attempts'], ['GET', `/v1/limited/attempts/${id(1)}/complete-field-work`]] as const) {
      const { app, calls } = await appFor(page(), { authCode: 'MISSING_ACCESS_TOKEN' });
      const response = await app.inject({ method, url });
      expect(response.statusCode).toBe(404); expect(response.headers['cache-control']).toBe('no-store'); expect(calls).toEqual([]);
      await app.close();
    }
  });
  it('single DTO rejects array/object profile and attempt status rather than coercing types', () => {
    for (const value of [['deactivation_pending'], {}]) expect(() => projectLimitedAttempt({ ...single(), profileStatus: value }, id(90))).toThrow();
    for (const value of [['in_progress'], {}]) expect(() => projectLimitedAttempt({ ...single(), attempt: { ...attempt(), status: value } }, id(90))).toThrow();
    for (const value of [['finish_current'], {}]) expect(() => projectLimitedAttempt({ ...single(), capability: { ...single().capability, kind: value } }, id(90))).toThrow();
  });
  it('preserves exact single lookup and denies mismatched IDOR projection', async () => {
    const { app, calls } = await appFor(single());
    const response = await app.inject({ method: 'GET', url: `/v1/limited/attempts/${id(1)}?assignmentRevision=3` });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual(single());
    expect(calls[0]?.args).toEqual({ p_actor_profile_id: id(90), p_session_id: id(91), p_attempt_id: id(1), p_assignment_revision: 3 });
    expect((await app.inject({ method: 'GET', url: `/v1/limited/attempts/${id(8)}?assignmentRevision=3` })).statusCode).toBe(500);
    await app.close();
  });
  it('completion uses the same Edge hash shape/order and replay does not invoke ordinary active auth', async () => {
    const result = { ...single(), attempt: { ...attempt(), executionVersion: 3, status: 'field_completed', fieldCompletedAt: '2026-10-03T01:00:00Z', endedAt: '2026-10-03T01:00:00Z' },
      capability: { ...single().capability, kind: 'upload_submit', allowedActions: ['upload_evidence', 'validate_evidence', 'submit'] },
      profileStatus: 'upload_only', profileVersion: 2, nextAttempt: null, effectiveAt: '2026-10-03T01:00:00Z', recordedAt: '2026-10-03T01:00:00Z' };
    const { app, calls } = await appFor(result);
    const payload = { expectedExecutionVersion: 2, expectedAssignmentId: id(2), expectedAssignmentRevision: 3 };
    const hash = '49248f20339b56cca0f12f12f3d26afe64f48194996bc92d2e0716e7531644e3';
    for (let n = 0; n < 2; n++) {
      const response = await app.inject({ method: 'POST', url: `/v1/limited/attempts/${id(1)}/complete-field-work`, headers: { 'idempotency-key': 'limited-replay-01' }, payload });
      expect(response.statusCode).toBe(200); expect(response.json()).toEqual(result); expect(response.headers['cache-control']).toBe('no-store');
    }
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ name: 'complete_limited_cleaning_attempt_field_work', args: {
      p_actor_profile_id: id(90), p_session_id: id(91), p_attempt_id: id(1), p_expected_execution_version: 2,
      p_expected_assignment_id: id(2), p_expected_assignment_revision: 3, p_idempotency_key: 'limited-replay-01', p_request_hash: hash,
    } }); await app.close();
  });
});
