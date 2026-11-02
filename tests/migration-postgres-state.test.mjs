import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { readPostgresMigrationState } from '../scripts/lib/migration-postgres-state.mjs';

const coverage = () => ({ serverMajor: 17, schemas: ['public'], catalogKinds: ['schema', 'relation', 'column', 'constraint', 'index', 'function', 'owner', 'acl', 'rls', 'policy', 'trigger', 'type'],
  dataRelations: [{ name: 'public.rooms', columns: [{ name: 'id', postgresType: 'uuid' }, { name: 'note', postgresType: 'text' }] }], sequences: ['public.counter'] });
const select = rows => ({ command: 'SELECT', rowCount: rows.length, rows, fields: Array.from({ length: rows[0]?.length ?? 0 }, () => ({ dataTypeID: 25, format: 'text' })) });
function fixture(change = () => {}) {
  const inventory = [['public', 'counter', 'S', 'last_value', 'bigint'], ['public', 'rooms', 'r', 'id', 'uuid'], ['public', 'rooms', 'r', 'note', 'text']];
  const catalog = [['schema', 'public', 'owner=postgres'], ['relation', 'public.rooms', 'reviewed definition']];
  const data = [[JSON.stringify(['id-1', 'sensitive-only-fixture'])], [JSON.stringify(['id-2', null])]];
  const values = { inventory, catalog, data, count: '2', bytes: '80', sequence: [['123', 'true']] }; change(values);
  const query = vi.fn(async (sql, parameters) => {
    if (sql.includes('LEFT JOIN pg_catalog.pg_attribute')) { expect(parameters).toEqual([['public']]); return select(values.inventory); }
    if (sql.startsWith('WITH namespaces')) return select(values.catalog);
    if (sql.startsWith('SELECT pg_catalog.count(*)')) return select([[values.count, values.bytes]]);
    if (sql.startsWith('SELECT pg_catalog.json_build_array')) return select(values.data);
    if (sql.startsWith('SELECT last_value')) return select(values.sequence);
    throw new Error('synthetic unexpected query');
  });
  return query;
}
describe('#378 state collector via bounded synthetic SQL results', () => {
  it('collects all declared catalog/table/sequence state without returning values', async () => {
    const result = await readPostgresMigrationState(fixture(), coverage());
    expect(result).toMatchObject({ rowCount: 2, relationCount: 1, sequenceCount: 1 });
    expect(JSON.stringify(result)).not.toContain('sensitive-only-fixture');
  });
  it.each([
    value => { value.inventory.push(['public', 'uncovered', 'r', 'id', 'uuid']); },
    value => { value.inventory[1][4] = 'text'; }, value => { value.inventory[1][2] = 'f'; },
    value => { value.inventory[1][2] = 'm'; }, value => { value.catalog[0][1] = 'private'; },
    value => { value.count = '100001'; }, value => { value.bytes = '33554433'; },
    value => { value.count = '3'; }, value => { value.data[0][0] = '[1,"number"]'; },
    value => { value.sequence[0][1] = 'unknown'; },
  ])('rejects coverage gaps, unsupported data or overflow %#', async change => {
    await expect(readPostgresMigrationState(fixture(change), coverage())).rejects.toThrow('MIGRATION_STATE_READ_FAILED');
  });
  it('rejects SQL identifier injection before invoking the query', async () => {
    const value = coverage(); value.dataRelations[0].name = 'public.rooms; DELETE'; const query = fixture();
    await expect(readPostgresMigrationState(query, value)).rejects.toThrow(); expect(query).not.toHaveBeenCalled();
  });
  it('parses fixed collector SQL in both PostgreSQL grammars without connecting', async () => {
    const query = fixture(); await readPostgresMigrationState(query, coverage());
    const { Parser } = createRequire(import.meta.url)('@pgsql/parser');
    for (const major of [15, 17]) {
      const parser = new Parser({ version: major });
      for (const [sql] of query.mock.calls) expect((await parser.parse(sql)).stmts).toHaveLength(1);
    }
  });
  it('does not label unsupported catalog objects as complete coverage', async () => {
    await expect(readPostgresMigrationState(fixture(value => { value.catalog.push(['unsupported', 'type:public.custom_domain', 'd']); }), coverage())).rejects.toThrow('MIGRATION_STATE_READ_FAILED');
  });
});
