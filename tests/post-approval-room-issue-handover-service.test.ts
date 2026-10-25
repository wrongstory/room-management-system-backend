import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '../src/domain/actor.js';
import { SupabasePostApprovalRoomIssueHandoverService } from '../src/modules/post-approval-room-issues/post-approval-room-issue-handover.service.js';

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = (session = id(2)): Actor => ({ authUserId: id(11), profileId: id(1), role: 'admin',
  displayName: 'synthetic', mustChangePassword: false,
  accessToken: `verified.${Buffer.from(JSON.stringify({ session_id: session })).toString('base64url')}.signature` });
const input = { operationId: id(3), expectedLeaseVersion: 1 };
const key = 'handover-test-001';
const serverKey = () => new Uint8Array(32).fill(73); // Synthetic test-only material.
const operation = { operationId: id(3), evidenceId: id(4), status: 'provider_succeeded', leaseVersion: 2,
  itemRevision: 0, evidenceRevision: 0, mimeType: 'image/jpeg' as const, sizeBytes: 3, sha256: 'a'.repeat(64) };
function setup(data: unknown = operation, error: unknown = null) {
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({ data, error }));
  return { rpc, service: new SupabasePostApprovalRoomIssueHandoverService({ rpc }, serverKey()) };
}
describe('supplemental evidence handover adapter', () => {
  it('passes the fresh handover fence only to the server recovery dependency', async () => {
    const { rpc } = setup();
    const recoverHandover = vi.fn(async () => ({ ...operation, status: 'accepted' as const, itemRevision: 1, evidenceRevision: 1 }));
    const service = new SupabasePostApprovalRoomIssueHandoverService({ rpc }, serverKey(), { recoverHandover });
    expect((await service.recover(actor(), input, key)).status).toBe('accepted');
    expect(recoverHandover).toHaveBeenCalledWith(actor(), operation, rpc.mock.calls[0]?.[1].p_fence_token_digest);
  });
  it('does not acquire ownership when recovery is unconfigured', async () => {
    const { service, rpc } = setup();
    await expect(service.recover(actor(), input, key)).rejects.toMatchObject({ statusCode: 503 });
    expect(rpc).not.toHaveBeenCalled();
  });
  it('does not invoke recovery if DB denies handover', async () => {
    const { rpc } = setup(null, { message: 'PHOTO_UPLOAD_FENCE_CONFLICT' });
    const recoverHandover = vi.fn();
    const service = new SupabasePostApprovalRoomIssueHandoverService({ rpc }, serverKey(), { recoverHandover });
    await expect(service.recover(actor(), input, key)).rejects.toMatchObject({ statusCode: 409 });
    expect(recoverHandover).not.toHaveBeenCalled();
  });
  it('binds only the authenticated actor/session and validated command to one RPC', async () => {
    const { service, rpc } = setup({ ...operation, providerFileId: 'private', fenceTokenDigest: 'private', sessionId: id(2) });
    expect(await service.handover(actor(), input, key)).toEqual(operation);
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc.mock.calls[0]).toEqual(['handover_post_approval_room_issue_evidence_upload', {
      p_actor_profile_id: id(1), p_session_id: id(2), p_operation_id: id(3), p_expected_lease_version: 1,
      p_idempotency_key_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      p_request_hash: expect.stringMatching(/^[0-9a-f]{64}$/), p_fence_token_digest: expect.stringMatching(/^[0-9a-f]{64}$/)
    }]);
  });
  it('reuses the same fence across retries, refreshed sessions and service instances', async () => {
    const { service, rpc } = setup();
    await service.handover(actor(), input, key);
    await service.handover(actor(id(20)), input, key);
    await new SupabasePostApprovalRoomIssueHandoverService({ rpc }, serverKey()).handover(actor(), input, key);
    const args = rpc.mock.calls.map(call => call[1]);
    expect(new Set(args.map(value => value.p_fence_token_digest)).size).toBe(1);
    expect(args[1]?.p_session_id).toBe(id(20));
  });
  it('does not cache successful receipts or skip fresh DB authorization', async () => {
    const { service, rpc } = setup();
    await service.handover(actor(), input, key);
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'SESSION_REVOKED' } });
    await expect(service.handover(actor(), input, key)).rejects.toMatchObject({ statusCode: 401, code: 'SESSION_REVOKED' });
    expect(rpc).toHaveBeenCalledTimes(2);
  });
  it('changes the fence when actor, key or payload changes and lets DB reject conflicts', async () => {
    const { service, rpc } = setup();
    for (const [a, value, k] of [[actor(), input, key], [{ ...actor(), profileId: id(10) }, input, key],
      [actor(), input, `${key}-other`], [actor(), { ...input, expectedLeaseVersion: 0 }, key]] as const) {
      rpc.mockResolvedValueOnce({ data: { ...operation, leaseVersion: value.expectedLeaseVersion + 1 }, error: null });
      await expect(service.handover(a, value, k)).resolves.toMatchObject({ leaseVersion: value.expectedLeaseVersion + 1 });
    }
    expect(new Set(rpc.mock.calls.map(call => call[1].p_fence_token_digest)).size).toBe(4);
    expect(rpc.mock.calls[0]?.[1].p_idempotency_key_digest).toBe(rpc.mock.calls[3]?.[1].p_idempotency_key_digest);
  });
  it('retries a lost response with exactly the same command and fence', async () => {
    const { service, rpc } = setup();
    rpc.mockRejectedValueOnce(new Error('synthetic response loss'));
    await expect(service.handover(actor(), input, key)).rejects.toMatchObject({ statusCode: 500 });
    await expect(service.handover(actor(), input, key)).resolves.toEqual(operation);
    expect(rpc.mock.calls[0]).toEqual(rpc.mock.calls[1]);
  });
  it('copies the injected key and never serializes it', async () => {
    const { rpc } = setup(), material = serverKey();
    const service = new SupabasePostApprovalRoomIssueHandoverService({ rpc }, material);
    material.fill(0);
    await service.handover(actor(), input, key);
    await new SupabasePostApprovalRoomIssueHandoverService({ rpc }, serverKey()).handover(actor(), input, key);
    expect(rpc.mock.calls[0]?.[1].p_fence_token_digest).toBe(rpc.mock.calls[1]?.[1].p_fence_token_digest);
    expect(JSON.stringify(service)).not.toContain('fenceKey');
  });
  it.each([0, 16, 31, 33, 64])('fails closed for key length %i', length => {
    expect(() => new SupabasePostApprovalRoomIssueHandoverService(setup(), new Uint8Array(length))).toThrow();
  });
  it.each(['maid', 'developer'] as const)('rejects %s before RPC', async role => {
    const { service, rpc } = setup();
    await expect(service.handover({ ...actor(), role }, input, key)).rejects.toMatchObject({ statusCode: 403 });
    expect(rpc).not.toHaveBeenCalled();
  });
  it.each([{ mustChangePassword: true }, { accessToken: 'invalid' }])('rejects invalid actor context %j', async change => {
    const { service, rpc } = setup();
    await expect(service.handover({ ...actor(), ...change }, input, key)).rejects.toBeDefined();
    expect(rpc).not.toHaveBeenCalled();
  });
  it.each(['actorProfileId', 'sessionId', 'fence', 'force', 'providerFileId'])('rejects client authority %s', async field => {
    const { service, rpc } = setup();
    await expect(service.handover(actor(), { ...input, [field]: 'forged' }, key)).rejects.toMatchObject({ statusCode: 400 });
    expect(rpc).not.toHaveBeenCalled();
  });
  it.each(['SESSION_REVOKED', 'ADMIN_REQUIRED', 'PHOTO_UPLOAD_FENCE_CONFLICT', 'IDEMPOTENCY_KEY_REUSED',
    'PHOTO_UPLOAD_RATE_LIMITED', 'PHOTO_UPLOAD_LIMIT_EXCEEDED'])('preserves safe DB denial %s', async code => {
    const { service } = setup(null, { message: code, details: 'private' });
    await expect(service.handover(actor(), input, key)).rejects.toMatchObject({ code });
  });
  it.each([null, { ...operation, operationId: id(9) }, { ...operation, leaseVersion: 1 },
    { ...operation, leaseVersion: 9 }, { ...operation, mimeType: 'invalid' }])('rejects invalid/mismatched projection', async value => {
    await expect(setup(value).service.handover(actor(), input, key)).rejects.toMatchObject({ statusCode: 500 });
  });
  it('accepts the bounded current lease after same-fence executor reclaim', async () => {
    expect((await setup({ ...operation, leaseVersion: 3 }).service.handover(actor(), input, key)).leaseVersion).toBe(3);
  });
  it('redacts transport and unknown SQL errors', async () => {
    const { service, rpc } = setup(null, { message: 'private provider error' });
    await expect(service.handover(actor(), input, key)).rejects.toMatchObject({ code: 'POST_APPROVAL_ROOM_ISSUE_EVIDENCE_COMMAND_FAILED' });
    rpc.mockRejectedValueOnce(new Error('private token'));
    await expect(service.handover(actor(), input, key)).rejects.not.toThrow('private token');
  });
  it.each(['accepted', 'compensated'])('permits current same-lease terminal receipt projection %s', async status => {
    const revisions = status === 'accepted' ? { itemRevision: 1, evidenceRevision: 1 } : {};
    expect((await setup({ ...operation, ...revisions, status }).service.handover(actor(), input, key)).status).toBe(status);
  });
});
