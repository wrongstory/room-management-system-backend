import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { Actor } from '../src/domain/actor.js';
import { AppError } from '../src/lib/app-error.js';
import { createWorkHistoryRoutes } from '../src/modules/work-history/work-history.routes.js';
import { SupabaseWorkHistoryService } from '../src/modules/work-history/work-history.service.js';

const sessionId = '20600000-0000-4000-8000-000000000001';
const token = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ session_id: sessionId })).toString('base64url')}.x`;
const maid: Actor = {
  authUserId: '20600000-0000-4000-8000-000000000002',
  profileId: '20600000-0000-4000-8000-000000000003',
  displayName: '기록 메이드', role: 'maid', mustChangePassword: false, accessToken: token
};
const nextMaid = '20600000-0000-4000-8000-000000000004';
const summary = {
  maidCount: 2,
  availabilityMaidCount: 1,
  availabilityDayCount: 2,
  notifiedMaidCount: 1,
  notifiedDayCount: 1,
  fieldCompletedMaidCount: 1,
  fieldCompletedDayCount: 1
};

describe('work history service', () => {
  it('binds the live session and reuses a scope-bound cursor without changing summary', async () => {
    const rpc = vi.fn(async () => ({ data: {
      weekStart: '2026-09-14', weekEnd: '2026-09-20', timezone: 'Asia/Seoul',
      summary, items: [], nextCursor: { maidProfileId: nextMaid }
    }, error: null }));
    const service = new SupabaseWorkHistoryService({ admin: { rpc } } as never);
    const first = await service.list(maid, { weekStart: '2026-09-14', limit: 1 }) as {
      nextCursor: string; summary: typeof summary;
    };
    expect(first.summary).toEqual(summary);
    expect(rpc).toHaveBeenCalledWith('list_work_history', expect.objectContaining({
      p_actor_profile_id: maid.profileId,
      p_session_id: sessionId,
      p_week_start: '2026-09-14',
      p_limit: 1
    }));
    await service.list(maid, { weekStart: '2026-09-14', limit: 1, cursor: first.nextCursor });
    expect(rpc).toHaveBeenLastCalledWith('list_work_history', expect.objectContaining({
      p_cursor_maid_profile_id: nextMaid
    }));
    await expect(service.list(maid, { weekStart: '2026-09-21', cursor: first.nextCursor }))
      .rejects.toMatchObject({ code: 'INVALID_WORK_HISTORY_CURSOR' });
  });

  it('keeps cross-maid denial stable and rejects developer access before RPC', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: 'WORK_HISTORY_MAID_SCOPE_REQUIRED' } }));
    const service = new SupabaseWorkHistoryService({ admin: { rpc } } as never);
    await expect(service.list(maid, {
      weekStart: '2026-09-14', maidProfileId: '20600000-0000-4000-8000-000000000099'
    })).rejects.toMatchObject({ code: 'WORK_HISTORY_MAID_SCOPE_REQUIRED' });
    await expect(service.list({ ...maid, role: 'developer' }, { weekStart: '2026-09-14' }))
      .rejects.toMatchObject({ code: 'WORK_HISTORY_ACCESS_REQUIRED' });
  });

  it('keeps Fastify invalid query and cursor codes aligned with Edge before service calls', async () => {
    const list = vi.fn(async () => ({ items: [] }));
    const app = Fastify({ logger: false });
    app.decorateRequest('actor');
    app.decorate('authenticate', async (request: { actor: Actor }) => { request.actor = maid; });
    app.decorate('requirePasswordChanged', async () => undefined);
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof AppError) {
        void reply.status(error.statusCode).send({ code: error.code, message: error.message });
        return;
      }
      void reply.status(500).send({ code: 'INTERNAL_ERROR' });
    });
    await app.register(createWorkHistoryRoutes({ list }), { prefix: '/v1/work-history' });

    for (const url of [
      '/v1/work-history',
      '/v1/work-history?weekStart=2026-09-15',
      '/v1/work-history?weekStart=2026-09-14&limit=0',
      '/v1/work-history?weekStart=2026-09-14&unknown=1',
      '/v1/work-history?weekStart=2026-09-14&weekStart=2026-09-21'
    ]) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'INVALID_WORK_HISTORY_QUERY' });
    }
    for (const url of [
      '/v1/work-history?weekStart=2026-09-14&cursor=',
      `/v1/work-history?weekStart=2026-09-14&cursor=${'a'.repeat(1025)}`
    ]) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'INVALID_WORK_HISTORY_CURSOR' });
    }
    expect(list).not.toHaveBeenCalled();
    await app.close();
  });
});
