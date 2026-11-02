import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runLocalHistoricalCompatibilityCheck } from './check-db-lint-baseline.mjs';

// Only the historical 100 -> 101 upgrade probe invokes this exact-nine gate.
// The final release entry point always requires all nineteen diagnostics.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { runLocalHistoricalCompatibilityCheck(); }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'DB lint baseline rejected: unexpected failure'}\n`);
    process.exitCode = 1;
  }
}
