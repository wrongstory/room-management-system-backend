import type { onRequestAsyncHookHandler } from 'fastify';
import { AppError } from '../../lib/app-error.js';

export const payrollRemittanceGuard: onRequestAsyncHookHandler = async (request, reply) => {
  const path = request.url.split('?')[0] ?? '';
  const family = path.split('/').map((segment) => { try { return decodeURIComponent(segment); } catch { return segment; } })
    .join('/').replace(/\/+/g, '/').replace(/\/+$/, '');
  const marker = '/v1/payroll/remittance-marker';
  const batch = `${marker}s`;
  if (![marker, batch].some((prefix) => family === prefix || family.startsWith(`${prefix}/`))) return;
  reply.header('Cache-Control', 'no-store');
  const allowed = (path === batch && request.method === 'GET')
    || (path === marker && ['GET', 'PUT'].includes(request.method))
    || (path === `${marker}/reconfirm` && request.method === 'POST')
    || (path === `${marker}/history` && request.method === 'GET');
  if (request.method !== 'OPTIONS' && !allowed) throw new AppError(404, 'ROUTE_NOT_FOUND', '요청한 API 경로를 찾을 수 없습니다.');
};
