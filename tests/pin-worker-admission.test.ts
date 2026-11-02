import { afterEach, describe, expect, it, vi } from 'vitest';
import { withPinIncrementalOperationAdmission } from '../src/modules/developer-reset/pin-worker-admission.js';
import type { OperationWorkerRpc } from '../src/modules/developer-reset/worker-admission.js';
import { RoomPinSheetSyncWorker } from '../src/modules/rooms/room-pin-sheet-sync.js';
import * as targets from '../src/modules/rooms/google-sheets-pin.js';
import { encryptRoomPin } from '../src/modules/rooms/room-pin-crypto.js';

const target = 'a'.repeat(20), nonce = 'b'.repeat(64), digest = 'c'.repeat(64);
const id = '13400000-0000-4000-8000-000000000001', claimId = '13400000-0000-4000-8000-000000000002';
const first = { p_claim_id: claimId, p_expected_environment: 'synthetic', p_expected_project_ref: target, p_expected_target_identity_digest: digest };
const incremental = { p_claim_id: claimId, p_expected_environment: 'synthetic', p_expected_project_ref: target, p_limit: 10 };
const heartbeat = { p_claim_id: claimId, p_lease_fence: 4, p_status: 'succeeded', p_claimed: 0, p_projected: 0,
  p_already_current: 0, p_superseded: 0, p_retrying: 0, p_blocked: 0, p_error_code: null };
const claim = { status: 'claimed', leaseFence: 4, items: [], blocked: 0 };
const ok = (data: unknown) => ({ data, error: null });
function fixture(options: { inactive?: boolean; refused?: boolean; terminal?: boolean; malformed?: unknown; status?: string; items?: unknown[] } = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const db: OperationWorkerRpc = { rpc: vi.fn(async (name, args) => {
    calls.push({ name, args });
    if (name === 'claim_operation_pin_incremental') return options.refused ? { data: null, error: { code: 'HOLD' } } :
      ok(options.malformed ?? { admissionId: options.inactive || options.status ? null : id,
        claim: { ...claim, ...(options.items ? { items: options.items } : {}), ...(options.status ? { status: options.status } : {}) } });
    if (name === 'complete_operation_pin_incremental') return options.terminal === false ?
      { data: null, error: { code: 'OPERATION_PIN_TERMINAL_UNVERIFIED' } } : ok({ completed: true });
    return ok({ status: args.p_action === 'HEARTBEAT' || args.p_action === 'SETTLE' ? 'succeeded' : args.p_action === 'AUTHORIZE' ? 'authorized' : 'leased', recordedAt: '2026-10-25T00:00:00Z' });
  }) };
  return { db, calls };
}
const options = (db: OperationWorkerRpc) => ({ db, config: { target }, budgetMs: 45_000, nonce: () => nonce });
async function begin(db: OperationWorkerRpc) {
  expect((await db.rpc('claim_room_pin_sheet_full_resync', first)).data).toEqual({ status: 'empty', leaseFence: 4 });
  expect((await db.rpc('claim_room_pin_sheet_sync', incremental)).data).toEqual(claim);
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe('incremental PIN worker admission', () => {
  it('preserves the original disabled worker port', async () => {
    const { db, calls } = fixture();
    expect(await withPinIncrementalOperationAdmission({ ...options(db), config: undefined }, async inner => {
      expect(inner).toBe(db); return 7;
    })).toBe(7);
    expect(calls).toEqual([]);
  });
  it('replaces both old claims with one incremental-only admission and fixed dispatch', async () => {
    const { db, calls } = fixture();
    await withPinIncrementalOperationAdmission(options(db), async inner => {
      await begin(inner);
      await inner.rpc('renew_room_pin_sheet_sync_run', { p_claim_id: claimId, p_lease_fence: 4 });
      await inner.rpc('record_room_pin_sheet_sync_heartbeat', heartbeat);
      expect(calls.some(c => c.name.startsWith('complete_'))).toBe(false);
    });
    expect(calls.map(c => c.name)).toEqual(['claim_operation_pin_incremental', 'dispatch_operation_pin_incremental',
      'dispatch_operation_pin_incremental', 'complete_operation_pin_incremental']);
    expect(calls[0]?.args).toMatchObject({ ...first, p_target: target, p_nonce: nonce });
    expect(calls[1]?.args).toMatchObject({ p_admission_id: id, p_action: 'RENEW' });
    expect(calls[3]?.args).toEqual({ p_target: target, p_admission_id: id, p_nonce: nonce });
  });
  it('does not turn missing control into an admission or completion proof', async () => {
    const { db, calls } = fixture({ inactive: true });
    await withPinIncrementalOperationAdmission(options(db), async inner => { await begin(inner); await inner.rpc('record_room_pin_sheet_sync_heartbeat', heartbeat); });
    expect(calls.map(c => c.name)).toEqual(['claim_operation_pin_incremental', 'record_room_pin_sheet_sync_heartbeat']);
  });
  it.each(['busy', 'operator_blocked'])('preserves %s without invoking providers or borrowing an older admission', async status => {
    const { db, calls } = fixture({ status });
    await withPinIncrementalOperationAdmission(options(db), async inner => {
      expect((await inner.rpc('claim_room_pin_sheet_full_resync', first)).data).toEqual({ status, leaseFence: 4 });
    });
    expect(calls).toHaveLength(1);
  });
  it('does not retry legacy claim or heartbeat after HOLD or unknown claim response', async () => {
    const { db, calls } = fixture({ refused: true });
    await expect(withPinIncrementalOperationAdmission(options(db), async inner => {
      await expect(inner.rpc('claim_room_pin_sheet_full_resync', first)).rejects.toThrow();
      await expect(inner.rpc('record_room_pin_sheet_sync_heartbeat', heartbeat)).rejects.toThrow();
    })).rejects.toThrow();
    expect(calls.map(c => c.name)).toEqual(['claim_operation_pin_incremental']);
  });
  it.each([{ admissionId: id }, { admissionId: 'wrong', claim }, { admissionId: id, claim, extra: true },
    { admissionId: id, claim: { ...claim, status: 'claimed_full_resync' } },
    { admissionId: id, claim: { ...claim, status: 'busy' } }])('rejects malformed claim and blocks later effects', async malformed => {
    const { db, calls } = fixture({ malformed });
    await expect(withPinIncrementalOperationAdmission(options(db), async inner => { await begin(inner); })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
  it.each([{ ...first, p_expected_project_ref: 'local' }, { ...first, p_unreviewed: true }, { ...first, p_claim_id: null }])(
    'rejects wrong target or extra claim authority before any remote call', async args => {
      const { db, calls } = fixture();
      await expect(withPinIncrementalOperationAdmission(options(db), async inner => { await inner.rpc('claim_room_pin_sheet_full_resync', args); })).rejects.toThrow();
      expect(calls).toEqual([]);
    });
  it('rejects a second claim, altered identity, wrong fence, and unrelated/full-resync effects', async () => {
    const { db, calls } = fixture();
    await withPinIncrementalOperationAdmission(options(db), async inner => {
      await begin(inner);
      for (const [name, args] of [
        ['claim_room_pin_sheet_sync', incremental],
        ['claim_room_pin_sheet_full_resync', first],
        ['settle_room_pin_sheet_full_resync', { p_claim_id: claimId, p_lease_fence: 4 }],
        ['renew_room_pin_sheet_sync_run', { p_claim_id: claimId, p_lease_fence: 5 }],
        ['renew_room_pin_sheet_sync_run', { p_claim_id: id, p_lease_fence: 4 }],
      ] as const) await expect(inner.rpc(name, args)).rejects.toThrow();
      await inner.rpc('record_room_pin_sheet_sync_heartbeat', heartbeat);
    });
    expect(calls).toHaveLength(3);
  });
  it('keeps the lazy claim one-shot even when awaited twice', async () => {
    const { db, calls } = fixture();
    await withPinIncrementalOperationAdmission(options(db), async inner => {
      const query = inner.rpc('claim_room_pin_sheet_full_resync', first);
      expect(calls).toHaveLength(0); await query; await query;
      await inner.rpc('claim_room_pin_sheet_sync', incremental);
      await inner.rpc('record_room_pin_sheet_sync_heartbeat', heartbeat);
    });
    expect(calls.filter(c => c.name.startsWith('claim_'))).toHaveLength(1);
  });
  it('requires durable per-admission terminal proof even after a successful heartbeat', async () => {
    const { db } = fixture({ terminal: false });
    await expect(withPinIncrementalOperationAdmission(options(db), async inner => { await begin(inner); await inner.rpc('record_room_pin_sheet_sync_heartbeat', heartbeat); }))
      .rejects.toThrow('OPERATION_WORKER_ADMISSION_UNAVAILABLE');
  });
  it('never clears an admission after missing heartbeat, thrown run, or response loss', async () => {
    for (const throws of [false, true]) {
      const { db, calls } = fixture();
      await expect(withPinIncrementalOperationAdmission(options(db), async inner => {
        await begin(inner); if (throws) throw new Error('synthetic response loss');
      })).rejects.toThrow();
      expect(calls).toHaveLength(1);
    }
  });
  it('blocks retained ports after the heartbeat or run completion', async () => {
    const { db, calls } = fixture(); let retained: OperationWorkerRpc | undefined;
    await withPinIncrementalOperationAdmission(options(db), async inner => {
      retained = inner; await begin(inner); await inner.rpc('record_room_pin_sheet_sync_heartbeat', heartbeat);
      await expect(inner.rpc('renew_room_pin_sheet_sync_run', heartbeat)).rejects.toThrow();
    });
    await expect(retained?.rpc('renew_room_pin_sheet_sync_run', heartbeat)).rejects.toThrow();
    expect(calls).toHaveLength(3);
  });
  it('bounds a stuck provider and blocks its late settle without asserting remote cancellation', async () => {
    vi.useFakeTimers(); const { db, calls } = fixture(); let resume: (() => void) | undefined;
    let late: Promise<unknown> | undefined;
    const pending = withPinIncrementalOperationAdmission({ ...options(db), budgetMs: 25 }, async inner => {
      await begin(inner); await new Promise<void>(resolve => { resume = resolve; });
      late = Promise.resolve(inner.rpc('settle_room_pin_sheet_sync', { p_claim_id: claimId, p_lease_fence: 4 }));
      await late;
    });
    const rejected = expect(pending).rejects.toThrow('OPERATION_WORKER_ADMISSION_UNAVAILABLE');
    await vi.advanceTimersByTimeAsync(25); await rejected;
    resume?.(); await vi.advanceTimersByTimeAsync(0);
    await expect(late).rejects.toThrow(); expect(calls).toHaveLength(1);
  });
  it('aborts observation of a stuck RPC at the same finite deadline', async () => {
    vi.useFakeTimers(); const db: OperationWorkerRpc = { rpc: () => new Promise(() => undefined) };
    const pending = withPinIncrementalOperationAdmission({ ...options(db), budgetMs: 25 }, async inner => { await begin(inner); });
    const rejected = expect(pending).rejects.toThrow(); await vi.advanceTimersByTimeAsync(25); await rejected;
  });
  it('actual Node worker uses the adapter under a synthetic approved-mapping port, not a production mapping', async () => {
    const { db, calls } = fixture();
    vi.spyOn(targets, 'approvedRoomPinSheetTarget').mockReturnValue({ ...targets.LOCAL_ROOM_PIN_SHEET_TARGET, environment: 'synthetic', projectRef: target });
    vi.spyOn(targets, 'roomPinSheetTargetDigest').mockResolvedValue(digest);
    const inspect = vi.fn(), write = vi.fn();
    const result = await new RoomPinSheetSyncWorker(db, { inspect, write }, { key: '', keyVersion: '', keyring: {}, environment: 'synthetic', projectRef: target }, Date.now, { target }).run();
    expect(result.claimed).toBe(0); expect(inspect).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
    expect(calls.map(c => c.name)).toEqual(['claim_operation_pin_incremental', 'dispatch_operation_pin_incremental', 'dispatch_operation_pin_incremental', 'complete_operation_pin_incremental']);
  });
  it('real unapproved hosted mapping remains rejected before DB or provider activity', async () => {
    const { db, calls } = fixture(); const inspect = vi.fn(), write = vi.fn();
    await expect(new RoomPinSheetSyncWorker(db, { inspect, write }, { key: '', keyVersion: '', keyring: {}, environment: 'synthetic', projectRef: target }, Date.now, { target }).run()).rejects.toThrow();
    expect(calls).toEqual([]); expect(inspect).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  });
  it.each(['write', 'current'] as const)('actual Node one-item %s path keeps exact authorization/settlement args with fake provider', async mode => {
    vi.spyOn(targets, 'approvedRoomPinSheetTarget').mockReturnValue({ ...targets.LOCAL_ROOM_PIN_SHEET_TARGET, environment: 'synthetic', projectRef: target });
    vi.spyOn(targets, 'roomPinSheetTargetDigest').mockResolvedValue(digest);
    const room = '13400000-0000-4000-8000-000000000010', outbox = '13400000-0000-4000-8000-000000000011';
    const cryptoConfig = { key: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))), keyVersion: 'v1', keyring: {}, environment: 'synthetic', projectRef: target };
    const envelope = await encryptRoomPin('101-1234', room, 1, cryptoConfig);
    const { db, calls } = fixture({ items: [{ outboxId: outbox, roomId: room, roomNumber: '101', sheetRow: 2, pinVersion: 1,
      effectiveAt: '2026-10-25T00:00:00Z', syncStatus: 'verified', reasonCode: 'PIN_CHANGE_CONFIRMED', leaseFence: 4, ...envelope }] });
    const inspect = vi.fn(async () => ({ outcome: mode, sheetRow: 2 })), write = vi.fn(async () => undefined);
    const result = await new RoomPinSheetSyncWorker(db, { inspect, write }, cryptoConfig, Date.now, { target }).run();
    expect(result.claimed).toBe(1); expect(result.projected).toBe(mode === 'write' ? 1 : 0);
    expect(result.alreadyCurrent).toBe(mode === 'current' ? 1 : 0); expect(inspect).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledTimes(mode === 'write' ? 1 : 0);
    const actions = calls.filter(c => c.name === 'dispatch_operation_pin_incremental');
    expect(actions.map(c => c.args.p_action)).toEqual(mode === 'write' ? ['RENEW', 'AUTHORIZE', 'SETTLE', 'HEARTBEAT'] : ['RENEW', 'SETTLE', 'HEARTBEAT']);
    const settled = actions.find(c => c.args.p_action === 'SETTLE')?.args.p_args;
    expect(settled).toEqual({ p_claim_id: calls[0]?.args.p_claim_id, p_lease_fence: 4, p_outbox_id: outbox,
      p_expected_pin_version: 1, p_outcome: mode === 'write' ? 'succeeded' : 'already_current', p_reason_code: null });
    expect(JSON.stringify(calls)).not.toContain('101-1234');
    expect(calls.at(-1)?.name).toBe('complete_operation_pin_incremental');
  });
});
