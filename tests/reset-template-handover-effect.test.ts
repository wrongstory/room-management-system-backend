import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestHash } from '../src/lib/command.js';
import { createResetPlanRevalidation, takeResetTemplateHandover } from '../src/modules/developer-reset/plan-revalidation.js';
import { prepareResetTemplateHandover } from '../src/modules/developer-reset/template-handover-effect.js';
import { prepareResetTemplateHandoverProtocol, RESET_TEMPLATE_HANDOVER_STEP } from '../src/modules/developer-reset/template-handover-protocol.js';
import { appendResetReceipt, type ResetReceipt } from '../src/modules/developer-reset/reset-receipt.js';
import { resetReceiptAnchor } from '../src/modules/developer-reset/reset-receipt-store.js';
import { reviewSourceHarness } from './helpers/reset-review-source.js';
import { reviewId } from './helpers/reset-review.js';
const approval = vi.hoisted(() => vi.fn());
vi.mock('../src/modules/developer-reset/reset-approval.js', async original => ({
  ...await original<Record<string, unknown>>(), consumeResetApproval: approval,
}));
const required = <T>(v: T | undefined | null): T => { if (v == null) throw new Error('fixture missing'); return v; };
const digest = (s: string) => createHash('sha256').update(`developer-operation-v1:${s}`).digest('hex');
const hash = (s: string) => s.repeat(64);
async function fixture() {
  const h = reviewSourceHarness(f => {
    const extend = (relation: string, fields: Record<string, [string, string | null]>) => {
      const table = required(f.metadata.relations.find(t => t.relation === relation));
      for (const [name, [type, value]] of Object.entries(fields)) {
        table.columns.push({ name, pgType: `pg_catalog.${type}` });
        for (const row of f.rows.filter(row => row.relation === relation)) row.values.push({ name, pgType: `pg_catalog.${type}`, value });
      }
    };
    extend('public.cleaning_template_versions', { published_at: ['timestamptz', '2026-01-02 00:00:00+00'] });
    extend('private.photo_template_slots', { slot_key: ['text', 'entry'], display_order: ['int4', '0'], required: ['bool', 'true'] });
    f.refreshCensus();
  });
  const owner = createResetPlanRevalidation({ expiresAt: Date.now() + 120000 });
  const first = await owner.prepare(h.source, h.f.request, h.open);
  expect(first.status).toBe('PREPARED');
  expect((await owner.recheck(h.source, h.f.request, h.open)).status).toBe('MATCHED');
  const settings = { actorProfileId: reviewId(1), authUserId: reviewId(2), sessionId: reviewId(50), sessionDigest: digest(reviewId(50)),
    passwordVersionDigest: hash('2'), challengeId: reviewId(51), controlVersion: '1', policyHash: hash('4'), approvalScopeHash: hash('5'),
    backupProofHash: hash('6'), idempotencyKeyDigest: hash('7'), expiresAt: Date.now() + 100000, timeoutMs: 50 };
  let stored: ResetReceipt | undefined;
  let registrationTime: string | null = null;
  const state = { deny: '', corrupt: '', lose: false, stall: false };
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>, _signal: AbortSignal) => {
    const mode = String(args.p_mode);
    if (mode === state.deny) return { data: null, error: { message: 'private database error value' } };
    if (name === 'store_developer_reset_receipt') {
      if (mode === 'CREATE') stored = { ...(args.p_header as Omit<ResetReceipt, 'events'>), events: [] };
      if (!stored) throw new Error('missing');
      if (mode === 'APPEND') stored = { ...stored, events: [...stored.events, args.p_entry as ResetReceipt['events'][number]] };
      return { data: { format: 'reset-receipt-store-v1', receipt: structuredClone(stored), anchor: resetReceiptAnchor(stored), executionEnabled: false }, error: null };
    }
    const count = (args.p_payload as { templates: unknown[] }).templates.length, payloadHash = requestHash(args.p_payload);
    if (mode === 'APPLY') registrationTime = new Date().toISOString();
    const postconditionHash = requestHash({ domain: 'reset-template-handover-postcondition-v1', payloadHash, count,
      registrationTime: 'DATABASE_CLOCK_AFTER_STARTED_BEFORE_OBSERVED' });
    let evidenceHash = requestHash({ domain: 'reset-template-handover-applied-v1', postconditionHash, registrationTime });
    if (mode === 'APPLY') {
      stored = appendResetReceipt(required(stored), { type: 'OBSERVED', stepId: RESET_TEMPLATE_HANDOVER_STEP, outcome: 'APPLIED', evidenceHash },
        { expectedVersion: 1, now: Date.now() });
      if (state.lose) throw new Error('provider raw private failure');
      if (state.stall) return new Promise<never>(() => {});
    }
    if (mode === 'APPLY' && ['clock-before', 'clock-after'].includes(state.corrupt)) {
      const current = required(stored), started = required(current.events[0]), observed = required(current.events[1]);
      registrationTime = new Date(state.corrupt === 'clock-before' ? started.at - 1 : observed.at + 1).toISOString();
      evidenceHash = requestHash({ domain: 'reset-template-handover-applied-v1', postconditionHash, registrationTime });
      stored = appendResetReceipt({ ...current, events: [started] },
        { type: 'OBSERVED', stepId: RESET_TEMPLATE_HANDOVER_STEP, outcome: 'APPLIED', evidenceHash }, { expectedVersion: 1, now: observed.at });
    }
    const value = { format: 'reset-template-effect-result-v1', status: mode === 'PRECHECK' ? 'PRECHECKED' : 'APPLIED',
      payloadHash, count, evidenceHash: mode === 'PRECHECK' ? null : evidenceHash, registrationTime,
      receipt: mode === 'PRECHECK' ? null : structuredClone(stored), executionEnabled: false };
    if (state.corrupt === mode) value.payloadHash = hash('0');
    return { data: value, error: null };
  });
  const options = { rpc, supabaseUrl: `https://${h.source.binding.projectRef}.supabase.co` };
  const input = { handle: owner, commitment: required(first.summary).commitment, settings };
  const args = { approvalId: reviewId(52), runId: reviewId(53), nonce: hash('9'), ioBudgetMs: 100 };
  return { ...h, owner, options, input, rpc, state, args, stored: () => stored,
    prepare: () => prepareResetTemplateHandoverProtocol(options, input) };
}
beforeEach(() => { approval.mockImplementation(async ({ request }) => ({ commandHash: request.commandHash, requestSha256: request.requestSha256 })); });
afterEach(() => { approval.mockReset(); vi.useRealTimers(); });

describe('inactive S1 boundary and internal protocol (synthetic ports only)', () => {
  it('public adapter cannot consume approval or call any RPC even with valid prepared content', async () => {
    const f = await fixture(), adapter = prepareResetTemplateHandover(f.options, f.input);
    expect(await adapter.execute(f.args)).toMatchObject({ status: 'ACTIVATION_REQUIRED', executionEnabled: false });
    expect(f.rpc).not.toHaveBeenCalled(); expect(approval).not.toHaveBeenCalled();
    expect(adapter.summary).toMatchObject({ count: 1, protectionVerified: false, activationRequired: true });
    for (const raw of ['synthetic private slot', reviewId(6), reviewId(50)]) expect(JSON.stringify(adapter.summary)).not.toContain(raw);
    adapter.dispose();
  });
  it('preserves owned original allocations and typed historical text; effect observation is not whole reset completion', async () => {
    const f = await fixture(), adapter = f.prepare();
    const result = await adapter.execute(f.args);
    expect(result).toMatchObject({ status: 'APPLIED', count: 1, completeResetCoverage: false, executionEnabled: false });
    expect(f.rpc.mock.calls.map(([name, a]) => `${name}:${a.p_mode}`)).toEqual([
      'apply_developer_template_handover:PRECHECK', 'store_developer_reset_receipt:CREATE',
      'store_developer_reset_receipt:APPEND', 'apply_developer_template_handover:APPLY']);
    const payload = required(f.rpc.mock.calls[0])?.[1].p_payload as { oldTemplates: { created_at: string; published_at: string }[]; templates: { newId: string; plannedAt: string }[] };
    expect(payload.oldTemplates[0]).toMatchObject({ created_at: '2026-01-01 00:00:00.123456+00', published_at: '2026-01-02 00:00:00+00' });
    expect(payload.templates[0]?.newId).not.toBe(reviewId(6));
    expect(f.rpc.mock.calls[3]?.[1].p_payload).toEqual(payload);
    expect(f.stored()?.events.map(e => e.event.type)).toEqual(['STARTED', 'OBSERVED']);
    expect(result.status === 'APPLIED' && Date.parse(required(result.registrationTime))).toBeGreaterThanOrEqual(Date.parse(required(payload.templates[0]).plannedAt));
    expect(JSON.stringify(result)).not.toContain(payload.templates[0]?.newId);
    expect((await adapter.execute(f.args)).status).toBe('UNKNOWN'); expect(approval).toHaveBeenCalledOnce(); adapter.dispose();
  });
  it.each(['PRECHECK', 'CREATE', 'APPEND', 'APPLY'])('never replays after %s fails', async mode => {
    const f = await fixture(); f.state.deny = mode; const adapter = f.prepare();
    expect((await adapter.execute(f.args)).status).toBe('UNKNOWN');
    const before = f.rpc.mock.calls.length; expect((await adapter.execute(f.args)).status).toBe('UNKNOWN');
    expect(f.rpc).toHaveBeenCalledTimes(before);
    if (mode === 'PRECHECK') expect(approval).not.toHaveBeenCalled();
    if (mode !== 'APPLY') expect(f.rpc.mock.calls.some(([, a]) => a.p_mode === 'APPLY')).toBe(false);
    adapter.dispose();
  });
  it('invalid or failed owner approval cannot reach durable CREATE or effect', async () => {
    const f = await fixture(), adapter = f.prepare(); approval.mockRejectedValueOnce(new Error('private file path'));
    const result = await adapter.execute(f.args); expect(result.status).toBe('UNKNOWN');
    expect(f.rpc).toHaveBeenCalledOnce(); expect(JSON.stringify(result)).not.toContain('private'); adapter.dispose();
  });
  it.each(['PRECHECK', 'APPLY', 'READ'])('rejects changed %s payload commitment', async mode => {
    const f = await fixture(), adapter = f.prepare(); f.state.corrupt = mode;
    const result = await adapter.execute(f.args);
    expect(mode === 'READ' ? (await adapter.reconcile()).status : result.status).toBe('UNKNOWN'); adapter.dispose();
  });
  it.each(['clock-before', 'clock-after'])('rejects %s even with internally consistent recomputed evidence and receipt', async mode => {
    const f = await fixture(), adapter = f.prepare(); f.state.corrupt = mode;
    expect((await adapter.execute(f.args)).status).toBe('UNKNOWN'); adapter.dispose();
  });
  it('lost response allows only explicit readback, without a second approval or APPLY', async () => {
    const f = await fixture(), adapter = f.prepare(); f.state.lose = true;
    expect((await adapter.execute(f.args)).status).toBe('UNKNOWN');
    expect((await adapter.reconcile()).status).toBe('APPLIED');
    expect(f.rpc.mock.calls.filter(([, a]) => a.p_mode === 'APPLY')).toHaveLength(1);
    expect(approval).toHaveBeenCalledOnce(); adapter.dispose();
  });
  it('timeout aborts the observation, does not claim rollback, and only explicit READ resolves it', async () => {
    const f = await fixture(), adapter = f.prepare(); f.state.stall = true; vi.useFakeTimers();
    const pending = adapter.execute(f.args); await vi.advanceTimersByTimeAsync(51);
    expect((await pending).status).toBe('UNKNOWN'); expect(f.rpc.mock.calls.at(-1)?.[2].aborted).toBe(true);
    expect((await adapter.reconcile()).status).toBe('APPLIED'); adapter.dispose();
  });
  it('rejects concurrent calls, disposed payload, clones and already transferred handles', async () => {
    const f = await fixture(); expect(() => takeResetTemplateHandover({ ...f.owner }, f.input.commitment)).toThrow();
    const adapter = f.prepare(); expect(() => f.prepare()).toThrow();
    const p = adapter.execute(f.args); expect((await adapter.execute(f.args)).status).toBe('UNKNOWN'); await p;
    adapter.dispose(); const count = f.rpc.mock.calls.length;
    expect((await adapter.reconcile()).status).toBe('UNKNOWN'); expect(f.rpc).toHaveBeenCalledTimes(count);
  });
  it.each(['PRECHECK', 'CREATE'])('dispose during %s prevents every later phase, without claiming remote rollback', async mode => {
    const f = await fixture(), adapter = f.prepare(), original = required(f.rpc.getMockImplementation());
    let release = () => {}, entered = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const observed = new Promise<void>(resolve => { entered = resolve; });
    f.rpc.mockImplementation(async (...args) => {
      if (args[1].p_mode === mode) { entered(); await gate; }
      return original(...args);
    });
    const pending = adapter.execute(f.args); await observed; adapter.dispose(); release();
    expect((await pending).status).toBe('UNKNOWN');
    expect(f.rpc.mock.calls.at(-1)?.[1].p_mode).toBe(mode);
    if (mode === 'PRECHECK') { expect(approval).not.toHaveBeenCalled(); expect(f.rpc.mock.calls.at(-1)?.[2].aborted).toBe(true); }
    else expect(approval).toHaveBeenCalledOnce();
    expect((await adapter.reconcile()).status).toBe('UNKNOWN');
  });
  it('transport cannot mutate the privately retained payload or receipt header between calls', async () => {
    const f = await fixture(), adapter = f.prepare(), original = required(f.rpc.getMockImplementation());
    f.rpc.mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[1].p_mode === 'PRECHECK') {
        expect(Reflect.set(args[1].p_header as object, 'expiresAt', 1)).toBe(false);
        expect(Reflect.set(args[1].p_payload as object, 'templates', [])).toBe(false);
      }
      return result;
    });
    expect((await adapter.execute(f.args)).status).toBe('APPLIED'); adapter.dispose();
  });
  it('expiry closes the owner payload without RPC or approval consumption', async () => {
    const f = await fixture(); f.input.settings.expiresAt = Date.now() + 100; const adapter = f.prepare();
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 101);
    expect((await adapter.execute(f.args)).status).toBe('UNKNOWN');
    expect(f.rpc).not.toHaveBeenCalled(); expect(approval).not.toHaveBeenCalled(); adapter.dispose();
  });
  it('never reads settings accessors or accepts expired/mutated transport target', async () => {
    const f = await fixture(); const getter = vi.fn(() => 1000);
    Object.defineProperty(f.input.settings, 'expiresAt', { get: getter });
    expect(() => f.prepare()).toThrow(); expect(getter).not.toHaveBeenCalled(); f.owner.dispose();
    const other = await fixture(); other.options.supabaseUrl = 'https://other.example/'; expect(() => other.prepare()).toThrow();
  });
  it('public import has no activation switch; added execute fields cannot enable it', async () => {
    const f = await fixture(), adapter = prepareResetTemplateHandover(f.options, f.input);
    expect(await adapter.execute({ ...f.args, activation: true, backupVerified: true })).toMatchObject({ status: 'ACTIVATION_REQUIRED' });
    expect(f.rpc).not.toHaveBeenCalled(); expect(approval).not.toHaveBeenCalled(); adapter.dispose();
  });
});
