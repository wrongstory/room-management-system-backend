import { readFileSync, writeFileSync } from 'node:fs';
// Frozen127 input. New relation rules belong in an append migration, never in127.
const baseline = JSON.parse(readFileSync('scripts/reset-row-impact-baseline127.json', 'utf8'));

const literal = value => `'${value.replaceAll("'", "''")}'`;
const rules = baseline.rules.map(({ relation, expression }) =>
  `    (${literal(relation)},${literal(expression)})`).join(',\n');
const output = readFileSync('scripts/reset-row-impact.sql.in', 'utf8').replaceAll('\r\n', '\n')
  .replace('@@ROW_RULES@@', rules).replace('@@RULE_FINGERPRINT@@', baseline.fingerprint);
const target = 'supabase/migrations/20261025024327_developer_reset_row_impact.sql';
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8').replaceAll('\r\n', '\n') !== output) throw new Error('Reset row impact source drift');
} else writeFileSync(target, output);
