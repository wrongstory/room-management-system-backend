import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { inspectResetLogicalReferences as inspect } from '../src/modules/developer-reset/logical-reference-inspector.js';
import { RESET_LOGICAL_REFERENCE_RULES as rules, RESET_LOGICAL_REFERENCE_REGISTRY_FINGERPRINT as fingerprint,
  findResetLogicalReferenceRule as find } from '../src/modules/developer-reset/logical-reference-registry.js';

const uuid = '11111111-1111-4111-8111-111111111111';
const h = (c: string) => c.repeat(64);
type Observation = { relation: string; path: string; rowToken: string; disposition: string;
  variant: string | null; before: string | null; retained: string | null;
  target: { relation: string; value: string; disposition: string } | null };
function fixture() {
  const binding = { projectRef: 'abcdefghijklmnopqrst', sourceCommit: 'a'.repeat(40),
    catalogFingerprint: h('a'), classificationFingerprint: h('b'), contentFingerprint: h('c'), snapshotId: h('d') };
  const observations: Observation[] = [
    { relation: 'private.developer_catalog_previews', path: 'entity_id', rowToken: h('1'), disposition: 'preserve',
      variant: 'room_deactivation', before: uuid, retained: uuid,
      target: { relation: 'public.rooms', value: uuid, disposition: 'roomBaseline' } },
    { relation: 'public.cleaning_attempts', path: 'room_snapshot', rowToken: h('2'), disposition: 'photoHold',
      variant: null, before: '{"roomId":"old-room-id","roomNumber":"101","roomType":{"id":"removed-type"}}',
      retained: '{"roomId":"old-room-id","roomNumber":"101","roomType":{"id":"removed-type"}}', target: null },
    { relation: 'private.photo_drive_identities', path: 'provider_file_id', rowToken: h('3'), disposition: 'photoHold',
      variant: null, before: 'synthetic_drive_file_123', retained: 'synthetic_drive_file_123', target: null },
    { relation: 'private.actor_activity_events', path: 'resource_id', rowToken: h('4'), disposition: 'preserve',
      variant: 'reservation', before: uuid, retained: uuid, target: null },
  ];
  const surfaces = observations.map(({ relation, path }) => ({ relation, path }));
  return { expected: { binding, registryFingerprint: fingerprint, surfaces },
    observed: { binding: { ...binding }, complete: true,
      census: surfaces.map(s => ({ ...s, count: 1 })), observations } };
}
function check(f = fixture()) { return inspect(f.expected, f.observed); }
describe('source-owned logical reference registry', () => {
  it('has finite unique source-backed fields and frozen rules without wildcard fallback', () => {
    expect(rules).toHaveLength(27);
    expect(new Set(rules.map(r => `${r.relation}:${r.path}`)).size).toBe(rules.length);
    expect(Object.isFrozen(rules)).toBe(true);
    for (const rule of rules) {
      expect(Object.isFrozen(rule)).toBe(true);
      const sql = readFileSync(`supabase/migrations/${rule.source}`, 'utf8');
      expect(sql).toContain(rule.relation);
      expect(sql).toContain(rule.path);
    }
    expect(find('private.photo_upload_operations', 'collection_item_id')).toBeUndefined();
    expect(find('public.rooms', 'future_payload')).toBeUndefined();
  });
  it('leaves report actor provenance with its existing composite foreign key', () => {
    const sql = readFileSync('supabase/migrations/20261005023103_post_approval_room_issue_ledger.sql', 'utf8');
    expect(sql).toMatch(/foreign key\s*\(\s*draft_id,source_submission_id,client_report_id,draft_created_by_profile_id,original_performer_profile_id\s*\)/);
    for (const path of ['draft_created_by_profile_id', 'original_performer_profile_id']) {
      expect(find('private.post_approval_room_issue_reports', path)).toBeUndefined();
    }
  });
  it('treats the durable receipt provenance as immutable history, not live actor/command authority', () => {
    for (const [relation, path] of [
      ['private.developer_reset_receipt_heads', 'actor_profile_id'], ['private.developer_reset_receipt_heads', 'binding'],
      ['private.developer_reset_receipt_heads', 'header'], ['private.developer_reset_receipt_events', 'entry'],
    ]) {
      expect(find(relation ?? '', path ?? '')).toMatchObject({ semantics: 'HISTORICAL_SNAPSHOT', targets: {} });
    }
  });
  it('leaves all seven template paths with the existing 129 owner', () => {
    const owner = readFileSync('src/modules/developer-reset/reset-template-evidence.ts', 'utf8');
    for (const path of ['template_snapshot.id', 'frozen_snapshot.templateVersionId', 'template_version_id',
      'previous_template_snapshot.id', 'previous_photo_contract.templateVersionId', 'previous_slots.template_version_id']) {
      expect(owner).toContain(path);
      expect(rules.some(r => r.path === path)).toBe(false);
    }
    // No second SQL collector, migration or template policy is introduced here.
    expect(find('private.flat_evidence_migration_receipts', 'previous_template_snapshot')).toBeUndefined();
  });
});
describe('logical reference preservation inspection', () => {
  it('separates current targets, frozen history and locators without granting full coverage', () => {
    expect(check()).toMatchObject({ logicalReferencesValid: true, executionEnabled: false,
      completeResetCoverage: false, externalObjectsVerified: false,
      counts: { surfaces: 4, rows: 4, currentPointers: 1, historicalSnapshots: 2, externalLocators: 1 } });
  });
  it.each(['remove', 'unresolved'])('blocks current pointers to %s targets', disposition => {
    const f = fixture(); f.observed.observations[0]!.target!.disposition = disposition;
    expect(check(f).logicalReferencesValid).toBe(false);
  });
  it.each(['wrong-type', 'wrong-id', 'missing'])('rejects %s current target evidence', kind => {
    const f = fixture(), row = f.observed.observations[0]!;
    if (kind === 'wrong-type') row.target!.relation = 'public.reservations';
    if (kind === 'wrong-id') row.target!.value = '22222222-2222-4222-8222-222222222222';
    if (kind === 'missing') row.target = null;
    expect(check(f).blockers).toContain('LOGICAL_REFERENCE_TARGET_UNRESOLVED');
  });
  it('maps the second preview kind to its exact room-type target', () => {
    const f = fixture(), row = f.observed.observations[0]!;
    row.variant = 'room_type_capacity'; row.target!.relation = 'public.room_types';
    expect(check(f).logicalReferencesValid).toBe(true);
    row.variant = 'new_unknown_kind';
    expect(check(f).blockers).toContain('LOGICAL_REFERENCE_VARIANT_UNREGISTERED');
  });
  it('keeps detached historical IDs intact without claiming current existence or authority', () => {
    const f = fixture();
    expect(check(f).logicalReferencesValid).toBe(true);
    f.observed.observations[1]!.target = { relation: 'public.rooms', value: uuid, disposition: 'roomBaseline' };
    expect(check(f).blockers).toContain('LOGICAL_REFERENCE_UNEXPECTED_TARGET');
  });
  it('cannot rewrite a historical payload to match current names, IDs or defaults', () => {
    const f = fixture(); f.observed.observations[1]!.retained = '{"roomId":"new","roomNumber":"101"}';
    expect(check(f).blockers).toContain('LOGICAL_REFERENCE_PRESERVED_VALUE_CHANGED');
  });
  it('preserves lossless PG JSON text including large numbers, NULL and unknown historical nested fields', () => {
    const f = fixture(), row = f.observed.observations[1]!;
    row.before = row.retained = '{"originalVersion":9007199254740993,"legacy":null,"futureHistoricalField":{"id":"old"}}';
    expect(check(f).logicalReferencesValid).toBe(true);
    row.retained = JSON.stringify(JSON.parse(row.before));
    expect(check(f).blockers).toContain('LOGICAL_REFERENCE_PRESERVED_VALUE_CHANGED');
  });
  it.each(['null', '[]', 'not-json', '1'])('rejects historical JSON root %s without exposing it', text => {
    const f = fixture(); f.observed.observations[1]!.before = f.observed.observations[1]!.retained = text;
    expect(check(f).blockers).toContain('LOGICAL_REFERENCE_VALUE_INVALID');
  });
  it('preserves nullable actor activity pairs and rejects mismatched/unknown resource kinds', () => {
    const f = fixture(), row = f.observed.observations[3]!;
    row.before = row.retained = null; row.variant = null;
    expect(check(f).logicalReferencesValid).toBe(true);
    row.variant = 'reservation';
    expect(check(f).blockers).toContain('LOGICAL_REFERENCE_VARIANT_UNREGISTERED');
    row.before = row.retained = uuid; row.variant = 'profile';
    expect(check(f).blockers).toContain('LOGICAL_REFERENCE_VARIANT_UNREGISTERED');
  });
  it('never clears, replaces or upgrades provider locators into provider existence proof', () => {
    const f = fixture(), row = f.observed.observations[2]!;
    row.retained = 'different_drive_file_456';
    expect(check(f).blockers).toContain('LOGICAL_REFERENCE_PRESERVED_VALUE_CHANGED');
    row.retained = row.before; row.target = { relation: 'public.rooms', value: uuid, disposition: 'preserve' };
    expect(check(f).blockers).toContain('LOGICAL_REFERENCE_UNEXPECTED_TARGET');
    expect(inspect(f.expected, { ...f.observed, providerExists: true }).logicalReferencesValid).toBe(false);
  });
  it.each(['https://example.invalid/file', '../file', '', null])('rejects malformed external locator %s', text => {
    const f = fixture(); f.observed.observations[2]!.before = f.observed.observations[2]!.retained = text;
    expect(check(f).blockers).toContain('LOGICAL_REFERENCE_VALUE_INVALID');
  });
  it('rejects new unregistered payloads even with zero rows and never hides pending item identities', () => {
    for (const s of [{ relation: 'public.rooms', path: 'future_payload' },
      { relation: 'private.photo_upload_operations', path: 'collection_item_id' }]) {
      const f = fixture(); f.expected.surfaces.push(s); f.observed.census.push({ ...s, count: 0 });
      expect(check(f).blockers).toContain('LOGICAL_REFERENCE_UNREGISTERED_SURFACE');
    }
  });
  it.each(['projectRef', 'sourceCommit', 'catalogFingerprint', 'classificationFingerprint', 'contentFingerprint', 'snapshotId'] as const)(
    'rejects changed %s bindings', field => {
      const f = fixture(); f.observed.binding[field] = (field === 'projectRef' ? 'z' : 'f').repeat(f.observed.binding[field].length);
      expect(check(f).blockers).toContain('LOGICAL_REFERENCE_SNAPSHOT_MISMATCH');
    });
  it('rejects registry drift, incomplete snapshots, missing/extra/duplicate census and duplicate rows', () => {
    const variants = Array.from({ length: 7 }, fixture);
    variants[0]!.expected.registryFingerprint = h('f'); variants[1]!.observed.complete = false;
    variants[2]!.observed.census.pop(); variants[3]!.observed.census.push({ relation: 'public.rooms', path: 'other', count: 0 });
    variants[4]!.observed.census.push(variants[4]!.observed.census[0]!);
    variants[5]!.observed.observations.push(variants[5]!.observed.observations[0]!);
    variants[6]!.expected.surfaces.push(variants[6]!.expected.surfaces[0]!);
    for (const f of variants) expect(check(f)).toMatchObject({ logicalReferencesValid: false, counts: null });
  });
  it('compares independent counts rather than accepting a truncated observation array', () => {
    const f = fixture(); f.observed.observations.pop();
    expect(check(f).blockers).toContain('LOGICAL_REFERENCE_ROW_COUNT_MISMATCH');
  });
  it('rejects remove/unresolved source dispositions rather than inventing preserved rows', () => {
    for (const disposition of ['remove', 'unresolved', 'resetCandidate']) {
      const f = fixture(); f.observed.observations[0]!.disposition = disposition;
      expect(check(f).blockers).toContain('LOGICAL_REFERENCE_INPUT_INVALID');
    }
  });
  it('returns fixed diagnostics and counts without source IDs, payloads or locators', () => {
    const f = fixture(), original = structuredClone(f), out = JSON.stringify(check(f));
    for (const row of f.observed.observations) {
      expect(out).not.toContain(row.rowToken);
      if (row.before) expect(out).not.toContain(row.before);
    }
    expect(f).toEqual(original);
    expect(inspect(null, { secret: 'do-not-return' })).toMatchObject({ logicalReferencesValid: false, counts: null });
  });
  it('does not execute getters and rejects cycles, prototypes, sparse arrays and oversized values', () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, 'binding', { enumerable: true, get() { getterCalls++; return {}; } });
    expect(inspect(accessor, {}).logicalReferencesValid).toBe(false); expect(getterCalls).toBe(0);
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    for (const value of [cyclic, new Date(), new Array(3), { large: 'x'.repeat(8 * 1024 * 1024 + 1) }]) {
      expect(inspect(value, {}).logicalReferencesValid).toBe(false);
    }
  });
});
