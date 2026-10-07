import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '../src/domain/actor.js';
import { AppError } from '../src/lib/app-error.js';
import { createPostApprovalRoomIssueModule, type PostApprovalRoomIssueModuleServices } from '../src/modules/post-approval-room-issues/post-approval-room-issue.module.js';
import { postApprovalRoomIssueModuleOpenApiFragment } from '../src/modules/post-approval-room-issues/post-approval-room-issue-module.openapi.js';
import { openApiDocument } from '../supabase/functions/_shared/openapi.js';
const id = '10000000-0000-4000-8000-000000000001';
const base = `/v1/cleaning-history/submissions/${id}/supplemental-room-issues`;
const handover = `/v1/post-approval-room-issue-evidence-uploads/${id}/handover`;
const who: Actor = { profileId: id, authUserId: id, role: 'admin', displayName: 'synthetic', mustChangePassword: false, accessToken: 'synthetic' };
const operation = { operationId: id, evidenceId: id, status: 'accepted' as const,
  leaseVersion: 2, itemRevision: 1, evidenceRevision: 1, mimeType: 'image/jpeg' as const, sizeBytes: 3, sha256: 'a'.repeat(64) };
async function fixture() {
  const unavailable = vi.fn(async (): Promise<never> => { throw new AppError(503, 'SYNTHETIC_UNAVAILABLE', 'synthetic'); });
  const consumed: Uint8Array[] = [];
  const services: PostApprovalRoomIssueModuleServices = {
    reports: { source: unavailable, list: unavailable, draft: unavailable, saveDraft: unavailable,
      finalize: unavailable, report: unavailable, close: unavailable },
    evidence: { upload: vi.fn(async (_actor, _input, _key, read) => {
      const body = await read();
      consumed.push(new Uint8Array(await new Response(body.stream).arrayBuffer()));
      return operation;
    }), status: vi.fn(async () => operation), content: vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg' as const })) },
    handover: { recover: vi.fn(async () => operation) }
  };
  const app = Fastify({ logger: false });
  const routes: string[] = [];
  app.addHook('onRoute', route => {
    for (const method of [route.method].flat()) {
      if (method !== 'HEAD' && route.url.startsWith('/v1/')) routes.push(`${method} ${route.url.replace(/:([A-Za-z]+)/g, '{$1}')}`);
    }
  });
  app.decorateRequest('actor');
  const authenticate = vi.fn(async (request: { actor: Actor }) => { request.actor = who; });
  app.decorate('authenticate', authenticate);
  app.decorate('requirePasswordChanged', async () => {});
  app.post('/sibling-json', async request => request.body);
  await app.register(createPostApprovalRoomIssueModule(services));
  return { app, services, consumed, authenticate, unavailable, routes };
}
describe('supplemental registered source module composition', () => {
  it('documents every registered module operation exactly once without advertising it as deployed', async () => {
    const f = await fixture();
    try {
      await f.app.ready();
      const paths = postApprovalRoomIssueModuleOpenApiFragment.paths;
      const operations: { path: string; method: string; operation: {
        operationId: string; security: unknown; 'x-implementation-status': string;
        parameters: readonly { in: string; name: string }[];
      } }[] = Object.entries(paths).flatMap(([path, item]) => Object.entries(item).map(([method, operation]) => ({
        path, method, operation
      })));
      expect(Object.keys(paths)).toHaveLength(10);
      expect(operations).toHaveLength(11);
      expect(operations.map(({ path, method }) => `${method.toUpperCase()} ${path}`).sort()).toEqual(f.routes.sort());
      const registeredIds = Object.values(openApiDocument.paths).flatMap(item => Object.values(item))
        .flatMap(value => value && typeof value === 'object' && 'operationId' in value ? [value.operationId] : []);
      const ids = operations.map(({ operation }) => operation.operationId);
      expect(new Set(ids).size).toBe(11);
      for (const { path, operation } of operations) {
        expect(openApiDocument.paths).toHaveProperty(path);
        expect(registeredIds.filter(id => id === operation.operationId)).toHaveLength(1);
        expect(operation.security).toEqual([{ bearerAuth: [] }]);
        expect(operation['x-implementation-status']).toBe('source-registered-not-deployed');
        const parameters = operation.parameters.filter(parameter => parameter.in === 'path').map(parameter => parameter.name).sort();
        expect(parameters).toEqual([...path.matchAll(/\{([^}]+)\}/g)].map(match => match[1]).sort());
      }
    } finally { await f.app.close(); }
  });
  it('isolates the binary parser from handover, report and parent JSON parsers', async () => {
    const f = await fixture();
    try {
      const jsonHeaders = { 'idempotency-key': 'synthetic-key-001' };
      const upload = await f.app.inject({ method: 'POST', url: `${base}/drafts/${id}/evidence/${id}/upload`,
        headers: { ...jsonHeaders, 'content-type': 'image/jpeg', 'if-draft-revision': '1', 'if-evidence-revision': '0', 'if-item-revision': '0' }, payload: Buffer.from([1, 2, 3]) });
      expect(upload.statusCode).toBe(200); expect(f.consumed).toEqual([new Uint8Array([1, 2, 3])]);
      const transfer = await f.app.inject({ method: 'POST', url: handover, headers: jsonHeaders, payload: { expectedLeaseVersion: 1 } });
      expect(transfer.statusCode).toBe(200);
      expect(f.services.handover.recover).toHaveBeenCalledWith(who, { operationId: id, expectedLeaseVersion: 1 }, 'synthetic-key-001');
      const close = await f.app.inject({ method: 'POST', url: `${base}/${id}/close`, headers: jsonHeaders, payload: { expectedClosureRevision: 0 } });
      expect(close.statusCode).toBe(500); // Unknown service sentinel is sanitized; service call below proves JSON parsing.
      expect(f.services.reports.close).toHaveBeenCalledWith(who, { sourceSubmissionId: id, reportId: id, expectedClosureRevision: 0 }, 'synthetic-key-001');
      const sibling = await f.app.inject({ method: 'POST', url: '/sibling-json', payload: { value: true } });
      expect(sibling.json()).toEqual({ value: true }); expect(sibling.headers['cache-control']).toBeUndefined();
      expect(f.authenticate).toHaveBeenCalledTimes(3);
    } finally { await f.app.close(); }
  });
  it('keeps JSON body limits after registering the raw upload parser', async () => {
    const f = await fixture();
    try {
      const result = await f.app.inject({ method: 'POST', url: handover, headers: { 'idempotency-key': 'synthetic-key-001' }, payload: { extra: 'x'.repeat(2048) } });
      expect(result.statusCode).toBe(413); expect(f.services.handover.recover).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
});
