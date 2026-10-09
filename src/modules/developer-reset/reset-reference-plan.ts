import { z } from 'zod';

const relation = z.string().regex(/^(public|private|auth)\.[a-z][a-z0-9_]*$/).max(128);
const identifier = z.string().regex(/^[a-z][a-z0-9_]*$/).max(63);
// Collector-local opaque row identities, not SQL identifiers or an execution API.
const key = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const schema = z.object({
  catalogFingerprint: hash, snapshotCatalogFingerprint: hash,
  complete: z.boolean(),
  relations: z.array(relation).min(1).max(1000),
  // Independent COUNT(*) per relation in the same trusted snapshot, not rows.length.
  relationRowCounts: z.array(z.object({
    relation, count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }).strict()).min(1).max(1000),
  foreignKeys: z.array(z.object({ source: relation, target: relation, name: identifier }).strict()).max(10000),
  rows: z.array(z.object({
    relation, key, disposition: z.enum(['keep', 'remove']),
    references: z.array(z.object({ constraint: identifier, targetKey: key.nullable() }).strict()).max(200),
  }).strict()).max(10000),
}).strict();

/** Checks supplied row edges only. Completeness must be established by a trusted collector.
 * Reseeded rows must be separately materialized/remapped before this check; no inferred rewrite.
 * Cycles are visited once, not topologically sorted: this is NOT a deletion order planner.
 */
export function inspectResetReferencePlan(input: unknown) {
  const parsed = schema.safeParse(input);
  const blocked = (blockers: string[]) => ({
    referencesValid: false, executionEnabled: false, blockers, counts: null,
  });
  if (!parsed.success) return blocked(['INVALID_INPUT']);
  const p = parsed.data;
  const blockers = new Set<string>();
  if (!p.complete) blockers.add('INCOMPLETE_SNAPSHOT');
  if (p.catalogFingerprint !== p.snapshotCatalogFingerprint) blockers.add('CATALOG_MISMATCH');
  const relations = new Set(p.relations);
  if (relations.size !== p.relations.length) blockers.add('DUPLICATE_RELATION');
  const constraints = new Map<string, Map<string, string>>();
  for (const fk of p.foreignKeys) {
    if (!relations.has(fk.source) || !relations.has(fk.target)) blockers.add('UNKNOWN_RELATION');
    const source = constraints.get(fk.source) ?? new Map<string, string>();
    if (source.has(fk.name)) blockers.add('DUPLICATE_CONSTRAINT');
    source.set(fk.name, fk.target);
    constraints.set(fk.source, source);
  }
  const rowIdentity = (table: string, rowKey: string) => `${table}:${rowKey}`;
  const rows = new Map(p.rows.map((row) => [rowIdentity(row.relation, row.key), row]));
  if (rows.size !== p.rows.length) blockers.add('DUPLICATE_ROW');
  const actualCounts = new Map<string, number>();
  for (const row of rows.values()) {
    actualCounts.set(row.relation, (actualCounts.get(row.relation) ?? 0) + 1);
  }
  const counted = new Set<string>();
  for (const entry of p.relationRowCounts) {
    if (counted.has(entry.relation)) blockers.add('DUPLICATE_RELATION_COUNT');
    counted.add(entry.relation);
    if (!relations.has(entry.relation)) blockers.add('UNKNOWN_RELATION_COUNT');
    if (entry.count !== (actualCounts.get(entry.relation) ?? 0)) blockers.add('ROW_COUNT_MISMATCH');
  }
  for (const name of relations) {
    if (!counted.has(name)) blockers.add('MISSING_RELATION_COUNT');
  }
  let edges = 0;
  for (const row of p.rows) {
    if (!relations.has(row.relation)) blockers.add('UNKNOWN_RELATION');
    const required = constraints.get(row.relation) ?? new Map<string, string>();
    const seen = new Set<string>();
    for (const ref of row.references) {
      if (seen.has(ref.constraint)) blockers.add('DUPLICATE_REFERENCE');
      seen.add(ref.constraint);
      const target = required.get(ref.constraint);
      if (!target) { blockers.add('UNKNOWN_CONSTRAINT'); continue; }
      // null means the collector verified SQL MATCH semantics yield no row edge.
      if (ref.targetKey === null) continue;
      edges++;
      const targetRow = rows.get(rowIdentity(target, ref.targetKey));
      if (!targetRow) blockers.add('MISSING_TARGET_ROW');
      else if (row.disposition === 'keep' && targetRow.disposition === 'remove') {
        // Even CASCADE / SET NULL must not silently mutate a preserved row.
        blockers.add('PRESERVED_ROW_REFERENCES_REMOVED_ROW');
      }
    }
    for (const name of required.keys()) {
      if (!seen.has(name)) blockers.add('MISSING_REFERENCE');
    }
  }
  if (blockers.size) return blocked([...blockers].sort());
  return {
    referencesValid: true, executionEnabled: false, blockers: [] as string[],
    counts: { rows: rows.size, edges, kept: p.rows.filter((r) => r.disposition === 'keep').length },
  };
}
