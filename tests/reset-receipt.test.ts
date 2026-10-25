import { describe, expect, it } from 'vitest';
import { appendResetReceipt, createResetReceipt, inspectResetReceipt, inspectResetReceiptRetry, type ResetReceipt } from '../src/modules/developer-reset/reset-receipt.js';
const h = (v: string) => v.repeat(64);
const fixture = () => ({
  binding: { actorProfileId: '11111111-1111-4111-8111-111111111111', authUserId: '22222222-2222-4222-8222-222222222222',
    sessionDigest: h('a'), passwordVersionDigest: h('b'), projectRef: 'a'.repeat(20), sourceCommit: 'a'.repeat(40),
    catalogFingerprint: h('c'), contentFingerprint: h('d'), planFingerprint: h('e'), expectedPostconditionFingerprint: h('f'),
    policyHash: h('1'), approvalScopeHash: h('2'), backupProofHash: h('3') },
  idempotencyKeyDigest: h('4'), createdAt: 1000, expiresAt: 2000,
  steps: [{ id: h('5'), kind: 'DATABASE' as const }, { id: h('6'), kind: 'AUTH' as const }, { id: h('7'), kind: 'EXTERNAL' as const }],
});
const create = () => createResetReceipt(fixture(), 1000);
const append = (r: ResetReceipt, e: unknown, now = 1100) => appendResetReceipt(r, e, { expectedVersion: r.events.length, now });
const start = (r: ResetReceipt, n = 0, now = 1100) => append(r, { type: 'STARTED', stepId: r.steps[n]?.id, bindingHash: r.bindingHash }, now);
const observe = (r: ResetReceipt, n = 0, outcome = 'APPLIED', now = 1101) => append(r,
  { type: 'OBSERVED', stepId: r.steps[n]?.id, outcome, evidenceHash: outcome === 'UNKNOWN' ? null : h('8') }, now);
const applied = () => {
  let r = create();
  for (let n = 0; n < 3; n++) r = observe(start(r, n, 1100 + n * 2), n, 'APPLIED', 1101 + n * 2);
  return r;
};
const verify = (r: ResetReceipt, now = 1200) => append(r, { type: 'FINAL_VERIFIED',
  postconditionFingerprint: h('f'), evidenceHash: h('9'), remoteQuiescent: true }, now);

describe('nonexecuting reset-specific receipt journal', () => {
  it('requires explicit expiration and creates a redacted immutable command binding without approval authority', () => {
    const c = fixture(); const before = structuredClone(c); const r = createResetReceipt(c, 1000);
    expect(inspectResetReceipt(r, 1000)).toMatchObject({ valid: true, status: 'PREPARED', executionEnabled: false, version: 0 });
    expect(JSON.stringify(r)).not.toContain(c.binding.actorProfileId); expect(c).toEqual(before);
    c.steps[0]!.id = h('0'); expect(r.steps[0]?.id).toBe(h('5'));
    expect(() => createResetReceipt({ ...fixture(), expiresAt: undefined }, 1000)).toThrow('RESET_RECEIPT_INPUT_INVALID');
  });
  it('appends all ordered effects and requires a separate final readback before verification', () => {
    const r = applied(); const before = structuredClone(r);
    expect(inspectResetReceipt(r, 1200)).toMatchObject({ status: 'RUNNING', counts: { applied: 3 }, partialEffects: true });
    const final = verify(r);
    expect(inspectResetReceipt(final, 3000)).toMatchObject({ status: 'VERIFIED', executionEnabled: false, partialEffects: false });
    expect(r).toEqual(before);
    expect(() => verify(final, 1300)).toThrow('RESET_RECEIPT_TERMINAL');
  });
  it('same key and exact input replay returns observation only and never another execution', () => {
    for (const r of [create(), start(create()), applied(), verify(applied())]) {
      expect(inspectResetReceiptRetry(r, fixture(), 1300)).toMatchObject({ valid: true, replay: true, retryExecutionAllowed: false, executionEnabled: false });
    }
  });
  it.each(['actorProfileId', 'authUserId', 'sessionDigest', 'passwordVersionDigest', 'projectRef', 'sourceCommit',
    'catalogFingerprint', 'contentFingerprint', 'planFingerprint', 'expectedPostconditionFingerprint', 'policyHash', 'approvalScopeHash', 'backupProofHash'] as const)(
    'same-key changes to %s cannot reuse a receipt', field => {
      const c = fixture(); const old = c.binding[field]; c.binding[field] = old.includes('-') ? '33333333-3333-4333-8333-333333333333' : (old[0] === 'b' ? 'c' : 'b').repeat(old.length);
      const result = inspectResetReceiptRetry(create(), c, 1000);
      expect(result).toMatchObject({ valid: false, replay: false, retryExecutionAllowed: false });
    });
  it('rejects different idempotency keys, reordered plans and changed expiration', () => {
    const r = create();
    for (const c of [{ ...fixture(), idempotencyKeyDigest: h('9') }, { ...fixture(), expiresAt: 2100 }, { ...fixture(), steps: fixture().steps.reverse() }]) {
      expect(inspectResetReceiptRetry(r, c, 1000).valid).toBe(false);
    }
  });
  it('never equates timeout or HTTP success with applied effects', () => {
    const r = start(create());
    expect(inspectResetReceipt(r, 2000)).toMatchObject({ status: 'UNKNOWN', counts: { unresolved: 1 } });
    expect(() => observe(r, 0, 'HTTP_200')).toThrow('RESET_RECEIPT_INPUT_INVALID');
    expect(() => append(r, { type: 'OBSERVED', stepId: h('5'), outcome: 'APPLIED', evidenceHash: null })).toThrow('RESET_RECEIPT_EVIDENCE_REQUIRED');
    const unknown = observe(r, 0, 'UNKNOWN');
    expect(() => start(unknown, 0, 1200)).toThrow('RESET_RECEIPT_STEP_ORDER');
    expect(() => start(unknown, 1, 1200)).toThrow('RESET_RECEIPT_STEP_ORDER');
    expect(() => verify(unknown)).toThrow('RESET_RECEIPT_INCOMPLETE');
  });
  it('can append definitive readback after uncertainty or expiry but cannot start another effect', () => {
    const unknown = observe(start(create()), 0, 'UNKNOWN');
    const resolved = observe(unknown, 0, 'APPLIED', 2200);
    expect(inspectResetReceipt(resolved, 2200)).toMatchObject({ status: 'EXPIRED', partialEffects: true, counts: { applied: 1 } });
    expect(() => start(resolved, 1, 2200)).toThrow('RESET_RECEIPT_EXPIRED');
    expect(() => observe(resolved, 0, 'NOT_APPLIED', 2300)).toThrow('RESET_RECEIPT_OBSERVATION_REJECTED');
    expect(inspectResetReceipt(verify(applied(), 2200), 2200).status).toBe('VERIFIED');
  });
  it('never hides a partially applied reset after a later confirmed failure', () => {
    const r = observe(start(observe(start(create())), 1, 1102), 1, 'NOT_APPLIED', 1103);
    expect(inspectResetReceipt(r, 1200)).toMatchObject({ status: 'FAILED', partialEffects: true, counts: { applied: 1, notApplied: 1 } });
    expect(() => start(r, 1, 1200)).toThrow('RESET_RECEIPT_STEP_ORDER');
    expect(() => start(r, 2, 1200)).toThrow('RESET_RECEIPT_STEP_ORDER');
  });
  it('requires the next exact step, unchanged binding and current journal version', () => {
    const r = create();
    expect(() => start(r, 1)).toThrow('RESET_RECEIPT_STEP_ORDER');
    expect(() => append(r, { type: 'STARTED', stepId: h('5'), bindingHash: h('9') })).toThrow('RESET_RECEIPT_BINDING_CHANGED');
    expect(() => appendResetReceipt(r, { type: 'STARTED', stepId: h('5'), bindingHash: r.bindingHash }, { expectedVersion: 1, now: 1100 })).toThrow('RESET_RECEIPT_STALE_VERSION');
    expect(() => observe(r)).toThrow('RESET_RECEIPT_OBSERVATION_REJECTED');
  });
  it('requires exact final postconditions and independently observed remote quiescence', () => {
    const r = applied();
    expect(() => append(r, { type: 'FINAL_VERIFIED', postconditionFingerprint: h('0'), evidenceHash: h('9'), remoteQuiescent: true }, 1200)).toThrow('RESET_RECEIPT_POSTCONDITION_CHANGED');
    expect(() => append(r, { type: 'FINAL_VERIFIED', postconditionFingerprint: h('f'), evidenceHash: h('9'), remoteQuiescent: false }, 1200)).toThrow('RESET_RECEIPT_INPUT_INVALID');
  });
  it('detects changed headers, missing/reordered/tampered events and future/backdated time', () => {
    const r = applied();
    const variants = [structuredClone(r), structuredClone(r), structuredClone(r), structuredClone(r)];
    variants[0]!.expiresAt++; variants[1]!.events.shift(); variants[2]!.events.reverse(); variants[3]!.events[0]!.event = { type: 'STARTED', stepId: h('9'), bindingHash: r.bindingHash };
    for (const v of variants) expect(inspectResetReceipt(v, 1200).valid).toBe(false);
    expect(inspectResetReceipt(r, 1000)).toMatchObject({ valid: false, blockers: ['RESET_RECEIPT_TIME_INVALID'] });
    expect(() => observe(start(create()), 0, 'APPLIED', 1050)).toThrow('RESET_RECEIPT_TIME_INVALID');
    expect(inspectResetReceipt(create(), 2000).status).toBe('EXPIRED');
  });
  it('returns only fixed errors and aggregate status, never arbitrary input or row identifiers', () => {
    const invalid = inspectResetReceipt({ private: 'synthetic-private-data' }, 1000);
    expect(JSON.stringify(invalid)).not.toContain('synthetic-private-data');
    expect(inspectResetReceipt(null, 1000).valid).toBe(false);
    const r = start(create()); const output = JSON.stringify(inspectResetReceipt(r, 1200));
    for (const value of [r.commandHash, r.bindingHash, r.idempotencyKeyDigest, h('5')]) expect(output).not.toContain(value);
  });
  it('does not claim a pure hash-chain prefix proves the durable latest head', () => {
    const final = verify(applied());
    const prefix = { ...final, events: final.events.slice(0, -1) };
    expect(inspectResetReceipt(prefix, 1200)).toMatchObject({ valid: true, status: 'RUNNING', executionEnabled: false });
    expect(inspectResetReceipt(final, 1200).status).toBe('VERIFIED');
    // Detecting this rollback requires a separately trusted durable head/version.
    // Neither prefix validation nor same-key retry grants execution permission.
    expect(inspectResetReceiptRetry(prefix, fixture(), 1200).retryExecutionAllowed).toBe(false);
  });
});
