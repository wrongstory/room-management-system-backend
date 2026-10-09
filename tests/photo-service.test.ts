import { readFile } from 'node:fs/promises';
import { ImageMagick, MagickColors, MagickFormat } from '@imagemagick/magick-wasm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as photoBinary from '../src/modules/photos/photo-binary.js';
import { initializePhotoDecoder, PhotoError, PHOTO_INPUT_MAX_BYTES } from '../src/modules/photos/photo-binary.js';
import { PhotoService, PhotoTiming, photoRoute, type PhotoIdentity, type PhotoRpc } from '../src/modules/photos/photo-service.js';
import type { PhotoProvider } from '../src/modules/photos/google-drive.js';
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
afterEach(() => vi.restoreAllMocks());
const identity: PhotoIdentity = { profileId: id(1), sessionId: id(2), role: 'maid', profileStatus: 'active' };
const now = new Date().toISOString(), purgeAfter = new Date(Date.parse(now) + 604800000).toISOString();
const retention = { retentionPolicy: 'cleaning_submission', retentionStartsAt: now,
  expiresAt: purgeAfter, purgedAt: null, mediaAvailability: 'available' };
const operation = (status = 'reserved', photoItemId: string | null = null) => ({ operationId: id(5), objectId: id(6), attemptId: id(3), targetSlotId: id(4), photoItemId, status,
  leaseVersion: 1, leaseExpiresAt: new Date(Date.now() + 300000).toISOString(), photoId: status === 'accepted' ? id(7) : null,
  photoVersion: status === 'accepted' ? 1 : null, collectionRevision: photoItemId === null ? null : status === 'accepted' ? 1 : 0,
  itemRevision: photoItemId === null ? null : status === 'accepted' ? 1 : 0, uploadedAt: ['reserved', 'reconciliation_pending'].includes(status) ? null : now,
  purgeAfter: ['reserved', 'reconciliation_pending'].includes(status) ? null : purgeAfter,
  ...(['reserved', 'reconciliation_pending'].includes(status)
    ? { retentionPolicy: null, retentionStartsAt: null, expiresAt: null, purgedAt: null, mediaAvailability: null }
    : retention), compensationAllowed: status === 'compensation_pending' });
let bytes: Uint8Array;
beforeAll(async () => {
  await initializePhotoDecoder(await readFile(new URL(import.meta.resolve('@imagemagick/magick-wasm/magick.wasm'))));
  bytes = ImageMagick.read(MagickColors.White, 16, 16, image => image.write(MagickFormat.Jpeg, data => Uint8Array.from(data)));
});
function request(raw = bytes) { return new Request(`http://local/v1/attempts/${id(3)}/photo-slots/${id(4)}/upload?assignmentId=${id(8)}&assignmentRevision=1&expectedPhotoRevision=0`, {
  method: 'POST', headers: { 'content-type': 'image/jpeg', 'idempotency-key': 'test-key-0001' }, body: Uint8Array.from(raw)
}); }
function setup(override: (name: string, args: Record<string, unknown>) => unknown = () => undefined) {
  const calls: string[] = []; let context: Record<string, unknown> = {}; let collectionItemId: string | null = null;
  const provider: PhotoProvider = { quota: vi.fn(async () => ({ refreshStartedAt: now, usageBytes: '0' })), generateUploadIds: vi.fn(async (): Promise<[string, string, string]> => ['candidate_date_123', 'candidate_room_123', 'provider_file_123']),
    rootFolderId: () => 'provider_root_123', ensureFolder: vi.fn(async () => {}), upload: vi.fn(async () => ({ uploadedAt: now })), inspect: vi.fn(async () => ({ uploadedAt: now })),
    read: vi.fn(async () => bytes), remove: vi.fn(async () => 'deleted' as const) };
  const db: PhotoRpc = { rpc: async (name, args) => {
    calls.push(name); const supplied = override(name, args); if (supplied !== undefined) return await supplied as {data:unknown;error:unknown};
    let data: unknown = null;
    if (name === 'admit_photo_upload') data = { admissionId: id(9), quotaWarning: false };
    if (name === 'admit_photo_collection_upload') { collectionItemId = String(args.p_photo_item_id); data = { admissionId: id(9), quotaWarning: false }; }
    if (name === 'reserve_photo_drive_folder') data = { scope: args.p_scope, folderId: args.p_scope === 'date' ? 'provider_date_123' : 'provider_folder_123', parentFolderId: args.p_scope === 'date' ? 'provider_root_123' : 'provider_date_123', uploadDate: context.uploadDate, roomNumber: args.p_scope === 'date' ? null : '101' };
    if (name === 'begin_admitted_photo_upload') { context = { objectId: id(6), sha256: args.p_sha256, mimeType: args.p_mime_type, sizeBytes: args.p_size_bytes,
      roomNumber: '101', uploadDate: new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10), providerFileId: null, providerFolderId: null }; data = operation(); }
    if (name === 'begin_admitted_photo_collection_upload') { context = { objectId: id(6), sha256: args.p_sha256, mimeType: args.p_mime_type, sizeBytes: args.p_size_bytes,
      roomNumber: '101', uploadDate: new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10), providerFileId: null, providerFolderId: null }; data = operation('reserved', collectionItemId); }
    if (name === 'claim_admitted_photo_upload') data = operation('reserved', collectionItemId);
    if (name === 'get_photo_provider_context') data = context;
    if (name === 'reserve_named_photo_provider_identity') { context = { ...context, providerFileId: args.p_provider_file_id, providerFolderId: args.p_provider_folder_id,
      fileName: collectionItemId === null ? null : `${context.uploadDate}_일반방_101_01.jpg` }; data = context; }
    if (name === 'record_admitted_photo_provider_success') data = operation('provider_succeeded', collectionItemId);
    if (name === 'finalize_admitted_photo_upload' || name === 'get_admitted_photo_upload' || name === 'reconcile_admitted_photo_upload' || name === 'get_photo_upload_receipt_with_session') data = operation('accepted', collectionItemId);
    if (name === 'authorize_photo_read') data = { photoId: id(7), providerFileId: 'provider_file_123', sha256: 'a'.repeat(64), mimeType: 'image/jpeg', sizeBytes: bytes.length, ...retention };
    return { data, error: null };
  } };
  return { calls, provider, service: new PhotoService(db, () => provider, async () => { calls.push('decode'); }) };
}
describe('photo application admission/provider/finalize boundary', () => {
  const emptySlots = { attemptId: id(3), assignmentId: id(8), assignmentRevision: 1, slots: [] };
  function includedRequest(option = 'true') { const base = request(); return new Request(base.url + '&includePhotoSlots=' + option, base); }
  it('keeps legacy upload response and RPC sequence unchanged without opt-in', async () => {
    const s = setup(); const result = await s.service.upload(request(), identity, id(3), id(4));
    expect(result).not.toHaveProperty('photoSlots');
    expect(s.calls).not.toContain('get_attempt_photo_slots');
  });
  it('adds an authorized projected snapshot after acceptance without leaking private DB fields', async () => {
    const s = setup((name, args) => {
      if (name !== 'get_attempt_photo_slots') return undefined;
      expect(args).toEqual({ p_actor_profile_id: id(1), p_session_id: id(2), p_attempt_id: id(3) });
      return { data: { ...emptySlots, providerFileId: 'private', hash: 'private' }, error: null };
    });
    expect(await s.service.upload(includedRequest(), identity, id(3), id(4))).toMatchObject({ status: 'accepted', photoSlots: emptySlots });
    expect(s.calls.at(-1)).toBe('get_attempt_photo_slots');
    expect(s.calls.filter(name => name === 'finalize_admitted_photo_upload')).toHaveLength(1);
  });
  it.each(['SESSION_REVOKED', 'PHOTO_ACCESS_REQUIRED', 'PHOTO_UPLOAD_FAILED'])('preserves accepted receipt when snapshot fails: %s', async code => {
    const s = setup(name => name === 'get_attempt_photo_slots' ? { data: null, error: { message: code } } : undefined);
    expect(await s.service.upload(includedRequest(), identity, id(3), id(4))).toMatchObject({ status: 'accepted', photoSlots: null });
    expect(s.provider.remove).not.toHaveBeenCalled();
    expect(s.provider.upload).toHaveBeenCalledOnce();
    expect(s.calls).not.toContain('reconcile_admitted_photo_upload');
  });
  it.each([
    { ...emptySlots, attemptId: id(99) }, { ...emptySlots, assignmentId: id(99) },
    { ...emptySlots, assignmentRevision: 2 }, { ...emptySlots, slots: 'invalid' },
  ])('does not attach a changed or malformed snapshot', async snapshot => {
    const s = setup(name => name === 'get_attempt_photo_slots' ? { data: snapshot, error: null } : undefined);
    expect(await s.service.upload(includedRequest(), identity, id(3), id(4))).toMatchObject({ status: 'accepted', photoSlots: null });
  });
  it('refreshes the snapshot on accepted replay without new provider writes', async () => {
    const s = setup(name => name === 'begin_admitted_photo_upload' ? { data: operation('accepted'), error: null }
      : name === 'get_attempt_photo_slots' ? { data: emptySlots, error: null } : undefined);
    expect(await s.service.upload(includedRequest(), identity, id(3), id(4))).toMatchObject({ status: 'accepted', photoSlots: emptySlots });
    expect(s.provider.upload).not.toHaveBeenCalled();
  });
  it.each(['false', '', '1', 'TRUE', 'true&includePhotoSlots=true', 'true&extra=1'])('rejects invalid/duplicate/unknown query before admission: %s', async option => {
    const s = setup();
    await expect(s.service.upload(includedRequest(option), identity, id(3), id(4))).rejects.toMatchObject({ statusCode: 400 });
    expect(s.calls).toEqual([]); expect(s.provider.upload).not.toHaveBeenCalled();
  });
  it('keeps the accepted receipt and same hash inputs when opting in', async () => {
    const captured: Record<string, unknown>[] = [];
    const make = () => setup((name, args) => {
      if (name === 'begin_admitted_photo_upload') captured.push(args);
      if (name === 'get_attempt_photo_slots') return { data: emptySlots, error: null };
      return undefined;
    });
    const plain = await make().service.upload(request(), identity, id(3), id(4));
    const { photoSlots, ...included } = await make().service.upload(includedRequest(), identity, id(3), id(4));
    expect({ ...included, leaseExpiresAt: null }).toEqual({ ...plain, leaseExpiresAt: null }); expect(photoSlots).toEqual(emptySlots);
    expect(captured[0]?.p_request_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(captured[0]?.p_request_hash).toBe(captured[1]?.p_request_hash);
    expect(captured[0]?.p_sha256).toBe(captured[1]?.p_sha256);
  });
  it.each(['active', 'upload_only', 'deactivation_pending'])('collection snapshot preserves revision and photo identity visibility: %s', async profileStatus => {
    const slots = { ...emptySlots, slots: [{ slotId: id(4), slotKey: 'cleaning-proof', required: true, displayOrder: 0,
      maxPhotos: 20, currentRevision: 0, collectionRevision: 1, photoCount: 1, uploadStatus: 'verified', photoId: null, ...retention,
      photos: [{ photoItemId: id(11), itemRevision: 1, displayOrder: 0, photoId: id(7), photoVersion: 1, uploadStatus: 'verified', ...retention }] }] };
    const s = setup(name => name === 'get_attempt_photo_slots' ? { data: slots, error: null } : undefined);
    const req = new Request(`http://local/upload?assignmentId=${id(8)}&assignmentRevision=1&expectedCollectionRevision=0&expectedItemRevision=0&includePhotoSlots=true`, {
      method: 'POST', headers: { 'content-type': 'image/jpeg', 'idempotency-key': 'snapshot-collection-409' }, body: Uint8Array.from(bytes),
    });
    const result = await s.service.upload(req, { ...identity, profileStatus }, id(3), id(4), id(11));
    expect(result).toMatchObject({ status: 'accepted', collectionRevision: 1, photoSlots: { slots: [{ collectionRevision: 1,
      photoId: null, photos: [{ photoId: profileStatus === 'active' ? id(7) : null }] }] } });
  });
  it('shares quota refresh coordination across timed scopes without sharing request durations', async () => {
    let refreshDone = false;
    const s = setup(name => {
      if (name === 'admit_photo_upload' && !refreshDone) return { data: null, error: { message: 'PHOTO_STORAGE_QUOTA_UNAVAILABLE' } };
      if (name === 'refresh_photo_storage_quota') refreshDone = true;
      if (name === 'begin_admitted_photo_upload') return { data: operation('accepted'), error: null };
      return undefined;
    });
    const first = s.service.withTiming(), second = s.service.withTiming();
    await Promise.all([first.upload(request(), identity, id(3), id(4)), second.upload(request(), identity, id(3), id(4))]);
    expect(s.provider.quota).toHaveBeenCalledOnce();
    expect(s.calls.filter(name => name === 'refresh_photo_storage_quota')).toHaveLength(1);
    expect(first.timingHeader()).toContain('photo_total'); expect(second.timingHeader()).toContain('photo_total');
  });
  it('isolates timing state across simultaneous requests on one shared service', async () => {
    const s = setup();
    const first = s.service.withTiming(), second = s.service.withTiming();
    await Promise.all([first.upload(request(), identity, id(3), id(4)), second.content(new Request('http://local'), identity, id(7))]);
    expect(first.timingHeader()).toContain('photo_decode;dur=');
    expect(second.timingHeader()).not.toContain('photo_decode');
    expect(second.timingHeader()).toContain('photo_drive;dur=');
    expect(s.service.timingHeader()).toBeUndefined();
    expect(first.timingHeader()).not.toContain('provider_');
    expect(first.timingHeader()).not.toContain(id(1));
  });
  it('records fixed numeric timing stages on success and failure without retaining error text', async () => {
    let clock = 0; const timing = new PhotoTiming(() => clock);
    await timing.measure('db', async () => { clock += 12; });
    await expect(timing.measure('db', () => { clock += 3; throw new Error('private-secret'); })).rejects.toThrow('private-secret');
    expect(timing.header()).toBe('photo_db;dur=15.0, photo_total;dur=15.0');
  });
  it('reserves distinct batched candidates before creating only the DB folder winners', async () => {
    const reservations: Record<string, unknown>[] = [];
    const s = setup((name, args) => { if (name === 'reserve_photo_drive_folder') reservations.push(args); return undefined; });
    expect((await s.service.upload(request(), identity, id(3), id(4))).status).toBe('accepted');
    expect(s.provider.generateUploadIds).toHaveBeenCalledOnce();
    expect(reservations.map(args => args.p_candidate_folder_id)).toEqual(['candidate_date_123', 'candidate_room_123']);
    expect(s.provider.ensureFolder).toHaveBeenNthCalledWith(1, expect.objectContaining({ folderId: 'provider_date_123' }));
    expect(s.provider.ensureFolder).toHaveBeenNthCalledWith(2, expect.objectContaining({ folderId: 'provider_folder_123' }));
    expect(s.calls.indexOf('reserve_named_photo_provider_identity')).toBeGreaterThan(s.calls.lastIndexOf('reserve_photo_drive_folder'));
    expect(s.provider.upload).toHaveBeenCalledWith(expect.objectContaining({ fileId: 'provider_file_123', folderId: 'provider_folder_123' }), expect.any(Uint8Array));
  });
  it('accepted replay allocates no new Drive identities', async () => {
    const s = setup(name => name === 'begin_admitted_photo_upload' ? { data: operation('accepted'), error: null } : undefined);
    expect((await s.service.upload(request(), identity, id(3), id(4))).status).toBe('accepted');
    expect(s.provider.generateUploadIds).not.toHaveBeenCalled();
    expect(s.provider.ensureFolder).not.toHaveBeenCalled();
    expect(s.provider.upload).not.toHaveBeenCalled();
  });
  it('pending retry with a durable identity reuses it without another candidate batch', async () => {
    let metadata: Record<string, unknown> = {};
    const s = setup((name, args) => {
      if (name === 'begin_admitted_photo_upload') metadata = args;
      if (name !== 'get_photo_provider_context') return undefined;
      return { data: { objectId: id(6), sha256: metadata.p_sha256, mimeType: metadata.p_mime_type, sizeBytes: metadata.p_size_bytes,
        roomNumber: '101', uploadDate: new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10), providerFileId: 'existing_file_123', providerFolderId: 'existing_folder_123' }, error: null };
    });
    expect((await s.service.upload(request(), identity, id(3), id(4))).status).toBe('accepted');
    expect(s.provider.generateUploadIds).not.toHaveBeenCalled();
    expect(s.provider.ensureFolder).not.toHaveBeenCalled();
    expect(s.calls).not.toContain('reserve_named_photo_provider_identity');
    expect(s.provider.upload).toHaveBeenCalledWith(expect.objectContaining({ fileId: 'existing_file_123', folderId: 'existing_folder_123' }), expect.any(Uint8Array));
  });
  it.each([false, true])('replays the exact legacy JPEG hash after begin conflict only (collection=%s)', async collection => {
    const current = { bytes, mime: 'image/jpeg' as const, sizeBytes: bytes.length, sha256: 'a'.repeat(64) };
    const legacy = { ...current, sha256: 'b'.repeat(64) };
    const decode = vi.spyOn(photoBinary, 'verifyPhotoBinary').mockResolvedValueOnce(current).mockResolvedValueOnce(legacy);
    const begins: Record<string, unknown>[] = [];
    const s = setup((name, args) => {
      if (!name.startsWith('begin_admitted_photo')) return undefined;
      begins.push(args);
      return begins.length === 1 ? { data: null, error: { message: 'IDEMPOTENCY_KEY_REUSED' } }
        : { data: operation('accepted', collection ? id(7) : null), error: null };
    });
    const req = collection ? new Request(`http://local/upload?assignmentId=${id(8)}&assignmentRevision=1&expectedCollectionRevision=0&expectedItemRevision=0`, {
      method: 'POST', headers: { 'content-type': 'image/jpeg', 'idempotency-key': 'test-key-0001' }, body: Uint8Array.from(bytes),
    }) : request();
    expect((await s.service.upload(req, identity, id(3), id(4), collection ? id(7) : undefined)).status).toBe('accepted');
    expect(decode).toHaveBeenCalledTimes(2);
    expect(decode).toHaveBeenLastCalledWith(bytes, 'image/jpeg', 'legacy');
    expect(begins[1]).toMatchObject({ p_sha256: legacy.sha256, p_admission_id: begins[0]?.p_admission_id, p_idempotency_key_digest: begins[0]?.p_idempotency_key_digest });
    expect(begins[1]?.p_request_hash).not.toBe(begins[0]?.p_request_hash);
    expect(s.provider.upload).not.toHaveBeenCalled();
  });
  it('uses legacy bytes throughout a pending retry, never a new operation or key', async () => {
    const legacyBytes = Uint8Array.from([1, 2, 3]);
    vi.spyOn(photoBinary, 'verifyPhotoBinary').mockResolvedValueOnce({ bytes, mime: 'image/jpeg', sizeBytes: bytes.length, sha256: 'a'.repeat(64) })
      .mockResolvedValueOnce({ bytes: legacyBytes, mime: 'image/jpeg', sizeBytes: 3, sha256: 'b'.repeat(64) });
    let begins = 0;
    const s = setup(name => name === 'begin_admitted_photo_upload' && begins++ === 0 ? { data: null, error: { message: 'IDEMPOTENCY_KEY_REUSED' } } : undefined);
    expect((await s.service.upload(request(), identity, id(3), id(4))).status).toBe('accepted');
    expect(s.provider.upload).toHaveBeenCalledOnce();
    expect(s.provider.upload).toHaveBeenCalledWith(expect.anything(), legacyBytes);
  });
  it('does not bypass a mismatched key, permission failure, or CAS conflict', async () => {
    for (const code of ['IDEMPOTENCY_KEY_REUSED', 'PHOTO_ACCESS_REQUIRED', 'PHOTO_VERSION_CONFLICT']) {
      const decode = vi.spyOn(photoBinary, 'verifyPhotoBinary').mockResolvedValueOnce({ bytes, mime: 'image/jpeg', sizeBytes: bytes.length, sha256: 'a'.repeat(64) })
        .mockResolvedValueOnce({ bytes, mime: 'image/jpeg', sizeBytes: bytes.length, sha256: 'b'.repeat(64) });
      const s = setup(name => name === 'begin_admitted_photo_upload' ? { data: null, error: { message: code } } : undefined);
      await expect(s.service.upload(request(), identity, id(3), id(4))).rejects.toMatchObject({ code });
      expect(decode).toHaveBeenCalledTimes(code === 'IDEMPOTENCY_KEY_REUSED' ? 2 : 1);
      expect(s.provider.upload).not.toHaveBeenCalled();
      decode.mockRestore();
    }
  });
  it('keeps a single combined decode budget across legacy recovery', async () => {
    vi.spyOn(photoBinary, 'verifyPhotoBinary').mockResolvedValueOnce({ bytes, mime: 'image/jpeg', sizeBytes: bytes.length, sha256: 'a'.repeat(64) })
      .mockResolvedValueOnce({ bytes, mime: 'image/jpeg', sizeBytes: bytes.length, sha256: 'b'.repeat(64) });
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(800).mockReturnValueOnce(800).mockReturnValueOnce(1601);
    const s = setup(name => name === 'begin_admitted_photo_upload' ? { data: null, error: { message: 'IDEMPOTENCY_KEY_REUSED' } } : undefined);
    await expect(s.service.upload(request(), identity, id(3), id(4))).rejects.toMatchObject({ code: 'PHOTO_DECODE_LIMIT_EXCEEDED' });
    expect(s.calls.filter(name => name === 'begin_admitted_photo_upload')).toHaveLength(1);
    expect(s.provider.upload).not.toHaveBeenCalled();
  });
  it('admission before decode, identity committed before provider, final allowlist only', async () => {
    const s = setup(); const result = await s.service.upload(request(), identity, id(3), id(4));
    expect(result.status).toBe('accepted'); expect(s.calls.slice(0, 3)).toEqual(['admit_photo_upload', 'decode', 'begin_admitted_photo_upload']);
    expect(s.calls.indexOf('reserve_named_photo_provider_identity')).toBeLessThan(s.calls.indexOf('record_admitted_photo_provider_success'));
    expect(s.provider.upload).toHaveBeenCalledOnce(); expect(JSON.stringify(result)).not.toMatch(/provider|session|claimDigest|sha256|test-key/);
    expect(result.quotaWarning).toBe(false);
    expect(s.provider.ensureFolder).toHaveBeenNthCalledWith(1, { folderId: 'provider_date_123', parentFolderId: 'provider_root_123', name: new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10) });
    expect(s.provider.ensureFolder).toHaveBeenNthCalledWith(2, { folderId: 'provider_folder_123', parentFolderId: 'provider_date_123', name: '101' });
  });
  it('durable admission denies before CPU/Drive and raw overflow never decodes', async () => {
    const blocked = setup(name => name === 'admit_photo_upload' ? { data: null, error: { message: 'PHOTO_ACCESS_REQUIRED' } } : undefined);
    await expect(blocked.service.upload(request(), identity, id(3), id(4))).rejects.toMatchObject({ code: 'PHOTO_ACCESS_REQUIRED' });
    expect(blocked.calls).toEqual(['admit_photo_upload']); expect(blocked.provider.quota).not.toHaveBeenCalled();
    const large = setup(); await expect(large.service.upload(request(new Uint8Array(PHOTO_INPUT_MAX_BYTES + 1)), identity, id(3), id(4))).rejects.toMatchObject({ code: 'PHOTO_TOO_LARGE' });
    expect(large.calls).toEqual(['admit_photo_upload']); expect(large.provider.upload).not.toHaveBeenCalled();
  });
  it('quota refresh only after an authorized unavailable admission; accepted retry does not create again', async () => {
    let admissions = 0;
    const s = setup(name => name === 'admit_photo_upload' && admissions++ === 0 ? { data: null, error: { message: 'PHOTO_STORAGE_QUOTA_UNAVAILABLE' } }
      : name === 'begin_admitted_photo_upload' ? { data: operation('accepted'), error: null } : undefined);
    const result = await s.service.upload(request(), identity, id(3), id(4));
    expect(result.status).toBe('accepted'); expect(s.provider.quota).toHaveBeenCalledOnce(); expect(s.provider.upload).not.toHaveBeenCalled();
    expect(s.calls.slice(0,3)).toEqual(['admit_photo_upload', 'refresh_photo_storage_quota', 'admit_photo_upload']);
  });
  it('lost finalize response reconciles accepted only after exact HTTP session reauthorization', async () => {
    const s = setup(name => name === 'finalize_admitted_photo_upload' ? Promise.reject(new Error('raw secret provider failure')) : undefined);
    expect((await s.service.upload(request(), identity, id(3), id(4))).status).toBe('accepted');
    expect(s.provider.remove).not.toHaveBeenCalled(); expect(s.calls).toContain('reconcile_admitted_photo_upload');
    expect(s.calls.at(-1)).toBe('get_photo_upload_receipt_with_session');
  });
  it.each(['SESSION_REVOKED', 'CAPABILITY_ACCESS_REQUIRED', 'PHOTO_ACCESS_REQUIRED'])('accepted reconciliation does not reopen HTTP access after %s', async (code) => {
    let args: Record<string, unknown> | undefined;
    const s = setup((name, input) => {
      if (name === 'finalize_admitted_photo_upload') return Promise.reject(new Error('lost response'));
      if (name === 'get_photo_upload_receipt_with_session') {
        args = input;
        return { data: null, error: { message: code } };
      }
      return undefined;
    });
    await expect(s.service.upload(request(), identity, id(3), id(4))).rejects.toMatchObject({ code });
    expect(args).toEqual({ p_actor_profile_id: identity.profileId, p_session_id: identity.sessionId, p_operation_id: id(5) });
    expect(s.provider.remove).not.toHaveBeenCalled();
    expect(s.calls).toContain('reconcile_admitted_photo_upload');
  });
  it('exposes only the admission quota warning on initial and accepted retry responses', async () => {
    for (const replay of [false, true]) {
      const s = setup(name => name === 'admit_photo_upload' ? { data: { admissionId: id(9), quotaWarning: true, usageBytes: 'private' }, error: null }
        : replay && name === 'begin_admitted_photo_upload' ? { data: operation('accepted'), error: null } : undefined);
      const result = await s.service.upload(request(), identity, id(3), id(4));
      expect(result.quotaWarning).toBe(true); expect(result).not.toHaveProperty('usageBytes');
    }
  });
  it('KST midnight rejects before create or after verified provider success without moving or accepting a candidate', async () => {
    for (const crossDuringHttp of [false, true]) {
      let metadata: Record<string, unknown> = {};
      const s = setup((name, args) => {
        if (name === 'begin_admitted_photo_upload') metadata = { objectId: id(6), sha256: args.p_sha256, mimeType: args.p_mime_type, sizeBytes: args.p_size_bytes,
          uploadDate: '2020-01-01', roomNumber: '101', providerFileId: 'provider_file_123', providerFolderId: 'provider_folder_123' };
        if (!crossDuringHttp && name === 'get_photo_provider_context') return { data: metadata, error: null };
        if (crossDuringHttp && name === 'finalize_admitted_photo_upload') return { data: null, error: { message: 'PHOTO_PROVIDER_DATE_MISMATCH' } };
        if (name === 'reconcile_admitted_photo_upload') return { data: operation('reconciliation_pending'), error: null };
        return undefined;
      });
      await expect(s.service.upload(request(), identity, id(3), id(4))).rejects.toMatchObject({ code: 'PHOTO_PROVIDER_DATE_MISMATCH', statusCode: 409 });
      expect(s.provider.upload).toHaveBeenCalledTimes(crossDuringHttp ? 1 : 0);
      expect(s.provider.remove).not.toHaveBeenCalled();
    }
  });
  it('unknown result is not deletion permission; only exact fenced compensation may delete', async () => {
    for (const unknown of [true, false]) {
      const s = setup(name => name === 'reconcile_admitted_photo_upload' ? { data: operation(unknown ? 'reconciliation_pending' : 'compensation_pending'), error: null }
        : name === 'get_photo_reconciliation_context' ? { data: { ...operation(unknown ? 'reconciliation_pending' : 'compensation_pending'), providerFileId: 'provider_file_123', providerFolderId: 'provider_folder_123', sha256: 'a'.repeat(64), mimeType: 'image/jpeg', sizeBytes: 100 }, error: null }
        : name === 'settle_admitted_photo_compensation' ? { data: operation('compensated'), error: null } : undefined);
      if (unknown) { vi.mocked(s.provider.inspect).mockRejectedValue(new PhotoError(503, 'PHOTO_PROVIDER_UNAVAILABLE')); await expect(s.service.reconcile(id(5))).rejects.toMatchObject({ code: 'PHOTO_PROVIDER_UNAVAILABLE' }); expect(s.provider.remove).not.toHaveBeenCalled(); }
      else { expect((await s.service.reconcile(id(5))).status).toBe('compensated'); expect(s.provider.remove).toHaveBeenCalledOnce(); }
      expect(s.provider.upload).not.toHaveBeenCalled();
    }
  });
  it('read revalidates after provider wait and never returns bytes after revoked authorization', async () => {
    let reads = 0;
    const s = setup(name => name === 'authorize_photo_read' && ++reads === 2 ? { data: null, error: { message: 'PHOTO_ACCESS_REQUIRED' } } : undefined);
    await expect(s.service.content(new Request('http://local/'), identity, id(7))).rejects.toMatchObject({ code: 'PHOTO_ACCESS_REQUIRED' });
    expect(s.provider.read).toHaveBeenCalledOnce();
    for (const profileStatus of ['upload_only', 'deactivation_pending']) await expect(s.service.content(new Request('http://local/'), { ...identity, profileStatus }, id(7))).rejects.toMatchObject({ code: 'PHOTO_ACCESS_REQUIRED' });
    expect(reads).toBe(2);
  });
  it('known uncertain candidate is inspected, never recreated, before fenced compensation', async () => {
    let known = false;
    const s = setup(name => {
      if (name === 'record_admitted_photo_provider_success') { known = true; return { data: operation('compensation_pending'), error: null }; }
      return name === 'reconcile_admitted_photo_upload' ? { data: operation('reconciliation_pending'), error: null }
      : name === 'get_photo_reconciliation_context' ? { data: { ...operation(known ? 'compensation_pending' : 'reconciliation_pending'), providerFileId: 'provider_file_123', providerFolderId: 'provider_folder_123', sha256: 'a'.repeat(64), mimeType: 'image/jpeg', sizeBytes: 100 }, error: null }
      : name === 'settle_admitted_photo_compensation' ? { data: operation('compensated'), error: null } : undefined;
    });
    expect((await s.service.reconcile(id(5))).status).toBe('compensated');
    expect(s.provider.inspect).toHaveBeenCalledOnce(); expect(s.provider.remove).toHaveBeenCalledOnce(); expect(s.provider.upload).not.toHaveBeenCalled();
    expect(s.calls.filter(x => x === 'get_photo_reconciliation_context')).toHaveLength(2);
  });
  it('safe read headers and slot metadata separate upload-only from original content', async () => {
    const s = setup(name => name === 'get_attempt_photo_slots' ? { data: { attemptId: id(3), assignmentId: id(8), assignmentRevision: 1,
      slots: [{ slotId: id(4), slotKey: 'tv', required: true, displayOrder: 0, currentRevision: 1, uploadStatus: 'verified', photoId: id(7), providerFileId: 'do_not_expose', ...retention }] }, error: null } : undefined);
    const res = await s.service.content(new Request('http://local/'), identity, id(7));
    expect(res.headers.get('cache-control')).toBe('no-store'); expect(res.headers.get('x-content-type-options')).toBe('nosniff'); expect(res.headers.has('location')).toBe(false);
    const result = await s.service.slots(new Request('http://local/'), { ...identity, profileStatus: 'upload_only' }, id(3));
    expect(JSON.stringify(result)).not.toContain('do_not_expose'); expect(result).toMatchObject({ slots: [{ photoId: null }] });
  });
  it.each(['일반방', '폭탄방', '특이사항'])('uses a frozen readable %s name only after read authorization', async category => {
    const fileName = `2026-10-05_${category}_350_100.jpg`;
    const s = setup(name => name === 'authorize_photo_read' ? { data: {
      photoId: id(7), providerFileId: 'provider_file_123', sha256: 'a'.repeat(64),
      mimeType: 'image/jpeg', sizeBytes: bytes.length, fileName, ...retention,
    }, error: null } : undefined);
    const res = await s.service.content(new Request('http://local/'), identity, id(7));
    expect(res.headers.get('content-disposition')).toBe(`inline; filename="photo.jpg"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    expect(res.headers.get('access-control-expose-headers')).toBe('Content-Disposition');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(s.calls.filter(name => name === 'authorize_photo_read')).toHaveLength(2);
    expect(res.headers.get('content-disposition')).not.toContain('provider_file_123');
  });
  it('denies corrupt or changed names before returning any protected bytes', async () => {
    for (const fileNames of [['2026-10-05_일반방_350_01.jpg', '2026-10-05_폭탄방_350_01.jpg'], ['../secret.jpg', '../secret.jpg']]) {
      let reads = 0;
      const s = setup(name => name === 'authorize_photo_read' ? { data: {
        photoId: id(7), providerFileId: 'provider_file_123', sha256: 'a'.repeat(64),
        mimeType: 'image/jpeg', sizeBytes: bytes.length, fileName: fileNames[reads++], ...retention,
      }, error: null } : undefined);
      await expect(s.service.content(new Request('http://local/'), identity, id(7))).rejects.toMatchObject({
        code: fileNames[0] === '../secret.jpg' ? 'PHOTO_UPLOAD_FAILED' : 'PHOTO_ACCESS_REQUIRED',
      });
      expect(s.provider.read).toHaveBeenCalledTimes(fileNames[0] === '../secret.jpg' ? 0 : 1);
    }
  });
  it('pending named identity retry keeps its name and does not reserve a replacement', async () => {
    let metadata: Record<string, unknown> = {};
    const date = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
    const fileName = `${date}_폭탄방_101_100.jpg`;
    const s = setup((name, args) => {
      if (name === 'begin_admitted_photo_upload') metadata = args;
      if (name !== 'get_photo_provider_context') return undefined;
      return { data: { objectId: id(6), sha256: metadata.p_sha256, mimeType: metadata.p_mime_type, sizeBytes: metadata.p_size_bytes,
        fileName, roomNumber: '101', uploadDate: date, providerFileId: 'existing_file_123', providerFolderId: 'existing_folder_123' }, error: null };
    });
    expect((await s.service.upload(request(), identity, id(3), id(4))).status).toBe('accepted');
    expect(s.calls).not.toContain('reserve_named_photo_provider_identity');
    expect(s.provider.generateUploadIds).not.toHaveBeenCalled();
    expect(s.provider.upload).toHaveBeenCalledWith(expect.objectContaining({ fileName }), expect.any(Uint8Array));
  });
  it('accepts an empty slot without retention metadata and requires metadata for an existing hidden photo', async () => {
    const slotBase = { slotId: id(4), slotKey: 'tv', required: true, displayOrder: 0,
      maxPhotos: 1, collectionRevision: null, photoCount: 0 };
    const empty = setup(name => name === 'get_attempt_photo_slots' ? { data: {
      attemptId: id(3), assignmentId: id(8), assignmentRevision: 1,
      slots: [{ ...slotBase, currentRevision: 0, uploadStatus: 'missing', photoId: null, photos: [] }]
    }, error: null } : undefined);
    await expect(empty.service.slots(new Request('http://local/'), identity, id(3)))
      .resolves.toMatchObject({ slots: [{ uploadStatus: 'missing', photoId: null, photos: [] }] });
    const hidden = setup(name => name === 'get_attempt_photo_slots' ? { data: {
      attemptId: id(3), assignmentId: id(8), assignmentRevision: 1,
      slots: [{ ...slotBase, currentRevision: 1, photoCount: 1, uploadStatus: 'verified', photoId: null,
        photos: [{ photoItemId: null, itemRevision: 1, displayOrder: 0, photoId: null,
          photoVersion: 1, uploadStatus: 'verified', ...retention }], ...retention }]
    }, error: null } : undefined);
    await expect(hidden.service.slots(new Request('http://local/'), { ...identity, profileStatus: 'upload_only' }, id(3)))
      .resolves.toMatchObject({ slots: [{ photoId: null, photos: [{ photoId: null, mediaAvailability: 'available' }] }] });
    const malformed = setup(name => name === 'get_attempt_photo_slots' ? { data: {
      attemptId: id(3), assignmentId: id(8), assignmentRevision: 1,
      slots: [{ ...slotBase, currentRevision: 1, photoCount: 1, uploadStatus: 'verified', photoId: null,
        photos: [{ photoItemId: null, itemRevision: 1, displayOrder: 0, photoId: null, photoVersion: 1, uploadStatus: 'verified' }] }]
    }, error: null } : undefined);
    await expect(malformed.service.slots(new Request('http://local/'), identity, id(3)))
      .rejects.toMatchObject({ code: 'PHOTO_UPLOAD_FAILED' });
  });
  it('four exact route shapes and strict upload query; aliases never accepted', async () => {
    expect(photoRoute('GET', `/v1/attempts/${id(3)}/photo-slots`)?.kind).toBe('slots');
    expect(photoRoute('POST', `/v1/attempts/${id(3)}/photo-slots/${id(4)}/photos/${id(7)}/upload`)).toMatchObject({ kind: 'upload', photoItemId: id(7) });
    expect(photoRoute('DELETE', `/v1/attempts/${id(3)}/photo-slots/${id(4)}/photos/${id(7)}`)).toMatchObject({ kind: 'delete-item', photoItemId: id(7) });
    for (const path of [`/v1/photos/${id(7)}/content/extra`, `/v1/photos/${id(7)}/content/`, `/v1/attempts/${id(3)}/photo-slots/${id(4)}/upload`]) expect(photoRoute('GET', path)).toBeNull();
    const s = setup(); const req = request(); const duplicate = new Request(`${req.url}&assignmentRevision=1`, req);
    await expect(s.service.upload(duplicate, identity, id(3), id(4))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' }); expect(s.calls).toEqual([]);
  });
  it('deletes one collection item with collection and item CAS revisions', async () => {
    const s=setup(name=>name==='delete_photo_collection_item'?{data:{attemptId:id(3),targetSlotId:id(4),photoItemId:id(7),collectionRevision:3,itemRevision:2,deleted:true},error:null}:undefined);
    const req=new Request(`http://local/v1/attempts/${id(3)}/photo-slots/${id(4)}/photos/${id(7)}?assignmentId=${id(8)}&assignmentRevision=1&expectedCollectionRevision=2&expectedItemRevision=1`,
      {method:'DELETE',headers:{'idempotency-key':'delete-key-0001'}});
    await expect(s.service.deleteItem(req,identity,id(3),id(4),id(7))).resolves.toEqual({attemptId:id(3),targetSlotId:id(4),photoItemId:id(7),collectionRevision:3,itemRevision:2,deleted:true});
    expect(s.calls).toContain('delete_photo_collection_item');
  });
  it('runs collection upload through dedicated admission and begin RPCs', async () => {
    const s=setup();
    const req=new Request(`http://local/v1/attempts/${id(3)}/photo-slots/${id(4)}/photos/${id(7)}/upload?assignmentId=${id(8)}&assignmentRevision=1&expectedCollectionRevision=0&expectedItemRevision=0`,
      {method:'POST',headers:{'content-type':'image/jpeg','idempotency-key':'collection-key-0001'},body:Uint8Array.from(bytes)});
    await expect(s.service.upload(req,identity,id(3),id(4),id(7))).resolves.toMatchObject({status:'accepted',photoItemId:id(7),collectionRevision:1,itemRevision:1});
    expect(s.calls.slice(0,3)).toEqual(['admit_photo_collection_upload','decode','begin_admitted_photo_collection_upload']);
    expect(s.calls).toContain('finalize_admitted_photo_upload');
    expect(s.provider.upload).toHaveBeenCalledWith(expect.objectContaining({
      fileName: `${new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10)}_일반방_101_01.jpg`,
    }), expect.any(Uint8Array));
  });
});

describe('named and legacy reconciliation workers (fake provider only)', () => {
  const variants = [
    { label: 'named', fileName: '2026-10-05_특이사항_350_100.jpg' },
    { label: 'legacy missing name', fileName: undefined },
    { label: 'legacy null name', fileName: null },
  ];
  function worker(fileName: unknown, options: {
    initialStatus?: string; recordedStatus?: string; failContextRead?: number;
    compensationAllowed?: boolean;
  } = {}) {
    const rpcArgs: { name: string; args: Record<string, unknown> }[] = [];
    let status = options.initialStatus ?? 'reconciliation_pending';
    let contextReads = 0, leaseVersion = 0;
    const s = setup((name, args) => {
      rpcArgs.push({ name, args: { ...args } });
      const projection = () => ({ ...operation(status, id(7)), leaseVersion });
      if (name === 'reconcile_admitted_photo_upload') {
        leaseVersion++;
        return { data: projection(), error: null };
      }
      if (name === 'get_photo_reconciliation_context') {
        if (++contextReads === options.failContextRead) {
          return { data: null, error: { message: 'PHOTO_UPLOAD_FENCE_CONFLICT' } };
        }
        return { data: {
          ...projection(), fileName, providerFileId: 'provider_file_123',
          providerFolderId: 'provider_folder_123', sha256: 'a'.repeat(64),
          mimeType: 'image/jpeg', sizeBytes: 100,
          compensationAllowed: options.compensationAllowed ?? status === 'compensation_pending',
        }, error: null };
      }
      if (name === 'record_admitted_photo_provider_success') {
        status = options.recordedStatus ?? 'compensation_pending';
        return { data: projection(), error: null };
      }
      if (name === 'settle_admitted_photo_compensation') {
        status = 'compensated';
        return { data: projection(), error: null };
      }
      return undefined;
    });
    return { ...s, rpcArgs };
  }

  describe.each(variants)('$label identity', ({ fileName }) => {
    it.each(['accepted', 'compensated'])('returns terminal %s without inspecting or deleting', async initialStatus => {
      const s = worker(fileName, { initialStatus });
      const result = await s.service.reconcile(id(5));
      expect(result.status).toBe(initialStatus);
      expect(s.calls).toEqual(['reconcile_admitted_photo_upload']);
      expect(s.provider.inspect).not.toHaveBeenCalled();
      expect(s.provider.remove).not.toHaveBeenCalled();
      expect(s.provider.upload).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toMatch(/fileName|provider_file_123|claimDigest/);
    });

    it('inspects the frozen name and exact object before rechecking the compensation fence', async () => {
      const s = worker(fileName);
      const result = await s.service.reconcile(id(5));
      expect(result.status).toBe('compensated');
      expect(s.provider.inspect).toHaveBeenCalledExactlyOnceWith({
        fileId: 'provider_file_123', folderId: 'provider_folder_123',
        objectId: id(6), mime: 'image/jpeg', sha256: 'a'.repeat(64), sizeBytes: 100,
        fileName: fileName ?? null,
      });
      expect(s.calls).toEqual([
        'reconcile_admitted_photo_upload', 'get_photo_reconciliation_context',
        'record_admitted_photo_provider_success', 'get_photo_reconciliation_context',
        'settle_admitted_photo_compensation',
      ]);
      const claim = s.rpcArgs[0]?.args.p_claim_digest;
      expect(claim).toMatch(/^[a-f0-9]{64}$/);
      for (const call of s.rpcArgs.slice(1)) expect(call.args).toMatchObject({
        p_operation_id: id(5), p_lease_version: 1, p_claim_digest: claim,
      });
      expect(s.provider.remove).toHaveBeenCalledExactlyOnceWith('provider_file_123');
      expect(s.provider.upload).not.toHaveBeenCalled();
      expect(s.provider.generateUploadIds).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toMatch(/fileName|provider_file_123|claimDigest/);
    });

    it.each([
      { failure: 'mismatched metadata', code: 'PHOTO_PROVIDER_IDENTITY_CONFLICT', status: 409 },
      { failure: 'missing exact identity (404)', code: 'PHOTO_PROVIDER_UNAVAILABLE', status: 503 },
      { failure: 'uncertain provider response', code: 'PHOTO_PROVIDER_UNAVAILABLE', status: 503 },
    ])('does not turn $failure into compensation permission', async ({ code, status }) => {
      const s = worker(fileName);
      vi.mocked(s.provider.inspect).mockRejectedValueOnce(new PhotoError(status, code));
      await expect(s.service.reconcile(id(5))).rejects.toMatchObject({ code });
      expect(s.calls).toEqual(['reconcile_admitted_photo_upload', 'get_photo_reconciliation_context']);
      expect(s.provider.inspect).toHaveBeenCalledOnce();
      expect(s.provider.remove).not.toHaveBeenCalled();
      expect(s.provider.upload).not.toHaveBeenCalled();
    });

    it.each(['accepted', 'reconciliation_pending', 'provider_succeeded'])('does not delete after provider acknowledgement returns %s', async recordedStatus => {
      const s = worker(fileName, { recordedStatus });
      expect((await s.service.reconcile(id(5))).status).toBe(recordedStatus);
      expect(s.provider.inspect).toHaveBeenCalledOnce();
      expect(s.provider.remove).not.toHaveBeenCalled();
      expect(s.calls.filter(name => name === 'get_photo_reconciliation_context')).toHaveLength(1);
      expect(s.calls).not.toContain('settle_admitted_photo_compensation');
    });

    it('does not delete without the explicit permission in the latest compensation context', async () => {
      const s = worker(fileName, { compensationAllowed: false });
      expect((await s.service.reconcile(id(5))).status).toBe('compensation_pending');
      expect(s.calls.filter(name => name === 'get_photo_reconciliation_context')).toHaveLength(2);
      expect(s.provider.remove).not.toHaveBeenCalled();
      expect(s.calls).not.toContain('settle_admitted_photo_compensation');
    });

    it.each([1, 2])('fails a stale context fence at read %s before deletion', async failContextRead => {
      const s = worker(fileName, { failContextRead });
      await expect(s.service.reconcile(id(5))).rejects.toMatchObject({ code: 'PHOTO_UPLOAD_FENCE_CONFLICT' });
      expect(s.provider.inspect).toHaveBeenCalledTimes(failContextRead - 1);
      expect(s.provider.remove).not.toHaveBeenCalled();
      expect(s.calls).not.toContain('settle_admitted_photo_compensation');
    });

    it('settles an authorized exact-ID delete 404 as compensated, without creating another identity', async () => {
      const s = worker(fileName, { initialStatus: 'compensation_pending' });
      vi.mocked(s.provider.remove).mockResolvedValueOnce('not_found');
      expect((await s.service.reconcile(id(5))).status).toBe('compensated');
      expect(s.provider.remove).toHaveBeenCalledExactlyOnceWith('provider_file_123');
      expect(s.rpcArgs.at(-1)).toMatchObject({ name: 'settle_admitted_photo_compensation', args: {
        p_operation_id: id(5), p_lease_version: 1, p_outcome: 'not_found',
      } });
      expect(s.provider.inspect).not.toHaveBeenCalled();
      expect(s.provider.upload).not.toHaveBeenCalled();
      expect(s.provider.generateUploadIds).not.toHaveBeenCalled();
    });

    it('keeps a failed delete unsettled and retries the same identity with a fresh DB fence', async () => {
      const s = worker(fileName, { initialStatus: 'compensation_pending' });
      vi.mocked(s.provider.remove)
        .mockRejectedValueOnce(new PhotoError(503, 'PHOTO_PROVIDER_UNAVAILABLE'))
        .mockResolvedValueOnce('not_found');
      await expect(s.service.reconcile(id(5))).rejects.toMatchObject({ code: 'PHOTO_PROVIDER_UNAVAILABLE' });
      expect(s.calls).not.toContain('settle_admitted_photo_compensation');
      expect((await s.service.reconcile(id(5))).status).toBe('compensated');
      expect(s.provider.remove).toHaveBeenNthCalledWith(1, 'provider_file_123');
      expect(s.provider.remove).toHaveBeenNthCalledWith(2, 'provider_file_123');
      const claims = s.rpcArgs.filter(call => call.name === 'reconcile_admitted_photo_upload');
      expect(claims).toHaveLength(2);
      expect(claims[1]?.args.p_claim_digest).not.toBe(claims[0]?.args.p_claim_digest);
      expect(s.rpcArgs.at(-1)).toMatchObject({ name: 'settle_admitted_photo_compensation', args: {
        p_operation_id: id(5), p_lease_version: 2,
        p_claim_digest: claims[1]?.args.p_claim_digest, p_outcome: 'not_found',
      } });
      expect(s.provider.upload).not.toHaveBeenCalled();
      expect(s.provider.generateUploadIds).not.toHaveBeenCalled();
    });
  });

  it.each(['../private.jpg', '2026-10-05_특이사항_350_100.webp'])('rejects corrupt filename %s before provider inspection or deletion', async fileName => {
    const s = worker(fileName);
    await expect(s.service.reconcile(id(5))).rejects.toMatchObject({ code: 'PHOTO_UPLOAD_FAILED' });
    expect(s.calls).toEqual(['reconcile_admitted_photo_upload', 'get_photo_reconciliation_context']);
    expect(s.provider.inspect).not.toHaveBeenCalled();
    expect(s.provider.remove).not.toHaveBeenCalled();
    expect(s.provider.upload).not.toHaveBeenCalled();
  });
});
