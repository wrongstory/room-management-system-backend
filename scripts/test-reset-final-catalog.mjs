/** #396: actual disposable schema + explicitly synthetic opaque FK rows.
 * No business-row reads, mutations, new reset, production connector or permit.
 * Run only inside the approved final Full DB job. Importing performs no DB/process I/O. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { fingerprint } from './db-validation-gate.mjs';
import { validateBaselineCheckpointEnvironment, validateBaselineCheckpointGate } from './test-migration-baseline-checkpoint.mjs';
import { readLocalResetValidationCatalog } from './read-reset-catalog.mjs';
import { validateResetCatalog } from './reset-catalog-contract.mjs';
import { RESET_ROW_RULE_FINGERPRINT } from './reset-row-policy.mjs';
import { createResetReadPlan } from '../src/modules/developer-reset/snapshot-read-plan.ts';
import { inspectResetProtectionPlan } from '../src/modules/developer-reset/reset-protection-plan.ts';
import { resetRelationGroups } from '../src/modules/developer-reset/reset-preview-groups.ts';

const sha = value => createHash('sha256').update(value).digest('hex');
const root = fileURLToPath(new URL('..', import.meta.url));
export const DEFERRED_RESET_RELATION = 'private.room_fixed_memo_revisions';
const phases = new Set(['INPUT', 'CATALOG_STRUCTURE', 'DEFERRED_STRUCTURE', 'FULL_CATALOG_BLOCK',
  'REVIEWED_PLAN', 'PHOTO_HOLD', 'NEGATIVE_FIXTURES', 'ENVIRONMENT', 'CHECKPOINT', 'CATALOG_READ', 'SOURCE_RECHECK']);
class FinalCatalogError extends Error {
  constructor(phase) { super('RESET_FINAL_CATALOG_REJECTED'); this.phase = phase; }
}
const reject = phase => { throw new FinalCatalogError(phase); };
export const formatFinalResetCatalogFailure = error =>
  `RESET_FINAL_CATALOG_REJECTED [${error instanceof FinalCatalogError && phases.has(error.phase) ? error.phase : 'UNKNOWN'}]`;

// A known, explicitly deferred policy is not permission to classify or delete its
// rows. Validate only the structural metadata catalog-v2 actually supplies.
function assertDeferredStructure(catalog) {
  const table = catalog.relations.find(row => row.name === DEFERRED_RESET_RELATION);
  assert.deepEqual(table, { name: DEFERRED_RESET_RELATION, kind: 'r', rls: true, forceRls: false,
    columns: [['room_id', 'uuid', false], ['revision', 'int8', false], ['memo', 'text', true],
      ['actor_profile_id', 'uuid', false], ['recorded_at', 'timestamptz', false]]
      .map(([name, type, nullable], i) => ({ name, position: i + 1, type: `pg_catalog.${type}`, nullable })),
    keys: [{ name: 'room_fixed_memo_revisions_pkey', columns: ['room_id', 'revision'], primary: true,
      valid: true, immediate: true, partial: false, expressions: false }] });
  assert.equal(catalog.foreignKeys.filter(fk => fk.target === DEFERRED_RESET_RELATION).length, 0);
  const outgoing = catalog.foreignKeys.filter(fk => fk.source === DEFERRED_RESET_RELATION);
  assert.equal(outgoing.length, 2);
  for (const [column, target, targetKey] of [['room_id', 'public.rooms', 'rooms_pkey'],
    ['actor_profile_id', 'public.profiles', 'profiles_pkey']]) {
    const fk = outgoing.find(row => row.name === `room_fixed_memo_revisions_${column}_fkey`);
    assert(fk);
    const { definition: _definition, ...structure } = fk;
    assert.deepEqual(structure, { source: DEFERRED_RESET_RELATION, target,
      name: `room_fixed_memo_revisions_${column}_fkey`, sourceColumns: [column], targetColumns: ['id'], targetKey,
      match: 's', onDelete: 'r', onUpdate: 'a', validated: true, deferrable: false, initiallyDeferred: false });
  }
  const triggers = catalog.triggers.filter(trigger => trigger.relation === DEFERRED_RESET_RELATION);
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0].name, 'room_fixed_memo_immutable');
  assert.equal(triggers[0].enabled, 'O');
  // Digests are bound by catalogFingerprint. Their syntax is already validated;
  // unknown digest values do not prove function body or trigger semantics.
  for (const field of ['definitionHash', 'functionHash']) assert(/^[a-f0-9]{32}$/u.test(triggers[0][field]));
}

function syntheticFixture(catalog, binding) {
  const relations = [...catalog.relations, ...catalog.boundaryRelations].map(table => table.name);
  const token = name => sha(`final-catalog-synthetic-row:${name}`);
  const rows = relations.map(relation => ({ relation, key: token(relation), disposition: 'remove',
    references: catalog.foreignKeys.filter(fk => fk.source === relation)
      .map(fk => ({ constraint: fk.name, targetKey: token(fk.target) })) }));
  const fullBinding = { ...binding, contentFingerprint: sha('synthetic-content'), snapshotId: sha('synthetic-snapshot') };
  return { binding: fullBinding,
    selection: { binding: { ...fullBinding }, templateSelection: 'CURRENT_PUBLISHED',
      requestFingerprint: sha('synthetic-request'), reviewPlanFingerprint: null },
    referenceCapture: { catalogFingerprint: binding.catalogFingerprint, snapshotCatalogFingerprint: binding.catalogFingerprint,
      complete: true, relations, relationRowCounts: relations.map(relation => ({ relation, count: 1 })),
      foreignKeys: catalog.foreignKeys.map(({ source, target, name }) => ({ source, target, name })), rows } };
}

/** Pure exercise. Supplying a catalog is NOT proof that it came from a DB.
 * Graph rows are invented opaque identities, not inserted/collected SQL rows.
 * Existing builder, codecs, logical references and live RPC tests remain separate. */
export function inspectFinalResetCatalog(input, sourceCommit) {
  let phase = 'INPUT';
  try {
    assert(/^[a-f0-9]{40}$/u.test(sourceCommit));
    phase = 'CATALOG_STRUCTURE';
    const { catalog: fullCatalog, catalogFingerprint } = validateResetCatalog(input);
    const fullRelations = [...fullCatalog.relations, ...fullCatalog.boundaryRelations].map(table => table.name);
    const reviewedNames = [...Object.values(resetRelationGroups).flat(), 'auth.users'].sort();
    const deferred = fullCatalog.relations.some(table => table.name === DEFERRED_RESET_RELATION);
    assert.deepEqual([...fullRelations].sort(), [...reviewedNames, ...(deferred ? [DEFERRED_RESET_RELATION] : [])].sort());
    const fullBinding = { projectRef: 'a'.repeat(20), sourceCommit, catalogFingerprint,
      classificationFingerprint: RESET_ROW_RULE_FINGERPRINT };
    if (deferred) {
      phase = 'DEFERRED_STRUCTURE';
      assertDeferredStructure(fullCatalog);
      phase = 'FULL_CATALOG_BLOCK';
      assert.throws(() => createResetReadPlan(fullCatalog, fullBinding), /^Error: RESET_READ_PLAN_REJECTED$/u);
      const blocked = inspectResetProtectionPlan(syntheticFixture(fullCatalog, fullBinding));
      assert.equal(blocked.manifestPrepared, false);
      assert.deepEqual(blocked.blockers, ['RESET_PROTECTION_RELATION_COVERAGE_INCOMPLETE']);
      assert.equal(blocked.executionEnabled, false);
      assert.equal(blocked.completeResetCoverage, false);
    }

    // The full source catalog remains bound above and MUST remain blocked for
    // #551. This separately bound projection exercises only previously reviewed
    // relations, never pretends that the deferred ledger was compiled or cleared.
    phase = 'REVIEWED_PLAN';
    const { catalog, catalogFingerprint: reviewedCatalogFingerprint } = validateResetCatalog({ ...fullCatalog,
      relations: fullCatalog.relations.filter(table => table.name !== DEFERRED_RESET_RELATION),
      foreignKeys: fullCatalog.foreignKeys.filter(fk => fk.source !== DEFERRED_RESET_RELATION),
      triggers: fullCatalog.triggers.filter(trigger => trigger.relation !== DEFERRED_RESET_RELATION) });
    assert.equal(catalogFingerprint === reviewedCatalogFingerprint, !deferred);
    const binding = { projectRef: 'a'.repeat(20), sourceCommit, catalogFingerprint: reviewedCatalogFingerprint,
      classificationFingerprint: RESET_ROW_RULE_FINGERPRINT };
    const plan = createResetReadPlan(catalog, binding);
    const relations = [...catalog.relations, ...catalog.boundaryRelations].map(table => table.name);
    assert.deepEqual([...relations].sort(), [...Object.values(resetRelationGroups).flat(), 'auth.users'].sort());
    assert.equal(plan.statements.length, relations.length);
    assert.deepEqual(plan.expected.relations.find(table => table.relation === 'auth.users').columns,
      [{ name: 'id', pgType: 'pg_catalog.uuid' }]);

    // One invented row per inventoried relation; all inventoried FK edges point
    // to that relation's invented row. This stresses cycles/shared/composite FK
    // identity coverage without claiming valid SQL values or an actual row census.
    const fixture = syntheticFixture(catalog, binding);

    // Require the *installed* FK graph to connect photo evidence through the
    // attempt/actor to Auth. Inventing a 4-table stand-in must no longer suffice.
    phase = 'PHOTO_HOLD';
    const reachable = new Set(['private.attempt_photo_versions']);
    for (const relation of reachable) for (const fk of catalog.foreignKeys.filter(fk => fk.source === relation)) reachable.add(fk.target);
    for (const relation of ['public.cleaning_attempts', 'public.profiles', 'auth.users']) assert(reachable.has(relation));
    const protectedResult = inspectResetProtectionPlan(fixture);
    assert.equal(protectedResult.manifestPrepared, true);
    assert(protectedResult.blockers.includes('RESET_PROTECTION_PRESERVATION_CONFLICT'));
    assert.equal(protectedResult.selectionBinding, 'CAPTURE_INTENT_ONLY');
    for (const relation of ['private.attempt_photo_versions', 'public.cleaning_attempts', 'public.profiles', 'auth.users']) {
      const counts = protectedResult.relations.find(row => row.relation === relation);
      assert.equal(counts.requiredByPreservation, 1);
      assert.equal(counts.preservationConflicts, 1);
    }
    for (const flag of ['executionEnabled', 'executionGranted', 'liveDatabaseVerified', 'completeResetCoverage',
      'backupVerified', 'restoreVerified', 'reservationBackupAcceptedAsResetProof']) assert.equal(protectedResult[flag], false);
    assert(protectedResult.domains.every(domain => domain.backup === 'NOT_OBSERVED' && domain.restore === 'NOT_OBSERVED'));

    phase = 'NEGATIVE_FIXTURES';
    const empty = structuredClone(fixture);
    empty.referenceCapture.rows = [];
    empty.referenceCapture.relationRowCounts.forEach(row => { row.count = 0; });
    const emptyResult = inspectResetProtectionPlan(empty);
    assert.equal(emptyResult.manifestPrepared, true);
    assert.equal(emptyResult.backupVerified, false);
    assert.equal(emptyResult.restoreVerified, false);

    const missing = structuredClone(fixture); missing.referenceCapture.relations.pop();
    assert.equal(inspectResetProtectionPlan(missing).manifestPrepared, false);
    const mixed = structuredClone(fixture); mixed.selection.binding.snapshotId = sha('different-snapshot');
    assert.equal(inspectResetProtectionPlan(mixed).manifestPrepared, false);
    const edge = structuredClone(fixture);
    edge.referenceCapture.rows.find(row => row.references.length).references.pop();
    assert.equal(inspectResetProtectionPlan(edge).manifestPrepared, false);
    const parent = structuredClone(fixture);
    parent.referenceCapture.rows = parent.referenceCapture.rows.filter(row => row.relation !== 'auth.users');
    parent.referenceCapture.relationRowCounts.find(row => row.relation === 'auth.users').count = 0;
    assert.equal(inspectResetProtectionPlan(parent).manifestPrepared, false);
    return { format: 'reset-final-catalog-exercise-v1', sourceCommit, catalogFingerprint,
      relationCount: fullRelations.length, foreignKeyCount: fullCatalog.foreignKeys.length,
      reviewedCatalogFingerprint, reviewedRelationCount: relations.length, reviewedForeignKeyCount: catalog.foreignKeys.length,
      deferredRelationCount: Number(deferred), compiledScope: 'REVIEWED_RESET_RELATIONS_ONLY',
      fullCatalogReadPlan: deferred ? 'BLOCKED_UNCLASSIFIED_551' : 'COMPILED_NOT_EXECUTED',
      fullCatalogProtectionPlan: deferred ? 'BLOCKED_RELATION_COVERAGE' : 'SYNTHETIC_ONLY',
      triggerSemantics: 'NOT_PROVEN_BY_CATALOG',
      compiledStatements: plan.statements.length, compiledPlanSha256: sha(JSON.stringify(plan)), cases: 6,
      rows: 'SYNTHETIC_ONLY', liveCatalogObserved: false, sqlReadPlanExecuted: false,
      liveDatabaseVerified: false, completeResetCoverage: false, executionEnabled: false,
      backupVerified: false, restoreVerified: false };
  } catch { return reject(phase); }
}

export function runFinalResetCatalog({ env = process.env, args = process.argv.slice(2), platform = process.platform,
  read = readFileSync, list = readdirSync, execute = execFileSync, readCatalog = readLocalResetValidationCatalog } = {}) {
  let phase = 'ENVIRONMENT';
  try {
    assert(args.length === 0 && platform === 'linux');
    validateBaselineCheckpointEnvironment(env, list(root), list(join(root, 'supabase')));
    const git = (...argv) => execute('git', argv, { cwd: root, env, encoding: 'utf8', timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024, shell: false, windowsHide: true });
    const head = git('rev-parse', 'HEAD').trim(), tree = git('ls-tree', '-r', '-z', 'HEAD');
    const gate = validateBaselineCheckpointGate({ env, event: JSON.parse(read(env.GITHUB_EVENT_PATH, 'utf8')),
      head, inputFingerprint: fingerprint(tree) });
    assert(git('diff', '--name-only', 'HEAD').trim() === '');
    phase = 'CHECKPOINT';
    const baseline = JSON.parse(read(join(root, '.tmp/baseline122-oracle.json'), 'utf8'));
    assert(baseline.format === 'baseline122-local-oracle-v1' && baseline.head === head &&
      baseline.inputFingerprint === gate.inputFingerprint && baseline.runId === gate.runId &&
      baseline.runAttempt === gate.runAttempt && baseline.exactFinalHistoryIdentitiesObserved === true);
    phase = 'CATALOG_READ';
    const result = inspectFinalResetCatalog(readCatalog({ env, args: [] }), head);
    phase = 'CATALOG_STRUCTURE';
    // This final source includes #551. The pure historical reviewed-only fixture
    // remains testable, but cannot stand in for the installed current source.
    assert.equal(result.deferredRelationCount, 1);
    phase = 'SOURCE_RECHECK';
    assert(git('rev-parse', 'HEAD').trim() === head && git('diff', '--name-only', 'HEAD').trim() === '');
    return { ...result, liveCatalogObserved: true, inputFingerprint: gate.inputFingerprint,
      runId: gate.runId, runAttempt: gate.runAttempt, executionApprovalVerified: false };
  } catch (error) {
    if (error instanceof FinalCatalogError) throw error;
    return reject(phase);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(runFinalResetCatalog())); }
  catch (error) { console.error(formatFinalResetCatalogFailure(error)); process.exitCode = 1; }
}
