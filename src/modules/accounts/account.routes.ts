import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AccountService } from './account.service.js';

const profileIdSchema = z.object({
  profileId: z.uuid()
});

const createAccountSchema = z.object({
  displayName: z.string().trim().min(2).max(40),
  role: z.enum(['admin', 'maid']),
  phone: z.string().trim().min(10).max(30)
});

const changeRoleSchema = z.object({ role: z.enum(['admin', 'maid']) });
const changeStatusSchema = z.object({
  status: z.enum(['active', 'inactive', 'departed']),
  reasonCode: z.string().trim().min(2).max(80).regex(/^[A-Z0-9_]+$/)
});

function idempotencyKey(request: FastifyRequest): string {
  return z.string()
    .min(8)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/)
    .parse(request.headers['idempotency-key']);
}

export function createAccountRoutes(accountService: AccountService): FastifyPluginAsync {
  return async (app) => {
    const adminPreHandler = [app.authenticate, app.requirePasswordChanged, app.requireAdmin];

    app.get('/', { preHandler: adminPreHandler }, async (request) => ({
      accounts: await accountService.list(request.actor)
    }));

    app.post('/', { preHandler: adminPreHandler }, async (request, reply) => {
      const input = createAccountSchema.parse(request.body);
      const result = await accountService.create(request.actor, {
        ...input,
        idempotencyKey: idempotencyKey(request)
      });
      return reply.code(201).send(result);
    });

    app.patch('/:profileId/role', { preHandler: adminPreHandler }, async (request) => {
      const { profileId } = profileIdSchema.parse(request.params);
      const { role } = changeRoleSchema.parse(request.body);
      return {
        account: await accountService.changeRole(request.actor, {
          targetProfileId: profileId,
          role,
          idempotencyKey: idempotencyKey(request)
        })
      };
    });

    app.patch('/:profileId/status', { preHandler: adminPreHandler }, async (request) => {
      const { profileId } = profileIdSchema.parse(request.params);
      const input = changeStatusSchema.parse(request.body);
      return {
        account: await accountService.changeStatus(request.actor, {
          targetProfileId: profileId,
          ...input,
          idempotencyKey: idempotencyKey(request)
        })
      };
    });

    app.post('/:profileId/unlock', { preHandler: adminPreHandler }, async (request) => {
      const { profileId } = profileIdSchema.parse(request.params);
      return {
        account: await accountService.unlock(request.actor, {
          targetProfileId: profileId,
          idempotencyKey: idempotencyKey(request)
        })
      };
    });

    app.post('/:profileId/password-reset', { preHandler: adminPreHandler }, async (request) => {
      const { profileId } = profileIdSchema.parse(request.params);
      return {
        account: await accountService.resetPassword(request.actor, {
          targetProfileId: profileId,
          idempotencyKey: idempotencyKey(request)
        })
      };
    });
  };
}
