import { inspectResetReferencePlan } from '../src/modules/developer-reset/reset-reference-plan.js';
const readerPath = './read-reset-catalog.mjs';
const { readLocalResetReferenceFixture } = await import(readerPath);

try {
  const fixture = readLocalResetReferenceFixture({ args: process.argv.slice(2) });
  const conflict = inspectResetReferencePlan(fixture);
  if (conflict.referencesValid || conflict.executionEnabled ||
      JSON.stringify(conflict.blockers) !== JSON.stringify(['PRESERVED_ROW_REFERENCES_REMOVED_ROW'])) {
    throw new Error('unexpected fixture result');
  }
  // Separate synthetic plan variant; no UPDATE is performed on any database.
  const preserved = structuredClone(fixture);
  for (const row of preserved.rows) row.disposition = 'keep';
  const safe = inspectResetReferencePlan(preserved);
  if (!safe.referencesValid || safe.executionEnabled || safe.counts?.rows !== 4 || safe.counts?.edges !== 1) {
    throw new Error('unexpected preservation result');
  }
  const omitted = structuredClone(preserved);
  omitted.rows = omitted.rows.filter((row: { key: string }) => row.key !== 'optional');
  const coverage = inspectResetReferencePlan(omitted);
  if (omitted.rows.length !== 3 || coverage.referencesValid || coverage.executionEnabled ||
      JSON.stringify(coverage.blockers) !== JSON.stringify(['ROW_COUNT_MISMATCH'])) {
    throw new Error('unexpected omission result');
  }
  process.stdout.write(`${JSON.stringify({
    scope: 'local-temporary-synthetic-reference-fixture',
    sqlConflictCheck: 'PASS', inMemoryPreservationVariant: 'PASS',
    independentSqlCountsOmissionCheck: 'PASS',
    executionEnabled: false, applicationDataChanged: false,
  })}\n`);
} catch {
  process.stderr.write('RESET_REFERENCE_FIXTURE_REJECTED\n');
  process.exitCode = 1;
}
