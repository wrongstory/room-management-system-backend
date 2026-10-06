import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { z } from 'zod';
import { classifyResetRelations } from './reset-relation-classification.mjs';
import { summarizeResetAccounts } from './reset-account-summary.mjs';
import {
  LOCAL_DB_CONTAINER, validateLocalDockerEndpoint, validateLocalContainer,
  validateLocalProjectConfig,
} from './db-lint-baseline.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const name = z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/).max(128);
const identifier = z.string().regex(/^[a-z][a-z0-9_]*$/).max(63);
const hash = z.string().regex(/^[a-f0-9]{32}$/);
const schema = z.object({
  format: z.literal('reset-catalog-v1'), readOnly: z.literal(true),
  relations: z.array(z.object({
    name, kind: z.enum(['r','p','f']), rls: z.boolean(), forceRls: z.boolean(),
  }).strict()).min(1).max(1000),
  foreignKeys: z.array(z.object({
    source: name, target: name, name: identifier, definition: z.string().min(1).max(4096),
  }).strict()).max(10000),
  triggers: z.array(z.object({
    relation: name, name: identifier, enabled: z.enum(['O','D','R','A']),
    definitionHash: hash, functionHash: hash,
  }).strict()).max(10000),
}).strict();
const reject = () => { throw new Error('RESET_CATALOG_REJECTED'); };

export function summarizeResetCatalog(input) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) reject();
  const c = parsed.data;
  const names = new Set(c.relations.map((r) => r.name));
  if (names.size !== c.relations.length || !names.has('public.profiles') ||
      !names.has('public.rooms') ||
      c.relations.some((r) => !/^(public|private)\./.test(r.name)) ||
      new Set(c.foreignKeys.map((f) => `${f.source}:${f.name}`)).size !== c.foreignKeys.length ||
      new Set(c.triggers.map((t) => `${t.relation}:${t.name}`)).size !== c.triggers.length ||
      c.foreignKeys.some((f) => !names.has(f.source) && !names.has(f.target)) ||
      c.triggers.some((t) => !names.has(t.relation))) reject();
  const by = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const canonical = {
    ...c,
    relations: [...c.relations].sort((a,b) => by(a.name,b.name)),
    foreignKeys: [...c.foreignKeys].sort((a,b) => by(`${a.source}:${a.name}`,`${b.source}:${b.name}`)),
    triggers: [...c.triggers].sort((a,b) => by(`${a.relation}:${a.name}`,`${b.relation}:${b.name}`)),
  };
  return {
    scope: 'local-structural-diagnostic', executionEnabled: false,
    classificationComplete: false,
    relationCount: names.size, foreignKeyCount: c.foreignKeys.length, triggerCount: c.triggers.length,
    crossSchemaForeignKeyCount: c.foreignKeys.filter((f) => !names.has(f.source) || !names.has(f.target)).length,
    unsupportedRelationCount: c.relations.filter((r) => r.kind !== 'r').length,
    ...classifyResetRelations([...names]),
    // Structural subset, not a full schema/CAS/content/backup proof.
    catalogFingerprint: createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
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
