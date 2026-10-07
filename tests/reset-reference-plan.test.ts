import { describe, expect, it } from 'vitest';
import { inspectResetReferencePlan } from '../src/modules/developer-reset/reset-reference-plan.js';

function at<T>(items: T[], index: number): T {
  const value = items[index];
  if (value === undefined) throw new Error('missing fixture item');
  return value;
}

function fixture() {
  return {
    catalogFingerprint: 'a'.repeat(64), snapshotCatalogFingerprint: 'a'.repeat(64), complete: true,
    relations: ['public.profiles', 'private.receipts'],
    relationRowCounts: [{ relation: 'public.profiles', count: 2 }, { relation: 'private.receipts', count: 1 }],
    foreignKeys: [{ source: 'private.receipts', target: 'public.profiles', name: 'actor_fk' }],
    rows: [
      { relation: 'public.profiles', key: 'developer', disposition: 'keep', references: [] as { constraint: string; targetKey: string | null }[] },
      { relation: 'public.profiles', key: 'maid', disposition: 'remove', references: [] },
      { relation: 'private.receipts', key: 'receipt', disposition: 'keep', references: [{ constraint: 'actor_fk', targetKey: 'developer' as string | null }] },
    ],
  };
}
describe('reset row reference plan', () => {
  it('accepts consistent preservation without authorizing reset or modifying inputs', () => {
    const f = fixture(); const original = structuredClone(f);
    expect(inspectResetReferencePlan(f)).toEqual({ referencesValid: true, executionEnabled: false,
      blockers: [], counts: { rows: 3, edges: 1, kept: 2 } });
    expect(f).toEqual(original);
  });
  it('blocks a preserved receipt referencing a removed maid', () => {
    const f = fixture(); at(at(f.rows, 2).references, 0).targetKey = 'maid';
    expect(inspectResetReferencePlan(f).blockers).toContain('PRESERVED_ROW_REFERENCES_REMOVED_ROW');
  });
  it('allows removed child to reference preserved parent', () => {
    const f = fixture(); at(f.rows, 2).disposition = 'remove';
    expect(inspectResetReferencePlan(f).referencesValid).toBe(true);
  });
  it('requires explicit null for a verified optional reference', () => {
    const f = fixture(); at(at(f.rows, 2).references, 0).targetKey = null;
    expect(inspectResetReferencePlan(f).counts?.edges).toBe(0);
    at(f.rows, 2).references = [];
    expect(inspectResetReferencePlan(f).blockers).toContain('MISSING_REFERENCE');
  });
  it.each([
    ['INCOMPLETE_SNAPSHOT', (f: ReturnType<typeof fixture>) => { f.complete = false; }],
    ['CATALOG_MISMATCH', (f: ReturnType<typeof fixture>) => { f.snapshotCatalogFingerprint = 'b'.repeat(64); }],
    ['DUPLICATE_RELATION', (f: ReturnType<typeof fixture>) => { f.relations.push('public.profiles'); }],
    ['UNKNOWN_RELATION', (f: ReturnType<typeof fixture>) => { f.relations.pop(); }],
    ['DUPLICATE_ROW', (f: ReturnType<typeof fixture>) => { f.rows.push(structuredClone(at(f.rows, 0))); }],
    ['DUPLICATE_CONSTRAINT', (f: ReturnType<typeof fixture>) => { f.foreignKeys.push({ ...at(f.foreignKeys, 0) }); }],
    ['DUPLICATE_REFERENCE', (f: ReturnType<typeof fixture>) => { at(f.rows, 2).references.push({ ...at(at(f.rows, 2).references, 0) }); }],
    ['UNKNOWN_CONSTRAINT', (f: ReturnType<typeof fixture>) => { f.foreignKeys = []; }],
    ['MISSING_TARGET_ROW', (f: ReturnType<typeof fixture>) => { f.rows.shift(); }],
  ] as const)('blocks %s', (reason, mutate) => {
    const f = fixture(); mutate(f);
    expect(inspectResetReferencePlan(f)).toMatchObject({ referencesValid: false, executionEnabled: false, counts: null });
    expect(inspectResetReferencePlan(f).blockers).toContain(reason);
  });
  it('handles preserved and removed cycles without claiming an execution order', () => {
    for (const disposition of ['keep', 'remove']) {
      const f = fixture();
      f.foreignKeys.push({ source: 'public.profiles', target: 'private.receipts', name: 'receipt_fk' });
      f.rows = [at(f.rows, 0), at(f.rows, 2)];
      at(f.relationRowCounts, 0).count = 1;
      for (const row of f.rows) row.disposition = disposition;
      at(f.rows, 0).references = [{ constraint: 'receipt_fk', targetKey: 'receipt' }];
      expect(inspectResetReferencePlan(f)).toMatchObject({ referencesValid: true, executionEnabled: false });
    }
  });
  it('rejects implicit reseed and never echoes untrusted values', () => {
    const f = fixture(); at(f.rows, 0).disposition = 'reseed';
    expect(inspectResetReferencePlan(f)).toMatchObject({ blockers: ['INVALID_INPUT'] });
    expect(JSON.stringify(inspectResetReferencePlan({ secret: 'do-not-echo' }))).not.toContain('do-not-echo');
  });
  it('accepts an explicit auth edge and checks its target', () => {
    const f = fixture(); f.relations.push('auth.users');
    f.foreignKeys.push({ source: 'public.profiles', target: 'auth.users', name: 'auth_fk' });
    for (const row of f.rows.filter((r) => r.relation === 'public.profiles')) {
      row.references.push({ constraint: 'auth_fk', targetKey: row.key });
    }
    expect(inspectResetReferencePlan(f).blockers).toContain('MISSING_TARGET_ROW');
  });
  it.each(['keep', 'remove'])('blocks omission of an unreferenced %s row', (disposition) => {
    const f = fixture(); at(f.rows, 1).disposition = disposition;
    f.rows.splice(1, 1);
    expect(inspectResetReferencePlan(f)).toMatchObject({
      referencesValid: false, executionEnabled: false, blockers: ['ROW_COUNT_MISMATCH'], counts: null,
    });
  });
  it('requires an explicit zero for an empty relation', () => {
    const f = fixture(); f.relations.push('private.empty');
    expect(inspectResetReferencePlan(f).blockers).toContain('MISSING_RELATION_COUNT');
    f.relationRowCounts.push({ relation: 'private.empty', count: 0 });
    expect(inspectResetReferencePlan(f).referencesValid).toBe(true);
  });
  it.each([
    ['MISSING_RELATION_COUNT', (f: ReturnType<typeof fixture>) => { f.relationRowCounts.pop(); }],
    ['UNKNOWN_RELATION_COUNT', (f: ReturnType<typeof fixture>) => { f.relationRowCounts.push({ relation: 'private.unknown', count: 0 }); }],
    ['DUPLICATE_RELATION_COUNT', (f: ReturnType<typeof fixture>) => { f.relationRowCounts.push({ ...at(f.relationRowCounts, 0) }); }],
    ['ROW_COUNT_MISMATCH', (f: ReturnType<typeof fixture>) => { at(f.relationRowCounts, 0).count = 1; }],
    ['ROW_COUNT_MISMATCH', (f: ReturnType<typeof fixture>) => { at(f.relationRowCounts, 0).count = 10001; }],
  ] as const)('rejects count coverage: %s', (reason, mutate) => {
    const f = fixture(); mutate(f);
    expect(inspectResetReferencePlan(f).blockers).toContain(reason);
    expect(inspectResetReferencePlan(f).executionEnabled).toBe(false);
  });
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, '2', null])('rejects invalid count %s', (count) => {
    const f = fixture();
    expect(inspectResetReferencePlan({ ...f, relationRowCounts: [{ relation: 'public.profiles', count }] }).blockers)
      .toEqual(['INVALID_INPUT']);
  });
  it('does not infer counts for the previous internal input contract', () => {
    const { relationRowCounts: _counts, ...legacy } = fixture();
    expect(inspectResetReferencePlan(legacy).blockers).toEqual(['INVALID_INPUT']);
  });
  it('accepts reordered rows and counts without mutating input', () => {
    const f = fixture(); f.rows.reverse(); f.relationRowCounts.reverse();
    const before = structuredClone(f);
    expect(inspectResetReferencePlan(f).referencesValid).toBe(true);
    expect(f).toEqual(before);
  });
});
