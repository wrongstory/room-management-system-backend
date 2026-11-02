import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(resolve(process.cwd(), 'package.json'));
const parser = version => require(`@pgsql/parser/v${version}`);
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const originPath = 'supabase/migrations/20261101230757_current_week_availability_approval.sql';
const origin = readFileSync(resolve(process.cwd(), originPath), 'utf8').replaceAll('\r\n', '\n');
const migrationPath = 'supabase/migrations/20261101235415_availability_guard_unused_parameter.sql';
const migration = read(migrationPath);
const regression = read('supabase/tests/availability_guard_unused_parameter.sql');
const fixture = read('supabase/tests/availability_guard_unused_parameter_fixture.psql');
const sha = value => createHash('sha256').update(value).digest('hex');
const identities = [
  'assert_availability_past_unchanged', 'request_availability_change_at', 'decide_availability_change_at',
];
const oldCalls = [
  'private.assert_availability_past_unchanged(v_current.id, p_week_start, v_dates, p_command_at)',
  'private.assert_availability_past_unchanged(v_current.id, v_request.week_start, v_request.requested_available_dates, p_command_at)',
];
const newCalls = [
  'private.assert_availability_past_unchanged(v_current.id, v_dates, p_command_at)',
  'private.assert_availability_past_unchanged(v_current.id, v_request.requested_available_dates, p_command_at)',
];
const find = (sql, name) => {
  const matches = [...sql.matchAll(new RegExp(`create(?: or replace)? function private\\.${name}\\([\\s\\S]*?\\$\\$;`, 'g'))];
  expect(matches).toHaveLength(1);
  return { definition: matches[0][0], body: matches[0][0].split('$$')[1] };
};
const noLocations = value => {
  if (Array.isArray(value)) return value.map(noLocations);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['location', 'stmt_location', 'stmt_len'].includes(key))
    .map(([key, item]) => [key, noLocations(item)]));
  return value;
};
const header = statement => {
  const fn = noLocations(statement.CreateFunctionStmt);
  expect(fn).toBeDefined();
  return { ...fn, replace: true, options: fn.options.filter(option => option.DefElem.defname !== 'as') };
};
const validateMinimalDefinitions = sql => {
  for (const [index, name] of identities.entries()) {
    const before = find(origin, name);
    const after = find(sql, name);
    const expected = index === 0
      ? before.definition.replace('p_version_id uuid, p_week_start date, p_dates date[]', 'p_version_id uuid, p_dates date[]')
      : before.definition.replace(oldCalls[index - 1], newCalls[index - 1]);
    expect(after.definition).toBe(expected);
  }
};

describe('#559 unused private availability argument (DB-free; actual PostgreSQL NOT RUN)', () => {
  it('pins the immutable policy145 source and the exact original function bodies', () => {
    expect(sha(origin)).toBe('7b4b70d2a506dd028aa02469369429c5971eb160769e168438cf6f8fa61aa70c');
    const origins = JSON.parse(migration.match(/\$origins\$([\s\S]*?)\$origins\$/)[1]);
    expect(origins).toHaveLength(3);
    for (const [index, name] of identities.entries()) {
      expect(origins[index].beforeSha256).toBe(sha(find(origin, name).body));
      expect(origins[index].afterSha256).toBe(sha(find(migration, name).body));
    }
    expect(find(origin, identities[0]).body).not.toContain('p_week_start');
    expect(find(migration, identities[0]).body).toBe(find(origin, identities[0]).body);
  });

  it('removes only the unused declaration and the two exact caller arguments', () => {
    validateMinimalDefinitions(migration);
    for (const [index, name] of identities.slice(1).entries()) {
      const before = find(origin, name).body;
      const after = find(migration, name).body;
      expect(before.split(oldCalls[index])).toHaveLength(2);
      expect(after.split(newCalls[index])).toHaveLength(2);
      expect(after.replace(newCalls[index], oldCalls[index])).toBe(before);
      expect(after).toContain('p_command_at');
    }
  });

  it.each([
    sql => sql.replace('p_version_id uuid, p_dates date[]', 'p_week_start date, p_dates date[]'),
    sql => sql.replace(newCalls[0], oldCalls[0]),
    sql => sql.replace(newCalls[1], oldCalls[1]),
    sql => sql.replace('PAST_AVAILABILITY_DATE_NOT_ALLOWED', 'PAST_AVAILABILITY_ALLOWED'),
    sql => sql.replace('Asia/Seoul', 'UTC'),
    sql => sql.replace('security definer', 'security invoker'),
    sql => sql.replace('v_current.id, v_dates, p_command_at', 'v_current.id, v_dates, now()'),
  ])('rejects accidental contract/body changes instead of treating them as argument removal (%#)', mutate => {
    expect(() => validateMinimalDefinitions(mutate(migration))).toThrow();
  });

  it.each([15, 17])('preserves caller headers and only removes the helper parameter under PostgreSQL %i grammar', async version => {
    const parsed = await parser(version).parse(migration);
    expect(parsed.stmts).toHaveLength(8);
    const definitions = parsed.stmts.filter(stmt => stmt.stmt.CreateFunctionStmt).map(stmt => stmt.stmt);
    expect(definitions).toHaveLength(3);
    for (const [index, name] of identities.entries()) {
      const before = header((await parser(version).parse(find(origin, name).definition)).stmts[0].stmt);
      if (index === 0) before.parameters = before.parameters.filter(p => p.FunctionParameter.name !== 'p_week_start');
      expect(header(definitions[index])).toEqual(before);
    }
    expect((await parser(version).parse(fixture)).stmts).toHaveLength(6);
    expect((await parser(version).parse(regression.replace(/^\\ir .+$/gm, ''))).stmts.length).toBeGreaterThan(20);
    // Outer SQL grammar does not execute or fully validate PL/pgSQL bodies.
  });

  it('guards exact original bodies/catalog, creates owner-only helper, then drops only the old signature with RESTRICT', () => {
    const guard = migration.match(/do \$availability_guard_559\$([\s\S]*?)\$availability_guard_559\$;/)[1];
    const testGuard = regression.match(/as \$availability_guard_559\$([\s\S]*?)\$availability_guard_559\$;/)[1];
    expect(testGuard).toBe(guard);
    expect(guard).toContain('AVAILABILITY_GUARD_SOURCE_DRIFT');
    for (const property of ['prosrc', 'proacl', 'proargnames', 'proargmodes', 'proallargtypes', 'proconfig',
      'provolatile', 'prosecdef', 'proisstrict', 'proleakproof', 'proparallel', 'prosupport', 'probin', 'procost', 'prorows']) {
      expect(guard).toContain(`actual.${property}`);
    }
    expect(guard).toContain("array['postgres=X/postgres']::text[]");
    expect(migration).toContain('from public, anon, authenticated, service_role;');
    expect(migration).toContain('AVAILABILITY_GUARD_ACL_DRIFT');
    expect(migration.trim()).toMatch(/drop function private\.assert_availability_past_unchanged\(uuid,date,date\[\],timestamptz\) restrict;$/);
    expect(migration.indexOf(newCalls[1])).toBeLessThan(migration.indexOf('drop function'));
    expect(migration).toContain('Text/dynamic PLpgSQL');
    expect(migration).not.toMatch(/\bcascade\s*;|disable\s+trigger|grant\s+execute|create(?: or replace)? function public\./i);
    expect(guard).toContain("replace(actual.prosrc,E'\\r\\n',E'\\n')");
    expect(guard).toContain("position(E'\\r' in replace(actual.prosrc,E'\\r\\n',E'\\n'))");
    expect(migration).not.toContain('\r');
  });

  it('prepares exact old-source reconstruction and rollback-only OID/ACL/behavior checks without extra reset', () => {
    for (const name of identities) expect(find(fixture, name).definition).toBe(find(origin, name).definition);
    expect(regression.match(/^\\ir /gm)).toHaveLength(2);
    expect(regression).toContain('availability_guard_unused_parameter_fixture.psql');
    expect(regression).toContain('availability_guard_unused_parameter_migration.psql');
    expect(regression).toContain('both callers preserve OID and every non-body catalog field');
    expect(regression).toContain('changed private signature intentionally receives a new OID');
    expect(regression).toContain('new helper ACL contains only its owner');
    expect(regression).toContain('unexpected caller body is rejected by the actual prestate guard');
    expect(regression).toContain('KST boundary before midnight');
    expect(regression).toContain('KST boundary at midnight');
    expect(regression).toContain('old/new behavior: ');
    expect(regression.trim()).toMatch(/rollback;$/);
    expect(regression).not.toMatch(/\btruncate\b|disable\s+trigger|\bpg_sleep\(/i);
  });

  it('finds only the two known static callers in the original migration set', () => {
    const paths = readdirSync(resolve(process.cwd(), 'supabase/migrations')).filter(p => p.endsWith('.sql') && p <= '20261101230757_current_week_availability_approval.sql');
    const calls = paths.flatMap(p => readFileSync(resolve(process.cwd(), 'supabase/migrations', p), 'utf8')
      .match(/perform private\.assert_availability_past_unchanged\([^;]+;/g) ?? []);
    expect(calls).toEqual(oldCalls.map(call => `perform ${call};`));
    // This source inventory is not a proof about unknown dynamic SQL consumers.
  });
});
