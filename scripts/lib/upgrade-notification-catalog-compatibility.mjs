import assert from 'node:assert/strict';

// One approved additive row in migration111, not a family-prefix allowlist.
// Importing this helper never reads files, starts a process or accesses a DB.
export const APPROVED_UPGRADE_NOTIFICATION_CATALOG_ROW = Object.freeze({
  event_family: 'post_approval_room_issue.reported_admin', category: 'room_issue_reported',
  source_entity_kind: 'post_approval_room_issue_report', recipient_capability: 'admin.inspection_queue',
  requires_action: false, push_eligible: true, resolver_kind: 'none', deep_link_kind: 'submission',
  group_family: 'post_approval_room_issue_reported', group_scope_kind: 'room', contract_version: 1,
});
const catalogTable = 'private.notification_event_catalog';
const literal = value => `'${value.replaceAll("'", "''")}'`;

function checkExpectedCount(expectedCount) {
  assert(Number.isSafeInteger(expectedCount) && expectedCount >= 95 && expectedCount <= 112,
    'Only the audited95..112 upgrade range is supported; index-only112 adds no catalog rows');
}
function catalogRows(value) {
  assert(Array.isArray(value), 'An existing baseline notification catalog is required');
  const families = new Set();
  for (const row of value) {
    assert(row && typeof row === 'object' && Object.getPrototypeOf(row) === Object.prototype,
      'Notification catalog rows must be plain JSON objects');
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(row)))
      assert(Object.hasOwn(descriptor, 'value'), 'Notification catalog accessors are forbidden');
    assert(typeof row.event_family === 'string' && !families.has(row.event_family),
      'Notification catalog event families must be unique');
    families.add(row.event_family);
  }
  return [...value].sort((a, b) => a.event_family.localeCompare(b.event_family));
}

/** Compare every whole old catalog row; permit only the exact new111 metadata. */
export function assertUpgradeNotificationCatalog(before, after, expectedCount) {
  checkExpectedCount(expectedCount);
  if (expectedCount < 111) {
    if (before === null || after === null) {
      assert.equal(after, before, 'A missing old catalog cannot be silently added or removed');
      return;
    }
    assert.deepEqual(catalogRows(after), catalogRows(before), 'Every old catalog row remains exact');
    return;
  }
  const previous = catalogRows(before), installed = catalogRows(after);
  const family = APPROVED_UPGRADE_NOTIFICATION_CATALOG_ROW.event_family;
  assert(!previous.some(row => row.event_family === family), 'The111 family cannot pre-exist the baseline');
  const added = installed.filter(row => row.event_family === family);
  assert.equal(added.length, 1, 'Exactly one approved111 notification catalog row is required');
  assert.deepEqual(added[0], APPROVED_UPGRADE_NOTIFICATION_CATALOG_ROW,
    'Every one of the11 approved typed metadata fields must match, with no extra fields');
  assert.equal(installed.length, previous.length + 1, 'No other catalog addition is permitted');
  assert.deepEqual(installed.filter(row => row.event_family !== family), previous,
    'Every baseline catalog whole row remains exact; no mutation, removal or extra family');
}

/** One statement returns the digest and unfiltered catalog used to validate it. */
export function upgradeHistorySnapshotSql(shape, expectedCount, excludeApprovedAddition = false) {
  checkExpectedCount(expectedCount);
  assert(typeof excludeApprovedAddition === 'boolean');
  assert(Array.isArray(shape) && shape.length > 0, 'A nonempty original table/column shape is required');
  const tables = new Set();
  const catalog = shape.find(entry => entry.table === catalogTable);
  const exclude = excludeApprovedAddition && expectedCount >= 111;
  if (exclude) {
    assert(catalog && Object.keys(APPROVED_UPGRADE_NOTIFICATION_CATALOG_ROW)
      .every(column => catalog.columns.includes(column)), 'The111 exception requires the complete baseline catalog schema');
  }
  const rows = shape.map(({ table, columns }) => {
    assert(typeof table === 'string' && /^(public|private)\.[a-z_][a-z_0-9]*$/.test(table)
      && !tables.has(table), 'Source-controlled unique baseline table identifier');
    tables.add(table);
    assert(Array.isArray(columns) && columns.length > 0 && new Set(columns).size === columns.length
      && columns.every(column => typeof column === 'string' && /^[a-z_][a-z_0-9]*$/.test(column)),
    'Original baseline column identifiers');
    const where = exclude && table === catalogTable
      ? ` where t.event_family<>${literal(APPROVED_UPGRADE_NOTIFICATION_CATALOG_ROW.event_family)}` : '';
    return `select ${literal(table)} tag,(select jsonb_object_agg(key,value) from jsonb_each(to_jsonb(t))
      where key=any(array[${columns.map(literal).join(',')}]::text[]))::text data from ${table} t${where}`;
  });
  const wholeCatalog = catalog
    ? `(select coalesce(jsonb_agg(to_jsonb(c) order by c.event_family),'[]'::jsonb) from ${catalogTable} c)`
    : 'null::jsonb';
  return `select jsonb_build_object('digest',md5(coalesce(string_agg(tag||':'||data,'|' order by tag,data),'')),
    'catalog',${wholeCatalog}) from (${rows.join(' union all ')}) history;`;
}
