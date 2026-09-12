import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClients } from '../src/lib/supabase.js';
import { SupabaseAuthService } from '../src/modules/auth/auth.service.js';

const profileId = '10000000-0000-4000-8000-000000000001';
const authUserId = '20000000-0000-4000-8000-000000000001';
const sessionId = '30000000-0000-4000-8000-000000000001';
const accessToken = `x.${Buffer.from(JSON.stringify({ session_id: sessionId })).toString('base64url')}.y`;
const actor = {
  authUserId,
  profileId,
  displayName: '관리자',
  role: 'admin' as const,
  mustChangePassword: true,
  accessToken
};

function clientsFor(options: {
  rpcStates: Array<{ data: unknown; error: null | { message: string } }>;
  verifiedPasswords?: string[];
  updateError?: null | { message: string };
}) {
  const verified = [...(options.verifiedPasswords ?? [])];
  const signInWithPassword = vi.fn(async ({ password }: { password: string }) => {
    const expected = verified.shift();
    return password === expected
      ? { data: { session: { access_token: `verification-${verified.length}` } }, error: null }
      : { data: { session: null }, error: { message: 'invalid' } };
  });
  const rpc = vi.fn();
  for (const result of options.rpcStates) rpc.mockResolvedValueOnce(result);
  const updateUserById = vi.fn(async () => ({ error: options.updateError ?? null }));
  const signOut = vi.fn(async () => ({ error: null as null | { message: string } }));
  const clients = {
    publicClient: { auth: { signInWithPassword } },
    admin: { auth: { admin: { updateUserById, signOut } }, rpc }
  } as unknown as SupabaseClients;
  return { clients, rpc, signInWithPassword, updateUserById, signOut };
}

describe('password change replay receipt', () => {
  it('changes Auth once and completes the scoped receipt', async () => {
    const mocked = clientsFor({
      verifiedPasswords: ['tmp:1234'],
      rpcStates: [
        { data: { state: 'absent' }, error: null },
        { data: { state: 'execute' }, error: null },
        { data: { completed: true }, error: null }
      ]
    });
    await new SupabaseAuthService(mocked.clients).changePassword(actor, '1234', '654321', 'password-change-0001');
    expect(mocked.updateUserById).toHaveBeenCalledOnce();
    expect(mocked.updateUserById).toHaveBeenCalledWith(authUserId, { password: '654321' });
    expect(mocked.rpc.mock.calls.map(([name]) => name)).toEqual([
      'inspect_password_change', 'prepare_password_change', 'complete_password_change'
    ]);
    const prepare = mocked.rpc.mock.calls[1]?.[1] as Record<string, string>;
    expect(prepare.p_request_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(prepare.p_claim_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(prepare)).not.toContain('1234');
    expect(JSON.stringify(prepare)).not.toContain('654321');
  });

  it('returns success after response loss by verifying the supplied new password', async () => {
    const mocked = clientsFor({ verifiedPasswords: ['654321'], rpcStates: [{ data: { state: 'completed' }, error: null }] });
    await new SupabaseAuthService(mocked.clients).changePassword(actor, '1234', '654321', 'password-change-0002');
    expect(mocked.updateUserById).not.toHaveBeenCalled();
    expect(mocked.rpc).toHaveBeenCalledOnce();
    expect(mocked.signOut).toHaveBeenCalledOnce();
  });

  it('rejects a completed key when the intended new password is not current', async () => {
    const mocked = clientsFor({ rpcStates: [{ data: { state: 'completed' }, error: null }] });
    await expect(new SupabaseAuthService(mocked.clients).changePassword(actor, '1234', '654321', 'password-change-0003'))
      .rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(mocked.updateUserById).not.toHaveBeenCalled();
  });

  it('recovers Auth-success/DB-failure without a second Auth mutation', async () => {
    const mocked = clientsFor({
      verifiedPasswords: ['654321'],
      rpcStates: [
        { data: { state: 'recover' }, error: null },
        { data: { state: 'recover' }, error: null },
        { data: { completed: true }, error: null }
      ]
    });
    await new SupabaseAuthService(mocked.clients).changePassword(actor, '1234', '654321', 'password-change-0004');
    expect(mocked.updateUserById).not.toHaveBeenCalled();
  });

  it('fails closed after a crash-before-Auth ambiguity rather than losing a possible completed audit', async () => {
    const mocked = clientsFor({
      rpcStates: [
        { data: { state: 'recover' }, error: null },
        { data: { state: 'recover' }, error: null },
        { data: null, error: null }
      ]
    });
    await expect(new SupabaseAuthService(mocked.clients).changePassword(actor, '1234', '654321', 'password-change-0005'))
      .rejects.toMatchObject({ code: 'PASSWORD_STATE_INCONSISTENT' });
    expect(mocked.updateUserById).not.toHaveBeenCalled();
    expect(mocked.rpc.mock.calls[2]?.[0]).toBe('finish_password_change_failure');
  });

  it('does not prepare a receipt for an invalid current password', async () => {
    const mocked = clientsFor({ rpcStates: [{ data: { state: 'absent' }, error: null }] });
    await expect(new SupabaseAuthService(mocked.clients).changePassword(actor, '9999', '654321', 'password-change-0006'))
      .rejects.toMatchObject({ statusCode: 401, code: 'INVALID_CURRENT_PASSWORD' });
    expect(mocked.rpc).toHaveBeenCalledOnce();
    expect(mocked.updateUserById).not.toHaveBeenCalled();
  });

  it('fails closed if a verification session cannot be revoked', async () => {
    const mocked = clientsFor({ verifiedPasswords: ['tmp:1234'], rpcStates: [{ data: { state: 'absent' }, error: null }] });
    mocked.signOut.mockResolvedValueOnce({ error: { message: 'unavailable' } });
    await expect(new SupabaseAuthService(mocked.clients).changePassword(actor, '1234', '654321', 'password-change-0007'))
      .rejects.toMatchObject({ code: 'PASSWORD_VERIFICATION_SESSION_REVOKE_FAILED' });
    expect(mocked.rpc).toHaveBeenCalledOnce();
    expect(mocked.updateUserById).not.toHaveBeenCalled();
  });

  it('reports replay instructions when DB completion fails after Auth success', async () => {
    const mocked = clientsFor({
      verifiedPasswords: ['tmp:1234'],
      rpcStates: [
        { data: { state: 'absent' }, error: null },
        { data: { state: 'execute' }, error: null },
        { data: null, error: { message: 'database unavailable' } }
      ]
    });
    await expect(new SupabaseAuthService(mocked.clients).changePassword(actor, '1234', '654321', 'password-change-0008'))
      .rejects.toMatchObject({ code: 'PASSWORD_STATE_UPDATE_FAILED' });
    expect(mocked.updateUserById).toHaveBeenCalledOnce();
  });

  it('maps cross-session receipt takeover to the stable Fastify conflict', async () => {
    const mocked = clientsFor({
      rpcStates: [{ data: null, error: { message: 'PASSWORD_CHANGE_SESSION_MISMATCH' } }]
    });
    await expect(
      new SupabaseAuthService(mocked.clients).changePassword(
        actor,
        '1234',
        '654321',
        'password-change-0009'
      )
    ).rejects.toMatchObject({ statusCode: 409, code: 'PASSWORD_CHANGE_SESSION_MISMATCH' });
    expect(mocked.signInWithPassword).not.toHaveBeenCalled();
    expect(mocked.updateUserById).not.toHaveBeenCalled();
  });
});
