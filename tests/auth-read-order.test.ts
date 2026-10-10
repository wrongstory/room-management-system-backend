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
  const rpc = vi.fn(async () => ({ data: sessionActive, error: null }));
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

    it('checks live session after a delayed profile read and rejects an intervening revocation', async () => {
      const f = fixture();
      const rejected = expect(authenticate(f)).rejects.toMatchObject({ code: 'SESSION_REVOKED' });
      f.auth.resolve({ data: { user: { id: authUserId } }, error: null });
      await vi.waitFor(() => expect(f.single).toHaveBeenCalledOnce());
      expect(f.rpc).not.toHaveBeenCalled();
      f.revoke();
      f.profile.resolve({ data: activeProfile, error: null });
      await rejected;
      expect(f.eq).toHaveBeenCalledWith('auth_user_id', authUserId);
      expect(f.rpc).toHaveBeenCalledExactlyOnceWith('is_active_auth_session', {
        p_auth_user_id: authUserId, p_session_id: sessionId
      });
    });

    it.each(['inactive', 'upload_only', 'deactivation_pending'])('preserves %s denial before a session read', async status => {
      const f = fixture();
      const rejected = expect(authenticate(f)).rejects.toMatchObject({ code: 'ACCOUNT_INACTIVE' });
      f.auth.resolve({ data: { user: { id: authUserId } }, error: null });
      f.profile.resolve({ data: { ...activeProfile, status }, error: null });
      await rejected;
      expect(f.rpc).not.toHaveBeenCalled();
    });

    it('preserves missing profile precedence even when the session claim is missing', async () => {
      const f = fixture();
      const rejected = expect(authenticate(f, 'e30.e30.synthetic')).rejects.toMatchObject({ code: 'PROFILE_NOT_FOUND' });
      f.auth.resolve({ data: { user: { id: authUserId } }, error: null });
      f.profile.resolve({ data: null, error: null });
      await rejected;
      expect(f.rpc).not.toHaveBeenCalled();
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
  });
}
