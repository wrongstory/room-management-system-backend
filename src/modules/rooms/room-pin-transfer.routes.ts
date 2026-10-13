import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/app-error.js';
import type { RoomPinTransfer } from './room-pin-transfer.js';
import { roomPinTransferFailure } from './room-pin-transfer-http.js';

export function createRoomPinTransferRoutes(service: RoomPinTransfer): FastifyPluginAsync {
  return async app => {
    app.addHook('onRequest', async (_request, reply) => { reply.header('cache-control', 'no-store'); });
    const guard = async (request: FastifyRequest) => {
      if (request.actor.role !== 'admin') throw new AppError(403, 'ADMIN_REQUIRED', '관리자 권한이 필요합니다.');
      if ([...new URL(request.raw.url ?? '/', 'http://internal').searchParams.keys()].length) {
        throw new AppError(400, 'VALIDATION_ERROR', 'query 항목은 허용되지 않습니다.');
      }
    };
    const actor = (request: FastifyRequest) => {
      try {
        const value = JSON.parse(Buffer.from(request.actor.accessToken.split('.')[1] ?? '', 'base64url').toString('utf8'));
        return { profileId: request.actor.profileId, sessionId: z.uuid().parse(value.session_id) };
      } catch { throw new AppError(401, 'SESSION_REVOKED', '다시 로그인해 주세요.'); }
    };
    const run = async <T>(fn: () => Promise<T>) => {
      try { return await fn(); } catch (error) {
        const failure = roomPinTransferFailure(error);
        throw new AppError(failure.status, failure.code, failure.message);
      }
    };
    const preHandler = [app.authenticate, app.requirePasswordChanged, guard];
    app.get('/export', { preHandler }, async (request, reply) => {
      const identity = actor(request);
      const file = await run(() => service.export(identity));
      return reply.header('content-disposition', 'attachment; filename="room-pins.xlsx"')
        .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(Buffer.from(file));
    });
    app.post('/import/preview', { preHandler }, async request => {
      z.object({}).strict().parse(request.body);
      const identity = actor(request);
      return { preview: await run(() => service.preview(identity)) };
    });
    app.post('/import/apply', { preHandler }, async request => {
      const body = z.object({ previewToken: z.string().max(160) }).strict().parse(request.body);
      const key = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/).parse(request.headers['idempotency-key']);
      const identity = actor(request);
      return { imported: await run(() => service.apply(identity, body.previewToken, key)) };
    });
  };
}
