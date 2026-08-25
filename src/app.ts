import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import type { AppEnv } from './config/env.js';
import { createSupabaseClients } from './lib/supabase.js';
import { AppError } from './lib/app-error.js';
import { SupabaseAuthService, type AuthService } from './modules/auth/auth.service.js';
import { createAuthRoutes } from './modules/auth/auth.routes.js';
import { SupabaseRoomService, type RoomService } from './modules/rooms/room.service.js';
import { createRoomRoutes } from './modules/rooms/room.routes.js';

export interface AppServices {
  auth: AuthService;
  rooms: RoomService;
}

export interface BuildAppOptions {
  env: AppEnv;
  services?: AppServices;
  logger?: boolean;
}

function bearerToken(authorization: string | undefined): string {
  if (!authorization?.startsWith('Bearer ')) {
    throw new AppError(401, 'MISSING_ACCESS_TOKEN', '로그인이 필요합니다.');
  }

  const token = authorization.slice('Bearer '.length).trim();
  if (!token) {
    throw new AppError(401, 'MISSING_ACCESS_TOKEN', '로그인이 필요합니다.');
  }
  return token;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger === false ? false : { level: options.env.LOG_LEVEL },
    requestIdHeader: 'x-request-id',
    trustProxy: true
  });

  const clients = options.services ? null : createSupabaseClients(options.env);
  const services = options.services ?? {
    auth: new SupabaseAuthService(clients!),
    rooms: new SupabaseRoomService(clients!)
  };

  await app.register(helmet, { global: true });
  await app.register(rateLimit, { global: true, max: 120, timeWindow: '1 minute' });
  await app.register(cors, {
    credentials: true,
    origin(origin, callback) {
      if (!origin || options.env.corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error('허용되지 않은 Origin입니다.'), false);
    }
  });

  app.decorateRequest('actor');
  app.decorate('authenticate', async (request) => {
    request.actor = await services.auth.authenticate(bearerToken(request.headers.authorization));
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: '요청 값이 올바르지 않습니다.',
          details: error.issues
        },
        requestId: request.id
      });
    }
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message },
        requestId: request.id
      });
    }

    request.log.error({ err: error }, 'Unhandled request error');
    return reply.code(500).send({
      error: { code: 'INTERNAL_SERVER_ERROR', message: '서버 오류가 발생했습니다.' },
      requestId: request.id
    });
  });

  app.get('/health', async () => ({
    status: 'ok',
    service: 'room-management-system-backend',
    timestamp: new Date().toISOString()
  }));

  await app.register(createAuthRoutes(services.auth), { prefix: '/v1/auth' });
  await app.register(createRoomRoutes(services.rooms), { prefix: '/v1/rooms' });

  return app;
}
