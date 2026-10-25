import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '../../lib/app-error.js';
import type { SupabaseClients } from '../../lib/supabase.js';
import {
  type AdmissionConfig, type AdmissionIdentity, type AdmissionRpc, type HttpAdmissionScope,
  beginHttpAdmission, httpAdmissionRoute, HttpAdmissionError,
} from './http-admission.js';

function sessionHint(token: string): string {
  try {
    const payload = token.split('.')[1];
    if (!payload) throw new Error();
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof claims.session_id !== 'string') throw new Error();
    return claims.session_id;
  } catch { throw new HttpAdmissionError(); }
}

/** The fallback preserves routes using their own limited-session authenticator.
 * JWT claims alone never grant admission: Auth verifies the user, then the SQL
 * wrapper checks the exact route's latest actor/session/capability authority. */
async function identity(request: FastifyRequest, clients: SupabaseClients, signal: AbortSignal): Promise<AdmissionIdentity> {
  const token = request.headers.authorization?.replace(/^Bearer /, '');
  if (!token || token === request.headers.authorization) throw new HttpAdmissionError();
  const actor = request.actor;
  if (actor) return { profileId: actor.profileId, authUserId: actor.authUserId, sessionId: sessionHint(token) };
  const user = await clients.publicClient.auth.getUser(token);
  if (signal.aborted) throw new HttpAdmissionError();
  if (user.error || !user.data.user) throw new HttpAdmissionError();
  const profile = await clients.admin.from('profiles').select('id').eq('auth_user_id', user.data.user.id).abortSignal(signal).maybeSingle();
  if (profile.error || !profile.data?.id) throw new HttpAdmissionError();
  return { profileId: profile.data.id, authUserId: user.data.user.id, sessionId: sessionHint(token) };
}

export function installHttpAdmission(app: FastifyInstance, options: {
  config: AdmissionConfig | undefined;
  clients: () => SupabaseClients;
  rpc?: AdmissionRpc;
}): () => HttpAdmissionScope | undefined {
  const context = new AsyncLocalStorage<HttpAdmissionScope | undefined>();
  if (options.config) app.addHook('onRoute', route => {
    const method = Array.isArray(route.method) ? route.method[0] : route.method;
    const admissionRoute = httpAdmissionRoute(method ?? '', route.url);
    if (!admissionRoute) return;
    const handler = route.handler;
    route.handler = async function(request, reply) {
      try {
        const clients = options.clients();
        const scope = await beginHttpAdmission({
          config: options.config, route: admissionRoute,
          identity: signal => admissionRoute.routeId === 'AUTH_LOGIN' ? Promise.resolve(undefined) : identity(request, clients, signal),
          rpc: options.rpc ?? (async (name, args, signal) => {
            const result = await clients.admin.rpc(name, args).abortSignal(signal);
            return { data: result.data, error: result.error };
          }),
        });
        return await context.run(scope, () => handler.call(this, request, reply));
      } catch (error) {
        if (error instanceof HttpAdmissionError) throw new AppError(error.status, error.code, '현재 작업을 시작할 수 없습니다. 잠시 후 다시 시도해 주세요.');
        throw error;
      }
    };
  });
  return () => context.getStore();
}
