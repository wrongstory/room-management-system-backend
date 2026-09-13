import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/app-error.js';
import type { RoomPinSheetOperationsService } from './room-pin-sheet-operations.service.js';

const bodySchema = z.object({ expectedVersion: z.number().int().nonnegative() }).strict();
const keySchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);

function noQuery(request: FastifyRequest): void {
  if ([...new URL(request.raw.url ?? '/', 'http://backend.internal').searchParams.keys()].length) {
    throw new AppError(400, 'VALIDATION_ERROR', 'query 항목은 허용되지 않습니다.');
  }
}
function key(request: FastifyRequest): string {
  return keySchema.parse(request.headers['idempotency-key']);
}

export function createRoomPinSheetOperationsRoutes(service: RoomPinSheetOperationsService): FastifyPluginAsync {
  return async (app) => {
    app.addHook('onRequest', async (_request, reply) => { reply.header('cache-control', 'no-store'); });
    const requireOperator = async (request: FastifyRequest) => {
      if (request.actor.role !== 'developer' && request.actor.role !== 'admin') {
        throw new AppError(403, 'ROOM_PIN_SHEET_OPERATOR_REQUIRED', 'PIN Sheet 운영 권한이 필요합니다.');
      }
    };
    const operator = [app.authenticate, app.requirePasswordChanged, requireOperator];
    app.get('/status', { preHandler: operator }, async (request) => {
      noQuery(request);
      return { sync: await service.status(request.actor) };
    });
    app.post('/full-resync', { preHandler: operator }, async (request, reply) => {
      noQuery(request);
      const body = bodySchema.parse(request.body);
      return reply.code(202).send({ sync: await service.requestFullResync(request.actor, body.expectedVersion, key(request)) });
    });
  };
}
