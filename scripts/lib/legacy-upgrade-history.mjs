// Read-only observations for the six pre140 -> latest synthetic upgrade tests.
// Importing this module cannot start a process or connect to a database.
const assignmentTable = 'public.cleaning_assignments';
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const hash = /^[0-9a-f]{32}$/;
const identifier = /^[a-z_][a-z_0-9]*$/;
const fail = code => { throw new Error(`LEGACY_UPGRADE_${code}`); };
const quoted = value => `'${value}'`; // Only validated source identifiers/UUIDs.
const exceptions = table => table === assignmentTable
  ? ['notified_reservation_schedule_snapshot']
  : table === 'public.cleaning_target_schedule_revisions' ? ['reservation_schedule_snapshot'] : [];

export function legacyUpgradeHistorySql(tables, baselineIds = []) {
  if (!Array.isArray(tables) || !tables.includes(assignmentTable) || new Set(tables).size !== tables.length
    || !tables.every(t => /^(public|private)\.[a-z_][a-z_0-9]*$/.test(t))) fail('TABLE_SCOPE');
  if (!Array.isArray(baselineIds) || !baselineIds.every(id => uuid.test(id))) fail('BASELINE_IDS');
  const legacy = `t.id::text=any(array[${baselineIds.map(quoted).join(',')}]::text[])`;
  const reports = tables.map(table => {
    const ignored = exceptions(table);
    const projection = `to_jsonb(t)-array[${ignored.map(quoted).join(',')}]::text[]`;
    const data = table === assignmentTable
      ? `case when ${legacy} then (${projection})-'instruction_memo' else ${projection} end` : projection;
    const schemaIgnored = table === assignmentTable ? [...ignored, 'instruction_memo'] : ignored;
    return `(with rows as (select ${data} data from ${table} t)
      select jsonb_build_object('table',${quoted(table)},'count',(select count(*) from rows),
        'digest',(select md5(coalesce(string_agg(data::text,'|' order by data::text),'')) from rows),
        'columns',(select coalesce(jsonb_agg(jsonb_build_object('name',a.attname,
          'type',pg_catalog.format_type(a.atttypid,a.atttypmod),'nullable',not a.attnotnull) order by a.attname),'[]'::jsonb)
          from pg_catalog.pg_attribute a where a.attrelid=${quoted(table)}::regclass
          and a.attnum>0 and not a.attisdropped and not(a.attname=any(array[${schemaIgnored.map(quoted).join(',')}]::text[]))),
        'fields',(select coalesce(jsonb_object_agg(key,digest),'{}'::jsonb) from
          (select e.key,md5(string_agg(e.value::text,'|' order by rows.data::text)) digest
           from rows cross join lateral jsonb_each(rows.data) e group by e.key) fields)))`;
  });
  return `select jsonb_build_object('tables',jsonb_build_array(${reports.join(',')}),
    'memoColumn',(select jsonb_build_object('type',pg_catalog.format_type(a.atttypid,a.atttypmod),
      'nullable',not a.attnotnull) from pg_catalog.pg_attribute a
      where a.attrelid='public.cleaning_assignments'::regclass and a.attname='instruction_memo'
      and a.attnum>0 and not a.attisdropped),
    'assignments',(select coalesce(jsonb_agg(jsonb_build_object('id',t.id::text,
      'memoNull',not(to_jsonb(t)?'instruction_memo') or to_jsonb(t)->'instruction_memo'='null'::jsonb)
      order by t.id),'[]'::jsonb) from public.cleaning_assignments t));`;
}

// Returns only counts, schema and digests. No row value, memo, PIN or identifier
// is included in assertion output. Field digests help locate a mismatch.
export function validateLegacyUpgradeObservation(value, tables, baselineIds, requireMemo) {
  if (!value || !Array.isArray(value.tables) || value.tables.length !== tables.length
    || !Array.isArray(value.assignments)) fail('OBSERVATION_SHAPE');
  const ids = new Set();
  for (const row of value.assignments) {
    if (!row || !uuid.test(row.id) || ids.has(row.id) || typeof row.memoNull !== 'boolean') fail('ASSIGNMENT_SHAPE');
    ids.add(row.id);
  }
  if (baselineIds === null) {
    if (requireMemo || !ids.size || value.memoColumn !== null || value.assignments.some(row => !row.memoNull)) fail('NONEMPTY_PRE140_BASELINE_REQUIRED');
  } else {
    if (requireMemo && value.memoColumn === null) fail('MEMO_COLUMN_MISSING');
    if (value.memoColumn !== null && (value.memoColumn?.type !== 'text' || value.memoColumn?.nullable !== true)) fail('MEMO_COLUMN_SHAPE');
    for (const id of baselineIds) {
      const row = value.assignments.find(r => r.id === id);
      if (!row) fail('BASELINE_ASSIGNMENT_MISSING');
      if (!row.memoNull) fail('BASELINE_MEMO_NOT_NULL');
    }
  }
  const normalized = tables.map(table => {
    const matches = value.tables.filter(row => row?.table === table);
    if (matches.length !== 1) fail('TABLE_SET');
    const row = matches[0];
    if (!Number.isSafeInteger(row.count) || row.count < 0 || !hash.test(row.digest)
      || !Array.isArray(row.columns) || !row.columns.length
      || !row.fields || typeof row.fields !== 'object' || Array.isArray(row.fields)) fail('TABLE_SHAPE');
    if (table === assignmentTable && row.count !== ids.size) fail('ASSIGNMENT_COUNT');
    const names = new Set();
    const columns = row.columns.map(column => {
      if (!column || !identifier.test(column.name) || names.has(column.name)
        || typeof column.type !== 'string') fail('COLUMN_SHAPE');
      if (!/^[a-zA-Z0-9_ .,[\]()]+$/.test(column.type) || typeof column.nullable !== 'boolean') fail('COLUMN_SHAPE');
      names.add(column.name);
      return { name: column.name, type: column.type, nullable: column.nullable };
    }).sort((a, b) => a.name.localeCompare(b.name));
    const fields = Object.keys(row.fields).sort().map(name => {
      if (!identifier.test(name) || !hash.test(row.fields[name])) fail('FIELD_SHAPE');
      return [name, row.fields[name]];
    });
    return { table, count: row.count, digest: row.digest, columns, fields };
  });
  return JSON.stringify(normalized);
}

export function createLegacyUpgradeHistory(sql, tables) {
  let baselineIds = null;
  let requireMemo = false;
  return {
    requireMemoColumn() { requireMemo = true; },
    snapshot() {
      let value;
      try { value = JSON.parse(sql(legacyUpgradeHistorySql(tables, baselineIds ?? []))); }
      catch { fail('QUERY_FAILED'); }
      const summary = validateLegacyUpgradeObservation(value, tables, baselineIds, requireMemo);
      if (baselineIds === null) baselineIds = value.assignments.map(row => row.id);
      return summary;
    },
    assertUnchanged(expected, message) {
      const actual = this.snapshot();
      if (actual === expected) return;
      const before = JSON.parse(expected), after = JSON.parse(actual);
      const changes = after.flatMap(row => {
        const old = before.find(item => item.table === row.table);
        if (JSON.stringify(old) === JSON.stringify(row)) return [];
        const fields = Object.fromEntries(row.fields), previousFields = Object.fromEntries(old.fields);
        return [{ table: row.table, beforeCount: old.count, afterCount: row.count,
          beforeDigest: old.digest, afterDigest: row.digest,
          changedFields: [...new Set([...Object.keys(fields), ...Object.keys(previousFields)])]
            .filter(key => fields[key] !== previousFields[key]).sort(),
          schemaChanged: JSON.stringify(row.columns) !== JSON.stringify(old.columns) }];
      });
      // These summaries were validated above; no row values or IDs can escape.
      console.error(`Legacy upgrade history mismatch: ${JSON.stringify(changes)}`);
      throw new Error(`LEGACY_UPGRADE_HISTORY_CHANGED: ${message}`);
    },
  };
}
