import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openApiDocument } from '../supabase/functions/_shared/openapi.ts';
import { flatTemplateRequest, historicalTemplateRequest, invalidFlatTemplateRequests } from '../tests/fixtures/cleaning-template-contract.ts';

// Isolated pinned TS5 toolchain: openapi-typescript's peer range excludes the app's TS7.
// Generated artifacts stay ignored; no application compiler override or frontend edits.
const directory = resolve('.tmp/template-client');
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, 'openapi.json'), JSON.stringify(openApiDocument));
const valid = [flatTemplateRequest, ...[false, true].map((legacy) => historicalTemplateRequest('standard', legacy))];
// TS cannot express numeric bounds / all JSON Schema predicates. Only assert tuple
// length, literal slot roles, flags and capacities here; Ajv covers all wire cases.
const typeInvalid = new Set(['missing slot', 'extra slot', 'duplicate key', 'wrong key', 'required cleaning', 'optional bomb', 'optional issue', 'duplicate order', 'order gap', 'swapped roles', 'cleaning capacity', 'bomb capacity', 'issue capacity', 'missing capacity']);
const source = [
  "import type { components } from './client.js';",
  "type Request = components['schemas']['PublishCleaningTemplateRequest'];",
  ...valid.map((body, index) => `const valid${index} = ${JSON.stringify(body)} satisfies Request;`),
  ...invalidFlatTemplateRequests().filter(([name]) => typeInvalid.has(name)).map(([name, body], index) =>
    `// @ts-expect-error ${name}\nconst invalid${index} = ${JSON.stringify(body.slots)} satisfies components['schemas']['CheckoutCleaningTemplateV9Slots'];`)
].join('\n');
await writeFile(resolve(directory, 'fixtures.ts'), source);
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Generated client check failed (${result.status})`);
}
run('npm', ['exec', '--yes', '--package=openapi-typescript@7.13.0', '--package=typescript@5.9.3', '--',
  'openapi-typescript', '.tmp/template-client/openapi.json', '-o', '.tmp/template-client/client.d.ts']);
run('npm', ['exec', '--yes', '--package=typescript@5.9.3', '--', 'tsc', '--noEmit', '--strict', '--skipLibCheck',
  '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '.tmp/template-client/fixtures.ts']);
console.log('Generated cleaning-template client: shared valid and invalid fixtures passed.');
