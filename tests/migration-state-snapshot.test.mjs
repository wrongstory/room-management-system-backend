import { describe, expect, it } from 'vitest';
import { compareMigrationStateSnapshots, createMigrationStateSnapshot, migrationStateDigests } from '../scripts/lib/migration-state-snapshot.mjs';

const kinds = ['schema', 'relation', 'column', 'constraint', 'index', 'function', 'owner', 'acl', 'rls', 'policy', 'trigger', 'type'];
const fixture = () => ({ coverage: { serverMajor: 17, schemas: ['public'], catalogKinds: kinds,
  dataRelations: [{ name: 'public.rooms', columns: [{ name: 'id', postgresType: 'uuid' }, { name: 'value', postgresType: 'text' }] }], sequences: ['public.counter'] },
  catalog: [{ kind: 'relation', identity: 'public.rooms', definition: 'owner=postgres;rls=true' }, { kind: 'function', identity: 'public.f()', definition: 'sensitive-function-body' }],
  data: [{ relation: 'public.rooms', rows: [['1', '가\r\n😀'], ['2', null], ['2', '']] }],
  sequences: [{ name: 'public.counter', lastValue: '9223372036854775807', isCalled: true }] });
const snapshot = createMigrationStateSnapshot;

describe('#378 declared full-state serialization (no DB observation)', () => {
  it('is insensitive to relation/catalog/row order but preserves multiplicity', () => {
    const left = fixture(); const right = structuredClone(left);
    right.catalog.reverse(); right.data[0].rows.reverse(); right.coverage.catalogKinds.reverse();
    expect(compareMigrationStateSnapshots(snapshot(left), snapshot(right)).matches).toBe(true);
    right.data[0].rows.push(['2', '']);
    expect(compareMigrationStateSnapshots(snapshot(left), snapshot(right)).matches).toBe(false);
  });
  it.each([
    value => { value.data[0].rows[0][1] = '가\n😀'; },
    value => { value.data[0].rows[1][1] = ''; },
    value => { value.catalog[0].definition = 'owner=authenticated;rls=false'; },
    value => { value.sequences[0].isCalled = false; },
    value => { value.sequences[0].lastValue = '9223372036854775806'; },
    value => { value.coverage.dataRelations[0].columns[0].postgresType = 'text'; },
  ])('detects data, catalog, type and nontransactional sequence drift %#', change => {
    const left = fixture(); const right = fixture(); change(right);
    expect(compareMigrationStateSnapshots(snapshot(left), snapshot(right)).matches).toBe(false);
  });
  it('returns only digests/counts and never exposes SQL or data', () => {
    const observed = snapshot(fixture());
    expect(Object.keys(migrationStateDigests(observed))).toHaveLength(4);
    expect(observed).toMatchObject({ coverageIsCallerClaim: true, liveDatabaseObserved: false, rowCount: 3 });
    expect(JSON.stringify(observed)).not.toMatch(/sensitive-function-body|가|owner=postgres|rooms/);
    expect(() => migrationStateDigests(structuredClone(observed))).toThrow('MIGRATION_STATE_NOT_OWNED');
  });
  it.each([
    value => { value.data = []; }, value => { value.data.push(value.data[0]); },
    value => { value.data[0].rows[0].pop(); }, value => { value.data[0].rows[0][1] = 1; },
    value => { value.data[0].rows[0][1] = 'x\0y'; }, value => { value.data[0].rows[0][1] = '\ud800'; },
    value => { value.sequences = []; }, value => { value.sequences[0].lastValue = '9223372036854775808'; },
    value => { value.sequences[0].lastValue = '01'; }, value => { value.sequences[0].lastValue = '-0'; },
    value => { value.catalog.push(value.catalog[0]); }, value => { value.coverage.catalogKinds = ['relation']; },
    value => { value.coverage.schemas = ['private']; }, value => { value.coverage.serverMajor = 16; },
    value => { value.coverage.dataRelations[0].columns.push(value.coverage.dataRelations[0].columns[0]); },
    value => { value.unverified = true; },
  ])('fails closed on incomplete, ambiguous or unsupported state %#', change => {
    const value = fixture(); change(value); expect(() => snapshot(value)).toThrow('MIGRATION_STATE_INVALID');
  });
  it('rejects getters without invoking them and bounds cell sizes', () => {
    const value = fixture(); let invoked = false;
    Object.defineProperty(value.catalog[0], 'definition', { enumerable: true, get() { invoked = true; return 'unsafe'; } });
    expect(() => snapshot(value)).toThrow(); expect(invoked).toBe(false);
    const large = fixture(); large.data[0].rows[0][1] = 'x'.repeat(2 * 1024 * 1024 + 1);
    expect(() => snapshot(large)).toThrow();
  });
});
