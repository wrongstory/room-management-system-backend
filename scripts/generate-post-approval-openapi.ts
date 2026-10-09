import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { postApprovalRoomIssueModuleOpenApiFragment } from '../src/modules/post-approval-room-issues/post-approval-room-issue-module.openapi.js';
import { postApprovalRoomIssueOpenApiFragment } from '../src/modules/post-approval-room-issues/post-approval-room-issue.openapi.js';
import { postApprovalRoomIssueEvidenceOpenApiFragment, postApprovalRoomIssueHandoverOpenApiFragment } from '../src/modules/post-approval-room-issues/post-approval-room-issue-evidence.openapi.js';
import { postApprovalRoomIssueHttpErrorStatuses } from '../src/modules/post-approval-room-issues/post-approval-room-issue.routes.js';
import { postApprovalRoomIssueEvidenceHttpErrorStatuses } from '../src/modules/post-approval-room-issues/post-approval-room-issue-evidence.routes.js';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = resolve(projectRoot, 'supabase/functions/_shared/post-approval-openapi.ts');
const image = 'denoland/deno:2.1.4@sha256:3bf75873714baa410dcf7fabaf76d806d20f0ac8a7579df11577b4ed97416e34';
const errorRef = '#/components/schemas/ErrorEnvelope';
const base = '/v1/cleaning-history/submissions/{sourceSubmissionId}/supplemental-room-issues';
const operations = {
  getPostApprovalRoomIssueSource: `get ${base}/source`,
  savePostApprovalRoomIssueDraft: `post ${base}/drafts`,
  getPostApprovalRoomIssueDraft: `get ${base}/drafts/{clientReportId}`,
  listPostApprovalRoomIssueReports: `get ${base}`,
  finalizePostApprovalRoomIssueReport: `post ${base}`,
  getPostApprovalRoomIssueReport: `get ${base}/{reportId}`,
  closePostApprovalRoomIssueReport: `post ${base}/{reportId}/close`,
  uploadPostApprovalRoomIssueEvidence: `post ${base}/drafts/{clientReportId}/evidence/{evidenceId}/upload`,
  getPostApprovalRoomIssueEvidenceUpload: 'get /v1/post-approval-room-issue-evidence-uploads/{operationId}',
  getPostApprovalRoomIssueEvidenceContent: 'get /v1/post-approval-room-issue-evidence/{evidenceId}/versions/{revision}/content',
  handoverPostApprovalRoomIssueEvidenceUpload: 'post /v1/post-approval-room-issue-evidence-uploads/{operationId}/handover'
} as const;
const forbiddenProperties = new Set([
  'servicerolekey', 'supabasesecretkey', 'supabaseservicerolekey', 'pinplaintext', 'pinhash',
  'pinciphertext', 'accesstoken', 'refreshtoken', 'sessionid', 'authuserid', 'fencetoken',
  'fencetokendigest', 'providerfileid', 'storagefileid', 'storagelocator', 'clientsecret', 'privatekey'
]);
const sourcePaths = [
  'scripts/generate-post-approval-openapi.ts',
  'src/modules/post-approval-room-issues/post-approval-room-issue-module.openapi.ts',
  'src/modules/post-approval-room-issues/post-approval-room-issue.openapi.ts',
  'src/modules/post-approval-room-issues/post-approval-room-issue-evidence.openapi.ts',
  'src/modules/post-approval-room-issues/post-approval-room-issue.routes.ts',
  'src/modules/post-approval-room-issues/post-approval-room-issue-evidence.routes.ts',
  'src/modules/post-approval-room-issues/post-approval-room-issue-handover.routes.ts',
  'src/modules/post-approval-room-issues/post-approval-room-issue-upload-contract.ts',
  'src/modules/photos/photo-binary.ts'
];
function object(value: Json | undefined, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`OpenAPI candidate invalid ${label}`);
  return value;
}
function assertSafeData(value: unknown): asserts value is Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object'
    || Object.getPrototypeOf(value) !== (Array.isArray(value) ? Array.prototype : Object.prototype)) throw new Error('OpenAPI candidate must contain plain JSON data only');
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!Object.hasOwn(descriptor, 'value')) throw new Error('OpenAPI candidate must contain plain JSON data only');
    if (forbiddenProperties.has(key.toLowerCase())) throw new Error('OpenAPI candidate contains a forbidden sensitive property');
    assertSafeData(descriptor.value);
  }
}

/** Generation-time imports only. The returned data has no Node/SDK/provider dependency. */
export function preparePostApprovalOpenApi(input: unknown = postApprovalRoomIssueModuleOpenApiFragment) {
  assertSafeData(input);
  const fragment = structuredClone(object(input, 'fragment'));
  const paths = object(fragment.paths, 'paths');
  if (Object.keys(fragment).join() !== 'paths' || Object.keys(paths).length !== 10) throw new Error('OpenAPI candidate path inventory must be exactly 10');
  const ids = new Set<string>();
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, operationValue] of Object.entries(object(item, 'path item'))) {
      const operation = object(operationValue, 'operation');
      const id = operation.operationId;
      if (typeof id !== 'string' || !Object.hasOwn(operations, id)
        || operations[id as keyof typeof operations] !== `${method} ${path}` || ids.has(id)) {
        throw new Error('OpenAPI candidate operation inventory/collision');
      }
      ids.add(id);
      if (typeof operation.summary !== 'string' || !/[가-힣]/.test(operation.summary)
        || typeof operation.description !== 'string' || !/[가-힣]/.test(operation.description)) throw new Error('OpenAPI candidate Korean integration guidance missing');
      if (JSON.stringify(operation.security) !== JSON.stringify([{ bearerAuth: [] }])
        || operation['x-implementation-status'] !== 'deployed'
        || operation['x-deployed-release'] !== 'v0.9.0'
        || JSON.stringify(operation.tags) !== JSON.stringify(['Post-approval Room Issues'])) throw new Error('OpenAPI candidate auth/status drift');
      if (!Array.isArray(operation.parameters)) throw new Error('OpenAPI candidate parameters missing');
      const parameters = operation.parameters.map(value => object(value, 'parameter'));
      const actualPaths = parameters.filter(parameter => parameter.in === 'path').map(parameter => parameter.name).sort();
      const expectedPaths = [...path.matchAll(/\{([^}]+)\}/g)].map(match => match[1]).sort();
      if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)
        || parameters.some(parameter => parameter.in === 'path' && parameter.required !== true)) throw new Error('OpenAPI candidate path parameter drift');
      if (method === 'post' && !parameters.some(parameter => parameter.in === 'header'
        && parameter.name === 'Idempotency-Key' && parameter.required === true)) throw new Error('OpenAPI candidate mutation idempotency drift');
      for (const [status, responseValue] of Object.entries(object(operation.responses, 'responses'))) {
        if (!/^[1-5][0-9]{2}$/.test(status)) throw new Error('OpenAPI candidate response status drift');
        const response = object(responseValue, 'response');
        const headers = object(response.headers, 'response headers');
        if (object(object(headers['Cache-Control'], 'cache header').schema, 'cache schema').const !== 'no-store') throw new Error('OpenAPI candidate no-store drift');
        if (Number(status) >= 400) {
          response.content = { 'application/json': { schema: { $ref: errorRef } } };
        }
      }
    }
  }
  if (ids.size !== 11) throw new Error('OpenAPI candidate operation inventory must be exactly 11');
  if ([...Object.values(postApprovalRoomIssueHttpErrorStatuses), ...Object.values(postApprovalRoomIssueEvidenceHttpErrorStatuses)]
    .some(status => !Number.isInteger(status) || status < 400 || status > 599)) throw new Error('OpenAPI candidate HTTP error status map drift');
  const codes = [...new Set([...Object.keys(postApprovalRoomIssueHttpErrorStatuses),
    ...Object.keys(postApprovalRoomIssueEvidenceHttpErrorStatuses)])].sort();
  if (codes.some(code => !/^[A-Z][A-Z0-9_]{0,95}$/.test(code))) throw new Error('OpenAPI candidate error code drift');
  return { fragment, errorCodes: codes, inventory: { pathCount: 10, operationCount: 11, operationIds: [...ids].sort() } };
}

function validateSourceComposition() {
  const parts = [postApprovalRoomIssueOpenApiFragment, postApprovalRoomIssueEvidenceOpenApiFragment,
    postApprovalRoomIssueHandoverOpenApiFragment];
  const paths: Record<string, unknown> = {};
  for (const part of parts) for (const [path, item] of Object.entries(part.paths)) {
    if (Object.hasOwn(paths, path)) throw new Error('OpenAPI source fragment path collision');
    paths[path] = item;
  }
  if (JSON.stringify({ paths }) !== JSON.stringify(postApprovalRoomIssueModuleOpenApiFragment)) throw new Error('OpenAPI module/source composition drift');
}

/** A strict literal grammar, not evaluation: reject imports, calls, getters and spreads. */
export function readPostApprovalOpenApiDataModule(source: string): Record<string, Json> {
  let offset = 0;
  const fail = (): never => { throw new Error('OpenAPI generated module must contain exported const literal data only'); };
  const whitespace = () => {
    for (;;) {
      while (offset < source.length && /\s/.test(source[offset] ?? '')) offset++;
      if (source.startsWith('//', offset)) { const end = source.indexOf('\n', offset); offset = end < 0 ? source.length : end + 1; }
      else if (source.startsWith('/*', offset)) { const end = source.indexOf('*/', offset + 2); if (end < 0) fail(); offset = end + 2; }
      else return;
    }
  };
  const take = (token: string) => { whitespace(); if (!source.startsWith(token, offset)) fail(); offset += token.length; };
  const identifier = () => {
    whitespace();
    const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(offset));
    if (!match) return fail();
    offset += match[0].length;
    return match[0];
  };
  const word = (token: string) => { if (identifier() !== token) fail(); };
  const string = (): string => {
    whitespace(); if (source[offset] !== '"') return fail();
    const start = offset++;
    while (offset < source.length) {
      const character = source[offset++];
      if (character === '\\') offset++;
      else if (character === '"') {
        let value: unknown;
        try { value = JSON.parse(source.slice(start, offset)); } catch { return fail(); }
        if (typeof value !== 'string') return fail();
        return value;
      }
    }
    return fail();
  };
  const literal = (): Json => {
    whitespace();
    if (source[offset] === '"') return string();
    if (source[offset] === '[') {
      offset++;
      const array: Json[] = [];
      whitespace();
      while (source[offset] !== ']') {
        array.push(literal()); whitespace();
        if (source[offset] === ']') break;
        take(','); whitespace();
      }
      take(']'); return array;
    }
    if (source[offset] === '{') {
      offset++;
      const value: JsonObject = {};
      whitespace();
      while (source[offset] !== '}') {
        const key = string();
        if (key === '__proto__' || Object.hasOwn(value, key)) return fail();
        take(':'); value[key] = literal(); whitespace();
        if (source[offset] === '}') break;
        take(','); whitespace();
      }
      take('}'); return value;
    }
    for (const [token, value] of [['true', true], ['false', false], ['null', null]] as const) {
      if (source.startsWith(token, offset)) { word(token); return value; }
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(offset));
    if (number && Number.isFinite(Number(number[0]))) { offset += number[0].length; return Number(number[0]); }
    return fail();
  };
  const result: Record<string, Json> = {};
  const names = ['postApprovalOpenApiFragment', 'postApprovalOpenApiErrorCodes', 'postApprovalOpenApiInventory'];
  whitespace();
  while (offset < source.length) {
    word('export'); word('const');
    const name = identifier();
    if (!names.includes(name) || Object.hasOwn(result, name)) return fail();
    take('='); result[name] = literal(); word('as'); word('const'); take(';'); whitespace();
  }
  if (Object.keys(result).length !== 3) throw new Error('OpenAPI generated export inventory invalid');
  assertSafeData(result);
  return result;
}

export async function generatePostApprovalOpenApi(check = false): Promise<void> {
  validateSourceComposition();
  const prepared = preparePostApprovalOpenApi();
  const inputHash = createHash('sha256');
  for (const path of sourcePaths) inputHash.update(`${path}\n`).update((await readFile(resolve(projectRoot, path), 'utf8')).replace(/\r\n?/g, '\n'));
  const raw = [
    '// Generated by scripts/generate-post-approval-openapi.ts; do not edit.',
    '// Source contract data only. Global source registration is not hosted deployment.',
    `// Source SHA-256: ${inputHash.digest('hex')}`,
    `export const postApprovalOpenApiFragment = ${JSON.stringify(prepared.fragment, null, 2)} as const;`,
    `export const postApprovalOpenApiErrorCodes = ${JSON.stringify(prepared.errorCodes, null, 2)} as const;`,
    `export const postApprovalOpenApiInventory = ${JSON.stringify(prepared.inventory, null, 2)} as const;`,
    ''
  ].join('\n');
  const format = spawnSync('docker', ['run', '--rm', '--network', 'none', '-i', '--entrypoint', 'deno', image,
    'fmt', '--ext=ts', '-'], { input: raw, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  if (format.status !== 0 || !format.stdout) throw new Error('OpenAPI candidate pinned Deno formatting failed');
  const formatted = format.stdout.replace(/\r\n?/g, '\n');
  const expectedData = { postApprovalOpenApiFragment: prepared.fragment,
    postApprovalOpenApiErrorCodes: prepared.errorCodes, postApprovalOpenApiInventory: prepared.inventory };
  if (JSON.stringify(readPostApprovalOpenApiDataModule(formatted)) !== JSON.stringify(expectedData)) throw new Error('OpenAPI generated data mismatch');
  if (check) {
    const stored = (await readFile(outputPath, 'utf8')).replace(/\r\n?/g, '\n');
    readPostApprovalOpenApiDataModule(stored);
    if (stored !== formatted) throw new Error('OpenAPI generated candidate drift; regenerate with npm exec -- tsx scripts/generate-post-approval-openapi.ts');
  } else await writeFile(outputPath, formatted, 'utf8');
  process.stdout.write(`Post-approval data-only OpenAPI ${check ? 'check' : 'generation'} PASS: 10 paths / 11 operations / ${prepared.errorCodes.length} safe error codes\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const argumentsList = process.argv.slice(2);
  if (argumentsList.length > 1 || argumentsList.some(argument => argument !== '--check')) throw new Error('Only --check is supported');
  generatePostApprovalOpenApi(argumentsList.includes('--check')).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : 'OpenAPI candidate generation failed'}\n`);
    process.exitCode = 1;
  });
}
