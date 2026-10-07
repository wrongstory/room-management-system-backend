import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '../src/domain/actor.js';
import * as photoBinary from '../src/modules/photos/photo-binary.js';
import type { PhotoProvider } from '../src/modules/photos/google-drive.js';
import {
  POST_APPROVAL_ROOM_ISSUE_UPLOAD_COMMAND, preparePostApprovalRoomIssueUpload,
  preparePostApprovalRoomIssueUploadKey, projectPostApprovalRoomIssueUpload, validatePostApprovalRoomIssueUpload
} from '../src/modules/post-approval-room-issues/post-approval-room-issue-upload-contract.js';
import {
  postApprovalRoomIssueEvidenceDatabaseError, SupabasePostApprovalRoomIssueEvidenceService,
  type PostApprovalRoomIssueEvidenceRpc
} from '../src/modules/post-approval-room-issues/post-approval-room-issue-evidence.service.js';

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = (role: Actor['role'] = 'maid', session = id(2)): Actor => ({ authUserId: id(11), profileId: id(1),
  role, displayName: 'synthetic', mustChangePassword: false,
  accessToken: `verified.${Buffer.from(JSON.stringify({ session_id: session })).toString('base64url')}.signature` });
const trusted = { actorProfileId: id(1), sessionId: id(2) };
const input = { sourceSubmissionId: id(3), clientReportId: id(4), evidenceId: id(5),
  expectedDraftRevision: 1, expectedEvidenceRevision: 0, expectedItemRevision: 0 };
const bytes = Uint8Array.from([1, 2, 3]);
const metadata = { mimeType: 'image/jpeg' as const, sizeBytes: 3,
  sha256: createHash('sha256').update(bytes).digest('hex') };
const uploadedAt = '2026-10-05T02:00:00Z';
const statuses = ['reserved', 'provider_succeeded', 'accepted', 'reconciliation_pending', 'compensation_pending', 'compensated'] as const;
type Status = typeof statuses[number];
interface Reply { data: unknown; error: unknown }
type Hook = (name: string, args: Record<string, unknown>) => Reply | undefined;
afterEach(() => vi.restoreAllMocks());
function setup(hook?: Hook) {
  const calls: string[] = [], rpcArgs: { name: string; args: Record<string, unknown> }[] = [];
  let state: Status = 'reserved', lease = 0, bound = false;
  const op = (status: Status = state) => ({ operationId: id(6), evidenceId: id(5), status, leaseVersion: lease,
    itemRevision: status === 'accepted' ? 1 : 0, evidenceRevision: status === 'accepted' ? 1 : 0,
    ...metadata, providerFileId: 'must_not_leak', sessionId: id(2), fenceTokenDigest: 'must_not_leak' });
  const providerContext = () => ({ objectId: id(7), fileId: bound ? 'provider_file_123' : null,
    folderId: bound ? 'provider_room_123' : null, fileName: '2026-10-05_특이사항_101_01.jpg',
    uploadDate: '2026-10-05', roomNumber: '101', ...metadata });
  const provider: PhotoProvider = {
    quota: vi.fn(async () => { calls.push('provider.quota'); return { refreshStartedAt: uploadedAt, usageBytes: '0' }; }),
    rootFolderId: () => 'provider_root_123',
    generateUploadIds: vi.fn(async (): Promise<[string, string, string]> => { calls.push('provider.generate'); return ['candidate_file_123', 'candidate_date_123', 'candidate_room_123']; }),
    ensureFolder: vi.fn(async () => { calls.push('provider.folder'); }),
    upload: vi.fn(async () => { calls.push('provider.upload'); return { uploadedAt }; }),
    inspect: vi.fn(async () => { calls.push('provider.inspect'); return { uploadedAt }; }),
    read: vi.fn(async () => { calls.push('provider.read'); return bytes; }),
    remove: vi.fn(async () => { calls.push('provider.delete'); return 'deleted' as const; })
  };
  const db: PostApprovalRoomIssueEvidenceRpc = { rpc: async (name, args) => {
    calls.push(name); rpcArgs.push({ name, args });
    const overridden = hook?.(name, args); if (overridden) return overridden;
    let data: unknown;
    if (name === 'admit_post_approval_room_issue_evidence_upload') data = {
      admissionId: id(8), expiresAt: '2026-10-05T02:05:00Z', reservedBytes: 307200, quotaWarning: true };
    if (name === 'admit_post_approval_room_issue_quota_refresh') data = { permitId: id(28), expiresAt: '2026-10-05T02:05:00Z' };
    if (name === 'refresh_post_approval_room_issue_quota') data = { refreshed: true };
    if (name === 'begin_post_approval_room_issue_evidence_upload') data = op();
    if (name === 'claim_post_approval_room_issue_evidence_upload') { lease += 1; data = op(); }
    if (name === 'renew_post_approval_room_issue_evidence_upload' || name === 'get_post_approval_room_issue_evidence_upload') data = op();
    if (name === 'get_post_approval_room_issue_evidence_provider_context') data = providerContext();
    if (name === 'reserve_post_approval_room_issue_evidence_folder') data = {
      folderId: args.p_scope === 'date' ? 'provider_date_123' : 'provider_room_123',
      parentFolderId: args.p_scope === 'date' ? 'provider_root_123' : 'provider_date_123',
      name: args.p_scope === 'date' ? '2026-10-05' : '101' };
    if (name === 'reserve_post_approval_room_issue_evidence_identity') { bound = true; data = providerContext(); }
    if (name === 'prepare_post_approval_room_issue_evidence_provider_write') { state = 'reconciliation_pending'; data = op(); }
    if (name === 'record_post_approval_room_issue_evidence_provider_success') {
      state = args.p_uploaded_at === uploadedAt ? 'provider_succeeded' : 'compensation_pending'; data = op(); }
    if (name === 'finalize_post_approval_room_issue_evidence_upload') { state = 'accepted'; data = op(); }
    if (name === 'mark_post_approval_room_issue_evidence_unknown') { state = 'reconciliation_pending'; data = op(); }
    if (name === 'prepare_post_approval_room_issue_evidence_delete') data = { deleteToken: id(9), objectId: id(7), fileId: 'provider_file_123' };
    if (name === 'settle_post_approval_room_issue_evidence_delete') { state = 'compensated'; data = op(); }
    if (name === 'get_post_approval_room_issue_evidence_content') data = { fileId: 'provider_file_123', ...metadata, raw: 'not_public' };
    return { data, error: null };
  } };
  const decoder = vi.fn(async () => { calls.push('decode'); });
  const decode = vi.spyOn(photoBinary, 'verifyPhotoBinary').mockResolvedValue({ bytes, mime: metadata.mimeType,
    sizeBytes: metadata.sizeBytes, sha256: metadata.sha256 });
  const service = new SupabasePostApprovalRoomIssueEvidenceService(db, () => provider, decoder);
  const reader = vi.fn(async () => { calls.push('body'); return { contentType: 'image/jpeg', contentLength: '3',
    stream: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }) }; });
  return { service, provider, calls, rpcArgs, reader, decoder, decode, op, providerContext,
    setState: (status: Status) => { state = status; }, setBound: () => { bound = true; },
    setLease: (version: number) => { lease = version; } };
}

describe('admin handover inspect-only recovery', () => {
  const fence = '7'.repeat(64);
  function recovery(hook?: Hook, status: Status = 'provider_succeeded') {
    const s = setup(hook); s.setLease(2); s.setState(status); s.setBound();
    return { ...s, baseline: projectPostApprovalRoomIssueUpload(s.op()) };
  }
  it.each(['reserved', 'reconciliation_pending', 'provider_succeeded'] as const)('recovers %s by inspecting the original identity only', async status => {
    const s = recovery(undefined, status);
    const result = await s.service.recoverHandover(actor('admin'), s.baseline, fence);
    expect(result.status).toBe('accepted');
    expect(s.provider.inspect).toHaveBeenCalledWith({ objectId: id(7), fileId: 'provider_file_123',
      folderId: 'provider_room_123', fileName: '2026-10-05_특이사항_101_01.jpg', mime: 'image/jpeg', ...{ sizeBytes: 3, sha256: metadata.sha256 } });
    for (const action of [s.provider.upload, s.provider.remove, s.provider.generateUploadIds, s.provider.ensureFolder,
      s.provider.quota, s.reader, s.decode]) expect(action).not.toHaveBeenCalled();
    for (const call of s.rpcArgs) {
      expect(call.args.p_actor_profile_id).toBe(id(1));
      if (call.args.p_lease_version !== undefined) {
        expect(call.args.p_lease_version).toBe(3); expect(call.args.p_fence_token_digest).toBe(fence);
      }
    }
    expect(s.calls.indexOf('renew_post_approval_room_issue_evidence_upload')).toBeLessThan(s.calls.indexOf('provider.inspect'));
    expect(JSON.stringify(result)).not.toContain('provider_file');
  });
  it('replays accepted after lost finalize without provider I/O', async () => {
    const s = recovery();
    await s.service.recoverHandover(actor('admin'), s.baseline, fence);
    vi.mocked(s.provider.inspect).mockClear();
    expect((await s.service.recoverHandover(actor('admin'), projectPostApprovalRoomIssueUpload(s.op()), fence)).status).toBe('accepted');
    expect(s.provider.inspect).not.toHaveBeenCalled();
  });
  it.each(['compensation_pending', 'compensated'] as const)('does not delete %s objects', async status => {
    const s = recovery(undefined, status);
    await expect(s.service.recoverHandover(actor('admin'), s.baseline, fence)).rejects.toMatchObject({ statusCode: status === 'compensated' ? 409 : 503 });
    expect(s.provider.inspect).not.toHaveBeenCalled(); expect(s.provider.remove).not.toHaveBeenCalled();
  });
  it('does not create a missing provider identity', async () => {
    const s = recovery(name => name === 'get_post_approval_room_issue_evidence_provider_context'
      ? { data: { objectId: id(7), fileId: null, folderId: null, fileName: '2026-10-05_특이사항_101_01.jpg',
        uploadDate: '2026-10-05', roomNumber: '101', ...metadata }, error: null } : undefined, 'reserved');
    await expect(s.service.recoverHandover(actor('admin'), s.baseline, fence)).rejects.toMatchObject({ statusCode: 503 });
    expect(s.provider.inspect).not.toHaveBeenCalled(); expect(s.provider.generateUploadIds).not.toHaveBeenCalled();
  });
  it('retains uncertainty on provider failure without upload or delete', async () => {
    const s = recovery(undefined, 'reserved');
    vi.mocked(s.provider.inspect).mockRejectedValueOnce(new Error('private provider response'));
    await expect(s.service.recoverHandover(actor('admin'), s.baseline, fence)).rejects.toMatchObject({ statusCode: 503 });
    expect(s.op().status).toBe('reconciliation_pending');
    expect(s.provider.upload).not.toHaveBeenCalled(); expect(s.provider.remove).not.toHaveBeenCalled();
    expect(s.calls).not.toContain('record_post_approval_room_issue_evidence_provider_success');
  });
  it('rechecks session after provider inspection before recording or finalizing', async () => {
    let renews = 0;
    const s = recovery(name => name === 'renew_post_approval_room_issue_evidence_upload' && ++renews === 2
      ? { data: null, error: { message: 'SESSION_REVOKED' } } : undefined);
    await expect(s.service.recoverHandover(actor('admin'), s.baseline, fence)).rejects.toMatchObject({ code: 'SESSION_REVOKED' });
    expect(s.provider.inspect).toHaveBeenCalledOnce();
    expect(s.calls).not.toContain('record_post_approval_room_issue_evidence_provider_success');
  });
  it('rejects a displaced executor before provider I/O', async () => {
    const s = recovery(name => name === 'get_post_approval_room_issue_evidence_upload'
      ? { data: null, error: { message: 'POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED' } } : undefined);
    await expect(s.service.recoverHandover(actor('admin'), s.baseline, fence)).rejects.toMatchObject({ statusCode: 403 });
    expect(s.provider.inspect).not.toHaveBeenCalled();
  });
  it('does not accept or delete provider date mismatch', async () => {
    const s = recovery();
    vi.mocked(s.provider.inspect).mockResolvedValueOnce({ uploadedAt: '2026-10-06T02:00:00Z' });
    await expect(s.service.recoverHandover(actor('admin'), s.baseline, fence)).rejects.toMatchObject({ statusCode: 503 });
    expect(s.op().status).toBe('compensation_pending');
    expect(s.calls).not.toContain('finalize_post_approval_room_issue_evidence_upload');
    expect(s.provider.remove).not.toHaveBeenCalled();
  });
  it.each([{ operationId: id(99) }, { leaseVersion: 3 }, { evidenceId: id(99) }, { sha256: 'c'.repeat(64) }])('rejects changed operation projection %j', async change => {
    const s = recovery();
    await expect(s.service.recoverHandover(actor('admin'), { ...s.baseline, ...change }, fence)).rejects.toMatchObject({ statusCode: 500 });
    expect(s.provider.inspect).not.toHaveBeenCalled();
  });
  it('rejects a maid before any DB/provider work', async () => {
    const s = recovery();
    await expect(s.service.recoverHandover(actor('maid'), s.baseline, fence)).rejects.toMatchObject({ code: 'ADMIN_REQUIRED' });
    expect(s.calls).toEqual([]);
  });
});

describe('typed supplemental evidence pure transport', () => {
  it('uses a distinct command and actor/command/key scope only', () => {
    expect(POST_APPROVAL_ROOM_ISSUE_UPLOAD_COMMAND).toBe('post_approval_room_issue.evidence_upload');
    const first = preparePostApprovalRoomIssueUploadKey(trusted, input, 'typed-key-0001');
    const refreshed = preparePostApprovalRoomIssueUploadKey({ ...trusted, sessionId: id(22) }, input, 'typed-key-0001');
    const changedPayload = preparePostApprovalRoomIssueUploadKey(trusted, { ...input, sourceSubmissionId: id(33) }, 'typed-key-0001');
    expect(first.idempotencyKeyDigest).toBe(refreshed.idempotencyKeyDigest);
    expect(first.idempotencyKeyDigest).toBe(changedPayload.idempotencyKeyDigest);
    expect(preparePostApprovalRoomIssueUpload(first, metadata).requestHash).toBe(preparePostApprovalRoomIssueUpload(refreshed, metadata).requestHash);
    expect(preparePostApprovalRoomIssueUpload(first, metadata).requestHash).not.toBe(preparePostApprovalRoomIssueUpload(changedPayload, metadata).requestHash);
    expect(preparePostApprovalRoomIssueUpload(first, metadata).requestHash).not.toBe(preparePostApprovalRoomIssueUpload(first, { ...metadata, sha256: 'a'.repeat(64) }).requestHash);
    expect(Object.isFrozen(first.input)).toBe(true);
  });
  it.each(['actorProfileId', 'sessionId', 'uploadedAt', 'providerFileId', 'role', 'accepted', 'requestHash', 'fileName'])('rejects caller authority field %s', field => {
    expect(() => validatePostApprovalRoomIssueUpload({ ...input, [field]: 'forged' })).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });
  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '0'])('rejects non-safe CAS %s', revision => {
    expect(() => validatePostApprovalRoomIssueUpload({ ...input, expectedEvidenceRevision: revision })).toThrow(expect.objectContaining({ statusCode: 400 }));
  });
  it.each(['expectedEvidenceRevision', 'expectedItemRevision'])('409 at exhausted incrementable %s', field => {
    expect(() => validatePostApprovalRoomIssueUpload({ ...input, [field]: Number.MAX_SAFE_INTEGER })).toThrow(expect.objectContaining({ statusCode: 409 }));
  });
  it('allows stored MAX_SAFE draft CAS without incrementing it', () => {
    expect(validatePostApprovalRoomIssueUpload({ ...input, expectedDraftRevision: Number.MAX_SAFE_INTEGER }).expectedDraftRevision).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => validatePostApprovalRoomIssueUpload({ ...input, expectedDraftRevision: 0 })).toThrow();
  });
  it.each(['short', 'invalid key', 'key/with/slash', 'a'.repeat(129), 123, null])('rejects invalid key %s', key => {
    expect(() => preparePostApprovalRoomIssueUploadKey(trusted, input, key)).toThrow(expect.objectContaining({ statusCode: 400 }));
  });
  it.each([{ mimeType: 'image/heic' }, { sizeBytes: 307201 }, { sizeBytes: 0 }, { sha256: 'A'.repeat(64) }, { fileId: 'raw' }])('binds only normalized storage metadata %j', change => {
    expect(() => preparePostApprovalRoomIssueUpload(preparePostApprovalRoomIssueUploadKey(trusted, input, 'typed-key-0001'), { ...metadata, ...change })).toThrow();
  });
  it('drops all unknown internal operation fields recursively at public projection', () => {
    expect(projectPostApprovalRoomIssueUpload({ operationId: id(6), evidenceId: id(5), status: 'accepted', leaseVersion: 1,
      itemRevision: 1, evidenceRevision: 1, ...metadata, providerFileId: 'secret_file', sessionId: id(2), nested: { locator: 'raw' } })).toEqual({
      operationId: id(6), evidenceId: id(5), status: 'accepted', leaseVersion: 1, itemRevision: 1, evidenceRevision: 1, ...metadata });
  });
  it('redacts raw provider/DB failures and rejects malformed metadata', () => {
    const error = postApprovalRoomIssueEvidenceDatabaseError({ message: 'raw pin secret provider_file_123', details: 'PII' });
    expect(error).toMatchObject({ statusCode: 500, code: 'POST_APPROVAL_ROOM_ISSUE_EVIDENCE_COMMAND_FAILED' });
    expect(JSON.stringify(error)).not.toMatch(/secret|provider_file|PII/);
    expect(() => projectPostApprovalRoomIssueUpload({ operationId: id(6) })).toThrow(expect.objectContaining({ statusCode: 500 }));
    expect(postApprovalRoomIssueEvidenceDatabaseError({ get message() { throw new Error('raw getter secret'); } }))
      .toMatchObject({ code: 'POST_APPROVAL_ROOM_ISSUE_EVIDENCE_COMMAND_FAILED' });
  });
  it('rejects fabricated accepted zero revisions', () => {
    expect(() => projectPostApprovalRoomIssueUpload({ operationId: id(6), evidenceId: id(5), status: 'accepted',
      leaseVersion: 0, itemRevision: 0, evidenceRevision: 0, ...metadata })).toThrow(expect.objectContaining({ statusCode: 500 }));
  });
  it.each(['PHOTO_UPLOAD_ADMISSION_EXPIRED', 'PHOTO_UPLOAD_FENCE_CONFLICT', 'PHOTO_UPLOAD_TIME_INVALID', 'PHOTO_PROVIDER_IDENTITY_CONFLICT'])('preserves exact typed SQL denial %s', code => {
    expect(postApprovalRoomIssueEvidenceDatabaseError({ message: code, details: 'never exposed' })).toMatchObject({ statusCode: 409, code });
  });
});

describe('typed supplemental evidence application boundary', () => {
  it('admission precedes body/decoder, binding precedes upload, final result is allowlisted', async () => {
    const s = setup(), result = await s.service.upload(actor(), input, 'typed-key-0001', s.reader);
    expect(result).toEqual({ operationId: id(6), evidenceId: id(5), status: 'accepted', leaseVersion: 1,
      itemRevision: 1, evidenceRevision: 1, ...metadata });
    expect(s.calls.indexOf('admit_post_approval_room_issue_evidence_upload')).toBeLessThan(s.calls.indexOf('body'));
    expect(s.calls.indexOf('body')).toBeLessThan(s.calls.indexOf('decode'));
    expect(s.calls.indexOf('reserve_post_approval_room_issue_evidence_identity')).toBeLessThan(s.calls.indexOf('provider.upload'));
    expect(s.calls.indexOf('prepare_post_approval_room_issue_evidence_provider_write')).toBeLessThan(s.calls.indexOf('provider.upload'));
    expect(s.provider.generateUploadIds).toHaveBeenCalledOnce();
    expect(s.provider.upload).toHaveBeenCalledWith({ objectId: id(7), fileId: 'provider_file_123', folderId: 'provider_room_123',
      fileName: '2026-10-05_특이사항_101_01.jpg', mime: metadata.mimeType, sizeBytes: 3, sha256: metadata.sha256 }, bytes);
    const admits = s.rpcArgs.find(call => call.name === 'admit_post_approval_room_issue_evidence_upload');
    expect(admits?.args).not.toHaveProperty('p_sha256');
    expect(admits?.args).toMatchObject({ p_actor_profile_id: id(1), p_session_id: id(2), p_evidence_id: id(5) });
    expect(s.provider.quota).not.toHaveBeenCalled();
  });
  it.each(['PHOTO_UPLOAD_RATE_LIMITED', 'PHOTO_UPLOAD_LIMIT_EXCEEDED', 'PHOTO_STORAGE_QUOTA_EXCEEDED',
    'POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED', 'POST_APPROVAL_ROOM_ISSUE_EVIDENCE_INVALID',
    'SESSION_REVOKED', 'CAPABILITY_ACCESS_REQUIRED'])('predecode %s denial makes no body/decoder/provider call', async code => {
    const s = setup(name => name === 'admit_post_approval_room_issue_evidence_upload' ? { data: null, error: { message: code } } : undefined);
    await expect(s.service.upload(actor(), input, 'typed-key-0001', s.reader)).rejects.toMatchObject({ code });
    expect(s.reader).not.toHaveBeenCalled(); expect(s.decoder).not.toHaveBeenCalled(); expect(s.decode).not.toHaveBeenCalled();
    expect(s.calls.filter(call => call.startsWith('provider.'))).toEqual([]);
  });
  it('cold quota uses one durable CPU permit before provider read and consumes it on admission', async () => {
    const s = setup((name, args) => name === 'admit_post_approval_room_issue_evidence_upload' && !args.p_quota_refresh_permit_id
      ? { data: null, error: { message: 'PHOTO_STORAGE_QUOTA_UNAVAILABLE' } } : undefined);
    expect((await s.service.upload(actor(), input, 'typed-key-0001', s.reader)).status).toBe('accepted');
    expect(s.calls.slice(0, 6)).toEqual(['admit_post_approval_room_issue_evidence_upload',
      'admit_post_approval_room_issue_quota_refresh', 'provider.quota', 'refresh_post_approval_room_issue_quota',
      'admit_post_approval_room_issue_evidence_upload', 'body']);
    const permits = s.rpcArgs.filter(call => call.name === 'admit_post_approval_room_issue_quota_refresh');
    expect(permits).toHaveLength(1);
    expect(permits[0]?.args).toMatchObject({ p_actor_profile_id: id(1), p_session_id: id(2), p_evidence_id: id(5),
      p_gate_request_digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const admissions = s.rpcArgs.filter(call => call.name === 'admit_post_approval_room_issue_evidence_upload');
    expect(admissions[1]?.args).toEqual({ ...admissions[0]?.args, p_quota_refresh_permit_id: id(28) });
    expect(permits[0]?.args.p_idempotency_key_digest).toBe(admissions[0]?.args.p_idempotency_key_digest);
    expect(s.provider.quota).toHaveBeenCalledOnce();
  });
  it.each(['PHOTO_UPLOAD_RATE_LIMITED', 'PHOTO_UPLOAD_LIMIT_EXCEEDED', 'SESSION_REVOKED', 'POST_APPROVAL_ROOM_ISSUE_DRAFT_CONFLICT'])
    ('cold quota gate %s fails before provider/body', async code => {
      const s = setup(name => name === 'admit_post_approval_room_issue_evidence_upload'
        ? { data: null, error: { message: 'PHOTO_STORAGE_QUOTA_UNAVAILABLE' } }
        : name === 'admit_post_approval_room_issue_quota_refresh' ? { data: null, error: { message: code } } : undefined);
      await expect(s.service.upload(actor(), input, 'typed-key-0001', s.reader)).rejects.toMatchObject({ code });
      expect(s.provider.quota).not.toHaveBeenCalled(); expect(s.reader).not.toHaveBeenCalled();
    });
  it.each(['SESSION_REVOKED', 'PHOTO_UPLOAD_ADMISSION_EXPIRED', 'POST_APPROVAL_ROOM_ISSUE_EVIDENCE_CONFLICT', 'PHOTO_STORAGE_QUOTA_UNAVAILABLE'])
    ('post-quota %s denies body/create/delete without a second admission', async code => {
      const s = setup(name => name === 'admit_post_approval_room_issue_evidence_upload'
        ? { data: null, error: { message: 'PHOTO_STORAGE_QUOTA_UNAVAILABLE' } }
        : name === 'refresh_post_approval_room_issue_quota' ? { data: null, error: { message: code } } : undefined);
      await expect(s.service.upload(actor(), input, 'typed-key-0001', s.reader)).rejects.toMatchObject({ code });
      expect(s.provider.quota).toHaveBeenCalledOnce(); expect(s.reader).not.toHaveBeenCalled();
      expect(s.provider.remove).not.toHaveBeenCalled(); expect(s.provider.upload).not.toHaveBeenCalled();
      expect(s.rpcArgs.filter(call => call.name === 'admit_post_approval_room_issue_evidence_upload')).toHaveLength(1);
    });
  it.each(['lost', 'invalid-unit', 'unsafe', 'timeout'])('unknown quota %s never guesses capacity or deletes', async mode => {
    const s = setup(name => name === 'admit_post_approval_room_issue_evidence_upload'
      ? { data: null, error: { message: 'PHOTO_STORAGE_QUOTA_UNAVAILABLE' } } : undefined);
    if (mode === 'lost') vi.mocked(s.provider.quota).mockRejectedValueOnce(new Error('raw provider secret'));
    else if (mode === 'timeout') { vi.useFakeTimers(); vi.mocked(s.provider.quota).mockReturnValueOnce(new Promise(() => {})); }
    else vi.mocked(s.provider.quota).mockResolvedValueOnce({ refreshStartedAt: uploadedAt, usageBytes: mode === 'unsafe' ? '9007199254740992' : '3GB' });
    try {
      const outcome = s.service.upload(actor(), input, 'typed-key-0001', s.reader);
      const asserted = expect(outcome).rejects.toMatchObject({ statusCode: 503, code: 'POST_APPROVAL_ROOM_ISSUE_EVIDENCE_RETRY_REQUIRED' });
      if (mode === 'timeout') await vi.advanceTimersByTimeAsync(10_001);
      await asserted;
      expect(s.reader).not.toHaveBeenCalled(); expect(s.provider.remove).not.toHaveBeenCalled();
      expect(s.calls).not.toContain('refresh_post_approval_room_issue_quota');
    } finally { vi.useRealTimers(); }
  });
  it('accepted replay still consumes admission and binds same normalized payload but calls no provider', async () => {
    const s = setup(); s.setState('accepted');
    expect((await s.service.upload(actor('admin', id(20)), input, 'typed-key-0001', s.reader)).status).toBe('accepted');
    expect(s.calls).toEqual(['admit_post_approval_room_issue_evidence_upload', 'body', 'decode', 'begin_post_approval_room_issue_evidence_upload']);
    expect(s.rpcArgs.every(call => call.args.p_session_id === id(20))).toBe(true);
  });
  it('reuses existing durable identity/name without another candidate batch', async () => {
    const s = setup(); s.setBound();
    await s.service.upload(actor(), input, 'typed-key-0001', s.reader);
    expect(s.provider.generateUploadIds).not.toHaveBeenCalled(); expect(s.provider.ensureFolder).not.toHaveBeenCalled();
    expect(s.provider.upload).toHaveBeenCalledWith(expect.objectContaining({ fileId: 'provider_file_123', fileName: '2026-10-05_특이사항_101_01.jpg' }), bytes);
  });
  it('limits raw body to 5 MiB before initializing or decoding', async () => {
    const s = setup(), read = vi.fn(async () => ({ stream: null, contentLength: String(photoBinary.PHOTO_INPUT_MAX_BYTES + 1), contentType: 'image/jpeg' }));
    await expect(s.service.upload(actor(), input, 'typed-key-0001', read)).rejects.toMatchObject({ code: 'PHOTO_TOO_LARGE', statusCode: 413 });
    expect(s.decoder).not.toHaveBeenCalled(); expect(s.provider.upload).not.toHaveBeenCalled();
  });
  it('never begins an operation if normalized bytes disagree with their metadata', async () => {
    const s = setup(); s.decode.mockResolvedValueOnce({ bytes, mime: 'image/jpeg', sizeBytes: 3, sha256: 'a'.repeat(64) });
    await expect(s.service.upload(actor(), input, 'typed-key-0001', s.reader)).rejects.toMatchObject({ statusCode: 503 });
    expect(s.calls).not.toContain('begin_post_approval_room_issue_evidence_upload'); expect(s.provider.upload).not.toHaveBeenCalled();
  });
  it('never forwards an arbitrary PhotoError code from a body reader', async () => {
    const s = setup();
    await expect(s.service.upload(actor(), input, 'typed-key-0001', async () => {
      throw new photoBinary.PhotoError(400, 'raw_PIN_provider_locator');
    })).rejects.toMatchObject({ statusCode: 503, code: 'POST_APPROVAL_ROOM_ISSUE_EVIDENCE_RETRY_REQUIRED' });
    expect(s.decoder).not.toHaveBeenCalled(); expect(s.provider.upload).not.toHaveBeenCalled();
  });
  it('validates generated identities before passing any candidate to SQL', async () => {
    const s = setup(); vi.mocked(s.provider.generateUploadIds).mockResolvedValueOnce(['same_candidate_123', 'same_candidate_123', 'same_candidate_123']);
    await expect(s.service.upload(actor(), input, 'typed-key-0001', s.reader)).rejects.toMatchObject({ statusCode: 503 });
    expect(s.calls).not.toContain('reserve_post_approval_room_issue_evidence_folder'); expect(s.provider.ensureFolder).not.toHaveBeenCalled();
  });
  it.each(['date', 'room'])('rejects mismatched %s folder parent before external folder create', async scope => {
    const s = setup((name, args) => name === 'reserve_post_approval_room_issue_evidence_folder' && args.p_scope === scope
      ? { data: { folderId: 'provider_wrong_123', parentFolderId: 'provider_other_root', name: scope === 'date' ? '2026-10-05' : '101' }, error: null } : undefined);
    await expect(s.service.upload(actor(), input, 'typed-key-0001', s.reader)).rejects.toMatchObject({ statusCode: 503 });
    expect(s.provider.ensureFolder).toHaveBeenCalledTimes(scope === 'date' ? 0 : 1); expect(s.provider.upload).not.toHaveBeenCalled();
  });
  it.each(['developer', 'temporary-password', 'invalid-token'])('server precheck rejects %s without RPC', async mode => {
    const s = setup(), identity = actor(mode === 'developer' ? 'developer' : 'maid');
    if (mode === 'temporary-password') identity.mustChangePassword = true;
    if (mode === 'invalid-token') identity.accessToken = 'not-a-session';
    await expect(s.service.upload(identity, input, 'typed-key-0001', s.reader)).rejects.toMatchObject({ statusCode: mode === 'invalid-token' ? 401 : 403 });
    expect(s.calls).toEqual([]);
  });
  it('stale CAS/key conflict does not allocate/upload/DELETE', async () => {
    for (const code of ['IDEMPOTENCY_KEY_REUSED', 'POST_APPROVAL_ROOM_ISSUE_EVIDENCE_INVALID']) {
      const s = setup(name => name === 'begin_post_approval_room_issue_evidence_upload' ? { data: null, error: { message: code } } : undefined);
      await expect(s.service.upload(actor(), input, 'typed-key-0001', s.reader)).rejects.toMatchObject({ code });
      expect(s.provider.generateUploadIds).not.toHaveBeenCalled(); expect(s.provider.remove).not.toHaveBeenCalled();
    }
  });
  it('create response loss reconciles only exact persisted identity, then accepts without DELETE', async () => {
    const s = setup(); vi.mocked(s.provider.upload).mockRejectedValueOnce(new Error('lost raw provider response'));
    expect((await s.service.upload(actor(), input, 'typed-key-0001', s.reader)).status).toBe('accepted');
    expect(s.provider.inspect).toHaveBeenCalledWith(expect.objectContaining({ fileId: 'provider_file_123', objectId: id(7), sha256: metadata.sha256 }));
    expect(s.provider.remove).not.toHaveBeenCalled();
  });
  it('CAS changes while provider is awaited keep the first physical clock but return409 without acceptance/delete', async () => {
    let changed = false;
    const s = setup(name => name === 'finalize_post_approval_room_issue_evidence_upload' && changed
      ? { data: null, error: { message: 'POST_APPROVAL_ROOM_ISSUE_EVIDENCE_INVALID' } } : undefined);
    vi.mocked(s.provider.upload).mockImplementationOnce(async () => { s.calls.push('provider.upload'); changed = true; return { uploadedAt }; });
    await expect(s.service.upload(actor(), input, 'typed-key-0001', s.reader)).rejects.toMatchObject({ statusCode: 409 });
    expect(s.calls.indexOf('prepare_post_approval_room_issue_evidence_provider_write')).toBeLessThan(s.calls.indexOf('provider.upload'));
    expect(s.rpcArgs.find(call => call.name === 'record_post_approval_room_issue_evidence_provider_success')?.args.p_uploaded_at).toBe(uploadedAt);
    await expect(s.service.upload(actor('maid', id(20)), input, 'typed-key-0001', s.reader)).rejects.toMatchObject({ statusCode: 409 });
    expect(s.provider.upload).toHaveBeenCalledOnce(); expect(s.provider.inspect).toHaveBeenCalledOnce();
    expect(s.provider.remove).not.toHaveBeenCalled();
  });
  it('actor expiry during provider wait returns401 and renewed session reconciles durable intent without another create', async () => {
    let revoked = false;
    const s = setup(name => name === 'renew_post_approval_room_issue_evidence_upload' && revoked
      ? { data: null, error: { message: 'SESSION_REVOKED' } } : undefined);
    vi.mocked(s.provider.upload).mockImplementationOnce(async () => { s.calls.push('provider.upload'); revoked = true; return { uploadedAt }; });
    await expect(s.service.upload(actor(), input, 'typed-key-0001', s.reader)).rejects.toMatchObject({ statusCode: 401, code: 'SESSION_REVOKED' });
    expect(s.provider.inspect).not.toHaveBeenCalled(); expect(s.calls).not.toContain('record_post_approval_room_issue_evidence_provider_success');
    revoked = false;
    expect((await s.service.upload(actor('maid', id(20)), input, 'typed-key-0001', s.reader)).status).toBe('accepted');
    expect(s.provider.upload).toHaveBeenCalledOnce(); expect(s.provider.inspect).toHaveBeenCalledOnce(); expect(s.provider.remove).not.toHaveBeenCalled();
  });
  it('lost durable-write-intent response never creates again or infers missing object deletion', async () => {
    let s: ReturnType<typeof setup>;
    s = setup(name => {
      if (name === 'prepare_post_approval_room_issue_evidence_provider_write') { s.setState('reconciliation_pending'); throw new Error('response lost'); }
      return undefined;
    });
    vi.mocked(s.provider.inspect).mockRejectedValueOnce(new Error('unknown absence'));
    await expect(s.service.upload(actor(), input, 'typed-key-0001', s.reader)).rejects.toMatchObject({ statusCode: 503 });
    expect(s.provider.upload).not.toHaveBeenCalled(); expect(s.provider.remove).not.toHaveBeenCalled();
    expect(s.calls).toContain('mark_post_approval_room_issue_evidence_unknown');
  });
  it('unknown create and unknown inspect remain retryable without immediate cleanup', async () => {
    const s = setup(); vi.mocked(s.provider.upload).mockRejectedValueOnce(new Error('timeout'));
    vi.mocked(s.provider.inspect).mockRejectedValueOnce(new Error('unknown, not proof of missing'));
    await expect(s.service.upload(actor(), input, 'typed-key-0001', s.reader)).rejects.toMatchObject({ statusCode: 503, code: 'POST_APPROVAL_ROOM_ISSUE_EVIDENCE_RETRY_REQUIRED' });
    expect(s.calls).toContain('mark_post_approval_room_issue_evidence_unknown'); expect(s.provider.remove).not.toHaveBeenCalled();
  });
  it('reconciliation retry inspects, never uploads a new object', async () => {
    const s = setup(); s.setState('reconciliation_pending'); s.setBound();
    expect((await s.service.upload(actor(), input, 'typed-key-0001', s.reader)).status).toBe('accepted');
    expect(s.provider.inspect).toHaveBeenCalledOnce(); expect(s.provider.upload).not.toHaveBeenCalled(); expect(s.provider.generateUploadIds).not.toHaveBeenCalled();
  });
  it('finalize response loss replays DB acceptance and never deletes', async () => {
    let s: ReturnType<typeof setup>;
    s = setup(name => {
      if (name === 'finalize_post_approval_room_issue_evidence_upload') { s.setState('accepted'); throw new Error('response lost after commit'); }
      return undefined;
    });
    expect((await s.service.upload(actor(), input, 'typed-key-0001', s.reader)).status).toBe('accepted');
    expect(s.provider.inspect).not.toHaveBeenCalled(); expect(s.provider.remove).not.toHaveBeenCalled();
  });
  it('provider acknowledgement response loss recovers immutable createdTime by inspect', async () => {
    let calls = 0;
    const s = setup(name => name === 'record_post_approval_room_issue_evidence_provider_success' && calls++ === 0
      ? { data: null, error: { message: 'opaque network response lost' } } : undefined);
    expect((await s.service.upload(actor(), input, 'typed-key-0001', s.reader)).status).toBe('accepted');
    expect(s.provider.inspect).toHaveBeenCalledOnce(); expect(s.provider.remove).not.toHaveBeenCalled();
    expect(s.rpcArgs.filter(call => call.name === 'record_post_approval_room_issue_evidence_provider_success').map(call => call.args.p_uploaded_at)).toEqual([uploadedAt, uploadedAt]);
  });
  it('fresh session rejection after provider wait returns denial and never finalizes/DELETEs', async () => {
    let s: ReturnType<typeof setup>;
    s = setup(name => name === 'renew_post_approval_room_issue_evidence_upload' && s.calls.includes('provider.upload')
      ? { data: null, error: { message: 'SESSION_REVOKED' } } : undefined);
    await expect(s.service.upload(actor(), input, 'typed-key-0001', s.reader)).rejects.toMatchObject({ statusCode: 401, code: 'SESSION_REVOKED' });
    expect(s.calls).not.toContain('finalize_post_approval_room_issue_evidence_upload'); expect(s.provider.remove).not.toHaveBeenCalled();
  });
  it('fresh session denial before persisted-object reconciliation prevents inspect/DELETE', async () => {
    let s: ReturnType<typeof setup>;
    s = setup(name => name === 'get_post_approval_room_issue_evidence_upload' && vi.mocked(s.provider.upload).mock.calls.length > 0
      ? { data: null, error: { message: 'SESSION_REVOKED' } } : undefined);
    vi.mocked(s.provider.upload).mockRejectedValueOnce(new Error('uncertain create'));
    await expect(s.service.upload(actor(), input, 'typed-key-0001', s.reader)).rejects.toMatchObject({ statusCode: 401 });
    expect(s.provider.inspect).not.toHaveBeenCalled(); expect(s.provider.remove).not.toHaveBeenCalled();
  });
  it('malformed provider context after binding is not treated as a network-retry receipt', async () => {
    let s: ReturnType<typeof setup>;
    s = setup(name => name === 'get_post_approval_room_issue_evidence_provider_context' && s.calls.includes('reserve_post_approval_room_issue_evidence_identity')
      ? { data: { ...s.providerContext(), fileName: 'client-file-name.jpg' }, error: null } : undefined);
    await expect(s.service.upload(actor(), input, 'typed-key-0001', s.reader)).rejects.toMatchObject({ statusCode: 500, code: 'POST_APPROVAL_ROOM_ISSUE_EVIDENCE_PROJECTION_INVALID' });
    expect(s.provider.upload).not.toHaveBeenCalled(); expect(s.provider.inspect).not.toHaveBeenCalled(); expect(s.provider.remove).not.toHaveBeenCalled();
  });
  it('final CAS conflict after external success is not proof of safe compensation', async () => {
    const s = setup(name => name === 'finalize_post_approval_room_issue_evidence_upload'
      ? { data: null, error: { message: 'POST_APPROVAL_ROOM_ISSUE_EVIDENCE_INVALID' } } : undefined);
    await expect(s.service.upload(actor(), input, 'typed-key-0001', s.reader)).rejects.toMatchObject({ statusCode: 409 });
    expect(s.provider.remove).not.toHaveBeenCalled(); expect(s.calls).not.toContain('prepare_post_approval_room_issue_evidence_delete');
  });
  it('known date mismatch uses DB prepared fence twice before DELETE and settle, never accepts', async () => {
    const s = setup(); vi.mocked(s.provider.upload).mockResolvedValueOnce({ uploadedAt: '2026-10-05T15:01:00Z' });
    await expect(s.service.upload(actor(), input, 'typed-key-0001', s.reader)).rejects.toMatchObject({ statusCode: 409, code: 'POST_APPROVAL_ROOM_ISSUE_UPLOAD_NOT_ACCEPTED' });
    expect(s.calls.filter(call => call === 'prepare_post_approval_room_issue_evidence_delete')).toHaveLength(2);
    expect(s.calls.indexOf('prepare_post_approval_room_issue_evidence_delete')).toBeLessThan(s.calls.indexOf('provider.delete'));
    expect(s.calls.indexOf('provider.delete')).toBeLessThan(s.calls.indexOf('settle_post_approval_room_issue_evidence_delete'));
    expect(s.provider.remove).toHaveBeenCalledWith('provider_file_123'); expect(s.calls).not.toContain('finalize_post_approval_room_issue_evidence_upload');
  });
  it('prepared compensation session/fence denial prevents any DELETE', async () => {
    const s = setup(name => name === 'prepare_post_approval_room_issue_evidence_delete'
      ? { data: null, error: { message: 'PHOTO_UPLOAD_FENCE_CONFLICT' } } : undefined);
    vi.mocked(s.provider.upload).mockResolvedValueOnce({ uploadedAt: '2026-10-05T15:01:00Z' });
    await expect(s.service.upload(actor(), input, 'typed-key-0001', s.reader)).rejects.toMatchObject({ statusCode: 409 });
    expect(s.provider.remove).not.toHaveBeenCalled();
  });
  it('expired session at final prepared-delete authorization prevents irreversible DELETE', async () => {
    let prepares = 0;
    const s = setup(name => name === 'prepare_post_approval_room_issue_evidence_delete' && prepares++ === 1
      ? { data: null, error: { message: 'SESSION_REVOKED' } } : undefined);
    vi.mocked(s.provider.upload).mockResolvedValueOnce({ uploadedAt: '2026-10-05T15:01:00Z' });
    await expect(s.service.upload(actor(), input, 'typed-key-0001', s.reader)).rejects.toMatchObject({ statusCode: 401 });
    expect(s.provider.remove).not.toHaveBeenCalled();
  });
  it('lost DELETE response only retries the identical durable prepared object, accepts 404 settle', async () => {
    const s = setup(); vi.mocked(s.provider.upload).mockResolvedValueOnce({ uploadedAt: '2026-10-05T15:01:00Z' });
    vi.mocked(s.provider.remove).mockRejectedValueOnce(new Error('lost DELETE response')).mockResolvedValueOnce('not_found');
    await expect(s.service.upload(actor(), input, 'typed-key-0001', s.reader)).rejects.toMatchObject({ code: 'POST_APPROVAL_ROOM_ISSUE_UPLOAD_NOT_ACCEPTED' });
    expect(s.provider.remove).toHaveBeenNthCalledWith(1, 'provider_file_123'); expect(s.provider.remove).toHaveBeenNthCalledWith(2, 'provider_file_123');
    expect(s.rpcArgs.filter(call => call.name === 'prepare_post_approval_room_issue_evidence_delete').every(call => call.args.p_operation_id === id(6) && call.args.p_lease_version === 1)).toBe(true);
    expect(s.rpcArgs.find(call => call.name === 'settle_post_approval_room_issue_evidence_delete')?.args).toMatchObject({ p_delete_token: id(9), p_result: 'not_found',
      p_operation_id: id(6), p_lease_version: 1, p_fence_token_digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(s.calls).not.toContain('finalize_post_approval_room_issue_evidence_upload');
  });
  it('settle response loss recognizes compensated DB state without further DELETE', async () => {
    let s: ReturnType<typeof setup>;
    s = setup(name => {
      if (name === 'settle_post_approval_room_issue_evidence_delete') { s.setState('compensated'); throw new Error('response loss after settle commit'); }
      return undefined;
    });
    vi.mocked(s.provider.upload).mockResolvedValueOnce({ uploadedAt: '2026-10-05T15:01:00Z' });
    await expect(s.service.upload(actor(), input, 'typed-key-0001', s.reader)).rejects.toMatchObject({ code: 'POST_APPROVAL_ROOM_ISSUE_UPLOAD_NOT_ACCEPTED' });
    expect(s.provider.remove).toHaveBeenCalledOnce(); expect(s.calls).not.toContain('finalize_post_approval_room_issue_evidence_upload');
  });
  it('malformed cross-evidence accepted receipt is rejected before provider calls', async () => {
    const s = setup(name => name === 'begin_post_approval_room_issue_evidence_upload' ? {
      data: { operationId: id(6), evidenceId: id(99), status: 'accepted', leaseVersion: 1, itemRevision: 1, evidenceRevision: 1, ...metadata }, error: null } : undefined);
    await expect(s.service.upload(actor(), input, 'typed-key-0001', s.reader)).rejects.toMatchObject({ statusCode: 500 });
    expect(s.calls.filter(call => call.startsWith('provider.'))).toEqual([]);
  });
  it('status strips provider fields and uses the current request session', async () => {
    const s = setup(); s.setState('accepted');
    expect(await s.service.status(actor('admin', id(20)), id(6))).not.toHaveProperty('providerFileId');
    expect(s.rpcArgs[0]?.args).toEqual({ p_actor_profile_id: id(1), p_session_id: id(20), p_operation_id: id(6) });
  });
});

describe('typed evidence content authorization', () => {
  it('reauthorizes after external read and returns bytes/MIME only', async () => {
    const s = setup();
    expect(await s.service.content(actor(), id(5), 1)).toEqual({ bytes, mimeType: 'image/jpeg' });
    expect(s.calls).toEqual(['get_post_approval_room_issue_evidence_content', 'provider.read', 'get_post_approval_room_issue_evidence_content']);
    expect(s.rpcArgs.every(call => call.args.p_evidence_id === id(5) && call.args.p_revision === 1)).toBe(true);
  });
  it.each(['SESSION_REVOKED', 'POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED', 'POST_APPROVAL_ROOM_ISSUE_MEDIA_PURGED'])('post-read %s returns no bytes', async code => {
    let count = 0;
    const s = setup(name => name === 'get_post_approval_room_issue_evidence_content' && count++ > 0
      ? { data: null, error: { message: code } } : undefined);
    await expect(s.service.content(actor(), id(5), 1)).rejects.toMatchObject({ code });
    expect(s.provider.read).toHaveBeenCalledOnce();
  });
  it('other maid denial precedes provider read', async () => {
    const s = setup(name => name === 'get_post_approval_room_issue_evidence_content' ? {
      data: null, error: { message: 'POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED' } } : undefined);
    await expect(s.service.content(actor(), id(5), 1)).rejects.toMatchObject({ statusCode: 403 });
    expect(s.provider.read).not.toHaveBeenCalled();
  });
  it('does not deliver mismatched bytes or changed identity', async () => {
    const s = setup(); vi.mocked(s.provider.read).mockResolvedValueOnce(Uint8Array.from([3, 2, 1]));
    await expect(s.service.content(actor(), id(5), 1)).rejects.toMatchObject({ statusCode: 503 });
  });
  it('does not deliver bytes if the authorized physical identity changes across the read', async () => {
    let reads = 0;
    const s = setup(name => name === 'get_post_approval_room_issue_evidence_content' && reads++ > 0
      ? { data: { fileId: 'changed_file_123', ...metadata }, error: null } : undefined);
    await expect(s.service.content(actor(), id(5), 1)).rejects.toMatchObject({ statusCode: 503 });
  });
});
