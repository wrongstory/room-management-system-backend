import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { inspectFinalResetCatalog, runFinalResetCatalog } from '../scripts/test-reset-final-catalog.mjs';
import { fingerprint } from '../scripts/db-validation-gate.mjs';
import { RESET_RELATION_NAMES } from '../scripts/reset-relation-classification.mjs';
import { resetRowDispositionExpression } from '../scripts/reset-row-policy.mjs';

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
  const readCatalog = vi.fn(() => catalog()), execute = vi.fn((_program, args) => args[0] === 'rev-parse' ? head : args[0] === 'ls-tree' ? tree : '');
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
  it('runs only in the full gate after the exact source checkpoint, before later resets', () => {
    const workflow = readFileSync(new URL('../.github/workflows/quality.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
    expect(workflow).toMatch(/Exercise installed reset catalog[\s\S]*?if: steps\.db_gate\.outputs\.full == 'true'[\s\S]*?run: npm run db:test:reset-final-catalog/u);
    expect(workflow.indexOf('run: node scripts/test-migration-baseline-checkpoint.mjs')).toBeLessThan(workflow.indexOf('run: npm run db:test:reset-final-catalog'));
    expect(workflow.indexOf('run: npm run db:test:reset-final-catalog')).toBeLessThan(workflow.indexOf('run: npm run db:test\n'));
  });
});
