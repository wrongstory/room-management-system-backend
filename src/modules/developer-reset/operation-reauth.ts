import { createClient } from '@supabase/supabase-js';
import type { AppEnv } from '../../config/env.js';
import { isLoginPassword, toSupabaseAuthPassword } from '../auth/password.js';
import type { ResetPreviewActor, ResetPreviewRpc } from './reset-preview.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = /^[0-9a-f]{64}$/;
export type OperationAction = 'RESET_REVIEW' | 'REQUEST_MAINTENANCE' | 'RESUME_ADMISSION' | 'START_OPERATION';
export class OperationReauthError extends Error {
  constructor(public readonly code: string) { super(code); }
}
export interface OperationPasswordProvider {
  signIn(profileId: string, password: string): Promise<{ accessToken: string } | null>;
  revoke(accessToken: string): Promise<void>;
}

/** Create a separate, non-persistent Auth client for each attempt. No token is logged or returned to HTTP. */
export function createOperationPasswordProvider(
  env: Pick<AppEnv, 'SUPABASE_URL' | 'SUPABASE_PUBLISHABLE_KEY' | 'SUPABASE_SECRET_KEY'>,
  signal: AbortSignal,
): OperationPasswordProvider {
  const options = {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, signal }) },
  };
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, options);
  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, options);
  return {
    async signIn(profileId, password) {
      const { data, error } = await client.auth.signInWithPassword({
        email: `user-${profileId}@auth.castletheart.invalid`, password: toSupabaseAuthPassword(password),
      });
      if (error || !data.session) return null;
      return { accessToken: data.session.access_token };
    },
    async revoke(accessToken) {
      const { error } = await admin.auth.admin.signOut(accessToken, 'local');
      if (error) throw new OperationReauthError('OPERATION_PROBE_CLEANUP_REQUIRED');
    },
  };
}

function probeSession(token: string): string {
  // Routing hint only: SQL checks the actual Auth-owned session and password AMR.
  try {
    const part = token.split('.')[1];
    if (!part || token.length > 16384) throw new Error();
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { session_id?: unknown };
    if (typeof payload.session_id !== 'string' || !uuid.test(payload.session_id)) throw new Error();
    return payload.session_id;
  } catch { throw new OperationReauthError('OPERATION_REAUTH_REJECTED'); }
}

/** Internal orchestration, deliberately not mounted as an HTTP route. Policy/target/CAS come from server control.
 * Caller-supplied actor/nonce/decoded JWT are never proof: every receipt step rechecks current DB authority.
 * The caller must supply a bounded abort signal and a server-derived client rate-limit digest.
 */
export async function prepareOperationReauthentication(input: {
  actor: ResetPreviewActor; sessionId: string; password: string; clientDigest: string;
  targetRef: string; controlVersion: string; action: OperationAction;
}, dependencies: { rpc: ResetPreviewRpc; provider: OperationPasswordProvider; signal: AbortSignal }) {
  const { actor } = input;
  const { rpc, provider, signal } = dependencies;
  if (actor.role !== 'developer' || actor.mustChangePassword || !uuid.test(actor.profileId)
    || !uuid.test(actor.authUserId) || !uuid.test(input.sessionId) || !hash.test(input.clientDigest)
    || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(input.targetRef) || !/^[1-9][0-9]{0,18}$/.test(input.controlVersion)
    || BigInt(input.controlVersion) > 9223372036854775807n || !isLoginPassword(input.password)
    || !['RESET_REVIEW', 'REQUEST_MAINTENANCE', 'RESUME_ADMISSION', 'START_OPERATION'].includes(input.action)) {
    throw new OperationReauthError('OPERATION_REAUTH_REJECTED');
  }
  const call = async (name: string, args: Record<string, unknown>) => {
    if (signal.aborted) throw new OperationReauthError('OPERATION_REAUTH_UNAVAILABLE');
    try {
      const result = await rpc(name, args, signal);
      if (result.error || signal.aborted) throw new Error();
      return result.data;
    } catch { throw new OperationReauthError('OPERATION_REAUTH_UNAVAILABLE'); }
  };
  const rate = await call('consume_password_verification_rate_limit', {
    p_actor_profile_id: actor.profileId, p_auth_user_id: actor.authUserId, p_session_id: input.sessionId,
    p_client_digest: input.clientDigest, p_limit: 10, p_window_seconds: 60,
  });
  // Reuse the existing password-verification limit, not a new reset policy.
  if (!Array.isArray(rate) || rate.length !== 1 || rate[0]?.allowed !== true) {
    throw new OperationReauthError('OPERATION_REAUTH_RATE_LIMITED');
  }
  const common = { p_actor: actor.profileId, p_auth: actor.authUserId, p_session: input.sessionId };
  const challenge = await call('begin_developer_operation_reauth', {
    ...common, p_target: input.targetRef, p_version: input.controlVersion, p_action: input.action,
  });
  if (!challenge || typeof challenge !== 'object' || Array.isArray(challenge)) {
    throw new OperationReauthError('OPERATION_REAUTH_UNAVAILABLE');
  }
  const receipt = challenge as Record<string, unknown>;
  if (Object.keys(receipt).length !== 3 || typeof receipt.challengeId !== 'string' || !uuid.test(receipt.challengeId)
    || typeof receipt.nonce !== 'string' || !hash.test(receipt.nonce)
    || typeof receipt.expiresAt !== 'string' || !Number.isFinite(Date.parse(receipt.expiresAt))) {
    throw new OperationReauthError('OPERATION_REAUTH_UNAVAILABLE');
  }
  const bound = { ...common, p_challenge: receipt.challengeId, p_nonce: receipt.nonce };
  let probe: { accessToken: string } | null;
  try { probe = await provider.signIn(actor.profileId, input.password); }
  catch { throw new OperationReauthError('OPERATION_REAUTH_UNAVAILABLE'); }
  if (!probe) throw new OperationReauthError('OPERATION_REAUTH_REJECTED');
  let originalSession = false;
  let verificationFailure: unknown = null;
  try {
    const sessionId = probeSession(probe.accessToken);
    originalSession = sessionId.toLowerCase() === input.sessionId.toLowerCase();
    if (originalSession) throw new OperationReauthError('OPERATION_REAUTH_REJECTED');
    await call('verify_developer_operation_probe', { ...bound, p_probe_session: sessionId });
  } catch (error) { verificationFailure = error; }
  // Even rejected/malformed probes must be revoked. Failed cleanup leaves the
  // receipt unready; never interpret a timeout/provider error as successful revocation.
  try { if (!originalSession) await provider.revoke(probe.accessToken); }
  catch { throw new OperationReauthError('OPERATION_PROBE_CLEANUP_REQUIRED'); }
  if (verificationFailure) throw verificationFailure;
  await call('finish_developer_operation_reauth', bound);
  return { challengeId: receipt.challengeId, nonce: receipt.nonce, expiresAt: receipt.expiresAt };
}
