import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { GoogleDriveProvider, type DriveObject } from '../src/modules/photos/google-drive.js';
import { PhotoTiming } from '../src/modules/photos/photo-service.js';

const bytes = Uint8Array.of(1, 2, 3);
const object: DriveObject = {
  fileId: 'synthetic_file_123', folderId: 'synthetic_room_123', objectId: 'synthetic_object_123',
  mime: 'image/jpeg', sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
  fileName: '2026-01-01_일반방_142_01.jpg',
};
const config = { clientId: 'synthetic', clientSecret: 'synthetic', refreshToken: 'synthetic', rootFolderId: 'synthetic_root_123' };
const metadata = () => ({
  id: object.fileId, name: object.fileName, mimeType: object.mime, parents: [object.folderId],
  size: String(object.sizeBytes), sha256Checksum: object.sha256, appProperties: { objectId: object.objectId },
  trashed: false, shared: false, createdTime: '2026-01-01T00:00:00.000Z',
});
function harness(ack: () => Response = () => Response.json(metadata()), media = bytes) {
  const calls: { url: URL; method: string }[] = [];
  const provider = new GoogleDriveProvider(config, async (input, init = {}) => {
    const url = new URL(String(input)); calls.push({ url, method: init.method ?? 'GET' });
    expect(init.redirect).toBe('error');
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'synthetic', expires_in: 3600, token_type: 'Bearer' });
    if (url.pathname.includes('/upload/')) return ack();
    expect(url.pathname).toBe(`/drive/v3/files/${object.fileId}`);
    if (url.searchParams.get('alt') === 'media') return new Response(Uint8Array.from(media), { headers: { 'content-type': object.mime } });
    return Response.json(metadata());
  });
  return { provider, calls, gets: () => calls.filter(c => c.method === 'GET') };
}

describe('#411 upload acknowledgement reuse (fake provider only)', () => {
  it('validates complete create metadata without a redundant GET and always reinspects on recovery', async () => {
    const s = harness();
    await expect(s.provider.upload(object, bytes)).resolves.toEqual({ uploadedAt: metadata().createdTime });
    expect(s.gets()).toHaveLength(0);
    await s.provider.inspect(object);
    expect(s.gets()).toHaveLength(1);
  });
  it.each(['id', 'name', 'mimeType', 'parents', 'size', 'appProperties', 'trashed', 'shared', 'createdTime'])('missing %s falls back to the exact durable identity', async key => {
    const ack: Record<string, unknown> = metadata(); delete ack[key];
    const s = harness(() => Response.json(ack));
    await expect(s.provider.upload(object, bytes)).resolves.toEqual({ uploadedAt: metadata().createdTime });
    expect(s.gets()).toHaveLength(1);
    expect(s.calls.some(c => c.method === 'DELETE')).toBe(false);
  });
  it.each([
    { id: 'wrong_file_123' }, { name: '2026-01-01_일반방_143_01.jpg' }, { mimeType: 'image/webp' },
    { parents: ['wrong_folder_123'] }, { parents: [object.folderId, 'extra_folder_123'] }, { size: '4' },
    { appProperties: { objectId: 'wrong_object_123' } }, { sha256Checksum: 'f'.repeat(64) },
    { sha256Checksum: null }, { trashed: true }, { shared: true }, { createdTime: 'invalid' },
    { createdTime: '2999-01-01T00:00:00.000Z' },
  ])('conflicting acknowledgement is rejected without concealing it through GET: %j', async patch => {
    const s = harness(() => Response.json({ ...metadata(), ...patch }));
    await expect(s.provider.upload(object, bytes)).rejects.toMatchObject({ code: 'PHOTO_PROVIDER_IDENTITY_CONFLICT' });
    expect(s.gets()).toHaveLength(0);
    expect(s.calls.some(c => c.method === 'DELETE')).toBe(false);
  });
  it.each([false, true])('absent checksum reads and hashes actual bytes, not appProperties (corrupt=%s)', async corrupt => {
    const ack: Record<string, unknown> = metadata(); delete ack.sha256Checksum;
    ack.appProperties = { objectId: object.objectId, sha256: object.sha256 };
    const s = harness(() => Response.json(ack), corrupt ? Uint8Array.of(4, 5, 6) : bytes);
    if (corrupt) await expect(s.provider.upload(object, bytes)).rejects.toMatchObject({ code: 'PHOTO_PROVIDER_IDENTITY_CONFLICT' });
    else await expect(s.provider.upload(object, bytes)).resolves.toEqual({ uploadedAt: metadata().createdTime });
    expect(s.gets()).toHaveLength(1);
    expect(s.gets()[0]?.url.searchParams.get('alt')).toBe('media');
  });
  it.each(['lost', '409', '500', 'empty', 'malformed', 'oversized'] as const)('%s response preserves same-ID recovery without another POST or delete', async outcome => {
    const s = harness(() => {
      if (outcome === 'lost') throw new Error('private provider response');
      if (outcome === '409' || outcome === '500') return Response.json(metadata(), { status: Number(outcome) });
      if (outcome === 'empty') return new Response(null);
      if (outcome === 'oversized') return Response.json({ ...metadata(), unsafePayload: 'x'.repeat(65536) });
      return new Response('{');
    });
    await expect(s.provider.upload(object, bytes)).resolves.toEqual({ uploadedAt: metadata().createdTime });
    expect(s.gets()).toHaveLength(1);
    expect(s.calls.filter(c => c.url.pathname.includes('/upload/'))).toHaveLength(1);
    expect(s.calls.some(c => c.method === 'DELETE')).toBe(false);
  });
  it('isolates concurrent provider substage timings without storing a request on the shared provider', async () => {
    const s = harness(); let firstClock = 0, secondClock = 0;
    const first = new PhotoTiming(() => ++firstClock), second = new PhotoTiming(() => { secondClock += 10; return secondClock; });
    await Promise.all([s.provider.upload(object, bytes, first), s.provider.upload(object, bytes, second)]);
    expect(first.header()).toContain('photo_drive_upload;dur=3.0');
    expect(first.header()).toContain('photo_drive_token;dur=1.0');
    expect(first.header()).toContain('photo_drive_verify;dur=1.0');
    expect(second.header()).toContain('photo_drive_upload;dur=30.0');
    expect(second.header()).toContain('photo_drive_token;dur=10.0');
    expect(second.header()).toContain('photo_drive_verify;dur=10.0');
    expect(first.header()).not.toMatch(/synthetic|142|secret|https/);
    expect(JSON.stringify(s.provider)).toBe('{}');
  });
  it('measures cold token wait and warm reuse without persisting request timing', async () => {
    let clock = 0, tokenCalls = 0;
    const provider = new GoogleDriveProvider(config, async input => {
      const url = new URL(String(input));
      if (url.hostname === 'oauth2.googleapis.com') {
        ++tokenCalls; clock += 40;
        return Response.json({ access_token: 'synthetic', expires_in: 3600, token_type: 'Bearer' });
      }
      clock += 100; return Response.json(metadata());
    });
    const cold = new PhotoTiming(() => clock);
    await provider.upload(object, bytes, cold);
    expect(cold.header()).toContain('photo_drive_token;dur=40.0');
    expect(cold.header()).toContain('photo_drive_upload;dur=140.0');
    const frozen = cold.header(), warm = new PhotoTiming(() => clock);
    await provider.upload(object, bytes, warm);
    expect(warm.header()).toContain('photo_drive_token;dur=0.0');
    expect(warm.header()).toContain('photo_drive_upload;dur=100.0');
    expect(tokenCalls).toBe(1);
    // total is a live clock, but old stage values must remain unchanged.
    expect(cold.header().split(', photo_total')[0]).toBe(frozen.split(', photo_total')[0]);
  });
  it('shares an in-flight token refresh but accounts wait independently in both requests', async () => {
    let clock = 0, tokenCalls = 0; let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const provider = new GoogleDriveProvider(config, async input => {
      if (new URL(String(input)).hostname === 'oauth2.googleapis.com') {
        ++tokenCalls; await gate;
        return Response.json({ access_token: 'synthetic', expires_in: 3600, token_type: 'Bearer' });
      }
      return Response.json(metadata());
    });
    const first = new PhotoTiming(() => clock), second = new PhotoTiming(() => clock);
    const requests = [provider.upload(object, bytes, first), provider.upload(object, bytes, second)];
    clock = 50; release(); await Promise.all(requests);
    expect(tokenCalls).toBe(1);
    expect(first.header()).toContain('photo_drive_token;dur=50.0');
    expect(second.header()).toContain('photo_drive_token;dur=50.0');
  });
  it('records token wait on failed OAuth without retaining credentials or raw error payload', async () => {
    let clock = 0;
    const provider = new GoogleDriveProvider(config, async () => {
      clock += 20; return Response.json({ error: 'private-oauth-diagnostic' }, { status: 500 });
    });
    const timing = new PhotoTiming(() => clock);
    await expect(provider.generateUploadIds(timing)).rejects.toMatchObject({ code: 'PHOTO_PROVIDER_UNAVAILABLE' });
    expect(timing.header()).toContain('photo_drive_token;dur=20.0');
    expect(timing.header()).not.toMatch(/private|synthetic|secret|https/);
  });
});

describe('#411 folder create acknowledgement', () => {
  const folder = { folderId: 'synthetic_date_123', parentFolderId: config.rootFolderId, name: '2026-01-01' };
  const row = { id: folder.folderId, name: folder.name, mimeType: 'application/vnd.google-apps.folder',
    parents: [folder.parentFolderId], shared: false, trashed: false };
  it('counts parallel folder token waits as cumulative caller time, not exclusive wall time', async () => {
    let clock = 0, tokenCalls = 0; let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const provider = new GoogleDriveProvider(config, async input => {
      const url = new URL(String(input));
      if (url.hostname === 'oauth2.googleapis.com') {
        ++tokenCalls; await gate;
        return Response.json({ access_token: 'synthetic', expires_in: 3600, token_type: 'Bearer' });
      }
      return Response.json(url.pathname.endsWith(folder.folderId) ? row : { ...row, id: folder.parentFolderId });
    });
    const timing = new PhotoTiming(() => clock);
    const pending = timing.measure('drive_folders', () => provider.ensureFolder(folder, timing));
    clock = 50; release(); await pending;
    expect(tokenCalls).toBe(1);
    expect(timing.header()).toContain('photo_drive_token;dur=100.0');
    expect(timing.header()).toContain('photo_drive_folders;dur=50.0');
  });
  it.each(['complete', 'partial', '409', 'lost', 'shared', 'wrong-parent'] as const)('%s retains private parent validation and same identity', async outcome => {
    const reads: string[] = []; let posted = false;
    const provider = new GoogleDriveProvider(config, async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'synthetic', expires_in: 3600, token_type: 'Bearer' });
      if (init.method === 'POST') {
        expect(posted).toBe(false); posted = true;
        expect(JSON.parse(String(init.body)).id).toBe(folder.folderId);
        if (outcome === 'lost') throw new Error('response lost');
        return Response.json(outcome === 'partial' ? { id: folder.folderId } :
          { ...row, ...(outcome === 'shared' ? { shared: true } : {}), ...(outcome === 'wrong-parent' ? { parents: ['wrong_parent_123'] } : {}) },
          { status: outcome === '409' ? 409 : 200 });
      }
      expect(init.method).toBeUndefined();
      const fileId = url.pathname.split('/').at(-1) ?? ''; reads.push(fileId);
      if (fileId === config.rootFolderId) return Response.json({ ...row, id: fileId });
      expect(fileId).toBe(folder.folderId);
      return posted ? Response.json(row) : new Response(null, { status: 404 });
    });
    if (outcome === 'shared' || outcome === 'wrong-parent') await expect(provider.ensureFolder(folder)).rejects.toMatchObject({ code: 'PHOTO_PROVIDER_IDENTITY_CONFLICT' });
    else await provider.ensureFolder(folder);
    expect(reads.filter(id => id === config.rootFolderId)).toHaveLength(1);
    expect(reads.filter(id => id === folder.folderId)).toHaveLength(['partial', '409', 'lost'].includes(outcome) ? 2 : 1);
  });
});

describe('#411 deterministic provider round-trip comparison, NOT hosted performance', () => {
  it.each([1, 5, 20])('%i serial photos save one wait/file when complete ACKs are available', async count => {
    vi.useFakeTimers();
    try {
      const run = async (complete: boolean) => {
        let calls = 0; const start = Date.now();
        const date = 'synthetic_date_123';
        const provider = new GoogleDriveProvider(config, async input => {
          calls++; await new Promise(resolve => setTimeout(resolve, 100));
          const url = new URL(String(input));
          if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'synthetic', expires_in: 3600, token_type: 'Bearer' });
          if (url.pathname.endsWith('/generateIds')) return Response.json({ ids: [date, object.folderId, object.fileId] });
          if (url.pathname.includes('/upload/')) return complete ? Response.json(metadata()) : new Response(null);
          const fileId = url.pathname.split('/').at(-1);
          if (fileId === object.fileId) return Response.json(metadata());
          return Response.json({ id: fileId, name: fileId === date ? '2026-01-01' : '142', parents: [fileId === date ? config.rootFolderId : date], mimeType: 'application/vnd.google-apps.folder', trashed: false, shared: false });
        });
        for (let i = 0; i < count; i++) {
          await provider.generateUploadIds();
          await provider.ensureFolder({ folderId: date, parentFolderId: config.rootFolderId, name: '2026-01-01' });
          await provider.ensureFolder({ folderId: object.folderId, parentFolderId: date, name: '142' });
          await provider.upload(object, bytes);
        }
        return { calls, ms: Date.now() - start };
      };
      const baseline = run(false); await vi.runAllTimersAsync(); const before = await baseline;
      const candidate = run(true); await vi.runAllTimersAsync(); const after = await candidate;
      expect(before).toEqual({ calls: 1 + 7 * count, ms: 100 + 500 * count });
      expect(after).toEqual({ calls: 1 + 6 * count, ms: 100 + 400 * count });
    } finally { vi.useRealTimers(); }
  });
});
