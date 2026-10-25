/** Bind the reviewed request to actual local Git objects before loading a DB credential. */
import { performance } from 'node:perf_hooks';
import { createExpectedMigrationHistorySnapshot, createHistoricalMigrationHistoryModel, createMigrationHistoryModel, migrationHistoryPolicyRows } from './migration-history-codec.mjs';
import { migrationReleaseConfiguration, prepareMigrationRelease } from './migration-release-preflight.mjs';
import { createMigrationSourceBundle, migrationHistorySourceBytes } from './migration-source-bundle.mjs';

const plans = new WeakMap();
export async function buildMigrationRuntimePlan(input) {
  try {
    const started = performance.now();
    const request = prepareMigrationRelease(input.requestInput);
    const bundle = await createMigrationSourceBundle(input.bundleInput);
    const configuration = migrationReleaseConfiguration(request);
    if (bundle.totalCount !== configuration.policy.expectedHistory.length + configuration.policy.pending.length
      || bundle.plannedCount !== configuration.policy.pending.length
      || !Object.keys(configuration.policy.expectedSource).every(key => bundle.modelSource[key] === configuration.policy.expectedSource[key])) throw new Error();
    const baselineCount = configuration.policy.expectedHistory.length;
    const mappings = configuration.historySourceMappings ?? [];
    const bySource = new Map(mappings.map(mapping => [mapping.sourceVersion, mapping]));
    const models = [];
    for (const [index, file] of bundle.files.entries()) {
      if (performance.now() - started >= 120000) throw new Error();
      const bytes = migrationHistorySourceBytes(bundle, file.path);
      try {
        const mapping = bySource.get(file.version);
        // All version/representation mappings belong to already-applied baseline rows.
        if (mapping && index >= baselineCount) throw new Error();
        const modelInput = { version: file.version, name: file.name, sqlBytes: bytes, sourceBinding: { bundle, path: file.path } };
        models.push(mapping?.representation ? createHistoricalMigrationHistoryModel({ ...modelInput,
          representation: mapping.representation, statementSha256: mapping.statementSha256 }) : createMigrationHistoryModel(modelInput));
      }
      finally { bytes.fill(0); }
    }
    let expected = createExpectedMigrationHistorySnapshot({ models: models.slice(0, baselineCount), mappings });
    if (expected.historySha256 !== configuration.policy.expectedSource.historySha256
      || JSON.stringify(migrationHistoryPolicyRows(expected)) !== JSON.stringify(configuration.policy.expectedHistory)) throw new Error();
    for (const [index, migration] of configuration.policy.pending.entries()) {
      const file = bundle.files[baselineCount + index]; const model = models[baselineCount + index];
      if (model.version !== migration.version || model.name !== migration.name || model.sqlSha256 !== migration.sqlSha256
        || model.historyStatementsSha256 !== migration.statementsSha256 || !file.plan
        || JSON.stringify(file.plan.statementSha256s) !== JSON.stringify(migration.statementSha256s)
        || migration.preHistorySha256 !== expected.historySha256) throw new Error();
      expected = createExpectedMigrationHistorySnapshot({ models: models.slice(0, baselineCount + index + 1), mappings });
      if (migration.postHistorySha256 !== expected.historySha256 || performance.now() - started >= 120000) throw new Error();
    }
    const result = Object.freeze({ request, bundleSha256: bundle.bundleSha256, sourceBound: true, pendingCount: request.pendingCount,
      expectedFinalHistorySha256: expected.historySha256, liveDatabaseObserved: false });
    plans.set(result, { request, bundle, historyModels: models });
    return result;
  } catch { throw new Error('MIGRATION_RUNTIME_PLAN_INVALID'); }
}
export function migrationRuntimeMaterial(plan) {
  const value = plans.get(plan); if (!value) throw new Error('MIGRATION_RUNTIME_PLAN_NOT_OWNED'); return value;
}
