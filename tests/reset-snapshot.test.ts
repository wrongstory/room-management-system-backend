import { describe, expect, it } from 'vitest';
import { requestHash } from '../src/lib/command.js';
import { inspectResetSnapshot } from '../src/modules/developer-reset/reset-snapshot.js';

function at<T>(rows: T[], index = 0): T {
  const row = rows[index]; if (row === undefined) throw new Error('missing fixture'); return row;
}
const snapshotId = 'd'.repeat(64);
function fixture() {
  const binding = { projectRef: 'a'.repeat(20), sourceCommit: 'b'.repeat(40),
    catalogFingerprint: 'c'.repeat(64), classificationFingerprint: 'e'.repeat(64) };
  const rows = [
    { relation: 'public.profiles', key: 'developer', disposition: 'keep', references: [] as { constraint: string; targetKey: string | null }[] },
    { relation: 'public.profiles', key: 'maid', disposition: 'remove', references: [] },
    { relation: 'private.receipts', key: 'receipt', disposition: 'keep', references: [{ constraint: 'actor_fk', targetKey: 'developer' as string | null }] },
  ];
  const relationRowCounts = [{ relation: 'public.profiles', count: 2 }, { relation: 'private.receipts', count: 1 }, { relation: 'private.empty', count: 0 }];
  const content = rows.map((row) => ({ relation: row.relation, key: row.key, snapshotId, contentToken: requestHash(row.key) }));
  return { expected: binding, snapshot: { ...binding, id: snapshotId, readOnly: true, isolation: 'repeatable read' },
    plan: { catalogFingerprint: binding.catalogFingerprint, snapshotCatalogFingerprint: binding.catalogFingerprint, complete: true,
      relations: relationRowCounts.map((entry) => entry.relation), relationRowCounts, rows,
      foreignKeys: [{ source: 'private.receipts', target: 'public.profiles', name: 'actor_fk' }],
    }, content,
    census: relationRowCounts.map((entry) => ({ ...entry, snapshotId,
      contentFingerprint: requestHash(content.filter((row) => row.relation === entry.relation)
        .map(({ key, contentToken }) => ({ key, contentToken })).sort((a, b) => a.key < b.key ? -1 : 1)) })),
    foreignKeys: [{ source: 'private.receipts', name: 'actor_fk', sourceNullable: [true, true], match: 's', validated: true }],
    nullEvidence: [{ relation: 'private.receipts', key: 'receipt', constraint: 'actor_fk', snapshotId, sourceNulls: [false, false] }],
  };
}
type F = ReturnType<typeof fixture>;

describe('coherent internal reset snapshot', () => {
  it('binds STABLE statement and REPEATABLE READ consistency as different evidence', () => {
    const f = fixture(); const rr = inspectResetSnapshot(f); f.snapshot.isolation = 'stable statement';
    const stable = inspectResetSnapshot(f);
    expect(rr.snapshotValid && stable.snapshotValid).toBe(true);
    expect(rr.fingerprint).not.toBe(stable.fingerprint);
  });
  it('checks a bounded consistent proposal without permitting execution or mutating it', () => {
    const f = fixture(); const before = structuredClone(f);
    expect(inspectResetSnapshot(f)).toMatchObject({ snapshotValid: true, executionEnabled: false,
      blockers: [], counts: { rows: 3, edges: 1, kept: 2 } });
    expect(f).toEqual(before);
  });
  it('canonicalizes collection order and preserves a content-sensitive fingerprint', () => {
    const f = fixture(); const result = inspectResetSnapshot(f);
    f.plan.rows.reverse(); f.plan.relations.reverse(); f.plan.relationRowCounts.reverse(); f.content.reverse(); f.census.reverse();
    expect(inspectResetSnapshot(f)).toEqual(result);
    at(f.content).contentToken = 'f'.repeat(64);
    expect(inspectResetSnapshot(f).blockers).toContain('CENSUS_CONTENT_MISMATCH');
    for (const entry of f.census) entry.contentFingerprint = requestHash(f.content.filter((row) => row.relation === entry.relation)
      .map(({ key, contentToken }) => ({ key, contentToken })).sort((a, b) => a.key < b.key ? -1 : 1));
    expect(inspectResetSnapshot(f).snapshotValid).toBe(true);
    expect(inspectResetSnapshot(f).fingerprint).not.toBe(result.fingerprint);
  });
  it.each([
    ['SNAPSHOT_BINDING_MISMATCH', (f: F) => { f.snapshot.projectRef = 'z'.repeat(20); }],
    ['SNAPSHOT_BINDING_MISMATCH', (f: F) => { f.snapshot.sourceCommit = 'f'.repeat(40); }],
    ['SNAPSHOT_BINDING_MISMATCH', (f: F) => { f.snapshot.classificationFingerprint = 'f'.repeat(64); }],
    ['SNAPSHOT_BINDING_MISMATCH', (f: F) => { f.plan.catalogFingerprint = 'f'.repeat(64); }],
    ['MIXED_SNAPSHOT', (f: F) => { at(f.content).snapshotId = 'f'.repeat(64); }],
    ['MIXED_SNAPSHOT', (f: F) => { at(f.census).snapshotId = 'f'.repeat(64); }],
    ['MIXED_SNAPSHOT', (f: F) => { at(f.nullEvidence).snapshotId = 'f'.repeat(64); }],
    ['CONTENT_ROW_COVERAGE_MISMATCH', (f: F) => { f.content.pop(); }],
    ['CONTENT_ROW_COVERAGE_MISMATCH', (f: F) => { at(f.content).key = 'unknown'; }],
    ['DUPLICATE_CONTENT_ROW', (f: F) => { f.content.push(at(f.content)); }],
    ['CENSUS_COVERAGE_MISMATCH', (f: F) => { f.census.pop(); }],
    ['CENSUS_COVERAGE_MISMATCH', (f: F) => { at(f.census).relation = 'private.unknown'; }],
    ['DUPLICATE_CENSUS_RELATION', (f: F) => { f.census.push(at(f.census)); }],
    ['CENSUS_COUNT_MISMATCH', (f: F) => { at(f.census).count = 1; }],
    ['CENSUS_CONTENT_MISMATCH', (f: F) => { at(f.census, 2).contentFingerprint = 'f'.repeat(64); }],
    ['ROW_COUNT_MISMATCH', (f: F) => { f.plan.rows.splice(1, 1); f.content.splice(1, 1); }],
    ['FK_SHAPE_COVERAGE_MISMATCH', (f: F) => { f.foreignKeys = []; }],
    ['FK_SHAPE_COVERAGE_MISMATCH', (f: F) => { f.foreignKeys.push(at(f.foreignKeys)); }],
    ['UNSUPPORTED_FK_SEMANTICS', (f: F) => { at(f.foreignKeys).validated = false; }],
    ['UNSUPPORTED_FK_SEMANTICS', (f: F) => { at(f.foreignKeys).match = 'p'; }],
    ['NULL_EVIDENCE_MISMATCH', (f: F) => { f.nullEvidence = []; }],
    ['NULL_EVIDENCE_MISMATCH', (f: F) => { at(f.nullEvidence).sourceNulls = [false]; }],
    ['DUPLICATE_NULL_EVIDENCE', (f: F) => { f.nullEvidence.push(at(f.nullEvidence)); }],
    ['UNKNOWN_NULL_EVIDENCE', (f: F) => { f.nullEvidence.push({ ...at(f.nullEvidence), key: 'unknown' }); }],
    ['PRESERVED_ROW_REFERENCES_REMOVED_ROW', (f: F) => { at(at(f.plan.rows, 2).references).targetKey = 'maid'; }],
  ] as const)('fails closed for %s', (blocker, mutate) => {
    const f = fixture(); mutate(f);
    const result = inspectResetSnapshot(f);
    expect(result).toMatchObject({ snapshotValid: false, executionEnabled: false, fingerprint: null, counts: null });
    expect(result.blockers).toContain(blocker);
  });
  it.each([
    ['s', [true, false], null, true], ['s', [false, false], null, false],
    ['s', [true, false], 'developer', false], ['s', [true, true], null, true],
    ['f', [true, false], null, false], ['f', [true, true], null, true],
    ['f', [false, false], 'developer', true], ['f', [false, false], null, false],
  ] as const)('checks composite MATCH %s null vector %s', (match, sourceNulls, targetKey, valid) => {
    const f = fixture(); at(f.foreignKeys).match = match; at(f.nullEvidence).sourceNulls = [...sourceNulls];
    at(at(f.plan.rows, 2).references).targetKey = targetKey;
    expect(inspectResetSnapshot(f).snapshotValid).toBe(valid);
    expect(inspectResetSnapshot(f).executionEnabled).toBe(false);
  });
  it('rejects a null in a NOT NULL source column even for MATCH SIMPLE', () => {
    const f = fixture(); at(f.foreignKeys).sourceNullable = [false, true];
    at(f.nullEvidence).sourceNulls = [true, false]; at(at(f.plan.rows, 2).references).targetKey = null;
    expect(inspectResetSnapshot(f).blockers).toContain('NON_NULL_COLUMN_VIOLATION');
  });
  it('binds FK targets even when opaque row keys happen to collide across relations', () => {
    const f = fixture(); at(f.plan.rows, 2).key = 'developer'; at(f.content, 2).key = 'developer';
    at(f.nullEvidence).key = 'developer';
    at(f.census, 1).contentFingerprint = requestHash([{ key: 'developer', contentToken: at(f.content, 2).contentToken }]);
    const result = inspectResetSnapshot(f);
    at(f.plan.foreignKeys).target = 'private.receipts';
    expect(inspectResetSnapshot(f).snapshotValid).toBe(true);
    expect(inspectResetSnapshot(f).fingerprint).not.toBe(result.fingerprint);
  });
  it('does not echo raw input or accept an incomplete legacy snapshot', () => {
    const result = inspectResetSnapshot({ ...fixture(), secret: 'do-not-echo' });
    expect(result.blockers).toEqual(['INVALID_SNAPSHOT_INPUT']);
    expect(JSON.stringify(result)).not.toContain('do-not-echo');
    expect(inspectResetSnapshot(fixture().plan).snapshotValid).toBe(false);
  });
});
