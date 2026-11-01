import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { DEFERRED_RESET_RELATION, formatFinalResetCatalogFailure, inspectFinalResetCatalog, runFinalResetCatalog } from '../scripts/test-reset-final-catalog.mjs';
import { fingerprint } from '../scripts/db-validation-gate.mjs';
import { RESET_RELATION_NAMES } from '../scripts/reset-relation-classification.mjs';
import { RESET_ROW_RULE_FINGERPRINT, resetRowDispositionExpression } from '../scripts/reset-row-policy.mjs';
import { validateResetCatalog } from '../scripts/reset-catalog-contract.mjs';
import { createResetReadPlan } from '../src/modules/developer-reset/snapshot-read-plan.ts';

// Explicitly synthetic metadata; never presented as an installed schema.
function catalog() {
  const table = name => {
    const fields = new Set(['id', ...[...resetRowDispositionExpression(name, 'r').matchAll(/\br\.([a-z_][a-z0-9_]*)/g)].map(match => match[1])]);
    if (name === 'public.profiles') { fields.add('auth_user_id'); fields.add('role'); }
    return { name, kind: 'r', rls: true, forceRls: false,
      columns: [...fields].map((field, i) => ({ name: field, position: i + 1, type: 'pg_catalog.uuid', nullable: false })),
      keys: [{ name: `${name.split('.')[1]}_pkey`, columns: ['id'], primary: true, valid: true,
        immediate: true, partial: false, expressions: false }] };
  };
  const relations = RESET_RELATION_NAMES.map(table), boundaryRelations = [table('auth.users')];
  const foreignKeys = [
    ['private.attempt_photo_versions', 'public.cleaning_attempts'],
    ['public.cleaning_attempts', 'public.profiles'], ['public.profiles', 'auth.users'],
  ].map(([source, target], i) => ({ source, target, name: `synthetic_fk_${i}`, definition: 'synthetic fixture only',
    sourceColumns: ['id'], targetColumns: ['id'], targetKey: `${target.split('.')[1]}_pkey`,
    match: 's', onDelete: 'a', onUpdate: 'a', validated: true, deferrable: false, initiallyDeferred: false }));
  return { format: 'reset-catalog-v2', readOnly: true, relations, boundaryRelations, foreignKeys, triggers: [] };
}
function currentCatalog() {
  const c = catalog();
  c.relations.push({ name: 'private.room_fixed_memo_revisions', kind: 'r', rls: true, forceRls: false,
    columns: [
      { name: 'room_id', position: 1, type: 'pg_catalog.uuid', nullable: false },
      { name: 'revision', position: 2, type: 'pg_catalog.int8', nullable: false },
      { name: 'memo', position: 3, type: 'pg_catalog.text', nullable: true },
      { name: 'actor_profile_id', position: 4, type: 'pg_catalog.uuid', nullable: false },
      { name: 'recorded_at', position: 5, type: 'pg_catalog.timestamptz', nullable: false },
    ],
    keys: [{ name: 'room_fixed_memo_revisions_pkey', columns: ['room_id', 'revision'], primary: true,
      valid: true, immediate: true, partial: false, expressions: false }] });
  c.foreignKeys.push(...[['room_id', 'public.rooms'], ['actor_profile_id', 'public.profiles']].map(([column, target]) => ({
    source: 'private.room_fixed_memo_revisions', target, name: `room_fixed_memo_revisions_${column}_fkey`,
    definition: `FOREIGN KEY (${column}) REFERENCES ${target}(id) ON DELETE RESTRICT`, sourceColumns: [column],
    targetColumns: ['id'], targetKey: `${target.split('.')[1]}_pkey`, match: 's', onDelete: 'r', onUpdate: 'a',
    validated: true, deferrable: false, initiallyDeferred: false,
  })));
  c.triggers.push({ relation: 'private.room_fixed_memo_revisions', name: 'room_fixed_memo_immutable', enabled: 'O',
    definitionHash: 'a'.repeat(32), functionHash: 'b'.repeat(32) });
  return c;
}
const head = 'a'.repeat(40);
function runner() {
  const tree = `100644 blob ${'b'.repeat(40)}\tpackage.json\0`, repository = 'wrongstory/room-management-system-backend';
  const env = { GITHUB_ACTIONS: 'true', GITHUB_WORKFLOW: 'quality', RMS_FINAL_DB_GATE_MODE: 'full',
    GITHUB_REPOSITORY: repository, GITHUB_SHA: head, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1',
    GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: 'synthetic-event.json', RMS_FINAL_DB_INPUT_SHA256: fingerprint(tree) };
  const event = { pull_request: { base: { ref: 'main', repo: { full_name: repository } },
    head: { ref: 'release/v1.0.0', repo: { full_name: repository } } } };
  const baseline = { format: 'baseline122-local-oracle-v1', head, inputFingerprint: fingerprint(tree),
    runId: '123', runAttempt: '1', exactFinalHistoryIdentitiesObserved: true };
  const readCatalog = vi.fn(() => currentCatalog()), execute = vi.fn((_program, args) => args[0] === 'rev-parse' ? head : args[0] === 'ls-tree' ? tree : '');
  const read = vi.fn(path => JSON.stringify(path === env.GITHUB_EVENT_PATH ? event : baseline));
  return { env, event, baseline, deps: { env, args: [], platform: 'linux', read, list: () => [], execute, readCatalog } };
}
describe('#396 final installed-catalog harness, DB-free unit tests', () => {
  it('compiles the complete relation inventory and exercises HOLD without granting execution or backup proof', () => {
    const result = inspectFinalResetCatalog(catalog(), head);
    expect(result).toMatchObject({ relationCount: RESET_RELATION_NAMES.length + 1, foreignKeyCount: 3,
      compiledStatements: RESET_RELATION_NAMES.length + 1, cases: 6, rows: 'SYNTHETIC_ONLY', liveCatalogObserved: false,
      sqlReadPlanExecuted: false, liveDatabaseVerified: false, completeResetCoverage: false, executionEnabled: false,
      backupVerified: false, restoreVerified: false });
    expect(JSON.stringify(result)).not.toContain('synthetic_fk');
  });
  it.each(['missing-relation', 'unknown-relation', 'missing-photo-path', 'unsafe-key', 'unvalidated-fk'])
    ('rejects unsupported or incomplete %s instead of a partial PASS', kind => {
      const c = catalog();
      if (kind === 'missing-relation') c.relations = c.relations.filter(row => row.name !== 'public.rooms');
      if (kind === 'unknown-relation') { const row = structuredClone(c.relations[0]); row.name = 'private.unreviewed'; c.relations.push(row); }
      if (kind === 'missing-photo-path') c.foreignKeys.shift();
      if (kind === 'unsafe-key') c.relations[0].keys[0].partial = true;
      if (kind === 'unvalidated-fk') c.foreignKeys[0].validated = false;
      expect(() => inspectFinalResetCatalog(c, head)).toThrow(/^RESET_FINAL_CATALOG_REJECTED$/);
    });
  it('projects only Auth id from richer metadata without executing the generated reads', () => {
    const c = catalog();
    c.boundaryRelations[0].columns.push({ name: 'synthetic_secret', position: 2, type: 'pg_catalog.text', nullable: true });
    expect(inspectFinalResetCatalog(c, head).sqlReadPlanExecuted).toBe(false);
  });
  it('preserves full-catalog rejection for #551 and binds the reviewed HOLD exercise separately', () => {
    const c = currentCatalog(), validated = validateResetCatalog(c);
    expect(resetRowDispositionExpression(DEFERRED_RESET_RELATION, 'r')).toBeNull();
    expect(() => createResetReadPlan(c, { projectRef: 'a'.repeat(20), sourceCommit: head,
      catalogFingerprint: validated.catalogFingerprint, classificationFingerprint: RESET_ROW_RULE_FINGERPRINT }))
      .toThrow(/^RESET_READ_PLAN_REJECTED$/);
    const result = inspectFinalResetCatalog(c, head), prior = inspectFinalResetCatalog(catalog(), head);
    expect(result).toMatchObject({ catalogFingerprint: validated.catalogFingerprint,
      relationCount: RESET_RELATION_NAMES.length + 2, foreignKeyCount: 5,
      reviewedRelationCount: RESET_RELATION_NAMES.length + 1, reviewedForeignKeyCount: 3,
      deferredRelationCount: 1, compiledStatements: RESET_RELATION_NAMES.length + 1,
      compiledScope: 'REVIEWED_RESET_RELATIONS_ONLY', fullCatalogReadPlan: 'BLOCKED_UNCLASSIFIED_551',
      fullCatalogProtectionPlan: 'BLOCKED_RELATION_COVERAGE', triggerSemantics: 'NOT_PROVEN_BY_CATALOG',
      cases: 6, sqlReadPlanExecuted: false, executionEnabled: false, completeResetCoverage: false,
      liveDatabaseVerified: false, backupVerified: false, restoreVerified: false });
    expect(result.reviewedCatalogFingerprint).toBe(prior.catalogFingerprint);
    expect(result.catalogFingerprint).not.toBe(result.reviewedCatalogFingerprint);
    expect(result.compiledPlanSha256).toBe(prior.compiledPlanSha256);
    expect(JSON.stringify(result)).not.toContain('room_fixed_memo');
  });
  it('binds observed trigger digests without pretending that opaque digests prove immutability', () => {
    const c = currentCatalog(), before = inspectFinalResetCatalog(c, head);
    c.triggers[0].functionHash = 'c'.repeat(32);
    const after = inspectFinalResetCatalog(c, head);
    expect(after.catalogFingerprint).not.toBe(before.catalogFingerprint);
    expect(after.reviewedCatalogFingerprint).toBe(before.reviewedCatalogFingerprint);
    expect(after.triggerSemantics).toBe('NOT_PROVEN_BY_CATALOG');
  });
  it.each(['columns', 'type', 'nullability', 'pk-order', 'pk-name', 'rls', 'force-rls', 'extra-key',
    'missing-fk', 'fk-action', 'fk-target', 'fk-column', 'fk-deferrable', 'missing-trigger', 'extra-trigger',
    'disabled-trigger', 'renamed-trigger', 'invalid-digest', 'inbound-fk', 'unknown-relation', 'missing-reviewed-relation',
    'photo-path', 'reviewed-key', 'reviewed-fk'])('still rejects #551 or reviewed-scope drift: %s', kind => {
    const c = currentCatalog(), memo = c.relations.find(row => row.name === DEFERRED_RESET_RELATION);
    const fk = c.foreignKeys.find(row => row.source === DEFERRED_RESET_RELATION);
    if (kind === 'columns') memo.columns.push({ name: 'extra', position: 6, type: 'pg_catalog.text', nullable: true });
    if (kind === 'type') memo.columns[1].type = 'pg_catalog.int4';
    if (kind === 'nullability') memo.columns[2].nullable = false;
    if (kind === 'pk-order') memo.keys[0].columns.reverse();
    if (kind === 'pk-name') memo.keys[0].name = 'unreviewed_pkey';
    if (kind === 'rls') memo.rls = false;
    if (kind === 'force-rls') memo.forceRls = true;
    if (kind === 'extra-key') memo.keys.push({ ...memo.keys[0], name: 'extra_key', primary: false });
    if (kind === 'missing-fk') c.foreignKeys.pop();
    if (kind === 'fk-action') fk.onDelete = 'c';
    if (kind === 'fk-target') { fk.target = 'public.profiles'; fk.targetKey = 'profiles_pkey'; }
    if (kind === 'fk-column') fk.sourceColumns = ['actor_profile_id'];
    if (kind === 'fk-deferrable') fk.deferrable = true;
    if (kind === 'missing-trigger') c.triggers = [];
    if (kind === 'extra-trigger') c.triggers.push({ ...c.triggers[0], name: 'unreviewed_trigger' });
    if (kind === 'disabled-trigger') c.triggers[0].enabled = 'D';
    if (kind === 'renamed-trigger') c.triggers[0].name = 'different_guard';
    if (kind === 'invalid-digest') c.triggers[0].functionHash = 'not-a-digest';
    if (kind === 'inbound-fk') {
      c.relations.find(row => row.name === 'public.rooms').columns.push({ name: 'memo_revision', position: 2,
        type: 'pg_catalog.int8', nullable: true });
      c.foreignKeys.push({ ...fk, source: 'public.rooms', target: DEFERRED_RESET_RELATION,
        name: 'unexpected_memo_fk', sourceColumns: ['id', 'memo_revision'], targetColumns: ['room_id', 'revision'],
        targetKey: 'room_fixed_memo_revisions_pkey' });
      expect(() => validateResetCatalog(c)).not.toThrow();
    }
    if (kind === 'unknown-relation') { const row = structuredClone(c.relations[0]); row.name = 'private.unreviewed'; c.relations.push(row); }
    if (kind === 'missing-reviewed-relation') c.relations = c.relations.filter(row => row.name !== 'private.developer_operation_events');
    if (kind === 'photo-path') c.foreignKeys.shift();
    if (kind === 'reviewed-key') c.relations[0].keys[0].partial = true;
    if (kind === 'reviewed-fk') c.foreignKeys[0].validated = false;
    expect(() => inspectFinalResetCatalog(c, head)).toThrow(/^RESET_FINAL_CATALOG_REJECTED$/);
  });
  it('compares PostgreSQL-parsed migration table declarations with explicit reviewed and deferred inventories', async () => {
    const { parse } = createRequire(import.meta.url)('@pgsql/parser/v17');
    const directory = new URL('../supabase/migrations/', import.meta.url), names = [];
    for (const file of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) {
      const parsed = await parse(readFileSync(new URL(file, directory), 'utf8'));
      for (const { stmt } of parsed.stmts) {
        // Existing migrations have no table removal/rename/CTAS. Requiring an
        // explicit review for any such source change avoids a stale net inventory.
        expect(stmt.DropStmt?.removeType).not.toBe('OBJECT_TABLE');
        expect(stmt.RenameStmt?.renameType).not.toBe('OBJECT_TABLE');
        expect(stmt.CreateTableAsStmt).toBeUndefined();
        expect(stmt.CreateForeignTableStmt).toBeUndefined();
        const relation = stmt.CreateStmt?.relation;
        if (relation && ['public', 'private'].includes(relation.schemaname)) {
          expect(relation.relpersistence).toBe('p');
          names.push(`${relation.schemaname}.${relation.relname}`);
        }
      }
    }
    expect(new Set(names).size).toBe(names.length);
    expect(names.sort()).toEqual([...RESET_RELATION_NAMES, DEFERRED_RESET_RELATION].sort());
  }, 30_000);
  it('only labels catalog observation after the exact final CI gate and current-run checkpoint', () => {
    const f = runner(), result = runFinalResetCatalog(f.deps);
    expect(f.deps.readCatalog).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ liveCatalogObserved: true, rows: 'SYNTHETIC_ONLY', executionApprovalVerified: false });
    expect(f.deps.execute.mock.calls.every(([program]) => program === 'git')).toBe(true);
  });
  it.each(['feature', 'foreign-run', 'fingerprint', 'dirty', 'target-env', 'no-checkpoint', 'args', 'windows'])
    ('rejects %s before any catalog connection', kind => {
      const f = runner();
      if (kind === 'feature') { f.event.pull_request.base.ref = 'dev'; f.event.pull_request.head.ref = 'codex/test'; }
      if (kind === 'foreign-run') f.baseline.runId = '456';
      if (kind === 'fingerprint') f.env.RMS_FINAL_DB_INPUT_SHA256 = '0'.repeat(64);
      if (kind === 'dirty') f.deps.execute = (_p, args) => args[0] === 'diff' ? 'changed.sql' : args[0] === 'rev-parse' ? head : `100644 blob ${'b'.repeat(40)}\tpackage.json\0`;
      if (kind === 'target-env') f.env.PGHOST = 'synthetic-remote-host';
      if (kind === 'no-checkpoint') f.baseline.exactFinalHistoryIdentitiesObserved = false;
      if (kind === 'args') f.deps.args = ['--target=synthetic'];
      if (kind === 'windows') f.deps.platform = 'win32';
      expect(() => runFinalResetCatalog(f.deps)).toThrow(/^RESET_FINAL_CATALOG_REJECTED$/);
      expect(f.deps.readCatalog).not.toHaveBeenCalled();
    });
  it('sanitizes native/catalog failures and leaves success unavailable', () => {
    const f = runner(); f.deps.readCatalog = () => { throw new Error('synthetic-private-detail'); };
    expect(() => runFinalResetCatalog(f.deps)).toThrow(/^RESET_FINAL_CATALOG_REJECTED$/);
  });
  it('requires the deferred table in the actual current-source catalog, even though the prior pure fixture passes', () => {
    const f = runner(); f.deps.readCatalog = () => catalog();
    expect(() => runFinalResetCatalog(f.deps)).toThrow(/^RESET_FINAL_CATALOG_REJECTED$/);
  });
  it.each([
    ['ENVIRONMENT', f => { f.deps.args = ['untrusted-secret']; }],
    ['CHECKPOINT', f => { f.baseline.runId = '456'; }],
    ['CATALOG_READ', f => { f.deps.readCatalog = () => { throw new Error('raw-db-secret'); }; }],
    ['DEFERRED_STRUCTURE', f => { f.deps.readCatalog = () => { const c = currentCatalog(); c.triggers[0].enabled = 'D'; return c; }; }],
    ['PHOTO_HOLD', f => { f.deps.readCatalog = () => { const c = currentCatalog(); c.foreignKeys.shift(); return c; }; }],
  ])('exposes only fixed failure phase %s, without native or caller detail', (phase, mutate) => {
    const f = runner(); mutate(f);
    try { runFinalResetCatalog(f.deps); throw new Error('unexpected success'); }
    catch (error) { expect(formatFinalResetCatalogFailure(error)).toBe(`RESET_FINAL_CATALOG_REJECTED [${phase}]`); }
  });
  it('does not reflect forged error properties through diagnostic formatting', () => {
    expect(formatFinalResetCatalogFailure(Object.assign(new Error('private detail'), { phase: 'raw-env' })))
      .toBe('RESET_FINAL_CATALOG_REJECTED [UNKNOWN]');
  });
  it('runs only in the full gate after the exact source checkpoint, before later resets', () => {
    const workflow = readFileSync(new URL('../.github/workflows/quality.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
    expect(workflow).toMatch(/Exercise installed reset catalog[\s\S]*?if: steps\.db_gate\.outputs\.full == 'true'[\s\S]*?run: npm run db:test:reset-final-catalog/u);
    expect(workflow.indexOf('run: node scripts/test-migration-baseline-checkpoint.mjs')).toBeLessThan(workflow.indexOf('run: npm run db:test:reset-final-catalog'));
    expect(workflow.indexOf('run: npm run db:test:reset-final-catalog')).toBeLessThan(workflow.indexOf('run: npm run db:test\n'));
  });
});
