import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createLegacyUpgradeHistory, legacyUpgradeHistorySql, validateLegacyUpgradeObservation } from '../scripts/lib/legacy-upgrade-history.mjs';

const table = 'public.cleaning_assignments';
const id = '28000000-0000-4000-8000-000000000405';
const second = '28000000-0000-4000-8000-000000000406';
const md5 = value => createHash('md5').update(JSON.stringify(value)).digest('hex');
const column = name => ({ name, type: name === 'id' ? 'uuid' : 'text', nullable: name !== 'id' });
// Synthetic query observations only, not a substitute for PostgreSQL execution.
const observation = () => ({
  memoColumn: null, assignments: [{ id, memoNull: true }],
  tables: [{ table, count: 1, digest: md5({ id, status: 'notified' }),
    columns: [column('id'), column('status')], fields: { id: md5(id), status: md5('notified') } }],
});
const installed = () => ({ ...observation(), memoColumn: { type: 'text', nullable: true } });
const normalized = value => validateLegacyUpgradeObservation(value, [table], [id], true);

describe('legacy upgrade preservation observations', () => {
  it('keeps the baseline through installation and later snapshots without recapture', () => {
    let value = observation(); const queries = [];
    const history = createLegacyUpgradeHistory(sql => { queries.push(sql); return JSON.stringify(value); }, [table]);
    const before = history.snapshot();
    expect(history.snapshot()).toBe(before); // baseline read-only probe
    history.requireMemoColumn(); value = installed();
    expect(history.snapshot()).toBe(before);
    value.assignments.push({ id: second, memoNull: false }); value.tables[0].count = 2;
    value.tables[0].digest = md5('new assignment with a real memo');
    expect(history.snapshot()).not.toBe(before); // new rows cannot disappear
    history.snapshot();
    expect(queries.at(-1)).toContain(`array['${id}']::text[]`);
    expect(queries.at(-1)).not.toContain(`array['${id}','${second}']`);
  });
  it.each(['status', 'fee_snapshot', 'maid_profile_id', 'template_snapshot', 'created_at'])('detects old %s value changes', field => {
    const value = installed(); value.tables[0].digest = md5({ [field]: 'changed' });
    value.tables[0].fields[field] = md5('changed');
    expect(normalized(value)).not.toBe(normalized(installed()));
  });
  it('includes unexpected fields and schema additions even on an empty protected table', () => {
    const value = installed(); value.tables[0].columns.push(column('unexpected'));
    expect(normalized(value)).not.toBe(normalized(installed()));
    const empty = { table: 'public.notifications', count: 0, digest: md5([]), columns: [column('id')], fields: {} };
    const original = { ...installed(), tables: [...installed().tables, empty] };
    const changed = structuredClone(original); changed.tables[1].columns.push(column('unexpected'));
    const tables = [table, 'public.notifications'];
    expect(validateLegacyUpgradeObservation(changed, tables, [id], true))
      .not.toBe(validateLegacyUpgradeObservation(original, tables, [id], true));
  });
  it.each([
    ['missing old assignment', v => { v.assignments = []; v.tables[0].count = 0; }],
    ['non-NULL old memo', v => { v.assignments[0].memoNull = false; }],
    ['missing new column', v => { v.memoColumn = null; }],
    ['wrong memo type', v => { v.memoColumn.type = 'jsonb'; }],
    ['NOT NULL memo', v => { v.memoColumn.nullable = false; }],
    ['duplicate assignment', v => { v.assignments.push({ ...v.assignments[0] }); }],
    ['wrong count', v => { v.tables[0].count = 0; }],
    ['missing protected table', v => { v.tables = []; }],
    ['extra protected table', v => { v.tables.push({ ...v.tables[0] }); }],
  ])('rejects %s', (_label, mutate) => {
    const value = installed(); mutate(value); expect(() => normalized(value)).toThrow(/LEGACY_UPGRADE_/);
  });
  it('rejects an empty or already-upgraded initial fixture', () => {
    const value = observation(); value.assignments = []; value.tables[0].count = 0;
    expect(() => validateLegacyUpgradeObservation(value, [table], null, false)).toThrow(/BASELINE_REQUIRED/);
    expect(() => validateLegacyUpgradeObservation(installed(), [table], null, false)).toThrow(/BASELINE_REQUIRED/);
  });
  it('rejects a dropped memo column after a successful installation snapshot', () => {
    let value = observation(); const h = createLegacyUpgradeHistory(() => JSON.stringify(value), [table]);
    h.snapshot(); h.requireMemoColumn(); value = installed(); h.snapshot(); value.memoColumn = null;
    expect(() => h.snapshot()).toThrow(/MEMO_COLUMN_MISSING/);
  });
  it('does not leak query errors, memo values or baseline identifiers', () => {
    const secret = 'DO_NOT_PRINT_MEMO_OR_PIN';
    const h = createLegacyUpgradeHistory(() => { throw new Error(secret); }, [table]);
    expect(() => h.snapshot()).toThrow('LEGACY_UPGRADE_QUERY_FAILED');
    const value = installed(); value.assignments[0].extra = secret;
    const report = normalized(value);
    expect(report).not.toContain(secret); expect(report).not.toContain(id);
    expect(report).toContain('status'); expect(report).toContain('digest');
  });
  it('fails with table/field diagnostics even when callers redact thrown errors', () => {
    let value = observation(); const h = createLegacyUpgradeHistory(() => JSON.stringify(value), [table]);
    const before = h.snapshot(); h.requireMemoColumn(); value = installed();
    h.assertUnchanged(before, 'preserve history');
    value.tables[0].digest = md5('changed'); value.tables[0].fields.status = md5('changed');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => h.assertUnchanged(before, 'preserve history')).toThrow(/HISTORY_CHANGED/);
      const text = log.mock.calls.flat().join('');
      expect(text).toContain('"changedFields":["status"]');
      expect(text).toContain('"beforeCount":1'); expect(text).not.toContain(id);
      expect(text).not.toContain('notified');
    } finally { log.mockRestore(); }
  });
});

describe('read-only SQL and source wiring', () => {
  it.each([15, 17])('parses the actual query as one SELECT with PG%s grammar (no database)', async version => {
    const { parse } = createRequire(import.meta.url)(`@pgsql/parser/v${version}`);
    for (const ids of [[], [id]]) {
      const sql = legacyUpgradeHistorySql([table, 'public.cleaning_targets', 'public.cleaning_target_schedule_revisions'], ids);
      const ast = await parse(sql); expect(ast.stmts).toHaveLength(1);
      expect(ast.stmts[0].stmt.SelectStmt).toBeDefined();
      expect(sql).not.toMatch(/jsonb_strip_nulls|\b(insert|update|delete|reset|create|alter)\b/i);
      expect(sql).toContain("else to_jsonb(t)-array['notified_reservation_schedule_snapshot']::text[] end");
    }
  });
  it.each([['public.x;delete from x'], [table, table], ['auth.users']])('rejects invalid table scope %s', tables => {
    expect(() => legacyUpgradeHistorySql(tables)).toThrow(/TABLE_SCOPE/);
  });
  it('rejects arbitrary SQL in baseline IDs', () => {
    expect(() => legacyUpgradeHistorySql([table], ["';select 1"])).toThrow(/BASELINE_IDS/);
  });
  const scopes = {
    'cleaning-overdue': ['public.cleaning_targets', table, 'public.cleaning_attempts', 'public.cleaning_target_schedule_revisions', 'public.notifications', 'public.audit_events', 'private.command_executions'],
    'cleaning-started': ['public.cleaning_targets', table, 'public.cleaning_attempts', 'public.audit_events', 'public.notifications', 'private.notification_groups', 'private.notification_delivery_outbox', 'private.command_executions'],
    'cleaning-overdue-preview': null, 'cleaning-overdue-commit': null,
    'assignment-target-read': null, 'manual-cleaning-cancel': null,
  };
  it.each(Object.entries(scopes))('wires %s after migration and retains protected table scope', (name, exactScope) => {
    const source = readFileSync(new URL(`../scripts/test-${name}-upgrade.mjs`, import.meta.url), 'utf8');
    expect(source).toContain('createLegacyUpgradeHistory(sql,');
    expect(source.match(/history.requireMemoColumn\(\)/g)).toHaveLength(1);
    expect(source.indexOf('history.requireMemoColumn()')).toBeGreaterThan(source.indexOf("'migration', 'up'"));
    expect(source).toContain('history.snapshot()');
    if (exactScope) {
      const definition = source.match(/createLegacyUpgradeHistory\(sql, \[([\s\S]*?)\]\)/)[1];
      expect([...definition.matchAll(/'([^']+)'/g)].map(m => m[1])).toEqual(exactScope);
    }
  });
});
