import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { openApiDocument } from '../supabase/functions/_shared/openapi.ts';
import { flatTemplateRequest, flatTemplateSlotPermutations, historicalTemplateRequest, invalidFlatTemplateRequests } from '../tests/fixtures/cleaning-template-contract.ts';

// Isolated pinned TS5 toolchain: openapi-typescript's peer range excludes the app's TS7.
// Generated artifacts stay ignored; no application compiler override or frontend edits.
const directory = resolve('.tmp/template-client');
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, 'openapi.json'), JSON.stringify(openApiDocument));
const valid = [flatTemplateRequest, ...[false, true].map((legacy) => historicalTemplateRequest('standard', legacy))];
// TS expresses length and canonical role fields, but not contains cardinality or
// numeric bounds. Validate every shared wire case with Ajv, including type-valid
// duplicate/missing roles, rather than treating successful codegen as parity.
const typeInvalid = new Set(['missing slot', 'extra slot', 'duplicate key', 'wrong key', 'required cleaning', 'optional bomb', 'optional issue', 'duplicate order', 'order gap', 'swapped roles', 'cleaning capacity', 'bomb capacity', 'issue capacity', 'missing capacity']);
const document = JSON.parse(JSON.stringify(openApiDocument));
const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
const validate = ajv.compile({
  $ref: '#/components/schemas/PublishCleaningTemplateRequest', components: document.components
});
const permutations = flatTemplateSlotPermutations();
for (const { name, body } of permutations) {
  if (!validate(JSON.parse(JSON.stringify(body)))) throw new Error(`Valid permutation rejected: ${name}`);
}
for (const [name, body] of invalidFlatTemplateRequests()) {
  if (validate(JSON.parse(JSON.stringify(body)))) throw new Error(`Malformed wire case accepted: ${name}`);
}
const repeatedRoleSlots = [flatTemplateRequest.slots[0], flatTemplateRequest.slots[1], flatTemplateRequest.slots[1]];
if (validate({ ...flatTemplateRequest, slots: repeatedRoleSlots })) {
  throw new Error('Schema lost exact-one role cardinality');
}
const source = [
  "import type { components } from './client.js';",
  "type Request = components['schemas']['PublishCleaningTemplateRequest'];",
  ...valid.map((body, index) => `const valid${index} = ${JSON.stringify(body)} satisfies Request;`),
  // All six input array orders are valid, in both the request and precise v9 type.
  ...permutations.flatMap(({ body }, index) => [
    `const permutationRequest${index} = ${JSON.stringify(body)} satisfies Request;`,
    `const permutation${index} = ${JSON.stringify(body.slots)} satisfies components['schemas']['CheckoutCleaningTemplateV9Slots'];`
  ]),
  // Characterize the generator's contains limitation; Ajv above rejects this.
  `const containsNotExpressed = ${JSON.stringify(repeatedRoleSlots)} satisfies components['schemas']['CheckoutCleaningTemplateV9Slots'];`,
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
  'openapi-typescript', '.tmp/template-client/openapi.json', '--array-length', '-o', '.tmp/template-client/client.d.ts']);
run('npm', ['exec', '--yes', '--package=typescript@5.9.3', '--', 'tsc', '--noEmit', '--strict', '--skipLibCheck',
  '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '.tmp/template-client/fixtures.ts']);
console.log('Generated cleaning-template client: six unordered v9 inputs and canonical field/length checks passed; Ajv rejected all malformed fixtures and type-valid duplicate/missing roles. Codegen alone does not enforce contains or DB state.');
