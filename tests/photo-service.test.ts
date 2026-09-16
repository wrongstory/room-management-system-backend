import { readFile } from 'node:fs/promises';
import { ImageMagick, MagickColors, MagickFormat } from '@imagemagick/magick-wasm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initializePhotoDecoder, PhotoError } from '../src/modules/photos/photo-binary.js';
import { PhotoService, photoRoute, type PhotoIdentity, type PhotoRpc } from '../src/modules/photos/photo-service.js';
import type { PhotoProvider } from '../src/modules/photos/google-drive.js';
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const identity: PhotoIdentity = { profileId: id(1), sessionId: id(2), role: 'maid', profileStatus: 'active' };
const now = new Date().toISOString(), purgeAfter = new Date(Date.parse(now) + 604800000).toISOString();
const operation = (status = 'reserved', photoItemId: string | null = null) => ({ operationId: id(5), objectId: id(6), attemptId: id(3), targetSlotId: id(4), photoItemId, status,
  leaseVersion: 1, leaseExpiresAt: new Date(Date.now() + 300000).toISOString(), photoId: status === 'accepted' ? id(7) : null,
  photoVersion: status === 'accepted' ? 1 : null, collectionRevision: photoItemId === null ? null : status === 'accepted' ? 1 : 0,
  itemRevision: photoItemId === null ? null : status === 'accepted' ? 1 : 0, uploadedAt: ['reserved', 'reconciliation_pending'].includes(status) ? null : now,
  purgeAfter: ['reserved', 'reconciliation_pending'].includes(status) ? null : purgeAfter, compensationAllowed: status === 'compensation_pending' });
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
  const provider: PhotoProvider = { quota: vi.fn(async () => ({ refreshStartedAt: now, usageBytes: '0' })), generateId: vi.fn(async () => 'provider_file_123'),
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
    if (name === 'reserve_photo_provider_identity') { context = { ...context, providerFileId: args.p_provider_file_id, providerFolderId: args.p_provider_folder_id }; data = context; }
    if (name === 'record_admitted_photo_provider_success') data = operation('provider_succeeded', collectionItemId);
    if (name === 'finalize_admitted_photo_upload' || name === 'get_admitted_photo_upload' || name === 'reconcile_admitted_photo_upload') data = operation('accepted', collectionItemId);
    if (name === 'authorize_photo_read') data = { photoId: id(7), providerFileId: 'provider_file_123', sha256: 'a'.repeat(64), mimeType: 'image/jpeg', sizeBytes: bytes.length, purgeAfter };
    return { data, error: null };
  } };
  return { calls, provider, service: new PhotoService(db, () => provider, async () => { calls.push('decode'); }) };
}
describe('photo application admission/provider/finalize boundary', () => {
  it('admission before decode, identity committed before provider, final allowlist only', async () => {
    const s = setup(); const result = await s.service.upload(request(), identity, id(3), id(4));
    expect(result.status).toBe('accepted'); expect(s.calls.slice(0, 3)).toEqual(['admit_photo_upload', 'decode', 'begin_admitted_photo_upload']);
    expect(s.calls.indexOf('reserve_photo_provider_identity')).toBeLessThan(s.calls.indexOf('record_admitted_photo_provider_success'));
    expect(s.provider.upload).toHaveBeenCalledOnce(); expect(JSON.stringify(result)).not.toMatch(/provider|session|claimDigest|sha256|test-key/);
    expect(result.quotaWarning).toBe(false);
    expect(s.provider.ensureFolder).toHaveBeenNthCalledWith(1, { folderId: 'provider_date_123', parentFolderId: 'provider_root_123', name: new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10) });
    expect(s.provider.ensureFolder).toHaveBeenNthCalledWith(2, { folderId: 'provider_folder_123', parentFolderId: 'provider_date_123', name: '101' });
  });
  it('durable admission denies before CPU/Drive and raw overflow never decodes', async () => {
    const blocked = setup(name => name === 'admit_photo_upload' ? { data: null, error: { message: 'PHOTO_ACCESS_REQUIRED' } } : undefined);
    await expect(blocked.service.upload(request(), identity, id(3), id(4))).rejects.toMatchObject({ code: 'PHOTO_ACCESS_REQUIRED' });
    expect(blocked.calls).toEqual(['admit_photo_upload']); expect(blocked.provider.quota).not.toHaveBeenCalled();
    const large = setup(); await expect(large.service.upload(request(new Uint8Array(307201)), identity, id(3), id(4))).rejects.toMatchObject({ code: 'PHOTO_TOO_LARGE' });
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
  it('lost finalize response reconciles accepted; no deletion after old access disappears', async () => {
    const s = setup(name => name === 'finalize_admitted_photo_upload' ? Promise.reject(new Error('raw secret provider failure')) : undefined);
    expect((await s.service.upload(request(), identity, id(3), id(4))).status).toBe('accepted');
    expect(s.provider.remove).not.toHaveBeenCalled(); expect(s.calls).toContain('reconcile_admitted_photo_upload');
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
      slots: [{ slotId: id(4), slotKey: 'tv', required: true, displayOrder: 0, currentRevision: 1, uploadStatus: 'verified', photoId: id(7), providerFileId: 'do_not_expose' }] }, error: null } : undefined);
    const res = await s.service.content(new Request('http://local/'), identity, id(7));
    expect(res.headers.get('cache-control')).toBe('no-store'); expect(res.headers.get('x-content-type-options')).toBe('nosniff'); expect(res.headers.has('location')).toBe(false);
    const result = await s.service.slots(new Request('http://local/'), { ...identity, profileStatus: 'upload_only' }, id(3));
    expect(JSON.stringify(result)).not.toContain('do_not_expose'); expect(result).toMatchObject({ slots: [{ photoId: null }] });
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
  });
});
