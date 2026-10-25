import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHistoricalBaselineReviewDesign } from '../scripts/lib/migration-baseline-review-design.mjs';

// Only the bundle ownership/access seam is synthetic. The production seam is the
// existing immutable Git bundle, independently covered by migration-source-bundle.test.ts.
const seam = vi.hoisted(() => ({ owned: new WeakMap<object, Map<string, Buffer>>(), failRead: false }));
vi.mock('../scripts/lib/migration-source-bundle.mjs', () => ({
  isOwnedMigrationSourceBundle: (bundle: object) => seam.owned.has(bundle),
  migrationHistorySourceBytes: (bundle: object, path: string) => {
    if (seam.failRead) throw new Error('synthetic private source and credential detail');
    const value = seam.owned.get(bundle)?.get(path);
    if (!value) throw new Error('synthetic private missing path');
    return Buffer.from(value);
  },
}));
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('SYNTHETIC_FIXTURE_MISSING');
  return value;
}
type RecordRow = { name: string; path: string; sourceSha256: string; sourceBytes: number; historyVersion: string; explanation: string };
const evidence = JSON.parse(readFileSync(new URL('../scripts/migration-baseline-review-evidence.json', import.meta.url), 'utf8')) as {
  rows: RecordRow[]; projectRef: string; baselineCount: number; baselineHead: string;
};
const manifest = JSON.parse(readFileSync(new URL('../supabase/migration-manifest.dev.json', import.meta.url), 'utf8')) as {
  migrations: { name: string; order: number }[];
};
function fixture() {
  const bytes = new Map(evidence.rows.map(row => [row.path,
    Buffer.from(readFileSync(new URL(`../${row.path}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n'))]));
  const files = manifest.migrations.map(row => {
    const archived = evidence.rows.find(item => item.name === row.name);
    return { name: row.name, order: row.order, path: archived?.path ?? `unrelated/${row.name}`,
      gitRawSha256: archived?.sourceSha256 ?? '0'.repeat(64) };
  });
  const bundle = { files, totalCount: files.length, bundleSha256: 'a'.repeat(64),
    modelSource: { projectRef: evidence.projectRef, sourceRef: 'refs/heads/codex/synthetic-review',
      headSha1: 'b'.repeat(40), treeSha1: 'c'.repeat(40), manifestSha256: 'd'.repeat(64), historySha256: 'e'.repeat(64) } };
  seam.owned.set(bundle, bytes);
  return { bundle, bytes };
}
afterEach(() => { seam.failRead = false; });

describe('#14 H1 source-bound historical review design, never baseline acceptance', () => {
  it('reproduces eight archived byte representations while preserving all twelve pending review records', () => {
    const { bundle } = fixture();
    const result = createHistoricalBaselineReviewDesign(bundle);
    expect(result.records).toHaveLength(12);
    expect(result.records.filter(row => row.archivedRepresentationReproduced)).toHaveLength(8);
    expect(result.records.filter(row => !row.archivedRepresentationReproduced).map(row => row.name)).toEqual([
      'initial_core_schema', 'harden_data_api_grants', 'complaint_deadlines_non_blocking', 'room_event_effective_lookup_indexes',
    ]);
    expect(result.records.filter(row => row.explanation === 'UNRESOLVED_ORIGINAL')).toHaveLength(2);
    expect(result.records.every(row => !row.baselineAccepted && !row.currentCatalogVerified && !row.liveHistoryVerified)).toBe(true);
    expect(result).toMatchObject({ status: 'DESIGN_ONLY_NOT_ACCEPTED', baselineAccepted: false, executionAllowed: false,
      operationalApproval: false, DBHistoryVerified: false, fullStateVerified: false, remoteSourceVerified: false,
      liveObservationCollected: false, runtimeHistoryModel: false });
    expect(result.checks).toHaveLength(8);
    expect(result.checks.every(check => check.status.startsWith('NOT_'))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/set local|create policy|sqlBytes|credential detail/iu);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.records[0])).toBe(true);
    expect(Object.isFrozen(result.checks)).toBe(true);
  });
  it.each(evidence.rows)('rejects changed source bytes for $name before interpreting the archived representation', row => {
    const { bundle, bytes } = fixture();
    bytes.set(row.path, Buffer.concat([bytes.get(row.path) ?? Buffer.alloc(0), Buffer.from('\n')]));
    expect(() => createHistoricalBaselineReviewDesign(bundle)).toThrow('BASELINE_REVIEW_DESIGN_UNAVAILABLE');
  });
  it('rejects a clone, shape-only verified claims and a getter without invoking the getter', () => {
    const { bundle } = fixture();
    expect(() => createHistoricalBaselineReviewDesign(structuredClone(bundle))).toThrow('BASELINE_REVIEW_DESIGN_UNAVAILABLE');
    expect(() => createHistoricalBaselineReviewDesign({ ...bundle, sourceEvidenceVerified: true })).toThrow('BASELINE_REVIEW_DESIGN_UNAVAILABLE');
    const getter = vi.fn(() => { throw new Error('private detail'); });
    expect(() => createHistoricalBaselineReviewDesign(Object.defineProperty({}, 'files', { get: getter }))).toThrow('BASELINE_REVIEW_DESIGN_UNAVAILABLE');
    expect(getter).not.toHaveBeenCalled();
  });
  it.each(['project', 'head', 'short', 'missing', 'pending', 'sourceHash'] as const)('rejects incompatible source scope: %s', kind => {
    const { bundle } = fixture();
    const firstName = required(evidence.rows[0]).name;
    if (kind === 'project') bundle.modelSource.projectRef = 'z'.repeat(20);
    if (kind === 'head') required(bundle.files[121]).name = 'another_head';
    if (kind === 'short') bundle.totalCount = 121;
    if (kind === 'missing') bundle.files = bundle.files.filter(row => row.name !== firstName);
    if (kind === 'pending') required(bundle.files.find(row => row.name === firstName)).order = 123;
    if (kind === 'sourceHash') required(bundle.files.find(row => row.name === firstName)).gitRawSha256 = 'f'.repeat(64);
    expect(() => createHistoricalBaselineReviewDesign(bundle)).toThrow('BASELINE_REVIEW_DESIGN_UNAVAILABLE');
  });
  it('binds the review design to its local source bundle without treating a new source digest as approval', () => {
    const first = fixture(); const second = fixture(); second.bundle.bundleSha256 = 'f'.repeat(64);
    const left = createHistoricalBaselineReviewDesign(first.bundle); const right = createHistoricalBaselineReviewDesign(second.bundle);
    expect(left.designSha256).not.toBe(right.designSha256);
    expect(right.baselineAccepted).toBe(false);
    expect(right.executionAllowed).toBe(false);
    for (const record of evidence.rows) expect(sha(required(first.bytes.get(record.path)))).toBe(record.sourceSha256);
  });
  it('contains source accessor failure without leaking native error detail', () => {
    const { bundle } = fixture(); seam.failRead = true;
    expect(() => createHistoricalBaselineReviewDesign(bundle)).toThrow(/^BASELINE_REVIEW_DESIGN_UNAVAILABLE$/u);
  });
  it('does not add historical representations to the runtime codec', async () => {
    const runtime = await import(new URL('../scripts/lib/migration-history-codec.mjs', import.meta.url).href) as {
      HISTORY_CODEC_HISTORICAL_REPRESENTATIONS: readonly string[];
    };
    expect(runtime.HISTORY_CODEC_HISTORICAL_REPRESENTATIONS).toEqual(['SOURCE_EXACT', 'SOURCE_APPEND_CRLF', 'LF_TO_CRLF_APPEND_CRLF']);
  });
});
