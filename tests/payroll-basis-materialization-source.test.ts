import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const read = async (path: string) => (await readFile(new URL(`../${path}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const original = await read('supabase/migrations/20261003064220_payroll_remittance_marker.sql');
const patch = await read('supabase/migrations/20261013063440_payroll_remittance_basis_materialized.sql');
const fixture = await read('supabase/tests/payroll_remittance_marker.sql');
const source = original.split('create function private.payroll_remittance_basis(')[1]?.split('as $$')[1]?.split('$$;')[0];
if (!source) throw new Error('BASIS_SOURCE_MISSING');
const md5 = (value: string) => createHash('md5').update(value).digest('hex');
const before = 'with projected as (', after = 'with projected as materialized (';
const candidate = source.replace(before, after);

describe('#416 payroll basis source only, DB/EXPLAIN NOT RUN', () => {
  it('pins the baseline and changes only CTE materialization', () => {
    expect(md5(source)).toBe('76783f5e09455472ee2774ba6d3e9766');
    expect(patch).toContain(md5(source));
    expect(source.split(before)).toHaveLength(2);
    expect(patch).toContain(`old_fragment constant text := '${before}'`);
    expect(patch).toContain(`new_fragment constant text := '${after}'`);
    expect(candidate.replace(after, before)).toBe(source);
    expect(candidate.match(/private\.project_payroll_cycle_bounded\(p_week,p_maid,1\)/g)).toHaveLength(1);
    expect([...candidate.matchAll(/value->'([^']+)'/g)].map(match => match[1]).sort()).toEqual([
      'accrualAmount', 'adjustmentAmount', 'carryInAmount', 'carryOutAmount',
      'lateEarningAmount', 'lockedAmount', 'payableAmount', 'totalAmount',
    ]);
  });
  it('keeps signature, owner, ACL, volatility and all other catalog fields', () => {
    expect(patch).toContain("to_jsonb(p) - 'prosrc'");
    expect(patch).toContain('after_catalog is distinct from before_catalog');
    expect(patch).toContain("to_regprocedure('private.payroll_remittance_basis(uuid,date)') <> function_oid");
    expect(patch).toContain('is distinct from new_source');
    expect(patch.match(/execute /g)).toHaveLength(1);
    expect(patch).not.toMatch(/^\s*(grant|revoke|insert|update|delete|alter table|create index)\b/im);
  });
  it('requires installed candidate and exact inverse before SQL comparison', () => {
    expect(md5(candidate)).toBe('5bb5b63b12c4055efeb00057859eb6bc');
    expect(fixture).toContain(`if md5(source) <> '${md5(candidate)}' then`);
    expect(fixture).toContain(`if md5(baseline) <> '${md5(source)}' then`);
    expect(fixture).toContain(`replace(source,'${after}','${before}')`);
    expect(fixture.indexOf('PAYROLL_BASIS_TEST_CANDIDATE_NOT_INSTALLED')).toBeLessThan(fixture.indexOf('execute format('));
    expect(fixture).toContain('cross join generate_series(-6,0) w');
    expect(fixture).toContain("49::bigint,'differential check contains seven fixture maids and seven weeks'");
    expect(fixture).toContain("cross join unnest(array['admin','maid']) r");
    expect(fixture).toContain('is distinct from pg_temp.baseline_remittance_basis');
    expect(fixture).toContain('is distinct from private.payroll_remittance_projection');
    expect(fixture.trim()).toMatch(/^begin;[\s\S]*rollback;$/);
  });
});
