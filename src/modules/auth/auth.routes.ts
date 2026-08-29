import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AuthService } from './auth.service.js';
import { isLoginPassword, isPersonalPassword } from './password.js';

const loginSchema = z.object({
  loginId: z.string().trim().min(1).max(80),
  password: z.string().refine(
    isLoginPassword,
    '임시 비밀번호 4자리 또는 허용된 개인 비밀번호를 입력해 주세요.'
  )
});

const changePasswordSchema = z.object({
  currentPassword: z.string().refine(isLoginPassword),
  newPassword: z.string().refine(
    isPersonalPassword,
    '새 비밀번호는 숫자 6자리 이상 또는 10자 이상의 영문 대·소문자, 숫자, 특수문자 조합이어야 합니다.'
  )
}).refine((value) => value.currentPassword !== value.newPassword, {
  path: ['newPassword'],
  message: '새 비밀번호는 현재 비밀번호와 달라야 합니다.'
});

function idempotencyKey(value: string | string[] | undefined): string {
  return z.string()
    .min(8)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/)
    .parse(value);
}

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
        role: request.actor.role,
        mustChangePassword: request.actor.mustChangePassword
      }
    }));

    app.post('/password', { preHandler: app.authenticate }, async (request, reply) => {
      const input = changePasswordSchema.parse(request.body);
      await authService.changePassword(
        request.actor,
        input.currentPassword,
        input.newPassword,
        idempotencyKey(request.headers['idempotency-key'])
      );
      return reply.code(204).send();
    });
  };
}
