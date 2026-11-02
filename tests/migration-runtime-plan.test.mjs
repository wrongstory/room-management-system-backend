import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => ({ bundle: null, bytes: new Map() }));
vi.mock('../scripts/lib/migration-source-bundle.mjs', () => ({
  createMigrationSourceBundle: async () => memory.bundle,
  isOwnedMigrationSourceBundle: value => value === memory.bundle,
  migrationHistorySourceBytes: (_bundle, path) => Buffer.from(memory.bytes.get(path)),
  bindMigrationHistorySource: ({ bundle, path, sqlBytes }) => {
    const file = bundle.files.find(item => item.path === path); if (!memory.bytes.get(path).equals(sqlBytes)) throw new Error();
    return { version: file.version, name: file.name, sqlSha256: file.plan?.sqlSha256, planStatementsSha256: file.plan?.statementsSha256 ?? null, parserEvidenceBound: file.plan !== null };
  },
}));
const { buildMigrationRuntimePlan, migrationRuntimeMaterial } = await import('../scripts/lib/migration-runtime-plan.mjs');
const { createMigrationHistoryModel, createHistoricalMigrationHistoryModel, createExpectedMigrationHistorySnapshot, migrationHistoryPolicyRows, migrationHistoryWriteMaterial } = await import('../scripts/lib/migration-history-codec.mjs');
const { prepareMigrationRelease } = await import('../scripts/lib/migration-release-preflight.mjs');
const h = number => number.toString(16).padStart(64, '0');
const sha = value => createHash('sha256').update(value).digest('hex');
function fixture(count = 3, mapped = false, representation = null) {
  const files = Array.from({ length: count }, (_, i) => ({ path: `${i}.sql`, version: `20260101${String(i).padStart(6, '0')}`, name: `m${i}`, plan: i === 0 ? null : { sqlSha256: sha(`SELECT ${i};`), statementSha256s: [sha(`SELECT ${i}`)] } }));
  memory.bytes = new Map(files.map((file, i) => [file.path, Buffer.from(`SELECT ${i};`)]));
  const historicalSql = '-- historical\nSELECT 0;\nSELECT 10;\n';
  if (representation) memory.bytes.set('0.sql', Buffer.from(historicalSql));
  memory.bundle = { files, totalCount: count, plannedCount: count - 1, bundleSha256: h(2) };
  const stored = representation === 'SOURCE_EXACT' ? historicalSql : representation === 'SOURCE_APPEND_CRLF'
    ? historicalSql + '\r\n' : historicalSql.replaceAll('\n', '\r\n') + '\r\n';
  const models = files.map((file, index) => {
    const input = { version: file.version, name: file.name, sqlBytes: memory.bytes.get(file.path), sourceBinding: { bundle: memory.bundle, path: file.path } };
    return representation && index === 0 ? createHistoricalMigrationHistoryModel({ ...input, representation, statementSha256: sha(stored) }) : createMigrationHistoryModel(input);
  });
  const mappings = mapped || representation ? [{ sourceVersion: models[0].version, historyVersion: mapped ? '20251231000000' : models[0].version, name: models[0].name, sqlSha256: models[0].sqlSha256, statementsSha256: models[0].historyStatementsSha256,
    ...(representation ? { representation, statementSha256: sha(stored) } : {}) }] : [];
  const snapshots = models.map((_, i) => createExpectedMigrationHistorySnapshot({ models: models.slice(0, i + 1), mappings }));
  const source = { projectRef: 'aodikrxcczbogjpsjwjt', sourceRef: 'refs/heads/main', headSha1: 'a'.repeat(40), treeSha1: 'b'.repeat(40), manifestSha256: h(3), historySha256: snapshots[0].historySha256 }; memory.bundle.modelSource = source;
  const state = { coverageSha256: h(4), catalogSha256: h(5), dataSha256: h(6), sequencesSha256: h(7) };
  const pending = models.slice(1).map((model, i) => ({ version: model.version, name: model.name, sqlSha256: model.sqlSha256, statementsSha256: model.historyStatementsSha256, statementSha256s: files[i + 1].plan.statementSha256s, preHistorySha256: snapshots[i].historySha256, postHistorySha256: snapshots[i + 1].historySha256, preState: state, postState: state }));
  const baseline = migrationHistoryPolicyRows(snapshots[0]);
  return { requestInput: { repository: 'wrongstory/room-management-system-backend', ...(mappings.length ? { historySourceMappings: mappings } : {}), policy: { expectedSource: source, observedSource: source, expectedHistory: baseline, observedHistory: baseline, pending, observedPending: pending, budget: { overallMs: 10000, statementMs: 1000, lockMs: 200, idleTransactionMs: 1000 } }, remote: { repository: 'wrongstory/room-management-system-backend', ...source, mergedReleasePr: 500, application: 'PASS', migration: 'FULL_DB_PASS', independentReview: 'PASS' }, validationFingerprint: h(8), recoveryEvidenceSha256: h(9) }, bundleInput: {} };
}
beforeEach(() => { memory.bundle = null; memory.bytes = new Map(); });
describe('#378 runtime composition with Git replaced, actual history codec and policy binding', () => {
  it.each([2, 3, 7])('binds every historical/pending row without a fixed migration tail (%i files)', async count => {
    const value = fixture(count); const result = await buildMigrationRuntimePlan(value);
    expect(result).toMatchObject({ pendingCount: count - 1, sourceBound: true, liveDatabaseObserved: false });
    expect(migrationRuntimeMaterial(result).historyModels).toHaveLength(count);
    expect(JSON.stringify(result)).not.toContain('SELECT');
    expect(() => migrationRuntimeMaterial(structuredClone(result))).toThrow('MIGRATION_RUNTIME_PLAN_NOT_OWNED');
  });
  it.each([
    () => { memory.bundle.totalCount += 1; }, () => { memory.bundle.plannedCount -= 1; },
    () => { memory.bundle.modelSource = { ...memory.bundle.modelSource, treeSha1: 'f'.repeat(40) }; },
    () => { memory.bytes.set('1.sql', Buffer.from('SELECT 999;')); },
    () => { memory.bundle.files[1].plan = null; },
    () => { memory.bundle.files[1].plan.statementSha256s = [h(99)]; },
  ])('rejects missing/stale/wrong source evidence %#', async change => { const value = fixture(); change(); await expect(buildMigrationRuntimePlan(value)).rejects.toThrow('MIGRATION_RUNTIME_PLAN_INVALID'); });
  it('does not accept a consistent caller claim for a different baseline history', async () => {
    const value = fixture(); const changed = [{ ...value.requestInput.policy.expectedHistory[0], statementsSha256: h(99) }];
    value.requestInput.policy.expectedHistory = changed; value.requestInput.policy.observedHistory = changed;
    await expect(buildMigrationRuntimePlan(value)).rejects.toThrow('MIGRATION_RUNTIME_PLAN_INVALID');
  });
  it('binds a reviewed source/history version mapping without changing SQL/name/statements', async () => {
    const value = fixture(3, true); const result = await buildMigrationRuntimePlan(value);
    expect(result).toMatchObject({ pendingCount: 2, sourceBound: true });
    expect(migrationRuntimeMaterial(result).historyModels[0].version).toBe('20260101000000');
    const without = fixture(3, true); delete without.requestInput.historySourceMappings;
    await expect(buildMigrationRuntimePlan(without)).rejects.toThrow('MIGRATION_RUNTIME_PLAN_INVALID');
  });
  it.each(['sqlSha256', 'statementsSha256', 'name', 'sourceVersion', 'historyVersion'])('rejects a mapping with a wrong %s', async key => {
    const value = fixture(3, true); value.requestInput.historySourceMappings[0][key] = key.endsWith('Version') ? '20250101000000' : key.endsWith('Sha256') ? h(99) : 'other';
    await expect(buildMigrationRuntimePlan(value)).rejects.toThrow('MIGRATION_RUNTIME_PLAN_INVALID');
  });
  it('rejects duplicated and extra source mappings', async () => {
    const value = fixture(3, true); value.requestInput.historySourceMappings.push({ ...value.requestInput.historySourceMappings[0] });
    await expect(buildMigrationRuntimePlan(value)).rejects.toThrow('MIGRATION_RUNTIME_PLAN_INVALID');
  });
  it.each(['SOURCE_EXACT', 'SOURCE_APPEND_CRLF', 'LF_TO_CRLF_APPEND_CRLF'])('composes %s baseline with unchanged pinned-CLI pending write material', async representation => {
    for (const mapped of [false, true]) {
      const value = fixture(3, mapped, representation);
      const result = await buildMigrationRuntimePlan(value);
      const material = migrationRuntimeMaterial(result);
      expect(material.historyModels[0].mode).toBe('HISTORICAL_WHOLE_FILE_SOURCE_MODEL');
      expect(() => migrationHistoryWriteMaterial(material.historyModels[0])).toThrow('HISTORY_CODEC_EXECUTION_MODEL_REQUIRED');
      expect(migrationHistoryWriteMaterial(material.historyModels[1])).toEqual({ version: '20260101000001', name: 'm1', statements: ['SELECT 1'] });
      expect(result).toMatchObject({ pendingCount: 2, liveDatabaseObserved: false });
      expect(JSON.stringify(result)).not.toContain('historical');
    }
  });
  it.each(['representation', 'statementSha256', 'sqlSha256', 'statementsSha256', 'sourceVersion', 'historyVersion', 'name'])('rejects an altered whole-file mapping %s', async key => {
    const value = fixture(3, true, 'SOURCE_EXACT');
    const oldRequest = prepareMigrationRelease(value.requestInput);
    value.requestInput.historySourceMappings[0][key] = key === 'representation' ? 'SOURCE_APPEND_CRLF' : key.endsWith('Sha256') ? h(99) : key.endsWith('Version') ? '20250101000000' : 'other';
    await expect(buildMigrationRuntimePlan(value)).rejects.toThrow('MIGRATION_RUNTIME_PLAN_INVALID');
    if (['representation', 'statementSha256', 'sqlSha256', 'sourceVersion'].includes(key)) {
      expect(prepareMigrationRelease(value.requestInput).requestSha256).not.toBe(oldRequest.requestSha256);
    }
  });
  it('rejects missing representations, unsupported transforms and unknown caller SQL before credentials', async () => {
    for (const change of [
      value => { delete value.requestInput.historySourceMappings; },
      value => { delete value.requestInput.historySourceMappings[0].representation; },
      value => { delete value.requestInput.historySourceMappings[0].statementSha256; },
      value => { value.requestInput.historySourceMappings[0].representation = 'TRIM'; },
      value => { value.requestInput.historySourceMappings[0].sql = 'SELECT 999;'; },
      value => { value.requestInput.historySourceMappings[0].sourceVersion = '20260101000001'; },
    ]) {
      const value = fixture(3, true, 'SOURCE_EXACT'); change(value);
      await expect(buildMigrationRuntimePlan(value)).rejects.toThrow('MIGRATION_RUNTIME_PLAN_INVALID');
    }
  });
});
