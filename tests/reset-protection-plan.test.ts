import { describe, expect, it } from 'vitest';
import { inspectResetProtectionPlan } from '../src/modules/developer-reset/reset-protection-plan.js';
import { resetRelationGroups, resetRowRuleFingerprint } from '../src/modules/developer-reset/reset-preview-groups.js';

const token = (n: number) => n.toString(16).padStart(64, '0');
function fixture() {
  const binding = { projectRef: 'a'.repeat(20), sourceCommit: 'b'.repeat(40), catalogFingerprint: 'c'.repeat(64),
    classificationFingerprint: resetRowRuleFingerprint, contentFingerprint: 'd'.repeat(64), snapshotId: 'e'.repeat(64) };
  const rows: { relation: string; key: string; disposition: 'keep' | 'remove' | 'roomBaseline' | 'templateSource' | 'unresolved';
    references: { constraint: string; targetKey: string | null }[] }[] = [
    { relation: 'private.attempt_photo_versions', key: token(1), disposition: 'keep', references: [{ constraint: 'photo_attempt_fk', targetKey: token(2) }] },
    { relation: 'public.cleaning_attempts', key: token(2), disposition: 'remove', references: [{ constraint: 'attempt_actor_fk', targetKey: token(3) }] },
    { relation: 'public.profiles', key: token(3), disposition: 'remove', references: [{ constraint: 'profile_auth_fk', targetKey: token(4) }] },
    { relation: 'auth.users', key: token(4), disposition: 'remove', references: [] },
    { relation: 'public.earnings', key: token(5), disposition: 'remove', references: [] },
  ];
  const relations = [...Object.values(resetRelationGroups).flat(), 'auth.users'];
  return { binding, selection: { binding: { ...binding }, templateSelection: 'CURRENT_PUBLISHED' as 'CURRENT_PUBLISHED' | 'ALL_VERSIONS' | null,
    requestFingerprint: token(11), reviewPlanFingerprint: token(12) as string | null },
  referenceCapture: { catalogFingerprint: binding.catalogFingerprint, snapshotCatalogFingerprint: binding.catalogFingerprint, complete: true,
    relations, relationRowCounts: relations.map(relation => ({ relation, count: rows.filter(row => row.relation === relation).length })),
    foreignKeys: [{ source: 'private.attempt_photo_versions', target: 'public.cleaning_attempts', name: 'photo_attempt_fk' },
      { source: 'public.cleaning_attempts', target: 'public.profiles', name: 'attempt_actor_fk' },
      { source: 'public.profiles', target: 'auth.users', name: 'profile_auth_fk' }], rows } };
}
const required = <T>(v: T | undefined | null): T => { if (v === undefined || v === null) throw new Error('fixture missing'); return v; };

describe('D01 protection manifest (no backup, restore or execution)', () => {
  it('finds the full photo-to-Auth preservation closure without changing removal candidates', () => {
    const f = fixture(), before = structuredClone(f), result = inspectResetProtectionPlan(f);
    expect(result).toMatchObject({ manifestPrepared: true, selectionBinding: 'REVIEW_PLAN',
      counts: { relations: 192, rows: 5, preservationRoots: 1, requiredByPreservation: 4, preservationConflicts: 3, removalCandidates: 4 },
      executionEnabled: false, executionGranted: false, liveDatabaseVerified: false, completeResetCoverage: false,
      backupVerified: false, restoreVerified: false, reservationBackupAcceptedAsResetProof: false });
    expect(result.blockers).toContain('RESET_PROTECTION_PRESERVATION_CONFLICT');
    expect(result.relations?.find(row => row.relation === 'public.earnings')).toMatchObject({ domain: 'PAYROLL_HISTORY', removalCandidates: 1, requiredByPreservation: 0 });
    expect(result.domains?.find(row => row.domain === 'AUTH_BOUNDARY')).toMatchObject({ captured: 1, backup: 'NOT_OBSERVED', restore: 'NOT_OBSERVED' });
    expect(f).toEqual(before);
    const output = JSON.stringify(result);
    for (const row of f.referenceCapture.rows) expect(output).not.toContain(row.key);
    for (const raw of ['photo_attempt_fk', 'requestFingerprint', f.binding.projectRef, f.selection.requestFingerprint]) expect(output).not.toContain(raw);
  });
  it('treats fixed photo/preserve roots as mandatory even if a proposed disposition tries to remove them', () => {
    const f = fixture(); required(f.referenceCapture.rows[0]).disposition = 'remove';
    expect(inspectResetProtectionPlan(f).counts).toMatchObject({ preservationRoots: 1, preservationConflicts: 4 });
    const history = fixture(); history.referenceCapture.rows.push({ relation: 'private.developer_reset_receipt_heads', key: token(6), disposition: 'remove', references: [] });
    required(history.referenceCapture.relationRowCounts.find(row => row.relation === 'private.developer_reset_receipt_heads')).count++;
    expect(inspectResetProtectionPlan(history).relations?.find(row => row.relation === 'private.developer_reset_receipt_heads')).toMatchObject({ requiredByPreservation: 1, preservationConflicts: 1 });
  });
  it('reports unresolved dispositions without selecting keep/remove, template status or a backup location', () => {
    const f = fixture(); required(f.referenceCapture.rows[1]).disposition = 'templateSource';
    f.selection.templateSelection = null; f.selection.reviewPlanFingerprint = null;
    const result = inspectResetProtectionPlan(f);
    expect(result).toMatchObject({ manifestPrepared: true, selectionBinding: 'CAPTURE_INTENT_ONLY', counts: { pending: 1 } });
    expect(result.blockers).toEqual(expect.arrayContaining(['RESET_PROTECTION_DISPOSITIONS_UNRESOLVED', 'RESET_PROTECTION_SELECTION_REQUIRED',
      'RESET_PROTECTION_FINAL_REVIEW_NOT_COMPOSED', 'RESET_PROTECTION_CAPACITY_LOCATION_RETENTION_NOT_VERIFIED']));
    expect(JSON.stringify(result)).not.toContain('storagePath');
  });
  it('handles cycles/shared parents once and never claims a deletion order', () => {
    const f = fixture();
    f.referenceCapture.foreignKeys.push({ source: 'auth.users', target: 'public.profiles', name: 'cycle_fk' });
    required(f.referenceCapture.rows[3]).references.push({ constraint: 'cycle_fk', targetKey: token(3) });
    const result = inspectResetProtectionPlan(f);
    expect(result.counts).toMatchObject({ requiredByPreservation: 4, preservationConflicts: 3 });
    expect(result).not.toHaveProperty('deletionOrder');
  });
  it('accepts a verified absent nullable edge without manufacturing a parent', () => {
    const f = fixture(); required(required(f.referenceCapture.rows[0]).references[0]).targetKey = null;
    const result = inspectResetProtectionPlan(f);
    expect(result.counts).toMatchObject({ requiredByPreservation: 1, preservationConflicts: 0 });
    expect(result.backupVerified).toBe(false); expect(result.restoreVerified).toBe(false);
  });
  it.each(['snapshotId', 'contentFingerprint', 'sourceCommit', 'catalogFingerprint', 'classificationFingerprint', 'projectRef'] as const)
    ('rejects a selection from a different %s', field => {
      const f = fixture(); f.selection.binding[field] = field === 'projectRef' ? 'z'.repeat(20) : '0'.repeat(field === 'sourceCommit' ? 40 : 64);
      expect(inspectResetProtectionPlan(f)).toMatchObject({ manifestPrepared: false, manifestFingerprint: null, blockers: ['RESET_PROTECTION_BINDING_CHANGED'] });
    });
  it.each(['missing-relation', 'duplicate-relation', 'extra-relation', 'classification', 'missing-count', 'count-drift', 'missing-edge', 'missing-target', 'incomplete', 'raw-identity'])
    ('does not produce a manifest from %s', change => {
      const f = fixture();
      if (change === 'missing-relation') f.referenceCapture.relations.pop();
      if (change === 'duplicate-relation') f.referenceCapture.relations.push('auth.users');
      if (change === 'extra-relation') f.referenceCapture.relations.push('private.unknown_secret');
      if (change === 'classification') { f.binding.classificationFingerprint = token(55); f.selection.binding.classificationFingerprint = token(55); }
      if (change === 'missing-count') f.referenceCapture.relationRowCounts.pop();
      if (change === 'count-drift') required(f.referenceCapture.relationRowCounts[0]).count++;
      if (change === 'missing-edge') required(f.referenceCapture.rows[0]).references.pop();
      if (change === 'missing-target') required(required(f.referenceCapture.rows[0]).references[0]).targetKey = token(99);
      if (change === 'incomplete') f.referenceCapture.complete = false;
      if (change === 'raw-identity') required(f.referenceCapture.rows[4]).key = 'raw-customer-uuid';
      const result = inspectResetProtectionPlan(f);
      expect(result).toMatchObject({ manifestPrepared: false, counts: null, relations: null, domains: null, executionGranted: false });
      expect(JSON.stringify(result)).not.toContain('unknown_secret');
    });
  it('binds selection, exact plan and row content identity while ignoring input ordering', () => {
    const f = fixture(), first = inspectResetProtectionPlan(f);
    f.referenceCapture.rows.reverse(); f.referenceCapture.foreignKeys.reverse(); f.referenceCapture.relations.reverse(); f.referenceCapture.relationRowCounts.reverse();
    expect(inspectResetProtectionPlan(f).manifestFingerprint).toBe(first.manifestFingerprint);
    f.selection.reviewPlanFingerprint = token(99);
    expect(inspectResetProtectionPlan(f).manifestFingerprint).not.toBe(first.manifestFingerprint);
    f.selection.reviewPlanFingerprint = token(12); f.selection.templateSelection = 'ALL_VERSIONS';
    expect(inspectResetProtectionPlan(f).manifestFingerprint).not.toBe(first.manifestFingerprint);
    f.selection.templateSelection = 'CURRENT_PUBLISHED'; f.binding.contentFingerprint = token(77); f.selection.binding.contentFingerprint = token(77);
    expect(inspectResetProtectionPlan(f).manifestFingerprint).not.toBe(first.manifestFingerprint);
  });
  it('never accepts reservation28/readback flags or arbitrary success hashes as whole-reset proof', () => {
    for (const proof of [{ reservationCount: 28, verified: true }, { backupProofHash: token(42) }, true]) {
      expect(inspectResetProtectionPlan({ ...fixture(), backupEvidence: proof }).manifestPrepared).toBe(false);
    }
    const result = inspectResetProtectionPlan(fixture());
    expect(result.blockers).toContain('RESET_PROTECTION_RESERVATION_BACKUP_INSUFFICIENT');
    expect(result.domains?.every(row => row.backup === 'NOT_OBSERVED' && row.restore === 'NOT_OBSERVED')).toBe(true);
  });
  it('does not invoke getters or expose provider errors/cause', () => {
    const f = fixture(); let invoked = false;
    Object.defineProperty(f, 'binding', { enumerable: true, get: () => { invoked = true; throw new Error('synthetic-sensitive-provider-message'); } });
    const result = inspectResetProtectionPlan(f);
    expect(invoked).toBe(false); expect(result.blockers).toEqual(['RESET_PROTECTION_INPUT_INVALID']);
    expect(JSON.stringify(result)).not.toContain('sensitive');
  });
});
