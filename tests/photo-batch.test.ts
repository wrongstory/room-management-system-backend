import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { preparePhotoCollectionBatch, preparePhotoCollectionUploadKey } from '../src/modules/photos/photo-upload-contract.js';
import { PhotoService, photoRoute, type PhotoIdentity } from '../src/modules/photos/photo-service.js';
import { createPhotoRoutes } from '../src/modules/photos/photo.routes.js';
import { openApiDocument } from '../supabase/functions/_shared/openapi.js';

const id = (n: number) => `41100000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor: PhotoIdentity = { profileId: id(1), sessionId: id(2), role: 'maid', profileStatus: 'active' };
const body = () => ({ assignmentId: id(3), assignmentRevision: 2, expectedCollectionRevision: 4,
  items: [5, 6].map(n => ({ photoItemId: id(n), expectedItemRevision: 0, idempotencyKey: `photo-key-${n}` })) });
const input = () => ({ ...body(), attemptId: id(7), targetSlotId: id(8) });
const path = `/v1/attempts/${id(7)}/photo-slots/${id(8)}/upload-batches`;
const request = (value: unknown = body(), headers: Record<string, string> = {}) => new Request(`http://local${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'batch-key-1', ...headers }, body: JSON.stringify(value),
});
const result = () => ({ batchId: id(9), maximumConcurrentTransfers: 2,
  items: body().items.map(item => ({ photoItemId: item.photoItemId, expiresAt: '2026-10-25T05:00:00Z', quotaWarning: false })) });

describe('two-file atomic reservation contract', () => {
  it('uses existing per-file key scope while binding the ordered batch to actor and original CAS', async () => {
    const parsed = await preparePhotoCollectionBatch(id(1), input(), 'batch-key-1');
    expect(parsed.items[0]?.keyDigest).toBe(await preparePhotoCollectionUploadKey(id(1), 'photo-key-5'));
    expect(JSON.stringify(parsed)).not.toContain('photo-key');
    expect(JSON.stringify(parsed)).not.toContain('batch-key');
    expect(await preparePhotoCollectionBatch(id(1), input(), 'batch-key-1')).toEqual(parsed);
    expect((await preparePhotoCollectionBatch(id(1), { ...input(), items: [...input().items].reverse() }, 'batch-key-1')).requestHash).not.toBe(parsed.requestHash);
    expect((await preparePhotoCollectionBatch(id(10), input(), 'batch-key-1')).idempotencyKeyDigest).not.toBe(parsed.idempotencyKeyDigest);
  });
  it.each([
    { items: [] }, { items: body().items.slice(0, 1) }, { items: [...body().items, body().items[0]] },
    { items: [body().items[0], body().items[0]] },
    { items: body().items.map(item => ({ ...item, idempotencyKey: 'same-key' })) },
    { items: [{ ...body().items[0], providerFileId: 'not-allowed' }, body().items[1]] },
    { expectedCollectionRevision: Number.MAX_SAFE_INTEGER - 2 }, { assignmentRevision: 0 },
    { expectedCollectionRevision: -1 }, { attemptId: 'bad' },
  ])('rejects malformed or unbounded metadata %j', async change => {
    await expect(preparePhotoCollectionBatch(id(1), { ...input(), ...change }, 'batch-key-1')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
  it('keeps member identity fixed when response properties are reordered', async () => {
    const a = input();
    const b = { ...a, items: a.items.map(item => ({ idempotencyKey: item.idempotencyKey, expectedItemRevision: item.expectedItemRevision, photoItemId: item.photoItemId })) };
    expect((await preparePhotoCollectionBatch(id(1), a, 'batch-key-1')).requestHash)
      .toBe((await preparePhotoCollectionBatch(id(1), b, 'batch-key-1')).requestHash);
  });
});

function setup(data: unknown = result(), error: unknown = null) {
  const rpc = vi.fn(async () => ({ data, error }));
  const provider = vi.fn(() => { throw new Error('No provider or decoder during metadata admission'); });
  const decoder = vi.fn(async () => { throw new Error('No decoder'); });
  return { rpc, provider, decoder, service: new PhotoService({ rpc }, provider, decoder) };
}
describe('bounded Node and Edge-neutral service boundary', () => {
  it('sends exactly one atomic RPC and strips private response fields', async () => {
    const s = setup({ ...result(), admissionId: id(30), token: 'private', items: result().items.map(item => ({ ...item, keyDigest: 'secret' })) });
    expect(await s.service.admitBatch(request(), actor, id(7), id(8))).toEqual(result());
    expect(s.rpc).toHaveBeenCalledTimes(1);
    const call = s.rpc.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(call[0]).toBe('admit_photo_collection_upload_batch');
    expect(call[1]).toMatchObject({ p_actor_profile_id: id(1), p_session_id: id(2), p_attempt_id: id(7), p_expected_collection_revision: 4 });
    expect(JSON.stringify(call)).not.toContain('photo-key');
    expect(s.provider).not.toHaveBeenCalled(); expect(s.decoder).not.toHaveBeenCalled();
  });
  it.each(['admin', 'developer'] as const)('denies %s before reading bytes or RPC', async role => {
    const s = setup();
    await expect(s.service.admitBatch(request(), { ...actor, role }, id(7), id(8))).rejects.toMatchObject({ code: 'PHOTO_ACCESS_REQUIRED' });
    expect(s.rpc).not.toHaveBeenCalled();
  });
  it.each(['active', 'upload_only', 'deactivation_pending'])('lets DB revalidate latest limited capability for %s', async profileStatus => {
    const s = setup(null, { message: 'CAPABILITY_ACCESS_REQUIRED' });
    await expect(s.service.admitBatch(request(), { ...actor, profileStatus }, id(7), id(8))).rejects.toMatchObject({ code: 'CAPABILITY_ACCESS_REQUIRED' });
    expect(s.rpc).toHaveBeenCalledTimes(1);
  });
  it.each([
    { ...result(), maximumConcurrentTransfers: 3 },
    { ...result(), items: [...result().items].reverse() },
    { ...result(), items: result().items.slice(0, 1) },
    { ...result(), items: result().items.map(item => ({ ...item, quotaWarning: 'false' })) },
  ])('fails closed on malformed or cross-item RPC response', async data => {
    await expect(setup(data).service.admitBatch(request(), actor, id(7), id(8))).rejects.toMatchObject({ code: 'PHOTO_UPLOAD_FAILED' });
  });
  it.each([{ 'content-type': 'image/jpeg' }, { 'content-encoding': 'gzip' }, { 'content-range': 'bytes 0-1/2' }])('rejects transport outside metadata contract', async headers => {
    const s = setup();
    await expect(s.service.admitBatch(request(body(), headers), actor, id(7), id(8))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(s.rpc).not.toHaveBeenCalled();
  });
  it('bounds input without decoding or network I/O', async () => {
    const s = setup();
    await expect(s.service.admitBatch(request({ junk: 'x'.repeat(8192) }), actor, id(7), id(8))).rejects.toMatchObject({ statusCode: 413 });
    expect(s.rpc).not.toHaveBeenCalled();
  });
  it('registers authenticated no-store Fastify metadata route without changing raw binary routes', async () => {
    const s = setup(), auth = vi.fn(async () => actor);
    const app = Fastify(); await app.register(createPhotoRoutes({ service: s.service, authenticate: auth, denied: async () => {} }));
    try {
      const response = await app.inject({ method: 'POST', url: path, headers: { 'content-type': 'application/json', 'idempotency-key': 'batch-key-1' }, payload: body() });
      expect(response.statusCode).toBe(200); expect(response.json()).toEqual(result());
      expect(response.headers['cache-control']).toBe('no-store'); expect(auth).toHaveBeenCalled();
      expect(photoRoute('POST', path)).toEqual({ kind: 'admit-batch', attemptId: id(7), slotId: id(8) });
    } finally { await app.close(); }
  });
  it('documents only a two-item metadata entry point', () => {
    const doc = openApiDocument;
    expect(JSON.stringify(doc)).toContain('admitAttemptPhotoCollectionBatch');
  });
});

describe('SQL source safety boundaries (not SQL execution)', () => {
  const sql = readFileSync('supabase/migrations/20261025022445_photo_collection_upload_batch.sql', 'utf8');
  it('preserves fixed membership, existing admissions, exact sibling proof, and no provider/deletion work', () => {
    expect(sql).toContain('deferrable initially deferred');
    expect(sql).toContain("item_index in (0,1)");
    expect(sql).toContain('ad:=public.admit_photo_collection_upload(');
    expect(sql).toContain("st.status='accepted'");
    expect(sql).toContain('ch.collection_revision=p_revision');
    expect(sql).toContain('op.expected_photo_revision=ad.expected_photo_revision');
    expect(sql).toContain('PHOTO_BATCH_SOURCE_DRIFT');
    expect(sql).not.toMatch(/update private\.photo_upload_(operations|admissions)|net\.http|cron\.schedule/i);
  });
});
