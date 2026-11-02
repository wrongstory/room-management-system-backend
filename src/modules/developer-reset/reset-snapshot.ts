import { z } from 'zod';
import { requestHash } from '../../lib/command.js';
import { inspectResetReferencePlan, inspectResetReferenceCapture, resetReferencePlanSchema, resetReferenceCaptureSchema } from './reset-reference-plan.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const relation = z.string().regex(/^(public|private|auth)\.[a-z][a-z0-9_]*$/).max(128);
const key = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const constraint = z.string().regex(/^[a-z][a-z0-9_]*$/).max(63);
const binding = z.object({
  projectRef: z.string().regex(/^[a-z]{20}$/), sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  catalogFingerprint: hash, classificationFingerprint: hash,
}).strict();
const schema = z.object({
  expected: binding,
  snapshot: binding.extend({ id: hash, readOnly: z.literal(true), isolation: z.enum(['repeatable read', 'stable statement']) }).strict(),
  plan: resetReferencePlanSchema,
  census: z.array(z.object({ relation, snapshotId: hash, count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), contentFingerprint: hash }).strict()).max(1000),
  // Tokens are produced by a trusted collector using a per-snapshot keyed digest.
  // They must not be raw row contents or reusable hashes of low-entropy secrets.
  content: z.array(z.object({ relation, key, snapshotId: hash, contentToken: hash }).strict()).max(10000),
  foreignKeys: z.array(z.object({
    source: relation, name: constraint, sourceNullable: z.array(z.boolean()).min(1).max(64),
    match: z.enum(['s', 'f', 'p']), validated: z.boolean(),
  }).strict()).max(10000),
  nullEvidence: z.array(z.object({
    relation, key, constraint, snapshotId: hash, sourceNulls: z.array(z.boolean()).min(1).max(64),
  }).strict()).max(100000),
}).strict();
const captureSchema = schema.extend({ plan: resetReferenceCaptureSchema }).strict();

/** Validates a collector's coherent bounded proposal. Never connects or authorizes reset.
 * This is not a trusted collector: labels/hashes supplied by an API client prove nothing.
 * SQL equality/collation and target row resolution must be performed in the collector DB.
 */
export function inspectResetSnapshot(input: unknown) {
  return inspect(input, false);
}
/** FK/NULL/content structure only; pending dispositions stay undecided. */
export function inspectResetSnapshotCapture(input: unknown) {
  const { snapshotValid, ...result } = inspect(input, true);
  return { ...result, structureValid: snapshotValid };
}
function inspect(input: unknown, capture: boolean) {
  const blocked = (blockers: string[]) => ({ snapshotValid: false, executionEnabled: false,
    blockers, fingerprint: null, counts: null });
  const parsed = (capture ? captureSchema : schema).safeParse(input);
  if (!parsed.success) return blocked(['INVALID_SNAPSHOT_INPUT']);
  const p = parsed.data;
  const blockers = new Set<string>();
  const actualBinding = { projectRef: p.snapshot.projectRef, sourceCommit: p.snapshot.sourceCommit,
    catalogFingerprint: p.snapshot.catalogFingerprint, classificationFingerprint: p.snapshot.classificationFingerprint };
  if (requestHash(actualBinding) !== requestHash(p.expected) ||
      p.plan.catalogFingerprint !== p.expected.catalogFingerprint || p.plan.snapshotCatalogFingerprint !== p.expected.catalogFingerprint) {
    blockers.add('SNAPSHOT_BINDING_MISMATCH');
  }
  const graph = capture ? inspectResetReferenceCapture(p.plan) : inspectResetReferencePlan(p.plan);
  for (const code of graph.blockers) blockers.add(code);
  const identity = (table: string, rowKey: string) => `${table}:${rowKey}`;
  const rowMap = new Map(p.plan.rows.map((row) => [identity(row.relation, row.key), row]));
  const contents = new Map(p.content.map((row) => [identity(row.relation, row.key), row]));
  if (contents.size !== p.content.length) blockers.add('DUPLICATE_CONTENT_ROW');
  if (contents.size !== rowMap.size || [...rowMap.keys()].some((id) => !contents.has(id)) ||
      [...contents.keys()].some((id) => !rowMap.has(id))) blockers.add('CONTENT_ROW_COVERAGE_MISMATCH');
  const counts = new Map(p.plan.relationRowCounts.map((entry) => [entry.relation, entry.count]));
  const census = new Map(p.census.map((entry) => [entry.relation, entry]));
  if (census.size !== p.census.length) blockers.add('DUPLICATE_CENSUS_RELATION');
  if (census.size !== counts.size || [...counts.keys()].some((name) => !census.has(name)) ||
      [...census.keys()].some((name) => !counts.has(name))) blockers.add('CENSUS_COVERAGE_MISMATCH');
  const contentGroups = new Map<string, { key: string; contentToken: string }[]>();
  for (const row of p.content) {
    const group = contentGroups.get(row.relation) ?? [];
    group.push({ key: row.key, contentToken: row.contentToken }); contentGroups.set(row.relation, group);
  }
  const byKey = (a: { key: string }, b: { key: string }) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  for (const entry of p.census) {
    if (counts.get(entry.relation) !== entry.count) blockers.add('CENSUS_COUNT_MISMATCH');
    const rows = [...(contentGroups.get(entry.relation) ?? [])].sort(byKey);
    if (requestHash(rows) !== entry.contentFingerprint) blockers.add('CENSUS_CONTENT_MISMATCH');
  }
  if ([...p.census, ...p.content, ...p.nullEvidence].some((item) => item.snapshotId !== p.snapshot.id)) {
    blockers.add('MIXED_SNAPSHOT');
  }
  const shapes = new Map(p.foreignKeys.map((fk) => [identity(fk.source, fk.name), fk]));
  const graphFks = new Set(p.plan.foreignKeys.map((fk) => identity(fk.source, fk.name)));
  if (shapes.size !== p.foreignKeys.length || shapes.size !== graphFks.size ||
      [...graphFks].some((id) => !shapes.has(id)) || [...shapes.keys()].some((id) => !graphFks.has(id))) {
    blockers.add('FK_SHAPE_COVERAGE_MISMATCH');
  }
  if (p.foreignKeys.some((fk) => !fk.validated || fk.match === 'p')) blockers.add('UNSUPPORTED_FK_SEMANTICS');
  const nulls = new Map(p.nullEvidence.map((item) => [`${identity(item.relation, item.key)}:${item.constraint}`, item]));
  if (nulls.size !== p.nullEvidence.length) blockers.add('DUPLICATE_NULL_EVIDENCE');
  const usedNulls = new Set<string>();
  for (const row of p.plan.rows) {
    for (const ref of row.references) {
      const evidenceId = `${identity(row.relation, row.key)}:${ref.constraint}`;
      const evidence = nulls.get(evidenceId); const fk = shapes.get(identity(row.relation, ref.constraint));
      usedNulls.add(evidenceId);
      if (!evidence || !fk || evidence.sourceNulls.length !== fk.sourceNullable.length) {
        blockers.add('NULL_EVIDENCE_MISMATCH'); continue;
      }
      const anyNull = evidence.sourceNulls.some(Boolean); const allNull = evidence.sourceNulls.every(Boolean);
      if (evidence.sourceNulls.some((isNull, i) => isNull && !fk.sourceNullable[i])) blockers.add('NON_NULL_COLUMN_VIOLATION');
      if (fk.match === 'f' && anyNull && !allNull) blockers.add('MATCH_FULL_PARTIAL_NULL');
      const absent = fk.match === 's' ? anyNull : allNull;
      if ((ref.targetKey === null) !== absent) blockers.add('NULL_EDGE_MISMATCH');
    }
  }
  if ([...nulls.keys()].some((id) => !usedNulls.has(id))) blockers.add('UNKNOWN_NULL_EVIDENCE');
  if (blockers.size) return blocked([...blockers].sort());
  const byIdentity = (a: { relation: string; key: string }, b: { relation: string; key: string }) =>
    byKey({ key: identity(a.relation, a.key) }, { key: identity(b.relation, b.key) });
  return { snapshotValid: true, executionEnabled: false, blockers: [] as string[], counts: graph.counts,
    // Not a bearer token, backup proof, TTL, live schema proof or execution permit.
    fingerprint: requestHash({ binding: p.expected, snapshotId: p.snapshot.id, isolation: p.snapshot.isolation,
      relations: [...p.plan.relations].sort(),
      foreignKeyTargets: [...p.plan.foreignKeys].sort((a, b) => byKey({ key: identity(a.source, a.name) }, { key: identity(b.source, b.name) })),
      rows: p.plan.rows.map((row) => ({ ...row, references: [...row.references].sort((a, b) => byKey({ key: a.constraint }, { key: b.constraint })) })).sort(byIdentity),
      content: [...p.content].sort(byIdentity), census: [...p.census].sort((a, b) => byKey({ key: a.relation }, { key: b.relation })),
      foreignKeys: [...p.foreignKeys].sort((a, b) => byKey({ key: identity(a.source, a.name) }, { key: identity(b.source, b.name) })),
      nullEvidence: [...p.nullEvidence].sort((a, b) => byKey({ key: `${identity(a.relation, a.key)}:${a.constraint}` }, { key: `${identity(b.relation, b.key)}:${b.constraint}` })),
    }),
  };
}
