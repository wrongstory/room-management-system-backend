import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { summarizeResetPreview } from '../src/modules/developer-reset/reset-preview.js';
import { resetRelationGroups, resetRowRuleFingerprint } from '../src/modules/developer-reset/reset-preview-groups.js';
// @ts-expect-error Source-only generator module has no TypeScript declarations.
import { evaluateResetRowCandidate, RESET_ROW_RULES, resetRowDispositionExpression } from '../scripts/reset-row-policy.mjs';

const labels = ['preserve', 'roomBaseline', 'resetCandidate', 'templateSource', 'photoHold', 'unresolved'];
const counts = (label = 'preserve', size = 1): Record<string, number> => Object.fromEntries(labels.map(name => [name, name === label ? size : 0]));
function fixture() {
  const relations = Object.values(resetRelationGroups).flat().map(relation => ({ relation: relation as string, kind: 'r', partition: false, observedRows: 1, exact: true }));
  return { format: 'reset-preview-inventory-v1', readOnly: true, capturedAt: '2026-10-25T00:00:00Z', snapshotId: 'a'.repeat(64), relations,
    rowImpact: { format: 'reset-row-impact-v1', snapshotId: 'a'.repeat(64), ruleFingerprint: resetRowRuleFingerprint,
      relations: relations.map(({ relation }) => ({ relation, rowCount: 1 as number | null, counts: counts() as Record<string, number> | null })),
      authBoundary: { rowCount: 2, independentCount: 2, preserve: 1, resetCandidate: 1, unresolved: 0 },
      expectedForeignKeys: 1, unsupportedForeignKeys: 0,
      foreignKeys: [{ source: 'public.profiles', constraint: 'profiles_auth_user_id_fkey', impact: {
        sourceRows: 1, nullEdges: 0, partialNulls: 0, missingTargets: 0, preservedToRemoved: 0, unresolvedTargets: 0 } }] } };
}
function first<T>(items: T[]): T { if (!items[0]) throw new Error('fixture missing'); return items[0]; }
const profiles = [{ id: 'developer-id', auth_user_id: 'developer-auth', role: 'developer' }, { id: 'maid-id', auth_user_id: 'maid-auth', role: 'maid' }];

describe('reset candidate row policy and aggregate collector evidence', () => {
  it('covers every inventoried relation exactly once without unknown-table fallback', () => {
    expect(RESET_ROW_RULES.map((r: { relation: string }) => r.relation).sort()).toEqual(Object.values(resetRelationGroups).flat().sort());
    expect(resetRowDispositionExpression('private.future_table', 'r')).toBeNull();
    expect(() => resetRowDispositionExpression('public.profiles', 'r;select')).toThrow();
    expect(evaluateResetRowCandidate('private.future_table', {}, profiles)).toBe('unresolved');
  });
  it('keeps developer accounts and linked security, classifies business roles and rejects dangling identities', () => {
    expect(evaluateResetRowCandidate('public.profiles', { role: 'developer' }, [])).toBe('preserve');
    for (const role of ['admin', 'maid']) expect(evaluateResetRowCandidate('public.profiles', { role }, [])).toBe('resetCandidate');
    for (const [relation, field, developer, maid] of [
      ['public.login_aliases', 'profile_id', 'developer-id', 'maid-id'],
      ['private.auth_password_versions', 'auth_user_id', 'developer-auth', 'maid-auth'],
      ['private.password_change_commands', 'actor_profile_id', 'developer-id', 'maid-id'],
      ['auth.users', 'id', 'developer-auth', 'maid-auth'],
    ] as const) {
      expect(evaluateResetRowCandidate(relation, { [field]: developer }, profiles)).toBe('preserve');
      expect(evaluateResetRowCandidate(relation, { [field]: maid }, profiles)).toBe('resetCandidate');
      expect(evaluateResetRowCandidate(relation, { [field]: 'orphan' }, profiles)).toBe('unresolved');
    }
    const secretRow = { id: 'developer-auth', get encrypted_password() { throw new Error('must not read password'); } };
    expect(evaluateResetRowCandidate('auth.users', secretRow, profiles)).toBe('preserve');
  });
  it('retains photos, room baseline, nonce/security state and template-source separation', () => {
    for (const table of ['public.submission_photos', 'private.photo_provider_objects', 'private.post_approval_issue_provider_objects', 'private.photo_upload_batches', 'private.photo_upload_batch_members'])
      expect(evaluateResetRowCandidate(table, {}, [])).toBe('photoHold');
    expect(evaluateResetRowCandidate('public.rooms', {}, [])).toBe('roomBaseline');
    expect(evaluateResetRowCandidate('public.cleaning_template_versions', {}, [])).toBe('templateSource');
    expect(evaluateResetRowCandidate('private.login_rate_limit_windows', {}, [])).toBe('preserve');
    expect(evaluateResetRowCandidate('private.room_pin_nonce_reservations', {}, [])).toBe('preserve');
    expect(evaluateResetRowCandidate('private.command_executions', { actor_profile_id: 'developer-id' }, profiles)).toBe('resetCandidate');
  });
  it('accepts coherent independent census evidence and still forbids execution', () => {
    const result = summarizeResetPreview(fixture());
    expect(result.rowImpact).toMatchObject({ available: true, diagnosticComplete: true, referencesValid: true, candidateCounts: { preserve: 191 } });
    expect(result.executionEnabled).toBe(false);
    expect(result.blockers).not.toContain('ROW_DISPOSITION_RULES_UNIMPLEMENTED');
    expect(result.blockers).toContain('RESET_RECOVERY_SCOPE_UNDECIDED');
    expect(JSON.stringify(result)).not.toMatch(/public\.profiles|profiles_auth_user_id/);
  });
  it.each(['preservedToRemoved', 'missingTargets', 'unresolvedTargets'] as const)('reports actual %s conflicts without changing row policy', field => {
    const value = fixture(); first(value.rowImpact.foreignKeys).impact[field] = 1;
    expect(summarizeResetPreview(value).rowImpact).toMatchObject({ diagnosticComplete: true, referencesValid: false, [field]: 1 });
  });
  it('does not accept absent evidence as a verified row plan', () => {
    const { rowImpact: _, ...oldInventory } = fixture();
    expect(summarizeResetPreview(oldInventory).rowImpact).toMatchObject({ available: false, diagnosticComplete: false, referencesValid: false });
  });
  it('reports an unlinked Auth account as unresolved using only bounded ID counts', () => {
    const value = fixture(); value.rowImpact.authBoundary.unresolved = 1; value.rowImpact.authBoundary.resetCandidate = 0;
    const result = summarizeResetPreview(value);
    expect(result.rowImpact).toMatchObject({ diagnosticComplete: true, referencesValid: false,
      authAccounts: { observedRows: 2, preserve: 1, resetCandidate: 0, unresolved: 1 } });
    expect(result.blockers).toContain('ROW_DISPOSITION_UNRESOLVED');
  });
  it.each([
    (v: ReturnType<typeof fixture>) => { first(v.rowImpact.relations).rowCount = 0; },
    (v: ReturnType<typeof fixture>) => { first(v.rowImpact.relations).counts = counts('preserve', 0); },
    (v: ReturnType<typeof fixture>) => { v.rowImpact.relations.pop(); },
    (v: ReturnType<typeof fixture>) => { v.rowImpact.relations.push(first(v.rowImpact.relations)); },
    (v: ReturnType<typeof fixture>) => { v.rowImpact.snapshotId = 'b'.repeat(64); },
    (v: ReturnType<typeof fixture>) => { v.rowImpact.ruleFingerprint = 'b'.repeat(64); },
    (v: ReturnType<typeof fixture>) => { v.rowImpact.expectedForeignKeys = 2; },
    (v: ReturnType<typeof fixture>) => { first(v.rowImpact.foreignKeys).impact.nullEdges = 2; },
    (v: ReturnType<typeof fixture>) => { first(v.rowImpact.foreignKeys).impact.partialNulls = 1; },
    (v: ReturnType<typeof fixture>) => { first(v.rowImpact.foreignKeys).impact.sourceRows = 2; },
    (v: ReturnType<typeof fixture>) => { first(v.rowImpact.relations).counts = null; },
    (v: ReturnType<typeof fixture>) => { v.rowImpact.authBoundary.independentCount = 1; },
    (v: ReturnType<typeof fixture>) => { v.rowImpact.authBoundary.unresolved = 1; },
  ])('rejects inconsistent or mixed-snapshot collector output', change => {
    const value = fixture(); change(value); expect(() => summarizeResetPreview(value)).toThrow('RESET_PREVIEW_UNAVAILABLE');
  });
  it('marks truncation, unsupported equality and unknown ownership incomplete or unresolved', () => {
    const value = fixture(); value.rowImpact.unsupportedForeignKeys = 1; value.rowImpact.foreignKeys = [];
    first(value.rowImpact.relations).counts = counts('unresolved');
    expect(summarizeResetPreview(value).rowImpact).toMatchObject({ diagnosticComplete: false, referencesValid: false, unsupportedForeignKeys: 1 });
    const bounded = fixture(); first(bounded.relations).observedRows = 10001; first(bounded.relations).exact = false;
    first(bounded.rowImpact.relations).rowCount = 10001; first(bounded.rowImpact.relations).counts = counts('preserve', 10001);
    expect(summarizeResetPreview(bounded).rowImpact.diagnosticComplete).toBe(false);
  });
  it('checks generated SQL and fixed ACL/snapshot/equality boundaries without running SQL', () => {
    expect(() => execFileSync(process.execPath, ['scripts/generate-reset-row-impact.mjs', '--check'])).not.toThrow();
    const sql = readFileSync('supabase/migrations/20261025024327_developer_reset_row_impact.sql', 'utf8');
    expect(sql).toContain('unnest(k.conkey,k.confkey,k.conpfeqop) with ordinality');
    expect(sql).toContain('a.atttypid=op.oprright and b.atttypid=op.oprleft');
    expect(sql).toContain('a.attcollation=b.attcollation');
    expect(sql).toContain("k.source_schema not in ('public','private')");
    expect(sql).toContain("k.target_schema='auth' and k.target_name='users'");
    expect(sql).toContain('select private.collect_developer_reset_inventory()||jsonb_build_object');
    expect(sql).toContain('private.collect_developer_reset_row_impact()');
    expect(sql).toContain("set statement_timeout='7s'");
    expect(sql).toContain('for pass in 1..2 loop');
    expect(sql).not.toMatch(/encrypted_password|to_jsonb\(|\b(?:delete\s+from|truncate|insert\s+into|update\s+(?:public|private|auth)\.|disable\s+trigger)\b/i);
  });
});
