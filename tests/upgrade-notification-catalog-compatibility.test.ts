import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { validatePostApprovalUpgradeSource } from '../scripts/test-post-approval-room-issue-upgrade.mjs';
import { APPROVED_UPGRADE_NOTIFICATION_CATALOG_ROW as addition, assertUpgradeNotificationCatalog,
  upgradeHistorySnapshotSql } from '../scripts/lib/upgrade-notification-catalog-compatibility.mjs';

const old = [{ event_family: 'existing.family', category: 'existing-category', preserved: { value: 1 } }];
const installed = () => structuredClone([...old, addition]);
describe('historical upgrade notification catalog compatibility', () => {
  it('permits only the complete approved111 addition with every original whole row intact', () => {
    expect(() => assertUpgradeNotificationCatalog(old, installed(), 111)).not.toThrow();
    expect(() => assertUpgradeNotificationCatalog(old, installed().reverse(), 111)).not.toThrow();
    for (let count = 95; count <= 110; count++) {
      expect(() => assertUpgradeNotificationCatalog(old, structuredClone(old), count)).not.toThrow();
      expect(() => assertUpgradeNotificationCatalog(old, installed(), count)).toThrow();
    }
  });
  it.each(Object.keys(addition))('rejects altered approved metadata %s', key => {
    const after = installed();
    (after[1] as Record<string, unknown>)[key] = 'unapproved';
    expect(() => assertUpgradeNotificationCatalog(old, after, 111)).toThrow();
  });
  it('rejects unknown additions, old-row changes, removals and duplicate families', () => {
    for (const after of [old, [...installed(), { event_family: 'unknown' }], [addition],
      [...installed(), addition], [{ ...old[0], preserved: { value: 2 } }, addition],
      [...old, { ...addition, extra: true }]]) {
      expect(() => assertUpgradeNotificationCatalog(old, after, 111)).toThrow();
    }
    expect(() => assertUpgradeNotificationCatalog(installed(), installed(), 111)).toThrow();
    for (const count of [94, 128, 111.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => assertUpgradeNotificationCatalog(old, installed(), count)).toThrow();
    }
  });
  it.each([113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 126, 127])('preserves the exact catalog and digest contract at reviewed migration %i', count => {
    expect(() => assertUpgradeNotificationCatalog(old, installed(), count)).not.toThrow();
    for (const key of Object.keys(addition)) {
      const after = installed();
      (after[1] as Record<string, unknown>)[key] = 'unapproved';
      expect(() => assertUpgradeNotificationCatalog(old, after, count)).toThrow();
    }
    for (const after of [old, [addition], [...installed(), { event_family: 'unknown' }],
      [...installed(), addition], [{ ...old[0], preserved: { value: 2 } }, addition],
      [...old, { ...addition, extra: true }]]) {
      expect(() => assertUpgradeNotificationCatalog(old, after, count)).toThrow();
    }
    const shape = [{ table: 'public.notifications', columns: ['id', 'payload'] },
      { table: 'private.notification_event_catalog', columns: Object.keys(addition) }];
    for (const exclude of [false, true]) {
      expect(upgradeHistorySnapshotSql(shape, count, exclude)).toBe(upgradeHistorySnapshotSql(shape, 111, exclude));
    }
  });
  it('accepts the actual source-reviewed manifest before constructing any DB snapshot', () => {
    const directory = new URL('../supabase/migrations/', import.meta.url);
    const manifest = JSON.parse(readFileSync(new URL('../supabase/migration-manifest.dev.json', import.meta.url), 'utf8'));
    const entries = readdirSync(directory, { withFileTypes: true }).filter(entry => entry.name.endsWith('.sql'))
      .map(entry => ({ file: entry.name, isFile: entry.isFile(), isSymbolicLink: entry.isSymbolicLink(),
        raw: readFileSync(new URL(entry.name, directory)) }));
    validatePostApprovalUpgradeSource(manifest, entries);
    expect(() => upgradeHistorySnapshotSql([{ table: 'public.notifications', columns: ['id'] }], manifest.totalCount)).not.toThrow();
    const runner = readFileSync(new URL('../scripts/test-assignment-reservation-schedule-upgrade.mjs', import.meta.url), 'utf8');
    expect(runner.indexOf('validatePostApprovalUpgradeSource(manifest,')).toBeGreaterThan(0);
    expect(runner.indexOf('validatePostApprovalUpgradeSource(manifest,')).toBeLessThan(runner.indexOf('resetStarted = true'));
  });
  it.each(Array.from({ length: 16 }, (_, index) => 112 + index))('keeps exactly the same111 catalog exception at audited head %i', count => {
    expect(() => assertUpgradeNotificationCatalog(old, installed(), count)).not.toThrow();
    for (const after of [old, [...installed(), { event_family: 'unknown' }],
      [addition], [...installed(), addition], [{ ...old[0], preserved: { value: 2 } }, addition],
      [...old, { ...addition, extra: true }]]) {
      expect(() => assertUpgradeNotificationCatalog(old, after, count)).toThrow();
    }
    for (const key of Object.keys(addition)) {
      const after = installed();
      (after[1] as Record<string, unknown>)[key] = 'unapproved';
      expect(() => assertUpgradeNotificationCatalog(old, after, count)).toThrow();
    }
    for (const [before, after] of [[null, installed()], [old, null], [null, null], [installed(), installed()]]) {
      expect(() => assertUpgradeNotificationCatalog(before, after, count)).toThrow();
    }
    const shape = [{ table: 'private.notification_event_catalog', columns: Object.keys(addition) }];
    expect(upgradeHistorySnapshotSql(shape,count,true)).toBe(upgradeHistorySnapshotSql(shape,111,true));
    expect(upgradeHistorySnapshotSql(shape,count)).toBe(upgradeHistorySnapshotSql(shape,111));
    expect(() => upgradeHistorySnapshotSql([{ table: 'public.notifications', columns: ['id'] }],count,true)).toThrow();
    expect(() => upgradeHistorySnapshotSql([{ table: 'private.notification_event_catalog', columns: ['event_family'] }],count,true)).toThrow();
  });
  it('does not invent a catalog for older schemas or accept a missing111 catalog', () => {
    expect(() => assertUpgradeNotificationCatalog(null, null, 95)).not.toThrow();
    for (const [before, after] of [[null, old], [old, null], [null, null]]) {
      expect(() => assertUpgradeNotificationCatalog(before, after, 111)).toThrow();
    }
    expect(() => assertUpgradeNotificationCatalog(null, old, 110)).toThrow();
  });
  it('keeps the full catalog and original-column digest in one statement with only one exact exclusion', () => {
    const shape = [{ table: 'public.notifications', columns: ['id', 'payload'] },
      { table: 'private.notification_event_catalog', columns: Object.keys(addition) }];
    const sql = upgradeHistorySnapshotSql(shape, 111, true);
    expect(sql).toContain("where t.event_family<>'post_approval_room_issue.reported_admin'");
    expect(sql.match(/where t\.event_family/g)).toHaveLength(1);
    expect(sql).toContain('jsonb_agg(to_jsonb(c) order by c.event_family)');
    expect(sql).toContain("array['id','payload']");
    expect(sql).toContain('from public.notifications t');
    expect(upgradeHistorySnapshotSql(shape, 110, true)).not.toContain('where t.event_family');
    expect(upgradeHistorySnapshotSql(shape, 111)).not.toContain('where t.event_family');
    const first = shape[0]; if (!first) throw new Error('Synthetic original table missing');
    expect(() => upgradeHistorySnapshotSql([first], 111, true)).toThrow();
    expect(() => upgradeHistorySnapshotSql([...shape, first], 111, true)).toThrow();
    expect(() => upgradeHistorySnapshotSql([{ table: 'public.x;delete', columns: ['id'] }], 95)).toThrow();
  });
});
