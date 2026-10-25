import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '../src/domain/actor.js';
import { AppError } from '../src/lib/app-error.js';
import { postApprovalRoomIssueHandoverOpenApiFragment } from '../src/modules/post-approval-room-issues/post-approval-room-issue-evidence.openapi.js';
import { createPostApprovalHandoverRoutes, POST_APPROVAL_HANDOVER_PATH } from '../src/modules/post-approval-room-issues/post-approval-room-issue-handover.routes.js';
const id = '10000000-0000-4000-8000-000000000001';
const actor: Actor = { profileId: id, authUserId: id, role: 'admin', displayName: 'synthetic', mustChangePassword: false, accessToken: 'verified' };
const operation = { operationId: id, evidenceId: id, status: 'provider_succeeded' as const,
  leaseVersion: 2, itemRevision: 0, evidenceRevision: 0, mimeType: 'image/jpeg' as const, sizeBytes: 3, sha256: 'a'.repeat(64) };
async function setup(who = actor, denial?: Error, authDenial?: Error, logs?: string[]) {
  const recover = vi.fn(async () => { if (denial) throw denial; return { ...operation, fence: 'secret-canary' }; });
  const app = Fastify({ logger: logs ? { level: 'trace', stream: { write: (line: string) => { logs.push(line); } } } : false });
  app.decorateRequest('actor');
  app.decorate('authenticate', async request => { if (authDenial) throw authDenial; request.actor = who; });
  app.decorate('requirePasswordChanged', async request => {
    if (request.actor.mustChangePassword) throw new AppError(403, 'PASSWORD_CHANGE_REQUIRED', 'secret-canary');
  });
  await app.register(createPostApprovalHandoverRoutes({ recover }));
  const send = (payload: unknown = { expectedLeaseVersion: 1 }, headers = { 'idempotency-key': 'synthetic-key-001' }, suffix = '') =>
    app.inject({ method: 'POST', url: POST_APPROVAL_HANDOVER_PATH.replace(':operationId', id) + suffix,
      headers, payload: payload as Record<string, unknown> });
  return { app, recover, send };
}
describe('isolated administrator evidence handover HTTP', () => {
  it('documents the exact unregistered administrator handover contract', async () => {
    const paths = postApprovalRoomIssueHandoverOpenApiFragment.paths;
    expect(Object.keys(paths)).toEqual([POST_APPROVAL_HANDOVER_PATH.replace(':operationId', '{operationId}')]);
    const entry = Object.values(paths)[0];
    if (!entry) throw new Error('missing handover contract');
    const spec = entry.post;
    expect(spec.security).toEqual([{ bearerAuth: [] }]);
    expect(spec['x-required-roles']).toEqual(['admin']);
    expect(spec['x-query-allowed']).toBe(false);
    expect(spec['x-implementation-status']).toBe('deployed');
    expect(spec['x-deployed-release']).toBe('v0.9.0');
    expect(spec.parameters.map(p => [p.name, p.in, p.required])).toEqual([
      ['operationId', 'path', true], ['Idempotency-Key', 'header', true]
    ]);
    expect(spec.parameters[1]).toMatchObject({ 'x-single-header': true,
      schema: { minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' } });
    expect(spec.requestBody['x-max-bytes']).toBe(1024);
    expect(spec.requestBody.content['application/json'].schema).toEqual({ type: 'object',
      additionalProperties: false, required: ['expectedLeaseVersion'],
      properties: { expectedLeaseVersion: { type: 'integer', minimum: 0, maximum: 7 } } });
    const f = await setup();
    try {
      const r = await f.send();
      expect(r.statusCode).toBe(200);
      const success = spec.responses['200'];
      expect(Object.keys(success.content['application/json'].schema.properties).sort()).toEqual(Object.keys(r.json()).sort());
      expect(success.headers['Cache-Control'].schema.const).toBe(r.headers['cache-control']);
      expect(success.content['application/json'].schema.additionalProperties).toBe(false);
      for (const status of ['400', '401', '403', '409', '413', '415', '429', '500', '503']) {
        expect(Object.hasOwn(spec.responses, status)).toBe(true);
      }
    } finally { await f.app.close(); }
  });
  it('does not log rejected raw query secrets with request logging enabled', async () => {
    const logs: string[] = [];
    const f = await setup(actor, undefined, undefined, logs);
    try {
      f.app.log.info('logger-control');
      const response = await f.send({ expectedLeaseVersion: 1 }, undefined, '?token=synthetic-secret-canary');
      expect(response.statusCode).toBe(400);
      expect(f.recover).not.toHaveBeenCalled();
      expect(response.body).not.toContain('synthetic-secret-canary');
    } finally { await f.app.close(); }
    expect(logs.join('')).toContain('logger-control');
    expect(logs.join('')).not.toContain('synthetic-secret-canary');
  });
  it('rejects oversized JSON before service', async () => {
    const f = await setup(); try {
      expect((await f.send({ extra: 'x'.repeat(2048) })).statusCode).toBe(413);
      expect(f.recover).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it('rejects duplicate raw idempotency headers', async () => {
    const f = await setup();
    f.app.addHook('onRequest', async request => { request.raw.rawHeaders.push('Idempotency-Key', 'synthetic-key-001'); });
    try { expect((await f.send()).statusCode).toBe(400); expect(f.recover).not.toHaveBeenCalled(); }
    finally { await f.app.close(); }
  });
  it.each([{ operationId: '10000000-0000-4000-8000-000000000002' }, { leaseVersion: 1 }])
    ('rejects mismatched service projection %s', async change => {
      const f = await setup(); f.recover.mockResolvedValueOnce({ ...operation, ...change, fence: 'secret-canary' });
      try { const r = await f.send(); expect(r.statusCode).toBe(500); expect(r.body).not.toContain('secret-canary'); }
      finally { await f.app.close(); }
    });
  it('passes authenticated actor and strict input, and strips internal output', async () => {
    const f = await setup(); try {
      const response = await f.send(); expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(operation); expect(response.headers['cache-control']).toBe('no-store');
      expect(f.recover).toHaveBeenCalledWith(actor, { operationId: id, expectedLeaseVersion: 1 }, 'synthetic-key-001');
    } finally { await f.app.close(); }
  });
  it.each(['maid', 'developer'] as const)('rejects %s before service', async role => {
    const f = await setup({ ...actor, role }); try {
      expect((await f.send()).statusCode).toBe(403); expect(f.recover).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it('rejects password-change-required and revoked session', async () => {
    for (const f of [await setup({ ...actor, mustChangePassword: true }),
      await setup(actor, undefined, new AppError(401, 'SESSION_REVOKED', 'secret-canary'))]) {
      try { const r = await f.send(); expect([401, 403]).toContain(r.statusCode);
        expect(r.body).not.toContain('secret-canary'); expect(f.recover).not.toHaveBeenCalled();
      } finally { await f.app.close(); }
    }
  });
  it.each([{}, { expectedLeaseVersion: 8 }, { expectedLeaseVersion: '1' },
    { expectedLeaseVersion: 1, operationId: id }, { expectedLeaseVersion: 1, actorProfileId: id },
    { expectedLeaseVersion: 1, fence: 'secret-canary' }])('rejects invalid body %s', async payload => {
    const f = await setup(); try { expect((await f.send(payload)).statusCode).toBe(400); expect(f.recover).not.toHaveBeenCalled(); }
    finally { await f.app.close(); }
  });
  it('rejects missing key and query parameters', async () => {
    const f = await setup(); try {
      expect((await f.send({}, {} as { 'idempotency-key': string })).statusCode).toBe(400);
      expect((await f.send({ expectedLeaseVersion: 1 }, undefined, '?force=true')).statusCode).toBe(400);
      expect(f.recover).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it.each([new Error('secret-canary'), new AppError(409, 'PHOTO_UPLOAD_FENCE_CONFLICT', 'secret-canary')])
    ('sanitizes failure', async error => {
      const f = await setup(actor, error); try {
        const r = await f.send(); expect(r.statusCode).toBe(error instanceof AppError ? 409 : 500);
        expect(r.body).not.toContain('secret-canary'); expect(r.headers['cache-control']).toBe('no-store');
      } finally { await f.app.close(); }
    });
});
