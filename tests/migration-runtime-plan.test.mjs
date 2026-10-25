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
const { createMigrationHistoryModel, createExpectedMigrationHistorySnapshot, migrationHistoryPolicyRows } = await import('../scripts/lib/migration-history-codec.mjs');
const h = number => number.toString(16).padStart(64, '0');
const sha = value => createHash('sha256').update(value).digest('hex');
function fixture(count = 3, mapped = false) {
  const files = Array.from({ length: count }, (_, i) => ({ path: `${i}.sql`, version: `20260101${String(i).padStart(6, '0')}`, name: `m${i}`, plan: i === 0 ? null : { sqlSha256: sha(`SELECT ${i};`), statementSha256s: [sha(`SELECT ${i}`)] } }));
  memory.bytes = new Map(files.map((file, i) => [file.path, Buffer.from(`SELECT ${i};`)]));
  memory.bundle = { files, totalCount: count, plannedCount: count - 1, bundleSha256: h(2) };
  const models = files.map(file => createMigrationHistoryModel({ version: file.version, name: file.name, sqlBytes: memory.bytes.get(file.path), sourceBinding: { bundle: memory.bundle, path: file.path } }));
  const mappings = mapped ? [{ sourceVersion: models[0].version, historyVersion: '20251231000000', name: models[0].name, sqlSha256: models[0].sqlSha256, statementsSha256: models[0].historyStatementsSha256 }] : [];
  const snapshots = models.map((_, i) => createExpectedMigrationHistorySnapshot({ models: models.slice(0, i + 1), mappings }));
  const source = { projectRef: 'aodikrxcczbogjpsjwjt', sourceRef: 'refs/heads/main', headSha1: 'a'.repeat(40), treeSha1: 'b'.repeat(40), manifestSha256: h(3), historySha256: snapshots[0].historySha256 }; memory.bundle.modelSource = source;
  const state = { coverageSha256: h(4), catalogSha256: h(5), dataSha256: h(6), sequencesSha256: h(7) };
  const pending = models.slice(1).map((model, i) => ({ version: model.version, name: model.name, sqlSha256: model.sqlSha256, statementsSha256: model.historyStatementsSha256, statementSha256s: files[i + 1].plan.statementSha256s, preHistorySha256: snapshots[i].historySha256, postHistorySha256: snapshots[i + 1].historySha256, preState: state, postState: state }));
  const baseline = migrationHistoryPolicyRows(snapshots[0]);
  return { requestInput: { repository: 'wrongstory/room-management-system-backend', ...(mapped ? { historySourceMappings: mappings } : {}), policy: { expectedSource: source, observedSource: source, expectedHistory: baseline, observedHistory: baseline, pending, observedPending: pending, budget: { overallMs: 10000, statementMs: 1000, lockMs: 200, idleTransactionMs: 1000 } }, remote: { repository: 'wrongstory/room-management-system-backend', ...source, mergedReleasePr: 500, application: 'PASS', migration: 'FULL_DB_PASS', independentReview: 'PASS' }, validationFingerprint: h(8), recoveryEvidenceSha256: h(9) }, bundleInput: {} };
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
});
