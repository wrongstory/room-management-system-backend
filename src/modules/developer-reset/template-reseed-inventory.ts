import { z } from 'zod';
import { requestHash } from '../../lib/command.js';
import { inspectTemplateReseedPlan, templateReseedPlanSchema } from './template-reseed-plan.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const schema = z.object({
  snapshotId: hash, catalogFingerprint: hash, plan: templateReseedPlanSchema,
  inventory: z.object({
    snapshotId: hash, catalogFingerprint: hash,
    sourceCount: count, referenceCount: count, existingTemplateCount: count,
    sourceIds: z.array(uuid).max(1000),
    // Includes templates outside the approved preservation selection, including retired ones.
    existingTemplateIds: z.array(uuid).max(10000),
    references: z.array(z.object({ referenceId: uuid, sourceId: uuid }).strict()).max(10000),
  }).strict(),
}).strict();

/** Additional internal completeness checks, not a collector, publication policy or execution permit.
 * The independent inventory/counts must come from a trusted collector in the same snapshot.
 * This checker does not choose which source versions to preserve or authorize registration.
 */
export function inspectTemplateReseedInventory(input: unknown) {
  const fail = (blockers: string[]) => ({ inventoryValid: false, executionEnabled: false,
    blockers, templateCount: null, referenceCount: null, fingerprint: null });
  const parsed = schema.safeParse(input);
  if (!parsed.success) return fail(['INVALID_TEMPLATE_INVENTORY']);
  const { plan, inventory, snapshotId, catalogFingerprint } = parsed.data;
  const base = inspectTemplateReseedPlan(plan);
  const blockers = new Set<string>(base.blockers);
  if (snapshotId !== inventory.snapshotId || catalogFingerprint !== inventory.catalogFingerprint) {
    blockers.add('TEMPLATE_INVENTORY_BINDING_MISMATCH');
  }
  const sources = new Set(inventory.sourceIds);
  const existing = new Set(inventory.existingTemplateIds);
  const refs = new Map(inventory.references.map((ref) => [ref.referenceId, ref.sourceId]));
  if (sources.size !== inventory.sourceIds.length || existing.size !== inventory.existingTemplateIds.length ||
      refs.size !== inventory.references.length) blockers.add('DUPLICATE_TEMPLATE_INVENTORY');
  if (inventory.sourceCount !== sources.size || inventory.referenceCount !== refs.size ||
      inventory.existingTemplateCount !== existing.size) blockers.add('TEMPLATE_INVENTORY_COUNT_MISMATCH');
  if (sources.size !== plan.sources.length || plan.sources.some((source) => !sources.has(source.id))) {
    blockers.add('TEMPLATE_SOURCE_COVERAGE_MISMATCH');
  }
  if ([...sources].some((id) => !existing.has(id))) blockers.add('TEMPLATE_SOURCE_NOT_IN_INVENTORY');
  if (refs.size !== plan.references.length || plan.references.some((ref) => refs.get(ref.referenceId) !== ref.sourceId) ||
      inventory.references.some((ref) => !sources.has(ref.sourceId))) blockers.add('TEMPLATE_REFERENCE_COVERAGE_MISMATCH');
  if (plan.replacements.some((replacement) => existing.has(replacement.newId))) blockers.add('EXISTING_TEMPLATE_ID_REUSED');
  if (blockers.size) return fail([...blockers].sort());
  const by = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  return { inventoryValid: true, executionEnabled: false, blockers: [] as string[],
    templateCount: base.templateCount, referenceCount: base.referenceCount,
    fingerprint: requestHash({ snapshotId, catalogFingerprint, planFingerprint: base.fingerprint,
      sourceIds: [...sources].sort(), existingTemplateIds: [...existing].sort(),
      references: [...inventory.references].sort((a, b) => by(a.referenceId, b.referenceId)),
    }),
  };
}
