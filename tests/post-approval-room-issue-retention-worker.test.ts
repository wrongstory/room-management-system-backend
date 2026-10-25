import { describe, expect, it } from 'vitest';
import { PostApprovalRoomIssueRetentionWorker } from '../src/modules/post-approval-room-issues/post-approval-room-issue-retention.worker.js';

const id = (n: number) => `b3369000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture({ failProvider = false, failSettle = false, mismatch = false, purged = false, claim = { items: [{ objectId: id(1), leaseVersion: 1 }], blocked: 0 } } = {}) {
  const calls: { name: string; args: Record<string, unknown> }[] = [], files: string[] = [];
  let reads = 0;
  const worker = new PostApprovalRoomIssueRetentionWorker({ rpc: async (name, args) => {
    calls.push({ name, args });
    if (name === 'claim_post_approval_room_issue_purges') return { data: claim, error: null };
    if (name === 'get_post_approval_room_issue_purge_context') return { data: { objectId: id(1), deleteToken: id(mismatch && reads++ > 0 ? 3 : 2), fileId: purged ? null : 'synthetic_owned_file_336' }, error: null };
    return failSettle ? { data: null, error: { message: 'raw provider locator secret' } }
      : { data: { status: args.p_outcome === 'retryable' ? 'retryable' : 'purged' }, error: null };
  } }, () => ({ remove: async file => { files.push(file); if (failProvider) throw new Error('raw locator/token'); return 'not_found'; } }));
  return { worker, calls, files };
}
describe('#336 isolated typed retention worker (synthetic; no DB/provider/Cron)', () => {
  it('commits barrier and rechecks fence before exact identity DELETE; 404 is settled idempotently', async () => {
    const f = fixture(); expect(await f.worker.run(1)).toEqual({ claimed: 1, purged: 1, retrying: 0, blocked: 0 });
    expect(f.calls.map(call => call.name)).toEqual(['claim_post_approval_room_issue_purges', 'get_post_approval_room_issue_purge_context', 'get_post_approval_room_issue_purge_context', 'settle_post_approval_room_issue_purge']);
    expect(f.files).toEqual(['synthetic_owned_file_336']); expect(f.calls[3]?.args.p_outcome).toBe('not_found');
    expect(f.calls[0]?.args.p_claim_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(f.calls.every(call => !('p_actor_profile_id' in call.args) && !('p_session_id' in call.args))).toBe(true);
  });
  it('never deletes a mismatched durable token or reports false success', async () => { const f = fixture({ mismatch: true });
    expect((await f.worker.run()).retrying).toBe(1); expect(f.files).toEqual([]);
  });
  it('unknown provider response retains barrier and records retryable, not purged', async () => { const f = fixture({ failProvider: true });
    expect(await f.worker.run()).toEqual({ claimed: 1, purged: 0, retrying: 1, blocked: 0 }); expect(f.calls[3]?.args.p_outcome).toBe('retryable');
  });
  it('lost settle response is not promoted to success and leaks no raw fields', async () => { const f = fixture({ failSettle: true });
    const result = await f.worker.run(); expect(result.purged).toBe(0); expect(result.retrying).toBe(1); expect(JSON.stringify(result)).not.toContain('synthetic_owned_file');
  });
  it('already settled exact identity needs no second network delete', async () => { const f = fixture({ purged: true });
    expect((await f.worker.run()).purged).toBe(1); expect(f.files).toEqual([]);
  });
  for (const limit of [0, 11, Number.NaN, 1.5, Number.MAX_SAFE_INTEGER]) it(`rejects unbounded batch ${limit}`, async () => {
    const f = fixture(); await expect(f.worker.run(limit)).rejects.toMatchObject({ statusCode: 400 }); expect(f.calls).toEqual([]);
  });
  it('empty claim cannot invoke provider or upload/finalization RPC', async () => { const f = fixture({ claim: { items: [], blocked: 1 } });
    expect(await f.worker.run()).toEqual({ claimed: 0, purged: 0, retrying: 0, blocked: 1 }); expect(f.files).toEqual([]); expect(f.calls).toHaveLength(1);
  });
  it('fresh worker invocations use independent non-reusable random fences', async () => { const f = fixture({ claim: { items: [], blocked: 0 } });
    await f.worker.run(); await f.worker.run(); expect(f.calls[0]?.args.p_claim_digest).not.toBe(f.calls[1]?.args.p_claim_digest);
  });
});
