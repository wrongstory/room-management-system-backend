import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requestHash } from '../../lib/command.js';
import { inspectTemplateReseedPlan, templateReseedPlanSchema } from './template-reseed-plan.js';

const uuid = z.uuid().transform(s => s.toLowerCase());
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const binding = z.object({ projectRef: z.string().regex(/^[a-z]{20}$/), sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  snapshotId: hash, catalogFingerprint: hash, contentFingerprint: hash }).strict();
const template = templateReseedPlanSchema.shape.sources.element.extend({
  status: z.enum(['draft', 'published', 'retired']), version: z.number().int().min(1).max(2147483647),
  createdBy: uuid, createdAt: z.iso.datetime(),
}).strict();
const reference = z.object({ referenceId: uuid, sourceId: uuid,
  kind: z.enum(['CURRENT_POINTER', 'HISTORICAL_SNAPSHOT']) }).strict();
const schema = z.object({ expected: binding, developerId: uuid,
  selection: z.enum(['CURRENT_PUBLISHED', 'ALL_VERSIONS']),
  inventory: z.object({ binding, complete: z.literal(true), referencesComplete: z.literal(true),
    templateCount: z.number().int().min(0).max(10000), referenceCount: z.number().int().min(0).max(10000),
    templates: z.array(template).max(10000), references: z.array(reference).max(10000),
  }).strict(),
}).strict();
type Template = z.infer<typeof template>;
type Reference = z.infer<typeof reference>;
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const canonical = (templates: Template[], references: Reference[]) => ({
  templates: templates.map(t => ({ ...t, content: { ...t.content,
    slots: [...t.content.slots].sort((a, b) => a.displayOrder - b.displayOrder) } })).sort((a, b) => cmp(a.id, b.id)),
  references: [...references].sort((a, b) => cmp(a.referenceId, b.referenceId)),
});
class PlanFailure extends Error {}
const fail = (code: string): never => { throw new PlanFailure(code); };

/** Server-internal proposal generator. Explicit selection is mandatory. The
 * collector must independently supply the complete bound inventory and digest.
 * This function never publishes, selects a new status/version or rewires history.
 * Output content/provenance is INTERNAL and must not be sent to a public API/log.
 */
export function buildTemplateReseedProposal(input: unknown, dependencies: {
  now?: () => Date; newId?: () => string;
} = {}) {
  try {
    const parsed = schema.safeParse(input);
    if (!parsed.success) return fail('TEMPLATE_BUILDER_INPUT_INVALID');
    const p = parsed.data; const { inventory } = p;
    if (requestHash(p.expected) !== requestHash(inventory.binding)) fail('TEMPLATE_BUILDER_BINDING_CHANGED');
    const originalIds = new Set(inventory.templates.map(t => t.id));
    const refIds = new Set(inventory.references.map(r => r.referenceId));
    if (originalIds.size !== inventory.templateCount || inventory.templates.length !== inventory.templateCount ||
        refIds.size !== inventory.referenceCount || inventory.references.length !== inventory.referenceCount) fail('TEMPLATE_BUILDER_CENSUS_MISMATCH');
    if (requestHash(canonical(inventory.templates, inventory.references)) !== p.expected.contentFingerprint) fail('TEMPLATE_BUILDER_CONTENT_CHANGED');
    // Detached historical identity is reported separately by source129. It must
    // receive a protection plan instead of silently vanishing from this proposal.
    if (inventory.references.some(r => !originalIds.has(r.sourceId))) fail('TEMPLATE_BUILDER_DETACHED_REFERENCE');
    const published = inventory.templates.filter(t => t.status === 'published');
    if (new Set(published.map(t => `${t.content.roomTypeId}:${t.content.cleaningKind}`)).size !== published.length) fail('TEMPLATE_BUILDER_PUBLICATION_AMBIGUOUS');
    const selected = (p.selection === 'CURRENT_PUBLISHED' ? published : inventory.templates).sort((a, b) => cmp(a.id, b.id));
    if (selected.length > 1000) fail('TEMPLATE_BUILDER_SELECTION_LIMIT');
    const selectedIds = new Set(selected.map(t => t.id));
    const refs = inventory.references.filter(r => selectedIds.has(r.sourceId));
    const now = (dependencies.now ?? (() => new Date()))();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail('TEMPLATE_BUILDER_CLOCK_INVALID');
    if (selected.some(t => Date.parse(t.createdAt) >= now.getTime())) fail('TEMPLATE_BUILDER_CLOCK_NOT_AFTER_SOURCE');
    const registrationTime = now.toISOString();
    const newId = dependencies.newId ?? randomUUID;
    const allocated = new Set(originalIds);
    const replacements = selected.map(source => {
      let id: string | undefined;
      for (let attempt = 0; attempt < 8; attempt++) {
        const candidate = uuid.safeParse(newId());
        const value = candidate.success ? candidate.data : fail('TEMPLATE_BUILDER_ID_INVALID');
        if (!allocated.has(value)) { id = value; allocated.add(value); break; }
      }
      if (!id) return fail('TEMPLATE_BUILDER_ID_EXHAUSTED');
      return { sourceId: source.id, newId: id, createdBy: p.developerId, createdAt: registrationTime,
        reason: 'OPERATIONAL_HANDOVER_INITIALIZATION' as const, content: structuredClone(source.content) };
    });
    const plan = { developerId: p.developerId, registrationTime, sourceComplete: true,
      sources: selected.map(({ id, content }) => ({ id, content: structuredClone(content) })), replacements,
      // A registration mapping does not authorize editing a retained/current or
      // historical reference. Leave that dependent plan explicitly incomplete.
      referencesComplete: refs.length === 0, references: [] };
    const checked = inspectTemplateReseedPlan(plan);
    if (checked.blockers.some(code => code !== 'INCOMPLETE_REFERENCES')) fail('TEMPLATE_BUILDER_GENERATED_PLAN_INVALID');
    return { generated: true as const, executionEnabled: false, selection: p.selection,
      plan, originalProvenance: selected.map(({ id, createdBy, createdAt, status, version }) => ({ id, createdBy, createdAt, status, version })),
      counts: { inventory: inventory.templateCount, selected: selected.length, excluded: inventory.templateCount - selected.length,
        currentReferences: refs.filter(r => r.kind === 'CURRENT_POINTER').length,
        historicalReferences: refs.filter(r => r.kind === 'HISTORICAL_SNAPSHOT').length },
      planFingerprint: requestHash({ binding: p.expected, selection: p.selection, plan }),
      blockers: [...checked.blockers, 'TEMPLATE_STATUS_AND_VERSION_POLICY_REQUIRED', 'TEMPLATE_HISTORY_PROTECTION_REQUIRED',
        'TEMPLATE_PUBLICATION_COMPATIBILITY_NOT_VERIFIED'],
    };
  } catch (error) {
    return { generated: false as const, executionEnabled: false, plan: null, originalProvenance: null, counts: null,
      planFingerprint: null, blockers: [error instanceof PlanFailure ? error.message : 'TEMPLATE_BUILDER_UNAVAILABLE'] };
  }
}
