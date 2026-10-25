import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendResetReceipt, createResetReceipt, type ResetReceipt } from '../src/modules/developer-reset/reset-receipt.js';
import { createSupabaseResetReceiptStore, resetReceiptAnchor } from '../src/modules/developer-reset/reset-receipt-store.js';
import { requestHash } from '../src/lib/command.js';

const h = (value: string) => value.repeat(64);
const actor = '11111111-1111-4111-8111-111111111111';
const auth = '22222222-2222-4222-8222-222222222222';
const session = '33333333-3333-4333-8333-333333333333';
const digest = (value: string) => createHash('sha256').update(`developer-operation-v1:${value}`).digest('hex');
const command = () => ({ binding: { actorProfileId: actor, authUserId: auth, sessionDigest: digest(session),
  passwordVersionDigest: h('b'), projectRef: 'a'.repeat(20), sourceCommit: 'a'.repeat(40),
  catalogFingerprint: h('c'), contentFingerprint: h('d'), planFingerprint: h('e'), expectedPostconditionFingerprint: h('f'),
  policyHash: h('1'), approvalScopeHash: h('2'), backupProofHash: h('3') }, idempotencyKeyDigest: h('4'),
  createdAt: 1000, expiresAt: 2000, steps: [{ id: h('5'), kind: 'DATABASE' }] });
const start = { type: 'STARTED', stepId: h('5') };
const genesis = () => createResetReceipt(command(), 1000);
const next = () => appendResetReceipt(genesis(), { ...start, bindingHash: genesis().bindingHash }, { expectedVersion: 0, now: 1100 });
const envelope = (receipt: ResetReceipt) => ({ format: 'reset-receipt-store-v1', receipt,
  anchor: resetReceiptAnchor(receipt), executionEnabled: false });
function setup() {
  let stored: ResetReceipt | undefined;
  const rpc = vi.fn(async (_name: string, args: Record<string, unknown>, _signal: AbortSignal) => {
    if (args.p_mode === 'CREATE') stored ??= { ...(args.p_header as Omit<ResetReceipt, 'events'>), events: [] };
    if (!stored) return { data: null, error: { message: 'not found' } };
    if (args.p_mode === 'APPEND') {
      if (args.p_expected_version !== stored.events.length || args.p_expected_head !== resetReceiptAnchor(stored).headHash)
        return { data: null, error: { message: 'stale' } };
      stored = { ...stored, events: [...stored.events, args.p_entry as ResetReceipt['events'][number]] };
    }
    return { data: structuredClone(envelope(stored)), error: null };
  });
  const options = { rpc, supabaseUrl: `https://${'a'.repeat(20)}.supabase.co`, projectRef: 'a'.repeat(20),
    actorProfileId: actor, authUserId: auth, sessionId: session, timeoutMs: 25 };
  return { rpc, options, store: createSupabaseResetReceiptStore(options), set: (r: ResetReceipt) => { stored = r; },
    get: () => stored };
}
afterEach(() => vi.useRealTimers());

describe('server-internal durable receipt adapter (synthetic RPC, no DB)', () => {
  it('pins Node canonical golden values also embedded literally in the prepared SQL regression', () => {
    const golden = JSON.parse(readFileSync('tests/fixtures/reset-receipt-store-golden.json', 'utf8')) as {
      binding: unknown; header: Omit<ResetReceipt, 'events'>; events: ResetReceipt['events']; headerHash: string };
    expect(requestHash(golden.binding)).toBe(golden.header.bindingHash);
    expect(requestHash(golden.header)).toBe(golden.headerHash);
    let hash = golden.headerHash;
    for (const entry of golden.events) {
      const { hash: actual, ...unsigned } = entry;
      expect(unsigned.previousHash).toBe(hash); expect(requestHash(unsigned)).toBe(actual); hash = actual;
    }
    expect(readFileSync('supabase/tests/developer_reset_receipt_store.sql', 'utf8')).toContain(JSON.stringify(golden));
  });
  it('creates and appends only the exact immutable header/event and returns no execution authority', async () => {
    const f = setup();
    const created = await f.store.create(command(), 1000);
    expect(created).toMatchObject({ status: 'CONFIRMED', executionEnabled: false, retryExecutionAllowed: false });
    const result = await f.store.append(command(), genesis(), { ...start, bindingHash: genesis().bindingHash },
      { anchor: resetReceiptAnchor(genesis()), now: 1100 });
    expect(result).toEqual({ status: 'CONFIRMED', receipt: next(), anchor: resetReceiptAnchor(next()),
      executionEnabled: false, retryExecutionAllowed: false });
    expect(f.rpc).toHaveBeenCalledTimes(2);
    expect(f.rpc.mock.calls[1]?.[0]).toBe('store_developer_reset_receipt');
    expect(f.rpc.mock.calls[1]?.[1]).toMatchObject({ p_mode: 'APPEND', p_actor: actor, p_auth: auth,
      p_session: session, p_expected_version: 0, p_entry: next().events[0] });
    expect(JSON.stringify(result)).not.toContain(session);
  });
  it('same-key create observes stored state without replaying an effect', async () => {
    const f = setup(); f.set(next());
    expect(await f.store.create(command(), 1300)).toMatchObject({ status: 'CONFIRMED', receipt: next() });
    expect(f.rpc).toHaveBeenCalledTimes(1);
  });
  it('accepts a complete latest history anchored at an older known prefix', async () => {
    const f = setup(); f.set(next());
    expect(await f.store.read(command(), resetReceiptAnchor(genesis()), 1200)).toMatchObject({ status: 'CONFIRMED', anchor: { version: 1 } });
  });
  it('detects normal-prefix rollback against a separately supplied latest durable anchor', async () => {
    const f = setup(); f.set(genesis());
    expect(await f.store.read(command(), resetReceiptAnchor(next()), 1200)).toMatchObject({ status: 'UNKNOWN' });
  });
  it('retains its own latest anchor despite caller mutation and rejects stale proposals locally', async () => {
    const f = setup(); f.set(next());
    const result = await f.store.read(command(), resetReceiptAnchor(next()), 1200);
    if (result.status !== 'CONFIRMED') throw new Error();
    result.anchor.version = 0; result.receipt.events.length = 0;
    await expect(f.store.read(command(), resetReceiptAnchor(genesis()), 1201)).rejects.toThrow('INPUT_REJECTED');
    expect(f.rpc).toHaveBeenCalledTimes(1);
  });
  it.each(['missing', 'extra', 'head', 'version', 'header', 'event'])('rejects malformed or inconsistent %s readback', async mode => {
    const f = setup(); const response = envelope(next()) as Record<string, unknown>;
    if (mode === 'missing') delete response.anchor;
    if (mode === 'extra') response.rawSecret = 'must-not-return';
    if (mode === 'head') (response.anchor as { headHash: string }).headHash = h('0');
    if (mode === 'version') (response.anchor as { version: number }).version = 0;
    if (mode === 'header') (response.receipt as ResetReceipt).expiresAt = 3000;
    if (mode === 'event') (response.receipt as ResetReceipt).events[0]!.at = 1101;
    f.rpc.mockResolvedValueOnce({ data: response as ReturnType<typeof envelope>, error: null });
    expect(await f.store.read(command(), resetReceiptAnchor(genesis()), 1200)).toEqual({ status: 'UNKNOWN', executionEnabled: false, retryExecutionAllowed: false });
  });
  it('requires exact proposal readback, not an apparently successful old receipt', async () => {
    const f = setup(); f.rpc.mockResolvedValueOnce({ data: envelope(genesis()), error: null });
    expect(await f.store.append(command(), genesis(), { ...start, bindingHash: genesis().bindingHash },
      { anchor: resetReceiptAnchor(genesis()), now: 1100 })).toMatchObject({ status: 'UNKNOWN' });
  });
  it('timeout aborts observation once, blocks automatic replay, and ignores old readback until the exact pending prefix appears', async () => {
    vi.useFakeTimers(); const f = setup(); f.set(genesis());
    f.rpc.mockImplementationOnce(async () => new Promise(() => {}));
    const pending = f.store.append(command(), genesis(), { ...start, bindingHash: genesis().bindingHash },
      { anchor: resetReceiptAnchor(genesis()), now: 1100 });
    await vi.advanceTimersByTimeAsync(26);
    expect(await pending).toMatchObject({ status: 'UNKNOWN' });
    expect(f.rpc.mock.calls[0]?.[2].aborted).toBe(true);
    expect(await f.store.append(command(), genesis(), { ...start, bindingHash: genesis().bindingHash },
      { anchor: resetReceiptAnchor(genesis()), now: 1101 })).toMatchObject({ status: 'UNKNOWN' });
    expect(f.rpc).toHaveBeenCalledTimes(1);
    expect(await f.store.read(command(), resetReceiptAnchor(genesis()), 1200)).toMatchObject({ status: 'UNKNOWN' });
    f.set(next());
    expect(await f.store.read(command(), resetReceiptAnchor(genesis()), 1200)).toMatchObject({ status: 'CONFIRMED' });
    expect(f.rpc).toHaveBeenCalledTimes(3);
  });
  it('response loss after commit is settled only by explicit read and never repeats append', async () => {
    const f = setup(); f.rpc.mockImplementationOnce(async () => { f.set(next()); throw new Error('sensitive remote error'); });
    expect(await f.store.append(command(), genesis(), { ...start, bindingHash: genesis().bindingHash },
      { anchor: resetReceiptAnchor(genesis()), now: 1100 })).toMatchObject({ status: 'UNKNOWN' });
    expect(await f.store.read(command(), resetReceiptAnchor(genesis()), 1200)).toMatchObject({ status: 'CONFIRMED', anchor: { version: 1 } });
    expect(f.rpc.mock.calls.map(call => call[1].p_mode)).toEqual(['APPEND', 'READ']);
  });
  it('two independent clients compete with the same version; only one synthetic CAS appends', async () => {
    const f = setup(); f.set(genesis()); const other = createSupabaseResetReceiptStore(f.options);
    const results = await Promise.all([f.store, other].map(store => store.append(command(), genesis(),
      { ...start, bindingHash: genesis().bindingHash }, { anchor: resetReceiptAnchor(genesis()), now: 1100 })));
    expect(results.map(r => r.status).sort()).toEqual(['CONFIRMED', 'UNKNOWN']);
    expect(f.get()?.events).toHaveLength(1);
  });
  it('rejects overlapping calls before RPC, so delayed write/read responses cannot lower its head', async () => {
    const f = setup(); let resolve: (value: { data: ReturnType<typeof envelope>; error: null }) => void = () => { throw new Error(); };
    f.rpc.mockImplementationOnce(async () => new Promise(done => { resolve = done; }));
    const pending = f.store.append(command(), genesis(), { ...start, bindingHash: genesis().bindingHash },
      { anchor: resetReceiptAnchor(genesis()), now: 1100 });
    await Promise.resolve();
    expect(await f.store.read(command(), resetReceiptAnchor(genesis()), 1200)).toMatchObject({ status: 'UNKNOWN' });
    expect(await f.store.append(command(), next(), { type: 'OBSERVED', stepId: h('5'), outcome: 'APPLIED', evidenceHash: h('8') },
      { anchor: resetReceiptAnchor(next()), now: 1200 })).toMatchObject({ status: 'UNKNOWN' });
    expect(f.rpc).toHaveBeenCalledTimes(1);
    resolve({ data: envelope(next()), error: null });
    expect(await pending).toMatchObject({ status: 'CONFIRMED', anchor: { version: 1 } });
    await expect(f.store.read(command(), resetReceiptAnchor(genesis()), 1201)).rejects.toThrow('INPUT_REJECTED');
  });
  it('one store instance is bounded to one receipt key rather than an unbounded actor cache', async () => {
    const f = setup(); await f.store.create(command(), 1000);
    const different = { ...command(), idempotencyKeyDigest: h('9') };
    await expect(f.store.create(different, 1000)).rejects.toThrow('INPUT_REJECTED');
    expect(f.rpc).toHaveBeenCalledTimes(1);
  });
  it.each(['actorProfileId', 'authUserId', 'sessionDigest', 'projectRef'])('rejects changed %s before any RPC', async field => {
    const f = setup(); const c = command(); (c.binding as Record<string, string>)[field] = field === 'projectRef' ? 'b'.repeat(20)
      : field === 'sessionDigest' ? h('0') : '44444444-4444-4444-8444-444444444444';
    await expect(f.store.create(c, 1000)).rejects.toThrow('INPUT_REJECTED'); expect(f.rpc).not.toHaveBeenCalled();
  });
  it.each(['http://aaaaaaaaaaaaaaaaaaaa.supabase.co', 'https://bbbbbbbbbbbbbbbbbbbb.supabase.co',
    'https://aaaaaaaaaaaaaaaaaaaa.supabase.co/?secret=1'])('rejects unbound target %s', url => {
    const f = setup(); expect(() => createSupabaseResetReceiptStore({ ...f.options, supabaseUrl: url })).toThrow('INPUT_REJECTED');
  });
  it.each([0, -1, 7001, Number.NaN])('requires a finite explicit transport budget %s', timeoutMs => {
    const f = setup(); expect(() => createSupabaseResetReceiptStore({ ...f.options, timeoutMs })).toThrow('INPUT_REJECTED');
  });
  it('rejects same key changed command and reordered/stale receipt before append', () => {
    const f = setup(); const c = command(); c.binding.policyHash = h('9');
    expect(() => f.store.append(c, genesis(), { ...start, bindingHash: genesis().bindingHash },
      { anchor: resetReceiptAnchor(genesis()), now: 1100 })).toThrow('INPUT_REJECTED');
    expect(f.rpc).not.toHaveBeenCalled();
  });
});
