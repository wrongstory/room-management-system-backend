import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { AppEnv } from '../../config/env.js';
import type { SupabaseClients } from '../../lib/supabase.js';
import { PhotoError, initializePhotoDecoder } from './photo-binary.js';
import { GoogleDriveProvider } from './google-drive.js';
import { PhotoService, photoError, photoRoute, type PhotoIdentity } from './photo-service.js';

export interface PhotoHttpServices {
  service: PhotoService;
  authenticate(request: Request, read: boolean): Promise<PhotoIdentity>;
  denied(identity: PhotoIdentity, code: string): Promise<void>;
}
export function createPhotoHttpServices(clients: SupabaseClients, env: AppEnv): PhotoHttpServices {
  let provider: GoogleDriveProvider | undefined, decoder: Promise<void> | undefined;
  return {
    service: new PhotoService(clients.admin, () => {
      provider ??= new GoogleDriveProvider({ clientId: env.GOOGLE_DRIVE_CLIENT_ID ?? '', clientSecret: env.GOOGLE_DRIVE_CLIENT_SECRET ?? '', refreshToken: env.GOOGLE_DRIVE_REFRESH_TOKEN ?? '', rootFolderId: env.GOOGLE_DRIVE_ROOT_FOLDER_ID ?? '' });
      return provider;
    }, () => {
      decoder ??= readFile(new URL(import.meta.resolve('@imagemagick/magick-wasm/magick.wasm'))).then(initializePhotoDecoder);
      return decoder;
    }),
    async authenticate(request, read) {
      const auth = request.headers.get('authorization');
      if (!auth?.startsWith('Bearer ') || !auth.slice(7).trim()) throw new PhotoError(401, 'MISSING_ACCESS_TOKEN');
      const token = auth.slice(7).trim();
      const user = await clients.publicClient.auth.getUser(token);
      if (user.error || !user.data.user) throw new PhotoError(401, 'INVALID_ACCESS_TOKEN');
      const profile = await clients.admin.from('profiles').select('id,auth_user_id,role,status,must_change_password').eq('auth_user_id', user.data.user.id).single();
      if (profile.error || !profile.data || profile.data.auth_user_id !== user.data.user.id) throw new PhotoError(401, 'PROFILE_NOT_FOUND');
      const p = profile.data;
      if (read ? p.status !== 'active' : p.role !== 'maid' || !['active', 'deactivation_pending', 'upload_only'].includes(p.status)) throw new PhotoError(403, read ? 'ACCOUNT_INACTIVE' : 'CAPABILITY_ACCESS_REQUIRED');
      if (p.must_change_password !== false) throw new PhotoError(403, 'PASSWORD_CHANGE_REQUIRED');
      let session: unknown;
      try { session = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')).session_id; }
      catch { throw new PhotoError(401, 'INVALID_ACCESS_TOKEN'); }
      if (typeof session !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(session)) throw new PhotoError(401, 'INVALID_ACCESS_TOKEN');
      const active = await clients.admin.rpc('is_active_auth_session', { p_auth_user_id: user.data.user.id, p_session_id: session });
      if (active.error || active.data !== true) throw new PhotoError(401, 'SESSION_REVOKED');
      return { profileId: p.id, sessionId: session, role: p.role, profileStatus: p.status };
    },
    async denied(identity, code) {
      const result = await clients.admin.rpc('record_authorization_denial', { p_actor_profile_id: identity.profileId, p_source: 'edge.authorization.photos', p_reason_code: code });
      if (result.error) throw new PhotoError(500, 'ACTIVITY_RECORD_FAILED');
    }
  };
}
export function webRequest(request: FastifyRequest, body = false): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
  const init: RequestInit & { duplex?: 'half' } = { method: request.method, headers };
  if (body && request.body instanceof Readable) { init.body = Readable.toWeb(request.body) as ReadableStream; init.duplex = 'half'; }
  return new Request(new URL(request.raw.url ?? '/', 'http://backend.internal'), init);
}
export function createPhotoRoutes(services: PhotoHttpServices): FastifyPluginAsync {
  return async app => {
    // Encapsulated raw-stream parser. No multipart/base64 buffering or caller MIME parser is used.
    app.removeAllContentTypeParsers();
    app.addContentTypeParser('*', (_request, payload, done) => done(null, payload));
    const identities = new WeakMap<FastifyRequest, PhotoIdentity>();
    app.setErrorHandler(async (error, request, reply) => {
      const frameworkCode = error && typeof error === 'object' && 'code' in error ? error.code : null;
      let safe = frameworkCode === 'FST_ERR_CTP_BODY_TOO_LARGE' ? new PhotoError(413, 'PHOTO_TOO_LARGE')
        : frameworkCode === 'FST_ERR_CTP_INVALID_CONTENT_LENGTH' ? new PhotoError(400, 'INVALID_PHOTO_BINARY') : photoError(error);
      const identity = identities.get(request);
      if (identity && ['PHOTO_ACCESS_REQUIRED', 'CAPABILITY_ACCESS_REQUIRED'].includes(safe.code)) {
        try { await services.denied(identity, safe.code); } catch { safe = new PhotoError(500, 'ACTIVITY_RECORD_FAILED'); }
      }
      return reply.code(safe.statusCode).header('cache-control', 'no-store').send({ error: { code: safe.code, message: '사진 작업 조건을 확인해 주세요.' }, requestId: request.id });
    });
    const routes = [
      ['POST', '/v1/attempts/:attemptId/photo-slots/:slotId/upload'],
      ['GET', '/v1/attempts/:attemptId/photo-slots'],
      ['GET', '/v1/photo-uploads/:operationId'],
      ['GET', '/v1/photos/:photoId/content']
    ] as const;
    for (const [method, url] of routes) app.route({ method, url, bodyLimit: 307200, logLevel: 'silent',
      onRequest: async request => { identities.set(request, await services.authenticate(webRequest(request), url.endsWith('/content'))); },
      handler: async (request, reply) => {
        const web = webRequest(request, method === 'POST'), route = photoRoute(method, new URL(web.url).pathname), identity = identities.get(request);
        if (!route || !identity) throw new PhotoError(404, 'ROUTE_NOT_FOUND');
        if (route.kind === 'content') {
          const result = await services.service.content(web, identity, route.photoId);
          result.headers.forEach((value, name) => { reply.header(name, value); });
          return reply.code(result.status).send(Buffer.from(await result.arrayBuffer()));
        }
        const result = route.kind === 'upload' ? await services.service.upload(web, identity, route.attemptId, route.slotId)
          : route.kind === 'slots' ? await services.service.slots(web, identity, route.attemptId) : await services.service.status(web, identity, route.operationId);
        return reply.header('cache-control', 'no-store').send(result);
      }
    });
  };
}
