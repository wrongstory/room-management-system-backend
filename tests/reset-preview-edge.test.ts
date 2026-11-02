import { describe, expect, it, vi } from 'vitest';
import { resetRelationGroups } from '../src/modules/developer-reset/reset-preview-groups.js';
const modulePath = '../supabase/functions/_shared/developer-reset-api.ts';
const { developerResetPreview } = await import(modulePath);
const sessionId = '00000000-0000-4000-8000-000000000001';
const actor = { authUserId: sessionId, profileId: sessionId, displayName: 'synthetic', role: 'developer', mustChangePassword: false };
function request(path = '/v1/developer/reset/preview') {
  return new Request(`https://synthetic.invalid${path}`, { headers: { authorization: `Bearer verified.${Buffer.from(JSON.stringify({ session_id: sessionId })).toString('base64url')}.signature` } });
}
function clients() {
  return { admin: { rpc: vi.fn(() => ({ abortSignal: vi.fn(async (_signal: AbortSignal) => ({ data: { format: 'reset-preview-inventory-v1', readOnly: true,
    capturedAt: '2026-10-25T00:00:00Z', snapshotId: 'a'.repeat(64),
    relations: Object.values(resetRelationGroups).flat().map(relation => ({ relation, kind: 'r', partition: false, observedRows: 0, exact: true })) }, error: null })) })) } };
}
describe('Edge developer reset preview adapter', () => {
  it('shares the same safe result and verified session RPC binding', async () => {
    const client = clients();
    expect(await developerResetPreview(request(), client, actor)).toMatchObject({ diagnosticComplete: true, executionEnabled: false });
    expect(client.admin.rpc).toHaveBeenCalledExactlyOnceWith('get_developer_reset_preview', {
      p_actor_profile_id: sessionId, p_auth_user_id: sessionId, p_session_id: sessionId,
    });
  });
  it.each(['admin', 'maid'])('denies %s without collecting data', async role => {
    const client = clients(); await expect(developerResetPreview(request(), client, { ...actor, role })).rejects.toMatchObject({ status: 403 });
    expect(client.admin.rpc).not.toHaveBeenCalled();
  });
  it('rejects password/session/target overrides before RPC', async () => {
    const client = clients();
    await expect(developerResetPreview(request(), client, { ...actor, mustChangePassword: true })).rejects.toMatchObject({ status: 403 });
    await expect(developerResetPreview(request('/v1/developer/reset/preview?target=other'), client, actor)).rejects.toMatchObject({ status: 400 });
    await expect(developerResetPreview(new Request('https://synthetic.invalid/v1/developer/reset/preview', { headers: { authorization: 'Bearer invalid' } }), client, actor)).rejects.toMatchObject({ status: 401 });
    expect(client.admin.rpc).not.toHaveBeenCalled();
  });
  it('does not reflect database or transport errors', async () => {
    const client = clients(); client.admin.rpc.mockImplementation(() => { throw new Error('sensitive-db-detail'); });
    await expect(developerResetPreview(request(), client, actor)).rejects.toMatchObject({ status: 503, code: 'RESET_PREVIEW_UNAVAILABLE' });
  });
});
