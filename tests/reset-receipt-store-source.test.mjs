import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { RESET_RELATION_NAMES, RESET_RELATION_GROUPS } from '../scripts/reset-relation-classification.mjs';
import { RESET_ROW_RULE_FINGERPRINT, resetRowDispositionExpression } from '../scripts/reset-row-policy.mjs';
const require = createRequire(import.meta.url);
const read = path => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
const path = 'supabase/migrations/20261025051231_developer_reset_receipt_store.sql';
const source = read(path);
const digest = value => createHash('sha256').update(value).digest('hex');
describe('durable reset receipt prepared source boundaries (no DB)', () => {
  it.each(['v15', 'v17'])('parses append135 and rollback-only regression with %s', async version => {
    const parser = require(`@pgsql/parser/${version}`);
    for (const p of [path, 'supabase/tests/developer_reset_receipt_store.sql'])
      expect((await parser.parse(read(p))).stmts.length).toBeGreaterThan(20);
  });
  it('keeps both generators deterministic without rewriting frozen127/128', () => {
    for (const generator of ['generate-reset-row-impact', 'generate-reset-receipt-store', 'generate-reset-preview-edge'])
      execFileSync(process.execPath, [`scripts/${generator}.mjs`, '--check']);
    const baseline = JSON.parse(read('scripts/reset-row-impact-baseline127.json'));
    expect(baseline.rules).toHaveLength(190); //189 app relations + Auth ID-only boundary.
    expect(baseline.rules.filter(r => r.relation.includes('reset_receipt'))).toEqual([]);
    expect(baseline.fingerprint).toBe('bf8bfdf62cc1e77687a02f227d1f8f6bcf5fddc516c5d2b8ad7880cdb850ded2');
    expect(read('supabase/migrations/20261025024327_developer_reset_row_impact.sql')).toContain(baseline.fingerprint);
    expect(source).toContain(RESET_ROW_RULE_FINGERPRINT);
    expect(RESET_ROW_RULE_FINGERPRINT).not.toBe(baseline.fingerprint);
    expect(digest(read('supabase/migrations/20261025024327_developer_reset_row_impact.sql')))
      .toBe(JSON.parse(read('supabase/migration-manifest.dev.json')).migrations.find(r => r.name === 'developer_reset_row_impact')?.sha256);
  });
  it('adds exactly two explicit preserved relations and leaves unknown relations unresolved', () => {
    expect(RESET_RELATION_NAMES).toHaveLength(191);
    expect(RESET_RELATION_GROUPS.preserve).toHaveLength(9);
    for (const name of ['heads', 'events'])
      expect(resetRowDispositionExpression(`private.developer_reset_receipt_${name}`, 'r')).toBe("'preserve'::text");
    expect(resetRowDispositionExpression('private.developer_reset_future', 'r')).toBeNull();
    expect(source).not.toContain('create or replace function private.collect_developer_reset_impact_preview');
    expect(source).not.toContain('create or replace function public.get_developer_reset_preview');
  });
  it('closes direct table access, pins ownership, and serializes immutable CAS and fresh readback', () => {
    for (const name of ['heads', 'events']) {
      expect(source).toContain(`alter table private.developer_reset_receipt_${name} force row level security`);
      expect(source).toContain(`before truncate on private.developer_reset_receipt_${name}`);
    }
    expect(source).toContain('unique(actor_profile_id,project_ref,key_digest)');
    expect(source).toContain('for update');
    expect(source).toContain('where id=r.id and version=p_expected_version and head_hash=p_expected_head returning * into r');
    expect(source.match(/perform private.assert_reset_receipt_identity\(p_actor,p_auth,p_session,p_binding\)/g)).toHaveLength(2);
    expect(source.match(/from private.developer_reset_receipt_events where receipt_id=r.id/g)).toHaveLength(2);
    expect(source).toContain('RESET_RECEIPT_PREFIX_ROLLBACK');
    expect(source).toContain("set lock_timeout='2s' set statement_timeout='7s'");
    expect(source).not.toMatch(/grant (?:select|insert|update|delete|all) on/i);
    expect(source).not.toMatch(/\b(?:delete from|truncate table|encrypted_password|dblink|http_post)\b/i);
  });
});
