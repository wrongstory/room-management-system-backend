import type { Actor } from '../domain/actor.js';

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor;
  }

  interface FastifyInstance {
    authenticate: (request: FastifyRequest) => Promise<void>;
    requirePasswordChanged: (request: FastifyRequest) => Promise<void>;
    requireAdmin: (request: FastifyRequest) => Promise<void>;
  }
}
