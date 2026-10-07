import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '../src/domain/actor.js';
import type { SupabaseClients } from '../src/lib/supabase.js';
import { createLazyPostApprovalRoomIssueRuntime, createPostApprovalRoomIssueRuntime } from '../src/modules/post-approval-room-issues/post-approval-room-issue.runtime.js';
import { SupabasePostApprovalRoomIssueEvidenceService } from '../src/modules/post-approval-room-issues/post-approval-room-issue-evidence.service.js';
import { createPhotoRuntimeDependencies } from '../src/modules/photos/photo.runtime.js';
import { createHmac } from 'node:crypto';
import { preparePostApprovalRoomIssueHandover } from '../src/modules/post-approval-room-issues/post-approval-room-issue-handover-contract.js';
const id = '10000000-0000-4000-8000-000000000001';
const actor: Actor = { profileId: id, authUserId: id, role: 'admin', displayName: 'synthetic', mustChangePassword: false,
  accessToken: `verified.${Buffer.from(JSON.stringify({ session_id: id })).toString('base64url')}.signature` };
function fixture() {
  const transport = vi.fn(async (): Promise<Response> => { throw new Error('unexpected network'); });
  const admin = createClient('http://127.0.0.1:54321', 'synthetic-key', {
    auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: transport }
  });
  const clients: SupabaseClients = { admin, publicClient: admin, forAccessToken: () => admin };
  const provider = vi.fn((): never => { throw new Error('unexpected provider'); });
  const initializeDecoder = vi.fn(async () => {});
  return { dependencies: { clients, provider, initializeDecoder, handoverFenceKey: new Uint8Array(32).fill(73) }, transport };
}
describe('supplemental runtime construction', () => {
  it('constructs shared photo dependencies without requiring Drive configuration or starting the decoder', () => {
    const network = vi.spyOn(globalThis, 'fetch');
    try {
      const shared = createPhotoRuntimeDependencies({});
      expect(Object.isFrozen(shared)).toBe(true);
      const runtime = createPostApprovalRoomIssueRuntime({ clients: fixture().dependencies.clients, ...shared });
      expect(runtime.reports).toBeDefined(); expect(runtime.evidence).toBeDefined();
      expect(network).not.toHaveBeenCalled();
      expect(() => shared.provider()).toThrow();
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
  it('shares the same lazy provider and decoder promise across consumers', async () => {
    const network = vi.spyOn(globalThis, 'fetch');
    try {
      const shared = createPhotoRuntimeDependencies({ GOOGLE_DRIVE_CLIENT_ID: 'synthetic-client',
        GOOGLE_DRIVE_CLIENT_SECRET: 'synthetic-secret', GOOGLE_DRIVE_REFRESH_TOKEN: 'synthetic-refresh',
        GOOGLE_DRIVE_ROOT_FOLDER_ID: 'synthetic-root-folder' });
      expect(network).not.toHaveBeenCalled();
      expect(shared.provider()).toBe(shared.provider());
      const initialization = shared.initializeDecoder();
      expect(shared.initializeDecoder()).toBe(initialization);
      await initialization;
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
  it('does not contact DB/provider or initialize decoder during construction', () => {
    const f = fixture(); const runtime = createPostApprovalRoomIssueRuntime(f.dependencies);
    expect(Object.keys(runtime).sort()).toEqual(['evidence', 'handover', 'reports']);
    expect(Object.isFrozen(runtime)).toBe(true);
    expect(f.transport).not.toHaveBeenCalled(); expect(f.dependencies.provider).not.toHaveBeenCalled();
    expect(f.dependencies.initializeDecoder).not.toHaveBeenCalled();
  });
  it.each([0, 31, 33])('lazily rejects invalid %i-byte key before any external work', async length => {
    const f = fixture(); f.dependencies.handoverFenceKey = new Uint8Array(length);
    const runtime = createPostApprovalRoomIssueRuntime(f.dependencies);
    await expect(runtime.handover.recover(actor, { operationId: id, expectedLeaseVersion: 1 }, 'synthetic-key-001'))
      .rejects.toMatchObject({ statusCode: 503, code: 'POST_APPROVAL_ROOM_ISSUE_EVIDENCE_RETRY_REQUIRED' });
    expect(f.transport).not.toHaveBeenCalled(); expect(f.dependencies.provider).not.toHaveBeenCalled();
    expect(f.dependencies.initializeDecoder).not.toHaveBeenCalled();
  });
  it('keeps report source and upload status readable without a handover key', async () => {
    const f = fixture(), { handoverFenceKey: _unused, ...dependencies } = f.dependencies;
    const operation = { operationId: id, evidenceId: id, status: 'reserved' as const,
      leaseVersion: 0, itemRevision: 0, evidenceRevision: 0, mimeType: 'image/jpeg' as const, sizeBytes: 3, sha256: 'a'.repeat(64) };
    f.transport.mockResolvedValueOnce(new Response(JSON.stringify({ source: {
      sourceSubmissionId: id, originalPerformerProfileId: id, sourceStatus: 'approved'
    } }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(operation), { status: 200, headers: { 'content-type': 'application/json' } }));
    const initialize = vi.fn(() => createPostApprovalRoomIssueRuntime(dependencies));
    const runtime = createLazyPostApprovalRoomIssueRuntime(initialize);
    expect(initialize).not.toHaveBeenCalled(); expect(f.transport).not.toHaveBeenCalled();
    await expect(runtime.reports.source(actor, id)).resolves.toMatchObject({ source: { sourceSubmissionId: id } });
    await expect(runtime.evidence.status(actor, id)).resolves.toEqual(operation);
    expect(f.transport).toHaveBeenCalledTimes(2);
    expect(initialize).toHaveBeenCalledOnce();
    await expect(runtime.handover.recover(actor, { operationId: id, expectedLeaseVersion: 1 }, 'synthetic-key-001'))
      .rejects.toMatchObject({ statusCode: 503, code: 'POST_APPROVAL_ROOM_ISSUE_EVIDENCE_RETRY_REQUIRED' });
    expect(f.transport).toHaveBeenCalledTimes(2);
    expect(f.dependencies.provider).not.toHaveBeenCalled(); expect(f.dependencies.initializeDecoder).not.toHaveBeenCalled();
  });
  it('preserves actor and request guards before the absent-key boundary', async () => {
    const f = fixture(), { handoverFenceKey: _unused, ...dependencies } = f.dependencies;
    const runtime = createPostApprovalRoomIssueRuntime(dependencies);
    const input = { operationId: id, expectedLeaseVersion: 1 }, key = 'synthetic-key-001';
    await expect(runtime.handover.recover({ ...actor, mustChangePassword: true }, input, key))
      .rejects.toMatchObject({ statusCode: 403, code: 'PASSWORD_CHANGE_REQUIRED' });
    await expect(runtime.handover.recover({ ...actor, accessToken: 'unverified' }, input, key))
      .rejects.toMatchObject({ statusCode: 401, code: 'INVALID_ACCESS_TOKEN' });
    await expect(runtime.handover.recover({ ...actor, role: 'maid' }, input, key))
      .rejects.toMatchObject({ statusCode: 403, code: 'ADMIN_REQUIRED' });
    await expect(runtime.handover.recover(actor, { ...input, expectedLeaseVersion: 8 }, key))
      .rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
    await expect(runtime.handover.recover(actor, input, 'short'))
      .rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
    expect(f.transport).not.toHaveBeenCalled(); expect(f.dependencies.provider).not.toHaveBeenCalled();
  });
  it('wires handover recovery to the same evidence instance without losing its receiver', async () => {
    const f = fixture();
    const operation = { operationId: id, evidenceId: id, status: 'provider_succeeded' as const,
      leaseVersion: 2, itemRevision: 0, evidenceRevision: 0, mimeType: 'image/jpeg' as const, sizeBytes: 3, sha256: 'a'.repeat(64) };
    f.transport.mockResolvedValueOnce(new Response(JSON.stringify(operation), {
      status: 200, headers: { 'content-type': 'application/json' }
    }));
    const recovery = vi.spyOn(SupabasePostApprovalRoomIssueEvidenceService.prototype, 'recoverHandover')
      .mockResolvedValue(operation);
    try {
      const runtime = createPostApprovalRoomIssueRuntime(f.dependencies);
      await expect(runtime.handover.recover(actor, { operationId: id, expectedLeaseVersion: 1 }, 'synthetic-key-001'))
        .resolves.toEqual(operation);
      expect(f.transport).toHaveBeenCalledOnce();
      expect(recovery).toHaveBeenCalledWith(actor, operation, expect.stringMatching(/^[0-9a-f]{64}$/));
      expect(recovery.mock.contexts[0]).toBe(runtime.evidence);
      expect(f.dependencies.provider).not.toHaveBeenCalled();
    } finally { recovery.mockRestore(); }
  });
  it('uses one stable key snapshot for all receipt replays, including caller mutation before first recover', async () => {
    const f = fixture(), input = { operationId: id, expectedLeaseVersion: 1 }, key = 'synthetic-key-001';
    const operation = { operationId: id, evidenceId: id, status: 'accepted' as const,
      leaseVersion: 2, itemRevision: 1, evidenceRevision: 1, mimeType: 'image/jpeg' as const, sizeBytes: 3, sha256: 'a'.repeat(64) };
    f.transport.mockImplementation(async () => new Response(JSON.stringify(operation), {
      status: 200, headers: { 'content-type': 'application/json' }
    }));
    const recovery = vi.spyOn(SupabasePostApprovalRoomIssueEvidenceService.prototype, 'recoverHandover')
      .mockResolvedValue(operation);
    try {
      const runtime = createPostApprovalRoomIssueRuntime(f.dependencies);
      f.dependencies.handoverFenceKey.fill(99);
      const prepared = preparePostApprovalRoomIssueHandover({ actorProfileId: id, sessionId: id }, input, key);
      const expected = createHmac('sha256', Buffer.alloc(32, 73))
        .update(`post-approval-evidence-handover:v1:${prepared.idempotencyKeyDigest}:${prepared.requestHash}`).digest('hex');
      await runtime.handover.recover(actor, input, key);
      f.dependencies.handoverFenceKey.fill(100);
      await runtime.handover.recover(actor, input, key);
      expect(f.transport).toHaveBeenCalledTimes(2);
      expect(recovery).toHaveBeenNthCalledWith(1, actor, operation, expected);
      expect(recovery).toHaveBeenNthCalledWith(2, actor, operation, expected);
      expect(f.dependencies.provider).not.toHaveBeenCalled();
    } finally { recovery.mockRestore(); }
  });
});
