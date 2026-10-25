import { describe, expect, it } from 'vitest';
import { createResetSnapshotBuilder } from '../src/modules/developer-reset/snapshot-builder.js';
import { resetRelationGroups, resetRowRuleFingerprint } from '../src/modules/developer-reset/reset-preview-groups.js';
import { resetReviewFixture, reviewId, reviewScope } from './helpers/reset-review.js';

const required = <T>(v: T | undefined | null): T => { if (v === undefined || v === null) throw new Error('fixture missing'); return v; };
function completeFixture() {
  const f = resetReviewFixture();
  f.metadata.binding.classificationFingerprint = resetRowRuleFingerprint;
  f.expected.binding.classificationFingerprint = resetRowRuleFingerprint;
  for (const relation of Object.values(resetRelationGroups).flat()) {
    if (f.metadata.relations.some(table => table.relation === relation)) continue;
    const table = { relation, columns: [{ name: 'id', pgType: 'pg_catalog.uuid' }], primaryKey: ['id'] };
    f.metadata.relations.push(table); f.expected.relations.push(structuredClone(table));
    f.census.push({ header: { relation, scopeId: reviewScope, count: 0 }, contents: [] });
  }
  return f;
}
function conflictingFixture() {
  const f = completeFixture();
  f.push('public.cleaning_attempts', 42, { template_snapshot: null }, 'remove');
  const attempt = required(f.rows.find(row => row.relation === 'public.cleaning_attempts'));
  const cell = { name: 'id', pgType: 'pg_catalog.uuid', value: reviewId(43) };
  f.rows.push({ relation: 'private.attempt_photo_versions', scopeId: reviewScope, key: [cell], values: [cell], disposition: 'keep',
    references: [{ constraint: 'photo_attempt_fk', targetKey: structuredClone(attempt.key), sourceNulls: [false] }] });
  const fk = { source: 'private.attempt_photo_versions', target: 'public.cleaning_attempts', name: 'photo_attempt_fk',
    sourceNullable: [false], match: 's' as const, validated: true as const };
  f.metadata.foreignKeys.push(fk); f.expected.foreignKeys.push(structuredClone(fk)); f.refreshCensus();
  return f;
}

describe('protection diagnostics in the existing content builder', () => {
  it('attaches a complete protection manifest to the existing composed plan without upgrading its PREPARED receipt', async () => {
    const f = completeFixture(), result = await f.run();
    expect(result.review).toMatchObject({ reviewPrepared: true, contentVerified: true,
      protection: { manifestPrepared: true, selectionBinding: 'REVIEW_PLAN', counts: { relations: 192 },
        completeResetCoverage: false, executionGranted: false, backupVerified: false, restoreVerified: false },
      receiptStatus: { valid: true, status: 'PREPARED', executionEnabled: false } });
    expect(result.snapshotValid).toBe(false);
    expect(result.review?.blockers).toEqual(expect.arrayContaining(['RESET_PROTECTION_LIVE_BACKUP_AND_RESTORE_NOT_VERIFIED',
      'RESET_PROTECTION_CAPACITY_LOCATION_RETENTION_NOT_VERIFIED', 'TEMPLATE_HISTORY_PROTECTION_REQUIRED']));
    expect(result.protection).toBeNull();
  });
  it('does not silently accept a partial catalog in an otherwise prepared synthetic review', async () => {
    const result = await resetReviewFixture().run();
    expect(result.review?.protection).toMatchObject({ manifestPrepared: false, manifestFingerprint: null, completeResetCoverage: false });
    expect(result.review?.blockers).toContain('RESET_PROTECTION_CLASSIFICATION_CHANGED');
  });
  it('keeps the existing non-FK current-pointer blocker and original template preservation findings', async () => {
    const f = completeFixture(); f.push('private.developer_catalog_previews', 80,
      { preview_kind: 'room_type_capacity', entity_id: reviewId(4), actor_profile_id: reviewId(1) });
    required(f.rows.find(row => row.relation === 'public.room_types')).disposition = 'remove'; f.refreshCensus();
    const result = await f.run();
    expect(result.review?.blockers).toEqual(expect.arrayContaining(['LOGICAL_REFERENCE_PRESERVED_TO_REMOVED',
      'RESET_PROTECTION_PRESERVATION_CONFLICT', 'TEMPLATE_HISTORY_PROTECTION_REQUIRED']));
    expect(result.review?.receipt).toBeNull(); expect(result.review?.protection?.executionGranted).toBe(false);
  });
  it('keeps review blocked while exposing only same-capture relation/count conflict diagnostics', async () => {
    const f = conflictingFixture(); const result = await f.run();
    expect(result).toMatchObject({ snapshotValid: false, review: null, protection: { manifestPrepared: true,
      selectionBinding: 'CAPTURE_INTENT_ONLY', counts: { relations: 192, preservationConflicts: 1 },
      executionEnabled: false, liveDatabaseVerified: false, backupVerified: false, restoreVerified: false } });
    expect(result.blockers).toContain('PRESERVED_ROW_REFERENCES_REMOVED_ROW');
    expect(result.protection?.blockers).toContain('RESET_PROTECTION_FINAL_REVIEW_NOT_COMPOSED');
    for (const raw of [reviewId(42), reviewId(43), 'synthetic_file_secret', 'rowToken', 'targetKey']) expect(JSON.stringify(result)).not.toContain(raw);
  });
  it.each(['missing-edge', 'null-shape', 'content-change', 'missing-census', 'partial-catalog'])
    ('does not label %s a complete protection capture', async change => {
      const f = conflictingFixture();
      const photo = required(f.rows.find(row => row.relation === 'private.attempt_photo_versions'));
      if (change === 'missing-edge') photo.references = [];
      if (change === 'null-shape') required(photo.references[0]).sourceNulls = [];
      if (change === 'content-change') required(required(required(f.census.find(row => row.header.relation === photo.relation)).contents[0]).values[0]).value = reviewId(99);
      if (change === 'missing-census') f.census.pop();
      if (change === 'partial-catalog') {
        f.metadata.relations = f.metadata.relations.filter(table => table.relation !== 'public.earnings');
        f.expected.relations = f.expected.relations.filter(table => table.relation !== 'public.earnings');
        f.census.splice(f.census.findIndex(row => row.header.relation === 'public.earnings'), 1);
      }
      const result = await f.run();
      expect(result.review).toBeNull();
      expect(result.protection?.manifestPrepared ?? false).toBe(false);
    });
  it('does not infer a selection when called through the ordinary snapshot-only path', async () => {
    const f = conflictingFixture(); const result = await createResetSnapshotBuilder(f.expected).build(f.source);
    expect(result.protection).toBeNull(); expect(result.snapshotValid).toBe(false);
  });
  it.each(['missing', 'role', 'status', 'auth', 'provenance'])('does not expose a completed conflict diagnostic for %s actor evidence', async mode => {
    const f = conflictingFixture();
    if (mode === 'missing') f.request.developerId = null;
    else if (mode === 'auth') f.request.receipt.authUserId = reviewId(999);
    else if (mode === 'provenance') f.request.receipt.actorProfileId = reviewId(999);
    else {
      const profile = required(f.rows.find(row => row.relation === 'public.profiles'));
      required(profile.values.find(cell => cell.name === mode)).value = mode === 'role' ? 'admin' : 'inactive';
      f.refreshCensus();
    }
    const result = await f.run(); expect(result.review).toBeNull(); expect(result.protection).toBeNull();
  });
  it.each(['mixed-scope', 'malformed', 'missing', 'invalid-time'])('rejects a %s review envelope even when only diagnosing an FK conflict', async mode => {
    const f = conflictingFixture();
    if (mode === 'mixed-scope') f.sidecar.scopeId = 'f'.repeat(64);
    if (mode === 'malformed') Object.assign(f.sidecar, { secret: 'synthetic-sensitive-metadata' });
    if (mode === 'invalid-time') f.sidecar.statementAt = 'synthetic-sensitive-metadata';
    const source = mode === 'missing' ? { collect: async (signal: AbortSignal) => {
      const { review: _review, ...collected } = await f.source.collect(signal); return collected;
    } } : f.source;
    const result = await createResetSnapshotBuilder(f.expected).buildReview(source, f.request);
    expect(result.review).toBeNull(); expect(result.protection).toBeNull();
    expect(JSON.stringify(result)).not.toContain('synthetic-sensitive-metadata');
    if (mode === 'mixed-scope') expect(result.blockers).toContain('RESET_REVIEW_MIXED_SCOPE');
  });
  it('keeps one-use and source-failure boundaries without leaking a previous manifest', async () => {
    const f = conflictingFixture(), builder = createResetSnapshotBuilder(f.expected);
    expect((await builder.buildReview(f.source, f.request)).protection?.manifestPrepared).toBe(true);
    expect((await builder.buildReview(f.source, f.request)).protection).toBeNull();
    const bad = await createResetSnapshotBuilder(f.expected).buildReview({ collect: async () => { throw new Error('synthetic-secret'); } }, f.request);
    expect(bad.protection).toBeNull(); expect(JSON.stringify(bad)).not.toContain('synthetic-secret');
  });
});
