import assert from 'node:assert/strict';

// One approved additive row in migration111, not a family-prefix allowlist.
// Importing this helper never reads files, starts a process or accesses a DB.
export const APPROVED_UPGRADE_NOTIFICATION_CATALOG_ROW = Object.freeze({
  event_family: 'post_approval_room_issue.reported_admin', category: 'room_issue_reported',
  source_entity_kind: 'post_approval_room_issue_report', recipient_capability: 'admin.inspection_queue',
  requires_action: false, push_eligible: true, resolver_kind: 'none', deep_link_kind: 'submission',
  group_family: 'post_approval_room_issue_reported', group_scope_kind: 'room', contract_version: 1,
});
export const APPROVED_AVAILABILITY_NOTIFICATION_ROWS = Object.freeze(['requested','approved','rejected'].map(phase => Object.freeze({
  event_family: `availability.change_${phase}`, category: `availability_change_${phase}`,
  source_entity_kind: 'availability_change_request',
  recipient_capability: phase === 'requested' ? 'admin.availability_decider' : 'maid.availability_owner',
  requires_action: phase === 'requested', push_eligible: true,
  resolver_kind: phase === 'requested' ? 'availability_decision' : 'none', deep_link_kind: 'availabilityRequest',
  group_family: `availability_change_${phase}`, group_scope_kind: 'availabilityRequest', contract_version: 1,
})));
export const APPROVED_ALL_PUSH_FAMILIES = Object.freeze([
  'inspection.original_approved',
  'inspection.reclean_approved',
  'inspection.complaint_rework_approved',
  'inspection.complaint_rework_rejected',
  'complaint.received',
  'complaint.corrected',
  'complaint.acknowledged',
  'complaint.closed',
  'payroll.adjustment_recorded',
  'payroll.adjustment_reversed',
  'payroll.late_earning_carried',
  'payroll.payment_started',
  'payroll.offset_settled',
  'payroll.payment_check_recorded',
  'payroll.payment_paid',
  'payroll.payment_reopened'
]);
const approvedAdditions = expectedCount => [APPROVED_UPGRADE_NOTIFICATION_CATALOG_ROW,
  ...(expectedCount >= 151 ? APPROVED_AVAILABILITY_NOTIFICATION_ROWS : [])];
const catalogTable = 'private.notification_event_catalog';
const literal = value => `'${value.replaceAll("'", "''")}'`;

function checkExpectedCount(expectedCount) {
  // 112 indexes; 113 auth read; 114 room aggregate; 115/118 assignment planning;
  // 116/117 payroll projection; 119 PIN transfer; 120/121 photo commands;
  // 122 memo-only reports; 123 overdue delivery clock; 124 card hydration;
  // 125 reset inventory read; 126 bounded photo batch admission;
  // 127 read-only reset row impact; 128 private operation gates; 129 template inventory; 130 HTTP admission; 131 atomic audit; 132 notification admission; 133 scheduler admission; 134 incremental PIN admission; 135 durable reset receipt store; 136 inactive template handover effect; 137 finite lifecycle admission; 138 room-ready correction reuses existing notification families. 139 repairs password receipt return values. 140 adds assignment instructions without new families. No catalog rows are added.
  // Runtime event dispatch is not permission to mutate historical catalog metadata.
  // 141 only observes an existing offline resolution terminal; no family is added.
  // 142 settles a password effect using the existing account.password_changed event.
  // 143 is an arrival read projection; it adds no event or catalog writes.
  // 144 adds room memo revisions; 145 changes current-week approval timing.
  // 146 replaces six existing function bodies without adding catalog rows.
  // 147 removes one unused private helper argument without notification catalog changes.
  // 150 narrows exactly 33 service privileges without catalog row changes.
  // 149 only revokes destructive request-history grants; notification rows remain exact.
  assert(Number.isSafeInteger(expectedCount) && expectedCount >= 95 && expectedCount <= 154,
    'Only the audited95..154 upgrade range is supported; 151 adds exactly three availability families');
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

/** The 56/73 cumulative probes allow later additions but preserve every old whole row. */
export function assertCumulativeNotificationCatalog(before, after, expectedCount) {
  assert(Number.isSafeInteger(expectedCount) && expectedCount >= 78 && expectedCount <= 154,
    'Only the audited 78..154 cumulative upgrade range is supported');
  const previous = catalogRows(before), installed = catalogRows(after);
  assert(previous.length > 0, 'The existing cumulative baseline catalog cannot be empty');
  if (expectedCount >= 152) {
    assert.equal(previous.filter(row => APPROVED_ALL_PUSH_FAMILIES.includes(row.event_family)
      && row.push_eligible === false).length, APPROVED_ALL_PUSH_FAMILIES.length,
    'Exactly sixteen existing false-to-true flags are reviewed');
  }
  const byFamily = new Map(installed.map(row => [row.event_family, row]));
  for (const row of previous) {
    const expected = expectedCount >= 152 && APPROVED_ALL_PUSH_FAMILIES.includes(row.event_family)
      ? { ...row, push_eligible: true } : row;
    assert.deepEqual(byFamily.get(row.event_family), expected,
      'Every cumulative baseline catalog row must remain exact except the approved sixteen push flags');
  }
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
  const additions = approvedAdditions(expectedCount), families = new Set(additions.map(row => row.event_family));
  assert(!previous.some(row => families.has(row.event_family)), 'Approved additions cannot pre-exist the baseline');
  assert.deepEqual(catalogRows(installed.filter(row => families.has(row.event_family))), catalogRows(additions),
    'Every approved typed metadata field must match, with no missing or extra family or field');
  assert.equal(installed.length, previous.length + additions.length, 'No other catalog addition is permitted');
  const expectedPrevious = previous.map(row => expectedCount >= 152 && APPROVED_ALL_PUSH_FAMILIES.includes(row.event_family)
    ? {...row, push_eligible: true} : row);
  if (expectedCount >= 152) {
    assert.equal(previous.filter(row => APPROVED_ALL_PUSH_FAMILIES.includes(row.event_family) && row.push_eligible === false).length,
      APPROVED_ALL_PUSH_FAMILIES.length, 'Exactly sixteen existing false-to-true flags are reviewed');
  }
  assert.deepEqual(installed.filter(row => !families.has(row.event_family)), expectedPrevious,
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
    const projection = exclude && expectedCount >= 152 && table === catalogTable
      ? `case when t.event_family in (${APPROVED_ALL_PUSH_FAMILIES.map(literal).join(',')}) then to_jsonb(t)||jsonb_build_object('push_eligible',false) else to_jsonb(t) end`
      : 'to_jsonb(t)';
    const where = exclude && table === catalogTable
      ? ` where ${approvedAdditions(expectedCount).map(row => `t.event_family<>${literal(row.event_family)}`).join(' and ')}` : '';
    return `select ${literal(table)} tag,(select jsonb_object_agg(key,value) from jsonb_each(${projection})
      where key=any(array[${columns.map(literal).join(',')}]::text[]))::text data from ${table} t${where}`;
  });
  const wholeCatalog = catalog
    ? `(select coalesce(jsonb_agg(to_jsonb(c) order by c.event_family),'[]'::jsonb) from ${catalogTable} c)`
    : 'null::jsonb';
  return `select jsonb_build_object('digest',md5(coalesce(string_agg(tag||':'||data,'|' order by tag,data),'')),
    'catalog',${wholeCatalog}) from (${rows.join(' union all ')}) history;`;
}
