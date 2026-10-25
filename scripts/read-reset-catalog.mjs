import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { validateResetCatalog } from './reset-catalog-contract.mjs';
import { classifyResetRelations } from './reset-relation-classification.mjs';
import { summarizeResetReviewRequirements } from './reset-review-requirements.mjs';
import { summarizeResetAccounts } from './reset-account-summary.mjs';
import {
  LOCAL_DB_CONTAINER, validateLocalDockerEndpoint, validateLocalContainer,
  validateLocalProjectConfig,
} from './db-lint-baseline.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const reject = () => { throw new Error('RESET_CATALOG_REJECTED'); };

export function summarizeResetCatalog(input) {
  const validated = validateResetCatalog(input);
  const c = validated.catalog;
  const names = new Set(c.relations.map((r) => r.name));
  return {
    scope: 'local-structural-diagnostic', executionEnabled: false,
    classificationComplete: false,
    relationCount: names.size, foreignKeyCount: c.foreignKeys.length, triggerCount: c.triggers.length,
    crossSchemaForeignKeyCount: c.foreignKeys.filter((f) => !names.has(f.source) || !names.has(f.target)).length,
    unsupportedRelationCount: c.relations.filter((r) => r.kind !== 'r').length,
    boundaryRelationCount: c.boundaryRelations.length,
    unsupportedKeyCount: validated.unsupportedKeyCount,
    unsupportedForeignKeyCount: validated.unsupportedForeignKeyCount,
    missingPrimaryKeyCount: validated.missingPrimaryKeyCount,
    reviewRequirements: summarizeResetReviewRequirements(),
    // These are unsatisfied gates, never inferred approvals from a valid catalog.
    executionBlockers: [
      'RESET_RECOVERY_SCOPE_UNDECIDED', 'PHOTO_DELETION_ON_HOLD',
      'TRUSTED_ROW_COLLECTOR_NOT_IMPLEMENTED', 'ROW_DISPOSITION_RULES_UNIMPLEMENTED',
      'TEMPLATE_PUBLICATION_RULES_UNVERIFIED', 'PRE_OPERATION_STATE_UNVERIFIED',
      'LIVE_RESET_AUTHORIZATION_UNVERIFIED', 'MAINTENANCE_AND_DRAIN_UNVERIFIED',
      'RESET_EXECUTION_NOT_IMPLEMENTED',
    ],
    ...classifyResetRelations([...names]),
    // Structural subset, not a full schema/CAS/content/backup proof.
    catalogFingerprint: validated.catalogFingerprint,
  };
}

function readFixedLocalDiagnostic(sqlFile, summarize, {
  spawn = spawnSync, read = readFileSync, env = process.env, args = [],
} = {}) {
  try {
    if (args.length || ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH']
      .some((key) => env[key])) reject();
    const { dbPort } = validateLocalProjectConfig(read(resolve(root,'supabase/config.toml'),'utf8'));
    const run = (args) => {
      const result = spawn('docker', ['--context','default',...args], {
        encoding: 'utf8', env, shell: false, windowsHide: true,
        timeout: 15000, maxBuffer: 4 * 1024 * 1024,
      });
      if (result.error || result.signal || result.status !== 0 ||
          result.stderr !== '' || typeof result.stdout !== 'string') reject();
      return result.stdout;
    };
    validateLocalDockerEndpoint(run(['context','inspect','default','--format','{{json .Endpoints.docker.Host}}']));
    validateLocalContainer(run(['inspect','--format',
      '{"name":{{json .Name}},"running":{{json .State.Running}},"project":{{json (index .Config.Labels "com.supabase.cli.project")}},"ports":{{json .NetworkSettings.Ports}}}',
      LOCAL_DB_CONTAINER]),dbPort);
    const sql = read(new URL(sqlFile,import.meta.url),'utf8');
    const output = run(['exec',LOCAL_DB_CONTAINER,'psql','-XqAt',
      '-h','/var/run/postgresql','-p','5432','-U','postgres','-d','postgres',
      '-v','ON_ERROR_STOP=1','-c',sql]);
    return summarize(JSON.parse(output));
  } catch {
    // Never print process error objects, raw SQL output, env, or stderr.
    reject();
  }
}

export function readLocalResetCatalog(dependencies) {
  return readFixedLocalDiagnostic('./reset-catalog.sql', summarizeResetCatalog, dependencies);
}

export function readLocalResetAccounts(dependencies) {
  return readFixedLocalDiagnostic('./reset-accounts.sql', summarizeResetAccounts, dependencies);
}

// Fixed synthetic pg_temp fixture, never accepts caller SQL or reads business rows.
// Only a test harness consumes these invented row keys; not a production collector.
export function readLocalResetReferenceFixture(dependencies) {
  return readFixedLocalDiagnostic('./reset-reference-fixture.sql', (fixture) => fixture, dependencies);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(`${JSON.stringify(readLocalResetCatalog({ args: process.argv.slice(2) }))}\n`); }
  catch { process.stderr.write('RESET_CATALOG_REJECTED\n'); process.exitCode = 1; }
}
