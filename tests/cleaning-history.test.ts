import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '../src/domain/actor.js';
import { SupabaseCleaningHistoryService } from '../src/modules/cleaning-history/cleaning-history.service.js';

const sessionId = '20400000-0000-4000-8000-000000000001';
const token = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ session_id: sessionId })).toString('base64url')}.x`;
const maid: Actor = {
  authUserId: '20400000-0000-4000-8000-000000000002',
  profileId: '20400000-0000-4000-8000-000000000003',
  displayName: '이력 메이드', role: 'maid', mustChangePassword: false, accessToken: token
};
const next = {
  fieldCompletedAt: '2026-09-18T23:59:59Z',
  attemptId: '20400000-0000-4000-8000-000000000004'
};

describe('cleaning history service', () => {
  it('binds the live session and creates a scope-bound cursor', async () => {
    const rpc = vi.fn(async () => ({ data: {
      date: '2026-09-19', fromDate: '2026-09-13', toDate: '2026-09-19', items: [], nextCursor: next
    }, error: null }));
    const service = new SupabaseCleaningHistoryService({ admin: { rpc } } as never);
    const first = await service.list(maid, { date: '2026-09-19', limit: 1 }) as { nextCursor: string };
    expect(rpc).toHaveBeenCalledWith('list_cleaning_history', expect.objectContaining({
      p_actor_profile_id: maid.profileId, p_session_id: sessionId, p_date: '2026-09-19', p_limit: 1
    }));
    await service.list(maid, { date: '2026-09-19', limit: 1, cursor: first.nextCursor });
    expect(rpc).toHaveBeenLastCalledWith('list_cleaning_history', expect.objectContaining({
      p_cursor_field_completed_at: next.fieldCompletedAt,
      p_cursor_attempt_id: next.attemptId
    }));
    await expect(service.list(maid, { date: '2026-09-18', cursor: first.nextCursor })).rejects.toMatchObject({
      code: 'INVALID_CLEANING_HISTORY_CURSOR'
    });
  });

  it('keeps other-maid scope denial stable and rejects developer access before RPC', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: 'CLEANING_HISTORY_MAID_SCOPE_REQUIRED' } }));
    const service = new SupabaseCleaningHistoryService({ admin: { rpc } } as never);
    await expect(service.list(maid, { date: '2026-09-19', maidProfileId: '20400000-0000-4000-8000-000000000099' }))
      .rejects.toMatchObject({ code: 'CLEANING_HISTORY_MAID_SCOPE_REQUIRED' });
    await expect(service.list({ ...maid, role: 'developer' }, { date: '2026-09-19' }))
      .rejects.toMatchObject({ code: 'CLEANING_HISTORY_ACCESS_REQUIRED' });
  });
});
