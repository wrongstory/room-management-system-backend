import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '../src/domain/actor.js';
import { AppError } from '../src/lib/app-error.js';
import { PhotoError, PHOTO_INPUT_MAX_BYTES, photoMime, readPhotoBody } from '../src/modules/photos/photo-binary.js';
import {
  createPostApprovalRoomIssueEvidenceRoutes, POST_APPROVAL_ROOM_ISSUE_EVIDENCE_CONTENT_PATH,
  POST_APPROVAL_ROOM_ISSUE_EVIDENCE_STATUS_PATH, POST_APPROVAL_ROOM_ISSUE_EVIDENCE_UPLOAD_PATH,
  type PostApprovalRoomIssueEvidenceHttpService
} from '../src/modules/post-approval-room-issues/post-approval-room-issue-evidence.routes.js';
import { postApprovalRoomIssueEvidenceOpenApiFragment } from '../src/modules/post-approval-room-issues/post-approval-room-issue-evidence.openapi.js';
import { postApprovalRoomIssueUploadStatuses } from '../src/modules/post-approval-room-issues/post-approval-room-issue-upload-contract.js';

const id = (n: number) => `b3600000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = (role: Actor['role'] = 'maid'): Actor => ({ profileId: id(1), authUserId: id(9), role,
  displayName: 'synthetic', mustChangePassword: false, accessToken: 'verified.server.token' });
const uploadPath = POST_APPROVAL_ROOM_ISSUE_EVIDENCE_UPLOAD_PATH.replace(':sourceSubmissionId', id(3))
  .replace(':clientReportId', id(4)).replace(':evidenceId', id(5));
const statusPath = POST_APPROVAL_ROOM_ISSUE_EVIDENCE_STATUS_PATH.replace(':operationId', id(6));
const contentPath = POST_APPROVAL_ROOM_ISSUE_EVIDENCE_CONTENT_PATH.replace(':evidenceId', id(5)).replace(':revision', '1');
const headers = { 'if-draft-revision': '1', 'if-evidence-revision': '0', 'if-item-revision': '0',
  'idempotency-key': 'synthetic-evidence-key', 'content-type': 'image/jpeg' };
const bytes = Buffer.from([1, 2, 3]);
const operation = { operationId: id(6), evidenceId: id(5), status: 'accepted' as const,
  leaseVersion: 1, itemRevision: 1, evidenceRevision: 1, mimeType: 'image/jpeg' as const, sizeBytes: 3, sha256: 'a'.repeat(64) };
interface Options { who?: Actor; denial?: unknown; authDenial?: unknown; duplicateHeader?: string; rawEmptyQuery?: boolean }
async function fixture(options: Options = {}) {
  const events: string[] = [], consumed: Uint8Array[] = [];
  const service: PostApprovalRoomIssueEvidenceHttpService = {
    upload: vi.fn(async (_actor, _input, _key, readBody) => {
      events.push('synthetic-admission'); if (options.denial !== undefined) throw options.denial;
      const body = await readBody(); events.push('body-callback');
      expect(body.stream).toBeInstanceOf(ReadableStream);
      try { photoMime(body.contentType); consumed.push(await readPhotoBody(body.stream, body.contentLength, PHOTO_INPUT_MAX_BYTES)); }
      catch (error) { if (error instanceof PhotoError) throw new AppError(error.statusCode, error.code, 'raw exception must not escape'); throw error; }
      return { ...operation, providerFileId: 'private_provider_file_123', sessionId: id(2) };
    }),
    status: vi.fn(async () => { if (options.denial !== undefined) throw options.denial; return { ...operation, providerLocator: 'private_provider_file_123' }; }),
    content: vi.fn(async () => { if (options.denial !== undefined) throw options.denial; return { bytes, mimeType: 'image/jpeg' as const }; })
  };
  const app = Fastify({ logger: false, requestIdHeader: 'x-request-id' });
  app.decorateRequest('actor');
  app.decorate('authenticate', async request => {
    events.push('auth'); if (options.authDenial !== undefined) throw options.authDenial; request.actor = options.who ?? actor();
  });
  app.decorate('requirePasswordChanged', async request => {
    events.push('password'); if (request.actor.mustChangePassword) throw new AppError(403, 'PASSWORD_CHANGE_REQUIRED', 'private password details');
  });
  if (options.duplicateHeader) app.addHook('onRequest', async request => {
    const name = options.duplicateHeader;
    if (name) request.raw.rawHeaders.push(name.toUpperCase(), String(request.headers[name] ?? 'synthetic-evidence-key'));
  });
  // Inject normalizes a trailing empty query away; preserve the raw HTTP marker for this boundary fixture.
  if (options.rawEmptyQuery) app.addHook('onRequest', async request => { request.raw.url = `${request.raw.url}?`; });
  app.post('/synthetic-json-sibling', async request => request.body);
  await app.register(createPostApprovalRoomIssueEvidenceRoutes(service));
  return { app, service, events, consumed };
}
async function upload(options: Options = {}, change: Record<string, string> = {}, payload: Buffer = bytes) {
  const f = await fixture(options);
  const response = await f.app.inject({ method: 'POST', url: uploadPath, headers: { ...headers, ...change }, payload });
  return { ...f, response };
}

describe('supplemental evidence isolated raw-stream routes (synthetic transport)', () => {
  it('passes strict path/CAS input and deferred binary reader only after auth/password', async () => {
    const f = await upload();
    try {
      expect(f.response.statusCode).toBe(200); expect(f.response.json()).toEqual(operation);
      expect(f.response.headers['cache-control']).toBe('no-store');
      expect(f.events).toEqual(['auth', 'password', 'synthetic-admission', 'body-callback']);
      expect(f.consumed).toEqual([new Uint8Array(bytes)]);
      expect(f.service.upload).toHaveBeenCalledWith(actor(), { sourceSubmissionId: id(3), clientReportId: id(4), evidenceId: id(5),
        expectedDraftRevision: 1, expectedEvidenceRevision: 0, expectedItemRevision: 0 }, headers['idempotency-key'], expect.any(Function));
      expect(f.response.body).not.toMatch(/providerFileId|sessionId|private_provider/);
    } finally { await f.app.close(); }
  });
  it('does not invoke/consume the body reader when synthetic admission denies', async () => {
    const f = await upload({ denial: new AppError(429, 'PHOTO_UPLOAD_RATE_LIMITED', 'private raw SQL detail') });
    try {
      expect(f.response.statusCode).toBe(429); expect(f.events).toEqual(['auth', 'password', 'synthetic-admission']);
      expect(f.consumed).toEqual([]); expect(f.response.body).not.toContain('private');
    } finally { await f.app.close(); }
  });
  it.each(['if-draft-revision', 'if-evidence-revision', 'if-item-revision', 'idempotency-key'])('rejects identical repeated raw %s headers before service', async name => {
    const f = await upload({ duplicateHeader: name });
    try { expect(f.response.statusCode).toBe(400); expect(f.service.upload).not.toHaveBeenCalled(); }
    finally { await f.app.close(); }
  });
  it('rejects a normalized header array even if raw names are folded', async () => {
    const f = await fixture();
    try {
      const result = await f.app.inject({ method: 'POST', url: uploadPath,
        headers: { ...headers, 'idempotency-key': ['synthetic-evidence-key', 'synthetic-evidence-key'] }, payload: bytes });
      expect(result.statusCode).toBe(400); expect(f.service.upload).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it.each(['if-draft-revision', 'if-evidence-revision', 'if-item-revision', 'idempotency-key'])('requires exactly one %s header', async name => {
    const f = await fixture();
    try {
      const selected: Record<string, string> = { ...headers }; delete selected[name];
      const result = await f.app.inject({ method: 'POST', url: uploadPath, headers: selected, payload: bytes });
      expect(result.statusCode).toBe(400); expect(f.service.upload).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it.each(['-1', '1.5', '1e2', '+1', 'NaN', 'Infinity', '9007199254740992', ' 1', '1 ', ''])('rejects nondecimal/unsafe CAS %j', async value => {
    const f = await upload({}, { 'if-evidence-revision': value });
    try { expect(f.response.statusCode).toBe(400); expect(f.service.upload).not.toHaveBeenCalled(); }
    finally { await f.app.close(); }
  });
  it('accepts stored MAX_SAFE draft and final incrementable evidence/item CAS', async () => {
    const f = await upload({}, { 'if-draft-revision': String(Number.MAX_SAFE_INTEGER),
      'if-evidence-revision': String(Number.MAX_SAFE_INTEGER - 1), 'if-item-revision': String(Number.MAX_SAFE_INTEGER - 1) });
    try { expect(f.response.statusCode).toBe(200); expect(vi.mocked(f.service.upload).mock.calls[0]?.[1]).toMatchObject({
      expectedDraftRevision: Number.MAX_SAFE_INTEGER, expectedEvidenceRevision: Number.MAX_SAFE_INTEGER - 1, expectedItemRevision: Number.MAX_SAFE_INTEGER - 1 }); }
    finally { await f.app.close(); }
  });
  it.each(['if-evidence-revision', 'if-item-revision'])('409 for exhausted safe %s CAS without admission', async name => {
    const f = await upload({}, { [name]: String(Number.MAX_SAFE_INTEGER) });
    try { expect(f.response.statusCode).toBe(409); expect(f.service.upload).not.toHaveBeenCalled(); }
    finally { await f.app.close(); }
  });
  it('requires positive draft but permits zero collection/item revisions and decimal leading zeros', async () => {
    const f = await upload({}, { 'if-draft-revision': '01', 'if-evidence-revision': '00', 'if-item-revision': '000' });
    try { expect(f.response.statusCode).toBe(200); }
    finally { await f.app.close(); }
    const denied = await upload({}, { 'if-draft-revision': '0' });
    try { expect(denied.response.statusCode).toBe(400); expect(denied.service.upload).not.toHaveBeenCalled(); }
    finally { await denied.app.close(); }
  });
  it.each(['short', 'key with spaces', 'key/provider/file', 'a'.repeat(129)])('rejects invalid idempotency key %j', async key => {
    const f = await upload({}, { 'idempotency-key': key });
    try { expect(f.response.statusCode).toBe(400); expect(f.service.upload).not.toHaveBeenCalled(); }
    finally { await f.app.close(); }
  });
  it.each(['?actorProfileId=x', '?sourceSubmissionId=x', '?x=1&x=2', '?'])('rejects query %s before service', async suffix => {
    const f = await fixture({ rawEmptyQuery: suffix === '?' });
    try {
      const result = await f.app.inject({ method: 'POST', url: uploadPath + suffix, headers, payload: bytes });
      expect(result.statusCode).toBe(400); expect(f.service.upload).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it.each(['sourceSubmissionId', 'clientReportId', 'evidenceId'])('rejects invalid upload path %s', async field => {
    const f = await fixture(), url = POST_APPROVAL_ROOM_ISSUE_EVIDENCE_UPLOAD_PATH.replace(`:${field}`, 'invalid-uuid')
      .replace(':sourceSubmissionId', id(3)).replace(':clientReportId', id(4)).replace(':evidenceId', id(5));
    try {
      expect((await f.app.inject({ method: 'POST', url, headers, payload: bytes })).statusCode).toBe(400);
      expect(f.service.upload).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it.each(['image/jpeg', 'image/webp', 'image/heic', 'image/heif'])('passes raw %s to the deferred reader without JSON parsing', async contentType => {
    const f = await upload({}, { 'content-type': contentType });
    try { expect(f.response.statusCode).toBe(200); expect(f.consumed[0]).toEqual(new Uint8Array(bytes)); }
    finally { await f.app.close(); }
  });
  it('does not inherit JSON 8192 limit and accepts raw bodies up to exactly 5 MiB', async () => {
    for (const size of [8193, PHOTO_INPUT_MAX_BYTES]) {
      const f = await upload({}, {}, Buffer.alloc(size, 1));
      try { expect(f.response.statusCode).toBe(200); expect(f.consumed[0]?.byteLength).toBe(size); }
      finally { await f.app.close(); }
    }
  });
  it('rejects raw body over 5 MiB with 413 after admission, without treating it as JSON', async () => {
    const f = await upload({}, {}, Buffer.alloc(PHOTO_INPUT_MAX_BYTES + 1, 1));
    try { expect(f.response.statusCode).toBe(413); expect(f.response.json().error.code).toBe('PHOTO_TOO_LARGE'); expect(f.consumed).toEqual([]); }
    finally { await f.app.close(); }
  });
  it.each(['application/json', 'multipart/form-data', 'text/plain'])('rejects unsupported %s without exposing a parser error/body', async contentType => {
    const f = await upload({}, { 'content-type': contentType }, Buffer.from('{broken private JSON provider_file}'));
    try { expect(f.response.statusCode).toBe(415); expect(f.response.body).not.toMatch(/broken|private|provider_file/); }
    finally { await f.app.close(); }
  });
  it('does not remove or change sibling JSON parsers', async () => {
    const f = await fixture();
    try {
      const result = await f.app.inject({ method: 'POST', url: '/synthetic-json-sibling', payload: { original: true } });
      expect(result.statusCode).toBe(200); expect(result.json()).toEqual({ original: true });
    } finally { await f.app.close(); }
  });
  it.each(['admin', 'maid'])('permits authenticated %s through the server gate', async role => {
    const f = await upload({ who: actor(role as Actor['role']) });
    try { expect(f.response.statusCode).toBe(200); }
    finally { await f.app.close(); }
  });
  it.each(['developer', 'password', 'auth'])('denies %s before parser/service admission', async mode => {
    const who = actor(mode === 'developer' ? 'developer' : 'maid'); if (mode === 'password') who.mustChangePassword = true;
    const f = await upload({ who, ...(mode === 'auth' ? { authDenial: new AppError(401, 'INVALID_ACCESS_TOKEN', 'raw token secret') } : {}) });
    try { expect(f.response.statusCode).toBe(mode === 'auth' ? 401 : 403); expect(f.service.upload).not.toHaveBeenCalled(); expect(f.consumed).toEqual([]); expect(f.response.body).not.toContain('secret'); }
    finally { await f.app.close(); }
  });
  it('status uses only operation params and strips internal provider projection', async () => {
    const f = await fixture();
    try {
      const result = await f.app.inject({ method: 'GET', url: statusPath });
      expect(result.statusCode).toBe(200); expect(result.json()).toEqual(operation); expect(result.headers['cache-control']).toBe('no-store');
      expect(f.service.status).toHaveBeenCalledWith(actor(), id(6)); expect(result.body).not.toMatch(/provider|locator|session|fence/);
    } finally { await f.app.close(); }
  });
  it('normalizes uppercase UUID paths without accepting caller authority', async () => {
    const f = await fixture();
    try {
      const url = uploadPath.replace(id(3), id(3).toUpperCase()).replace(id(4), id(4).toUpperCase()).replace(id(5), id(5).toUpperCase());
      const result = await f.app.inject({ method: 'POST', url, headers, payload: bytes });
      expect(result.statusCode).toBe(200); expect(vi.mocked(f.service.upload).mock.calls[0]?.[1]).toMatchObject({ sourceSubmissionId: id(3), clientReportId: id(4), evidenceId: id(5) });
    } finally { await f.app.close(); }
  });
  it.each(['upload', 'status'] as const)('rejects foreign identity in the %s response', async method => {
    const f = await fixture();
    try {
      if (method === 'upload') vi.mocked(f.service.upload).mockResolvedValueOnce({ ...operation, evidenceId: id(99) });
      else vi.mocked(f.service.status).mockResolvedValueOnce({ ...operation, operationId: id(99) });
      const result = await f.app.inject(method === 'upload' ? { method: 'POST', url: uploadPath, headers, payload: bytes } : { method: 'GET', url: statusPath });
      expect(result.statusCode).toBe(500); expect(result.json().error.code).toBe('POST_APPROVAL_ROOM_ISSUE_EVIDENCE_PROJECTION_INVALID');
      expect(result.body).not.toContain(id(99));
    } finally { await f.app.close(); }
  });
  it.each(['upload', 'status'] as const)('rejects invalid safe metadata in the %s response', async method => {
    const f = await fixture();
    try {
      vi.mocked(f.service[method]).mockResolvedValueOnce({ ...operation, sizeBytes: 307201 });
      const result = await f.app.inject(method === 'upload' ? { method: 'POST', url: uploadPath, headers, payload: bytes } : { method: 'GET', url: statusPath });
      expect(result.statusCode).toBe(500); expect(result.body).not.toContain('307201');
    } finally { await f.app.close(); }
  });
  it('content uses separate evidence/revision params, returns binary with no private headers', async () => {
    const f = await fixture();
    try {
      const result = await f.app.inject({ method: 'GET', url: contentPath });
      expect(result.statusCode).toBe(200); expect(result.rawPayload).toEqual(bytes); expect(result.headers['content-type']).toBe('image/jpeg');
      expect(result.headers['cache-control']).toBe('no-store'); expect(f.service.content).toHaveBeenCalledWith(actor(), id(5), 1);
      for (const header of ['provider-file-id', 'x-sha256', 'etag', 'content-disposition', 'x-room-pin']) expect(result.headers[header]).toBeUndefined();
    } finally { await f.app.close(); }
  });
  it.each(['0', '-1', '1.5', '1e2', '9007199254740992'])('rejects invalid content revision %s', async revision => {
    const f = await fixture();
    try {
      const result = await f.app.inject({ method: 'GET', url: contentPath.replace('/versions/1/', `/versions/${revision}/`) });
      expect(result.statusCode).toBe(400); expect(f.service.content).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it.each([0, 307201])('rejects content projection of %s bytes', async length => {
    const f = await fixture();
    try {
      vi.mocked(f.service.content).mockResolvedValueOnce({ bytes: new Uint8Array(length), mimeType: 'image/jpeg' });
      const result = await f.app.inject({ method: 'GET', url: contentPath });
      expect(result.statusCode).toBe(500); expect(result.json().error.code).toBe('POST_APPROVAL_ROOM_ISSUE_EVIDENCE_PROJECTION_INVALID');
    } finally { await f.app.close(); }
  });
  it('permits the final positive safe content revision without incrementing it', async () => {
    const f = await fixture();
    try {
      const result = await f.app.inject({ method: 'GET', url: contentPath.replace('/versions/1/', `/versions/${Number.MAX_SAFE_INTEGER}/`) });
      expect(result.statusCode).toBe(200); expect(f.service.content).toHaveBeenCalledWith(actor(), id(5), Number.MAX_SAFE_INTEGER);
    } finally { await f.app.close(); }
  });
  it.each([statusPath, contentPath])('rejects GET body/query for %s', async url => {
    const f = await fixture();
    try {
      expect((await f.app.inject({ method: 'GET', url, payload: 'private body', headers: { 'content-type': 'text/plain' } })).statusCode).toBe(400);
      expect((await f.app.inject({ method: 'GET', url: `${url}?actorProfileId=x` })).statusCode).toBe(400);
      expect(f.service.status).not.toHaveBeenCalled(); expect(f.service.content).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it.each([statusPath, contentPath])('applies server role/password gates to GET %s', async url => {
    for (const who of [actor('developer'), { ...actor(), mustChangePassword: true }]) {
      const f = await fixture({ who });
      try {
        expect((await f.app.inject({ method: 'GET', url })).statusCode).toBe(403);
        expect(f.service.status).not.toHaveBeenCalled(); expect(f.service.content).not.toHaveBeenCalled();
      } finally { await f.app.close(); }
    }
  });
  it('rejects invalid status/evidence UUIDs and does not expose implicit HEAD handlers', async () => {
    const f = await fixture();
    try {
      expect((await f.app.inject({ method: 'GET', url: statusPath.replace(id(6), 'invalid') })).statusCode).toBe(400);
      expect((await f.app.inject({ method: 'GET', url: contentPath.replace(id(5), 'invalid') })).statusCode).toBe(400);
      expect((await f.app.inject({ method: 'HEAD', url: contentPath })).statusCode).toBe(404);
      expect(f.service.status).not.toHaveBeenCalled(); expect(f.service.content).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it.each(['SESSION_REVOKED', 'POST_APPROVAL_ROOM_ISSUE_MEDIA_PURGED', 'PHOTO_STORAGE_QUOTA_UNAVAILABLE', 'PHOTO_UPLOAD_FENCE_CONFLICT'])('preserves known %s with fixed message/no-store', async code => {
    const f = await upload({ denial: new AppError(500, code, 'raw SQL provider_file token PIN', { 'x-private': 'secret' }) });
    try {
      expect(f.response.statusCode).toBe({ SESSION_REVOKED: 401, POST_APPROVAL_ROOM_ISSUE_MEDIA_PURGED: 410,
        PHOTO_STORAGE_QUOTA_UNAVAILABLE: 503, PHOTO_UPLOAD_FENCE_CONFLICT: 409 }[code]);
      expect(f.response.json().error.code).toBe(code); expect(f.response.headers['cache-control']).toBe('no-store');
      expect(f.response.headers['x-private']).toBeUndefined(); expect(f.response.body).not.toMatch(/raw SQL|provider_file|token|PIN|secret/);
    } finally { await f.app.close(); }
  });
  it.each([new Error('raw SQL provider_file token PIN'), new AppError(409, 'RAW_SECRET_PROVIDER', 'private', { 'x-private': 'secret' })])('redacts unknown exceptions and request-id header', async denial => {
    const f = await upload({ denial }, { 'x-request-id': 'raw-provider-token-secret' });
    try { expect(f.response.statusCode).toBe(500); expect(f.response.json().requestId).toBe('unavailable'); expect(f.response.body).not.toMatch(/raw-provider|RAW_SECRET|private|PIN/); }
    finally { await f.app.close(); }
  });
  it.each([['FST_ERR_CTP_BODY_TOO_LARGE', 413], ['FST_ERR_CTP_INVALID_CONTENT_LENGTH', 400], ['FST_ERR_CTP_INVALID_MEDIA_TYPE', 415]] as const)('sanitizes framework %s', async (code, status) => {
    const f = await upload({ denial: { code, message: 'private parser value' } });
    try { expect(f.response.statusCode).toBe(status); expect(f.response.body).not.toContain('private'); }
    finally { await f.app.close(); }
  });
});

describe('standalone supplemental evidence OpenAPI fragment', () => {
  it('documents exactly the three unregistered HTTP paths with bounded safe operation DTO', () => {
    const entries = Object.values(postApprovalRoomIssueEvidenceOpenApiFragment.paths);
    expect(entries).toHaveLength(3);
    const uploadEntry = entries.find(value => 'post' in value); if (!uploadEntry || !('post' in uploadEntry)) throw new Error('missing upload');
    const specification = uploadEntry.post;
    expect(specification['x-implementation-status']).toBe('source-registered-not-deployed');
    expect(specification['x-required-roles']).toEqual(['admin', 'maid']);
    expect(Object.keys(specification.requestBody.content)).toEqual(['image/jpeg', 'image/webp', 'image/heic', 'image/heif']);
    expect(specification.requestBody.content['image/heic']?.schema['x-max-bytes']).toBe(PHOTO_INPUT_MAX_BYTES);
    const dto = specification.responses['200'].content['application/json'].schema;
    expect(dto.properties.status.enum).toEqual(postApprovalRoomIssueUploadStatuses);
    expect(dto.properties.sizeBytes.maximum).toBe(307200); expect(dto.properties.itemRevision.maximum).toBe(Number.MAX_SAFE_INTEGER);
    expect(Object.keys(dto.properties).sort()).toEqual(Object.keys(operation).sort());
    for (const status of ['429', '503', '409']) expect(Object.hasOwn(specification.responses, status)).toBe(true);
    expect(specification.responses['200'].headers['Cache-Control'].schema.const).toBe('no-store');
  });
  it('documents exact single key/three decimal-string CAS headers and independent content revision', () => {
    const entries = Object.values(postApprovalRoomIssueEvidenceOpenApiFragment.paths);
    const uploadEntry = entries.find(value => 'post' in value); if (!uploadEntry || !('post' in uploadEntry)) throw new Error('missing upload');
    const params = uploadEntry.post.parameters.filter(value => value.in === 'header');
    expect(params.map(value => value.name)).toEqual(['Idempotency-Key', 'If-Draft-Revision', 'If-Evidence-Revision', 'If-Item-Revision']);
    for (const parameter of params) expect('x-single-header' in parameter && parameter['x-single-header']).toBe(true);
    const serialized = JSON.stringify(postApprovalRoomIssueEvidenceOpenApiFragment);
    expect(serialized).toContain('^[0-9]+$'); expect(serialized).toContain('"x-integer-maximum":9007199254740990');
    expect(Object.keys(postApprovalRoomIssueEvidenceOpenApiFragment.paths)).toContain('/v1/post-approval-room-issue-evidence-uploads/{operationId}');
    expect(Object.keys(postApprovalRoomIssueEvidenceOpenApiFragment.paths)).toContain('/v1/post-approval-room-issue-evidence/{evidenceId}/versions/{revision}/content');
    expect(serialized).not.toContain('application/json":{"schema":{"type":"string","format":"binary"');
  });
});
