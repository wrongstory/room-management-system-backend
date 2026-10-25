import { createHash } from 'node:crypto';
import { z } from 'zod';

const identifier = z.string().regex(/^[a-z][a-z0-9_]*$/).max(63);
const relationName = z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/).max(128);
const typeName = z.string().regex(/^[a-z][a-z0-9_]*\.[a-z_][a-z0-9_]*$/).max(128);
const columns = z.array(identifier).min(1).max(64);
const hash = z.string().regex(/^[a-f0-9]{32}$/);
const relation = z.object({
  name: relationName, kind: z.enum(['r', 'p', 'f']), rls: z.boolean(), forceRls: z.boolean(),
  columns: z.array(z.object({
    name: identifier, position: z.number().int().min(1).max(32767),
    type: typeName, nullable: z.boolean(),
  }).strict()).min(1).max(1600),
  // Primary keys and unique indexes actually referenced by an inventoried FK.
  keys: z.array(z.object({
    name: identifier, columns, primary: z.boolean(), valid: z.boolean(),
    immediate: z.boolean(), partial: z.boolean(), expressions: z.boolean(),
  }).strict()).max(1000),
}).strict();
export const resetCatalogSchema = z.object({
  format: z.literal('reset-catalog-v2'), readOnly: z.literal(true),
  relations: z.array(relation).min(1).max(1000),
  boundaryRelations: z.array(relation).max(1000),
  foreignKeys: z.array(z.object({
    source: relationName, target: relationName, name: identifier,
    definition: z.string().min(1).max(4096),
    sourceColumns: columns, targetColumns: columns, targetKey: identifier,
    match: z.enum(['s', 'f', 'p']), onDelete: z.enum(['a', 'r', 'c', 'n', 'd']),
    onUpdate: z.enum(['a', 'r', 'c', 'n', 'd']), validated: z.boolean(),
    deferrable: z.boolean(), initiallyDeferred: z.boolean(),
  }).strict()).max(10000),
  triggers: z.array(z.object({
    relation: relationName, name: identifier, enabled: z.enum(['O', 'D', 'R', 'A']),
    definitionHash: hash, functionHash: hash,
  }).strict()).max(10000),
}).strict();

const reject = () => { throw new Error('RESET_CATALOG_REJECTED'); };
const unique = (values) => new Set(values).size === values.length;
const by = (a, b) => a < b ? -1 : a > b ? 1 : 0;

/** Internal catalog validation only. Never accepts SQL or enables execution. */
export function validateResetCatalog(input) {
  const parsed = resetCatalogSchema.safeParse(input);
  if (!parsed.success) reject();
  const c = parsed.data;
  const appNames = new Set(c.relations.map((r) => r.name));
  const all = [...c.relations, ...c.boundaryRelations];
  const tables = new Map(all.map((r) => [r.name, r]));
  if (tables.size !== all.length || !appNames.has('public.profiles') || !appNames.has('public.rooms') ||
      c.relations.some((r) => !/^(public|private)\./.test(r.name)) ||
      c.boundaryRelations.some((r) => /^(public|private)\./.test(r.name)) ||
      !unique(c.foreignKeys.map((f) => `${f.source}:${f.name}`)) ||
      !unique(c.triggers.map((t) => `${t.relation}:${t.name}`))) reject();
  for (const table of all) {
    const names = new Set(table.columns.map((col) => col.name));
    if (names.size !== table.columns.length || !unique(table.columns.map((col) => col.position)) ||
        !unique(table.keys.map((key) => key.name)) || table.keys.filter((key) => key.primary).length > 1 ||
        table.keys.some((key) => !unique(key.columns) || key.columns.some((col) => !names.has(col)))) reject();
  }
  for (const fk of c.foreignKeys) {
    const source = tables.get(fk.source);
    const target = tables.get(fk.target);
    const key = target?.keys.find((item) => item.name === fk.targetKey);
    if ((!appNames.has(fk.source) && !appNames.has(fk.target)) || !source || !target || !key ||
        fk.sourceColumns.length !== fk.targetColumns.length || !unique(fk.sourceColumns) ||
        !unique(fk.targetColumns) || fk.sourceColumns.some((name) => !source.columns.some((col) => col.name === name)) ||
        fk.targetColumns.some((name) => !target.columns.some((col) => col.name === name)) ||
        key.columns.length !== fk.targetColumns.length || key.columns.some((name) => !fk.targetColumns.includes(name)) ||
        (fk.initiallyDeferred && !fk.deferrable)) reject();
  }
  if (c.boundaryRelations.some((table) => !c.foreignKeys.some((fk) => fk.source === table.name || fk.target === table.name)) ||
      c.triggers.some((t) => !appNames.has(t.relation))) reject();
  const canonicalRelation = (table) => ({ ...table,
    columns: [...table.columns].sort((a, b) => a.position - b.position),
    keys: [...table.keys].sort((a, b) => by(a.name, b.name)),
  });
  const canonical = {
    ...c,
    relations: c.relations.map(canonicalRelation).sort((a, b) => by(a.name, b.name)),
    boundaryRelations: c.boundaryRelations.map(canonicalRelation).sort((a, b) => by(a.name, b.name)),
    foreignKeys: [...c.foreignKeys].sort((a, b) => by(`${a.source}:${a.name}`, `${b.source}:${b.name}`)),
    triggers: [...c.triggers].sort((a, b) => by(`${a.relation}:${a.name}`, `${b.relation}:${b.name}`)),
  };
  return { catalog: canonical,
    // Structural subset; no ACL/default/policy/function-closure or data completeness claim.
    catalogFingerprint: createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
    unsupportedKeyCount: all.flatMap((r) => r.keys).filter((k) => !k.valid || !k.immediate || k.partial || k.expressions).length,
    unsupportedForeignKeyCount: c.foreignKeys.filter((f) => !f.validated || f.match === 'p').length,
    missingPrimaryKeyCount: all.filter((r) => !r.keys.some((k) => k.primary)).length,
  };
}
