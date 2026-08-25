import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AuthService } from './auth.service.js';

const loginSchema = z.object({
  loginId: z.string().trim().min(1).max(80),
  password: z.string().regex(/^\d{6,}$/, '로그인 비밀번호는 숫자 6자리 이상이어야 합니다.')
});

export function createAuthRoutes(authService: AuthService): FastifyPluginAsync {
  return async (app) => {
    app.post('/login', {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } }
    }, async (request, reply) => {
      const input = loginSchema.parse(request.body);
      const result = await authService.login(input);
      return reply.code(200).send(result);
    });

    app.get('/me', { preHandler: app.authenticate }, async (request) => ({
      user: {
        authUserId: request.actor.authUserId,
        profileId: request.actor.profileId,
        displayName: request.actor.displayName,
        role: request.actor.role
      }
    }));
  };
}

