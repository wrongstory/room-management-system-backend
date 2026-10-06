import { z } from 'zod';
import { requestHash } from '../../lib/command.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const slot = z.object({
  slotKey: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
  displayOrder: z.number().int().min(0).max(99),
  required: z.boolean(),
  label: z.string().min(1).max(80),
  maxPhotos: z.number().int().min(1).max(20).optional(),
  description: z.string().min(1).max(200).optional(),
  section: z.string().min(1).max(80).optional(),
  instanceKey: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/).optional(),
}).strict();
const content = z.object({
  roomTypeId: uuid,
  cleaningKind: z.enum(['checkout', 'stayover', 'additional', 'reclean']),
  durationMinutes: z.number().int().min(1).max(10080).nullable(),
  slots: z.array(slot).min(1).max(100),
}).strict().superRefine((value, ctx) => {
  if ((value.cleaningKind !== 'checkout' && value.durationMinutes === null) ||
      new Set(value.slots.map((s) => s.slotKey)).size !== value.slots.length ||
      new Set(value.slots.map((s) => s.displayOrder)).size !== value.slots.length) {
    ctx.addIssue({ code: 'custom', message: 'invalid template shape' });
  }
});
const planSchema = z.object({
  developerId: uuid,
  registrationTime: z.iso.datetime(),
  sourceComplete: z.boolean(),
  sources: z.array(z.object({ id: uuid, content }).strict()).max(1000),
  replacements: z.array(z.object({
    sourceId: uuid, newId: uuid, createdBy: uuid,
    createdAt: z.iso.datetime(),
    reason: z.literal('OPERATIONAL_HANDOVER_INITIALIZATION'),
    content,
  }).strict()).max(1000),
  referencesComplete: z.boolean(),
  references: z.array(z.object({
    referenceId: uuid, sourceId: uuid, newId: uuid,
  }).strict()).max(10000),
}).strict();

type Blocker = 'INVALID_INPUT' | 'INCOMPLETE_SOURCE' | 'INCOMPLETE_REFERENCES' |
  'DUPLICATE_ID' | 'MAPPING_MISMATCH' | 'OLD_ID_REUSED' | 'CONTENT_CHANGED' |
  'PROVENANCE_MISMATCH' | 'REFERENCE_MISMATCH';

/** Internal proposal checker only. Does not authenticate, publish, or mutate. */
export function inspectTemplateReseedPlan(input: unknown) {
  const fail = (blockers: Blocker[]) => ({
    planValid: false as const, executionEnabled: false as const,
    blockers, templateCount: null, referenceCount: null, fingerprint: null,
  });
  const parsed = planSchema.safeParse(input);
  if (!parsed.success) return fail(['INVALID_INPUT']);
  const p = parsed.data;
  const blockers = new Set<Blocker>();
  if (!p.sourceComplete) blockers.add('INCOMPLETE_SOURCE');
  if (!p.referencesComplete) blockers.add('INCOMPLETE_REFERENCES');
  const sources = new Map(p.sources.map((s) => [s.id, s]));
  const replacements = new Map(p.replacements.map((r) => [r.sourceId, r]));
  if (sources.size !== p.sources.length ||
      replacements.size !== p.replacements.length ||
      new Set(p.replacements.map((r) => r.newId)).size !== p.replacements.length ||
      new Set(p.references.map((r) => r.referenceId)).size !== p.references.length) {
    blockers.add('DUPLICATE_ID');
  }
  if (sources.size !== replacements.size ||
      p.sources.some((s) => !replacements.has(s.id))) blockers.add('MAPPING_MISMATCH');
  const canonicalContent = (c: z.infer<typeof content>) => ({
    ...c, slots: [...c.slots].sort((a, b) => a.displayOrder - b.displayOrder),
  });
  for (const replacement of p.replacements) {
    const source = sources.get(replacement.sourceId);
    if (!source) blockers.add('MAPPING_MISMATCH');
    if (sources.has(replacement.newId)) blockers.add('OLD_ID_REUSED');
    if (replacement.createdBy !== p.developerId ||
        replacement.createdAt !== p.registrationTime) blockers.add('PROVENANCE_MISMATCH');
    if (source && requestHash(canonicalContent(source.content)) !==
        requestHash(canonicalContent(replacement.content))) blockers.add('CONTENT_CHANGED');
  }
  for (const reference of p.references) {
    if (!sources.has(reference.sourceId) ||
        replacements.get(reference.sourceId)?.newId !== reference.newId) {
      blockers.add('REFERENCE_MISMATCH');
    }
  }
  if (blockers.size) return fail([...blockers].sort());
  const by = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  return {
    planValid: true as const, executionEnabled: false as const,
    blockers: [] as Blocker[],
    templateCount: p.sources.length, referenceCount: p.references.length,
    fingerprint: requestHash({
      ...p,
      sources: p.sources.map((s) => ({ ...s, content: canonicalContent(s.content) }))
        .sort((a, b) => by(a.id, b.id)),
      replacements: p.replacements.map((r) => ({ ...r, content: canonicalContent(r.content) }))
        .sort((a, b) => by(a.sourceId, b.sourceId)),
      references: [...p.references].sort((a, b) => by(a.referenceId, b.referenceId)),
    }),
  };
}
