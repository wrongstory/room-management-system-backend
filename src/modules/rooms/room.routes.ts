import type { FastifyPluginAsync } from 'fastify';
import type { RoomService } from './room.service.js';

export function createRoomRoutes(roomService: RoomService): FastifyPluginAsync {
  return async (app) => {
    app.get('/', { preHandler: [app.authenticate, app.requirePasswordChanged] }, async (request) => ({
      rooms: await roomService.list(request.actor.accessToken)
    }));
  };
}
