import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '../src/domain/actor.js';
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
});
