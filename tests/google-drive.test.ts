import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GoogleDriveProvider, type DriveObject } from '../src/modules/photos/google-drive.js';

const bytes = Uint8Array.from([1, 2, 3]);
const object: DriveObject = { fileId: 'synthetic_file_123', folderId: 'synthetic_folder_123', objectId: '00000000-0000-4000-8000-000000000001', mime: 'image/jpeg', sizeBytes: 3, sha256: createHash('sha256').update(bytes).digest('hex') };
function harness(options: { uploadStatus?: number; timeout?: boolean; digest?: string | null; media?: Uint8Array; badParent?: boolean; redirect?: boolean; quota?: unknown } = {}) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const transport: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input)); calls.push({ url, init });
    expect(init.redirect).toBe('error'); expect(init.signal).toBeInstanceOf(AbortSignal);
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'synthetic_access_token', expires_in: 3600, token_type: 'Bearer' });
    expect(url.hostname).toBe('www.googleapis.com');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer synthetic_access_token');
    if (options.redirect) return new Response(null, { status: 302, headers: { location: 'https://unsafe.invalid/credential' } });
    if (url.pathname.endsWith('/about')) return Response.json({ storageQuota: { usage: options.quota ?? '9000000000' } });
    if (url.pathname.endsWith('/generateIds')) return Response.json({ ids: [object.fileId] });
    if (init.method === 'DELETE') return new Response(null, { status: 404 });
    if (url.searchParams.get('alt') === 'media') return new Response(Uint8Array.from(options.media ?? bytes), { headers: { 'content-type': 'image/jpeg' } });
    if (url.pathname.includes('/upload/')) {
      const body = init.body as Uint8Array;
      const text = new TextDecoder().decode(body);
      expect(text).toContain(object.fileId); expect(text).toContain(object.objectId);
      expect(text).not.toContain('createdTime'); expect(text).not.toContain('synthetic_access_token');
      if (options.timeout) throw new Error('raw provider secret body must never propagate');
      return new Response(null, { status: options.uploadStatus ?? 200 });
    }
    return Response.json({ id: object.fileId, name: `${object.objectId}.jpg`, mimeType: object.mime, size: '3', parents: [options.badParent ? 'wrong_parent_123' : object.folderId],
      appProperties: { objectId: object.objectId, sha256: object.sha256 }, trashed: false, shared: false, createdTime: '2026-01-01T00:00:00.000Z',
      ...(options.digest === null ? {} : { sha256Checksum: options.digest ?? object.sha256 }) });
  };
  const provider = new GoogleDriveProvider({ clientId: 'synthetic-client', clientSecret: 'synthetic-secret', refreshToken: 'synthetic-refresh', rootFolderId: 'synthetic_root_123' }, transport);
  return { provider, calls };
}
describe('Google Drive HTTP adapter, fake transport only', () => {
  it('two cold workers use the durable folder winner, never list names or create a loser candidate', async () => {
    const root = 'synthetic_root_123', winner = 'synthetic_winner_123';
    const created = new Map<string, Record<string, unknown>>();
    const posts: string[] = [], gets: string[] = [];
    let initialReads = 0, release = () => {};
    const bothReads = new Promise<void>(resolve => { release = resolve; });
    const transport: typeof fetch = async (input, init = {}) => {
      const url = new URL(String(input)); expect(init.redirect).toBe('error');
      if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'synthetic', expires_in: 3600, token_type: 'Bearer' });
      expect(url.searchParams.has('q')).toBe(false);
      if (init.method === 'POST') {
        const row = JSON.parse(String(init.body)) as Record<string, unknown>; posts.push(String(row.id));
        if (created.has(String(row.id))) return new Response(null, { status: 409 });
        created.set(String(row.id), { ...row, trashed: false, shared: false }); return Response.json({ id: row.id });
      }
      const fileId = url.pathname.split('/').at(-1); gets.push(String(fileId));
      if (fileId === root) return Response.json({ id: root, mimeType: 'application/vnd.google-apps.folder', trashed: false, shared: false });
      if (initialReads < 2) { initialReads++; if (initialReads === 2) release(); await bothReads; return new Response(null, { status: 404 }); }
      return Response.json(created.get(String(fileId)));
    };
    // The registry arbitrates different preallocated candidates before either provider can create.
    let reserved: string | undefined;
    const reserve = async (candidate: string) => { reserved ??= candidate; return reserved; };
    const candidates = [winner, 'synthetic_loser_123'];
    const folders = await Promise.all(candidates.map(async candidate => ({ folderId: await reserve(candidate), parentFolderId: root, name: '2026-09-09' })));
    await Promise.all(folders.map(folder => new GoogleDriveProvider({ clientId: 'synthetic-client', clientSecret: 'synthetic-secret', refreshToken: 'synthetic-refresh', rootFolderId: root }, transport).ensureFolder(folder)));
    expect(new Set(posts)).toEqual(new Set([winner])); expect(created.size).toBe(1);
    expect(gets).not.toContain(candidates[1]); expect(posts).not.toContain(candidates[1]);
  });
  it('generates an ID, reads total usage and single-flights token acquisition', async () => {
    const { provider, calls } = harness();
    const result = await Promise.all([provider.generateId(), provider.quota()]);
    expect(result[0]).toBe(object.fileId); expect(result[1]).toMatchObject({ usageBytes: '9000000000' });
    expect(calls.filter(c => c.url.hostname === 'oauth2.googleapis.com')).toHaveLength(1);
    expect(JSON.stringify(provider)).not.toMatch(/synthetic|token|secret|root/);
  });
  it.each([200, 409])('verifies exact metadata and immutable provider clock after create %i', async status => {
    const { provider, calls } = harness({ uploadStatus: status });
    expect(await provider.upload(object, bytes)).toEqual({ uploadedAt: '2026-01-01T00:00:00.000Z' });
    expect(calls.filter(c => c.url.pathname.includes('/upload/'))).toHaveLength(1);
  });
  it('lost create response rechecks only the same preallocated ID', async () => {
    const { provider, calls } = harness({ timeout: true });
    expect(await provider.upload(object, bytes)).toEqual({ uploadedAt: '2026-01-01T00:00:00.000Z' });
    expect(calls.filter(c => c.init.method === 'POST' && c.url.hostname === 'www.googleapis.com')).toHaveLength(1);
    expect(calls.some(c => c.init.method === 'DELETE')).toBe(false);
  });
  it('does not trust appProperties hash when Drive checksum is missing; bounded download proves bytes', async () => {
    const valid = harness({ digest: null }); await valid.provider.upload(object, bytes);
    expect(valid.calls.some(c => c.url.searchParams.get('alt') === 'media')).toBe(true);
    const invalid = harness({ digest: null, media: Uint8Array.of(4, 5, 6) });
    await expect(invalid.provider.upload(object, bytes)).rejects.toMatchObject({ code: 'PHOTO_PROVIDER_IDENTITY_CONFLICT' });
  });
  it('wrong SHA/parent is not accepted or deleted on 409', async () => {
    for (const options of [{ digest: 'f'.repeat(64) }, { badParent: true }]) {
      const { provider, calls } = harness({ uploadStatus: 409, ...options });
      await expect(provider.upload(object, bytes)).rejects.toMatchObject({ code: 'PHOTO_PROVIDER_IDENTITY_CONFLICT' });
      expect(calls.some(c => c.init.method === 'DELETE')).toBe(false);
    }
  });
  it('no redirect, unknown quota, oversize response, or raw upstream errors reach a client', async () => {
    await expect(harness({ redirect: true }).provider.quota()).rejects.toMatchObject({ code: 'PHOTO_PROVIDER_UNAVAILABLE' });
    await expect(harness({ quota: 12000000000 }).provider.quota()).rejects.toMatchObject({ code: 'PHOTO_PROVIDER_UNAVAILABLE' });
    await expect(harness({ media: new Uint8Array(307201) }).provider.read(object)).rejects.toMatchObject({ code: 'PHOTO_PROVIDER_UNAVAILABLE' });
    const provider = new GoogleDriveProvider({ clientId: 'synthetic-client', clientSecret: 'synthetic-secret', refreshToken: 'synthetic-refresh', rootFolderId: 'synthetic_root_123' }, async () => { throw new Error('synthetic-secret provider raw body'); });
    await expect(provider.quota()).rejects.toMatchObject({ message: 'PHOTO_PROVIDER_UNAVAILABLE' });
    await expect(provider.quota()).rejects.not.toHaveProperty('cause');
  });
  it('provider delete 404 is idempotent; caller still must acquire DB compensation fence', async () => {
    expect(await harness().provider.remove(object.fileId)).toBe('not_found');
  });
});
