import { readFile } from 'node:fs/promises';
import { ImageMagick, MagickColors, MagickFormat } from '@imagemagick/magick-wasm';
import Fastify from 'fastify';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { checkPhotoThumbnail, initializePhotoDecoder } from '../src/modules/photos/photo-binary.js';
import { GoogleDriveProvider, type PhotoProvider } from '../src/modules/photos/google-drive.js';
import { PhotoService, photoRoute, type PhotoIdentity } from '../src/modules/photos/photo-service.js';
import { createPhotoRoutes } from '../src/modules/photos/photo.routes.js';
import { openApiDocument } from '../supabase/functions/_shared/openapi.js';

let jpeg: Uint8Array;
beforeAll(async () => {
  await initializePhotoDecoder(await readFile(new URL(import.meta.resolve('@imagemagick/magick-wasm/magick.wasm'))));
  jpeg = ImageMagick.read(MagickColors.White, 16, 16, image => image.write(MagickFormat.Jpeg, data => Uint8Array.from(data)));
});
const object = { fileId: 'synthetic_file_411', mime: 'image/jpeg' as const, sizeBytes: 300000, sha256: 'a'.repeat(64) };
const link = 'https://lh3.googleusercontent.com/drive-storage/synthetic-preview';
function providerHarness(options: { first?: Record<string, unknown>; last?: Record<string, unknown>; body?: Uint8Array;
  status?: number; mime?: string; failure?: boolean } = {}) {
  let count = 0;
  const calls: { url: URL; init: RequestInit }[] = [];
  const provider = new GoogleDriveProvider({ clientId: 'synthetic-client', clientSecret: 'synthetic-secret',
    refreshToken: 'synthetic-refresh', rootFolderId: 'synthetic_root_411' }, async (input, init = {}) => {
    const url = new URL(String(input)); calls.push({ url, init });
    expect(init.redirect).toBe('error'); expect(init.signal).toBeInstanceOf(AbortSignal);
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'synthetic_token', expires_in: 3600, token_type: 'Bearer' });
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer synthetic_token');
    if (url.origin === 'https://lh3.googleusercontent.com') {
      if (options.failure) throw new Error('signed URL and credentials must never escape');
      return new Response(Uint8Array.from(options.body ?? jpeg), { status: options.status ?? 200,
        headers: { 'content-type': options.mime ?? 'image/jpeg', location: 'https://untrusted.invalid/' } });
    }
    expect(url.origin).toBe('https://www.googleapis.com');
    expect(url.pathname).toBe('/drive/v3/files/synthetic_file_411');
    expect(url.searchParams.has('alt')).toBe(false);
    return Response.json({ id: object.fileId, mimeType: object.mime, size: String(object.sizeBytes), sha256Checksum: object.sha256,
      trashed: false, shared: false, hasThumbnail: true, version: '3', thumbnailVersion: '2', thumbnailLink: link,
      ...options.first, ...(count++ > 0 ? options.last : {}) });
  });
  return { provider, calls };
}
describe('private provider thumbnail', () => {
  it('reads bounded preview of the exact unchanged object without original download or decoder', async () => {
    const h = providerHarness();
    expect(await h.provider.thumbnail(object)).toEqual(jpeg);
    expect(h.calls.map(c => c.url.hostname)).toEqual(['oauth2.googleapis.com', 'www.googleapis.com', 'lh3.googleusercontent.com', 'www.googleapis.com']);
    expect(h.calls.every(c => !c.init.method || c.init.method === 'GET' || c.url.hostname === 'oauth2.googleapis.com')).toBe(true);
  });
  it.each([
    { id: 'other_file_411' }, { mimeType: 'image/png' }, { size: '1' }, { sha256Checksum: undefined },
    { sha256Checksum: 'b'.repeat(64) }, { trashed: true }, { shared: true }, { shared: undefined },
    { hasThumbnail: false }, { version: '' }, { thumbnailVersion: null }, { thumbnailLink: null },
  ])('rejects unavailable or mismatched metadata before fetching bytes: %j', async first => {
    const h = providerHarness({ first });
    await expect(h.provider.thumbnail(object)).rejects.toMatchObject({ code: 'PHOTO_THUMBNAIL_UNAVAILABLE' });
    expect(h.calls.some(c => c.url.hostname === 'lh3.googleusercontent.com')).toBe(false);
  });
  it.each(['http://lh3.googleusercontent.com/a', 'https://lh3.googleusercontent.com.evil.invalid/a',
    'https://evil.invalid/a', 'https://127.0.0.1/a', 'https://lh3.googleusercontent.com:444/a',
    'https://secret@lh3.googleusercontent.com/a', 'https://lh3.googleusercontent.com/a#fragment',
    'https://lh3.googleusercontent.com./a', 'not-a-url'])('never sends credentials to %s', async thumbnailLink => {
    const h = providerHarness({ first: { thumbnailLink } });
    await expect(h.provider.thumbnail(object)).rejects.toMatchObject({ code: 'PHOTO_THUMBNAIL_UNAVAILABLE' });
    expect(h.calls).toHaveLength(2);
  });
  it.each([{ status: 302 }, { status: 401 }, { status: 404 }, { mime: 'image/svg+xml' }, { failure: true },
    { body: new Uint8Array(65537) }, { body: new Uint8Array([1, 2, 3]) }])('does not proxy unsafe bytes/header/errors: %j', async options => {
    const h = providerHarness(options);
    await expect(h.provider.thumbnail(object)).rejects.toMatchObject({ message: 'PHOTO_THUMBNAIL_UNAVAILABLE' });
    expect(h.calls).toHaveLength(3);
  });
  it.each([{ version: '4' }, { thumbnailVersion: '3' }, { sha256Checksum: 'b'.repeat(64) }, { shared: true }])('rejects provider changes while reading %j', async last => {
    await expect(providerHarness({ last }).provider.thumbnail(object)).rejects.toMatchObject({ code: 'PHOTO_THUMBNAIL_UNAVAILABLE' });
  });
  it('bounds dimensions and rejects embedded metadata and appended content', () => {
    const oversized = ImageMagick.read(MagickColors.White, 513, 16, image => image.write(MagickFormat.Jpeg, data => Uint8Array.from(data)));
    expect(() => checkPhotoThumbnail(oversized)).toThrow();
    const metadata = new Uint8Array(jpeg.length + 6); metadata.set(jpeg.subarray(0, 2));
    metadata.set([255, 225, 0, 4, 1, 2], 2); metadata.set(jpeg.subarray(2), 8);
    expect(() => checkPhotoThumbnail(metadata)).toThrow();
    expect(() => checkPhotoThumbnail(Uint8Array.from([...jpeg, 1]))).toThrow();
  });
});

const id = '10000000-0000-4000-8000-000000000411';
const identity: PhotoIdentity = { profileId: id, sessionId: id, role: 'maid', profileStatus: 'active' };
function serviceHarness(last: Record<string, unknown> = {}, error?: string) {
  let count = 0;
  const rpc = vi.fn(async () => ({ error: count > 0 && error ? { message: error } : null,
    data: { providerFileId: object.fileId, mimeType: object.mime, sizeBytes: object.sizeBytes, sha256: object.sha256,
      fileName: null, retentionPolicy: 'cleaning_submission', retentionStartsAt: null, expiresAt: null,
      purgedAt: null, mediaAvailability: 'available', ...(count++ > 0 ? last : {}) } }));
  const thumbnail = vi.fn(async () => jpeg), read = vi.fn(async () => jpeg), decode = vi.fn();
  const service = new PhotoService({ rpc }, () => ({ thumbnail, read } as unknown as PhotoProvider), decode);
  return { service, rpc, thumbnail, read, decode };
}
describe('thumbnail uses original authorization and response boundary', () => {
  it('routes as ordinary active content and returns no signed location/cache', async () => {
    const h = serviceHarness(), app = Fastify({ logger: false }), authenticate = vi.fn(async () => identity);
    await app.register(createPhotoRoutes({ service: h.service, authenticate, denied: async () => {} }));
    try {
      const response = await app.inject({ method: 'GET', url: `/v1/photos/${id}/thumbnail` });
      expect(response.statusCode).toBe(200); expect(response.rawPayload).toEqual(Buffer.from(jpeg));
      expect(authenticate).toHaveBeenCalledWith(expect.any(Request), true);
      expect(h.rpc).toHaveBeenCalledTimes(2); expect(h.thumbnail).toHaveBeenCalledOnce();
      expect(h.read).not.toHaveBeenCalled(); expect(h.decode).not.toHaveBeenCalled();
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['content-disposition']).toBe('inline; filename="thumbnail.jpg"');
      expect(JSON.stringify(response.headers)).not.toMatch(/googleusercontent|synthetic_file|location|token/);
    } finally { await app.close(); }
  });
  it.each(['developer', 'upload_only', 'deactivation_pending'])('rejects %s before provider', async mode => {
    const h = serviceHarness();
    const actor = mode === 'developer' ? { ...identity, role: 'developer' as const } : { ...identity, profileStatus: mode };
    await expect(h.service.content(new Request('http://local/'), actor, id, 'thumbnail')).rejects.toMatchObject({ code: 'PHOTO_ACCESS_REQUIRED' });
    expect(h.thumbnail).not.toHaveBeenCalled(); expect(h.rpc).not.toHaveBeenCalled();
  });
  it.each([{ providerFileId: 'other_file_411' }, { sha256: 'b'.repeat(64) }, { mimeType: 'image/webp' },
    { sizeBytes: 1 }, { mediaAvailability: 'expired' }])('drops bytes after changed ownership/retention %j', async last => {
    const h = serviceHarness(last);
    await expect(h.service.content(new Request('http://local/'), identity, id, 'thumbnail')).rejects.toThrow();
    expect(h.thumbnail).toHaveBeenCalledOnce();
  });
  it('rejects a session revoked during provider read', async () => {
    await expect(serviceHarness({}, 'SESSION_REVOKED').service.content(new Request('http://local/'), identity, id, 'thumbnail')).rejects.toMatchObject({ code: 'SESSION_REVOKED' });
  });
  it('rejects Range and caller-controlled variants/URLs', async () => {
    for (const request of [new Request('http://local/?url=https://evil.invalid'), new Request('http://local/', { headers: { range: 'bytes=0-1' } })]) {
      const h = serviceHarness();
      await expect(h.service.content(request, identity, id, 'thumbnail')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(h.thumbnail).not.toHaveBeenCalled();
    }
  });
  it('publishes an additive contract without changing content and limited access', () => {
    expect(photoRoute('GET', `/v1/photos/${id}/thumbnail`)).toEqual({ kind: 'thumbnail', photoId: id });
    const operation = openApiDocument.paths['/v1/photos/{photoId}/thumbnail'].get;
    expect(operation['x-required-roles']).toEqual(['admin', 'maid']);
    expect(operation.responses['200'].headers['Cache-Control'].schema.const).toBe('no-store');
    expect(operation.responses['503']).toBeDefined();
  });
});
