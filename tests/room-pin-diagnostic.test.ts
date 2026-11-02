import { describe, expect, it } from 'vitest';
import { roomPinFailureDiagnostic, roomPinOperation } from '../src/lib/room-pin-diagnostic.js';
import { safeRequestLog } from '../src/config/logger.js';
import type { FastifyRequest } from 'fastify';
import Fastify from 'fastify';
import { Writable } from 'node:stream';

const id = '10000000-0000-4000-8000-000000000001';
describe('#317 closed PIN diagnostics', () => {
  it('keeps automatic Fastify request logs free of PIN URL, headers and room identity', async () => {
    const records: string[] = [];
    const stream = new Writable({ write(chunk, _encoding, callback) { records.push(String(chunk)); callback(); } });
    const app = Fastify({ logger: { level: 'info', stream, serializers: { req: safeRequestLog } } });
    app.post('/v1/rooms/:roomId/pin/reveal', async () => ({ ok: true }));
    try {
      await app.inject({ method: 'POST', url: `/v1/rooms/${id}/pin/reveal?pin=synthetic-secret-query`, headers: { authorization: 'Bearer synthetic-secret-auth', cookie: 'synthetic-secret-cookie' } });
      const serialized = records.join('');
      expect(serialized).toContain('"operation":"reveal"');
      expect(serialized).not.toContain(id);
      expect(serialized).not.toContain('synthetic-secret');
    } finally { await app.close(); }
  });
  it('never serializes unknown code objects or exception details', () => {
    const hostile = { toJSON() { throw new Error('must not serialize'); }, toString() { throw new Error('must not coerce'); } };
    for (const code of [hostile, 'secret\nforged-record', undefined, 123]) {
      expect(roomPinFailureDiagnostic('reveal', id, 503, code)).toEqual({ operation: 'reveal', requestId: id, status: 503, code: 'INTERNAL_SERVER_ERROR' });
    }
  });
  it('rejects non-5xx, untrusted IDs and operations', () => {
    for (const status of [200, 400, 401, 403, 409, 429, 499, 600, NaN, 500.5]) expect(roomPinFailureDiagnostic('reveal', id, status, 'ROOM_COMMAND_FAILED')).toBeNull();
    for (const value of ['client-id', `${id}\n`, '', 'secret']) expect(roomPinFailureDiagnostic('reveal', value, 500, '')).toBeNull();
    expect(roomPinFailureDiagnostic('secret', id, 500, '')).toBeNull();
    expect(roomPinFailureDiagnostic(null, id, 500, '')).toBeNull();
  });
  it('classifies only exact POST routes and omits URL, query and identity from automatic logs', () => {
    const url = `/v1/rooms/${id}/pin/reveal?pin=synthetic-secret`;
    expect(roomPinOperation('POST', url)).toBe('reveal');
    expect(roomPinOperation('GET', url)).toBeNull();
    expect(roomPinOperation('POST', '/v1/rooms/pins/import')).toBeNull();
    expect(roomPinOperation('POST', `${url.split('?')[0]}/extra`)).toBeNull();
    expect(safeRequestLog({ method: 'POST', url } as FastifyRequest)).toEqual({ operation: 'reveal' });
  });
});
