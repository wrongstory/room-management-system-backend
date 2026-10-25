import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '../src/domain/actor.js';
import { createPostApprovalHandoverRoutes, POST_APPROVAL_HANDOVER_PATH } from '../src/modules/post-approval-room-issues/post-approval-room-issue-handover.routes.js';
import { SupabasePostApprovalRoomIssueHandoverService } from '../src/modules/post-approval-room-issues/post-approval-room-issue-handover.service.js';

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = (session = id(2)): Actor => ({ authUserId: id(11), profileId: id(1), role: 'admin',
  displayName: 'synthetic', mustChangePassword: false,
  accessToken: `verified.${Buffer.from(JSON.stringify({ session_id: session })).toString('base64url')}.signature` });
const operation = { operationId: id(3), evidenceId: id(4), status: 'provider_succeeded' as const,
  leaseVersion: 2, itemRevision: 0, evidenceRevision: 0, mimeType: 'image/jpeg' as const,
  sizeBytes: 3, sha256: 'a'.repeat(64) };

// Real HTTP + handover adapter; auth/RPC/provider boundaries are synthetic, NOT an E2E DB test.
async function setup(recoveryConfigured = true) {
  let currentActor = actor();
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> =>
    ({ data: { ...operation, providerFileId: 'private-canary' }, error: null }));
  const recoverHandover = vi.fn(async () => ({ ...operation, status: 'accepted' as const,
    itemRevision: 1, evidenceRevision: 1, fence: 'private-canary' }));
  const service = new SupabasePostApprovalRoomIssueHandoverService({ rpc }, new Uint8Array(32).fill(73),
    recoveryConfigured ? { recoverHandover } : undefined);
  const app = Fastify({ logger: false });
  app.decorateRequest('actor');
  app.decorate('authenticate', async request => { request.actor = currentActor; });
  app.decorate('requirePasswordChanged', async () => {});
  await app.register(createPostApprovalHandoverRoutes(service));
  const send = () => app.inject({ method: 'POST', url: POST_APPROVAL_HANDOVER_PATH.replace(':operationId', id(3)),
    headers: { 'idempotency-key': 'integration-key-001' }, payload: { expectedLeaseVersion: 1 } });
  return { app, rpc, recoverHandover, send, setActor: (value: Actor) => { currentActor = value; } };
}

describe('handover HTTP and real service composition', () => {
  it('binds current session but preserves receipt/fence across session replacement', async () => {
    const f = await setup();
    try {
      for (const session of [id(2), id(20)]) {
        f.setActor(actor(session));
        const r = await f.send();
        expect(r.statusCode).toBe(200); expect(r.json().status).toBe('accepted');
        expect(r.headers['cache-control']).toBe('no-store');
        expect(r.body).not.toContain('private-canary');
      }
      const first = f.rpc.mock.calls[0]?.[1], second = f.rpc.mock.calls[1]?.[1];
      expect(first).toMatchObject({ p_actor_profile_id: id(1), p_session_id: id(2), p_operation_id: id(3) });
      expect(second).toEqual({ ...first, p_session_id: id(20) });
      expect(f.rpc.mock.calls.map(call => call[0])).toEqual(Array(2).fill('handover_post_approval_room_issue_evidence_upload'));
      expect(f.recoverHandover).toHaveBeenLastCalledWith(actor(id(20)), operation, second?.p_fence_token_digest);
    } finally { await f.app.close(); }
  });
  it('rechecks DB authorization on replay and never recovers a revoked session', async () => {
    const f = await setup();
    try {
      expect((await f.send()).statusCode).toBe(200);
      f.rpc.mockResolvedValueOnce({ data: null, error: { message: 'SESSION_REVOKED', details: 'private-canary' } });
      const r = await f.send();
      expect(r.statusCode).toBe(401); expect(r.json().error.code).toBe('SESSION_REVOKED');
      expect(r.body).not.toContain('private-canary');
      expect(f.rpc).toHaveBeenCalledTimes(2); expect(f.recoverHandover).toHaveBeenCalledTimes(1);
    } finally { await f.app.close(); }
  });
  it('fails before ownership RPC when recovery is not configured', async () => {
    const f = await setup(false);
    try { expect((await f.send()).statusCode).toBe(503); expect(f.rpc).not.toHaveBeenCalled(); }
    finally { await f.app.close(); }
  });
  it('retries a lost RPC response with identical receipt and fence', async () => {
    const f = await setup();
    try {
      f.rpc.mockRejectedValueOnce(new Error('private-canary'));
      const failed = await f.send(); expect(failed.statusCode).toBe(500); expect(failed.body).not.toContain('private-canary');
      expect(f.recoverHandover).not.toHaveBeenCalled();
      expect((await f.send()).statusCode).toBe(200);
      expect(f.rpc.mock.calls[0]).toEqual(f.rpc.mock.calls[1]);
    } finally { await f.app.close(); }
  });
  it('rejects an authenticated actor without session binding before RPC', async () => {
    const f = await setup(); f.setActor({ ...actor(), accessToken: 'invalid' });
    try { expect((await f.send()).statusCode).toBe(401); expect(f.rpc).not.toHaveBeenCalled(); }
    finally { await f.app.close(); }
  });
});
