import type { onRequestAsyncHookHandler } from 'fastify';
import { AppError } from '../../lib/app-error.js';

export const payrollWorkDetailsGuard: onRequestAsyncHookHandler = async (request, reply) => {
  const path = request.url.split('?')[0] ?? '';
  const family = path.split('/').map((part) => { try { return decodeURIComponent(part); } catch { return part; } })
    .join('/').replace(/\/+/g, '/').replace(/\/+$/, '');
  const canonical = '/v1/payroll/work-details';
  if (family !== canonical && !family.startsWith(`${canonical}/`)) return;
  reply.header('Cache-Control', 'no-store');
  if (request.method !== 'OPTIONS' && (request.method !== 'GET' || path !== canonical)) {
    throw new AppError(404, 'ROUTE_NOT_FOUND', '요청한 API 경로를 찾을 수 없습니다.');
  }
};
