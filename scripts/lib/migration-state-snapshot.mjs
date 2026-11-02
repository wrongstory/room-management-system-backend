/** #378 deterministic, bounded serialization of a declared PostgreSQL state coverage. */
import { createHash } from 'node:crypto';

const snapshots = new WeakMap();
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_ROWS = 100_000;
const categories = Object.freeze(['schema', 'relation', 'column', 'constraint', 'index', 'function', 'owner', 'acl', 'rls', 'policy', 'trigger', 'type']);
const ident = /^[a-z_][a-z0-9_]{0,62}$/u;
const qualified = /^[a-z_][a-z0-9_]{0,62}\.[a-z_][a-z0-9_]{0,62}$/u;
const digest = (format, value) => createHash('sha256').update(JSON.stringify({ format, value })).digest('hex');
const fail = () => { throw new Error('MIGRATION_STATE_INVALID'); };
function object(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== keys.length) fail();
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
    result[key] = descriptor.value;
  }
  return result;
}
function list(value, max = MAX_ROWS) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) fail();
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
    return descriptor.value;
  });
}
function text(value, max, budget) {
  if (typeof value !== 'string' || !value.isWellFormed() || value.includes('\0')) fail();
  const size = Buffer.byteLength(value);
  budget.bytes += size;
  if (size > max || budget.bytes > MAX_BYTES) fail();
  return value;
}
function name(value, pattern = ident) { if (typeof value !== 'string' || !pattern.test(value)) fail(); return value; }
function sortedUnique(rows, key = value => value) {
  const values = rows.map(key);
  if (new Set(values).size !== values.length) fail();
  return rows.sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
}

/** Caller observations are hashed, never promoted to a live DB or complete-coverage proof. */
export function createMigrationStateSnapshot(input) {
  try {
    const value = object(input, ['coverage', 'catalog', 'data', 'sequences']);
    const budget = { bytes: 0 };
    const supplied = object(value.coverage, ['serverMajor', 'schemas', 'catalogKinds', 'dataRelations', 'sequences']);
    if (![15, 17].includes(supplied.serverMajor)) fail();
    const schemas = sortedUnique(list(supplied.schemas, 128).map(value => name(value)));
    if (schemas.length === 0) fail();
    const names = rows => sortedUnique(list(rows, 2048).map(value => {
      const valid = name(value, qualified);
      if (!schemas.includes(valid.split('.')[0])) fail();
      return valid;
    }));
    const kinds = sortedUnique(list(supplied.catalogKinds, categories.length).map(value => name(value)));
    if (JSON.stringify(kinds) !== JSON.stringify([...categories].sort())) fail();
    const relations = sortedUnique(list(supplied.dataRelations, 2048).map(item => {
      const relation = object(item, ['name', 'columns']);
      names([relation.name]);
      const columns = list(relation.columns, 1600).map(item => {
        const column = object(item, ['name', 'postgresType']);
        name(column.name);
        text(column.postgresType, 512, budget);
        if (!column.postgresType) fail();
        return column;
      });
      if (columns.length === 0 || new Set(columns.map(column => column.name)).size !== columns.length) fail();
      return { name: relation.name, columns };
    }), row => row.name);
    const sequenceNames = names(supplied.sequences);
    const coverage = { serverMajor: supplied.serverMajor, schemas, catalogKinds: kinds, dataRelations: relations, sequences: sequenceNames };
    const catalog = sortedUnique(list(value.catalog).map(item => {
      const row = object(item, ['kind', 'identity', 'definition']);
      if (!kinds.includes(row.kind)) fail();
      text(row.identity, 1024, budget); text(row.definition, 2 * 1024 * 1024, budget);
      if (!row.identity) fail();
      return row;
    }), row => JSON.stringify([row.kind, row.identity]));
    let rowCount = 0; let cellCount = 0;
    const data = sortedUnique(list(value.data, 2048).map(item => {
      const supplied = object(item, ['relation', 'rows']);
      const relation = relations.find(row => row.name === supplied.relation);
      if (!relation) fail();
      const rows = list(supplied.rows).map(row => {
        rowCount += 1;
        if (rowCount > MAX_ROWS) fail();
        const cells = list(row, relation.columns.length);
        if (cells.length !== relation.columns.length) fail();
        cellCount += cells.length;
        if (cellCount > 1_000_000) fail();
        return cells.map(cell => cell === null ? null : text(cell, 2 * 1024 * 1024, budget));
      });
      // A multiset: preserve duplicates, null/empty/Unicode and column order.
      rows.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
      return { relation: supplied.relation, rows };
    }), row => row.relation);
    if (JSON.stringify(data.map(row => row.relation)) !== JSON.stringify(relations.map(row => row.name))) fail();
    const sequences = sortedUnique(list(value.sequences, 2048).map(item => {
      const row = object(item, ['name', 'lastValue', 'isCalled']);
      if (!sequenceNames.includes(row.name) || typeof row.isCalled !== 'boolean' || typeof row.lastValue !== 'string'
        || !/^(?:0|-?[1-9][0-9]{0,18})$/u.test(row.lastValue)) fail();
      const last = BigInt(row.lastValue);
      if (last < -9223372036854775808n || last > 9223372036854775807n) fail();
      return row;
    }), row => row.name);
    if (JSON.stringify(sequences.map(row => row.name)) !== JSON.stringify(sequenceNames)) fail();
    const result = Object.freeze({ format: 'postgres-state-snapshot-v1', coverageIsCallerClaim: true, liveDatabaseObserved: false,
      coverageSha256: digest('postgres-state-coverage-v1', coverage), catalogSha256: digest('postgres-state-catalog-v1', catalog),
      dataSha256: digest('postgres-state-data-v1', data), sequencesSha256: digest('postgres-state-sequences-v1', sequences),
      catalogCount: catalog.length, relationCount: relations.length, rowCount, sequenceCount: sequences.length });
    snapshots.set(result, true);
    return result;
  } catch { throw new Error('MIGRATION_STATE_INVALID'); }
}
export function isOwnedMigrationStateSnapshot(value) { return snapshots.has(value); }
export function migrationStateDigests(value) {
  if (!snapshots.has(value)) throw new Error('MIGRATION_STATE_NOT_OWNED');
  return Object.freeze(Object.fromEntries(['coverageSha256', 'catalogSha256', 'dataSha256', 'sequencesSha256'].map(key => [key, value[key]])));
}
export function compareMigrationStateSnapshots(left, right) {
  const first = migrationStateDigests(left); const second = migrationStateDigests(right);
  return Object.freeze({ matches: Object.keys(first).every(key => first[key] === second[key]), liveDatabaseObserved: false });
}
