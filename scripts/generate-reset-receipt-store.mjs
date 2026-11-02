import { readFileSync, writeFileSync } from 'node:fs';
// Frozen135: later row policies must append, never rewrite this source.
const baseline = JSON.parse(readFileSync('scripts/reset-row-impact-baseline135.json', 'utf8'));

const literal = value => `'${value.replaceAll("'", "''")}'`;
const rules = baseline.rules.map(({ relation, expression }) =>
  `    (${literal(relation)},${literal(expression)})`).join(',\n');
// Reuse only the finite disposition and row-impact collectors. Keep the combined
//129 collector (inventory/rowImpact/gateEvidence/templateEvidence) and Auth wrapper.
const base = readFileSync('scripts/reset-row-impact.sql.in', 'utf8').replaceAll('\r\n', '\n');
const extension = base.slice(base.indexOf('create function private.developer_reset_disposition_expression'),
  base.indexOf('-- Both collectors share'))
  .replaceAll('create function private.', 'create or replace function private.')
  .replace('@@ROW_RULES@@', rules).replace('@@RULE_FINGERPRINT@@', baseline.fingerprint).trimEnd();
const output = readFileSync('scripts/reset-receipt-store.sql.in', 'utf8').replaceAll('\r\n', '\n')
  .replace('@@COLLECTOR_EXTENSION@@', () => extension);
const target = 'supabase/migrations/20261025051231_developer_reset_receipt_store.sql';
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8').replaceAll('\r\n', '\n') !== output) throw new Error('Reset receipt store source drift');
} else writeFileSync(target, output);
