import { createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { copyMigrationData } from '../../../scripts/lib/migration-evidence-input.mjs';
import { requestHash } from '../../lib/command.js';
import { inspectResetReadOnlyReview, type OpenResetReadClient } from './snapshot-read-source.js';
import { inspectResetNativeReview } from './snapshot-native-postgres.js';
import type { ReviewRow } from './review-composition.js';
import type { buildTemplateReseedProposal } from './template-plan-builder.js';

type Proposal = ReturnType<typeof buildTemplateReseedProposal>;
type Phase = 'NEW' | 'PREPARING' | 'PREPARED' | 'CHECKING' | 'CHECKED' | 'CLOSED';
type Blueprint = { ids: string[]; time: string; digest: string };
type Session = { phase: Phase; secret: Buffer; expiresAt: number; deadline: number;
  inputHash?: string; content?: string; blueprint?: Blueprint; summary?: Summary;
  effectSource?: unknown; effectContentFingerprint?: string; effectRows?: ReviewRow[]; effectProposal?: Proposal;
  contentSeen: boolean; proposalSeen: boolean; controller?: AbortController; timer?: ReturnType<typeof setTimeout> };
type Summary = { commitment: string; reviewedPlanFingerprint: string; blockers: string[] };
const captures = new WeakMap<object, Session>();
const sessions = new WeakMap<object, Session>();
const reject = (): never => { throw new Error('RESET_PLAN_REVALIDATION_REJECTED'); };
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const flags = { executionEnabled: false as const, liveDatabaseVerified: false as const, completeResetCoverage: false as const };
const reviewSummarySchema = z.object({ reviewPrepared: z.literal(true), contentVerified: z.literal(true),
  planFingerprint: z.string().regex(/^[a-f0-9]{64}$/), blockers: z.array(z.string().max(128)).max(1000) });
const failed = () => ({ ...flags, status: 'REJECTED' as const, revalidated: false as const, summary: null });
function close(session: Session) {
  session.phase = 'CLOSED'; session.secret.fill(0); delete session.blueprint;
  delete session.effectSource; delete session.effectContentFingerprint; delete session.effectRows; delete session.effectProposal;
  session.controller?.abort(); if (session.timer) clearTimeout(session.timer);
}
function live(session: Session) {
  if (session.phase === 'CLOSED' || Date.now() >= session.expiresAt || performance.now() >= session.deadline) {
    close(session); reject();
  }
}
function owned(token: object) {
  const session = captures.get(token); if (!session) return reject(); live(session);
  if (session.phase !== 'PREPARING' && session.phase !== 'CHECKING') return reject();
  return session;
}
function digest(session: Session, purpose: string, value: unknown) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, 'utf8') > 16 * 1024 * 1024) return reject();
  return createHmac('sha256', session.secret).update(`reset-plan-revalidation-v1:${purpose}:`).update(text).digest('hex');
}

/** Internal seam only. Tokens are never returned by the public session factory.
 * The builder calls this after independent content/census and technical FK checks.
 * No caller-provided Boolean or snapshot hash substitutes for those checks. */
export function captureResetPlanContent(token: object, expected: unknown, request: unknown, rows: ReviewRow[]) {
  const session = owned(token); if (session.contentSeen) return reject();
  session.contentSeen = true;
  const normalized = rows.map(row => {
    const values = [...row.values].sort((a, b) => order(a.name, b.name));
    const key = row.keyFields.map(name => values.find(cell => cell.name === name));
    if (key.some(cell => !cell)) return reject();
    return { relation: row.relation, key, values, disposition: row.disposition };
  }).sort((a, b) => order(a.relation, b.relation) || order(JSON.stringify(a.key), JSON.stringify(b.key)));
  // expected binds complete catalog/column/key/FK structure, not transient RR IDs.
  const content = digest(session, 'content', { expected, request, rows: normalized });
  if (session.phase === 'PREPARING') session.content = content;
  else if (content !== session.content) return reject();
  if (session.phase === 'PREPARING') session.effectSource = copyMigrationData(expected);
  else session.effectRows = copyMigrationData(rows.filter(row =>
    row.relation === 'public.cleaning_template_versions' || row.relation === 'private.photo_template_slots')) as ReviewRow[];
}

/** Only the composition can obtain these functions with its private capture token.
 * A second observation reuses allocations; it never allocates new UUIDs/time. */
export function resetPlanTemplateDependencies(token: object) {
  const session = owned(token); if (!session.contentSeen) return reject();
  if (session.phase === 'PREPARING') return undefined;
  const blueprint = session.blueprint; if (!blueprint) return reject();
  let offset = 0;
  return { now: () => new Date(blueprint.time), newId: () => blueprint.ids[offset++] ?? reject() };
}
export function captureResetPlanTemplate(token: object, proposal: Proposal | null) {
  const session = owned(token);
  if (!session.contentSeen || session.proposalSeen || !proposal?.generated) return reject();
  session.proposalSeen = true;
  const fingerprint = digest(session, 'template-plan', { plan: proposal.plan, handover: proposal.handover ?? null });
  if (session.phase === 'PREPARING') session.blueprint = { ids: proposal.plan.replacements.map(row => row.newId),
    time: proposal.plan.registrationTime, digest: fingerprint };
  else if (fingerprint !== session.blueprint?.digest) return reject();
  if (session.phase === 'CHECKING') session.effectProposal = structuredClone(proposal);
}

/** Internal S1 adapter seam. Only this module's successfully rechecked handle can
 * transfer the original template plan once. Never expose this raw internal value
 * via an HTTP/API/log. Ordinary consume/dispose/expiry also destroys the payload.
 * Ownership is NOT live transport, backup, approval or execution authority. */
export function takeResetTemplateHandover(handle: object, commitment: string) {
  const session = sessions.get(handle);
  if (!session) return reject();
  try {
    live(session);
    if (session.phase !== 'CHECKED' || session.summary?.commitment !== commitment || !session.effectRows
      || !session.effectProposal?.generated || !session.effectProposal.handover || !session.effectContentFingerprint) return reject();
    return { source: copyMigrationData(session.effectSource), contentFingerprint: session.effectContentFingerprint,
      reviewedPlanFingerprint: session.summary.reviewedPlanFingerprint, expiresAt: session.expiresAt,
      rows: structuredClone(session.effectRows), proposal: structuredClone(session.effectProposal),
      blockers: [...session.summary.blockers] };
  } finally { close(session); }
}

/** Bounded server-owned two-observation session. It is not human authorization,
 * a durable approval/plan store, a deletion permit, or an automatic retry path.
 * Real observations use the existing closed read-only collector. Synthetic ports
 * exercise that path but cannot prove a live DB. No credentials are retained. */
export function createResetPlanRevalidation(options: unknown) {
  let copied: unknown;
  try { copied = copyMigrationData(options); } catch { return reject(); }
  if (!copied || typeof copied !== 'object' || Array.isArray(copied)
    || Object.keys(copied).length !== 1 || !Object.hasOwn(copied, 'expiresAt')) return reject();
  const expiresAt = (copied as { expiresAt: unknown }).expiresAt;
  const now = Date.now();
  // Timer implementation bound, not a recommended policy TTL. No default expiry.
  if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt - now > 2_147_483_647) return reject();
  const session: Session = { phase: 'NEW', secret: randomBytes(32), expiresAt,
    deadline: performance.now() + expiresAt - now, contentSeen: false, proposalSeen: false };
  session.timer = setTimeout(() => close(session), expiresAt - now); session.timer.unref();
  async function observe(mode: 'PREPARING' | 'CHECKING', input: unknown, request: unknown, open: OpenResetReadClient | null, signal?: AbortSignal) {
    let token: object | undefined;
    try {
      live(session);
      if (session.phase !== (mode === 'PREPARING' ? 'NEW' : 'PREPARED')) return reject();
      session.phase = mode; session.contentSeen = false; session.proposalSeen = false;
      // Snapshot input before await; getters, cycles and unsupported data fail closed.
      // Native credentials are passed only to the existing transport validator.
      // Never copy/hash/retain them as approved content or emit a password digest.
      const native = open === null;
      const fields = native && input && typeof input === 'object' ? Object.getOwnPropertyDescriptors(input) : null;
      if (native && (!fields || Reflect.ownKeys(fields).length !== 2 || !fields.source || !fields.connection
        || !Object.hasOwn(fields.source, 'value') || !Object.hasOwn(fields.connection, 'value'))) return reject();
      const source = copyMigrationData(native ? fields?.source?.value : input); const intent = copyMigrationData(request);
      const inputHash = requestHash({ native, source, intent, expiresAt: session.expiresAt });
      if (mode === 'PREPARING') session.inputHash = inputHash;
      else if (inputHash !== session.inputHash) return reject();
      session.controller = new AbortController();
      const abort = signal ? AbortSignal.any([signal, session.controller.signal]) : session.controller.signal;
      token = Object.freeze({}); captures.set(token, session);
      const result = native
        ? await inspectResetNativeReview({ source, connection: fields?.connection?.value }, intent, abort, token)
        : await inspectResetReadOnlyReview(source, intent, open, abort, token);
      live(session);
      const review = reviewSummarySchema.parse('review' in result ? result.review : null);
      if (abort.aborted || !session.contentSeen || !session.proposalSeen || !session.content || !session.blueprint) return reject();
      const blockers = [...new Set([...result.blockers, ...review.blockers])].sort();
      if (mode === 'PREPARING') {
        const effectReview = z.object({ contentFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).safeParse('review' in result ? result.review : null);
        if (effectReview.success) session.effectContentFingerprint = effectReview.data.contentFingerprint;
        session.summary = { commitment: digest(session, 'review', { inputHash, content: session.content,
          plan: session.blueprint.digest, blockers }), reviewedPlanFingerprint: review.planFingerprint, blockers };
        session.phase = 'PREPARED';
        return { ...flags, status: 'PREPARED' as const, revalidated: false as const, summary: structuredClone(session.summary) };
      }
      if (!session.summary || requestHash(blockers) !== requestHash(session.summary.blockers)) return reject();
      session.phase = 'CHECKED';
      // Retain the bounded internal template payload until one transfer, consume or expiry.
      session.secret.fill(0); delete session.blueprint;
      return { ...flags, status: 'MATCHED' as const, revalidated: true as const, summary: structuredClone(session.summary) };
    } catch { close(session); return failed(); }
    finally { if (token) captures.delete(token); }
  }
  const handle = Object.freeze({
    prepare: (input: unknown, request: unknown, open: OpenResetReadClient, signal?: AbortSignal) => observe('PREPARING', input, request, open, signal),
    recheck: (input: unknown, request: unknown, open: OpenResetReadClient, signal?: AbortSignal) => observe('CHECKING', input, request, open, signal),
    prepareNative: (input: unknown, request: unknown, signal?: AbortSignal) => observe('PREPARING', input, request, null, signal),
    recheckNative: (input: unknown, request: unknown, signal?: AbortSignal) => observe('CHECKING', input, request, null, signal),
    consume(commitment: string) {
      try {
        live(session);
        if (session.phase !== 'CHECKED' || !session.summary || commitment !== session.summary.commitment) return reject();
        const summary = structuredClone(session.summary); close(session);
        return { ...flags, status: 'CONSUMED' as const, revalidated: true as const, summary };
      } catch { close(session); return failed(); }
    },
    dispose: () => close(session),
  });
  sessions.set(handle, session);
  return handle;
}
