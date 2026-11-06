import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const read = path => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
const sha = value => createHash('sha256').update(value).digest('hex');
const contract = JSON.parse(read('tests/fixtures/db-lint-source-corrections.json'));
const migration = read(contract.migration);
const regression = read('supabase/tests/db_lint_source_corrections.sql');
const require = createRequire(import.meta.url);
const find = (sql, identity) => {
  const name = identity.split('(')[0];
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matcher = new RegExp(`create (?:or replace )?function ${escaped}\\([\\s\\S]*?\\bas \\$\\$([\\s\\S]*?)\\$\\$;`, 'g');
  const matches = [...sql.matchAll(matcher)];
  expect(matches).toHaveLength(1);
  return { definition: matches[0][0], body: matches[0][1] };
};
const exactReplace = (source, before, after) => {
  expect(source.split(before)).toHaveLength(2);
  return source.replace(before, after);
};
const noLocations = value => {
  if (Array.isArray(value)) return value.map(noLocations);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['location', 'stmt_location', 'stmt_len'].includes(key))
    .map(([key, item]) => [key, noLocations(item)]));
  return value;
};
const functionContract = statement => {
  const parsed = noLocations(statement.CreateFunctionStmt);
  expect(parsed).toBeDefined();
  return { ...parsed, replace: true, options: parsed.options.filter(option => option.DefElem.defname !== 'as') };
};

describe('#558 exact source corrections (DB-free; PostgreSQL behavior NOT RUN)', () => {
  it('preserves every prior migration and exact manifest entry through the integrated source145', () => {
    const manifest = JSON.parse(read('supabase/migration-manifest.dev.json'));
    expect(contract.priorMigrationCount).toBe(145);
    expect(sha(JSON.stringify(manifest.migrations.slice(0, 145)))).toBe(contract.priorManifestPrefixSha256);
    expect(manifest.migrations[145].name).toBe('db_lint_source_corrections');
    expect(manifest.migrations[145].sha256).toBe(sha(migration));
    expect(manifest.totalCount).toBe(151);
  });

  it.each([15, 17])('parses all prepared statements and preserves function attributes with PostgreSQL %i grammar', async version => {
    const parser = require(`@pgsql/parser/v${version}`);
    const append = await parser.parse(migration);
    expect(append.stmts).toHaveLength(7);
    expect(append.stmts[0].stmt.DoStmt).toBeDefined();
    expect((await parser.parse(regression)).stmts.length).toBeGreaterThan(40);
    for (const [index, fn] of contract.functions.entries()) {
      const original = find(read(fn.originPath), fn.identity);
      const prior = await parser.parse(original.definition);
      expect(functionContract(append.stmts[index + 1].stmt)).toEqual(functionContract(prior.stmts[0].stmt));
    }
    // This SQL grammar parser does not execute or fully validate PL/pgSQL bodies.
  });

  it.each(contract.functions)('changes only reviewed fragments in $identity', fn => {
    const original = find(read(fn.originPath), fn.identity);
    const proposed = find(migration, fn.identity);
    expect(sha(original.body)).toBe(fn.beforeSha256);
    expect(sha(proposed.body)).toBe(fn.afterSha256);
    let expected = original.body;
    for (const edit of fn.edits) expected = exactReplace(expected, edit.before, edit.after);
    expect(proposed.body).toBe(expected);
    for (const edit of [...fn.edits].reverse()) expected = exactReplace(expected, edit.after, edit.before);
    expect(expected).toBe(original.body);
  });

  it('binds the preflight guard and SQL round trip to all six exact origins', () => {
    const origins = JSON.parse(migration.match(/\$origins\$([\s\S]*?)\$origins\$/)[1]);
    expect(origins.map(row => row.identity)).toEqual(contract.functions.map(fn => fn.identity));
    expect(origins.map(row => row.beforeSha256)).toEqual(contract.functions.map(fn => fn.beforeSha256));
    const guard = migration.match(/do \$lint_source_guard\$([\s\S]*?)\$lint_source_guard\$;/)[1];
    const testGuard = regression.match(/as \$lint_source_guard\$([\s\S]*?)\$lint_source_guard\$;/)[1];
    expect(testGuard).toBe(guard);
    expect(JSON.parse(regression.match(/\$contracts\$([\s\S]*?)\$contracts\$/)[1])).toEqual(contract.functions);
    expect(migration.indexOf('DB_LINT_CORRECTION_SOURCE_DRIFT')).toBeLessThan(migration.indexOf('create or replace function'));
    expect(migration).not.toMatch(/\b(?:drop|grant|revoke|alter)\s+(?:function|table|role)|disable\s+trigger/i);
  });

  it('preserves the live timer and snapshot/authentication contract byte for byte apart from JSONB casts', () => {
    const template = find(migration, 'private.collect_developer_reset_template_inventory()').body;
    const oldTemplate = find(read('supabase/migrations/20261025031218_developer_reset_template_inventory.sql'),
      'private.collect_developer_reset_template_inventory()').body;
    const clocks = text => text.split('\n').filter(line => /clock_timestamp|statement_timestamp|deadline|snapshotId/.test(line));
    expect(clocks(template)).toEqual(clocks(oldTemplate));
    const preview = find(migration, 'public.get_developer_reset_preview(uuid,uuid,text)').body;
    expect(preview.split('begin\n')[1]).toBe(find(read('supabase/migrations/20261025024327_developer_reset_row_impact.sql'),
      'public.get_developer_reset_preview(uuid,uuid,text)').body.split('begin\n')[1]);
    expect(migration).not.toContain('create or replace function private.collect_developer_reset_inventory(');
    expect(migration).not.toContain('create or replace function private.collect_developer_reset_row_impact(');
  });

  it('keeps fixed Node golden vectors and prepares old/new bytes, OID/ACL and expired-deadline assertions', () => {
    const golden = JSON.parse(read('tests/fixtures/reset-receipt-store-golden.json'));
    expect(JSON.parse(regression.match(/\$golden\$([\s\S]*?)\$golden\$/)[1])).toEqual(golden);
    expect(regression).toContain("to_jsonb(p)-'prosrc'");
    expect(regression).toContain('old/new canonical bytes agree');
    expect(regression).toContain('old/new canonical hash agrees');
    expect(regression).toContain('original bodies after rejection');
    expect(regression).toContain('all six corrected bodies restored exactly');
    expect(regression).toContain('clock deadline');
    expect(regression).toContain('same fixed state chain');
    expect(regression.trim()).toMatch(/rollback;$/);
    expect(regression).not.toMatch(/\bpg_sleep\(|\btruncate\b|delete from (?:public|private)\./i);
  });
});
