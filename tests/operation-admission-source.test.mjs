import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { admissionRouteRows, generateAdmissionSql } from '../scripts/generate-operation-admission-sql.mjs';

const require = createRequire(import.meta.url);
const read = path => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
const routes = JSON.parse(read('src/modules/developer-reset/http-admission-routes.json'));
const template = read('scripts/operation-admission.sql.in');
const source = read('supabase/migrations/20261025032719_operation_admission_authority.sql');
const receipt = routes.filter(r => ['CALLER', 'SQL_AVAILABILITY'].includes(r.hashMode));

describe('finite HTTP admission SQL contract', () => {
  it('generates the committed migration from the exact canonical routes', () => {
    expect(generateAdmissionSql(routes, template)).toBe(source);
    expect(receipt).toHaveLength(65);
    expect(routes.filter(r => r.hashMode === 'NONE')).toHaveLength(27);
    expect(routes.filter(r => r.hashMode === 'READ_ONLY')).toHaveLength(6);
    expect(routes.filter(r => r.hashMode === 'ATOMIC_RPC')).toHaveLength(1);
  });
  it('never grants ordinary admission to read-only or same-transaction dispatch routes', () => {
    const rows = admissionRouteRows(routes);
    for (const route of routes.filter(r => ['READ_ONLY', 'ATOMIC_RPC'].includes(r.hashMode))) {
      expect(rows).not.toContain(`('${route.routeId}',`);
    }
  });
  it.each(receipt.map(r => [r.routeId, r.commandName, r.keyArgument, r.kind]))(
    'binds %s to the reviewed command receipt, never an HTTP body hash', (route, command, key, kind) => {
      expect(admissionRouteRows(routes)).toContain(`'${route}', '${kind}'`);
      const row = admissionRouteRows(routes).split('\n').find(s => s.includes(`'${route}',`));
      expect(row).toContain(`'${command}', '${key}'`);
    },
  );
  it.each([
    r => { r[0].routeId = "x'); select dangerous(); --"; },
    r => { r.push({ ...r[0] }); },
    r => { r[0].hashMode = 'TRUST_HTTP_200'; },
    r => { r[0].commandName = null; },
    r => { r[0].commandName = "' or true --"; },
    r => { r[0].rpc = null; },
    r => { r[0].authority = 'LOGIN'; },
    r => { r[0].authority = 'CALLER_BOOLEAN'; },
    r => { r[0].keyArgument = 'caller_token'; },
    r => { r[0].hashMode = 'SQL_AVAILABILITY'; },
    r => { r[0].hashMode = 'ATOMIC_RPC'; },
    r => { r.find(x => x.hashMode === 'READ_ONLY').rpc = 'mutate_everything'; },
  ])('fails closed for unreviewed manifest substitutions', mutate => {
    const changed = structuredClone(routes); mutate(changed);
    expect(() => admissionRouteRows(changed)).toThrow('ADMISSION_MANIFEST_INVALID');
  });
  it('requires exactly one template binding position', () => {
    expect(() => generateAdmissionSql(routes, '')).toThrow('ADMISSION_TEMPLATE_INVALID');
    expect(() => generateAdmissionSql(routes, '@@HTTP_ROUTES@@@@HTTP_ROUTES@@')).toThrow('ADMISSION_TEMPLATE_INVALID');
  });
  it.each(['v15', 'v17'])('parses source and prepared rollback-only regressions with %s without a DB connection', async version => {
    const parser = require(`@pgsql/parser/${version}`);
    for (const file of ['supabase/migrations/20261025032719_operation_admission_authority.sql',
      'supabase/tests/operation_http_admission.sql']) {
      const parsed = await parser.parse(read(file));
      expect(parsed.stmts.length).toBeGreaterThan(8);
    }
  });
  it('preserves the source128 preview collector and source127 classification fingerprint', () => {
    expect(source).not.toContain('create or replace function private.collect_developer_reset_impact_preview');
    expect(source).not.toContain('create table');
    expect(source).not.toMatch(/\b(?:delete from|truncate)\b/i);
  });
});
