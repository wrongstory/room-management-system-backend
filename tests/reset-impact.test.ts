import { describe, expect, it } from 'vitest';
import { inspectResetImpact } from '../src/modules/developer-reset/reset-impact.js';

const schemaFingerprint = 'a'.repeat(64);
function first<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error('missing fixture row');
  return row;
}
function fixture() {
  return {
    manifest: {
      version: 'synthetic-v1', schemaFingerprint,
      relations: [
        { relation: 'public.profiles', disposition: 'mixed' },
        { relation: 'public.cleaning_template_versions', disposition: 'reseed' },
      ],
    },
    snapshot: {
      schemaFingerprint, complete: true,
      relations: [
        { relation: 'public.profiles', total: 3, preserve: 1, clear: 2, reseed: 0 },
        { relation: 'public.cleaning_template_versions', total: 4, preserve: 0, clear: 0, reseed: 4 },
      ],
    },
  };
}
describe('reset impact internal classification', () => {
  it('classifies counts without granting reset authority or changing inputs', () => {
    const f = fixture();
    const original = structuredClone(f);
    expect(inspectResetImpact(f.manifest, f.snapshot)).toMatchObject({
      classificationValid: true, executionEnabled: false, blockers: [],
      counts: { preserve: 1, clear: 2, reseed: 4 },
    });
    expect(f).toEqual(original);
  });
  it('uses order-independent diagnostic fingerprints', () => {
    const f = fixture();
    const a = inspectResetImpact(f.manifest, f.snapshot);
    f.manifest.relations.reverse();
    f.snapshot.relations.reverse();
    expect(inspectResetImpact(f.manifest, f.snapshot)).toEqual(a);
    f.manifest.version = 'synthetic-v2';
    expect(inspectResetImpact(f.manifest, f.snapshot).fingerprint).not.toBe(a.fingerprint);
  });
  it.each([
    ['INCOMPLETE_SNAPSHOT', (f: ReturnType<typeof fixture>) => { f.snapshot.complete = false; }],
    ['SCHEMA_MISMATCH', (f: ReturnType<typeof fixture>) => { f.snapshot.schemaFingerprint = 'b'.repeat(64); }],
    ['MISSING_RELATION', (f: ReturnType<typeof fixture>) => { f.snapshot.relations.pop(); }],
    ['UNCLASSIFIED_RELATION', (f: ReturnType<typeof fixture>) => { f.manifest.relations.pop(); }],
    ['DUPLICATE_RELATION', (f: ReturnType<typeof fixture>) => { f.manifest.relations.push(first(f.manifest.relations)); }],
    ['DUPLICATE_RELATION', (f: ReturnType<typeof fixture>) => { f.snapshot.relations.push(first(f.snapshot.relations)); }],
    ['COUNT_MISMATCH', (f: ReturnType<typeof fixture>) => { first(f.snapshot.relations).total = 4; }],
    ['DISPOSITION_MISMATCH', (f: ReturnType<typeof fixture>) => { first(f.manifest.relations).disposition = 'clear'; }],
  ] as const)('blocks %s', (reason, change) => {
    const f = fixture();
    change(f);
    const result = inspectResetImpact(f.manifest, f.snapshot);
    expect(result.blockers).toContain(reason);
    expect(result).toMatchObject({ executionEnabled: false, classificationValid: false, counts: null, fingerprint: null });
  });
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid count %s', (n) => {
    const f = fixture();
    first(f.snapshot.relations).total = n;
    expect(inspectResetImpact(f.manifest, f.snapshot).blockers).toEqual(['INVALID_INPUT']);
  });
  it('blocks aggregate overflow even when each table count is safe', () => {
    const f = fixture();
    f.snapshot.relations = f.snapshot.relations.map((row) => ({
      ...row, total: Number.MAX_SAFE_INTEGER, preserve: 0, clear: Number.MAX_SAFE_INTEGER, reseed: 0,
    }));
    f.manifest.relations.forEach((row) => { row.disposition = 'clear'; });
    expect(inspectResetImpact(f.manifest, f.snapshot).blockers).toContain('COUNT_MISMATCH');
  });
  it.each([null, {}, { secret: 'do-not-echo' }])('rejects malformed input without reflecting it', (input) => {
    expect(inspectResetImpact(input, fixture().snapshot)).toEqual({
      classificationValid: false, executionEnabled: false, blockers: ['INVALID_INPUT'],
      counts: null, fingerprint: null,
    });
  });
  it('rejects unexpected fields and SQL-like relation identifiers', () => {
    const f = fixture();
    expect(inspectResetImpact({ ...f.manifest, secret: 'do-not-echo' }, f.snapshot).blockers).toEqual(['INVALID_INPUT']);
    first(f.snapshot.relations).relation = 'public.profiles;DELETE';
    expect(inspectResetImpact(f.manifest, f.snapshot).blockers).toEqual(['INVALID_INPUT']);
  });
});
