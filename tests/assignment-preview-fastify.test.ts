import Fastify from 'fastify';
import { ZodError } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '../src/domain/actor.js';
import { AppError } from '../src/lib/app-error.js';
import {
  createAssignmentDurationPolicyRoutes,
  createAssignmentPreviewRoutes
} from '../src/modules/assignments/assignment-preview.routes.js';
import {
  type AssignmentPreviewService,
  SupabaseAssignmentPreviewService
} from '../src/modules/assignments/assignment-preview.service.js';

const admin: Actor = {
  authUserId: '10000000-0000-4000-8000-000000000001',
  profileId: '20000000-0000-4000-8000-000000000001',
  displayName: '관리자',
  role: 'admin',
  mustChangePassword: false,
  accessToken: 'active-session-token'
};

function today(): string {
  return new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
}

async function appWith(service: AssignmentPreviewService, actor: Actor = admin) {
  const app = Fastify({ logger: false });
  app.decorateRequest('actor');
  app.decorate('authenticate', async (request) => {
    request.actor = actor;
  });
  app.decorate('requirePasswordChanged', async (request) => {
    if (request.actor.mustChangePassword) {
      throw new AppError(403, 'PASSWORD_CHANGE_REQUIRED', '비밀번호 변경이 필요합니다.');
    }
  });
  app.decorate('requireAdmin', async (request) => {
    if (request.actor.role !== 'admin') {
      throw new AppError(403, 'ADMIN_REQUIRED', '관리자만 접근할 수 있습니다.');
    }
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR' }, requestId: request.id });
    }
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message },
        requestId: request.id
      });
    }
    return reply.code(500).send({
      error: { code: 'INTERNAL_SERVER_ERROR', message: '서버 오류가 발생했습니다.' },
      requestId: request.id
    });
  });
  await app.register(createAssignmentPreviewRoutes(service), { prefix: '/v1/assignments' });
  await app.register(createAssignmentDurationPolicyRoutes(service), {
    prefix: '/v1/assignment-preview'
  });
  return app;
}

function clientsWithRpc(rpc: (name: string, args: unknown) => Promise<unknown>) {
  return {
    admin: { rpc },
    publicClient: {},
    forAccessToken: () => ({})
  } as never;
}

describe('assignment preview Fastify parity', () => {
  it('uses the shared retired-policy optimizer and camel-to-snake RPC arguments', async () => {
    const serviceDate = today();
    const rpc = vi.fn(async (name: string) => {
      expect(name).toBe('get_assignment_preview_snapshot');
      return {
        data: {
          serviceDate,
          planningAt: new Date().toISOString(),
          durationPolicy: null,
          durationPolicyStatus: 'retired',
          durationPolicyRequired: false,
          maids: [],
          targets: []
        },
        error: null
      };
    });
    const app = await appWith(new SupabaseAssignmentPreviewService(clientsWithRpc(rpc)));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/assignments/preview',
      payload: { serviceDate, previewSeed: 'fastify-seed' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      serviceDate,
      previewSeed: 'fastify-seed',
      decisionReady: true,
      durationPolicy: null,
      durationPolicyStatus: 'retired',
      durationPolicyRequired: false
    });
    expect(rpc).toHaveBeenCalledWith('get_assignment_preview_snapshot', {
      p_actor_profile_id: admin.profileId,
      p_service_date: serviceDate
    });
    await app.close();
  });

  it('keeps the historical GET envelope and blocks the retired POST with stable 410', async () => {
    const historical = {
      id: '30000000-0000-4000-8000-000000000001',
      version: 2,
      status: 'confirmed',
      standardMinutes: 55,
      premiumMinutes: 65,
      oceanPremiumMinutes: 70,
      oceanFamilyMinutes: 80,
      createdAt: '2026-09-01T00:00:00Z',
      confirmedAt: '2026-09-01T00:00:01Z'
    };
    const rpc = vi.fn(async () => ({ data: historical, error: null }));
    const app = await appWith(new SupabaseAssignmentPreviewService(clientsWithRpc(rpc)));

    const read = await app.inject({
      method: 'GET',
      url: '/v1/assignment-preview/duration-policy'
    });
    const retired = await app.inject({
      method: 'POST',
      url: '/v1/assignment-preview/duration-policy',
      payload: { expectedVersion: 2, standardMinutes: 1 }
    });

    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({ durationPolicy: historical });
    expect(rpc).toHaveBeenCalledWith('get_assignment_duration_policy', {
      p_actor_profile_id: admin.profileId
    });
    expect(retired.statusCode).toBe(410);
    expect(retired.json().error.code).toBe('ASSIGNMENT_DURATION_POLICY_RETIRED');
    expect(rpc).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('preserves auth, password and exact-admin gates before all three operations', async () => {
    const service: AssignmentPreviewService = {
      preview: vi.fn(),
      durationPolicy: vi.fn()
    };
    const changing = await appWith(service, { ...admin, mustChangePassword: true });
    const passwordBlocked = await changing.inject({
      method: 'POST',
      url: '/v1/assignments/preview',
      payload: { serviceDate: today() }
    });
    expect(passwordBlocked.statusCode).toBe(403);
    expect(passwordBlocked.json().error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    await changing.close();

    const maid = await appWith(service, { ...admin, role: 'maid' });
    for (const request of [
      { method: 'POST' as const, url: '/v1/assignments/preview', payload: { serviceDate: today() } },
      { method: 'GET' as const, url: '/v1/assignment-preview/duration-policy' },
      { method: 'POST' as const, url: '/v1/assignment-preview/duration-policy', payload: {} }
    ]) {
      const response = await maid.inject(request);
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('ADMIN_REQUIRED');
    }
    expect(service.preview).not.toHaveBeenCalled();
    expect(service.durationPolicy).not.toHaveBeenCalled();
    await maid.close();
  });

  it('rejects alias/extra input and redacts unknown database errors', async () => {
    const serviceDate = today();
    const rpc = vi.fn(async () => ({ data: null, error: { message: 'postgres secret detail' } }));
    const app = await appWith(new SupabaseAssignmentPreviewService(clientsWithRpc(rpc)));

    const alias = await app.inject({
      method: 'POST',
      url: '/v1/assignments/preview',
      payload: { service_date: serviceDate }
    });
    const extra = await app.inject({
      method: 'POST',
      url: '/v1/assignments/preview',
      payload: { serviceDate, durationMinutes: 55 }
    });
    const leaked = await app.inject({
      method: 'POST',
      url: '/v1/assignments/preview',
      payload: { serviceDate }
    });
    const query = await app.inject({
      method: 'GET',
      url: '/v1/assignment-preview/duration-policy?raw=true'
    });

    expect(alias.statusCode).toBe(400);
    expect(extra.statusCode).toBe(400);
    expect(leaked.statusCode).toBe(500);
    expect(leaked.json().error).toEqual({
      code: 'ASSIGNMENT_PREVIEW_FAILED',
      message: '배정 미리보기를 처리하지 못했습니다.'
    });
    expect(JSON.stringify(leaked.json())).not.toContain('postgres secret detail');
    expect(query.statusCode).toBe(400);
    await app.close();
  });
});
