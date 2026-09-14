import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleDriveProvider } from '../src/modules/photos/google-drive.js';
const fileId = 'synthetic_private_file', parentId = 'synthetic_private_parent';
function setup(status: number, options: { network?: boolean; wrongParent?: boolean; children?: unknown[]; nextPage?: string; incomplete?: boolean } = {}) {
  const calls: { url: URL; method: string }[] = [];
  const transport: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input)); expect(init.redirect).toBe('error'); expect(init.signal).toBeInstanceOf(AbortSignal);
    calls.push({ url, method: init.method ?? 'GET' });
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'synthetic_token', expires_in: 3600, token_type: 'Bearer' });
    if (options.network) throw new Error('synthetic_token raw provider payload');
    if (init.method === 'DELETE') return new Response(null, { status });
    if (url.searchParams.has('q')) return Response.json({ files: options.children ?? [], ...(options.nextPage ? { nextPageToken: options.nextPage } : {}), incompleteSearch: options.incomplete ?? false });
    if (status === 404) return new Response(null, { status: 404 });
    return Response.json({ id: fileId, mimeType: 'application/vnd.google-apps.folder', parents: [options.wrongParent ? 'wrong_parent' : parentId], shared: false, trashed: false });
  };
  return { calls, provider: new GoogleDriveProvider({ clientId: 'synthetic-client', clientSecret: 'synthetic-secret', refreshToken: 'synthetic-refresh', rootFolderId: 'synthetic_root_folder' }, transport) };
}
describe('purge Drive adapter fake-only boundaries', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  it.each([204, 404])('DELETE %i is logical success with exact ID and no body', async status => {
    const s = setup(status); expect(await s.provider.purgeRemove(fileId)).toBe(status === 204 ? 'deleted' : 'not_found');
    expect(s.calls.at(-1)?.url.pathname).toBe(`/drive/v3/files/${fileId}`); expect(s.calls.at(-1)?.method).toBe('DELETE');
  });
  it.each([200, 302, 401, 403, 429, 500, 503])('DELETE %i never becomes success', async status => {
    await expect(setup(status).provider.purgeRemove(fileId)).rejects.toMatchObject({ code: 'PHOTO_PURGE_PROVIDER_UNAVAILABLE' });
  });
  it('network/response loss and 404 lookup never reflect raw provider errors', async () => {
    await expect(setup(204, { network: true }).provider.purgeRemove(fileId)).rejects.toMatchObject({ reason: 'NETWORK_ERROR', message: 'PHOTO_PURGE_PROVIDER_UNAVAILABLE' });
    expect(await setup(404).provider.purgeExists(fileId)).toBe(false);
    expect(await setup(204).provider.purgeExists(fileId)).toBe(true);
  });
  it('folder inspection uses exact parent only and never authorizes deletion itself', async () => {
    const s = setup(204); expect(await s.provider.purgeEmptyFolder(fileId, parentId)).toBe('empty');
    expect(s.calls.every(c => c.method !== 'DELETE')).toBe(true);
    expect(s.calls.at(-1)?.url.searchParams.get('q')).toBe(`'${fileId}' in parents`);
    expect(s.calls.at(-1)?.url.searchParams.get('pageSize')).toBe('1');
    await expect(setup(204, { wrongParent: true }).provider.purgeEmptyFolder(fileId, parentId)).rejects.toMatchObject({ code: 'PHOTO_PURGE_PROVIDER_UNAVAILABLE' });
  });
  it.each([{ children: [{ id: 'foreign_child' }] }, { nextPage: 'untrusted_page' }, { incomplete: true }])('nonempty or incomplete listing cannot delete: %j', async options => {
    expect(await setup(204, options).provider.purgeEmptyFolder(fileId, parentId)).toBe('not_empty');
  });
  it('path injection fails before any network call', async () => {
    const s = setup(204); await expect(s.provider.purgeRemove('../folder?x=secret')).rejects.toBeDefined(); expect(s.calls).toHaveLength(0);
  });
  it('derives OAuth and Drive abort signals from one absolute provider deadline', async () => {
    let now = 1000; const timeouts: number[] = [];
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => { timeouts.push(milliseconds); return new AbortController().signal; });
    const transport: typeof fetch = async input => {
      const url = new URL(String(input)); now += 200;
      if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'synthetic_token', expires_in: 3600, token_type: 'Bearer' });
      return new Response(null, { status: 204 });
    };
    const provider = new GoogleDriveProvider({ clientId: 'synthetic-client', clientSecret: 'synthetic-secret', refreshToken: 'synthetic-refresh', rootFolderId: 'synthetic_root_folder' }, transport);
    await expect(provider.purgeRemove(fileId, 2000)).resolves.toBe('deleted');
    expect(timeouts).toEqual([1000, 800]);
  });
  it('recomputes the remaining absolute deadline across folder metadata and child-list requests', async () => {
    let now = 1000; const timeouts: number[] = [];
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => { timeouts.push(milliseconds); return new AbortController().signal; });
    const transport: typeof fetch = async input => {
      const url = new URL(String(input)); now += 200;
      if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'synthetic_token', expires_in: 3600, token_type: 'Bearer' });
      if (url.searchParams.has('q')) return Response.json({ files: [], incompleteSearch: false });
      return Response.json({ id: fileId, mimeType: 'application/vnd.google-apps.folder', parents: [parentId], shared: false, trashed: false });
    };
    const provider = new GoogleDriveProvider({ clientId: 'synthetic-client', clientSecret: 'synthetic-secret', refreshToken: 'synthetic-refresh', rootFolderId: 'synthetic_root_folder' }, transport);
    await expect(provider.purgeEmptyFolder(fileId, parentId, 2200)).resolves.toBe('empty');
    expect(timeouts).toEqual([1200, 1000, 800]);
  });
});
