/** Inactive S1 execution adapter. No HTTP/CLI entry or database EXECUTE grant.
 * Deployment activation and independently verified protection remain separate. */
import { z } from 'zod';
import { copyMigrationData } from '../../../scripts/lib/migration-evidence-input.mjs';
import { requestHash } from '../../lib/command.js';
import { RESET_HANDOVER_POLICY_FINGERPRINT } from './approved-handover-policy.js';
import { takeResetTemplateHandover } from './plan-revalidation.js';
import { consumeResetApproval, prepareResetApprovalRequest } from './reset-approval.js';
import { createResetReceipt, inspectResetReceiptRetry, type ResetReceipt } from './reset-receipt.js';
import { createSupabaseResetReceiptStore, resetReceiptAnchor } from './reset-receipt-store.js';
import type { ResetPreviewRpc } from './reset-preview.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/), uuid = z.uuid().transform(s => s.toLowerCase());
const version = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(s => BigInt(s) <= 9223372036854775807n);
const sourceBinding = z.object({ projectRef: z.string().regex(/^[a-z]{20}$/), sourceCommit: z.string().regex(/^[a-f0-9]{40}$/), catalogFingerprint: hash });
const settingsSchema = z.object({ actorProfileId: uuid, authUserId: uuid, sessionId: uuid,
  sessionDigest: hash, passwordVersionDigest: hash, challengeId: uuid, controlVersion: version,
  policyHash: hash, approvalScopeHash: hash, backupProofHash: hash, idempotencyKeyDigest: hash,
  expiresAt: z.number().int().positive().max(8640000000000000), timeoutMs: z.number().int().min(1).max(7000),
}).strict();
const rpcName = 'apply_developer_template_handover';
export const RESET_TEMPLATE_HANDOVER_STEP = requestHash({ operation: 'reset.template.handover', version: 1 });
const flags = { executionEnabled: false as const, operationalAuthorityEnabled: false as const,
  liveDatabaseVerified: false as const, completeResetCoverage: false as const, retryExecutionAllowed: false as const };
const rejected = () => ({ ...flags, status: 'UNKNOWN' as const, evidenceHash: null, count: null });
const fail = (): never => { throw new Error('RESET_TEMPLATE_HANDOVER_REJECTED'); };
const columns = {
  'public.cleaning_template_versions': ['id', 'room_type_id', 'cleaning_kind', 'version', 'status', 'duration_minutes', 'photo_slots', 'published_at', 'created_by', 'created_at'],
  'private.photo_template_slots': ['id', 'template_version_id', 'slot_key', 'display_order', 'required', 'slot_snapshot'],
} as const;
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** The caller is trusted server infrastructure. Transport is not a permission
 * callback: the fixed SQL repeats identity/control/reauth/CAS checks. The supplied
 * policy/backup hashes bind operator intent; they do not certify actual backup.
 * PUBLIC, anon, authenticated and service_role have no EXECUTE on
 * the fixed RPC. Owner/superuser access is not operational authority. This internal
 * protocol is not imported by any operational entry point; only the closed public
 * adapter may prepare it. Protection/coverage/authority activation remains absent.
 */
export function prepareResetTemplateHandoverProtocol(options: { rpc: ResetPreviewRpc; supabaseUrl: string }, input: {
  handle: object; commitment: string; settings: unknown;
}) {
  const settings = settingsSchema.parse(copyMigrationData(input.settings));
  const capture = takeResetTemplateHandover(input.handle, hash.parse(input.commitment));
  const source = sourceBinding.parse((capture.source as { binding?: unknown }).binding);
  const proposal = capture.proposal;
  if (!proposal.handover || proposal.selection !== 'CURRENT_PUBLISHED' || proposal.plan.developerId !== settings.actorProfileId
    || !proposal.plan.replacements.length || proposal.plan.replacements.length > 1000
    || settings.expiresAt > capture.expiresAt || settings.expiresAt <= Date.now()) return fail();
  // Exact typed text from the independently checked capture, including timestamps
  // and JSON numeric text. No JSON parse/reserialize of historical source values.
  const preserved = (relation: keyof typeof columns) => capture.rows.filter(row => row.relation === relation).map(row => {
    const names = columns[relation];
    if (row.values.length !== names.length || names.some(name => !row.values.some(c => c.name === name))) return fail();
    return Object.fromEntries(names.map(name => [name, row.values.find(c => c.name === name)?.value ?? null]));
  }).sort((a, b) => cmp(String(a.id), String(b.id)));
  const oldTemplates = preserved('public.cleaning_template_versions'), oldSlots = preserved('private.photo_template_slots');
  if (requestHash(oldTemplates.map(row => row.id)) !== requestHash(proposal.handover.preservedSourceIds)) return fail();
  const templates = proposal.plan.replacements.map(replacement => {
    const draft = proposal.handover?.drafts.find(row => row.newId === replacement.newId);
    if (!draft || replacement.content.cleaningKind !== 'checkout') return fail();
    return { sourceId: replacement.sourceId, newId: replacement.newId, version: draft.version,
      maximumVersion: draft.maximumVersion, expectedCurrentVersion: draft.expectedCurrentVersion,
      plannedAt: replacement.createdAt, createdBy: replacement.createdBy, reason: replacement.reason, content: replacement.content };
  }).sort((a, b) => cmp(a.sourceId, b.sourceId));
  const payload = copyMigrationData({ format: 'reset-template-effect-v1', policyFingerprint: RESET_HANDOVER_POLICY_FINGERPRINT,
    ...source, reviewedPlanFingerprint: capture.reviewedPlanFingerprint, contentFingerprint: capture.contentFingerprint,
    challengeId: settings.challengeId, controlVersion: settings.controlVersion, oldTemplates, oldSlots, templates });
  const payloadHash = requestHash(payload), templateCount = templates.length;
  const rpc = options.rpc;
  const postconditionHash = requestHash({ domain: 'reset-template-handover-postcondition-v1', payloadHash, count: templateCount,
    registrationTime: 'DATABASE_CLOCK_AFTER_STARTED_BEFORE_OBSERVED' });
  const command = { binding: { actorProfileId: settings.actorProfileId, authUserId: settings.authUserId,
    sessionDigest: settings.sessionDigest, passwordVersionDigest: settings.passwordVersionDigest, ...source,
    contentFingerprint: capture.contentFingerprint, planFingerprint: capture.reviewedPlanFingerprint,
    expectedPostconditionFingerprint: postconditionHash, policyHash: settings.policyHash,
    approvalScopeHash: settings.approvalScopeHash, backupProofHash: settings.backupProofHash },
  idempotencyKeyDigest: settings.idempotencyKeyDigest, createdAt: Date.now(), expiresAt: settings.expiresAt,
  steps: [{ id: RESET_TEMPLATE_HANDOVER_STEP, kind: 'DATABASE' as const }] };
  const genesis = createResetReceipt(command, command.createdAt);
  const approvalRequest = prepareResetApprovalRequest(command, command.createdAt);
  const store = createSupabaseResetReceiptStore({ ...settings, ...source, rpc, supabaseUrl: options.supabaseUrl });
  let attempted = false, busy = false, discarded = false;
  let inFlight: AbortController | undefined;
  let current: ResetReceipt = genesis;
  let rawPayload: unknown = payload;
  const { events: _events, ...header } = genesis;
  // The plaintext plan lives only in this bounded owner closure until disposal or
  // expiry; it is never returned in the review/approval response.
  const discard = () => { discarded = true; rawPayload = null; inFlight?.abort(); };
  const assertLive = () => { if (discarded || Date.now() >= settings.expiresAt) return fail(); };
  const disposal = setTimeout(discard, Math.min(settings.expiresAt - Date.now(), 2147483647));
  disposal.unref();
  const publicSummary = Object.freeze({ ...flags, approvalRequest, payloadHash, postconditionHash,
    count: templateCount, blockers: Object.freeze([...capture.blockers]),
    protectionVerified: false as const, activationRequired: true as const });
  async function call(mode: 'PRECHECK' | 'APPLY' | 'READ', nonce: string | null) {
    assertLive();
    if (discarded || rawPayload === null) return fail();
    const controller = new AbortController();
    inFlight = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        Promise.resolve().then(() => rpc(rpcName, { p_mode: mode, p_actor: settings.actorProfileId,
          p_auth: settings.authUserId, p_session: settings.sessionId, p_nonce: nonce,
          p_binding: copyMigrationData(command.binding), p_header: copyMigrationData(header), p_payload: copyMigrationData(rawPayload),
          p_expected_version: current.events.length, p_expected_head: resetReceiptAnchor(current).headHash,
        }, controller.signal)),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error()); }, settings.timeoutMs); }),
      ]);
      if (discarded || controller.signal.aborted || response.error) return fail();
      assertLive();
      const value = z.object({ format: z.literal('reset-template-effect-result-v1'),
        status: z.enum(['PRECHECKED', 'APPLIED']), payloadHash: hash, evidenceHash: hash.nullable(), registrationTime: z.iso.datetime().nullable(),
        count: z.number().int().min(1).max(1000), receipt: z.unknown().nullable(), executionEnabled: z.literal(false),
      }).strict().parse(copyMigrationData(response.data));
      if (value.payloadHash !== payloadHash || value.count !== templateCount) return fail();
      if (mode === 'PRECHECK') {
        if (value.status !== 'PRECHECKED' || value.evidenceHash !== null || value.registrationTime !== null || value.receipt !== null) return fail();
      } else {
        const registrationTime = value.registrationTime;
        if (registrationTime === null || new Date(registrationTime).toISOString() !== registrationTime) return fail();
        const evidenceHash = requestHash({ domain: 'reset-template-handover-applied-v1', postconditionHash, registrationTime });
        if (value.status !== 'APPLIED' || value.evidenceHash !== evidenceHash
          || !inspectResetReceiptRetry(value.receipt, command, Date.now()).valid) return fail();
        const receipt = value.receipt as ResetReceipt;
        if (receipt.events.length !== 2 || receipt.events[0]?.event.type !== 'STARTED'
          || receipt.events[0]?.event.stepId !== RESET_TEMPLATE_HANDOVER_STEP
          || receipt.events[1]?.event.type !== 'OBSERVED' || receipt.events[1].event.outcome !== 'APPLIED'
          || receipt.events[1].event.evidenceHash !== evidenceHash
          || Date.parse(registrationTime) < receipt.events[0].at || Date.parse(registrationTime) > receipt.events[1].at) return fail();
        if (current.events.length && receipt.events[0]?.hash !== current.events[0]?.hash) return fail();
        current = receipt;
      }
      return value;
    } finally { if (timer) clearTimeout(timer); if (inFlight === controller) inFlight = undefined; }
  }
  return Object.freeze({
    summary: publicSummary,
    async execute(input: unknown) {
      if (attempted || busy || discarded) return rejected();
      attempted = true; busy = true;
      try {
        const args = z.object({ approvalId: uuid, runId: uuid, nonce: hash,
          ioBudgetMs: z.number().int().min(1).max(30000) }).strict().parse(copyMigrationData(input));
        if (Date.now() >= settings.expiresAt) return fail();
        await call('PRECHECK', args.nonce); // No grant means no approval/DB write.
        assertLive();
        const approval = await consumeResetApproval({ request: approvalRequest, approvalId: args.approvalId,
          runId: args.runId, ioBudgetMs: args.ioBudgetMs });
        if (approval.commandHash !== genesis.commandHash || approval.requestSha256 !== approvalRequest.requestSha256
          || discarded || Date.now() >= settings.expiresAt) return fail();
        assertLive();
        const created = await store.create(command, Date.now());
        if (discarded || created.status !== 'CONFIRMED' || created.receipt.events.length !== 0) return fail();
        assertLive();
        current = created.receipt;
        const started = await store.append(command, current, { type: 'STARTED', stepId: RESET_TEMPLATE_HANDOVER_STEP,
          bindingHash: genesis.bindingHash }, { anchor: created.anchor, now: Date.now() });
        if (discarded || started.status !== 'CONFIRMED' || started.receipt.events.length !== 1) return fail();
        assertLive();
        current = started.receipt;
        const result = await call('APPLY', args.nonce);
        return { ...flags, status: 'APPLIED' as const, evidenceHash: result.evidenceHash, registrationTime: result.registrationTime, count: templateCount };
      } catch { return rejected(); }
      finally { busy = false; }
    },
    // Explicit readback only, including a lost response. Never calls APPLY again,
    // never consumes another approval, and never claims whole-reset completion.
    async reconcile() {
      if (!attempted || busy || discarded) return rejected();
      busy = true;
      try { const result = await call('READ', null); return { ...flags, status: 'APPLIED' as const,
        evidenceHash: result.evidenceHash, registrationTime: result.registrationTime, count: templateCount }; }
      catch { return rejected(); }
      finally { busy = false; }
    },
    dispose() { discard(); clearTimeout(disposal); },
  });
}
