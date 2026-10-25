import { afterEach, describe, expect, it, vi } from 'vitest';
import { createResetPlanRevalidation, captureResetPlanContent, captureResetPlanTemplate,
  resetPlanTemplateDependencies } from '../src/modules/developer-reset/plan-revalidation.js';
import { inspectResetReadOnlyReview } from '../src/modules/developer-reset/snapshot-read-source.js';
import type { buildTemplateReseedProposal } from '../src/modules/developer-reset/template-plan-builder.js';

vi.mock('../src/modules/developer-reset/snapshot-read-source.js', () => ({ inspectResetReadOnlyReview: vi.fn() }));
const closed = vi.mocked(inspectResetReadOnlyReview);
const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const h = (c: string) => c.repeat(64);
const required = <T>(value: T | null | undefined): T => { if (value === null || value === undefined) throw new Error('fixture missing'); return value; };
const blank = async () => { throw new Error('The pure orchestration fixture must not connect'); };
const owners: ReturnType<typeof createResetPlanRevalidation>[] = [];
afterEach(() => { for (const owner of owners) owner.dispose(); owners.length = 0; vi.restoreAllMocks(); vi.useRealTimers(); closed.mockReset(); });
function fixture() {
  const input = { source: 'fixed source catalog' }, request = { policy: 'explicit selection', expiresAt: Date.now() + 60000 };
  const expected = { source: 'source binding', columns: ['id', 'payload'] };
  const rows = [{ relation: 'public.example', key: h('a'), keyFields: ['id'], disposition: 'keep' as const,
    values: [{ name: 'id', pgType: 'pg_catalog.uuid', value: id(1) }, { name: 'payload', pgType: 'pg_catalog.text', value: 'synthetic private content' }] }];
  const registrationTime = new Date().toISOString();
  const plan = { developerId: id(2), registrationTime, sourceComplete: true, referencesComplete: true,
    sources: [], references: [], replacements: [{ sourceId: id(3), newId: id(4), createdBy: id(2), createdAt: registrationTime,
      reason: 'OPERATIONAL_HANDOVER_INITIALIZATION', content: { private: 'synthetic plan content' } }] };
  let count = 0;
  const state = { mutatePlan: false, invalid: false, omitContent: false, omitPlan: false, blocker: 'POLICY_UNDECIDED', seenTokens: [] as object[] };
  closed.mockImplementation(async (_input, _request, _open, _signal, token) => {
    if (!token) throw new Error('missing private token'); state.seenTokens.push(token);
    if (!state.omitContent) captureResetPlanContent(token, expected, _request, rows);
    const deps = resetPlanTemplateDependencies(token);
    const current = structuredClone(plan);
    if (deps) {
      current.registrationTime = deps.now().toISOString();
      for (const row of current.replacements) { row.newId = deps.newId(); row.createdAt = current.registrationTime; }
    }
    if (state.mutatePlan) required(current.replacements[0]).newId = id(5);
    if (!state.omitPlan) captureResetPlanTemplate(token, { generated: true, plan: current } as unknown as ReturnType<typeof buildTemplateReseedProposal>);
    return { blockers: [state.blocker], review: state.invalid ? null : { reviewPrepared: true, contentVerified: true,
      planFingerprint: h(String(++count)), blockers: [state.blocker] } } as Awaited<ReturnType<typeof inspectResetReadOnlyReview>>;
  });
  const owner = createResetPlanRevalidation({ expiresAt: request.expiresAt }); owners.push(owner);
  return { owner, input, request, expected, rows, state, plan, prepare: () => owner.prepare(input, request, blank), recheck: () => owner.recheck(input, request, blank) };
}

describe('bounded reset plan revalidation lifecycle (inert closed-collector seam)', () => {
  it('keeps original allocations/plan identity across observations and consumes only once without execution authority', async () => {
    const f = fixture(); const first = await f.prepare();
    expect(first.status).toBe('PREPARED');
    const second = await f.recheck(); expect(second.status).toBe('MATCHED');
    expect(second.summary).toEqual(first.summary);
    expect(second).toMatchObject({ executionEnabled: false, liveDatabaseVerified: false, completeResetCoverage: false });
    expect(f.owner.consume(required(first.summary).commitment).status).toBe('CONSUMED');
    expect(f.owner.consume(required(first.summary).commitment).status).toBe('REJECTED');
    const text = JSON.stringify([first, second]);
    expect(text).not.toContain('synthetic private'); expect(text).not.toContain('synthetic plan'); expect(text).not.toContain(id(4));
  });
  it.each(['content', 'key', 'disposition', 'catalog', 'request', 'source', 'plan', 'blocker'])('rejects %s drift and closes the session', async mode => {
    const f = fixture(); await f.prepare();
    if (mode === 'content') required(required(f.rows[0]).values[1]).value = 'same count different content';
    if (mode === 'key') required(required(f.rows[0]).values[0]).value = id(9);
    if (mode === 'disposition') required(f.rows[0]).disposition = 'remove' as 'keep';
    if (mode === 'catalog') f.expected.columns.push('extra');
    if (mode === 'request') f.request.policy = 'another policy';
    if (mode === 'source') f.input.source = 'another source';
    if (mode === 'plan') f.state.mutatePlan = true;
    if (mode === 'blocker') f.state.blocker = 'DRAIN_EXPIRED';
    expect((await f.recheck()).status).toBe('REJECTED');
    expect((await f.recheck()).status).toBe('REJECTED');
  });
  it.each(['invalid', 'omitContent', 'omitPlan'])('cannot treat a %s returned summary as trusted comparison evidence', async mode => {
    const f = fixture(); f.state[mode as 'invalid' | 'omitContent' | 'omitPlan'] = true;
    expect((await f.prepare()).status).toBe('REJECTED');
  });
  it('rejects forged and replayed private capture tokens', async () => {
    const f = fixture(); expect(() => captureResetPlanContent({}, {}, {}, [])).toThrow('RESET_PLAN_REVALIDATION_REJECTED');
    await f.prepare(); expect(() => resetPlanTemplateDependencies(required(f.state.seenTokens[0]))).toThrow('RESET_PLAN_REVALIDATION_REJECTED');
  });
  it('rejects wrong confirmation and cannot consume before comparison', async () => {
    const f = fixture(); const prepared = await f.prepare();
    expect(f.owner.consume(required(prepared.summary).commitment).status).toBe('REJECTED');
    expect((await f.recheck()).status).toBe('REJECTED');
  });
  it('does not accept a different session commitment', async () => {
    const f = fixture(); await f.prepare(); await f.recheck();
    expect(f.owner.consume(h('f')).status).toBe('REJECTED');
  });
  it('expires an idle session without selecting a policy TTL', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.prepare();
    await vi.advanceTimersByTimeAsync(60000);
    expect((await f.recheck()).status).toBe('REJECTED'); expect(closed).toHaveBeenCalledOnce();
  });
  it('disposal and cancellation do not reopen or call the collector again', async () => {
    const f = fixture(); await f.prepare(); f.owner.dispose();
    expect((await f.recheck()).status).toBe('REJECTED'); expect(closed).toHaveBeenCalledOnce();
  });
  it('rejects a concurrent observation and invalidates the first in-flight result', async () => {
    const f = fixture(); const original = required(closed.getMockImplementation());
    let release = () => {}; const barrier = new Promise<void>(resolve => { release = resolve; });
    closed.mockImplementation(async (...args) => { await barrier; return original(...args); });
    const first = f.prepare(); expect((await f.prepare()).status).toBe('REJECTED'); release();
    expect((await first).status).toBe('REJECTED'); expect(closed).toHaveBeenCalledOnce();
  });
  it('masks transport errors and never treats timeout as remote rollback', async () => {
    const f = fixture(); closed.mockRejectedValue(new Error('synthetic private provider error'));
    const result = await f.prepare(); expect(result.status).toBe('REJECTED'); expect(JSON.stringify(result)).not.toContain('provider');
  });
  it.each([0, NaN, Infinity, -1])('rejects invalid explicit expiry %s', expiresAt => {
    expect(() => createResetPlanRevalidation({ expiresAt })).toThrow('RESET_PLAN_REVALIDATION_REJECTED');
  });
  it('never invokes expiry accessors and rejects extra fields/noninteger/out-of-range options', () => {
    vi.useFakeTimers();
    let calls = 0;
    expect(() => createResetPlanRevalidation({ get expiresAt() { calls++; return Date.now() + 60000; } })).toThrow('RESET_PLAN_REVALIDATION_REJECTED');
    expect(calls).toBe(0);
    for (const options of [null, [], {}, { expiresAt: Date.now() + 60000, extra: true },
      { expiresAt: Date.now() + 0.5 }, { expiresAt: Date.now() + 2_147_483_648 }, { expiresAt: 'never' }]) {
      expect(() => createResetPlanRevalidation(options)).toThrow('RESET_PLAN_REVALIDATION_REJECTED');
    }
  });
  it('fixes the explicit lifetime before returning the session', async () => {
    const f = fixture(); const options = { expiresAt: Date.now() + 60000 };
    const owner = createResetPlanRevalidation(options); owners.push(owner); options.expiresAt = 1;
    expect((await owner.prepare(f.input, f.request, blank)).status).toBe('PREPARED');
  });
});
