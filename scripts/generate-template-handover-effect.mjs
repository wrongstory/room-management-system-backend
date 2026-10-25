import { readFileSync, writeFileSync } from 'node:fs';
import { RESET_ROW_RULES, RESET_ROW_RULE_FINGERPRINT, resetRowDispositionExpression } from './reset-row-policy.mjs';
const literal = value => `'${value.replaceAll("'", "''")}'`;
const rules = [...RESET_ROW_RULES.map(rule => rule.relation), 'auth.users'].sort().map(relation =>
  `    (${literal(relation)},${literal(resetRowDispositionExpression(relation, 'r').replaceAll(/\br\./g, '{alias}.'))})`).join(',\n');
const base = readFileSync('scripts/reset-row-impact.sql.in', 'utf8').replaceAll('\r\n', '\n');
const extension = base.slice(base.indexOf('create function private.developer_reset_disposition_expression'), base.indexOf('-- Both collectors share'))
  .replaceAll('create function private.', 'create or replace function private.')
  .replace('@@ROW_RULES@@', rules).replace('@@RULE_FINGERPRINT@@', RESET_ROW_RULE_FINGERPRINT).trimEnd();
const output = readFileSync('scripts/template-handover-effect.sql.in', 'utf8').replaceAll('\r\n', '\n')
  .replace('@@COLLECTOR_EXTENSION@@', () => extension);
const target = 'supabase/migrations/20261025072617_developer_template_handover_effect.sql';
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8').replaceAll('\r\n', '\n') !== output) throw new Error('Template handover effect source drift');
} else writeFileSync(target, output);
