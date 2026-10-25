import { readFileSync, writeFileSync } from 'node:fs';
import { RESET_ROW_RULES, RESET_ROW_RULE_FINGERPRINT, resetRowDispositionExpression } from './reset-row-policy.mjs';

const literal = value => `'${value.replaceAll("'", "''")}'`;
const rules = [...RESET_ROW_RULES.map(rule => rule.relation), 'auth.users'].sort().map(relation =>
  `    (${literal(relation)},${literal(resetRowDispositionExpression(relation, 'r').replaceAll(/\br\./g, '{alias}.'))})`).join(',\n');
const output = readFileSync('scripts/reset-row-impact.sql.in', 'utf8').replaceAll('\r\n', '\n')
  .replace('@@ROW_RULES@@', rules).replace('@@RULE_FINGERPRINT@@', RESET_ROW_RULE_FINGERPRINT);
const target = 'supabase/migrations/20261025024327_developer_reset_row_impact.sql';
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8').replaceAll('\r\n', '\n') !== output) throw new Error('Reset row impact source drift');
} else writeFileSync(target, output);
