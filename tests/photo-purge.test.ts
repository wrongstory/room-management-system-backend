import { afterEach, describe, expect, it, vi } from 'vitest';
import { handlePhotoPurge, PHOTO_PURGE_RUN_BUDGET_MS, PhotoPurgeProviderError, PhotoPurgeWorker, type PurgeProvider, type PurgeRpc } from '../src/modules/photos/photo-purge.js';

const objectId = '00000000-0000-4000-8000-000000000001';
const providerId = 'synthetic_private_file';
function setup(options: { remove?: () => Promise<'deleted' | 'not_found'>; exists?: () => Promise<boolean>; contextError?: boolean; settleError?: boolean; budget?: boolean } = {}) {
  const calls: string[] = [], args: Record<string, unknown>[] = [];
  const db: PurgeRpc = { rpc: async (name, value) => {
    calls.push(name); args.push(value);
    if (name === 'claim_due_photo_purges') return { data: { items: [{ objectId, leaseVersion: 1, purgeAfter: '2026-09-09T00:00:00.000001Z' }], blocked: 0 }, error: null };
    if (name === 'claim_due_photo_orphan_purges' || name === 'claim_due_photo_folder_purges') return { data: { items: [], blocked: 0 }, error: null };
    if (name === 'record_photo_purge_heartbeat') return { data: { status: 'succeeded' }, error: null };
    if (name === 'get_photo_purge_context') return { data: { objectId, providerFileId: providerId }, error: options.contextError ? { message: 'raw DB locator secret' } : null };
    return { data: { status: value.p_outcome === 'retryable' ? 'retry' : 'purged', providerFileId: 'never reflect raw' }, error: options.settleError ? new Error('secret') : null };
  } };
  const provider: PurgeProvider = {
    purgeRemove: async id => { expect(id).toBe(providerId); calls.push('delete'); return options.remove ? options.remove() : 'deleted'; },
    purgeExists: async id => { expect(id).toBe(providerId); calls.push('exists'); return options.exists ? options.exists() : false; },
    purgeEmptyFolder: async () => 'empty',
  };
  let clocks = 0;
  return { calls, args, worker: new PhotoPurgeWorker(db, provider, () => options.budget && clocks++ >= 2 ? 32900 : 0) };
}
describe('photo retention worker (no real Google calls)', () => {
  afterEach(() => { vi.useRealTimers(); });
  it('claims at most ten items across accepted, orphan and folder phases', async () => {
    const limits: number[] = [], calls: string[] = [];
    const ids = Array.from({ length: 10 }, (_, index) => `00000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`);
    const db: PurgeRpc = { rpc: async (name, args) => {
      calls.push(name);
      if (name.startsWith('claim_due_')) limits.push(args.p_limit as number);
      if (name === 'claim_due_photo_purges') return { data: { items: ids.slice(0, 8).map(objectId => ({ objectId, leaseVersion: 1 })), blocked: 0 }, error: null };
      if (name === 'claim_due_photo_orphan_purges') return { data: { items: ids.slice(8).map((objectId, i) => ({ objectId, operationId: ids[i], leaseVersion: 1 })), blocked: 0 }, error: null };
      if (name === 'get_photo_purge_context') return { data: { objectId: args.p_object_id, providerFileId: providerId }, error: null };
      if (name === 'get_photo_orphan_purge_context') return { data: { objectId: ids[ids.indexOf(String(args.p_operation_id)) + 8], providerFileId: providerId }, error: null };
      if (name.startsWith('settle_photo_')) return { data: { status: 'purged' }, error: null };
      return { data: {}, error: null };
    } };
    const provider: PurgeProvider = { purgeRemove: async () => 'deleted', purgeExists: async () => false, purgeEmptyFolder: async () => 'empty' };
    const result = await new PhotoPurgeWorker(db, provider).run();
    expect(result).toMatchObject({ claimed: 10, acceptedClaimed: 8, orphanClaimed: 2, folderClaimed: 0 });
    expect(limits).toEqual([10, 2]);
    expect(calls).not.toContain('claim_due_photo_folder_purges');
  });
  it('verifies an empty folder before deleting and settles non-empty as a safe retry', async () => {
    const folderId = '00000000-0000-4000-8000-000000000099', settled: Record<string, unknown>[] = [];
    const db: PurgeRpc = { rpc: async (name, args) => {
      if (name === 'claim_due_photo_purges' || name === 'claim_due_photo_orphan_purges') return { data: { items: [], blocked: 0 }, error: null };
      if (name === 'claim_due_photo_folder_purges') return { data: { items: [{ folderRegistryId: folderId, leaseVersion: 1 }], blocked: 0 }, error: null };
      if (name === 'get_photo_folder_purge_context') return { data: { providerFolderId: 'synthetic_room_folder', parentFolderId: 'synthetic_date_folder' }, error: null };
      if (name === 'settle_photo_folder_purge') { settled.push(args); return { data: { status: 'retry' }, error: null }; }
      return { data: {}, error: null };
    } };
    const provider: PurgeProvider = { purgeRemove: async () => { throw new Error('must not delete'); }, purgeExists: async () => false, purgeEmptyFolder: async () => 'not_empty' };
    expect(await new PhotoPurgeWorker(db, provider).run()).toMatchObject({ folderClaimed: 1, retryable: 1, deleted: 0 });
    expect(settled[0]).toMatchObject({ p_outcome: 'not_empty', p_reason_code: null });
  });
  it('DB µs due authorization precedes delete and fenced callback; no caller clocks', async () => {
    const s = setup(); expect(await s.worker.run()).toEqual({ claimed: 1, deleted: 1, notFound: 0, retryable: 0, deferred: 0, blocked: 0, acceptedClaimed: 1, orphanClaimed: 0, folderClaimed: 0 });
    expect(s.calls).toEqual(['claim_due_photo_purges', 'get_photo_purge_context', 'delete', 'settle_photo_purge', 'claim_due_photo_orphan_purges', 'claim_due_photo_folder_purges', 'record_photo_purge_heartbeat']);
    expect(s.args[0]?.p_claim_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(s.args[2]).toMatchObject({ p_object_id: objectId, p_lease_version: 1, p_outcome: 'deleted', p_reason_code: null });
    expect(JSON.stringify(s.args)).not.toContain('purgeAfter');
  });
  it('expired/stolen DB fence never reaches provider', async () => {
    const s = setup({ contextError: true }); await expect(s.worker.run()).rejects.toMatchObject({ code: 'PHOTO_PURGE_FAILED' }); expect(s.calls).not.toContain('delete');
  });
  it('404 is logical success and callback loss is not reported as success', async () => {
    expect(await setup({ remove: async () => 'not_found' }).worker.run()).toMatchObject({ notFound: 1 });
    await expect(setup({ settleError: true }).worker.run()).rejects.toMatchObject({ code: 'PHOTO_PURGE_FAILED' });
    // A new fenced run observes absence, without reaccepting or inventing a new object.
    expect(await setup({ remove: async () => 'not_found' }).worker.run()).toMatchObject({ notFound: 1, deleted: 0 });
  });
  it.each(['RATE_LIMITED', 'PROVIDER_ERROR', 'NETWORK_ERROR'] as const)('transient %s is durable retry, not sleep or raw provider error', async reason => {
    const s = setup({ remove: async () => { throw new PhotoPurgeProviderError(reason); }, exists: async () => true });
    expect(await s.worker.run()).toMatchObject({ retryable: 1, deleted: 0 }); expect(s.args[2]).toMatchObject({ p_outcome: 'retryable', p_reason_code: reason });
  });
  it('uncertain DELETE resolves only an exact-ID 404, never assumes absence on timeout', async () => {
    const remove = async (): Promise<never> => { throw new Error('secret raw URL'); };
    expect(await setup({ remove }).worker.run()).toMatchObject({ notFound: 1 });
    expect(await setup({ remove, exists: async () => { throw new Error('token'); } }).worker.run()).toMatchObject({ retryable: 1, notFound: 0 });
  });
  it('bounded worker defers before external work when wall budget is exhausted', async () => {
    const s = setup({ budget: true }); expect(await s.worker.run()).toMatchObject({ deferred: 1 }); expect(s.calls).not.toContain('delete');
  });
  it('propagates bounded blocked transitions and never reports a succeeded heartbeat', async () => {
    let heartbeat: Record<string, unknown> | undefined;
    const db: PurgeRpc = { rpc: async (name, args) => {
      if (name === 'claim_due_photo_purges') return { data: { items: [], blocked: 1 }, error: null };
      if (name === 'claim_due_photo_orphan_purges' || name === 'claim_due_photo_folder_purges') return { data: { items: [], blocked: 0 }, error: null };
      if (name === 'record_photo_purge_heartbeat') heartbeat = args;
      return { data: {}, error: null };
    } };
    const provider: PurgeProvider = { purgeRemove: async () => 'deleted', purgeExists: async () => false, purgeEmptyFolder: async () => 'empty' };
    expect(await new PhotoPurgeWorker(db, provider).run()).toMatchObject({ blocked: 1, claimed: 0 });
    expect(heartbeat).toMatchObject({ p_status: 'degraded', p_blocked: 1 });
  });
  it('terminates a hung provider before the 45-second run deadline and settles the lease retryably', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-09T00:00:00Z'));
    const calls: string[] = [], settled: Record<string, unknown>[] = [];
    let providerStartedResolve!: () => void; const providerStarted = new Promise<void>(resolve => { providerStartedResolve = resolve; });
    const db: PurgeRpc = { rpc: async (name, args) => {
      calls.push(name);
      if (name === 'claim_due_photo_purges') return { data: { items: [{ objectId, leaseVersion: 1 }], blocked: 0 }, error: null };
      if (name === 'get_photo_purge_context') return { data: { objectId, providerFileId: providerId }, error: null };
      if (name === 'settle_photo_purge') { settled.push(args); return { data: { status: 'retry' }, error: null }; }
      if (name === 'claim_due_photo_orphan_purges' || name === 'claim_due_photo_folder_purges') return { data: { items: [], blocked: 0 }, error: null };
      return { data: {}, error: null };
    } };
    const provider: PurgeProvider = {
      purgeRemove: async (_id, deadlineAt) => {
        expect(deadlineAt).toBeLessThan(Date.now() + PHOTO_PURGE_RUN_BUDGET_MS);
        providerStartedResolve();
        return new Promise<'deleted'>(() => {});
      },
      purgeExists: async () => true,
      purgeEmptyFolder: async () => 'empty',
    };
    const run = new PhotoPurgeWorker(db, provider).run();
    await providerStarted;
    await vi.advanceTimersByTimeAsync(PHOTO_PURGE_RUN_BUDGET_MS - 1);
    await expect(run).resolves.toMatchObject({ retryable: 1, deferred: 2 });
    expect(settled[0]).toMatchObject({ p_outcome: 'retryable', p_reason_code: 'NETWORK_ERROR' });
    expect(calls).toContain('record_photo_purge_heartbeat');
  });
  it('bounds a hung DB RPC by the shared run deadline and still records a failed heartbeat', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-09T00:00:00Z'));
    const startedAt = Date.now(), calls: string[] = []; let aborted = false;
    let claimStartedResolve!: () => void;
    const claimStarted = new Promise<void>(resolve => { claimStartedResolve = resolve; });
    const db: PurgeRpc = { rpc: name => {
      calls.push(name);
      if (name === 'claim_due_photo_purges') {
        claimStartedResolve();
        let abortRequest!: () => void;
        const pending = new Promise<{ data: unknown; error: unknown }>((_resolve, reject) => {
          abortRequest = () => reject(new DOMException('aborted', 'AbortError'));
        }) as Promise<{ data: unknown; error: unknown }> & { abortSignal(signal: AbortSignal): PromiseLike<{ data: unknown; error: unknown }> };
        pending.abortSignal = signal => {
          signal.addEventListener('abort', () => { aborted = true; abortRequest(); }, { once: true });
          return pending;
        };
        return pending;
      }
      return Promise.resolve({ data: {}, error: null });
    } };
    const provider: PurgeProvider = {
      purgeRemove: async () => 'deleted',
      purgeExists: async () => false,
      purgeEmptyFolder: async () => 'empty',
    };
    const run = new PhotoPurgeWorker(db, provider).run();
    const rejected = expect(run).rejects.toMatchObject({ code: 'PHOTO_PURGE_FAILED' });
    await claimStarted;
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(Date.now() - startedAt).toBeLessThan(PHOTO_PURGE_RUN_BUDGET_MS);
    expect(aborted).toBe(true);
    expect(calls).toEqual(['claim_due_photo_purges', 'record_photo_purge_heartbeat']);
  });
  it('does not start folder DELETE when metadata/list inspection consumes the provider budget', async () => {
    let now = 0; let deletes = 0; const settled: Record<string, unknown>[] = [];
    const folderId = '00000000-0000-4000-8000-000000000099';
    const db: PurgeRpc = { rpc: async (name, args) => {
      if (name === 'claim_due_photo_purges' || name === 'claim_due_photo_orphan_purges') return { data: { items: [], blocked: 0 }, error: null };
      if (name === 'claim_due_photo_folder_purges') return { data: { items: [{ folderRegistryId: folderId, leaseVersion: 1 }], blocked: 0 }, error: null };
      if (name === 'get_photo_folder_purge_context') return { data: { providerFolderId: 'synthetic_room_folder', parentFolderId: 'synthetic_date_folder' }, error: null };
      if (name === 'settle_photo_folder_purge') settled.push(args);
      return { data: {}, error: null };
    } };
    const provider: PurgeProvider = {
      purgeRemove: async () => { deletes++; return 'deleted'; }, purgeExists: async () => false,
      purgeEmptyFolder: async (_folder, _parent, deadlineAt) => { now = deadlineAt - 100; return 'empty'; },
    };
    expect(await new PhotoPurgeWorker(db, provider, () => now).run()).toMatchObject({ deferred: 1, deleted: 0 });
    expect(deletes).toBe(0); expect(settled).toHaveLength(0);
  });
  it('keeps the worst folder inspect-delete-settle-heartbeat path inside the absolute deadline', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-09T00:00:00Z'));
    const startedAt = Date.now(), calls: string[] = [];
    let inspectionStartedResolve!: () => void; const inspectionStarted = new Promise<void>(resolve => { inspectionStartedResolve = resolve; });
    const folderId = '00000000-0000-4000-8000-000000000099';
    const delay = <T>(milliseconds: number, value: T) => new Promise<T>(resolve => setTimeout(() => resolve(value), milliseconds));
    const db: PurgeRpc = { rpc: async (name) => {
      calls.push(name);
      if (name === 'claim_due_photo_purges' || name === 'claim_due_photo_orphan_purges') return { data: { items: [], blocked: 0 }, error: null };
      if (name === 'claim_due_photo_folder_purges') return { data: { items: [{ folderRegistryId: folderId, leaseVersion: 1 }], blocked: 0 }, error: null };
      if (name === 'get_photo_folder_purge_context') return { data: { providerFolderId: 'synthetic_room_folder', parentFolderId: 'synthetic_date_folder' }, error: null };
      if (name === 'settle_photo_folder_purge') return delay(4000, { data: { status: 'purged' }, error: null });
      if (name === 'record_photo_purge_heartbeat') return delay(4000, { data: {}, error: null });
      return { data: {}, error: null };
    } };
    const provider: PurgeProvider = {
      purgeEmptyFolder: async (_folder, _parent, deadlineAt) => { expect(deadlineAt - startedAt).toBe(33000); inspectionStartedResolve(); return delay(14000, 'empty'); },
      purgeRemove: async (_file, deadlineAt) => { expect(deadlineAt - startedAt).toBe(33000); return delay(14000, 'deleted'); },
      purgeExists: async () => false,
    };
    const run = new PhotoPurgeWorker(db, provider).run();
    await inspectionStarted;
    await vi.advanceTimersByTimeAsync(PHOTO_PURGE_RUN_BUDGET_MS - 1);
    await expect(run).resolves.toMatchObject({ deleted: 1, retryable: 0 });
    expect(Date.now() - startedAt).toBeLessThan(PHOTO_PURGE_RUN_BUDGET_MS);
    expect(calls).toContain('settle_photo_folder_purge'); expect(calls).toContain('record_photo_purge_heartbeat');
  });
  it.each(['accepted', 'orphan', 'folder'] as const)('counts %s blocked when the eighth provider failure is settled', async kind => {
    let heartbeat: Record<string, unknown> | undefined;
    const folderId = '00000000-0000-4000-8000-000000000099';
    const operationId = '00000000-0000-4000-8000-000000000098';
    const db: PurgeRpc = { rpc: async (name, args) => {
      if (name === 'claim_due_photo_purges') return { data: { items: kind === 'accepted' ? [{ objectId, leaseVersion: 8 }] : [], blocked: 0 }, error: null };
      if (name === 'claim_due_photo_orphan_purges') return { data: { items: kind === 'orphan' ? [{ objectId, operationId, leaseVersion: 8 }] : [], blocked: 0 }, error: null };
      if (name === 'claim_due_photo_folder_purges') return { data: { items: kind === 'folder' ? [{ folderRegistryId: folderId, leaseVersion: 8 }] : [], blocked: 0 }, error: null };
      if (name === 'get_photo_purge_context' || name === 'get_photo_orphan_purge_context') return { data: { objectId, providerFileId: providerId }, error: null };
      if (name === 'get_photo_folder_purge_context') return { data: { providerFolderId: 'synthetic_room_folder', parentFolderId: 'synthetic_date_folder' }, error: null };
      if (name.startsWith('settle_photo_')) return { data: { status: 'blocked' }, error: null };
      if (name === 'record_photo_purge_heartbeat') heartbeat = args;
      return { data: {}, error: null };
    } };
    const provider: PurgeProvider = {
      purgeRemove: async () => { throw new PhotoPurgeProviderError('PROVIDER_ERROR'); },
      purgeExists: async () => true,
      purgeEmptyFolder: async () => kind === 'folder' ? 'not_empty' : 'empty',
    };
    expect(await new PhotoPurgeWorker(db, provider).run()).toMatchObject({ blocked: 1, retryable: 0 });
    expect(heartbeat).toMatchObject({ p_status: 'degraded', p_blocked: 1, p_retrying: 0 });
  });
});
describe('server-only exact purge route', () => {
  const secret = 'synthetic-secret-with-at-least-32-characters';
  const run = async () => ({ claimed: 0, deleted: 0, notFound: 0, retryable: 0, deferred: 0, blocked: 0, acceptedClaimed: 0, orphanClaimed: 0, folderClaimed: 0, providerId: 'must_not_reflect' });
  it('authenticates only dedicated secret and redacts extra worker result keys', async () => {
    const response = await handlePhotoPurge(new Request('https://local.invalid/functions/v1/photo-purge', { method: 'POST', headers: { 'x-photo-purge-secret': secret, 'X-Request-ID': 'secret-via-header' } }), secret, run);
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store'); expect(await response.text()).not.toMatch(/provider|secret/);
  });
  it.each(['/photo-purge/extra', '/photo-purge/', '/photo-purge?limit=100'])('rejects alias %s', async path => {
    expect((await handlePhotoPurge(new Request(`https://local.invalid${path}`, { method: 'POST' }), secret, run)).status).toBe(404);
  });
  it('denies missing config, user JWT, invalid secret, body and non-POST', async () => {
    expect((await handlePhotoPurge(new Request('https://local.invalid/photo-purge', { method: 'POST' }), undefined, run)).status).toBe(503);
    expect((await handlePhotoPurge(new Request('https://local.invalid/photo-purge', { method: 'POST', headers: { authorization: 'Bearer user.jwt.value' } }), secret, run)).status).toBe(401);
    expect((await handlePhotoPurge(new Request('https://local.invalid/photo-purge', { method: 'POST', headers: { 'x-photo-purge-secret': 'x'.repeat(40) } }), secret, run)).status).toBe(401);
    expect((await handlePhotoPurge(new Request('https://local.invalid/photo-purge', { method: 'POST', body: '{}', headers: { 'x-photo-purge-secret': secret } }), secret, run)).status).toBe(400);
    expect((await handlePhotoPurge(new Request('https://local.invalid/photo-purge'), secret, run)).status).toBe(405);
  });
});
