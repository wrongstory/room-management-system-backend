import { generateKeyPairSync, verify } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createBackupAlertToken } from '../supabase/functions/_shared/reservation-backup-github-app.js';

const now = new Date('2026-10-25T01:00:00Z');
const appId = 123456;
const installationId = 987654;
const repository = { id: 1346229617, full_name: 'wrongstory/room-management-system-backend' };
const token = ['ghs', 'syntheticInstallationTokenForTestsOnly'].join('_');
const failure = 'BACKUP_ALERT_AUTH_FAILED';
let pkcs1 = ''; let pkcs8 = ''; let publicKey = '';
beforeAll(() => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  pkcs1 = pair.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  pkcs8 = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
});
function response(overrides: Record<string, unknown> = {}) {
  return { token, expires_at: '2026-10-25T02:00:00Z', permissions: { issues: 'write', metadata: 'read' },
    repository_selection: 'selected', repositories: [repository], ...overrides };
}
function options(fetcher: typeof fetch, privateKeyPem = pkcs8) {
  return { appId, installationId, privateKeyPem, fetcher, now };
}

describe('repository-restricted backup alert GitHub App tokens', () => {
  it.each(['pkcs1', 'pkcs8'])('signs a real RS256 JWT from a %s RSA key and requests only the intended issue permission', async (format) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response(), { status: 201 }));
    expect(await createBackupAlertToken(options(fetcher, format === 'pkcs1' ? pkcs1 : pkcs8))).toBe(token);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const call = fetcher.mock.calls[0]; if (!call) throw new Error('Missing request');
    const [url, init] = call;
    expect(url).toBe('https://api.github.com/app/installations/987654/access_tokens');
    expect(init?.method).toBe('POST'); expect(init?.redirect).toBe('error'); expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init?.body))).toEqual({ repository_ids: [1346229617], permissions: { issues: 'write' } });
    const authorization = new Headers(init?.headers).get('Authorization');
    expect(authorization?.startsWith('Bearer ')).toBe(true);
    const jwt = authorization?.slice(7).split('.'); if (jwt?.length !== 3) throw new Error('Missing JWT');
    const [header, payload, signature] = jwt;
    if (!header || !payload || !signature) throw new Error('Missing JWT components');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toEqual({
      iss: String(appId), iat: Math.floor(now.getTime() / 1000) - 60, exp: Math.floor(now.getTime() / 1000) + 120,
    });
    expect(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
    expect(String(url) + String(init?.body)).not.toContain('PRIVATE KEY');
    expect(new Headers(init?.headers).get('X-GitHub-Api-Version')).toBe('2026-03-10');
  });
  it('accepts the documented newer stateless installation-token character set', async () => {
    const stateless = ['ghs', '123456', 'eyJhbGciOiJ.Test_payload-with-hyphen.signature'].join('_');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response({ token: stateless }), { status: 201 }));
    expect(await createBackupAlertToken(options(fetcher))).toBe(stateless);
  });
  it('accepts metadata omitted from an otherwise issues-only response', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response({ permissions: { issues: 'write' } }), { status: 201 }));
    expect(await createBackupAlertToken(options(fetcher))).toBe(token);
  });
  it.each([
    { issues: 'write', contents: 'read' }, { issues: 'write', actions: 'write' },
    { issues: 'read' }, { issues: 'write', metadata: 'write' }, {}, null,
  ])('rejects missing or excess granted permissions %j', async (permissions) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response({ permissions }), { status: 201 }));
    await expect(createBackupAlertToken(options(fetcher))).rejects.toThrow(failure);
  });
  it.each([
    { repository_selection: 'all' }, { repositories: [] }, { repositories: [repository, { id: 2 }] },
    { repositories: [{ ...repository, id: 2 }] }, { repositories: [{ ...repository, full_name: 'other/repository' }] },
  ])('rejects unexpected repository grants %j', async (overrides) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response(overrides), { status: 201 }));
    await expect(createBackupAlertToken(options(fetcher))).rejects.toThrow(failure);
  });
  it.each([
    '2026-10-25T01:00:00Z', '2026-10-25T01:00:15Z', '2026-10-25T02:01:01Z', 'not-a-date',
  ])('rejects expired, near-expiring, overlong or malformed expiry %s', async (expires_at) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response({ expires_at }), { status: 201 }));
    await expect(createBackupAlertToken(options(fetcher))).rejects.toThrow(failure);
  });
  it.each(['ghp_wrong-token-kind', 'ghs_bad\nheader', `ghs_${'a'.repeat(4093)}`, 'ghs_short'])('rejects unsafe installation-token values', async (value) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response({ token: value }), { status: 201 }));
    await expect(createBackupAlertToken(options(fetcher))).rejects.toThrow(failure);
  });
  it('rejects invalid identifiers without issuing requests', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const overrides of [{ appId: 0 }, { installationId: -1 }, { installationId: Number.MAX_SAFE_INTEGER + 1 }, { now: new Date('invalid') }]) {
      await expect(createBackupAlertToken({ ...options(fetcher), ...overrides })).rejects.toThrow(failure);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects malformed, multiple, unsupported or weak private keys without exposing them', async () => {
    const weak = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const fetcher = vi.fn<typeof fetch>();
    for (const invalid of ['private-synthetic-detail', pkcs8 + pkcs8, pkcs8.replace('PRIVATE KEY', 'CERTIFICATE'),
      pkcs8.replace(/\n/, '\n!'), 'a'.repeat(16385), weak, ec]) {
      await expect(createBackupAlertToken(options(fetcher, invalid))).rejects.toThrow(failure);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([200, 301, 401, 403, 429, 500])('rejects status %s without surfacing provider details', async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('sensitive provider body', { status }));
    await expect(createBackupAlertToken(options(fetcher))).rejects.toThrow(/^BACKUP_ALERT_AUTH_FAILED$/);
  });
  it('rejects redirects, oversized replies and invalid JSON', async () => {
    const redirected = Response.json(response(), { status: 201 });
    Object.defineProperty(redirected, 'redirected', { value: true });
    for (const item of [redirected, new Response('x'.repeat(65537), { status: 201 }),
      new Response('{}', { status: 201, headers: { 'content-length': '65537' } }), new Response('{invalid', { status: 201 })]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(item);
      await expect(createBackupAlertToken(options(fetcher))).rejects.toThrow(failure);
    }
  });
  it('bounds stalled network and response-body reads with the same ten-second deadline', async () => {
    for (const stalledBody of [false, true]) {
      const controller = new AbortController(); const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
      const pull = vi.fn();
      const fetcher = vi.fn<typeof fetch>(() => stalledBody
        ? Promise.resolve(new Response(new ReadableStream<Uint8Array>({ pull }), { status: 201 }))
        : new Promise<Response>(() => undefined));
      try {
        const result = createBackupAlertToken(options(fetcher));
        const rejected = expect(result).rejects.toThrow(failure);
        await vi.waitFor(() => expect(stalledBody ? pull : fetcher).toHaveBeenCalled());
        controller.abort(); await rejected;
        expect(timeout).toHaveBeenCalledWith(10000);
      } finally { timeout.mockRestore(); }
    }
  });
  it('replaces network errors with the fixed error code', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('synthetic private detail'));
    await expect(createBackupAlertToken(options(fetcher))).rejects.toThrow(/^BACKUP_ALERT_AUTH_FAILED$/);
  });
});
