import { z } from 'zod';
import { requestHash } from '../../lib/command.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const time = z.number().int().min(0).max(8640000000000000);
const step = z.object({ id: hash, kind: z.enum(['DATABASE', 'AUTH', 'EXTERNAL']) }).strict();
const binding = z.object({
  actorProfileId: z.uuid(), authUserId: z.uuid(), sessionDigest: hash, passwordVersionDigest: hash,
  projectRef: z.string().regex(/^[a-z]{20}$/), sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  catalogFingerprint: hash, contentFingerprint: hash, planFingerprint: hash,
  expectedPostconditionFingerprint: hash, policyHash: hash, approvalScopeHash: hash, backupProofHash: hash,
}).strict();
const command = z.object({ binding, idempotencyKeyDigest: hash,
  createdAt: time, expiresAt: time, steps: z.array(step).min(1).max(100) }).strict();
const start = z.object({ type: z.literal('STARTED'), stepId: hash, bindingHash: hash }).strict();
const observed = z.object({ type: z.literal('OBSERVED'), stepId: hash,
  outcome: z.enum(['APPLIED', 'NOT_APPLIED', 'UNKNOWN']), evidenceHash: hash.nullable() }).strict();
const verified = z.object({ type: z.literal('FINAL_VERIFIED'),
  postconditionFingerprint: hash, evidenceHash: hash, remoteQuiescent: z.literal(true) }).strict();
const event = z.discriminatedUnion('type', [start, observed, verified]);
const entry = z.object({ sequence: z.number().int().min(1).max(1000), at: time,
  previousHash: hash, event, hash }).strict();
const header = z.object({ format: z.literal('reset-receipt-v1'), commandHash: hash, bindingHash: hash,
  idempotencyKeyDigest: hash, expectedPostconditionFingerprint: hash,
  createdAt: time, expiresAt: time, steps: z.array(step).min(1).max(100) }).strict();
const receipt = header.extend({ events: z.array(entry).max(1000) }).strict();
export type ResetReceipt = z.infer<typeof receipt>;
type Event = z.infer<typeof event>;
type StepState = 'PENDING' | 'STARTED' | 'APPLIED' | 'NOT_APPLIED' | 'UNKNOWN';
class ReceiptError extends Error { constructor(readonly code: string) { super(code); } }
const fail = (code: string): never => { throw new ReceiptError(code); };
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : fail('RESET_RECEIPT_INPUT_INVALID');
}
function digestEntry(value: Omit<z.infer<typeof entry>, 'hash'>) { return requestHash(value); }
function headerValue(r: ResetReceipt) { const { events: _events, ...value } = r; return header.parse(value); }
function commandValue(c: z.infer<typeof command>) {
  return { bindingHash: requestHash(c.binding), idempotencyKeyDigest: c.idempotencyKeyDigest,
    expectedPostconditionFingerprint: c.binding.expectedPostconditionFingerprint,
    createdAt: c.createdAt, expiresAt: c.expiresAt, steps: c.steps };
}
function head(r: ResetReceipt): string {
  return r.events.at(-1)?.hash ?? requestHash(headerValue(r));
}
function checkHeader(r: ResetReceipt) {
  if (r.expiresAt <= r.createdAt || new Set(r.steps.map(s => s.id)).size !== r.steps.length) fail('RESET_RECEIPT_INPUT_INVALID');
  const { format: _format, commandHash, ...value } = headerValue(r);
  if (commandHash !== requestHash(value)) fail('RESET_RECEIPT_HEADER_CHANGED');
}

/** Pure internal journal model. It neither verifies human authorization nor
 * calls a DB/provider. A durable store must separately enforce append-only CAS,
 * per-actor/project idempotency uniqueness and trusted readback provenance. */
export function createResetReceipt(input: unknown, now: number): ResetReceipt {
  const c = parse(command, input); parse(time, now);
  if (c.createdAt !== now || c.expiresAt <= now || new Set(c.steps.map(s => s.id)).size !== c.steps.length) {
    return fail('RESET_RECEIPT_INPUT_INVALID');
  }
  const value = commandValue(c);
  return { format: 'reset-receipt-v1', commandHash: requestHash(value), ...value, events: [] };
}

function replay(input: unknown, now: number) {
  const r = parse(receipt, input); parse(time, now); checkHeader(r);
  if (r.createdAt > now) fail('RESET_RECEIPT_TIME_INVALID');
  const states = new Map<string, StepState>(r.steps.map(s => [s.id, 'PENDING']));
  let previousHash = requestHash(headerValue(r));
  let lastAt = r.createdAt; let final = false;
  for (const [index, row] of r.events.entries()) {
    const { hash: actualHash, ...unsigned } = row;
    if (row.sequence !== index + 1 || row.previousHash !== previousHash || digestEntry(unsigned) !== actualHash) fail('RESET_RECEIPT_CHAIN_INVALID');
    if (row.at < lastAt || row.at > now) fail('RESET_RECEIPT_TIME_INVALID');
    if (final) fail('RESET_RECEIPT_TERMINAL');
    const e = row.event;
    if (e.type === 'STARTED') {
      if (row.at >= r.expiresAt) fail('RESET_RECEIPT_EXPIRED');
      if (e.bindingHash !== r.bindingHash) fail('RESET_RECEIPT_BINDING_CHANGED');
      const next = r.steps.find(s => states.get(s.id) !== 'APPLIED');
      if (!next || next.id !== e.stepId || states.get(e.stepId) !== 'PENDING') fail('RESET_RECEIPT_STEP_ORDER');
      states.set(e.stepId, 'STARTED');
    } else if (e.type === 'OBSERVED') {
      const state = states.get(e.stepId);
      if (state !== 'STARTED' && state !== 'UNKNOWN') fail('RESET_RECEIPT_OBSERVATION_REJECTED');
      if ((e.outcome === 'UNKNOWN') !== (e.evidenceHash === null)) fail('RESET_RECEIPT_EVIDENCE_REQUIRED');
      states.set(e.stepId, e.outcome);
    } else {
      if ([...states.values()].some(s => s !== 'APPLIED')) fail('RESET_RECEIPT_INCOMPLETE');
      if (e.postconditionFingerprint !== r.expectedPostconditionFingerprint) fail('RESET_RECEIPT_POSTCONDITION_CHANGED');
      final = true;
    }
    previousHash = actualHash; lastAt = row.at;
  }
  const values = [...states.values()];
  const expired = now >= r.expiresAt;
  const status = final ? 'VERIFIED' : values.includes('UNKNOWN') || (expired && values.includes('STARTED')) ? 'UNKNOWN'
    : values.includes('NOT_APPLIED') ? 'FAILED' : expired ? 'EXPIRED'
      : values.includes('STARTED') || values.includes('APPLIED') ? 'RUNNING' : 'PREPARED';
  return { r, status, states, expired, final };
}

/** Appends a new event; the original receipt is never mutated. expectedVersion
 * detects stale in-memory proposals but is not a substitute for durable DB CAS.
 * An expired/unknown effect may be observed, never automatically started again. */
export function appendResetReceipt(input: unknown, observation: unknown, options: { expectedVersion: number; now: number }): ResetReceipt {
  const current = replay(input, options.now);
  if (!Number.isSafeInteger(options.expectedVersion) || options.expectedVersion !== current.r.events.length) fail('RESET_RECEIPT_STALE_VERSION');
  if (current.r.events.length >= 1000) fail('RESET_RECEIPT_EVENT_LIMIT');
  const nextEvent: Event = parse(event, observation);
  const unsigned = { sequence: current.r.events.length + 1, at: options.now, previousHash: head(current.r), event: nextEvent };
  const next = { ...current.r, events: [...current.r.events, { ...unsigned, hash: digestEntry(unsigned) }] };
  replay(next, options.now);
  return next;
}

/** Same-key retry is observation-only: it returns no executable step or permit. */
export function inspectResetReceiptRetry(input: unknown, requestedCommand: unknown, now: number) {
  try {
    const { r } = replay(input, now); const c = parse(command, requestedCommand);
    if (r.idempotencyKeyDigest !== c.idempotencyKeyDigest) fail('RESET_RECEIPT_KEY_MISMATCH');
    if (r.commandHash !== requestHash(commandValue(c))) fail('RESET_RECEIPT_COMMAND_CHANGED');
    return { ...inspectResetReceipt(r, now), replay: true, retryExecutionAllowed: false };
  } catch (error) { return { ...blocked(error), replay: false, retryExecutionAllowed: false }; }
}

export function inspectResetReceipt(input: unknown, now: number) {
  try {
    const { r, status, states } = replay(input, now);
    const values = [...states.values()];
    return { valid: true, executionEnabled: false, status, version: r.events.length,
      counts: { total: values.length, applied: values.filter(s => s === 'APPLIED').length,
        notApplied: values.filter(s => s === 'NOT_APPLIED').length,
        unresolved: values.filter(s => s === 'STARTED' || s === 'UNKNOWN').length },
      partialEffects: values.includes('APPLIED') && status !== 'VERIFIED', blockers: [] as string[] };
  } catch (error) { return blocked(error); }
}
function blocked(error: unknown) {
  return { valid: false, executionEnabled: false, status: 'INVALID', version: null, counts: null,
    partialEffects: null, blockers: [error instanceof ReceiptError ? error.code : 'RESET_RECEIPT_INPUT_INVALID'] };
}
