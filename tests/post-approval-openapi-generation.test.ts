import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { preparePostApprovalOpenApi, readPostApprovalOpenApiDataModule } from '../scripts/generate-post-approval-openapi.js';
import { postApprovalRoomIssueModuleOpenApiFragment } from '../src/modules/post-approval-room-issues/post-approval-room-issue-module.openapi.js';
import { postApprovalRoomIssueHttpErrorStatuses } from '../src/modules/post-approval-room-issues/post-approval-room-issue.routes.js';
import { postApprovalRoomIssueEvidenceHttpErrorStatuses } from '../src/modules/post-approval-room-issues/post-approval-room-issue-evidence.routes.js';
import { postApprovalOpenApiFragment, postApprovalOpenApiErrorCodes, postApprovalOpenApiInventory } from '../supabase/functions/_shared/post-approval-openapi.js';
import { openApiDocument } from '../supabase/functions/_shared/openapi.js';

const errorRef = '#/components/schemas/ErrorEnvelope';
type MutableFragment = { paths: Record<string, Record<string, Record<string, unknown>>> };
const candidate = () => structuredClone(postApprovalRoomIssueModuleOpenApiFragment) as unknown as MutableFragment;
const operation = (fragment: MutableFragment, operationId: string): Record<string, unknown> => {
  const result = Object.values(fragment.paths).flatMap(item => Object.values(item)).find(value => value.operationId === operationId);
  if (!result) throw new Error('Synthetic candidate operation missing');
  return result;
};
const dataSource = (fragment = '{}') => `
export const postApprovalOpenApiFragment = ${fragment} as const;
export const postApprovalOpenApiErrorCodes = [] as const;
export const postApprovalOpenApiInventory = {} as const;
`;

describe('#336 data-only registered source OpenAPI generation', () => {
  it('registers the exact 10 paths / 11 operations with the verified deployed release', () => {
    const prepared = preparePostApprovalOpenApi();
    expect(prepared.fragment).toEqual(postApprovalOpenApiFragment);
    expect(prepared.errorCodes).toEqual(postApprovalOpenApiErrorCodes);
    expect(prepared.inventory).toEqual(postApprovalOpenApiInventory);
    expect(postApprovalOpenApiInventory.pathCount).toBe(10);
    expect(postApprovalOpenApiInventory.operationCount).toBe(11);
    expect(new Set(postApprovalOpenApiInventory.operationIds).size).toBe(11);
    for (const [path, item] of Object.entries(postApprovalOpenApiFragment.paths)) {
      expect(openApiDocument.paths).toHaveProperty(path, item);
      for (const value of Object.values(item)) {
        expect(value['x-implementation-status']).toBe('deployed');
        expect(value['x-deployed-release']).toBe('v0.9.0');
        expect(value.security).toEqual([{ bearerAuth: [] }]);
        expect(value.summary).toMatch(/[가-힣]/);
        expect(value.description).toMatch(/[가-힣]/);
      }
    }
    expect(Object.keys(postApprovalOpenApiInventory)).toEqual(['pathCount', 'operationCount', 'operationIds']);
  });
  it('normalizes every error to the existing shared envelope without mutating the source fragments', () => {
    const before = JSON.stringify(postApprovalRoomIssueModuleOpenApiFragment);
    const prepared = preparePostApprovalOpenApi();
    for (const item of Object.values(prepared.fragment.paths as Record<string, Record<string, {
      responses: Record<string, { headers: unknown; content: Record<string, { schema: unknown }> }>;
    }>>)) for (const value of Object.values(item)) {
      for (const [status, response] of Object.entries(value.responses)) {
        if (Number(status) >= 400) expect(response.content).toEqual({ 'application/json': { schema: { $ref: errorRef } } });
        expect(response.headers).toEqual({ 'Cache-Control': { schema: { type: 'string', const: 'no-store' } } });
      }
    }
    expect(JSON.stringify(postApprovalRoomIssueModuleOpenApiFragment)).toBe(before);
  });
  it('exports the deduplicated safe HTTP error union, without importing the global document', () => {
    expect(postApprovalOpenApiErrorCodes).toEqual([...new Set([...Object.keys(postApprovalRoomIssueHttpErrorStatuses),
      ...Object.keys(postApprovalRoomIssueEvidenceHttpErrorStatuses)])].sort());
    expect(postApprovalOpenApiErrorCodes).toContain('POST_APPROVAL_ROOM_ISSUE_EVIDENCE_RETRY_REQUIRED');
    expect(postApprovalOpenApiErrorCodes).toContain('PHOTO_UPLOAD_FENCE_CONFLICT');
    expect(new Set(postApprovalOpenApiErrorCodes).size).toBe(postApprovalOpenApiErrorCodes.length);
    const globalCodes = openApiDocument.components.schemas.ErrorCode.enum;
    expect(globalCodes).toHaveLength(335);
    expect(new Set(globalCodes).size).toBe(335);
    for (const code of postApprovalOpenApiErrorCodes) expect(globalCodes).toContain(code);
    expect(Object.keys(openApiDocument.paths)).toHaveLength(151);
    const globalOperations = Object.values(openApiDocument.paths).flatMap(item => Object.values(item))
      .filter((value): value is { operationId: string } => Boolean(value && typeof value === 'object' && 'operationId' in value));
    expect(globalOperations).toHaveLength(163);
    expect(new Set(globalOperations.map(value => value.operationId)).size).toBe(163);
  });
  it('retains binary MIME/size, CAS headers and independent administrator-only handover', () => {
    const values = Object.values(postApprovalOpenApiFragment.paths).flatMap(item => Object.values(item));
    const upload = values.find(value => value.operationId === 'uploadPostApprovalRoomIssueEvidence');
    const handover = values.find(value => value.operationId === 'handoverPostApprovalRoomIssueEvidenceUpload');
    expect(upload?.parameters.filter((parameter: { in: string }) => parameter.in === 'header').map((parameter: { name: string }) => parameter.name))
      .toEqual(['Idempotency-Key', 'If-Draft-Revision', 'If-Evidence-Revision', 'If-Item-Revision']);
    expect(upload && 'requestBody' in upload && Object.keys(upload.requestBody.content)).toEqual(['image/jpeg', 'image/webp', 'image/heic', 'image/heif']);
    expect(handover?.['x-required-roles']).toEqual(['admin']);
  });
  it('documents shared administrator and historical status reads without granting execution authority', () => {
    const status = postApprovalOpenApiFragment.paths['/v1/post-approval-room-issue-evidence-uploads/{operationId}'].get;
    const description = status.responses['200'].description;
    for (const policy of ['본인 초안 작성자·현재 실행자 조건을 모두 충족', '관리자는 안전한 상태·leaseVersion을 공동 조회',
      'rejected/superseded(반려·대체)되어도 조회 권한만 유지', '실제 인계·provider 쓰기 권한은 별도',
      '조회로 실행자·fence를 변경하지 않는다', '최신 session·role/status 권한 재검증']) expect(description).toContain(policy);
    expect(status['x-implementation-status']).toBe('deployed');
    expect(status['x-deployed-release']).toBe('v0.9.0');
  });
  it('documents actual notified assignment as the maid access basis, not original performance alone', () => {
    const source = postApprovalOpenApiFragment.paths['/v1/cleaning-history/submissions/{sourceSubmissionId}/supplemental-room-issues/source'].get;
    expect(source.description).toContain('원 수행 여부와 무관하게 같은 target의 본인 실제 통보 배정 이력이 필요');
    expect(source.description).toContain('응답 ownership 구분이지 별도 접근 권한이 아니다');
    const detail = postApprovalOpenApiFragment.paths['/v1/cleaning-history/submissions/{sourceSubmissionId}/supplemental-room-issues/{reportId}'].get;
    expect(detail.responses['200'].description).toContain('실제 통보 배정 이력이 있는 메이드/관리자');
  });
  it.each(['missing path', 'duplicate id', 'wrong method', 'missing idempotency', 'path parameter drift', 'wrong status', 'invalid response status', 'wrong cache policy'])('rejects %s rather than weakening the reviewed inventory', mutation => {
    const input = candidate();
    const firstPath = Object.keys(input.paths)[0];
    if (!firstPath) throw new Error('Synthetic path missing');
    const source = operation(input, 'getPostApprovalRoomIssueSource');
    if (mutation === 'missing path') delete input.paths[firstPath];
    if (mutation === 'duplicate id') operation(input, 'listPostApprovalRoomIssueReports').operationId = source.operationId;
    if (mutation === 'wrong method') input.paths[firstPath] = { patch: source };
    if (mutation === 'missing idempotency') operation(input, 'savePostApprovalRoomIssueDraft').parameters = [];
    if (mutation === 'path parameter drift') source.parameters = [];
    if (mutation === 'wrong status') source['x-implementation-status'] = 'source-registered-not-deployed';
    if (mutation === 'invalid response status') source.responses = { invalid: {} };
    if (mutation === 'wrong cache policy') source.responses = { '200': { headers: { 'Cache-Control': { schema: { const: 'public' } } } } };
    expect(() => preparePostApprovalOpenApi(input)).toThrow(/OpenAPI candidate/);
  });
  it.each(['pinPlaintext', 'serviceRoleKey', 'providerFileId', 'sessionId', 'fenceTokenDigest', 'accessToken'])('rejects sensitive %s properties', property => {
    const input = candidate();
    operation(input, 'getPostApprovalRoomIssueSource')[property] = 'synthetic-value';
    expect(() => preparePostApprovalOpenApi(input)).toThrow('forbidden sensitive property');
  });
  it.each(['summary', 'description'])('rejects missing, non-Korean and non-string %s guidance', field => {
    for (const value of [undefined, 'English-only guidance', 336, null, '']) {
      const input = candidate();
      if (value === undefined) delete operation(input, 'getPostApprovalRoomIssueSource')[field];
      else operation(input, 'getPostApprovalRoomIssueSource')[field] = value;
      expect(() => preparePostApprovalOpenApi(input)).toThrow('Korean integration guidance missing');
    }
  });
  it.each(['object', 'array'])('rejects %s accessors before reading them', kind => {
    let reads = 0;
    const input = candidate();
    const target = kind === 'object' ? operation(input, 'getPostApprovalRoomIssueSource') : [];
    Object.defineProperty(target, kind === 'object' ? 'syntheticAccessor' : '0', {
      enumerable: true, get() { reads++; throw new Error('never-read-sensitive-canary'); }
    });
    if (kind === 'array') operation(input, 'getPostApprovalRoomIssueSource').syntheticArray = target;
    expect(() => preparePostApprovalOpenApi(input)).toThrow('plain JSON data only');
    expect(reads).toBe(0);
  });
  it('reads the real generated module as literal data and imports no Fastify, WASM, provider or source module', async () => {
    const source = await readFile(new URL('../supabase/functions/_shared/post-approval-openapi.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/^\/\/ Generated by scripts\/generate-post-approval-openapi\.ts/);
    expect(source).toMatch(/\/\/ Source SHA-256: [a-f0-9]{64}/);
    expect(source).not.toMatch(/\bimport\s|\bimport\(|\bfrom\s+["']|fastify|magick-wasm|node:|Deno\.env|process\.env/i);
    expect(readPostApprovalOpenApiDataModule(source)).toEqual({
      postApprovalOpenApiFragment, postApprovalOpenApiErrorCodes, postApprovalOpenApiInventory
    });
  });
  it('keeps NodeNext and both frozen Deno graphs on the same generated literal module', async () => {
    const shared = await readFile(new URL('../supabase/functions/_shared/openapi.ts', import.meta.url), 'utf8');
    expect(shared).toContain('from "./post-approval-openapi.js"');
    for (const name of ['deno.json', 'post-approval-report.deno.json']) {
      const config = JSON.parse(await readFile(new URL(`../supabase/functions/${name}`, import.meta.url), 'utf8'));
      expect(config.imports['./_shared/post-approval-openapi.js']).toBe('./_shared/post-approval-openapi.ts');
    }
    const configuration = openApiDocument.components.schemas.DeveloperRuntimeStatus.properties.configuration;
    expect(configuration.additionalProperties).toBe(false);
    expect(configuration.required).toContain('POST_APPROVAL_ROOM_ISSUE_HANDOVER_KEY_BASE64');
    expect(configuration.properties.POST_APPROVAL_ROOM_ISSUE_HANDOVER_KEY_BASE64).toEqual({
      type: 'object', additionalProperties: false, required: ['configured'], properties: { configured: { type: 'boolean' } }
    });
    expect(configuration.required.length).toBe(Object.keys(configuration.properties).length);
  });
  it.each([
    dataSource('JSON.parse("{}")'), dataSource('{ get "x"() { return "synthetic"; } }'),
    dataSource('{ ...{} }'), dataSource('{ "x": await Promise.resolve(1) }'),
    dataSource('{ "x": () => "synthetic" }'), dataSource('{ "x": 1, "x": 2 }'),
    `import "fastify";${dataSource()}`, `export { value } from "node:fs";${dataSource()}`,
    `${dataSource()}globalThis.syntheticExecuted = true;`, dataSource('{ "__proto__": {} }'),
    dataSource('{ "x": Infinity }'), dataSource('{ "x": undefined }')
  ])('rejects executable or ambiguous generated module %# without evaluating it', source => {
    expect(() => readPostApprovalOpenApiDataModule(source)).toThrow(/OpenAPI generated/);
    expect(Object.hasOwn(globalThis, 'syntheticExecuted')).toBe(false);
  });
  it('allows formatter trailing commas and comments only between fixed literal declarations', () => {
    const source = dataSource(`{ /* safe comment */ "x": [true, false, null, 1,${JSON.stringify('quoted " text')},], }`);
    expect(readPostApprovalOpenApiDataModule(source).postApprovalOpenApiFragment)
      .toEqual({ x: [true, false, null, 1, 'quoted " text'] });
  });
});
