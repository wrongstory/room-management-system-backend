import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('..', import.meta.url);
const fixture = readFileSync(new URL('fixtures/payroll-payment-upgrade-v39.sql', import.meta.url));
const assertions = readFileSync(new URL('fixtures/payroll-payment-upgrade-v40-assert.sql', import.meta.url));
const supabaseCli = fileURLToPath(
  new URL('../node_modules/supabase/dist/supabase.js', import.meta.url)
);
const container = 'supabase_db_room-management-system-backend';
const psqlArgs = [
  'exec', '-i', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
  '-U', 'postgres', '-d', 'postgres'
];

function run(command, args, options = {}) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options });
}

function psql(input) {
  execFileSync('docker', psqlArgs, {
    cwd: root,
    input,
    stdio: ['pipe', 'inherit', 'inherit']
  });
}

let passed = false;
try {
  run(process.execPath, [
    supabaseCli, 'db', 'reset', '--local', '--no-seed',
    '--version', '20260910071812'
  ]);
  psql(fixture);
  run(process.execPath, [supabaseCli, 'migration', 'up', '--local']);
  psql(assertions);
  passed = true;
  process.stdout.write('payroll payment 39 -> 40 upgrade compatibility: PASS\n');
} finally {
  // Every exit path restores a clean full-migration database so the pgTAP and
  // concurrency suites never inherit compatibility fixtures or a v39 schema.
  try {
    run(process.execPath, [supabaseCli, 'db', 'reset', '--local', '--no-seed']);
  } catch (restoreError) {
    process.stderr.write(`failed to restore full local migration state: ${restoreError}\n`);
    if (passed) process.exitCode = 1;
  }
}
