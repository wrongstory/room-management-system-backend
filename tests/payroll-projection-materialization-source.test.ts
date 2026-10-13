import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const candidate = read('20261013064056_payroll_projection_materialization.sql');
describe('#414 one-call payroll projection reuse (source only, DB NOT RUN)', () => {
  for (const [file, name, installed, hash] of [
    ['20260910114525_payroll_payment_results.sql', 'private.project_payroll_cycle_bounded', 'private.project_payroll_cycle_before_workflow(date,uuid,integer)', '0f2f288532d83a8b49259e96815d4628'],
    ['20261003064220_payroll_remittance_marker.sql', 'private.payroll_remittance_basis', 'private.payroll_remittance_basis(uuid,date)', '76783f5e09455472ee2774ba6d3e9766'],
  ]) {
    it(`pins and preserves every other byte of ${installed}`, () => {
      const source = read(file!);
      const start = source.indexOf(`create function ${name}(`);
      expect(start).toBeGreaterThan(-1);
      const bodyStart = source.indexOf('as $$', start) + 5;
      const body = source.slice(bodyStart, source.indexOf('$$;', bodyStart));
      expect(createHash('md5').update(body).digest('hex')).toBe(hash);
      expect(candidate).toContain(`('${installed}', '${hash}')`);
      expect(body.split('with projected as (')).toHaveLength(2);
      const changed = body.replace('with projected as (', 'with projected as materialized (');
      expect(changed.replace('with projected as materialized (', 'with projected as (')).toBe(body);
    });
  }
  it('preserves function catalog and fails closed on unexpected deployed source', () => {
    expect(candidate).toContain("to_jsonb(p)-'prosrc'");
    expect(candidate).toContain('after_catalog is distinct from before_catalog');
    expect(candidate).toContain('PAYROLL_PROJECTION_SOURCE_DRIFT');
    expect(candidate).not.toMatch(/\b(?:grant|revoke|create table|update public|delete from|insert into)\b/i);
  });
  it('targets the installed workflow wrapper clone, not the superseded original name', () => {
    const source = read('20260928095656_flat_cleaning_evidence_history_payroll.sql');
    expect(source).toContain("'FUNCTION private.project_payroll_cycle_before_workflow('");
    expect(source).toContain('select private.project_payroll_cycle_before_workflow(p_week_start,p_maid_profile_id,p_nested_limit)');
  });
});
