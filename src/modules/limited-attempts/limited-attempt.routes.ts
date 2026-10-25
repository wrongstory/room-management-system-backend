import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/app-error.js';
import type { PhotoHttpServices } from '../photos/photo.routes.js';
import { webRequest } from '../photos/photo.routes.js';
import { photoError, type PhotoIdentity } from '../photos/photo-service.js';
import type { LimitedAttemptService } from './limited-attempt.service.js';

export async function limitedAttemptPathGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const rawPath = (request.raw.url ?? '/').split('?')[0] ?? '/';
  let decoded: string;
  try { decoded = rawPath.split('/').map(decodeURIComponent).filter(Boolean).join('/'); }
  catch { decoded = rawPath.replace(/^\/+/, ''); }
  if (decoded !== 'v1/limited/attempts' && !decoded.startsWith('v1/limited/attempts/')) return;
  reply.header('cache-control', 'no-store');
  const allowedMethod = rawPath.endsWith('/complete-field-work') ? request.method === 'POST' : request.method === 'GET';
  if (`/${decoded}` !== rawPath || !/^\/v1\/limited\/attempts(?:\/[0-9a-f-]+(?:\/complete-field-work)?)?$/i.test(rawPath)
    || (request.method !== 'OPTIONS' && !allowedMethod)) {
    throw new AppError(404, 'ROUTE_NOT_FOUND', '요청한 API 경로를 찾을 수 없습니다.');
  }
}

export function createLimitedAttemptRoutes(service: LimitedAttemptService, authenticate: PhotoHttpServices['authenticate']): FastifyPluginAsync {
  return async (app) => {
    const identities = new WeakMap<FastifyRequest, PhotoIdentity>();
    app.addHook('onRequest', async (request, reply) => {
      reply.header('cache-control', 'no-store');
      await limitedAttemptPathGuard(request, reply);
      const rawPath = new URL(request.raw.url ?? '/', 'http://backend.internal').pathname;
      if (!/^\/v1\/limited\/attempts(?:\/[0-9a-f-]+(?:\/complete-field-work)?)?$/i.test(rawPath)) throw new AppError(404, 'ROUTE_NOT_FOUND', '요청한 API 경로를 찾을 수 없습니다.');
      try {
        const identity = await authenticate(webRequest(request), false);
        if (identity.role !== 'maid' || !['active', 'deactivation_pending', 'upload_only'].includes(identity.profileStatus)) throw new AppError(403, 'CAPABILITY_ACCESS_REQUIRED', '허용된 제한 수행 권한이 필요합니다.');
        identities.set(request, identity);
      } catch (error) {
        if (error instanceof AppError) throw error;
        const safe = photoError(error);
        throw new AppError(safe.statusCode, safe.code, '허용된 제한 수행 권한이 필요합니다.');
      }
    });
    const identity = (request: FastifyRequest) => {
      const result = identities.get(request);
      if (!result) throw new AppError(401, 'INVALID_ACCESS_TOKEN', '로그인이 필요합니다.');
      return result;
    };
    const uuid = z.uuid().transform((value) => value.toLowerCase());
    const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
    const attemptId = (request: FastifyRequest) => z.object({ attemptId: uuid }).strict().parse(request.params).attemptId;
    const noQuery = (request: FastifyRequest) => {
      if (new URL(request.raw.url ?? '/', 'http://backend.internal').search) throw new AppError(400, 'VALIDATION_ERROR', '허용되지 않은 query입니다.');
    };
    app.get('/v1/limited/attempts', async (request) => { noQuery(request); return service.list(identity(request)); });
    app.get('/v1/limited/attempts/:attemptId', async (request) => {
      const query = new URL(request.raw.url ?? '/', 'http://backend.internal').searchParams;
      if (query.size !== 1 || query.getAll('assignmentRevision').length !== 1 || !/^[1-9]\d*$/.test(query.get('assignmentRevision') ?? '')) throw new AppError(400, 'VALIDATION_ERROR', '허용된 배정 revision을 확인해 주세요.');
      return service.get(identity(request), attemptId(request), version.parse(Number(query.get('assignmentRevision'))));
    });
    app.post('/v1/limited/attempts/:attemptId/complete-field-work', async (request) => {
      noQuery(request);
      const body = z.object({ expectedExecutionVersion: version, expectedAssignmentId: uuid, expectedAssignmentRevision: version }).strict().parse(request.body);
      const key = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/).parse(request.headers['idempotency-key']);
      return service.complete(identity(request), { attemptId: attemptId(request), ...body }, key);
    });
  };
}
