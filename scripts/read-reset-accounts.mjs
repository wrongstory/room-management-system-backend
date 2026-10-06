import { readLocalResetAccounts } from './read-reset-catalog.mjs';

try {
  process.stdout.write(`${JSON.stringify(readLocalResetAccounts({ args: process.argv.slice(2) }))}\n`);
} catch {
  process.stderr.write('RESET_ACCOUNTS_REJECTED\n');
  process.exitCode = 1;
}
