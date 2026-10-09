import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Actor } from '../src/domain/actor.js';
import { AppError } from '../src/lib/app-error.js';
import type { SupabaseClients } from '../src/lib/supabase.js';
import { preparePostApprovalRoomIssueDraft } from '../src/modules/post-approval-room-issues/post-approval-room-issue-contract.js';
import { createPostApprovalRoomIssueRoutes, POST_APPROVAL_ROOM_ISSUE_BASE_PATH } from '../src/modules/post-approval-room-issues/post-approval-room-issue.routes.js';
import { SupabasePostApprovalRoomIssueService } from '../src/modules/post-approval-room-issues/post-approval-room-issue.service.js';
import { postApprovalRoomIssueOpenApiFragment } from '../src/modules/post-approval-room-issues/post-approval-room-issue.openapi.js';

const id = (n: number) => `b3600000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const token = (session = id(2)) => `synthetic.${Buffer.from(JSON.stringify({ session_id: session })).toString('base64url')}.synthetic`;
const actor = (role: Actor['role'] = 'maid'): Actor => ({ profileId: id(1), authUserId: id(9), role,
  displayName: '합성', mustChangePassword: false, accessToken: token() });
const base = POST_APPROVAL_ROOM_ISSUE_BASE_PATH.replace(':sourceSubmissionId', id(3));
const draft = { clientReportId: id(4), expectedDraftRevision: 0, memo: '합성 신고' };
const finalize = { ...draft, expectedDraftRevision: 1, expectedEvidenceRevision: 1,
  evidence: [{ evidenceId: id(5), revision: 1, displayOrder: 0 }] };
const source = { sourceSubmissionId: id(3), originalPerformerProfileId: id(1), sourceStatus: 'approved' };
const headers = { 'idempotency-key': 'synthetic-report-key' };
type Call = { name: string; args: Record<string, unknown> };
async function fixture(initial = actor(), result?: unknown, dbError?: unknown) {
  const calls: Call[] = [];
  const clients = { admin: { rpc: async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    return { error: dbError ?? null, data: result ?? { source,
      draft: { ...draft, sourceSubmissionId: id(3), draftRevision: 1, evidenceRevision: 0, evidenceCount: 0 },
      report: { reportId: id(6), clientReportId: id(4), sourceSubmissionId: id(3), originalPerformerProfileId: id(1),
        reportedByProfileId: id(1), reportedAt: '2026-10-05T00:00:00Z', memo: draft.memo, evidence: finalize.evidence,
        closureRevision: 0, closedAt: null, closedByProfileId: null } } };
  } } } as unknown as SupabaseClients;
  const service = new SupabasePostApprovalRoomIssueService(clients);
  const app = Fastify({ logger: false });
  app.decorateRequest('actor');
  app.decorate('authenticate', async (request) => { request.actor = initial; });
  app.decorate('requirePasswordChanged', async (request) => {
    if (request.actor.mustChangePassword) throw new AppError(403, 'PASSWORD_CHANGE_REQUIRED', '합성 거부');
  });
  await app.register(createPostApprovalRoomIssueRoutes(service));
  return { app, calls, service };
}

describe('#336 isolated HTTP/RPC source slice (synthetic, not DB authorization)', () => {
  it.each([
    [new AppError(500, 'SESSION_REVOKED', 'private-canary'), 401, 'SESSION_REVOKED'],
    [new AppError(409, 'PRIVATE_CANARY', 'private-canary'), 500, 'POST_APPROVAL_ROOM_ISSUE_COMMAND_FAILED'],
    [new Error('private-canary'), 500, 'POST_APPROVAL_ROOM_ISSUE_COMMAND_FAILED'],
    [Object.defineProperty({}, 'code', { get() { throw new Error('private-canary'); } }), 500, 'POST_APPROVAL_ROOM_ISSUE_COMMAND_FAILED']
  ])('sanitizes service exception and arbitrary request id', async (failure, status, code) => {
    const f = await fixture();
    f.service.source = async () => { throw failure; };
    f.app.addHook('onRequest', async request => { request.id = 'private-request-canary'; });
    try {
      const r = await f.app.inject({ method: 'GET', url: `${base}/source` });
      expect(r.statusCode).toBe(status); expect(r.json().error.code).toBe(code);
      expect(r.json().requestId).toBe('unavailable'); expect(r.headers['cache-control']).toBe('no-store');
      expect(r.body).not.toMatch(/private|PRIVATE_CANARY/);
    } finally { await f.app.close(); }
  });
  for (const status of ['submitted', 'approved']) it(`does not reject ${status} source`, async () => {
    const f = await fixture(actor(), { source: { ...source, sourceStatus: status } });
    try {
      const reply = await f.app.inject({ method: 'GET', url: `${base}/source` });
      expect(reply.statusCode).toBe(200);
      expect(reply.headers['cache-control']).toBe('no-store');
      expect(reply.json()).toEqual({ source: { ...source, sourceStatus: status, ownership: 'original_performer' } });
      expect(f.calls[0]).toEqual({ name: 'get_post_approval_room_issue_source', args: {
        p_actor_profile_id: id(1), p_session_id: id(2), p_source_submission_id: id(3)
      } });
    } finally { await f.app.close(); }
  });
  it('uses server actor/session and scoped digest, not token/raw key, in the actual RPC adapter', async () => {
    const f = await fixture();
    try {
      const reply = await f.app.inject({ method: 'POST', url: `${base}/drafts`, headers, payload: draft });
      expect(reply.statusCode).toBe(200);
      const prepared = preparePostApprovalRoomIssueDraft({ actorProfileId: id(1), sessionId: id(2) }, { ...draft, sourceSubmissionId: id(3) }, headers['idempotency-key']);
      expect(f.calls).toEqual([{ name: 'save_post_approval_room_issue_draft', args: {
        p_actor_profile_id: id(1), p_session_id: id(2), p_source_submission_id: id(3), p_client_report_id: id(4),
        p_expected_draft_revision: 0, p_memo: draft.memo, p_idempotency_key_digest: prepared.idempotencyKeyDigest, p_request_hash: prepared.requestHash
      } }]);
      expect(JSON.stringify(f.calls)).not.toContain(headers['idempotency-key']);
      expect(JSON.stringify(reply.json())).not.toMatch(/session|requestHash|idempotency/);
    } finally { await f.app.close(); }
  });
  it('projects the last safely incremented revision and fails exhausted draft CAS closed with 409', async () => {
    const f = await fixture(actor(), { source, draft: { ...draft, sourceSubmissionId: id(3),
      draftRevision: Number.MAX_SAFE_INTEGER, evidenceRevision: 0, evidenceCount: 0 } });
    try {
      const reply = await f.app.inject({ method: 'POST', url: `${base}/drafts`, headers,
        payload: { ...draft, expectedDraftRevision: Number.MAX_SAFE_INTEGER - 1 } });
      expect(reply.statusCode).toBe(200); expect(reply.json().draft.draftRevision).toBe(Number.MAX_SAFE_INTEGER);
      const exhausted = await f.app.inject({ method: 'POST', url: `${base}/drafts`, headers,
        payload: { ...draft, expectedDraftRevision: Number.MAX_SAFE_INTEGER } });
      expect(exhausted.statusCode).toBe(409); expect(exhausted.json().error.code).toBe('POST_APPROVAL_ROOM_ISSUE_DRAFT_CONFLICT');
      expect(f.calls).toHaveLength(1);
    } finally { await f.app.close(); }
  });
  for (const field of ['sourceSubmissionId', 'actorProfileId', 'sessionId', 'roomId', 'maidProfileId', 'role', 'reportedAt', 'status', 'providerLocator', 'pin', 'inspectionDecision', 'payment']) {
    it(`rejects client authority field ${field} without calling RPC`, async () => {
      const f = await fixture();
      try {
        const reply = await f.app.inject({ method: 'POST', url: `${base}/drafts`, headers, payload: { ...draft, [field]: id(8) } });
        expect(reply.statusCode).toBe(400); expect(f.calls).toEqual([]);
        expect(reply.headers['cache-control']).toBe('no-store'); expect(reply.body).not.toContain(id(8));
      } finally { await f.app.close(); }
    });
  }
  for (const suffix of ['?actorProfileId=x', '?x=1&x=2', '?sessionId=x']) it(`rejects query ${suffix}`, async () => {
    const f = await fixture();
    try { expect((await f.app.inject({ method: 'GET', url: `${base}/source${suffix}` })).statusCode).toBe(400); expect(f.calls).toEqual([]); }
    finally { await f.app.close(); }
  });
  it('keeps admin access but rejects another maid and developer', async () => {
    for (const [who, status] of [[actor('admin'), 200], [{ ...actor(), profileId: id(7) }, 403], [actor('developer'), 403]] as const) {
      const f = await fixture(who);
      try { expect((await f.app.inject({ method: 'GET', url: `${base}/source` })).statusCode).toBe(status); }
      finally { await f.app.close(); }
    }
  });
  for (const who of [{ ...actor(), mustChangePassword: true }, { ...actor(), accessToken: 'bad' }, { ...actor(), accessToken: token('bad') }]) {
    it('rejects password or malformed authenticated-session context before RPC', async () => {
      const f = await fixture(who);
      try { expect([401, 403]).toContain((await f.app.inject({ method: 'GET', url: `${base}/source` })).statusCode); expect(f.calls).toEqual([]); }
      finally { await f.app.close(); }
    });
  }
  it('strips raw nested DTO extras and rejects a mismatched returned source', async () => {
    for (const bad of [false, true]) {
      const f = await fixture(actor(), { source: { ...source, sourceSubmissionId: bad ? id(8) : id(3), pin: 'synthetic-private', providerLocator: 'synthetic-private' } });
      try {
        const reply = await f.app.inject({ method: 'GET', url: `${base}/source` });
        expect(reply.statusCode).toBe(bad ? 500 : 200); expect(reply.body).not.toContain('synthetic-private');
      } finally { await f.app.close(); }
    }
  });
  for (const code of ['IDEMPOTENCY_KEY_REUSED', 'POST_APPROVAL_ROOM_ISSUE_DRAFT_CONFLICT', 'POST_APPROVAL_ROOM_ISSUE_EVIDENCE_INVALID', 'untrusted SQL/private provider']) {
    it(`maps safe DB error ${code} without leaking details`, async () => {
      const f = await fixture(actor(), undefined, { message: code, details: 'synthetic-private', hint: 'synthetic-private' });
      try {
        const reply = await f.app.inject({ method: 'POST', url: base, headers, payload: finalize });
        expect(reply.statusCode).toBe(code.startsWith('untrusted') ? 500 : 409);
        expect(reply.body).not.toContain('synthetic-private'); expect(reply.body).not.toContain('untrusted SQL');
      } finally { await f.app.close(); }
    });
  }
  it('enforces body size, JSON and key bounds before RPC', async () => {
    const f = await fixture();
    try {
      expect((await f.app.inject({ method: 'POST', url: `${base}/drafts`, headers, payload: { ...draft, memo: 'x'.repeat(9000) } })).statusCode).toBe(413);
      expect((await f.app.inject({ method: 'POST', url: `${base}/drafts`, headers: { ...headers, 'content-type': 'application/json' }, payload: '{bad' })).statusCode).toBe(400);
      expect((await f.app.inject({ method: 'POST', url: `${base}/drafts`, headers: { ...headers, 'content-type': 'application/xml' }, payload: '<synthetic/>' })).statusCode).toBe(415);
      expect((await f.app.inject({ method: 'POST', url: `${base}/drafts`, payload: draft })).statusCode).toBe(400);
      expect((await f.app.inject({ method: 'POST', url: `${base}/drafts`, headers: { 'idempotency-key': ['key-value-1', 'key-value-2'] }, payload: draft })).statusCode).toBe(400);
      expect(f.calls).toEqual([]);
    } finally { await f.app.close(); }
  });
  it('records finalize adapter args only; synthetic success is not actual executed SQL success', async () => {
    const f = await fixture();
    try {
      const reply = await f.app.inject({ method: 'POST', url: base, headers, payload: finalize });
      expect(reply.statusCode).toBe(201);
      expect(f.calls[0]?.name).toBe('finalize_post_approval_room_issue_report');
      expect(f.calls[0]?.args.p_evidence).toEqual(finalize.evidence);
    } finally { await f.app.close(); }
  });
  it('registers typed seal/read/admin-closure contracts with the verified production release', () => {
    const entries = Object.values(postApprovalRoomIssueOpenApiFragment.paths);
    expect(entries).toHaveLength(6);
    for (const entry of entries) for (const operation of Object.values(entry)) {
      expect(operation['x-implementation-status']).toBe('deployed');
      expect(operation['x-deployed-release']).toBe('v0.9.0');
      expect(operation['x-required-roles']).toEqual(operation.operationId === 'closePostApprovalRoomIssueReport' ? ['admin'] : ['admin', 'maid']);
      expect(operation.responses['503']).toBeDefined();
    }
    const operation = postApprovalRoomIssueOpenApiFragment.paths[base.replace(id(3), '{sourceSubmissionId}')]?.post;
    expect(operation?.description).toContain('이후 수정본의 운영 반영은 별도 릴리스 절차를 따른다');
    expect(operation?.description).not.toContain('source 등록이며');
    expect(operation?.description).toContain('CAS·불변 seal·receipt');
  });
  it('reads only exact source/report IDs and strips hidden fields', async () => {
    const f = await fixture();
    try { const reply = await f.app.inject({ method: 'GET', url: `${base}/${id(6)}` });
      expect(reply.statusCode).toBe(200); expect(f.calls[0]?.name).toBe('get_post_approval_room_issue_report');
      expect(f.calls[0]?.args.p_report_id).toBe(id(6));
    } finally { await f.app.close(); }
  });
  it('separately discovers same-source reports for admin without altering the old submission DTO', async () => {
    const report = { reportId: id(6), clientReportId: id(4), sourceSubmissionId: id(3), originalPerformerProfileId: id(1),
      reportedByProfileId: id(1), reportedAt: '2026-10-05T00:00:00Z', memo: draft.memo,
      closureRevision: 1, closedAt: '2026-10-06T00:00:00Z', closedByProfileId: id(7),
      evidence: [{ ...finalize.evidence[0], providerFileId: 'never expose' }], hidden: 'never expose' };
    const f = await fixture(actor('admin'), { source, reports: [report] });
    try { const reply = await f.app.inject({ method: 'GET', url: base });
      expect(reply.statusCode).toBe(200); expect(reply.headers['cache-control']).toBe('no-store');
      expect(reply.json().source.ownership).toBe('admin'); expect(reply.json().reports[0].reportId).toBe(id(6));
      expect(reply.json().reports[0]).toMatchObject({ closureRevision: 1, closedAt: report.closedAt, closedByProfileId: id(7) });
      expect(reply.body).not.toContain('never expose'); expect(f.calls[0]?.name).toBe('list_post_approval_room_issue_reports');
      expect((await f.app.inject({ method: 'GET', url: `${base}?cursor=forged` })).statusCode).toBe(400);
      expect(f.calls).toHaveLength(1);
    } finally { await f.app.close(); }
  });
  it('discovery cannot launder a report from a different historical source', async () => {
    const f = await fixture(actor('admin'), { source, reports: [{ reportId: id(6), clientReportId: id(4), sourceSubmissionId: id(33),
      originalPerformerProfileId: id(1), reportedByProfileId: id(1), reportedAt: '2026-10-05T00:00:00Z', memo: draft.memo, evidence: finalize.evidence,
      closureRevision: 0, closedAt: null, closedByProfileId: null }] });
    try { expect((await f.app.inject({ method: 'GET', url: base })).statusCode).toBe(500); }
    finally { await f.app.close(); }
  });
  it.each([0, 1])('recovers %i current typed evidence items without internal fields', async count => {
    const result = { source, draft: { clientReportId: id(4), sourceSubmissionId: id(3), draftRevision: 1,
      evidenceRevision: count, evidenceCount: count, memo: draft.memo, secret: 'never expose' },
      evidence: count ? [{ ...finalize.evidence[0], providerFileId: 'never expose' }] : [], reportId: null, sessionId: 'never expose' };
    const f = await fixture(actor(), result);
    try { const reply = await f.app.inject({ method: 'GET', url: `${base}/drafts/${id(4)}` });
      expect(reply.statusCode).toBe(200); expect(reply.body).not.toContain('never expose');
      expect(reply.json().evidence).toHaveLength(count); expect(reply.json().reportId).toBeNull();
      expect(f.calls[0]).toEqual({ name: 'get_post_approval_room_issue_draft', args: {
        p_actor_profile_id: id(1), p_session_id: id(2), p_source_submission_id: id(3), p_client_report_id: id(4) } });
    } finally { await f.app.close(); }
  });
  it('rejects drifted draft recovery count/source instead of returning a plausible empty collection', async () => {
    const f = await fixture(actor(), { source, draft: { ...draft, sourceSubmissionId: id(3), draftRevision: 1,
      evidenceRevision: 1, evidenceCount: 1 }, evidence: [], reportId: null });
    try { expect((await f.app.inject({ method: 'GET', url: `${base}/drafts/${id(4)}` })).statusCode).toBe(500); }
    finally { await f.app.close(); }
  });
  it('closes only as admin with strict CAS0 and separate receipt scope', async () => {
    const f = await fixture(actor('admin'), { reportId: id(6), closureRevision: 1, closedAt: '2026-10-05T00:00:00Z', hidden: 'not exposed' });
    try { const reply = await f.app.inject({ method: 'POST', url: `${base}/${id(6)}/close`, headers, payload: { expectedClosureRevision: 0 } });
      expect(reply.statusCode).toBe(200); expect(reply.json()).not.toHaveProperty('hidden');
      expect(f.calls[0]?.name).toBe('close_post_approval_room_issue_report');
      expect(f.calls[0]?.args.p_expected_closure_revision).toBe(0);
    } finally { await f.app.close(); }
  });
  for (const body of [{ expectedClosureRevision: 1 }, { expectedClosureRevision: '0' }, { expectedClosureRevision: 0, closedAt: 'client clock' }]) {
    it(`rejects forged closure ${JSON.stringify(body)}`, async () => { const f = await fixture(actor('admin'));
      try { const reply = await f.app.inject({ method: 'POST', url: `${base}/${id(6)}/close`, headers, payload: body });
        expect(reply.statusCode).toBe(400); expect(f.calls).toHaveLength(0);
      } finally { await f.app.close(); }
    });
  }
  it('does not allow a maid to close historical report or bypass DB via reporter field', async () => {
    const f = await fixture();
    try { const reply = await f.app.inject({ method: 'POST', url: `${base}/${id(6)}/close`, headers, payload: { expectedClosureRevision: 0 } });
      expect(reply.statusCode).toBe(403); expect(f.calls).toHaveLength(0);
    } finally { await f.app.close(); }
  });
});
