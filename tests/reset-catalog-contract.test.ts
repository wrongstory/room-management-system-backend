import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resetCatalog, resetTable } from './helpers/reset-catalog.js';
const modulePath = '../scripts/reset-catalog-contract.mjs';
const { validateResetCatalog } = await import(modulePath);
type Catalog = ReturnType<typeof resetCatalog>;
const first = <T>(rows: T[]) => { const row = rows[0]; if (!row) throw new Error('fixture'); return row; };

describe('structured reset catalog contract', () => {
  it('requires v2 and complete ordered key metadata without reflecting errors', () => {
    const c = resetCatalog(); c.format = 'reset-catalog-v1';
    expect(() => validateResetCatalog(c)).toThrow(/^RESET_CATALOG_REJECTED$/);
    expect(() => validateResetCatalog({ ...resetCatalog(), secret: 'do-not-echo' })).toThrow(/^RESET_CATALOG_REJECTED$/);
  });
  it('preserves FK pair order while normalizing unrelated catalog enumeration order', () => {
    const c = resetCatalog();
    const before = structuredClone(c);
    const result = validateResetCatalog(c);
    c.relations.reverse(); first(c.relations.filter((r) => r.name === 'public.profiles')).columns.reverse();
    expect(validateResetCatalog(c).catalogFingerprint).toBe(result.catalogFingerprint);
    expect(before.foreignKeys).toEqual(result.catalog.foreignKeys);
  });
  it('accepts PostgreSQL array type names in column metadata', () => {
    const c = resetCatalog(); first(first(c.relations).columns).type = 'pg_catalog._uuid';
    expect(validateResetCatalog(c).catalog.relations).toHaveLength(2);
  });
  it('preserves composite FK pairs without assuming referenced index order matches them', () => {
    const c = resetCatalog(); const source = first(c.relations); const target = first(c.boundaryRelations);
    target.columns.push({ name: 'tenant_id', position: 2, type: 'pg_catalog.uuid', nullable: false });
    first(target.keys).columns = ['tenant_id', 'id'];
    source.columns.push({ name: 'tenant_id', position: 3, type: 'pg_catalog.uuid', nullable: false });
    const fk = first(c.foreignKeys); fk.sourceColumns = ['auth_user_id', 'tenant_id']; fk.targetColumns = ['id', 'tenant_id'];
    const before = validateResetCatalog(c);
    expect(before.catalog.foreignKeys).toEqual(expect.arrayContaining([expect.objectContaining({ targetColumns: ['id', 'tenant_id'] })]));
    fk.sourceColumns.reverse();
    expect(validateResetCatalog(c).catalogFingerprint).not.toBe(before.catalogFingerprint);
  });
  it.each([
    ['missing column', (c: Catalog) => { first(c.foreignKeys).sourceColumns = ['missing']; }],
    ['missing key', (c: Catalog) => { first(c.foreignKeys).targetKey = 'missing'; }],
    ['wrong key columns', (c: Catalog) => { first(c.foreignKeys).targetColumns = ['missing']; }],
    ['wrong arity', (c: Catalog) => { first(c.foreignKeys).sourceColumns.push('id'); }],
    ['duplicate pair', (c: Catalog) => { first(c.foreignKeys).sourceColumns.push('auth_user_id'); first(c.foreignKeys).targetColumns.push('id'); }],
    ['missing boundary', (c: Catalog) => { c.boundaryRelations = []; }],
    ['unrelated boundary', (c: Catalog) => { c.boundaryRelations.push(resetTable('auth.sessions')); }],
    ['duplicate boundary', (c: Catalog) => { c.boundaryRelations.push(first(c.boundaryRelations)); }],
    ['duplicate column position', (c: Catalog) => { first(first(c.relations).columns.slice(1)).position = 1; }],
    ['duplicate key name', (c: Catalog) => { first(c.relations).keys.push(first(first(c.relations).keys)); }],
    ['deferred but not deferrable', (c: Catalog) => { first(c.foreignKeys).initiallyDeferred = true; }],
  ] as const)('rejects %s', (_name, mutate) => {
    const c = resetCatalog(); mutate(c);
    expect(() => validateResetCatalog(c)).toThrow(/^RESET_CATALOG_REJECTED$/);
  });
  it.each([
    ['nullability', (c: Catalog) => { first(first(c.relations).columns).nullable = true; }],
    ['MATCH FULL', (c: Catalog) => { first(c.foreignKeys).match = 'f'; }],
    ['CASCADE', (c: Catalog) => { first(c.foreignKeys).onDelete = 'c'; }],
    ['update action', (c: Catalog) => { first(c.foreignKeys).onUpdate = 'n'; }],
    ['deferral', (c: Catalog) => { first(c.foreignKeys).deferrable = true; }],
  ] as const)('binds %s into the structural fingerprint', (_name, mutate) => {
    const c = resetCatalog(); const before = validateResetCatalog(c).catalogFingerprint; mutate(c);
    expect(validateResetCatalog(c).catalogFingerprint).not.toBe(before);
  });
  it('reports unsupported keys and FK shapes without claiming execution eligibility', () => {
    const c = resetCatalog(); first(first(c.relations).keys).valid = false;
    first(c.foreignKeys).match = 'p'; first(c.relations.filter((r) => r.name === 'public.rooms')).keys = [];
    expect(validateResetCatalog(c)).toMatchObject({ unsupportedKeyCount: 1, unsupportedForeignKeyCount: 1, missingPrimaryKeyCount: 1 });
  });
  it('extracts structured key metadata only from catalog inside a read-only transaction', () => {
    const sql = readFileSync(new URL('../scripts/reset-catalog.sql', import.meta.url), 'utf8');
    for (const source of ['conkey', 'confkey', 'confmatchtype', 'confdeltype', 'confupdtype', 'convalidated', 'condeferrable', 'condeferred', 'indnkeyatts', 'WITH ORDINALITY']) expect(sql).toContain(source);
    expect(sql).toContain('REPEATABLE READ READ ONLY');
    expect(sql).toContain("'format', 'reset-catalog-v2'");
    expect(sql).not.toMatch(/\b(?:DELETE|UPDATE|INSERT INTO|CREATE|TRUNCATE)\b/i);
  });
});
