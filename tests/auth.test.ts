import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClients } from '../src/lib/supabase.js';
import { SupabaseAuthService } from '../src/modules/auth/auth.service.js';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});

afterEach(() => vi.mocked(randomUUID).mockReset());

const profileId = '10000000-0000-4000-8000-000000000001';
const authUserId = '20000000-0000-4000-8000-000000000001';
const sessionId = '30000000-0000-4000-8000-000000000001';
const accessToken = `x.${Buffer.from(JSON.stringify({ session_id: sessionId })).toString('base64url')}.y`;
const verificationPepper = 'password-verification-test-pepper-at-least-32-characters';
const effectMarker = 'e'.repeat(64);
const proposedMarkerNonce = '42200000-0000-4000-8000-000000000001';
// Its real SHA-256 claim contains "1234": reproduce the former CI false positive.
const claimNonce = '42200000-0000-4000-8000-0000000000e7';
const expectedPrepare = {
  p_actor_profile_id: profileId,
  p_auth_user_id: authUserId,
  p_session_id: sessionId,
  p_idempotency_key: 'password-change-0001',
  p_request_hash: createHash('sha256')
    .update(JSON.stringify({ actorProfileId: profileId, command: 'account.password.change' }))
    .digest('hex'),
  p_claim_digest: createHash('sha256').update(`password-change-claim:v1\0${claimNonce}`).digest('hex'),
  p_effect_marker: createHash('sha256').update(`password-change-effect:v1\0${proposedMarkerNonce}`).digest('hex')
};

function expectSafePrepare(parameters: unknown) {
  // Exact keys and password-independent values reject plaintext, transformed
  // passwords, extra fields, and even a valid-looking password-derived digest.
  expect(parameters).toStrictEqual(expectedPrepare);
}
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
  rateLimitAllowed?: boolean | boolean[];
  authPasswordVersion?: string | null;
  authPasswordVersions?: Array<string | null>;
}) {
  const verified = [...(options.verifiedPasswords ?? [])];
  const rateLimitDecisions = Array.isArray(options.rateLimitAllowed)
    ? [...options.rateLimitAllowed]
    : null;
  const signInWithPassword = vi.fn(async ({ password }: { password: string }) => {
    const expected = verified.shift();
    return password === expected
      ? { data: { session: { access_token: `verification-${verified.length}` } }, error: null }
      : { data: { session: null }, error: { message: 'invalid' } };
  });
  const states = [...options.rpcStates];
  const passwordVersions = [...(options.authPasswordVersions ?? [])];
  const rpc = vi.fn(async (name: string, _parameters?: Record<string, string>) => {
    if (name === 'consume_password_verification_rate_limit') {
      const allowed = rateLimitDecisions?.shift() ?? (options.rateLimitAllowed !== false);
      return {
        data: [{ allowed, retry_after_seconds: 60 }],
        error: null
      };
    }
    if (name === 'get_auth_password_version') {
      return {
        data: passwordVersions.length > 0
          ? passwordVersions.shift()
          : (options.authPasswordVersion === undefined ? effectMarker : options.authPasswordVersion),
        error: null
      };
    }
    const result = states.shift() ?? { data: null, error: null };
    if (
      result.data && typeof result.data === 'object' &&
      'state' in result.data && (result.data as { state?: unknown }).state !== 'absent' &&
      !('effectMarker' in result.data)
    ) {
      return { ...result, data: { ...result.data, effectMarker } };
    }
    return result;
  });
  const updateUserById = vi.fn(async () => ({ error: options.updateError ?? null }));
  const signOut = vi.fn(async () => ({ error: null as null | { message: string } }));
  const clients = {
    publicClient: { auth: { signInWithPassword } },
    admin: {
      auth: {
        admin: {
          updateUserById,
          signOut,
          getUserById: vi.fn()
        }
      },
      rpc
    }
  } as unknown as SupabaseClients;
  return { clients, rpc, signInWithPassword, updateUserById, signOut };
}

describe('password change replay receipt', () => {
  it('changes Auth once and completes the scoped receipt', async () => {
    vi.mocked(randomUUID).mockReturnValueOnce(proposedMarkerNonce).mockReturnValueOnce(claimNonce);
    const mocked = clientsFor({
      verifiedPasswords: ['tmp:1234'],
      rpcStates: [
        { data: { state: 'absent' }, error: null },
        { data: { state: 'execute' }, error: null },
        { data: { completed: true }, error: null }
      ]
    });
    await new SupabaseAuthService(mocked.clients, verificationPepper).changePassword(actor, '1234', '654321', 'password-change-0001', 'fastify-client-1');
    expect(mocked.updateUserById).toHaveBeenCalledOnce();
    expect(mocked.updateUserById).toHaveBeenCalledWith(authUserId, {
      password: '654321',
      app_metadata: {
        profile_id: profileId,
        role: 'admin'
      }
    });
    expect(mocked.rpc.mock.calls.map(([name]) => name).filter((name) => name !== 'consume_password_verification_rate_limit')).toEqual([
      'inspect_password_change', 'prepare_password_change', 'get_auth_password_version', 'complete_password_change'
    ]);
    const prepareCall = mocked.rpc.mock.calls.find(([name]) => name === 'prepare_password_change');
    const prepare = prepareCall?.[1] as Record<string, string>;
    expect(prepare.p_request_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(prepare.p_claim_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(prepare.p_effect_marker).toMatch(/^[0-9a-f]{64}$/);
    expect(prepare.p_claim_digest).toContain('1234');
    expectSafePrepare(prepare);
    expect(randomUUID).toHaveBeenCalledTimes(2);
  });

  it.each(['1234', 'tmp:1234', '654321'])('rejects an extra receipt field leaking %s', (password) => {
    expect(() => expectSafePrepare({ ...expectedPrepare, p_password: password })).toThrow();
  });

  it.each(['p_request_hash', 'p_claim_digest', 'p_effect_marker'] as const)(
    'rejects plaintext and password-derived values in %s', (field) => {
      for (const password of ['1234', 'tmp:1234', '654321']) {
        for (const value of [password, createHash('sha256').update(password).digest('hex')]) {
          expect(() => expectSafePrepare({ ...expectedPrepare, [field]: value })).toThrow();
        }
      }
    }
  );

  it('returns success after response loss by verifying the supplied new password', async () => {
    const mocked = clientsFor({ verifiedPasswords: ['654321'], rpcStates: [{ data: { state: 'completed' }, error: null }] });
    await new SupabaseAuthService(mocked.clients, verificationPepper).changePassword(actor, '1234', '654321', 'password-change-0002', 'fastify-client-1');
    expect(mocked.updateUserById).not.toHaveBeenCalled();
    expect(mocked.rpc.mock.calls.map(([name]) => name)).toEqual([
      'inspect_password_change',
      'get_auth_password_version',
      'consume_password_verification_rate_limit',
      'get_auth_password_version'
    ]);
    expect(mocked.signOut).toHaveBeenCalledOnce();
  });

  it('rejects a completed key when the intended new password is not current', async () => {
    const mocked = clientsFor({ rpcStates: [{ data: { state: 'completed' }, error: null }] });
    await expect(new SupabaseAuthService(mocked.clients, verificationPepper).changePassword(actor, '1234', '654321', 'password-change-0003', 'fastify-client-1'))
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
    await new SupabaseAuthService(mocked.clients, verificationPepper).changePassword(actor, '1234', '654321', 'password-change-0004', 'fastify-client-1');
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
    await expect(new SupabaseAuthService(mocked.clients, verificationPepper).changePassword(actor, '1234', '654321', 'password-change-0005', 'fastify-client-1'))
      .rejects.toMatchObject({ code: 'PASSWORD_STATE_INCONSISTENT' });
    expect(mocked.updateUserById).not.toHaveBeenCalled();
    expect(mocked.rpc.mock.calls.map(([name]) => name)).toContain('finish_password_change_failure');
  });

  it('does not prepare a receipt for an invalid current password', async () => {
    const mocked = clientsFor({ rpcStates: [{ data: { state: 'absent' }, error: null }] });
    await expect(new SupabaseAuthService(mocked.clients, verificationPepper).changePassword(actor, '9999', '654321', 'password-change-0006', 'fastify-client-1'))
      .rejects.toMatchObject({ statusCode: 401, code: 'INVALID_CURRENT_PASSWORD' });
    expect(mocked.rpc.mock.calls.map(([name]) => name)).toEqual([
      'inspect_password_change',
      'consume_password_verification_rate_limit'
    ]);
    expect(mocked.updateUserById).not.toHaveBeenCalled();
  });

  it('fails closed if a verification session cannot be revoked', async () => {
    const mocked = clientsFor({ verifiedPasswords: ['tmp:1234'], rpcStates: [{ data: { state: 'absent' }, error: null }] });
    mocked.signOut.mockResolvedValueOnce({ error: { message: 'unavailable' } });
    await expect(new SupabaseAuthService(mocked.clients, verificationPepper).changePassword(actor, '1234', '654321', 'password-change-0007', 'fastify-client-1'))
      .rejects.toMatchObject({ code: 'PASSWORD_VERIFICATION_SESSION_REVOKE_FAILED' });
    expect(mocked.rpc.mock.calls.map(([name]) => name)).toEqual([
      'inspect_password_change',
      'consume_password_verification_rate_limit'
    ]);
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
    await expect(new SupabaseAuthService(mocked.clients, verificationPepper).changePassword(actor, '1234', '654321', 'password-change-0008', 'fastify-client-1'))
      .rejects.toMatchObject({ code: 'PASSWORD_STATE_UPDATE_FAILED' });
    expect(mocked.updateUserById).toHaveBeenCalledOnce();
  });

  it('maps cross-session receipt takeover to the stable Fastify conflict', async () => {
    const mocked = clientsFor({
      rpcStates: [{ data: null, error: { message: 'PASSWORD_CHANGE_SESSION_MISMATCH' } }]
    });
    await expect(
      new SupabaseAuthService(mocked.clients, verificationPepper).changePassword(
        actor,
        '1234',
        '654321',
        'password-change-0009',
        'fastify-client-1'
      )
    ).rejects.toMatchObject({ statusCode: 409, code: 'PASSWORD_CHANGE_SESSION_MISMATCH' });
    expect(mocked.signInWithPassword).not.toHaveBeenCalled();
    expect(mocked.updateUserById).not.toHaveBeenCalled();
  });

  it('limits wrong current-password verification before another Auth call', async () => {
    const mocked = clientsFor({
      rateLimitAllowed: false,
      rpcStates: [{ data: { state: 'absent' }, error: null }]
    });
    await expect(
      new SupabaseAuthService(mocked.clients, verificationPepper).changePassword(
        actor,
        '9999',
        '654321',
        'password-change-limited-0010',
        'fastify-attacker-client'
      )
    ).rejects.toMatchObject({
      statusCode: 429,
      code: 'PASSWORD_VERIFICATION_RATE_LIMITED',
      headers: { 'Retry-After': '60' }
    });
    expect(mocked.signInWithPassword).not.toHaveBeenCalled();
  });

  it('does not let rotating idempotency keys bypass the actor verification limit', async () => {
    const mocked = clientsFor({
      rateLimitAllowed: [...Array.from({ length: 10 }, () => true), false],
      rpcStates: Array.from({ length: 11 }, () => ({ data: { state: 'absent' }, error: null }))
    });
    const service = new SupabaseAuthService(mocked.clients, verificationPepper);

    for (let index = 0; index < 11; index += 1) {
      const result = service.changePassword(
        actor,
        'wrong-current',
        '654321',
        `password-rotating-${index.toString().padStart(4, '0')}`,
        'fastify-attacker-client'
      );
      await expect(result).rejects.toMatchObject(
        index === 10
          ? { statusCode: 429, code: 'PASSWORD_VERIFICATION_RATE_LIMITED' }
          : { statusCode: 401, code: 'INVALID_CURRENT_PASSWORD' }
      );
    }

    expect(mocked.signInWithPassword).toHaveBeenCalledTimes(10);
    expect(mocked.updateUserById).not.toHaveBeenCalled();
  });

  it('limits completed-receipt wrong-password probes before another Auth call', async () => {
    const mocked = clientsFor({
      rateLimitAllowed: [...Array.from({ length: 10 }, () => true), false],
      rpcStates: Array.from({ length: 11 }, () => ({ data: { state: 'completed' }, error: null }))
    });
    const service = new SupabaseAuthService(mocked.clients, verificationPepper);

    for (let index = 0; index < 11; index += 1) {
      const result = service.changePassword(
        actor,
        'unused-current',
        'wrong-new-password',
        'password-completed-probe-0012',
        'fastify-attacker-client'
      );
      await expect(result).rejects.toMatchObject(
        index === 10
          ? { statusCode: 429, code: 'PASSWORD_VERIFICATION_RATE_LIMITED' }
          : { statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED' }
      );
    }

    expect(mocked.signInWithPassword).toHaveBeenCalledTimes(10);
    expect(mocked.updateUserById).not.toHaveBeenCalled();
  });

  it('rejects an old completed key after a later password operation rotates the private version', async () => {
    const mocked = clientsFor({
      authPasswordVersion: 'f'.repeat(64),
      rpcStates: [{ data: { state: 'completed', effectMarker }, error: null }]
    });
    await expect(
      new SupabaseAuthService(mocked.clients, verificationPepper).changePassword(
        actor,
        '654321',
        '777777',
        'password-change-old-effect-0011',
        'fastify-client-1'
      )
    ).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(mocked.signInWithPassword).not.toHaveBeenCalled();
  });

  it('fails closed when a concurrent Auth password update rotates the version during replay proof', async () => {
    const mocked = clientsFor({
      authPasswordVersions: [effectMarker, 'f'.repeat(64)],
      verifiedPasswords: ['654321'],
      rpcStates: [{ data: { state: 'completed', effectMarker }, error: null }]
    });
    await expect(
      new SupabaseAuthService(mocked.clients, verificationPepper).changePassword(
        actor,
        '1234',
        '654321',
        'password-change-concurrent-effect-0013',
        'fastify-client-1'
      )
    ).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(mocked.updateUserById).not.toHaveBeenCalled();
    expect(mocked.signOut).toHaveBeenCalledOnce();
  });
});
