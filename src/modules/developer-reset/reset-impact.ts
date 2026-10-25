import { z } from 'zod';
import { requestHash } from '../../lib/command.js';

const relation = z.string().regex(/^(public|private)\.[a-z][a-z0-9_]*$/).max(128);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const disposition = z.enum(['preserve', 'clear', 'reseed', 'mixed']);
const manifestSchema = z.object({
  version: z.string().min(1).max(80),
  schemaFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  relations: z.array(z.object({
    relation,
    disposition,
  }).strict()).min(1).max(1000),
}).strict();
const snapshotSchema = z.object({
  schemaFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  complete: z.boolean(),
  relations: z.array(z.object({
    relation,
    total: count,
    preserve: count,
    clear: count,
    reseed: count,
  }).strict()).max(1000),
}).strict();

export type ResetImpactManifest = z.infer<typeof manifestSchema>;
export type ResetImpactSnapshot = z.infer<typeof snapshotSchema>;
type Blocker =
  | 'INVALID_INPUT'
  | 'INCOMPLETE_SNAPSHOT'
  | 'SCHEMA_MISMATCH'
  | 'DUPLICATE_RELATION'
  | 'UNCLASSIFIED_RELATION'
  | 'MISSING_RELATION'
  | 'COUNT_MISMATCH'
  | 'DISPOSITION_MISMATCH';

function duplicateNames(rows: { relation: string }[]): boolean {
  return new Set(rows.map((row) => row.relation)).size !== rows.length;
}

/**
 * Internal pure validator, not an API or an authorization/backup proof.
 * Both inputs must eventually come from server-controlled catalog readers.
 * No table names or SQL from this result may be used as an execution plan.
 */
export function inspectResetImpact(manifestInput: unknown, snapshotInput: unknown) {
  const manifest = manifestSchema.safeParse(manifestInput);
  const snapshot = snapshotSchema.safeParse(snapshotInput);
  const blocked = (blockers: Blocker[]) => ({
    classificationValid: false as const,
    executionEnabled: false as const,
    blockers,
    fingerprint: null,
    counts: null,
  });
  // Never echo parser errors, raw payloads, or untrusted relation names.
  if (!manifest.success || !snapshot.success) return blocked(['INVALID_INPUT']);
  const m = manifest.data;
  const s = snapshot.data;
  const blockers = new Set<Blocker>();
  if (!s.complete) blockers.add('INCOMPLETE_SNAPSHOT');
  if (m.schemaFingerprint !== s.schemaFingerprint) blockers.add('SCHEMA_MISMATCH');
  if (duplicateNames(m.relations) || duplicateNames(s.relations)) {
    blockers.add('DUPLICATE_RELATION');
  }
  const rules = new Map(m.relations.map((row) => [row.relation, row.disposition]));
  const observed = new Set(s.relations.map((row) => row.relation));
  for (const rule of m.relations) {
    if (!observed.has(rule.relation)) blockers.add('MISSING_RELATION');
  }
  const totals = { preserve: 0, clear: 0, reseed: 0 };
  for (const row of s.relations) {
    const rule = rules.get(row.relation);
    if (!rule) blockers.add('UNCLASSIFIED_RELATION');
    const sum = row.preserve + row.clear + row.reseed;
    if (!Number.isSafeInteger(sum) || sum !== row.total) blockers.add('COUNT_MISMATCH');
    if (rule && rule !== 'mixed' && row[rule] !== row.total) {
      blockers.add('DISPOSITION_MISMATCH');
    }
    for (const key of ['preserve', 'clear', 'reseed'] as const) {
      totals[key] += row[key];
      if (!Number.isSafeInteger(totals[key])) blockers.add('COUNT_MISMATCH');
    }
  }
  if (blockers.size) return blocked([...blockers].sort());
  const byName = (a: { relation: string }, b: { relation: string }) =>
    a.relation < b.relation ? -1 : a.relation > b.relation ? 1 : 0;
  return {
    classificationValid: true as const,
    executionEnabled: false as const,
    blockers: [] as Blocker[],
    // Count-only diagnostic: deliberately NOT a TTL/CAS or row-content proof.
    fingerprint: requestHash({
      manifest: { ...m, relations: [...m.relations].sort(byName) },
      snapshot: { ...s, relations: [...s.relations].sort(byName) },
    }),
    counts: totals,
  };
}
