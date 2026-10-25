import { createHash } from 'node:crypto';
import { z } from 'zod';
import { requestHash } from '../../lib/command.js';
import { appendResetReceipt, createResetReceipt, inspectResetReceiptRetry, type ResetReceipt } from './reset-receipt.js';
import type { ResetPreviewRpc } from './reset-preview.js';

const hex = z.string().regex(/^[a-f0-9]{64}$/);
const anchorSchema = z.object({ commandHash: hex, version: z.number().int().min(0).max(1000), headHash: hex }).strict();
export type ResetReceiptAnchor = z.infer<typeof anchorSchema>;
export type ResetReceiptStoreResult =
  | { status: 'CONFIRMED'; receipt: ResetReceipt; anchor: ResetReceiptAnchor; executionEnabled: false; retryExecutionAllowed: false }
  | { status: 'UNKNOWN'; executionEnabled: false; retryExecutionAllowed: false };
export class ResetReceiptStoreError extends Error {
  constructor() { super('RESET_RECEIPT_STORE_INPUT_REJECTED'); }
}
const reject = (): never => { throw new ResetReceiptStoreError(); };
const unknown = (): ResetReceiptStoreResult => ({ status: 'UNKNOWN', executionEnabled: false, retryExecutionAllowed: false });
const digest = (value: string) => createHash('sha256').update(`developer-operation-v1:${value}`).digest('hex');
function header(receipt: ResetReceipt) { const { events: _events, ...value } = receipt; return value; }
export function resetReceiptAnchor(receipt: ResetReceipt): ResetReceiptAnchor {
  return { commandHash: receipt.commandHash, version: receipt.events.length,
    headHash: receipt.events.at(-1)?.hash ?? requestHash(header(receipt)) };
}

/** Server-internal persistence only. RPC checks live authority itself. An injected
 * RPC transport is trusted infrastructure, never an HTTP caller or approval proof.
 * No method executes a reset step, changes policy, supplies TTL or replays a write. */
export function createSupabaseResetReceiptStore(options: {
  rpc: ResetPreviewRpc;
  supabaseUrl: string;
  projectRef: string;
  actorProfileId: string;
  authUserId: string;
  sessionId: string;
  timeoutMs: number;
}) {
  options = { ...options };
  const identity = z.object({ actorProfileId: z.uuid(), authUserId: z.uuid(), sessionId: z.uuid(),
    projectRef: z.string().regex(/^[a-z]{20}$/), timeoutMs: z.number().int().min(1).max(7000) }).strict().safeParse({
    actorProfileId: options.actorProfileId, authUserId: options.authUserId, sessionId: options.sessionId,
    projectRef: options.projectRef, timeoutMs: options.timeoutMs,
  });
  if (!identity.success) reject();
  let url: URL;
  try { url = new URL(options.supabaseUrl); } catch { return reject(); }
  if (url.protocol !== 'https:' || url.hostname !== `${options.projectRef}.supabase.co` || url.port || url.username
    || url.password || url.pathname !== '/' || url.search || url.hash) reject();
  // Local uncertainty is sticky until an explicit successful READ. This latch is
  // not a durable cross-process permit; SQL CAS remains authoritative on restart.
  const uncertain = new Map<string, ResetReceiptAnchor>();
  const known = new Map<string, ResetReceiptAnchor>();
  // One factory instance owns one receipt key and one in-flight RPC. No growing
  // per-actor cache and no reversed responses can lower a previously seen head.
  let boundKey: string | undefined;
  let busy = false;
  function prepare(command: unknown, now: number) {
    if (!command || typeof command !== 'object' || Array.isArray(command)) return reject();
    const c = command as Record<string, unknown>;
    const genesis = createResetReceipt(c, c.createdAt as number);
    if (!inspectResetReceiptRetry(genesis, command, now).valid) return reject();
    const b = c.binding as Record<string, unknown>;
    if (b.actorProfileId !== options.actorProfileId || b.authUserId !== options.authUserId
      || b.projectRef !== options.projectRef || b.sessionDigest !== digest(options.sessionId)) return reject();
    return { genesis, binding: structuredClone(b) };
  }
  function checkAnchor(value: unknown, expected: ResetReceipt, latest?: ResetReceiptAnchor) {
    const parsed = anchorSchema.safeParse(value);
    if (!parsed.success || parsed.data.commandHash !== expected.commandHash) return reject();
    if (latest && (parsed.data.version < latest.version
      || (parsed.data.version === latest.version && parsed.data.headHash !== latest.headHash))) return reject();
    return parsed.data;
  }
  function matchesPrefix(receipt: ResetReceipt, anchor: ResetReceiptAnchor) {
    const actual = anchor.version === 0 ? requestHash(header(receipt)) : receipt.events[anchor.version - 1]?.hash;
    return receipt.commandHash === anchor.commandHash && receipt.events.length >= anchor.version && actual === anchor.headHash;
  }
  async function call(mode: 'CREATE' | 'READ' | 'APPEND', command: unknown, now: number,
    anchorInput?: ResetReceiptAnchor, proposal?: ResetReceipt): Promise<ResetReceiptStoreResult> {
    const { genesis, binding } = prepare(command, now);
    const key = genesis.idempotencyKeyDigest;
    if (boundKey !== undefined && boundKey !== key) return reject();
    boundKey = key;
    const anchor = checkAnchor(anchorInput ?? resetReceiptAnchor(genesis), genesis, known.get(key));
    if (busy) return unknown();
    if (mode !== 'READ' && uncertain.has(key)) return unknown();
    busy = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // One RPC invocation only. Abort bounds observation; it cannot prove remote rollback.
      const result = await Promise.race([
        Promise.resolve().then(() => options.rpc('store_developer_reset_receipt', {
          p_mode: mode, p_actor: options.actorProfileId, p_auth: options.authUserId, p_session: options.sessionId,
          p_binding: binding, p_header: header(genesis), p_expected_version: anchor.version,
          p_expected_head: anchor.headHash, p_entry: proposal?.events.at(-1) ?? null,
        }, controller.signal)),
        new Promise<never>((_, fail) => { timer = setTimeout(() => { controller.abort(); fail(new Error()); }, options.timeoutMs); }),
      ]);
      if (controller.signal.aborted || result.error) throw new Error();
      const envelope = z.object({ format: z.literal('reset-receipt-store-v1'), receipt: z.unknown(),
        anchor: anchorSchema, executionEnabled: z.literal(false) }).strict().parse(result.data);
      if (!inspectResetReceiptRetry(envelope.receipt, command, now).valid) throw new Error();
      const received = envelope.receipt as ResetReceipt;
      const unresolved = uncertain.get(key);
      const latest = known.get(key);
      if (requestHash(envelope.anchor) !== requestHash(resetReceiptAnchor(received)) || !matchesPrefix(received, anchor)
        || (proposal && requestHash(received) !== requestHash(proposal))
        || (latest && !matchesPrefix(received, latest))
        || (unresolved && !matchesPrefix(received, unresolved))) throw new Error();
      // Clone all returned data: caller mutation cannot alter this store's trusted anchor.
      known.set(key, structuredClone(envelope.anchor));
      uncertain.delete(key);
      return { status: 'CONFIRMED', receipt: structuredClone(received), anchor: structuredClone(envelope.anchor),
        executionEnabled: false, retryExecutionAllowed: false };
    } catch {
      // An old READ snapshot cannot settle an earlier timed-out write that may
      // still commit later. Only its exact proposed prefix resolves this latch.
      if (!uncertain.has(key)) uncertain.set(key, proposal ? resetReceiptAnchor(proposal) : anchor);
      return unknown();
    } finally { if (timer !== undefined) clearTimeout(timer); busy = false; }
  }
  return {
    create(command: unknown, now: number) { return call('CREATE', command, now); },
    read(command: unknown, anchor: ResetReceiptAnchor, now: number) { return call('READ', command, now, anchor); },
    append(command: unknown, current: ResetReceipt, event: unknown, input: { anchor: ResetReceiptAnchor; now: number }) {
      const { genesis } = prepare(command, input.now);
      if (!inspectResetReceiptRetry(current, command, input.now).valid) return reject();
      const anchor = checkAnchor(input.anchor, genesis, known.get(genesis.idempotencyKeyDigest));
      if (requestHash(anchor) !== requestHash(resetReceiptAnchor(current))) return reject();
      const proposal = appendResetReceipt(current, event, { expectedVersion: anchor.version, now: input.now });
      return call('APPEND', command, input.now, anchor, proposal);
    },
  };
}
