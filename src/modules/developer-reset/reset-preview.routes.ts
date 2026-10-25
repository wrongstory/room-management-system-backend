import type { FastifyPluginAsync } from 'fastify';
import type { Actor } from '../../domain/actor.js';
import { AppError } from '../../lib/app-error.js';
import { readResetPreview, ResetPreviewError, type ResetPreviewRpc } from './reset-preview.js';

export interface ResetPreviewService { read(actor: Actor): Promise<ReturnType<typeof import('./reset-preview.js').summarizeResetPreview>> }
export class SupabaseResetPreviewService implements ResetPreviewService {
  constructor(private readonly rpc: ResetPreviewRpc) {}
  async read(actor: Actor) {
    let sessionId = '';
    try {
      const encoded = actor.accessToken.split('.')[1];
      if (encoded) {
        const claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as { session_id?: unknown };
        if (typeof claims.session_id === 'string') sessionId = claims.session_id;
      }
    } catch { /* Invalid claims fail closed in readResetPreview. */ }
    return readResetPreview(this.rpc, actor, sessionId);
  }
}
export function createDeveloperResetPreviewRoutes(service: ResetPreviewService): FastifyPluginAsync {
  return async app => {
    app.get('/reset/preview', {
      exposeHeadRoute: false,
      onRequest: async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        if (request.raw.url !== '/v1/developer/reset/preview') throw new AppError(400, 'VALIDATION_ERROR', '조회 조건을 지정할 수 없습니다.');
      },
      preHandler: [app.authenticate, app.requirePasswordChanged, app.requireDeveloper],
    }, async (request, reply) => {
      try { return reply.send({ preview: await service.read(request.actor) }); }
      catch (error) {
        if (error instanceof ResetPreviewError) throw new AppError(error.status, error.code, '초기화 영향 조회 조건을 확인해 주세요.');
        throw new AppError(503, 'RESET_PREVIEW_UNAVAILABLE', '초기화 영향을 조회하지 못했습니다.');
      }
    });
  };
}
