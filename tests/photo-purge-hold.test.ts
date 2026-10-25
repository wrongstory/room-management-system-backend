import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { handleHeldPhotoPurge } from '../src/modules/photos/photo-purge.js';

describe('photo purge deployment HOLD', () => {
  it.each(['/photo-purge', '/functions/v1/photo-purge'])('holds the exact route %s without reading headers or body', async path => {
    const request = new Request(`https://synthetic.invalid${path}`, { method: 'POST', body: 'sensitive synthetic request' });
    Object.defineProperties(request, {
      headers: { get() { throw new Error('HOLD must not inspect caller authority'); } },
      body: { get() { throw new Error('HOLD must not inspect body'); } },
    });
    const response = handleHeldPhotoPurge(request);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: 'PHOTO_PURGE_HELD' } });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
  it.each([{}, { 'x-photo-purge-secret': 'synthetic-correct-looking-secret-at-least32' },
    { authorization: 'Bearer synthetic-token', 'x-photo-purge-enabled': 'true', 'x-request-id': 'do-not-echo' }])(
    'accepts no authority or unlock headers', async headers => {
      const response = handleHeldPhotoPurge(new Request('https://synthetic.invalid/photo-purge', { method: 'POST', headers }));
      expect(response.status).toBe(503); expect(await response.text()).toBe('{"error":{"code":"PHOTO_PURGE_HELD"}}');
    });
  it.each(['/photo-purge?enable=true', '/photo-purge/', '/photo-purge/execute', '/other'])('refuses aliases/parameters %s', async path => {
    const response = handleHeldPhotoPurge(new Request(`https://synthetic.invalid${path}`, { method: 'POST' }));
    expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: { code: 'ROUTE_NOT_FOUND' } });
  });
  it.each(['GET', 'DELETE', 'OPTIONS'])('does not expose an alternate %s execution method', method => {
    expect(handleHeldPhotoPurge(new Request('https://synthetic.invalid/photo-purge', { method })).status).toBe(405);
  });
  it('deployment entrypoint has no environment loader, client, provider or legacy worker bypass', () => {
    const entry = readFileSync('supabase/functions/photo-purge/index.ts', 'utf8');
    expect(entry).toContain('Deno.serve(handleHeldPhotoPurge)');
    expect(entry).not.toMatch(/Deno\.env|createEdgeClients|GoogleDriveProvider|PhotoPurgeWorker|handlePhotoPurge\s*\(/);
  });
});
