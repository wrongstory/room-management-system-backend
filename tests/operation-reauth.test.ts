import { describe, expect, it, vi } from 'vitest';
import { prepareOperationReauthentication } from '../src/modules/developer-reset/operation-reauth.js';
import type { ResetPreviewRpc } from '../src/modules/developer-reset/reset-preview.js';

const id = (n: number) => `f3961280-0000-4000-8000-${String(n).padStart(12, '0')}`;
const token = (session: string) => `header.${Buffer.from(JSON.stringify({ session_id: session })).toString('base64url')}.signature`;
const request = () => ({ actor: { profileId: id(1), authUserId: id(2), role: 'developer', mustChangePassword: false },
  sessionId: id(3), password: '123456', clientDigest: 'a'.repeat(64), targetRef: 'synthetic-target',
  controlVersion: '1', action: 'RESET_REVIEW' as const });
const receipt = { challengeId: id(4), nonce: 'b'.repeat(64), expiresAt: '2026-10-25T10:00:00Z' };
function harness(failure?: string) {
  const steps: string[] = [];
  const rpc: ResetPreviewRpc = vi.fn(async name => {
    steps.push(name);
    if (name === failure) return { data: null, error: { secret: 'must-not-escape' } };
    return { data: name === 'consume_password_verification_rate_limit' ? [{ allowed: true }]
      : name === 'begin_developer_operation_reauth' ? receipt : null, error: null };
  });
  const provider = {
    signIn: vi.fn(async () => { steps.push('signIn'); return { accessToken: token(id(5)) }; }),
    revoke: vi.fn(async () => { steps.push('revoke'); }),
  };
  return { steps, rpc, provider, signal: new AbortController().signal };
}
describe('trusted operation reauthentication orchestration', () => {
  it('requires DB observed password probe, then local revoke, then DB absence readback', async () => {
    const h = harness();
    expect(await prepareOperationReauthentication(request(), h)).toEqual(receipt);
    expect(h.steps).toEqual(['consume_password_verification_rate_limit', 'begin_developer_operation_reauth',
      'signIn', 'verify_developer_operation_probe', 'revoke', 'finish_developer_operation_reauth']);
    expect(h.rpc).toHaveBeenNthCalledWith(3, 'verify_developer_operation_probe', expect.objectContaining({
      p_actor: id(1), p_auth: id(2), p_session: id(3), p_challenge: id(4), p_nonce: receipt.nonce, p_probe_session: id(5),
    }), h.signal);
    expect(h.rpc).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ verified: true }), expect.anything());
  });
  it.each(['consume_password_verification_rate_limit', 'begin_developer_operation_reauth'])('stops before Auth when %s fails', async failure => {
    const h = harness(failure);
    await expect(prepareOperationReauthentication(request(), h)).rejects.toThrow('OPERATION_REAUTH_UNAVAILABLE');
    expect(h.provider.signIn).not.toHaveBeenCalled();
  });
  it('revokes the temporary session even when DB rejects identity, nonce, AMR or version', async () => {
    const h = harness('verify_developer_operation_probe');
    await expect(prepareOperationReauthentication(request(), h)).rejects.toThrow('OPERATION_REAUTH_UNAVAILABLE');
    expect(h.steps.at(-1)).toBe('revoke');
    expect(h.steps).not.toContain('finish_developer_operation_reauth');
  });
  it('does not finalize when provider revocation fails', async () => {
    const h = harness(); h.provider.revoke.mockRejectedValueOnce(new Error('private-token'));
    await expect(prepareOperationReauthentication(request(), h)).rejects.toThrow('OPERATION_PROBE_CLEANUP_REQUIRED');
    expect(h.steps).not.toContain('finish_developer_operation_reauth');
  });
  it('does not return a ready receipt when DB revocation readback or fresh actor check fails', async () => {
    const h = harness('finish_developer_operation_reauth');
    await expect(prepareOperationReauthentication(request(), h)).rejects.toThrow('OPERATION_REAUTH_UNAVAILABLE');
    expect(h.provider.revoke).toHaveBeenCalledOnce();
  });
  it('cleans a malformed provider token and never uses decoded claims as proof', async () => {
    const h = harness(); h.provider.signIn.mockResolvedValueOnce({ accessToken: 'malformed' });
    await expect(prepareOperationReauthentication(request(), h)).rejects.toThrow('OPERATION_REAUTH_REJECTED');
    expect(h.provider.revoke).toHaveBeenCalledWith('malformed');
    expect(h.steps).not.toContain('verify_developer_operation_probe');
  });
  it('rejects a provider session that is the original session', async () => {
    const h = harness(); h.provider.signIn.mockResolvedValueOnce({ accessToken: token(id(3)) });
    await expect(prepareOperationReauthentication(request(), h)).rejects.toThrow('OPERATION_REAUTH_REJECTED');
    expect(h.steps).not.toContain('verify_developer_operation_probe');
    expect(h.provider.revoke).not.toHaveBeenCalled();
  });
  it('sanitizes Auth transport errors', async () => {
    const h = harness(); h.provider.signIn.mockRejectedValueOnce(new Error('private-password'));
    await expect(prepareOperationReauthentication(request(), h)).rejects.toThrow('OPERATION_REAUTH_UNAVAILABLE');
    expect(h.steps).not.toContain('finish_developer_operation_reauth');
  });
  it('rejects an already aborted bounded operation before any I/O', async () => {
    const h = harness(); h.signal = AbortSignal.abort();
    await expect(prepareOperationReauthentication(request(), h)).rejects.toThrow('OPERATION_REAUTH_UNAVAILABLE');
    expect(h.steps).toEqual([]);
  });
  it.each([
    { sessionId: 'bad' }, { controlVersion: '0' }, { controlVersion: '9223372036854775808' },
    { clientDigest: 'true' }, { targetRef: 'https://wrong-target.invalid' }, { password: '' },
    { actor: { ...request().actor, role: 'admin' } }, { actor: { ...request().actor, mustChangePassword: true } },
  ])('rejects invalid bindings before I/O %#', async change => {
    const h = harness();
    await expect(prepareOperationReauthentication({ ...request(), ...change }, h)).rejects.toThrow('OPERATION_REAUTH_REJECTED');
    expect(h.steps).toEqual([]);
  });
});
