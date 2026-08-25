import type { Actor } from '../domain/actor.js';

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor;
  }

  interface FastifyInstance {
    authenticate: (request: FastifyRequest) => Promise<void>;
  }
}

