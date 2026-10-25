import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClients } from '../src/lib/supabase.js';
import { SupabaseAuthService } from '../src/modules/auth/auth.service.js';

const edge = await import(new URL('../supabase/functions/_shared/runtime.ts', import.meta.url).href) as {
  authenticate(request: Request, clients: unknown): Promise<unknown>;
};
const authUserId = '44200000-0000-4000-8000-000000000001';
const profileId = '44200000-0000-4000-8000-000000000002';
const sessionId = '44200000-0000-4000-8000-000000000003';
const token = `e30.${Buffer.from(JSON.stringify({ session_id: sessionId })).toString('base64url')}.synthetic`;
const activeProfile = { id: profileId, auth_user_id: authUserId, display_name: '합성',
  role: 'admin', status: 'active', must_change_password: false };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const auth = deferred<{ data: { user: { id: string } | null }; error: null }>();
  const profile = deferred<{ data: typeof activeProfile | null; error: null }>();
  let sessionActive = true;
  const getUser = vi.fn(() => auth.promise);
  const single = vi.fn(() => profile.promise);
  const eq = vi.fn(() => ({ single }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  // Contract double only: the real SQL snapshot/race tests require approved DB execution.
  const rpc = vi.fn(async (_name: string, args: { p_session_id: string | null }) => {
    const { data: p } = await single();
    const code = !p ? 'PROFILE_NOT_FOUND' : p.status !== 'active' ? 'ACCOUNT_INACTIVE'
      : !args.p_session_id ? 'INVALID_ACCESS_TOKEN' : !sessionActive ? 'SESSION_REVOKED' : 'OK';
    return { data: code === 'OK' ? { code, profile: p } : { code }, error: null };
  });
  const clients = { publicClient: { auth: { getUser } }, admin: { from, rpc } };
  const nodeService = new SupabaseAuthService(clients as unknown as SupabaseClients, 'synthetic-pepper');
  return { auth, profile, getUser, single, eq, from, rpc,
    revoke: () => { sessionActive = false; },
    clients, nodeService };
}

const runners = {
  node: (f: ReturnType<typeof fixture>, accessToken = token) =>
    f.nodeService.authenticate(accessToken),
  edge: (f: ReturnType<typeof fixture>, accessToken = token) =>
    edge.authenticate(new Request('https://example.invalid/v1/auth/me', {
      headers: { authorization: `Bearer ${accessToken}` }
    }), f.clients)
};

for (const [runtime, authenticate] of Object.entries(runners)) {
  describe(`${runtime}: authentication performance safety boundary (#442)`, () => {
    it('does not start privileged profile/session reads before Auth verification', async () => {
      const f = fixture();
      const rejected = expect(authenticate(f)).rejects.toMatchObject({ code: 'INVALID_ACCESS_TOKEN' });
      await Promise.resolve();
      expect(f.from).not.toHaveBeenCalled();
      expect(f.rpc).not.toHaveBeenCalled();
      f.auth.resolve({ data: { user: null }, error: null });
      await rejected;
      expect(f.from).not.toHaveBeenCalled();
      expect(f.rpc).not.toHaveBeenCalled();
    });

    it('rejects the RPC denial after a simulated profile delay and intervening revocation', async () => {
      const f = fixture();
      const rejected = expect(authenticate(f)).rejects.toMatchObject({ code: 'SESSION_REVOKED' });
      f.auth.resolve({ data: { user: { id: authUserId } }, error: null });
      await vi.waitFor(() => expect(f.single).toHaveBeenCalledOnce());
      expect(f.rpc).toHaveBeenCalledOnce();
      f.revoke();
      f.profile.resolve({ data: activeProfile, error: null });
      await rejected;
      expect(f.from).not.toHaveBeenCalled();
      expect(f.rpc).toHaveBeenCalledExactlyOnceWith('get_active_auth_context', {
        p_auth_user_id: authUserId, p_session_id: sessionId
      });
    });

    it.each(['inactive', 'upload_only', 'deactivation_pending'])('preserves %s denial before a session read', async status => {
      const f = fixture();
      const rejected = expect(authenticate(f)).rejects.toMatchObject({ code: 'ACCOUNT_INACTIVE' });
      f.auth.resolve({ data: { user: { id: authUserId } }, error: null });
      f.profile.resolve({ data: { ...activeProfile, status }, error: null });
      await rejected;
      expect(f.rpc).toHaveBeenCalledOnce();
    });

    it('preserves missing profile precedence even when the session claim is missing', async () => {
      const f = fixture();
      const rejected = expect(authenticate(f, 'e30.e30.synthetic')).rejects.toMatchObject({ code: 'PROFILE_NOT_FOUND' });
      f.auth.resolve({ data: { user: { id: authUserId } }, error: null });
      f.profile.resolve({ data: null, error: null });
      await rejected;
      expect(f.rpc).toHaveBeenCalledExactlyOnceWith('get_active_auth_context', {
        p_auth_user_id: authUserId, p_session_id: null
      });
    });

    it('does not cache successful authentication across requests', async () => {
      const f = fixture();
      f.auth.resolve({ data: { user: { id: authUserId } }, error: null });
      f.profile.resolve({ data: activeProfile, error: null });
      await expect(authenticate(f)).resolves.toMatchObject({ profileId, role: 'admin' });
      f.revoke();
      await expect(authenticate(f)).rejects.toMatchObject({ code: 'SESSION_REVOKED' });
      expect(f.getUser).toHaveBeenCalledTimes(2);
      expect(f.single).toHaveBeenCalledTimes(2);
      expect(f.rpc).toHaveBeenCalledTimes(2);
    });

    it.each(['developer', 'admin', 'maid'])('returns only current %s actor fields with one DB call', async role => {
      const f = fixture();
      f.auth.resolve({ data: { user: { id: authUserId } }, error: null });
      f.profile.resolve({ data: { ...activeProfile, role, must_change_password: true }, error: null });
      const result = await authenticate(f);
      expect(result).toMatchObject({ profileId, authUserId, role, mustChangePassword: true });
      expect(result).not.toHaveProperty('status');
      expect(result).not.toHaveProperty('session_id');
      expect(f.rpc).toHaveBeenCalledOnce();
      expect(f.from).not.toHaveBeenCalled();
    });

    it.each([null, true, [], {}, { code: 'OK' },
      { code: 'OK', profile: { ...activeProfile, auth_user_id: profileId } },
      { code: 'OK', profile: { ...activeProfile, id: 'invalid' } },
      { code: 'OK', profile: { ...activeProfile, role: 'owner' } },
      { code: 'OK', profile: { ...activeProfile, must_change_password: null } },
      { code: 'OK', profile: { ...activeProfile, display_name: 42 } },
      { code: 'toString' }, { code: 'AUTH_CONTEXT_UNAVAILABLE' }
    ])('fails closed on malformed/unavailable context %# without another lookup', async data => {
      const f = fixture();
      f.auth.resolve({ data: { user: { id: authUserId } }, error: null });
      f.rpc.mockResolvedValueOnce({ data, error: null } as never);
      await expect(authenticate(f)).rejects.toMatchObject({ code: 'AUTH_CONTEXT_UNAVAILABLE', [runtime === 'node' ? 'statusCode' : 'status']: 503 });
      expect(f.rpc).toHaveBeenCalledOnce();
      expect(f.from).not.toHaveBeenCalled();
    });

    it('does not expose RPC errors or fall back to a stale successful response', async () => {
      const f = fixture();
      f.auth.resolve({ data: { user: { id: authUserId } }, error: null });
      f.rpc.mockResolvedValueOnce({ data: { code: 'OK', profile: activeProfile },
        error: { message: 'private-canary', code: 'PGRST202' } } as never);
      await expect(authenticate(f)).rejects.toMatchObject({ code: 'AUTH_CONTEXT_UNAVAILABLE', [runtime === 'node' ? 'statusCode' : 'status']: 503 });
      expect(f.rpc).toHaveBeenCalledOnce();
      expect(f.from).not.toHaveBeenCalled();
    });
    it('replaces thrown/rejected provider errors with a safe typed error', async () => {
      const f = fixture();
      f.auth.resolve({ data: { user: { id: authUserId } }, error: null });
      f.rpc.mockRejectedValueOnce(new Error('private-rpc-canary'));
      const error = await authenticate(f).catch((value: unknown) => value);
      expect(error).toMatchObject({ code: 'AUTH_CONTEXT_UNAVAILABLE', [runtime === 'node' ? 'statusCode' : 'status']: 503 });
      expect(String(error)).not.toContain('private-rpc-canary');
      expect(JSON.stringify(error)).not.toContain('private-rpc-canary');
      expect(error).not.toHaveProperty('cause');
      expect(f.from).not.toHaveBeenCalled();
    });
  });
}
