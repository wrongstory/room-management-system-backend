import { describe, expect, it, vi } from 'vitest';
import { createResetSnapshotBuilder, type ResetSnapshotSource } from '../src/modules/developer-reset/snapshot-builder.js';

const buffers = vi.hoisted(() => [] as Buffer[]);
vi.mock('node:crypto', async importOriginal => {
  const crypto = await importOriginal<typeof import('node:crypto')>();
  return { ...crypto, randomFillSync: (buffer: Buffer) => { buffers.push(buffer); return crypto.randomFillSync(buffer); } };
});

const scopeId = 'd'.repeat(64);
const typed = (name: string, value: string | null, pgType = 'pg_catalog.text') => ({ name, value, pgType });
const pk = (id: string) => [typed('id', id, 'pg_catalog.uuid')];
const id = '11111111-1111-4111-8111-111111111111';
const receipt = '22222222-2222-4222-8222-222222222222';
async function* stream<T>(values: T[]) { for (const value of values) yield value; }
function fixture() {
  const binding = { projectRef: 'a'.repeat(20), sourceCommit: 'b'.repeat(40),
    catalogFingerprint: 'c'.repeat(64), classificationFingerprint: 'e'.repeat(64) };
  const metadata = { binding, consistency: { kind: 'stable-statement', statementId: scopeId },
    relations: ['public.profiles', 'private.receipts', 'private.empty'].map(relation => ({ relation,
      columns: [{ name: 'id', pgType: 'pg_catalog.uuid' }, { name: 'value', pgType: 'pg_catalog.text' }], primaryKey: ['id'] })),
    foreignKeys: [{ source: 'private.receipts', target: 'public.profiles', name: 'actor_fk', sourceNullable: [true, true], match: 's', validated: true }],
  };
  const rows = [
    { scopeId, relation: 'public.profiles', key: pk(id), values: [...pk(id), typed('value', 'sensitive synthetic developer')], disposition: 'keep',
      references: [] as { constraint: string; targetKey: ReturnType<typeof pk> | null; sourceNulls: boolean[] }[] },
    { scopeId, relation: 'private.receipts', key: pk(receipt), values: [...pk(receipt), typed('value', 'sensitive synthetic history')], disposition: 'keep',
      references: [{ constraint: 'actor_fk', targetKey: pk(id), sourceNulls: [false, false] }] },
  ];
  const contents = rows.map(({ disposition: _disposition, references: _references, ...row }) => structuredClone(row));
  const census = metadata.relations.map(({ relation }) => ({ header: { scopeId, relation, count: contents.filter(row => row.relation === relation).length },
    contents: contents.filter(row => row.relation === relation) }));
  const expected = structuredClone({ binding, relations: metadata.relations, foreignKeys: metadata.foreignKeys });
  return { metadata, rows, census, expected };
}
type F = ReturnType<typeof fixture>;
function at<T>(values: T[], index = 0): T { const value = values[index]; if (!value) throw new Error('bad fixture'); return value; }
function source(f: F): ResetSnapshotSource {
  return { collect: async () => ({ metadata: f.metadata, rows: stream(f.rows),
    census: stream(f.census.map(entry => ({ header: entry.header, contents: stream(entry.contents) }))) }) };
}
const run = (f: F) => createResetSnapshotBuilder(f.expected).build(source(f));

describe('one-use trusted reset content snapshot builder', () => {
  it('checks independently collected content without returning raw rows, keys, tokens or executable authority', async () => {
    const f = fixture(); const before = structuredClone(f); const result = await run(f);
    expect(result).toMatchObject({ snapshotValid: true, executionEnabled: false, consistency: 'stable-statement',
      blockers: [], counts: { rows: 2, edges: 1, kept: 2 } });
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    for (const text of [id, receipt, 'sensitive', 'contentToken', 'public.profiles', scopeId]) expect(JSON.stringify(result)).not.toContain(text);
    expect(f).toEqual(before);
    expect(at(buffers, buffers.length - 1).every(byte => byte === 0)).toBe(true);
  });
  it('canonicalizes independently ordered cells, relations, rows and census values', async () => {
    const f = fixture(); f.metadata.relations.reverse(); f.rows.reverse(); f.census.reverse();
    for (const row of f.rows) { row.key.reverse(); row.values.reverse(); }
    for (const chunk of f.census) { chunk.contents.reverse(); for (const row of chunk.contents) row.values.reverse(); }
    expect((await run(f)).snapshotValid).toBe(true);
  });
  it('uses distinct per-build keys and refuses to reuse or reopen a completed builder', async () => {
    const f = fixture(); const builder = createResetSnapshotBuilder(f.expected);
    const first = await builder.build(source(f)); const second = await run(f);
    expect(first.snapshotValid && second.snapshotValid).toBe(true);
    expect(first.fingerprint).not.toBe(second.fingerprint);
    expect((await builder.build(source(f))).blockers).toEqual(['RESET_SNAPSHOT_BUILDER_CLOSED']);
  });
  it('captures the server-selected catalog and binding before caller mutation', async () => {
    const f = fixture(); const builder = createResetSnapshotBuilder(f.expected);
    f.expected.binding.projectRef = 'z'.repeat(20); at(f.expected.relations).columns.pop();
    expect((await builder.build(source(f))).snapshotValid).toBe(true);
  });
  it.each([
    ['CENSUS_CONTENT_MISMATCH', (f: F) => { at(at(f.census).contents).values[1] = typed('value', 'same count but changed content'); }],
    ['CENSUS_CONTENT_MISMATCH', (f: F) => { const row = at(at(f.census).contents); row.key = pk(receipt); row.values[0] = at(pk(receipt)); }],
    ['RESET_SNAPSHOT_CENSUS_MISMATCH', (f: F) => { at(f.census).header.count += 1; }],
    ['RESET_SNAPSHOT_CENSUS_MISMATCH', (f: F) => { const c = at(f.census); c.contents.push(at(c.contents)); c.header.count += 1; }],
    ['MISSING_RELATION_COUNT', (f: F) => { f.census.pop(); }],
    ['RESET_SNAPSHOT_INPUT_INVALID', (f: F) => { f.census.push(at(f.census)); }],
    ['RESET_SNAPSHOT_MIXED_SCOPE', (f: F) => { at(f.rows).scopeId = 'f'.repeat(64); }],
    ['RESET_SNAPSHOT_MIXED_SCOPE', (f: F) => { at(f.census).header.scopeId = 'f'.repeat(64); }],
    ['RESET_SNAPSHOT_MIXED_SCOPE', (f: F) => { at(at(f.census).contents).scopeId = 'f'.repeat(64); }],
    ['RESET_SNAPSHOT_BINDING_MISMATCH', (f: F) => { f.metadata.binding.projectRef = 'z'.repeat(20); }],
    ['RESET_SNAPSHOT_BINDING_MISMATCH', (f: F) => { f.metadata.binding.sourceCommit = 'f'.repeat(40); }],
    ['RESET_SNAPSHOT_BINDING_MISMATCH', (f: F) => { f.metadata.binding.catalogFingerprint = 'f'.repeat(64); }],
    ['RESET_SNAPSHOT_BINDING_MISMATCH', (f: F) => { f.metadata.binding.classificationFingerprint = 'f'.repeat(64); }],
    ['RESET_SNAPSHOT_CATALOG_MISMATCH', (f: F) => { at(at(f.metadata.relations).columns).pgType = 'pg_catalog.text'; }],
    ['RESET_SNAPSHOT_CATALOG_MISMATCH', (f: F) => { at(f.metadata.foreignKeys).target = 'private.empty'; }],
    ['RESET_SNAPSHOT_CATALOG_MISMATCH', (f: F) => { f.metadata.relations.pop(); }],
    ['RESET_SNAPSHOT_INPUT_INVALID', (f: F) => { at(at(f.rows).key).pgType = 'pg_catalog.text'; }],
    ['RESET_SNAPSHOT_INPUT_INVALID', (f: F) => { at(f.rows).values.pop(); }],
    ['RESET_SNAPSHOT_INPUT_INVALID', (f: F) => { at(f.rows).values.push(at(at(f.rows).values)); }],
    ['RESET_SNAPSHOT_KEY_CONTENT_MISMATCH', (f: F) => { at(f.rows).values[0] = at(pk(receipt)); }],
    ['RESET_SNAPSHOT_INPUT_INVALID', (f: F) => { at(at(f.rows).key).value = null; }],
    ['MISSING_REFERENCE', (f: F) => { at(f.rows, 1).references = []; }],
    ['PRESERVED_ROW_REFERENCES_REMOVED_ROW', (f: F) => { at(f.rows).disposition = 'remove'; }],
    ['NULL_EVIDENCE_MISMATCH', (f: F) => { at(at(f.rows, 1).references).sourceNulls = [false]; }],
    ['NULL_EDGE_MISMATCH', (f: F) => { at(at(f.rows, 1).references).targetKey = null; }],
  ] as const)('fails closed with no partial evidence for %s', async (code, mutate) => {
    const f = fixture(); mutate(f); const result = await run(f);
    expect(result).toMatchObject({ snapshotValid: false, executionEnabled: false, fingerprint: null, counts: null });
    expect(result.blockers).toContain(code);
  });
  it('supports MATCH SIMPLE partial null without inventing a target, and rejects MATCH FULL partial null', async () => {
    const f = fixture(); const ref = at(at(f.rows, 1).references); ref.sourceNulls = [true, false]; ref.targetKey = null;
    expect((await run(f)).snapshotValid).toBe(true);
    at(f.metadata.foreignKeys).match = 'f'; at(f.expected.foreignKeys).match = 'f';
    expect((await run(f)).blockers).toContain('MATCH_FULL_PARTIAL_NULL');
  });
  it('distinguishes STABLE same-statement from explicitly collected READ ONLY REPEATABLE READ', async () => {
    const f = fixture(); Object.assign(f.metadata, { consistency: { kind: 'repeatable-read', transactionId: scopeId } });
    expect(await run(f)).toMatchObject({ snapshotValid: true, consistency: 'repeatable-read', executionEnabled: false });
    Object.assign(f.metadata, { consistency: { kind: 'read-committed', transactionId: scopeId } });
    expect((await run(f)).blockers).toContain('RESET_SNAPSHOT_INPUT_INVALID');
  });
  it('refuses auth credential columns even if present in an expected internal catalog', async () => {
    const f = fixture(); const table = { relation: 'auth.users', columns: [{ name: 'id', pgType: 'pg_catalog.uuid' },
      { name: 'encrypted_password', pgType: 'pg_catalog.text' }], primaryKey: ['id'] };
    f.metadata.relations.push(table); f.expected.relations.push(table);
    expect((await run(f)).blockers).toContain('RESET_SNAPSHOT_AUTH_BOUNDARY');
  });
  it.each([{ rows: 1 }, { bytes: 100 }])('rejects the bounded capture instead of returning partial success %j', async limits => {
    const f = fixture(); expect((await createResetSnapshotBuilder(f.expected, limits).build(source(f))).blockers).toContain('RESET_SNAPSHOT_LIMIT_EXCEEDED');
  });
  it('rejects sparse arrays, accessor payloads and excessive property names without reading them', async () => {
    const sparse = fixture(); at(sparse.rows).values.length = 8;
    expect((await run(sparse)).blockers).toContain('RESET_SNAPSHOT_INPUT_INVALID');
    const f = fixture(); let called = false;
    Object.defineProperty(at(f.rows), 'secret', { enumerable: true, get: () => { called = true; throw new Error('synthetic-private'); } });
    expect((await run(f)).blockers).toContain('RESET_SNAPSHOT_INPUT_INVALID'); expect(called).toBe(false);
    const big = fixture(); Object.assign(at(big.rows), { ['x'.repeat(5000)]: null });
    const result = await createResetSnapshotBuilder(big.expected, { bytes: 4000 }).build(source(big));
    expect(result.blockers).toContain('RESET_SNAPSHOT_LIMIT_EXCEEDED');
  });
  it('masks source errors and closes failed builders', async () => {
    const f = fixture(); const builder = createResetSnapshotBuilder(f.expected);
    const result = await builder.build({ collect: async () => { throw new Error('synthetic-private'); } });
    expect(result.blockers).toEqual(['RESET_SNAPSHOT_SOURCE_UNAVAILABLE']); expect(JSON.stringify(result)).not.toContain('synthetic-private');
    expect(at(buffers, buffers.length - 1).every(byte => byte === 0)).toBe(true);
    expect((await builder.build(source(f))).blockers).toEqual(['RESET_SNAPSHOT_BUILDER_CLOSED']);
  });
  it('stops waiting for an uncooperative collector on timeout without claiming remote cancellation', async () => {
    const f = fixture(); let supplied: AbortSignal | undefined;
    const result = await createResetSnapshotBuilder(f.expected, { milliseconds: 20 }).build({ collect: signal => {
      supplied = signal; return new Promise(() => {});
    } });
    expect(result.blockers).toEqual(['RESET_SNAPSHOT_TIMEOUT']); expect(supplied?.aborted).toBe(true);
  });
  it('cancels a pending iterator on disposal and never reopens the builder', async () => {
    const f = fixture(); const builder = createResetSnapshotBuilder(f.expected); let started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; }); let returned = false;
    const capture = source(f); const collect = capture.collect.bind(capture);
    capture.collect = async signal => ({ ...await collect(signal), rows: { [Symbol.asyncIterator]: () => ({
      next: () => { started(); return new Promise(() => {}); }, return: async () => { returned = true; return { done: true, value: undefined }; },
    }) } });
    const promise = builder.build(capture); await waiting; builder.dispose();
    expect((await promise).blockers).toEqual(['RESET_SNAPSHOT_CANCELLED']); expect(returned).toBe(true);
    expect(at(buffers, buffers.length - 1).every(byte => byte === 0)).toBe(true);
    expect((await builder.build(source(f))).blockers).toEqual(['RESET_SNAPSHOT_BUILDER_CLOSED']);
  });
  it('honors external cancellation before collection and during collection', async () => {
    const f = fixture(); const abort = new AbortController(); abort.abort(); let called = false;
    const result = await createResetSnapshotBuilder(f.expected).build({ collect: async () => { called = true; return source(f).collect(abort.signal); } }, abort.signal);
    expect(result.blockers).toEqual(['RESET_SNAPSHOT_CANCELLED']); expect(called).toBe(false);
    const next = new AbortController(); const builder = createResetSnapshotBuilder(f.expected);
    const pending = builder.build({ collect: () => new Promise(() => {}) }, next.signal); next.abort();
    expect((await pending).blockers).toEqual(['RESET_SNAPSHOT_CANCELLED']);
  });
  it('retains the bounded timeout result when an iterator cleanup throws private details', async () => {
    const f = fixture(); const capture = source(f); const collect = capture.collect.bind(capture);
    capture.collect = async signal => ({ ...await collect(signal), rows: { [Symbol.asyncIterator]: () => ({
      next: () => new Promise(() => {}), return: () => { throw new Error('synthetic-private-cleanup'); },
    }) } });
    const result = await createResetSnapshotBuilder(f.expected, { milliseconds: 20 }).build(capture);
    expect(result.blockers).toEqual(['RESET_SNAPSHOT_TIMEOUT']);
    expect(JSON.stringify(result)).not.toContain('synthetic-private');
  });
  it.each([
    ['roomBaseline', 'RESET_ROOM_BASELINE_DISPOSITION_UNRESOLVED'],
    ['templateSource', 'RESET_TEMPLATE_DISPOSITION_UNRESOLVED'],
    ['unresolved', 'RESET_ROW_DISPOSITION_UNRESOLVED'],
  ])('keeps %s undecided after independent content comparison', async (candidate, code) => {
    const f = fixture(); at(f.rows).disposition = candidate;
    expect(await run(f)).toMatchObject({ snapshotValid: false, fingerprint: null, counts: null, blockers: [code] });
    at(at(f.census).contents).values[1] = typed('value', 'drift remains an error before policy waiting');
    expect((await run(f)).blockers).toContain('CENSUS_CONTENT_MISMATCH');
  });
  it('binds PostgreSQL array type identity without converting values to JS arrays', async () => {
    const f = fixture();
    for (const table of [at(f.metadata.relations), at(f.expected.relations)]) table.columns[1] = { name: 'value', pgType: 'pg_catalog._uuid' };
    at(f.rows).values[1] = typed('value', `{${id}}`, 'pg_catalog._uuid');
    at(at(f.census).contents).values[1] = typed('value', `{${id}}`, 'pg_catalog._uuid');
    expect((await run(f)).snapshotValid).toBe(true);
  });
});
