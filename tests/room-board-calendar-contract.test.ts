import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import type { Actor } from '../src/domain/actor.js';
import { createRoomRoutes } from '../src/modules/rooms/room.routes.js';
import type { RoomService } from '../src/modules/rooms/room.service.js';

const edgeApi = await import(new URL('../supabase/functions/_shared/room-api.ts', import.meta.url).href) as {
  roomListServiceDate(request: Request): string | null;
};

async function readFastify(value: string) {
  const app = Fastify();
  const list = vi.fn(async () => []);
  const authenticate = async () => {};
  app.decorate('authenticate', authenticate);
  app.decorate('requirePasswordChanged', authenticate);
  app.decorate('requireAdmin', authenticate);
  app.addHook('preHandler', async (request) => {
    request.actor = { role: 'admin' } as Actor;
  });
  app.setErrorHandler((error, _request, reply) => {
    reply.code(error instanceof ZodError ? 400 : 500).send({});
  });
  await app.register(createRoomRoutes({ list } as unknown as RoomService), { prefix: '/v1/rooms' });
  try {
    const response = await app.inject(`/v1/rooms?serviceDate=${encodeURIComponent(value)}`);
    return { statusCode: response.statusCode, calls: list.mock.calls };
  } finally {
    await app.close();
  }
}

describe('room board calendar parity at the HTTP and Edge parser boundaries', () => {
  it.each(['0001-01-01', '0099-12-31', '0096-02-29', '0100-01-01', '2000-02-29', '2026-09-22', '9999-12-31'])(
    'passes %s unchanged without the Date.UTC 1900 adjustment', async (value) => {
      const actual = await readFastify(value);
      expect(actual.statusCode).toBe(200);
      expect(actual.calls).toEqual([[expect.objectContaining({ role: 'admin' }), { serviceDate: value }]]);
      expect(edgeApi.roomListServiceDate(new Request(`https://example.invalid/v1/rooms?serviceDate=${value}`))).toBe(value);
    }
  );

  it.each(['0000-01-01', '0099-02-29', '0100-02-29', '1900-02-29', '2026-02-29', '2026-02-30', '2026-9-22', '2026-00-01', '2026-01-00'])(
    'rejects unsupported or impossible date %s before any service call', async (value) => {
      const actual = await readFastify(value);
      expect(actual.statusCode).toBe(400);
      expect(actual.calls).toHaveLength(0);
      expect(() => edgeApi.roomListServiceDate(new Request(`https://example.invalid/v1/rooms?serviceDate=${value}`)))
        .toThrow(expect.objectContaining({ status: 400 }));
    }
  );
});
